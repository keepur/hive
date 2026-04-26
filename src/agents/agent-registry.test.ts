import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { toAgentConfig, AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { Collection } from "mongodb";

// Stub required env vars before src/config.ts is imported transitively by agent-registry.
process.env.SLACK_APP_TOKEN ??= "xapp-test";
process.env.SLACK_BOT_TOKEN ??= "xoxb-test";
process.env.MONGODB_URI ??= "mongodb://localhost:27017";
process.env.OPENPHONE_API_KEY ??= "test";

type AgentRegistryModule = typeof import("./agent-registry.js");
type ArchetypesRegistryModule = typeof import("../archetypes/registry.js");
let AgentRegistry: AgentRegistryModule["AgentRegistry"];
let registerArchetype: ArchetypesRegistryModule["registerArchetype"];
let __resetRegistryForTests: ArchetypesRegistryModule["__resetRegistryForTests"];

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
      metadata: { dodiOpsMode: "readonly" },
      slackBot: "jasper",
      plugins: ["dodi-dev"],
      subscribe: ["deals", "jobs"],
    });
    const config = toAgentConfig(def, {});
    expect((config.metadata as { dodiOpsMode: string }).dodiOpsMode).toBe("readonly");
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

function makeFakeCollection(docs: AgentDefinition[]): Collection<AgentDefinition> {
  return {
    find: () => ({ toArray: async () => docs }),
  } as unknown as Collection<AgentDefinition>;
}

describe("AgentRegistry archetype validation on load", () => {
  beforeAll(async () => {
    const archetypes = await import("../archetypes/registry.js");
    registerArchetype = archetypes.registerArchetype;
    __resetRegistryForTests = archetypes.__resetRegistryForTests;
    const registryModule = await import("./agent-registry.js");
    AgentRegistry = registryModule.AgentRegistry;
  });

  beforeEach(() => {
    __resetRegistryForTests();
    registerArchetype({
      id: "test-arch",
      validateConfig: (c: unknown) => {
        const cfg = (c ?? {}) as { workshop?: string };
        if (typeof cfg.workshop !== "string") {
          throw new Error("missing workshop");
        }
        return cfg;
      },
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
  });

  it("loads agent with valid archetypeConfig and reflects validator return value", async () => {
    const def = makeDefinition({
      _id: "valid-agent",
      archetype: "test-arch",
      archetypeConfig: { workshop: "/tmp/workshop" },
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    expect(result.added).toContain("valid-agent");
    const loaded = registry.get("valid-agent");
    expect(loaded).toBeDefined();
    expect(loaded?.archetype).toBe("test-arch");
    expect(loaded?.archetypeConfig).toEqual({ workshop: "/tmp/workshop" });
  });

  it("fails closed on invalid archetypeConfig (agent not added to active map)", async () => {
    const def = makeDefinition({
      _id: "invalid-agent",
      archetype: "test-arch",
      archetypeConfig: {},
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    expect(result.added).not.toContain("invalid-agent");
    expect(registry.get("invalid-agent")).toBeUndefined();
    expect(registry.getAll().map((a) => a.id)).not.toContain("invalid-agent");
  });

  it("evicts a previously-loaded agent when its archetypeConfig becomes invalid on reload", async () => {
    // Round 1: doc is valid, agent loads.
    const validDef = makeDefinition({
      _id: "evicted-agent",
      archetype: "test-arch",
      archetypeConfig: { workshop: "/tmp/workshop" },
    });
    const docs: AgentDefinition[] = [validDef];
    const collection = {
      find: () => ({ toArray: async () => docs }),
    } as unknown as Collection<AgentDefinition>;

    const registry = new AgentRegistry(collection);
    await registry.load();
    expect(registry.get("evicted-agent")).toBeDefined();

    // Round 2: same id, but archetypeConfig is now invalid (simulates DB corruption
    // or a relay edit gone wrong). The previously-loaded valid version must
    // NOT keep serving requests.
    docs[0] = makeDefinition({
      _id: "evicted-agent",
      archetype: "test-arch",
      archetypeConfig: {}, // missing workshop — validateConfig throws
    });
    const result = await registry.load();

    expect(result.removed).toContain("evicted-agent");
    expect(registry.get("evicted-agent")).toBeUndefined();
    expect(registry.getAll().map((a) => a.id)).not.toContain("evicted-agent");
  });

  it("degrades gracefully on unknown archetype id", async () => {
    const def = makeDefinition({
      _id: "unknown-arch-agent",
      archetype: "missing",
      archetypeConfig: { workshop: "/tmp/x" },
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    expect(result.added).toContain("unknown-arch-agent");
    const loaded = registry.get("unknown-arch-agent");
    expect(loaded).toBeDefined();
    expect(loaded?.archetype).toBeUndefined();
    expect(loaded?.archetypeConfig).toBeUndefined();
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

describe("origin routing", () => {
  it("findByOrigin returns the catching agent", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({ _id: "production-support", name: "Sige", catches: ["dodi-shop"] }),
        makeDefinition({ _id: "executive-assistant", name: "Rae" }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")?.id).toBe("production-support");
  });

  it("findByOrigin returns undefined for unknown slug", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({ _id: "production-support", name: "Sige", catches: ["dodi-shop"] }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("unknown")).toBeUndefined();
  });

  it("first-sorted agent wins on origin conflict", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({ _id: "zeta", name: "Zeta", catches: ["shared"] }),
        makeDefinition({ _id: "alpha", name: "Alpha", catches: ["shared"] }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("shared")?.id).toBe("alpha");
  });

  it("disabled agents do not catch origins", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({
          _id: "production-support",
          name: "Sige",
          catches: ["dodi-shop"],
          disabled: true,
        }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")).toBeUndefined();
  });

  it("reload picks up new catches entries", async () => {
    // makeFakeCollection returns a closure over a mutable docs array — mutate
    // it directly between load() calls to simulate a DB update.
    const docs = [makeDefinition({ _id: "production-support", name: "Sige" })];
    const col = makeFakeCollection(docs);
    const registry = new AgentRegistry(col);
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")).toBeUndefined();

    docs[0] = makeDefinition({ _id: "production-support", name: "Sige", catches: ["dodi-shop"] });
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")?.id).toBe("production-support");
  });
});

describe("AgentRegistry post-reload subscribers", () => {
  it("onPostReload handlers fire after load() commits state", async () => {
    const reg = new AgentRegistry(
      makeFakeCollection([makeDefinition({ _id: "rae", name: "Rae" })]),
    );
    let observedIds: string[] = [];
    reg.onPostReload(() => {
      // listIds() observable inside the handler — state already committed
      observedIds = reg.listIds();
    });
    await reg.load();
    expect(observedIds).toEqual(["rae"]);
  });

  it("multiple handlers all fire", async () => {
    const reg = new AgentRegistry(makeFakeCollection([]));
    const a = vi.fn();
    const b = vi.fn();
    reg.onPostReload(a);
    reg.onPostReload(b);
    await reg.load();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("a throwing handler does not prevent later handlers from firing", async () => {
    const reg = new AgentRegistry(makeFakeCollection([]));
    const second = vi.fn();
    reg.onPostReload(() => {
      throw new Error("boom");
    });
    reg.onPostReload(second);
    await reg.load();
    expect(second).toHaveBeenCalledOnce();
  });
});
