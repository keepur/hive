/**
 * KPR-349 (spec §D1/§D3): Lane B instruction-builder tests. The load-bearing
 * invariant this file exists to prove is the MEMORY TOOL-CLAIM GATE — a
 * non-executing provider must never see `memory_recall`, the "memory MCP
 * server" sentence, or any other claim of a tool it cannot call, while the
 * memory CONTENT (records, counts, file paths) still renders.
 *
 * Standalone: its own local scaffolding, NOT imported from the golden file.
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

import {
  buildProviderInstructions,
  skillsSection,
  SECTION_JOINER,
  type ProviderInstructionsInput,
} from "./prefix-builder.js";
import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";
import type { ArchetypeDefinition } from "../archetypes/registry.js";
import type { HiveToolInventoryEntry } from "./provider-adapters/tool-transport.js";
import type { ProviderSkillIndexEntry } from "./provider-adapters/turn-assembly.js";
import { BUILTIN_TOOL_DEFINITIONS } from "./provider-adapters/builtin-executor.js";

// ── Fixtures ────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "golden-agent",
    name: "GoldenAgent",
    model: "openai/gpt-5.4-mini",
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

function makeEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
  return {
    name: "memory",
    transport: "sdk-in-process",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: true,
    inProcess: true,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
    ...overrides,
  };
}

const builtinEntry = (): HiveToolInventoryEntry =>
  makeEntry({
    name: "__builtins__",
    transport: "claude-builtin",
    source: "sdk-builtin",
    inProcess: false,
    requiresHiveRuntime: false,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "static", tools: BUILTIN_TOOL_DEFINITIONS },
  });

const engineEntry = (name: string): HiveToolInventoryEntry =>
  makeEntry({ name, transport: "http", source: "engine", inProcess: false, requiresHiveRuntime: false });

const subagentEntry = (): HiveToolInventoryEntry =>
  makeEntry({
    name: "__subagent__",
    transport: "claude-subagent",
    source: "delegate",
    inProcess: false,
    requiresHiveRuntime: false,
    schemas: { kind: "unavailable" },
  });

const SKILLS: ProviderSkillIndexEntry[] = [
  { name: "greet", description: "Say hello", path: "/skills/greet/SKILL.md" },
  { name: "close-deal", description: "Move a lead to close", path: "/skills/close-deal/SKILL.md" },
];

/** Hot-tier mock that honors the §D5 opts contract (executable vs gated). */
function honestHotTier() {
  return vi.fn().mockImplementation((_agentId: string, _budget: number, opts?: { recallToolName?: string | null }) => {
    const body = "## Your Memory\n\n### Key Facts\n- [2026-07-01] Golden fact (high)";
    const recall = opts?.recallToolName;
    let trailer: string;
    if (recall === null) {
      trailer = "---\nYou have 7 additional memories.";
    } else if (recall === undefined) {
      trailer = "---\nYou have 7 additional memories available via `memory_recall`. Use it to search for context before starting tasks.";
    } else {
      trailer = `---\nYou have 7 additional memories available via \`${recall}\`. Use it to search for context before starting tasks.`;
    }
    return Promise.resolve(`${body}\n\n${trailer}`);
  });
}

/** memoryManager whose legacy fallback fires (hot tier null → memory.md + files). */
function legacyFallbackMemory() {
  return makeMemoryManager({
    getHotTierPrompt: vi.fn().mockResolvedValue(null),
    read: vi.fn().mockImplementation((p: string) =>
      Promise.resolve(p === "agents/golden-agent/memory.md" ? "GOLDEN-LEGACY-MEMORY body." : null),
    ),
    list: vi.fn().mockResolvedValue(["memory.md", "projects.md", "contacts.md", "notes.txt"]),
  });
}

function makeInput(overrides: Partial<ProviderInstructionsInput> = {}): ProviderInstructionsInput {
  return {
    toolInventory: [],
    skillIndex: [],
    toolsExecutable: false,
    memoryManager: makeMemoryManager() as never,
    teamRoster: undefined,
    plugins: [],
    ...overrides,
  };
}

const GOLDEN_ARCHETYPE: ArchetypeDefinition = {
  id: "golden-archetype",
  validateConfig: (c) => c,
  systemPromptCard: () => "GOLDEN-ARCHETYPE-CARD: fixture discipline card.",
  preToolUseHooks: () => [],
  memoryScopes: () => [],
  sessionOptions: () => ({}),
};

beforeEach(() => {
  __resetRegistryForTests();
  registerArchetype(GOLDEN_ARCHETYPE);
});
afterEach(() => __resetRegistryForTests());

// ── Composition / order ─────────────────────────────────────────────

