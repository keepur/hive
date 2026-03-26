import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "../types/agent-config.js";
import type { LoadedPlugin } from "../plugins/types.js";

// ── node:fs mock ─────────────────────────────────────────────────────
const mockExistsSync = vi.fn().mockReturnValue(true);
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

// ── SDK mock ────────────────────────────────────────────────────────
const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: any[]) => {
    mockQuery(...args);
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "test response",
          total_cost_usd: 0.001,
          duration_ms: 100,
          session_id: "test-session",
        };
      },
    };
  },
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

// ── Config mock ─────────────────────────────────────────────────────
vi.mock("../config.js", () => ({
  config: {
    instance: { id: "hive", portBase: 3100 },
    slack: { mcpToken: "" },
    mongo: { uri: "mongodb://localhost:27017", dbName: "hive-test" },
    google: { account: "", accounts: {}, sharedFolder: "test-folder" },
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
      hubspotBcc: "",
    },
    linear: { apiKey: "", teamId: "" },
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
    agents: { defaultAgent: "chief-of-staff" },
    externalComms: { enabled: true },
    triage: { enabled: false },
    browser: { cdpEndpoint: "" },
    memory: { hotBudgetTokens: 3000 },
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
    soul: "",
    systemPrompt: "You are a test agent.",
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

// ── Tests ───────────────────────────────────────────────────────────
describe("AgentRunner.buildMcpServers (via send)", () => {
  let runner: AgentRunner;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    memoryManager = makeMockMemoryManager();
  });

  it("includes core servers (memory, keychain, google, etc.)", async () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("memory");
    expect(servers).toHaveProperty("keychain");
    expect(servers).toHaveProperty("google");
    expect(servers).toHaveProperty("contacts");
    expect(servers).toHaveProperty("background");
    expect(servers).toHaveProperty("callback");
    expect(servers).toHaveProperty("admin");
  });

  it("filters servers by agent allowlist", async () => {
    runner = new AgentRunner(
      makeAgentConfig({ servers: ["memory", "keychain"] }),
      memoryManager as any,
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    // structured-memory only included when memory.structured is enabled
    expect(Object.keys(servers)).toEqual(["memory", "keychain"]);
  });

  it("removes resend and quo when external comms disabled", async () => {
    const { config } = await import("../config.js");
    const orig = config.externalComms.enabled;
    (config.externalComms as any).enabled = false;
    (config.quo as any).apiKey = "test-quo-key";
    (config.resend as any).apiKey = "test-resend-key";

    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).not.toHaveProperty("resend");
    expect(servers).not.toHaveProperty("quo");

    // Restore
    (config.externalComms as any).enabled = orig;
    (config.quo as any).apiKey = "";
    (config.resend as any).apiKey = "";
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
        agentsTemplates: [],
      },
    };

    runner = new AgentRunner(makeAgentConfig(), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("custom-server");
    expect(servers["custom-server"].type).toBe("stdio");
    expect(servers["custom-server"].env.AGENT_ID).toBe("test-agent");
    expect(servers["custom-server"].env.AGENT_NAME).toBe("TestAgent");
    expect(servers["custom-server"].env.MONGODB_URI).toBe(
      "mongodb://localhost:27017",
    );
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
        agentsTemplates: [],
      },
    };

    runner = new AgentRunner(makeAgentConfig(), memoryManager as any, [plugin]);
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
            agentEnv: { CUSTOM_MODE: "dodiOpsMode", CUSTOM_ID: "id" },
          },
        },
        agentsTemplates: [],
      },
    };

    runner = new AgentRunner(
      makeAgentConfig({ dodiOpsMode: "readonly" }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["agent-env-server"].env.CUSTOM_MODE).toBe("readonly");
    expect(servers["agent-env-server"].env.CUSTOM_ID).toBe("test-agent");
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
        agentsTemplates: [],
      },
    };

    runner = new AgentRunner(makeAgentConfig(), memoryManager as any, [plugin]);
    await runner.send("hello");
    const servers = getCapturedServers();

    // Should still be core memory server, not the plugin one
    expect(servers.memory.args[0]).toContain("dist/memory/memory-mcp-server.js");
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
        agentsTemplates: [],
      },
    };

    // agent-a has a per-agent key "key-a" in the mock config
    runner = new AgentRunner(
      makeAgentConfig({ id: "agent-a" }),
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
        agentsTemplates: [],
      },
    };

    // "unknown-agent" doesn't have a per-agent key
    runner = new AgentRunner(
      makeAgentConfig({ id: "unknown-agent" }),
      memoryManager as any,
      [plugin],
    );
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers["keyed-server"].env.TASK_LEDGER_API_KEY).toBe("global-key");
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
    runner = new AgentRunner(makeAgentConfig({ id: "my-agent" }), memoryManager as any);
    await runner.send("hello");
    const servers = getCapturedServers();

    expect(servers).toHaveProperty("conversation-search");
    expect(servers["conversation-search"].env.AGENT_ID).toBe("my-agent");
    expect(servers["conversation-search"].env.DEFAULT_AGENT).toBe("chief-of-staff");
  });

  it("admin server env includes AGENT_ID", async () => {
    runner = new AgentRunner(makeAgentConfig({ id: "some-agent" }), memoryManager as any);
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
});

// ── Security hardening tests ─────────────────────────────────────
describe("AgentRunner security hardening", () => {
  let runner: AgentRunner;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    memoryManager = makeMockMemoryManager();
  });


  it("passes BG_AUTH_TOKEN to background MCP server env", async () => {
    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
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

    runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
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
