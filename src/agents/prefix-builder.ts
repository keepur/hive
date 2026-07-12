/**
 * Prefix builder — pure function that assembles the cacheable system-prompt
 * prefix for an agent. Extracted from `AgentRunner.buildSystemPrompt` so the
 * write-through prefix cache (KPR-213) can share the assembly logic without
 * pulling in the full runner.
 *
 * The prefix is everything in `buildSystemPrompt` EXCEPT the trailing
 * datetime — datetime stays in the runner because it changes every minute
 * and would invalidate the cache continuously. The runner appends datetime
 * after fetching the cached prefix.
 *
 * Inputs are deterministic per agent: agentConfig is constructor-stable and
 * the context fields (memoryManager, teamRoster, plugins, skillIndex,
 * coreServerNames, activeDelegateNames, eventSubscribersJson) are all
 * derivable from agent-def + engine state. Per-call inputs (channel/thread)
 * are NOT in the prefix — they thread through MCP server contextRefs at the
 * tool-handler layer.
 */

import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { TeamRoster } from "../team-roster/team-roster.js";
import type { LoadedPlugin } from "../plugins/types.js";
import type { SkillIndex } from "./skill-loader.js";
import type { CodeIndexPrefetcher } from "../code-index/prefetcher.js";
import { getArchetype } from "../archetypes/registry.js";
import { buildToolkitSection } from "./toolkit-section.js";
import { config } from "../config.js";

const log = createLogger("prefix-builder");

export interface PrefixBuildContext {
  /** Post-filter list of MCP server names enabled on this agent (Object.keys(mcpServers) at spawn time). */
  coreServerNames: string[];
  /** Post-filter list of delegated subagent server names. */
  activeDelegateNames: string[];
  /** Read access to FS-style and structured memory. */
  memoryManager: MemoryManager;
  /** Live team roster for the team-summary slot. Optional — falls through if undefined. */
  teamRoster?: TeamRoster;
  /** Loaded plugins — feeds the toolkit section so plugin MCPs get listed. */
  plugins: LoadedPlugin[];
  /** Skill index — currently unused at builder layer (skills are wired as SDK plugins, not via prompt). Reserved. */
  skillIndex: SkillIndex;
  /** Optional code-index prefetcher — currently unused at builder layer. Reserved for future code-context injection. */
  prefetcher?: CodeIndexPrefetcher;
  /** Engine event subscriber map (JSON string) — currently unused at builder layer. Reserved. */
  eventSubscribersJson: string;
  /** Auto-injected MCP server names (mirrors AgentRunner.autoInjectedServerNames). */
  autoInjectedServers: ReadonlySet<string>;
}

/**
 * Build the cacheable prefix for an agent. Mirrors the assembly in
 * `AgentRunner.buildSystemPrompt` MINUS the datetime trailer.
 *
 * Layer order (matches AgentAnatomy in CLAUDE.md):
 *   soul → archetype card → systemPrompt → constitution → team summary →
 *   toolkit → hot-tier memory (or legacy memory blob)
 */
export async function buildPrefix(agentConfig: AgentConfig, ctx: PrefixBuildContext): Promise<string> {
  const parts: string[] = [];

  // --- Static prefix (stable across turns → cacheable) ---

  if (agentConfig.soul) {
    parts.push(agentConfig.soul);
  }

  // Archetype card. Lookup is module-resolved so the builder stays pure
  // w.r.t. its inputs — `getArchetype` reads a process-global registry that
  // doesn't change post-startup.
  const archetypeDef = agentConfig.archetype ? getArchetype(agentConfig.archetype) ?? null : null;
  if (archetypeDef && agentConfig.archetypeConfig) {
    try {
      const card = archetypeDef.systemPromptCard({
        agentConfig,
        archetypeConfig: agentConfig.archetypeConfig,
      });
      if (card) parts.push(card);
    } catch (err) {
      log.error("Archetype systemPromptCard threw — omitting card", {
        agent: agentConfig.id,
        archetype: agentConfig.archetype,
        error: String(err),
      });
    }
  }

  parts.push(agentConfig.systemPrompt);

  // Constitution — non-negotiable team rules. Read failures fall through
  // (memoryManager.read returns null on miss).
  const constitution = await ctx.memoryManager.read("shared/constitution.md");
  if (constitution) {
    parts.push(constitution);
  }

  // KPR-139: live team summary
  if (ctx.teamRoster) {
    try {
      const teamSummary = await ctx.teamRoster.teamSummary();
      if (teamSummary) parts.push(teamSummary);
    } catch (err) {
      log.warn("teamSummary failed; omitting from prompt", {
        agent: agentConfig.id,
        error: String(err),
      });
    }
  }

  // --- Semi-static (stable within a session, changes on restart/reload) ---

  // KPR-87: unified "Your toolkit" section.
  parts.push(
    buildToolkitSection({
      coreServerNames: ctx.coreServerNames,
      delegateServerNames: ctx.activeDelegateNames,
      plugins: ctx.plugins,
      autoInjectedServers: ctx.autoInjectedServers,
      // KPR-329: resolved mode ≠ "off" (agent override → hive.yaml → auto).
      // Lives in the cached prefix: the agent-def field change invalidates via
      // the definition-update path; hive.yaml changes require restart anyway.
      deferredLoadingActive: (agentConfig.toolSearch ?? config.toolSearch.mode) !== "off",
    }),
  );

  // KPR-327: manual "memory-first" guidance for the native-shaped file-tier
  // memory MCP. The Agent SDK injects no system instruction for MCP tools
  // (unlike the native memory_20250818 API tool), so hive authors it here —
  // explicitly deferring to the hot tier injected below to avoid redundant
  // view-everything-first round-trips. Static text: lives in the cached
  // prefix; KPR-213 invalidation semantics are unchanged.
  if (ctx.coreServerNames.includes("memory")) {
    parts.push(
      "## File-Tier Memory\n" +
        "You have a file-tier memory at `/memories` (tools: view, create, str_replace, insert, delete, rename). " +
        "Your hot-tier memory is already injected in this prompt — do **not** re-`view` files to rediscover what's already here. " +
        "`view` file-tier paths when a task needs detail beyond the hot tier, and record durable file-worthy material there.",
    );
  }

  // --- Memory injection (changes on memory writes — cache invalidated then) ---

  const hotTierPrompt = await ctx.memoryManager.getHotTierPrompt(agentConfig.id, config.memory.hotBudgetTokens);
  if (hotTierPrompt) {
    parts.push(hotTierPrompt);
  } else {
    // Legacy path — inject memory.md blob if structured records don't exist yet.
    const memoryDir = `agents/${agentConfig.id}`;
    const memory = await ctx.memoryManager.read(`${memoryDir}/memory.md`);
    if (memory) {
      parts.push(`## Your Memory\n${memory}`);
    }
    const memoryFiles = await ctx.memoryManager.list(memoryDir);
    const mdFiles = memoryFiles.filter((f) => f.endsWith(".md") && f !== "memory.md");
    if (mdFiles.length > 0) {
      parts.push(
        `## Available Memory Files\nYou have ${mdFiles.length} reference file(s) in your memory directory:\n` +
          mdFiles.map((f) => `- /memories/${memoryDir}/${f}`).join("\n") +
          `\n\nRead relevant files via the memory MCP server (\`view\`) before starting tasks that may relate to them.`,
      );
    }
  }

  return parts.join("\n\n---\n\n");
}
