export interface PluginMcpServer {
  entry: string;
  env?: string[];
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
