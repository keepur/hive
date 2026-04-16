import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripOriginBlock } from "./frontmatter.js";

/**
 * Compute a SHA-256 content hash of a skill directory.
 *
 * The hash covers SKILL.md (with origin: block stripped) plus all sidecar
 * files in alphabetical path order, separated by null bytes.
 */
export function computeContentHash(skillDir: string): string {
  const files = collectFiles(skillDir).sort();
  const hash = createHash("sha256");

  for (let i = 0; i < files.length; i++) {
    if (i > 0) hash.update("\x00");
    const filePath = join(skillDir, files[i]!);
    const content = readFileSync(filePath, "utf-8");
    if (files[i] === "SKILL.md") {
      hash.update(stripOriginBlock(content));
    } else {
      hash.update(content);
    }
  }

  return hash.digest("hex");
}

function collectFiles(dir: string, prefix = ""): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}
