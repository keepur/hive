/**
 * Instance capabilities — maps servers to their credential checks and builds
 * a capabilities summary from the running config.
 *
 * Used by agent-runner to inject INSTANCE_CAPABILITIES env var into the admin
 * MCP server at spawn time.
 */

import { config } from "../config.js";
import { fromKeychain } from "../keychain/from-keychain.js";
import type { LoadedPlugin } from "../plugins/types.js";
import { SERVER_CATALOG } from "./server-catalog.js";

export interface BrokenServerCapability {
  /** Server name as agents know it (e.g. "dodi-ops"). */
  name: string;
  /** Short reason — e.g. "no compiled entry found". Safe for agent prompts. */
  reason: string;
}

export interface InstanceCapabilities {
  instanceId: string;
  servers: {
    /** Server has credentials + a runnable entry. */
    configured: string[];
    /** Server is present but missing credentials. */
    unconfigured: string[];
    /**
     * Server is declared but not runnable — compiled entry missing, manifest
     * error, etc. Distinct from `unconfigured` so agents can tell "not set up"
     * from "set up wrong." Plugin loader writes the cause; this is the surface.
     */
    broken: BrokenServerCapability[];
  };
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
  "code-task": () => true,
  "code-search": () => !!config.codeIndex?.enabled,
  browser: () => !!config.browser?.cdpEndpoint,
  tasks: () => (config.taskLedger?.apiUrl ?? "") !== "http://localhost:3002",
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
export function buildInstanceCapabilities(plugins: LoadedPlugin[] = []): InstanceCapabilities {
  const configured: string[] = [];
  const unconfigured: string[] = [];
  const broken: BrokenServerCapability[] = [];

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

  // Plugin servers — three-way classification:
  //   - broken: loader couldn't resolve compiled entry (wins — no point checking creds)
  //   - unconfigured: entry OK but required env/secrets missing
  //   - configured: entry OK and creds resolve
  const instanceId = config.instance?.id ?? "unknown";
  for (const plugin of plugins) {
    for (const [serverName, serverDef] of Object.entries(plugin.manifest.mcpServers)) {
      const brokenInfo = plugin.brokenServers[serverName];
      if (brokenInfo) {
        broken.push({ name: serverName, reason: brokenInfo.reason });
        continue;
      }
      const requiredEnv = serverDef.env ?? [];
      const requiredSecrets = serverDef.secretEnv ?? [];
      const envOk = requiredEnv.every((v) => !!process.env[v]);
      const secretsOk = requiredSecrets.every((v) => !!process.env[v] || !!fromKeychain(instanceId, v));
      if (envOk && secretsOk) {
        configured.push(serverName);
      } else {
        unconfigured.push(serverName);
      }
    }
  }

  return {
    instanceId: config.instance?.id ?? "unknown",
    servers: { configured, unconfigured, broken },
  };
}
