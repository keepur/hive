import dotenv from "dotenv";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { AUTONOMY_DEFAULTS } from "./agents/autonomy.js";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG, type CircuitBreakerConfig } from "./agents/provider-circuit-breaker.js";
import { DEFAULT_OUTAGE_QUEUE_CONFIG, type OutageQueueConfig } from "./outage/outage-queue-store.js";
import { fromKeychain as fromKeychainRaw } from "./keychain/from-keychain.js";
import { engineDir, hiveHome, resolveConfigFile, resolveDotenvPath } from "./paths.js";

// Load .env from resolved hive home
const dotenvPath = resolveDotenvPath(hiveHome);
dotenv.config({ path: dotenvPath });

function required(key: string): string {
  const val = process.env[key] || fromKeychain(key);
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fromKeychain(key) || fallback;
}

/**
 * Normalize `hive.google.accounts` to `Record<string, string[]>`.
 * Accepts string (single account) or string[] (multi-account) per agent.
 * Filters out falsy/empty values; preserves declaration order (first = default).
 * Explicitly rejects array inputs — YAML maps can't produce arrays at this
 * position, but the typed input is `unknown` so guard against stringly-keyed
 * garbage if a future caller hands us `[]` or `[["agent", "email"]]`.
 */
export function normalizeGoogleAccounts(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [agentId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) {
      out[agentId] = [val.trim()];
    } else if (Array.isArray(val)) {
      const list = val.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
      if (list.length > 0) out[agentId] = list;
    }
  }
  return out;
}

/**
 * KPR-306: resolve the optional hive.yaml `circuitBreaker` section.
 * Liberal-loader style (KPR-225 F3): all keys optional, unknown keys
 * ignored, non-object/garbage input → all defaults. Numbers must be finite
 * and > 0 or they fall back; p95MinSamples is clamped to p95WindowSize so a
 * misconfigured gate can't make the p95 rule unreachable silently.
 * Read once at boot (registry construction) — changes need a restart, like
 * every other hive.yaml key.
 */
export function resolveCircuitBreakerConfig(raw: unknown): CircuitBreakerConfig {
  const d = DEFAULT_CIRCUIT_BREAKER_CONFIG;
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  const windowSize = num(src.p95WindowSize, d.p95WindowSize);
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : d.enabled,
    consecutiveFaultThreshold: num(src.consecutiveFaultThreshold, d.consecutiveFaultThreshold),
    openBaseMs: num(src.openBaseMs, d.openBaseMs),
    openMaxMs: num(src.openMaxMs, d.openMaxMs),
    p95WindowSize: windowSize,
    p95MinSamples: Math.min(num(src.p95MinSamples, d.p95MinSamples), windowSize),
    p95ThresholdMs: num(src.p95ThresholdMs, d.p95ThresholdMs),
  };
}

/**
 * KPR-307: liberal-loader resolver for the `outageQueue` hive.yaml section
 * (KPR-225 F3 — all keys optional, unknown keys ignored, absent section =
 * all defaults). Exported pure for unit tests.
 */
export function resolveOutageQueueConfig(raw: unknown): OutageQueueConfig {
  const d = DEFAULT_OUTAGE_QUEUE_CONFIG;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  const posNum = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    replayIntervalMs: posNum(r.replayIntervalMs, d.replayIntervalMs),
    maxAgeHours: posNum(r.maxAgeHours, d.maxAgeHours),
    maxDepth: posNum(r.maxDepth, d.maxDepth),
    maxReplayAttempts: posNum(r.maxReplayAttempts, d.maxReplayAttempts),
  };
}

/**
 * KPR-329: tool-search (deferred MCP tool loading) mode. Controls the
 * `ENABLE_TOOL_SEARCH` env var pinned on every Claude-provider spawn:
 *   auto → CLI threshold mode (defer only past ~10% context) — engine default
 *   on   → always defer eligible MCP tool schemas
 *   off  → eager loading (today's intended behavior) — the rollback posture
 */
export type ToolSearchMode = "auto" | "on" | "off";

export interface ToolSearchConfig {
  mode: ToolSearchMode;
  /** Where `mode` came from — explicit hive.yaml value vs engine default.
   *  Feeds the per-spawn debug log (`source=agent|hive.yaml|default`). */
  source: "hive.yaml" | "default";
}

