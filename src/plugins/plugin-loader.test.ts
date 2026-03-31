import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPlugins, normalizeManifest } from "./plugin-loader.js";
import { existsSync, readFileSync } from "node:fs";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("normalizeManifest", () => {
  it("normalizes a full manifest with all fields", () => {
    const raw = {
      name: "test-plugin",
      description: "A test plugin",
      "mcp-servers": {
        "my-server": {
          entry: "mcp-servers/my-server/index.ts",
          env: ["API_KEY"],
          "env-map": { SERVER_URL: "BASE_URL" },
          "agent-env": { MODE: "agentMode" },
        },
      },
      "agents-templates": ["agent-a", "agent-b"],
    };

    const result = normalizeManifest(raw);

    expect(result.name).toBe("test-plugin");
    expect(result.description).toBe("A test plugin");
    expect(result.agentSeeds).toEqual(["agent-a", "agent-b"]);
    expect(result.mcpServers["my-server"]).toEqual({
      entry: "mcp-servers/my-server/index.ts",
      description: undefined,
      env: ["API_KEY"],
      envMap: { SERVER_URL: "BASE_URL" },
      agentEnv: { MODE: "agentMode" },
    });
  });

  it("passes through server description when present", () => {
    const raw = {
      name: "desc-plugin",
      "mcp-servers": {
        "crm-server": {
          entry: "mcp-servers/crm/index.ts",
          description: "CRM operations — contacts, deals, notes",
        },
      },
    };
    const result = normalizeManifest(raw);
    expect(result.mcpServers["crm-server"].description).toBe("CRM operations — contacts, deals, notes");
  });

  it("defaults missing fields", () => {
    const result = normalizeManifest({});
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.mcpServers).toEqual({});
    expect(result.agentSeeds).toEqual([]);
  });

  it("defaults missing server sub-fields", () => {
    const raw = {
      "mcp-servers": {
        simple: { entry: "index.ts" },
      },
    };
    const result = normalizeManifest(raw);
    expect(result.mcpServers.simple).toEqual({
      entry: "index.ts",
      description: undefined,
      env: [],
      envMap: {},
      agentEnv: {},
    });
  });
});

describe("loadPlugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips plugins with missing manifest", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = loadPlugins(["missing-plugin"], "/root");
    expect(result).toEqual([]);
  });

  it("loads a valid plugin", () => {
    const manifestYaml = `
name: test
description: Test plugin
mcp-servers:
  my-server:
    entry: mcp-servers/my-server/index.ts
    env: [API_KEY]
agents-templates:
  - my-agent
`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["test"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test");
    expect(result[0].manifest.mcpServers["my-server"].entry).toBe("mcp-servers/my-server/index.ts");
    expect(result[0].manifest.agentSeeds).toEqual(["my-agent"]);
  });

  it("sets dir to resolved plugin path", () => {
    const manifestYaml = `name: foo\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["foo"], "/root");
    expect(result).toHaveLength(1);
    // dir should be /root/plugins/foo (resolved)
    expect(result[0].dir).toContain("plugins");
    expect(result[0].dir).toContain("foo");
  });

  it("loads multiple plugins and skips invalid ones", () => {
    const manifestYaml = `name: good\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      // Only the second plugin's manifest exists
      return String(path).includes("good");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["bad", "good"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good");
  });
});
