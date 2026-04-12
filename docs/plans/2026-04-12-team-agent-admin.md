# Team Agent Admin Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Expose agent metadata and runtime status over the Team WebSocket connection via a new `agent_list` message type, enabling clients to discover and inspect agents without admin tokens.

**Architecture:** Three files change. `protocol.ts` gains new type definitions and parser/union extensions. `ws-adapter.ts` gains two new constructor dependencies (`AgentRegistry`, `AgentManager`) and a handler that joins registry data with runtime state. `index.ts` passes the new dependencies at construction time.

**Tech Stack:** TypeScript, WebSocket (ws)

**Spec:** `docs/specs/2026-04-12-team-agent-admin-design.md`

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/channels/ws/protocol.ts` | `AgentInfo`, `AgentListRequest`, `AgentListResponse`, `AgentStatusUpdate` types; `ClientMessage` and `ServerMessage` union extensions; `parseClientMessage()` case |
| `src/channels/ws/ws-adapter.ts` | `AgentRegistry` + `AgentManager` constructor params; `buildAgentList()` method; `agent_list` handler in message router |
| `src/index.ts` | Pass `registry` and `agentManager` to `WsAdapter` constructor |

---

### Task 1: Protocol Types and Parser

**Files:**
- Modify: `src/channels/ws/protocol.ts`

- [ ] **Step 1:** Add the new interfaces after the existing `ClientHistory` interface (before the `ClientMessage` union, around line 85):

```typescript
export interface ClientAgentList {
  type: "agent_list";
  id: string;
}
```

- [ ] **Step 2:** Add `ClientAgentList` to the `ClientMessage` union (line 87–99). Add `| ClientAgentList` as the last member:

```typescript
export type ClientMessage =
  | ClientTextMessage
  | ClientImageMessage
  | ClientPing
  | ClientTeamMessage
  | ClientTeamImage
  | ClientTeamFile
  | ClientJoin
  | ClientLeave
  | ClientCommand
  | ClientCommandList
  | ClientChannelList
  | ClientHistory
  | ClientAgentList;
```

- [ ] **Step 3:** Add server response types after the existing `ServerChannelEvent` interface (before the `ServerMessage` union, around line 165):

```typescript
export interface AgentInfo {
  id: string;
  name: string;
  icon: string;
  title: string | null;
  model: string;
  status: "idle" | "processing" | "error" | "stopped";
  tools: string[];
  schedule: { cron: string; task: string }[];
  channels: string[];
  messagesProcessed: number;
  lastActivity: string | null; // ISO 8601, null when agent has never received a message
}

export interface ServerAgentList {
  type: "agent_list";
  agents: AgentInfo[];
  id: string;
}

// Phase 2 — defined now, added to ServerMessage union later
export interface ServerAgentStatus {
  type: "agent_status";
  agentId: string;
  status: "idle" | "processing" | "error" | "stopped";
  id: string;
}
```

- [ ] **Step 4:** Add `ServerAgentList` to the `ServerMessage` union (line 167–175). Add `| ServerAgentList` as the last member:

```typescript
export type ServerMessage =
  | ServerTextMessage
  | ServerAck
  | ServerTyping
  | ServerError
  | ServerChannelList
  | ServerCommandList
  | ServerHistory
  | ServerChannelEvent
  | ServerAgentList;
```

Note: `ServerAgentStatus` is intentionally NOT added to `ServerMessage` yet — that's Phase 2.

- [ ] **Step 5:** Add the `agent_list` case to `parseClientMessage()`. Insert before the `default:` case (around line 298), after the `history` case:

```typescript
    case "agent_list":
      if (typeof msg.id === "string") {
        return { type: "agent_list", id: msg.id };
      }
      return null;
```

- [ ] **Step 6:** Verify — build the project:

Run: `cd ~/github/hive && npx tsc --noEmit`
Expected: No errors (the new types are defined and wired into unions but not yet consumed — that's Task 2)

- [ ] **Step 7:** Commit

```bash
git add src/channels/ws/protocol.ts
git commit -m "feat(ws): add agent_list protocol types and parser case"
```

---

### Task 2: WsAdapter — Constructor and Handler

**Files:**
- Modify: `src/channels/ws/ws-adapter.ts`

- [ ] **Step 1:** Add imports. At the top of the file, add the `AgentRegistry` and `AgentManager` imports, and the new protocol type import:

```typescript
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { AgentManager } from "../../agents/agent-manager.js";
```

Also add `ClientAgentList` and `AgentInfo` to the existing protocol import (line 8–19):

```typescript
import type {
  ServerMessage,
  ClientTeamMessage,
  ClientTeamImage,
  ClientTeamFile,
  ClientJoin,
  ClientLeave,
  ClientCommand,
  ClientCommandList,
  ClientChannelList,
  ClientHistory,
  ClientAgentList,
  AgentInfo,
} from "./protocol.js";
```

- [ ] **Step 2:** Add instance fields. After the `commandRegistry` field (line 40):

```typescript
  private agentRegistry?: AgentRegistry;
  private agentManager?: AgentManager;
