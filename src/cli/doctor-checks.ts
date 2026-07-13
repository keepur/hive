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

/**
 * KPR-312: one informational line for `hive doctor` — which mode the model
 * router's complexity classifier runs in. Key-less (subscription-auth)
 * instances run heuristics-only: a deliberate steady state, never a failing
 * check (spec #157: ANTHROPIC_API_KEY is optional-with-fallback and must not
 * false-positive). Pure string producer — no failure channel by construction.
 */
export function modelRouterModeLine(apiKeyPresent: boolean): string {
  return apiKeyPresent ? "model router: LLM classification" : "model router: heuristics-only (no ANTHROPIC_API_KEY)";
}

/**
 * KPR-314: one informational line for `hive doctor` — sidecar LLM provider
 * presence and what degrades without each key. Key-less is a deliberate
 * steady state (subscription-auth instances), never a failing check —
 * pure string producer, no failure channel by construction (312 precedent).
 */
export function llmSidecarLine(anthropicPresent: boolean, geminiPresent: boolean): string {
  const anthropic = anthropicPresent
    ? "anthropic ✓"
    : "anthropic ✗ (meeting classifier → all-roster, memory dream → skipped)";
  const gemini = geminiPresent ? "gemini ✓" : "gemini ✗ (image description → off)";
  return `llm sidecar: ${anthropic}, ${gemini}`;
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

/** True when at least one agent has `isDefault: true`.
 *
 * KPR-229: replaces the prior per-id check (which required setting
 * `DEFAULT_AGENT` per-instance, otherwise fell back to the literal
 * "chief-of-staff" — failing as `✗` on every non-default instance like
 * keepur/hermi or dodi/mokie). The `isDefault` flag is the
 * agent-definition mechanism for "this is the instance's default
 * agent"; checking it directly removes the per-instance config
 * dependency. The prior query also had a latent field-name bug
 * (looked up by `{ id: ... }` while the docs use `_id`), which this
 * fix obviates entirely.
 */
export async function defaultAgentExists(uri: string, dbName: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const doc = await client.db(dbName).collection("agent_definitions").findOne({ isDefault: true });
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
export async function spawnCoordinatorStatsForDoctor(uri: string, dbName: string): Promise<SpawnCoordinatorRow[]> {
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
          staleSeconds: updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 1000) : null,
        };
      })
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * KPR-306: per-provider circuit-breaker snapshot row from `telemetry`
 * (kind=circuit_breaker_stats heartbeat). Informational only — D4.
 */
export interface CircuitBreakerRow {
  provider: string;
  state: "closed" | "open" | "half-open";
  enabled: boolean;
  reason: string | null;
  consecutiveHardFaults: number;
  tripCount: number;
  lastTripAt: number | null;
  fastFailCount: number;
  lastFaultMessage: string | null;
  p95Ms: number | null;
  sampleCount: number;
  probeInFlight: boolean;
  openedAt: number | null;
  nextProbeEligibleAt: number | null;
  /** Seconds since the engine last wrote this doc; null if no doc found yet. */
  staleSeconds: number | null;
}

/**
 * Read-only doctor adapter for `kind="circuit_breaker_stats"` heartbeat docs.
 * Mirrors `spawnCoordinatorStatsForDoctor` — short-lived MongoClient,
 * defaults for missing fields, empty array on error, sorted by provider.
 */
