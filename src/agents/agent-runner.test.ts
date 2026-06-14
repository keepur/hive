import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import type { AgentConfig } from "../types/agent-config.js";
import type { LoadedPlugin } from "../plugins/types.js";

// ── node:fs mock ─────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock factory, avoiding the TDZ error that
// occurs when paths.ts (imported transitively) calls existsSync at module
// load time before plain const-declared mocks are initialized.
const { mockExistsSync, mockStatSync, mockMkdirSync, mockSymlinkSync, mockLstatSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockStatSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  mockMkdirSync: vi.fn(),
  mockSymlinkSync: vi.fn(),
  // Default: lstat throws (link target not present) so ensurePluginNodeModulesLink
  // will proceed to create a symlink.
  mockLstatSync: vi.fn().mockImplementation(() => {
    const err: NodeJS.ErrnoException = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  }),
}));
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  symlinkSync: (...args: any[]) => mockSymlinkSync(...args),
  lstatSync: (...args: any[]) => mockLstatSync(...args),
}));

// ── SDK mock ────────────────────────────────────────────────────────
const mockQuery = vi.fn();
let mockMessages: any[] | null = null; // Override per-test; null = default result

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: any[]) => {
    mockQuery(...args);
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        if (mockMessages) {
          for (const msg of mockMessages) yield msg;
        } else {
          yield {
            type: "result",
            subtype: "success",
            result: "test response",
            total_cost_usd: 0.001,
            duration_ms: 100,
            session_id: "test-session",
          };
        }
      },
    };
  },
  // KPR-139: agent-runner imports createTeamRosterMcpServer which uses these.
  // Required so any test passing a `teamRoster` to AgentRunner doesn't NPE on
  // `createSdkMcpServer is undefined`.
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({
    name: opts.name,
    type: "sdk",
    instance: {},
  })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Keychain mock ───────────────────────────────────────────────────
vi.mock("../keychain/from-keychain.js", () => ({
  fromKeychain: vi.fn(() => ""),
}));

