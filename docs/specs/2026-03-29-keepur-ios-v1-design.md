# Keepur iOS v1 — Design Spec

**Date**: 2026-03-29
**Status**: Draft
**Author**: May + Claude Code
**Depends on**: [Beekeeper Relay spec](2026-03-28-beekeeper-relay-design.md)

## Summary

Keepur is a native iOS app — the primary access layer to the Hive appliance. v1 connects to the Beekeeper relay only (Claude Code on the Mac Mini). Workspace and Vault channels come in future versions as their backends get built.

**Product name**: Keepur
**Internal domain**: Beekeeper (the relay service it connects to)

## Architecture

```
Keepur iOS App
  → WSS (beekeeper.dodihome.com?token=<auth_token>)
  → Cloudflare Tunnel
  → localhost:3099
  → Beekeeper Relay Server
  → Claude Code SDK Session
```

- **Local WiFi**: When on the same network as the Mac Mini, connect directly to `192.168.x.x:3099` (mDNS/Bonjour discovery — v2)
- **Remote**: Cloudflare Tunnel via `beekeeper.dodihome.com`
- **v1**: Remote only (Cloudflare Tunnel). Local discovery is v2.

## Auth

Static token. One-time setup screen on first launch — user pastes the token, stored in iOS Keychain. No pairing flow, no JWT, no expiry. Single user.

If the token is rejected (WebSocket upgrade fails), show the setup screen again.

## Screens

### 1. Setup (first launch only)

- Text field: "Beekeeper Token"
- "Connect" button
- Token saved to iOS Keychain on success
- Shown again if connection auth fails

### 2. Chat (main screen)

The primary interface. A chat with Claude Code.

- **Message list**: scrolling conversation. User messages right-aligned, Claude responses left-aligned.
- **Text input bar**: text field + send button at bottom. Native keyboard dictation (mic button) provides voice input for free — no custom STT needed.
- **Streaming responses**: text appears word-by-word as chunks arrive (`final: false`), solidifies on `final: true`.
- **Status indicator**: top bar shows current state — `thinking`, `tool_running`, `idle`, `session_ended`. No tool name display in v1 (relay `status` message only carries `state`).
- **Workspace badge**: current workspace name in the nav bar (e.g., "hive", "ios", "dodi").
- **New session button**: top right. Starts fresh Claude Code session. Clears chat history (previous session's messages stay in local storage for scroll-back but visually separated).
- **Markdown rendering**: Claude's responses are markdown. Render code blocks, bold, italic, lists, links. Code blocks get a copy button.

### 3. Tool Approval (modal overlay)

When the relay flags a destructive operation:

- Modal slides up over the chat
- Shows: tool name and the command extracted from the `input` object (`input.command` for Bash tool)
- Two buttons: **Approve** (green) and **Deny** (red)
- Auto-denies on 60s timeout (show countdown timer)
- Dismiss on approve/deny/timeout → back to chat with inline status message ("Approved" / "Denied" / "Timed out")

### 4. Settings (sheet)

- **Workspace picker**: list of workspaces received from server via `session_info.workspaces` (array of workspace names sent on connect). Tap to switch (sends `new_session` with workspace).
- **Connection status**: connected/disconnected, current session ID
- **Disconnect/reconnect** button
- **Clear token** (shows setup screen)

## Data Model

### Local Storage (SwiftData)

```
Session
  - id: String
  - workspace: String
  - createdAt: Date
  - messages: [Message]

Message
  - id: UUID
  - sessionId: String
  - text: String
  - role: String (user | assistant | system)  // system = errors, dividers, status
  - timestamp: Date
  - isStreaming: Bool (transient, not persisted)
```

Sessions are kept locally for scroll-back. New session creates a visual divider.

### Keychain

- `beekeeper_auth_token`: the static auth token

## WebSocket Protocol

Implements the client side of the [Beekeeper Relay protocol](2026-03-28-beekeeper-relay-design.md#websocket-protocol):

### Send
- `{ type: "message", text: "...", sessionId?: "..." }`
- `{ type: "new_session", workspace?: "..." }` (workspace picker and new session button both use this)
- `{ type: "approve", toolUseId: "..." }`
- `{ type: "deny", toolUseId: "..." }`
- `{ type: "ping" }`

### Receive
- `message` → append/stream to chat
- `tool_approval` → show approval modal
- `status` → update status indicator
- `session_info` → update workspace badge, store session ID, cache workspace list
- `error` → show inline error in chat
- `pong` → connection alive

## Relay Protocol Changes Required

The Beekeeper relay spec needs two additions to support this client:

1. **`session_info.workspaces`** — add an array of available workspace names to the `session_info` message so the client can populate the workspace picker without hardcoding.
2. **`session_ended` handling** — when the client receives `{ type: "status", state: "session_ended" }`, it inserts a visual divider in the chat and disables the input bar until a new `session_info` arrives.

## Connection Handling

- **Auto-reconnect**: exponential backoff (1s, 2s, 4s, 8s, max 30s)
- **Ping/pong**: every 30s to keep connection alive
- **Background**: iOS kills WebSocket after ~30s in background. On foreground, reconnect immediately. If a session was active, relay resumes it and drains buffered output.
- **No offline queue**: unlike dodi-shop, there's no point queueing messages for Claude Code offline. Show "disconnected" state clearly.

## Tech Stack

- **SwiftUI**, iOS 17+
- **URLSessionWebSocketTask** (native, no deps)
- **SwiftData** for local message persistence
- **iOS Keychain** for token
- **No external dependencies**

## Project Structure

```
Keepur/
├── Keepur.xcodeproj
├── Keepur/
│   ├── KeepurApp.swift
│   ├── Views/
│   │   ├── RootView.swift          # Routes Setup ↔ Chat
│   │   ├── SetupView.swift         # Token entry
│   │   ├── ChatView.swift          # Message list + input
│   │   ├── ToolApprovalView.swift  # Modal for destructive ops
│   │   ├── SettingsView.swift      # Workspace picker, connection
│   │   └── MessageBubble.swift     # Single message render
│   ├── ViewModels/
│   │   └── ChatViewModel.swift     # Orchestrates WS, state, messages
│   ├── Managers/
│   │   ├── WebSocketManager.swift  # Connection, reconnect, protocol
│   │   └── KeychainManager.swift   # Token storage
│   ├── Models/
│   │   ├── Session.swift           # SwiftData model
│   │   ├── Message.swift           # SwiftData model
│   │   └── WSMessage.swift         # Protocol encode/decode
│   └── Assets.xcassets/
└── README.md
```

## Repo

New repo: `dodi-hq/keepur-ios` (or `keepur` if we want one repo for everything eventually).

## v1 Non-Goals

- **Workspace channel** (Meteor/DDP) — backend doesn't exist yet
- **Vault channel** (local model) — backend doesn't exist yet
- **Custom voice interface** — native keyboard dictation is good enough for v1
- **Local WiFi / Bonjour discovery** — Cloudflare Tunnel only for v1
- **Push notifications** — app is foregrounded during use
- **Multi-user** — May only
- **File/image sharing** — text chat only for v1

## Future (v2+)

- Workspace channel (Meteor backend + DDP client)
- Vault channel (local model + air-gapped socket)
- Bonjour/mDNS local discovery (WiFi-first, Tailscale fallback)
- Connection mode indicator (local vs remote)
- Conversational voice (continuous STT, turn detection, TTS)
- Push notifications via APNs
- Tab bar for channel switching (Workspace / Vault / Beekeeper)
