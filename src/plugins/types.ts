export interface PluginMcpServer {
  entry: string;
  description?: string;
  /** When to use this server — guidance for agents */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
  env?: string[]; // pass-through from base env (same name)
  envMap?: Record<string, string>; // rename: SERVER_VAR -> BASE_VAR
  agentEnv?: Record<string, string>;
}

export interface PluginManifest {
  name: string;
  description?: string;
  mcpServers: Record<string, PluginMcpServer>;
  agentSeeds: string[];
  /** Optional: path to a JS module that exports registerCommands(registry) for Team slash commands */
  registerCommands?: string;
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  manifest: PluginManifest;
}