// ── Config mock ─────────────────────────────────────────────────────
vi.mock("../config.js", () => ({
  config: {
    instance: { id: "hive", portBase: 3100 },
    slack: { mcpToken: "" },
    mongo: { uri: "mongodb://localhost:27017", dbName: "hive-test" },
    google: { client: "test-client", accounts: { "test-agent": ["test@example.com"] }, sharedFolder: "test-folder" },
    quo: { apiKey: "", phoneNumberId: "", lines: [] },
    taskLedger: {
      apiUrl: "http://localhost:3000",
      apiKey: "global-key",
      agentKeys: { "agent-a": "key-a" } as Record<string, string>,
    },
    brave: { apiKey: "" },
    resend: {
      apiKey: "",
      emailDomain: "test.com",
      businessName: "TestBiz",
      fromAddress: "",
      defaultCc: "",
      defaultBcc: "",
    },
    linear: { apiKey: "", teamId: "" },
    clickup: { apiToken: "" },
    github: { repo: "", token: "" },
    recall: {
      apiKey: "",
      region: "",
      monitorPort: 3100,
      monitorPublicUrl: "",
      webhookSecret: "test-webhook-secret",
    },
    background: { port: 3200, authToken: "test-bg-token" },
    codeTask: { port: 3202, authToken: "test-ct-token", pluginDir: "/tmp/fake-plugins" },
    anthropic: { apiKey: "test-key" },
    defaultAgent: "chief-of-staff",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    browser: { cdpEndpoint: "" },
    memory: { hotBudgetTokens: 3000 },
    workflow: { enabled: false },
    voice: { apiKey: "", phoneNumberId: "", assistants: {} },
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────
function makeMockMemoryManager() {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    history: vi.fn().mockResolvedValue([]),
    rollback: vi.fn().mockResolvedValue(undefined),
    getHotTierPrompt: vi.fn().mockResolvedValue(null),
  };
}

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

function getCapturedServers(): Record<string, any> {
  const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
  return call[0].options.mcpServers ?? {};
}

function getCapturedOptions(): Record<string, any> {
  const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
  return call[0].options ?? {};
}

// ── Import after mocks ──────────────────────────────────────────────
import { AgentRunner } from "./agent-runner.js";
import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";
import { fromKeychain } from "../keychain/from-keychain.js";

const mockFromKeychain = vi.mocked(fromKeychain);

function makeRunner(overrides: Partial<AgentConfig> = {}, teamRoster?: any): AgentRunner {
  return new AgentRunner(
    makeAgentConfig(overrides),
    makeMockMemoryManager() as any,
    [],
    new Map(),
    "{}",
    undefined,
    teamRoster,
  );
}

function makeGooglePlugin(): LoadedPlugin {
  return {
    name: "@keepur/hive-plugin-google",
    dir: "/plugins/node_modules/@keepur/hive-plugin-google",
    manifest: {
      name: "@keepur/hive-plugin-google",
      description: "Google Workspace tools",
      mcpServers: {
        google: {
          entry: "mcp-servers/google/index.ts",
          env: ["GOG_ACCOUNTS"],
          envMap: {},
          agentEnv: {},
        },
      },
      agentSeeds: [],
    },
    brokenServers: {},
  };
}

function inventoryByName(runner: AgentRunner, name: string) {
  const descriptor = runner.buildToolTransportInventory().find((entry) => entry.name === name);
  expect(descriptor).toBeDefined();
  return descriptor!;
}

// ── Tests ───────────────────────────────────────────────────────────
describe("AgentRunner.buildMcpServers (via send)", () => {
  let runner: AgentRunner;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("includes core servers (memory, keychain, google, etc.)", async () => {
    const coreServers = ["memory", "keychain", "google", "contacts", "background", "callback", "admin"];
    runner = new AgentRunner(makeAgentConfig({ coreServers }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("memory");
    expect(servers).toHaveProperty("structured-memory"); // always paired with memory
    expect(servers).toHaveProperty("keychain");
    expect(servers).toHaveProperty("google");
    expect(servers).toHaveProperty("contacts");
    expect(servers).toHaveProperty("background");
    expect(servers).toHaveProperty("callback");
    expect(servers).toHaveProperty("admin");
  });

  it("filters servers by agent coreServers allowlist", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["memory", "keychain"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    // structured-memory is auto-paired with memory (always registered)
    // schedule + team are always included as implicit core servers (KPR-11)
    // skill-author is always included as an implicit core server (KPR-104)
    expect(Object.keys(servers).sort()).toEqual(
      ["memory", "structured-memory", "keychain", "team", "schedule", "skill-author"].sort(),
    );
  });

  it("empty coreServers means only implicit servers", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ coreServers: [] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    // schedule + team are always included as implicit core servers (KPR-11)
    // skill-author is always included as an implicit core server (KPR-104)
    expect(Object.keys(servers).sort()).toEqual(["team", "schedule", "skill-author"].sort());
  });

  it("KPR-139: team-roster appears in mcpServers when a TeamRoster is provided", async () => {
    const teamRoster = {
      teamSummary: async () => "## Team\n- Alice",
    };
    runner = new AgentRunner(
      makeAgentConfig({ coreServers: [] }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      teamRoster as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).toHaveProperty("team-roster");
  });

  it("KPR-139: team-roster is rendered under 'Engine-provided' in the toolkit section", async () => {
    const teamRoster = {
      teamSummary: async () => "## Team\n- Alice",
    };
    runner = new AgentRunner(
      makeAgentConfig({ coreServers: [] }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      teamRoster as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();
    const engineIdx = options.systemPrompt.indexOf("### Engine-provided");
    const teamRosterIdx = options.systemPrompt.indexOf("- team-roster");
    expect(engineIdx).toBeGreaterThan(-1);
    expect(teamRosterIdx).toBeGreaterThan(engineIdx);
  });

  it("removes resend and quo when externalComms autonomy flag is false", async () => {
    const { config } = await import("../config.js");
    const origResendKey = config.resend.apiKey;
    const origQuoKey = (config.quo as any).apiKey;
    (config.resend as any).apiKey = "test-resend-key";
    (config.quo as any).apiKey = "test-quo-key";

    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "keychain", "resend", "quo"],
        autonomy: { externalComms: false, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("resend");
    expect(servers).not.toHaveProperty("quo");

    (config.resend as any).apiKey = origResendKey;
    (config.quo as any).apiKey = origQuoKey;
  });

  it("removes code-task when codeTask autonomy flag is false", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-task"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("code-task");
  });

  it("keeps code-task when codeTask autonomy flag is true", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-task"],
        autonomy: { externalComms: true, codeTask: true, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).toHaveProperty("code-task");
  });

  it("removes code-search when codeAccess autonomy flag is false", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("code-search");
  });

  it("keeps code-search when codeAccess autonomy flag is true", async () => {
    runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: true },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).toHaveProperty("code-search");
  });

  it("injects plugin MCP servers with correct env", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "custom-server": {
            entry: "mcp-servers/custom/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["custom-server"] }), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("custom-server");
    expect(servers["custom-server"].type).toBe("stdio");
    expect(servers["custom-server"].env.AGENT_ID).toBe("test-agent");
    expect(servers["custom-server"].env.AGENT_NAME).toBe("TestAgent");
    expect(servers["custom-server"].env.MONGODB_URI).toBe(
      "mongodb://localhost:27017",
    );
    // NODE_PATH is NOT set — Node's ESM resolver ignores it. Plugins get
    // their deps via a node_modules symlink inside plugin.dir instead.
    expect(servers["custom-server"].env.NODE_PATH).toBeUndefined();
  });

  it("uses the built-in Google MCP server when the external Google plugin is not installed", async () => {
    runner = new AgentRunner(makeAgentConfig({ coreServers: ["google"] }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers.google.args[0]).toMatch(/google[/-]google-mcp-server\.js$|mcp\/google\.min\.js$/);
    expect(servers.google.args[0]).not.toContain("/plugins/");
    expect(servers.google.env.GOG_ACCOUNTS).toBe("test@example.com");
    expect(servers.google.env.GOG_CLIENT).toBe("test-client");
  });

  it("lets @keepur/hive-plugin-google replace the built-in Google MCP server", async () => {
    process.env.GOG_ACCOUNTS = "wrong-global@example.com";
    runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["google"] }),
      memoryManager as any,
      [makeGooglePlugin()],
    );

    try {
      await runner.send("hello");
      const servers = getCapturedServers();

      expect(servers.google.args[0]).toContain("@keepur/hive-plugin-google");
      expect(servers.google.args[0]).toMatch(/mcp-servers[/\\]google[/\\]index(?:\.min)?\.js$/);
      expect(servers.google.args[0]).not.toMatch(/google[/-]google-mcp-server\.js$|mcp\/google\.min\.js$/);
      expect(servers.google.env.GOG_ACCOUNTS).toBe("test@example.com");
      expect(servers.google.env.GOG_CLIENT).toBe("test-client");
      expect(servers.google.env.DRIVE_SHARED_FOLDER).toBe("test-folder");
      expect(servers.google.env.INSTANCE_ID).toBe("hive");
    } finally {
      delete process.env.GOG_ACCOUNTS;
    }
  });

  it("does not expose the Google plugin to agents without configured Google accounts", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ id: "no-google-agent", coreServers: ["google"] }),
      memoryManager as any,
      [makeGooglePlugin()],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).not.toHaveProperty("google");
  });

  it("KPR-236: emits an http MCP config for transport:http plugin servers with api-key auth", async () => {
    const plugin: LoadedPlugin = {
      name: "remote-plugin",
      dir: "/plugins/remote-plugin",
      manifest: {
        name: "remote-plugin",
        description: "",
        mcpServers: {
          purchasing: {
            transport: "http",
            url: "https://app.example.com/mcp/purchasing",
            auth: { type: "api-key", keySource: "agentApiKey" },
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["purchasing"] }), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    // Default `test-agent` is not in taskLedger.agentKeys, so the global key wins.
    expect(servers.purchasing).toEqual({
      type: "http",
      url: "https://app.example.com/mcp/purchasing",
      headers: { "x-api-key": "global-key" },
    });
  });

  it("KPR-236: bearer auth prefixes the value with 'Bearer ' and defaults to the Authorization header", async () => {
    const plugin: LoadedPlugin = {
      name: "remote-plugin",
      dir: "/plugins/remote-plugin",
      manifest: {
        name: "remote-plugin",
        description: "",
        mcpServers: {
          remote: {
            transport: "http",
            url: "https://example.com/mcp",
            auth: { type: "bearer", keySource: "agentApiKey" },
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(
      makeAgentConfig({ id: "agent-a", coreServers: ["remote"] }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    // agent-a has a per-agent key in taskLedger.agentKeys → that wins over global-key.
    expect(servers.remote).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer key-a" },
    });
  });

  it("symlinks plugin.dir/node_modules to engine deps before spawning a plugin server", async () => {
    mockSymlinkSync.mockClear();
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "custom-server": {
            entry: "mcp-servers/custom/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["custom-server"] }), memoryManager as any, [plugin]);
    await runner.send("hello");

    // Symlink created at <plugin.dir>/node_modules, pointing at an absolute
    // path that contains "node_modules" (the engine's).
    const calls = mockSymlinkSync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toContain("node_modules");
    expect(lastCall[1]).toBe("/plugins/test-plugin/node_modules");
    expect(lastCall[2]).toBe("dir");
  });

  it("skips symlink creation when plugin.dir/node_modules already exists", async () => {
    mockSymlinkSync.mockClear();
    // lstat returns a stat object → link already exists → no new symlink.
    mockLstatSync.mockReturnValueOnce({ isSymbolicLink: () => true } as any);
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "custom-server": {
            entry: "mcp-servers/custom/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["custom-server"] }), memoryManager as any, [plugin]);
    await runner.send("hello");

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("injects plugin secretEnv from process.env when present (no keychain lookup)", async () => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockReturnValue("");
    process.env.__TEST_SECRET_ENV = "from-env";
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "secret-server": {
            entry: "mcp-servers/secret/index.ts",
            env: [],
            secretEnv: ["__TEST_SECRET_ENV"],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["secret-server"] }), memoryManager as any, [plugin]);
    try {
      await runner.send("hello");
      const servers = getCapturedServers();
      expect(servers["secret-server"].env.__TEST_SECRET_ENV).toBe("from-env");
      expect(mockFromKeychain).not.toHaveBeenCalled();
    } finally {
      delete process.env.__TEST_SECRET_ENV;
    }
  });

  it("falls back to Keychain for plugin secretEnv when process.env is empty", async () => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockImplementation((_id, key) => (key === "__TEST_SECRET_KC" ? "from-kc" : ""));
    delete process.env.__TEST_SECRET_KC;
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "kc-server": {
            entry: "mcp-servers/kc/index.ts",
            env: [],
            secretEnv: ["__TEST_SECRET_KC"],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["kc-server"] }), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["kc-server"].env.__TEST_SECRET_KC).toBe("from-kc");
    expect(mockFromKeychain).toHaveBeenCalledWith("hive", "__TEST_SECRET_KC");
  });

  it("omits plugin secretEnv key when neither env nor Keychain resolves", async () => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockReturnValue("");
    delete process.env.__TEST_SECRET_MISSING;
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "missing-server": {
            entry: "mcp-servers/missing/index.ts",
            env: [],
            secretEnv: ["__TEST_SECRET_MISSING"],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["missing-server"] }), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    // Subprocess still spawns (lenient failure mode per spec); var simply absent.
    expect(servers).toHaveProperty("missing-server");
    expect(servers["missing-server"].env.__TEST_SECRET_MISSING).toBeUndefined();
  });

  it("applies plugin envMap remapping", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "mapped-server": {
            entry: "mcp-servers/mapped/index.ts",
            env: [],
            envMap: { CUSTOM_API_URL: "TASK_LEDGER_API_URL" },
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["mapped-server"] }), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    // envMap copies TASK_LEDGER_API_URL value into CUSTOM_API_URL
    expect(servers["mapped-server"].env.CUSTOM_API_URL).toBe(
      "http://localhost:3000",
    );
  });

  it("resolves plugin agentEnv from agent config fields", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "agent-env-server": {
            entry: "mcp-servers/ae/index.ts",
            env: [],
            envMap: {},
            agentEnv: {
              CUSTOM_ID: "id",                      // flat
              CUSTOM_MODE: "metadata.dodiOpsMode",  // dotted
              CUSTOM_MISSING: "metadata.notThere",  // dotted miss
            },
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(
      makeAgentConfig({
        metadata: { dodiOpsMode: "readonly" },
        coreServers: ["agent-env-server"],
      }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["agent-env-server"].env.CUSTOM_ID).toBe("test-agent");
    expect(servers["agent-env-server"].env.CUSTOM_MODE).toBe("readonly");
    expect(servers["agent-env-server"].env.CUSTOM_MISSING).toBe("");
  });

  it("skips plugin server that conflicts with core server name", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          memory: {
            // conflicts with core "memory" server
            entry: "mcp-servers/memory/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["memory"] }), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    // Should still be core memory server, not the plugin one.
    // Path differs by mode: dev (dist/memory/memory-mcp-server.js) vs npm bundle (mcp/memory.min.js).
    expect(servers.memory.args[0]).toMatch(/memory[/-](?:memory-mcp-server\.js|min\.js)$|mcp\/memory\.min\.js$/);
    expect(servers.memory.args[0]).not.toContain("/plugins/");
  });

  it("uses per-agent task ledger key when available", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "keyed-server": {
            entry: "mcp-servers/keyed/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    // agent-a has a per-agent key "key-a" in the mock config
    runner = new AgentRunner(
      makeAgentConfig({ id: "agent-a", coreServers: ["keyed-server"] }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["keyed-server"].env.TASK_LEDGER_API_KEY).toBe("key-a");
  });

  it("falls back to global task ledger key for unknown agents", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "keyed-server": {
            entry: "mcp-servers/keyed/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    // "unknown-agent" doesn't have a per-agent key
    runner = new AgentRunner(
      makeAgentConfig({ id: "unknown-agent", coreServers: ["keyed-server"] }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["keyed-server"].env.TASK_LEDGER_API_KEY).toBe("global-key");
  });

  it("skips plugin servers the loader flagged as broken", async () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "broken-server": {
            entry: "mcp-servers/broken/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {
        "broken-server": {
          reason: "no compiled entry found",
          pathsChecked: ["/tmp/dist/broken.min.js", "/tmp/dist/broken.js"],
        },
      },
    };

    runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["broken-server"] }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).not.toHaveProperty("broken-server");
  });

  it("excludes brave-search when API key is empty", async () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("brave-search");
  });

  it("excludes quo when API key is empty", async () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers).not.toHaveProperty("quo");
  });

  it("conversation-search server env includes DEFAULT_AGENT and AGENT_ID", async () => {
    runner = new AgentRunner(makeAgentConfig({ id: "my-agent", coreServers: ["conversation-search"] }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("conversation-search");
    expect(servers["conversation-search"].env.AGENT_ID).toBe("my-agent");
    expect(servers["conversation-search"].env.DEFAULT_AGENT).toBe("chief-of-staff");
  });

  it("admin server env includes AGENT_ID", async () => {
    runner = new AgentRunner(makeAgentConfig({ id: "some-agent", coreServers: ["admin"] }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("admin");
    expect(servers["admin"].env.AGENT_ID).toBe("some-agent");
  });

  it("does not include crm-search, product-search, or ops-search in core servers", async () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).not.toHaveProperty("crm-search");
    expect(servers).not.toHaveProperty("product-search");
    expect(servers).not.toHaveProperty("ops-search");
  });

  it("scopes Playwright MCP output-dir and user-data-dir per agent", async () => {
    const { config } = await import("../config.js");
    const orig = config.browser.cdpEndpoint;
    (config.browser as any).cdpEndpoint = "http://127.0.0.1:9222";
    try {
      runner = new AgentRunner(
        makeAgentConfig({ id: "river", coreServers: ["browser"] }),
        memoryManager as any,
      );
      await runner.send("hello");
      const servers = getCapturedServers();
      expect(servers).toHaveProperty("browser");
      const args: string[] = servers.browser.args;
      const outIdx = args.indexOf("--output-dir");
      const udIdx = args.indexOf("--user-data-dir");
      expect(outIdx).toBeGreaterThan(-1);
      expect(udIdx).toBeGreaterThan(-1);
      expect(args[outIdx + 1]).toMatch(/\/agents\/river\/playwright$/);
      expect(args[udIdx + 1]).toMatch(/\/agents\/river\/playwright\/user-data$/);
    } finally {
      (config.browser as any).cdpEndpoint = orig;
    }
  });
});