export async function circuitBreakerStatsForDoctor(uri: string, dbName: string): Promise<CircuitBreakerRow[]> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const docs = await client
      .db(dbName)
      .collection("telemetry")
      .find<{
        provider?: string;
        state?: "closed" | "open" | "half-open";
        enabled?: boolean;
        reason?: string | null;
        consecutiveHardFaults?: number;
        tripCount?: number;
        lastTripAt?: number | null;
        fastFailCount?: number;
        lastFaultMessage?: string | null;
        p95Ms?: number | null;
        sampleCount?: number;
        probeInFlight?: boolean;
        openedAt?: number | null;
        nextProbeEligibleAt?: number | null;
        updatedAt?: Date;
      }>({ kind: "circuit_breaker_stats" })
      .toArray();
    return docs
      .filter((d) => typeof d.provider === "string")
      .map((d) => {
        const updatedAt = d.updatedAt instanceof Date ? d.updatedAt : null;
        return {
          provider: d.provider as string,
          state: d.state ?? "closed",
          enabled: d.enabled ?? true,
          reason: d.reason ?? null,
          consecutiveHardFaults: d.consecutiveHardFaults ?? 0,
          tripCount: d.tripCount ?? 0,
          lastTripAt: d.lastTripAt ?? null,
          fastFailCount: d.fastFailCount ?? 0,
          lastFaultMessage: d.lastFaultMessage ?? null,
          p95Ms: d.p95Ms ?? null,
          sampleCount: d.sampleCount ?? 0,
          probeInFlight: d.probeInFlight ?? false,
          openedAt: d.openedAt ?? null,
          nextProbeEligibleAt: d.nextProbeEligibleAt ?? null,
          staleSeconds: updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 1000) : null,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * KPR-307: outage-queue snapshot. Direct collection read — the queue is
 * durable, so unlike the breaker no heartbeat proxy is needed. Returns null
 * when Mongo is unreachable.
 */
export interface OutageQueueStats {
  pending: number;
  replaying: number;
  oldestPendingAgeSeconds: number | null;
  expired24h: number;
  failed24h: number;
}

export async function outageQueueStatsForDoctor(uri: string, dbName: string): Promise<OutageQueueStats | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const collection = client.db(dbName).collection("outage_queue");
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [pending, replaying, expired24h, failed24h, oldest] = await Promise.all([
      collection.countDocuments({ status: "pending" }),
      collection.countDocuments({ status: "replaying" }),
      collection.countDocuments({ status: "expired", doneAt: { $gte: dayAgo } }),
      collection.countDocuments({ status: "failed", doneAt: { $gte: dayAgo } }),
      collection.find<{ enqueuedAt?: Date }>({ status: "pending" }).sort({ enqueuedAt: 1 }).limit(1).toArray(),
    ]);
    const oldestDoc = oldest[0];
    const oldestPendingAgeSeconds =
      oldestDoc?.enqueuedAt instanceof Date ? Math.round((Date.now() - oldestDoc.enqueuedAt.getTime()) / 1000) : null;
    return { pending, replaying, oldestPendingAgeSeconds, expired24h, failed24h };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * KPR-241: per-agent memory lifecycle snapshot row from `telemetry`
 * (kind=memory_lifecycle_stats heartbeat).
 *
 * Note: `cursor.lastId` is read as the BSON ObjectId's `.toString()` form
 * (24-char hex) because the doctor runs out-of-process from the engine and
 * surfaces the value to humans. Mongo's driver round-trips it as either an
 * ObjectId or a string depending on serialization path — we accept either
 * shape on read and normalize to string.
 */
export interface MemoryLifecycleRow {
  agentId: string;
  counts: { hot: number; warm: number; cold: number };
  summarizedNotPurged: number;
  needsReview: number;
  oldestColdAgeDays: number | null;
  consolidation: {
    phase: string;
    topic: string | null;
    cursor: { createdAt: Date; lastId: string } | null;
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
    lastRunSpentUsd: number | null;
    cumulativeSpentUsd30d: number;
  };
  /** Seconds since the engine last wrote this doc; null if no doc found. */
  staleSeconds: number | null;
}

/**
 * Read-only doctor adapter for the per-agent
 * `kind="memory_lifecycle_stats"` heartbeat docs. Mirrors
 * `spawnCoordinatorStatsForDoctor`.
 */
export async function memoryLifecycleStatsForDoctor(uri: string, dbName: string): Promise<MemoryLifecycleRow[]> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const docs = await client
      .db(dbName)
      .collection("telemetry")
      .find<{
        agentId?: string;
        counts?: { hot: number; warm: number; cold: number };
        summarizedNotPurged?: number;
        needsReview?: number;
        oldestColdAgeDays?: number | null;
        consolidation?: MemoryLifecycleRow["consolidation"];
        updatedAt?: Date;
      }>({ kind: "memory_lifecycle_stats" })
      .sort({ agentId: 1 })
      .toArray();
    const now = Date.now();
    return docs.map((doc) => {
      const cons = doc.consolidation;
      const cursor = cons?.cursor
        ? {
            createdAt:
              cons.cursor.createdAt instanceof Date
                ? cons.cursor.createdAt
                : new Date(cons.cursor.createdAt as unknown as string),
            // BSON ObjectId or string — normalize to string for the doctor surface.
            lastId: String((cons.cursor as { lastId: unknown }).lastId ?? ""),
          }
        : null;
      return {
        agentId: doc.agentId ?? "<unknown>",
        counts: doc.counts ?? { hot: 0, warm: 0, cold: 0 },
        summarizedNotPurged: doc.summarizedNotPurged ?? 0,
        needsReview: doc.needsReview ?? 0,
        oldestColdAgeDays: doc.oldestColdAgeDays ?? null,
        consolidation: cons
          ? { ...cons, cursor }
          : {
              phase: "idle",
              topic: null,
              cursor: null,
              lastAttemptAt: null,
              lastSuccessAt: null,
              lastError: null,
              lastRunSpentUsd: null,
              cumulativeSpentUsd30d: 0,
            },
        staleSeconds: doc.updatedAt instanceof Date ? Math.round((now - doc.updatedAt.getTime()) / 1000) : null,
      };
    });
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}

// ── datastore identity (KPR-296) ────────────────────────────────────────

/**
 * Sentinel Contract identifiers (KPR-294 R2) and telemetry kinds, duplicated
 * as literals: `src/db/identity-sentinel.ts` statically imports the mongodb
 * driver + engine logger, and this module's convention is to never pull the
 * driver at module load (unit tests mock nothing). Drift against the
 * producer's exported constants is pinned by a test in doctor-checks.test.ts.
 */
export const DOCTOR_SENTINEL_COLLECTION = "instance_identity";
export const DOCTOR_SENTINEL_ID = "identity_sentinel";
export const DOCTOR_SENTINEL_SCHEMA_VERSION = 1;
export const DOCTOR_DB_IDENTITY_STATS_KIND = "db_identity_stats";
export const DOCTOR_ROSTER_STATS_KIND = "agent_roster_stats";

/** KPR-296 spec §Report shape — verbatim. */
export interface DatastoreIdentityReport {
  // Connection target (from config; credentials redacted before display)
  uri: string; // userinfo stripped: mongodb://<credentials>@host
  dbName: string;
  instanceId: string;

  // Server fingerprint — each null when the command failed; note carries why
  server: {
    host: string | null; // serverStatus.host (self-reported host:port)
    version: string | null; // serverStatus.version
    pid: number | null; // serverStatus.pid
    uptimeSeconds: number | null;
    dbPath: string | null; // getCmdLineOpts.parsed.storage.dbPath
    note: string | null; // e.g. "serverStatus unauthorized — expected under authed Mongo (KPR-297)"
  };

  // Doctor's own sentinel read (Sentinel Contract, KPR-294 R2)
  sentinel:
    | {
        state: "verified";
        observed: { instanceId: string; dbName: string; sentinelId: string | null };
        schemaVersionNewer: boolean;
        stampedAt: Date | null; // advisory display only, never verified (R2)
        stampedBy: string | null;
      }
    | {
        state: "mismatch";
        observed: { instanceId: string; dbName: string; sentinelId: string | null };
        schemaVersionNewer: boolean;
      }
    | { state: "absent" }
    | { state: "error"; message: string };

  // Live count — exact countDocuments({}), not estimated (it is a compare-target)
  agentDefinitionsCount: number | null;

  // Engine's identity monitor view (db_identity_stats — heartbeat kind)
  identityStats: {
    state: "verified" | "mismatch" | "cant_verify" | string; // tolerate unknown future states as non-verified
    writesRefused: boolean;
    refusedWriteCount: number;
    lastVerifiedAt: Date | null;
    lastMismatchAt: Date | null;
    observedInstanceId: string | null;
    observedDbName: string | null;
    staleSeconds: number | null; // from updatedAt — heartbeat cadence, staleness IS meaningful here
  } | null; // null = no doc yet (engine never booted post-KPR-294)

  // Roster guard view (agent_roster_stats — EVENT-DRIVEN kind)
  rosterStats: {
    docCount: number | null;
    activeCount: number | null;
    disabledCount: number | null;
    lastGoodAt: Date | null;
    lastGoodSource: "boot" | "reload" | null;
    degraded: boolean;
    degradedSince: Date | null;
    blockedReloadCount: number;
    lastBlockedAt: Date | null;
    updatedAt: Date | null; // displayed as a timestamp only — NEVER a staleness warning (canon E3)
  } | null; // null = no doc yet (engine never booted post-KPR-295)
}

/** Strip userinfo from a Mongo URI for display (log-redaction convention, CLAUDE.md Security). */
export function redactMongoUri(uri: string): string {
  // Userinfo cannot contain an unencoded `/`, so `[^@/]+@` never crosses
  // into the host/path and a credential-less URI passes through unchanged.
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]+@/, "$1<credentials>@");
}

