import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LaneBProviderId } from "./types.js";
// Runtime import direction: tool-transport → builtin-executor. builtin-executor's
// import of HiveToolSchemaEntry from this file is type-only and erased, so no
// runtime cycle (KPR-348 spec §D5).
import { EXECUTOR_BACKED_BUILTIN_NAMES } from "./builtin-executor.js";

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
  compatibility: Record<"claude" | LaneBProviderId, ProviderToolCompatibility>;
}

/**
 * Claude Agent SDK built-ins advertised by Hive's toolkit section — per-tool
 * (KPR-348 replaced the compound display names so archetype rules and the
 * builtin executor address tools by their real names).
 */
export const CLAUDE_SDK_BUILTIN_TOOL_NAMES: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
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
        codex: "unsupported",
      },
    };
  }

  if (input.transport === "claude-builtin" || input.transport === "claude-subagent") {
    // KPR-348 (spec §D5, canon 2): the six executor-backed builtins are
    // bridgeable on every Lane B provider — ONE code path emits openai,
    // gemini, and codex identically (codex ≡ openai at the classify site;
    // gemini upgraded for classification honesty — its adapter still
    // advertises zero tools until KPR-352, only its omission record changes).
    const executorBacked =
      input.transport === "claude-builtin" && EXECUTOR_BACKED_BUILTIN_NAMES.has(input.name);
    const nonClaude: ProviderToolCompatibility = executorBacked ? "requires-hive-bridge" : "claude-only";
    return {
      name: input.name,
      transport: input.transport,
      source: input.source,
      requiresTurnContext,
      requiresHiveRuntime,
      inProcess,
      compatibility: {
        claude: "direct",
        openai: nonClaude,
        gemini: nonClaude,
        codex: nonClaude,
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
      codex: nonClaudeCompatibility,
    },
  };
}

/** One provider-facing tool with its JSON-schema input contract. */
export interface HiveToolSchemaEntry {
  /** Provider-facing tool name, e.g. "mcp__memory__view" or "Bash". */
  name: string;
  description: string;
  /**
   * JSON Schema for the tool input, as emitted by the MCP SDK's zod
   * conversion (in-process/stdio discovery) or authored (builtin executor,
   * KPR-348). Opaque at the type level — the bridge passes it through to
   * the provider SDK; hive never interprets it.
   */
  inputSchema: Record<string, unknown>;
}

/**
 * Where an entry's per-tool schemas come from. KPR-347 populates the
 * declaration only; KPR-348 materializes:
 *  - "connect-time": schemas are discovered by the bridge when it connects
 *    (stdio/http/sse → MCP tools/list) or instantiates the server
 *    (sdk-in-process → the same factory outputs AgentRunner.send() wires).
 *  - "static": hive holds the schemas now (KPR-348's authored builtin-
 *    executor tools; any future eagerly-manifested server).
 *  - "unavailable": no schema surface exists (claude-builtin until the
 *    executor is authored; claude-subagent until child 9). Entries in this
 *    state are claude-only by classification and never reach a bridge.
 */
export type ToolSchemaAvailability =
  | { kind: "static"; tools: HiveToolSchemaEntry[] }
  | { kind: "connect-time" }
  | { kind: "unavailable" };

export interface HiveToolInventoryEntry extends HiveToolTransportDescriptor {
  schemas: ToolSchemaAvailability;
  /**
   * Present on external MCP transports (stdio | http | sse) only: the exact
   * server config the Claude lane would pass to the SDK, resolved env
   * (incl. secret-env) and all — KPR-348 translates it to MCPServerStdio /
   * MCPServerStreamableHttp params. Credential posture unchanged: this
   * object is bridge-facing, never model-facing, and MUST never be logged
   * (log entry NAMES only). Omitted for sdk-in-process entries — their
   * stdio-placeholder config is wrong by construction (send() overrides it);
   * the bridge instantiates from the factories instead.
   */
  serverConfig?: McpServerConfig;
}

/** Compatibility classes the Lane B bridge can carry (KPR-348 implements per class). */
export const BRIDGEABLE_COMPATIBILITIES: ReadonlySet<ProviderToolCompatibility> = new Set([
  "direct",
  "mcp-bridge-candidate",
  "requires-hive-bridge",
]);

/** R3 honesty record: one tool the partition removed for a provider. */
export interface OmittedToolRecord {
  name: string;
  transport: HiveToolTransportKind;
  /** Why it was omitted: "claude-only" | "unsupported" for this provider. */
  compatibility: ProviderToolCompatibility;
}

/**
 * KPR-347 (§D4): pure compatibility partition — replaces the pilot
 * assertToolFreePilot throws. Order-preserving; provider-column lookup only.
 * Omitted entries carry names + reasons ONLY (never serverConfig) — safe to
 * log and to feed the parity matrix (child 10).
 */
export function partitionInventoryForProvider(
  inventory: readonly HiveToolInventoryEntry[],
  provider: LaneBProviderId,
): { bridgeable: HiveToolInventoryEntry[]; omitted: OmittedToolRecord[] } {
  const bridgeable: HiveToolInventoryEntry[] = [];
  const omitted: OmittedToolRecord[] = [];
  for (const entry of inventory) {
    const compatibility = entry.compatibility[provider];
    if (BRIDGEABLE_COMPATIBILITIES.has(compatibility)) {
      bridgeable.push(entry);
    } else {
      omitted.push({ name: entry.name, transport: entry.transport, compatibility });
    }
  }
  return { bridgeable, omitted };
}
