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

import {
  buildPrefix,
  type PrefixBuildContext,
  appendDateTimeTrailer,
  formatDateTimeTrailer,
  TURN_TRAILER_JOINER,
  SECTION_JOINER,
  renderMemoryBlock,
  memoryDigest,
  shouldInjectMemory,
  composeTurnInput,
  fileTierMemoryGuidance,
  MEMORY_TURN_HEADER,
} from "./prefix-builder.js";

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

  it("KPR-434: a rendered hot tier never enters the prefix (it rides the turn input)", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue("## Your Memory\nHOT-TIER-MARKER"),
    });
    const out = await buildPrefix(makeAgentConfig(), makeCtx({ memoryManager: mm as any, coreServerNames: ["memory"] }));
    expect(out).not.toContain("HOT-TIER-MARKER");
    expect(out).not.toContain("## Your Memory");
    expect(out).toContain("delivered in the conversation");
    expect(out).not.toContain("already injected in this prompt");
    expect(mm.getHotTierPrompt).not.toHaveBeenCalled(); // the prefix reads no agent memory at all
  });

  it("KPR-434: legacy memory.md + file listing never enter the prefix either", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      read: vi.fn().mockImplementation(async (path: string) => (path === "agents/test-agent/memory.md" ? "LEGACY-MEMORY-BODY" : null)),
      list: vi.fn().mockResolvedValue(["memory.md", "notes.md"]),
    });
    const out = await buildPrefix(makeAgentConfig(), makeCtx({ memoryManager: mm as any }));
    expect(out).not.toContain("LEGACY-MEMORY-BODY");
    expect(out).not.toContain("## Available Memory Files");
    expect(mm.list).not.toHaveBeenCalled();
    expect(mm.read).toHaveBeenCalledWith("shared/constitution.md"); // the ONLY memoryManager read left in the prefix
    expect(mm.read).not.toHaveBeenCalledWith("agents/test-agent/memory.md");
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

  it("KPR-327/KPR-434: legacy fallback block references view with /memories paths, not memory_read", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue(["notes.md"]),
    });
    const r = await renderMemoryBlock(mm as any, "test-agent", { toolsExecutable: true });
    expect(r!.block).toContain("- /memories/agents/test-agent/notes.md");
    expect(r!.block).toContain("`view`");
    expect(r!.block).not.toContain("memory_read");
  });
});

describe("appendDateTimeTrailer (KPR-432)", () => {
  it("is <prompt> + TURN_TRAILER_JOINER + formatDateTimeTrailer(now), bytes-exact", () => {
    const now = new Date("2026-09-04T17:17:01Z"); // 10:17 AM PDT
    expect(TURN_TRAILER_JOINER).toBe("\n\n");
    expect(appendDateTimeTrailer("hello", now)).toBe(`hello\n\n${formatDateTimeTrailer(now)}`);
    expect(appendDateTimeTrailer("hello", now)).toMatch(
      /^hello\n\n\*\*Current date\/time\*\*: Friday, September 4, 2026 at 10:17 AM \(Pacific Time\)$/,
    );
  });
});