/** Temp-directory roots — a dbPath under any of these is the Jul-4 impostor signature (spec W3). */
const TEMP_DB_PATH_ROOTS = ["/tmp", "/private/tmp", "/var/folders"];

export function isTempDbPath(dbPath: string): boolean {
  return TEMP_DB_PATH_ROOTS.some((root) => dbPath === root || dbPath.startsWith(`${root}/`));
}

/** Compact uptime for the fingerprint line: 266520 → "3d2h", 3700 → "1h1m", 90 → "1m". */
export function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** Loose read shapes — the doctor reads defensively; it never assumes the producer's TS types (E2). */
interface SentinelDocLike {
  instanceId?: unknown;
  dbName?: unknown;
  sentinelId?: unknown;
  schemaVersion?: unknown;
  stampedAt?: unknown;
  stampedBy?: unknown;
}

/**
 * Pure sentinel-doc → report mapping. Match = `instanceId` AND `dbName`
 * equality ONLY (Sentinel Contract, R2) — never `sentinelId`, `stampedAt`,
 * `stampedBy`, or wall clock. `schemaVersion > 1` is tolerated (W2 warn at
 * render time; frozen fields still trusted). The `error` variant is
 * assigned by the adapter's catch, not here.
 */
export function mapSentinelDoc(
  doc: SentinelDocLike | null,
  expected: { instanceId: string; dbName: string },
): DatastoreIdentityReport["sentinel"] {
  if (!doc) return { state: "absent" };
  const observed = {
    instanceId: typeof doc.instanceId === "string" ? doc.instanceId : "<invalid>",
    dbName: typeof doc.dbName === "string" ? doc.dbName : "<invalid>",
    sentinelId: typeof doc.sentinelId === "string" ? doc.sentinelId : null,
  };
  const schemaVersionNewer =
    typeof doc.schemaVersion === "number" && doc.schemaVersion > DOCTOR_SENTINEL_SCHEMA_VERSION;
  if (observed.instanceId === expected.instanceId && observed.dbName === expected.dbName) {
    const stampedBy = doc.stampedBy as { engineVersion?: unknown; hostname?: unknown } | null | undefined;
    return {
      state: "verified",
      observed,
      schemaVersionNewer,
      stampedAt: doc.stampedAt instanceof Date ? doc.stampedAt : null,
      stampedBy:
        stampedBy && (typeof stampedBy.engineVersion === "string" || typeof stampedBy.hostname === "string")
          ? `${String(stampedBy.engineVersion ?? "?")}@${String(stampedBy.hostname ?? "?")}`
          : null,
    };
  }
  return { state: "mismatch", observed, schemaVersionNewer };
}

