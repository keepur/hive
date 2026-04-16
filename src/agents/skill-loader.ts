import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedPlugin } from "../plugins/types.js";
import { createLogger } from "../logging/logger.js";
import { computeContentHash } from "../skills/content-hash.js";
import { readSkillMd, writeSkillMd } from "../skills/frontmatter.js";
import { commitToState } from "../skills/instance-git.js";

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
 * Scan seed-bundled skills, plugin-bundled skills, and customer-space skills,
 * build a map of agentId → SdkPluginConfig[] for that agent's workflows.
 *
 * Precedence (high to low): customer > seeds > plugins.
 * Customer space always wins (shadow). Among non-customer sources, first
 * registered wins — seeds are scanned before plugins so they take priority.
 * Customer→customer collisions are errors — neither version loads.
 */
export function loadSkillIndex(
  customerSkillsDir: string,
  plugins?: LoadedPlugin[],
  seedDirs?: string[],
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
 * Scan one top-level skills directory (plugin or customer), register non-colliding
 * workflows into the index, and append to universalPlugins for hive-wide skills.
 *
 * When winsCollisions is true (customer space), collisions with non-customer
 * sources shadow the existing entry. Customer→customer collisions are errors.
 */
function scanWorkflowsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
  winsCollisions: boolean,
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

    const existing = collisionMap.get(workflow);
    if (existing) {
      if (winsCollisions && existing.source !== "customer") {
        // Customer shadows plugin — remove plugin's entries and replace
        log.warn("Customer skill shadows plugin-bundled skill", {
          workflow,
          shadowed: existing,
          customer: { source, path: workflowPath },
        });
        removeWorkflowFromIndex(existing.path, index, universalPlugins);
        collisionMap.set(workflow, { source, path: workflowPath });
      } else if (winsCollisions && existing.source === "customer") {
        // Customer→customer collision — error, load neither
        log.error("Customer skill collision — both skipped", {
          workflow,
          first: existing,
          second: { source, path: workflowPath },
        });
        // Remove the first customer version that was already loaded
        removeWorkflowFromIndex(existing.path, index, universalPlugins);
        collisionMap.delete(workflow);
        continue;
      } else {
        // Plugin→plugin collision — first wins
        log.warn("Skill workflow collision — keeping first, skipping second", {
          workflow,
          kept: existing,
          skipped: { source, path: workflowPath },
        });
        continue;
      }
    } else {
      collisionMap.set(workflow, { source, path: workflowPath });
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

      const agents = parseAgentsFromFrontmatter(readFileSync(skillMd, "utf-8"));
      for (const agent of agents) {
        if (agent === "all") {
          hasAll = true;
        } else {
          agentIds.add(agent);
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
          if (!frontmatter.origin.modified) {
            frontmatter.origin.modified = true;
            // Persist to disk so upgrade flow can read the flag
            writeSkillMd(skillMdPath, frontmatter, body);
            // Audit the modification detection on the state branch
            commitToState(
              hiveHome,
              [relative(hiveHome, skillMdPath)],
              `detect-modified: ${skillDir} content hash changed`,
            );
          }
          modified.add(skillPath);
          log.warn("Registry-installed skill has been modified", {
            workflow,
            skill: skillDir,
            source: frontmatter.origin.source,
            baseHash: frontmatter.origin["base-content-hash"],
            currentHash,
          });
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
