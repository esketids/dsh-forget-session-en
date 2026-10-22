/**
 * dsh-forget-session-en v2.1 verification (isolated HOME; never touches the real
 * ~/.dsh).
 *
 * The contract surface has only one remote method, `delete` (extra methods such
 * as health-check/sweep have been removed as requested).
 * Covers: the full delete waterfall (directory/shard/table entry/detach),
 * idempotency, the resurrection guard (a recreated directory is deleted again
 * automatically), zero collateral damage to normal sessions, and an error for a
 * missing argument.
 */
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

const mod = await import("../lib/index.js");
const home = mkdtempSync(join(tmpdir(), "fs-v21-"));
process.env.DSH_FORGET_SESSION_HOME = home;

const root = join(home, ".dsh", "sessions");
const projDir = join(root, "--D-proj--");
mkdirSync(projDir, { recursive: true });

// ── Fixtures ──────────────────────────────────────────────────────────
const victimId = "session-victim";
const victimDir = join(projDir, victimId);
const header = JSON.stringify({ type: "session", version: 4, id: victimId, createdAt: 2, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 });
mkdirSync(victimDir);
writeFileSync(join(victimDir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(
	Buffer.from(header + "\n" + JSON.stringify({ type: "user/message", seq: 1 }) + "\n", "utf8")
));

// Control: a normal session (must never be deleted by mistake)
const otherId = "session-other";
const otherDir = join(projDir, otherId);
mkdirSync(otherDir);
writeFileSync(join(otherDir, "session.v4.jsonl"), JSON.stringify({ type: "session", version: 4, id: otherId, createdAt: 1, cwd: "D:\\proj", isSeeded: false, delegationDepth: 0 }) + "\n" + JSON.stringify({ type: "user/message", seq: 1 }) + "\n");

// Projection cache: shard + table entry
mkdirSync(join(home, ".dsh", "storages", "session_projcache", "sessions"), { recursive: true });
writeFileSync(join(home, ".dsh", "storages", "session_projcache", "sessions", `${victimId}.json`), "{}");
writeFileSync(join(home, ".dsh", "storages", "session_projcache.json"), JSON.stringify({
	unit: { name: "session_projcache", version: 3 }, global: null,
	tables: { sessions: { [victimId]: { keep: true }, [otherId]: { keep: true } } }
}, null, 1));

// ── Fake registry + fake sessions service + real Cordis Context ───────
const detached = [];
const registry = {
	readSessionHeader: async (id) => ({ id, cwd: id === victimId ? "D:\\proj" : undefined }),
	archiveSession: async () => {}, unarchiveSession: async () => {}, unpinSession: async () => {},
	list: () => [{ sessionIds: [victimId, otherId], detachSession: async (id) => detached.push(id) }],
	archivedSessionIds: [], pinnedSessionIds: []
};

// Live side: victim is alive in the Session store (detach removes it from the
// store; faithfully simulates the official detachEntered: store.delete +
// attachments.delete + emitDisposed)
const liveDetachCalls = [];
const liveFlushCalls = [];
const sessionsService = {
	store: new Map(),
	get(id) { return this.store.has(id) ? { id } : undefined; },
	async flush() { liveFlushCalls.push(1); return true; }
};
const liveEntry = { id: victimId, detach: () => { liveDetachCalls.push(victimId); sessionsService.store.delete(victimId); } };
sessionsService.store.set(victimId, liveEntry);

const { Context } = await import("@deepseek-ai/cordis");
const ctx = new Context().extend({
	workspaceRegistry: registry,
	sessions: sessionsService,
	get(key) { return key === "workspaceRegistry" ? registry : key === "sessions" ? sessionsService : undefined; }
});
const gateway = new mod.default(ctx, undefined);

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

// 1) The contract surface has only delete (health-check/sweep methods must not exist)
check("surface.onlyDelete", typeof gateway.delete === "function"
	&& gateway.verify === undefined && gateway.sweepShells === undefined
	&& gateway.audit === undefined && gateway.preview === undefined);

// 2) Full delete waterfall
const del = await gateway.delete({ sessionId: victimId });
check("delete.ok", del.ok === true);
check("delete.dirGone", !existsSync(victimDir));
check("delete.shardGone", !existsSync(join(home, ".dsh", "storages", "session_projcache", "sessions", `${victimId}.json`)));
const pc = JSON.parse(readFileSync(join(home, ".dsh", "storages", "session_projcache.json"), "utf8"));
check("delete.tableEntryGone", pc.tables.sessions[victimId] === undefined);
check("delete.otherEntryKept", pc.tables.sessions[otherId] !== undefined);
check("delete.detachCalled", detached.includes(victimId));
check("delete.liveDetached", del.removed?.detachedLive === true && liveDetachCalls.includes(victimId) && !sessionsService.store.has(victimId));
check("delete.liveFlushed", del.removed?.flushed === true && liveFlushCalls.length > 0);
check("delete.guardScheduled", del.removed?.guardScheduled === true);

// 3) Zero collateral damage
check("other.intact", existsSync(otherDir));

// 4) Idempotency
const del2 = await gateway.delete({ sessionId: victimId });
check("delete.idempotent", del2.ok === true);

// 5) Resurrection guard: recreate the directory right after deletion; the guard should remove it at the ~2s step
mkdirSync(victimDir, { recursive: true });
writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
check("guard.recreated", existsSync(victimDir));
await new Promise((resolve) => setTimeout(resolve, 5000));
check("guard.resurrectedRemoved", !existsSync(victimDir));
gateway.stopGuard(victimId);

// 6) Missing-argument error
let threw = false;
try { await gateway.delete({}); } catch { threw = true; }
check("delete.requiresSessionId", threw);

rmSync(home, { recursive: true, force: true });
const pass = results.every(([, ok]) => ok);
console.log(pass ? "\nFINAL: ALL PASSED" : `\nFINAL: FAILED (${results.filter(([, ok]) => !ok).length} failures)`);
process.exit(pass ? 0 : 1);
