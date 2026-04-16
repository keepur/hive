import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { skillsDir, hiveHome } from "../paths.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { commitToState } from "./instance-git.js";
import { isInsideCustomerSpace } from "./skill-paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("write-guard");

export interface WriteGuardContext {
  agentId: string;
  reason?: string;
}

/**
 * Check if a file path is a SKILL.md write that should go through the write guard.
 */
export function isSkillWrite(path: string): boolean {
  const resolved = resolve(path);
  return resolved.endsWith("/SKILL.md") && isInsideCustomerSpace(resolved);
}

/**
 * Process a SKILL.md write through the guard.
 * - Validates the path is in customer space
 * - Injects agent-authored metadata for new skills
 * - Commits to the state branch
 *
 * Returns the (possibly modified) content to write.
 * Throws if the path violates the customer-space constraint.
 */
export function processSkillWrite(path: string, content: string, ctx: WriteGuardContext): string {
  const resolved = resolve(path);

  if (!isInsideCustomerSpace(resolved)) {
    throw new Error(
      `Skill write rejected: ${resolved} is outside customer space (${skillsDir}). ` +
        `Agent-authored skills must be written under ${skillsDir}/.`,
    );
  }

  const isNew = !existsSync(resolved);
  let finalContent = content;

  if (isNew) {
    try {
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter.origin) {
        frontmatter.origin = {
          type: "agent-authored",
        };
        frontmatter.author = {
          "agent-id": ctx.agentId,
          "authored-at": new Date().toISOString(),
          ...(ctx.reason ? { reason: ctx.reason } : {}),
        };
        finalContent = serializeFrontmatter(frontmatter, body);
      }
    } catch {
      log.warn("Could not parse frontmatter for metadata injection", {
        path: resolved,
      });
    }
  }

  // Commit to state branch
  const relPath = relative(hiveHome, resolved);
  const message = isNew ? `agent-authored: ${relPath}${ctx.reason ? ` — ${ctx.reason}` : ""}` : `update: ${relPath}`;
  commitToState(hiveHome, [relPath], message, ctx.agentId);

  return finalContent;
}
