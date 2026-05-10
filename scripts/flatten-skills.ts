#!/usr/bin/env npx tsx
/**
 * KPR-214 — Skills layout flatten migration script.
 *
 * Walks a given root directory and rewrites the legacy double-`skills/` layout
 * (`<root>/skills/<workflow>/skills/<skill>/SKILL.md`) into the SDK-exact flat
 * layout (`<root>/skills/<skill>/SKILL.md`).
 *
 * Idempotent — re-running on already-flat layout is a no-op. Dry-run mode
 * prints planned moves without applying.
 *
 * Usage:
 *   npx tsx scripts/flatten-skills.ts <root> [<root>...] [--dry] [--quiet]
 *
 * Examples:
 *   npx tsx scripts/flatten-skills.ts seeds/chief-of-staff
 *   npx tsx scripts/flatten-skills.ts seeds/chief-of-staff plugins --dry
 */
import { existsSync, mkdtempSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PlannedMove {
  from: string;
  to: string;
  /** True when the destination name was rewritten to avoid a name collision. */
  renamed: boolean;
  /** Original inner skill directory name (before any collision rename). */
  originalSkill: string;
  /** The workflow grouping the skill was lifted out of. */
  workflow: string;
}

export interface FlattenPlan {
  root: string;
  moves: PlannedMove[];
  /** Workflow-level dirs that will be removed once empty. */
  emptyWorkflows: string[];
  /** Workflows already at the flat layout — no work to do. */
  alreadyFlat: string[];
}

export interface FlattenOptions {
  /** When true, only compute the plan; do not move anything on disk. */
  dry?: boolean;
  /** When true, suppress info-level logging (errors still print). */
  quiet?: boolean;
}

/**
 * Detect whether a workflow dir holds the legacy double-`skills/` layout.
 * Returns the path to the inner `skills/` subdir, or null if the workflow is
 * already flat (i.e. it directly contains a `SKILL.md`).
 */
function detectInnerSkillsDir(workflowPath: string): string | null {
  const innerSkills = join(workflowPath, "skills");
  // If the workflow dir itself looks like a flat skill (has SKILL.md), it's
  // already flat — leave it alone.
  if (existsSync(join(workflowPath, "SKILL.md"))) return null;
  if (!existsSync(innerSkills)) return null;
  try {
    if (!statSync(innerSkills).isDirectory()) return null;
  } catch {
    return null;
  }
  return innerSkills;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Compute the planned moves for a single root (e.g. `seeds/chief-of-staff` or
 * a plugin directory). The `root` is the directory CONTAINING `skills/`.
 *
 * Layout produced:
 *   <root>/skills/<workflow>/skills/<skill>/SKILL.md
 *     →
 *   <root>/skills/<skill>/SKILL.md
 *
 * If the same `<skill>` name would appear under two different workflows, the
 * second occurrence is renamed to `<workflow>-<skill>` to avoid clobbering.
 */
export function planFlatten(root: string): FlattenPlan {
  const skillsRoot = join(root, "skills");
  const plan: FlattenPlan = {
    root,
    moves: [],
    emptyWorkflows: [],
    alreadyFlat: [],
  };

  if (!existsSync(skillsRoot)) return plan;

  // Track destination names already claimed within this root so collisions get
  // a stable, deterministic rename.
  const claimed = new Set<string>();

  // First pass: anything already-flat at the top level claims its name (so
  // re-running on a partially-migrated tree doesn't try to move workflow-grouped
  // siblings on top of an already-flat skill).
  const topLevel = listDirs(skillsRoot);
  for (const name of topLevel) {
    const candidate = join(skillsRoot, name);
    if (existsSync(join(candidate, "SKILL.md"))) {
      claimed.add(name);
      plan.alreadyFlat.push(name);
    }
  }

  for (const workflow of topLevel) {
    const workflowPath = join(skillsRoot, workflow);
    const innerSkills = detectInnerSkillsDir(workflowPath);
    if (!innerSkills) continue; // already-flat or unrelated

    const innerSkillDirs = listDirs(innerSkills);
    if (innerSkillDirs.length === 0) {
      // Empty workflow grouping — nothing to lift, but the workflow dir is
      // dead weight; record it for cleanup.
      plan.emptyWorkflows.push(workflowPath);
      continue;
    }

    for (const skill of innerSkillDirs) {
      const fromPath = join(innerSkills, skill);

      // Only operate on dirs that contain a SKILL.md (matches what the loader
      // would actually pick up). Dirs without SKILL.md are skipped — surface
      // them as a warning at execute time.
      if (!existsSync(join(fromPath, "SKILL.md"))) continue;

      let destName = skill;
      let renamed = false;
      if (claimed.has(destName)) {
        // Collision — prefix with workflow name. If THAT also collides, append
        // a numeric suffix until a free slot is found. This is intentionally
        // boring: deterministic, easy to audit in commit output.
        const prefixed = `${workflow}-${skill}`;
        if (!claimed.has(prefixed)) {
          destName = prefixed;
        } else {
          let n = 2;
          while (claimed.has(`${prefixed}-${n}`)) n++;
          destName = `${prefixed}-${n}`;
        }
        renamed = true;
      }
      claimed.add(destName);

      const toPath = join(skillsRoot, destName);
      plan.moves.push({
        from: fromPath,
        to: toPath,
        renamed,
        originalSkill: skill,
        workflow,
      });
    }

    // The workflow dir + its inner `skills/` go away once moves are applied
    // (they'll be empty). Record for cleanup.
    plan.emptyWorkflows.push(workflowPath);
  }

  return plan;
}

/**
 * Apply a flatten plan to disk. Logs each move; removes empty workflow dirs.
 * Returns the plan unchanged for chaining.
 *
 * Move strategy: every move is staged through a sibling temp directory before
 * landing at its final destination. This is required when the destination is
 * an ancestor of the source (the very common `<root>/skills/<x>/skills/<x>`
 * → `<root>/skills/<x>` case) — a direct `rename()` fails with `ENOTEMPTY`
 * because the destination workflow dir isn't yet empty. Staging via a
 * sibling-of-the-destination keeps the rename atomic on the same filesystem
 * and avoids cross-device EXDEV.
 */
export function applyFlattenPlan(plan: FlattenPlan, opts: FlattenOptions = {}): FlattenPlan {
  const log = opts.quiet ? () => {} : (...args: unknown[]) => console.log(...args);

  // Staging dir is a sibling of the skills/ root so it shares the same
  // filesystem (no cross-device renames).
  let stagingDir: string | null = null;
  if (plan.moves.length > 0) {
    stagingDir = mkdtempSync(join(plan.root, ".flatten-skills-staging-"));
  }

  // Phase 1: source → staging.
  const stagedMoves: { stage: string; final: string; renamed: boolean }[] = [];
  for (const move of plan.moves) {
    if (existsSync(move.to) && !pathIsAncestorOf(move.to, move.from)) {
      // Pre-existing flat skill at the destination that's NOT an ancestor of
      // the source — leave the source in place and warn. Idempotency for
      // already-flattened skills is handled by `planFlatten` returning no
      // moves; this branch only fires on operator-mid-migration messes.
      log(`[flatten] skip (dest exists, unrelated): ${move.to}`);
      continue;
    }
    if (!existsSync(move.from)) {
      log(`[flatten] skip (source missing): ${move.from}`);
      continue;
    }
    const stagePath = join(stagingDir!, `${stagedMoves.length}-${move.to.split("/").pop()}`);
    log(
      `[flatten] mv ${move.from} → ${move.to}${move.renamed ? "  (renamed: collision)" : ""}`,
    );
    renameSync(move.from, stagePath);
    stagedMoves.push({ stage: stagePath, final: move.to, renamed: move.renamed });
  }

  // Phase 2: tear down empty workflow shells (now that all sources are gone).
  for (const workflowPath of plan.emptyWorkflows) {
    const innerSkills = join(workflowPath, "skills");
    try {
      if (existsSync(innerSkills) && listDirs(innerSkills).length === 0) {
        // Inner skills/ may still have stray non-dir entries; only remove if
        // truly empty.
        if (readdirSync(innerSkills).length === 0) {
          rmdirSync(innerSkills);
        }
      }
    } catch (err) {
      log(`[flatten] could not remove inner skills/ at ${innerSkills}: ${String(err)}`);
    }
    try {
      const remaining = existsSync(workflowPath) ? readdirSync(workflowPath) : [];
      if (remaining.length === 0 && existsSync(workflowPath)) {
        rmdirSync(workflowPath);
        log(`[flatten] rmdir ${workflowPath}`);
      } else if (remaining.length > 0) {
        log(`[flatten] keep ${workflowPath} (non-empty after lift: ${remaining.join(", ")})`);
      }
    } catch (err) {
      log(`[flatten] could not remove workflow dir ${workflowPath}: ${String(err)}`);
    }
  }

  // Phase 3: staging → final destination.
  for (const staged of stagedMoves) {
    if (existsSync(staged.final)) {
      // Operator already had something at the final path (rare — partial
      // re-run). Don't clobber. Skill stays in staging for manual recovery.
      log(`[flatten] WARN: dest now occupied, skill left in staging: ${staged.stage} (intended: ${staged.final})`);
      continue;
    }
    renameSync(staged.stage, staged.final);
  }

  // Phase 4: clean up staging dir if empty.
  if (stagingDir && existsSync(stagingDir)) {
    try {
      const left = readdirSync(stagingDir);
      if (left.length === 0) {
        rmdirSync(stagingDir);
      } else {
        log(`[flatten] WARN: staging dir not empty after migration: ${stagingDir} (${left.length} items left)`);
      }
    } catch {
      // ignore
    }
  }

  return plan;
}

/**
 * Returns true when `ancestor` is a path-prefix ancestor of `descendant`.
 * Used to detect the standard "lift skill out of workflow" case where the
 * planned destination is an ancestor of the source.
 */
function pathIsAncestorOf(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;
  return descendant.startsWith(ancestor + "/");
}

/**
 * Plan + apply for a single root. Convenience wrapper.
 */
export function flattenRoot(root: string, opts: FlattenOptions = {}): FlattenPlan {
  const plan = planFlatten(root);
  if (opts.dry) return plan;
  return applyFlattenPlan(plan, opts);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function isMain(): boolean {
  // tsx-compatible main detection.
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const quiet = args.includes("--quiet");
  const roots = args.filter((a) => !a.startsWith("--"));

  if (roots.length === 0) {
    console.error("usage: flatten-skills.ts <root> [<root>...] [--dry] [--quiet]");
    process.exit(2);
  }

  let totalMoves = 0;
  let totalRenames = 0;
  for (const root of roots) {
    const plan = flattenRoot(root, { dry, quiet });
    totalMoves += plan.moves.length;
    totalRenames += plan.moves.filter((m) => m.renamed).length;

    if (!quiet) {
      console.log(
        `[flatten] ${root}: planned=${plan.moves.length} renames=${plan.moves.filter((m) => m.renamed).length} alreadyFlat=${plan.alreadyFlat.length} emptyWorkflows=${plan.emptyWorkflows.length}`,
      );
      if (dry && plan.moves.length > 0) {
        for (const move of plan.moves) {
          console.log(`  [dry] ${move.from} → ${move.to}${move.renamed ? "  (renamed)" : ""}`);
        }
      }
    }
  }

  if (!quiet) {
    console.log(`[flatten] total moves=${totalMoves} renames=${totalRenames}${dry ? " (dry-run)" : ""}`);
  }
}
