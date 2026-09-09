import { beforeEach, describe, expect, it, vi } from "vitest";

interface MutableMockConfig {
  instance: { id: string };
  voice: {
    workerPort: number;
    port: number;
    bridgeToken: string;
    livekitApiKey: string;
    livekitApiSecret: string;
    livekit: {
      enabled: boolean;
      url: string;
      sipTrunkId: string;
      inboundAgents: Record<string, string>;
      agentVoices: Record<string, string>;
      defaultStt: string;
      defaultTts: string;
    };
  };
  mongo: { uri: string; dbName: string };
}

const { mockConfig, resolveSecretEnvMock, warnMock } = vi.hoisted(() => ({
  mockConfig: {} as MutableMockConfig,
  resolveSecretEnvMock: vi.fn<(key: string) => string>(),
  warnMock: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: mockConfig,
  resolveSecretEnv: resolveSecretEnvMock,
}));
vi.mock("../logging/logger.js", () => ({ createLogger: () => ({ warn: warnMock }) }));
vi.mock("../paths.js", () => ({ hiveHome: "/fixture/hive" }));

import { livekitServerAuth, loadWorkerConfig } from "./worker-config.js";

beforeEach(() => {
  Object.assign(mockConfig, {
    instance: { id: "fixture" },
    voice: {
      workerPort: 4107,
      port: 4105,
      bridgeToken: "bridge-token",
      livekitApiKey: "livekit-key",
      livekitApiSecret: "livekit-secret",
      livekit: {
        enabled: true,
        url: "wss://example.livekit.cloud",
        sipTrunkId: "ST_fixture",
        inboundAgents: { "+15551230000": "nora" },
        agentVoices: { nora: "voice-fixture" },
        defaultStt: "deepgram/flux-general-en",
        defaultTts: "cartesia/sonic-3",
      },
    },
    mongo: { uri: "mongodb://fixture/hive", dbName: "hive-fixture" },
  });
  resolveSecretEnvMock.mockReset();
  resolveSecretEnvMock.mockImplementation((key) => {
    const values: Record<string, string> = {
      DEEPGRAM_API_KEY: "deepgram-key",
      CARTESIA_API_KEY: "cartesia-key",
      ELEVENLABS_API_KEY: "elevenlabs-key",
    };
    return values[key] ?? "";
  });
  warnMock.mockReset();
});

describe("livekitServerAuth (KPR-322)", () => {
  it("returns wsURL, apiKey, and apiSecret from the worker config", () => {
    expect(
      livekitServerAuth({
        livekitUrl: "wss://example.livekit.cloud",
        livekitApiKey: "k",
        livekitApiSecret: "s",
      }),
    ).toEqual({
      wsURL: "wss://example.livekit.cloud",
      apiKey: "k",
      apiSecret: "s",
    });
  });

  it("keeps an empty url empty (does not invent localhost)", () => {
    expect(
      livekitServerAuth({
        livekitUrl: "",
        livekitApiKey: "k",
        livekitApiSecret: "s",
      }),
    ).toEqual({
      wsURL: "",
      apiKey: "k",
      apiSecret: "s",
    });
  });
});

describe("loadWorkerConfig", () => {
  it("propagates the resolved health port and preserves loader-owned values", () => {
    expect(loadWorkerConfig()).toEqual({
      instanceHome: "/fixture/hive",
      instanceId: "fixture",
      healthPort: 4107,
      livekitUrl: "wss://example.livekit.cloud",
      livekitApiKey: "livekit-key",
      livekitApiSecret: "livekit-secret",
      sipTrunkId: "ST_fixture",
      inboundAgents: { "+15551230000": "nora" },
      agentVoices: { nora: "voice-fixture" },
      defaultStt: "deepgram/flux-general-en",
      defaultTts: "cartesia/sonic-3",
      deepgramApiKey: "deepgram-key",
      cartesiaApiKey: "cartesia-key",
      elevenlabsApiKey: "elevenlabs-key",
      bridgeToken: "bridge-token",
      bridgeUrl: "http://127.0.0.1:4105/v1/chat/completions",
      mongoUri: "mongodb://fixture/hive",
      mongoDbName: "hive-fixture",
    });
    expect(resolveSecretEnvMock.mock.calls.map(([key]) => key)).toEqual([
      "DEEPGRAM_API_KEY",
      "CARTESIA_API_KEY",
      "ELEVENLABS_API_KEY",
    ]);
  });

  it("fails before resolving vendor secrets when LiveKit is disabled", () => {
    mockConfig.voice.livekit.enabled = false;
    expect(() => loadWorkerConfig()).toThrow("voice.livekit.enabled is false");
    expect(resolveSecretEnvMock).not.toHaveBeenCalled();
  });

  it.each([
    ["livekitUrl", () => (mockConfig.voice.livekit.url = "")],
    ["livekitApiKey", () => (mockConfig.voice.livekitApiKey = "")],
    ["livekitApiSecret", () => (mockConfig.voice.livekitApiSecret = "")],
    ["deepgramApiKey", () => resolveSecretEnvMock.mockImplementation((key) => (key === "DEEPGRAM_API_KEY" ? "" : "x"))],
    ["bridgeToken", () => (mockConfig.voice.bridgeToken = "")],
  ])("retains the required-key failure for %s", (name, remove) => {
    remove();
    expect(() => loadWorkerConfig()).toThrow(`voice worker missing required config: ${name}`);
  });

  it("requires the selected Cartesia vendor key", () => {
    resolveSecretEnvMock.mockImplementation((key) => (key === "CARTESIA_API_KEY" ? "" : "x"));
    expect(() => loadWorkerConfig()).toThrow("CARTESIA_API_KEY missing for default TTS cell");
  });

  it("requires the selected ElevenLabs vendor key", () => {
    mockConfig.voice.livekit.defaultTts = "elevenlabs/eleven_flash_v2_5";
    resolveSecretEnvMock.mockImplementation((key) => (key === "ELEVENLABS_API_KEY" ? "" : "x"));
    expect(() => loadWorkerConfig()).toThrow("ELEVENLABS_API_KEY missing for default TTS cell");
  });

  it("warns but starts when only the unselected vendor key is missing", () => {
    resolveSecretEnvMock.mockImplementation((key) => (key === "ELEVENLABS_API_KEY" ? "" : "x"));
    expect(loadWorkerConfig().defaultTts).toBe("cartesia/sonic-3");
    expect(warnMock).toHaveBeenCalledOnce();
  });
});
