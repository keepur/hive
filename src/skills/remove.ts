import { existsSync, rmSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readSkillMd } from "./frontmatter.js";
import { commitRemovalToState } from "./instance-git.js";
import { findInstalledSkill } from "./upgrade.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-remove");

export interface RemoveOptions {
  force?: boolean;
  confirmFn?: (message: string) => Promise<boolean>;
}

/**
 * Remove an installed skill from customer space.
 *
 * §9 of the registry spec:
 *  - Warns if the skill has local modifications (unless --force)
 *  - Removes the skill directory
 *  - Cleans up empty workflow directory
 *  - Commits removal to the state branch
 */
export async function removeSkill(
  skillName: string,
  skillsDir: string,
  hiveHome: string,
  opts: RemoveOptions = {},
): Promise<void> {
  const installed = findInstalledSkill(skillName, skillsDir);
  if (!installed) {
    throw new Error(`Skill "${skillName}" is not installed.`);
  }

  const skillMdPath = join(installed.path, "SKILL.md");
  if (existsSync(skillMdPath)) {
    try {
      const { frontmatter } = readSkillMd(skillMdPath);
      const isModified =
        frontmatter.origin?.modified === true ||
        frontmatter.origin?.type === "agent-authored";

      if (isModified && !opts.force) {
        const message =
          `Warning: ${installed.workflow}/${skillName} has local modifications that will be removed. ` +
          `Your changes are preserved in git history on the 'state' branch. Proceed?`;

        if (opts.confirmFn) {
          const confirmed = await opts.confirmFn(message);
          if (!confirmed) {
            log.info("Skill removal aborted by user", { name: skillName });
            return;
          }
        } else {
          log.warn(message);
          log.warn("Use --force to skip this prompt.");
          return;
        }
      }
    } catch {
      // Frontmatter parse failure — proceed with removal
    }
  }

  const relPath = relative(hiveHome, installed.path);
  rmSync(installed.path, { recursive: true, force: true });

  // Clean up empty workflow directory
  const workflowSkillsDir = join(skillsDir, installed.workflow, "skills");
  if (existsSync(workflowSkillsDir)) {
    const remaining = readdirSync(workflowSkillsDir);
    if (remaining.length === 0) {
      rmSync(join(skillsDir, installed.workflow), {
        recursive: true,
        force: true,
      });
    }
  }

  commitRemovalToState(
    hiveHome,
    [relPath],
    `remove: ${installed.workflow}/${skillName}`,
  );

  log.info("Skill removed", { name: skillName, workflow: installed.workflow });
}
