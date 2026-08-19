/**
 * KPR-349 (spec §D2): golden byte-parity gate for the Claude-lane prefix.
 *
 * COMMITTED REFACTOR-FREE: these snapshots were generated against the
 * pre-extraction buildPrefix (KPR-213 shape). Any snapshot churn in a later
 * commit is a Claude-lane parity break BY DEFINITION — fix the refactor,
 * never update the snapshots. The fixture matrix covers every branch in
 * buildPrefix; inputs are deterministic mocks so bytes are machine-stable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentConfig } from "../types/agent-config.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      memory: { hotBudgetTokens: 3000 },
      workflow: { enabled: false },
      toolSearch: { mode: "auto", source: "default" },
    },
  };
});

import { buildPrefix, type PrefixBuildContext } from "./prefix-builder.js";
import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";
import type { ArchetypeDefinition } from "../archetypes/registry.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "golden-agent",
    name: "GoldenAgent",
    model: "claude-haiku-4-5",
    channels: ["agent-golden"],
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
    systemPrompt: "GOLDEN-SYSTEM-PROMPT: you are the golden fixture agent.",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function makeMemoryManager(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    read: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    getHotTierPrompt: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PrefixBuildContext> = {}): PrefixBuildContext {
  return {
    coreServerNames: [],
    activeDelegateNames: [],
    memoryManager: makeMemoryManager() as never,
    teamRoster: undefined,
    plugins: [],
    skillIndex: new Map(),
    prefetcher: undefined,
    eventSubscribersJson: "{}",
    autoInjectedServers: new Set<string>(),
    ...overrides,
  };
}

/** Deterministic hot-tier block — the EXACT shape getHotTierPrompt renders
 *  (memory-manager.ts:107-127) including the fused memory_recall trailer. */
const HOT_TIER_FIXTURE = [
  "## Your Memory",
  "### Key Facts\n- [2026-07-01] Golden fact one (high)\n- [2026-07-02] Golden fact two (medium)",
  "### Pinned\n- Golden pinned entry (high, pinned)",
  "---\nYou have 7 additional memories available via `memory_recall`. Use it to search for context before starting tasks.",
].join("\n\n");

const GOLDEN_ARCHETYPE: ArchetypeDefinition = {
  id: "golden-archetype",
  validateConfig: (c) => c,
  systemPromptCard: () => "GOLDEN-ARCHETYPE-CARD: fixture discipline card.",
  preToolUseHooks: () => [],
  memoryScopes: () => [],
  sessionOptions: () => ({}),
};

const THROWING_ARCHETYPE: ArchetypeDefinition = {
  ...GOLDEN_ARCHETYPE,
  id: "throwing-archetype",
  systemPromptCard: () => {
    throw new Error("card exploded");
  },
};

beforeEach(() => {
  __resetRegistryForTests();
  registerArchetype(GOLDEN_ARCHETYPE);
  registerArchetype(THROWING_ARCHETYPE);
});
afterEach(() => __resetRegistryForTests());

