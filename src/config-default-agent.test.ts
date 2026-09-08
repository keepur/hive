import { vi } from "vitest";

const { TEST_HIVE_HOME, ORIGINAL_HIVE_HOME } = vi.hoisted(() => {
  // Keep config's module-load path resolution away from the operator's real
  // instance. This must run before paths.ts and config.ts are imported.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const originalHiveHome = process.env.HIVE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "hive-default-agent-test-"));
  process.env.HIVE_HOME = dir;
  return { TEST_HIVE_HOME: dir, ORIGINAL_HIVE_HOME: originalHiveHome };
});

const { mockKeychain } = vi.hoisted(() => ({ mockKeychain: vi.fn<(instanceId: string, key: string) => string>() }));

vi.mock("./keychain/from-keychain.js", () => ({ fromKeychain: mockKeychain }));

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dotenvPath = join(TEST_HIVE_HOME, ".env");
const savedTokens = {
  app: process.env.SLACK_APP_TOKEN,
  bot: process.env.SLACK_BOT_TOKEN,
  signing: process.env.SLACK_SIGNING_SECRET,
  config: process.env.HIVE_CONFIG,
  defaultAgent: process.env.DEFAULT_AGENT,
};

function removeDefaultAgentSources(): void {
  delete process.env.DEFAULT_AGENT;
  rmSync(dotenvPath, { force: true });
}

function defaultAgentKeychainCalls(): unknown[][] {
  return mockKeychain.mock.calls.filter(([, key]) => key === "DEFAULT_AGENT");
}

async function loadConfig() {
  return (await import("./config.js")).config;
}

beforeEach(() => {
  vi.resetModules();
  mockKeychain.mockReset().mockReturnValue("");
  removeDefaultAgentSources();
  delete process.env.HIVE_CONFIG;
  process.env.SLACK_APP_TOKEN = "test";
  process.env.SLACK_BOT_TOKEN = "test";
  process.env.SLACK_SIGNING_SECRET = "test";
});

afterEach(() => {
  removeDefaultAgentSources();
});

afterAll(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("SLACK_APP_TOKEN", savedTokens.app);
  restore("SLACK_BOT_TOKEN", savedTokens.bot);
  restore("SLACK_SIGNING_SECRET", savedTokens.signing);
  restore("HIVE_CONFIG", savedTokens.config);
  restore("DEFAULT_AGENT", savedTokens.defaultAgent);
  restore("HIVE_HOME", ORIGINAL_HIVE_HOME);
  rmSync(TEST_HIVE_HOME, { recursive: true, force: true });
});

describe("DEFAULT_AGENT provenance", () => {
  it("preserves an environment value byte-for-byte while exposing trimmed provenance", async () => {
    process.env.DEFAULT_AGENT = "  env-agent  ";
    mockKeychain.mockImplementation((_instanceId, key) => (key === "DEFAULT_AGENT" ? "keychain-agent" : ""));

    const config = await loadConfig();

    expect(config.defaultAgent).toBe("  env-agent  ");
    expect(config.explicitDefaultAgent).toBe("env-agent");
    expect(defaultAgentKeychainCalls()).toHaveLength(0);
  });

  it("loads .env before consulting Keychain", async () => {
    writeFileSync(dotenvPath, "DEFAULT_AGENT=dotenv-agent\n", "utf8");
    mockKeychain.mockImplementation((_instanceId, key) => (key === "DEFAULT_AGENT" ? "keychain-agent" : ""));

    const config = await loadConfig();

    expect(config.defaultAgent).toBe("dotenv-agent");
    expect(config.explicitDefaultAgent).toBe("dotenv-agent");
    expect(defaultAgentKeychainCalls()).toHaveLength(0);
  });

  it("resolves Keychain once and preserves its ordinary whitespace behavior", async () => {
    mockKeychain.mockImplementation((_instanceId, key) => (key === "DEFAULT_AGENT" ? "  keychain-agent  " : ""));

    const config = await loadConfig();

    expect(config.defaultAgent).toBe("  keychain-agent  ");
    expect(config.explicitDefaultAgent).toBe("keychain-agent");
    expect(defaultAgentKeychainCalls()).toEqual([["hive", "DEFAULT_AGENT"]]);
  });

  it("keeps the legacy implicit fallback while recording no explicit provenance", async () => {
    const config = await loadConfig();

    expect(config.defaultAgent).toBe("chief-of-staff");
    expect(config.explicitDefaultAgent).toBeUndefined();
    expect(defaultAgentKeychainCalls()).toEqual([["hive", "DEFAULT_AGENT"]]);
  });

  it("keeps a whitespace environment value as the legacy default but rejects it as provenance", async () => {
    process.env.DEFAULT_AGENT = "   ";

    const config = await loadConfig();

    expect(config.defaultAgent).toBe("   ");
    expect(config.explicitDefaultAgent).toBeUndefined();
    expect(defaultAgentKeychainCalls()).toHaveLength(0);
  });

  it("treats an empty environment value as absent and consults Keychain exactly once", async () => {
    process.env.DEFAULT_AGENT = "";
    mockKeychain.mockImplementation((_instanceId, key) => (key === "DEFAULT_AGENT" ? "keychain-agent" : ""));

    const config = await loadConfig();

    expect(config.defaultAgent).toBe("keychain-agent");
    expect(config.explicitDefaultAgent).toBe("keychain-agent");
    expect(defaultAgentKeychainCalls()).toEqual([["hive", "DEFAULT_AGENT"]]);
  });
});
