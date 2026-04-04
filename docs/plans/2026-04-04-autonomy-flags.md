# Autonomy Flags Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace scattered legacy gates (`externalComms.enabled`, `memory.reflectionEnabled`, `memory.structured`) with a unified per-agent autonomy flag system that resolves hardcoded defaults → instance ceiling → per-agent restrictions.

**Architecture:** New `src/agents/autonomy.ts` module (~40 lines) owns flag types, hardcoded defaults, and resolution logic. Schema additions to `AgentDefinition` and `AgentConfig`. Config additions to `config.ts`. Guard checks in `agent-runner.ts` and `agent-manager.ts` switch from instance-level config reads to per-agent resolved flags. Legacy gates are removed.

**Tech Stack:** TypeScript, MongoDB (agent definitions), hive.yaml (instance config)

**Design note:** The resolution function uses `ceiling = instance ?? hardcoded; result = ceiling AND agent`. This means hardcoded defaults are fallbacks (not ceilings) — instance config can enable a default-false flag like `codeTask`. Per-agent can only restrict below the instance ceiling, never escalate.

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/agents/autonomy.ts` | Create | `AutonomyFlags` interface, `AUTONOMY_DEFAULTS`, `resolveAutonomy()` |
| `src/types/agent-definition.ts` | Modify | Add optional `autonomy` field to `AgentDefinition`, pass instance ceiling to `toAgentConfig()` |
| `src/types/agent-config.ts` | Modify | Add required `autonomy` field to `AgentConfig` |
| `src/config.ts` | Modify | Add `autonomy` section, remove `externalComms`, `memory.structured`, `memory.reflectionEnabled` |
| `src/agents/agent-runner.ts` | Modify | Replace `config.externalComms.enabled` with per-agent flags, add `codeTask`/`codeAccess` gates, always register `structured-memory` |
| `src/agents/agent-manager.ts` | Modify | Remove `reflectionEnabled` guard (reflection always on) |
| `src/agents/agent-registry.ts` | Modify | Pass `config.autonomy` to `toAgentConfig()` |
| `src/index.ts` | Modify | Remove `memory.structured` conditional — always init structured memory; fix stale optional chaining in shutdown |
| `src/agents/autonomy.test.ts` | Create | Unit tests for `resolveAutonomy()` |
| `src/agents/agent-runner.test.ts` | Modify | Update mock config, replace `externalComms.enabled` tests with autonomy flag tests |
| `src/agents/agent-manager.test.ts` | Modify | Remove `reflectionEnabled` mock and test, add `autonomy` to makeAgentConfig |
| `src/agents/agent-registry.test.ts` | Modify | Pass instance ceiling to `toAgentConfig()`, add autonomy resolution test |

---

### Task 1: Create autonomy module

**Files:**
- Create: `src/agents/autonomy.ts`

- [ ] **Step 1:** Create the autonomy module with types, defaults, and resolver

```typescript
/**
 * Autonomy flags — per-agent capability gates.
 *
 * Only capabilities with real external side effects, resource costs,
 * or information access implications are gated. Infrastructure
 * (reflection, compaction, backgroundTasks, etc.) is always on.
 *
 * Resolution: hardcoded default → instance ceiling → per-agent (restrict only).
 * - Hardcoded defaults are fallback values when instance config is absent.
 * - Instance ceiling (hive.yaml) sets the maximum for the installation.
 * - Per-agent can only restrict (AND with ceiling), never escalate.
 */

export interface AutonomyFlags {
  /** Outbound email/SMS via resend/quo servers */
  externalComms: boolean;
  /** Claude Code CLI sessions via code-task server */
  codeTask: boolean;
  /** Source code visibility via code-search server */
  codeAccess: boolean;
}

export const AUTONOMY_DEFAULTS: Readonly<AutonomyFlags> = {
  externalComms: true,
  codeTask: false,
  codeAccess: false,
};

/**
 * Resolve autonomy flags: hardcoded → instance ceiling → per-agent.
 *
 * Instance config overrides hardcoded defaults (can enable default-false flags).
 * Per-agent can only restrict below the instance ceiling (AND logic), never escalate.
 */
