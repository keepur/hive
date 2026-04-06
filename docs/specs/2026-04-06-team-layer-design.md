# Team Layer — Design Spec

**Date:** 2026-04-06
**Origin:** Strategic decision to move away from Slack as primary interface. Five drivers: (1) agent-to-agent comms should be direct, not routed through a third-party platform, (2) native clients can read messages aloud — Slack can't, (3) people and agents should have equal status, (4) owning the full UX enables better workflow control, (5) Hive as an SMB edge appliance can't assume customers use Slack.

## Problem

Hive agents interact with users primarily through Slack, creating dependencies that limit the product:

1. **Agent-to-agent comms route through Slack** — a public, rate-limited, third-party channel for what should be internal function calls
2. **No voice output** — Slack can't read messages aloud; the native apps can (TTS already built)
3. **Agents are second-class** — bot labels, restricted APIs, rate limits. People and agents aren't peers.
4. **Workflow locked behind Slack's UX** — approvals, commands, custom views all gated by what Slack exposes
5. **SMB customers won't have Slack** — Hive as an edge appliance can't assume any third-party messaging platform

## Solution

A **Team layer** inside Hive — channels, DMs, slash commands, @mentions, and agent-to-agent direct messaging — served to native clients (iOS/macOS) over the existing WebSocket transport. Slack becomes an optional adapter, not the primary interface.

## Concepts

- **Channel** — persistent group space with a name, member list (people + agents), and message history. Like `#production` or `#general`.
- **DM** — direct conversation between two participants (person-to-agent, agent-to-agent, person-to-person). Thread-to-agent binding — no routing ambiguity.
- **@mention** — pull a participant into any channel thread. Triggers routing to that agent without leaving the channel.
- **Slash command** — `/name [args]`. Core commands are built-in. Skill commands are discovered from plugins at runtime.
- **Internal message** — agent-to-agent communication that never touches a channel adapter. Direct, fast, audited.

### Three Spaces

| Space | Purpose | Interface |
|-------|---------|-----------|
| **Team** | Day-to-day interaction — people and agents as equals | Keepur native apps (iOS/macOS) |
| **Beekeeper** | Admin/operator — config, deploy, brainstorm, code | Claude Code CLI |
| **Slack** | Optional adapter — for teams that already use it | Slack (unchanged) |

## Data Model

### MongoDB Collections

**`team_channels`** — channels and DMs

```typescript
{
  _id: string,              // "general", "production", "dm:<sortedA>:<sortedB>" (participants sorted lexicographically)
  type: "channel" | "dm",
  name: string,             // "#general" or generated DM name
  members: string[],        // agent IDs + device IDs
  createdBy: string,
  createdAt: Date,
  updatedAt: Date,
  archived: boolean
}
```

DM `_id` construction: participants are **sorted lexicographically** to produce a canonical key. `dm:device123:jessica` is the same DM regardless of who initiates it.

**`team_messages`** — all messages, searchable, auditable

```typescript
{
  _id: ObjectId,
  channelId: string,        // FK to team_channels
  threadId?: string,        // reply threading within a channel
  senderId: string,         // agent ID or device ID
  senderType: "agent" | "person",
  senderName: string,
  text: string,
  files?: { name: string, mimetype: string, size: number, storageKey: string, isImage: boolean }[],
  command?: { name: string, args: string[], result?: string },
  createdAt: Date,
  editedAt?: Date
}
```

**`team_commands`** — registered slash commands (populated by plugins at startup)

```typescript
{
  _id: string,              // command name, e.g. "order-status"
  source: "core" | "skill",
  pluginId?: string,
  description: string,
  args?: { name: string, required: boolean, description: string }[],
  handler: string           // skill/plugin reference to invoke
}
```

### Key Design Choices

- **DMs are channels with `type: "dm"` and exactly 2 members** — no separate model
- **Messages are flat with optional `threadId`** for reply threading — same proven model as Slack
- **Commands are registered at startup** — plugins populate the registry when Hive boots
- **No separate "internal" message table** — agent-to-agent messages go through `team_messages` for audit. The difference is they skip channel adapters (no WS/Slack delivery).
- **File storage by reference** — files are saved to disk (`/tmp/<instanceId>-team-files/`) and referenced by `storageKey` in the message document. No base64 blobs in MongoDB. The `ProcessedFile` from the shared file processor is used during processing; only the reference is persisted.
- **Command results** stored as `result` field on the command message itself — not as a separate message.

## WS Protocol Extensions

### Client to Server

