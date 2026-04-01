# Beekeeper Session Persistence

**Date**: 2026-04-01
**Status**: Implemented
**Scope**: Server-side (beekeeper)

## Problem

Every time the beekeeper server is deployed or restarted, the in-memory `sessions` Map is wiped clean. Clients (Keepur) that had active sessions immediately get "Unknown session" errors when they try to send messages. The user must manually clear client-side state and re-create all sessions from scratch — making every deploy disruptive.

The Claude SDK already persists session conversation history to disk at `~/.claude/projects/{project-key}/{session-id}.jsonl`. The only thing missing after a restart is the lightweight `sessionId → cwd` mapping that tells the server which sessions exist and where they point.

## Design

### Persistence Strategy

Persist the session map to a JSON file on disk. On server startup, read it back and re-register each session as a **lazy slot** — the same mechanism `resumeSession()` already uses. No SDK call is made until the client actually sends a message, at which point the SDK picks up from its own JSONL history.

This is the simplest approach with zero new dependencies. The file is small (just session IDs and paths), writes are fast, and the existing `resumeSession` code path handles all the lazy-loading logic.

**Alternatives considered:**
- **MongoDB persistence** — aligns with existing device-registry pattern, but adds unnecessary coupling for a simple key-value map. MongoDB is also an external dependency that could fail independently.
- **Client-side reconnect** — client detects unknown session error, sends `resume_session`. Works but requires changes to every client and still causes a brief error/retry loop on every deploy.

### File Format

`~/.beekeeper/data/sessions.json`:

```json
[
  { "sessionId": "a1b2c3d4-...", "cwd": "/Users/mokie/github/hive" },
  { "sessionId": "e5f6g7h8-...", "cwd": "/Users/mokie/github/other" }
]
```

Only `sessionId` and `cwd` are persisted. Everything else (`activeQuery`, `state`, `outputBuffer`) is ephemeral and reconstructed when the session is lazily resumed.

Sessions with `pending-` prefixed IDs are excluded — these are transient placeholders during `newSession()` that get replaced with real SDK-assigned IDs.

### Configuration

A new `dataDir` field is added to `BeekeeperConfig`:

```typescript
export interface BeekeeperConfig {
  // ... existing fields ...
  dataDir: string;  // Default: ~/.beekeeper/data
}
```

Resolution order:
1. `BEEKEEPER_DATA_DIR` env var
2. `data_dir` in `beekeeper.yaml`
3. Default: `~/.beekeeper/data`

### Mutation Points

The session map is persisted after every mutation that changes which sessions exist:

| Mutation | Method | When |
|----------|--------|------|
| Session created | `newSession()` | After real ID replaces pending ID |
| Session cleared | `clearSession()` | After `sessions.delete()` |
| Session resumed | `resumeSession()` | After `sessions.set()` |
| Server shutdown | `index.ts` shutdown handler | Before `stopAll()` clears the map |

Persist is **not** called during `stopAll()` itself — by that point the map is being cleared. Instead, `persistSessions()` is called just before `stopAll()` in the shutdown handler.

Persist is also **not** called on state transitions (`idle` ↔ `busy`) — those are ephemeral and don't need to survive restarts.

### Startup Restore

On server start, `restoreSessions()` is called immediately after `SessionManager` is constructed, before the HTTP server starts accepting connections:

1. Check if `sessions.json` exists — if not, skip (clean start)
2. Read and parse the file
3. For each entry, call `resumeSession(sessionId, cwd)` — this creates a lazy slot in the map
4. Sessions are now registered and will respond to client messages

When a client connects and sends a message to a restored session, `sendMessage()` finds the slot, calls `runQuery()`, which passes `resume: sessionId` to the SDK. The SDK loads its JSONL history and continues the conversation seamlessly.

### Error Handling

Both `persistSessions()` and `restoreSessions()` wrap all I/O in try-catch and log errors without crashing the server. A failed persist is non-fatal — the server continues operating, and the next mutation will retry. A failed restore is also non-fatal — the server starts with an empty session map (same as pre-feature behavior).

The `dataDir` is created automatically with `mkdirSync({ recursive: true })` if it doesn't exist.

## What Stays the Same

- Client protocol — no new message types, no client-side changes required
- `resumeSession()` behavior — already existed, now also called during restore
- `listWorkspaceSessions()` — still available for discovering sessions from `~/.claude/projects/`
- SDK session resumption — still handled by passing `resume: sessionId` to `query()`

## Out of Scope

- Multi-instance support (shared session state across multiple beekeeper processes)
- Session expiry / garbage collection of stale sessions
- Persisting session state (busy/idle) or output buffers
- Client-side reconnection logic (no longer needed for this problem)
