import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedPlugin } from "../plugins/types.js";
import { createLogger } from "../logging/logger.js";
import { computeContentHash } from "../skills/content-hash.js";
import { readSkillMd, writeSkillMd } from "../skills/frontmatter.js";
import { commitToState } from "../skills/instance-git.js";
import { agentSkillsDir } from "../paths.js";

const log = createLogger("skill-loader");

export type SkillIndex = Map<string, SdkPluginConfig[]>;

/** Set of skill directory paths detected as modified from their registry base. */
let _modifiedSkills: Set<string> = new Set();

/** Returns the set of skill paths that were detected as modified on last load. */
export function getModifiedSkills(): Set<string> {
  return _modifiedSkills;
}

type CollisionEntry = { source: string; path: string };

/**
 * Scan seed-bundled skills, plugin-bundled skills, agent-private skills (KPR-75),
 * and customer-space skills, building a map of agentId → SdkPluginConfig[] for
 * that agent's workflows.
 *
 * Precedence (high to low): customer > agent-private > seeds = plugins.
 *
 * Load-bearing pass-ordering invariant: seeds → plugins → agent-private → customer.
 * Reordering breaks the customer-shadow-evicts-agent-private logic in scanWorkflowsFrom.
 *
 * Customer space always wins (shadow). Among non-customer sources, first registered
 * wins — seeds are scanned before plugins so they take priority. Customer→customer
 * collisions are errors. Agent-private skills are scoped per-agent, so two agents
 * each having the same workflow name is NOT a collision.
 *
 * @param customerSkillsDir  e.g. <hiveHome>/skills
 * @param plugins            loaded plugins (each may contain a skills/ dir)
 * @param seedDirs           seed directories that may contain skills/
 * @param agentIds           list of agent IDs to scan agents/<id>/skills/ for (KPR-75)
 * @param hiveHomeOverride   testability — overrides the runtime hiveHome const for
 *                           agentSkillsDir() resolution. Production callers omit this.
 */
export function loadSkillIndex(
  customerSkillsDir: string,
  plugins?: LoadedPlugin[],
  seedDirs?: string[],
  agentIds?: string[],
  hiveHomeOverride?: string,
): SkillIndex {
  const index: SkillIndex = new Map();
  const universalPlugins: SdkPluginConfig[] = [];
  const collisionMap = new Map<string, CollisionEntry>();

  // Seeds first — win over plugins (first-in-wins among non-customer sources)
  for (const seedDir of seedDirs ?? []) {
    const seedSkillsDir = join(seedDir, "skills");
    if (!existsSync(seedSkillsDir)) continue;
    const seedName = seedDir.split("/").pop() ?? "seed";
    scanWorkflowsFrom(seedSkillsDir, `seed:${seedName}`, collisionMap, index, universalPlugins, false);
  }

  // Plugins second — lose to seeds (first-in-wins), lose to customer (winsCollisions)
  for (const plugin of plugins ?? []) {
    const pluginSkillsDir = join(plugin.dir, "skills");
    if (!existsSync(pluginSkillsDir)) continue;
    scanWorkflowsFrom(pluginSkillsDir, plugin.name, collisionMap, index, universalPlugins, false);
  }

  // Agent-private third (KPR-75) — agent-authored, agent-scoped by path.
  // Path is source of truth — frontmatter `agents:` is forbidden.
  // Local-filesystem-only — never commit, push, or sync these.
  //
  // A bad SKILL.md from one agent must not prevent the hive from booting or
  // disable other agents' skills. Catch per-agent so the rest of the index
  // builds normally.
  for (const agentId of agentIds ?? []) {
    const dir = agentSkillsDir(agentId, hiveHomeOverride);
    if (!existsSync(dir)) continue;
    try {
      scanWorkflowsFrom(
        dir,
        `agent-private:${agentId}`,
        collisionMap,
        index,
        universalPlugins,
        false,
        agentId, // implicitAgentScope
      );
    } catch (err) {
      log.error("Agent-private skill rejected, skipping this agent's private skills", {
        agentId,
        dir,
        error: String(err),
      });
    }
  }

  // Customer space last — wins all collisions
  if (existsSync(customerSkillsDir)) {
    scanWorkflowsFrom(customerSkillsDir, "customer", collisionMap, index, universalPlugins, true);
  } else {
    log.debug("No customer skills directory found", { path: customerSkillsDir });
  }

  // Merge universal plugins into every agent's list + expose via sentinel
  if (universalPlugins.length > 0) {
    for (const agentId of [...index.keys()]) {
      const existing = index.get(agentId)!;
      existing.push(...universalPlugins);
    }
    index.set("__universal__", universalPlugins);
  }

  // Post-scan: detect customer modifications to registry-installed skills
  _modifiedSkills = detectModifiedSkills(collisionMap, customerSkillsDir);

  log.info("Skill index loaded", {
    workflows: collisionMap.size,
    agents: index.size - (index.has("__universal__") ? 1 : 0),
  });

  return index;
}