describe("KPR-434 D1 helpers", () => {
  const NOW = new Date("2026-09-05T17:17:01Z"); // 10:17 AM PDT
  const PRE_434_GUIDANCE =
    "## File-Tier Memory\n" +
    "You have a file-tier memory at `/memories` (tools: view, create, str_replace, insert, delete, rename). " +
    "Your hot-tier memory is already injected in this prompt — do **not** re-`view` files to rediscover what's already here. " +
    "`view` file-tier paths when a task needs detail beyond the hot tier, and record durable file-worthy material there.";

  it("shouldInjectMemory truth table: no digest ⇒ false; no sessionId ⇒ true; equal ⇒ false; differ ⇒ true; resumed without a mark ⇒ true", () => {
    expect(shouldInjectMemory({ sessionId: undefined, digest: undefined })).toBe(false);
    expect(shouldInjectMemory({ sessionId: "s", digest: undefined, memoryDigestSeen: "d" })).toBe(false);
    expect(shouldInjectMemory({ sessionId: undefined, digest: "d" })).toBe(true);
    expect(shouldInjectMemory({ sessionId: "s", digest: "d", memoryDigestSeen: "d" })).toBe(false);
    expect(shouldInjectMemory({ sessionId: "s", digest: "d", memoryDigestSeen: "e" })).toBe(true);
    expect(shouldInjectMemory({ sessionId: "s", digest: "d", memoryDigestSeen: undefined })).toBe(true);
  });

  it("memoryDigest is stable and 16 lowercase hex chars; distinct inputs differ", () => {
    expect(memoryDigest("## Your Memory\nA")).toBe(memoryDigest("## Your Memory\nA"));
    expect(memoryDigest("## Your Memory\nA")).toMatch(/^[0-9a-f]{16}$/);
    expect(memoryDigest("## Your Memory\nA")).not.toBe(memoryDigest("## Your Memory\nB"));
  });

  it("renderMemoryBlock: undefined on no blocks", async () => {
    const mm = makeMemoryManager();
    expect(await renderMemoryBlock(mm as any, "test-agent", { toolsExecutable: true })).toBeUndefined();
  });

  it("renderMemoryBlock: hot tier ⇒ block === hotTierPrompt, hotTierPrompt passed through, digest matches", async () => {
    const mm = makeMemoryManager({ getHotTierPrompt: vi.fn().mockResolvedValue("## Your Memory\nHOT") });
    const r = await renderMemoryBlock(mm as any, "test-agent", { toolsExecutable: true });
    expect(r).toEqual({
      block: "## Your Memory\nHOT",
      digest: memoryDigest("## Your Memory\nHOT"),
      hotTierPrompt: "## Your Memory\nHOT",
    });
    expect(mm.getHotTierPrompt).toHaveBeenCalledWith("test-agent", 3000, undefined); // Claude-lane two-arg shape preserved
  });

  it("renderMemoryBlock: legacy fallback joins memory.md + file listing with SECTION_JOINER, no hotTierPrompt key", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      read: vi.fn().mockImplementation(async (p: string) => (p === "agents/test-agent/memory.md" ? "LEGACY-BODY" : null)),
      list: vi.fn().mockResolvedValue(["memory.md", "notes.md"]),
    });
    const r = await renderMemoryBlock(mm as any, "test-agent", { toolsExecutable: true });
    expect(r!.block.split(SECTION_JOINER)).toHaveLength(2);
    expect(r!.block.startsWith("## Your Memory\nLEGACY-BODY")).toBe(true);
    expect(r!.block).toContain("## Available Memory Files");
    expect(r!.block).toContain("- /memories/agents/test-agent/notes.md");
    expect(r!.digest).toBe(memoryDigest(r!.block));
    expect(r).not.toHaveProperty("hotTierPrompt");
  });

  it("composeTurnInput bytes: memory first, message, datetime last; memory-less === appendDateTimeTrailer (KPR-432 T4 pin survives)", () => {
    expect(composeTurnInput({ prompt: "hi", memoryBlock: "## Your Memory\nA", now: NOW })).toBe(
      `${MEMORY_TURN_HEADER}\n\n## Your Memory\nA\n\nhi\n\n${formatDateTimeTrailer(NOW)}`,
    );
    expect(composeTurnInput({ prompt: "hi", now: NOW })).toBe(appendDateTimeTrailer("hi", NOW));
    expect(composeTurnInput({ prompt: "hi", memoryBlock: "M", datetime: false })).toBe(
      `${MEMORY_TURN_HEADER}\n\nM\n\nhi`,
    );
    expect(composeTurnInput({ prompt: "hi", datetime: false })).toBe("hi");
  });

  it("fileTierMemoryGuidance: 'instructions' is the pre-434 string byte-for-byte; 'conversation' tells the truth", () => {
    expect(fileTierMemoryGuidance("instructions")).toBe(PRE_434_GUIDANCE);
    const conv = fileTierMemoryGuidance("conversation");
    expect(conv).toContain("delivered in the conversation");
    expect(conv).toContain("when present");
    expect(conv).not.toContain("already injected in this prompt");
    expect(conv.startsWith("## File-Tier Memory\nYou have a file-tier memory at `/memories`")).toBe(true);
    expect(conv.endsWith("record durable file-worthy material there.")).toBe(true);
  });

  it("MEMORY_TURN_HEADER wording (exported bytes, KPR-417 precedent)", () => {
    expect(MEMORY_TURN_HEADER).toContain("Your memory");
    expect(MEMORY_TURN_HEADER).toContain("may occasionally be repeated");
    expect(MEMORY_TURN_HEADER).toContain("supersedes any earlier memory block");
    expect(MEMORY_TURN_HEADER).not.toContain("hot tier");
    expect(MEMORY_TURN_HEADER).not.toContain("is not repeated");
  });
});