// ── buildServerConfig tests ──────────────────────────────────────
describe("AgentRunner.buildHttpServerConfig", () => {
  it("defaults header to x-api-key and uses the raw key for api-key auth", () => {
    const result = AgentRunner.buildHttpServerConfig(
      {
        transport: "http",
        url: "https://x/mcp",
        auth: { type: "api-key", keySource: "agentApiKey" },
      },
      "my-key",
    );
    expect(result).toEqual({
      type: "http",
      url: "https://x/mcp",
      headers: { "x-api-key": "my-key" },
    });
  });

  it("defaults header to Authorization and prefixes 'Bearer ' for bearer auth", () => {
    const result = AgentRunner.buildHttpServerConfig(
      {
        transport: "http",
        url: "https://x/mcp",
        auth: { type: "bearer", keySource: "agentApiKey" },
      },
      "my-key",
    );
    expect(result.headers).toEqual({ Authorization: "Bearer my-key" });
  });

  it("respects an explicit header override but still applies the Bearer prefix on bearer auth", () => {
    const result = AgentRunner.buildHttpServerConfig(
      {
        transport: "http",
        url: "https://x/mcp",
        auth: { type: "bearer", header: "X-Custom", keySource: "agentApiKey" },
      },
      "my-key",
    );
    expect(result.headers).toEqual({ "X-Custom": "Bearer my-key" });
  });
});

describe("AgentRunner.buildServerConfig", () => {
  let runner: AgentRunner;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("returns config for a known server", () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const serverConfig = runner.buildServerConfig("google");
    expect(serverConfig).toBeDefined();
    expect(serverConfig!.type).toBe("stdio");
  });

  it("returns undefined for an unknown server", () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const serverConfig = runner.buildServerConfig("nonexistent");
    expect(serverConfig).toBeUndefined();
  });
});

