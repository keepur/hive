# Beekeeper `/clear` Session Handoff

**Ticket:** dodi-hq/hive#113
**Status:** Design
**Date:** 2026-04-09

## Problem

The beekeeper `/clear` slash command (shipped in #97/#98) tears down the current session server-side and creates a new one, but the client has no way to atomically adopt the new session. The server emits two disconnected messages — `context_cleared` followed later by a generic `session_info` — and the iOS client treats `context_cleared` as terminal. From the user's perspective, `/clear` ends the conversation instead of resetting it.

This is a follow-up to #97/#98. Server-side behavior (teardown + new session creation) is already correct; the bug is in the wire protocol contract between server and client.

## Goals

- `/clear` feels like "reset this conversation" from the client's perspective: session wipes, new one is ready, user keeps typing.
- Single atomic swap signal on the wire — no implicit coupling between two unrelated messages.
- No regressions to the non-`/clear` new-session path.

## Non-Goals

- iOS client implementation (separate PR in `keepur-ios`).
- Retry/resilience on `newSession()` failure beyond what exists today.
- Changes to `/help`, `/status`, or any other slash command.

## Root Cause

Current `handleClear()` flow (`src/beekeeper/session-manager.ts:408`):

1. Interrupt and delete the old slot.
2. Emit `context_cleared { oldSessionId, sessionId: <oldId> }` — the `sessionId` field duplicates `oldSessionId` and carries no information about the replacement.
3. Call `newSession(cwd)`, which runs a welcome query. The SDK `init` event fires inside `runQuery`, which emits a generic `session_info { sessionId: <new>, path }` — the same shape used by every other new-session path.

On the wire the client sees:

```
context_cleared   (old session ended)
session_info      (a new session exists — but no signal it's the replacement)
message/status …  (welcome stream)
```

The client has no way to tell that the `session_info` is the replacement for the cleared session versus an unrelated event, so it does not auto-adopt it.

## Design

### Protocol change

Replace `context_cleared` with a new atomic `session_replaced` message.

**`src/beekeeper/types.ts`:**

```ts
// REMOVED
| { type: "context_cleared"; oldSessionId: string; sessionId: string }

// ADDED
| { type: "session_replaced"; oldSessionId: string; newSessionId: string; path: string }
```

`context_cleared` is removed entirely — nothing else uses it.

### Server flow

`handleClear()` becomes:

1. Guard against concurrent `/clear` calls via `slot.clearing` (unchanged).
2. Interrupt active query, await `queryDone`, delete slot, persist (unchanged).
3. Call the refactored `newSession(cwd, { suppressClientSignals: true })` that:
   - Returns early as soon as the SDK emits `init`, yielding the real `newSessionId`.
   - Suppresses the intermediate `status` and `session_info` emits from the bootstrap query so nothing about the new session reaches the client before `handleClear` can emit `session_replaced`.
4. Emit `session_replaced { oldSessionId, newSessionId, path: cwd }`.
5. Background welcome query continues streaming. Its `status` / `message` / `result` events flow to `newSessionId`, which the client has already adopted — they land naturally as the inaugural response in the new session. (Because the slot map-key swap has happened by this point, `send()` routes them via the slot's `outputBuffer` when the client is offline, not `globalBuffer`.)
6. On `newSession()` throw (including the init-never-fires case — see below): emit `error`, do not emit `session_replaced`. Client stays in its spinner / empty state, user retries manually.

### `newSession()` refactor

Today `newSession()` awaits the entire welcome query before returning. It must return early — as soon as the SDK emits `init` — so `handleClear()` can fire `session_replaced` before any new-session signal reaches the client. The `runQuery` emit sites also need to honor a suppression flag for the `/clear` bootstrap path.

**`runQuery` signature change:**

```ts
interface RunQueryOptions {
  /**
   * When true, suppress the initial `status(thinking)` emit and the
   * `session_info` emit on SDK init. Used by /clear to avoid leaking
   * intermediate new-session signals to the client before session_replaced.
   */
  suppressClientSignals?: boolean;
  /**
   * Called synchronously when the SDK's `system/init` message arrives,
   * carrying the real session_id. Used by newSession() to return early.
   */
  onInit?: (realSessionId: string) => void;
}

private async runQuery(slot: SessionSlot, text: string, opts?: RunQueryOptions): Promise<string>
```

Inside `runQuery`:

- The existing `send({ type: "status", state: "thinking", … })` at the top is gated on `!opts?.suppressClientSignals`.
- The existing `send({ type: "session_info", … })` on `init` is gated on `!opts?.suppressClientSignals`. The side effect of capturing `resolvedSessionId` / `slot.sessionId` still happens.
- On `init`, after mutating `slot.sessionId`, call `opts?.onInit?.(resolvedSessionId)`.
- The existing pre-existing `status(thinking)` emit on line 459 that reports `slot.sessionId = "pending-*"` is only a problem under the old flow because the pending ID could leak. Under suppression this is moot; under the non-clear `new_session` path the pending ID still leaks, but that's a pre-existing issue out of scope for this ticket.

**`newSession()`:**

```ts
async newSession(cwd: string, opts?: { suppressClientSignals?: boolean }): Promise<string> {
  const pendingId = `pending-${randomUUID()}`;
  const slot: SessionSlot = { sessionId: pendingId, cwd, activeQuery: null, state: "idle", outputBuffer: [] };
  this.sessions.set(pendingId, slot);

  const initDeferred = createDeferred<string>();
  let initFired = false;

  const donePromise = this.runQuery(slot, "You are now connected. Briefly acknowledge readiness.", {
    suppressClientSignals: opts?.suppressClientSignals,
    onInit: (realId) => {
      initFired = true;
      initDeferred.resolve(realId);
    },
  });

  // If runQuery settles without init ever firing, reject the init deferred
  // so newSession() doesn't hang forever. Covers both:
  //   - SDK throws/errors before init (donePromise rejects)
  //   - SDK returns a `result` before emitting `system/init` (donePromise resolves)
  donePromise.finally(() => {
    if (!initFired) {
      initDeferred.reject(new Error("Session never initialized (SDK completed without init event)"));
    }
  });

  slot.queryDone = donePromise;

  const realId = await initDeferred.promise;

  // Swap the map key from pending to real.
  this.sessions.delete(pendingId);
  slot.sessionId = realId;
  this.sessions.set(realId, slot);
  this.persistSessions();

  // donePromise continues in the background; welcome stream flows to the
  // (now properly keyed) slot. Intentional behavior change: offline clients
  // will see welcome stream messages routed via the slot's outputBuffer
  // rather than globalBuffer, matching how all other runQuery output is buffered.
  return realId;
}
```

`createDeferred<T>()` is a trivial helper (`{ promise, resolve, reject }`). Inline if preferred.

**Non-`/clear` new-session path** (`index.ts` WS handler `case "new_session"` at line ~454): continues to call `newSession(cwd)` without options. Behavior change for this path:

- It now returns on init instead of on full welcome-query completion. The current caller is fire-and-forget (awaits the promise but does nothing with the return value), so there is no functional regression.
- Client-facing emits (`status(thinking)`, `session_info`, welcome stream) are unchanged for this path because `suppressClientSignals` is not set.

### Client contract (documented for `keepur-ios`)

Not implemented in this repo, but the iOS PR must:

- On user typing `/clear`: optimistically wipe the chat view and show an empty/loading state immediately. Do not wait for a server signal.
- On receiving `session_replaced { oldSessionId, newSessionId, path }`: switch the active session to `newSessionId`. Subsequent `status` / `message` / `session_info` events for `newSessionId` stream into the fresh chat view naturally.
- On receiving `error` during the clearing window (no `session_replaced` yet): drop the spinner, surface the error, leave the chat empty. The user can manually start a new session or retry `/clear`.

## Tests

`src/beekeeper/session-manager.test.ts` — update existing `/clear` tests and add one new case.

Updates (replace `context_cleared` assertions with `session_replaced`):

- `/clear sends context_cleared, destroys session, creates new one` → rename and assert `session_replaced { oldSessionId, newSessionId, path }` with `newSessionId` matching the fresh session's ID, not the old one.
- `/clear is case-insensitive` → same assertion swap.
- `/clear works when session is busy — interrupts active query` → same assertion swap.
- `/clear when newSession() SDK fails — sends error, does not throw` → assert no `session_replaced` is sent and an `error` message is present.
- `concurrent /clear calls — second call is a no-op` → assert exactly one `session_replaced` across both calls.

New:

- `session_replaced fires before any new-session signals reach the client` — mock a delayed welcome stream with an `init` event followed by streamed `message` events. Assert: (a) `session_replaced` appears on the wire before any welcome `message` event, (b) no `session_info` or `status(thinking)` event for the new sessionId is ever emitted (these are suppressed under `suppressClientSignals`), (c) streamed `message` and `result` events for the new sessionId *do* still reach the client after `session_replaced` — only the init-time signals are suppressed.
- `/clear when SDK completes without emitting init — sends error, does not hang` — mock a `runQuery` that settles (success or throw) without ever yielding a `system/init` message. Assert `newSession()` rejects, `handleClear` catches it, an `error` message is emitted, and no `session_replaced` appears.
- `newSession() non-clear path still emits session_info and status on init` — regression test confirming the `new_session` WS handler path is unaffected by the suppression flag (client still sees `status(thinking)` + `session_info` + welcome stream as before).

## Rollout

- Server ships in hive-113 PR into `main`, deploys to beekeeper instance.
- iOS client ships separately in `keepur-ios`. Until that ships, `/clear` on existing iOS builds will continue to see the session end (no worse than current behavior — the old `context_cleared` message is gone, but the iOS client's handling was already broken).
- No migrations, no feature flag — the protocol change is small and `/clear` is the only consumer.

## Risks

- **iOS client lag:** if the iOS update lags behind the server deploy, `/clear` will produce an unknown-message-type warning in the client and no session handoff — functionally equivalent to today's bug. Mitigation: coordinate the two PRs.
- **`newSession()` refactor regressing non-clear path:** the change to early-return on init must not break the existing `new_session` client message flow. Covered by the new regression test plus the existing `newSession()` tests; verify they still pass.
- **Background welcome-query errors:** since `newSession()` no longer awaits full completion, errors in the welcome stream happen after `newSession()` has returned. They still land on the client via the existing `runQuery` error path (`error` / non-success `result`), but the `/clear` caller no longer sees them as exceptions. Acceptable — a failed welcome message is cosmetic, not a lifecycle failure.
- **Welcome-stream buffering behavior change:** under the old flow, if the client disconnected during `newSession()`, welcome messages buffered via `globalBuffer` because the slot was keyed on `pending-*` while `slot.sessionId` was already the real ID (`send()` would miss the slot lookup). Under the new flow the map-key swap happens early, so welcome messages route via the slot's `outputBuffer`. This matches how every other `runQuery` output is buffered and is the intended behavior, but it is a visible change for a narrow edge case (client disconnects during `/clear`'s ~1-3s window).
- **`slot.clearing` is write-once:** this flag is set to `true` at the top of `handleClear` and is never reset because the slot is deleted immediately after. No change in this spec — called out to acknowledge the existing pattern, not fix it.
