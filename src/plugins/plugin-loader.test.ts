import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPlugins, normalizeManifest, rescanPluginBrokenServers, resolvePluginServerPath } from "./plugin-loader.js";
import type { BrokenServer, LoadedPlugin, PluginMcpServer } from "./types.js";
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
          "secret-env": ["SECRET_TOKEN"],
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
      transport: "stdio",
      entry: "mcp-servers/my-server/index.ts",
      description: undefined,
      usage: undefined,
      notFor: undefined,
      env: ["API_KEY"],
      secretEnv: ["SECRET_TOKEN"],
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

  it("passes through usage and not-for fields from YAML", () => {
    const raw = {
      name: "guide-plugin",
      "mcp-servers": {
        "guide-server": {
          entry: "mcp-servers/guide/index.ts",
          usage: "Finding things by topic",
          "not-for": "Creating records — use write-server instead",
        },
      },
    };
    const result = normalizeManifest(raw);
    expect(result.mcpServers["guide-server"].usage).toBe("Finding things by topic");
    expect(result.mcpServers["guide-server"].notFor).toBe("Creating records — use write-server instead");
  });

  it("defaults missing server sub-fields", () => {
    const raw = {
      "mcp-servers": {
        simple: { entry: "index.ts" },
      },
    };
    const result = normalizeManifest(raw);
    expect(result.mcpServers.simple).toEqual({
      transport: "stdio",
      entry: "index.ts",
      description: undefined,
      usage: undefined,
      notFor: undefined,
      env: [],
      secretEnv: [],
      envMap: {},
      agentEnv: {},
    });
  });

  it("round-trips secret-env (YAML) to secretEnv (TS)", () => {
    const raw = {
      "mcp-servers": {
        s: { entry: "e.ts", "secret-env": ["A", "B", "C"] },
      },
    };
    const result = normalizeManifest(raw);
    const server = result.mcpServers.s;
    if (server.transport === "http") throw new Error("expected stdio");
    expect(server.secretEnv).toEqual(["A", "B", "C"]);
    expect(server.env).toEqual([]);
  });

  describe("transport: http", () => {
    it("normalizes an http server with api-key auth", () => {
      const raw = {
        name: "remote-plugin",
        "mcp-servers": {
          purchasing: {
            transport: "http",
            url: "https://app.example.com/mcp/purchasing",
            description: "Remote purchasing",
            auth: { type: "api-key", "key-source": "agentApiKey" },
          },
        },
      };
      const result = normalizeManifest(raw);
      expect(result.mcpServers.purchasing).toEqual({
        transport: "http",
        url: "https://app.example.com/mcp/purchasing",
        description: "Remote purchasing",
        usage: undefined,
        notFor: undefined,
        auth: { type: "api-key", header: undefined, keySource: "agentApiKey" },
      });
    });

    it("normalizes an http server with bearer auth and a custom header", () => {
      const raw = {
        "mcp-servers": {
          remote: {
            transport: "http",
            url: "https://example.com/mcp",
            auth: { type: "bearer", header: "X-Auth", keySource: "agentApiKey" },
          },
        },
      };
      const result = normalizeManifest(raw);
      const server = result.mcpServers.remote;
      if (server.transport !== "http") throw new Error("expected http");
      expect(server.auth).toEqual({ type: "bearer", header: "X-Auth", keySource: "agentApiKey" });
    });

    it("accepts kebab-case key-source from YAML and camelCase keySource interchangeably", () => {
      const camelRaw = {
        "mcp-servers": {
          r: { transport: "http", url: "https://x/mcp", auth: { type: "api-key", keySource: "agentApiKey" } },
        },
      };
      const result = normalizeManifest(camelRaw);
      const server = result.mcpServers.r;
      if (server.transport !== "http") throw new Error("expected http");
      expect(server.auth.keySource).toBe("agentApiKey");
    });

    it("rejects http server missing url", () => {
      expect(() =>
        normalizeManifest({
          "mcp-servers": { bad: { transport: "http", auth: { type: "api-key", keySource: "agentApiKey" } } },
        }),
      ).toThrow(/requires a 'url'/);
    });

    it("rejects http server missing auth block", () => {
      expect(() =>
        normalizeManifest({
          "mcp-servers": { bad: { transport: "http", url: "https://x/mcp" } },
        }),
      ).toThrow(/requires an 'auth' block/);
    });

    it("rejects unknown auth.type", () => {
      expect(() =>
        normalizeManifest({
          "mcp-servers": {
            bad: { transport: "http", url: "https://x/mcp", auth: { type: "oauth2", keySource: "agentApiKey" } },
          },
        }),
      ).toThrow(/auth.type must be/);
    });

    it("rejects unknown keySource", () => {
      expect(() =>
        normalizeManifest({
          "mcp-servers": {
            bad: { transport: "http", url: "https://x/mcp", auth: { type: "api-key", keySource: "env:OTHER" } },
          },
        }),
      ).toThrow(/auth.keySource must be/);
    });

    it("rejects unknown transport value", () => {
      expect(() => normalizeManifest({ "mcp-servers": { bad: { transport: "websocket", entry: "x.ts" } } })).toThrow(
        /unknown transport/,
      );
    });

    it("rejects stdio server missing entry", () => {
      expect(() => normalizeManifest({ "mcp-servers": { bad: {} } })).toThrow(/requires an 'entry'/);
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
    vi.mocked(existsSync).mockImplementation((path: any) => {
      const p = String(path);
      // In-tree path exists (no node_modules match)
      if (p.includes("node_modules")) return false;
      return p.endsWith("plugin.yaml") || p.includes("foo");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["foo"], "/root");
    expect(result).toHaveLength(1);
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

  it("loads a plugin with no hiveApi field (optional)", () => {
    const manifestYaml = `name: no-api\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["no-api"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].manifest.hiveApi).toBeUndefined();
  });

  it("loads a plugin whose hiveApi caret range accepts the current version", () => {
    // HIVE_PLUGIN_API_VERSION is "1.0.0"; "^1.0.0" accepts 1.x.y
    const manifestYaml = `name: compat\nhiveApi: "^1.0.0"\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["compat"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].manifest.hiveApi).toBe("^1.0.0");
  });

  it("loads a plugin whose hiveApi is an exact version match", () => {
    const manifestYaml = `name: exact\nhiveApi: "1.0.0"\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["exact"], "/root");
    expect(result).toHaveLength(1);
  });

  it("skips a plugin whose hiveApi caret requires a newer major version", () => {
    // HIVE_PLUGIN_API_VERSION is "1.0.0"; "^2.0.0" does not accept 1.x.y
    const manifestYaml = `name: future\nhiveApi: "^2.0.0"\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["future"], "/root");
    expect(result).toEqual([]);
  });

  it("skips a plugin whose hiveApi caret requires a newer minor version", () => {
    // HIVE_PLUGIN_API_VERSION is "1.0.0"; "^1.5.0" requires >= 1.5.0
    const manifestYaml = `name: needs-features\nhiveApi: "^1.5.0"\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["needs-features"], "/root");
    expect(result).toEqual([]);
  });

  it("accepts unrecognized hiveApi range syntax (lenient fallback)", () => {
    // Non-caret, non-exact: logged as warn but plugin still loads
    const manifestYaml = `name: weird\nhiveApi: ">=1.0.0"\n`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["weird"], "/root");
    expect(result).toHaveLength(1);
  });

  it("resolves npm-installed plugin via node_modules/ path", () => {
    const manifestYaml = `name: npm-plugin\nhiveApi: "^1.0.0"\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      // Manifest exists at node_modules path, not in-tree
      return String(path).includes("node_modules/npm-plugin/plugin.yaml");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["npm-plugin"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toContain("node_modules");
    expect(result[0].dir).toContain("npm-plugin");
  });

  it("falls back to in-tree path when node_modules path missing", () => {
    const manifestYaml = `name: intree\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      const p = String(path);
      // Only in-tree manifest exists
      if (p.includes("node_modules")) return false;
      return p.includes("intree");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["intree"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).not.toContain("node_modules");
  });

  it("resolves scoped npm package names", () => {
    const manifestYaml = `name: "@keepur/hive-plugin-foo"\nhiveApi: "^1.0.0"\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      return String(path).includes("node_modules/@keepur/hive-plugin-foo/plugin.yaml");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["@keepur/hive-plugin-foo"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toContain("@keepur");
  });

  it("loads a plugin with an http-transport server without touching the entry resolver", () => {
    const manifestYaml = `
name: remote
mcp-servers:
  purchasing:
    transport: http
    url: https://app.example.com/mcp/purchasing
    auth:
      type: api-key
      key-source: agentApiKey
`;
    // existsSync returns true for the manifest path; nothing else needs to exist
    // — the loader must not even ask the filesystem about a compiled entry.
    vi.mocked(existsSync).mockImplementation((path: any) => String(path).endsWith("plugin.yaml"));
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["remote"], "/root");
    expect(result).toHaveLength(1);
    const server = result[0].manifest.mcpServers.purchasing;
    if (server.transport !== "http") throw new Error("expected http");
    expect(server.url).toBe("https://app.example.com/mcp/purchasing");
    expect(server.auth.type).toBe("api-key");
    expect(result[0].brokenServers).toEqual({});
  });

  it("skips a plugin whose manifest is invalid (e.g. http server missing url)", () => {
    const manifestYaml = `
name: broken
mcp-servers:
  bad:
    transport: http
    auth:
      type: api-key
      key-source: agentApiKey
`;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["broken"], "/root");
    expect(result).toEqual([]);
  });
});

describe("normalizeManifest hiveApi field", () => {
  it("picks up hiveApi camelCase form", () => {
    const result = normalizeManifest({ name: "t", hiveApi: "^1.0.0" });
    expect(result.hiveApi).toBe("^1.0.0");
  });

  it("picks up hive-api kebab-case form as fallback", () => {
    const result = normalizeManifest({ name: "t", "hive-api": "^1.2.3" });
    expect(result.hiveApi).toBe("^1.2.3");
  });

  it("leaves hiveApi undefined when absent", () => {
    const result = normalizeManifest({ name: "t" });
    expect(result.hiveApi).toBeUndefined();
  });
});

describe("resolvePluginServerPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers dev-build path when distDir is set and file exists", () => {
    vi.mocked(existsSync).mockImplementation((path: any) => String(path).startsWith("/dist/plugins/foo/"));
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
      distDir: "/dist",
    });
    expect(r).toEqual({ path: "/dist/plugins/foo/mcp-servers/bar/index.js" });
  });

  it("falls back to npm .min.js when dev build missing", () => {
    vi.mocked(existsSync).mockImplementation(
      (path: any) => String(path) === "/hive/plugins/node_modules/foo/dist/mcp-servers/bar/index.min.js",
    );
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
      distDir: "/dist",
    });
    expect(r).toEqual({
      path: "/hive/plugins/node_modules/foo/dist/mcp-servers/bar/index.min.js",
    });
  });

  it("falls back to npm .js when npm .min.js missing", () => {
    vi.mocked(existsSync).mockImplementation(
      (path: any) => String(path) === "/hive/plugins/node_modules/foo/dist/mcp-servers/bar/index.js",
    );
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
      distDir: "/dist",
    });
    expect(r).toEqual({
      path: "/hive/plugins/node_modules/foo/dist/mcp-servers/bar/index.js",
    });
  });

  it("falls back to in-tree .min.js when npm paths missing", () => {
    vi.mocked(existsSync).mockImplementation(
      (path: any) => String(path) === "/hive/plugins/foo/dist/mcp-servers/bar/index.min.js",
    );
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
    });
    expect(r).toEqual({ path: "/hive/plugins/foo/dist/mcp-servers/bar/index.min.js" });
  });

  // This is tonight's dodi case: user dropped a plugin in, ran `tsc` once,
  // got un-minified `.js` in `dist/`. Without this fallback the engine would
  // silently fail to spawn.
  it("falls back to in-tree .js — the tonight's-dodi case", () => {
    vi.mocked(existsSync).mockImplementation(
      (path: any) => String(path) === "/hive/plugins/foo/dist/mcp-servers/bar/index.js",
    );
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
    });
    expect(r).toEqual({ path: "/hive/plugins/foo/dist/mcp-servers/bar/index.js" });
  });

  it("returns broken with paths tried when nothing resolves", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
      distDir: "/dist",
    });
    expect("reason" in r).toBe(true);
    if ("reason" in r) {
      expect(r.reason).toContain("no compiled entry");
      expect(r.pathsChecked).toHaveLength(5);
      expect(r.pathsChecked[0]).toContain("/dist/plugins/foo/");
      expect(r.pathsChecked.some((p) => p.includes("node_modules"))).toBe(true);
      expect(r.pathsChecked.some((p) => p.endsWith("index.min.js"))).toBe(true);
      expect(r.pathsChecked.some((p) => p.endsWith("index.js"))).toBe(true);
    }
  });

  it("skips dev path when distDir is not provided", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const r = resolvePluginServerPath("foo", "mcp-servers/bar/index.ts", {
      hiveHome: "/hive",
    });
    expect("reason" in r).toBe(true);
    if ("reason" in r) {
      expect(r.pathsChecked).toHaveLength(4);
      expect(r.pathsChecked.every((p) => !p.startsWith("/dist/"))).toBe(true);
    }
  });
});

