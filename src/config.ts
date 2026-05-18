import dotenv from "dotenv";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { AUTONOMY_DEFAULTS } from "./agents/autonomy.js";
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
    account: optional("GOOGLE_ACCOUNT", hive.google?.account ?? ""),
    client: optional("GOG_CLIENT", hive.google?.client ?? ""),
    accounts: (hive.google?.accounts ?? {}) as Record<string, string>,
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
    idleThresholdMinutes: parseInt(
      optional("AUTODREAM_IDLE_THRESHOLD_MINUTES", String(hive.autoDream?.idleThresholdMinutes ?? 30)),
      10,
    ),
    cooldownMinutes: parseInt(
      optional("AUTODREAM_COOLDOWN_MINUTES", String(hive.autoDream?.cooldownMinutes ?? 60)),
      10,
    ),
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
      optional("AUTODREAM_MAX_PROMOTIONS", String(hive.autoDream?.maxPromotionsPerRun ?? 10)),
      10,
    ),
    maxBudgetUsd: parseFloat(optional("AUTODREAM_MAX_BUDGET_USD", String(hive.autoDream?.maxBudgetUsd ?? 0.1))),
  },
  browser: {
    cdpEndpoint: optional("BROWSER_CDP_ENDPOINT", ""),
  },
  tasksDir: {
    code: optional("CODE_TASKS_DIR", `/tmp/${instanceId}-code-tasks`),
    background: optional("BG_TASKS_DIR", `/tmp/${instanceId}-bg-tasks`),
  },
} as const;