export const DEFAULT_TOOL_SEARCH_CONFIG: ToolSearchConfig = { mode: "auto", source: "default" };

/** Type guard shared by the loader; agent-side guards live at their own boundaries. */
export function isToolSearchMode(v: unknown): v is ToolSearchMode {
  return v === "auto" || v === "on" || v === "off";
}

/**
 * KPR-329: liberal-loader resolver for the `toolSearch` hive.yaml section
 * (KPR-225 F3 — all keys optional, unknown keys ignored, absent section =
 * all defaults, invalid mode → warn + default). Exported pure for unit tests.
 */
export function resolveToolSearchConfig(raw: unknown): ToolSearchConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TOOL_SEARCH_CONFIG };
  const r = raw as Record<string, unknown>;
  if (r.mode === undefined) return { ...DEFAULT_TOOL_SEARCH_CONFIG };
  if (isToolSearchMode(r.mode)) return { mode: r.mode, source: "hive.yaml" };
  console.warn(
    `[config] toolSearch.mode "${String(r.mode)}" is invalid — expected auto | on | off; defaulting to "auto".`,
  );
  return { ...DEFAULT_TOOL_SEARCH_CONFIG };
}

/**
 * KPR-242: warn once at config load if hive.yaml still carries the deprecated
 * `google.account` field. Exported so unit tests can exercise it directly.
 */
export function warnIfLegacyGoogleAccount(rawHive: Record<string, unknown> | undefined): void {
  const g = rawHive?.google;
  if (g && typeof g === "object" && "account" in g) {
    console.warn(
      "[config] `google.account` is deprecated and unused; " +
        "use `google.accounts.<agentId>` (string for single account, string[] for multi-account) to grant Google access per agent.",
    );
  }
}

/** Auto-discover all plugin dirs under <engineDir>/plugins/claude-code/, or use explicit list from hive.yaml */
function discoverPluginDirs(yamlDirs?: string[]): string[] {
  // Explicit list in hive.yaml takes precedence
  if (yamlDirs?.length) {
    return yamlDirs.map((d) => resolve(d.replace(/^~/, process.env.HOME ?? "/tmp")));
  }
  // Auto-scan <engineDir>/plugins/claude-code/*/
  const parentDir = resolve(engineDir, "plugins/claude-code");
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir)
    .map((name) => resolve(parentDir, name))
    .filter((p) => statSync(p).isDirectory());
}

// Load hive.yaml from resolved hive home
const hiveConfigPath = resolveConfigFile(hiveHome);
let hive: Record<string, any> = {};
if (existsSync(hiveConfigPath)) {
  hive = parseYaml(readFileSync(hiveConfigPath, "utf-8")) ?? {};
}

warnIfLegacyGoogleAccount(hive);

const home = process.env.HOME ?? "/tmp";

// Instance identity — single source of truth for multi-instance derivation
const instanceId = (hive.instance?.id as string) ?? "hive";

/** Closure over `instanceId` — lets `required()` / `optional()` stay unchanged. */
const fromKeychain = (key: string) => fromKeychainRaw(instanceId, key);

const portBase = (hive.instance?.portBase as number) ?? 3100;
const ports = (hive.instance?.ports as Record<string, number>) ?? {};

export interface RegistryConfig {
  name: string;
  url: string;
  default?: boolean;
}

export interface OperatorSkillsRepoConfig {
  url: string;
  branch: string;
}

export interface RetentionPathConfig {
  /** Number of days to keep files. `0` means keep forever. Negative values are rejected. */
  days: number;
}

export interface RetentionConfig {
  /** When false, sweeper logs + reports candidates but does not delete (ship as false). */
  enabled: boolean;
  /** Interval between sweeps. Defaults to 7 days. */
  intervalMs: number;
  /** Fallback retention for any path not in `paths`. */
  defaultDays: number;
  /** Per-path retention. Keys are glob-like strings relative to hiveHome (e.g. "agents/*\/scratch"). */
  paths: Record<string, RetentionPathConfig>;
}

export interface SmsLine {
  id: string;
  label: string;
  number: string;
  slackChannel: string;
}

export interface QuoLine {
  id: string;
  number: string;
  label: string;
}