describe("loadPlugins broken-server tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records servers with no resolvable entry in brokenServers", () => {
    const manifestYaml = `
name: p
mcp-servers:
  working:
    entry: mcp-servers/working/index.ts
  broken:
    entry: mcp-servers/broken/index.ts
`;
    // Manifest found in-tree; only the `working` server has a compiled entry.
    vi.mocked(existsSync).mockImplementation((path: any) => {
      const p = String(path);
      if (p.endsWith("plugins/p/plugin.yaml")) return true;
      if (p.endsWith("mcp-servers/working/index.js")) return true;
      if (p.endsWith("mcp-servers/working/index.min.js")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["p"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].brokenServers).toHaveProperty("broken");
    expect(result[0].brokenServers.broken.reason).toContain("no compiled entry");
    expect(result[0].brokenServers.broken.pathsChecked.length).toBeGreaterThan(0);
    expect(result[0].brokenServers).not.toHaveProperty("working");
  });

  it("leaves brokenServers empty when all entries resolve", () => {
    const manifestYaml = `
name: p
mcp-servers:
  a:
    entry: mcp-servers/a/index.ts
`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      const p = String(path);
      if (p.endsWith("plugins/p/plugin.yaml")) return true;
      if (p.endsWith("mcp-servers/a/index.min.js")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["p"], "/root");
    expect(result[0].brokenServers).toEqual({});
  });
});

