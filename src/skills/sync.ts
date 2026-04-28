import { join } from "node:path";
import { shallowClone, listSkillsInClone } from "./registry-fetch.js";
import { installSkill } from "./install.js";
import { upgradeSkill } from "./upgrade.js";
import { removeSkill } from "./remove.js";
import { scanCustomerSpaceSkills, skillsFromSource } from "./customer-space-scan.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-sync");

const refuseConflict = async (): Promise<"keep" | "take"> => {
  throw new Error(
    "Sync hit a 3-way merge conflict — this should not happen because customer-modified skills are pre-filtered. File a bug.",
  );
};

export interface SyncResult {
  headSha: string;
  installed: string[];
  upgraded: string[];
  upToDate: string[];
  modifiedSkipped: string[];
  orphaned: string[];
  pruned: string[];
  errors: { skill: string; error: string }[];
}

export interface SyncOptions {
  prune?: boolean;
  dryRun?: boolean;
}

/**
 * Sync customer-space skills against an operator repo.
 *
 * Idempotent. Safe to re-run. Customer-modified skills are never overwritten
 * (the upgrade flow's keep/take logic is bypassed for sync — we always keep
 * local modifications and report them).
 */
export async function syncOperatorSkills(
  operatorRepoUrl: string,
  targetHiveHome: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    headSha: "",
    installed: [],
    upgraded: [],
    upToDate: [],
    modifiedSkipped: [],
    orphaned: [],
    pruned: [],
    errors: [],
  };

  log.info("Sync starting", { repo: operatorRepoUrl, dryRun: !!opts.dryRun });

  const customerSkillsDir = join(targetHiveHome, "skills");
  const clone = shallowClone(operatorRepoUrl);
  result.headSha = clone.headSha;

  try {
    const remoteSkillNames = listSkillsInClone(clone.dir);
    const allCustomer = scanCustomerSpaceSkills(customerSkillsDir);
    const fromOperator = skillsFromSource(allCustomer, operatorRepoUrl);

    for (const remoteName of remoteSkillNames) {
      const existing = fromOperator.find((s) => s.name === remoteName);

      if (!existing) {
        if (opts.dryRun) {
          result.installed.push(remoteName);
          continue;
        }
        try {
          installSkill(operatorRepoUrl, remoteName, customerSkillsDir, targetHiveHome);
          result.installed.push(remoteName);
          log.info("Installed", { skill: remoteName });
        } catch (err) {
          result.errors.push({ skill: remoteName, error: String(err) });
          log.warn("Install failed", { skill: remoteName, err });
        }
        continue;
      }

      if (existing.origin?.modified === true) {
        result.modifiedSkipped.push(remoteName);
        log.info("Skipped (customer-modified)", { skill: remoteName });
        continue;
      }

      if (existing.origin?.["base-version"] === clone.headSha) {
        result.upToDate.push(remoteName);
        continue;
      }

      if (opts.dryRun) {
        result.upgraded.push(remoteName);
        continue;
      }
      try {
        await upgradeSkill(remoteName, customerSkillsDir, targetHiveHome, refuseConflict);
        result.upgraded.push(remoteName);
        log.info("Upgraded", { skill: remoteName });
      } catch (err) {
        result.errors.push({ skill: remoteName, error: String(err) });
        log.warn("Upgrade failed", { skill: remoteName, err });
      }
    }

    // Orphan detection
    for (const customer of fromOperator) {
      if (!remoteSkillNames.includes(customer.name)) {
        result.orphaned.push(customer.name);
        if (opts.prune && !opts.dryRun) {
          try {
            await removeSkill(customer.name, customerSkillsDir, targetHiveHome, { force: true });
            result.pruned.push(customer.name);
            log.info("Pruned orphan", { skill: customer.name });
          } catch (err) {
            result.errors.push({ skill: customer.name, error: String(err) });
            log.warn("Prune failed", { skill: customer.name, err });
          }
        }
      }
    }
  } finally {
    clone.cleanup();
  }

  log.info("Sync complete", {
    installed: result.installed.length,
    upgraded: result.upgraded.length,
    upToDate: result.upToDate.length,
    modifiedSkipped: result.modifiedSkipped.length,
    orphaned: result.orphaned.length,
    pruned: result.pruned.length,
    errors: result.errors.length,
  });

  return result;
}
