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
      credential: { kind: "env-key", key: "KIMI_API_KEY" },
      defaultModel: "kimi-k3",
    });
    expect(PASSTHROUGH_PROVIDERS.deepseek).toEqual({
      id: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      credential: { kind: "env-key", key: "DEEPSEEK_API_KEY" },
      defaultModel: "deepseek-v4-pro",
    });
  });

  it("KPR-384: grok carries the loopback gateway endpoint (env-overridable), the gateway-key credential, and grok-4.6", () => {
    expect(PASSTHROUGH_PROVIDERS.grok).toEqual({
      id: "grok",
      displayName: "Grok (xAI)",
      baseUrl: "http://127.0.0.1:8317",
      baseUrlEnv: "GROK_GATEWAY_URL",
      credential: { kind: "env-key", key: "GROK_GATEWAY_KEY" },
      defaultModel: "grok-4.6",
    });
  });
});

describe("isLaneAProvider (KPR-346 §D1)", () => {
  it.each([
    ["kimi", true],
    ["deepseek", true],
    // KPR-371: NOT compile-forced. A missed id here silently degrades the
    // session-handoff notice and silently drops :effort instead of clamping.
    ["grok", true],
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
      const call = () => resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" });
      expect(call).toThrow(TurnAssemblyError);
      expect(call).toThrow(/Passthrough credential missing \(authentication\): KIMI_API_KEY/);
      expect(call).toThrow(/hive credentials add/);
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

describe("resolvePassthroughSpawn — grok gateway (KPR-384)", () => {
  const ORIG_KEY = process.env.GROK_GATEWAY_KEY;
  const ORIG_URL = process.env.GROK_GATEWAY_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFromKeychain.mockReturnValue("");
    delete process.env.GROK_GATEWAY_KEY;
    delete process.env.GROK_GATEWAY_URL;
  });

  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.GROK_GATEWAY_KEY;
    else process.env.GROK_GATEWAY_KEY = ORIG_KEY;
    if (ORIG_URL === undefined) delete process.env.GROK_GATEWAY_URL;
    else process.env.GROK_GATEWAY_URL = ORIG_URL;
  });

  it("resolves GROK_GATEWAY_KEY on the standard env → Keychain chain — no OAuth-file path remains", () => {
    process.env.GROK_GATEWAY_KEY = "gw-env-tok";
    const cfg = resolvePassthroughSpawn("grok", "", { configuredModel: "", instanceId: "inst" });
    expect(cfg.authToken).toBe("gw-env-tok");
    expect(mockFromKeychain).not.toHaveBeenCalled();

    delete process.env.GROK_GATEWAY_KEY;
    mockFromKeychain.mockReturnValue("gw-kc-tok");
    const kc = resolvePassthroughSpawn("grok", "", { configuredModel: "", instanceId: "inst-9" });
    expect(kc.authToken).toBe("gw-kc-tok");
    expect(mockFromKeychain).toHaveBeenCalledWith("inst-9", "GROK_GATEWAY_KEY");
  });

  it("missing gateway key throws the standard breaker-invisible config fault naming GROK_GATEWAY_KEY", () => {
    const call = () => resolvePassthroughSpawn("grok", "", { configuredModel: "", instanceId: "inst" });
    expect(call).toThrow(TurnAssemblyError);
    expect(call).toThrow(/Passthrough credential missing \(authentication\): GROK_GATEWAY_KEY/);
    let thrown: unknown;
    try {
      call();
    } catch (err) {
      thrown = err;
    }
    expect(classifyThrown(thrown)).toMatchObject({ outcome: "fault", kind: "non-provider" });
  });

  it("model chain: route → configured → grok-4.6", () => {
    const base = { instanceId: "inst", resolveSecret: () => "tok" };
    expect(resolvePassthroughSpawn("grok", "grok-4.5", { ...base, configuredModel: "cfg" }).model).toBe("grok-4.5");
    expect(resolvePassthroughSpawn("grok", "", { ...base, configuredModel: "cfg" }).model).toBe("cfg");
    expect(resolvePassthroughSpawn("grok", "", { ...base, configuredModel: "" }).model).toBe("grok-4.6");
  });

  it("carries the loopback gateway base URL by default", () => {
    const cfg = resolvePassthroughSpawn("grok", "", {
      configuredModel: "",
      instanceId: "inst",
      resolveSecret: () => "tok",
    });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8317");
    expect(cfg.provider).toBe("grok");
  });

  it("GROK_GATEWAY_URL overrides the gateway address per spawn", () => {
    process.env.GROK_GATEWAY_URL = "http://127.0.0.1:9999";
    const cfg = resolvePassthroughSpawn("grok", "", {
      configuredModel: "",
      instanceId: "inst",
      resolveSecret: () => "tok",
    });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:9999");

    // Per-spawn, not module-load: clearing the override restores the default
    // on the very next resolution.
    delete process.env.GROK_GATEWAY_URL;
    const next = resolvePassthroughSpawn("grok", "", {
      configuredModel: "",
      instanceId: "inst",
      resolveSecret: () => "tok",
    });
    expect(next.baseUrl).toBe("http://127.0.0.1:8317");
  });

  describe("override validation: https, or http to loopback only (review r1)", () => {
    const base = { configuredModel: "", instanceId: "inst", resolveSecret: () => "tok" };
    const call = () => resolvePassthroughSpawn("grok", "", base);

    it.each(["http://localhost:9999", "http://127.0.0.1:8317", "http://127.5.5.5:80", "http://[::1]:8317", "https://gw.internal.example:8317"])(
      "accepts %s",
      (url) => {
        process.env.GROK_GATEWAY_URL = url;
        expect(call().baseUrl).toBe(url);
      },
    );

    it("rejects cleartext http to a non-loopback host as a breaker-invisible config fault", () => {
      process.env.GROK_GATEWAY_URL = "http://gw.internal.example:8317";
      expect(call).toThrow(TurnAssemblyError);
      expect(call).toThrow(/cleartext to a non-loopback host/);
      let thrown: unknown;
      try {
        call();
      } catch (err) {
        thrown = err;
      }
      expect(classifyThrown(thrown)).toMatchObject({ outcome: "fault", kind: "non-provider" });
    });

    it("rejects a malformed override URL", () => {
      process.env.GROK_GATEWAY_URL = "not a url";
      expect(call).toThrow(TurnAssemblyError);
      expect(call).toThrow(/GROK_GATEWAY_URL is not a valid URL/);
    });
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

  it("KPR-384: grok pins the gateway endpoint and grok-4.6 across every model var", () => {
    const env = buildPassthroughEnv({
      provider: "grok",
      model: "grok-4.6",
      baseUrl: "http://127.0.0.1:8317",
      authToken: "grok-gateway-key",
    });
    expect(env).toStrictEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "grok-gateway-key",
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: "grok-4.6",
      ANTHROPIC_SMALL_FAST_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "grok-4.6",
      CLAUDE_CODE_SUBAGENT_MODEL: "grok-4.6",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_ENTRYPOINT: undefined,
    });
  });
});
