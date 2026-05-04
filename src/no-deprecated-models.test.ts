// src/no-deprecated-models.test.ts
/**
 * KPR-119 — guards against re-introducing a deprecated Claude model
 * literal in tracked source. The acceptance regex is the same one
 * captured in the KPR-119 spec body.
 *
 * Canonical-form rule: this scans BOTH the runtime stamped form
 * (claude-haiku-4-5-20251001) and the unstamped fixture form
 * (claude-haiku-4-5). The deprecated regex below intentionally only
 * matches IDs strictly older than the current tier ceilings.
 *
 * If a future bump is needed (e.g. opus 4-7 → 4-8), update the regex
 * here in the same PR that bumps the runtime sites.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Tier ceilings as of 2026-05-04 — Opus 4.7, Sonnet 4.6, Haiku 4.5.
// Match deprecated IDs strictly older than each ceiling.
const DEPRECATED = /claude-opus-4-[0-6]\b|claude-sonnet-4-[0-5]\b|claude-haiku-4-[0-4]\b|claude-haiku-3-/;

// Roots to scan, relative to repo root. Mirrors the KPR-119 AC grep
// (which includes `docs/`; non-historical docs only — historical
// plans/specs filtered via IGNORE_FRAGMENTS below).
const ROOTS = ["src", "setup", "seeds", "install", "service", "templates", "docs"];

// Path fragments to ignore. Historical artifacts and vendored content
// are explicitly out of scope per the KPR-119 spec.
const IGNORE_FRAGMENTS = [
  "node_modules",
  "/dist/",
  "/pkg/",
  "docs/plans/",
  "docs/specs/",
  "plugins/claude-code/",
  ".claude/worktrees/",
  // Self-exclusion: this file documents the regex literally.
  "src/no-deprecated-models.test.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (IGNORE_FRAGMENTS.some((frag) => full.includes(frag))) continue;
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("KPR-119: no deprecated Claude model literals in tracked source", () => {
  it("every tracked file is on the current tier ceiling", () => {
    const repoRoot = process.cwd();
    const offenders: string[] = [];
    for (const root of ROOTS) {
      const files = walk(join(repoRoot, root));
      for (const f of files) {
        // Only scan text-ish files; skip binaries by extension.
        if (!/\.(ts|tsx|js|mjs|cjs|json|yaml|yml|md|sh|tpl)$/.test(f)) continue;
        let content: string;
        try {
          content = readFileSync(f, "utf8");
        } catch {
          continue;
        }
        if (DEPRECATED.test(content)) {
          offenders.push(relative(repoRoot, f));
        }
      }
    }
    expect(offenders, `Found deprecated model literal(s) in:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
