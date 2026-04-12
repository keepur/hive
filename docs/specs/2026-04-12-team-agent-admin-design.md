# Team Agent Admin — Design Spec

**Date:** 2026-04-12
**Status:** Draft
**Depends on:** [Team Layer Hive](2026-04-06-team-layer-design.md) (shipped)

## Problem

Clients connected to the Hive Team WebSocket (iOS, future web) have no way to discover which agents exist, what they do, what tools they have, or whether they're busy. The only agent discovery path is knowing an agent ID and using the `/new` slash command.

For Hive instances **without Slack** (scenario A), the Team WS is the entire comms platform — agent discovery is essential. For instances **with Slack** (scenario B), the Team WS serves as agent admin + DMs — a control surface for your agent team.

## Solution

Expose agent metadata and runtime status over the existing Team WebSocket connection via new message types. Read-only. No separate REST connection, no admin tokens — device JWT is sufficient.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | WS message types on existing Team connection | Clients already have this connection; avoids second auth flow |
| Auth | Device JWT (existing) | Read-only data, no elevated access needed |
| Scope | Read-only | Avoids authorization design; edits happen via Beekeeper or CLI |
| DM relay to Slack | Existing audit log only | Sufficient visibility; full relay deferred |
| Agent detail depth | Flat — one `agent_list` returns everything | Agent count is small (< 20); no pagination needed |

## Context: Teams on iOS

The Team tab on the Keepur iOS app has two operating modes, determined by whether the Hive instance has an active Slack connection:

- **No Slack configured** → Team tab is the full comms platform (channels, DMs, group messaging). Agent discovery via `agent_list` is essential for users to find and interact with agents.
- **Slack active** → Team tab provides agent admin (read-only roster) + agent DMs. The primary team comms happen on Slack; the iOS app is a mobile control surface.

DMs initiated from the Team tab are relayed to the agent's Slack audit channel via the existing audit log mechanism (compact summary). No full conversation mirroring. iOS UI design (layout, navigation, views) is out of scope for this spec — covered separately in the keepur-ios repo.

## WS Protocol Additions

### Client → Server

```
{ type: "agent_list", id: "<uuid>" }
```

Requests the full agent roster with runtime status. No parameters — returns all non-disabled agents. On failure (registry unavailable), responds with the standard error type: `{ type: "error", message: "Agent registry not available" }`.

### Server → Client

```json
{
  "type": "agent_list",
  "agents": [
    {
      "id": "rae",
      "name": "Rae",
      "icon": ":wave:",
      "title": "Receptionist",
      "model": "claude-haiku-3-5",
      "status": "idle",
      "tools": ["schedule", "crm-search", "slack"],
      "schedule": [
        { "cron": "0 9 * * 1-5", "task": "Morning standup summary" }
      ],
      "channels": ["general"],
      "messagesProcessed": 142,
      "lastActivity": "2026-04-12T14:30:00Z"
    }
  ],
  "id": "<echoed-uuid>"
}
```

**Field sources:**

| Field | Source | Notes |
|-------|--------|-------|
| `id` | `AgentDefinition._id` | |
| `name` | `AgentDefinition.name` | |
| `icon` | `AgentDefinition.icon` | Emoji string or URL |
| `title` | `AgentDefinition.title` | Optional — may be null |
| `model` | `AgentDefinition.model` | Ceiling model ID |
| `status` | `AgentState.status` | Runtime — `"idle"`, `"processing"`, `"error"`, or `"stopped"`. Matches `AgentStatus` type. Default `"idle"` when no state exists. |
| `tools` | `coreServers ∪ delegateServers` | `[...new Set([...agent.coreServers, ...agent.delegateServers])].sort()` |
| `schedule` | `AgentDefinition.schedule` | Array of `{ cron, task }` |
| `channels` | `AgentDefinition.channels` | Slack channel names |
| `messagesProcessed` | `AgentState.messagesProcessed` | Runtime counter |
| `lastActivity` | `AgentState.lastActivity` | `Date` serialized via `.toISOString()`. Null only when `agentManager.getState()` returns `undefined` (agent never received a message). Note: `lastActivity` is set on first message receipt, not first completed response — an in-flight agent may have `messagesProcessed: 0` with non-null `lastActivity`. |

