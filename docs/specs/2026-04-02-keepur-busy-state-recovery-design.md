# Keepur Busy State Recovery

**Date:** 2026-04-02
**Repo:** keepur-ios-12
**Scope:** Client-side only — no beekeeper server changes

## Problem

When the Keepur app sends a message to beekeeper while a session is processing, the app can get stuck in a non-responsive state permanently. Two bugs combine:

1. **Race condition on send.** The client only queues messages when local state is `"busy"`, but the server rejects messages anytime `slot.state === "busy"` — which covers all processing states (thinking, tool_running, tool_starting). A user sending a message during "thinking" state bypasses the client queue, the server discards the message payload and responds with a `busy` status. The message content is permanently lost because the client already sent it over the wire and has no copy to retry.

2. **No recovery from stale busy.** If the `idle` status is missed (app backgrounded, WS hiccup, long-running query), the client displays "Server busy..." forever with no self-healing mechanism.

## Design

### Change 1: Widen the Queue Gate

**Current** (`ChatViewModel.sendText()`):
```swift
if statusFor(sessionId) == "busy" {
    // queue locally
} else {
    // send immediately
}
```

**New:**
```swift
if statusFor(sessionId) != "idle" {
    // queue locally
} else {
    // send immediately
}
```

Any non-idle state means the server cannot accept a new message. Queue it locally and flush when idle arrives.

### Change 2: Flush on Transition to Idle

**Current** (status handler):
```swift
if previousState == "busy" && state != "busy" {
    flushPendingMessages(for: effectiveId)
}
```

**New:**
```swift
if state == "idle" && !pendingMessages.filter({ $0.sessionId == effectiveId }).isEmpty {
    flushNextPendingMessage(for: effectiveId)
}
```

Flush **one message at a time** whenever we receive `idle`. No need to track previous state — simpler and handles all transition paths.

`flushNextPendingMessage` replaces `flushPendingMessages` — it sends only the first pending message for the session, removes it from the queue, and leaves the rest. When the server finishes processing that message and sends the next `idle`, the next pending message flushes. This avoids the bug where flushing all at once causes messages 2+ to be dropped by the server (which goes busy after processing message 1).

```swift
private func flushNextPendingMessage(for sessionId: String) {
    guard let index = pendingMessages.firstIndex(where: { $0.sessionId == sessionId }) else { return }
    let pending = pendingMessages.remove(at: index)
    pendingMessageIds.remove(pending.messageId)
    ws.send(.message(text: pending.text, sessionId: pending.sessionId))
}
```

The existing `clearPendingMessages(for:)` stays for the `session_ended` and cancel paths. The old `flushPendingMessages` method is removed.

### Change 3: Stale-Busy Timeout

Add a per-session watchdog timer. When any non-idle status is received, start/reset a 90-second timer. If it fires without a new status update:

1. Transition the session to `idle` locally
2. Flush the next pending message (if any)

**Implementation** — use `Task` cancellation (idiomatic Swift concurrency for `@MainActor`):
```swift
private static let staleBusyTimeout: TimeInterval = 90
private var busyTimers: [String: Task<Void, Never>] = [:]
```

In the `.status` handler, after updating `sessionStatuses`:
- If `state != "idle"`: cancel existing task, start new one:
  ```swift
  busyTimers[effectiveId]?.cancel()
  busyTimers[effectiveId] = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.staleBusyTimeout))
      guard !Task.isCancelled else { return }
      self?.sessionStatuses[effectiveId] = "idle"
      self?.flushNextPendingMessage(for: effectiveId)
  }
  ```
- If `state == "idle"`: cancel timer (no longer needed)

The timeout value (90s) is generous — long enough that normal Claude queries won't trigger it, short enough that the user doesn't sit there forever. A tool_running or thinking status resets the timer, so active-but-slow queries keep the timer fresh.

### Change 4: Reconcile State on Reconnect

Add an `onConnect` callback to `WebSocketManager` (alongside existing `onMessage` and `onAuthFailure`). Fire it when the WS task transitions to connected state. In `ChatViewModel.configure()`, wire it up:

```swift
ws.onConnect = { [weak self] in
    self?.listSessions()
}
```

The `session_list` response includes each session's `state` field (binary: `"idle"` or `"busy"` — the server's slot-level state, not granular thinking/tool_running). In `syncSessions()`, add status reconciliation:

**Current:** `syncSessions()` only handles stale detection (marking sessions not in server list as stale).

**New:** Also update `sessionStatuses` from the server's reported state per session. If a session the client thinks is busy but the server reports idle, transition to idle and flush the next pending message.

| File | Change |
|------|--------|
| `Managers/WebSocketManager.swift` | Add `onConnect` callback, fire on successful connection |
| `ViewModels/ChatViewModel.swift` | Wire `onConnect`, update `syncSessions` to reconcile statuses |

## Files Changed

| File | Change |
|------|--------|
| `ViewModels/ChatViewModel.swift` | Widen queue gate, one-at-a-time flush, busy timeout, reconnect sync |
| `Managers/WebSocketManager.swift` | Add `onConnect` callback |

No new files. No server changes. No protocol changes.

## Edge Cases

- **Multiple pending messages:** Only the first pending message flushes on each `idle`. Server processes it, goes busy, sends `idle` when done, next message flushes. Messages drain one per idle cycle. Convergence is guaranteed.
- **Timeout fires during legitimate processing:** The client sends one pending message. If the server is still busy, it responds with `busy` status, which resets the timer. The message payload is lost (same as the original bug), but the timeout prevents permanent stuckness — worst case one message is sacrificed to break the deadlock.
- **Session ends while messages are pending:** Existing `session_ended` handling already calls `clearPendingMessages`. No change needed.
- **App backgrounded during query:** On return, WS reconnects, `listSessions()` fires, state reconciles, pending messages flush if session is idle.

## Not in Scope

- Server-side message queueing — adds multi-client complexity for no benefit
- UI changes to the busy indicator — existing "Server busy..." display is fine
- Disabling the send button during processing — users should be able to type and queue; their message appears immediately in the chat