interface IdentityStatsDocLike {
  state?: unknown;
  writesRefused?: unknown;
  refusedWriteCount?: unknown;
  lastVerifiedAt?: unknown;
  lastMismatchAt?: unknown;
  observedInstanceId?: unknown;
  observedDbName?: unknown;
  updatedAt?: unknown;
}

/** Pure db_identity_stats-doc → report mapping. Unknown/missing `state` maps to "unknown" — the renderer treats any non-"verified" as F3 when fresh (fail-closed, spec edge #12). */
export function mapIdentityStatsDoc(
  doc: IdentityStatsDocLike | null,
  now = Date.now(),
): DatastoreIdentityReport["identityStats"] {
  if (!doc) return null;
  const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : null;
  return {
    state: typeof doc.state === "string" ? doc.state : "unknown",
    writesRefused: doc.writesRefused === true,
    refusedWriteCount: typeof doc.refusedWriteCount === "number" ? doc.refusedWriteCount : 0,
    lastVerifiedAt: doc.lastVerifiedAt instanceof Date ? doc.lastVerifiedAt : null,
    lastMismatchAt: doc.lastMismatchAt instanceof Date ? doc.lastMismatchAt : null,
    observedInstanceId: typeof doc.observedInstanceId === "string" ? doc.observedInstanceId : null,
    observedDbName: typeof doc.observedDbName === "string" ? doc.observedDbName : null,
    staleSeconds: updatedAt ? Math.round((now - updatedAt.getTime()) / 1000) : null,
  };
}

