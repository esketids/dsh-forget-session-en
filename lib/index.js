/**
 * dsh-forget-session — Host half (Cordis plugin) v2.
 *
 * A single TypertRemoteService: after the browser half mounts this service's
 * contract with `ctx.remote.$mount(...)`, calls arrive here through
 * `ctx.get('remote.forgetSessionEn').<method>(payload)`.
 *
 * "Deleting a session" has two layers:
 *
 *  A. Authoritative state (always through official channels; never edit
 *     workspace.json by hand):
 *    1. Stop work + temporary archive: `registry.archiveSession(id, { stopActivity: true })`
 *    2. Remove from archive: `registry.unarchiveSession(id)`
 *    3. Remove pin: `registry.unpinSession(id)`
 *    4. Flush live entry: `sessions.flush(id)` writes buffered events to disk.
 *    5. Detach live entry (core): `sessions.store.get(id).detach()` — the store
 *       has no public remove API; the detach capability lives on each store
 *       entry (the closure enter() returns to the creating fiber). It performs
 *       store.delete + attachments.delete + emitDisposed; the latter triggers
 *       the official `api-session/removed` (the client row disappears through
 *       the official path instead of falling into "Ungrouped") and the
 *       persistence layer's `session/disposed` → `writer.close()` (the write
 *       handle is released, which is what makes disk deletion possible).
 *       Without detaching the live entry, session.list always lists it, so the
 *       row reappears on the next refresh.
 *    6. Remove accounting: for every workspace entity that contains it,
 *       `entity.detachSession(id)`.
 *
 *  B. Disk files (session log directory + projection cache shard/table entry):
 *    - Session log directory: `~/.dsh/sessions/<projectKey(cwd)>/<id>` (fully
 *      isomorphic with `projectKey`/`encodeSegment` in
 *      session-persistence-jsonl, including the `_no-cwd` project directory and
 *      v0/vN generation files).
 *    - Projection cache shard: `~/.dsh/storages/session_projcache/sessions/<id>.json`
 *    - Projection cache table: `tables.sessions[<id>]` in
 *      `~/.dsh/storages/session_projcache.json` (read-modify-write, everything
 *      else is preserved).
 *
 * Root causes of "deleted sessions come back" fixed in v2:
 *
 *  1. Windows live-deletion race: once a session has been opened there is a
 *     write handle / cross-process lease, so `rm` reports EBUSY/EPERM while v1
 *     failed silently → files remained → the registry re-adopted them into
 *     "Ungrouped" after restart; and a late append from the live teardown after
 *     deletion could recreate the deleted directory. v2 does a **verification
 *     re-check** after deletion, retries occupied errors with backoff, and sets
 *     up a "resurrection guard": for about 2 minutes after a successful
 *     deletion it re-checks periodically and immediately deletes any directory
 *     that gets recreated.
 *  2. Flush the live buffered events before deletion, so the buffer cannot
 *     write back after the disk files are gone.
 *
 * Memory safety: memory data lives in `~/.dsh/.dsh-memory`, which does not
 * intersect with the files this plugin deletes.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import * as zlib from "node:zlib";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** Subdirectory holding the per-session shard files of the projection cache. */
const PROJCACHE_SHARD_DIR = ["storages", "session_projcache", "sessions"];
/** Projection cache table file (the storage-domain sessions table). */
const PROJCACHE_JSON = ["storages", "session_projcache.json"];
/** Generation log file names: `session.vN.jsonl[.zstd]` / v0 `session.jsonl[.zstd]`. */
/** Resurrection guard: re-check interval (ms), exponential backoff ×2, total window ~2 minutes. */
const GUARD_BASE_DELAY_MS = 2_000;
const GUARD_MAX_DELAY_MS = 32_000;
const GUARD_TOTAL_MS = 130_000;
/** Base retry interval (ms) and attempt count when deletion fails (EBUSY etc.). */
const RETRY_BASE_DELAY_MS = 1_500;
const RETRY_MAX_ATTEMPTS = 3;

/** Active resurrection guards: sessionId → timer. Module-level so service rebuilds do not stack. */
const resurrectionGuards = new Map();

