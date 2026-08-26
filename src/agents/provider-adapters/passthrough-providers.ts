import { fromKeychain } from "../../keychain/from-keychain.js";
import { TurnAssemblyError } from "./error-classification.js";
import type { AgentProviderId } from "./types.js";

/**
 * KPR-346 (epic KPR-345 §D1): Lane A passthrough providers — vendors that
 * operate an official Anthropic-compatible endpoint, run through the FULL
 * Claude-lane runtime (ClaudeAgentAdapter/AgentRunner: MCP tools, skills,
 * hooks, memory, subagents, resume) with per-spawn env substitution only.
 * Translation proxies are ruled out (epic canon); vendor-operated endpoints
 * are the rule. Grok was the one sanctioned exception (KPR-384: an
 * OPERATOR-hosted gateway, because the vendor endpoint itself is broken for
 * real toolkits) until KPR-392 promoted it to a native Lane B adapter
 * (`grok-gateway-adapter.ts`) — the gateway-exception canon note now lives
 * there; this table has no exceptions left. Adding the next compat vendor is:
 * one table row + one AgentProviderId union member + one SESSION_SEMANTICS
 * entry (compile-forced) + two resolveProviderModel-style prefix arms + the
 * isLaneAProvider body (NOT compile-forced) + a `credential` entry
 * (KPR-371) — no new code path.
 *
 * Lane A ids join AgentProviderId only. LaneBProviderId is NEVER touched:
 * these providers must never gain a tool-transport compatibility column or a
 * bridge path (decision-register canon).
 */
export type LaneAProviderId = "kimi" | "deepseek";

/**
 * Lane A credential source: a static key resolved env → Honeypot Keychain per
 * spawn. KPR-371 briefly widened this to a discriminated union with an
 * `oauth-file` variant for grok's vendor-CLI-owned subscription OAuth file;
 * KPR-384 retired that variant when grok moved behind the self-hosted
 * CLIProxyAPI gateway and its credential became an ordinary gateway API key.
 * KPR-392 then promoted grok off this table entirely — Lane B now resolves
 * its own gateway key via `resolveEnvKeyCredential` below (exported for
 * that purpose). The `kind` discriminant stays so a future non-key vendor
 * re-widens the union without touching existing rows.
 */
export type PassthroughCredential = { kind: "env-key"; key: string };

export interface PassthroughProviderDef {
  id: LaneAProviderId;
  displayName: string;
  /**
   * The endpoint the spawn's ANTHROPIC_BASE_URL is pinned to — the
   * vendor-operated Anthropic-compat endpoint (never a translation proxy —
   * epic KPR-345 canon). Grok was the one sanctioned exception (KPR-384: an
   * OPERATOR-hosted loopback CLIProxyAPI gateway, because xAI's own compat
   * endpoint rejects the CLI's tool schemas) until KPR-392 moved it to a
   * native Lane B adapter, taking the exception with it — this table's
   * remaining rows are all vendor-operated endpoints.
   */
  baseUrl: string;
  /** Env var that overrides `baseUrl` per spawn, for endpoints that are
   *  deployment infrastructure rather than a universal vendor address. The
   *  override is validated (https, or http to loopback only) — see
   *  assertSafeBaseUrlOverride. */
  baseUrlEnv?: string;
  /** Credential source — resolved PER SPAWN (env → Honeypot Keychain
   *  `hive/<instanceId>/<KEY>`), never boot-time. */
  credential: PassthroughCredential;
  /**
   * Fallback model when neither the route (`kimi/<model>`) nor config
   * (`KIMI_AGENT_MODEL` / `DEEPSEEK_AGENT_MODEL`) names one. Pinned at plan
   * time from vendor docs (2026-07-23):
   *  - kimi-k3: Moonshot flagship since 2026-07-16, served on the
   *    /anthropic endpoint (platform.kimi.ai models overview).
   *  - deepseek-v4-pro: DeepSeek's own Claude Code integration doc pins
   *    ANTHROPIC_MODEL=deepseek-v4-pro (deepseek-chat is deprecated
   *    2026-07-24 and must not be used).
   */
  defaultModel: string;
}

export const PASSTHROUGH_PROVIDERS: Readonly<Record<LaneAProviderId, PassthroughProviderDef>> = {
  kimi: {
    id: "kimi",
    displayName: "Kimi (Moonshot AI)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    credential: { kind: "env-key", key: "KIMI_API_KEY" },
    defaultModel: "kimi-k3",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    credential: { kind: "env-key", key: "DEEPSEEK_API_KEY" },
    defaultModel: "deepseek-v4-pro",
  },
};

/**
 * NOT compile-forced — a missed id here produces no compile error and no
 * runtime error, it just takes the wrong branch at agent-manager.ts's
 * session-handoff notice (degrades to the Lane B variant) and its :effort
 * clamp (silently dropped instead of clamped). Every Lane A id must appear.
 */
export function isLaneAProvider(p: AgentProviderId): p is LaneAProviderId {
  return p === "kimi" || p === "deepseek";
}

/** Per-spawn resolved shape handed to the runner (§D1). The credential lives
 *  only in this object's short spawn-env path — never in long-lived config. */
