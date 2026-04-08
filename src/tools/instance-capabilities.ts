/**
 * Instance capabilities — maps servers to their credential checks and builds
 * a capabilities summary from the running config.
 *
 * Used by agent-runner to inject INSTANCE_CAPABILITIES env var into the admin
 * MCP server at spawn time.
 */

import { config } from "../config.js";
import { SERVER_CATALOG } from "./server-catalog.js";

export interface InstanceCapabilities {
  instanceId: string;
  servers: {
    configured: string[];
    unconfigured: string[];
  };
  integrations: Record<string, { configured: boolean; detail?: string }>;
}

/**
 * Server-to-credential mapping. Each entry is a function that returns true
 * if the server has the credentials/config it needs to operate.
 *
 * Servers not listed here are assumed always-available (infrastructure servers
 * like memory, slack, callback, background, etc.).
 */
const SERVER_CREDENTIAL_CHECKS: Record<string, () => boolean> = {
  google: () => Object.keys(config.google?.accounts ?? {}).length > 0 || !!config.google?.account,
  resend: () => !!config.resend?.apiKey,
  "brave-search": () => !!config.brave?.apiKey,
  linear: () => !!config.linear?.apiKey,
  clickup: () => !!config.clickup?.apiToken,
  "github-issues": () => !!config.github?.repo,
  quo: () => !!config.quo?.apiKey,
  recall: () => !!config.recall?.apiKey,
  "hubspot-crm": () => !!config.hubspot?.apiKey,
  permits: () => (config.permits?.mongoUri ?? "") !== "mongodb://localhost:27017/permits",
  "code-task": () => true,
  "code-search": () => !!config.codeIndex?.enabled,
  browser: () => !!config.browser?.cdpEndpoint,
  catalog: () => (config.taskLedger?.apiUrl ?? "") !== "http://localhost:3002",
  "dodi-ops": () => (config.taskLedger?.apiUrl ?? "") !== "http://localhost:3002",
  tasks: () => (config.taskLedger?.apiUrl ?? "") !== "http://localhost:3002",
  "product-search": () => !!config.hubspot?.apiKey,
  "ops-search": () => (config.taskLedger?.apiUrl ?? "") !== "http://localhost:3002",
};

/** Infrastructure servers — always available, don't need credential checks */
const INFRASTRUCTURE_SERVERS = new Set([
  "memory",
  "slack",
  "contacts",
  "callback",
  "background",
  "schedule",
  "event-bus",
  "conversation-search",
  "keychain",
  "admin",
]);

/**
 * Build the full instance capabilities summary from the current config.
 * Result is JSON-serialized and passed to admin MCP server via env var.
 * Config is immutable at runtime, so the result is stable across calls.
 */
export function buildInstanceCapabilities(): InstanceCapabilities {
  const configured: string[] = [];
  const unconfigured: string[] = [];

  for (const serverName of Object.keys(SERVER_CATALOG)) {
    if (INFRASTRUCTURE_SERVERS.has(serverName)) {
      configured.push(serverName);
      continue;
    }
    const check = SERVER_CREDENTIAL_CHECKS[serverName];
    if (!check || check()) {
      configured.push(serverName);
    } else {
      unconfigured.push(serverName);
    }
  }

  // Build human-readable integration summary
  const googleAccounts = config.google?.accounts ?? {};
  const integrations: Record<string, { configured: boolean; detail?: string }> = {
    google: {
      configured: Object.keys(googleAccounts).length > 0 || !!config.google?.account,
      detail: Object.keys(googleAccounts).length > 0 ? `${Object.keys(googleAccounts).length} account(s)` : undefined,
    },
    slack: { configured: true },
    email: { configured: !!config.resend?.apiKey },
    sms: { configured: !!config.quo?.apiKey },
    crm: { configured: !!config.hubspot?.apiKey },
    "issue-tracking": {
      configured: !!config.linear?.apiKey || !!config.github?.repo,
      detail:
        [config.linear?.apiKey ? "Linear" : "", config.github?.repo ? "GitHub Issues" : ""]
          .filter(Boolean)
          .join(", ") || undefined,
    },
    "web-search": { configured: !!config.brave?.apiKey },
    browser: { configured: !!config.browser?.cdpEndpoint },
    "video-meetings": { configured: !!config.recall?.apiKey },
  };

  return {
    instanceId: config.instance?.id ?? "unknown",
    servers: { configured, unconfigured },
    integrations,
  };
}
