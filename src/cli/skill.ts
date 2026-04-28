import { verifyGitAvailable } from "../skills/registry-fetch.js";
import { parseSkillSpec, resolveRegistry } from "../skills/registry-resolver.js";
import { installSkill } from "../skills/install.js";
import { upgradeSkill, findInstalledSkill } from "../skills/upgrade.js";
import { removeSkill } from "../skills/remove.js";
import { syncOperatorSkills, type SyncResult } from "../skills/sync.js";
import { readSkillMd } from "../skills/frontmatter.js";
import { hiveHome, skillsDir } from "../paths.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function runSkill(subcommand?: string, ...args: string[]): Promise<void> {
  switch (subcommand) {
    case "add": {
      verifyGitAvailable();
      const spec = args[0];
      if (!spec) {
        console.error("Usage: hive skill add <name|registry:name|url#skills/name>");
        process.exit(1);
      }
      // Lazy-load config only when needed (CLI commands that need config)
      const { config } = await import("../config.js");
      const parsed = parseSkillSpec(spec);
      const registry = resolveRegistry(parsed, config.skillRegistries);
      const result = installSkill(registry.url, parsed.name, skillsDir, hiveHome);
      console.log(`Installed ${result.workflow}/${result.name} (${result.version.slice(0, 8)})`);
      break;
    }

    case "list": {
      if (args.includes("--available")) {
        verifyGitAvailable();
        await listAvailable(args);
      } else {
        listInstalled();
      }
      break;
    }

    case "upgrade": {
      verifyGitAvailable();
      const target = args[0];
      if (!target) {
        console.error("Usage: hive skill upgrade <name|--all>");
        process.exit(1);
      }

      const promptFn = async (yours: string, theirs: string, base?: string): Promise<"keep" | "take"> => {
        console.log("\n--- Your version (installed) ---");
        console.log(yours.slice(0, 500) + (yours.length > 500 ? "\n..." : ""));
        console.log("\n--- Upstream version (registry) ---");
        console.log(theirs.slice(0, 500) + (theirs.length > 500 ? "\n..." : ""));
        if (base) console.log("\n(Three-way diff available)");
        else console.log("\n(Two-way comparison — base version unreachable)");

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("\n[k]eep your version or [t]ake upstream? ", resolve);
        });
        rl.close();
        return answer.toLowerCase().startsWith("t") ? "take" : "keep";
      };

      if (target === "--all") {
        await upgradeAll(promptFn);
      } else {
        const result = await upgradeSkill(target, skillsDir, hiveHome, promptFn);
        console.log(`${result.name}: ${result.action}`);
      }
      break;
    }

    case "remove": {
      const name = args[0];
      if (!name) {
        console.error("Usage: hive skill remove <name> [--force]");
        process.exit(1);
      }
      const force = args.includes("--force");

      const confirmFn = async (message: string): Promise<boolean> => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`${message} [y/N] `, resolve);
        });
        rl.close();
        return answer.toLowerCase() === "y";
      };

      const removed = await removeSkill(name, skillsDir, hiveHome, { force, confirmFn });
      if (removed) {
        console.log(`Removed ${name}`);
      }
      break;
    }

    case "search": {
      const query = args[0];
      if (!query) {
        console.error("Usage: hive skill search <query>");
        process.exit(1);
      }
      searchSkills(query);
      break;
    }

    case "sync": {
      verifyGitAvailable();
      const { config } = await import("../config.js");
      if (!config.operatorSkillsRepo) {
        console.error("No operatorSkillsRepo configured in hive.yaml. Set:");
        console.error("");
        console.error("  operatorSkillsRepo:");
        console.error("    url: https://github.com/<operator>/<repo>");
        console.error("");
        process.exit(1);
      }
      const dryRun = process.argv.includes("--dry-run");
      const prune = process.argv.includes("--prune");
      const result = await syncOperatorSkills(
        config.operatorSkillsRepo.url,
        hiveHome,
        { dryRun, prune },
      );
      printSyncSummary(result, { dryRun, prune });
      if (result.errors.length > 0) process.exit(1);
      break;
    }

    default:
      console.error(
        "Usage: hive skill <add|list|upgrade|remove|search|sync> [args]\n" +
          "\n" +
          "  sync [--dry-run] [--prune]\n" +
          "        Sync customer-space skills with the configured operatorSkillsRepo.\n" +
          "        Installs missing, upgrades stale, leaves customer-modified alone.\n" +
          "        --dry-run: report changes without applying.\n" +
          "        --prune:   remove customer-space skills sourced from this repo\n" +
          "                   but no longer present in it.",
      );
      process.exit(1);
  }
}

