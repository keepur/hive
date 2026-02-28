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
  },
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
  },
  linear: {
    apiKey: optional("LINEAR_API_KEY", ""),
  },
  memory: {
    repo: optional("HIVE_MEMORY_REPO", "bot-dodi/hive-memory"),
    localPath: optional("HIVE_MEMORY_LOCAL_PATH", "/Users/mokie/hive-memory"),
  },
  agents: {
    defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff"),
    defaultModel: optional("DEFAULT_MODEL", "claude-sonnet-4-6"),
    definitionsPath: optional("AGENTS_PATH", "./agents"),
  },
  scheduler: {
    heartbeatIntervalMs: parseInt(optional("HEARTBEAT_INTERVAL_MS", "120000"), 10),
  },
} as const;
