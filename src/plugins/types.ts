/**
 * Plugin manifest types.
 *
 * Two transport shapes for an MCP server entry:
 *  - `stdio` (default): the engine spawns a Node subprocess from a compiled entry.
 *  - `http`: the engine talks to a remote MCP server over HTTP, injecting a
 *    per-agent key as a request header. No subprocess, no `entry`, no env wiring.
 */

interface PluginMcpServerBase {
  description?: string;
  /** When to use this server — guidance for agents */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
}

export interface StdioPluginMcpServer extends PluginMcpServerBase {
  transport?: "stdio";
  /** Path to the server's source `.ts` (resolved against compiled `.js` at load). */
  entry: string;
  env?: string[]; // pass-through from base env (same name); no keychain fallback
  /** Secret vars resolved via process.env first, macOS Keychain (honeypot) second. */
  secretEnv?: string[];
  envMap?: Record<string, string>; // rename: SERVER_VAR -> BASE_VAR
  agentEnv?: Record<string, string>;
}

export interface HttpPluginMcpServer extends PluginMcpServerBase {
  transport: "http";
  /** Fully-qualified remote MCP server URL. */
  url: string;
  auth: PluginMcpAuth;
}

/**
 * How the engine authenticates against a remote HTTP MCP server.
 *
 * `keySource` is enumerated (not free-form) so unknown values fail loudly at
 * parse time. Only `agentApiKey` is supported today — it resolves the same
 * per-agent key plumbed into stdio plugins as `TASK_LEDGER_API_KEY`
 * (`config.taskLedger.agentKeys[agentId] ?? config.taskLedger.apiKey`).
 */
export interface PluginMcpAuth {
  type: "api-key" | "bearer";
  /**
   * Header name on the wire. Defaults: `x-api-key` for `api-key`,
   * `Authorization` for `bearer`. For `bearer`, the runtime prefixes the
   * value with `Bearer ` automatically.
   */
  header?: string;
  keySource: "agentApiKey";
}

export type PluginMcpServer = StdioPluginMcpServer | HttpPluginMcpServer;

export interface PluginManifest {
  name: string;
  description?: string;
  /** Semver range the plugin requires. Optional during transition; missing == accept-any. */
  hiveApi?: string;
  mcpServers: Record<string, PluginMcpServer>;
  agentSeeds: string[];
  /** Optional: path to a JS module that exports registerCommands(registry) for Team slash commands */
  registerCommands?: string;
}

/** A plugin MCP server whose entry couldn't be resolved to a runnable file. */
export interface BrokenServer {
  /** Human-readable explanation (e.g. "no compiled entry found"). */
  reason: string;
  /** Filesystem paths the resolver tried, in priority order. */
  pathsChecked: string[];
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  manifest: PluginManifest;
  /**
   * Servers whose compiled entry could not be resolved at load time.
   * Keyed by server name. Callers (agent-runner, instance-capabilities) must
   * skip these rather than spawning a missing file. Only applies to stdio
   * servers — http servers never appear here.
   */
  brokenServers: Record<string, BrokenServer>;
}

/** Type guard: server is an HTTP-transport MCP server. */
export function isHttpServer(server: PluginMcpServer): server is HttpPluginMcpServer {
  return server.transport === "http";
}
