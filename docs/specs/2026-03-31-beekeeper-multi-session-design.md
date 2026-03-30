# Beekeeper Multi-Session + Workspace Browsing

**Date**: 2026-03-31
**Status**: Draft
**Author**: May + Claude Code

## Problem

Beekeeper's `SessionManager` is single-session — one `sessionId`, one workspace, `newSession()` kills the previous session. The iOS app (keepur-ios) already has multi-session UI built (SwiftData `Session` model, `SessionListView`, messages keyed by `sessionId`), but the server can't support it.

Additionally, workspaces are hardcoded in `beekeeper.yaml`. Users should be able to browse the filesystem and pick any directory as a workspace, with the iOS app remembering selections locally.

## Design

Two changes: (1) replace single `SessionManager` with a concurrent multi-session map, and (2) add directory browsing so the client can pick workspaces dynamically.

### Multi-Session Manager

Replace `SessionManager`'s single-session state with a `Map<string, SessionSlot>`:

```typescript
interface SessionSlot {
  sessionId: string;          // Claude SDK session ID (UUID)
  path: string;               // Absolute workspace path (cwd for SDK)
  activeQuery: Query | null;  // Running SDK query, if any
  outputBuffer: ServerMessage[]; // Buffered output while client is disconnected
}
```

**Lifecycle:**

- **Create**: Client sends `new_session { path }`. Server validates path (see Path Validation below), spawns SDK `query()` with that `cwd`, captures `sessionId` from the `system/init` event, adds to map. Returns `session_info`. Multiple sessions with the same `path` are allowed (like multiple terminal tabs in the same project).
- **Send message**: Client sends `message { sessionId, text }`. Server looks up slot by `sessionId`, calls `query()` with `resume: sessionId` and `cwd: slot.path`. If `sessionId` is missing or not found, return `{ type: "error", message: "Session not found", sessionId }`.
- **Clear**: Client sends `clear_session { sessionId }`. Server interrupts active query if running, waits for query to finish/abort, removes slot from map, sends `session_cleared { sessionId }`.
- **List**: Client sends `list_sessions`. Server responds with all active slots (sessionId, path, state).
- **Reconnect**: When a client connects, server sends `session_list` first, then drains all per-session output buffers. This ensures the client knows about all sessions before receiving buffered messages.
- **After beekeeper restart**: Session map is empty (in-memory). Server sends empty `session_list` on connect. iOS app marks its local sessions as stale. SDK session files persist on disk under `~/.claude/projects/`, so the client can offer to re-create sessions that resume old SDK sessions — but this is a client-side UX concern, not a server concern.

**Concurrency:**

- Multiple sessions can run queries simultaneously — each SDK `query()` is an independent subprocess.
- No two queries share the same `sessionId`, so no session file corruption risk.

**SDK crash handling:**

- If an SDK `query()` subprocess crashes or throws, the session slot's `activeQuery` is cleared, an error with `sessionId` is sent to the client, and the session remains in the map so the user can retry or clear it.

**Output buffering:**

- Each `SessionSlot` has its own `outputBuffer`. When client disconnects, output accumulates per-session. All buffered messages carry `sessionId`, so the client can route them correctly on drain.

### Tool Guardian Changes

The `ToolGuardian` is currently a single shared instance that sends `tool_approval` messages directly via `this.client.send()`. This needs changes for multi-session:

- `createHookCallback()` must accept a `sessionId` parameter and include it in the outgoing `tool_approval` message.
- Guardian must send through a callback/delegate instead of holding a direct `ws` reference. This ensures `tool_approval` messages go through the session's `outputBuffer` when the client is disconnected, rather than being lost.
- The `pendingApprovals` map (keyed by `toolUseId`) is already multi-approval safe — UUIDs are globally unique across sessions.

### Protocol Changes

**Client → Server:**

| Type | Fields | Change |
|------|--------|--------|
| `message` | `text`, `sessionId` | `sessionId` now **required** (was optional/ignored) |
| `new_session` | `path` | Replace `workspace?: string` with `path: string` (absolute path) |
| `clear_session` | `sessionId` | **New** — remove session from server |
| `list_sessions` | (none) | **New** — request active session list |
| `browse` | `path?` | **New** — browse directory (default: `~`) |
| `approve` | `toolUseId` | Unchanged |
| `deny` | `toolUseId` | Unchanged |
| `ping` | (none) | Unchanged |

**Removed client messages:**
- `switch_workspace` — replaced by `new_session { path }`. Client switches workspaces by creating a new session in the target directory.

