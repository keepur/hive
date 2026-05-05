/**
 * KPR-184: the 10 KPR-122-ported in-process MCP servers.
 *
 * These run in-process via `createSdkMcpServer` wired in
 * `agent-runner.ts:send()`. They cannot appear in `delegateServers` because
 * the SDK's `AgentDefinition.mcpServers` type accepts only stdio/sse/http or
 * non-instance SDK configs — not `McpSdkServerConfigWithInstance`. A delegate
 * referencing one of these would fall back to a stdio path that no longer
 * exists post-KPR-183 (the per-MCP bundles `pkg/mcp/<server>.min.js` were
 * dropped when the engine bundle stopped emitting standalone entries).
 *
 * Validation:
 *   - Admin tool (`agent_create` / `agent_update`) rejects malformed inputs.
 *   - Agent registry (`load()`) sanitizes any pre-existing data on engine
 *     boot and logs an error — operator moves the entries to `coreServers`
 *     (or removes them) via `admin_agent_update`.
 *
 * Lives in its own module to avoid a circular import between `agent-runner`
 * (which imports `createAdminMcpServer` from `admin-mcp-server`) and
 * `admin-mcp-server` (which uses this constant).
 */
export const IN_PROCESS_PORTED_SERVERS = new Set<string>([
  "memory",
  "structured-memory",
  "event-bus",
  "callback",
  "contacts",
  "schedule",
  "team",
  "admin",
  "code-search",
  "workflow",
]);