// ── Tool transport inventory tests (KPR-232) ─────────────────────
describe("AgentRunner.buildToolTransportInventory", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("classifies stdio core servers as non-Claude MCP bridge candidates", () => {
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["keychain"] }),
      memoryManager as any,
    );

    const keychain = inventoryByName(runner, "keychain");
    expect(keychain).toMatchObject({
      transport: "stdio",
      source: "core",
      requiresTurnContext: false,
      requiresHiveRuntime: false,
      inProcess: false,
    });
    expect(keychain.compatibility).toEqual({
      claude: "direct",
      openai: "mcp-bridge-candidate",
      gemini: "mcp-bridge-candidate",
    });
  });

  it("classifies hosted Slack HTTP MCP as a bridge candidate when explicitly configured", async () => {
    const { config } = await import("../config.js");
    const origToken = config.slack.mcpToken;
    const origLocal = (config.slack as any).localMcpServer;
    (config.slack as any).mcpToken = "xoxp-test";
    (config.slack as any).localMcpServer = false;
    try {
      const runner = new AgentRunner(
        makeAgentConfig({ coreServers: ["slack"] }),
        memoryManager as any,
      );

      const slack = inventoryByName(runner, "slack");
      expect(slack.transport).toBe("http");
      expect(slack.source).toBe("core");
      expect(slack.compatibility.openai).toBe("mcp-bridge-candidate");
      expect(slack.compatibility.gemini).toBe("mcp-bridge-candidate");
    } finally {
      (config.slack as any).mcpToken = origToken;
      (config.slack as any).localMcpServer = origLocal;
    }
  });

  it("classifies plugin stdio servers as plugin bridge candidates", () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "custom-server": {
            entry: "mcp-servers/custom/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["custom-server"] }),
      memoryManager as any,
      [plugin],
    );

    const custom = inventoryByName(runner, "custom-server");
    expect(custom).toMatchObject({
      transport: "stdio",
      source: "plugin",
      requiresTurnContext: false,
      requiresHiveRuntime: false,
    });
    expect(custom.compatibility.openai).toBe("mcp-bridge-candidate");
  });

  it("excludes broken plugin servers from available inventory", () => {
    const plugin: LoadedPlugin = {
      name: "test-plugin",
      dir: "/plugins/test-plugin",
      manifest: {
        name: "test-plugin",
        description: "Test",
        mcpServers: {
          "broken-server": {
            entry: "mcp-servers/broken/index.ts",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {
        "broken-server": {
          reason: "no compiled entry found",
          pathsChecked: ["/tmp/dist/broken.min.js"],
        },
      },
    };
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["broken-server"] }),
      memoryManager as any,
      [plugin],
    );

    expect(runner.buildToolTransportInventory().map((entry) => entry.name)).not.toContain("broken-server");
  });

  it("classifies in-process memory as Hive-runtime-backed but not turn-context-dependent", () => {
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["memory"] }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      undefined,
      {} as any,
    );

    const memory = inventoryByName(runner, "memory");
    expect(memory).toMatchObject({
      transport: "sdk-in-process",
      source: "core",
      requiresTurnContext: false,
      requiresHiveRuntime: true,
      inProcess: true,
    });
    expect(memory.compatibility.openai).toBe("requires-hive-bridge");
    expect(memory.compatibility.gemini).toBe("requires-hive-bridge");
  });

  it("classifies auto-injected in-process schedule as requiring a Hive bridge", () => {
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: [] }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      undefined,
      {} as any,
    );

    const schedule = inventoryByName(runner, "schedule");
    expect(schedule).toMatchObject({
      transport: "sdk-in-process",
      source: "engine",
      requiresTurnContext: false,
      requiresHiveRuntime: true,
      inProcess: true,
    });
    expect(schedule.compatibility.openai).toBe("requires-hive-bridge");
  });

  it("classifies context-dependent servers as requiring a Hive bridge", () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["background"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );

    const background = inventoryByName(runner, "background");
    expect(background.requiresTurnContext).toBe(true);
    expect(background.requiresHiveRuntime).toBe(false);
    expect(background.compatibility.openai).toBe("requires-hive-bridge");
    expect(background.compatibility.gemini).toBe("requires-hive-bridge");
  });

  it("includes team-roster when a TeamRoster is present", () => {
    const teamRoster = {
      teamSummary: async () => "## Team\n- Alice",
    };
    const runner = makeRunner({ coreServers: [] }, teamRoster);

    const teamRosterDescriptor = inventoryByName(runner, "team-roster");
    expect(teamRosterDescriptor).toMatchObject({
      transport: "sdk-in-process",
      source: "engine",
      requiresTurnContext: false,
      requiresHiveRuntime: true,
      inProcess: true,
    });
    expect(teamRosterDescriptor.compatibility.openai).toBe("requires-hive-bridge");
  });

  it("classifies delegate servers as Claude sub-agents and Claude-only for non-Claude providers", () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: [],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );

    const google = inventoryByName(runner, "google");
    expect(google).toMatchObject({
      transport: "claude-subagent",
      source: "delegate",
      requiresTurnContext: false,
      requiresHiveRuntime: false,
    });
    expect(google.compatibility).toEqual({
      claude: "direct",
      openai: "claude-only",
      gemini: "claude-only",
    });
  });

  it("includes representative Claude SDK built-ins as Claude-only descriptors", () => {
    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);

    const bash = inventoryByName(runner, "Bash");
    const task = inventoryByName(runner, "Task");
    for (const descriptor of [bash, task]) {
      expect(descriptor).toMatchObject({
        transport: "claude-builtin",
        source: "sdk-builtin",
        requiresTurnContext: false,
        requiresHiveRuntime: false,
        inProcess: false,
      });
      expect(descriptor.compatibility).toEqual({
        claude: "direct",
        openai: "claude-only",
        gemini: "claude-only",
      });
    }
  });

  it("matches runtime-exposed mcpServers and agents in a golden send comparison", async () => {
    const teamRoster = {
      teamSummary: async () => "## Team\n- Alice",
    };
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "keychain"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      teamRoster as any,
    );

    const inventoryNames = new Set(runner.buildToolTransportInventory().map((entry) => entry.name));
    await runner.send("hello");
    const runtimeServerNames = Object.keys(getCapturedServers());
    const runtimeAgentNames = Object.keys(getCapturedOptions().agents ?? {});

    for (const name of [...runtimeServerNames, ...runtimeAgentNames]) {
      expect(inventoryNames).toContain(name);
    }
  });

  it("applies autonomy gates consistently to inventory", () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["code-task", "code-search"],
        delegateServers: ["code-task", "code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );

    const names = runner.buildToolTransportInventory().map((entry) => entry.name);
    expect(names).not.toContain("code-task");
    expect(names).not.toContain("code-search");
  });
});

// ── Server sub-agents tests (KPR-221) ─────────────────────────────
describe("AgentRunner server sub-agents (via send)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("passes delegate agents in query options when delegateServers configured", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "slack"],
        delegateServers: ["google", "contacts"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("agents");
    expect(Object.keys(options.agents)).toEqual(["google", "contacts"]);
  });

  it("does not pass agents when no delegateServers", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["memory"], delegateServers: [] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("agents");
  });

  it("delegate AgentDefinition uses Record-form mcpServers", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();
    const googleAgent = options.agents["google"];

    expect(googleAgent.mcpServers).toHaveLength(1);
    expect(googleAgent.mcpServers[0]).toHaveProperty("google");
    expect(typeof googleAgent.mcpServers[0]).toBe("object");
    // Must NOT be a string reference
    expect(typeof googleAgent.mcpServers[0]).not.toBe("string");
  });

  it("delegate AgentDefinition has disallowedTools: ['Agent']", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents["google"].disallowedTools).toEqual(["Agent"]);
  });

  it("delegate AgentDefinition has model: 'inherit'", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents["google"].model).toBe("inherit");
  });

  it("excludes resend and quo from delegates when externalComms autonomy flag is false", async () => {
    const { config } = await import("../config.js");
    const origResendKey = config.resend.apiKey;
    (config.resend as any).apiKey = "test-key";

    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "resend"],
        autonomy: { externalComms: false, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents).toHaveProperty("google");
    expect(options.agents).not.toHaveProperty("resend");

    (config.resend as any).apiKey = origResendKey;
  });

  it("excludes code-task from delegates when codeTask autonomy flag is false", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "code-task"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents).toHaveProperty("google");
    expect(options.agents).not.toHaveProperty("code-task");
  });

  it("KPR-221: skips context-dependent servers if they slip through (defense-in-depth)", async () => {
    // Bypass the registry/admin guards by constructing the AgentConfig
    // directly with a context-dependent server. The runner must skip it
    // (not build a sub-agent for it) — sub-agents spawn without channel
    // context and the server would silently malfunction.
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "background"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents).toHaveProperty("google");
    expect(options.agents).not.toHaveProperty("background");
  });

  it("excludes code-search from delegates when codeAccess autonomy flag is false", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: false },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents).toHaveProperty("google");
    expect(options.agents).not.toHaveProperty("code-search");
  });

  it("delegate servers are NOT in parent mcpServers", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "contacts"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("memory");
    expect(servers).not.toHaveProperty("google");
    expect(servers).not.toHaveProperty("contacts");
  });

  it("system prompt includes delegate summaries when delegateServers present", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "contacts"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    // KPR-87: delegate listing moved into the unified "Your toolkit" section.
    expect(options.systemPrompt).toContain("### Delegated capability MCPs");
    expect(options.systemPrompt).toMatch(/- google —/);
    expect(options.systemPrompt).toMatch(/- contacts —/);
  });

  it("system prompt does NOT include delegate section when no delegateServers", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ coreServers: ["memory"], delegateServers: [] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.systemPrompt).not.toContain("### Delegated capability MCPs");
  });

  it("includes namespace description in delegate AgentDefinition", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents["google"].description).toContain("Gmail");
  });

  it("uses custom delegatePrompt when available", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
        delegatePrompts: { google: "Custom Google prompt." },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents["google"].prompt).toBe("Custom Google prompt.");
    expect(options.agents["google"].maxTurns).toBe(7);
  });

  it("uses generic prompt and maxTurns 10 when no custom delegatePrompt", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.agents["google"].prompt).toContain("tool specialist");
    expect(options.agents["google"].maxTurns).toBe(10);
  });

  it("delegatePrompts only applies to the matching server, not other delegates", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google", "contacts"],
        delegatePrompts: { contacts: "Custom Contacts prompt." },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    // contacts gets the custom prompt and maxTurns 7
    expect(options.agents["contacts"].prompt).toBe("Custom Contacts prompt.");
    expect(options.agents["contacts"].maxTurns).toBe(7);

    // google (no matching delegatePrompt) gets the generic prompt and maxTurns 10
    expect(options.agents["google"].prompt).toContain("tool specialist");
    expect(options.agents["google"].maxTurns).toBe(10);
  });

  it("delegatePrompts with empty string falls back to generic prompt and maxTurns 10", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
        delegatePrompts: { google: "" },
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    // empty string is falsy — should fall back to generic prompt
    expect(options.agents["google"].prompt).toContain("tool specialist");
    expect(options.agents["google"].maxTurns).toBe(10);
  });
});

