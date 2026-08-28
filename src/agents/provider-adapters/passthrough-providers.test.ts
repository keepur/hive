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
  assertSafeBaseUrlOverride,
  resolveEnvKeyCredential,
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

  it("KPR-392: the table holds exactly kimi and deepseek — grok promoted off Lane A to a native Lane B module", () => {
    expect(Object.keys(PASSTHROUGH_PROVIDERS).sort()).toEqual(["deepseek", "kimi"]);
  });
});

describe("isLaneAProvider (KPR-346 §D1)", () => {
  it.each([
    ["kimi", true],
    ["deepseek", true],
    // KPR-392: explicit promotion pin — grok left Lane A for a native Lane B
    // module; NOT compile-forced, so this row guards the regression directly
    // (a false positive here would silently re-degrade the session-handoff
    // notice and re-clamp grok's :effort suffix).
    ["grok", false],
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

describe("assertSafeBaseUrlOverride (exported for kimi/deepseek + KPR-394 plugin api-key-env use)", () => {
  const call = (url: string) => assertSafeBaseUrlOverride(url, "TEST_URL_ENV");

  it.each(["http://localhost:9999", "http://127.0.0.1:8317", "http://127.5.5.5:80", "http://[::1]:8317", "https://gw.internal.example:8317"])(
    "accepts %s",
    (url) => {
      expect(call(url)).toBe(url);
    },
  );

  it("rejects cleartext http to a non-loopback host as a breaker-invisible config fault", () => {
    const attempt = () => call("http://gw.internal.example:8317");
    expect(attempt).toThrow(TurnAssemblyError);
    expect(attempt).toThrow(/cleartext to a non-loopback host/);
    let thrown: unknown;
    try {
      attempt();
    } catch (err) {
      thrown = err;
    }
    expect(classifyThrown(thrown)).toMatchObject({ outcome: "fault", kind: "non-provider" });
  });

  it("rejects a malformed override URL", () => {
    const attempt = () => call("not a url");
    expect(attempt).toThrow(TurnAssemblyError);
    expect(attempt).toThrow(/TEST_URL_ENV is not a valid URL/);
  });
});

describe("resolveEnvKeyCredential (exported for kimi/deepseek + KPR-394 plugin api-key-env use)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromKeychain.mockReturnValue("");
  });

  it("honors the resolveSecret test seam", () => {
    const token = resolveEnvKeyCredential("TEST_KEY", { instanceId: "inst", resolveSecret: () => "seam-tok" });
    expect(token).toBe("seam-tok");
    expect(mockFromKeychain).not.toHaveBeenCalled();
  });

  it("defaults to env-first-then-Keychain when no seam is supplied", () => {
    const ORIG = process.env.TEST_KEY;
    delete process.env.TEST_KEY;
    try {
      mockFromKeychain.mockReturnValue("kc-tok");
      const token = resolveEnvKeyCredential("TEST_KEY", { instanceId: "inst-7" });
      expect(token).toBe("kc-tok");
      expect(mockFromKeychain).toHaveBeenCalledWith("inst-7", "TEST_KEY");

      process.env.TEST_KEY = "env-tok";
      mockFromKeychain.mockClear();
      const envToken = resolveEnvKeyCredential("TEST_KEY", { instanceId: "inst-7" });
      expect(envToken).toBe("env-tok");
      expect(mockFromKeychain).not.toHaveBeenCalled();
    } finally {
      if (ORIG === undefined) delete process.env.TEST_KEY;
      else process.env.TEST_KEY = ORIG;
    }
  });

  it("missing credential throws TurnAssemblyError naming the key and the remediation, byte-pinned", () => {
    const call = () => resolveEnvKeyCredential("TEST_KEY", { instanceId: "inst", resolveSecret: () => "" });
    expect(call).toThrow(TurnAssemblyError);
    expect(call).toThrow(/Passthrough credential missing \(authentication\): TEST_KEY — seed it via `hive credentials add TEST_KEY`/);
    let thrown: unknown;
    try {
      call();
    } catch (err) {
      thrown = err;
    }
    expect(classifyThrown(thrown)).toMatchObject({ outcome: "fault", kind: "non-provider" });
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
