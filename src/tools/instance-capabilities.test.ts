import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing the module under test
vi.mock("../config.js", () => ({
  config: {
    instance: { id: "test-instance" },
    google: { accounts: { mokie: ["mokie@example.com"] } },
    resend: { apiKey: "rk_test" },
    brave: { apiKey: "" },
    linear: { apiKey: "lin_test" },
    clickup: { apiToken: "" },
    github: { repo: "org/repo" },
    quo: { apiKey: "" },
    recall: { apiKey: "" },
    codeIndex: { enabled: false },
    browser: { cdpEndpoint: "" },
    taskLedger: { apiUrl: "http://localhost:3002" },
  },
}));

vi.mock("../keychain/from-keychain.js", () => ({
  fromKeychain: vi.fn(() => ""),
}));

import { buildInstanceCapabilities, type InstanceCapabilities } from "./instance-capabilities.js";
import { fromKeychain } from "../keychain/from-keychain.js";
import type { LoadedPlugin } from "../plugins/types.js";

const mockFromKeychain = vi.mocked(fromKeychain);

function makePlugin(
  name: string,
  mcpServers: LoadedPlugin["manifest"]["mcpServers"],
  brokenServers: LoadedPlugin["brokenServers"] = {},
): LoadedPlugin {
  return {
    name,
    dir: `/tmp/${name}`,
    manifest: { name, mcpServers, agentSeeds: [] },
    brokenServers,
  };
}

describe("buildInstanceCapabilities", () => {
  let result: InstanceCapabilities;

  beforeEach(() => {
    result = buildInstanceCapabilities();
  });

  it("returns the instance ID from config", () => {
    expect(result.instanceId).toBe("test-instance");
  });

  it("classifies infrastructure servers as configured", () => {
    const infra = [
      "memory",
      "slack",
      "contacts",
      "callback",
      "background",
      "schedule",
      "event-bus",
      "conversation-search",
      "keychain",
      "admin",
    ];
    for (const server of infra) {
      expect(result.servers.configured, `expected ${server} in configured`).toContain(server);
    }
  });

  it("classifies servers with valid credentials as configured", () => {
    // google has accounts, resend has apiKey, linear has apiKey, github has repo
    expect(result.servers.configured).toContain("google");
    expect(result.servers.configured).toContain("resend");
    expect(result.servers.configured).toContain("linear");
    expect(result.servers.configured).toContain("github-issues");
  });

  it("classifies servers with missing credentials as unconfigured", () => {
    // brave has empty apiKey, clickup has empty apiToken, quo has empty apiKey
    expect(result.servers.unconfigured).toContain("brave-search");
    expect(result.servers.unconfigured).toContain("clickup");
    expect(result.servers.unconfigured).toContain("quo");
    expect(result.servers.unconfigured).toContain("recall");
    expect(result.servers.unconfigured).toContain("browser");
    expect(result.servers.unconfigured).toContain("code-search");
  });

  it("marks servers with default URIs as unconfigured", () => {
    // taskLedger has default localhost URL
    expect(result.servers.unconfigured).toContain("tasks");
  });

  it("always classifies code-task as configured", () => {
    expect(result.servers.configured).toContain("code-task");
  });

  it("does not include servers in both configured and unconfigured", () => {
    const overlap = result.servers.configured.filter((s) => result.servers.unconfigured.includes(s));
    expect(overlap).toEqual([]);
  });
});

// Invariant test — ensure credential checks stay in sync with server catalog
describe("SERVER_CREDENTIAL_CHECKS invariant", () => {
  it("all credential check entries exist in SERVER_CATALOG", async () => {
    // Import directly to inspect the mapping keys
    const { SERVER_CATALOG } = await import("./server-catalog.js");
    const catalogKeys = new Set(Object.keys(SERVER_CATALOG));

    // These are the servers we define credential checks for — must all be in the catalog
    const credentialCheckServers = [
      "google",
      "resend",
      "brave-search",
      "linear",
      "clickup",
      "github-issues",
      "quo",
      "recall",
      "code-task",
      "code-search",
      "browser",
      "tasks",
    ];

    for (const server of credentialCheckServers) {
      expect(catalogKeys, `SERVER_CREDENTIAL_CHECKS has '${server}' but SERVER_CATALOG does not`).toContain(server);
    }
  });
});

