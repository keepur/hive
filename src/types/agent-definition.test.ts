import { describe, it, expect } from "vitest";
import { toAgentConfig, type AgentDefinition } from "./agent-definition.js";

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
