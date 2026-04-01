# Beekeeper Chat Resilience — Server-Side

**Date:** 2026-04-01
**Status:** Draft
**Scope:** Beekeeper server changes to support iOS chat resilience features
**Companion spec:** `keepur-ios/docs/specs/2026-04-01-chat-resilience-design.md` (client-side)

## Problem

Three gaps in the beekeeper ↔ client protocol:

1. **AskUserQuestion tool vanishes** — Claude calls `AskUserQuestion`, the built-in handler fails (no TTY), client gets an error it can't render. The question is lost.
2. **No non-destructive cancel** — the only way to stop a running query is `clear_session`, which destroys the session permanently.
3. **No busy signal** — when `sendMessage` hits a busy session, the server returns `{ type: "error" }`. The client has no way to show a "waiting" state.

## Design Decisions

| Feature | Approach |
|---------|----------|
| AskUserQuestion | PreToolUse hook intercepts → formats as plain text message → waits for reply → blocks tool with answer in reason |
| Cancel | New `cancel` client message → `slot.activeQuery.interrupt()` without removing session |
| Busy state | Replace error response with `{ type: "status", state: "busy" }` |

---

## 1. AskUserQuestion Relay

### Mechanism

The Claude Agent SDK's `PreToolUse` hook fires before any tool executes, even in `bypassPermissions` mode. The existing `ToolGuardian` already uses this to intercept destructive Bash commands with a Promise-based suspension pattern. We extend this to `AskUserQuestion`.

### New class: `QuestionRelayer`

Separate from `ToolGuardian` — different concern, different lifecycle. Same structural pattern, including the `setSendDelegate()` two-step init (needed because `QuestionRelayer` and `SessionManager` are co-dependent — same reason `ToolGuardian` uses it).

```typescript
// src/beekeeper/question-relayer.ts

interface PendingQuestion {
  resolve: (decision: HookJSONOutput) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  toolUseId: string;
}
```

**Public methods:**

- `setSendDelegate(send)` — set broadcast function (called once at startup, same as ToolGuardian)
- `createHookCallback(sessionId)` — returns a `HookCallback` for SDK PreToolUse registration
- `handleReply(sessionId, text)` — resolve pending question with user's answer
- `hasPending(sessionId)` — check if a question is pending for this session
- `denyPending(sessionId, reason)` — clear one session's pending question (cancel flow). Calls `clearTimeout` on the timer before resolving.
- `denyAll(reason)` — clear ALL pending questions (disconnect flow). Calls `clearTimeout` on each timer before resolving.

**Hook callback logic:**

1. If `tool_name !== "AskUserQuestion"` → `{ decision: "approve" }` (pass through)
2. Extract `questions` array from `tool_input`
3. Format each question as numbered plain text:
   ```
   What's the primary pain you're solving?

   1. Agent management UI — Visual dashboard to see agent status...
   2. System monitoring — See what's happening live...
   3. Full control panel — Both management AND monitoring...
   4. Beekeeper frontend — A proper web UI for Claude Code sessions...
   ```
