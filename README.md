# dsh-forget-session-en

**English fork of [dsh-forget-session](https://github.com/2026heshao/dsh-forget-session) by [2026heshao](https://github.com/2026heshao).** This fork translates the UI text, code comments, documentation, and error messages to English, and uses its own package, plugin-row, service, and slot IDs so it can be installed alongside the original instead of colliding with it. The behavior is otherwise identical to upstream v2.2.1.

See [docs/verification-checklist.md](docs/verification-checklist.md) for the verification and troubleshooting checklist.

A DeepSeek Harness (DSH) plugin that adds a **"Forget session"** item to the session row's "…" menu and removes that session completely from the sidebar and from disk. Data accumulated by the Lingxu memory plugin is not affected. It works on both the desktop and web builds (the plugin UI runs in the same browser rendering layer in both, so behavior is identical).

> **Compatibility**: fully tested on DeepSeek Harness 44.7.0 (host bundles `@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2` / cordis 4.0.5); the declared peer range `>=0.1.5-rc.1` still covers it, and this version needs no code changes.

## Features

Adds exactly one item, in the **session row "…" menu**:

- **"Forget session"** (order 500, placed after the official "Pin / Rename / Branch / Archive" items)
- **Two-step confirmation** after clicking: the row becomes "Click again to confirm", and only the next click executes
  (everything happens inside the menu, with no dialog; failures are shown directly on this row, never silently)
- On success the row disappears and a top Toast reports the deletion summary (how many artifacts were deleted, how many warnings)

| Deleted object | Method |
| --- | --- |
| Running work | Official `workspace/session-stop` waterfall (stopActivity archive path) |
| **Live session (inside the Session store)** | Official `entry.detach()` internal channel: `store.delete` + `attachments.delete` + `emitDisposed` (new in v2.2; see root cause 3 below) |
| Workspace accounting (`sessionIds` in workspace.json) | Official `detachSession` channel (domain write chain) |
| Archive set / pinned set | Official `unarchiveSession` / `unpinSession` |
| Session log directory `~/.dsh/sessions/<project key>/<id>` | Whole-directory delete (including `_no-cwd`, legacy unprefixed layouts, and in-use retries) |
| Projection cache shard `~/.dsh/storages/session_projcache/sessions/<id>.json` | Delete |
| Table entry in the projection cache `~/.dsh/storages/session_projcache.json` | Read-modify-write; everything else is preserved as-is |
| Resurrected files (leftover handles / recreated by late writes) | The Host "resurrection guard" deletes them again automatically within a ~2-minute window |
| Sidebar session row (client session list) | Official `sessions.handleSessionRemoved(id)` + `sessions.refresh()` |

**Data left untouched**: Lingxu memory (`~/.dsh/.dsh-memory`), attachments, and any other session.

## What was fixed (why deleted sessions returned to "Ungrouped")

"Ungrouped" = ids in the client session list − the union of all `workspace.sessionIds`.
After gathering evidence package by package from the official source, three resurrection paths were confirmed:

| Root cause | Mechanism | Countermeasure |
| --- | --- | --- |
| **Windows live-deletion race** | Once a session has been opened there is a write handle / cross-process lease: `rm` on the directory reports EBUSY/EPERM, v1 failed silently → files remained → the registry re-adopted them after a restart; and a late append from the live teardown after deletion could **recreate the deleted directory** | **Verification re-check** after deletion, with backoff retries for in-use errors; set up a **resurrection guard**: exponential backoff starting at 2s (capped at 32s) and periodic re-checks for a total window of ~130s, immediately deleting any recreated directory |
| **Client list resurrection** | The Host's `session.list` still lists live sessions; any client `refreshList` (triggered on reconnect) merges the deleted rows back | After deletion, call the official `sessions.refresh()` to reload the baseline, so the resurrected row is removed again before it becomes visible |
| **Live entry never detached (root-fixed in v2.2)** | `SessionStore` has no public remove API: once a session enters the store, `session.list` (which merges live + persisted sessions) always lists it — after deletion it **immediately** returns to "Ungrouped"; and the persistence writer holds a write handle that keeps the disk busy, so `rm` gets EBUSY and even the resurrection guard deleting for ~130s is wasted | Use the official `entry.detach()` carried by every store entry (= `store.delete` + `attachments.delete` + `emitDisposed`): this both removes the row from `session.list` (official `api-session/removed` frame) and releases the persistence write handle — only then does the disk deletion actually work |

> v2 once also added extra remote endpoints such as "session health check / empty-shell sweep / audit inventory", but they were never mounted with the client contract; clicking them only produced a `typert gateway` error, making them a useless surface — they have all been removed, and the contract surface keeps only the single `delete` method.

## Remote contract

The `forgetSessionEn` service exposes only one method:

| Method | Parameters | Behavior |
| --- | --- | --- |
| `delete` | `{ sessionId }` | Full waterfall deletion (authoritative state + disk artifacts + resurrection guard) |

## Installation

Install from npm with the official DSH command (whichever profile you install into is where it takes effect):

```sh
dsh plugin --profile web add dsh-forget-session-en
```

Or install directly from the repository:

```sh
dsh plugin --profile web add github:esketids/dsh-forget-session-en
```

**Restart DSH** after installation for it to take effect (replace the value after `--profile` with the profile name you actually use).

## Uninstall

```sh
dsh plugin --profile web remove dsh-forget-session-en
```

`remove` also removes the dependency and the patch layer; after restarting DSH the menu returns to its original state.

## How it works (for maintainers)

- **Host half** (`lib/index.js`): a `TypertRemoteService` named `forgetSessionEn` with
  `inject: ["workspaceRegistry"]`. `delete()` goes through the official state channels
  (stop / unarchive / unpin / **live detach** / detach), then deletes disk artifacts
  using the same path algorithm as `session-persistence-jsonl` (`projectKey` +
  `encodeSegment`) (retrying in-use errors with backoff + verification re-check),
  cleans the projection cache, and finally sets up the resurrection guard. It never
  edits `workspace.json` by hand — accounting is done through the registry's official
  mutate write chain. Live removal obtains the entry via
  `ctx.get("sessions").store` (a public class field Map) and calls `entry.detach()`,
  which is equivalent to the official `SessionStore.detachEntered`.
- **Browser half** (`lib/client.js`): a `window.__ModuleLoader__` bundle;
  `ctx.remote.$mount` mounts a contract with only the single `delete` method
  (strict codec writes both keys); `ctx.slots.inject("sidebar.workspaces.session.menu.item", ...)`
  registers the menu row. Toasts use `primitives.Toast`, rendered through a
  module-level toast bus + a resident `shell.overlay` component (**React hooks must
  never be called inside `apply()`** — there is no dispatcher outside a render
  context, which makes the whole fiber FAILED).
- **Resurrection guard**: started after a successful `delete()` (whether or not this
  pass removed everything); each step re-checks the log directory (located by
  project key when cwd is known, otherwise a full scan) and the shard cache, and a
  successful deletion also clears the shard. An explicit delete of the same session
  resets the guard.

## Tests

```powershell
cd <this repository directory>
node test/verify.mjs
```

With an isolated HOME (`DSH_FORGET_SESSION_HOME` points at a temporary directory),
15 assertions cover: the contract surface contains only `delete`, the full `delete`
waterfall (live flush/detach, directory/shard/table entry/workspace detach), zero
collateral damage to normal sessions, idempotency, missing-argument errors, and the
resurrection guard deleting a recreated directory.

> The test needs `@deepseek-ai/cordis` and `@deepseek-ai/dsh-typert-protocol`
> (peer dependencies, supplied by DSH) and can be run directly inside a profile
> where this plugin is installed.

## Known limitations

- The official DSH design is "archive sessions, never delete them" (see the
  dsh-client-ui-workspace README); this plugin is a user-level addition beyond the
  official channels.
- If the deleted session is live in this process: buffered events are first
  `flush`ed to disk, then the session is detached from the store via
  `entry.detach()` (the official dispose channel closes the persistence write
  handle). Late writes from the teardown within the guard window (~130s) are
  deleted afterwards. Deleting idle sessions is recommended.
- For the session search index (`session-query-sqlite`), when `openAt` is not
  `never`, deleted session rows converge automatically on the next `_reconcile`
  (any search) — the persisted list no longer contains the id, and the index clears
  it through `persistentDeletes`; `openAt: never` (the default) is in-memory and
  self-heals.

## License

MIT
