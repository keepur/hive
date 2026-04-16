import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedPlugin } from "../plugins/types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-loader");

export type SkillIndex = Map<string, SdkPluginConfig[]>;

type CollisionEntry = { source: string; path: string };

/**
 * Scan core skills/ and (optionally) plugin-bundled skills, build a map of
 * agentId → SdkPluginConfig[] for that agent's workflows.
 *
 * Collisions are detected on bare workflow directory name. Core wins over
 * plugins; earlier plugins win over later plugins (input order from hive.yaml
 * is preserved by loadPlugins in src/plugins/plugin-loader.ts).
 */
export function loadSkillIndex(
  skillsDir: string = resolve("skills"),
  plugins?: LoadedPlugin[],
): SkillIndex {
  const index: SkillIndex = new Map();
  const universalPlugins: SdkPluginConfig[] = [];
  const collisionMap = new Map<string, CollisionEntry>();

  // Core first
  if (existsSync(skillsDir)) {
    scanWorkflowsFrom(skillsDir, "core", collisionMap, index, universalPlugins);
  } else {
    log.debug("No core skills directory found", { path: skillsDir });
  }

  // Then plugins, in hive.yaml order
  for (const plugin of plugins ?? []) {
    const pluginSkillsDir = join(plugin.dir, "skills");
    if (!existsSync(pluginSkillsDir)) continue;
    scanWorkflowsFrom(pluginSkillsDir, plugin.name, collisionMap, index, universalPlugins);
  }

  // Merge universal plugins into every agent's list + expose via sentinel
  if (universalPlugins.length > 0) {
    for (const agentId of [...index.keys()]) {
      const existing = index.get(agentId)!;
      existing.push(...universalPlugins);
    }
    index.set("__universal__", universalPlugins);
  }

  log.info("Skill index loaded", {
    workflows: collisionMap.size,
    agents: index.size - (index.has("__universal__") ? 1 : 0),
  });

  return index;
}

/**
 * Scan one top-level skills directory (core or plugin), register non-colliding
 * workflows into the index, and append to universalPlugins for hive-wide skills.
 */
function scanWorkflowsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
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
      log.warn("Skill workflow collision — keeping first, skipping second", {
        workflow,
        kept: existing,
        skipped: { source, path: workflowPath },
      });
      continue;
    }
    collisionMap.set(workflow, { source, path: workflowPath });

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
