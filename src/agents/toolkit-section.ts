/**
 * Toolkit-section assembler — KPR-87.
 *
 * Builds the runtime "Your toolkit" markdown block that goes into every agent's
 * system prompt (between constitution and memory) so agents have a canonical
 * "what can I call" reference.
 *
 * Three layers of tools, all of which are normally invisible to the agent:
 *   - SDK builtins (Bash/Read/Write/Edit/Glob/Grep/etc.) — provided by
 *     @anthropic-ai/claude-agent-sdk, no programmatic manifest available.
 *   - Engine-auto-injected MCPs (schedule, structured-memory, team, slack,
 *     conditional workflow) — added by AgentRunner.filterCoreServers regardless
 *     of the agent definition.
 *   - Capability MCPs (coreServers + delegateServers) — explicit per-agent.
 *
 * This module is a pure function — caller passes the resolved server lists,
 * we return a string. No I/O, no globals, easy to test.
 */
import { SERVER_CATALOG, type ServerCatalogEntry } from "../tools/server-catalog.js";
import type { LoadedPlugin } from "../plugins/types.js";

export interface ToolkitSectionInput {
  /** MCP servers actually configured for this agent's parent session
   *  (post-filterCoreServers — i.e. post-auto-inject, post-autonomy-gate). */
  coreServerNames: string[];
  /** MCP servers actually built as delegate subagents (post-autonomy-gate). */
  delegateServerNames: string[];
  /** Plugins in the runner — for resolving plugin-server descriptions. */
  plugins: LoadedPlugin[];
  /**
   * Set of server names the engine auto-injects (regardless of agent
   * definition). MUST mirror the additions in
   * AgentRunner.filterCoreServers — keep both sites in sync.
   */
  autoInjectedServers: ReadonlySet<string>;
}

/**
 * SDK builtin tools. The Claude Agent SDK does not expose a programmatic
 * manifest for these, so we maintain the list manually. Source:
 * @anthropic-ai/claude-agent-sdk — see SDK README and the `Options.allowedTools`
 * type, plus `sdk-tools.d.ts`'s `ToolInputSchemas` union for the canonical
 * shipped set.
 *
 * Keep entries terse — total budget for the whole toolkit section is ≤ 1 KB
 * for a bare-bones agent.
 */
const SDK_BUILTINS: ReadonlyArray<{ name: string; blurb: string }> = [
  { name: "Bash", blurb: "run shell commands" },
  { name: "Read / Write / Edit", blurb: "file I/O" },
  { name: "Glob / Grep", blurb: "file/content search" },
  { name: "WebFetch / WebSearch", blurb: "web access" },
  { name: "NotebookEdit", blurb: "Jupyter notebook editing" },
  // KPR-174: Task is the SDK's subagent-dispatch tool — agents with
  // delegateServers must know it exists, otherwise the "Delegated capability
  // MCPs" subsection is unreachable. TodoWrite is the multi-step task tracker.
  { name: "Task", blurb: "delegate to a subagent (see Delegated capability MCPs below)" },
  { name: "TodoWrite", blurb: "track multi-step tasks within this session" },
];

/**
 * Resolve a server's catalog entry — checks the core catalog first, then plugin
 * manifests, then falls back to a description-only stub.
 *
 * Mirrors AgentRunner.getServerCatalogEntry. Kept inline (not imported from
 * agent-runner) so this module stays a pure function with no AgentRunner
 * dependency, making it trivially testable.
 */
function resolveCatalogEntry(
  serverName: string,
  plugins: LoadedPlugin[],
): ServerCatalogEntry {
  const core = SERVER_CATALOG[serverName];
  if (core) return core;
  for (const plugin of plugins) {
    const serverDef = plugin.manifest.mcpServers[serverName];
    if (serverDef?.description) {
      return {
        description: serverDef.description,
        usage: serverDef.usage,
        notFor: serverDef.notFor,
      };
    }
  }
  return { description: serverName };
}

/** Pick the punchy line for the toolkit section. Prefer toolkitBlurb if set. */
function blurbFor(entry: ServerCatalogEntry): string {
  return entry.toolkitBlurb ?? entry.description;
}

/** Format `- name — blurb` for the section. One line per server. */
function formatToolkitLine(name: string, entry: ServerCatalogEntry): string {
  return `- ${name} — ${blurbFor(entry)}`;
}

/**
 * Build the "Your toolkit" markdown section.
 *
 * Subsections:
 *   1. Built-in (always available)        — SDK_BUILTINS, hardcoded
 *   2. Engine-provided (always available) — coreServerNames ∩ autoInjectedServers
 *   3. Capability MCPs (provisioned)      — coreServerNames \ autoInjectedServers
 *   4. Delegated capability MCPs          — delegateServerNames
 *
 * Subsections that would be empty are omitted. Output is intended to fit in
 * ≤ 1 KB for a bare-bones agent (Built-in + Engine-provided only).
 */
export function buildToolkitSection(input: ToolkitSectionInput): string {
  const { coreServerNames, delegateServerNames, plugins, autoInjectedServers } = input;

  const engineProvided: string[] = [];
  const capabilityCore: string[] = [];

  // Stable order — keep the engine list in autoInjectedServers iteration order
  // (caller controls), and the capability list in coreServerNames order.
  const engineSet = new Set<string>();
  for (const name of coreServerNames) {
    if (autoInjectedServers.has(name)) {
      engineProvided.push(name);
      engineSet.add(name);
    }
  }
  for (const name of coreServerNames) {
    if (!engineSet.has(name)) capabilityCore.push(name);
  }

  const sections: string[] = [];

  sections.push(
    "## Your toolkit\n\n" +
      "You have access to the following tools this session. Try them; don't guess at availability.",
  );

  // Built-in (SDK)
  const sdkLines = SDK_BUILTINS.map((b) => `- ${b.name} — ${b.blurb}`).join("\n");
  sections.push(`### Built-in (always available)\n${sdkLines}`);

  // Engine-provided
  if (engineProvided.length > 0) {
    const lines = engineProvided
      .map((s) => formatToolkitLine(s, resolveCatalogEntry(s, plugins)))
      .join("\n");
    sections.push(
      "### Engine-provided (always available to every agent)\n" + lines,
    );
  }

  // Capability MCPs (explicit core)
  if (capabilityCore.length > 0) {
    const lines = capabilityCore
      .map((s) => formatToolkitLine(s, resolveCatalogEntry(s, plugins)))
      .join("\n");
    sections.push("### Capability MCPs (provisioned for your role)\n" + lines);
  }

  // Delegated capability MCPs
  if (delegateServerNames.length > 0) {
    const lines = delegateServerNames
      .map((s) => formatToolkitLine(s, resolveCatalogEntry(s, plugins)))
      .join("\n");
    sections.push(
      "### Delegated capability MCPs (via Agent tool)\n" + lines,
    );
  }

  return sections.join("\n\n");
}
