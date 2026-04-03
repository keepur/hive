# Self-Adjusting Resource Limits Per Model Tier

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** When the model router classifies a message into a complexity tier (haiku/sonnet/opus), dynamically adjust timeout, max turns, and budget so simple tasks get short leashes and complex tasks get room to breathe.

**Architecture:** Add a `ResourceTierDefaults` table to model-router.ts that maps each tier to resource limits. Extend `ModelRouterResult` to include resolved limits. Agent-manager passes these limits through to agent-runner, which uses them instead of the static agent config values. Per-agent overrides in `AgentConfig.resourceTiers` take priority over global defaults.

**Tech Stack:** TypeScript, Claude Agent SDK, Vitest

---

### Task 1: Add resource tier types and defaults to model-router.ts

**Files:**
- Modify: `src/agents/model-router.ts:7-31`

- [ ] **Step 1:** Add `ResourceLimits` interface and `RESOURCE_TIER_DEFAULTS` constant after the `ModelTier` type (line 7). Add `resourceTiers` field type for per-agent overrides. Extend `ModelRouterResult` to include resource limits.

```typescript
// After line 7 (export type ModelTier = ...)

export interface ResourceLimits {
  timeoutMs: number;
  maxTurns: number;
  budgetUsd: number;
}

/** Per-agent override map — only specified fields override the tier default */
export type ResourceTierOverrides = Partial<Record<ModelTier, Partial<ResourceLimits>>>;

/** Global defaults per tier — these fire when no per-agent override exists */
export const RESOURCE_TIER_DEFAULTS: Record<ModelTier, ResourceLimits> = {
  haiku:  { timeoutMs: 120_000,  maxTurns: 20,  budgetUsd: 1  },
  sonnet: { timeoutMs: 300_000,  maxTurns: 50,  budgetUsd: 5  },
  opus:   { timeoutMs: 600_000,  maxTurns: 200, budgetUsd: 50 },
};

/**
 * Resolve resource limits for a tier, applying per-agent overrides on top of global defaults.
 */
export function resolveResourceLimits(
  tier: ModelTier,
  agentOverrides?: ResourceTierOverrides,
): ResourceLimits {
  const defaults = RESOURCE_TIER_DEFAULTS[tier];
  const overrides = agentOverrides?.[tier];
  if (!overrides) return { ...defaults };
  return {
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    maxTurns: overrides.maxTurns ?? defaults.maxTurns,
    budgetUsd: overrides.budgetUsd ?? defaults.budgetUsd,
  };
}
```

- [ ] **Step 2:** Update `ModelRouterResult` to include resolved resource limits:

```typescript
export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
}
```

- [ ] **Step 3:** Update the `routeModel` function signature to accept optional `ResourceTierOverrides` and return resolved limits in all return paths. The function signature becomes:

```typescript
export async function routeModel(
  text: string,
  ceilingModel: string,
  resourceTierOverrides?: ResourceTierOverrides,
): Promise<ModelRouterResult>
```

Every `return` statement in `routeModel` must include resolved resource limits. There are 4 return paths — note the tier variable differs per path:
1. Early return for haiku ceiling (line 85): `resourceLimits: resolveResourceLimits("haiku", resourceTierOverrides)`
2. Error fallback (line 148): `resourceLimits: resolveResourceLimits(fallbackTier, resourceTierOverrides)`
3. Parse failure fallback (line 158): `resourceLimits: resolveResourceLimits(fallbackTier, resourceTierOverrides)`
4. Normal return (line 177): `resourceLimits: resolveResourceLimits(finalTier, resourceTierOverrides)`

- [ ] **Step 4:** Commit

```bash
git add src/agents/model-router.ts
git commit -m "feat(#76): add resource tier types, defaults, and resolver to model-router"
```

---

### Task 2: Add `resourceTiers` to AgentConfig and AgentDefinition

**Files:**
- Modify: `src/types/agent-config.ts:6-31`
- Modify: `src/types/agent-definition.ts:4-46,68-95`

