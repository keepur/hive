import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  shallowClone,
  listSkillsInClone,
  findTagForSha,
} from "./registry-fetch.js";
import { extractWorkflow, projectToRuntime } from "./projection.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { computeContentHash } from "./content-hash.js";
import { commitToState } from "./instance-git.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-install");

export interface InstallResult {
  name: string;
  workflow: string;
  targetPath: string;
  version: string;
}

export function installSkill(
  registryUrl: string,
  skillName: string,
  targetSkillsDir: string,
  targetHiveHome: string,
): InstallResult {
  const clone = shallowClone(registryUrl);

  try {
    // Resolve skill directory in clone
    const skillSrcDir = join(clone.dir, "skills", skillName);
    if (!existsSync(skillSrcDir)) {
      const available = listSkillsInClone(clone.dir);
      throw new Error(
        `Skill "${skillName}" not found in registry ${registryUrl}. ` +
          `Available skills: ${available.join(", ") || "(none)"}`,
      );
    }

    // Read frontmatter, extract workflow
    const skillMdPath = join(skillSrcDir, "SKILL.md");
    const workflow = extractWorkflow(skillMdPath, skillName);

    // Validate name field (warning only)
    const rawContent = readFileSync(skillMdPath, "utf-8");
    const fmMatch = rawContent.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const nameMatch = fmMatch[1]!.match(/^name:\s*(.+)$/m);
      if (nameMatch && nameMatch[1]!.trim() !== skillName) {
        log.warn("Registry skill name mismatch — using directory name", {
          dirName: skillName,
          frontmatterName: nameMatch[1]!.trim(),
        });
      }
    }

    // Construct target path
    const targetPath = projectToRuntime(targetSkillsDir, workflow, skillName);

    // Check for existing install
    if (existsSync(targetPath)) {
      throw new Error(
        `Skill "${skillName}" is already installed at ${targetPath}. ` +
          `Use "hive skill upgrade ${skillName}" to update, or "hive skill remove ${skillName}" first.`,
      );
    }

    // Copy entire skill directory
    mkdirSync(targetPath, { recursive: true });
    cpSync(skillSrcDir, targetPath, { recursive: true });

    // Record install metadata
    const contentHash = computeContentHash(targetPath);
    const tag = findTagForSha(clone.dir, clone.headSha);
    const { frontmatter, body } = parseFrontmatter(
      readFileSync(join(targetPath, "SKILL.md"), "utf-8"),
    );

    frontmatter.origin = {
      type: "registry",
      source: registryUrl,
      "base-version": clone.headSha,
      ...(tag ? { "base-tag": tag } : {}),
      "base-content-hash": contentHash,
      "installed-at": new Date().toISOString(),
      modified: false,
    };

    writeFileSync(
      join(targetPath, "SKILL.md"),
      serializeFrontmatter(frontmatter, body),
    );

    // Commit to state branch
    const relPath = relative(targetHiveHome, targetPath);
    commitToState(
      targetHiveHome,
      [relPath],
      `install: ${workflow}/${skillName} from ${registryUrl}@${clone.headSha.slice(0, 8)}`,
    );

    log.info("Skill installed", {
      name: skillName,
      workflow,
      version: clone.headSha.slice(0, 8),
    });

    return { name: skillName, workflow, targetPath, version: clone.headSha };
  } finally {
    clone.cleanup();
  }
}