```typescript
// Join/create a channel or DM
{ type: "join", channelId: string, id: string }

// Leave a channel
{ type: "leave", channelId: string, id: string }

// Send message to a specific channel
{ type: "message", channelId: string, text: string, threadId?: string, id: string }

// Send image to a specific channel
{ type: "image", channelId: string, data: string, filename: string, id: string }

// Send document attachment
{ type: "file", channelId: string, data: string, filename: string, mimetype: string, id: string }

// Request command list
{ type: "command_list", id: string }

// Execute a slash command
{ type: "command", channelId: string, name: string, args: string[], id: string }

// Request channel list
{ type: "channel_list", id: string }

// Request message history
{ type: "history", channelId: string, before?: string, limit?: number, id: string }
```

### Server to Client

```typescript
// Channel list response
{ type: "channel_list", channels: TeamChannel[], id: string }

// Command list response
{ type: "command_list", commands: { name: string, description: string, args?: ArgDef[] }[], id: string }

// Message history response
{ type: "history", channelId: string, messages: TeamMessage[], hasMore: boolean, id: string }

// Channel event (member joined/left, created, archived)
{ type: "channel_event", channelId: string, event: "created" | "joined" | "left" | "archived", detail: any }

// Existing message type gains channelId
{ type: "message", channelId: string, text: string, agentId: string, agentName: string, threadId?: string, replyTo?: string }
```

### Backward Compatibility

Messages without `channelId` fall back to the device's default thread — existing clients don't break. The `image` type also gains the optional `channelId` field, same as `message`. The `parseClientMessage()` function in `protocol.ts` must be extended to handle all new message types (currently returns `null` for unknown types).

## Routing Changes

### Current State

The dispatcher resolves agents through a priority chain: explicit target -> dedicated channel -> thread continuity -> name addressing -> default. This is Slack-oriented.

### Team Routing

A new `resolveFromTeam()` path runs **before** the existing resolution chain when the WorkItem originates from the Team layer (WS adapter with `channelId`).

**DMs** — no routing needed. `channelId: "dm:jessica:device123"` -> message goes to `jessica`. Done.

**Channels** — @mention parsing. Message in `#production` mentioning `@sige` -> route to Sige. No mention in a channel -> route to all agent members (they each decide whether to respond, or lightweight triage picks one).

**Slash commands** — intercepted before routing. Parsed, validated against command registry, dispatched to the skill/plugin handler. Never hits an agent's LLM context.

**Agent-to-agent** — new internal dispatch path. Agent calls `send_message` tool with a target agent ID. Message stored in `team_messages`, dispatched directly as a WorkItem with `source.kind: "internal"`. No channel adapter involved.

**Slack routing** — unchanged. If WorkItem came from Slack, existing resolution handles it.

### Router Retirement

The mandatory front-door router (Rae/triage) is no longer needed for Team messages where the target is known (DMs, @mentions). Triage becomes **fallback for unaddressed messages in channels** and **discovery for new users** who don't know the agent roster.

## Slash Command Architecture

### Core Commands (always available)

| Command | Description |
|---------|-------------|
| `/new` | Create a new thread/DM |
| `/rename [name]` | Rename current thread |
| `/help` | List available commands |
| `/members` | List channel members |

### Skill Commands (discovered from plugins)

- Plugins register commands via a `registerCommands()` hook — a new optional method on `PluginManifest` that receives the command registry and adds entries. Called during plugin loading in `src/plugins/plugin-loader.ts`.
- Each command maps to a skill handler function
- Commands are instance-specific — a Dodi instance has different commands than a personal instance
- Unknown commands fall through to the agent as normal text (same pattern as beekeeper slash commands)

### Discovery Flow

1. Client connects -> sends `{ type: "command_list" }`
2. Server returns all registered commands (core + skill)
3. Client caches locally, shows autocomplete overlay when user types `/`
4. Client sends `{ type: "command", name: "order-status", args: ["12345"] }`
5. Server validates, dispatches to handler, returns result as a message

## Agent-to-Agent Direct Comms

### New MCP Tool: `send_message`

Available to all agents:

```typescript
{
  name: "send_message",
  description: "Send a direct message to another agent",
  params: {
    targetAgentId: string,    // "jessica", "sige", etc.
    text: string,
    expectReply?: boolean,    // default false
    context?: string          // thread/reference context
  }
}
```

### Two Modes

**Fire-and-forget** (`expectReply: false`): message delivered asynchronously, sender continues. Like an event but targeted and immediate.

**Request/response** (`expectReply: true`): sender blocks until target responds. Target gets a WorkItem, responds, response returned to sender's tool call. Timeout after 60s — on timeout, tool returns `{ error: "timeout", message: "No response from <targetAgentId> within 60s" }`. No retry — the calling agent decides what to do.