describe("buildInstanceCapabilities — plugin secretEnv", () => {
  beforeEach(() => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockReturnValue("");
    // Clear any test-leaked process.env overrides
    delete process.env.__TEST_SECRET;
    delete process.env.__TEST_PUBLIC;
  });

  it("marks plugin server configured when secretEnv resolves from process.env", () => {
    process.env.__TEST_SECRET = "s";
    const plugin = makePlugin("p", {
      srv: { entry: "e.ts", secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("srv");
    delete process.env.__TEST_SECRET;
  });

  it("marks plugin server configured when secretEnv resolves from Keychain", () => {
    mockFromKeychain.mockImplementation((_id, key) => (key === "__TEST_SECRET" ? "from-kc" : ""));
    const plugin = makePlugin("p", {
      srv: { entry: "e.ts", secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("srv");
    expect(mockFromKeychain).toHaveBeenCalledWith("test-instance", "__TEST_SECRET");
  });

  it("marks plugin server unconfigured when secretEnv missing from both env and Keychain", () => {
    const plugin = makePlugin("p", {
      srv: { entry: "e.ts", secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.unconfigured).toContain("srv");
  });

  it("marks plugin server unconfigured when env var missing (no keychain fallback for env)", () => {
    // Keychain has the value, but it's declared under `env`, not `secretEnv`
    mockFromKeychain.mockReturnValue("from-kc");
    const plugin = makePlugin("p", {
      srv: { entry: "e.ts", env: ["__TEST_PUBLIC"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.unconfigured).toContain("srv");
  });

  it("marks plugin server configured when both env and secretEnv resolve", () => {
    process.env.__TEST_PUBLIC = "p";
    mockFromKeychain.mockReturnValue("from-kc");
    const plugin = makePlugin("p", {
      srv: { entry: "e.ts", env: ["__TEST_PUBLIC"], secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("srv");
    delete process.env.__TEST_PUBLIC;
  });
});

describe("buildInstanceCapabilities — http-transport plugin servers", () => {
  // The test mock for config has no taskLedger.apiKey and no agentKeys, so
  // the default behavior is `unconfigured` — matching agent-runner's
  // skip-on-no-key behavior. Tests with keys mutate config in-place.

  beforeEach(() => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockReturnValue("");
  });

  it("marks http server unconfigured when no global apiKey and no per-agent keys", async () => {
    // Default mock has neither — verify against that baseline.
    const { config } = await import("../config.js");
    expect(config.taskLedger.apiKey).toBeUndefined();
    expect(config.taskLedger.agentKeys).toBeUndefined();

    const plugin = makePlugin("p", {
      remote: {
        transport: "http",
        url: "https://x/mcp",
        auth: { type: "api-key", keySource: "agentApiKey" },
      },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.unconfigured).toContain("remote");
    expect(result.servers.configured).not.toContain("remote");
  });

  it("marks http server configured when a global apiKey is set", async () => {
    const { config } = await import("../config.js");
    (config.taskLedger as any).apiKey = "global-key";
    try {
      const plugin = makePlugin("p", {
        remote: {
          transport: "http",
          url: "https://x/mcp",
          auth: { type: "api-key", keySource: "agentApiKey" },
        },
      });
      const result = buildInstanceCapabilities([plugin]);
      expect(result.servers.configured).toContain("remote");
    } finally {
      delete (config.taskLedger as any).apiKey;
    }
  });

  it("marks http server configured when at least one per-agent key is set", async () => {
    const { config } = await import("../config.js");
    (config.taskLedger as any).agentKeys = { nora: "key-nora" };
    try {
      const plugin = makePlugin("p", {
        remote: {
          transport: "http",
          url: "https://x/mcp",
          auth: { type: "api-key", keySource: "agentApiKey" },
        },
      });
      const result = buildInstanceCapabilities([plugin]);
      expect(result.servers.configured).toContain("remote");
    } finally {
      delete (config.taskLedger as any).agentKeys;
    }
  });
});

describe("buildInstanceCapabilities — broken plugin servers", () => {
  beforeEach(() => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockReturnValue("");
  });

  it("surfaces broken servers with their reason, skipping cred checks", () => {
    process.env.__TEST_PUBLIC = "p";
    const plugin = makePlugin(
      "p",
      {
        broken: { entry: "e.ts", env: ["__TEST_PUBLIC"] },
      },
      {
        broken: {
          reason: "no compiled entry found",
          pathsChecked: ["/some/path/dist/e.min.js", "/some/path/dist/e.js"],
        },
      },
    );
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.broken).toEqual([{ name: "broken", reason: "no compiled entry found" }]);
    // Even though __TEST_PUBLIC is set, broken wins — server never runs,
    // creds are moot.
    expect(result.servers.configured).not.toContain("broken");
    expect(result.servers.unconfigured).not.toContain("broken");
    delete process.env.__TEST_PUBLIC;
  });

  it("keeps working servers classified normally while broken ones are separated", () => {
    process.env.__TEST_PUBLIC = "p";
    const plugin = makePlugin(
      "p",
      {
        working: { entry: "w.ts", env: ["__TEST_PUBLIC"] },
        broken: { entry: "b.ts", env: ["__TEST_PUBLIC"] },
      },
      {
        broken: { reason: "no compiled entry found", pathsChecked: [] },
      },
    );
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("working");
    expect(result.servers.broken.map((s) => s.name)).toEqual(["broken"]);
    delete process.env.__TEST_PUBLIC;
  });

  it("returns empty broken list when plugins have no broken servers", () => {
    const result = buildInstanceCapabilities([]);
    expect(result.servers.broken).toEqual([]);
  });
});
