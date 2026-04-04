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
    const config = toAgentConfig(def, {});
    expect(config.id).toBe("rae");
    expect(config.name).toBe("Rae");
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.channels).toEqual(["general"]);
    expect(config.coreServers).toEqual(["memory", "slack"]);
    expect(config.soul).toBe("I am Rae.");
    expect(config.systemPrompt).toBe("You are a receptionist.");
    // autonomy is always present and resolved
    expect(config.autonomy).toBeDefined();
    expect(config.autonomy.externalComms).toBe(true);
  });

  it("applies defaults for missing optional fields", () => {
    const def = makeDefinition();
    delete (def as any).maxConcurrent;
    delete (def as any).timeoutMs;
    delete (def as any).budgetUsd;
    delete (def as any).maxTurns;
    delete (def as any).icon;
    delete (def as any).keywords;
    delete (def as any).passiveChannels;
    delete (def as any).delegatePrompts;
    delete (def as any).schedule;

    const config = toAgentConfig(def, {});
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
    const config = toAgentConfig(def, {});
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
    const config = toAgentConfig(def, {});
    expect(config.triageModel).toBe("claude-haiku-4-5");
    expect(config.dodiOpsMode).toBe("readonly");
    expect(config.slackBot).toBe("jasper");
    expect(config.plugins).toEqual(["dodi-dev"]);
    expect(config.subscribe).toEqual(["deals", "jobs"]);
  });
});

describe("toAgentConfig autonomy resolution", () => {
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