**Server → Client:**

| Type | Fields | Change |
|------|--------|--------|
| `message` | `text`, `sessionId`, `final` | Unchanged |
| `session_info` | `sessionId`, `path` | Drop `workspace` name and `workspaces` list |
| `session_list` | `sessions: [{ sessionId, path, state }]` | **New** — response to `list_sessions` and sent on connect |
| `session_cleared` | `sessionId` | **New** — confirms session removal |
| `status` | `state`, `sessionId` | Add `sessionId` to scope status to a session. Drop `session_ended` state (use `session_cleared` instead). |
| `browse_result` | `path`, `entries: [{ name, isDirectory }]` | **New** — directory listing response |
| `tool_approval` | `toolUseId`, `tool`, `input`, `sessionId` | Add `sessionId` so client knows which session needs approval |
| `error` | `message`, `sessionId?` | `sessionId` optional (some errors are session-scoped, some are global) |
| `pong` | (none) | Unchanged |

### Path Validation

For both `new_session` and `browse` paths:

1. Resolve symlinks with `fs.realpathSync()`
2. Confirm resolved path starts with resolved `~` (home directory)
3. Confirm path is a directory with `fs.statSync()` (not a file)
4. Return `{ type: "error", message: "Path must be a directory under home" }` on failure

### Directory Browsing

- Client sends `browse { path? }` — defaults to `~` if omitted
- Server responds with `browse_result { path, entries }` — list of `{ name: string, isDirectory: boolean }`
- **Home-rooted**: server rejects any path that resolves outside `~` (after symlink resolution)
- If `path` is a file, return error (not a directory)
- Filters out hidden entries (dotfiles/dotdirs) by default — the client doesn't need `.git`, `.env`, etc.
- Sorts: directories first, then alphabetical

### Config Changes

Remove from `BeekeeperConfig`:
- `workspaces: Record<string, string>` — gone, client picks paths dynamically
- `defaultWorkspace: string` — gone, client decides

Remove from `beekeeper.yaml`:
- `workspaces` section
- `default_workspace`

Keep:
- `port`, `model`, `confirm_operations`, `plugins`, `mongo_db`

Note: `authToken` is unaffected by this spec (handled separately by the device pairing spec).

**Plugin discovery**: The current `discoverProjectSkills(workspaces)` in `config.ts` iterates the static workspace list to find `.claude/skills/` dirs. With workspaces removed, drop this server-side discovery. The Claude SDK already discovers project-level CLAUDE.md and skills from `cwd` when a session starts — project skills are loaded per-session automatically.

### Deployment Coordination

This spec and the device pairing spec (#63) both modify `BeekeeperConfig` in `types.ts` and `loadConfig()` in `config.ts`. They should be coordinated to avoid merge conflicts. Either land one first, or combine into a single PR.

The `new_session` field change (`workspace` → `path`) is a **breaking protocol change**. Server and iOS app updates must ship together. Alternatively, the server can accept `workspace` as an alias for `path` during a transition period.

### What Stays the Same

- WebSocket connection management — single active client (multi-client is out of scope)
- SDK options (`permissionMode`, `allowDangerouslySkipPermissions`, etc.) — unchanged
- `cleanEnv()` — unchanged

### iOS App Changes (keepur-ios)

Client-side updates needed (separate repo/PR):

- **Workspace picker**: browse → select directory → `new_session { path }`
- **Workspace memory**: SwiftData model to remember selected workspaces locally
- **Session list per workspace**: filter sessions by path, show in `SessionListView`
- **Status scoping**: handle `sessionId` on status messages to update correct session
- **Tool approval scoping**: handle `sessionId` on `tool_approval` to show in correct session context
- **Remove hardcoded workspace list**: no more relying on server's `workspaces` array in `session_info`
- **New message types**: add `clear_session`, `list_sessions`, `browse` to `WSOutgoing`; add `session_list`, `session_cleared`, `browse_result` to `WSIncoming`
- **Stale session handling**: on connect, sync local sessions against `session_list` from server

### Resource Considerations

Each active SDK session is a separate Node.js subprocess (~50-150MB RSS). On the Mac Mini, 2-3 concurrent sessions are comfortable. No hard limit enforced — if resource pressure becomes a problem, add a max-concurrent-sessions config later.

## Out of Scope

- Multi-client simultaneous connections — separate ticket
- Session persistence across beekeeper restarts — server map is in-memory, SDK files persist on disk, client handles stale sessions
- Token refresh/rotation (covered by device pairing spec)
- Max session limits / resource management