export function resolveAutonomy(
  instanceCeiling: Partial<AutonomyFlags> = {},
  agentOverrides?: Partial<AutonomyFlags>,
): AutonomyFlags {
  const result = {} as AutonomyFlags;
  for (const key of Object.keys(AUTONOMY_DEFAULTS) as (keyof AutonomyFlags)[]) {
    const ceiling = instanceCeiling[key] ?? AUTONOMY_DEFAULTS[key];
    // Agent can only restrict below ceiling (AND), never escalate
    result[key] = ceiling && (agentOverrides?.[key] ?? true);
  }
  return result;
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/agents/autonomy.ts
git commit -m "feat(autonomy): add flag types, defaults, and resolution logic (#81)"
```

---

### Task 2: Add autonomy tests

**Files:**
- Create: `src/agents/autonomy.test.ts`

- [ ] **Step 1:** Write unit tests for `resolveAutonomy()`

```typescript
import { describe, it, expect } from "vitest";
import { resolveAutonomy, AUTONOMY_DEFAULTS } from "./autonomy.js";

describe("resolveAutonomy", () => {
  it("returns hardcoded defaults when no overrides provided", () => {
    const result = resolveAutonomy();
    expect(result).toEqual(AUTONOMY_DEFAULTS);
  });

  it("returns hardcoded defaults when empty overrides provided", () => {
    const result = resolveAutonomy({}, {});
    expect(result).toEqual(AUTONOMY_DEFAULTS);
  });

  it("instance ceiling can restrict a default-true flag", () => {
    const result = resolveAutonomy({ externalComms: false });
    expect(result.externalComms).toBe(false);
  });

  it("instance ceiling can enable a default-false flag", () => {
    const result = resolveAutonomy({ codeTask: true });
    expect(result.codeTask).toBe(true);
  });

  it("per-agent can restrict within instance ceiling", () => {
    const result = resolveAutonomy(
      { externalComms: true, codeTask: true },
      { externalComms: false },
    );
    expect(result.externalComms).toBe(false);
    expect(result.codeTask).toBe(true);
  });

  it("per-agent cannot escalate beyond instance ceiling", () => {
    const result = resolveAutonomy(
      { codeTask: false },
      { codeTask: true },
    );
    expect(result.codeTask).toBe(false);
  });

  it("per-agent cannot escalate beyond hardcoded default when instance unset", () => {
    // codeTask hardcoded default is false, instance doesn't override
    // Agent tries to enable — should stay false (ceiling = hardcoded = false)
    const result = resolveAutonomy(
      {},
      { codeTask: true },
    );
    expect(result.codeTask).toBe(false);
  });

  it("full resolution chain with mixed flags", () => {
    const result = resolveAutonomy(
      { externalComms: true, codeTask: true, codeAccess: true },
      { externalComms: false, codeTask: true, codeAccess: true },
    );
    expect(result.externalComms).toBe(false); // agent restricted
    expect(result.codeTask).toBe(true);       // both allow
    expect(result.codeAccess).toBe(true);     // both allow
  });

  it("agent unset flags inherit from instance ceiling", () => {
    const result = resolveAutonomy(
      { codeTask: true, codeAccess: true },
      { codeTask: true }, // codeAccess not specified — inherits ceiling
    );
    expect(result.codeAccess).toBe(true);
  });

  it("all flags false when instance blocks everything", () => {
    const result = resolveAutonomy(
      { externalComms: false, codeTask: false, codeAccess: false },
      { externalComms: true, codeTask: true, codeAccess: true },
    );
    expect(result.externalComms).toBe(false);
    expect(result.codeTask).toBe(false);
    expect(result.codeAccess).toBe(false);
  });
});
```

- [ ] **Step 2:** Verify

Run: `npx vitest run src/agents/autonomy.test.ts`
Expected: all tests pass

- [ ] **Step 3:** Commit

```bash
git add src/agents/autonomy.test.ts
git commit -m "test(autonomy): unit tests for resolveAutonomy (#81)"
```

---

### Task 3: Schema changes — AgentDefinition and AgentConfig

**Files:**
- Modify: `src/types/agent-definition.ts:5-49` (AgentDefinition interface)
- Modify: `src/types/agent-definition.ts:71-100` (toAgentConfig function)
- Modify: `src/types/agent-config.ts:8-35` (AgentConfig interface)

- [ ] **Step 1:** Add `autonomy` to `AgentDefinition`

In `src/types/agent-definition.ts`, add after line 41 (`resourceTiers?: ResourceTierOverrides;`):

```typescript
  // Autonomy — per-agent capability gates (can only restrict, never escalate beyond instance ceiling)
  autonomy?: Partial<import("../agents/autonomy.js").AutonomyFlags>;
```

- [ ] **Step 2:** Add `autonomy` to `AgentConfig`

In `src/types/agent-config.ts`, add after line 31 (`resourceTiers?: ResourceTierOverrides;`):

```typescript
  autonomy: import("../agents/autonomy.js").AutonomyFlags; // resolved — always present
```

- [ ] **Step 3:** Wire resolution in `toAgentConfig()`

In `src/types/agent-definition.ts`, add import at top:

```typescript
import { resolveAutonomy, type AutonomyFlags } from "../agents/autonomy.js";
```

Change `toAgentConfig` signature to accept instance ceiling as parameter (keeps `types/` free from importing `config.ts`):

```typescript
export function toAgentConfig(doc: AgentDefinition, instanceAutonomy?: Partial<AutonomyFlags>): AgentConfig {
  return {
    ...existing fields...,
    autonomy: resolveAutonomy(instanceAutonomy, doc.autonomy),
  };
}
```

Add `autonomy: resolveAutonomy(instanceAutonomy, doc.autonomy),` after `systemPrompt: doc.systemPrompt ?? "",` in the return object.

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: may have errors where `toAgentConfig` is called without the new arg — fixed in Tasks 4-8.

- [ ] **Step 5:** Commit

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts
git commit -m "feat(autonomy): add autonomy field to AgentDefinition and AgentConfig (#81)"
```

---

### Task 4: Config changes — add autonomy section, remove legacy gates

**Files:**
- Modify: `src/config.ts:184-186` (externalComms section)
- Modify: `src/config.ts:206-233` (memory section)

- [ ] **Step 1:** Add `autonomy` section to config

In `src/config.ts`, replace the `externalComms` section (lines 184-186):

```typescript
  // BEFORE:
  externalComms: {
    enabled: optional("EXTERNAL_COMMS_ENABLED", "false") === "true",
  },

  // AFTER:
  autonomy: {
    externalComms: (hive.autonomy?.externalComms ?? true) as boolean,
    codeTask: (hive.autonomy?.codeTask ?? false) as boolean,
    codeAccess: (hive.autonomy?.codeAccess ?? false) as boolean,
  },
```

- [ ] **Step 2:** Remove legacy gates from memory section

In `src/config.ts`, remove these two lines from the `memory` section:

```typescript
  // REMOVE:
  structured: hive.memory?.structured === true || process.env.MEMORY_STRUCTURED === "true",
  reflectionEnabled: (hive.memory?.reflectionEnabled ?? true) && process.env.MEMORY_REFLECTION_ENABLED !== "false",
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: errors for code still referencing removed fields — fixed in Tasks 5-8.

- [ ] **Step 4:** Commit

```bash
git add src/config.ts
git commit -m "feat(autonomy): add autonomy config section, remove legacy gates (#81)"
```

---

### Task 5: Update agent-registry — pass instance ceiling to toAgentConfig

**Files:**
- Modify: `src/agents/agent-registry.ts:35`

- [ ] **Step 1:** Add config import and pass instance ceiling

Add import at top of `src/agents/agent-registry.ts`:

```typescript
import { config } from "../config.js";
```

Then at line 35, change:

```typescript
  // BEFORE:
  const config = toAgentConfig(doc);

  // AFTER:
  const agentConfig = toAgentConfig(doc, config.autonomy);
```

Note: since `config` is already imported as a variable name, you'll need to either rename the local or use a different import alias. Check existing imports — if `config` is already imported from `../config.js`, just use it. If not, add the import and rename the local variable from `config` to `agentConfig`.

Actually, looking at the existing code at line 35: `const config = toAgentConfig(doc);` — this local `config` shadows any import. The safest approach: rename the local to `agentConfig` and update all references in the `load()` method.

```typescript
// Change line 35 and all references within load():
const agentConfig = toAgentConfig(doc, appConfig.autonomy);
```

Import as `appConfig` to avoid collision:

```typescript
import { config as appConfig } from "../config.js";
```

Update all references to the local `config` variable in `load()` to `agentConfig`. (The variable is used at lines 35-58 approximately.)

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors (or only test errors)

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-registry.ts
git commit -m "feat(autonomy): pass instance ceiling to toAgentConfig in registry (#81)"
```

---

### Task 6: Update agent-runner — replace externalComms gate, add codeTask/codeAccess gates, always register structured-memory

**Files:**
- Modify: `src/agents/agent-runner.ts:177-179` (structured-memory conditional)
- Modify: `src/agents/agent-runner.ts:574-583` (filterCoreServers externalComms gate)
- Modify: `src/agents/agent-runner.ts:604-606` (buildDelegateAgents externalComms gate)

- [ ] **Step 1:** Always register structured-memory server

In `src/agents/agent-runner.ts`, remove the `if (config.memory.structured)` guard around the structured-memory server registration. Change lines 177-179 from:

```typescript
    // Structured Memory MCP server — semantic + temporal memory with vector search
    // Only enabled when memory.structured is true in hive.yaml
    if (config.memory.structured) {
```

To:

```typescript
    // Structured Memory MCP server — semantic + temporal memory with vector search
    {
```

The closing brace and server registration stay the same — just remove the conditional.

- [ ] **Step 2:** Replace externalComms gate in filterCoreServers

In `src/agents/agent-runner.ts`, replace lines 574-583:

```typescript
    // BEFORE:
    // Hard gate: strip external communication servers unless explicitly enabled
    if (!config.externalComms.enabled) {
      const externalServers = ["resend", "quo"];
      for (const key of externalServers) {
        if (servers[key]) {
          log.debug("External comms disabled — removing server", { server: key, agent: this.agentConfig.id });
          delete servers[key];
        }
      }
    }

    // AFTER:
    // Autonomy gates — strip servers based on per-agent resolved flags
    if (!this.agentConfig.autonomy.externalComms) {
      for (const key of ["resend", "quo"]) {
        if (servers[key]) {
          log.debug("Autonomy: externalComms disabled — removing server", { server: key, agent: this.agentConfig.id });
          delete servers[key];
        }
      }
    }
    if (!this.agentConfig.autonomy.codeTask) {
      if (servers["code-task"]) {
        log.debug("Autonomy: codeTask disabled — removing server", { server: "code-task", agent: this.agentConfig.id });
        delete servers["code-task"];
      }
    }
    if (!this.agentConfig.autonomy.codeAccess) {
      if (servers["code-search"]) {
        log.debug("Autonomy: codeAccess disabled — removing server", { server: "code-search", agent: this.agentConfig.id });
        delete servers["code-search"];
      }
    }
```

- [ ] **Step 3:** Replace externalComms gate in buildDelegateAgents

In `src/agents/agent-runner.ts`, replace lines 603-613:

```typescript
    // BEFORE:
    // Same externalComms gate as buildMcpServers — block resend/quo in delegates too
    const externalBlocked = !config.externalComms.enabled
      ? new Set(["resend", "quo"])
      : new Set<string>();

    for (const serverName of delegates) {
      // Hard gate: strip external communication servers unless explicitly enabled
      if (externalBlocked.has(serverName)) {
        log.debug("External comms disabled — skipping delegate server", { server: serverName, agent: this.agentConfig.id });
        continue;
      }

    // AFTER:
    // Autonomy gates for delegate servers — same rules as core servers
    const blockedDelegates = new Set<string>();
    if (!this.agentConfig.autonomy.externalComms) {
      blockedDelegates.add("resend");
      blockedDelegates.add("quo");
    }
    if (!this.agentConfig.autonomy.codeTask) {
      blockedDelegates.add("code-task");
    }
    if (!this.agentConfig.autonomy.codeAccess) {
      blockedDelegates.add("code-search");
    }

    for (const serverName of delegates) {
      if (blockedDelegates.has(serverName)) {
        log.debug("Autonomy gate — skipping delegate server", { server: serverName, agent: this.agentConfig.id });
        continue;
      }
```

- [ ] **Step 4:** Verify no remaining references to `config.externalComms` in agent-runner.ts

Run: `grep -n "config.externalComms\|config\.memory\.structured" src/agents/agent-runner.ts`
Expected: no matches

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(autonomy): replace legacy gates with per-agent autonomy flags in agent-runner (#81)"
```

---

### Task 7: Update agent-manager — remove reflectionEnabled gate

**Files:**
- Modify: `src/agents/agent-manager.ts:248-249`

- [ ] **Step 1:** Remove `reflectionEnabled` from the reflection guard

In `src/agents/agent-manager.ts`, line 249, remove `appConfig.memory.reflectionEnabled &&` from the if condition:

```typescript
    // BEFORE:
    if (
      appConfig.memory.reflectionEnabled &&
      hasMemoryServer &&
      lastResult &&

    // AFTER:
    if (
      hasMemoryServer &&
      lastResult &&
```

The rest of the guard conditions (`lastItem`, `!lastResult.error`, `!lastResult.aborted`, `turnCount >= reflectionMinTurns`, sender check) remain unchanged.

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-manager.ts
git commit -m "refactor(autonomy): remove reflectionEnabled gate — reflection is always-on infrastructure (#81)"
```

---

### Task 8: Update index.ts — always init structured memory, fix stale optional chaining

**Files:**
- Modify: `src/index.ts:101-123` (memory init)
- Modify: `src/index.ts:187-192` (code index knowledge extractor)
- Modify: `src/index.ts:403` (shutdown handler)

- [ ] **Step 1:** Remove `memory.structured` conditional — always init

In `src/index.ts`, replace lines 101-123:

```typescript
  // BEFORE:
  // Structured memory lifecycle — opt-in via memory.structured in hive.yaml
  let memoryLifecycle: MemoryLifecycle | undefined;
  let memoryStore: MemoryStore | undefined;
  let memoryEmbedder: MemoryEmbedder | undefined;
  if (config.memory.structured) {
    ...
  } else {
    log.info("Structured memory lifecycle disabled (legacy mode)");
  }

  // AFTER:
  // Structured memory lifecycle — always enabled
  const memoryStore = new MemoryStore(config.mongo.uri, config.mongo.dbName);
  await memoryStore.init();
  memoryManager.memoryStore = memoryStore;
  const memoryEmbedder = new MemoryEmbedder();
  const memoryLifecycle = new MemoryLifecycle(memoryStore, memoryEmbedder, {
    hotBudgetTokens: config.memory.hotBudgetTokens,
    sweepIntervalHours: config.memory.sweepIntervalHours,
    hotThreshold: config.memory.hotThreshold,
    warmThreshold: config.memory.warmThreshold,
    recencyHalfLifeDays: config.memory.recencyHalfLifeDays,
    coldSummaryMinRecords: config.memory.coldSummaryMinRecords,
    coldRetentionDays: config.memory.coldRetentionDays,
    purgeRetentionDays: config.memory.purgeRetentionDays,
  });
  log.info("Structured memory lifecycle enabled");
```

- [ ] **Step 2:** Simplify code index knowledge extractor branch

Since memoryStore and memoryEmbedder are now always initialized, the `else if` warning branch at lines 190-192 is unreachable. Simplify:

```typescript
  // BEFORE (lines 187-192):
  if (config.codeIndex.sessionKnowledge.enabled && memoryStore && memoryEmbedder) {
    knowledgeExtractor = new KnowledgeExtractor(memoryStore, memoryEmbedder);
  } else if (config.codeIndex.sessionKnowledge.enabled && (!memoryStore || !memoryEmbedder)) {
    log.warn("Code index session knowledge enabled but memory.structured is false — session knowledge disabled");
  }

  // AFTER:
  if (config.codeIndex.sessionKnowledge.enabled) {
    knowledgeExtractor = new KnowledgeExtractor(memoryStore, memoryEmbedder);
  }
```

- [ ] **Step 3:** Fix stale optional chaining in shutdown handler

In `src/index.ts`, line 403, change:

```typescript
  // BEFORE:
  await memoryStore?.close();

  // AFTER:
  await memoryStore.close();
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5:** Commit

```bash
git add src/index.ts
git commit -m "refactor(autonomy): always init structured memory, remove migration flag (#81)"
```

---

### Task 9: Update tests

**Files:**
- Modify: `src/agents/agent-runner.test.ts`
- Modify: `src/agents/agent-manager.test.ts`
- Modify: `src/agents/agent-registry.test.ts`

- [ ] **Step 1:** Update agent-runner.test.ts config mock

Replace line 84:

```typescript
    // BEFORE:
    externalComms: { enabled: true },

    // AFTER:
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
```

- [ ] **Step 2:** Update makeAgentConfig helper in agent-runner.test.ts to include autonomy

In `makeAgentConfig()` (lines 104-123), add `autonomy` to the default config:

```typescript
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "TestAgent",
    model: "claude-haiku-4-5",
    channels: ["agent-test"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    icon: "",
    coreServers: [],
    delegateServers: [],
    soul: "",
    systemPrompt: "You are a test agent.",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}
```

- [ ] **Step 3:** Update "removes resend and quo when external comms disabled" test (line 189)

Replace the test to use autonomy flags on the agent config instead of mutating global config:

```typescript
  it("removes resend and quo when externalComms autonomy flag is false", async () => {
    const { config } = await import("../config.js");
    const origResendKey = config.resend.apiKey;
    const origQuoKey = (config.quo as any).apiKey;
    (config.resend as any).apiKey = "test-resend-key";
    (config.quo as any).apiKey = "test-quo-key";

    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "keychain", "resend"],
        autonomy: { externalComms: false, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("resend");
    expect(servers).not.toHaveProperty("quo");

    (config.resend as any).apiKey = origResendKey;
    (config.quo as any).apiKey = origQuoKey;
  });
```

- [ ] **Step 4:** Update delegate externalComms test (line 543)

Similar refactor — use per-agent flag instead of global config:

```typescript
  it("excludes resend and quo from delegates when externalComms autonomy flag is false", async () => {
    const { config } = await import("../config.js");
    const origResendKey = config.resend.apiKey;
    (config.resend as any).apiKey = "test-key";

    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["resend", "brave-search"],
        autonomy: { externalComms: false, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();
    expect(options.agents).not.toHaveProperty("resend");
    expect(options.agents).toHaveProperty("brave-search");

    (config.resend as any).apiKey = origResendKey;
  });
```

- [ ] **Step 5:** Add new tests for codeTask and codeAccess gates

```typescript
  it("removes code-task when codeTask autonomy flag is false", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-task"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("code-task");
  });

  it("keeps code-task when codeTask autonomy flag is true", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-task"],
        autonomy: { externalComms: true, codeTask: true, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).toHaveProperty("code-task");
  });

  it("removes code-search when codeAccess autonomy flag is false", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("code-search");
  });

  it("keeps code-search when codeAccess autonomy flag is true", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: true },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).toHaveProperty("code-search");
  });
