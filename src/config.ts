import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";

dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

// Load hive.yaml instance config
const hiveConfigPath = resolve(process.env.HIVE_CONFIG ?? "./hive.yaml");
let hive: Record<string, any> = {};
if (existsSync(hiveConfigPath)) {
  hive = parseYaml(readFileSync(hiveConfigPath, "utf-8")) ?? {};
}

const home = process.env.HOME ?? "/tmp";

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
  },
  slackJasper: {
    appToken: optional("SLACK_JASPER_APP_TOKEN", ""),
    botToken: optional("SLACK_JASPER_BOT_TOKEN", ""),
    mcpToken: optional("SLACK_JASPER_MCP_TOKEN", ""),
  },
  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
  },
  linear: {
    apiKey: optional("LINEAR_API_KEY", ""),
    teamId: optional("LINEAR_TEAM_ID", ""),
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
    dbName: optional("MONGODB_DB", "hive"),
  },
  agents: {
    defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff"),
    defaultModel: optional("DEFAULT_MODEL", "claude-sonnet-4-6"),
    definitionsPath: optional("AGENTS_PATH", "./agents"),
  },
  google: {
    account: optional("GOOGLE_ACCOUNT", ""),
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
  resend: {
    apiKey: optional("RESEND_API_KEY", ""),
    fromAddress: optional("RESEND_FROM_ADDRESS", ""),
    defaultCc: optional("RESEND_DEFAULT_CC", ""),
    hubspotBcc: optional("HUBSPOT_BCC_OUTGOING", ""),
    emailDomain: optional("RESEND_EMAIL_DOMAIN", hive.resend?.emailDomain ?? ""),
    businessName: optional("RESEND_BUSINESS_NAME", hive.resend?.businessName ?? ""),
  },
  plugins: (hive.plugins ?? []) as string[],
  hubspot: {
    apiKey: optional("HUBSPOT_API_KEY", ""),
  },
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
    monitorPort: parseInt(optional("MEETING_MONITOR_PORT", "3101"), 10),
    monitorPublicUrl: optional("MEETING_MONITOR_PUBLIC_URL", ""),
    webhookSecret: optional("RECALL_WEBHOOK_SECRET", ""),
  },
  scheduler: {
    heartbeatIntervalMs: parseInt(optional("HEARTBEAT_INTERVAL_MS", "120000"), 10),
  },
  background: {
    port: parseInt(optional("BG_TASK_PORT", "3100"), 10),
    authToken: optional("BG_TASK_AUTH_TOKEN", "") || randomUUID(),
  },
  codeTask: {
    port: parseInt(optional("CODE_TASK_PORT", "3102"), 10),
    authToken: optional("CODE_TASK_AUTH_TOKEN", "") || randomUUID(),
    pluginDir: optional("CODE_TASK_PLUGIN_DIR", resolve("plugins/claude-code/dodi-dev")),
    defaultModel: optional("CODE_TASK_MODEL", "claude-sonnet-4-6"),
    defaultMaxTurns: parseInt(optional("CODE_TASK_MAX_TURNS", "100"), 10),
    defaultMaxBudget: parseFloat(optional("CODE_TASK_MAX_BUDGET", "5.00")),
    maxConcurrent: parseInt(optional("CODE_TASK_MAX_CONCURRENT", "2"), 10),
  },
  ws: {
    enabled: optional("WS_ENABLED", "false") === "true",
    port: parseInt(optional("WS_PORT", "3200"), 10),
    jwtSecret: optional("WS_JWT_SECRET", ""),
  },
  externalComms: {
    enabled: optional("EXTERNAL_COMMS_ENABLED", "false") === "true",
  },
  triage: {
    model: optional("TRIAGE_MODEL", "claude-haiku-4-5-20251001"),
    timeoutMs: parseInt(optional("TRIAGE_TIMEOUT_MS", "10000"), 10),
    enabled: optional("TRIAGE_ENABLED", "true") === "true",
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
} as const;