// ── Toolkit section prompt tests (KPR-87) ─────────────────────────
describe("AgentRunner toolkit section prompt (via send)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("injects 'Your toolkit' header with the four standard subsections (those that apply)", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "contacts"],
        delegateServers: [],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.systemPrompt).toContain("## Your toolkit");
    // SDK builtins always present
    expect(options.systemPrompt).toContain("### Built-in (always available)");
    // Engine-provided subsection appears (schedule/team auto-injected)
    expect(options.systemPrompt).toContain("### Engine-provided");
    // Capability MCPs subsection appears (memory + contacts are explicit)
    expect(options.systemPrompt).toContain("### Capability MCPs");
    // No delegates configured → no Delegated subsection
    expect(options.systemPrompt).not.toContain("### Delegated capability MCPs");
  });

  it("lists explicit core servers under 'Capability MCPs' with their blurbs", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory", "contacts"],
        delegateServers: [],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.systemPrompt).toMatch(/- memory —/);
    expect(options.systemPrompt).toMatch(/- contacts —/);
  });

  it("lists auto-injected servers under 'Engine-provided' even when not in coreServers", async () => {
    // No explicit core servers — schedule/team still auto-inject.
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: [],
        delegateServers: [],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    const engineIdx = options.systemPrompt.indexOf("### Engine-provided");
    expect(engineIdx).toBeGreaterThan(-1);
    expect(options.systemPrompt).toMatch(/- schedule —/);
    expect(options.systemPrompt).toMatch(/- team —/);
  });

  it("renders Engine-provided even when only auto-injected servers exist (no Capability MCPs)", async () => {
    // Bare-bones agent — Engine-provided block must appear, Capability MCPs must not
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: [],
        delegateServers: [],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.systemPrompt).toContain("## Your toolkit");
    expect(options.systemPrompt).toContain("### Engine-provided");
    expect(options.systemPrompt).not.toContain("### Capability MCPs");
  });

  it("emits 'Delegated capability MCPs' subsection for delegates", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: ["google"],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.systemPrompt).toContain("### Delegated capability MCPs");
    expect(options.systemPrompt).toMatch(/- google —/);
  });

  it("falls back to plugin manifest description for plugin servers", async () => {
    const plugin: LoadedPlugin = {
      name: "custom-plugin",
      dir: "/plugins/custom-plugin",
      manifest: {
        name: "custom-plugin",
        description: "Custom",
        mcpServers: {
          "custom-tool": {
            entry: "mcp-servers/custom/index.ts",
            description: "A custom tool for testing",
            usage: "Testing things",
            notFor: "Production use",
            env: [],
            envMap: {},
            agentEnv: {},
          },
        },
        agentSeeds: [],
      },
      brokenServers: {},
    };

    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["custom-tool"],
        delegateServers: [],
      }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.systemPrompt).toContain("- custom-tool — A custom tool for testing");
  });

  it("places toolkit section between constitution and date/time (assembly order)", async () => {
    memoryManager.read.mockImplementation((path: string) => {
      if (path === "shared/constitution.md") return Promise.resolve("CONSTITUTION_MARKER");
      return Promise.resolve(null);
    });

    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["memory"],
        delegateServers: [],
      }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    const constIdx = options.systemPrompt.indexOf("CONSTITUTION_MARKER");
    const toolkitIdx = options.systemPrompt.indexOf("## Your toolkit");
    const dateIdx = options.systemPrompt.indexOf("**Current date/time**");
    expect(constIdx).toBeGreaterThan(-1);
    expect(toolkitIdx).toBeGreaterThan(constIdx);
    expect(dateIdx).toBeGreaterThan(toolkitIdx);
  });
});

// ── Security hardening tests ─────────────────────────────────────
describe("AgentRunner security hardening", () => {
  let runner: AgentRunner;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });


  it("passes BG_AUTH_TOKEN to background MCP server env", async () => {
    runner = new AgentRunner(makeAgentConfig({ coreServers: ["background"] }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["background"].env.BG_AUTH_TOKEN).toBe("test-bg-token");
  });

  it("passes RECALL_WEBHOOK_SECRET to recall MCP server env", async () => {
    const { config } = await import("../config.js");
    const origApiKey = config.recall.apiKey;
    const origMonitorPublicUrl = config.recall.monitorPublicUrl;
    (config.recall as any).apiKey = "test-recall-key";
    (config.recall as any).monitorPublicUrl = "http://test";

    runner = new AgentRunner(makeAgentConfig({ coreServers: ["recall"] }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["recall"].env.RECALL_WEBHOOK_SECRET).toBe(
      "test-webhook-secret",
    );

    // Restore
    (config.recall as any).apiKey = origApiKey;
    (config.recall as any).monitorPublicUrl = origMonitorPublicUrl;
  });
});

// ── buildSdkPlugins tests ────────────────────────────────────────
describe("AgentRunner.buildSdkPlugins (via send)", () => {
  let runner: AgentRunner;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: any path checked with existsSync returns true (plugin dir exists)
    mockExistsSync.mockReturnValue(true);
    memoryManager = makeMockMemoryManager();
  });

  it("does not include plugins in query options when no plugins configured", async () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("plugins");
  });

  it("does not include plugins when plugins array is empty", async () => {
    runner = new AgentRunner(makeAgentConfig({ plugins: [] }), memoryManager as any);
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("plugins");
  });

  it("passes plugins array with correct type and path when plugins are configured and dirs exist", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["quality-gate", "deploy"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("plugins");
    expect(options.plugins).toHaveLength(2);
    expect(options.plugins[0].type).toBe("local");
    expect(options.plugins[0].path).toContain("quality-gate");
    expect(options.plugins[1].type).toBe("local");
    expect(options.plugins[1].path).toContain("deploy");
  });

  it("resolves plugin paths relative to plugins/claude-code directory", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["my-plugin"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.plugins[0].path).toMatch(/plugins[/\\]claude-code[/\\]my-plugin/);
  });

  it("skips missing plugin dir and warns, still includes remaining plugins", async () => {
    // Only the second plugin path exists
    mockExistsSync.mockImplementation((p: string) => {
      return String(p).includes("present-plugin");
    });

    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["missing-plugin", "present-plugin"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("plugins");
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins[0].path).toContain("present-plugin");
  });

  it("does not include plugins in options when all plugins are missing", async () => {
    mockExistsSync.mockReturnValue(false);

    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["gone"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("plugins");
  });

  it("skips plugin name containing forward slash", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["bad/name", "good-plugin"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("plugins");
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins[0].path).toContain("good-plugin");
  });

  it("skips plugin name containing backslash", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["bad\\name", "good-plugin"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("plugins");
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins[0].path).toContain("good-plugin");
  });

  it("skips plugin name equal to '..'", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["..", "good-plugin"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("plugins");
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins[0].path).toContain("good-plugin");
  });

  it("skips plugin name starting with a dot", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: [".hidden", "good-plugin"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("plugins");
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins[0].path).toContain("good-plugin");
  });

  it("skips all invalid names and does not include plugins key when no valid ones remain", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ plugins: ["../escape", ".hidden", "bad/slash"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("plugins");
  });
});

