import { describe, it, expect } from "vitest";
import { toAgentConfig, type AgentDefinition, AGENT_DEFINITION_DEFAULTS } from "./agent-definition.js";

// Stub required env vars before src/config.ts is imported transitively.
process.env.SLACK_APP_TOKEN ??= "xapp-test";
process.env.SLACK_BOT_TOKEN ??= "xoxb-test";
process.env.MONGODB_URI ??= "mongodb://localhost:27017";
process.env.OPENPHONE_API_KEY ??= "test";

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

describe("toAgentConfig — archetype passthrough", () => {
  it("passes archetype, title, archetypeConfig through unchanged", () => {
    const def = makeDefinition({
      archetype: "software-engineer",
      title: "VP Engineering",
      archetypeConfig: { workshop: "/Users/x/dev" },
    });
    const cfg = toAgentConfig(def);
    expect(cfg.archetype).toBe("software-engineer");
    expect(cfg.title).toBe("VP Engineering");
    expect(cfg.archetypeConfig).toEqual({ workshop: "/Users/x/dev" });
  });

  it("leaves archetype, title, archetypeConfig undefined when unset", () => {
    const def = makeDefinition();
    const cfg = toAgentConfig(def);
    expect(cfg.archetype).toBeUndefined();
    expect(cfg.title).toBeUndefined();
    expect(cfg.archetypeConfig).toBeUndefined();
  });

  it("does not mutate the input definition", () => {
    const def = makeDefinition({
      archetype: "software-engineer",
      title: "VP Engineering",
      archetypeConfig: { workshop: "/Users/x/dev" },
    });
    const before = JSON.stringify(def);
    toAgentConfig(def);
    const after = JSON.stringify(def);
    expect(after).toBe(before);
  });
});

describe("AGENT_DEFINITION_DEFAULTS", () => {
  it("exposes the functional-team-member coreServers baseline", () => {
    expect(AGENT_DEFINITION_DEFAULTS.coreServers).toEqual([
      "memory",
      "structured-memory",
      "keychain",
      "contacts",
      "event-bus",
      "conversation-search",
      "callback",
      "schedule",
      "slack",
    ]);
  });

  it("defaults delegateServers to empty", () => {
    expect(AGENT_DEFINITION_DEFAULTS.delegateServers).toEqual([]);
  });
});

describe("toAgentConfig — spawn budget passthrough (KPR-220 Phase 17)", () => {
  it("does NOT materialize maxConcurrent when absent from the doc — passes undefined through", () => {
    // KPR-220 Phase 17: pre-fix, toAgentConfig populated maxConcurrent with
    // AGENT_DEFINITION_DEFAULTS.maxConcurrent (= 3) for legacy docs that
    // had no explicit field. That made the spawnBudgetFor fallback's
    // final `?? DEFAULT_PER_AGENT_SPAWN_BUDGET` branch (= 5) unreachable
    // for those agents. Post-fix: maxConcurrent passes through as-is so
    // the fallback chain correctly reaches the engine default of 5.
    const def = makeDefinition();
    const legacy = { ...def } as AgentDefinition & { maxConcurrent?: number };
    delete (legacy as { maxConcurrent?: number }).maxConcurrent;
    const cfg = toAgentConfig(legacy);
    expect(cfg.maxConcurrent).toBeUndefined();
  });

  it("preserves explicit maxConcurrent value", () => {
    const def = makeDefinition({ maxConcurrent: 7 });
    const cfg = toAgentConfig(def);
    expect(cfg.maxConcurrent).toBe(7);
  });

  it("passes spawnBudget through unchanged (set + unset)", () => {
    const defWith = makeDefinition({ spawnBudget: 10 });
    expect(toAgentConfig(defWith).spawnBudget).toBe(10);

    const defWithout = makeDefinition();
    expect(toAgentConfig(defWithout).spawnBudget).toBeUndefined();
  });
});

describe("toAgentConfig — floorCritical projection (KPR-308)", () => {
  it("defaults to false when absent", () => {
    expect(toAgentConfig(makeDefinition()).floorCritical).toBe(false);
  });

  it("passes true through", () => {
    expect(toAgentConfig(makeDefinition({ floorCritical: true })).floorCritical).toBe(true);
  });

  it("passes false through", () => {
    expect(toAgentConfig(makeDefinition({ floorCritical: false })).floorCritical).toBe(false);
  });

  it("coerces garbage to false (liberal loader)", () => {
    expect(toAgentConfig(makeDefinition({ floorCritical: "yes" as unknown as boolean })).floorCritical).toBe(false);
    expect(toAgentConfig(makeDefinition({ floorCritical: 1 as unknown as boolean })).floorCritical).toBe(false);
  });
});

describe("toAgentConfig — coreServers/delegateServers fallback", () => {
  it("falls back to the baseline when a definition is missing coreServers", () => {
    // Simulate a malformed/legacy definition that lacks coreServers (upstream callers
    // guarantee the field, but toAgentConfig is defensive).
    const def = makeDefinition();
    const legacy = { ...def } as AgentDefinition & { coreServers?: string[] };
    delete (legacy as { coreServers?: string[] }).coreServers;
    const cfg = toAgentConfig(legacy);
    expect(cfg.coreServers).toEqual([...AGENT_DEFINITION_DEFAULTS.coreServers]);
  });

  it("falls back to the delegateServers baseline when missing", () => {
    const def = makeDefinition();
    const legacy = { ...def } as AgentDefinition & { delegateServers?: string[] };
    delete (legacy as { delegateServers?: string[] }).delegateServers;
    const cfg = toAgentConfig(legacy);
    expect(cfg.delegateServers).toEqual([...AGENT_DEFINITION_DEFAULTS.delegateServers]);
  });
});
