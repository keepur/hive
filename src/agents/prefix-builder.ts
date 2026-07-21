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
import { config, resolveToolSearchMode } from "../config.js";

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

/** Shared section joiner — the exact prefix-builder.ts:167 string, single definition (§D1). */
export const SECTION_JOINER = "\n\n---\n\n";

// ── Section helpers (KPR-349 §D1) ──────────────────────────────────
// Each returns the rendered section or null-to-omit. Extracted verbatim from
// buildPrefix (KPR-213 shape); the golden suite (prefix-builder.golden.test.ts)
// pins byte-identity of the recomposition. Both lanes compose these — Claude
// via buildPrefix (below), Lane B via buildProviderInstructions (§D1/§D3).

export function soulSection(agentConfig: AgentConfig): string | null {
  return agentConfig.soul ? agentConfig.soul : null;
}

/** Archetype card. Catch-and-omit posture unchanged (prefix-builder.ts:71-89).
 *  The `archetypeDef && archetypeConfig` conjunction short-circuits before the
 *  card is attempted — golden G5 pins that branch. */
export function archetypeCardSection(agentConfig: AgentConfig): string | null {
  const archetypeDef = agentConfig.archetype ? getArchetype(agentConfig.archetype) ?? null : null;
  if (!archetypeDef || !agentConfig.archetypeConfig) return null;
  try {
    const card = archetypeDef.systemPromptCard({
      agentConfig,
      archetypeConfig: agentConfig.archetypeConfig,
    });
    return card ? card : null;
  } catch (err) {
    log.error("Archetype systemPromptCard threw — omitting card", {
      agent: agentConfig.id,
      archetype: agentConfig.archetype,
      error: String(err),
    });
    return null;
  }
}

export function systemPromptSection(agentConfig: AgentConfig): string {
  return agentConfig.systemPrompt;
}

/** Constitution — read-miss falls through (memoryManager.read returns null). */
export async function constitutionSection(memoryManager: MemoryManager): Promise<string | null> {
  return await memoryManager.read("shared/constitution.md");
}

/** KPR-139 team summary — warn-and-omit posture unchanged. */
export async function teamSummarySection(agentId: string, teamRoster?: TeamRoster): Promise<string | null> {
  if (!teamRoster) return null;
  try {
    const teamSummary = await teamRoster.teamSummary();
    return teamSummary ? teamSummary : null;
  } catch (err) {
    log.warn("teamSummary failed; omitting from prompt", { agent: agentId, error: String(err) });
    return null;
  }
}

/** KPR-327 static file-tier guidance text, verbatim (prefix-builder.ts:137-141). */
export function fileTierMemoryGuidance(): string {
  return (
    "## File-Tier Memory\n" +
    "You have a file-tier memory at `/memories` (tools: view, create, str_replace, insert, delete, rename). " +
    "Your hot-tier memory is already injected in this prompt — do **not** re-`view` files to rediscover what's already here. " +
    "`view` file-tier paths when a task needs detail beyond the hot tier, and record durable file-worthy material there."
  );
}

export interface MemorySectionsOptions {
  /**
   * §D3/§D5 tool-claim gate. False strips the two tool-instruction lines
   * embedded in the memory block (the hot-tier `memory_recall` trailer's
   * imperative sentence and the legacy file-listing's "via the memory MCP
   * server (`view`)" sentence) — memory CONTENT is never gated. The Claude
   * lane always passes true, so buildPrefix output is unchanged.
   */
  toolsExecutable: boolean;
  /**
   * §D5 naming-mismatch, option (a): a tool-executing Lane B render passes
   * the bridged name "mcp__structured-memory__memory_recall" so the trailer
   * names the tool the model can actually call. Omitted (Claude lane) ⇒
   * bare "memory_recall", byte-identical to pre-349 (golden-pinned).
   * Ignored when toolsExecutable is false.
   */
  recallToolName?: string;
}

export interface MemorySectionsResult {
  /** Rendered block(s) in prompt order: [hotTier] OR [legacy memory.md?, file listing?]. */
  blocks: string[];
  /**
   * Raw hot-tier block (present iff the hot tier rendered) — returned
   * alongside blocks so assembly can populate ProviderMemoryBundle without
   * a second Mongo read. SINGLE-INJECTION: this exact string is already in
   * `blocks` (and therefore in the composed instructions) — consumers must
   * never fold it in again.
   */
  hotTierPrompt?: string;
}