function printSyncSummary(
  r: SyncResult,
  opts: { dryRun: boolean; prune: boolean },
): void {
  const prefix = opts.dryRun ? "(dry-run) " : "";
  console.log(`${prefix}Sync result @ ${r.headSha.slice(0, 8)}:`);
  if (r.installed.length)
    console.log(`  installed (${r.installed.length}): ${r.installed.join(", ")}`);
  if (r.upgraded.length)
    console.log(`  upgraded (${r.upgraded.length}): ${r.upgraded.join(", ")}`);
  if (r.upToDate.length) console.log(`  up to date: ${r.upToDate.length}`);
  if (r.modifiedSkipped.length)
    console.log(`  customer-modified (skipped): ${r.modifiedSkipped.join(", ")}`);
  if (r.orphaned.length) {
    console.log(`  orphaned (${r.orphaned.length}): ${r.orphaned.join(", ")}`);
    if (!opts.prune) console.log(`    re-run with --prune to remove orphans`);
  }
  if (r.pruned.length) console.log(`  pruned: ${r.pruned.join(", ")}`);
  if (r.errors.length) {
    console.log(`  errors (${r.errors.length}):`);
    for (const e of r.errors) console.log(`    ${e.skill}: ${e.error}`);
  }
}

function listInstalled(): void {
  if (!existsSync(skillsDir)) {
    console.log("No skills installed.");
    return;
  }

  const workflows = readdirSync(skillsDir).filter((d) => {
    try {
      return statSync(join(skillsDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  if (workflows.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log("Installed skills:\n");

  for (const workflow of workflows.sort()) {
    const skillsSubdir = join(skillsDir, workflow, "skills");
    if (!existsSync(skillsSubdir)) continue;

    for (const skill of readdirSync(skillsSubdir).sort()) {
      const mdPath = join(skillsSubdir, skill, "SKILL.md");
      if (!existsSync(mdPath)) continue;

      try {
        const { frontmatter } = readSkillMd(mdPath);
        const originType = frontmatter.origin?.type ?? "unknown";
        const modified = frontmatter.origin?.modified !== undefined ? String(frontmatter.origin.modified) : "-";
        console.log(`  ${skill.padEnd(25)} ${workflow.padEnd(20)} ${originType.padEnd(15)} ${modified}`);
      } catch {
        console.log(`  ${skill.padEnd(25)} ${workflow.padEnd(20)} ${"?".padEnd(15)} ?`);
      }
    }
  }
}

async function listAvailable(args: string[]): Promise<void> {
  const { shallowClone, listSkillsInClone } = await import("../skills/registry-fetch.js");
  const { config } = await import("../config.js");

  const fromIdx = args.indexOf("--from");
  const fromArg = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

  const registries = fromArg
    ? [
        {
          name: fromArg,
          url: config.skillRegistries.find((r) => r.name === fromArg)?.url ?? fromArg,
        },
      ]
    : config.skillRegistries;

  for (const reg of registries) {
    console.log(`\nRegistry: ${reg.name} (${reg.url})\n`);
    const clone = shallowClone(reg.url);
    try {
      const names = listSkillsInClone(clone.dir);
      if (names.length === 0) {
        console.log("  (no skills)");
        continue;
      }
      for (const name of names.sort()) {
        const mdPath = join(clone.dir, "skills", name, "SKILL.md");
        const content = readFileSync(mdPath, "utf-8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch?.[1]?.trim() ?? "";
        console.log(`  ${name.padEnd(30)} ${desc}`);
      }
    } finally {
      clone.cleanup();
    }
  }
}

function searchSkills(query: string): void {
  const lowerQuery = query.toLowerCase();
  let found = false;

  if (existsSync(skillsDir)) {
    for (const workflow of readdirSync(skillsDir)) {
      const skillsSubdir = join(skillsDir, workflow, "skills");
      if (!existsSync(skillsSubdir)) continue;

      for (const skill of readdirSync(skillsSubdir)) {
        const mdPath = join(skillsSubdir, skill, "SKILL.md");
        if (!existsSync(mdPath)) continue;

        try {
          const { frontmatter } = readSkillMd(mdPath);
          if (
            skill.toLowerCase().includes(lowerQuery) ||
            (frontmatter.description ?? "").toLowerCase().includes(lowerQuery)
          ) {
            console.log(`  ${skill} (${workflow}) — ${frontmatter.description ?? ""}`);
            found = true;
          }
        } catch {
          // skip
        }
      }
    }
  }

  if (!found) console.log("No matching skills found.");
}

async function upgradeAll(
  promptFn: (yours: string, theirs: string, base?: string) => Promise<"keep" | "take">,
): Promise<void> {
  if (!existsSync(skillsDir)) {
    console.log("No skills installed.");
    return;
  }

  const skills: string[] = [];
  for (const workflow of readdirSync(skillsDir)) {
    const skillsSubdir = join(skillsDir, workflow, "skills");
    if (!existsSync(skillsSubdir)) continue;

    for (const skill of readdirSync(skillsSubdir).sort()) {
      const mdPath = join(skillsSubdir, skill, "SKILL.md");
      if (!existsSync(mdPath)) continue;

      try {
        const { frontmatter } = readSkillMd(mdPath);
        if (frontmatter.origin?.type === "registry") {
          skills.push(skill);
        }
      } catch {
        // skip
      }
    }
  }

  if (skills.length === 0) {
    console.log("No registry-sourced skills to upgrade.");
    return;
  }

  for (const name of skills) {
    try {
      const result = await upgradeSkill(name, skillsDir, hiveHome, promptFn);
      console.log(`${result.name}: ${result.action}`);
    } catch (err) {
      console.error(`${name}: failed — ${String(err)}`);
    }
  }
}
