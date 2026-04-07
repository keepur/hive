# Beekeeper Slash Commands — Design Spec

**Date:** 2026-04-04
**Origin:** Discovery that "clear context" in beekeeper sessions was purely cosmetic — the model responded "Context cleared" but the SDK session retained full history.

## Problem

Beekeeper sessions have no mechanism for client-side control commands. Users type "clear context" expecting a real reset, but it's just a text message the model responds to conversationally. The full conversation history stays in the SDK session.

More broadly, there's no way for users to perform session management actions (clear, status check, help) without leaving the chat flow.

## Design

### Server-Side Command Detection

Commands are parsed **server-side only**. The iOS client sends `/clear` as a regular `{ type: "message", text: "/clear", sessionId: "..." }`. The server intercepts text starting with `/` before it reaches the SDK.

**Fallback rule:** If the command name is not recognized, the text is passed through to the SDK as a normal message. No dead ends.

### Detection Point

In `SessionManager.sendMessage()`, before the busy check and `runQuery()` call:

```
sendMessage(sessionId, text)
  ├─ text starts with "/" ?
  │   ├─ parse command name + args
  │   ├─ known command? → execute handler, return
  │   └─ unknown? → fall through to normal flow
  └─ normal message → busy check → runQuery()
```

### Command Parsing

Minimal parsing — split on whitespace:
- `/clear` → `{ name: "clear", args: [] }`
- `/status` → `{ name: "status", args: [] }`
- `/help` → `{ name: "help", args: [] }`
- `/unknown foo bar` → not found → pass `/unknown foo bar` to SDK as text

No flags, no quoted strings, no complex parsing. If a future command needs structured args, extend then.

### Command Registry

A `Map<string, CommandDef>` where each command has a handler and description:

```typescript
interface CommandDef {
  description: string;
  handler: (sessionId: string, args: string[], slot: SessionSlot) => Promise<void>;
}
```

Handlers are private methods on `SessionManager` with access to `this.send()`. The registry is populated in the constructor. New commands are added by registering a handler — no switch statement, no dispatch changes.

**Important:** Command detection runs **before** the busy check. `/clear` must work even when the session is busy (it interrupts the active query). `/status` and `/help` are read-only and work regardless of session state.

## Commands

### /clear

**Purpose:** Destroy the current SDK session and create a fresh one on the same workspace. The user gets a clean context with zero friction.

**Flow:**
1. Record `cwd` from current session slot
2. Send `{ type: "context_cleared", oldSessionId }` to client **first** — so the client can wipe the chat view before new session events arrive
3. Tear down the old session inline (interrupt active query if busy, remove slot from map, persist). Do NOT call `clearSession()` — that sends its own `session_cleared` event which would create confusing duplicate signals
4. Call `newSession(cwd)` — spawns fresh SDK session, streams inaugural greeting, returns new session ID. The client already received `context_cleared` so it handles the new `session_info` and greeting cleanly
5. Note: `newSessionId` is not in `context_cleared` — the client gets it from the `session_info` event that `newSession()` emits. This avoids a sequencing issue where `context_cleared` would reference a session ID that doesn't exist yet

**Edge cases:**
- Session is busy (active query): interrupt it, wait for `queryDone`, then proceed with teardown
- Session not found: send `{ type: "error", message: "Unknown session" }`

### /help

**Purpose:** List available commands with descriptions.

**Flow:**
1. Iterate command registry, collect name + description pairs
2. Format as plain text
3. Send as `{ type: "message", text: "...", sessionId, final: true }`

No new server message type needed — renders as a normal assistant message on iOS.

**Output format:**
```
Available commands:
  /clear   — Reset context and start a fresh session
  /help    — Show this list
  /status  — Show current session info
```

### /status

**Purpose:** Show session metadata — ID, workspace path, state.

**Flow:**
1. Read slot: sessionId, cwd, state
2. Format as plain text
3. Send as `{ type: "message", text: "...", sessionId, final: true }`

No new server message type needed.

**Output format:**
```
Session: a1b2c3d4-...
Workspace: /Users/mokie/github/hive
State: idle
```

## Protocol Changes

### New ServerMessage Type

```typescript
| { type: "context_cleared"; oldSessionId: string }
```

Deliberately minimal — only carries the old session ID so the client knows what to clear. The new session ID and path arrive via the subsequent `session_info` event from `newSession()`. This avoids sequencing issues and keeps the event self-contained.

Only `/clear` produces this. `/help` and `/status` use existing `message` type.

### No ClientMessage Changes

iOS continues to send `{ type: "message", text: "/clear", sessionId: "..." }`. No new client message types.

## iOS Changes

**Single addition:** Handle `context_cleared` in `ChatViewModel.handleIncoming()`:

1. Decode new `WSIncoming.contextCleared(oldSessionId)` case
2. Clear all messages for `oldSessionId` from the chat view
3. The new session ID and path arrive separately via `session_info` (already handled)

The `WSIncoming` decoder's `.unknown` fallback already handles unrecognized types gracefully, so older clients won't crash — they just won't clear the view.

`/help` and `/status` responses arrive as regular `message` type and render automatically with no iOS changes.

## File Map

| File | Change |
|------|--------|
| `src/beekeeper/session-manager.ts` | Add command detection in `sendMessage()`, command registry, `/clear` + `/help` + `/status` handlers |
| `src/beekeeper/types.ts` | Add `context_cleared` to `ServerMessage` union |
| `src/beekeeper/session-manager.test.ts` | Tests for command parsing, dispatch, fallback, all three commands |
| iOS: `WSMessage.swift` | Add `contextCleared` case to `WSIncoming` |
| iOS: `ChatViewModel.swift` | Handle `contextCleared` — wipe view, switch session |

## What We're NOT Building

- **Client-side command parsing** — server handles everything. No iOS changes for new commands.
- **Complex argument parsing** — split on whitespace is enough. No flags, no quoting.
- **Command permissions** — all commands available to all clients. Gate later if needed.
- **Command aliases** — no `/c` for `/clear`. Add later if warranted.
- **Confirmation prompts** — `/clear` executes immediately. The user typed it deliberately.
