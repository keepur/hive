#!/usr/bin/env npx tsx
/**
 * KPR-323 C6 / spec §3: blessed read-only first-audio baseline harvester.
 *
 * Reads the instance's engine log files (JSON lines), filters successful
 * "Voice turn complete" rows for one agent within a ≤30-day window, splits
 * by sdkSessionResumeAttempted, and emits the aggregate-only artifact JSON
 * (spec §3.3). Zero behavior change to the engine; no traffic generated;
 * no message content or phone numbers read or written — only numeric
 * latency fields, counts, and ISO timestamps.
 *
 * D3: although read-only, a run against production logs requires a
 * recorded per-run operator go (spec §3.4 step 1).
 *
 * Usage:
 *   npx tsx scripts/voice-latency-baseline.ts \
 *     --log-dir ~/services/hive/<instance>/logs \
 *     --agent <agentId> \
 *     [--to <ISO8601>] [--days 30 | --from <ISO8601>] \
 *     [--git-sha <engine sha>] [--engine-version <x.y.z>] \
 *     --out docs/epics/kpr-320/baselines/voice-baseline-<YYYY-MM-DD>.json
 *
 * The artifact is emitted with `blessing` EMPTY; the operator reviews the
 * numbers + sample sizes, blesses in Linear (date + words), the blessing is
 * stamped, and the file is committed — immutable thereafter (spec §3.4).
 */
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface VoiceTurnSample {
  tsMs: number;
  firstTokenMs: number | undefined;
  /**
   * `undefined` for a malformed row missing the field (review round 4,
   * issue 9): mapping it to 0 injected a bogus zero into the totalMs
   * percentile distribution. Same treatment as `firstTokenMs`.
   */
  totalMs: number | undefined;
  resumed: boolean;
}

/**
 * Parse one log line. Returns a sample for matching "Voice turn complete"
 * rows (streaming mode, given agent), null otherwise. Tolerates non-JSON
 * lines (multi-writer logs). Success-only by construction: the engine emits
 * this line only on successful turns — see the "Voice turn complete" log
 * site at the end of `spawnTurnViaAgentManager` in voice-adapter.ts.
 */
export function parseVoiceTurnLine(line: string, agentId: string): VoiceTurnSample | null {
  if (!line.includes("Voice turn complete")) return null; // cheap pre-filter
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.msg !== "Voice turn complete" || entry.component !== "voice-adapter") return null;
  if (entry.agentId !== agentId) return null;
  if (entry.mode !== "streaming") return null;
  const tsMs = Date.parse(String(entry.ts ?? ""));
  if (!Number.isFinite(tsMs)) return null;
  return {
    tsMs,
    firstTokenMs: typeof entry.firstTokenMs === "number" ? entry.firstTokenMs : undefined,
    totalMs: typeof entry.totalMs === "number" ? entry.totalMs : undefined,
    resumed: entry.sdkSessionResumeAttempted === true,
  };
}

/** Nearest-rank percentile over an ascending-sorted array (spec §3.1). */
export function nearestRank(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscending.length));
  return sortedAscending[rank - 1]!;
}

interface PercentilePair {
  p50: number;
  p95: number;
}

export interface BaselineArtifact {
  kind: "voice_latency_baseline";
  version: 1;
  capturedAt: string;
  engineVersion: string;
  gitSha: string;
  source: "vapi-production-logs";
  window: { from: string; to: string };
  agentId: string;
  mode: "streaming";
  samples: { resumed: number; nonResumed: number; excludedMissingFirstToken: number };
  metrics: {
    resumed: { firstTokenMs: PercentilePair; totalMs: PercentilePair };
    nonResumed: { firstTokenMs: PercentilePair; totalMs: PercentilePair };
  };
  blessing: { blessedBy: string; blessedAt: string; linearRef: string };
  notes: string;
}

