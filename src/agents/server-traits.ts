/**
 * Shared MCP server traits for provider/tool transport planning.
 *
 * Keep "needs per-turn WorkItemContext" separate from "unsafe to delegate":
 * runtime `memory` is delegate-unsafe, but it does not consume channel/thread
 * metadata from the active turn.
 */
export const TURN_CONTEXT_DEPENDENT_SERVERS = new Set<string>([
  "callback",
  "background",
  "code-task",
  "recall",
  "structured-memory",
]);

export const DELEGATE_UNSAFE_SERVERS = new Set<string>([
  ...TURN_CONTEXT_DEPENDENT_SERVERS,
  "memory",
]);
