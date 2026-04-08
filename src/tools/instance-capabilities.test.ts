import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing the module under test
vi.mock("../config.js", () => ({
  config: {
    instance: { id: "test-instance" },
    google: { accounts: { "user@example.com": "token" }, account: "" },
    resend: { apiKey: "rk_test" },
    brave: { apiKey: "" },
    linear: { apiKey: "lin_test" },
    clickup: { apiToken: "" },
    github: { repo: "org/repo" },
    quo: { apiKey: "" },
    recall: { apiKey: "" },
    hubspot: { apiKey: "hub_test" },
    permits: { mongoUri: "mongodb://localhost:27017/permits" },
    codeIndex: { enabled: false },
    browser: { cdpEndpoint: "" },
    taskLedger: { apiUrl: "http://localhost:3002" },
  },
}));

import { buildInstanceCapabilities, type InstanceCapabilities } from "./instance-capabilities.js";

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
    expect(result.servers.configured).toContain("hubspot-crm");
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
    // permits has default mongo URI, taskLedger has default localhost URL
    expect(result.servers.unconfigured).toContain("permits");
    expect(result.servers.unconfigured).toContain("catalog");
    expect(result.servers.unconfigured).toContain("tasks");
    expect(result.servers.unconfigured).toContain("dodi-ops");
    expect(result.servers.unconfigured).toContain("ops-search");
  });

  it("always classifies code-task as configured", () => {
    expect(result.servers.configured).toContain("code-task");
  });

  it("builds integration summary correctly", () => {
    expect(result.integrations.google).toEqual({
      configured: true,
      detail: "1 account(s)",
    });
    expect(result.integrations.slack).toEqual({ configured: true });
    expect(result.integrations.email).toEqual({ configured: true });
    expect(result.integrations.sms).toEqual({ configured: false });
    expect(result.integrations.crm).toEqual({ configured: true });
    expect(result.integrations["web-search"]).toEqual({ configured: false });
    expect(result.integrations.browser).toEqual({ configured: false });
    expect(result.integrations["video-meetings"]).toEqual({ configured: false });
  });

  it("reports issue-tracking with detail when both Linear and GitHub are configured", () => {
    expect(result.integrations["issue-tracking"]).toEqual({
      configured: true,
      detail: "Linear, GitHub Issues",
    });
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
      "google", "resend", "brave-search", "linear", "clickup", "github-issues",
      "quo", "recall", "hubspot-crm", "permits", "code-task", "code-search",
      "browser", "catalog", "dodi-ops", "tasks", "product-search", "ops-search",
    ];

    for (const server of credentialCheckServers) {
      expect(catalogKeys, `SERVER_CREDENTIAL_CHECKS has '${server}' but SERVER_CATALOG does not`).toContain(server);
    }
  });
});