export const config = {
  instance: { id: instanceId, portBase },
  business: {
    name: hive.business?.name ?? optional("BUSINESS_NAME", ""),
    description: hive.business?.description ?? "",
    location: hive.business?.location ?? "",
    ownerName: hive.business?.owner?.name ?? "",
    ownerRole: hive.business?.owner?.role ?? "",
  },
  slack: {
    appToken: required("SLACK_APP_TOKEN"),
    botToken: required("SLACK_BOT_TOKEN"),
    mcpToken: optional("SLACK_MCP_TOKEN", ""),
    auditChannel: optional("SLACK_AUDIT_CHANNEL", hive.slack?.auditChannel ?? ""),
    localMcpServer: Boolean(hive.slack?.localMcpServer ?? false),
  },
  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
  },
  openai: {
    agentModel: optional("OPENAI_AGENT_MODEL", ""),
  },
  codex: {
    agentModel: optional("CODEX_AGENT_MODEL", "gpt-5.4-mini"),
  },
  linear: {
    apiKey: optional("LINEAR_API_KEY", ""),
    teamId: optional("LINEAR_TEAM_ID", ""),
  },
  clickup: {
    apiToken: optional("CLICKUP_API_TOKEN", ""),
  },
  github: {
    repo: optional("GITHUB_REPO", ""),
    token: optional("GH_TOKEN", ""),
  },
  brave: {
    apiKey: optional("BRAVE_API_KEY", ""),
  },
  taskLedger: {
    apiUrl: optional("TASK_LEDGER_API_URL", "http://localhost:3002"),
    /** Per-agent API keys for task attribution. Falls back to shared TASK_LEDGER_API_KEY. */
    agentKeys: Object.fromEntries(
      Object.entries(process.env)
        .filter(([k]) => k.startsWith("TASK_LEDGER_KEY_"))
        .map(([k, v]) => [k.replace("TASK_LEDGER_KEY_", "").toLowerCase().replace(/_/g, "-"), v!]),
    ) as Record<string, string>,
    apiKey: optional("TASK_LEDGER_API_KEY", ""),
  },
  mongo: {
    uri: optional("MONGODB_URI", "mongodb://localhost:27017"),
    dbName: optional("MONGODB_DB", `hive_${instanceId}`),
  },
  defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff"),
  google: {
    client: optional("GOG_CLIENT", hive.google?.client ?? ""),
    accounts: normalizeGoogleAccounts(hive.google?.accounts),
    sharedFolder: optional(
      "DRIVE_SHARED_FOLDER",
      hive.google?.sharedFolder ?? hive.googleWorkspace?.sharedFolder ?? "",
    ),
  },
  googleWorkspace: {
    account: optional("GWS_ACCOUNT", hive.googleWorkspace?.account ?? ""),
    gwsPath: optional("GWS_PATH", ""),
    sharedFolder: optional("GWS_SHARED_FOLDER", hive.googleWorkspace?.sharedFolder ?? ""),
  },
  quo: {
    apiKey: optional("QUO_API_KEY", ""),
    phoneNumberId: optional("QUO_PHONE_NUMBER_ID", ""),
    lines: (hive.quo?.lines ?? {}) as Record<string, QuoLine>,
  },
  sms: {
    lines: (hive.sms?.lines ?? []) as SmsLine[],
  },
  imessage: {
    enabled: (hive.imessage?.enabled ?? false) as boolean,
    slackChannel: (hive.imessage?.slackChannel ?? "imessage") as string,
    hotWindowMs: (hive.imessage?.hotWindowMs ?? 300_000) as number,
    coldIntervalMs: (hive.imessage?.coldIntervalMs ?? 300_000) as number,
    hotIntervalMs: (hive.imessage?.hotIntervalMs ?? 10_000) as number,
  },
  resend: {
    apiKey: optional("RESEND_API_KEY", ""),
    fromAddress: optional("RESEND_FROM_ADDRESS", ""),
    defaultCc: optional("RESEND_DEFAULT_CC", ""),
    defaultBcc: optional("RESEND_DEFAULT_BCC", ""),
    emailDomain: optional("RESEND_EMAIL_DOMAIN", hive.resend?.emailDomain ?? ""),
    businessName: optional("RESEND_BUSINESS_NAME", hive.resend?.businessName ?? ""),
  },
  plugins: (hive.plugins ?? []) as string[],
  skillRegistries: (hive.skillRegistries as RegistryConfig[] | undefined) ?? [
    { name: "keepur-default", url: "https://github.com/keepur/hive-skills", default: true },
  ],
  operatorSkillsRepo: hive.operatorSkillsRepo
    ? ({
        url: String((hive.operatorSkillsRepo as { url: unknown }).url),
        branch: (hive.operatorSkillsRepo as { branch?: unknown }).branch
          ? String((hive.operatorSkillsRepo as { branch: unknown }).branch)
          : "main",
      } as OperatorSkillsRepoConfig)
    : null,
  gemini: {
    apiKey: optional("GEMINI_API_KEY", ""),
    visionModel: optional("GEMINI_VISION_MODEL", "gemini-2.5-flash"),
    agentModel: optional("GEMINI_AGENT_MODEL", ""),
  },
  permits: {
    mongoUri: optional("PERMITS_MONGO_URI", "mongodb://localhost:27017/permits"),
  },
  recall: {
    apiKey: optional("RECALL_API_KEY", ""),
    region: optional("RECALL_API_REGION", "us-west-2"),
    monitorPort: parseInt(optional("MEETING_MONITOR_PORT", String(ports.recall ?? portBase + 1)), 10),
    monitorPublicUrl: optional("MEETING_MONITOR_PUBLIC_URL", ""),
    webhookSecret: optional("RECALL_WEBHOOK_SECRET", ""),
  },
  scheduler: {
    heartbeatIntervalMs: parseInt(optional("HEARTBEAT_INTERVAL_MS", "120000"), 10),
  },
  background: {
    port: parseInt(optional("BG_TASK_PORT", String(ports.background ?? portBase)), 10),
    authToken: optional("BG_TASK_AUTH_TOKEN", "") || randomUUID(),
  },
  slackInternal: {
    port: parseInt(optional("SLACK_INTERNAL_PORT", String(ports.slackInternal ?? portBase + 6)), 10),
    authToken: optional("SLACK_INTERNAL_TOKEN", "") || randomUUID(),
  },
  codeTask: {
    port: parseInt(optional("CODE_TASK_PORT", String(ports.codeTask ?? portBase + 2)), 10),
    authToken: optional("CODE_TASK_AUTH_TOKEN", "") || randomUUID(),
    pluginDirs: discoverPluginDirs((hive.codeTask as Record<string, unknown>)?.pluginDirs as string[] | undefined),
    defaultModel: optional("CODE_TASK_MODEL", "claude-sonnet-4-6"),
    defaultMaxTurns: parseInt(optional("CODE_TASK_MAX_TURNS", "100"), 10),
    defaultMaxBudget: parseFloat(optional("CODE_TASK_MAX_BUDGET", "5.00")),
    maxConcurrent: parseInt(optional("CODE_TASK_MAX_CONCURRENT", "2"), 10),
    maxLifetimeMs: parseInt(optional("CODE_TASK_MAX_LIFETIME_MS", String(8 * 60 * 60 * 1000)), 10),
    staleGraceMs: parseInt(optional("CODE_TASK_STALE_GRACE_MS", String(30 * 60 * 1000)), 10),
  },
  ws: {
    enabled: optional("WS_ENABLED", "false") === "true",
    port: parseInt(optional("WS_PORT", String(ports.ws ?? portBase + 3)), 10),
  },
  beekeeper: {
    port: parseInt(optional("BEEKEEPER_PORT", String((hive.beekeeper as { port?: number })?.port ?? 8420)), 10),
  },
  workflow: {
    enabled: optional("WORKFLOW_ENABLED", "false") === "true",
  },
  adminApi: {
    port: parseInt(optional("ADMIN_API_PORT", String(ports.adminApi ?? portBase + 4)), 10),
    token: optional("ADMIN_API_TOKEN", ""),
  },
  voice: {
    enabled: !!hive.voice?.provider,
    provider: (hive.voice?.provider as string) ?? "",
    publicUrl: (hive.voice?.publicUrl as string) ?? "",
    phoneNumberId: (hive.voice?.phoneNumberId as string) ?? "",
    assistants: (hive.voice?.assistants ?? {}) as Record<string, string>,
    apiKey: optional("VAPI_API_KEY", ""),
    serverSecret: optional("VAPI_SERVER_SECRET", ""),
    port: parseInt(optional("VOICE_PORT", String(ports.voice ?? portBase + 5)), 10),
  },
  autonomy: {
    externalComms: (hive.autonomy?.externalComms ?? AUTONOMY_DEFAULTS.externalComms) as boolean,
    codeTask: (hive.autonomy?.codeTask ?? AUTONOMY_DEFAULTS.codeTask) as boolean,
    codeAccess: (hive.autonomy?.codeAccess ?? AUTONOMY_DEFAULTS.codeAccess) as boolean,
  },
  modelRouter: {
    enabled: optional("MODEL_ROUTER_ENABLED", "true") === "true",
    model: optional("MODEL_ROUTER_MODEL", "claude-haiku-4-5-20251001"),
    timeoutMs: parseInt(optional("MODEL_ROUTER_TIMEOUT_MS", "8000"), 10),
  },
  // KPR-306: provider circuit breaker (hive.yaml `circuitBreaker`, all keys
  // optional; enabled:false = shadow mode — observe + telemetry, never fast-fail).
  circuitBreaker: resolveCircuitBreakerConfig(hive.circuitBreaker),
  // KPR-307: Mongo-backed outage queue (hive.yaml `outageQueue`, all keys
  // optional; enabled:false = interception off, fast-fails fall back to the raw error path).
  outageQueue: resolveOutageQueueConfig(hive.outageQueue),
  // KPR-329: tool-search / deferred MCP tool loading (hive.yaml `toolSearch`,
  // all keys optional; mode: off = eager loading, the rollback posture).
  toolSearch: resolveToolSearchConfig(hive.toolSearch),
  sweeper: {
    intervalMs: parseInt(optional("SWEEPER_INTERVAL_MS", "300000"), 10),
    threadTtlMs: parseInt(optional("SWEEPER_THREAD_TTL_MS", "86400000"), 10),
    taskFileTtlMs: parseInt(optional("SWEEPER_TASK_FILE_TTL_MS", "604800000"), 10),
    meetingSessionTtlMs: parseInt(optional("SWEEPER_MEETING_TTL_MS", "3600000"), 10),
    cacheTtlMs: parseInt(optional("SWEEPER_CACHE_TTL_MS", "3600000"), 10),
    retryMaxAttempts: parseInt(optional("SWEEPER_RETRY_MAX_ATTEMPTS", "3"), 10),
    retryBaseDelayMs: parseInt(optional("SWEEPER_RETRY_BASE_DELAY_MS", "30000"), 10),
  },
  retention: (() => {
    const yamlPaths = (hive.retention?.paths ?? {
      data: 7,
      "agents/*/scratch": 7,
      "agents/*/feeds": 7,
      "agents/*/playwright": 3,
      "agents/*/reports": 0,
      logs: 30,
    }) as Record<string, number>;
    const paths: Record<string, RetentionPathConfig> = {};
    for (const [k, v] of Object.entries(yamlPaths)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`Invalid retention.paths.${k}: must be a non-negative integer (got ${v})`);
      }
      paths[k] = { days: v };
    }
    const defaultDays = Number(hive.retention?.defaults?.days ?? 7);
    if (!Number.isFinite(defaultDays) || defaultDays < 0) {
      throw new Error(`Invalid retention.defaults.days: ${defaultDays}`);
    }
    const intervalMs = parseInt(
      optional("RETENTION_INTERVAL_MS", String(hive.retention?.intervalMs ?? 7 * 24 * 3600_000)),
      10,
    );
    // Guard against YAML like `intervalMs: weekly` (parseInt → NaN) — setInterval(fn, NaN)
    // in Node clamps to 1ms and fires continuously, which would hammer the fs + Slack.
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`Invalid retention.intervalMs: must be a positive integer (got ${intervalMs})`);
    }
    return {
      enabled: Boolean(hive.retention?.enabled ?? false),
      intervalMs,
      defaultDays,
      paths,
    } satisfies RetentionConfig;
  })(),
  memory: {
    hotBudgetTokens: parseInt(optional("MEMORY_HOT_BUDGET_TOKENS", String(hive.memory?.hotBudgetTokens ?? 3000)), 10),
    sweepIntervalHours: parseFloat(
      optional("MEMORY_SWEEP_INTERVAL_HOURS", String(hive.memory?.sweepIntervalHours ?? 6)),
    ),
    hotThreshold: parseFloat(optional("MEMORY_HOT_THRESHOLD", String(hive.memory?.hotThreshold ?? 0.6))),
    warmThreshold: parseFloat(optional("MEMORY_WARM_THRESHOLD", String(hive.memory?.warmThreshold ?? 0.3))),
    recencyHalfLifeDays: parseFloat(
      optional("MEMORY_RECENCY_HALF_LIFE_DAYS", String(hive.memory?.recencyHalfLifeDays ?? 7)),
    ),
    coldSummaryMinRecords: parseInt(
      optional("MEMORY_COLD_SUMMARY_MIN", String(hive.memory?.coldSummaryMinRecords ?? 5)),
      10,
    ),
    coldRetentionDays: parseInt(
      optional("MEMORY_COLD_RETENTION_DAYS", String(hive.memory?.coldRetentionDays ?? 90)),
      10,
    ),
    purgeRetentionDays: parseInt(
      optional("MEMORY_PURGE_RETENTION_DAYS", String(hive.memory?.purgeRetentionDays ?? 7)),
      10,
    ),
    reflectionMinTurns: parseInt(
      optional("MEMORY_REFLECTION_MIN_TURNS", String(hive.memory?.reflectionMinTurns ?? 3)),
      10,
    ),
    spendWarnThresholdUsd: parseFloat(
      optional("MEMORY_SPEND_WARN_THRESHOLD_USD", String(hive.memory?.spendWarnThresholdUsd ?? 5)),
    ),
    writeGuards: {
      burst: {
        enabled: (hive.memory?.writeGuards?.burst?.enabled ?? true) as boolean,
        windowMinutes: parseInt(
          optional(
            "MEMORY_WRITE_GUARD_BURST_WINDOW_MINUTES",
            String(hive.memory?.writeGuards?.burst?.windowMinutes ?? 1440),
          ),
          10,
        ),
        similarityThreshold: parseFloat(
          optional(
            "MEMORY_WRITE_GUARD_BURST_SIMILARITY",
            String(hive.memory?.writeGuards?.burst?.similarityThreshold ?? 0.92),
          ),
        ),
        topK: parseInt(
          optional("MEMORY_WRITE_GUARD_BURST_TOPK", String(hive.memory?.writeGuards?.burst?.topK ?? 5)),
          10,
        ),
      },
      oversize: {
        enabled: (hive.memory?.writeGuards?.oversize?.enabled ?? true) as boolean,
        maxChars: parseInt(
          optional(
            "MEMORY_WRITE_GUARD_OVERSIZE_MAX_CHARS",
            String(hive.memory?.writeGuards?.oversize?.maxChars ?? 6000),
          ),
          10,
        ),
      },
      rawDump: {
        enabled: (hive.memory?.writeGuards?.rawDump?.enabled ?? true) as boolean,
        jsonTokenThreshold: parseInt(
          optional(
            "MEMORY_WRITE_GUARD_RAWDUMP_JSON_TOKENS",
            String(hive.memory?.writeGuards?.rawDump?.jsonTokenThreshold ?? 300),
          ),
          10,
        ),
        monolithCharThreshold: parseInt(
          optional(
            "MEMORY_WRITE_GUARD_RAWDUMP_MONOLITH_CHARS",
            String(hive.memory?.writeGuards?.rawDump?.monolithCharThreshold ?? 2000),
          ),
          10,
        ),
      },
    },
  },
  codeIndex: {
    enabled: hive.codeIndex?.enabled === true || process.env.CODE_INDEX_ENABLED === "true",
    scoreThreshold: parseFloat(optional("CODE_INDEX_SCORE_THRESHOLD", String(hive.codeIndex?.scoreThreshold ?? 0.65))),
    prefetchLimit: parseInt(optional("CODE_INDEX_PREFETCH_LIMIT", String(hive.codeIndex?.prefetchLimit ?? 8)), 10),
    sessionKnowledge: {
      enabled:
        (hive.codeIndex?.sessionKnowledge?.enabled ?? true) && process.env.CODE_INDEX_SESSION_KNOWLEDGE !== "false",
    },
    repos:
      (hive.codeIndex?.repos as Record<
        string,
        { path: string; include: string[]; extensions: string[]; exclude: string[] }
      >) ?? {},
  },
  events: {
    retentionDays: parseInt(optional("EVENT_RETENTION_DAYS", String(hive.events?.retentionDays ?? 30)), 10),
  },
  activity: {
    enabled: (hive.activity?.enabled ?? true) && process.env.ACTIVITY_LOG_ENABLED !== "false",
    bufferSize: parseInt(optional("ACTIVITY_BUFFER_SIZE", String(hive.activity?.bufferSize ?? 200)), 10),
    flushIntervalMs: parseInt(
      optional("ACTIVITY_FLUSH_INTERVAL_MS", String(hive.activity?.flushIntervalMs ?? 30000)),
      10,
    ),
    retentionDays: parseInt(optional("ACTIVITY_RETENTION_DAYS", String(hive.activity?.retentionDays ?? 90)), 10),
  },
  autoDream: {
    enabled: (hive.autoDream?.enabled ?? true) as boolean,
    quietPeriodMinutes: parseInt(
      optional(
        "AUTODREAM_QUIET_PERIOD_MINUTES",
        String(hive.autoDream?.quietPeriodMinutes ?? hive.autoDream?.idleThresholdMinutes ?? 120),
      ),
      10,
    ),
    cooldownMinutes: parseInt(
      optional("AUTODREAM_COOLDOWN_MINUTES", String(hive.autoDream?.cooldownMinutes ?? 1440)),
      10,
    ),
    minNewMemories: parseInt(optional("AUTODREAM_MIN_NEW_MEMORIES", String(hive.autoDream?.minNewMemories ?? 10)), 10),
    similarityThreshold: parseFloat(
      optional("AUTODREAM_SIMILARITY_THRESHOLD", String(hive.autoDream?.similarityThreshold ?? 0.85)),
    ),
    patternMinCount: parseInt(
      optional("AUTODREAM_PATTERN_MIN_COUNT", String(hive.autoDream?.patternMinCount ?? 3)),
      10,
    ),
    maxClustersPerRun: parseInt(
      optional("AUTODREAM_MAX_CLUSTERS", String(hive.autoDream?.maxClustersPerRun ?? 20)),
      10,
    ),
    maxContradictionPairsPerRun: parseInt(
      optional("AUTODREAM_MAX_CONTRADICTIONS", String(hive.autoDream?.maxContradictionPairsPerRun ?? 30)),
      10,
    ),
    maxPromotionsPerRun: parseInt(
      optional("AUTODREAM_MAX_PROMOTIONS", String(hive.autoDream?.maxPromotionsPerRun ?? 2)),
      10,
    ),
    maxRunBudgetUsd: parseFloat(
      optional(
        "AUTODREAM_MAX_RUN_BUDGET_USD",
        String(hive.autoDream?.maxRunBudgetUsd ?? hive.autoDream?.maxBudgetUsd ?? 0.05),
      ),
    ),
    maxCallBudgetUsd: parseFloat(
      optional(
        "AUTODREAM_MAX_CALL_BUDGET_USD",
        String(hive.autoDream?.maxCallBudgetUsd ?? hive.autoDream?.maxBudgetUsd ?? 0.01),
      ),
    ),
    coldSummaryPageSize: parseInt(
      optional("AUTODREAM_COLD_SUMMARY_PAGE_SIZE", String(hive.autoDream?.coldSummaryPageSize ?? 20)),
      10,
    ),
    coldSummaryPromptTokenBudget: parseInt(
      optional(
        "AUTODREAM_COLD_SUMMARY_PROMPT_TOKEN_BUDGET",
        String(hive.autoDream?.coldSummaryPromptTokenBudget ?? 8000),
      ),
      10,
    ),
  },
  browser: {
    cdpEndpoint: optional("BROWSER_CDP_ENDPOINT", ""),
  },
  tasksDir: {
    code: optional("CODE_TASKS_DIR", `/tmp/${instanceId}-code-tasks`),
    background: optional("BG_TASKS_DIR", `/tmp/${instanceId}-bg-tasks`),
  },
} as const;
