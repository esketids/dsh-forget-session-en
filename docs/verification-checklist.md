# dsh-forget-session verification / troubleshooting checklist

## Usage (two-step confirmation)

1. Session row "…" menu → click **"Forget session"** (the item after the four official ones)
2. The row becomes **"Click again to confirm"** (only the next click actually runs)
3. Click again → the row disappears, and the session plus its disk data are removed; a top Toast reports the deletion summary
4. For about 2 minutes afterward, the Host's **resurrection guard** re-checks several times: directories recreated by late writes from the live teardown, or left over by Windows handles, are deleted automatically

If you do not want to delete, click elsewhere to close the menu; there are no side effects.

## Why the session row really disappears (mechanism)

The official sidebar grouping algorithm:

```
accounted = union of all workspace.sessionIds
Ungrouped = ids in the client session list − accounted
```

Since v2.2, the Host first detaches the live session from `SessionStore` (the
entry's own official `detach()`: `store.delete` + `attachments.delete` +
`emitDisposed`) — this triggers the server's `api-session/removed` frame, and
`session.list` no longer lists it; the client half then calls the official
`sessions.handleSessionRemoved(id)` + `sessions.refresh()` to reload the
baseline. Double insurance makes the row disappear immediately and stay gone.

## Three sources of the "Ungrouped" ghost

1. **Windows live-deletion race**: once a session has been opened there is a
   write handle / cross-process lease, so `rm` reports EBUSY and fails silently
   → files remain → after a restart the session returns to "Ungrouped". v2 does
   a verification re-check + backoff retries + a ~130s resurrection guard after
   deletion; once the handle is released or a late write recreates the files,
   they are deleted again automatically.
2. **Client list resurrection**: the Host's session.list still lists live
   sessions, and the client's refreshList on reconnect merges deleted rows back.
   v2 calls `sessions.refresh()` after deletion.
3. **Live entry never detached (root-fixed in v2.2)**: `SessionStore` has no
   public remove API; after a session has entered the store, `session.list`
   (live + persisted merge) always lists it — immediately after deletion it
   returns to "Ungrouped"; and the persistence writer holds a write handle that
   keeps the disk busy, `rm` gets EBUSY, and even the guard deleting for ~130s is
   wasted. v2.2 removes the live entry through the official `entry.detach()`
   channel: the row disappears from the list (official removed frame) and the
   write handle is released (so disk deletion actually works).

> Historically there was also an old issue where "empty-shell sweeping never
> worked" (v1's sweep method referenced an unimported `zlib`). That capability,
> along with the "session health check" menu, was removed entirely at the user's
> request — the contract surface now has only the `delete` method, with no extra
> entry that would produce a `typert gateway` error.

## Self-check after restart

- The menu shows "Forget session" → the client half is loaded
- The first click changes it to "Click again to confirm" → the interaction chain works
- After the second click the row disappears and "Ungrouped" does **not** appear → the fix is active
- Wait 30 seconds after deletion, then refresh/reconnect → the row does not return (resurrection guard works)
- The menu has **no** other extra items (such as "session health check") → the contract surface is clean

## If something goes wrong

Errors are shown **directly on the menu row** (never silently):

| Shown on the row | Meaning | Action |
|---|---|---|
| `Forget failed: Host service is not connected (restart DSH)` | The host half is not loaded | Restart DSH |
| `Forget failed: workspaceRegistry service is unavailable (workspace plugin not loaded)` | The workspace plugin is not ready | Restart DSH |
| `file still present after retries` (console warning) | A Windows handle was left over | No action — the resurrection guard deletes it once the handle is released |

## Recovery point

Before deleting, the plugin goes through the official "stop and archive"
channel, then removes accounting. Even if it fails midway, the worst case for
the session is **"archived"**, which can be recovered from the sidebar's "All
chats (show archived)" (the disk files still exist on this path).

## Memory integrity

Lingxu memory uses the `session/event` event stream and stores data in
`~/.dsh/.dsh-memory`, which does not intersect with session log / projection
cache files. Forgetting a session does not affect accumulated memory.

## Automated tests

```powershell
cd <this repository directory>
node test/verify.mjs   # 15 assertions, isolated HOME, never touches real data
```
