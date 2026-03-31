# DB-Native Agents Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Move agent definitions from the template→generate→file pipeline to MongoDB documents, eliminating 4 override collections and the generated `agents/` directory.

**Architecture:** A single `agent_definitions` collection replaces `agents/` + `model_overrides` + `agent_config_overrides` + `prompt_overrides` + `schedule_overrides`. AgentRegistry reads from MongoDB instead of the filesystem. Admin MCP server gets full CRUD tools + REST API. Version history via `agent_definition_versions`.

**Tech Stack:** TypeScript, MongoDB (mongodb driver), MCP SDK, node:http for REST API

---

### Task 1: AgentDefinition type + toAgentConfig converter

**Files:**
- Create: `src/types/agent-definition.ts`
- Modify: `src/types/agent-config.ts` — remove `ConfigOverride`, `PromptOverride`, `ArrayOverride`

- [ ] **Step 1:** Create `src/types/agent-definition.ts` with the `AgentDefinition` and `AgentDefinitionVersion` interfaces

```typescript
import type { AgentSchedule } from "./agent-config.js";

export interface AgentDefinition {
  _id: string;                    // "rae", "jasper" — immutable after creation
  name: string;
  icon: string;

  // LLM
  model: string;
  triageModel?: string;

  // Routing
  channels: string[];
  passiveChannels: string[];
  keywords: string[];
  isDefault: boolean;

  // Capabilities
  coreServers: string[];
  delegateServers: string[];
  delegatePrompts: Record<string, string>;
  plugins?: string[];
  dodiOpsMode?: "full" | "readonly";

  // Identity
  soul: string;
  systemPrompt: string;

  // Scheduling
  schedule: AgentSchedule[];
  subscribe?: string[];

  // Limits
  budgetUsd: number;
  maxTurns: number;
  maxConcurrent: number;
  timeoutMs: number;

  // Lifecycle
  disabled: boolean;
  slackBot?: string;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

export interface AgentDefinitionVersion {
  agentId: string;
  snapshot: AgentDefinition;
  changedFields: string[];
  createdAt: Date;
}

/** Defaults applied by toAgentConfig when fields are absent */
export const AGENT_DEFINITION_DEFAULTS = {
  maxConcurrent: 3,
  timeoutMs: 300_000,
  budgetUsd: 10,
  maxTurns: 200,
  icon: "",
  keywords: [] as string[],
  passiveChannels: [] as string[],
  delegatePrompts: {} as Record<string, string>,
  schedule: [] as AgentSchedule[],
} as const;
```

- [ ] **Step 2:** Create `toAgentConfig` converter function in the same file

```typescript
import type { AgentConfig } from "./agent-config.js";

export function toAgentConfig(doc: AgentDefinition): AgentConfig {
  return {
    id: doc._id,
    name: doc.name,
    model: doc.model,
    channels: doc.channels ?? [],
    passiveChannels: doc.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
    keywords: doc.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
    isDefault: doc.isDefault ?? false,
    schedule: doc.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
    budgetUsd: doc.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
    maxTurns: doc.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
    icon: doc.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
    slackBot: doc.slackBot,
    coreServers: doc.coreServers ?? [],
    delegateServers: doc.delegateServers ?? [],
    plugins: doc.plugins,
    maxConcurrent: doc.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
    timeoutMs: doc.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
    triageModel: doc.triageModel,
    dodiOpsMode: doc.dodiOpsMode,
    disabled: doc.disabled ?? false,
    subscribe: doc.subscribe ?? [],
    delegatePrompts: doc.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
    soul: doc.soul ?? "",
    systemPrompt: doc.systemPrompt ?? "",
  };
}
```

- [ ] **Step 3:** Remove override types from `src/types/agent-config.ts`

Delete the `ArrayOverride`, `ConfigOverride`, and `PromptOverride` interfaces (lines 33-64). Keep `AgentConfig`, `AgentSchedule`, `AgentStatus`, `AgentState`, `IncomingMessage`, and re-exports unchanged.

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: Type errors in files that import the removed types (agent-registry.ts, admin-mcp-server.ts, agent-registry.test.ts) — these will be fixed in subsequent tasks.

- [ ] **Step 5:** Commit

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts
git commit -m "feat(types): add AgentDefinition type + toAgentConfig, remove override types"
```

---

### Task 2: Rewrite AgentRegistry to read from MongoDB

**Files:**
- Modify: `src/agents/agent-registry.ts` — full rewrite
- Modify: `src/agents/agent-registry.test.ts` — replace override tests with toAgentConfig tests
- Modify: `src/config.ts` — remove `config.agents` block, add top-level `defaultAgent`
- Modify: `src/index.ts:40-43` — new registry construction
- Modify: `src/index.ts:99` — `config.agents.defaultAgent` → `config.defaultAgent`
- Modify: `src/index.ts:178-183` — remove agents/ file watcher, add change stream/polling
- Modify: `src/agents/agent-runner.ts:430` — `config.agents.defaultAgent` → `config.defaultAgent`

- [ ] **Step 1:** Update `src/config.ts` — remove `config.agents`, add `defaultAgent` at top level

Replace lines 103-107:
```typescript
  agents: {
    defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff"),
    defaultModel: optional("DEFAULT_MODEL", "claude-sonnet-4-6"),
    definitionsPath: optional("AGENTS_PATH", "./agents"),
  },
```
With (add after `plugins` line 145, at the same nesting level as other top-level keys):
```typescript
  defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff"),
```

- [ ] **Step 2:** Rewrite `src/agents/agent-registry.ts`

Replace the entire file with a DB-backed implementation:

```typescript
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { toAgentConfig } from "../types/agent-definition.js";
import type { Collection, ChangeStream } from "mongodb";

const log = createLogger("agent-registry");

