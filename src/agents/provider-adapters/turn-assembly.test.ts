import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import type { AgentConfig } from "../../types/agent-config.js";
import type { AgentRunner } from "../agent-runner.js";
import { registerArchetype } from "../../archetypes/registry.js";
import { classifyThrown, TurnAssemblyError } from "./error-classification.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import {
  assembleProviderTurn,
  buildDefaultGuardrailGate,
  TOOL_EXECUTING_PROVIDERS,
} from "./turn-assembly.js";
import {
  ProviderCircuitBreakerRegistry,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "../provider-circuit-breaker.js";

const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: mockLogInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "pilot", name: "Pilot", model: "openai/gpt-5.4-mini",
    channels: [], passiveChannels: [], keywords: [], isDefault: false,
    schedule: [], budgetUsd: 10, maxTurns: 25, coreServers: [], delegateServers: [],
    icon: "", soul: "pilot soul", systemPrompt: "pilot system",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
  return {
    name: "memory", transport: "sdk-in-process", source: "core",
    requiresTurnContext: false, requiresHiveRuntime: true, inProcess: true,
    compatibility: {
      claude: "direct", openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge", codex: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
    ...overrides,
  };
}

type RunnerExtra = Partial<
  Pick<AgentRunner, "buildInProcessServers" | "resolveTurnCwd" | "buildProviderPrompt">
>;

function makeRunner(
  inventory: HiveToolInventoryEntry[] | (() => HiveToolInventoryEntry[]),
  extra: RunnerExtra = {},
): AgentRunner {
  const impl = typeof inventory === "function" ? inventory : () => inventory;
  return {
    buildToolTransportInventory: vi.fn(impl),
    buildInProcessServers: extra.buildInProcessServers ?? vi.fn(() => ({})),
    resolveTurnCwd: extra.resolveTurnCwd ?? vi.fn(() => "/tmp/kpr348-assembly-cwd"),
    buildProviderPrompt:
      extra.buildProviderPrompt ??
      vi.fn(async () => ({
        instructions: "ASSEMBLED-INSTRUCTIONS\n\n---\n\n**Current date/time**: fixture (Pacific Time)",
        hotTierPrompt: "HOT-TIER-BLOCK",
        skillEntries: [{ name: "fixture-skill", description: "d", path: "/tmp/fixture/SKILL.md" }],
      })),
  } as unknown as AgentRunner;
}

beforeEach(() => vi.clearAllMocks());

describe("assembleProviderTurn (KPR-347 §D1.4 / KPR-349 §D1/§D3)", () => {
  it("KPR-349 inversion: instructions come from buildProviderPrompt; memory + skillIndex populated; inventory partitioned", async () => {
    const bridgeable = makeEntry();
    const omittedEntry = makeEntry({
      name: "Bash", transport: "claude-builtin", inProcess: false, requiresHiveRuntime: false,
      compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
      schemas: { kind: "unavailable" },
    });
    const plantedServers = { memory: { instance: {} } } as never;
    const runner = makeRunner([bridgeable, omittedEntry], {
      buildInProcessServers: vi.fn(() => plantedServers),
      resolveTurnCwd: vi.fn(() => "/tmp/kpr348-planted-cwd"),
    });
    const assembly = await assembleProviderTurn({
      runner,
      config: makeAgentConfig(),
      provider: "openai",
    });
    // Instructions are the runner-assembled prompt (NOT the old soul\n\nsystem shape).
    expect(assembly.instructions).toContain("ASSEMBLED-INSTRUCTIONS");
    expect(assembly.instructions).toMatch(/\*\*Current date\/time\*\*: .+ \(Pacific Time\)$/);
    expect(assembly.instructions).not.toBe("pilot soul\n\npilot system");
    expect(assembly.toolInventory).toEqual([bridgeable]);
    expect(assembly.omittedTools).toEqual([{ name: "Bash", transport: "claude-builtin", compatibility: "claude-only" }]);
    expect(assembly.memory).toEqual({ hotTierPrompt: "HOT-TIER-BLOCK" });
    expect(assembly.skillIndex).toEqual([{ name: "fixture-skill", description: "d", path: "/tmp/fixture/SKILL.md" }]);
    // buildProviderPrompt receives the PARTITIONED (bridgeable) inventory + toolsExecutable:true for openai.
    expect(runner.buildProviderPrompt as unknown as Mock).toHaveBeenCalledWith({
      toolInventory: [bridgeable],
      toolsExecutable: true,
    });
    // KPR-348: the assembly carries the in-process servers + resolved cwd.
    expect(assembly.inProcessServers).toBe(plantedServers);
    expect(assembly.sessionCwd).toBe("/tmp/kpr348-planted-cwd");
  });

  it("KPR-353 §D1: TOOL_EXECUTING_PROVIDERS is exactly {openai, codex} (352 grows it with the gemini flip)", () => {
    expect(TOOL_EXECUTING_PROVIDERS).toEqual(new Set(["openai", "codex"]));
  });

  it("KPR-349 §D3: toolsExecutable false for gemini (pre-352)", async () => {
    const runner = makeRunner([makeEntry()]);
    await assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "gemini" });
    expect(runner.buildProviderPrompt as unknown as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ toolsExecutable: false }),
    );
  });

  it("KPR-353 §D1: toolsExecutable TRUE for codex (flip commit — same commit as the adapter's tools flip)", async () => {
    const runner = makeRunner([makeEntry()]);
    await assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "codex" });
    expect(runner.buildProviderPrompt as unknown as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ toolsExecutable: true }),
    );
  });

  it("KPR-349: runner returning hotTierPrompt undefined → assembly.memory is {} (347 optional-field shape preserved)", async () => {
    const runner = makeRunner([makeEntry()], {
      buildProviderPrompt: vi.fn(async () => ({
        instructions: "X\n\n---\n\n**Current date/time**: fixture (Pacific Time)",
        hotTierPrompt: undefined,
        skillEntries: [],
      })),
    });
    const assembly = await assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "openai" });
    expect(assembly.memory).toEqual({});
    expect(assembly.skillIndex).toEqual([]);
  });

  it("KPR-348: a resolveTurnCwd throw rejects with TurnAssemblyError (classifies non-provider)", async () => {
    const promise = assembleProviderTurn({
      runner: makeRunner([], {
        resolveTurnCwd: vi.fn(() => {
          throw new Error("Archetype cwd unavailable at session start — refusing to run");
        }),
      }),
      config: makeAgentConfig(),
      provider: "openai",
    });
    await expect(promise).rejects.toBeInstanceOf(TurnAssemblyError);
    const err = await promise.catch((e: unknown) => e);
    expect(classifyThrown(err)).toMatchObject({ outcome: "fault", kind: "non-provider" });
  });

  it("omission log carries names + reasons only — never serverConfig/env values (§edge: serverConfig secrecy)", async () => {
    const secretEntry = makeEntry({
      name: "quo", transport: "stdio", inProcess: false, requiresHiveRuntime: false,
      compatibility: { claude: "direct", openai: "unsupported", gemini: "unsupported", codex: "unsupported" },
      serverConfig: { type: "stdio", command: "quo", args: [], env: { QUO_API_KEY: "hunter2" } } as never,
    });
    await assembleProviderTurn({ runner: makeRunner([secretEntry]), config: makeAgentConfig(), provider: "openai" });
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("hunter2");
    expect(JSON.stringify(mockLogInfo.mock.calls)).toContain("quo:unsupported");
  });

  it("T5: an inventory-build throw rejects with TurnAssemblyError and classifies non-provider", async () => {
    const promise = assembleProviderTurn({
      runner: makeRunner(() => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:27017");
      }),
      config: makeAgentConfig(),
      provider: "gemini",
    });
    await expect(promise).rejects.toBeInstanceOf(TurnAssemblyError);
    const err = await promise.catch((e: unknown) => e);
    expect(classifyThrown(err)).toMatchObject({ outcome: "fault", kind: "non-provider" });
  });

  it("T7: buildProviderPrompt rejecting with a Mongo error → TurnAssemblyError → non-provider; openai breaker stays closed after 3", async () => {
    const runner = makeRunner([makeEntry()], {
      buildProviderPrompt: vi.fn(async () => {
        throw new Error("MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017");
      }),
    });
    const promise = assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "openai" });
    await expect(promise).rejects.toBeInstanceOf(TurnAssemblyError);
    const err = await promise.catch((e: unknown) => e);
    const classification = classifyThrown(err);
    expect(classification).toMatchObject({ outcome: "fault", kind: "non-provider" });

    // Feed the classified fault through a real breaker 3× — non-provider must
    // never trip a healthy foreign provider's circuit (§D9).
    const registry = new ProviderCircuitBreakerRegistry(DEFAULT_CIRCUIT_BREAKER_CONFIG, () => 0);
    for (let i = 0; i < 3; i++) {
      const permit = registry.acquire("openai");
      registry.record(permit, classification, 0);
    }
    expect(registry.stateFor("openai")?.state).toBe("closed");
  });

  it("T7b: buildProviderPrompt throwing SYNCHRONOUSLY is still wrapped as TurnAssemblyError", async () => {
    const runner = makeRunner([makeEntry()], {
      // Not `async` — throws synchronously when invoked, before returning a promise.
      buildProviderPrompt: vi.fn(() => {
        throw new Error("synchronous boom inside buildProviderPrompt");
      }) as never,
    });
    const promise = assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "openai" });
    await expect(promise).rejects.toBeInstanceOf(TurnAssemblyError);
    const err = await promise.catch((e: unknown) => e);
    expect(classifyThrown(err)).toMatchObject({ outcome: "fault", kind: "non-provider" });
  });
});

