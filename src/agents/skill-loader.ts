import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-loader");

export type SkillIndex = Map<string, SdkPluginConfig[]>;

/**
 * Scan skills/ for workflow directories, parse SKILL.md frontmatter,
 * build a map of agentId → SdkPluginConfig[] for that agent's workflows.
 */
export function loadSkillIndex(skillsDir: string = resolve("skills")): SkillIndex {
  const index: SkillIndex = new Map();

  if (!existsSync(skillsDir)) {
    log.debug("No skills directory found", { path: skillsDir });
    return index;
  }

  try {
    // Collect workflows that apply to "all" agents
    const universalPlugins: SdkPluginConfig[] = [];

    // Each top-level dir in skills/ is a workflow
    const workflows = readdirSync(skillsDir).filter((d) =>
      statSync(join(skillsDir, d)).isDirectory(),
    );

    for (const workflow of workflows) {
      const workflowPath = join(skillsDir, workflow);
      const skillsSubdir = join(workflowPath, "skills");

      if (!existsSync(skillsSubdir)) {
        log.debug("Workflow missing .claude/skills/, skipping", { workflow });
        continue;
      }

      const pluginConfig: SdkPluginConfig = { type: "local", path: workflowPath };

      // Scan each skill inside the workflow for agents frontmatter
      const agentIds = new Set<string>();
      let hasAll = false;

      const skillDirs = readdirSync(skillsSubdir).filter((d) =>
        statSync(join(skillsSubdir, d)).isDirectory(),
      );

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
        log.debug("Workflow registered as universal", { workflow, skills: skillDirs.length });
      } else if (agentIds.size > 0) {
        for (const agentId of agentIds) {
          const existing = index.get(agentId) ?? [];
          existing.push(pluginConfig);
          index.set(agentId, existing);
        }
        log.debug("Workflow registered", { workflow, agents: [...agentIds], skills: skillDirs.length });
      }
    }

    // Merge universal plugins into every agent's list
    if (universalPlugins.length > 0) {
      // Get all agent IDs currently in the index
      const allAgentIds = new Set(index.keys());
      // Also need to handle agents with no workflow-specific skills —
      // they'll get universal plugins when looked up via getSkillsForAgent()
      for (const agentId of allAgentIds) {
        const existing = index.get(agentId)!;
        existing.push(...universalPlugins);
      }
      // Store universal plugins under a sentinel key for agents not yet in the index
      index.set("__universal__", universalPlugins);
    }

    const totalWorkflows = workflows.filter((w) => existsSync(join(skillsDir, w, ".claude", "skills"))).length;
    log.info("Skill index loaded", { workflows: totalWorkflows, agents: index.size - (index.has("__universal__") ? 1 : 0) });
  } catch (err) {
    log.warn("Failed to load skill index, returning empty index", { error: String(err) });
  }

  return index;
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
