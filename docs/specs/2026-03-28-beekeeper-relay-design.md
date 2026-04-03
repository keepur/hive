# Beekeeper Relay — Design Spec

**Date**: 2026-03-28
**Status**: Draft
**Author**: May + Claude Code

## Problem

There is no mobile-friendly way to interact with Claude Code on the Mac Mini. Existing options (SSH, Screen Sharing, `/remote-control`, Claude iOS app's Code section) are all flawed — too clunky, too flaky, or missing voice support. Claude Code operates *outside* Hive (it builds, deploys, and manages Hive), so routing through Hive is architecturally wrong.

## Solution

**Beekeeper** — a standalone relay service on the Mac Mini that bridges a dedicated iOS app to Claude Code sessions via the SDK. Runs independently of Hive with its own process, port, and lifecycle.

## Design Principles

- **Outside Hive** — Beekeeper is not a Hive feature. It manages Hive. Separate process, separate LaunchAgent, no shared runtime state.
- **Single user** — May only. No multi-tenant complexity.
- **SDK-native** — Uses `@anthropic-ai/claude-code` SDK for structured session management, tool events, and streaming.
- **Minimal footprint** — Small relay server, not a platform. Keep it simple.

## Architecture

```
iOS App (Beekeeper)
  → WSS (beekeeper.dodihome.com)
  → Cloudflare Tunnel
  → localhost:3099
  → Beekeeper Relay Server
  → Claude Code SDK Session
  → Tools (Read, Write, Edit, Bash, etc.)
```

### Components

| Component | Location | Role |
|-----------|----------|------|
| Relay Server | `src/beekeeper/index.ts` | Express + WebSocket on port 3099 |
| Session Manager | `src/beekeeper/session-manager.ts` | Spawn/resume/destroy Claude Code sessions |
| Tool Guardian | `src/beekeeper/tool-guardian.ts` | SDK `PreToolUse` hook, flags destructive ops for approval |
| Config | `beekeeper.yaml` | Workspaces, guardian rules (gitignored) |
| LaunchAgent | `com.hive.beekeeper.plist` | Independent service lifecycle |
| iOS App | Separate repo (TBD) | Chat UI, voice input, tool approval prompts |

### Config (`beekeeper.yaml`)

```yaml
port: 3099

default_workspace: hive
model: claude-opus-4-5-20250514

workspaces:
  hive: ~/github/hive
  ios: ~/github/dodi-shop-ios
  dodi: ~/dev/dodi_v2
  marketing: ~/github/marketing

confirm_operations:
  - "git push --force"
  - "git branch -D"
  - "rm -rf"
  - "rm -r"
  - "git reset --hard"
  - "git checkout -- ."
  - "git clean -f"
```

## WebSocket Protocol

### Client → Server

| Type | Fields | Description |
|------|--------|-------------|
| `message` | `text`, `sessionId?` | Send message to active or specified session |
| `new_session` | `workspace?` | Start fresh session, optional workspace (defaults to `default_workspace`) |
| `switch_workspace` | `workspace` | Change working directory of current session |
| `approve` | `toolUseId` | Approve a flagged tool call |
| `deny` | `toolUseId` | Deny a flagged tool call |
| `ping` | — | Keepalive |

### Server → Client

| Type | Fields | Description |
|------|--------|-------------|
| `message` | `text`, `sessionId`, `final` | Claude's response text (streamed in chunks, `final: true` on last) |
| `tool_approval` | `toolUseId`, `tool`, `input` | Destructive operation needs confirmation |
| `status` | `state` | `thinking`, `idle`, `tool_running`, `session_ended` — activity indicator |
| `session_info` | `sessionId`, `workspace` | Session metadata (sent on connect/new session) |
| `error` | `message` | Error message |
| `pong` | — | Keepalive response |

## Authentication

Single static token, generated once and stored in:
- Server: `.env` as `BEEKEEPER_AUTH_TOKEN` (follows existing secrets convention)
- Client: iOS Keychain

Connection: `wss://beekeeper.dodihome.com?token=<auth_token>`

Server rejects WebSocket upgrade if token doesn't match. No pairing flow, no JWT, no expiry — single user on a private tunnel.

## Session Lifecycle

### Connect
1. Client connects via WebSocket with auth token
2. If an active session exists → resume it, send `session_info`
3. If no active session → start new session in default workspace, send `session_info`

### New Session
1. Client sends `{ type: "new_session", workspace?: "ios" }`
2. Server stops current session (if any)
3. Spawns new Claude Code SDK session in specified workspace
4. Sends `session_info` with new session ID and workspace

### Switch Workspace
1. Client sends `{ type: "switch_workspace", workspace: "dodi" }`
2. Server stops current session
3. Spawns new session in the requested workspace
4. Sends `session_info`

Note: switching workspace starts a fresh session — Claude Code sessions are bound to a working directory. Server sends a `{ type: "status", state: "session_ended" }` before the new `session_info` so the client can visually indicate the context break.

### Disconnect
- Client disconnect (phone sleeps, app backgrounded) does NOT kill the session
- Session stays alive on the server, resumable on reconnect
- If a query is mid-flight when client disconnects: the query continues running, output is buffered, and drained to the client on reconnect
- If a tool approval is pending when client disconnects: auto-deny immediately (don't wait for timeout)
- No idle timeout by default

### Explicit End
- `new_session` ends the current session before starting a new one
- Server restart ends all sessions (acceptable — single user, infrequent)

## Tool Guardian

All sessions run with `bypassPermissions: true` for frictionless interaction.

The Tool Guardian uses the SDK's `hooks.PreToolUse` callback to intercept tool calls before execution. It checks Bash tool inputs against `confirm_operations` patterns from config.

### SDK Integration

The guardian is registered at session spawn time via the SDK's hook system:

```typescript
query({
  prompt: userMessage,
  options: {
    bypassPermissions: true,
    hooks: {
      PreToolUse: [{ matcher: guardianMatcher, callback: guardianCallback }]
    }
  }
})
```

The guardian callback receives `PreToolUseHookInput` (containing `tool_name`, `tool_input`, `tool_use_id`) and returns a `Promise<SyncHookJSONOutput>`:

```
guardianCallback(input):
  if input.tool_name == "Bash" AND input.tool_input.command matches any confirm_operations pattern:
    → store Promise resolver in pendingApprovals Map (keyed by tool_use_id)
    → send tool_approval message to client over WebSocket
    → await resolver (60s timeout)
    → on approve: return { decision: "approve" }
    → on deny/timeout: return { decision: "block", reason: "User denied" }
  else:
    → return { decision: "approve" }
```

### Blocking-Wait Pattern

The approval flow blocks the SDK's execution loop via an unresolved Promise:

1. Guardian callback creates a `Promise` and stores its `resolve` function in `pendingApprovals: Map<toolUseId, { resolve, timer }>`
2. Sends `tool_approval` message to iOS client over WebSocket
3. Returns the Promise (SDK waits for it)
4. When client sends `approve`/`deny`, the WebSocket handler looks up the resolver and calls it
5. On 60s timeout: auto-deny and resolve the Promise
6. On client disconnect: immediately resolve all pending approvals with deny

### Approval Flow
1. Server sends `{ type: "tool_approval", toolUseId: "abc", tool: "Bash", input: "git push --force origin main" }`
2. iOS app shows confirmation dialog with the command
3. User taps approve → `{ type: "approve", toolUseId: "abc" }` → tool executes
4. User taps deny → `{ type: "deny", toolUseId: "abc" }` → tool blocked, Claude informed
5. Timeout (60s no response) → auto-deny, Claude informed
6. Client disconnect with pending approval → auto-deny immediately

### Guardian Scope
- Only applies to `Bash` tool — file reads/writes/edits are fine under bypass
- Pattern matching is substring (not regex) for simplicity
- Patterns are configurable in `beekeeper.yaml`

## Deployment

### Port
- **3099** — just below Hive instance ranges (`3100+`), avoids port 3000 conflicts with dev tooling (Next.js, React, etc.)

### LaunchAgent (`com.hive.beekeeper.plist`)
```xml
<dict>
  <key>Label</key>
  <string>com.hive.beekeeper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/mokie/services/hive/dist/beekeeper/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/mokie/services/hive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/mokie</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>BEEKEEPER_CONFIG</key>
    <string>beekeeper.yaml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/mokie/services/hive/logs-beekeeper/beekeeper.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mokie/services/hive/logs-beekeeper/beekeeper.err</string>
</dict>
```

### Cloudflare Tunnel
Add route to existing `dodi-shop` tunnel via Cloudflare dashboard:
- `beekeeper.dodihome.com → http://localhost:3099`
- Optional: Cloudflare Access policy restricting to May's email

### Build
Beekeeper source lives in `src/beekeeper/` and compiles with the existing `npm run build`. No separate build step.

### Deploy
Add to `service/deploy.sh` as an independent phase:
1. Build happens with everything else (shared `npm run build`)
2. Restart Beekeeper LaunchAgent independently of Hive instances
3. Health check: hit `GET /health` on port 3099

## iOS App (Beekeeper)

Separate repo, separate app. Minimal scope for v1:

### Screens
1. **Chat** — message list + text input. Default screen.
2. **Tool Approval Dialog** — modal overlay when a destructive op needs confirmation.
3. **Settings** — workspace picker, connection status.

### Features (v1)
- Text chat with Claude Code
- Tool approval prompts (approve/deny with one tap)
- Workspace switcher (dropdown from config)
- New session button
- Connection status indicator
- Native keyboard dictation (built-in mic button) for voice input

### Features (v2 — separate spec)
- Conversational voice interface (continuous STT, turn detection, TTS)
- Streaming response display (typing indicator → progressive text)

### Tech Stack
- SwiftUI
- Native `URLSessionWebSocketTask` (same pattern as dodi-shop)
- iOS Keychain for auth token storage
- No external dependencies for v1

## File Structure

```
src/beekeeper/
├── index.ts              # Entry point — Express + WebSocket server
├── session-manager.ts    # Claude Code SDK session lifecycle
├── tool-guardian.ts      # PreToolUse hook, pattern matching, approval routing
├── config.ts             # Load beekeeper.yaml
└── types.ts              # Protocol message types
```

## Non-Goals

- **Multi-user support** — single user (May), no auth complexity
- **Conversational voice** — separate spec (v2)
- **Running inside Hive** — architecturally wrong, explicitly excluded
- **Full terminal emulation** — this is a chat interface, not a terminal
- **Session persistence across server restarts** — acceptable loss for single user

## Resolved Design Decisions

1. **Response streaming** — Stream `text_delta` events from the SDK as `{ type: "message", text: chunk, final: false }`, send `final: true` on completion. Same pattern as `agent-runner.ts`. Single-user over localhost-to-Cloudflare handles word-by-word fine.
2. **Session resume after server restart** — Start fresh. Not worth the complexity for single user.
3. **Model selection** — Always Opus. This is the management channel. Configurable via `model` field in `beekeeper.yaml` for future flexibility.
4. **Logging** — Uses existing `createLogger("beekeeper")` pattern from `src/logging/logger.ts`.
5. **Auth token location** — `.env` as `BEEKEEPER_AUTH_TOKEN`, not in `beekeeper.yaml`. Follows existing secrets convention. `beekeeper.yaml` is gitignored regardless (per-instance config like `hive.yaml`).
