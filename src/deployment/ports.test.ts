import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertWorkerPortAvailableInConfig, voiceWorkerPort } from "./ports.js";

const { fromKeychainMock } = vi.hoisted(() => ({
  fromKeychainMock: vi.fn<(instanceId: string, key: string) => string>(),
}));

vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: fromKeychainMock }));

describe("voiceWorkerPort", () => {
  it("uses the default base and offset", () => {
    expect(voiceWorkerPort(undefined, undefined)).toBe(3107);
  });

  it("derives from an explicit base and lets an explicit worker port win", () => {
    expect(voiceWorkerPort(4200, undefined)).toBe(4207);
    expect(voiceWorkerPort(4200, 9000)).toBe(9000);
  });

  it("accepts both worker-port boundaries", () => {
    expect(voiceWorkerPort(3100, 1)).toBe(1);
    expect(voiceWorkerPort(3100, 65535)).toBe(65535);
    expect(voiceWorkerPort(65528, undefined)).toBe(65535);
  });

  it.each([null, "3100", 3100.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid base %s",
    (base) => {
      expect(() => voiceWorkerPort(base, 4000)).toThrow("invalid instance.portBase");
    },
  );

  it.each([null, "3107", 3107.5, 0, -1, 65536, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid worker port %s",
    (port) => {
      expect(() => voiceWorkerPort(3100, port)).toThrow("invalid instance.ports.voiceWorker");
    },
  );

  it("rejects a derived worker port outside the valid range", () => {
    expect(() => voiceWorkerPort(65529, undefined)).toThrow("invalid instance.ports.voiceWorker");
  });
});

describe("assertWorkerPortAvailableInConfig", () => {
  it("accepts distinct valid listener ports", () => {
    expect(() => assertWorkerPortAvailableInConfig(3107, { background: 3100, voice: 3105 })).not.toThrow();
  });

  it("names the colliding resolved listener", () => {
    expect(() => assertWorkerPortAvailableInConfig(4107, { background: 4100, adminApi: 4107 })).toThrow(
      "voiceWorker port collides with adminApi",
    );
  });

  it.each([0, 65536, 4.5, Number.NaN])("rejects invalid existing listener port %s", (port) => {
    expect(() => assertWorkerPortAvailableInConfig(3107, { voice: port })).toThrow("invalid voice port");
  });
});

describe("config voice worker port integration", () => {
  const originalEnv = { ...process.env };
  let fixtureHome: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "hive-worker-port-"));
    for (const key of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "BG_TASK_PORT",
      "MEETING_MONITOR_PORT",
      "CODE_TASK_PORT",
      "WS_PORT",
      "ADMIN_API_PORT",
      "VOICE_PORT",
      "SLACK_INTERNAL_PORT",
      "BEEKEEPER_PORT",
    ]) {
      delete process.env[key];
    }
    process.env.HOME = fixtureHome;
    process.env.HIVE_HOME = fixtureHome;
    process.env.HIVE_CONFIG = "hive.yaml";
    process.env.DOTENV_CONFIG_QUIET = "true";
    fromKeychainMock.mockReset();
    fromKeychainMock.mockReturnValue("");
  });

  afterEach(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  async function loadConfig(yaml: string, dotenv = "SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\n") {
    writeFileSync(join(fixtureHome, "hive.yaml"), yaml);
    writeFileSync(join(fixtureHome, ".env"), dotenv);
    vi.resetModules();
    return (await import("../config.js")).config;
  }

  it("loads the default and explicit worker ports from fixture YAML", async () => {
    const defaults = await loadConfig("instance:\n  id: fixture\n  portBase: 4700\n");
    expect(defaults.voice.workerPort).toBe(4707);

    const overridden = await loadConfig(
      "instance:\n  id: fixture\n  portBase: 4700\n  ports:\n    voiceWorker: 4800\n",
    );
    expect(overridden.voice.workerPort).toBe(4800);
  });

  it("detects a collision with the env-resolved VOICE_PORT when LiveKit is enabled", async () => {
    fromKeychainMock.mockImplementation((_instanceId, key) => (key === "VOICE_PORT" ? "4888" : ""));
    await expect(
      loadConfig(
        "instance:\n  id: fixture\n  portBase: 4700\n  ports:\n    voiceWorker: 4777\nvoice:\n  livekit:\n    enabled: true\n",
        "SLACK_APP_TOKEN=xapp-fixture\nSLACK_BOT_TOKEN=xoxb-fixture\nVOICE_PORT=4777\n",
      ),
    ).rejects.toThrow("voiceWorker port collides with voice");
  });

  it("detects a collision with the Keychain-resolved VOICE_PORT when LiveKit is enabled", async () => {
    fromKeychainMock.mockImplementation((_instanceId, key) => (key === "VOICE_PORT" ? "4777" : ""));
    await expect(
      loadConfig(
        "instance:\n  id: fixture\n  portBase: 4700\n  ports:\n    voiceWorker: 4777\nvoice:\n  livekit:\n    enabled: true\n",
      ),
    ).rejects.toThrow("voiceWorker port collides with voice");
  });

  it("does not apply collision policy while LiveKit is disabled", async () => {
    const loaded = await loadConfig(
      "instance:\n  id: fixture\n  portBase: 4700\n  ports:\n    voice: 4777\n    voiceWorker: 4777\nvoice:\n  livekit:\n    enabled: false\n",
    );
    expect(loaded.voice.port).toBe(4777);
    expect(loaded.voice.workerPort).toBe(4777);
  });
});
