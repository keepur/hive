import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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
  brave: {
    apiKey: optional("BRAVE_API_KEY", ""),
  },
  taskLedger: {
    apiUrl: optional("TASK_LEDGER_API_URL", "http://localhost:3002"),
    apiKey: optional("TASK_LEDGER_API_KEY", ""),
  },
  mongo: {
    uri: optional("MONGODB_URI", "mongodb://localhost:27017"),
    dbName: optional("MONGODB_DB", "hive"),
  },
  memory: {
    repo: optional("HIVE_MEMORY_REPO", hive.memory?.repo ?? ""),
    localPath: optional(
      "HIVE_MEMORY_LOCAL_PATH",
      (hive.memory?.localPath ?? `${home}/hive-memory`).replace("~", home),
    ),
  },
  agents: {
    defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff"),
    defaultModel: optional("DEFAULT_MODEL", "claude-sonnet-4-6"),
    definitionsPath: optional("AGENTS_PATH", "./agents"),
  },
  google: {
    account: optional("GOOGLE_ACCOUNT", ""),
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
  },
  recall: {
    apiKey: optional("RECALL_API_KEY", ""),
    region: optional("RECALL_API_REGION", "us-west-2"),
  },
  scheduler: {
    heartbeatIntervalMs: parseInt(optional("HEARTBEAT_INTERVAL_MS", "120000"), 10),
  },
  background: {
    port: parseInt(optional("BG_TASK_PORT", "3100"), 10),
  },
} as const;