/**
 * Hot-tier injection with legacy memory.md + file-listing fallback —
 * extracted from prefix-builder.ts:146-165, logic and budget identical on
 * both lanes (§D5).
 */
export async function memorySections(
  memoryManager: MemoryManager,
  agentId: string,
  opts: MemorySectionsOptions,
): Promise<MemorySectionsResult> {
  const hotTierPrompt = await memoryManager.getHotTierPrompt(
    agentId,
    config.memory.hotBudgetTokens,
    opts.toolsExecutable
      ? opts.recallToolName !== undefined
        ? { recallToolName: opts.recallToolName }
        : undefined // Claude lane: two-arg call shape, bytes untouched
      : { recallToolName: null }, // gated: reworded count-only trailer (§D5)
  );
  if (hotTierPrompt) {
    return { blocks: [hotTierPrompt], hotTierPrompt };
  }
  const blocks: string[] = [];
  const memoryDir = `agents/${agentId}`;
  const memory = await memoryManager.read(`${memoryDir}/memory.md`);
  if (memory) {
    blocks.push(`## Your Memory\n${memory}`);
  }
  const memoryFiles = await memoryManager.list(memoryDir);
  const mdFiles = memoryFiles.filter((f) => f.endsWith(".md") && f !== "memory.md");
  if (mdFiles.length > 0) {
    const listing =
      `## Available Memory Files\nYou have ${mdFiles.length} reference file(s) in your memory directory:\n` +
      mdFiles.map((f) => `- /memories/${memoryDir}/${f}`).join("\n");
    blocks.push(
      opts.toolsExecutable
        ? listing +
            `\n\nRead relevant files via the memory MCP server (\`view\`) before starting tasks that may relate to them.`
        : listing, // §D3/§D5: paths stay, the tool-instruction sentence goes
    );
  }
  return { blocks };
}

/**
 * Datetime trailer — the ONE definition both lanes append last
 * (agent-runner.ts:376-378 format string, verbatim). Kept out of buildPrefix
 * so the KPR-213 cache never holds a timestamp.
 */
export function formatDateTimeTrailer(now: Date = new Date()): string {
  const pacific = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `**Current date/time**: ${pacific} (Pacific Time)`;
}

/**
 * Build the cacheable prefix for an agent. Signature and output UNCHANGED
 * (KPR-349 golden gate) — now a composition of the exported helpers.
 * Layer order: soul → archetype card → systemPrompt → constitution →
 * team summary → toolkit → file-tier guidance → hot-tier/legacy memory.
 */
export async function buildPrefix(agentConfig: AgentConfig, ctx: PrefixBuildContext): Promise<string> {
  const parts: string[] = [];

  const soul = soulSection(agentConfig);
  if (soul) parts.push(soul);

  const card = archetypeCardSection(agentConfig);
  if (card) parts.push(card);

  parts.push(systemPromptSection(agentConfig));

  const constitution = await constitutionSection(ctx.memoryManager);
  if (constitution) parts.push(constitution);

  const teamSummary = await teamSummarySection(agentConfig.id, ctx.teamRoster);
  if (teamSummary) parts.push(teamSummary);

  // KPR-87 Claude toolkit — buildToolkitSection call unchanged (golden-gated).
  parts.push(
    buildToolkitSection({
      coreServerNames: ctx.coreServerNames,
      delegateServerNames: ctx.activeDelegateNames,
      plugins: ctx.plugins,
      autoInjectedServers: ctx.autoInjectedServers,
      // KPR-329: resolved mode ≠ "off" (agent override → hive.yaml → auto).
      // Lives in the cached prefix: the agent-def field change invalidates via
      // the definition-update path; hive.yaml changes require restart anyway.
      deferredLoadingActive: resolveToolSearchMode(agentConfig.toolSearch, config.toolSearch.mode).mode !== "off",
    }),
  );

  // KPR-327 guidance gate — keyed on coreServerNames, unchanged.
  if (ctx.coreServerNames.includes("memory")) {
    parts.push(fileTierMemoryGuidance());
  }

  // Claude lane always has tools: toolsExecutable true, bare recall name.
  const memory = await memorySections(ctx.memoryManager, agentConfig.id, { toolsExecutable: true });
  parts.push(...memory.blocks);

  return parts.join(SECTION_JOINER);
}
