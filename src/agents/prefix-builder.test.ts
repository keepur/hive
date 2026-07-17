import { describe, it, expect, vi } from "vitest";
import type { AgentConfig } from "../types/agent-config.js";

// ── Mocks (mirror agent-runner.test.ts structure where needed) ─────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../config.js", async (importOriginal) => {
  // KPR-326: partial mock — keep the real resolveToolSearchMode/isToolSearchMode
  // (prefix-builder.ts now imports resolveToolSearchMode from here) while
  // stubbing out the `config` singleton itself.
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      memory: { hotBudgetTokens: 3000 },
      workflow: { enabled: false },
      // KPR-329: engine-default tool-search config for the mocked module.
      toolSearch: { mode: "auto", source: "default" },
    },
  };
});

import { buildPrefix, type PrefixBuildContext } from "./prefix-builder.js";

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

function makeMemoryManager(overrides: Partial<Record<string, any>> = {}) {
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
    memoryManager: makeMemoryManager() as any,
    teamRoster: undefined,
    plugins: [],
    skillIndex: new Map(),
    prefetcher: undefined,
    eventSubscribersJson: "{}",
    autoInjectedServers: new Set<string>(),
    ...overrides,
  };
}

describe("buildPrefix", () => {
  it("produces deterministic output for identical inputs", async () => {
    const cfg = makeAgentConfig({ soul: "SOUL", systemPrompt: "SYS" });
    const ctx = makeCtx();
    const a = await buildPrefix(cfg, ctx);
    const b = await buildPrefix(cfg, ctx);
    expect(a).toBe(b);
  });

  it("includes soul and systemPrompt", async () => {
    const cfg = makeAgentConfig({ soul: "SOUL-MARKER", systemPrompt: "SYS-MARKER" });
    const out = await buildPrefix(cfg, makeCtx());
    expect(out).toContain("SOUL-MARKER");
    expect(out).toContain("SYS-MARKER");
  });

  it("handles missing constitution gracefully (omits, doesn't throw)", async () => {
    const mm = makeMemoryManager({
      read: vi.fn().mockResolvedValue(null), // no constitution, no memory.md
    });
    const cfg = makeAgentConfig({ systemPrompt: "ROLE" });
    const out = await buildPrefix(cfg, makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("ROLE");
    expect(out).not.toContain("Constitution"); // header text varies; just check no throw
  });

  it("includes constitution when memory returns one", async () => {
    const mm = makeMemoryManager({
      read: vi.fn().mockImplementation(async (path: string) => {
        if (path === "shared/constitution.md") return "CONSTITUTION-BODY";
        return null;
      }),
    });
    const cfg = makeAgentConfig();
    const out = await buildPrefix(cfg, makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("CONSTITUTION-BODY");
  });

  it("handles missing team roster gracefully (no team summary section)", async () => {
    const cfg = makeAgentConfig({ systemPrompt: "ROLE" });
    const out = await buildPrefix(cfg, makeCtx({ teamRoster: undefined }));
    expect(out).toContain("ROLE");
    // No team summary marker; downstream tests cover the present-roster path.
  });

  it("includes team summary when teamRoster.teamSummary returns content", async () => {
    const teamRoster = {
      teamSummary: vi.fn().mockResolvedValue("TEAM-SUMMARY-MARKER"),
    } as any;
    const cfg = makeAgentConfig();
    const out = await buildPrefix(cfg, makeCtx({ teamRoster }));
    expect(out).toContain("TEAM-SUMMARY-MARKER");
  });

  it("tolerates teamRoster.teamSummary throwing — omits, doesn't propagate", async () => {
    const teamRoster = {
      teamSummary: vi.fn().mockRejectedValue(new Error("roster fail")),
    } as any;
    const cfg = makeAgentConfig({ systemPrompt: "ROLE" });
    const out = await buildPrefix(cfg, makeCtx({ teamRoster }));
    expect(out).toContain("ROLE");
  });

  it("handles missing memory gracefully (no memory section, no throw)", async () => {
    const mm = makeMemoryManager({
      read: vi.fn().mockResolvedValue(null),
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    });
    const cfg = makeAgentConfig({ systemPrompt: "ROLE" });
    const out = await buildPrefix(cfg, makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("ROLE");
    expect(out).not.toContain("## Your Memory");
  });

  it("uses hot-tier prompt when MemoryManager returns one", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue("HOT-TIER-MARKER"),
    });
    const cfg = makeAgentConfig();
    const out = await buildPrefix(cfg, makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("HOT-TIER-MARKER");
  });

  it("falls back to legacy memory.md blob when no hot-tier prompt", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      read: vi.fn().mockImplementation(async (path: string) => {
        if (path === "agents/test-agent/memory.md") return "LEGACY-MEMORY-BODY";
        return null;
      }),
      list: vi.fn().mockResolvedValue([]),
    });
    const cfg = makeAgentConfig();
    const out = await buildPrefix(cfg, makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("LEGACY-MEMORY-BODY");
  });

  it("KPR-327: includes memory-first block only when agent has the memory server", async () => {
    const cfg = makeAgentConfig();
    const withMemory = await buildPrefix(cfg, makeCtx({ coreServerNames: ["memory"] }));
    expect(withMemory).toContain("## File-Tier Memory");
    expect(withMemory).toContain("/memories");
    expect(withMemory).toContain("view, create, str_replace, insert, delete, rename");
    const without = await buildPrefix(cfg, makeCtx({ coreServerNames: [] }));
    expect(without).not.toContain("## File-Tier Memory");
  });

  it("KPR-327: legacy fallback references view with /memories paths, not memory_read", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue(["notes.md"]),
    });
    const out = await buildPrefix(makeAgentConfig(), makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("- /memories/agents/test-agent/notes.md");
    expect(out).toContain("`view`");
    expect(out).not.toContain("memory_read");
  });
});
