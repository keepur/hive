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
 *
 * KPR-228: the scan + walk helpers are pure functions parameterized on
 * roots and ignoreFragments so the regression test can exercise the
 * worktree-vs-CI asymmetry case (file tree under .claude/worktrees/
 * MUST be scanned when invoked from inside such a worktree).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
//
// KPR-228: previously included ".claude/worktrees/" which silently
// disabled the entire test when `npm run check` ran from a worktree
// path (every scanned path matched the fragment → walk returned
// nothing → test trivially passed). The asymmetry hid two
// claude-sonnet-4-5 violations through 17 phases of the KPR-220 epic
// (caught only on CI of PR #266; fixed in a8d28fb). Worktree paths
// are now scanned the same as repo-root paths.
const IGNORE_FRAGMENTS = [
  "node_modules",
  "/dist/",
  "/pkg/",
  "docs/plans/",
  "docs/specs/",
  "plugins/claude-code/",
  // Self-exclusion: this file documents the regex literally.
  "src/no-deprecated-models.test.ts",
];

function walk(dir: string, out: string[], ignoreFragments: string[]): string[] {
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
    if (ignoreFragments.some((frag) => full.includes(frag))) continue;
    if (st.isDirectory()) walk(full, out, ignoreFragments);
    else out.push(full);
  }
  return out;
}

function scanForDeprecatedModels(repoRoot: string, roots: string[], ignoreFragments: string[]): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    const files = walk(join(repoRoot, root), [], ignoreFragments);
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
  return offenders;
}

describe("KPR-119: no deprecated Claude model literals in tracked source", () => {
  it("every tracked file is on the current tier ceiling", () => {
    const offenders = scanForDeprecatedModels(process.cwd(), ROOTS, IGNORE_FRAGMENTS);
    expect(offenders, `Found deprecated model literal(s) in:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("KPR-228: worktree-vs-CI exclusion asymmetry regression", () => {
  // Pre-fix bug (recorded in feedback_worktree_ci_quality_gate_asymmetry):
  // IGNORE_FRAGMENTS included ".claude/worktrees/". When npm run check ran
  // from inside .claude/worktrees/<name>/, process.cwd()-rooted walk paths
  // all matched the fragment, so the scan returned no files and the test
  // trivially passed. CI runs from a non-worktree path and detected the
  // regression — the local quality gate did not.
  //
  // Post-fix: ".claude/worktrees/" is no longer in IGNORE_FRAGMENTS, so
  // a worktree-style file tree is correctly scanned.
  it("scans files inside .claude/worktrees/<name>/ when invoked from such a worktree", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "kpr228-"));
    try {
      // Simulate the on-disk shape of a worktree: <root>/.claude/worktrees/x/src/<file>.ts
      // The "worktree root" is the dir we run the scan from (mimics process.cwd()
      // when npm run check is invoked from inside a worktree).
      const worktreeRoot = join(tmpRoot, ".claude", "worktrees", "x");
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "deprecated.ts"), `export const STALE_MODEL = "claude-sonnet-4-5";\n`);
      writeFileSync(join(worktreeRoot, "src", "current.ts"), `export const FRESH_MODEL = "claude-sonnet-4-6";\n`);

      // Scan with the post-fix IGNORE_FRAGMENTS — must find deprecated.ts.
      // Negative-verify: add ".claude/worktrees/" back to the local
      // ignoreFragments arg and the scan returns [] (fragment filter
      // catches every path under the worktree root).
      const offenders = scanForDeprecatedModels(worktreeRoot, ["src"], IGNORE_FRAGMENTS);

      expect(offenders).toContain("src/deprecated.ts");
      expect(offenders).not.toContain("src/current.ts");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("IGNORE_FRAGMENTS does NOT contain '.claude/worktrees/' (the exclusion that hid KPR-220 voice-test regressions)", () => {
    // Stronger guard than the behavior test above — pins the explicit
    // list so a future "innocent" PR can't silently restore the
    // worktree-blanket exclusion without this test failing.
    expect(IGNORE_FRAGMENTS).not.toContain(".claude/worktrees/");
  });
});
