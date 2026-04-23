import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("upgrade-notice");

export function checkUpgradeNotice(hiveMetaDir: string, skillsDir: string): void {
  const noticeFlag = resolve(hiveMetaDir, "upgrade-notice-emitted");
  if (existsSync(noticeFlag)) return;

  const prevSnapshotPath = resolve(hiveMetaDir, "previous-snapshot.json");
  if (!existsSync(prevSnapshotPath)) return;

  try {
    const prevSnapshot: Array<{ path: string }> = JSON.parse(readFileSync(prevSnapshotPath, "utf-8"));
    const removedSkills: string[] = [];

    for (const entry of prevSnapshot) {
      if (typeof entry.path === "string" && entry.path.startsWith("skills/") && entry.path.endsWith("SKILL.md")) {
        const match = entry.path.match(/^skills\/([^/]+)\//);
        if (match && !existsSync(resolve(skillsDir, match[1]!))) {
          removedSkills.push(match[1]!);
        }
      }
    }

    if (removedSkills.length === 0) return;

    const unique = [...new Set(removedSkills)];
    const notice = [
      "",
      "=".repeat(72),
      "Your previous version of hive shipped the following skills in its tarball:",
      ...unique.map((s) => `  - ${s}`),
      "",
      "These are no longer part of the hive core package. You can re-install any of",
      "them from the default Keepur registry with:",
      "",
      "  hive skill add <name>",
      "",
      "Agent-authored skills you or your agents wrote on this hive are unaffected and",
      "continue to work. This notice only appears once.",
      "=".repeat(72),
      "",
    ].join("\n");

    log.info(notice);

    mkdirSync(hiveMetaDir, { recursive: true });
    writeFileSync(noticeFlag, new Date().toISOString());
  } catch (err) {
    log.warn("Failed to check upgrade notice", { error: String(err) });
  }
}