**Filtering:** Disabled agents (`disabled: true`) are excluded. The response includes all active agents regardless of whether the requesting device has interacted with them.

**Agents with no runtime state:** `AgentManager` populates state lazily via `ensureState()`, called on first `sendMessage()`. An agent that has never received a message has no `AgentState` entry. `buildAgentList()` iterates `AgentRegistry.getAll()` (returns `AgentConfig[]` — note: the `id` field on `AgentConfig` maps from `_id` in MongoDB) and does a per-agent lookup via `agentManager.getState(agentId)`. If no state exists, use defaults: `status: "idle"`, `messagesProcessed: 0`, `lastActivity: null`.

**`icon` field:** `AgentConfig.icon` defaults to `""` (empty string). Clients should handle empty string gracefully (e.g., show a default avatar). The server sends the value as-is — no normalization to null.

**Staleness:** This is a point-in-time snapshot. Runtime status reflects the moment the request is handled. There is no live subscription — clients re-fetch when needed (on connect, pull-to-refresh, app foreground).

### Server → Client (Push — Phase 2)

```json
{
  "type": "agent_status",
  "agentId": "jasper",
  "status": "processing",
  "id": "<server-generated-uuid>"
}
```

**Phase 2 enhancement.** The server pushes status changes as agents transition between idle/processing/error/stopped. This requires a new `broadcastToTeamDevices(msg: ServerMessage)` method on `WsAdapter` that iterates `this.connections` and sends to all connected devices (regardless of channel membership — status updates are global). The existing `onProcessingStart`/`onProcessingEnd` hooks are per-device (they send `typing` to the originating device only) — they cannot be reused directly for broadcast. The new broadcast method would be called from `AgentManager` state transitions.

Without this, the agent roster shows status as of the last `agent_list` fetch, which is acceptable for Phase 1.

## Server-Side Implementation

### 1. Protocol Types

Add to `src/channels/ws/protocol.ts`:

```typescript
// Client → Server
interface AgentListRequest {
  type: 'agent_list';
  id: string;
}

// Server → Client
interface AgentListResponse {
  type: 'agent_list';
  agents: AgentInfo[];
  id: string;
}

interface AgentInfo {
  id: string;
  name: string;
  icon: string;
  title: string | null;
  model: string;
  status: 'idle' | 'processing' | 'error' | 'stopped';
  tools: string[];
  schedule: { cron: string; task: string }[];
  channels: string[];
  messagesProcessed: number;
  lastActivity: string | null;  // ISO 8601, null when no AgentState exists (agent never received a message)
}

// Server → Client (push, Phase 2)
interface AgentStatusUpdate {
  type: 'agent_status';
  agentId: string;
  status: 'idle' | 'processing' | 'error' | 'stopped';
  id: string;
}
```

Add `AgentListRequest` to both the `ClientMessage` type union and the `parseClientMessage()` switch-case. The parse case follows the `channel_list`/`command_list` pattern:

```typescript
case 'agent_list':
  if (typeof msg.id === 'string') {
    return { type: 'agent_list', id: msg.id };
  }
  return null;
```