describe("buildProviderInstructions — composition / order", () => {
  function richInput(toolsExecutable: boolean): { cfg: AgentConfig; input: ProviderInstructionsInput } {
    const cfg = makeAgentConfig({
      soul: "GOLDEN-SOUL: warm, precise.",
      archetype: "golden-archetype",
      archetypeConfig: { k: "v" },
    });
    const input = makeInput({
      toolInventory: [makeEntry({ name: "memory" }), engineEntry("slack"), builtinEntry()],
      skillIndex: SKILLS,
      toolsExecutable,
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "shared/constitution.md" ? "GOLDEN-CONSTITUTION: rule one." : null),
        ),
        getHotTierPrompt: honestHotTier(),
      }) as never,
      teamRoster: { teamSummary: vi.fn().mockResolvedValue("GOLDEN-TEAM: roster of two.") } as never,
    });
    return { cfg, input };
  }

  it("full assembly renders every layer in spec order, datetime last", async () => {
    const { cfg, input } = richInput(true);
    const { instructions } = await buildProviderInstructions(cfg, input);

    const order = [
      "GOLDEN-SOUL",
      "GOLDEN-ARCHETYPE-CARD",
      "GOLDEN-SYSTEM-PROMPT",
      "GOLDEN-CONSTITUTION",
      "GOLDEN-TEAM",
      "## Your toolkit",
      "## File-Tier Memory",
      "## Your skills",
      "## Your Memory",
      "**Current date/time**",
    ].map((s) => instructions.indexOf(s));

    for (let i = 0; i < order.length; i++) expect(order[i]).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]!);

    expect(instructions).toMatch(/\*\*Current date\/time\*\*: .+ \(Pacific Time\)$/);
  });

  it("sections are joined by \\n\\n---\\n\\n (joiners = sections − 1)", async () => {
    const { cfg, input } = richInput(true);
    const { instructions } = await buildProviderInstructions(cfg, input);
    // 10 sections: soul, card, systemPrompt, constitution, team, toolkit,
    // file-tier, skills, memory, datetime → 9 joiners.
    const joinerCount = instructions.split(SECTION_JOINER).length - 1;
    expect(joinerCount).toBe(9);
  });

  it("hotTierPrompt is returned alongside the folded-in instructions", async () => {
    const { cfg, input } = richInput(true);
    const result = await buildProviderInstructions(cfg, input);
    expect(result.hotTierPrompt).toContain("## Your Memory");
    expect(result.instructions).toContain(result.hotTierPrompt!);
  });

  it("bare-bones agent → systemPrompt + datetime only, no 'You are ' fallback", async () => {
    const cfg = makeAgentConfig({ soul: "" });
    const { instructions } = await buildProviderInstructions(cfg, makeInput({ toolsExecutable: false }));
    const parts = instructions.split(SECTION_JOINER);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("GOLDEN-SYSTEM-PROMPT: you are the golden fixture agent.");
    expect(parts[1]).toMatch(/^\*\*Current date\/time\*\*: .+ \(Pacific Time\)$/);
    expect(instructions).not.toContain("You are GoldenAgent");
  });
});

// ── † gate ──────────────────────────────────────────────────────────

describe("buildProviderInstructions — toolsExecutable gate", () => {
  const richInputs = () =>
    makeInput({
      toolInventory: [makeEntry({ name: "memory" }), engineEntry("slack")],
      skillIndex: SKILLS,
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "shared/constitution.md" ? "GOLDEN-CONSTITUTION: rule one." : null),
        ),
        getHotTierPrompt: honestHotTier(),
      }) as never,
      teamRoster: { teamSummary: vi.fn().mockResolvedValue("GOLDEN-TEAM: roster of two.") } as never,
    });

  it("false → no toolkit, no file-tier, no skills; constitution/roster/memory still present", async () => {
    const input = richInputs();
    input.toolsExecutable = false;
    const { instructions } = await buildProviderInstructions(makeAgentConfig(), input);
    expect(instructions).not.toContain("## Your toolkit");
    expect(instructions).not.toContain("## File-Tier Memory");
    expect(instructions).not.toContain("## Your skills");
    expect(instructions).toContain("GOLDEN-CONSTITUTION");
    expect(instructions).toContain("GOLDEN-TEAM");
    expect(instructions).toContain("## Your Memory");
  });

  it("true + empty skill index → no skills section", async () => {
    const input = richInputs();
    input.toolsExecutable = true;
    input.skillIndex = [];
    const { instructions } = await buildProviderInstructions(makeAgentConfig(), input);
    expect(instructions).toContain("## Your toolkit");
    expect(instructions).not.toContain("## Your skills");
  });

  it("true + no memory entry in inventory → no file-tier guidance (hot tier still renders)", async () => {
    const input = richInputs();
    input.toolsExecutable = true;
    input.toolInventory = [engineEntry("slack")]; // no `memory` entry
    const { instructions } = await buildProviderInstructions(makeAgentConfig(), input);
    expect(instructions).not.toContain("## File-Tier Memory");
    expect(instructions).toContain("## Your Memory"); // injection is memoryManager-side
  });
});

// ── Memory tool-claim gate (the invariant this chunk exists to prove) ─

