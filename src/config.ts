import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  slack: {
    appToken: required("SLACK_APP_TOKEN"),
    botToken: required("SLACK_BOT_TOKEN"),
    mcpToken: optional("SLACK_MCP_TOKEN", ""),
  },
  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
  },
  linear: {
    apiKey: optional("LINEAR_API_KEY", ""),
  },
  mongo: {
    uri: optional("MONGODB_URI", "mongodb://localhost:27017"),
    dbName: optional("MONGODB_DB", "hive"),
  },
  memory: {
    repo: optional("HIVE_MEMORY_REPO", "bot-dodi/hive-memory"),
    localPath: optional("HIVE_MEMORY_LOCAL_PATH", "/Users/mokie/github/hive-memory"),
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
  },
  scheduler: {
    heartbeatIntervalMs: parseInt(optional("HEARTBEAT_INTERVAL_MS", "120000"), 10),
  },
} as const;
