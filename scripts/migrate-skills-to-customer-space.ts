#!/usr/bin/env npx tsx
/**
 * One-time migration: copy agent-authored skills from plugins/dodi/skills/
 * to customer space (<hiveHome>/skills/) with agent-authored metadata.
 *
 * Run on each deployment after updating to the version that removes
 * plugins/dodi/skills/ from the repo.
 *
 * Usage: npx tsx scripts/migrate-skills-to-customer-space.ts <source-dir>
 *
 * source-dir is required — point it to a backup of the old plugins/dodi/skills/
 * directory (the skills were deleted from the repo in this PR).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readSkillMd, writeSkillMd } from "../src/skills/frontmatter.js";
import { commitToState } from "../src/skills/instance-git.js";

// Resolve paths — source-dir is required (the skills/ dir was deleted from the repo)
const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error("Usage: npx tsx scripts/migrate-skills-to-customer-space.ts <source-dir>");
  console.error("  source-dir: path to the old plugins/dodi/skills/ directory (backed up before deploy)");
  process.exit(1);
}
const hiveHome = process.env.HIVE_HOME ?? process.cwd();
const targetSkillsDir = resolve(hiveHome, "skills");

if (!existsSync(sourceDir)) {
  console.error(`Source directory not found: ${sourceDir}`);
  console.error("Pass the path to the old plugins/dodi/skills/ directory as an argument.");
  process.exit(1);
}

const timestamp = new Date().toISOString();
const migrated: string[] = [];

// Walk each workflow suite
for (const suite of readdirSync(sourceDir)) {
  const suiteDir = join(sourceDir, suite);
  if (!statSync(suiteDir).isDirectory()) continue;

  const targetSuiteDir = join(targetSkillsDir, suite);

  if (existsSync(targetSuiteDir)) {
    console.log(`⚠ Skipping ${suite} — already exists in customer space`);
    continue;
  }

  // Copy entire suite preserving structure
  mkdirSync(targetSuiteDir, { recursive: true });
  cpSync(suiteDir, targetSuiteDir, { recursive: true });

  // Inject metadata on each SKILL.md
  const skillsSubDir = join(targetSuiteDir, "skills");
  if (existsSync(skillsSubDir)) {
    for (const skill of readdirSync(skillsSubDir)) {
      const skillMdPath = join(skillsSubDir, skill, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const { frontmatter, body } = readSkillMd(skillMdPath);
        if (!frontmatter.origin) {
          frontmatter.origin = { type: "agent-authored" };
          frontmatter.author = {
            "agent-id": "migrated-from-plugin",
            "authored-at": timestamp,
            reason: "Migrated from plugins/dodi/skills/ — agent-authored content restored to customer space",
          };
          writeSkillMd(skillMdPath, frontmatter, body);
          console.log(`  ✓ ${suite}/skills/${skill}/SKILL.md — metadata injected`);
        } else {
          console.log(`  → ${suite}/skills/${skill}/SKILL.md — origin already set, skipping`);
        }
      } catch (err) {
        console.error(`  ✗ ${suite}/skills/${skill}/SKILL.md — ${String(err)}`);
      }
    }
  }

  migrated.push(suite);
  console.log(`✓ Migrated ${suite}`);
}

if (migrated.length === 0) {
  console.log("\nNothing to migrate.");
  process.exit(0);
}

// Commit to state branch
const relPaths = migrated.map((s) => relative(hiveHome, join(targetSkillsDir, s)));
try {
  commitToState(
    hiveHome,
    relPaths,
    `migrate: restore ${migrated.length} agent-authored skill suites from plugins/dodi/skills/ to customer space`,
    "migrated-from-plugin",
  );
  console.log(`\n✓ Committed to state branch (${migrated.length} suites)`);
} catch (err) {
  console.warn(`\n⚠ State branch commit failed: ${String(err)}`);
  console.warn("Skills were copied but not committed. Run manually if needed.");
}

console.log(`\nMigration complete. ${migrated.length} suites moved to ${targetSkillsDir}`);