describe("buildProviderInstructions — memory tool-claim gate", () => {
  it("toolsExecutable false → hot-tier trailer leaks no tool claim, content stays", async () => {
    const mm = makeMemoryManager({ getHotTierPrompt: honestHotTier() });
    const { instructions } = await buildProviderInstructions(
      makeAgentConfig(),
      makeInput({ toolsExecutable: false, memoryManager: mm as never }),
    );
    expect(instructions).not.toContain("memory_recall");
    expect(instructions).not.toContain("memory MCP server");
    // Content survives.
    expect(instructions).toContain("Golden fact");
    expect(instructions).toContain("You have 7 additional memories.");
    // The builder passed the gate option through.
    expect(mm.getHotTierPrompt).toHaveBeenCalledWith("golden-agent", 3000, { recallToolName: null });
  });

  it("toolsExecutable true → passes the qualified bridged recall tool name (option a)", async () => {
    const mm = makeMemoryManager({ getHotTierPrompt: honestHotTier() });
    const { instructions } = await buildProviderInstructions(
      makeAgentConfig(),
      makeInput({
        toolsExecutable: true,
        toolInventory: [makeEntry({ name: "memory" })],
        memoryManager: mm as never,
      }),
    );
    expect(mm.getHotTierPrompt).toHaveBeenCalledWith("golden-agent", 3000, {
      recallToolName: "mcp__structured-memory__memory_recall",
    });
    expect(instructions).toContain("mcp__structured-memory__memory_recall");
    expect(instructions).not.toContain("`memory_recall`"); // bare form absent
  });

  it("legacy fallback, toolsExecutable true → memory MCP server (view) sentence present + paths", async () => {
    const { instructions } = await buildProviderInstructions(
      makeAgentConfig(),
      makeInput({ toolsExecutable: true, memoryManager: legacyFallbackMemory() as never }),
    );
    expect(instructions).toContain("Read relevant files via the memory MCP server (`view`)");
    expect(instructions).toContain("/memories/agents/golden-agent/projects.md");
  });

  it("legacy fallback gated, toolsExecutable false → paths present, tool sentence absent", async () => {
    const { instructions } = await buildProviderInstructions(
      makeAgentConfig(),
      makeInput({ toolsExecutable: false, memoryManager: legacyFallbackMemory() as never }),
    );
    expect(instructions).toContain("/memories/agents/golden-agent/projects.md");
    expect(instructions).toContain("GOLDEN-LEGACY-MEMORY body.");
    expect(instructions).not.toContain("memory MCP server");
    expect(instructions).not.toContain("via the memory");
  });
});

// ── Toolkit honesty ─────────────────────────────────────────────────

describe("buildProviderInstructions — toolkit honesty", () => {
  it("Lane B toolkit never advertises Claude-CLI-only builtins; delegates render via the Task tool (KPR-354 §D6)", async () => {
    const { instructions } = await buildProviderInstructions(
      makeAgentConfig(),
      makeInput({
        toolsExecutable: true,
        toolInventory: [builtinEntry(), makeEntry({ name: "memory" }), engineEntry("slack"), subagentEntry()],
      }),
    );
    // Claude-CLI-only builtins are partition-omitted from Lane B.
    for (const forbidden of ["WebFetch", "WebSearch", "NotebookEdit", "TodoWrite"]) {
      expect(instructions).not.toContain(forbidden);
    }
    // The six executor builtins DO render as per-tool lines.
    expect(instructions).toContain("- Bash — run shell commands");
    // KPR-354 §D6: claude-subagent entries render the delegated section via-Task.
    expect(instructions).toContain("### Delegated capability MCPs (via the Task tool)");
    expect(instructions).toContain("- __subagent__ — __subagent__");
  });
});

describe("skillsSection unit", () => {
  it("renders the header, teaching sentence, and one line per skill", () => {
    const out = skillsSection(SKILLS);
    expect(out).toBe(
      "## Your skills\n" +
        "Named procedures for specific jobs. When a task matches one, call load_skill with its name FIRST and follow the returned instructions.\n" +
        "- greet — Say hello\n- close-deal — Move a lead to close",
    );
  });
});

// ── Fault posture ───────────────────────────────────────────────────

describe("buildProviderInstructions — fault posture", () => {
  it("a getHotTierPrompt rejection escapes the builder (rejects)", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockRejectedValue(new Error("mongo down")),
    });
    await expect(
      buildProviderInstructions(makeAgentConfig(), makeInput({ memoryManager: mm as never })),
    ).rejects.toThrow("mongo down");
  });

  it("null constitution + throwing teamSummary → omit-and-continue, no throw", async () => {
    const input = makeInput({
      teamRoster: { teamSummary: vi.fn().mockRejectedValue(new Error("roster down")) } as never,
    });
    const { instructions } = await buildProviderInstructions(makeAgentConfig(), input);
    expect(instructions).toContain("GOLDEN-SYSTEM-PROMPT");
    expect(instructions).not.toContain("GOLDEN-TEAM");
    expect(instructions).not.toContain("GOLDEN-CONSTITUTION");
  });
});
