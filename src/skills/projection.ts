import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Read the workflow: field from SKILL.md frontmatter.
 * Returns the workflow name, or the skill name as fallback.
 */
export function extractWorkflow(skillMdPath: string, skillName: string): string {
  const content = readFileSync(skillMdPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return skillName;
  const workflowMatch = fmMatch[1]!.match(/^workflow:\s*(.+)$/m);
  if (!workflowMatch) return skillName;
  return workflowMatch[1]!.trim();
}

/**
 * Compute the runtime target path for a skill.
 * Registry: skills/<name>/ → Runtime: <skillsDir>/<workflow>/skills/<name>/
 */
export function projectToRuntime(skillsDir: string, workflow: string, skillName: string): string {
  return join(skillsDir, workflow, "skills", skillName);
}