```

- [ ] **Step 6:** Update the comment at agent-runner.test.ts line 172

```typescript
    // BEFORE:
    // structured-memory only included when memory.structured is enabled

    // AFTER:
    // structured-memory is auto-paired with memory (always registered)
```

- [ ] **Step 7:** Update agent-manager.test.ts config mock and helper

Remove `reflectionEnabled` from config mock (line 18):

```typescript
    // BEFORE:
    memory: { reflectionEnabled: true, reflectionMinTurns: 3 },

    // AFTER:
    memory: { reflectionMinTurns: 3 },
```

Add `autonomy` to the makeAgentConfig helper at line 65:

```typescript
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "TestAgent",
    model: "claude-haiku-4-5",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    coreServers: ["memory"],
    delegateServers: [],
    icon: "",
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}
```

Delete the "skips reflection when reflectionEnabled is false" test (lines 654-674) entirely. Reflection is now always-on infrastructure.

- [ ] **Step 8:** Update agent-registry.test.ts

Update all `toAgentConfig(def)` calls to pass instance ceiling: `toAgentConfig(def, {})` (empty = use hardcoded defaults).

Add a new test for autonomy resolution:

```typescript
  it("resolves autonomy flags from definition and instance ceiling", () => {
    const def = makeDefinition({
      autonomy: { externalComms: false },
    });
    const instanceCeiling = { externalComms: true, codeTask: true, codeAccess: false };
    const config = toAgentConfig(def, instanceCeiling);

    expect(config.autonomy.externalComms).toBe(false); // agent restricted
    expect(config.autonomy.codeTask).toBe(true);       // inherits ceiling
    expect(config.autonomy.codeAccess).toBe(false);    // ceiling is false
  });

  it("uses hardcoded defaults when no autonomy overrides", () => {
    const def = makeDefinition();
    const config = toAgentConfig(def, {});
    // AUTONOMY_DEFAULTS: externalComms=true, codeTask=false, codeAccess=false
    expect(config.autonomy.externalComms).toBe(true);
    expect(config.autonomy.codeTask).toBe(false);
    expect(config.autonomy.codeAccess).toBe(false);
  });
```

- [ ] **Step 9:** Verify

Run: `npx vitest run src/agents/`
Expected: all tests pass

- [ ] **Step 10:** Commit

```bash
git add src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/agents/agent-registry.test.ts
git commit -m "test(autonomy): update tests for per-agent autonomy flags, remove legacy gate tests (#81)"
```

---

### Task 10: Final verification

- [ ] **Step 1:** Full type check

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2:** Full test suite

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 3:** Build

Run: `npm run build`
Expected: clean build

- [ ] **Step 4:** Verify no remaining references to removed config fields

Run: `grep -rn "externalComms\.enabled\|memory\.structured\|memory\.reflectionEnabled\|MEMORY_STRUCTURED\|MEMORY_REFLECTION_ENABLED" src/`
Expected: no matches (specs and docs may still reference them, that's fine)

- [ ] **Step 5:** Commit any stragglers, if needed