// ── Resource limits override tests ───────────────────────────────
describe("AgentRunner resource limits override (via send)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("uses resourceLimits when provided", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ maxTurns: 25, budgetUsd: 10, timeoutMs: 300_000 }),
      memoryManager as any,
    );

    await runner.send("test", undefined, undefined, undefined, undefined, {
      timeoutMs: 600_000,
      maxTurns: 200,
      budgetUsd: 50,
    });

    const options = getCapturedOptions();
    expect(options.maxTurns).toBe(200);
    expect(options.maxBudgetUsd).toBe(50);
  });

  it("falls back to agentConfig when resourceLimits not provided", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ maxTurns: 25, budgetUsd: 10 }),
      memoryManager as any,
    );

    await runner.send("test");

    const options = getCapturedOptions();
    expect(options.maxTurns).toBe(25);
    expect(options.maxBudgetUsd).toBe(10);
  });
});

// ── Token tracking and compaction tests ──────────────────────────
describe("AgentRunner token tracking and compaction (via send)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("extracts token usage from SDK result message", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      result: "response",
      total_cost_usd: 0.01,
      duration_ms: 200,
      session_id: "s1",
      usage: {
        input_tokens: 1500,
        output_tokens: 300,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
      },
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 1500,
          outputTokens: 300,
          contextWindow: 200000,
        },
      },
    }];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(300);
    expect(result.cacheReadTokens).toBe(500);
    expect(result.cacheCreationTokens).toBe(200);
    expect(result.contextWindow).toBe(200000);
  });

  it("defaults token fields to 0 when SDK result has no usage", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      result: "response",
      total_cost_usd: 0.001,
      duration_ms: 100,
      session_id: "s1",
    }];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.contextWindow).toBe(0);
    expect(result.compactions).toBe(0);
  });

  it("counts compaction events from compact_boundary messages", async () => {
    mockMessages = [
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 180000 },
        session_id: "s1",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 190000 },
        session_id: "s1",
      },
      {
        type: "result",
        subtype: "success",
        result: "response",
        total_cost_usd: 0.05,
        duration_ms: 5000,
        session_id: "s1",
      },
    ];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.compactions).toBe(2);
    // preCompactTokens should be from the LAST compaction event
    expect(result.preCompactTokens).toBe(190000);
  });

  it("preCompactTokens is undefined when no compaction occurs", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      result: "response",
      total_cost_usd: 0.001,
      duration_ms: 100,
      session_id: "s1",
    }];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.preCompactTokens).toBeUndefined();
  });

  it("extracts ephemeral 5m/1h breakdown when SDK surfaces cache_creation", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      result: "response",
      total_cost_usd: 0.01,
      duration_ms: 200,
      session_id: "s1",
      usage: {
        input_tokens: 1500,
        output_tokens: 300,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_creation: {
          ephemeral_5m_input_tokens: 150,
          ephemeral_1h_input_tokens: 50,
        },
      },
    }];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.ephemeral5mTokens).toBe(150);
    expect(result.ephemeral1hTokens).toBe(50);
  });

  it("leaves ephemeral fields undefined when SDK does not surface cache_creation", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      result: "response",
      total_cost_usd: 0.01,
      duration_ms: 200,
      session_id: "s1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        // no cache_creation field
      },
    }];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.ephemeral5mTokens).toBeUndefined();
    expect(result.ephemeral1hTokens).toBeUndefined();
  });

  it("picks largest contextWindow when multiple models used", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      result: "response",
      total_cost_usd: 0.01,
      duration_ms: 200,
      session_id: "s1",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200000 },
        "claude-sonnet-4-6": { contextWindow: 1000000 },
      },
    }];

    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    const result = await runner.send("hello");

    expect(result.contextWindow).toBe(1000000);
  });
});

// ── PreCompact hook tests ────────────────────────────────────────
describe("AgentRunner PreCompact hook (via send)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("registers PreCompact hook in query options", async () => {
    const runner = new AgentRunner(makeAgentConfig({ name: "Jasper" }), memoryManager as any);
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).toHaveProperty("hooks");
    expect(options.hooks).toHaveProperty("PreCompact");
    expect(options.hooks.PreCompact).toHaveLength(1);
    expect(options.hooks.PreCompact[0].hooks).toHaveLength(1);
  });

  it("PreCompact hook returns agent-specific preservation instructions", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ id: "jasper", name: "Jasper" }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    const hookFn = options.hooks.PreCompact[0].hooks[0];
    const result = await hookFn({}, undefined, { signal: new AbortController().signal });

    expect(result.continue).toBe(true);
    expect(result.systemMessage).toContain("Jasper");
    expect(result.systemMessage).toContain("jasper");
    expect(result.systemMessage).toContain("Preserve your identity");
    expect(result.systemMessage).toContain("customer/contact names");
    expect(result.systemMessage).toContain("active workflows");
  });

  // ── Code-aware PreCompact hook tests ────────────────────────────

  describe("PreCompact code context (code-aware compaction)", () => {
    const transcriptPath = "/tmp/test-transcript-agent-runner-89.txt";

    afterEach(async () => {
      try {
        await unlink(transcriptPath);
      } catch {
        // file may not exist in all tests — that is fine
      }
    });

    it("without prefetcher returns base instructions only (backward compat)", async () => {
      await writeFile(transcriptPath, "User: hello\nAssistant: hi");

      const runner = new AgentRunner(
        makeAgentConfig({ id: "jasper", name: "Jasper" }),
        memoryManager as any,
        // no prefetcher argument — backward-compat path
      );
      await runner.send("hello");
      const options = getCapturedOptions();

      const hookFn = options.hooks.PreCompact[0].hooks[0];
      const result = await hookFn(
        { transcript_path: transcriptPath, trigger: "auto" },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result.continue).toBe(true);
      expect(result.systemMessage).toContain("Preserve your identity");
      // No code context injected — message should be exactly the base instructions
      expect(result.systemMessage).not.toContain("code files");
      expect(result.systemMessage).not.toContain("Relevant code");
    });

    it("with prefetcher appends code context to base instructions", async () => {
      await writeFile(transcriptPath, "User: can you fix the bug in agent-runner.ts?\nAssistant: sure");

      const mockPrefetcher = {
        getCompactionContext: vi.fn().mockResolvedValue(
          "Relevant code files referenced:\n- src/agents/agent-runner.ts",
        ),
      };

      const runner = new AgentRunner(
        makeAgentConfig({ id: "jasper", name: "Jasper" }),
        memoryManager as any,
        [],       // plugins
        new Map(), // skillIndex
        "{}",     // eventSubscribersJson
        mockPrefetcher as any,
      );
      await runner.send("hello");
      const options = getCapturedOptions();

      const hookFn = options.hooks.PreCompact[0].hooks[0];
      const result = await hookFn(
        { transcript_path: transcriptPath, trigger: "auto" },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result.continue).toBe(true);
      // Base instructions present
      expect(result.systemMessage).toContain("Preserve your identity");
      // Code context appended
      expect(result.systemMessage).toContain("Relevant code files referenced");
      expect(result.systemMessage).toContain("agent-runner.ts");
      // Prefetcher was called with the transcript text and agent ID
      expect(mockPrefetcher.getCompactionContext).toHaveBeenCalledWith(
        expect.stringContaining("fix the bug"),
        "jasper",
      );
    });

    it("survives prefetcher failure and falls back to base instructions", async () => {
      await writeFile(transcriptPath, "User: deploy the service\nAssistant: deploying");

      const mockPrefetcher = {
        getCompactionContext: vi.fn().mockRejectedValue(new Error("Qdrant is down")),
      };

      const runner = new AgentRunner(
        makeAgentConfig({ id: "jasper", name: "Jasper" }),
        memoryManager as any,
        [],
        new Map(),
        "{}",
        mockPrefetcher as any,
      );
      await runner.send("hello");
      const options = getCapturedOptions();

      const hookFn = options.hooks.PreCompact[0].hooks[0];
      // Should not throw — graceful fallback
      const result = await hookFn(
        { transcript_path: transcriptPath, trigger: "auto" },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result.continue).toBe(true);
      // Falls back to base instructions only
      expect(result.systemMessage).toContain("Preserve your identity");
      // No code context in the output
      expect(result.systemMessage).not.toContain("Relevant code");
    });
  });
});

