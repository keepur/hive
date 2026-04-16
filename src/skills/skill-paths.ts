import { resolve, join } from "node:path";
import { skillsDir } from "../paths.js";

/**
 * Resolve the runtime path for a skill given its workflow and name.
 * Layout: <skillsDir>/<workflow>/skills/<name>/SKILL.md
 */
export function skillRuntimePath(workflow: string, name: string): string {
  return join(skillsDir, workflow, "skills", name);
}

/**
 * Check whether a given absolute path is inside the customer-space skills dir.
 */
export function isInsideCustomerSpace(path: string): boolean {
  const resolved = resolve(path);
  const base = resolve(skillsDir);
  return resolved.startsWith(base + "/") || resolved === base;
}

/**
 * Extract workflow and skill name from a runtime path inside customer space.
 * Returns null if the path doesn't match the expected layout.
 */
export function parseSkillPath(
  path: string,
): { workflow: string; name: string } | null {
  const resolved = resolve(path);
  const base = resolve(skillsDir);
  if (!resolved.startsWith(base + "/")) return null;
  const rel = resolved.slice(base.length + 1);
  const match = rel.match(/^([^/]+)\/skills\/([^/]+)/);
  if (!match) return null;
  return { workflow: match[1]!, name: match[2]! };
}