Add `AgentListResponse` to the `ServerMessage` union type (the union that constrains the `send()` method's `msg` parameter) — without this, `this.send(ws, { type: 'agent_list', ... })` will fail to compile. `AgentStatusUpdate` is defined here but added to `ServerMessage` in Phase 2 only.

### 2. WsAdapter — Handle `agent_list`

In `ws-adapter.ts`, add a handler for `type: "agent_list"` in the message router. The router uses `if/else if` chains (not a switch), so the handler follows that pattern. Insert before the `isTeamMessage()` guard:

```typescript
if (msg.type === 'agent_list') {
  const agents = await this.buildAgentList();
  this.send(ws, { type: 'agent_list', agents, id: msg.id });
  return;
}
```

The `buildAgentList()` method needs access to:
- **`AgentRegistry`** — for agent metadata (`registry.getAll()` returns all active `AgentConfig[]`). Already available as `registry` in `src/index.ts`.
- **`AgentManager`** — for runtime state (`agentManager.getState(agentId)` returns `AgentState | undefined`)

Both are available in the Hive bootstrap (`src/index.ts`) where the WsAdapter is constructed. Pass `AgentRegistry` and `AgentManager` as new required constructor parameters — unlike `teamStore?` and `commandRegistry?` (which are optional because the Team layer is feature-flagged), the registry and agent manager are always instantiated in bootstrap and required for core Hive operation.

### 3. AgentManager — No Changes

`AgentManager.getState(agentId)` returns `AgentState | undefined` for a single agent. `AgentManager.getAllStates()` returns `AgentState[]` (only agents that have processed at least one message). No changes needed — `buildAgentList()` iterates `AgentRegistry.getAll()` and looks up per-agent state, defaulting missing entries to idle/zero/null.

### 4. Bootstrap Wiring

In `src/index.ts`, pass `AgentRegistry` and `AgentManager` when constructing `WsAdapter`:

```typescript
wsAdapter = new WsAdapter(
  config.ws.port,
  deviceRegistry,
  config.ws.jwtSecret,
  teamStore,
  commandRegistry,
  registry,       // NEW
  agentManager,   // NEW
);
```

Both are already instantiated earlier in the bootstrap sequence.

## What's NOT in This Spec

- **Write operations** — no editing model ceilings, schedules, enable/disable from clients
- **Authorization model** — read-only eliminates the need for role-based access
- **Full comms mode** (scenario A) — separate spec for group channels, multi-device fan-out
- **Private messages** — all DMs relay to Slack via existing audit log
- **Memory viewer** — agent memory is not exposed
- **Conversation history** — agent's past conversations are not surfaced
- **Agent-to-agent messaging visibility** — internal channels stay internal
- **Agent creation/deletion from clients** — admin operations stay on CLI/Beekeeper
- **iOS UI design** — layout, navigation, views are a separate keepur-ios spec

## Build Sequence

### Phase 1 — `agent_list` support

1. Add `AgentInfo`, `AgentListRequest`, `AgentListResponse`, `AgentStatusUpdate` types to `protocol.ts`
2. Add `AgentListRequest` to `ClientMessage` union and `parseClientMessage()` switch-case; add `AgentListResponse` to `ServerMessage` union. **Blocking** — steps 3–6 will not compile without this.
3. Add `AgentRegistry` and `AgentManager` as required params to `WsAdapter` constructor
4. Implement `buildAgentList()` — iterate `AgentRegistry.getAll()`, lookup `AgentManager.getState()` per agent, default missing state to idle/zero/null
5. Handle `agent_list` message type in WS message router (if/else if chain, before `isTeamMessage()`)
6. Wire new params in `src/index.ts`

### Phase 2 — `agent_status` push

7. Add `AgentStatusUpdate` to `ServerMessage` union (interface already defined in Phase 1)
8. Implement `broadcastToTeamDevices()` on `WsAdapter`
9. Hook into `AgentManager` state transitions to broadcast status changes

## File Map

| File | Changes |
|------|---------|
| `src/channels/ws/protocol.ts` | Add `AgentListRequest`, `AgentListResponse`, `AgentInfo`, `AgentStatusUpdate` types; extend unions |
| `src/channels/ws/ws-adapter.ts` | Add `AgentRegistry` + `AgentManager` constructor params; handle `agent_list`; implement `buildAgentList()` |
| `src/index.ts` | Pass `registry` and `agentManager` to `WsAdapter` constructor |