/**
 * Remove all index entries that reference the given workflow path.
 * Used when customer-space shadows a plugin-bundled workflow.
 */
function removeWorkflowFromIndex(
  workflowPath: string,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
): void {
  // Remove from per-agent entries
  for (const [agentId, configs] of index) {
    const filtered = configs.filter((c) => c.path !== workflowPath);
    if (filtered.length !== configs.length) {
      if (filtered.length === 0) {
        index.delete(agentId);
      } else {
        index.set(agentId, filtered);
      }
    }
  }

  // Remove from universalPlugins array (mutate in place)
  for (let i = universalPlugins.length - 1; i >= 0; i--) {
    if (universalPlugins[i]!.path === workflowPath) {
      universalPlugins.splice(i, 1);
    }
  }
}

/**
 * Scan one top-level skills directory (plugin, customer, seed, or agent-private),
 * register non-colliding workflows into the index, and append to universalPlugins
 * for hive-wide skills.
 *
 * When winsCollisions is true (customer space), collisions with non-customer
 * sources shadow the existing entry. Customer→customer collisions are errors.
 *
 * When implicitAgentScope is set (agent-private skills, KPR-75):
 *   - The collision key becomes per-agent (`<agentId>::<workflow>`), so two
 *     agents each having the same workflow name is NOT a collision.
 *   - Frontmatter `agents:` in agent-private skills is a hard error — the path
 *     is the source of truth.
 *   - Skills are bound to the implicit-scope agent only.
 *
 * When customer pass runs with no implicitAgentScope, after agent scope is
 * known from frontmatter, also evict any per-agent-keyed entries in
 * collisionMap+index for those agents — preserves operator authority over
 * agent-private skills.
 */
function scanWorkflowsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
  winsCollisions: boolean,
  implicitAgentScope?: string,
): void {
  let workflows: string[];
  try {
    workflows = readdirSync(rootDir).filter((d) => {
      try {
        return statSync(join(rootDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    log.warn("Failed to read skills directory", { source, path: rootDir, error: String(err) });
    return;
  }

  for (const workflow of workflows) {
    const workflowPath = join(rootDir, workflow);
    const skillsSubdir = join(workflowPath, "skills");

    if (!existsSync(skillsSubdir)) {
      log.debug("Workflow missing skills/ subdirectory, skipping", { source, workflow });
      continue;
    }

    // Per-agent collision key for agent-private skills; global for the rest.
    const collisionKey = implicitAgentScope ? `${implicitAgentScope}::${workflow}` : workflow;

    const existing = collisionMap.get(collisionKey);
    if (existing) {
      if (winsCollisions && existing.source !== "customer") {
        // Customer shadows plugin/seed — remove their entries and replace
        log.warn("Customer skill shadows plugin-bundled skill", {
          workflow,
          shadowed: existing,
          customer: { source, path: workflowPath },
        });
        removeWorkflowFromIndex(existing.path, index, universalPlugins);
        collisionMap.set(collisionKey, { source, path: workflowPath });
      } else if (winsCollisions && existing.source === "customer") {
        // Customer→customer collision — error, load neither
        log.error("Customer skill collision — both skipped", {
          workflow,
          first: existing,
          second: { source, path: workflowPath },
        });
        // Remove the first customer version that was already loaded
        removeWorkflowFromIndex(existing.path, index, universalPlugins);
        collisionMap.delete(collisionKey);
        continue;
      } else {
        // Plugin→plugin or agent-private→agent-private (same agent) collision — first wins
        log.warn("Skill workflow collision — keeping first, skipping second", {
          workflow,
          kept: existing,
          skipped: { source, path: workflowPath },
        });
        continue;
      }
    } else {
      collisionMap.set(collisionKey, { source, path: workflowPath });
    }

    const pluginConfig: SdkPluginConfig = { type: "local", path: workflowPath };

    const agentIds = new Set<string>();
    let hasAll = false;

    let skillDirs: string[];
    try {
      skillDirs = readdirSync(skillsSubdir).filter((d) => {
        try {
          return statSync(join(skillsSubdir, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch (err) {
      log.warn("Failed to read workflow skills subdir", { source, workflow, error: String(err) });
      continue;
    }

    for (const skillDir of skillDirs) {
      const skillMd = join(skillsSubdir, skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      const declaredAgents = parseAgentsFromFrontmatter(readFileSync(skillMd, "utf-8"));

      if (implicitAgentScope) {
        // Path is the source of truth for agent-private skills. Frontmatter
        // `agents:` is forbidden — surfaces a clear error rather than letting
        // the file silently scope incorrectly.
        if (declaredAgents.length > 0) {
          throw new Error(
            `Agent-private skill at ${skillMd} declares agents: in frontmatter. ` +
              `For skills under agents/${implicitAgentScope}/skills/, the path is the source of truth — ` +
              `remove the agents: field.`,
          );
        }
        agentIds.add(implicitAgentScope);
      } else {
        for (const agent of declaredAgents) {
          if (agent === "all") {
            hasAll = true;
          } else {
            agentIds.add(agent);
          }
        }
      }
    }

    // Customer-shadow eviction: when customer skill is loading and any agent
    // it scopes to has an agent-private skill of the same workflow name, evict
    // the agent-private version. Operator authority preserved.
    if (winsCollisions && !implicitAgentScope) {
      for (const agentId of agentIds) {
        const perAgentKey = `${agentId}::${workflow}`;
        const evicted = collisionMap.get(perAgentKey);
        if (evicted) {
          log.warn("Customer-space skill shadows agent-private skill", {
            workflow,
            agent: agentId,
            shadowed: evicted.path,
            winner: workflowPath,
          });
          removeWorkflowFromIndex(evicted.path, index, universalPlugins);
          collisionMap.delete(perAgentKey);
        }
      }
    }

    if (hasAll) {
      universalPlugins.push(pluginConfig);
      log.debug("Workflow registered as universal", { source, workflow, skills: skillDirs.length });
    } else if (agentIds.size > 0) {
      for (const agentId of agentIds) {
        const existing = index.get(agentId) ?? [];
        existing.push(pluginConfig);
        index.set(agentId, existing);
      }
      log.debug("Workflow registered", {
        source,
        workflow,
        agents: [...agentIds],
        skills: skillDirs.length,
      });
    }
  }
}

/**
 * Look up skills for a specific agent. Merges agent-specific + universal.
 */
export function getSkillsForAgent(index: SkillIndex, agentId: string): SdkPluginConfig[] {
  const agentSkills = index.get(agentId) ?? [];
  const universal = index.get("__universal__") ?? [];

  // If agent already has universal plugins merged (from loadSkillIndex), avoid duplicates
  if (agentSkills.length > 0 && universal.length > 0) {
    const paths = new Set(agentSkills.map((p) => p.path));
    const missing = universal.filter((p) => !paths.has(p.path));
    return [...agentSkills, ...missing];
  }

  // Agent not in index — just return universal
  if (agentSkills.length === 0 && universal.length > 0) {
    return [...universal];
  }

  return agentSkills;
}

/**
 * After skills are loaded, check each skill with an origin block containing
 * a base-content-hash. If the current content hash differs, mark the skill
 * as modified (in-memory only) and log a warning.
 *
 * Returns the set of modified skill directory paths for testability.
 */
function detectModifiedSkills(
  collisionMap: Map<string, CollisionEntry>,
  customerSkillsDir: string,
): Set<string> {
  const modified = new Set<string>();
  const hiveHome = resolve(customerSkillsDir, "..");

  for (const [workflow, entry] of collisionMap) {
    // Only check customer-space skills — never write to plugin directories
    if (entry.source !== "customer") continue;

    const skillsSubdir = join(entry.path, "skills");
    if (!existsSync(skillsSubdir)) continue;

    let skillDirs: string[];
    try {
      skillDirs = readdirSync(skillsSubdir).filter((d) => {
        try {
          return statSync(join(skillsSubdir, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const skillDir of skillDirs) {
      const skillPath = join(skillsSubdir, skillDir);
      const skillMdPath = join(skillPath, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const { frontmatter, body } = readSkillMd(skillMdPath);
        if (!frontmatter.origin?.["base-content-hash"]) continue;

        const currentHash = computeContentHash(skillPath);
        if (currentHash !== frontmatter.origin["base-content-hash"]) {
          // Record in-memory first so state is consistent even if the disk
          // persistence below fails (permissions, read-only FS, etc).
          modified.add(skillPath);
          log.warn("Registry-installed skill has been modified", {
            workflow,
            skill: skillDir,
            source: frontmatter.origin.source,
            baseHash: frontmatter.origin["base-content-hash"],
            currentHash,
          });

          if (!frontmatter.origin.modified) {
            frontmatter.origin.modified = true;
            // The write below triggers fs.watch; loadSkillIndex re-entering is
            // safe because on the next pass frontmatter.origin.modified is
            // already true, so this branch is skipped and no further write
            // occurs. The 500ms debounce in index.ts coalesces the trigger.
            try {
              writeSkillMd(skillMdPath, frontmatter, body);
              commitToState(
                hiveHome,
                [relative(hiveHome, skillMdPath)],
                `detect-modified: ${skillDir} content hash changed`,
              );
            } catch (err) {
              log.error("Failed to persist modified flag to disk", {
                path: skillMdPath,
                error: String(err),
              });
            }
          }
        }
      } catch {
        // If we can't parse frontmatter, skip silently
      }
    }
  }

  return modified;
}

/**
 * Parse the agents field from SKILL.md YAML frontmatter.
 * Returns empty array if no frontmatter or no agents field.
 */
function parseAgentsFromFrontmatter(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];

  const frontmatter = match[1]!;

  // Match "agents:" followed by YAML list items
  const agentsMatch = frontmatter.match(/^agents:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (agentsMatch) {
    return agentsMatch[1]!
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
  }

  // Also support inline format: agents: [sdr, chief-of-staff]
  const inlineMatch = frontmatter.match(/^agents:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}