/**
 * Isomorphic with `encodeSegment` in session-persistence-jsonl: any string →
 * a safe path segment.
 * @param {string} raw - Raw segment (the session id).
 * @returns {string} A filesystem-safe segment.
 */
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

/**
 * Isomorphic with `projectKey` in session-persistence-jsonl: project directory
 * → human-readable directory name.
 * @param {string} cwd - The session's project directory (absolute path).
 * @returns {string} The project directory name under the sessions root.
 */
function projectKey(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Directories a session may have under the sessions root.
 * cwd known → `join(projectKey(cwd), encodeSegment(id))`; cwd unknown → scan all
 * project directories (including `_no-cwd`, which is also an ordinary directory
 * under the root).
 * @param {string} sessionsRoot - DSH session storage root.
 * @param {string|undefined} cwd - The cwd from the session header.
 * @param {string} id - Session id.
 * @returns {Promise<string[]>} Absolute paths of possible session directories.
 */
async function candidateSessionDirs(sessionsRoot, cwd, id) {
	const encoded = encodeSegment(id);
	if (cwd !== undefined && cwd !== "") {
		return [join(sessionsRoot, projectKey(cwd), encoded)];
	}
	const dirs = [];
	try {
		for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			dirs.push(join(sessionsRoot, entry.name, encoded));
		}
	} catch {
		// Root does not exist → there is nothing to delete
	}
	return dirs;
}

/** Whether this is a "file in use" error (Windows EBUSY/EPERM/ENOTEMPTY can be saved by retrying). */
function isBusyError(error) {
	const message = errorMessage(error);
	return /\b(EBUSY|EPERM|ENOTEMPTY)\b/i.test(message) || /being used by another process/i.test(message);
}

/** Delete one directory (retrying in-use errors with backoff); returns whether it is really gone. */
async function removeDirWithRetry(dir) {
	for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			if (!existsSync(dir)) return true;
			await rm(dir, { recursive: true, force: true });
			return !existsSync(dir);
		} catch (error) {
			if (attempt === RETRY_MAX_ATTEMPTS || !isBusyError(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
		}
	}
	return false;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * DSH data root (the parent of `~/.dsh`). Prefers `DSH_FORGET_SESSION_HOME`
 * (used to isolate tests), otherwise the OS home directory (dsh-home-paths
 * convention: sessions/storage live under `<home>/.dsh`).
 * @returns {string} Absolute path of the home directory.
 */
function resolveHome() {
	const override = process.env.DSH_FORGET_SESSION_HOME;
	if (override !== undefined && override !== "") return override;
	return homedir();
}

var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = !target ? void 0 : Object.getOwnPropertyDescriptor(target, contextIn.name);
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(result.init);
		} else if (kind === "method") {
			// The Remote(name) decorator (the usage in this plugin): a method
			// decorator does not return a replacement value. When result is
			// undefined, keep the original method (the official __esDecorate's
			// `typeof result === "function" ? _ = result : _ = result[key]`
			// branch is skipped silently for methods with no replacement value).
			if (typeof result === "function") descriptor[key] = result;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};

let ForgetSessionGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _delete_decorators;
	return class ForgetSessionGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_delete_decorators = [Remote("delete")];
			__esDecorate(this, null, _delete_decorators, { kind: "method", name: "delete", static: false, private: false, access: { has: (obj) => "delete" in obj, get: (obj) => obj.delete }, metadata: _metadata }, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
		}
		// Declarative injection: same style as the official
		// @deepseek-ai/dsh-api-workspace-controller. Cordis instantiates this
		// service only after the dependency is ready, which is also what makes
		// `ctx.x` property access legal — accessing an undeclared service through
		// a property makes the Proxy throw
		// `cannot get property "x" without inject`.
		static inject = ["workspaceRegistry"];
		constructor(ctx) {
			super(ctx, "forgetSessionEn");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		 * Resolve the workspace registry.
		 *
		 * Uses the **lenient entry point** `ctx.get()` (the official dsh-workspace
		 * uses the same one for `sessions`): when the service is missing it
		 * returns undefined instead of throwing, so we can produce a readable
		 * error for the frontend. In normal operation `static inject` above
		 * guarantees that it exists.
		 */
		requireRegistry() {
			const ctx = this.ctx;
			const registry = typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined;
			if (registry === undefined || registry === null) {
				throw new Error("workspaceRegistry service is unavailable (workspace plugin not loaded)");
			}
			return registry;
		}

		// ════════════════════ Remote method: delete ════════════════════

		/** Delete a session (authoritative state + disk artifacts + resurrection guard). Idempotent. */
		async delete(payload) {
			const sessionId = this.requireSessionId(payload);
			const removed = {
				sessionId,
				stoppedWork: false,
				detached: false,
				detachedLive: false,
				unarchived: false,
				unpinned: false,
				flushed: false,
				filesRemoved: [],
				projcacheShard: false,
				projcacheJson: false,
				guardScheduled: false,
				warnings: []
			};
			const registry = this.requireRegistry();

			// ── 0. Read the header to get cwd (before touching any state) ────────────
			let cwd;
			try {
				const header = await registry.readSessionHeader(sessionId);
				cwd = header?.cwd;
			} catch (error) {
				removed.warnings.push(`read header: ${errorMessage(error)}`);
			}

			// ── 1. Stop work (official stopActivity archive path, temporary state) ──
			try {
				await registry.archiveSession(sessionId, { stopActivity: true });
				removed.stoppedWork = true;
			} catch (error) {
				const message = errorMessage(error);
				if (!/unknown session/i.test(message)) removed.warnings.push(`stop activity: ${message}`);
			}

			// ── 2. Remove from archive (undo the temporary archive from step 1) ──────
			try {
				await registry.unarchiveSession(sessionId);
				removed.unarchived = true;
			} catch (error) {
				removed.warnings.push(`unarchive: ${errorMessage(error)}`);
			}

			// ── 3. Remove pin ────────────────────────────────────────────────────────
			try {
				await registry.unpinSession(sessionId);
				removed.unpinned = true;
			} catch (error) {
				removed.warnings.push(`unpin: ${errorMessage(error)}`);
			}

			// ── 4. Flush live entry (persist buffered events; we delete from disk next) ─
			try {
				const sessions = this.ctx.get("sessions");
				const live = sessions?.get?.(sessionId);
				if (live !== undefined) {
					try { await sessions.flush?.(live); removed.flushed = true; } catch { /* a failed flush does not block deletion */ }
				}
			} catch (error) {
				removed.warnings.push(`live flush: ${errorMessage(error)}`);
			}

			// ── 5. Detach live entry (core! remove the session from the Session store) ─
			// Without detaching the live entry, session.list always lists it → the
			// client row returns on the next refresh (falling into "Ungrouped");
			// the persistence writer also still holds a write handle → disk EBUSY
			// and deletion fails (even the resurrection guard deleting for 130s is
			// wasted). The store has no public remove API; the detach capability
			// exists only on the entry (the closure enter() returns to the creating
			// fiber) — call entry.detach() directly: store.delete +
			// attachments.delete + emitDisposed. The latter triggers the official
			// `api-session/removed` (the row disappears through the official path)
			// and the persistence layer's `writer.close()` (the handle is released,
			// which is what makes step 7's disk deletion possible).
			try {
				const sessions = this.ctx.get("sessions");
				const entry = sessions?.store?.get?.(sessionId);
				if (entry && typeof entry.detach === "function") {
					entry.detach();
					removed.detachedLive = true;
				}
			} catch (error) {
				removed.warnings.push(`live detach: ${errorMessage(error)}`);
			}

			// ── 6. Remove workspace accounting (official detach channel) ────────────
			try {
				for (const entity of registry.list()) {
					const ids = entity.sessionIds;
					if (Array.isArray(ids) && ids.includes(sessionId)) {
						await entity.detachSession(sessionId);
						removed.detached = true;
					}
				}
			} catch (error) {
				removed.warnings.push(`detach: ${errorMessage(error)}`);
			}

			// ── 7. Delete the on-disk session directory (retry in-use errors + verify) ─
			const home = resolveHome();
			const sessionsRoot = join(home, ".dsh", "sessions");
			const candidates = await candidateSessionDirs(sessionsRoot, cwd, sessionId);
			for (const dir of candidates) {
				if (!existsSync(dir)) continue;
				try {
					const ok = await removeDirWithRetry(dir);
					if (ok) removed.filesRemoved.push(dir);
					else removed.warnings.push(`rm ${dir}: file still present after retries (held by a live handle?)`);
				} catch (error) {
					removed.warnings.push(`rm ${dir}: ${errorMessage(error)}`);
				}
			}

			// ── 7. Clean the projection cache (shard + table entry) ─────────────────
			await this.cleanProjectionCache(home, sessionId, removed);

			// ── 8. Resurrection guard: whether or not this pass removed everything,
			//       re-check periodically for the next ~2 minutes.
			//       Covers two kinds of resurrection: a) EBUSY leftovers (deleted
			//       later once the live handle is released); b) directories recreated
			//       by a late append from the live teardown.
			this.scheduleResurrectionGuard(sessionId, cwd, removed);

			return { ok: true, removed };
		}

		// ════════════════════ Internal helpers ════════════════════

		/** Stop a session's resurrection guard. */
		stopGuard(sessionId) {
			const guard = resurrectionGuards.get(sessionId);
			if (guard !== undefined) {
				clearTimeout(guard);
				resurrectionGuards.delete(sessionId);
			}
		}

		/**
		 * Set up the resurrection guard: starts at 2s, ×2 backoff, total window
		 * ~130s; each step re-checks the directory and shard and deletes them
		 * again if recreated. An explicit delete of the same session resets the
		 * guard.
		 */
		scheduleResurrectionGuard(sessionId, cwd, removed) {
			this.stopGuard(sessionId);
			const startedAt = Date.now();
			let delay = GUARD_BASE_DELAY_MS;
			const tick = async () => {
				try {
					const home = resolveHome();
					const sessionsRoot = join(home, ".dsh", "sessions");
					const dirs = await candidateSessionDirs(sessionsRoot, cwd, sessionId);
					let removedAny = false;
					for (const dir of dirs) {
						if (!existsSync(dir)) continue;
						try {
							if (await removeDirWithRetry(dir)) removedAny = true;
						} catch { /* still in use; wait for the next step */ }
					}
					if (removedAny) {
						const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${sessionId}.json`);
						try { if (existsSync(shard)) await rm(shard, { force: true }); } catch { /* ignore */ }
					}
				} catch { /* filesystem hiccup; check again at the next step */ }
				const nextDelay = delay * 2;
				if (Date.now() - startedAt + nextDelay > GUARD_TOTAL_MS) {
					resurrectionGuards.delete(sessionId);
					return;
				}
				delay = Math.min(nextDelay, GUARD_MAX_DELAY_MS);
				resurrectionGuards.set(sessionId, setTimeout(tick, delay));
			};
			if (removed) removed.guardScheduled = true;
			resurrectionGuards.set(sessionId, setTimeout(tick, delay));
		}

		/** Validate the payload and extract the session id. */
		requireSessionId(payload) {
			const id = String(payload?.sessionId ?? "");
			if (id === "") throw new Error("sessionId is required");
			return id;
		}

		/** Clean the projection cache (shard + table entry). */
		async cleanProjectionCache(home, sessionId, removed) {
			const shard = join(home, ".dsh", ...PROJCACHE_SHARD_DIR, `${sessionId}.json`);
			try {
				if (existsSync(shard)) {
					await rm(shard, { force: true });
					removed.projcacheShard = true;
				}
			} catch (error) {
				removed.warnings.push(`projcache shard: ${errorMessage(error)}`);
			}
			const jsonPath = join(home, ".dsh", ...PROJCACHE_JSON);
			try {
				if (!existsSync(jsonPath)) return;
				const raw = await readFile(jsonPath, "utf8");
				const parsed = JSON.parse(raw);
				const table = parsed?.tables?.sessions;
				if (table && Object.prototype.hasOwnProperty.call(table, sessionId)) {
					delete table[sessionId];
					// Write back with the original indentation (that file uses 1
					// space); on failure only record a warning.
					await writeFile(jsonPath, JSON.stringify(parsed, null, 1), "utf8");
					removed.projcacheJson = true;
				}
			} catch (error) {
				removed.warnings.push(`projcache json: ${errorMessage(error)}`);
			}
		}
	};
})();

export { ForgetSessionGateway, ForgetSessionGateway as default };