describe("rescanPluginBrokenServers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makePlugin(brokenNames: string[]): LoadedPlugin {
    const mcpServers: Record<string, PluginMcpServer> = {};
    const brokenServers: Record<string, BrokenServer> = {};
    for (const name of brokenNames) {
      mcpServers[name] = { entry: `mcp-servers/${name}/index.ts` };
      brokenServers[name] = { reason: "no compiled entry (startup)", pathsChecked: [] };
    }
    return {
      name: "p",
      dir: "/hive/plugins/p",
      manifest: {
        name: "p",
        description: "",
        mcpServers,
        agentSeeds: [],
      },
      brokenServers,
    };
  }

  it("drops entries that now resolve, keeps entries still missing", () => {
    const plugin = makePlugin(["rescue-me", "still-broken"]);
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("mcp-servers/rescue-me/index.js"));

    const { rescued, stillBroken } = rescanPluginBrokenServers([plugin], "/hive");

    expect(rescued).toEqual({ p: ["rescue-me"] });
    expect(stillBroken).toEqual({ p: ["still-broken"] });
    expect(plugin.brokenServers).toHaveProperty("still-broken");
    expect(plugin.brokenServers).not.toHaveProperty("rescue-me");
  });

  it("returns empty maps when no plugins have broken servers", () => {
    const plugin = makePlugin([]);
    const { rescued, stillBroken } = rescanPluginBrokenServers([plugin], "/hive");
    expect(rescued).toEqual({});
    expect(stillBroken).toEqual({});
  });

  it("drops a broken entry whose server was removed from the manifest", () => {
    const plugin = makePlugin(["still-registered"]);
    // Simulate: the broken server was unregistered since startup.
    plugin.brokenServers["phantom"] = { reason: "legacy", pathsChecked: [] };
    vi.mocked(existsSync).mockReturnValue(false);

    const { rescued, stillBroken } = rescanPluginBrokenServers([plugin], "/hive");

    expect(plugin.brokenServers).not.toHaveProperty("phantom");
    expect(plugin.brokenServers).toHaveProperty("still-registered");
    expect(rescued).toEqual({});
    expect(stillBroken).toEqual({ p: ["still-registered"] });
  });

  it("drops a broken entry whose transport flipped to http", () => {
    const plugin = makePlugin(["was-stdio"]);
    plugin.manifest.mcpServers["was-stdio"] = {
      transport: "http",
      url: "https://x/mcp",
      auth: { type: "api-key", keySource: "agentApiKey" },
    };
    vi.mocked(existsSync).mockReturnValue(false);

    const { rescued, stillBroken } = rescanPluginBrokenServers([plugin], "/hive");

    expect(plugin.brokenServers).not.toHaveProperty("was-stdio");
    expect(rescued).toEqual({});
    expect(stillBroken).toEqual({});
  });
});
