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
    // KPR-220 Phase 17: maxConcurrent is no longer materialized to a default
    // by toAgentConfig (it would make the spawnBudgetFor fallback chain's
    // engine-default branch unreachable). The field passes through as
    // undefined; spawnBudgetFor handles the absence directly.
    expect(config.maxConcurrent).toBeUndefined();
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

describe("AgentRegistry roles[] warning on load", () => {
  beforeAll(async () => {
    const registryModule = await import("./agent-registry.js");
    AgentRegistry = registryModule.AgentRegistry;
  });

  function captureWarnings(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        if (text.includes(`"level":"warn"`)) warnings.push(text);
        return true;
      });
    return {
      warnings,
      restore: () => spy.mockRestore(),
    };
  }

  it("warns when an active agent has empty roles[]", async () => {
    const { warnings, restore } = captureWarnings();
    try {
      const registry = new AgentRegistry(
        makeFakeCollection([makeDefinition({ _id: "no-roles", name: "NoRoles", roles: [] })]),
      );
      await registry.load();
      const matched = warnings.filter(
        (w) => w.includes("Agent has no roles[]") && w.includes(`"id":"no-roles"`),
      );
      expect(matched.length).toBe(1);
    } finally {
      restore();
    }
  });

  it("warns when an active agent has missing roles[]", async () => {
    const { warnings, restore } = captureWarnings();
    try {
      const def = makeDefinition({ _id: "missing-roles", name: "MissingRoles" });
      delete (def as Partial<AgentDefinition>).roles;
      const registry = new AgentRegistry(makeFakeCollection([def]));
      await registry.load();
      const matched = warnings.filter(
        (w) => w.includes("Agent has no roles[]") && w.includes(`"id":"missing-roles"`),
      );
      expect(matched.length).toBe(1);
    } finally {
      restore();
    }
  });

  it("does not warn when roles[] is non-empty", async () => {
    const { warnings, restore } = captureWarnings();
    try {
      const registry = new AgentRegistry(
        makeFakeCollection([
          makeDefinition({ _id: "has-roles", name: "HasRoles", roles: ["chief-of-staff"] }),
        ]),
      );
      await registry.load();
      const matched = warnings.filter(
        (w) => w.includes("Agent has no roles[]") && w.includes(`"id":"has-roles"`),
      );
      expect(matched.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("does not warn for disabled agents with empty roles[]", async () => {
    const { warnings, restore } = captureWarnings();
    try {
      const registry = new AgentRegistry(
        makeFakeCollection([
          makeDefinition({
            _id: "disabled-no-roles",
            name: "DisabledNoRoles",
            roles: [],
            disabled: true,
          }),
        ]),
      );
      await registry.load();
      const matched = warnings.filter(
        (w) => w.includes("Agent has no roles[]") && w.includes(`"id":"disabled-no-roles"`),
      );
      expect(matched.length).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("AgentRegistry onPostReload", () => {
  beforeAll(async () => {
    const registryModule = await import("./agent-registry.js");
    AgentRegistry = registryModule.AgentRegistry;
  });

  it("fires after load() commits new state, in subscription order", async () => {
    const calls: string[] = [];
    const registry = new AgentRegistry(
      makeFakeCollection([makeDefinition({ _id: "a-1", name: "A" })]),
    );
    registry.onPostReload(() => calls.push("a"));
    registry.onPostReload(() => calls.push("b"));
    await registry.load();
    expect(calls).toEqual(["a", "b"]);
  });

  it("fires only after rebuildOriginIndex completes — handler sees the new state", async () => {
    const docs = [makeDefinition({ _id: "agent-x", name: "X", catches: ["origin-x"] })];
    const registry = new AgentRegistry(makeFakeCollection(docs));
    let observed: string | undefined;
    registry.onPostReload(() => {
      observed = registry.findByOrigin("origin-x")?.id;
    });
    await registry.load();
    expect(observed).toBe("agent-x");
  });

  it("returns an unsubscribe function", async () => {
    const calls: string[] = [];
    const registry = new AgentRegistry(makeFakeCollection([makeDefinition({ _id: "a-1", name: "A" })]));
    const off = registry.onPostReload(() => calls.push("x"));
    await registry.load();
    expect(calls).toEqual(["x"]);
    off();
    await registry.load();
    expect(calls).toEqual(["x"]); // not fired again
  });

  it("isolates handler errors — later subscribers still fire and load() does not throw", async () => {
    const calls: string[] = [];
    const registry = new AgentRegistry(makeFakeCollection([makeDefinition({ _id: "a-1", name: "A" })]));
    registry.onPostReload(() => {
      throw new Error("boom");
    });
    registry.onPostReload(() => calls.push("after-throw"));
    await expect(registry.load()).resolves.not.toThrow();
    expect(calls).toEqual(["after-throw"]);
  });

  it("fires on every reload", async () => {
    const docs = [makeDefinition({ _id: "a-1", name: "A" })];
    const registry = new AgentRegistry(makeFakeCollection(docs));
    let count = 0;
    registry.onPostReload(() => {
      count++;
    });
    await registry.load();
    await registry.load();
    await registry.load();
    expect(count).toBe(3);
  });
});

describe("KPR-184 — AgentRegistry sanitizes in-process-ported servers from delegateServers", () => {
  beforeAll(async () => {
    const registryModule = await import("./agent-registry.js");
    AgentRegistry = registryModule.AgentRegistry;
  });

  it("strips ported servers from delegateServers and keeps the rest", async () => {
    const def = makeDefinition({
      _id: "mixed-delegate",
      delegateServers: ["memory", "google", "event-bus", "linear"],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    await registry.load();

    const loaded = registry.get("mixed-delegate");
    expect(loaded).toBeDefined();
    expect(loaded?.delegateServers).toEqual(["google", "linear"]);
  });

  it("strips all entries when every delegateServer is ported", async () => {
    const def = makeDefinition({
      _id: "all-ported",
      delegateServers: ["memory", "structured-memory", "team"],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    await registry.load();

    expect(registry.get("all-ported")?.delegateServers).toEqual([]);
  });

  it("leaves clean delegateServers untouched", async () => {
    const def = makeDefinition({
      _id: "clean-delegate",
      delegateServers: ["google", "linear", "clickup"],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    await registry.load();

    expect(registry.get("clean-delegate")?.delegateServers).toEqual([
      "google",
      "linear",
      "clickup",
    ]);
  });

  it("loads agent successfully even when sanitization removes entries", async () => {
    const def = makeDefinition({
      _id: "sanitized-agent",
      delegateServers: ["memory"],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    // Agent still loads — sanitization is non-fatal.
    expect(result.added).toContain("sanitized-agent");
    expect(registry.get("sanitized-agent")).toBeDefined();
  });
});

describe("KPR-221 — AgentRegistry hard-rejects context-dependent servers in delegateServers", () => {
  beforeAll(async () => {
    const registryModule = await import("./agent-registry.js");
    AgentRegistry = registryModule.AgentRegistry;
  });

  // Context-dependent servers that aren't also in IN_PROCESS_PORTED_SERVERS
  // (which the KPR-184 sanitizer strips first). These are uniquely caught
  // by KPR-221's hard-reject. The overlap cases (callback, memory,
  // structured-memory) are stripped by KPR-184's sanitizer and don't reach
  // the hard-reject path — covered by the separate "stripped" test.
  const CONTEXT_DEPENDENT_NEW = ["background", "code-task", "recall"];

  it.each(CONTEXT_DEPENDENT_NEW)("rejects agent with '%s' in delegateServers", async (server) => {
    const def = makeDefinition({
      _id: `bad-${server}-agent`,
      delegateServers: [server],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    // Agent must NOT load — fail-closed.
    expect(result.added).not.toContain(`bad-${server}-agent`);
    expect(registry.get(`bad-${server}-agent`)).toBeUndefined();
  });

  it("rejects agent when context-dependent server is mixed with valid entries", async () => {
    const def = makeDefinition({
      _id: "mixed-context-agent",
      delegateServers: ["google", "background", "linear"],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    expect(result.added).not.toContain("mixed-context-agent");
    expect(registry.get("mixed-context-agent")).toBeUndefined();
  });

  it("evicts a previously-loaded agent if a new load contains a context-dependent server", async () => {
    // First load: clean. Second load: same id but with a bad delegateServer.
    const cleanDocs = [
      makeDefinition({
        _id: "agent-x",
        delegateServers: ["google"],
      }),
    ];
    const dirtyDocs = [
      makeDefinition({
        _id: "agent-x",
        delegateServers: ["google", "recall"],
      }),
    ];

    let activeDocs = cleanDocs;
    const collection = {
      find: () => ({ toArray: async () => activeDocs }),
    } as unknown as Collection<AgentDefinition>;

    const registry = new AgentRegistry(collection);
    await registry.load();
    expect(registry.get("agent-x")).toBeDefined();

    activeDocs = dirtyDocs;
    const result = await registry.load();
    expect(result.removed).toContain("agent-x");
    expect(registry.get("agent-x")).toBeUndefined();
  });

  it("does not abort the entire load when one agent has a bad delegateServer", async () => {
    // Two agents — one bad, one clean. Clean must still load.
    const docs = [
      makeDefinition({ _id: "bad-agent", delegateServers: ["recall"] }),
      makeDefinition({ _id: "clean-agent", delegateServers: ["google"] }),
    ];
    const registry = new AgentRegistry(makeFakeCollection(docs));
    const result = await registry.load();

    expect(registry.get("bad-agent")).toBeUndefined();
    expect(registry.get("clean-agent")).toBeDefined();
    expect(result.added).toContain("clean-agent");
  });

  it("KPR-220 PR #266 fix: a DISABLED agent with a context-dependent delegateServer lands in disabledAgents, not evicted", async () => {
    // Pre-fix: validateDelegateServersOrThrow ran AHEAD of the disabled
    // short-circuit, so a disabled agent with `delegateServers: ["recall"]`
    // got logged as a load failure and was omitted from disabledAgents.
    // That broke the operator-facing "disable first, repair config later"
    // invariant — disabled agents are offline docs, not live configs.
    // Post-fix: the disabled check runs first; validation is skipped for
    // disabled agents.
    //
    // Negative-verify: swap the order back (validateDelegateServersOrThrow
    // before the disabled-check block) → this test fails because the agent
    // is evicted/omitted instead of appearing in disabledAgents.
    const docs = [
      makeDefinition({
        _id: "disabled-with-bad-delegate",
        disabled: true,
        delegateServers: ["recall"],
      }),
    ];
    const registry = new AgentRegistry(makeFakeCollection(docs));
    await registry.load();

    // Disabled agents land in the disabled list (accessed via getDisabled()),
    // not in the active map.
    expect(registry.getDisabled()).toContainEqual(
      expect.objectContaining({ id: "disabled-with-bad-delegate" }),
    );
    expect(registry.get("disabled-with-bad-delegate")).toBeUndefined();
  });

  it("memory, structured-memory, callback are stripped by KPR-184 sanitizer first (no hard-reject)", async () => {
    // KPR-184's sanitizer strips IN_PROCESS_PORTED_SERVERS (which includes
    // memory, structured-memory, and callback) before KPR-221 validation
    // runs, so these load with empty delegateServers rather than getting
    // evicted. The hard-reject path applies only to context-dependent
    // servers that aren't also in-process (background, code-task, recall).
    const def = makeDefinition({
      _id: "in-process-stripped",
      delegateServers: ["memory", "structured-memory", "callback"],
    });
    const registry = new AgentRegistry(makeFakeCollection([def]));
    const result = await registry.load();

    expect(result.added).toContain("in-process-stripped");
    expect(registry.get("in-process-stripped")?.delegateServers).toEqual([]);
  });
});

describe("KPR-221 — validateDelegateServersOrThrow", () => {
  it("throws when a context-dependent server is present", async () => {
    const mod = await import("./agent-registry.js");
    expect(() => mod.validateDelegateServersOrThrow("a", ["callback"])).toThrow(/callback/);
    expect(() => mod.validateDelegateServersOrThrow("a", ["google", "background"])).toThrow(/background/);
  });

  it("does not throw on a clean list", async () => {
    const mod = await import("./agent-registry.js");
    expect(() => mod.validateDelegateServersOrThrow("a", ["google", "linear"])).not.toThrow();
    expect(() => mod.validateDelegateServersOrThrow("a", [])).not.toThrow();
  });

  it("error message names the offending server and the agent id", async () => {
    const mod = await import("./agent-registry.js");
    try {
      mod.validateDelegateServersOrThrow("rae", ["recall", "code-task"]);
      throw new Error("expected throw");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("rae");
      expect(msg).toContain("recall");
      expect(msg).toContain("code-task");
    }
  });
});
