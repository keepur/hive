import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillOrigin } from "./frontmatter.js";
import { readSkillMd } from "./frontmatter.js";

export interface InstalledSkill {
  /** Skill directory name (e.g., "morning-briefing") */
  name: string;
  /** Workflow projection (e.g., "morning-briefing" or "default") */
  workflow: string;
  /** Absolute path to the SKILL.md file */
  skillMdPath: string;
  /** Origin metadata from frontmatter, if present */
  origin?: SkillOrigin;
}

/**
 * Walk <hiveHome>/skills/<workflow>/skills/<name>/SKILL.md and return
 * one entry per installed skill with parsed origin frontmatter.
 *
 * Skills without a SKILL.md or with unparseable frontmatter are skipped
 * (logged at debug level by the caller).
 */
export function scanCustomerSpaceSkills(skillsRoot: string): InstalledSkill[] {
  if (!existsSync(skillsRoot)) return [];
  const results: InstalledSkill[] = [];

  for (const workflow of readdirSync(skillsRoot)) {
    const workflowDir = join(skillsRoot, workflow);
    if (!statSync(workflowDir).isDirectory()) continue;

    const skillsSubdir = join(workflowDir, "skills");
    if (!existsSync(skillsSubdir)) continue;

    for (const name of readdirSync(skillsSubdir)) {
      const skillDir = join(skillsSubdir, name);
      if (!statSync(skillDir).isDirectory()) continue;

      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      let origin: SkillOrigin | undefined;
      try {
        const { frontmatter } = readSkillMd(skillMdPath);
        origin = frontmatter.origin;
      } catch {
        // Unparseable frontmatter — skip origin but still report the skill exists
      }

      results.push({ name, workflow, skillMdPath, origin });
    }
  }

  return results;
}

/**
 * Filter installed skills by origin source URL.
 * Used by sync to find skills that came from a specific operator repo.
 */
export function skillsFromSource(
  installed: InstalledSkill[],
  sourceUrl: string,
): InstalledSkill[] {
  return installed.filter((s) => s.origin?.source === sourceUrl);
}