// ── Betas passthrough tests ──────────────────────────────────────
describe("AgentRunner betas passthrough (via send)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("passes betas to query options when configured", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ betas: ["context-1m-2025-08-07"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options.betas).toEqual(["context-1m-2025-08-07"]);
  });

  it("does not include betas when not configured", async () => {
    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("betas");
  });

  it("does not include betas when array is empty", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({ betas: [] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const options = getCapturedOptions();

    expect(options).not.toHaveProperty("betas");
  });
});

// ── Archetype card injection ─────────────────────────────────────
describe("buildSystemPrompt — archetype card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();
  });

  it("injects card between soul and systemPrompt", async () => {
    registerArchetype({
      id: "stub",
      validateConfig: (c) => c,
      systemPromptCard: () => "ARCH_CARD_MARKER",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "SOUL_MARKER",
      systemPrompt: "SYSPROMPT_MARKER",
      archetype: "stub",
      archetypeConfig: {},
    });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    const soulIdx = prompt.indexOf("SOUL_MARKER");
    const cardIdx = prompt.indexOf("ARCH_CARD_MARKER");
    const sysIdx = prompt.indexOf("SYSPROMPT_MARKER");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(cardIdx).toBeGreaterThan(soulIdx);
    expect(sysIdx).toBeGreaterThan(cardIdx);
  });

  it("no card when archetype unset", async () => {
    const runner = makeRunner({ soul: "SOUL_MARKER", systemPrompt: "SYSPROMPT_MARKER" });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    expect(prompt).not.toContain("ARCH_CARD_MARKER");
    expect(prompt).toContain("SOUL_MARKER");
    expect(prompt).toContain("SYSPROMPT_MARKER");
  });

  it("KPR-139: injects team summary when teamRoster is provided", async () => {
    const teamRoster = {
      teamSummary: async () => "## Team\n- TEAM_SUMMARY_MARKER",
    };
    const runner = makeRunner({ soul: "SOUL", systemPrompt: "SYS" }, teamRoster);
    const prompt = await (runner as any).buildSystemPrompt([], []);
    expect(prompt).toContain("TEAM_SUMMARY_MARKER");
  });

  it("KPR-139: no team summary section when teamRoster is undefined", async () => {
    const runner = makeRunner({ soul: "SOUL", systemPrompt: "SYS" });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    expect(prompt).not.toContain("TEAM_SUMMARY_MARKER");
  });

  it("KPR-139: prompt assembly tolerates teamRoster.teamSummary throwing", async () => {
    const teamRoster = {
      teamSummary: async () => {
        throw new Error("cache busted");
      },
    };
    const runner = makeRunner({ soul: "SOUL", systemPrompt: "SYS_MARKER" }, teamRoster);
    const prompt = await (runner as any).buildSystemPrompt([], []);
    // Prompt still builds, no team summary, but other parts present
    expect(prompt).toContain("SYS_MARKER");
  });

  it("buildHooks includes PreCompact by default", () => {
    const runner = makeRunner({ soul: "", systemPrompt: "" });
    const hooks = (runner as any).buildHooks();
    expect(hooks.PreCompact).toBeDefined();
    expect(Array.isArray(hooks.PreCompact)).toBe(true);
    expect(hooks.PreToolUse).toBeUndefined();
  });

  it("buildHooks merges archetype PreToolUse hooks", () => {
    registerArchetype({
      id: "hooked",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [
        { matcher: "Edit", hooks: [async () => ({ continue: true })] },
      ],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "",
      systemPrompt: "",
      archetype: "hooked",
      archetypeConfig: {},
    });
    const hooks = (runner as any).buildHooks();
    expect(hooks.PreCompact).toBeDefined();
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].matcher).toBe("Edit");
  });

  it("buildHooks installs deny-all when preToolUseHooks throws (fail-closed)", () => {
    registerArchetype({
      id: "hook-throws",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => {
        throw new Error("hook init boom");
      },
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "",
      systemPrompt: "",
      archetype: "hook-throws",
      archetypeConfig: {},
    });
    const hooks = (runner as any).buildHooks();
    expect(hooks.PreCompact).toBeDefined();
    // Should have a deny-all hook, not undefined (fail-open)
    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PreToolUse).toHaveLength(1);
    // No matcher = matches all tools
    expect(hooks.PreToolUse[0].matcher).toBeUndefined();
  });

  it("KPR-222: buildHooks rebuilds with current WorkItemContext on every call (no stale context across spawns)", () => {
    const captured: Array<unknown> = [];
    registerArchetype({
      id: "context-capturing",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: (args) => {
        captured.push(args.workItemContext);
        return [];
      },
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "",
      systemPrompt: "",
      archetype: "context-capturing",
      archetypeConfig: {},
    });
    const ctxA = { channelId: "ch-a", threadId: "thr-a", source: "test" } as any;
    const ctxB = { channelId: "ch-b", threadId: "thr-b", source: "test" } as any;
    (runner as any).buildHooks(ctxA);
    (runner as any).buildHooks(ctxB);
    expect(captured).toEqual([ctxA, ctxB]);
  });

  it("omits card gracefully when archetype systemPromptCard throws", async () => {
    registerArchetype({
      id: "throws",
      validateConfig: (c) => c,
      systemPromptCard: () => {
        throw new Error("boom");
      },
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "SOUL_MARKER",
      systemPrompt: "SYSPROMPT_MARKER",
      archetype: "throws",
      archetypeConfig: {},
    });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    expect(prompt).toContain("SOUL_MARKER");
    expect(prompt).toContain("SYSPROMPT_MARKER");
    expect(prompt).not.toContain("ARCH_CARD_MARKER");
  });
});

// ── Archetype sessionOptions + cwd validation ───────────────────
describe("AgentRunner — archetype sessionOptions + cwd guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();
    mockStatSync.mockReset();
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  afterEach(() => {
    __resetRegistryForTests();
    mockStatSync.mockReset();
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  it("merges archetype sessionOptions (cwd + settingSources) into SDK query options", async () => {
    registerArchetype({
      id: "with-session",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({ cwd: "/tmp/exists", settingSources: ["project"] }),
    });
    const runner = makeRunner({
      archetype: "with-session",
      archetypeConfig: {},
    });
    await runner.send("hello");
    const options = getCapturedOptions();
    expect(options.cwd).toBe("/tmp/exists");
    expect(options.settingSources).toEqual(["project"]);
  });

  it("throws when statSync errors on the archetype cwd", async () => {
    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    registerArchetype({
      id: "missing-cwd",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({ cwd: "/tmp/missing" }),
    });
    const runner = makeRunner({
      archetype: "missing-cwd",
      archetypeConfig: {},
    });
    await expect(runner.send("hello")).rejects.toThrow(/\/tmp\/missing/);
  });

  it("throws when archetype cwd exists but is not a directory", async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    registerArchetype({
      id: "file-cwd",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({ cwd: "/tmp/file" }),
    });
    const runner = makeRunner({
      archetype: "file-cwd",
      archetypeConfig: {},
    });
    await expect(runner.send("hello")).rejects.toThrow(/not a directory/);
  });

  it("falls back to per-agent scratch dir when no archetype is configured", async () => {
    mockStatSync.mockClear();
    mockMkdirSync.mockClear();
    const runner = makeRunner({ id: "milo" });
    await runner.send("hello");
    // Default path: mkdir the scratch dir, no archetype stat.
    expect(mockStatSync.mock.calls.length).toBe(0);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/\/agents\/milo\/scratch$/),
      { recursive: true },
    );
    const options = getCapturedOptions();
    expect(options.cwd).toMatch(/\/agents\/milo\/scratch$/);
  });

  it("archetype-provided cwd still wins over default scratch dir", async () => {
    mockMkdirSync.mockClear();
    registerArchetype({
      id: "overrides",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({ cwd: "/tmp/exists" }),
    });
    const runner = makeRunner({
      id: "jasper",
      archetype: "overrides",
      archetypeConfig: {},
    });
    await runner.send("hello");
    const options = getCapturedOptions();
    expect(options.cwd).toBe("/tmp/exists");
    // Archetype branch must not mkdir (operator-configured path must already exist).
    const jasperScratchCalls = mockMkdirSync.mock.calls.filter((c) =>
      /\/agents\/jasper\/scratch$/.test(String(c[0])),
    );
    expect(jasperScratchCalls.length).toBe(0);
  });

  it("propagates mkdir failure when scratch dir can't be created", async () => {
    mockMkdirSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    const runner = makeRunner({ id: "river" });
    await expect(runner.send("hello")).rejects.toThrow(/EACCES/);
  });
});

