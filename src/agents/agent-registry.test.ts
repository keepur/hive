import { describe, it, expect } from "vitest";
import { applyConfigOverrides } from "./agent-registry.js";
import type { AgentConfig, ConfigOverride } from "../types/agent-config.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
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
    soul: "",
    systemPrompt: "",
    ...overrides,
  };
}

describe("applyConfigOverrides", () => {
  it("returns config unchanged when no override", () => {
    const config = makeConfig();
    const result = applyConfigOverrides(config, undefined, undefined);
    expect(result).toBe(config); // same reference
  });

  it("replaces array field entirely", () => {
    const config = makeConfig({ channels: ["old-channel"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      channels: { replace: ["new-a", "new-b"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, makeConfig());
    expect(result.channels).toEqual(["new-a", "new-b"]);
  });

  it("adds to array field without duplicates", () => {
    const template = makeConfig({ channels: ["existing"] });
    const config = makeConfig({ channels: ["existing"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      channels: { add: ["existing", "new-channel"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.channels).toEqual(["existing", "new-channel"]);
  });

  it("removes from array field", () => {
    const template = makeConfig({ channels: ["keep", "remove-me"] });
    const config = makeConfig({ channels: ["keep", "remove-me"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      channels: { remove: ["remove-me"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.channels).toEqual(["keep"]);
  });

  it("applies add and remove together", () => {
    const template = makeConfig({ channels: ["a", "b", "c"] });
    const config = makeConfig({ channels: ["a", "b", "c"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      channels: { add: ["d"], remove: ["b"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.channels).toEqual(["a", "c", "d"]);
  });

  it("overrides scalar fields", () => {
    const config = makeConfig({ budgetUsd: 10, maxTurns: 25 });
    const override: ConfigOverride = {
      agentId: "test-agent",
      budgetUsd: 50,
      maxTurns: 100,
      isDefault: true,
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, makeConfig());
    expect(result.budgetUsd).toBe(50);
    expect(result.maxTurns).toBe(100);
    expect(result.isDefault).toBe(true);
  });

  it("uses template as base for add/remove (not current config)", () => {
    // Template has ["a", "b"], current config was already modified to ["a", "b", "extra"]
    // Override should use template as base, not current
    const template = makeConfig({ channels: ["a", "b"] });
    const config = makeConfig({ channels: ["a", "b", "extra"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      channels: { add: ["c"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    // Should be template base + add, NOT current config base + add
    expect(result.channels).toEqual(["a", "b", "c"]);
  });

  it("does not override scalar fields that are not present in override", () => {
    const config = makeConfig({ budgetUsd: 10, maxTurns: 25, isDefault: false });
    const override: ConfigOverride = {
      agentId: "test-agent",
      budgetUsd: 50,
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, makeConfig());
    expect(result.budgetUsd).toBe(50);
    expect(result.maxTurns).toBe(25); // unchanged
    expect(result.isDefault).toBe(false); // unchanged
  });

  it("handles passiveChannels and keywords array overrides", () => {
    const template = makeConfig({ passiveChannels: ["biz"], keywords: ["deploy"] });
    const config = makeConfig({ passiveChannels: ["biz"], keywords: ["deploy"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      passiveChannels: { add: ["general"] },
      keywords: { replace: ["ship", "release"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.passiveChannels).toEqual(["biz", "general"]);
    expect(result.keywords).toEqual(["ship", "release"]);
  });

  it("replaces plugins array entirely", () => {
    const config = makeConfig({ plugins: ["old-plugin"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      plugins: { replace: ["new-plugin-a", "new-plugin-b"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, makeConfig());
    expect(result.plugins).toEqual(["new-plugin-a", "new-plugin-b"]);
  });

  it("adds plugins without duplicates", () => {
    const template = makeConfig({ plugins: ["existing-plugin"] });
    const config = makeConfig({ plugins: ["existing-plugin"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      plugins: { add: ["existing-plugin", "new-plugin"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.plugins).toEqual(["existing-plugin", "new-plugin"]);
  });

  it("removes plugins", () => {
    const template = makeConfig({ plugins: ["keep-plugin", "remove-plugin"] });
    const config = makeConfig({ plugins: ["keep-plugin", "remove-plugin"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      plugins: { remove: ["remove-plugin"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.plugins).toEqual(["keep-plugin"]);
  });
});

describe("subscribe overrides", () => {
  it("replaces subscribe array entirely", () => {
    const config = makeConfig({ subscribe: ["deals"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      subscribe: { replace: ["cases", "jobs"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, makeConfig());
    expect(result.subscribe).toEqual(["cases", "jobs"]);
  });

  it("adds to subscribe array without duplicates", () => {
    const template = makeConfig({ subscribe: ["deals"] });
    const config = makeConfig({ subscribe: ["deals"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      subscribe: { add: ["deals", "jobs"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.subscribe).toEqual(["deals", "jobs"]);
  });

  it("removes from subscribe array", () => {
    const template = makeConfig({ subscribe: ["deals", "jobs", "cases"] });
    const config = makeConfig({ subscribe: ["deals", "jobs", "cases"] });
    const override: ConfigOverride = {
      agentId: "test-agent",
      subscribe: { remove: ["jobs"] },
      updatedAt: new Date(),
      updatedBy: "test",
    };
    const result = applyConfigOverrides(config, override, template);
    expect(result.subscribe).toEqual(["deals", "cases"]);
  });
});

describe("name matching patterns", () => {
  // These test the same regex logic used in findAllByName
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
    // "Jasper" should not match inside "Jasperson"
    expect(matchesName("Contact Jasperson about this", "Jasper")).toBe(false);
  });

  it("matches multiple agents", () => {
    const text = "Jasper and River, coordinate on this";
    expect(matchesName(text, "Jasper")).toBe(true);
    expect(matchesName(text, "River")).toBe(true);
    expect(matchesName(text, "Milo")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(matchesName("hey RIVER", "River")).toBe(true);
    expect(matchesName("hey river", "River")).toBe(true);
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

  it("handles special regex characters in keywords", () => {
    expect(matchesKeyword("price is $100", "$100")).toBe(false); // word boundary won't match $ at start
    expect(matchesKeyword("check (status)", "(status)")).toBe(false); // parens aren't word chars
  });

  it("is case insensitive", () => {
    expect(matchesKeyword("PERMIT needed", "permit")).toBe(true);
  });
});
