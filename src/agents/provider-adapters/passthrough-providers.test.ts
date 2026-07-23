import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../keychain/from-keychain.js", () => ({
  fromKeychain: vi.fn(() => ""),
}));

import { fromKeychain } from "../../keychain/from-keychain.js";
import { classifyThrown, TurnAssemblyError } from "./error-classification.js";
import {
  PASSTHROUGH_PROVIDERS,
  buildPassthroughEnv,
  isLaneAProvider,
  resolvePassthroughSpawn,
  type PassthroughSpawnConfig,
} from "./passthrough-providers.js";
import type { AgentProviderId } from "./types.js";

const mockFromKeychain = vi.mocked(fromKeychain);

describe("PASSTHROUGH_PROVIDERS table (KPR-346 §D1)", () => {
  it("carries the exact vendor endpoints, key names, and default models", () => {
    expect(PASSTHROUGH_PROVIDERS.kimi).toEqual({
      id: "kimi",
      displayName: "Kimi (Moonshot AI)",
      baseUrl: "https://api.moonshot.ai/anthropic",
      authTokenKey: "KIMI_API_KEY",
      defaultModel: "kimi-k3",
    });
    expect(PASSTHROUGH_PROVIDERS.deepseek).toEqual({
      id: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      authTokenKey: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-v4-pro",
    });
  });
});

describe("isLaneAProvider (KPR-346 §D1)", () => {
  it.each([
    ["kimi", true],
    ["deepseek", true],
    ["claude", false],
    ["openai", false],
    ["gemini", false],
    ["codex", false],
  ] as const)("%s → %s", (provider, expected) => {
    expect(isLaneAProvider(provider as AgentProviderId)).toBe(expected);
  });
});

describe("resolvePassthroughSpawn (KPR-346 §D4)", () => {
  const ORIG_KIMI = process.env.KIMI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFromKeychain.mockReturnValue("");
    delete process.env.KIMI_API_KEY;
  });

  afterEach(() => {
    if (ORIG_KIMI === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = ORIG_KIMI;
  });

  describe("model chain: route.model || configuredModel || table default", () => {
    it("route model wins over both configured and default", () => {
      const cfg = resolvePassthroughSpawn("kimi", "kimi/route-model", {
        configuredModel: "cfg-model",
        instanceId: "inst",
        resolveSecret: () => "tok",
      });
      expect(cfg.model).toBe("kimi/route-model");
    });

    it("empty route falls back to configured model", () => {
      const cfg = resolvePassthroughSpawn("kimi", "", {
        configuredModel: "cfg-model",
        instanceId: "inst",
        resolveSecret: () => "tok",
      });
      expect(cfg.model).toBe("cfg-model");
    });

    it("empty route + empty config falls back to the table default", () => {
      const cfg = resolvePassthroughSpawn("kimi", "", {
        configuredModel: "",
        instanceId: "inst",
        resolveSecret: () => "tok",
      });
      expect(cfg.model).toBe("kimi-k3");
    });
  });

  describe("credential chain: process.env first, then Keychain (per spawn)", () => {
    it("process.env.KIMI_API_KEY wins; Keychain is not consulted", () => {
      process.env.KIMI_API_KEY = "env-tok";
      const cfg = resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" });
      expect(cfg.authToken).toBe("env-tok");
      expect(mockFromKeychain).not.toHaveBeenCalled();
    });

    it("empty env → fromKeychain(instanceId, KIMI_API_KEY) is consulted", () => {
      mockFromKeychain.mockReturnValue("kc-tok");
      const cfg = resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst-7" });
      expect(cfg.authToken).toBe("kc-tok");
      expect(mockFromKeychain).toHaveBeenCalledWith("inst-7", "KIMI_API_KEY");
    });

    it("both empty → throws TurnAssemblyError naming the key and the remediation", () => {
      mockFromKeychain.mockReturnValue("");
      expect(() =>
        resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" }),
      ).toThrow(TurnAssemblyError);
      expect(() =>
        resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" }),
      ).toThrow(/Passthrough credential missing \(authentication\): KIMI_API_KEY/);
      expect(() =>
        resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" }),
      ).toThrow(/hive credentials add/);
    });
  });

  it("breaker-invisibility: the missing-credential throw classifies non-provider, while the same message as a plain Error classifies auth", () => {
    let thrown: unknown;
    try {
      resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst", resolveSecret: () => "" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAssemblyError);
    // The typed wrapper short-circuits to non-provider (instanceof, NOT message).
    expect(classifyThrown(thrown)).toMatchObject({ outcome: "fault", kind: "non-provider" });
    // Control: the SAME message, thrown as a plain Error, matches the auth row —
    // proving the instanceof short-circuit (not the message) is load-bearing.
    const message = (thrown as Error).message;
    expect(classifyThrown(new Error(message))).toMatchObject({ outcome: "fault", kind: "auth" });
  });

  it("the credential never leaks into any spawn-config field other than authToken", () => {
    const cfg = resolvePassthroughSpawn("kimi", "", {
      configuredModel: "",
      instanceId: "inst",
      resolveSecret: () => "SECRET-TOK",
    });
    expect(cfg.authToken).toBe("SECRET-TOK");
    expect(cfg.provider).toBe("kimi");
    expect(cfg.model).toBe("kimi-k3");
    expect(cfg.baseUrl).toBe("https://api.moonshot.ai/anthropic");
    expect(cfg.baseUrl).not.toContain("SECRET-TOK");
    expect(cfg.model).not.toContain("SECRET-TOK");
    expect(cfg.provider).not.toContain("SECRET-TOK");
  });
});

describe("buildPassthroughEnv (KPR-346 §D5)", () => {
  const sample: PassthroughSpawnConfig = {
    provider: "kimi",
    model: "kimi-k3",
    baseUrl: "https://api.moonshot.ai/anthropic",
    authToken: "tok-123",
  };

  it("spreads the exact 11-key pin record (ANTHROPIC_API_KEY + CLAUDE_CODE_ENTRYPOINT present-as-key with value undefined)", () => {
    const env = buildPassthroughEnv(sample);

    // Present-as-key containment for the two scrub pins (undefined values).
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "ENABLE_TOOL_SEARCH",
    ]);
    expect(Object.keys(env)).toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(env)).toContain("CLAUDE_CODE_ENTRYPOINT");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();

    // Full deep-equal (toStrictEqual retains the undefined-valued keys).
    expect(env).toStrictEqual({
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tok-123",
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: "kimi-k3",
      ANTHROPIC_SMALL_FAST_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_ENTRYPOINT: undefined,
    });
  });
});