interface RosterStatsDocLike {
  docCount?: unknown;
  activeCount?: unknown;
  disabledCount?: unknown;
  lastGoodAt?: unknown;
  lastGoodSource?: unknown;
  degraded?: unknown;
  degradedSince?: unknown;
  blockedReloadCount?: unknown;
  lastBlockedAt?: unknown;
  updatedAt?: unknown;
}

/** Pure agent_roster_stats-doc → report mapping. Frozen fields per E2; `disabledCount`/`degradedSince`/`blockedReloadCount`/`lastBlockedAt` are merged-but-stable (spec §Report shape note) — a partial/pre-KPR-295 doc still maps without throwing. */
export function mapRosterStatsDoc(doc: RosterStatsDocLike | null): DatastoreIdentityReport["rosterStats"] {
  if (!doc) return null;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const date = (v: unknown): Date | null => (v instanceof Date ? v : null);
  return {
    docCount: num(doc.docCount),
    activeCount: num(doc.activeCount),
    disabledCount: num(doc.disabledCount),
    lastGoodAt: date(doc.lastGoodAt),
    lastGoodSource: doc.lastGoodSource === "boot" || doc.lastGoodSource === "reload" ? doc.lastGoodSource : null,
    degraded: doc.degraded === true,
    degradedSince: date(doc.degradedSince),
    blockedReloadCount: typeof doc.blockedReloadCount === "number" ? doc.blockedReloadCount : 0,
    lastBlockedAt: date(doc.lastBlockedAt),
    updatedAt: date(doc.updatedAt),
  };
}

/**
 * KPR-296 read adapter. Returns `null` only when the server is unreachable
 * (the Agents-group `mongoReachable` check already fails and explains that
 * case — the section renders "○ unreachable" and does not double-fail).
 *
 * ⚠ Delegated (spec §Design, settled): ONE shared client for all sub-reads,
 * unlike the sibling one-client-per-check pattern — the report's value
 * depends on every read observing the SAME server; split clients could
 * straddle a server flap and produce an incoherent report. Each sub-read is
 * individually try/caught so one failing command (e.g. unauthorized
 * `serverStatus` post-KPR-297) yields a partial report, not a dead section.
 *
 * STRICTLY READ-ONLY — both producer contracts mandate "doctor MUST NOT
 * write" (R2 / E2). No insert/update/replace/delete/drop of any kind.
 */
