import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../keychain/from-keychain.js", () => ({
  fromKeychain: vi.fn(() => ""),
}));

vi.mock("./grok-oauth.js", () => ({
  resolveOAuthFileToken: vi.fn(async () => "grok-oauth-token"),
}));

import { fromKeychain } from "../../keychain/from-keychain.js";
import { classifyThrown, TurnAssemblyError } from "./error-classification.js";
import { resolveOAuthFileToken } from "./grok-oauth.js";
import {
  PASSTHROUGH_PROVIDERS,
  buildPassthroughEnv,
  isLaneAProvider,
  resolvePassthroughSpawn,
  type PassthroughSpawnConfig,
} from "./passthrough-providers.js";
import type { AgentProviderId } from "./types.js";

const mockFromKeychain = vi.mocked(fromKeychain);
const mockResolveOAuthFileToken = vi.mocked(resolveOAuthFileToken);

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

  it("KPR-371: grok carries the xAI endpoint, the OAuth-file credential, and grok-4.6", () => {
    expect(PASSTHROUGH_PROVIDERS.grok).toEqual({
      id: "grok",
      displayName: "Grok (xAI)",
      baseUrl: "https://api.x.ai",
      credential: { kind: "oauth-file", path: "~/.grok/auth.json" },
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
    it("route model wins over both configured and default", async () => {
      const cfg = await resolvePassthroughSpawn("kimi", "kimi/route-model", {
        configuredModel: "cfg-model",
        instanceId: "inst",
        resolveSecret: () => "tok",
      });
      expect(cfg.model).toBe("kimi/route-model");
    });

    it("empty route falls back to configured model", async () => {
      const cfg = await resolvePassthroughSpawn("kimi", "", {
        configuredModel: "cfg-model",
        instanceId: "inst",
        resolveSecret: () => "tok",
      });
      expect(cfg.model).toBe("cfg-model");
    });

    it("empty route + empty config falls back to the table default", async () => {
      const cfg = await resolvePassthroughSpawn("kimi", "", {
        configuredModel: "",
        instanceId: "inst",
        resolveSecret: () => "tok",
      });
      expect(cfg.model).toBe("kimi-k3");
    });
  });

  describe("credential chain: process.env first, then Keychain (per spawn)", () => {
    it("process.env.KIMI_API_KEY wins; Keychain is not consulted", async () => {
      process.env.KIMI_API_KEY = "env-tok";
      const cfg = await resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" });
      expect(cfg.authToken).toBe("env-tok");
      expect(mockFromKeychain).not.toHaveBeenCalled();
    });

    it("empty env → fromKeychain(instanceId, KIMI_API_KEY) is consulted", async () => {
      mockFromKeychain.mockReturnValue("kc-tok");
      const cfg = await resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst-7" });
      expect(cfg.authToken).toBe("kc-tok");
      expect(mockFromKeychain).toHaveBeenCalledWith("inst-7", "KIMI_API_KEY");
    });

    it("both empty → rejects with TurnAssemblyError naming the key and the remediation", async () => {
      mockFromKeychain.mockReturnValue("");
      const call = () => resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst" });
      await expect(call()).rejects.toThrow(TurnAssemblyError);
      await expect(call()).rejects.toThrow(/Passthrough credential missing \(authentication\): KIMI_API_KEY/);
      await expect(call()).rejects.toThrow(/hive credentials add/);
    });
  });

  it("breaker-invisibility: the missing-credential throw classifies non-provider, while the same message as a plain Error classifies auth", async () => {
    let thrown: unknown;
    try {
      await resolvePassthroughSpawn("kimi", "", { configuredModel: "", instanceId: "inst", resolveSecret: () => "" });
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

  it("the credential never leaks into any spawn-config field other than authToken", async () => {
    const cfg = await resolvePassthroughSpawn("kimi", "", {
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

describe("resolvePassthroughSpawn — oauth-file credential (KPR-371 §D2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveOAuthFileToken.mockResolvedValue("grok-oauth-token");
  });

  it("resolves the credential from the OAuth file, never from env/Keychain", async () => {
    const cfg = await resolvePassthroughSpawn("grok", "", {
      configuredModel: "",
      instanceId: "inst",
      resolveSecret: () => "SHOULD-NOT-BE-USED",
    });
    expect(cfg.authToken).toBe("grok-oauth-token");
    expect(mockResolveOAuthFileToken).toHaveBeenCalledWith("~/.grok/auth.json", {
      fetchImpl: undefined,
      now: undefined,
    });
    expect(mockFromKeychain).not.toHaveBeenCalled();
  });

  it("model chain: route → configured → grok-4.6", async () => {
    const base = { instanceId: "inst" };
    expect((await resolvePassthroughSpawn("grok", "grok-4.5", { ...base, configuredModel: "cfg" })).model).toBe(
      "grok-4.5",
    );
    expect((await resolvePassthroughSpawn("grok", "", { ...base, configuredModel: "cfg" })).model).toBe("cfg");
    expect((await resolvePassthroughSpawn("grok", "", { ...base, configuredModel: "" })).model).toBe("grok-4.6");
  });

  it("carries the xAI base URL into the spawn config", async () => {
    const cfg = await resolvePassthroughSpawn("grok", "", { configuredModel: "", instanceId: "inst" });
    expect(cfg.baseUrl).toBe("https://api.x.ai");
    expect(cfg.provider).toBe("grok");
  });

  it("propagates an OAuth failure unwrapped — the branch adds no wrapping", async () => {
    const failure = new TurnAssemblyError("Grok OAuth credential unavailable (authentication) at /x — run `grok login`");
    mockResolveOAuthFileToken.mockRejectedValue(failure);
    await expect(
      resolvePassthroughSpawn("grok", "", { configuredModel: "", instanceId: "inst" }),
    ).rejects.toBe(failure);
  });

  it("threads the fetch/now test seams through to the OAuth resolver", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const now = () => 42;
    await resolvePassthroughSpawn("grok", "", { configuredModel: "", instanceId: "inst", fetchImpl, now });
    expect(mockResolveOAuthFileToken).toHaveBeenCalledWith("~/.grok/auth.json", { fetchImpl, now });
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

  it("KPR-371: grok pins the xAI endpoint and grok-4.6 across every model var", () => {
    const env = buildPassthroughEnv({
      provider: "grok",
      model: "grok-4.6",
      baseUrl: "https://api.x.ai",
      authToken: "grok-oauth-token",
    });
    expect(env).toStrictEqual({
      ANTHROPIC_BASE_URL: "https://api.x.ai",
      ANTHROPIC_AUTH_TOKEN: "grok-oauth-token",
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