const POLL_INTERVAL_MS = 30_000;

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private agentDefs: Collection<AgentDefinition>;
  private changeStream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = new Date(0);
  private onReload?: () => void;

  constructor(agentDefs: Collection<AgentDefinition>, onReload?: () => void) {
    this.agentDefs = agentDefs;
    this.onReload = onReload;
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    const docs = await this.agentDefs.find().toArray();
    const previousIds = new Set(this.agents.keys());
    const currentIds = new Set<string>();
    const added: string[] = [];
    const updated: string[] = [];

    for (const doc of docs) {
      const config = toAgentConfig(doc);
      currentIds.add(config.id);

      if (previousIds.has(config.id)) {
        updated.push(config.id);
      } else {
        added.push(config.id);
      }

      this.agents.set(config.id, config);
      log.info("Loaded agent", { id: config.id, name: config.name });
    }

    // Remove agents that no longer exist in DB
    const removed: string[] = [];
    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        this.agents.delete(id);
        removed.push(id);
        log.info("Removed agent", { id });
      }
    }

    this.lastPollTime = new Date();
    return { added, updated, removed };
  }

  /** Start watching for changes via change stream (replica set) or polling fallback */
  async startWatching(): Promise<void> {
    try {
      this.changeStream = this.agentDefs.watch([], { fullDocument: "updateLookup" });
      this.changeStream.on("change", () => {
        log.info("Agent definition changed (change stream), triggering reload");
        this.onReload?.();
      });
      this.changeStream.on("error", (err) => {
        log.warn("Change stream error, falling back to polling", { error: String(err) });
        this.changeStream = null;
        this.startPolling();
      });
      log.info("Agent registry watching via change stream");
    } catch {
      log.info("Change stream not available, using polling fallback");
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const changed = await this.agentDefs.countDocuments({
          updatedAt: { $gt: this.lastPollTime },
        });
        if (changed > 0) {
          log.info("Agent definitions changed (poll), triggering reload", { changed });
          this.onReload?.();
        }
      } catch (err) {
        log.error("Poll check failed", { error: String(err) });
      }
    }, POLL_INTERVAL_MS);
    log.info("Agent registry watching via polling", { intervalMs: POLL_INTERVAL_MS });
  }

  stopWatching(): void {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /** Get all agents including disabled (for admin reporting) */
  async getAllDefinitions(): Promise<AgentDefinition[]> {
    return this.agentDefs.find().toArray();
  }

  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  findByChannel(channelName: string): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.channels.includes(channelName));
  }

  isPassiveChannel(channelName: string): boolean {
    return this.getAll().some((a) => !a.disabled && a.passiveChannels.includes(channelName));
  }

  findByKeyword(text: string): AgentConfig | undefined {
    const lower = text.toLowerCase();
    return this.getAll().find((a) =>
      !a.disabled &&
      a.keywords.some((kw) => {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(lower);
      }),
    );
  }

  findByName(text: string): AgentConfig | undefined {
    return this.findAllByName(text)[0];
  }

  findAllByName(text: string): AgentConfig[] {
    return this.getAll().filter((a) => {
      if (a.disabled) return false;
      const name = a.name.toLowerCase();
      const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
      return pattern.test(text);
    });
  }

  getDefault(): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.isDefault);
  }

  getDisabled(): AgentConfig[] {
    return this.getAll().filter((a) => a.disabled);
  }

  getSubscriberMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const agent of this.getAll()) {
      if (agent.disabled) continue;
      for (const sub of agent.subscribe ?? []) {
        const domain = sub.includes(":") ? sub.split(":")[0] : sub;
        if (!map[domain]) map[domain] = [];
        if (!map[domain].includes(agent.id)) {
          map[domain].push(agent.id);
        }
      }
    }
    return map;
  }
}
```

- [ ] **Step 3:** Update `src/index.ts` — registry construction and hot reload

Replace lines 1 (remove `watch` from import):
```typescript
import { existsSync } from "node:fs";
```

Replace lines 39-43 (registry construction) — note: `MongoClient` must be created here. Add import at top:
```typescript
import { MongoClient } from "mongodb";
```

Replace the registry construction block (lines 39-43) with:
```typescript
  // Shared MongoDB client
  const mongoClient = new MongoClient(config.mongo.uri);
  await mongoClient.connect();
  const db = mongoClient.db(config.mongo.dbName);

  // Load agent definitions from MongoDB
  const agentDefsCollection = db.collection("agent_definitions");
  await agentDefsCollection.createIndex({ channels: 1 });
  await agentDefsCollection.createIndex({ disabled: 1 });
```

Then replace the `const registry = ...` through `log.info("Agent registry loaded"...)` with:
```typescript
  // reload closure — defined before registry so it can be passed as onReload callback
  let registry: AgentRegistry;
  let scheduler: Scheduler;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const reload = async () => {
    log.info("Hot-reloading agent registry...");
    const result = await registry.load();

    if (result.added.length) log.info("New agents online", { agents: result.added });
    if (result.updated.length) log.info("Agents updated", { agents: result.updated });
    if (result.removed.length) {
      log.info("Agents removed", { agents: result.removed });
      for (const id of result.removed) {
        agentManager.stopAgent(id);
      }
    }

    const disabled = registry.getDisabled();
    for (const agent of disabled) {
      agentManager.stopAgent(agent.id);
    }
    if (disabled.length) {
      log.info("Disabled agents stopped", { agents: disabled.map((a) => a.id) });
    }

    await scheduler.reloadSchedules();
    agentManager.reloadSkills();
  };

  registry = new AgentRegistry(agentDefsCollection, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(), 500);
  });
  await registry.load();
  log.info("Agent registry loaded", { agents: registry.listIds() });
```

**Note:** This creates a forward reference problem — `agentManager` and `scheduler` are used in `reload` but declared later. We need to hoist the variable declarations. The cleanest approach: declare `let agentManager: AgentManager;` and `let scheduler: Scheduler;` early, assign them later. The existing `reload` closure in the original code has the same pattern — it references `scheduler` which is declared 100 lines later. Check how the original handles this (line 174 references `scheduler` from line 278). The existing code relies on closure + the fact that `reload` is only called after everything is initialized. We can use the same pattern.

Actually, looking at the original code more carefully: `reload` is defined at line 151 and `scheduler` at line 278 — the closure captures the variable, which is assigned by the time `reload` is ever called. Same pattern works here.

Restructured approach for index.ts:
1. Create MongoDB client + collection (early)
2. Declare `let registry: AgentRegistry`, `let agentManager: AgentManager`, `let scheduler: Scheduler` as `let` (not `const`) — these are assigned later but captured by the reload closure
3. Define `reload` closure  
4. Construct registry with onReload callback, call `registry.load()`
5. Change `const agentManager = new AgentManager(...)` to `agentManager = new AgentManager(...)` (assignment, not declaration)
6. Change `const scheduler = new Scheduler(...)` to `scheduler = new Scheduler(...)` (assignment, not declaration)
7. Remove the entire old block from line 148 through line 197 (reloadTimer, reload closure, agents/ watcher, skills/ watcher, SIGUSR1 handler) — these are all replaced by the new structure above
8. Re-add the skills/ watcher and SIGUSR1 handler after the scheduler, calling the new `reload()`
9. After scheduler is constructed, call `await registry.startWatching()`

Replace line 99 (`config.agents.defaultAgent`):
```typescript
    config.defaultAgent,
```

Remove the old reload closure (lines 149-183) and the old `reloadTimer` declaration.

Keep the skills/ watcher unchanged (lines 185-193), but change it to call `reload()` directly.

Keep `process.on("SIGUSR1", () => reload())` unchanged.

Add after scheduler starts (after line 285):
```typescript
  await registry.startWatching();
```

Add to shutdown (before `process.exit(0)`):
```typescript
    registry.stopWatching();
    await mongoClient.close();
```

- [ ] **Step 4:** Update `src/agents/agent-runner.ts:430` — fix defaultAgent reference

Replace:
```typescript
        DEFAULT_AGENT: config.agents.defaultAgent,
```
With:
```typescript
        DEFAULT_AGENT: config.defaultAgent,
```

- [ ] **Step 5:** Update `src/agents/agent-runner.ts:502` — remove AGENT_SCHEDULE_DEFAULTS env var

Replace the schedule server block (lines 496-506):
```typescript
    servers["schedule"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/schedule/schedule-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
      },
    };
```

- [ ] **Step 6:** Rewrite `src/agents/agent-registry.test.ts`

Replace all override tests with `toAgentConfig` tests:

```typescript
import { describe, it, expect } from "vitest";
import { toAgentConfig, AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";
import type { AgentDefinition } from "../types/agent-definition.js";

function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    _id: "test-agent",
    name: "TestAgent",
    model: "claude-haiku-4-5",
    icon: "",
    channels: ["agent-test"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    coreServers: [],
    delegateServers: [],
    delegatePrompts: {},
    soul: "",
    systemPrompt: "",
    schedule: [],
    budgetUsd: 10,
    maxTurns: 200,
    maxConcurrent: 3,
    timeoutMs: 300_000,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: "test",
    ...overrides,
  };
}