export function buildArtifact(
  windowSamples: VoiceTurnSample[],
  opts: { capturedAt: string; engineVersion: string; gitSha: string; agentId: string; from: string; to: string },
): { artifact: BaselineArtifact; shortfall: string | null } {
  // Spec §3.2: rows without firstTokenMs (degenerate zero-chunk streaming
  // turns — the adapter emits headers + [DONE] only) are excluded from ALL
  // metrics and counted.
  const excludedMissingFirstToken = windowSamples.filter((s) => s.firstTokenMs === undefined).length;
  const usable = windowSamples.filter((s) => s.firstTokenMs !== undefined);
  const resumed = usable.filter((s) => s.resumed);
  const nonResumed = usable.filter((s) => !s.resumed);

  const pair = (xs: number[]): PercentilePair => {
    const sorted = [...xs].sort((a, b) => a - b);
    return { p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95) };
  };
  const bucket = (xs: VoiceTurnSample[]) => ({
    firstTokenMs: pair(xs.map((s) => s.firstTokenMs!)),
    // A row missing `totalMs` (malformed — the engine always emits it) is
    // dropped from THIS bucket only; its firstTokenMs is still a valid
    // sample (review round 4, issue 9).
    totalMs: pair(xs.map((s) => s.totalMs).filter((v): v is number => v !== undefined)),
  });

  const shortfallParts: string[] = [];
  if (resumed.length < 50) shortfallParts.push(`resumed=${resumed.length}<50`);
  if (nonResumed.length < 20) shortfallParts.push(`nonResumed=${nonResumed.length}<20`);
  const shortfall =
    shortfallParts.length > 0
      ? `SAMPLE SHORTFALL: ${shortfallParts.join(", ")} — operator decides: bless small-n (recorded) or wait for traffic (spec §3.2)`
      : null;

  return {
    artifact: {
      kind: "voice_latency_baseline",
      version: 1,
      capturedAt: opts.capturedAt,
      engineVersion: opts.engineVersion,
      gitSha: opts.gitSha,
      source: "vapi-production-logs",
      window: { from: opts.from, to: opts.to },
      agentId: opts.agentId,
      mode: "streaming",
      samples: {
        resumed: resumed.length,
        nonResumed: nonResumed.length,
        excludedMissingFirstToken,
      },
      metrics: { resumed: bucket(resumed), nonResumed: bucket(nonResumed) },
      blessing: { blessedBy: "", blessedAt: "", linearRef: "" },
      notes: shortfall ?? "",
    },
    shortfall,
  };
}

export type WindowResolution =
  | { ok: true; from: Date; to: Date }
  | { ok: false; error: string };

/**
 * Resolve + VALIDATE the harvest window from the CLI args (review round 1,
 * issue 5). Unvalidated args used to fail silently and late: `--days abc`
 * made `from` an Invalid Date, the ≤30-day guard's comparison was `false`
 * for NaN operands so it passed, zero samples matched the NaN-bounded
 * window, and the run finally died on `from.toISOString()` with a bare
 * RangeError. Every malformed input now produces a usage error instead.
 * Pure + exported so the failure modes are unit-testable.
 */
export function resolveWindow(
  args: { from?: string; to?: string; days?: string },
  now: Date = new Date(),
): WindowResolution {
  const to = args.to !== undefined ? new Date(args.to) : now;
  if (Number.isNaN(to.getTime())) {
    return { ok: false, error: `--to is not a valid ISO 8601 timestamp: ${args.to}` };
  }

  let days = 30;
  if (args.days !== undefined) {
    const parsed = parseInt(args.days, 10);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: `--days is not a number: ${args.days}` };
    }
    if (parsed < 1) {
      return { ok: false, error: `--days must be at least 1: ${args.days}` };
    }
    days = parsed;
  }

  const from = args.from !== undefined ? new Date(args.from) : new Date(to.getTime() - days * 86_400_000);
  if (Number.isNaN(from.getTime())) {
    return { ok: false, error: `--from is not a valid ISO 8601 timestamp: ${args.from}` };
  }
  if (from.getTime() > to.getTime()) {
    return { ok: false, error: "--from must not be after --to" };
  }
  if (to.getTime() - from.getTime() > 30 * 86_400_000) {
    return { ok: false, error: "window exceeds the spec §3.2 maximum of 30 days" };
  }
  return { ok: true, from, to };
}