- [ ] **Step 1:** Import `ResourceTierOverrides` type in agent-config.ts and add optional `resourceTiers` field to `AgentConfig`:

```typescript
import type { ResourceTierOverrides } from "../agents/model-router.js";

// Add to AgentConfig interface, after line 27 (subscribe field):
resourceTiers?: ResourceTierOverrides;
```

- [ ] **Step 2:** Add optional `resourceTiers` field to `AgentDefinition` in agent-definition.ts (after line 38, the `timeoutMs` field):

```typescript
import type { ResourceTierOverrides } from "../agents/model-router.js";

// Add to AgentDefinition interface, in the Limits section:
resourceTiers?: ResourceTierOverrides;
```

- [ ] **Step 3:** Pass `resourceTiers` through in `toAgentConfig()`:

```typescript
// Add to the return object in toAgentConfig(), after the subscribe line:
resourceTiers: doc.resourceTiers,
```

- [ ] **Step 4:** Commit

```bash
git add src/types/agent-config.ts src/types/agent-definition.ts
git commit -m "feat(#76): add resourceTiers to AgentConfig and AgentDefinition"
```

---

### Task 3: Pass resolved resource limits from agent-manager to agent-runner

**Files:**
- Modify: `src/agents/agent-manager.ts:163-179`
- Modify: `src/agents/agent-runner.ts:683-755`

- [ ] **Step 1:** In agent-manager.ts, update the model router call block (lines 163-177) to capture resource limits and pass them to `runner.send()`. Import only the `ResourceLimits` type (resolution already happens inside `routeModel`):

```typescript
// At the top, update the import from model-router:
import { routeModel, type ResourceLimits } from "./model-router.js";
```

Update the model routing block to capture resource limits and pass agent overrides:

```typescript
        // Model routing — classify complexity and pick the right model tier
        let modelOverride: string | undefined;
        let routerCostUsd = 0;
        let resourceLimits: ResourceLimits | undefined;
        if (appConfig.modelRouter.enabled && item.message.sender !== "system") {
          try {
            const agentConfig = this.registry.get(agentId);
            if (agentConfig) {
              const route = await routeModel(
                item.message.text,
                agentConfig.model,
                agentConfig.resourceTiers,
              );
              modelOverride = route.model !== agentConfig.model ? route.model : undefined;
              routerCostUsd = route.costUsd;
              resourceLimits = route.resourceLimits;
            }
          } catch (err) {
            log.warn("Model router failed, using default", { agentId, error: String(err) });
          }
        }

        const result = await runner.send(prompt, existingSession, item.onStream, bgContext, modelOverride, resourceLimits);
```

- [ ] **Step 2:** Update agent-runner.ts `send()` method to accept an optional `ResourceLimits` parameter and use it for maxTurns, budgetUsd, and timeoutMs. Import the type:

```typescript
import type { ResourceLimits } from "./model-router.js";
```

Update the `send` signature:

```typescript
async send(
  prompt: string,
  sessionId?: string,
  onStream?: StreamCallback,
  context?: WorkItemContext,
  modelOverride?: string,
  resourceLimits?: ResourceLimits,
): Promise<RunResult> {
```

Update the SDK query options (lines 716-717) to prefer resourceLimits:

```typescript
        maxTurns: resourceLimits?.maxTurns ?? this.agentConfig.maxTurns,
        maxBudgetUsd: resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,
```

Update the timeout (line 748) to prefer resourceLimits:

