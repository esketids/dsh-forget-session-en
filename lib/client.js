/**
 * dsh-forget-session-en — browser half v2.
 *
 * Adds a "Forget session" row to the session row's "…" menu
 * (`sidebar.workspaces.session.menu.item`), using a **two-step confirmation**:
 * the first click turns the row into "Click again to confirm", and only the
 * second click actually runs. All state lives inside the menu item component;
 * if the component can render, it can work. Errors are shown directly on this
 * row, never silently.
 *
 * v2 upgrade (paired with Host half v2):
 *
 *  1. After a successful deletion, call the official `sessions.refresh()` to
 *     reload the session baseline — if the Host still lists the session because
 *     it is live (refreshList merges the row back), the refresh removes it again
 *     before the resurrection becomes visible. (Disk-side resurrection is
 *     handled independently by the Host half's resurrection guard; the
 *     frontend does not need to participate.)
 *  2. Menu text includes a deletion summary (how many artifacts, how many
 *     warnings), and the result is reported in a top Toast.
 *
 * The contract surface mounts only one method, `delete`: extra methods make the
 * typert gateway reject the whole batch (manifesting as a
 * `typert gateway: forgetSessionEn/...` error), so the surface stays minimal.
 */
window.__ModuleLoader__.load({
	id: "dsh-forget-session-en",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { useState, useEffect } = React;

		const PLUGIN_ID = "dsh-forget-session-en";
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		const MENU_ORDER = 500;

		/** Text (built-in English; does not depend on the host locale service). */
		const TEXT = {
			menu: "Forget session",
			armed: "Click again to confirm",
			busy: "Forgetting…",
			failed: "Forget failed: {message}",
			done: "Forgotten ({files} artifacts{warn})",
			doneWarn: ", {count} warning(s) — see console"
		};
		const format = (key, params) => {
			let text = TEXT[key] ?? key;
			if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
			return text;
		};

		/** In-app Toast bus: during apply we only emit (showToast); all React hooks stay in components. */
		/** Hooks must never be called during apply (outside a React render context) — useState throws because the dispatcher is null, which makes the whole fiber FAILED. */
		const toastBus = { listener: null, seq: 0 };
		const showToast = (text, tone) => {
			const item = { seq: ++toastBus.seq, text, tone };
			try {
				if (toastBus.listener) toastBus.listener(item);
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] toast dispatch failed:`, error);
			}
		};

		/** shell.overlay resident component: subscribes to toastBus and renders the top Toast (same registration as dsh-market/workbuddy-update). */
		function ForgetSessionToaster() {
			const [toast, setToast] = useState(null);
			useEffect(() => {
				toastBus.listener = setToast;
				return () => {
					toastBus.listener = null;
				};
			}, []);
			if (toast === null) return null;
			return jsxRuntime.jsx(primitives.Toast, {
				text: toast.text,
				tone: toast.tone,
				holdMs: 6_000,
				onDone: () => {
					setToast((current) => (current !== null && current.seq === toast.seq ? null : current));
				}
			});
		}

		/**
		 * Ask the client to remove this session from the **session list**.
		 *
		 * The official sidebar grouping algorithm:
		 *
		 *   accounted = union of all workspace.sessionIds
		 *   Ungrouped = ids in the client session list − accounted
		 *
		 * Removing only the Host-side accounting without clearing the client list
		 * leaves the deleted session as a ghost in "Ungrouped". The official
		 * removal path is the server-side `api-session/removed` frame → the client
		 * `sessions.handleSessionRemoved(id)`. Here we call **the same official
		 * method** directly.
		 *
		 * @returns {boolean} Whether the official channel was used (false means we
		 *   had to fall back to DOM removal).
		 */
		function releaseSessionRow(ctx, sessionId) {
			try {
				const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : undefined;
				if (sessions && typeof sessions.handleSessionRemoved === "function") {
					sessions.handleSessionRemoved(sessionId);
					return true;
				}
				console.warn(`[${PLUGIN_ID}] client sessions service unavailable; falling back to DOM removal`);
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] official row removal failed:`, error);
			}
			return false;
		}

		/** DOM fallback: when the official channel is unavailable, at least remove the row from the page. */
		function removeSessionRow(sessionId) {
			try {
				const selector = `[data-row-key="session:${CSS.escape(sessionId)}"]`;
				for (const node of document.querySelectorAll(selector)) node.remove();
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] row removal skipped:`, error);
			}
		}

		/** Official list reload (to counter refreshList resurrection); failures are only logged to the console. */
		function refreshClientList(ctx) {
			try {
				const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : undefined;
				if (sessions && typeof sessions.refresh === "function") {
					Promise.resolve(sessions.refresh()).catch((error) => {
						console.warn(`[${PLUGIN_ID}] list refresh failed:`, error);
					});
				}
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] list refresh skipped:`, error);
			}
		}

		/**
		 * Menu row: two-step confirmation + inline feedback.
		 *
		 * The real props of the official `MenuItemButton` are
		 * `{ children, shortcut, icon, disabled, danger, separatorBefore, onSelect }`,
		 * so this uses only that prop set and not fields such as `title`/`label`
		 * that do not exist.
		 */
		function ForgetSessionMenuItem({ sessionId, useMenuOpenState, call, dropSession, refreshList, showToast }) {
			const [phase, setPhase] = useState("idle");
			const [error, setError] = useState(null);
			// Slot-level hook: normally always present; when missing, degrade to a
			// no-op and never throw because it is unavailable.
			const menuOpenState = typeof useMenuOpenState === "function" ? useMenuOpenState() : undefined;
			const setMenuOpen = Array.isArray(menuOpenState) ? menuOpenState[1] : () => {};

			const forget = () => {
				setPhase("busy");
				setError(null);
				Promise.resolve(call("delete", { sessionId })).then((result) => {
					if (result && result.ok === false) {
						setPhase("error");
						setError(result.error || "unknown error");
						return;
					}
					const removed = result?.removed;
					const warnings = removed?.warnings;
					if (Array.isArray(warnings) && warnings.length > 0) {
						console.warn(`[${PLUGIN_ID}] host warnings for ${sessionId}:`, warnings);
					}
					// Row removal: prefer the official channel; then reload the
					// official list to realign (against refreshList resurrection).
					if (typeof dropSession === "function") dropSession(sessionId);
					else removeSessionRow(sessionId);
					if (typeof refreshList === "function") refreshList();
					if (typeof showToast === "function") {
						const warnNote = Array.isArray(warnings) && warnings.length > 0
							? format("doneWarn", { count: warnings.length })
							: "";
						showToast(format("done", { files: removed?.filesRemoved?.length ?? 0 }) + warnNote, warnings?.length > 0 ? undefined : "success");
					}
					setPhase("idle");
					setMenuOpen(false);
				}).catch((reason) => {
					setPhase("error");
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};

			const onSelect = () => {
				if (phase === "busy") return;
				if (phase === "idle") {
					// First step: enter the pending-confirmation state, keep the menu
					// open, and wait for the second click.
					setPhase("armed");
					setError(null);
					return;
				}
				// Second step (armed / error): actually run.
				forget();
			};

			const label =
				phase === "busy" ? format("busy")
					: phase === "armed" ? format("armed")
						: phase === "error" ? format("failed", { message: error ?? "unknown" })
							: format("menu");

			return jsxRuntime.jsx(primitives.MenuItemButton, {
				icon: jsxRuntime.jsx(primitives.IconTrashOutlineRegular, {}),
				disabled: phase === "busy",
				danger: phase === "armed",
				onSelect,
				children: label
			});
		}

		async function apply(ctx) {
			// ── Host contract mount (same shape as the official descriptor, strict codec writes both keys) ──
			const ANY_VALUE_SCHEMA = { parse: (v) => v };
			const strictCodec = (symbol) => ({
				mode: "strict",
				typeSymbol: `${PLUGIN_ID}/typert#${symbol}`,
				schema: ANY_VALUE_SCHEMA,
				create: () => ANY_VALUE_SCHEMA
			});
			const descriptorFor = (method) => ({
				id: `${PLUGIN_ID}#forgetSessionEn/${method}`,
				service: "forgetSessionEn",
				namespace: "forgetSessionEn",
				method,
				invocation: { kind: "direct" },
				parameters: [{ name: "payload", wire: "payload", source: "json", codec: strictCodec("AnyValue") }],
				result: strictCodec("AnyResult"),
				sourceLocation: { file: `${PLUGIN_ID}/lib/index.js`, line: 1, column: 1 }
			});
			const DESCRIPTORS = [descriptorFor("delete")];

			const disposeMount = await ctx.remote.$mount({ package: PLUGIN_ID, descriptors: DESCRIPTORS });

			/**
			 * Call the Host: returns the unified envelope `{ ok, ...value }` /
			 * `{ ok:false, error }`, converting any exception into a displayable
			 * error (never silent).
			 */
			const call = async (method, args) => {
				try {
					const service = typeof ctx.get === "function" ? ctx.get("remote.forgetSessionEn") : null;
					if (!service || typeof service[method] !== "function") {
						return { ok: false, error: "Host service is not connected (restart DSH)" };
					}
					const reply = await service[method](args);
					if (reply && reply.ok === true) {
						return { ok: true, ...((reply.value && typeof reply.value === "object") ? reply.value : {}) };
					}
					const detail = reply?.error;
					return { ok: false, error: (detail && (detail.message || detail.code)) || "Host call failed" };
				} catch (reason) {
					return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
				}
			};

			// In-app Toast: a resident shell.overlay component (same registration as dsh-market/workbuddy-update).
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "forget-session-en-toast" }, ForgetSessionToaster)
			);

			const dropSession = (sessionId) => releaseSessionRow(ctx, sessionId);
			const refreshList = () => refreshClientList(ctx);

			// Session row "…" menu: Forget session (the only item; the contract surface stays minimal).
			ctx.slots.inject(MENU_SLOT, () =>
				ctx.slots.register({
					name: MENU_SLOT,
					id: "forget-en",
					order: MENU_ORDER,
					inject: () => ({ call, dropSession, refreshList, showToast })
				}, ForgetSessionMenuItem)
			);

			return async function cleanup() {
				try { await disposeMount?.(); } catch { /* already unmounted */ }
			};
		}

		const inject = ["slots", "remote", "typert"];

		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
