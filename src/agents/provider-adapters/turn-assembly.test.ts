import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentConfig } from "../../types/agent-config.js";
import type { AgentRunner } from "../agent-runner.js";
import { registerArchetype } from "../../archetypes/registry.js";
import { classifyThrown, TurnAssemblyError } from "./error-classification.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import {
  assembleProviderTurn,
  buildDefaultGuardrailGate,
  buildPilotInstructions,
} from "./turn-assembly.js";

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

function makeRunner(
  inventory: HiveToolInventoryEntry[] | (() => HiveToolInventoryEntry[]),
  extra: Partial<Pick<AgentRunner, "buildInProcessServers" | "resolveTurnCwd">> = {},
): AgentRunner {
  const impl = typeof inventory === "function" ? inventory : () => inventory;
  return {
    buildToolTransportInventory: vi.fn(impl),
    buildInProcessServers: extra.buildInProcessServers ?? vi.fn(() => ({})),
    resolveTurnCwd: extra.resolveTurnCwd ?? vi.fn(() => "/tmp/kpr348-assembly-cwd"),
  } as unknown as AgentRunner;
}

beforeEach(() => vi.clearAllMocks());

describe("assembleProviderTurn (KPR-347 §D1.4)", () => {
  it("instructions are byte-identical to buildPilotInstructions; inventory partitioned; placeholders empty", async () => {
    const bridgeable = makeEntry();
    const omittedEntry = makeEntry({
      name: "Bash", transport: "claude-builtin", inProcess: false, requiresHiveRuntime: false,
      compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
      schemas: { kind: "unavailable" },
    });
    const plantedServers = { memory: { instance: {} } } as never;
    const assembly = await assembleProviderTurn({
      runner: makeRunner([bridgeable, omittedEntry], {
        buildInProcessServers: vi.fn(() => plantedServers),
        resolveTurnCwd: vi.fn(() => "/tmp/kpr348-planted-cwd"),
      }),
      config: makeAgentConfig(),
      provider: "openai",
    });
    expect(assembly.instructions).toBe(buildPilotInstructions("Pilot", "pilot soul", "pilot system"));
    expect(assembly.instructions).toBe("pilot soul\n\npilot system");
    expect(assembly.toolInventory).toEqual([bridgeable]);
    expect(assembly.omittedTools).toEqual([{ name: "Bash", transport: "claude-builtin", compatibility: "claude-only" }]);
    expect(assembly.memory).toEqual({});
    expect(assembly.skillIndex).toEqual([]);
    // KPR-348: the assembly carries the in-process servers + resolved cwd.
    expect(assembly.inProcessServers).toBe(plantedServers);
    expect(assembly.sessionCwd).toBe("/tmp/kpr348-planted-cwd");
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
});

describe("buildDefaultGuardrailGate (KPR-347 §D1.5, T8)", () => {
  it("archetype-less agent → allow-all (mirror of the Claude lane's no-hooks state)", async () => {
    const gate = buildDefaultGuardrailGate(makeAgentConfig());
    await expect(gate({ toolName: "anything", input: {} })).resolves.toEqual({ behavior: "allow" });
  });

  it("archetyped agent (def + config both present) → deny-all with the KPR-348 reason", async () => {
    registerArchetype({
      id: "kpr347-stub",
      validateConfig: (c: unknown) => c,
      preToolUseHooks: () => [],
      systemPromptCard: () => "",
    } as never);
    const gate = buildDefaultGuardrailGate(
      makeAgentConfig({ archetype: "kpr347-stub", archetypeConfig: {} }),
    );
    const decision = await gate({ toolName: "Bash", input: { command: "ls" } });
    expect(decision).toEqual({
      behavior: "deny",
      reason: "Archetype tool policy (kpr347-stub) is not yet enforced on the native provider lane; tool blocked fail-closed (KPR-348).",
    });
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
