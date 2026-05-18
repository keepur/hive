import { describe, expect, it } from "vitest";
import { classifyToolTransport } from "./tool-transport.js";

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
    });
  });
});