### Audit

All internal messages logged to `team_messages` with a stable synthetic `channelId` using lexicographic sort (e.g., `internal:jessica:sige`). Individual exchanges use `threadId` for grouping. This allows querying full conversation history between any two agents.

### Replaces

This replaces the current pattern of agents posting to Slack channels to talk to each other. Direct, fast, no third-party dependency, no user-visible noise.

## Agent Addressing

### In DMs

Implicit — the DM's other participant is the target. No ambiguity.

### In Channels

**@mention** — `@jessica check on the Smith order` in any channel thread routes to Jessica.

**No mention** — lightweight triage (reuse existing Haiku classifier) picks the best responder from the channel's agent members. Single agent claims the thread. This mirrors the current triage pattern but scoped to channel membership instead of global routing.

### Handoff

Agent A is in a conversation, realizes Agent B should handle it. Agent A uses `send_message` to brief Agent B, then Agent B joins the thread via @mention or direct entry. The thread transitions from single-agent to multi-agent (existing dispatcher logic handles this).

## Build Sequence

### Phase 1 — DMs + Document Attachments

- `team_channels` and `team_messages` MongoDB collections + indexes (`{ channelId: 1, createdAt: -1 }`, `{ threadId: 1 }`)
- DM creation/resolution (`type: "dm"`, 2 members, lexicographic ID)
- Protocol: `channelId` on messages and images, `file` message type for documents
- File storage by reference (disk + `storageKey` in message doc)
- Shared file processor handles docs (already exists in `src/files/`)
- Dispatcher: `resolveFromTeam()` for DM routing (trivial — read channel members)
- WS adapter: parse `channelId`, `file` messages, create Team-aware WorkItems
- **Note:** iOS/macOS client changes (document picker, channel-aware sending) tracked separately per-repo. This plan covers Hive server-side only.

### Phase 2 — Slash Commands

- `team_commands` collection + in-memory command registry
- Core commands: `/new`, `/rename`, `/help`, `/members`
- Plugin `registerCommands()` hook
- Protocol: `command_list` and `command` message types
- Command interception in WS adapter (before dispatch)

### Phase 3 — Channels + @mentions

- Channel CRUD (create, join, leave, archive, list)
- @mention parsing in Team context
- Message history API with cursor-based pagination
- Channel membership management
- Protocol: `join`, `leave`, `channel_list`, `history`, `channel_event`
- History API: `before` field is a message `_id` (ObjectId string) for cursor-based pagination

### Phase 4 — Agent-to-Agent Direct Comms

- `send_message` MCP tool (new MCP server or extension of existing)
- Internal dispatch path in dispatcher (skips channel adapters)
- Fire-and-forget + request/response patterns
- Audit logging to `team_messages` with synthetic channel IDs
- 60s timeout for request/response mode

## What We're NOT Building

- **Conference rooms** — future, needs more design around come-and-go semantics
- **Presence/online status** — agents are always on, not needed yet
- **Reactions/emoji** — nice-to-have, not now
- **Message editing/deletion** — append-only for audit integrity
- **Push notifications** — iOS already handles via WS reconnect + pending message drain
- **Migration from Slack** — Slack stays as optional adapter, no data migration
- **Web client** — iOS + macOS cover the bases, web can come later
- **File sharing between agents** — agents share context via `send_message` text, not file attachments
- **Message archival/TTL** — `team_messages` will grow; archival strategy deferred until volume warrants it
- **iOS/macOS client changes** — tracked separately per-repo; this spec covers Hive server-side only

## File Map

| Area | Files | Changes |
|------|-------|---------|
| Team core | `src/team/team-manager.ts` | Channel/DM CRUD, membership, message storage |
| Team core | `src/team/command-registry.ts` | Slash command registration + dispatch |
| Team core | `src/team/types.ts` | TeamChannel, TeamMessage, TeamCommand types |
| Protocol | `src/channels/ws/protocol.ts` | New message types (join, leave, file, command, history, etc.) |
| WS adapter | `src/channels/ws/ws-adapter.ts` | Channel-aware message handling, command interception, file messages |
| Routing | `src/channels/dispatcher.ts` | `resolveFromTeam()` path, Team-aware routing |
| Agent comms | `src/team/team-mcp-server.ts` | `send_message` tool for agent-to-agent |
| Agent runner | `src/agents/agent-runner.ts` | Wire team MCP server into agent sessions |
| Plugins | `src/plugins/plugin-types.ts` | `registerCommands()` hook |
| iOS/macOS | Keepur apps | Document picker, channel UI, slash command autocomplete, @mentions |
