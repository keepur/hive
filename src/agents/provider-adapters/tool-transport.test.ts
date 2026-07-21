import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  classifyToolTransport,
  partitionInventoryForProvider,
  type HiveToolInventoryEntry,
  type OmittedToolRecord,
} from "./tool-transport.js";

describe("classifyToolTransport", () => {
  it.each(["stdio", "http", "sse"] as const)(
    "marks %s MCP transports as direct for Claude and bridge candidates for non-Claude providers",
    (transport) => {
      const descriptor = classifyToolTransport({
        name: `${transport}-tool`,
        transport,
        source: "core",
      });

      expect(descriptor.compatibility).toEqual({
        claude: "direct",
        openai: "mcp-bridge-candidate",
        gemini: "mcp-bridge-candidate",
        codex: "mcp-bridge-candidate",
      });
      expect(descriptor.requiresTurnContext).toBe(false);
      expect(descriptor.requiresHiveRuntime).toBe(false);
      expect(descriptor.inProcess).toBe(false);
    },
  );

  it("marks turn-context-dependent MCP servers as requiring a Hive bridge", () => {
    const descriptor = classifyToolTransport({
      name: "background",
      transport: "stdio",
      source: "core",
      requiresTurnContext: true,
    });

    expect(descriptor.requiresTurnContext).toBe(true);
    expect(descriptor.requiresHiveRuntime).toBe(false);
    expect(descriptor.compatibility.openai).toBe("requires-hive-bridge");
    expect(descriptor.compatibility.gemini).toBe("requires-hive-bridge");
  });

  it("keeps Hive runtime dependency separate from turn context", () => {
    const descriptor = classifyToolTransport({
      name: "memory",
      transport: "stdio",
      source: "core",
      requiresHiveRuntime: true,
    });

    expect(descriptor.requiresTurnContext).toBe(false);
    expect(descriptor.requiresHiveRuntime).toBe(true);
    expect(descriptor.compatibility.openai).toBe("requires-hive-bridge");
    expect(descriptor.compatibility.gemini).toBe("requires-hive-bridge");
  });

  it("marks SDK in-process servers as Hive-runtime-backed", () => {
    const descriptor = classifyToolTransport({
      name: "schedule",
      transport: "sdk-in-process",
      source: "engine",
    });

    expect(descriptor.inProcess).toBe(true);
    expect(descriptor.requiresHiveRuntime).toBe(true);
    expect(descriptor.requiresTurnContext).toBe(false);
    expect(descriptor.compatibility).toEqual({
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    });
  });

  it.each(["claude-builtin", "claude-subagent"] as const)(
    "marks %s as Claude-only outside Claude",
    (transport) => {
      const descriptor = classifyToolTransport({
        name: transport === "claude-builtin" ? "Bash" : "google",
        transport,
        source: transport === "claude-builtin" ? "sdk-builtin" : "delegate",
      });

      expect(descriptor.compatibility).toEqual({
        claude: "direct",
        openai: "claude-only",
        gemini: "claude-only",
        codex: "claude-only",
      });
    },
  );

  it("can classify broken transports as unsupported for diagnostics", () => {
    const descriptor = classifyToolTransport({
      name: "broken-plugin",
      transport: "stdio",
      source: "plugin",
      broken: true,
    });

    expect(descriptor.compatibility).toEqual({
      claude: "unsupported",
      openai: "unsupported",
      gemini: "unsupported",
      codex: "unsupported",
    });
  });

  // T3 codex-column pin: codex tracks openai at every classify site. Pinned so
  // future divergence is a deliberate test edit (spec T3), never an accident.
  it.each([
    { name: "stdio-tool", input: { transport: "stdio" } },
    { name: "http-tool", input: { transport: "http" } },
    { name: "sse-tool", input: { transport: "sse" } },
    { name: "in-process", input: { transport: "sdk-in-process" } },
    { name: "builtin", input: { transport: "claude-builtin", source: "sdk-builtin" } },
    { name: "subagent", input: { transport: "claude-subagent", source: "delegate" } },
    { name: "broken", input: { transport: "stdio", broken: true } },
  ] as const)("codex === openai for $name", ({ name, input }) => {
    const descriptor = classifyToolTransport({
      name,
      source: "core",
      ...input,
    });
    expect(descriptor.compatibility.codex).toBe(descriptor.compatibility.openai);
  });
});

function makeEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
  return {
    name: "tool",
    transport: "stdio",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: "mcp-bridge-candidate",
      gemini: "mcp-bridge-candidate",
      codex: "mcp-bridge-candidate",
    },
    schemas: { kind: "connect-time" },
    ...overrides,
  };
}

describe("partitionInventoryForProvider (KPR-347)", () => {
  // 1. Each compatibility class × each LaneBProviderId.
  const bridgeableClasses = ["direct", "mcp-bridge-candidate", "requires-hive-bridge"] as const;
  const omittedClasses = ["claude-only", "unsupported"] as const;
  const providers = ["openai", "gemini", "codex"] as const;

  it.each(
    bridgeableClasses.flatMap((cls) => providers.map((provider) => ({ cls, provider }))),
  )("$cls lands in bridgeable for $provider", ({ cls, provider }) => {
    const entry = makeEntry({
      compatibility: { claude: "direct", openai: cls, gemini: cls, codex: cls },
    });
    const { bridgeable, omitted } = partitionInventoryForProvider([entry], provider);
    expect(bridgeable).toEqual([entry]);
    expect(omitted).toEqual([]);
  });

  it.each(
    omittedClasses.flatMap((cls) => providers.map((provider) => ({ cls, provider }))),
  )("$cls lands in omitted for $provider with name/transport/compatibility", ({ cls, provider }) => {
    const entry = makeEntry({
      name: "gated",
      transport: "claude-builtin",
      compatibility: { claude: "direct", openai: cls, gemini: cls, codex: cls },
    });
    const { bridgeable, omitted } = partitionInventoryForProvider([entry], provider);
    expect(bridgeable).toEqual([]);
    expect(omitted).toEqual<OmittedToolRecord[]>([
      { name: "gated", transport: "claude-builtin", compatibility: cls },
    ]);
  });

  // 2. Per-provider divergence: the codex column is genuinely consulted.
  it("consults the codex column independently of openai", () => {
    const entry = makeEntry({
      compatibility: {
        claude: "direct",
        openai: "mcp-bridge-candidate",
        gemini: "mcp-bridge-candidate",
        codex: "claude-only",
      },
    });
    expect(partitionInventoryForProvider([entry], "openai").bridgeable).toEqual([entry]);
    const codexResult = partitionInventoryForProvider([entry], "codex");
    expect(codexResult.bridgeable).toEqual([]);
    expect(codexResult.omitted).toEqual<OmittedToolRecord[]>([
      { name: entry.name, transport: entry.transport, compatibility: "claude-only" },
    ]);
  });

  // 3. Order preservation.
  it("preserves input order in both partitions", () => {
    const a = makeEntry({ name: "a" });
    const b = makeEntry({
      name: "b",
      transport: "claude-builtin",
      compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
    });
    const c = makeEntry({ name: "c" });
    const { bridgeable, omitted } = partitionInventoryForProvider([a, b, c], "openai");
    expect(bridgeable.map((e) => e.name)).toEqual(["a", "c"]);
    expect(omitted.map((e) => e.name)).toEqual(["b"]);
  });

  // 4. Empty input.
  it("returns empty partitions for empty input", () => {
    expect(partitionInventoryForProvider([], "openai")).toEqual({ bridgeable: [], omitted: [] });
  });

  // 5. serverConfig secrecy (T7 half): omitted records never leak configs/env.
  it("omitted records carry names + reasons only — never serverConfig/env values", () => {
    const entry = makeEntry({
      name: "quo",
      transport: "stdio",
      compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
      serverConfig: {
        type: "stdio",
        command: "x",
        args: [],
        env: { SECRET_TOKEN: "hunter2" },
      } as McpServerConfig,
    });
    const { omitted } = partitionInventoryForProvider([entry], "codex");
    expect(JSON.stringify(omitted)).not.toContain("hunter2");
    expect(Object.keys(omitted[0]!)).toEqual(["name", "transport", "compatibility"]);
  });
});
