# Team Layer GA Hardening — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Remove the dead `team.enabled` feature gate, rename `/new` → `/dm`, validate agent ids/names, fix double-ack and the misleading unknown-command fallthrough.

**Spec:** [docs/specs/2026-04-13-team-ga-hardening-design.md](../specs/2026-04-13-team-ga-hardening-design.md)

**Ticket:** [KPR-11](https://linear.app/keepur/issue/KPR-11)

**Architecture:** `CommandRegistry` gains a narrow `AgentResolver` closure (not the full `AgentRegistry`) so command handlers can validate agent ids or display names without coupling the generic command layer to agent internals. `WsAdapter` drops its optional-deps posture — `teamStore` and `commandRegistry` are always present, all `?.` guards are removed, and `handleCommand` short-circuits on unknown command names with an explicit error instead of falling through to `handleTeamMessage`.

**Tech Stack:** TypeScript, Node 24, Vitest, MongoDB.

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/config.ts` | Modify | Drop `team.enabled` field + `TEAM_ENABLED` env var |
| `src/index.ts` | Modify | Build `AgentResolver` closure; unconditional `TeamStore` + `CommandRegistry` construction |
| `src/team/command-registry.ts` | Modify | Accept `AgentResolver` in ctor; rename `/new` → `/dm`; validate agent before `getOrCreateDm` |
| `src/team/command-registry.test.ts` | Modify | Update for `/dm` contract + resolver stub |
| `src/channels/ws/ws-adapter.ts` | Modify | Non-optional `teamStore`/`commandRegistry`; strip `?.` guards; rewrite `handleCommand` |

No new files. No test file created for `ws-adapter.ts` (none exists today — existing WS behavior is covered by manual end-to-end testing per the Phase B ship).

---

## Task 1: Remove `team.enabled` from config

**Files:**
- Modify: `src/config.ts:196-198`

- [ ] **Step 1:** Delete the `team` block from the config object.

```ts
// DELETE these lines in src/config.ts (around 196-198):
  team: {
    enabled: optional("TEAM_ENABLED", "false") === "true",
  },
```

- [ ] **Step 2:** Search for any other references.

Run: (Grep tool) `pattern: "config\\.team|TEAM_ENABLED"` `path: src`
Expected: Only hits should be `src/index.ts:325` (`config.team.enabled`) — which Task 4 removes. No other references.

- [ ] **Step 3:** Typecheck.

Run: `npm run typecheck`
Expected: Errors only in `src/index.ts` referencing `config.team.enabled`. No other files complain.

---

## Task 2: Add `AgentResolver` type + refactor `CommandRegistry`

**Files:**
- Modify: `src/team/command-registry.ts`

- [ ] **Step 1:** Replace the full file with the version below.

```ts
// src/team/command-registry.ts

import { createLogger } from "../logging/logger.js";
import type { TeamCommandHandler, TeamCommandDef, CommandContext } from "./types.js";
import type { TeamStore } from "./team-store.js";

const log = createLogger("command-registry");

/**
 * Narrow resolver for the `/dm` command. Built in src/index.ts as a closure
 * over AgentRegistry.getAll(). Accepts either an agent id (exact match) or
 * display name (case-insensitive); returns null on no match.
 */
export type AgentResolver = (idOrName: string) => { id: string; name: string } | null;

export class CommandRegistry {
  private commands = new Map<string, TeamCommandHandler>();

  constructor(
    private teamStore: TeamStore,
    private resolveAgent: AgentResolver,
  ) {
    this.registerCoreCommands();
  }

  register(handler: TeamCommandHandler): void {
    if (this.commands.has(handler.def.name)) {
      log.warn("Command already registered, overwriting", { name: handler.def.name });
    }
    this.commands.set(handler.def.name, handler);
    log.info("Command registered", { name: handler.def.name, source: handler.def.source });
  }

  get(name: string): TeamCommandHandler | undefined {
    return this.commands.get(name);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  list(): TeamCommandDef[] {
    return [...this.commands.values()].map((h) => h.def);
  }

  async execute(name: string, context: CommandContext): Promise<{ found: boolean; result?: string }> {
    const handler = this.commands.get(name);
    if (!handler) return { found: false };

    try {
      const result = await handler.execute(context);
      return { found: true, result };
    } catch (err) {
      log.error("Command execution failed", { name, error: String(err) });
      return { found: true, result: `Command failed: ${String(err)}` };
    }
  }

  private registerCoreCommands(): void {
    this.register({
      def: {
        name: "help",
        source: "core",
        description: "List available commands",
      },
      execute: async () => {
        const defs = this.list();
        const lines = defs.map((d) => `  /${d.name} — ${d.description}`);
        return `Available commands:\n${lines.join("\n")}`;
      },
    });

    this.register({
      def: {
        name: "dm",
        source: "core",
        description: "Open or create a DM with an agent",
        args: [{ name: "agent", required: true, description: "Agent id or display name" }],
      },
      execute: async (ctx) => {
        const input = ctx.args[0];
        if (!input) return "Usage: /dm <agent-id-or-name>";
        const agent = this.resolveAgent(input);
        if (!agent) return `Unknown agent: ${input}`;
        const dm = await this.teamStore.getOrCreateDm(ctx.senderId, agent.id, ctx.senderName);
        return `DM ready: ${dm._id}`;
      },
    });

    this.register({
      def: {
        name: "rename",
        source: "core",
        description: "Rename the current channel or thread",
        args: [{ name: "name", required: true, description: "New name" }],
      },
      execute: async (ctx) => {
        const newName = ctx.args.join(" ");
        if (!newName) return "Usage: /rename <new name>";
        const ok = await this.teamStore.renameChannel(ctx.channelId, newName);
        return ok ? `Renamed to "${newName}"` : "Channel not found";
      },
    });

    this.register({
      def: {
        name: "members",
        source: "core",
        description: "List members of the current channel",
      },
      execute: async (ctx) => {
        const channel = await this.teamStore.getChannel(ctx.channelId);
        if (!channel) return "Channel not found";
        return `Members of ${channel.name}:\n${channel.members.map((m) => `  - ${m}`).join("\n")}`;
      },
    });
  }
}
```

- [ ] **Step 2:** Typecheck. Two downstream errors are expected: `src/index.ts` (Task 4) and `src/team/command-registry.test.ts` (Task 3) — both will be fixed in their own tasks.

Run: `npm run typecheck`
Expected: Errors confined to `src/index.ts` and `src/team/command-registry.test.ts`.

---

## Task 3: Update `command-registry.test.ts`

**Files:**
- Modify: `src/team/command-registry.test.ts`

- [ ] **Step 1:** Replace the full file with the version below.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── TeamStore mock ──────────────────────────────────────────────────
const mockGetOrCreateDm = vi.fn().mockResolvedValue({ _id: "dm:a:b", type: "dm", members: ["a", "b"] });
const mockRenameChannel = vi.fn().mockResolvedValue(true);
const mockGetChannel = vi.fn().mockResolvedValue({ _id: "general", name: "#general", members: ["agent-a", "agent-b"] });

const mockTeamStore = {
  getOrCreateDm: mockGetOrCreateDm,
  renameChannel: mockRenameChannel,
  getChannel: mockGetChannel,
} as any;

// ── AgentResolver stub ──────────────────────────────────────────────
const KNOWN_AGENTS = [
  { id: "jessica", name: "Jessica" },
  { id: "chloe", name: "Chloe" },
];
const mockResolver = vi.fn((input: string) => {
  const byId = KNOWN_AGENTS.find((a) => a.id === input);
  if (byId) return byId;
  const byName = KNOWN_AGENTS.find((a) => a.name.toLowerCase() === input.toLowerCase());
  return byName ?? null;
});

import { CommandRegistry } from "./command-registry.js";

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry(mockTeamStore, mockResolver);
  });

  it("has core commands registered", () => {
    const names = registry.list().map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("dm");
    expect(names).toContain("rename");
    expect(names).toContain("members");
  });

  it("does NOT register legacy /new", () => {
    const names = registry.list().map((c) => c.name);
    expect(names).not.toContain("new");
  });

  it("executes /help and returns command list", async () => {
    const { found, result } = await registry.execute("help", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("/help");
    expect(result).toContain("/dm");
  });

  it("returns found=false for unknown commands", async () => {
    const { found } = await registry.execute("nonexistent", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(false);
  });

  it("/dm with valid agent id creates DM", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["jessica"],
    });
    expect(found).toBe(true);
    expect(result).toContain("DM ready");
    expect(mockGetOrCreateDm).toHaveBeenCalledWith("user-1", "jessica", "User");
  });

  it("/dm with display name (case-insensitive) creates DM", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["CHLOE"],
    });
    expect(found).toBe(true);
    expect(result).toContain("DM ready");
    // Resolver maps display name → id before hitting teamStore
    expect(mockGetOrCreateDm).toHaveBeenCalledWith("user-1", "chloe", "User");
  });

  it("/dm with unknown agent returns error, no DB write", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["not-a-real-agent"],
    });
    expect(found).toBe(true);
    expect(result).toBe("Unknown agent: not-a-real-agent");
    expect(mockGetOrCreateDm).not.toHaveBeenCalled();
  });

  it("/dm with no args returns usage", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("Usage: /dm");
    expect(mockGetOrCreateDm).not.toHaveBeenCalled();
  });

  it("executes /rename", async () => {
    const { found, result } = await registry.execute("rename", {
      channelId: "general",
      senderId: "user-1",
      senderName: "User",
      args: ["New", "Name"],
    });
    expect(found).toBe(true);
    expect(result).toContain("Renamed");
    expect(mockRenameChannel).toHaveBeenCalledWith("general", "New Name");
  });

  it("executes /members", async () => {
    const { found, result } = await registry.execute("members", {
      channelId: "general",
      senderId: "user-1",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("agent-a");
    expect(result).toContain("agent-b");
  });

  it("accepts custom skill commands", async () => {
    registry.register({
      def: { name: "order-status", source: "skill", description: "Check order status" },
      execute: async (ctx) => `Order ${ctx.args[0]} is shipped`,
    });

    const { found, result } = await registry.execute("order-status", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: ["12345"],
    });
    expect(found).toBe(true);
    expect(result).toBe("Order 12345 is shipped");
  });

  it("handles command execution errors gracefully", async () => {
    registry.register({
      def: { name: "failing", source: "skill", description: "Always fails" },
      execute: async () => {
        throw new Error("boom");
      },
    });

    const { found, result } = await registry.execute("failing", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("Command failed");
  });
});
```

- [ ] **Step 2:** Run just this test file.

Run: `npx vitest run src/team/command-registry.test.ts`
Expected: All tests pass.

---

## Task 4: Unconditional team wiring in `src/index.ts`

**Files:**
- Modify: `src/index.ts:321-341`

- [ ] **Step 1:** Replace lines 321–341 **in full**. This includes both the forward `let teamStore` / `let commandRegistry` declarations at lines 322–323 AND the `if (config.team.enabled)` block AND the trailing `if (commandRegistry) { ... registerPluginCommands }` block at 338–341.

The replacement code sits at the **same outer function scope** as the original `let` declarations, so downstream references at line ~350 (WsAdapter ctor) and line ~466 (`teamStore.close()`) continue to resolve. The new declarations are `const` at outer-function scope, not inside any nested block.

```ts
  // Team layer — channels, DMs, commands. Always on when mongo is available;
  // no feature gate (KPR-11).
  const { TeamStore } = await import("./team/team-store.js");
  const { CommandRegistry } = await import("./team/command-registry.js");

  const teamStore = new TeamStore(config.mongo.uri, config.mongo.dbName);
  await teamStore.connect();

  // Narrow resolver closure — keeps CommandRegistry decoupled from AgentRegistry.
  // Exact id wins; otherwise case-insensitive display name match.
  const resolveAgent = (input: string): { id: string; name: string } | null => {
    const all = registry.getAll();
    const byId = all.find((a) => a.id === input);
    if (byId) return { id: byId.id, name: byId.name };
    const lower = input.toLowerCase();
    const byName = all.find((a) => a.name.toLowerCase() === lower);
    return byName ? { id: byName.id, name: byName.name } : null;
  };

  const commandRegistry = new CommandRegistry(teamStore, resolveAgent);
  dispatcher.setTeamStore(teamStore);

  log.info("Team layer initialized");

  const { registerPluginCommands } = await import("./plugins/plugin-loader.js");
  await registerPluginCommands(agentManager.getPlugins(), commandRegistry);
```

**Scope sanity check:** After this edit, `teamStore` and `commandRegistry` must be accessible at the indentation level of the original `let` declarations (function scope of the top-level start routine in `index.ts`). If your editor auto-indents the block one level deeper, fix it — downstream consumers at `wsAdapter = new WsAdapter(..., { teamStore, commandRegistry, ... })` and `await teamStore.close()` depend on outer-scope visibility.

- [ ] **Step 2:** Confirm the shutdown path still closes `teamStore`.

Run: (Grep tool) `pattern: "teamStore"` `path: src/index.ts`
Expected: `teamStore.close()` call near line 466 still present and compiles without the `if (teamStore)` guard — it's now always defined, so simplify:

```ts
// Change (around line 466):
//   if (teamStore) await teamStore.close();
// to:
    await teamStore.close();
```

- [ ] **Step 3:** Typecheck.

Run: `npm run typecheck`
Expected: Errors only in `src/channels/ws/ws-adapter.ts` (Task 5 fixes those — `WsAdapterDeps` still marks the fields optional).

---

## Task 4b: Drop `team.enabled` from `agent-runner` and `scheduler`

**Files:**
- Modify: `src/agents/agent-runner.ts:614-631, 692-694`
- Modify: `src/scheduler/scheduler.ts:112-115, 170-174, 181`

Found during Task 1 typecheck — `config.team.enabled` is referenced in these two files in addition to `src/index.ts`. Spec says the flag must be gone from **all code paths**; all references become unconditional.

- [ ] **Step 1:** `src/agents/agent-runner.ts:614` — drop the `if` gate around the `team` MCP server. Team server is always registered.

```ts
// OLD (614-631):
    // Team MCP server — agent-to-agent direct messaging
    if (config.team.enabled) {
      if (!AgentRunner.registryRef) {
        log.warn("Team enabled but registryRef not set — agents will get empty AGENT_IDS");
      }
      servers["team"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/team/team-mcp-server.js")],
        env: {
          AGENT_ID: this.agentConfig.id,
          MONGODB_URI: config.mongo.uri,
          MONGODB_DB: config.mongo.dbName,
          AGENT_IDS: JSON.stringify(
            AgentRunner.registryRef?.getAll().map((a) => a.id) ?? [],
          ),
        },
      };
    }
// NEW:
    // Team MCP server — agent-to-agent direct messaging
    if (!AgentRunner.registryRef) {
      log.warn("registryRef not set — agents will get empty AGENT_IDS for team server");
    }
    servers["team"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/team/team-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        AGENT_IDS: JSON.stringify(
          AgentRunner.registryRef?.getAll().map((a) => a.id) ?? [],
        ),
      },
    };
```

- [ ] **Step 2:** `src/agents/agent-runner.ts:692` — drop the `if` gate around adding `"team"` to the core set. Team is always an implicit core server.

```ts
// OLD (689-694):
    // schedule is an implicit core server — available to all agents unconditionally
    coreSet.add("schedule");
    // team is an implicit core server when team layer is enabled
    if (config.team.enabled) {
      coreSet.add("team");
    }
// NEW:
    // schedule is an implicit core server — available to all agents unconditionally
    coreSet.add("schedule");
    // team is an implicit core server — available to all agents unconditionally
    coreSet.add("team");
```

- [ ] **Step 3:** `src/scheduler/scheduler.ts:112` — drop the `if` gate around team pending-requests indexes. Always create them.

```ts
// OLD (111-115):
    // Team pending requests indexes
    if (config.team.enabled) {
      await this.db.collection("team_pending_requests").createIndex({ status: 1, createdAt: -1 });
      await this.db.collection("team_pending_requests").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    }
// NEW:
    // Team pending requests indexes
    await this.db.collection("team_pending_requests").createIndex({ status: 1, createdAt: -1 });
    await this.db.collection("team_pending_requests").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
```

- [ ] **Step 4:** `src/scheduler/scheduler.ts:170` — drop the `config.team.enabled &&` gate on the team request timer. Keep the `this.db` null check.

```ts
// OLD (169-174):
    // Team requests: check every 5 seconds for agent-to-agent messages
    if (config.team.enabled && this.db) {
      this.teamTimer = setInterval(() => {
        this.fireTeamRequests().catch((err) => log.error("Team request check failed", { error: String(err) }));
      }, 5_000);
    }
// NEW:
    // Team requests: check every 5 seconds for agent-to-agent messages
    if (this.db) {
      this.teamTimer = setInterval(() => {
        this.fireTeamRequests().catch((err) => log.error("Team request check failed", { error: String(err) }));
      }, 5_000);
    }
```

- [ ] **Step 5:** `src/scheduler/scheduler.ts:181` — remove the `teamEnabled` field from the scheduler `start` log object (it's now always true and therefore not interesting).

```ts
// OLD (176-182):
    log.info("Scheduler started", {
      heartbeatMs: config.scheduler.heartbeatIntervalMs,
      cronJobs: this.cronJobs.length,
      callbacksEnabled: !!this.callbackCollection,
      eventsEnabled: !!this.eventsCollection,
      teamEnabled: config.team.enabled,
    });
// NEW:
    log.info("Scheduler started", {
      heartbeatMs: config.scheduler.heartbeatIntervalMs,
      cronJobs: this.cronJobs.length,
      callbacksEnabled: !!this.callbackCollection,
      eventsEnabled: !!this.eventsCollection,
    });
```

- [ ] **Step 6:** Typecheck. After Task 4 lands (index.ts fix), only `src/channels/ws/ws-adapter.ts` should still fail. After both Task 4 and Task 4b, the only remaining typecheck errors should be in `ws-adapter.ts` (fixed by Task 5).

Run: `npm run typecheck`
Expected (assuming Tasks 1 + 4 + 4b done, Task 5 pending): errors only in `src/channels/ws/ws-adapter.ts`.

---

## Task 5: Harden `WsAdapter` — required deps, strip `?.`, rewrite `handleCommand`

**Files:**
- Modify: `src/channels/ws/ws-adapter.ts`

- [ ] **Step 1:** Make `teamStore` and `commandRegistry` required in `WsAdapterDeps` and on the class.

Replace lines 42–70 with:

```ts
export interface WsAdapterDeps {
  teamStore: TeamStore;
  commandRegistry: CommandRegistry;
  agentRegistry: AgentRegistry;
  agentManager: AgentManager;
}

export class WsAdapter implements ChannelAdapter {
  readonly id = "ws";
  readonly kind: ChannelKind = "app";

  private port: number;
  private server!: Server;
  private wss!: WebSocketServer;
  private connections = new Map<string, WebSocket>(); // deviceId -> ws
  private pendingMessages = new Map<string, ServerMessage[]>(); // deviceId -> queued messages
  private onWorkItem!: (item: WorkItem) => void;
  private teamStore: TeamStore;
  private commandRegistry: CommandRegistry;
  private agentRegistry: AgentRegistry;
  private agentManager: AgentManager;

  constructor(port: number, deps: WsAdapterDeps) {
    this.port = port;
    this.teamStore = deps.teamStore;
    this.commandRegistry = deps.commandRegistry;
    this.agentRegistry = deps.agentRegistry;
    this.agentManager = deps.agentManager;
  }
```

- [ ] **Step 2:** Strip optional-chaining on `teamStore` at line 408 (`verifyChannelMembership`).

```ts
// OLD:
    const channel = await this.teamStore?.getChannel(channelId);
// NEW:
    const channel = await this.teamStore.getChannel(channelId);
```

- [ ] **Step 3:** Strip `if (this.teamStore)` guards in `handleTeamMessage` / `handleTeamImage` / `handleTeamFile`.

Lines 454, 504, 572 — remove the `if (this.teamStore) { ... }` wrapper, keep the inner `await this.teamStore.saveMessage({...});` call unconditional. Example for `handleTeamMessage`:

```ts
// OLD:
    // Save to team_messages
    if (this.teamStore) {
      await this.teamStore.saveMessage({
        channelId: msg.channelId,
        ...
      });
    }
// NEW:
    // Save to team_messages
    await this.teamStore.saveMessage({
      channelId: msg.channelId,
      ...
    });
```

Apply the same unwrap to `handleTeamImage` (line 504) and `handleTeamFile` (line 572).

- [ ] **Step 4:** Rewrite `handleCommand` (lines 626–678).

Replace the entire method body with:

```ts
  private async handleCommand(ws: WebSocket, msg: ClientCommand, device: Device, deviceId: string): Promise<void> {
    this.send(ws, { type: "ack", id: msg.id });

    // Unknown command → explicit error, no fallthrough to handleTeamMessage
    // (KPR-11: fallthrough previously produced the misleading "Channel not found").
    if (!this.commandRegistry.has(msg.name)) {
      this.send(ws, { type: "error", message: `Unknown command: /${msg.name}` });
      return;
    }

    const { result } = await this.commandRegistry.execute(msg.name, {
      channelId: msg.channelId,
      senderId: deviceId,
      senderName: device.name,
      args: msg.args,
    });

    // Save command + result as a message
    if (result) {
      await this.teamStore.saveMessage({
        channelId: msg.channelId,
        senderId: "system",
        senderType: "agent",
        senderName: "system",
        text: result,
        command: { name: msg.name, args: msg.args, result },
        createdAt: new Date(),
      });
    }

    // Send result back as a regular message
    this.send(ws, {
      type: "message",
      text: result ?? "Done.",
      agentId: "system",
      agentName: "system",
      replyTo: msg.id,
    });
  }
```

Note: `device` stays a parameter — `device.name` is still consumed as `senderName` on the `execute()` call. Signature matches sibling handlers.

- [ ] **Step 5:** Strip optional-chaining in `handleCommandList` (line 681).

```ts
// OLD:
    const commands = this.commandRegistry?.list() ?? [];
// NEW:
    const commands = this.commandRegistry.list();
```

- [ ] **Step 6:** Strip optional-chaining in `handleChannelList` (line 694).

```ts
// OLD:
    const channels = (await this.teamStore?.listChannels(deviceId)) ?? [];
// NEW:
    const channels = await this.teamStore.listChannels(deviceId);
```

- [ ] **Step 7:** Remove the redundant `if (!this.teamStore)` guard in `handleHistory` (line 708).

```ts
// OLD:
  private async handleHistory(ws: WebSocket, msg: ClientHistory, deviceId: string): Promise<void> {
    if (!this.teamStore) {
      this.send(ws, { type: "error", message: "Team store not available" });
      return;
    }

    if (!(await this.verifyChannelMembership(ws, msg.channelId, deviceId))) return;
// NEW:
  private async handleHistory(ws: WebSocket, msg: ClientHistory, deviceId: string): Promise<void> {
    if (!(await this.verifyChannelMembership(ws, msg.channelId, deviceId))) return;
```

- [ ] **Step 8:** Strip optional-chaining on `teamStore` in `handleJoin` (line 740) and `handleLeave` (line 762).

```ts
// handleJoin (line 740):
// OLD:
      const channel = await this.teamStore?.getChannel(msg.channelId);
// NEW:
      const channel = await this.teamStore.getChannel(msg.channelId);

// handleJoin (line 747):
// OLD:
    const ok = await this.teamStore?.joinChannel(msg.channelId, deviceId);
// NEW:
    const ok = await this.teamStore.joinChannel(msg.channelId, deviceId);

// handleLeave (line 762):
// OLD:
    const ok = await this.teamStore?.leaveChannel(msg.channelId, deviceId);
// NEW:
    const ok = await this.teamStore.leaveChannel(msg.channelId, deviceId);
```

- [ ] **Step 9:** Final sweep. Confirm no `?.`/null guards on `teamStore` or `commandRegistry` remain anywhere in the file.

Run: (Grep tool) `pattern: "teamStore\\?|commandRegistry\\?|if \\(this\\.teamStore|if \\(!this\\.teamStore|if \\(this\\.commandRegistry|if \\(!this\\.commandRegistry"` `path: src/channels/ws/ws-adapter.ts`
Expected: Zero matches.

- [ ] **Step 10:** Typecheck.

Run: `npm run typecheck`
Expected: Clean (zero errors).

---

## Task 6: Full check + commit

- [ ] **Step 1:** Run full check.

Run: `npm run check`
Expected: Clean — typecheck, lint, format, and tests all pass.

- [ ] **Step 2:** Commit.

```bash
git add src/config.ts src/index.ts src/team/command-registry.ts src/team/command-registry.test.ts src/channels/ws/ws-adapter.ts docs/specs/2026-04-13-team-ga-hardening-design.md docs/plans/2026-04-13-team-ga-hardening.md
git commit -m "$(cat <<'EOF'
feat(team): GA hardening — remove team.enabled, /dm command, agent validation (KPR-11)

- Drop dead team.enabled feature gate from config + env
- Rename /new → /dm; validate agent by id or display name (case-insensitive)
- CommandRegistry takes a narrow AgentResolver closure
- WsAdapter: teamStore + commandRegistry now required deps; strip all ?. guards
- handleCommand: explicit "Unknown command" error, no fallthrough, single ack
EOF
)"
```

- [ ] **Step 3:** Deploy-time cleanup (not part of this PR — tracked as a post-merge action).

After this lands and deploys, remove `TEAM_ENABLED=true` from `~/services/hive/.env` on the deploy machine. Listed in acceptance criteria; must be confirmed at submit time, not git-committed (file is deploy-dir only).

---

## Acceptance Verification

Before declaring complete, manually verify each acceptance criterion from the spec:

- [ ] `grep -r "team.enabled\|TEAM_ENABLED" src/` returns zero hits
- [ ] `grep -r "teamStore?\|commandRegistry?" src/channels/ws/` returns zero hits
- [ ] `npm run check` passes
- [ ] `src/team/command-registry.test.ts` has explicit tests for: valid id, valid name (case-insensitive), unknown agent, no args, `/new` not registered
- [ ] Deploy note captured in acceptance checklist for submit step