4. Send formatted text as `{ type: "message", text, sessionId, final: true }` to client
5. If a question is already pending for this session, supersede it first (clear the existing timer, resolve with `{ decision: "block", reason: "Superseded by new question" }`) — prevents orphaned promises if Claude calls AskUserQuestion twice in the same turn
6. Store `PendingQuestion` keyed by `sessionId` (not `toolUseId` — the client doesn't know the toolUseId)
7. Return a Promise that suspends the hook until the user replies
8. When reply arrives (via `handleReply`), resolve with:
   ```typescript
   {
     decision: "block",
     reason: `User answered: ${userReply}`
   }
   ```
9. Timeout: 5 minutes (questions need think time, unlike tool approvals). Timer cleared by `denyPending`/`denyAll`/`handleReply`.

**One pending question per session.** The map is keyed by `sessionId`. If a second `AskUserQuestion` fires before the first resolves (rare — would require parallel tool calls), the first is auto-superseded (step 5).

### Why `block` with reason?

The PreToolUse hook can only return `approve` or `block`. If we approve, the built-in AskUserQuestion handler runs and fails (no TTY). Blocking with the user's answer in the `reason` field means Claude sees:

> Tool AskUserQuestion was blocked: User answered: Full control panel

Claude is smart enough to extract the answer and proceed. This is pragmatic — if the SDK adds custom tool result injection in the future, we can switch to that.

### Formatting rules

- One question per message (most AskUserQuestion calls have 1 question)
- Question text on first line
- Blank line, then numbered options: `{n}. {label} — {description}`
- If `multiSelect: true`, append "(select multiple)" after the question
- No fancy markdown — the client renders it as a plain assistant bubble

### Reply routing

The client has no knowledge of tool use IDs or pending questions. The user just types a reply in the chat. The beekeeper needs to intercept the next `sendMessage` on that session and check if a question is pending:

- In `SessionManager.sendMessage()`, before calling `runQuery()`, check if `questionRelayer.hasPending(sessionId)` is true
- If yes, pass the text to `questionRelayer.handleReply(sessionId, text)` and return (don't start a new query)
- If no, proceed normally

This avoids any protocol changes — the user's reply flows through the existing `message` type.

### Hook registration

Both `QuestionRelayer` and `ToolGuardian` need PreToolUse hooks. Register both in the hooks array:

```typescript
hooks: {
  PreToolUse: [
    { hooks: [guardianCallback] },
    { hooks: [questionCallback] },
  ],
}
```

They don't conflict — guardian only cares about Bash, relayer only cares about AskUserQuestion. The SDK runs hook entries sequentially within the `PreToolUse` array. For a non-Bash tool like `AskUserQuestion`, the guardian callback returns `approve` immediately, then the question callback runs. For a Bash command, the guardian may suspend while the question callback returns `approve` immediately. No interference.

### Wiring in index.ts

Follow the same pattern as `ToolGuardian`:

```typescript
const questionRelayer = new QuestionRelayer();
const sessionManager = new SessionManager(config, guardian, questionRelayer);
questionRelayer.setSendDelegate((msg) => sessionManager.send(msg));
```

### Files changed

- **New: `src/beekeeper/question-relayer.ts`** — `QuestionRelayer` class with `setSendDelegate()`, `createHookCallback()`, `handleReply()`, `hasPending()`, `denyPending()`, `denyAll()`
- **`src/beekeeper/session-manager.ts`** — import QuestionRelayer, wire into constructor, register second PreToolUse hook, check pending before `runQuery`
- **`src/beekeeper/index.ts`** — instantiate QuestionRelayer, wire send delegate, pass to SessionManager

### Edge cases

- User sends a reply after the 5-minute timeout → treated as a normal message (new query)
- User sends a reply to a different session → only the session with a pending question gets intercepted
- Multiple questions in one AskUserQuestion call → all formatted in a single message; user's single reply answers all
- Client disconnects while question pending → `denyAll("Client disconnected")` blocks with that reason

---

## 2. Non-Destructive Cancel

### Server contract

New client message type:

```typescript
{ type: "cancel", sessionId: string }
```

### Behavior

1. Look up the session slot
2. If `slot.state !== "busy"` or `!slot.activeQuery` → ignore (no-op)
3. Call `slot.activeQuery.interrupt()`
4. **Do NOT** set `slot.cleared = true` — session survives
5. **Do NOT** delete from sessions map or persist
6. The `runQuery` finally block handles the rest: sets `state = "idle"`, sends idle status

The interrupt causes the SDK's async iterator to end. The `runQuery` finally block fires naturally:
```typescript
finally {
  slot.activeQuery = null;
  slot.state = "idle";
  if (!slot.cleared) {
    this.send({ type: "status", state: "idle", sessionId: slot.sessionId });
  }
}
```

Since `slot.cleared` is NOT set, the idle status IS sent — which is exactly what we want. The session is now idle and ready for the next message.

### Difference from `clear_session`

| | `cancel` | `clear_session` |
|---|---|---|
| Interrupts query | Yes | Yes |
| Sets `slot.cleared` | No | Yes |
| Removes from map | No | Yes |
| Sends `session_cleared` | No | Yes |
| Sends `idle` status | Yes (via finally) | No (suppressed by cleared flag) |
| Session resumable | Yes | No |

### New method: `SessionManager.cancelQuery()`

Order matters: clear the pending question BEFORE calling interrupt. This mirrors how `clearSession` sets `slot.cleared = true` before `interrupt()` — the goal is to close the reply-intercept window so a user message arriving between interrupt and the finally block doesn't get swallowed by `hasPending()`.

```typescript
async cancelQuery(sessionId: string): Promise<void> {
  const slot = this.sessions.get(sessionId);
  if (!slot || !slot.activeQuery) return;

  // Clear pending question FIRST — closes reply-intercept window
  this.questionRelayer.denyPending(sessionId, "Operation cancelled");

  // Then interrupt the SDK query
  try {
    await slot.activeQuery.interrupt();
  } catch (err) {
    log.error("Failed to interrupt session during cancel", { sessionId, error: String(err) });
  }
  // State transition handled by runQuery's finally block
}
```

### Suppress spurious empty message after interrupt

When `interrupt()` is called, the for-await loop in `runQuery` ends and falls through to the `final: true` empty message send (line 405). This empty message would cause the client to finalize a partial response into an empty bubble.

Add an `interrupted` flag to `SessionSlot`:

```typescript
interface SessionSlot {
  // ...existing fields...
  interrupted?: boolean;
}
```

Set it in `cancelQuery` before calling `interrupt()`. Check it in `runQuery` after the loop:

```typescript
// After the for-await loop:
if (!slot.interrupted) {
  this.send({ type: "message", text: "", sessionId: resolvedSessionId, final: true });
}
```

Clear it in the finally block: `slot.interrupted = false;`

### Wire into index.ts

Add to the WebSocket message switch:

```typescript
case "cancel":
  await sessionManager.cancelQuery(msg.sessionId);
  break;
```

### Type changes

Add to `ClientMessage` in `types.ts`:
```typescript
| { type: "cancel"; sessionId: string }
```

Add `"busy"` to the status state union in `ServerMessage`:
```typescript
{ type: "status"; state: "thinking" | "idle" | "tool_running" | "busy"; sessionId: string }
```

### Note on `session_ended`

The client spec's status table lists `session_ended` as a state. This is **client-local state** — the client derives it from receiving `{ type: "session_cleared" }` or `{ type: "error", message: "Session ended: ..." }`. The server does NOT emit `{ type: "status", state: "session_ended" }` and we are not adding it. No change needed.

### Files changed

- **`src/beekeeper/types.ts`** — add `cancel` to `ClientMessage`, add `"busy"` to status state union
- **`src/beekeeper/session-manager.ts`** — add `cancelQuery()` method
- **`src/beekeeper/index.ts`** — add `"cancel"` case to WS switch

---

## 3. Busy Status

### Current behavior

When `sendMessage` is called on a busy session (`slot.state === "busy"`), the server sends:

```json
{ "type": "error", "message": "Session is busy", "sessionId": "..." }
```

The client treats this as an error and may show an error banner.

### New behavior

Replace the error with a status message:

```json
{ "type": "status", "state": "busy", "sessionId": "..." }
```

The client shows a "waiting" badge on the user's last message and a clock icon status bubble.

### Change in `session-manager.ts`

```typescript
// Before:
if (slot.state === "busy") {
  this.send({ type: "error", message: "Session is busy", sessionId });
  return;
}

// After:
if (slot.state === "busy") {
  this.send({ type: "status", state: "busy", sessionId });
  return;
}
```

One line change.

### Files changed

- **`src/beekeeper/session-manager.ts`** — change error to status in `sendMessage()`

---

## Protocol Summary (After Changes)

### Client → Server

| Type | Fields | New? |
|------|--------|------|
| `message` | `text`, `sessionId` | |
| `new_session` | `path` | |
| `clear_session` | `sessionId` | |
| `list_sessions` | | |
| `resume_session` | `sessionId`, `path` | |
| `approve` | `toolUseId` | |
| `deny` | `toolUseId` | |
| `browse` | `path?` | |
| `list_workspace_sessions` | `path` | |
| `ping` | | |
| **`cancel`** | **`sessionId`** | **Yes** |

### Server → Client

| Type | Fields | New? |
|------|--------|------|
| `message` | `text`, `sessionId`, `final` | |
| `status` | `state`, `sessionId` | **`"busy"` added to state** |
| `tool_approval` | `toolUseId`, `tool`, `input`, `sessionId` | |
| `session_info` | `sessionId`, `path` | |
| `session_list` | `sessions` | |
| `session_cleared` | `sessionId` | |
| `browse_result` | `path`, `entries` | |
| `workspace_session_list` | `path`, `sessions` | |
| `error` | `message`, `sessionId?` | |
| `pong` | | |

---

## Files Changed (Complete)

| File | Change |
|------|--------|
| **New: `src/beekeeper/question-relayer.ts`** | QuestionRelayer class — PreToolUse hook for AskUserQuestion, Promise-based relay |
| `src/beekeeper/types.ts` | Add `cancel` to ClientMessage; add `"busy"` to status state union |
| `src/beekeeper/session-manager.ts` | Wire QuestionRelayer hook, check pending before runQuery, add `cancelQuery()`, add `interrupted` flag to SessionSlot, suppress empty final message on interrupt, change busy error→status |
| `src/beekeeper/index.ts` | Instantiate QuestionRelayer, wire send delegate, add `"cancel"` case to WS switch |

## Files NOT Changed

- **`tool-guardian.ts`** — untouched, separate concern
- **`device-registry.ts`** — no protocol impact
- **`session-history.ts`** — no impact
- **`config.ts`** — no new config needed (timeout is hardcoded, like guardian's 60s)

---

## Non-Goals

- Rich question UI on the client — plain text is sufficient
- Custom tool result injection (SDK doesn't support it; block-with-reason works)
- Rate limit detection / server health monitoring — future enhancement
- Message queuing during busy state — client can send, server responds with `busy` status