```

- [ ] **Step 3:** Update the constructor signature (lines 42–54). Add the two new parameters after `commandRegistry`:

```typescript
  constructor(
    port: number,
    deviceRegistry: DeviceRegistry,
    adminSecret: string,
    teamStore?: TeamStore,
    commandRegistry?: CommandRegistry,
    agentRegistry?: AgentRegistry,
    agentManager?: AgentManager,
  ) {
    this.port = port;
    this.deviceRegistry = deviceRegistry;
    this.adminSecret = adminSecret;
    this.teamStore = teamStore;
    this.commandRegistry = commandRegistry;
    this.agentRegistry = agentRegistry;
    this.agentManager = agentManager;
  }
```

- [ ] **Step 4:** Add the `agent_list` handler in the message router. Insert after the `handleLeave` block (after line 420, before the `isTeamMessage()` check at line 422):

```typescript
          if (msg.type === "agent_list") {
            if (!this.agentRegistry) {
              this.send(ws, { type: "error", message: "Agent registry not available" });
              return;
            }
            const agents = this.buildAgentList();
            this.send(ws, { type: "agent_list", agents, id: msg.id });
            return;
          }
```

- [ ] **Step 5:** Add the `buildAgentList()` method. Add it in the Team helpers section (after line 617, before the Team message handlers):

```typescript
  /** Build the agent roster with runtime status for client consumption. */
  private buildAgentList(): AgentInfo[] {
    if (!this.agentRegistry) return [];

    return this.agentRegistry.getAll().map((agent) => {
      const state = this.agentManager?.getState(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        icon: agent.icon,
        title: agent.title ?? null,
        model: agent.model,
        status: state?.status ?? "idle",
        tools: [...new Set([...agent.coreServers, ...agent.delegateServers])].sort(),
        schedule: agent.schedule.map((s) => ({ cron: s.cron, task: s.task })),
        channels: agent.channels,
        messagesProcessed: state?.messagesProcessed ?? 0,
        lastActivity: state?.lastActivity?.toISOString() ?? null,
      };
    });
  }
```

- [ ] **Step 6:** Verify — type-check:

Run: `cd ~/github/hive && npx tsc --noEmit`
Expected: Clean — no errors. The new constructor params are optional (`?`), so the existing 5-arg call in `index.ts` still compiles. Task 3 adds the args explicitly.

- [ ] **Step 7:** Commit

```bash
git add src/channels/ws/ws-adapter.ts
git commit -m "feat(ws): handle agent_list — expose agent roster over Team WS"
```

---

### Task 3: Bootstrap Wiring

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1:** Update the `WsAdapter` constructor call at line 343. Change from:

```typescript
    wsAdapter = new WsAdapter(config.ws.port, deviceRegistry, config.ws.jwtSecret, teamStore, commandRegistry);
```

To:

```typescript
    wsAdapter = new WsAdapter(config.ws.port, deviceRegistry, config.ws.jwtSecret, teamStore, commandRegistry, registry, agentManager);
```

Both `registry` and `agentManager` are already declared and initialized earlier in the bootstrap (lines 54–56 and 91–179 respectively), well before the WsAdapter construction at line 343.

- [ ] **Step 2:** Verify — full type-check and build:

Run: `cd ~/github/hive && npx tsc --noEmit`
Expected: Clean — no errors.

Run: `cd ~/github/hive && npm run build`
Expected: Build succeeds.

- [ ] **Step 3:** Commit

```bash
git add src/index.ts
git commit -m "feat(ws): wire AgentRegistry and AgentManager into WsAdapter"
```

---

### Task 4: Smoke Test

- [ ] **Step 1:** Verify the build output is complete:

Run: `cd ~/github/hive && npm run build`
Expected: Clean build, no errors.

- [ ] **Step 2:** Verify `agent_list` appears in the compiled protocol:

Run: `grep -n "agent_list" dist/channels/ws/protocol.js`
Expected: Multiple matches — the parse case and type references.

- [ ] **Step 3:** Verify `buildAgentList` appears in the compiled WsAdapter:

Run: `grep -n "buildAgentList" dist/channels/ws/ws-adapter.js`
Expected: At least 2 matches — the method definition and the call site.

- [ ] **Step 4:** Commit (no new files — just verification)

No commit needed for this task.