describe("toAgentConfig", () => {
  it("maps all fields from definition to config", () => {
    const def = makeDefinition({
      _id: "rae",
      name: "Rae",
      model: "claude-haiku-4-5",
      channels: ["general"],
      coreServers: ["memory", "slack"],
      soul: "I am Rae.",
      systemPrompt: "You are a receptionist.",
    });
    const config = toAgentConfig(def);
    expect(config.id).toBe("rae");
    expect(config.name).toBe("Rae");
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.channels).toEqual(["general"]);
    expect(config.coreServers).toEqual(["memory", "slack"]);
    expect(config.soul).toBe("I am Rae.");
    expect(config.systemPrompt).toBe("You are a receptionist.");
  });

  it("applies defaults for missing optional fields", () => {
    const def = makeDefinition();
    // Unset optional fields to simulate sparse DB doc
    delete (def as any).maxConcurrent;
    delete (def as any).timeoutMs;
    delete (def as any).budgetUsd;
    delete (def as any).maxTurns;
    delete (def as any).icon;
    delete (def as any).keywords;
    delete (def as any).passiveChannels;
    delete (def as any).delegatePrompts;
    delete (def as any).schedule;

    const config = toAgentConfig(def);
    expect(config.maxConcurrent).toBe(AGENT_DEFINITION_DEFAULTS.maxConcurrent);
    expect(config.timeoutMs).toBe(AGENT_DEFINITION_DEFAULTS.timeoutMs);
    expect(config.budgetUsd).toBe(AGENT_DEFINITION_DEFAULTS.budgetUsd);
    expect(config.maxTurns).toBe(AGENT_DEFINITION_DEFAULTS.maxTurns);
    expect(config.icon).toBe(AGENT_DEFINITION_DEFAULTS.icon);
    expect(config.keywords).toEqual(AGENT_DEFINITION_DEFAULTS.keywords);
    expect(config.passiveChannels).toEqual(AGENT_DEFINITION_DEFAULTS.passiveChannels);
    expect(config.delegatePrompts).toEqual(AGENT_DEFINITION_DEFAULTS.delegatePrompts);
    expect(config.schedule).toEqual(AGENT_DEFINITION_DEFAULTS.schedule);
  });

  it("preserves delegatePrompts when present", () => {
    const def = makeDefinition({
      delegatePrompts: { google: "Search Google.", clickup: "Manage tasks." },
    });
    const config = toAgentConfig(def);
    expect(config.delegatePrompts).toEqual({ google: "Search Google.", clickup: "Manage tasks." });
  });

  it("preserves optional fields when present", () => {
    const def = makeDefinition({
      triageModel: "claude-haiku-4-5",
      dodiOpsMode: "readonly",
      slackBot: "jasper",
      plugins: ["dodi-dev"],
      subscribe: ["deals", "jobs"],
    });
    const config = toAgentConfig(def);
    expect(config.triageModel).toBe("claude-haiku-4-5");
    expect(config.dodiOpsMode).toBe("readonly");
    expect(config.slackBot).toBe("jasper");
    expect(config.plugins).toEqual(["dodi-dev"]);
    expect(config.subscribe).toEqual(["deals", "jobs"]);
  });
});