// ── KPR-122: in-process MCP server wiring ──────────────────────────────
//
// Each ported server (per the plan) gets one assertion confirming that when
// `db` is supplied to AgentRunner, the corresponding `mcpServers["<name>"]`
// entry is replaced with an SDK MCP server instance (the mock in this file
// returns objects with type:"sdk") rather than the stdio fallback. The cached
// instance is exercised across turns by the team-roster precedent — same
// shape applies here.
describe("AgentRunner — KPR-122 in-process MCP wiring", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  function makeFakeDb(): any {
    return {
      collection: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue(null),
        find: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([]),
          sort: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          project: vi.fn().mockReturnThis(),
          skip: vi.fn().mockReturnThis(),
        })),
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
        insertOne: vi.fn().mockResolvedValue({ insertedId: "x" }),
        deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        countDocuments: vi.fn().mockResolvedValue(0),
        createIndex: vi.fn().mockResolvedValue("ok"),
      })),
    };
  }

  function makeRunnerWithDb(coreServers: string[]): AgentRunner {
    return new AgentRunner(
      makeAgentConfig({ coreServers }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      undefined,
      makeFakeDb(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("memory becomes an in-process SDK server when db is supplied", async () => {
    const runner = makeRunnerWithDb(["memory"]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers.memory).toBeDefined();
    expect(servers.memory.type).toBe("sdk");
  });

  it("memory in-process server is cached across send() invocations", async () => {
    const runner = makeRunnerWithDb(["memory"]);
    await runner.send("first");
    const first = getCapturedServers().memory;
    await runner.send("second");
    const second = getCapturedServers().memory;
    expect(first).toBe(second);
  });

  it("structured-memory becomes an in-process SDK server when memory is enabled", async () => {
    const runner = makeRunnerWithDb(["memory"]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["structured-memory"]).toBeDefined();
    expect(servers["structured-memory"].type).toBe("sdk");
  });

  it("event-bus becomes an in-process SDK server when in coreServers", async () => {
    const runner = makeRunnerWithDb(["event-bus"]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["event-bus"]).toBeDefined();
    expect(servers["event-bus"].type).toBe("sdk");
  });

  it("callback becomes an in-process SDK server when in coreServers", async () => {
    const runner = makeRunnerWithDb(["callback"]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["callback"]).toBeDefined();
    expect(servers["callback"].type).toBe("sdk");
  });

  it("contacts becomes an in-process SDK server when in coreServers", async () => {
    const runner = makeRunnerWithDb(["contacts"]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["contacts"]).toBeDefined();
    expect(servers["contacts"].type).toBe("sdk");
  });

  it("schedule becomes an in-process SDK server (auto-injected)", async () => {
    const runner = makeRunnerWithDb([]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["schedule"]).toBeDefined();
    expect(servers["schedule"].type).toBe("sdk");
  });

  it("team becomes an in-process SDK server (auto-injected)", async () => {
    const runner = makeRunnerWithDb([]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["team"]).toBeDefined();
    expect(servers["team"].type).toBe("sdk");
  });

  it("admin becomes an in-process SDK server when in coreServers", async () => {
    const runner = makeRunnerWithDb(["admin"]);
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["admin"]).toBeDefined();
    expect(servers["admin"].type).toBe("sdk");
  });

  it("workflow becomes an in-process SDK server when config.workflow.enabled is true", async () => {
    const { config } = await import("../config.js");
    const orig = config.workflow.enabled;
    (config.workflow as any).enabled = true;
    try {
      const runner = makeRunnerWithDb(["workflow"]);
      await runner.send("hello");
      const servers = getCapturedServers();
      expect(servers["workflow"]).toBeDefined();
      expect(servers["workflow"].type).toBe("sdk");
    } finally {
      (config.workflow as any).enabled = orig;
    }
  });

  it("code-search becomes an in-process SDK server when codeAccess is on", async () => {
    const runner = new AgentRunner(
      makeAgentConfig({
        coreServers: ["code-search"],
        autonomy: { externalComms: true, codeTask: false, codeAccess: true },
      }),
      memoryManager as any,
      [],
      new Map(),
      "{}",
      undefined,
      undefined,
      makeFakeDb(),
    );
    await runner.send("hello");
    const servers = getCapturedServers();
    expect(servers["code-search"]).toBeDefined();
    expect(servers["code-search"].type).toBe("sdk");
  });
});

describe("AgentRunner — MEMORY_SCOPES_JSON wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();
  });
  afterEach(() => __resetRegistryForTests());

  it("defaults to self-mongo only when no archetype is set", async () => {
    const runner = makeRunner({ coreServers: ["memory"] });
    await runner.send("hello");
    const servers = getCapturedServers();
    const scopes = JSON.parse(servers.memory.env.MEMORY_SCOPES_JSON);
    expect(scopes).toEqual([{ id: "self", backing: "mongo" }]);
  });

  it("leads with self-mongo and appends archetype scopes", async () => {
    registerArchetype({
      id: "scoped",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [
        { id: "workshop", backing: "filesystem", dir: "/tmp/workshop" },
        { id: "workspace:dodi_v2", backing: "filesystem", dir: "/tmp/dodi" },
      ],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({ archetype: "scoped", archetypeConfig: {}, coreServers: ["memory"] });
    await runner.send("hello");
    const servers = getCapturedServers();
    const scopes = JSON.parse(servers.memory.env.MEMORY_SCOPES_JSON);
    expect(scopes[0]).toEqual({ id: "self", backing: "mongo" });
    expect(scopes).toHaveLength(3);
    expect(scopes.find((s: { id: string }) => s.id === "workshop")).toEqual({
      id: "workshop",
      backing: "filesystem",
      dir: "/tmp/workshop",
    });
    expect(scopes.find((s: { id: string }) => s.id === "workspace:dodi_v2")).toBeDefined();
  });

  it("dedupes self when an archetype incorrectly returns its own self entry", async () => {
    registerArchetype({
      id: "with-self",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [
        { id: "self", backing: "filesystem", dir: "/tmp/should-be-filtered" },
        { id: "workshop", backing: "filesystem", dir: "/tmp/workshop" },
      ],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({ archetype: "with-self", archetypeConfig: {}, coreServers: ["memory"] });
    await runner.send("hello");
    const servers = getCapturedServers();
    const scopes = JSON.parse(servers.memory.env.MEMORY_SCOPES_JSON);
    const selfEntries = scopes.filter((s: { id: string }) => s.id === "self");
    expect(selfEntries).toHaveLength(1);
    expect(selfEntries[0]).toEqual({ id: "self", backing: "mongo" });
    expect(scopes[0]).toEqual({ id: "self", backing: "mongo" });
  });

  it("falls back to self-mongo only when memoryScopes throws", async () => {
    registerArchetype({
      id: "throwing",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => {
        throw new Error("intentional");
      },
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({ archetype: "throwing", archetypeConfig: {}, coreServers: ["memory"] });
    await runner.send("hello");
    const servers = getCapturedServers();
    const scopes = JSON.parse(servers.memory.env.MEMORY_SCOPES_JSON);
    expect(scopes).toEqual([{ id: "self", backing: "mongo" }]);
  });
});