export async function datastoreIdentityForDoctor(
  uri: string,
  dbName: string,
  instanceId: string,
): Promise<DatastoreIdentityReport | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
  } catch {
    await client.close().catch(() => {});
    return null;
  }

  try {
    const db = client.db(dbName);
    const admin = db.admin();

    // Server fingerprint — best-effort, never fails the report (I4/KPR-297 forward-compat).
    const server: DatastoreIdentityReport["server"] = {
      host: null,
      version: null,
      pid: null,
      uptimeSeconds: null,
      dbPath: null,
      note: null,
    };
    const notes: string[] = [];
    try {
      const status = await admin.command({ serverStatus: 1 });
      server.host = typeof status.host === "string" ? status.host : null;
      server.version = typeof status.version === "string" ? status.version : null;
      // BSON int64 may surface as a bson.Long depending on driver serialization
      // (promoteLongs defaults to true, but don't assume the caller's client
      // config) — a genuine Long has no valueOf, so plain Number(...) can
      // yield NaN. Route through toString() first, which every plausible
      // shape (number, bson.Long, numeric string) supports correctly.
      server.pid = status.pid != null ? Number(status.pid.toString()) : null;
      server.uptimeSeconds = typeof status.uptime === "number" ? Math.round(status.uptime) : null;
    } catch (err) {
      notes.push(`serverStatus failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const opts = await admin.command({ getCmdLineOpts: 1 });
      const dbPath = (opts as { parsed?: { storage?: { dbPath?: unknown } } }).parsed?.storage?.dbPath;
      server.dbPath = typeof dbPath === "string" ? dbPath : null; // absent under bare defaults → renderer prints "(default)", skips W3
    } catch (err) {
      notes.push(`getCmdLineOpts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    server.note = notes.length > 0 ? notes.join("; ") : null;

    // Doctor's OWN sentinel read (out-of-process, R4 leaves CLIs ungated by design).
    let sentinel: DatastoreIdentityReport["sentinel"];
    try {
      const doc = await db
        .collection<{ _id: string } & SentinelDocLike>(DOCTOR_SENTINEL_COLLECTION)
        .findOne({ _id: DOCTOR_SENTINEL_ID });
      sentinel = mapSentinelDoc(doc, { instanceId, dbName });
    } catch (err) {
      sentinel = { state: "error", message: err instanceof Error ? err.message : String(err) };
    }

    // Live roster count — exact countDocuments (compare-target for W5),
    // NOT estimatedDocumentCount.
    let agentDefinitionsCount: number | null = null;
    try {
      agentDefinitionsCount = await db.collection("agent_definitions").countDocuments({});
    } catch {
      agentDefinitionsCount = null;
    }

    // Engine telemetry views — absent doc and failed read both map to null
    // (renders I2); the report shape carries no error slot for these.
    let identityStats: DatastoreIdentityReport["identityStats"] = null;
    try {
      identityStats = mapIdentityStatsDoc(
        await db.collection<IdentityStatsDocLike>("telemetry").findOne({ kind: DOCTOR_DB_IDENTITY_STATS_KIND }),
      );
    } catch {
      /* stays null */
    }

    let rosterStats: DatastoreIdentityReport["rosterStats"] = null;
    try {
      rosterStats = mapRosterStatsDoc(
        await db.collection<RosterStatsDocLike>("telemetry").findOne({ kind: DOCTOR_ROSTER_STATS_KIND }),
      );
    } catch {
      /* stays null */
    }

    return {
      uri: redactMongoUri(uri),
      dbName,
      instanceId,
      server,
      sentinel,
      agentDefinitionsCount,
      identityStats,
      rosterStats,
    };
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