describe("buildPrefix golden byte-parity (KPR-349 §D2 — snapshot-first)", () => {
  it("G1: bare-bones agent (no soul/archetype/roster/memory)", async () => {
    expect(await buildPrefix(makeAgentConfig(), makeCtx())).toMatchSnapshot();
  });

  it("G2: soul + constitution present", async () => {
    const ctx = makeCtx({
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "shared/constitution.md" ? "GOLDEN-CONSTITUTION: rule one." : null),
        ),
      }) as never,
    });
    expect(await buildPrefix(makeAgentConfig({ soul: "GOLDEN-SOUL: warm, precise." }), ctx)).toMatchSnapshot();
  });

  it("G3: archetype card rendered (archetypeConfig present)", async () => {
    const cfg = makeAgentConfig({ archetype: "golden-archetype", archetypeConfig: { k: "v" } });
    expect(await buildPrefix(cfg, makeCtx())).toMatchSnapshot();
  });

  it("G4: archetype card throws → omitted, rest of prefix intact", async () => {
    const cfg = makeAgentConfig({ archetype: "throwing-archetype", archetypeConfig: { k: "v" } });
    const out = await buildPrefix(cfg, makeCtx());
    expect(out).not.toContain("GOLDEN-ARCHETYPE-CARD");
    expect(out).toMatchSnapshot();
  });

  it("G5: archetype id resolves but archetypeConfig absent → card skipped (prefix-builder.ts:75 conjunction)", async () => {
    const cfg = makeAgentConfig({ archetype: "golden-archetype" }); // no archetypeConfig
    const out = await buildPrefix(cfg, makeCtx());
    expect(out).not.toContain("GOLDEN-ARCHETYPE-CARD");
    expect(out).toMatchSnapshot();
  });

  it("G6: team summary present", async () => {
    const ctx = makeCtx({
      teamRoster: { teamSummary: vi.fn().mockResolvedValue("GOLDEN-TEAM: roster of two.") } as never,
    });
    expect(await buildPrefix(makeAgentConfig(), ctx)).toMatchSnapshot();
  });

  it("G7: team summary throws → omitted", async () => {
    const ctx = makeCtx({
      teamRoster: { teamSummary: vi.fn().mockRejectedValue(new Error("roster down")) } as never,
    });
    const out = await buildPrefix(makeAgentConfig(), ctx);
    expect(out).not.toContain("GOLDEN-TEAM");
    expect(out).toMatchSnapshot();
  });

  it("G8: memory in coreServers → file-tier guidance + hot-tier block", async () => {
    const ctx = makeCtx({
      coreServerNames: ["memory", "structured-memory"],
      memoryManager: makeMemoryManager({
        getHotTierPrompt: vi.fn().mockResolvedValue(HOT_TIER_FIXTURE),
      }) as never,
    });
    const out = await buildPrefix(makeAgentConfig({ coreServers: ["memory"] }), ctx);
    expect(out).toContain("## File-Tier Memory");
    expect(out).toContain("memory_recall");
    expect(out).toMatchSnapshot();
  });

  it("G9: legacy memory.md + extra files fallback (hot tier null)", async () => {
    const ctx = makeCtx({
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "agents/golden-agent/memory.md" ? "GOLDEN-LEGACY-MEMORY body." : null),
        ),
        list: vi.fn().mockResolvedValue(["memory.md", "projects.md", "contacts.md", "notes.txt"]),
      }) as never,
    });
    const out = await buildPrefix(makeAgentConfig(), ctx);
    expect(out).toContain("## Available Memory Files");
    expect(out).toContain("Read relevant files via the memory MCP server (`view`)");
    expect(out).toMatchSnapshot();
  });

  it("G10: toolkit subsections — core + plugins + delegates + auto-injected", async () => {
    const ctx = makeCtx({
      coreServerNames: ["schedule", "team", "contacts", "golden-plugin-server"],
      activeDelegateNames: ["crm-search"],
      autoInjectedServers: new Set(["schedule", "team", "team-roster"]),
      plugins: [
        {
          manifest: {
            mcpServers: { "golden-plugin-server": { description: "golden plugin capability" } },
          },
        } as never,
      ],
    });
    const out = await buildPrefix(makeAgentConfig({ coreServers: ["contacts"] }), ctx);
    expect(out).toContain("### Delegated capability MCPs");
    expect(out).toMatchSnapshot();
  });

  it("G11: toolSearch off vs auto — byte-identical today (hint dark), pinned", async () => {
    const ctx = makeCtx();
    const offOut = await buildPrefix(makeAgentConfig({ toolSearch: "off" }), ctx);
    const autoOut = await buildPrefix(makeAgentConfig({ toolSearch: "auto" }), ctx);
    expect(offOut).toBe(autoOut); // TOOLKIT_DEFERRED_HINT stays dark (toolkit-section.ts:120)
    expect(offOut).toMatchSnapshot();
  });

  it("G12: kitchen sink — every layer at once", async () => {
    const ctx = makeCtx({
      coreServerNames: ["memory", "schedule", "team", "contacts"],
      activeDelegateNames: ["crm-search"],
      autoInjectedServers: new Set(["schedule", "team", "team-roster"]),
      teamRoster: { teamSummary: vi.fn().mockResolvedValue("GOLDEN-TEAM: roster of two.") } as never,
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "shared/constitution.md" ? "GOLDEN-CONSTITUTION: rule one." : null),
        ),
        getHotTierPrompt: vi.fn().mockResolvedValue(HOT_TIER_FIXTURE),
      }) as never,
    });
    const cfg = makeAgentConfig({
      soul: "GOLDEN-SOUL: warm, precise.",
      archetype: "golden-archetype",
      archetypeConfig: { k: "v" },
      coreServers: ["memory", "contacts"],
    });
    expect(await buildPrefix(cfg, ctx)).toMatchSnapshot();
  });
});