export interface PassthroughSpawnConfig {
  provider: LaneAProviderId;
  /** Resolved foreign model id (prefix + :effort already stripped). */
  model: string;
  baseUrl: string;
  authToken: string;
}

/**
 * KPR-346 (§D4): per-spawn credential + model resolution. Model chain mirrors
 * codex/openai/gemini: route.model || configured agentModel || table default.
 *
 * The credential is the standard secret-env pattern (agent-runner.ts plugin
 * stdio servers): process.env first, then Honeypot Keychain
 * (hive/<instanceId>/<KEY>) — per spawn, not boot-time, so `hive credentials
 * add` takes effect on the next spawn without a restart. The base URL is
 * likewise re-read per spawn when the row declares a `baseUrlEnv` override.
 * (KPR-371's async oauth-file arm lived here until KPR-384 removed it —
 * resolution is synchronous again.)
 *
 * Missing/empty credential throws TurnAssemblyError — classifyThrown
 * short-circuits it to non-provider BEFORE the pattern tables
 * (error-classification.ts:126-129). The breaker-invisibility guarantee is
 * the instanceof short-circuit, NOT the message: the message below
 * deliberately contains "authentication" so that, thrown as a plain Error,
 * it WOULD match the `auth` fault row and count toward the foreign
 * breaker's trip streak — which is exactly what the negative-verify leg
 * exploits to prove the typed wrapper is load-bearing. Config fault, not
 * provider fault (epic §D2).
 */
export function resolvePassthroughSpawn(
  provider: LaneAProviderId,
  routeModel: string,
  opts: {
    /** appConfig.<provider>.agentModel — non-secret, boot-time config. */
    configuredModel: string;
    instanceId: string;
    /** Test seam only; defaults to env → Keychain. */
    resolveSecret?: (instanceId: string, key: string) => string;
  },
): PassthroughSpawnConfig {
  const def = PASSTHROUGH_PROVIDERS[provider];
  const override = def.baseUrlEnv ? process.env[def.baseUrlEnv] : undefined;
  return {
    provider,
    model: routeModel || opts.configuredModel || def.defaultModel,
    baseUrl: override ? assertSafeBaseUrlOverride(override, def.baseUrlEnv!) : def.baseUrl,
    authToken: resolveEnvKeyCredential(def.credential.key, opts),
  };
}

/**
 * KPR-384 (review r1): a base-URL override redirects the auth token AND the
 * full prompt/tool-result stream, so refuse a cleartext off-box target:
 * `http:` is allowed only toward loopback hosts; anything else must be
 * `https:`. Thrown as TurnAssemblyError — a config fault, breaker-invisible
 * like every other Lane A assembly fault.
 */
export function assertSafeBaseUrlOverride(raw: string, envKey: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TurnAssemblyError(`${envKey} is not a valid URL ("${raw}") — fix or unset the override`);
  }
  const host = url.hostname;
  const loopback = host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TurnAssemblyError(
      `${envKey} ("${raw}") would send the credential and conversation over cleartext to a non-loopback host — use https:// for off-box gateways, or an http://127.0.0.1/localhost address`,
    );
  }
  return raw;
}

/** The env-key credential resolution — byte-for-byte the pre-KPR-371 behaviour. */
export function resolveEnvKeyCredential(
  key: string,
  opts: { instanceId: string; resolveSecret?: (instanceId: string, key: string) => string },
): string {
  const resolve =
    opts.resolveSecret ?? ((instanceId: string, k: string) => process.env[k] || fromKeychain(instanceId, k));
  const authToken = resolve(opts.instanceId, key);
  if (!authToken) {
    throw new TurnAssemblyError(
      `Passthrough credential missing (authentication): ${key} — seed it via \`hive credentials add ${key}\``,
    );
  }
  return authToken;
}

/**
 * KPR-346 (§D5): the passthrough env pin set, spread LAST into the runner's
 * query() env so every pin wins over process.env and the runner's own
 * entries.
 *  - ANTHROPIC_API_KEY: undefined scrubs both the runner's conditional
 *    injection and any ambient value (established pattern: CLAUDECODE).
 *  - All model pins point at ONE model — deliberate v1 posture (no per-tier
 *    foreign mapping, YAGNI); CLAUDE_CODE_SUBAGENT_MODEL ensures Task
 *    subagents never request a Claude id from a foreign endpoint.
 *  - ENABLE_TOOL_SEARCH forced "false": tool_reference blocks are
 *    unsupported on vendor compat endpoints (same failure mode as the
 *    KPR-329 proxy note).
 */
export function buildPassthroughEnv(p: PassthroughSpawnConfig): Record<string, string | undefined> {
  return {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.authToken,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_SMALL_FAST_MODEL: p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model,
    CLAUDE_CODE_SUBAGENT_MODEL: p.model,
    ENABLE_TOOL_SEARCH: "false",
    // KPR-346 spike finding: an inherited CLAUDE_CODE_ENTRYPOINT (e.g. a
    // nested/code_task/dev-shell context) makes the CLI treat the spawn as
    // first-party interactive and force OAuth over the injected env carrier.
    // Scrub it so the SDK re-stamps sdk-ts and precedence holds everywhere.
    CLAUDE_CODE_ENTRYPOINT: undefined,
  };
}
