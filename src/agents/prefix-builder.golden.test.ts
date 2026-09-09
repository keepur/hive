/**
 * KPR-349 (spec §D2): golden byte-parity gate for the Claude-lane prefix.
 *
 * COMMITTED REFACTOR-FREE: these snapshots were generated against the
 * pre-extraction buildPrefix (KPR-213 shape) and RE-PINNED ONCE in KPR-434
 * (D7) at the post-434 shape — agent memory (hot tier / legacy memory.md +
 * file listing) rides the turn input, so the `## Your Memory` /
 * `## Available Memory Files` sections left the prefix and the file-tier
 * guidance sentence was reworded ("delivered in the conversation"). G8, G9 and
 * G12 moved in that one sanctioned commit; nothing else did.
 *
 * RE-PINNED A SECOND TIME in KPR-435 — the archetype system was removed from
 * the engine, so its prefix-section helper and its slot in the layer order
 * are gone. G3/G4/G5 (the three archetype-card branch cases) were deleted and
 * their snapshot entries removed as obsolete; G12 lost exactly the one
 * archetype-card fixture line and its one SECTION_JOINER — the pre-re-pin
 * diff was verified to contain nothing else, and the .snap diff is a PURE
 * DELETION (no added bytes anywhere). Every other entry, G1 included, is
 * byte-unchanged. G1's title still reads "no soul/archetype/roster/memory":
 * that is deliberate — it documents the negative-space case and is also the
 * .snap entry key, so renaming it would force an unrelated re-pin. This file
 * and its .snap are named exceptions on KPR-435's archetype-scrub sweep.
 *
 * The standing rule is unchanged in spirit: any snapshot churn that is NOT
 * carried by an explicit, ticketed prefix-shape change like the two above is a
 * Claude-lane parity break BY DEFINITION — fix the refactor, never update the
 * snapshots. The fixture matrix covers every branch in buildPrefix; inputs are
 * deterministic mocks so bytes are machine-stable. HOT_TIER_FIXTURE stays: it
 * is the renderMemoryBlock shape.
 */
import { describe, it, expect, vi } from "vitest";
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
    autonomy: { externalComms: true, codeAccess: false },
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

  // KPR-434: the hot-tier block left the prefix (it rides the turn input); the guidance sentence reads "delivered in the conversation".
  it("G8: memory in coreServers → file-tier guidance + hot-tier block", async () => {
    const ctx = makeCtx({
      coreServerNames: ["memory", "structured-memory"],
      memoryManager: makeMemoryManager({
        getHotTierPrompt: vi.fn().mockResolvedValue(HOT_TIER_FIXTURE),
      }) as never,
    });
    const out = await buildPrefix(makeAgentConfig({ coreServers: ["memory"] }), ctx);
    expect(out).toContain("## File-Tier Memory");
    expect(out).not.toContain("memory_recall");
    expect(out).not.toContain("## Your Memory");
    expect(out).toContain("delivered in the conversation");
    expect(out).toMatchSnapshot();
  });

  // KPR-434: legacy memory.md + the file listing left the prefix too (renderMemoryBlock carries them).
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
    expect(out).not.toContain("## Available Memory Files");
    expect(out).not.toContain("Read relevant files via the memory MCP server (`view`)");
    expect(out).not.toContain("GOLDEN-LEGACY-MEMORY");
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
      coreServers: ["memory", "contacts"],
    });
    expect(await buildPrefix(cfg, ctx)).toMatchSnapshot();
  });
});