```typescript
    const timeoutMs = resourceLimits?.timeoutMs ?? this.agentConfig.timeoutMs ?? 300_000;
```

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-manager.ts src/agents/agent-runner.ts
git commit -m "feat(#76): wire resource limits from model router through to agent runner"
```

---

### Task 4: Add tests

**Files:**
- Create: `src/agents/model-router.test.ts`
- Modify: `src/agents/agent-manager.test.ts`
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1:** Create `src/agents/model-router.test.ts` for the pure-function `resolveResourceLimits`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveResourceLimits, RESOURCE_TIER_DEFAULTS } from "./model-router.js";

describe("resolveResourceLimits", () => {
  it("returns global defaults when no agent overrides", () => {
    const limits = resolveResourceLimits("haiku");
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
  });

  it("returns global defaults when agent overrides is undefined", () => {
    const limits = resolveResourceLimits("sonnet", undefined);
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
  });

  it("returns global defaults when agent has no override for the tier", () => {
    const limits = resolveResourceLimits("haiku", { opus: { timeoutMs: 900_000 } });
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
  });

  it("merges partial agent overrides with global defaults", () => {
    const limits = resolveResourceLimits("opus", {
      opus: { timeoutMs: 900_000 },
    });
    expect(limits).toEqual({
      timeoutMs: 900_000,
      maxTurns: RESOURCE_TIER_DEFAULTS.opus.maxTurns,
      budgetUsd: RESOURCE_TIER_DEFAULTS.opus.budgetUsd,
    });
  });

  it("fully overrides all fields when all specified", () => {
    const limits = resolveResourceLimits("sonnet", {
      sonnet: { timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 },
    });
    expect(limits).toEqual({ timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 });
  });

  it("returns a copy, not a reference to defaults", () => {
    const limits = resolveResourceLimits("haiku");
    limits.timeoutMs = 999;
    expect(RESOURCE_TIER_DEFAULTS.haiku.timeoutMs).toBe(120_000);
  });
});
```

- [ ] **Step 2:** Add model-router integration tests to `agent-manager.test.ts`. Enable model router in a new describe block and verify resource limits are passed through to the runner:

```typescript
// Import routeModel mock at the top
import { routeModel } from "./model-router.js";

describe("model router resource limits", () => {
  beforeEach(() => {
    // Enable model router for these tests
    (appConfig as any).modelRouter.enabled = true;
  });

  afterEach(() => {
    (appConfig as any).modelRouter.enabled = false;
  });

  it("passes resource limits from router to runner.send()", async () => {
    const mockRoute = {
      tier: "opus" as const,
      model: "claude-opus-4-6",
      costUsd: 0.001,
      durationMs: 50,
      resourceLimits: { timeoutMs: 600_000, maxTurns: 200, budgetUsd: 50 },
    };
    vi.mocked(routeModel).mockResolvedValue(mockRoute);

    const item = makeWorkItem();
    await manager.sendMessage("agent-a", item);

    expect(mockRunnerSend).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      undefined,
      expect.any(Object),
      "claude-opus-4-6",
      mockRoute.resourceLimits,
    );
  });

  it("passes undefined resource limits when model router is disabled", async () => {
    (appConfig as any).modelRouter.enabled = false;

    const item = makeWorkItem();
    await manager.sendMessage("agent-a", item);

    expect(mockRunnerSend).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      undefined,
      expect.any(Object),
      undefined,
      undefined,
    );
  });
});
```

- [ ] **Step 3:** Add test to `agent-runner.test.ts` verifying resource limits override agent config values in the SDK query call. Add a new describe block:

```typescript
describe("resource limits override", () => {
  it("uses resourceLimits when provided", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ maxTurns: 25, budgetUsd: 10, timeoutMs: 300_000 }),
      mockMemoryManager as any,
    );

    await runner.send("test", undefined, undefined, undefined, undefined, {
      timeoutMs: 600_000,
      maxTurns: 200,
      budgetUsd: 50,
    });

    const options = getCapturedOptions();
    expect(options.maxTurns).toBe(200);
    expect(options.maxBudgetUsd).toBe(50);
  });

  it("falls back to agentConfig when resourceLimits not provided", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ maxTurns: 25, budgetUsd: 10 }),
      mockMemoryManager as any,
    );

    await runner.send("test");

    const options = getCapturedOptions();
    expect(options.maxTurns).toBe(25);
    expect(options.maxBudgetUsd).toBe(10);
  });
});
```

- [ ] **Step 4:** Verify build and tests pass

Run: `npm run check`
Expected: Typecheck, lint, format, and all tests pass

- [ ] **Step 5:** Commit

```bash
git add src/agents/model-router.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts
git commit -m "test(#76): add tests for resource tier resolution and wiring"
```
