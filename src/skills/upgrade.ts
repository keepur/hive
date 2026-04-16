import { existsSync, readFileSync, cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { partialClone, lsRemoteHead, checkoutSha, findTagForSha } from "./registry-fetch.js";
import { readSkillMd, writeSkillMd } from "./frontmatter.js";
import { computeContentHash } from "./content-hash.js";
import { commitToState } from "./instance-git.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-upgrade");

export type UpgradeAction = "up-to-date" | "applied" | "kept" | "taken" | "removed-upstream";

export interface UpgradeResult {
  name: string;
  action: UpgradeAction;
  oldVersion: string;
  newVersion?: string;
}

/**
 * Find an installed skill by name, searching all workflows in customer space.
 */
export function findInstalledSkill(name: string, skillsDir: string): { path: string; workflow: string } | null {
  if (!existsSync(skillsDir)) return null;

  for (const workflow of readdirSync(skillsDir)) {
    const workflowDir = join(skillsDir, workflow);
    try {
      if (!statSync(workflowDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillPath = join(workflowDir, "skills", name);
    if (existsSync(join(skillPath, "SKILL.md"))) {
      return { path: skillPath, workflow };
    }
  }
  return null;
}

/**
 * Upgrade a registry-installed skill to the latest remote HEAD.
 *
 * §8 of the registry spec:
 *  1. Find installed skill by name
 *  2. Read origin metadata from frontmatter (must be registry-sourced)
 *  3. Check remote HEAD via lsRemoteHead
 *  4. If same SHA → "up-to-date"
 *  5. If unmodified → apply cleanly (overwrite, update metadata)
 *  6. If modified → prompt customer (keep vs take)
 *  7. Commit to state branch
 */
export async function upgradeSkill(
  skillName: string,
  skillsDir: string,
  hiveHome: string,
  promptFn: (yours: string, theirs: string, base?: string) => Promise<"keep" | "take">,
): Promise<UpgradeResult> {
  const installed = findInstalledSkill(skillName, skillsDir);
  if (!installed) {
    throw new Error(`Skill "${skillName}" is not installed or is not registry-sourced.`);
  }

  const { frontmatter } = readSkillMd(join(installed.path, "SKILL.md"));
  const origin = frontmatter.origin;
  if (!origin || origin.type !== "registry" || !origin.source || !origin["base-version"]) {
    throw new Error(`Skill "${skillName}" has no registry origin metadata.`);
  }

  const remoteHead = lsRemoteHead(origin.source);
  const oldVersion = origin["base-version"];

  if (remoteHead === oldVersion) {
    return { name: skillName, action: "up-to-date", oldVersion };
  }

  const clone = partialClone(origin.source);

  try {
    const skillSrcDir = join(clone.dir, "skills", skillName);
    if (!existsSync(join(skillSrcDir, "SKILL.md"))) {
      log.warn("Skill removed from registry — keeping installed copy", {
        name: skillName,
        source: origin.source,
      });
      return { name: skillName, action: "removed-upstream", oldVersion };
    }

    // Unmodified — apply cleanly
    if (!origin.modified) {
      cpSync(skillSrcDir, installed.path, { recursive: true });
      const newHash = computeContentHash(installed.path);
      const tag = findTagForSha(clone.dir, remoteHead);
      const { frontmatter: updatedFm, body } = readSkillMd(join(installed.path, "SKILL.md"));
      updatedFm.origin = {
        ...updatedFm.origin!,
        "base-version": remoteHead,
        "base-content-hash": newHash,
        "installed-at": new Date().toISOString(),
        modified: false,
        ...(tag ? { "base-tag": tag } : {}),
      };
      writeSkillMd(join(installed.path, "SKILL.md"), updatedFm, body);

      const relPath = relative(hiveHome, installed.path);
      commitToState(hiveHome, [relPath], `upgrade: ${skillName} ${oldVersion.slice(0, 8)} → ${remoteHead.slice(0, 8)}`);

      return {
        name: skillName,
        action: "applied",
        oldVersion,
        newVersion: remoteHead,
      };
    }

    // Modified — prompt customer
    // Capture upstream content BEFORE checking out the base version,
    // because checkoutSha will overwrite the clone's working tree.
    const yours = readFileSync(join(installed.path, "SKILL.md"), "utf-8");
    const theirs = readFileSync(join(skillSrcDir, "SKILL.md"), "utf-8");

    // Save a copy of the upstream skill directory before checkout changes it
    const theirsCopyDir = join(clone.dir, ".hive-theirs-copy", skillName);
    mkdirSync(theirsCopyDir, { recursive: true });
    cpSync(skillSrcDir, theirsCopyDir, { recursive: true });

    let base: string | undefined;
    try {
      checkoutSha(clone.dir, oldVersion);
      const basePath = join(clone.dir, "skills", skillName, "SKILL.md");
      if (existsSync(basePath)) {
        base = readFileSync(basePath, "utf-8");
      }
    } catch {
      // Base version unreachable — proceed without it
    }

    const choice = await promptFn(yours, theirs, base);

    if (choice === "keep") {
      return { name: skillName, action: "kept", oldVersion };
    }

    // Take upstream — backup modified skill first if no base available
    if (!base) {
      const backupDir = join(hiveHome, ".hive", "skill-backups", `${skillName}-${Date.now()}`);
      mkdirSync(backupDir, { recursive: true });
      cpSync(installed.path, backupDir, { recursive: true });
      log.info("Backed up modified skill before upgrade", {
        backup: backupDir,
      });
    }

    // Copy from the saved upstream snapshot (not skillSrcDir which now points at the base version)
    cpSync(theirsCopyDir, installed.path, { recursive: true });
    const newHash = computeContentHash(installed.path);
    const tag = findTagForSha(clone.dir, remoteHead);
    const { frontmatter: updatedFm, body } = readSkillMd(join(installed.path, "SKILL.md"));
    updatedFm.origin = {
      ...updatedFm.origin!,
      "base-version": remoteHead,
      "base-content-hash": newHash,
      "installed-at": new Date().toISOString(),
      modified: false,
      ...(tag ? { "base-tag": tag } : {}),
    };
    writeSkillMd(join(installed.path, "SKILL.md"), updatedFm, body);

    const relPath = relative(hiveHome, installed.path);
    commitToState(
      hiveHome,
      [relPath],
      `upgrade: ${skillName} ${oldVersion.slice(0, 8)} → ${remoteHead.slice(0, 8)} (took upstream)`,
    );

    return {
      name: skillName,
      action: "taken",
      oldVersion,
      newVersion: remoteHead,
    };
  } finally {
    clone.cleanup();
  }
}