describe("name matching patterns", () => {
  function matchesName(text: string, agentName: string): boolean {
    const name = agentName.toLowerCase();
    const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
    return pattern.test(text);
  }

  it("matches 'hey River'", () => {
    expect(matchesName("hey River, can you help?", "River")).toBe(true);
  });

  it("matches '@Jasper'", () => {
    expect(matchesName("@Jasper please review", "Jasper")).toBe(true);
  });

  it("matches 'Jasper,' with comma", () => {
    expect(matchesName("Jasper, what do you think?", "Jasper")).toBe(true);
  });

  it("matches 'Jasper:' with colon", () => {
    expect(matchesName("Jasper: handle this", "Jasper")).toBe(true);
  });

  it("matches name at start of text", () => {
    expect(matchesName("River should do this", "River")).toBe(true);
  });

  it("does not match partial name within word", () => {
    expect(matchesName("Contact Jasperson about this", "Jasper")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(matchesName("hey RIVER", "River")).toBe(true);
  });
});

describe("keyword matching", () => {
  function matchesKeyword(text: string, keyword: string): boolean {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(text.toLowerCase());
  }

  it("matches exact keyword", () => {
    expect(matchesKeyword("I need a permit quote", "permit")).toBe(true);
  });

  it("does not match partial keyword", () => {
    expect(matchesKeyword("permitted entry", "permit")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(matchesKeyword("PERMIT needed", "permit")).toBe(true);
  });
});
```

- [ ] **Step 7:** Fix any other references to `config.agents`

Search codebase for `config.agents` — update all references. Known locations:
- `src/agents/agent-runner.test.ts` — mock config object, remove `.agents` block, add `.defaultAgent`

- [ ] **Step 8:** Verify

Run: `npm run typecheck`
Expected: Clean pass (all references updated)

Run: `npm run test`
Expected: Registry tests pass, runner tests pass

- [ ] **Step 9:** Commit

```bash
git add src/agents/agent-registry.ts src/agents/agent-registry.test.ts src/config.ts src/index.ts src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "feat(registry): rewrite AgentRegistry to read from MongoDB

Replaces filesystem-based agent loading with direct MongoDB reads.
Removes 4 override collections (model_overrides, agent_config_overrides,
prompt_overrides, schedule_overrides). Adds change stream hot-reload
with polling fallback."
```

---

### Task 3: Rewrite Schedule MCP server + Scheduler

**Files:**
- Modify: `src/schedule/schedule-mcp-server.ts` — read/write `agent_definitions.schedule` directly
- Modify: `src/scheduler/scheduler.ts` — remove `loadScheduleOverrides()`, `schedule_overrides` collection
- Modify: `src/schedule/schedule-mcp-server.test.ts` — update test mocks

- [ ] **Step 1:** Rewrite `src/schedule/schedule-mcp-server.ts`

Key changes:
- Remove `AGENT_SCHEDULE_DEFAULTS` env var parsing (lines 25-31)
- Replace `scheduleOverrides` collection with `agentDefs` collection (`agent_definitions`)
- `my_schedules`: read from `agentDefs.findOne({ _id: AGENT_ID })`, show `doc.schedule`
- `my_schedule_add`: read current schedule from `agentDefs`, append, write back via `$set: { schedule, updatedAt, updatedBy }`
- `my_schedule_remove`: read, filter, write back
- `my_schedule_update`: read, find by task name, update cron, write back
- Remove the two-layer defaults/override merge pattern entirely
- Keep `validateMinInterval()` unchanged

Replace the collection setup (lines 33-36):
```typescript
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const agentDefs = db.collection("agent_definitions");
```

Replace `my_schedules` handler — read from `agentDefs`:
```typescript
  async () => {
    const doc = await agentDefs.findOne({ _id: AGENT_ID }) as any;
    const schedule: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

    const lines: string[] = [];
    lines.push(`## Schedules for ${AGENT_ID}\n`);

    if (schedule.length === 0) {
      lines.push("No scheduled tasks configured.");
    } else {
      lines.push("### Active Schedules:");
      for (const s of schedule) {
        lines.push(`  ${s.cron} → ${s.task}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
```

Replace `my_schedule_add` handler — read/write `agent_definitions`:
```typescript
  async ({ cron, task, reason }) => {
    const intervalError = validateMinInterval(cron);
    if (intervalError) {
      return { content: [{ type: "text", text: intervalError }], isError: true };
    }

    const doc = await agentDefs.findOne({ _id: AGENT_ID }) as any;
    const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

    if (current.length >= MAX_SCHEDULES) {
      return {
        content: [{ type: "text", text: `Maximum ${MAX_SCHEDULES} schedules reached. Remove one first.` }],
        isError: true,
      };
    }

    if (current.some((s) => s.task === task)) {
      return {
        content: [{ type: "text", text: `Schedule for task '${task}' already exists. Use my_schedule_update to change it.` }],
        isError: true,
      };
    }

    const newSchedule = [...current, { cron, task }];

    await agentDefs.updateOne(
      { _id: AGENT_ID },
      { $set: { schedule: newSchedule, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    try { process.kill(process.ppid, "SIGUSR1"); } catch {}

    return {
      content: [{ type: "text", text: `Added schedule: ${cron} → ${task}\nReason: ${reason}\nHot-reload triggered.` }],
    };
  },
```

Apply the same pattern for `my_schedule_remove` and `my_schedule_update` — read `doc.schedule`, modify, write back to `agent_definitions`.

- [ ] **Step 2:** Update `src/scheduler/scheduler.ts`

Remove:
- `ScheduleOverride` interface (lines 19-25)
- `scheduleOverrides` collection member (line 75)
- `this.scheduleOverrides` assignment in `connectDb()` (line 110)
- `scheduleOverrides` index creation (line 120)
- `await this.loadScheduleOverrides()` call in `connectDb()` (line 122)
- `loadScheduleOverrides()` method entirely (lines 144-169)
- `await this.loadScheduleOverrides()` call in `reloadSchedules()` (line 141)

The `reloadSchedules()` method becomes simply:
```typescript
  async reloadSchedules(): Promise<void> {
    this.cronJobs = [];
    for (const agent of this.registry.getAll()) {
      for (const schedule of agent.schedule) {
        this.cronJobs.push({
          agentId: agent.id,
          cron: schedule.cron,
          task: schedule.task,
          lastRun: null,
        });
      }
    }
    log.info("Schedules reloaded", { jobs: this.cronJobs.length });
  }
```

- [ ] **Step 3:** Update `src/schedule/schedule-mcp-server.test.ts`

Update test mocks to use `agent_definitions` collection instead of `schedule_overrides`. The `AGENT_SCHEDULE_DEFAULTS` env var is no longer set.

- [ ] **Step 4:** Verify

Run: `npm run typecheck && npm run test`
Expected: Clean pass

- [ ] **Step 5:** Commit

```bash
git add src/schedule/schedule-mcp-server.ts src/scheduler/scheduler.ts src/schedule/schedule-mcp-server.test.ts
git commit -m "feat(schedule): rewrite to read/write agent_definitions directly

Removes schedule_overrides collection and two-layer merge pattern.
Schedule MCP server reads/writes agent_definitions.schedule field.
Scheduler reads from registry only — no separate override loading."
```

---

### Task 4: Rewrite Admin MCP server with CRUD tools + version history

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` — full rewrite

- [ ] **Step 1:** Rewrite `src/admin/admin-mcp-server.ts`

Remove all existing tools (model_list/set/reset, schedule_list/disable/set/reset, config_list/get/set/reset/add/remove, prompt_get/set/reset, agent_disable/enable).

Replace with new tools that operate on `agent_definitions` + `agent_definition_versions`:

```typescript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const AGENT_ID = process.env.AGENT_ID ?? "admin";

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const agentDefs = db.collection<AgentDefinition>("agent_definitions");
const agentVersions = db.collection<AgentDefinitionVersion>("agent_definition_versions");

const server = new McpServer({ name: "hive-admin", version: "0.2.0" });

/** Save a version snapshot before mutation */
async function saveVersion(agentId: string, changedFields: string[]): Promise<void> {
  const current = await agentDefs.findOne({ _id: agentId as any });
  if (!current) return;
  await agentVersions.insertOne({
    agentId,
    snapshot: current as unknown as AgentDefinition,
    changedFields,
    createdAt: new Date(),
  });
}

function triggerReload(): void {
  try { process.kill(process.ppid, "SIGUSR1"); } catch {}
}
```

Then register the CRUD tools:

**agent_list**: Query all agent definitions, return summary table.

**agent_get**: Find one by `_id`, return full document formatted.

**agent_create**: Insert new agent definition with required fields `_id`, `name`, `model`. Apply defaults for everything else. No version saved (it's new).

**agent_update**: Accept `agent_id` + `fields` (JSON object of fields to update). Save version before mutation. Apply `$set` with the provided fields + `updatedAt` + `updatedBy`. Trigger reload.

**agent_delete**: Accept `agent_id` + `confirm` boolean. Save version before deletion. Delete document. Trigger reload.

**agent_enable / agent_disable**: Convenience tools that set `disabled` field. Save version.

**agent_history**: Accept `agent_id`, optional `limit` (default 10). Query `agent_definition_versions` sorted by `createdAt: -1`.

**agent_rollback**: Accept `agent_id` + `version_index` (0 = most recent version). Read the version snapshot, replace current document with it, save version of current state first.

Each tool should call `triggerReload()` after mutations.

Input schemas use zod. Example for `agent_update`:
```typescript
server.registerTool(
  "agent_update",
  {
    title: "Update Agent",
    description: "Update fields on an agent definition. Pass a JSON object of fields to update.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      fields: z.record(z.any()).describe("Fields to update (e.g. { model: 'claude-sonnet-4-6', channels: ['general'] })"),
    },
  },
  async ({ agent_id, fields }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return { content: [{ type: "text", text: `Agent '${agent_id}' not found.` }], isError: true };
    }

    const changedFields = Object.keys(fields);
    await saveVersion(agent_id, changedFields);

    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { ...fields, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    triggerReload();

    return {
      content: [{ type: "text", text: `Updated ${agent_id}: ${changedFields.join(", ")}. Hot-reload triggered.` }],
    };
  },
);
```

- [ ] **Step 2:** Create indexes for versions collection

Add to the top of the server (after DB connection):
```typescript
await agentVersions.createIndex({ agentId: 1, createdAt: -1 });
```

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 4:** Commit

```bash
git add src/admin/admin-mcp-server.ts
git commit -m "feat(admin): rewrite MCP server with agent CRUD + version history

Replaces override-based tools with direct agent_definitions CRUD.
Adds agent_create/get/update/delete/list/history/rollback tools.
Every mutation saves previous state to agent_definition_versions."
```

---

### Task 5: Admin REST API

**Files:**
- Create: `src/admin/admin-api.ts` — HTTP server for agent CRUD
- Modify: `src/index.ts` — wire up admin API server
- Modify: `src/config.ts` — add `adminApi` config section

- [ ] **Step 1:** Add config for admin API in `src/config.ts`

Add after the `codeTask` block:
```typescript
  adminApi: {
    port: parseInt(optional("ADMIN_API_PORT", String(ports.adminApi ?? portBase + 4)), 10),
    token: optional("ADMIN_API_TOKEN", ""),
  },
```

- [ ] **Step 2:** Create `src/admin/admin-api.ts`

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "../logging/logger.js";
import type { Collection } from "mongodb";
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";

const log = createLogger("admin-api");

export class AdminApi {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private token: string;
  private agentDefs: Collection<AgentDefinition>;
  private agentVersions: Collection<AgentDefinitionVersion>;
  private onReload: () => void;

  constructor(
    port: number,
    token: string,
    agentDefs: Collection<AgentDefinition>,
    agentVersions: Collection<AgentDefinitionVersion>,
    onReload: () => void,
  ) {
    this.port = port;
    this.token = token;
    this.agentDefs = agentDefs;
    this.agentVersions = agentVersions;
    this.onReload = onReload;
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        log.info("Admin API started", { port: this.port });
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth check
    if (this.token) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${this.token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // Route matching
      if (path === "/admin/agents" && method === "GET") {
        return await this.listAgents(res);
      }
      if (path === "/admin/agents" && method === "POST") {
        return await this.createAgent(req, res);
      }

      const agentMatch = path.match(/^\/admin\/agents\/([^/]+)$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        if (method === "GET") return await this.getAgent(id, res);
        if (method === "PATCH") return await this.updateAgent(id, req, res);
        if (method === "DELETE") return await this.deleteAgent(id, res);
      }

      const enableMatch = path.match(/^\/admin\/agents\/([^/]+)\/(enable|disable)$/);
      if (enableMatch && method === "POST") {
        const id = decodeURIComponent(enableMatch[1]);
        const action = enableMatch[2] as "enable" | "disable";
        return await this.toggleAgent(id, action, res);
      }

      const historyMatch = path.match(/^\/admin\/agents\/([^/]+)\/history$/);
      if (historyMatch && method === "GET") {
        const id = decodeURIComponent(historyMatch[1]);
        const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
        return await this.agentHistory(id, limit, res);
      }

      const rollbackMatch = path.match(/^\/admin\/agents\/([^/]+)\/rollback$/);
      if (rollbackMatch && method === "POST") {
        const id = decodeURIComponent(rollbackMatch[1]);
        return await this.rollbackAgent(id, req, res);
      }

      // Server registry
      if (path === "/admin/servers" && method === "GET") {
        return await this.listServers(res);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      log.error("Admin API error", { error: String(err), path, method });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, data: any): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async saveVersion(agentId: string, changedFields: string[]): Promise<void> {
    const current = await this.agentDefs.findOne({ _id: agentId as any });
    if (!current) return;
    await this.agentVersions.insertOne({
      agentId,
      snapshot: current as unknown as AgentDefinition,
      changedFields,
      createdAt: new Date(),
    });
  }

  private async listAgents(res: ServerResponse): Promise<void> {
    const docs = await this.agentDefs.find().toArray();
    this.json(res, 200, docs);
  }

  private async getAgent(id: string, res: ServerResponse): Promise<void> {
    const doc = await this.agentDefs.findOne({ _id: id as any });
    if (!doc) return this.json(res, 404, { error: "Agent not found" });
    this.json(res, 200, doc);
  }

  private async createAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body._id || !body.name || !body.model) {
      return this.json(res, 400, { error: "Required: _id, name, model" });
    }

    const existing = await this.agentDefs.findOne({ _id: body._id as any });
    if (existing) return this.json(res, 409, { error: "Agent already exists" });

    const now = new Date();
    const doc: AgentDefinition = {
      _id: body._id,
      name: body.name,
      model: body.model,
      icon: body.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
      channels: body.channels ?? [],
      passiveChannels: body.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
      keywords: body.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
      isDefault: body.isDefault ?? false,
      coreServers: body.coreServers ?? [],
      delegateServers: body.delegateServers ?? [],
      delegatePrompts: body.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
      plugins: body.plugins,
      dodiOpsMode: body.dodiOpsMode,
      soul: body.soul ?? "",
      systemPrompt: body.systemPrompt ?? "",
      schedule: body.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
      subscribe: body.subscribe,
      budgetUsd: body.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
      maxTurns: body.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
      maxConcurrent: body.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
      timeoutMs: body.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
      disabled: body.disabled ?? false,
      slackBot: body.slackBot,
      createdAt: now,
      updatedAt: now,
      updatedBy: "admin-api",
    };

    await this.agentDefs.insertOne(doc as any);
    this.onReload();
    this.json(res, 201, doc);
  }

  private async updateAgent(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found" });

    // Don't allow changing _id
    delete body._id;

    const changedFields = Object.keys(body);
    await this.saveVersion(id, changedFields);

    await this.agentDefs.updateOne(
      { _id: id as any },
      { $set: { ...body, updatedAt: new Date(), updatedBy: "admin-api" } },
    );

    this.onReload();
    const updated = await this.agentDefs.findOne({ _id: id as any });
    this.json(res, 200, updated);
  }

  private async deleteAgent(id: string, res: ServerResponse): Promise<void> {
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found" });

    await this.saveVersion(id, ["_deleted"]);
    await this.agentDefs.deleteOne({ _id: id as any });
    this.onReload();
    this.json(res, 200, { deleted: id });
  }

  private async toggleAgent(id: string, action: "enable" | "disable", res: ServerResponse): Promise<void> {
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found" });

    await this.saveVersion(id, ["disabled"]);
    await this.agentDefs.updateOne(
      { _id: id as any },
      { $set: { disabled: action === "disable", updatedAt: new Date(), updatedBy: "admin-api" } },
    );

    this.onReload();
    this.json(res, 200, { [action + "d"]: id });
  }

  private async agentHistory(id: string, limit: number, res: ServerResponse): Promise<void> {
    const versions = await this.agentVersions
      .find({ agentId: id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    this.json(res, 200, versions);
  }

  private async rollbackAgent(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const versionIndex = body.version_index ?? 0;

    const versions = await this.agentVersions
      .find({ agentId: id })
      .sort({ createdAt: -1 })
      .skip(versionIndex)
      .limit(1)
      .toArray();

    if (versions.length === 0) {
      return this.json(res, 404, { error: "No version found at that index" });
    }

    // Save current state before rollback
    await this.saveVersion(id, ["_rollback"]);

    const snapshot = versions[0].snapshot;
    await this.agentDefs.replaceOne({ _id: id as any }, snapshot as any, { upsert: true });

    this.onReload();
    this.json(res, 200, snapshot);
  }

  private async listServers(res: ServerResponse): Promise<void> {
    // Static server registry — derived from codebase, not DB
    // This can be expanded later; for now return a useful list
    this.json(res, 200, { message: "Server registry — use agent_definitions.coreServers/delegateServers fields" });
  }
}
```

- [ ] **Step 3:** Wire up in `src/index.ts`

Add import:
```typescript
import { AdminApi } from "./admin/admin-api.js";
```

After scheduler starts, before sweeper:
```typescript
  // Admin REST API
  let adminApi: AdminApi | undefined;
  if (config.adminApi.token) {
    adminApi = new AdminApi(
      config.adminApi.port,
      config.adminApi.token,
      agentDefsCollection,
      db.collection("agent_definition_versions"),
      () => reload(),
    );
    await adminApi.start();
    log.info("Admin API started", { port: config.adminApi.port });
  }
```

Add to shutdown:
```typescript
    adminApi?.stop();
```

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 5:** Commit

```bash
git add src/admin/admin-api.ts src/config.ts src/index.ts
git commit -m "feat(admin): add REST API for agent CRUD

HTTP endpoints for external clients (beekeeper, CLI, web UI).
Bearer token auth via ADMIN_API_TOKEN. Full CRUD + history + rollback."
```

---

### Task 6: Migration script

**Files:**
- Create: `setup/migrate-agents.ts`
- Modify: `package.json` — add `migrate:agents` script

- [ ] **Step 1:** Create `setup/migrate-agents.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Migrate agent definitions from files + override collections to agent_definitions.
 *
 * For each agent directory in agents/:
 * 1. Read agent.yaml, soul.md, system-prompt.md
 * 2. Read existing overrides from model_overrides, agent_config_overrides, prompt_overrides, schedule_overrides
 * 3. Merge into a single AgentDefinition document (overrides win over file values)
 * 4. Upsert into agent_definitions
 *
 * Usage: npm run migrate:agents [--dry-run]
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import type { AgentDefinition } from "../src/types/agent-definition.js";

const ROOT = resolve(import.meta.dirname, "..");
const AGENTS_DIR = resolve(process.env.AGENTS_PATH ?? join(ROOT, "agents"));
const DRY_RUN = process.argv.includes("--dry-run");

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const mongoDb = process.env.MONGODB_DB || "hive";

async function main() {
  if (!existsSync(AGENTS_DIR)) {
    console.log(`No agents/ directory found at ${AGENTS_DIR} — nothing to migrate.`);
    return;
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);

  // Load existing overrides
  const modelOverrides = await db.collection("model_overrides").find().toArray();
  const configOverrides = await db.collection("agent_config_overrides").find().toArray();
  const promptOverrides = await db.collection("prompt_overrides").find().toArray();
  const scheduleOverrides = await db.collection("schedule_overrides").find().toArray();

  const modelMap = new Map(modelOverrides.map((d: any) => [d.agentId, d.model]));
  const configMap = new Map(configOverrides.map((d: any) => [d.agentId, d]));
  const promptMap = new Map(promptOverrides.map((d: any) => [d.agentId, d]));
  const scheduleMap = new Map(scheduleOverrides.map((d: any) => [d.agentId, d]));

  const agentDefs = db.collection("agent_definitions");
  const entries = readdirSync(AGENTS_DIR).filter((d) => statSync(join(AGENTS_DIR, d)).isDirectory());

  let migrated = 0;
  let skipped = 0;

  for (const dirName of entries) {
    const agentDir = join(AGENTS_DIR, dirName);
    const yamlPath = join(agentDir, "agent.yaml");

    if (!existsSync(yamlPath)) {
      console.log(`  SKIP ${dirName} — no agent.yaml`);
      skipped++;
      continue;
    }

    // Check if already migrated
    const existing = await agentDefs.findOne({ _id: dirName as any });
    if (existing) {
      console.log(`  SKIP ${dirName} — already exists in agent_definitions`);
      skipped++;
      continue;
    }

    // Read files
    const raw = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, any>;
    const soul = existsSync(join(agentDir, "soul.md"))
      ? readFileSync(join(agentDir, "soul.md"), "utf-8")
      : "";
    const systemPrompt = existsSync(join(agentDir, "system-prompt.md"))
      ? readFileSync(join(agentDir, "system-prompt.md"), "utf-8")
      : "";

    const agentId = (raw.id as string) || dirName;

    // Parse tiered servers
    const rawServers = raw.servers;
    let coreServers: string[];
    let delegateServers: string[];
    if (Array.isArray(rawServers)) {
      coreServers = rawServers;
      delegateServers = [];
    } else if (rawServers && typeof rawServers === "object") {
      const tiered = rawServers as { core?: string[]; delegate?: string[] };
      coreServers = tiered.core ?? [];
      delegateServers = tiered.delegate ?? [];
    } else {
      coreServers = [];
      delegateServers = [];
    }

    // Build base definition
    const now = new Date();
    const def: AgentDefinition = {
      _id: agentId,
      name: (raw.name as string) || dirName,
      model: modelMap.get(agentId) ?? (raw.model as string) || "claude-sonnet-4-6",
      icon: (raw.icon as string) || "",
      channels: (raw.channels as string[]) || [],
      passiveChannels: (raw.passiveChannels as string[]) || [],
      keywords: (raw.keywords as string[]) || [],
      isDefault: (raw.isDefault as boolean) || false,
      coreServers,
      delegateServers,
      delegatePrompts: (raw.delegatePrompts as Record<string, string>) || {},
      plugins: (raw.plugins as string[]) || undefined,
      dodiOpsMode: (raw.dodiOpsMode as "full" | "readonly") || undefined,
      soul,
      systemPrompt,
      schedule: (raw.schedule as any[]) || [],
      subscribe: (raw.subscribe as string[]) || [],
      budgetUsd: (raw.budgetUsd as number) || 10,
      maxTurns: (raw.maxTurns as number) || 200,
      maxConcurrent: (raw.maxConcurrent as number) || 3,
      timeoutMs: (raw.timeoutMs as number) || 300_000,
      disabled: (raw.disabled as boolean) || false,
      slackBot: (raw.slackBot as string) || undefined,
      createdAt: now,
      updatedAt: now,
      updatedBy: "migration",
    };

    // Apply config overrides (overrides win)
    const co = configMap.get(agentId) as any;
    if (co) {
      // Array fields: apply replace/add/remove
      for (const field of ["channels", "passiveChannels", "keywords", "coreServers", "delegateServers", "plugins", "subscribe"]) {
        const ov = co[field] ?? (field === "coreServers" ? co.servers : undefined);
        if (!ov) continue;
        if (ov.replace) {
          (def as any)[field] = [...ov.replace];
        } else {
          const base = [...((def as any)[field] ?? [])];
          const added = ov.add ? [...base, ...ov.add.filter((v: string) => !base.includes(v))] : base;
          const result = ov.remove ? added.filter((v: string) => !ov.remove.includes(v)) : added;
          (def as any)[field] = result;
        }
      }
      // Scalar fields
      if (co.isDefault !== undefined) def.isDefault = co.isDefault;
      if (co.budgetUsd !== undefined) def.budgetUsd = co.budgetUsd;
      if (co.maxTurns !== undefined) def.maxTurns = co.maxTurns;
      if (co.maxConcurrent !== undefined) def.maxConcurrent = co.maxConcurrent;
      if (co.timeoutMs !== undefined) def.timeoutMs = co.timeoutMs;
      if (co.disabled !== undefined) def.disabled = co.disabled;
    }

    // Apply prompt overrides
    const po = promptMap.get(agentId) as any;
    if (po) {
      if (po.soul !== undefined) def.soul = po.soul;
      if (po.systemPrompt !== undefined) def.systemPrompt = po.systemPrompt;
    }

    // Apply schedule overrides
    const so = scheduleMap.get(agentId) as any;
    if (so) {
      if (so.schedule === null) {
        def.schedule = [];
        def.disabled = def.disabled; // preserve disabled state, empty schedule = no jobs
      } else if (so.schedule) {
        def.schedule = so.schedule;
      }
    }

    if (DRY_RUN) {
      console.log(`  DRY-RUN ${agentId}: ${def.name} (${def.model})`);
      console.log(`    channels: [${def.channels.join(", ")}]`);
      console.log(`    coreServers: [${def.coreServers.join(", ")}]`);
      console.log(`    disabled: ${def.disabled}`);
      console.log(`    schedule: ${def.schedule.length} jobs`);
    } else {
      await agentDefs.insertOne(def as any);
      console.log(`  MIGRATE ${agentId}: ${def.name} (${def.model})`);
    }
    migrated++;
  }

  console.log(`\n${DRY_RUN ? "DRY-RUN: " : ""}${migrated} agents migrated, ${skipped} skipped`);

  // Create indexes
  if (!DRY_RUN) {
    await agentDefs.createIndex({ channels: 1 });
    await agentDefs.createIndex({ disabled: 1 });
    console.log("Indexes created on agent_definitions");
  }

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2:** Add script to `package.json`

Add to scripts:
```json
"migrate:agents": "npx tsx setup/migrate-agents.ts",
```

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 4:** Commit

```bash
git add setup/migrate-agents.ts package.json
git commit -m "feat(migration): add agent definition migration script

Reads agents/ + 4 override collections → single agent_definitions docs.
Supports --dry-run. Skips agents already in agent_definitions."
```

---

### Task 7: Setup commands + plugin seeds + constitution extraction

**Files:**
- Create: `setup/setup-constitution.ts` — constitution render → MongoDB
- Create: `setup/setup-seeds.ts` — import plugin agent seeds
- Modify: `setup/generate-agents.ts` — keep only plugin sync function
- Modify: `package.json` — update setup scripts
- Modify: `src/plugins/types.ts` — add `agentSeeds` to `PluginManifest`
- Modify: `src/plugins/plugin-loader.ts` — validate seeds dir instead of templates
- Modify: `src/plugins/plugin-loader.test.ts` — update `agentsTemplates` → `agentSeeds` references
- Modify: `src/agents/agent-runner.test.ts` — update `agentsTemplates` → `agentSeeds` in plugin mocks

- [ ] **Step 1:** Extract constitution rendering to `setup/setup-constitution.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Render constitution template → MongoDB.
 * Reads setup/templates/constitution-{personal|business}.md.tpl, renders with
 * hive.yaml context, upserts to memory collection.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import { render } from "./template-renderer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_CONFIG = resolve(process.env.HIVE_CONFIG ?? join(ROOT, "hive.yaml"));

function loadConfig(): Record<string, any> {
  if (!existsSync(HIVE_CONFIG)) {
    console.error("hive.yaml not found.");
    process.exit(1);
  }
  return parseYaml(readFileSync(HIVE_CONFIG, "utf-8")) ?? {};
}

async function main() {
  const config = loadConfig();
  const instanceType = (config.instance?.type as string) ?? "business";

  // Build team map from agents in hive.yaml (if any — may be empty after migration)
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const instanceId = (config.instance?.id as string) ?? "hive";
  const mongoDb = process.env.MONGODB_DB || `hive_${instanceId}`;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);

  // Build team map from agent_definitions in MongoDB (not hive.yaml — agents section removed after migration)
  const team: Record<string, string> = {};
  const agentDocs = await db.collection("agent_definitions").find({}, { projection: { _id: 1, name: 1 } }).toArray();
  for (const doc of agentDocs) {
    team[doc._id as string] = (doc as any).name ?? doc._id;
  }

  const constitutionFile =
    instanceType === "personal" ? "constitution-personal.md.tpl" : "constitution-business.md.tpl";
  const typedPath = join(ROOT, "setup", "templates", constitutionFile);
  const legacyPath = join(ROOT, "setup", "templates", "constitution.md.tpl");
  const constitutionTplPath = existsSync(typedPath) ? typedPath : legacyPath;

  if (!existsSync(constitutionTplPath)) {
    console.log("No constitution template found — skipping.");
    await client.close();
    return;
  }

  const constitutionTpl = readFileSync(constitutionTplPath, "utf-8");
  const content = render(constitutionTpl, { business: config.business ?? {}, team });

  const existing = await db.collection("memory").findOne({ path: "shared/constitution.md" });
  if (existing && existing.content !== content) {
    await db.collection("memory_versions").insertOne({
      path: "shared/constitution.md",
      content: existing.content,
      savedAt: existing.updatedAt,
      savedBy: existing.updatedBy || "system",
    });
    await db.collection("memory").updateOne(
      { path: "shared/constitution.md" },
      { $set: { content, updatedAt: new Date(), updatedBy: "setup:constitution" } },
    );
    console.log("  SYNC shared/constitution.md → MongoDB");
  } else if (!existing) {
    await db.collection("memory").insertOne({
      path: "shared/constitution.md",
      content,
      updatedAt: new Date(),
      updatedBy: "setup:constitution",
    });
    console.log("  SYNC shared/constitution.md → MongoDB (new)");
  } else {
    console.log("  SKIP shared/constitution.md — unchanged");
  }

  await client.close();
}

main().catch((err) => {
  console.error("Constitution setup failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2:** Create `setup/setup-seeds.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Import plugin agent seeds → agent_definitions (skip if exists).
 * Reads YAML seed files from plugins/<name>/agent-seeds/.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import type { AgentDefinition } from "../src/types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../src/types/agent-definition.js";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_CONFIG = resolve(process.env.HIVE_CONFIG ?? join(ROOT, "hive.yaml"));

async function main() {
  const config = existsSync(HIVE_CONFIG)
    ? parseYaml(readFileSync(HIVE_CONFIG, "utf-8")) ?? {}
    : {};

  const enabledPlugins: string[] = (config as any).plugins ?? [];
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const instanceId = ((config as any).instance?.id as string) ?? "hive";
  const mongoDb = process.env.MONGODB_DB || `hive_${instanceId}`;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);
  const agentDefs = db.collection("agent_definitions");

  let imported = 0;
  let skipped = 0;

  for (const pluginName of enabledPlugins) {
    const seedsDir = join(ROOT, "plugins", pluginName, "agent-seeds");
    if (!existsSync(seedsDir)) continue;

    const files = readdirSync(seedsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of files) {
      const raw = parseYaml(readFileSync(join(seedsDir, file), "utf-8")) as any;
      if (!raw?._id) {
        console.log(`  SKIP ${pluginName}/${file} — no _id field`);
        continue;
      }

      const existing = await agentDefs.findOne({ _id: raw._id });
      if (existing) {
        console.log(`  SKIP ${raw._id} — already exists`);
        skipped++;
        continue;
      }

      const now = new Date();
      const doc: AgentDefinition = {
        _id: raw._id,
        name: raw.name ?? raw._id,
        model: raw.model ?? "claude-sonnet-4-6",
        icon: raw.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
        channels: raw.channels ?? [],
        passiveChannels: raw.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
        keywords: raw.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
        isDefault: raw.isDefault ?? false,
        coreServers: raw.coreServers ?? [],
        delegateServers: raw.delegateServers ?? [],
        delegatePrompts: raw.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
        plugins: raw.plugins,
        dodiOpsMode: raw.dodiOpsMode,
        soul: raw.soul ?? "",
        systemPrompt: raw.systemPrompt ?? "",
        schedule: raw.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
        subscribe: raw.subscribe,
        budgetUsd: raw.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
        maxTurns: raw.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
        maxConcurrent: raw.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
        timeoutMs: raw.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
        disabled: raw.disabled ?? false,
        slackBot: raw.slackBot,
        createdAt: now,
        updatedAt: now,
        updatedBy: `setup:seed:${pluginName}`,
      };

      await agentDefs.insertOne(doc as any);
      console.log(`  SEED ${raw._id} from ${pluginName}/${file}`);
      imported++;
    }
  }

  console.log(`\n${imported} seeds imported, ${skipped} skipped`);
  await client.close();
}

main().catch((err) => {
  console.error("Seed import failed:", err);
  process.exit(1);
});
```

- [ ] **Step 3:** Reduce `setup/generate-agents.ts` to plugin sync only

Rename to `setup/setup-plugins.ts` (or keep the file and gut it). Remove:
- Template rendering logic (lines 154-333)
- Constitution rendering (lines 335-383)
- Meta file handling
- Agent template processing

Keep only `syncPlugins()` function (lines 70-151) and call it from a simple main:
```typescript
#!/usr/bin/env npx tsx
/**
 * Sync Claude Code plugins from cache → plugins/claude-code/
 */
// ... keep syncPlugins() as-is, just call it from main
async function main() {
  syncPlugins();
}
main();
```

- [ ] **Step 4:** Update `package.json` scripts

```json
"setup:agents": "npx tsx setup/migrate-agents.ts",
"setup:constitution": "npx tsx setup/setup-constitution.ts",
"setup:seeds": "npx tsx setup/setup-seeds.ts",
"setup:plugins": "npx tsx setup/setup-plugins.ts",
```

Keep `setup:agents` as an alias for `migrate:agents` for backward compat during transition.

- [ ] **Step 5:** Update `src/plugins/types.ts`

Change `agentsTemplates` to `agentSeeds`:
```typescript
export interface PluginManifest {
  name: string;
  description?: string;
  mcpServers: Record<string, PluginMcpServer>;
  agentSeeds: string[];
}
```

- [ ] **Step 6:** Update `src/plugins/plugin-loader.ts`

Change template validation to seed validation:
```typescript
    for (const seed of manifest.agentSeeds) {
      const seedPath = join(pluginDir, "agent-seeds", seed);
      if (!existsSync(seedPath)) {
        log.warn("Plugin agent seed not found", { plugin: name, seed, path: seedPath });
      }
    }
```

Update `normalizeManifest`:
```typescript
    agentSeeds: raw["agent-seeds"] ?? raw["agents-templates"] ?? [],
```

Update logging:
```typescript
    log.info("Plugin loaded", {
      plugin: name,
      mcpServers: Object.keys(manifest.mcpServers),
      seeds: manifest.agentSeeds,
    });
```

- [ ] **Step 7:** Update test files for `agentsTemplates` → `agentSeeds` rename

In `src/plugins/plugin-loader.test.ts`: replace all `agentsTemplates` references with `agentSeeds` and update test assertions to use `agent-seeds` directory instead of `agents-templates`.

In `src/agents/agent-runner.test.ts`: replace all `agentsTemplates: []` in plugin mock objects with `agentSeeds: []`.

- [ ] **Step 8:** Verify

Run: `npm run typecheck && npm run test`
Expected: Clean pass

- [ ] **Step 9:** Commit

```bash
git add setup/setup-constitution.ts setup/setup-seeds.ts setup/generate-agents.ts package.json src/plugins/types.ts src/plugins/plugin-loader.ts src/plugins/plugin-loader.test.ts src/agents/agent-runner.test.ts
git commit -m "feat(setup): extract constitution, add seed imports, reduce generate-agents

Constitution rendering extracted to standalone setup:constitution script.
Plugin agent seeds imported via setup:seeds (skip-if-exists).
generate-agents.ts reduced to plugin sync only.
Plugin manifest: agentsTemplates → agentSeeds."
```

---

### Task 8: Cleanup — remove dead code and old override collections

**Files:**
- Modify: `src/types/agent-config.ts` — verify override types are gone (done in Task 1)
- Delete: `agents-templates/` — template directory (keep in git history)
- Delete: `.hive-generated.json` — template metadata
- Modify: `.gitignore` — remove `agents/` entry (directory no longer generated)
- Modify: `CLAUDE.md` — update architecture docs

- [ ] **Step 1:** Remove `agents-templates/` directory

This contains 17 template directories. They're preserved in git history. The replacement is agent seed YAML files in `plugins/<name>/agent-seeds/`.

The `plugins/dodi/agents-templates/` directory is converted to seed format in Step 4 below.

- [ ] **Step 2:** Remove `.hive-generated.json` from tracking

```bash
git rm .hive-generated.json 2>/dev/null || true
```

- [ ] **Step 3:** Update `.gitignore`

Remove the `agents/` entry since the directory is no longer generated. The agent definitions now live in MongoDB.

- [ ] **Step 4:** Convert `plugins/dodi/agents-templates/` to `plugins/dodi/agent-seeds/`

For each template directory (9 agents), create a single YAML seed file that inlines soul + systemPrompt + all agent.yaml fields. Remove the `agents-templates/` directory from the plugin.

The seed files go in `plugins/dodi/agent-seeds/` with format:
```yaml
_id: customer-success
name: Customer Success  # Default name, overridden per-instance
model: claude-sonnet-4-6
channels: []  # Configured per-instance
coreServers:
  - memory
  - slack
  - hubspot-crm
  # ... rest of servers
soul: |
  [contents of soul.md]
systemPrompt: |
  [contents of system-prompt.md]
# ... all other fields
```

- [ ] **Step 5:** Update `plugins/dodi/plugin.yaml`

Change `agents-templates` to `agent-seeds` and list the YAML files.

- [ ] **Step 6:** Update `CLAUDE.md` documentation

Update the Architecture section, Agent Anatomy section, Setup Commands, and Common Gotchas to reflect the new DB-native approach. Key changes:
- Agent definitions live in MongoDB, not files
- `npm run setup:agents` is now `npm run migrate:agents` (one-time)
- New setup commands: `setup:constitution`, `setup:seeds`, `setup:plugins`
- No more "must run `npm run setup:agents` to regenerate agents/"
- Admin MCP server has full CRUD tools
- Admin REST API on configurable port

- [ ] **Step 7:** Verify full pipeline

Run: `npm run check`
Expected: All checks pass (typecheck + lint + format + test)

- [ ] **Step 8:** Commit

```bash
git add -A
git commit -m "chore: remove template pipeline, convert plugin seeds, update docs

Removes agents-templates/ directory (preserved in git history).
Converts plugins/dodi/ from agents-templates to agent-seeds format.
Updates CLAUDE.md with new DB-native architecture."
```

---

## Execution Order

Tasks 1-2 must be sequential (types before registry rewrite).
Tasks 3-7 can be parallelized after Task 2.
Task 8 is cleanup, runs last after all others.

```
Task 1 → Task 2 → ┬→ Task 3 (schedule)
                   ├→ Task 4 (admin MCP)
                   ├→ Task 5 (admin REST)
                   ├→ Task 6 (migration)
                   └→ Task 7 (setup/seeds/plugins)
                        └──→ Task 8 (cleanup)
```