export type LogDirResolution = { ok: true; names: string[] } | { ok: false; error: string };

/**
 * List the regular files in the log dir, or report a usage error (review
 * round 4, issue 9). A mistyped `--log-dir` used to surface as a raw ENOENT
 * stack out of `readdirSync`; every other malformed-input path exits 1 with
 * a clean line. Pure + exported for the same reason as `resolveWindow`.
 */
export function resolveLogFiles(logDir: string): LogDirResolution {
  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch (err) {
    return { ok: false, error: `log-dir not found or unreadable: ${logDir} (${String(err)})` };
  }
  const names = entries.filter((n) => {
    try {
      return statSync(join(logDir, n)).isFile();
    } catch {
      return false;
    }
  });
  return { ok: true, names };
}

async function harvestDir(
  logDir: string,
  names: string[],
  agentId: string,
  fromMs: number,
  toMs: number,
): Promise<VoiceTurnSample[]> {
  const samples: VoiceTurnSample[] = [];
  for (const name of names) {
    const rl = createInterface({ input: createReadStream(join(logDir, name)), crlfDelay: Infinity });
    for await (const line of rl) {
      const s = parseVoiceTurnLine(line, agentId);
      if (s && s.tsMs >= fromMs && s.tsMs <= toMs) samples.push(s);
    }
  }
  return samples;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "log-dir": { type: "string" },
      agent: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      days: { type: "string" },
      "git-sha": { type: "string" },
      "engine-version": { type: "string" },
      out: { type: "string" },
    },
  });
  const logDir = values["log-dir"];
  const agent = values.agent;
  const out = values.out;
  if (!logDir || !agent || !out) {
    process.stderr.write("required: --log-dir <dir> --agent <agentId> --out <file>\n");
    process.exit(1);
  }
  const window = resolveWindow({ from: values.from, to: values.to, days: values.days });
  if (!window.ok) {
    process.stderr.write(window.error + "\n");
    process.exit(1);
  }
  const { from, to } = window;

  // Provenance (review round 4, issue 1): the artifact is immutable once
  // blessed (spec §3.4) and 322 P2 binds to it, so both provenance fields
  // must describe the ENGINE, never the harvesting shell's cwd. Defaults
  // resolve against this script's own location; `--engine-version` /
  // `--git-sha` override when the harvested logs came from a different
  // engine build than the checkout running the harvest.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const engineVersion =
    values["engine-version"] ??
    (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }).version;
  let gitSha = values["git-sha"] ?? "";
  if (!gitSha) {
    try {
      // cwd = the engine repo (via scriptDir), not process.cwd(); stderr
      // suppressed so a "fatal: not a git repository" line can never
      // interleave with the load-bearing SAMPLE SHORTFALL message.
      gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf-8",
        cwd: scriptDir,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      gitSha = "unknown";
    }
  }

  const logFiles = resolveLogFiles(logDir);
  if (!logFiles.ok) {
    process.stderr.write(logFiles.error + "\n");
    process.exit(1);
  }
  const samples = await harvestDir(logDir, logFiles.names, agent, from.getTime(), to.getTime());
  const { artifact, shortfall } = buildArtifact(samples, {
    capturedAt: new Date().toISOString(),
    engineVersion,
    gitSha,
    agentId: agent,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
  // Summary is aggregate-only — mirrors the artifact, nothing more.
  process.stdout.write(
    JSON.stringify({ out, samples: artifact.samples, metrics: artifact.metrics }, null, 2) + "\n",
  );
  if (shortfall) process.stderr.write(shortfall + "\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

// Main-guard (mirrors scripts/flatten-skills.ts) so the vitest import of the
// pure functions never runs the harvest. The esbuild shim-guard hazard does
// not apply: scripts/ is not bundled.
function isMain(): boolean {
  // tsx-compatible main detection.
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  await main();
}
