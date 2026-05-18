export type HiveToolTransportKind =
  | "stdio"
  | "http"
  | "sse"
  | "sdk-in-process"
  | "claude-builtin"
  | "claude-subagent";

export type ProviderToolCompatibility =
  | "direct"
  | "mcp-bridge-candidate"
  | "requires-hive-bridge"
  | "claude-only"
  | "unsupported";

export type HiveToolTransportSource =
  | "engine"
  | "core"
  | "plugin"
  | "delegate"
  | "sdk-builtin";

export interface HiveToolTransportDescriptor {
  name: string;
  transport: HiveToolTransportKind;
  source: HiveToolTransportSource;
  requiresTurnContext: boolean;
  requiresHiveRuntime: boolean;
  inProcess: boolean;
  compatibility: {
    claude: ProviderToolCompatibility;
    openai: ProviderToolCompatibility;
    gemini: ProviderToolCompatibility;
  };
}

/**
 * Claude Agent SDK built-ins advertised by Hive's toolkit section.
 * The SDK does not expose a runtime manifest, so KPR-232 mirrors the visible
 * toolkit names here for provider compatibility inventory.
 */
export const CLAUDE_SDK_BUILTIN_TOOL_NAMES: readonly string[] = [
  "Bash",
  "Read / Write / Edit",
  "Glob / Grep",
  "WebFetch / WebSearch",
  "NotebookEdit",
  "Task",
  "TodoWrite",
];

export interface ClassifyToolTransportInput {
  name: string;
  transport: HiveToolTransportKind;
  source: HiveToolTransportSource;
  requiresTurnContext?: boolean;
  requiresHiveRuntime?: boolean;
  inProcess?: boolean;
  broken?: boolean;
}

export function classifyToolTransport(input: ClassifyToolTransportInput): HiveToolTransportDescriptor {
  const inProcess = input.inProcess ?? input.transport === "sdk-in-process";
  const requiresHiveRuntime =
    input.requiresHiveRuntime ?? (inProcess || input.transport === "sdk-in-process");
  const requiresTurnContext = input.requiresTurnContext ?? false;

  if (input.broken) {
    return {
      name: input.name,
      transport: input.transport,
      source: input.source,
      requiresTurnContext,
      requiresHiveRuntime,
      inProcess,
      compatibility: {
        claude: "unsupported",
        openai: "unsupported",
        gemini: "unsupported",
      },
    };
  }

  if (input.transport === "claude-builtin" || input.transport === "claude-subagent") {
    return {
      name: input.name,
      transport: input.transport,
      source: input.source,
      requiresTurnContext,
      requiresHiveRuntime,
      inProcess,
      compatibility: {
        claude: "direct",
        openai: "claude-only",
        gemini: "claude-only",
      },
    };
  }

  const nonClaudeCompatibility: ProviderToolCompatibility =
    requiresTurnContext || requiresHiveRuntime || input.transport === "sdk-in-process"
      ? "requires-hive-bridge"
      : "mcp-bridge-candidate";

  return {
    name: input.name,
    transport: input.transport,
    source: input.source,
    requiresTurnContext,
    requiresHiveRuntime,
    inProcess,
    compatibility: {
      claude: "direct",
      openai: nonClaudeCompatibility,
      gemini: nonClaudeCompatibility,
    },
  };
}
