export interface PluginMcpServer {
  entry: string;
  env?: string[];              // pass-through from base env (same name)
  envMap?: Record<string, string>;  // rename: SERVER_VAR -> BASE_VAR
  agentEnv?: Record<string, string>;
}

export interface PluginManifest {
  name: string;
  description?: string;
  mcpServers: Record<string, PluginMcpServer>;
  agentsTemplates: string[];
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  manifest: PluginManifest;
}
