export interface PluginMcpServer {
  entry: string;
  description?: string;
  /** When to use this server — guidance for agents */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
  env?: string[]; // pass-through from base env (same name); no keychain fallback
  /** Secret vars resolved via process.env first, macOS Keychain (honeypot) second. */
  secretEnv?: string[];
  envMap?: Record<string, string>; // rename: SERVER_VAR -> BASE_VAR
  agentEnv?: Record<string, string>;
}

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
   * skip these rather than spawning a missing file.
   */
  brokenServers: Record<string, BrokenServer>;
}
