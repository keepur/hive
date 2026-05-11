import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CheckGroup = "prereq" | "config" | "agents" | "services";

export interface Check {
  name: string;
  group: CheckGroup;
  required: boolean;
  test: () => boolean | Promise<boolean>;
  remedy?: string;
}

// ── helpers ─────────────────────────────────────────────────────────────

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function brewServiceRunning(name: string): boolean {
  try {
    const out = execFileSync("brew", ["services", "list"], { encoding: "utf-8" });
    return out.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch {
    return false;
  }
}

export async function httpProbe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ── required-env derivation from config.ts source ──────────────────────

/**
 * Scan src/config.ts source for `required("KEY")` call sites so the doctor's
 * env check mirrors the config loader exactly. Spec #157: do not hardcode —
 * `ANTHROPIC_API_KEY`, `MONGODB_URI`, `BG_TASK_AUTH_TOKEN` are optional-with-
 * fallback and must not false-positive.
 */
export function requiredEnvVarsFromConfig(configTsPath: string): string[] {
  const src = readFileSync(configTsPath, "utf-8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/\brequired\(\s*"([A-Z0-9_]+)"\s*\)/g)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

// ── launchctl print parsing ─────────────────────────────────────────────

export interface LaunchdState {
  loaded: boolean;
  state: "running" | "not running" | "unknown";
  pid: number | null;
}

export function launchctlPrint(label: string): LaunchdState {
  const uid = process.getuid?.();
  if (uid === undefined) return { loaded: false, state: "unknown", pid: null };
  try {
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stateMatch = out.match(/state\s*=\s*([^\n]+?)\s*$/m);
    const pidMatch = out.match(/pid\s*=\s*(\d+)/);
    const raw = stateMatch?.[1];
    const state = raw === "running" ? "running" : raw === "not running" ? "not running" : "unknown";
    return {
      loaded: true,
      state,
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
    };
  } catch {
    return { loaded: false, state: "unknown", pid: null };
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── live checks ────────────────────────────────────────────────────────

export async function mongoReachable(uri: string, dbName: string, timeoutMs = 2000): Promise<boolean> {
  // Dynamic import so unit tests can mock without pulling the driver at module load.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function hasAnyAgent(uri: string, dbName: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const count = await client.db(dbName).collection("agent_definitions").estimatedDocumentCount();
    return count > 0;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function defaultAgentExists(uri: string, dbName: string, defaultAgent: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const doc = await client.db(dbName).collection("agent_definitions").findOne({ id: defaultAgent });
    return doc !== null;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function slackAuthOk(botToken: string): Promise<boolean> {
  if (!botToken) return false;
  const { WebClient } = await import("@slack/web-api");
  try {
    const res = await new WebClient(botToken).auth.test();
    return res.ok === true;
  } catch {
    return false;
  }
}

// ── prompt cache observability (KPR-140) ───────────────────────────────

export interface PromptCacheRow {
  agentId: string;
  turns: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  ephemeral5mTokens: number;
  ephemeral1hTokens: number;
  hitRate: number | null;
}

/**
 * Read-only doctor adapter for the agent_turn_telemetry collection. Uses a
 * short-lived MongoClient like the other live checks in this file —
 * `hive doctor` is a one-shot CLI, not the running engine. Mirrors the
 * aggregator pipeline in `TurnTelemetryStore.hitRatesByAgent` rather than
 * routing through the runtime store (which holds its own `Db` ref) — keeps
 * the layering of `doctor-checks.ts` consistent with `mongoReachable` etc.
 */
export async function cacheHitRatesForDoctor(
  uri: string,
  dbName: string,
  windowMs = 7 * 24 * 60 * 60 * 1000,
): Promise<PromptCacheRow[]> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const since = new Date(Date.now() - windowMs);
    const cursor = client
      .db(dbName)
      .collection("agent_turn_telemetry")
      .aggregate<{
        _id: string;
        turns: number;
        inputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        ephemeral5mTokens: number;
        ephemeral1hTokens: number;
      }>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$agentId",
            turns: { $sum: 1 },
            inputTokens: { $sum: "$inputTokens" },
            cacheReadTokens: { $sum: "$cacheReadTokens" },
            cacheCreationTokens: { $sum: "$cacheCreationTokens" },
            ephemeral5mTokens: { $sum: { $ifNull: ["$ephemeral5mTokens", 0] } },
            ephemeral1hTokens: { $sum: { $ifNull: ["$ephemeral1hTokens", 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);
    const rows: PromptCacheRow[] = [];
    for await (const r of cursor) {
      const denom = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
      rows.push({
        agentId: r._id,
        turns: r.turns,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        inputTokens: r.inputTokens,
        ephemeral5mTokens: r.ephemeral5mTokens,
        ephemeral1hTokens: r.ephemeral1hTokens,
        hitRate: denom > 0 ? r.cacheReadTokens / denom : null,
      });
    }
    return rows;
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}

/** Format a hit-rate value for display. Mirrors the "no data" branch in the aggregator. */
export function formatHitRate(rate: number | null): string {
  if (rate === null) return "no data";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * KPR-213 prefix-cache stats snapshot. Engine heartbeats this once every 30s
 * to `db.telemetry` (kind="prefix_cache_stats"); doctor reads it. `staleSeconds`
 * is computed at read time so the operator can tell live-vs-stale at a glance.
 */
export interface PrefixCacheStatsRow {
  hits: number;
  misses: number;
  entryCount: number;
  lastBuildP99Ms: number;
  oldestEntryAgeMs: number;
  /** Seconds since the engine last wrote this doc; null if no doc found yet. */
  staleSeconds: number | null;
}

/**
 * Read-only doctor adapter for the `telemetry` collection's
 * prefix_cache_stats heartbeat doc. Short-lived MongoClient mirrors the
 * `cacheHitRatesForDoctor` pattern.
 */
export async function prefixCacheStatsForDoctor(uri: string, dbName: string): Promise<PrefixCacheStatsRow | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const doc = await client.db(dbName).collection("telemetry").findOne<{
      hits?: number;
      misses?: number;
      entryCount?: number;
      lastBuildP99Ms?: number;
      oldestEntryAgeMs?: number;
      updatedAt?: Date;
    }>({ kind: "prefix_cache_stats" });
    if (!doc) return null;
    const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : null;
    return {
      hits: doc.hits ?? 0,
      misses: doc.misses ?? 0,
      entryCount: doc.entryCount ?? 0,
      lastBuildP99Ms: doc.lastBuildP99Ms ?? 0,
      oldestEntryAgeMs: doc.oldestEntryAgeMs ?? 0,
      staleSeconds: updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 1000) : null,
    };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * KPR-220 Phase 11 / spec S6+S8: per-agent spawn-coordinator snapshot row,
 * read from the `telemetry` collection where the engine heartbeats it every
 * 30s under `kind: "spawn_coordinator_stats"`.
 */
export interface SpawnCoordinatorRow {
  agentId: string;
  activeSpawns: number;
  budget: number;
  budgetSource: "spawnBudget" | "maxConcurrent" | "default";
  saturationCount: number;
  lastSaturationAt: number | null;
  lastSpawnAt: number | null;
  lastError: string | null;
  stopped: boolean;
  /** Seconds since the engine last wrote this doc; null if no doc found yet. */
  staleSeconds: number | null;
}

/**
 * Read-only doctor adapter for the per-agent
 * `kind="spawn_coordinator_stats"` heartbeat docs (KPR-220 Phase 11).
 * Mirrors `prefixCacheStatsForDoctor` — short-lived MongoClient + per-agent
 * documents. Returns an empty array if no docs exist yet.
 */
export async function spawnCoordinatorStatsForDoctor(
  uri: string,
  dbName: string,
): Promise<SpawnCoordinatorRow[]> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const docs = await client
      .db(dbName)
      .collection("telemetry")
      .find<{
        agentId?: string;
        activeSpawns?: number;
        budget?: number;
        budgetSource?: "spawnBudget" | "maxConcurrent" | "default";
        saturationCount?: number;
        lastSaturationAt?: number | null;
        lastSpawnAt?: number | null;
        lastError?: string | null;
        stopped?: boolean;
        updatedAt?: Date;
      }>({ kind: "spawn_coordinator_stats" })
      .toArray();
    return docs
      .filter((d) => typeof d.agentId === "string")
      .map((d) => {
        const updatedAt = d.updatedAt instanceof Date ? d.updatedAt : null;
        return {
          agentId: d.agentId as string,
          activeSpawns: d.activeSpawns ?? 0,
          budget: d.budget ?? 0,
          budgetSource: d.budgetSource ?? "default",
          saturationCount: d.saturationCount ?? 0,
          lastSaturationAt: d.lastSaturationAt ?? null,
          lastSpawnAt: d.lastSpawnAt ?? null,
          lastError: d.lastError ?? null,
          stopped: d.stopped ?? false,
          staleSeconds: updatedAt
            ? Math.round((Date.now() - updatedAt.getTime()) / 1000)
            : null,
        };
      })
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}

// ── resolved paths ─────────────────────────────────────────────────────

/** Expand ~ in a path. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, process.env.HOME ?? "");
}

/** Resolve the service path that the LaunchAgent actually points at by reading
 *  the plist WorkingDirectory. Returns null if the plist cannot be read. */
export function resolveServicePath(label = "com.hive.agent"): string | null {
  const plist = expandHome(`~/Library/LaunchAgents/${label}.plist`);
  if (!existsSync(plist)) return null;
  const raw = readFileSync(plist, "utf-8");
  const m = raw.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? resolve(expandHome(m[1])) : null;
}