describe("buildDefaultGuardrailGate (KPR-347 §D1.5, T8)", () => {
  it("archetype-less agent → allow-all (mirror of the Claude lane's no-hooks state)", async () => {
    const gate = buildDefaultGuardrailGate(makeAgentConfig());
    await expect(gate({ toolName: "anything", input: {} })).resolves.toEqual({ behavior: "allow" });
  });

  // KPR-348: the KPR-347 "archetyped agent ⇒ deny-all placeholder" assertion is
  // RELOCATED (not deleted) — the placeholder body is gone; the archetyped path
  // now ports buildHooks' real evaluation. The remaining fail-closed obligation
  // this test pins is: a matcher-production throw ⇒ deny-all (canon 6 fallback).
  it("archetyped agent whose preToolUseHooks throws at production → deny-all (fail-closed port of buildHooks)", async () => {
    registerArchetype({
      id: "kpr348-throwing-stub",
      validateConfig: (c: unknown) => c,
      preToolUseHooks: () => {
        throw new Error("boom at production");
      },
      systemPromptCard: () => "",
    } as never);
    const gate = buildDefaultGuardrailGate(
      makeAgentConfig({ archetype: "kpr348-throwing-stub", archetypeConfig: {} }),
    );
    const decision = await gate({ toolName: "Bash", input: { command: "ls" } });
    expect(decision.behavior).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("Archetype hook initialization failed");
  });

  it("archetype id that does not resolve → allow-all (unreachable post-registry-sanitization; posture matches buildHooks)", async () => {
    const gate = buildDefaultGuardrailGate(
      makeAgentConfig({ archetype: "no-such-archetype", archetypeConfig: {} }),
    );
    await expect(gate({ toolName: "x", input: null })).resolves.toEqual({ behavior: "allow" });
  });

  it("gate never throws for well-formed input", async () => {
    const gate = buildDefaultGuardrailGate(makeAgentConfig());
    await expect(gate({ toolName: "", input: undefined })).resolves.toBeDefined();
  });
});
