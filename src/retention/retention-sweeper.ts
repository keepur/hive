import { readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createLogger } from "../logging/logger.js";
import type { RetentionConfig } from "../config.js";

const log = createLogger("retention");

export interface RetentionCandidate {
  path: string;
  /** Which configured path rule matched (e.g. "agents/*\/scratch"). */
  rule: string;
  /** Effective retention days (after `.retention-days` override, if any). */
  days: number;
  /** mtime of the file/dir. */
  mtime: Date;
  /** Age in days at sweep time. */
  ageDays: number;
}

export interface RetentionReport {
  sweptAt: Date;
  dryRun: boolean;
  candidates: RetentionCandidate[];
  deleted: RetentionCandidate[];
  errors: { path: string; error: string }[];
}

export interface RetentionSweeperDeps {
  /** Hive home to resolve rule paths against. */
  hiveHome: string;
  /** Posts the dry-run/enforcement summary somewhere the operator can see (usually Slack). */
  report: (text: string) => Promise<void> | void;
}

/**
 * Walks configured paths, deletes age-over files (or reports them in dry-run mode),
 * and emits a summary via the injected `report` callback.
 *
 * Design notes (see 2026-04-21-per-agent-cwd-design.md):
 * - `.retention-days` dotfile in any directory overrides the configured rule for that
 *   subtree. Integer only; negative/NaN falls back to rule default with a log warning.
 * - `days: 0` means "keep forever" — per spec §Retention Policy, not "delete everything".
 * - mtime-only for Phase 1. atime-skip is listed under Runtime Failure Mode 3 as a
 *   future hardening; not implemented here because atime is unreliable across filesystems.
 */
export class RetentionSweeper {
  private config: RetentionConfig;
  private deps: RetentionSweeperDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RetentionConfig, deps: RetentionSweeperDeps) {
    this.config = config;
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => log.error("Retention sweep failed", { error: String(err) }));
    }, this.config.intervalMs);
    log.info("Retention sweeper started", {
      intervalMs: this.config.intervalMs,
      enabled: this.config.enabled,
      rules: Object.keys(this.config.paths).length,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Retention sweeper stopped");
  }

  /** Runs one sweep pass. Public so tests and ops triggers can invoke directly. */
  async sweep(): Promise<RetentionReport> {
    const sweptAt = new Date();
    const candidates: RetentionCandidate[] = [];
    const deleted: RetentionCandidate[] = [];
    const errors: { path: string; error: string }[] = [];

    for (const [rule, cfg] of Object.entries(this.config.paths)) {
      if (cfg.days === 0) continue; // keep forever
      for (const root of expandRule(this.deps.hiveHome, rule)) {
        try {
          collectCandidates(root, rule, cfg.days, sweptAt, candidates);
        } catch (err) {
          errors.push({ path: root, error: String(err) });
        }
      }
    }

    if (this.config.enabled) {
      for (const c of candidates) {
        try {
          rmSync(c.path, { recursive: true, force: true });
          deleted.push(c);
        } catch (err) {
          errors.push({ path: c.path, error: String(err) });
        }
      }
    }

    const report: RetentionReport = {
      sweptAt,
      dryRun: !this.config.enabled,
      candidates,
      deleted,
      errors,
    };

    try {
      await this.deps.report(formatReport(report));
    } catch (err) {
      log.warn("Retention report delivery failed", { error: String(err) });
    }

    return report;
  }
}

/**
 * Expand a rule string into concrete absolute roots under hiveHome.
 * Supports exactly one `*` segment (e.g. `agents/*\/scratch` → every agent's scratch).
 * Phase 1 deliberately does not support arbitrary globbing — if you need deeper matching,
 * write a second rule. Keeping the matcher simple keeps the blast radius small.
 */
export function expandRule(hiveHome: string, rule: string): string[] {
  const segments = rule.split("/");
  const starIdx = segments.indexOf("*");
  if (starIdx === -1) {
    const full = resolve(hiveHome, rule);
    return existsSync(full) ? [full] : [];
  }
  if (segments.indexOf("*", starIdx + 1) !== -1) {
    throw new Error(`Retention rules support at most one '*' segment: ${rule}`);
  }
  const prefix = segments.slice(0, starIdx).join(sep);
  const suffix = segments.slice(starIdx + 1).join(sep);
  const parent = resolve(hiveHome, prefix);
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(parent, e.name, suffix))
    .filter((p) => existsSync(p));
}

function collectCandidates(
  root: string,
  rule: string,
  defaultDays: number,
  now: Date,
  out: RetentionCandidate[],
): void {
  const effectiveDays = readRetentionOverride(root) ?? defaultDays;
  if (effectiveDays === 0) return; // override says keep forever
  const cutoff = now.getTime() - effectiveDays * 86400_000;

  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".retention-days") continue;
    const full = join(root, entry.name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs <= cutoff) {
      out.push({
        path: full,
        rule,
        days: effectiveDays,
        mtime: st.mtime,
        ageDays: (now.getTime() - st.mtimeMs) / 86400_000,
      });
    }
  }
}

function readRetentionOverride(dir: string): number | null {
  const path = join(dir, ".retention-days");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    log.warn("Invalid .retention-days override — ignoring", { path, raw });
    return null;
  }
  return n;
}

function formatReport(r: RetentionReport): string {
  const verb = r.dryRun ? "would delete" : "deleted";
  const lines = [
    `*Retention sweep* (${r.dryRun ? "dry-run" : "enforced"}) @ ${r.sweptAt.toISOString()}`,
    `${r.candidates.length} candidates · ${verb} ${r.dryRun ? r.candidates.length : r.deleted.length} · ${r.errors.length} errors`,
  ];
  const sample = r.candidates.slice(0, 10);
  if (sample.length) {
    lines.push("```");
    for (const c of sample) {
      lines.push(`${c.path}  (age ${c.ageDays.toFixed(1)}d, rule ${c.rule}@${c.days}d)`);
    }
    if (r.candidates.length > sample.length) {
      lines.push(`… and ${r.candidates.length - sample.length} more`);
    }
    lines.push("```");
  }
  if (r.errors.length) {
    lines.push(
      `Errors: ${r.errors
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.error}`)
        .join(" | ")}`,
    );
  }
  return lines.join("\n");
}
