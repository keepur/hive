# KPR-455 chunk 1 — Views, bounds and resolvers

**Task 1 of 5.** Read [the plan index](kpr-455-plan.md) and all eight chunk files before starting. This chunk creates the module every rendered outcome in this child comes from: the resolved bounds, the `(publishedAt, _id)` comparator, the class-legality predicate, the two view resolvers, the two bounded reads and the cursor codec. **Nothing in this chunk writes, calls `init()`, creates a collection or an index, or constructs an `OpsNotifier`.**

**Split, and it is a STEP seam rather than a task seam — the recorded exception.** Chunks 1 and 1b are **one task and one commit**: this file carries Steps 1–2 (the re-verification and the module), [chunk 1b](kpr-455-plan-1b-view-tests.md) carries Steps 3–7 (the unit suite, the two empirical harness confirmations, the NV2 rehearsal and the commit). The module and its suite cannot be two commits without leaving a tree whose new module has no coverage; the combined file ran to ~1,250 lines, over this plan's own bound. Read 1 and 1b as one unit.

**Files**

- Create: `src/cli/ops-views.ts`
- Create: `src/cli/ops-views.test.ts` (chunk 1b)
- Read-only (verify, never edit): `src/ops/types.ts`, `src/ops/notification-store.ts`, `src/ops/testing/fake-db.ts`, `src/activity/types.ts`, `src/obligations/reader.ts:19-39`, `src/obligations/testing/fake-db.ts`

**Tier: `capable`.** Four of the sixteen acceptance criteria are properties of the functions in this file and of nothing else, and three of them have a plausible wrong implementation that a mechanical pass produces: joining recoveries on `errorSig` (AC4), letting an unrecognized `class` clear a condition (AC16), and reading the discovery window as the horizon (AC3).

---

## Task 1: the view module

- [ ] **Step 1:** Re-verify the four integration points against the merged siblings. This is a read-only step; it produces no diff.

```bash
# (a) The ops event envelope and the collection constant.
grep -n "export interface OpsEvent" -A 32 src/ops/types.ts
grep -n "OPS_EVENTS_COLLECTION" src/ops/types.ts
# EXPECT: `_id?: ObjectId`, `schemaVersion: number`, `publishedAt: Date`, `producer`, `reasonId`, `class`,
# `retry`, `waiting`, `subject: { kind, id }`, `generation`, `dedupeKey`,
# `detail`, `evidence`, `matchedSubscriptions`, `matchedSubscriptionIds`, and
# the two optional clearing fields `clears?` / `clearsFamily?`.
# If `clears` is absent or renamed, STOP — resolveOpenConditions keys on it.

# (b) The heartbeat kind and the field set the doctor section and both read
#     payloads project.
grep -n "NOTIFIER_STATS_KIND" src/ops/notification-store.ts
grep -n "writeHeartbeat({" -A 40 src/ops/notifier.ts
# EXPECT: kind "ops_notifier_stats"; the document carries `timestamp`,
# `lastSuccessfulSweep`, `cursorAt`, `eventsBehind`, `oldestUnappliedAt`,
# `ingestFaults`, `sweepFaults` and `state` among others.
# If `timestamp` is not written on the degraded path too, STOP — the plan
# index's staleness-field assumption rests on it.

# (c) OpsNotifier's constructor arity and init()'s throw posture (chunk 2 uses
#     these; verified here so one step covers all four).
grep -n "constructor(" -A 8 src/ops/notifier.ts | head -20
grep -n "async init()" -A 12 src/ops/notifier.ts
# EXPECT: constructor(db, activityRetentionDays, clock?, sleep?) and an init()
# that THROWS when the unique identity index cannot be created.

# (d) The two fake-db extensions this plan depends on.
grep -n "const copy" src/ops/testing/fake-db.ts
grep -n "unique(" src/ops/testing/fake-db.ts | head -3
# EXPECT: `copy` preserves ObjectId (KPR-468 extension (f)) and insertOne
# enforces unique indexes (extension (c)). If `copy` is a bare
# `structuredClone`, STOP and report a blocker: AC10 cannot resolve a handle
# through parseHandle against a degraded `_id`, and the test would go green
# while asserting nothing.
```

- [ ] **Step 2:** Create `src/cli/ops-views.ts`.

```typescript
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { parse as parseYaml } from "yaml";
import { ObjectId, type Db, type Filter } from "mongodb";
import { z } from "zod";
import { OPS_EVENTS_COLLECTION, type OpsEvent } from "../ops/types.js";
import { NOTIFIER_STATS_KIND } from "../ops/notification-store.js";
import { TURN_ACTIVITY_FILTER, type ActivityRecord } from "../activity/types.js";
import type { CliSelection } from "./obligations.js";

/**
 * KPR-455 D4/D5/D6/D9 — the operational reader's bounds, resolvers and bounded
 * reads.
 *
 * READ-ONLY IN EVERY DIRECTION. Nothing in this module opens a write, calls
 * init(), creates a collection or an index, or constructs an OpsNotifier. The
 * only write anywhere in this child's diff is intake's own CAS on the `ack`
 * path, performed by KPR-468's code and reached from src/cli/ops.ts.
 *
 * The rule that governs all of it: THE READER READS. It decides nothing about
 * who should hear about a condition, how loud it is, when it should be
 * repeated, or whether it matters. Every such decision has a home — the
 * subscription row, the cadence table, the reason registry — and none of them
 * is this child's.
 */

/** A CLI-local failure token. SNAKE_CASE deliberately: src/cli.ts:178 prints a
 *  thrown message only when it matches /^[a-z_]+$/, and KPR-468's refusal
 *  vocabulary is kebab-case, so contract refusals travel as DATA in the JSON
 *  payload and never through here (D7). */
export class OpsCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OpsCliError";
  }
}
export function failOps(code: string): never {
  throw new OpsCliError(code);
}

// ── Bounds. Every one is a code constant with no hive.yaml key (the standing
//    "no preemptive levers" preference; both siblings ship none). Every horizon
//    is also a flag, and the flag's DIRECTION is what makes the default safe:
//    past the horizon the answer is `unknown`, so a shorter horizon yields MORE
//    unknown and no setting can manufacture a `healthy` (D6). ──

/** 24 h. A tool condition RENEWS on every repeat (KPR-454 keys on the tool), so
 *  the horizon must exceed the interval between a tool's USES, not its
 *  failures: a tool exercised once a day by a cron would read `unknown` under a
 *  shorter one even while broken. 24 h covers a working day plus the overnight
 *  crons. */
export const TOOL_HEALTH_STALE_AFTER_MINUTES = 1440;

/** 72 h, deliberately NOT the tool horizon — D8 makes the horizon a property of
 *  the VIEW. A workItem-shaped condition has no renewal rhythm: published once,
 *  it can stay open for days with nothing republished, so the tool horizon
 *  would render every genuinely open condition `unknown` inside a day. Three
 *  days spans a weekend. */
export const WORK_STATUS_STALE_AFTER_MINUTES = 4320;

/** 24 h. "What started and went quiet" is a today question; the 7 d ratio the
 *  scope addition measured is one `--window 10080` away. */
export const QUIET_TURN_WINDOW_MINUTES = 1440;

/** The KEY SPACE is enumerated over a window WIDER than the horizon. Without
 *  it, "the latest fact is older than the horizon" (⇒ unknown) and "the key does
 *  not appear at all" (⇒ absent) are the same observation and D4's table has
 *  two rows it cannot tell apart. The cost is stated in the payload: absence
 *  means "published no fact in the discovery window", never "never". */
export const DISCOVERY_WINDOW_FLOOR_MS = 7 * 86_400_000;
export const DISCOVERY_HORIZON_MULTIPLIER = 3;

/** Bounds the DOCUMENTS READ, which `--limit` does not (D4: `--limit` caps
 *  output rows, and a caller narrowing it does not narrow the work). The scan
 *  walks {publishedAt: 1, _id: 1} in reverse, so the cap truncates the OLDER
 *  TAIL only: every key's latest fact — and therefore every rendered outcome —
 *  is exact under the cap, and only `eventCount` and `firstAt` become lower
 *  bounds, which the payload labels. */
export const OPS_EVENT_SCAN_CAP = 5_000;

/** Bounds arm 2's grouping read. The exact totals do not depend on it (they are
 *  two countDocuments), so a breach costs only the per-(agentId, channelKind)
 *  grouping and is flagged `groupsTruncated`. */
export const ACTIVITY_MATCH_CAP = 2_000;

/** src/cli/obligations.ts:111, :121-122 — one pair of numbers for both CLIs. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** src/obligations/reader.ts:47-57, and the threshold every existing doctor
 *  section uses (src/cli/doctor.ts:117). */
export const HEARTBEAT_STALE_MS = 120_000;

/** src/config.ts:659's own default, used when no instance value resolves. */
export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;

/** The rollup key for a condition event carrying no `detail.errorSig`.
 *  Unreachable under the shipped producer (`errorSig` is a required detailKey
 *  on `tool-failed`); it exists to keep the reducer total. The parenthesised
 *  form cannot collide with a real token — OPS_TOKEN_RE bounds those to
 *  /^[a-z][a-z0-9-]{0,39}$/. */
export const UNKNOWN_ERROR_SIG = "(unset)";

/** KPR-458 D8 scopes the tool-health view to this producer; KPR-454 D4 fixes
 *  the subject. Clearing events are identified STRUCTURALLY by the presence of
 *  `clears` rather than by hardcoding the reason id `tool-recovered`, which is
 *  what keeps the resolver generic within the producer (C16). */
export const ROLLUP_PRODUCER = "hive-runtime";
export const TOOL_SUBJECT_KIND = "tool";

export const ACTIVITY_COLLECTION = "activity_log";
export const TELEMETRY_COLLECTION = "telemetry";

// ── The log's own total order ──

export interface EventPosition {
  publishedAt: Date;
  _id?: ObjectId;
}

/**
 * `(publishedAt, _id)` — the same total order KPR-454's epoch resolver and
 * KPR-468's cursor use, compared on `String(_id)` for the same reason they do:
 * an ObjectId's hex is byte-identical to its own order.
 */
export function isAfter(a: EventPosition, b: EventPosition): boolean {
  const at = a.publishedAt.getTime();
  const bt = b.publishedAt.getTime();
  if (at !== bt) return at > bt;
  return String(a._id ?? "") > String(b._id ?? "");
}

function detailString(event: OpsEvent, key: string): string | undefined {
  const value = event.detail?.[key];
  return typeof value === "string" ? value : undefined;
}

// ── D5: the class-legality rule, applied by this reader over TWO EVENTS ──

/** D3's four values. A stored `class` outside this set is unresolvable, and the
 *  reader FAILS OPEN AS OPEN rather than treating the clearing fact as legal. */
export const OPS_CLASSES: ReadonlySet<string> = new Set(["integrity", "resource", "judgment", "informational"]);

/**
 * KPR-458 D3's clearing rule, verbatim, over two EVENTS.
 *
 * KPR-468's `clearingProvenanceOk(row, e)` cannot be borrowed in this shape: it
 * reads `row.producer` and `row.class` off a LEDGER ROW, and this child never
 * has one — it may not read `ops_notifications` at all. D8 defines the derived
 * view as "open until a class-legal clearing fact", so applying class legality
 * IS this view's own definition; one rule with two appliers, BY CONTRACT.
 *
 * The `class` read is the CLEARED CONDITION'S (kpr-458-design.md:323), and it
 * is a field of a document this reader already has: `class` and `retry` are
 * copied from the registry entry into every event at accept and are never
 * producer-supplied (kpr-458-design.md:100-101; KPR-454 stamps both at :360).
 * So neither read path reads `ops_reasons` at all.
 *
 * The `default` arm is the forward-compatibility limb and it matches the
 * sibling's own (`case "informational": default: return false`): a reader that
 * showed CLEARED on an unresolvable class would be the "absence is not health"
 * defect wearing a different hat. The vocabulary is contract-fixed rather than
 * registry data (kpr-458-design.md:370), so a fifth class is a contract
 * revision, not a row somebody registers.
 *
 * ⚠ If KPR-468 ever exports an event-shaped predicate, adopt it and delete this
 * one. Until then AC16's six limbs are what pin the two against drift.
 */
export function clearingIsLegal(condition: OpsEvent, clearing: OpsEvent): boolean {
  if (clearing.producer !== condition.producer) return false;
  if (clearing.clears !== condition.dedupeKey) return false;
  switch (condition.class) {
    case "resource":
      return true;
    case "judgment":
    case "integrity":
      return (clearing.evidence?.length ?? 0) >= 1;
    case "informational":
    default:
      return false;
  }
}

// ── Bounded reads over ops_events ──

export function discoveryWindowMs(horizonMs: number): number {
  return Math.max(DISCOVERY_WINDOW_FLOOR_MS, horizonMs * DISCOVERY_HORIZON_MULTIPLIER);
}

export interface OpsEventScan {
  events: OpsEvent[];
  fromAt: Date;
  scannedEvents: number;
  scanCapped: boolean;
}

/**
 * One bounded read, newest-first, over the `{ publishedAt: 1, _id: 1 }` index
 * KPR-454 creates for its own cursor — walked in reverse, with `producer` and
 * `subject.kind` as residual predicates when the caller supplies them.
 *
 * `--limit` is NOT a scan bound and saying it were would be false: KPR-454
 * appends one event per failure, so a key-space enumeration scales with EVENT
 * VOLUME inside the window. `OPS_EVENT_SCAN_CAP` and the window are what bound
 * this read.
 */
export async function scanOpsEvents(
  db: Db,
  opts: { now: Date; windowMs: number; scope?: Filter<OpsEvent> },
): Promise<OpsEventScan> {
  const fromAt = new Date(opts.now.getTime() - opts.windowMs);
  const filter: Filter<OpsEvent> = { ...(opts.scope ?? {}), publishedAt: { $gte: fromAt } };
  const events = await db
    .collection<OpsEvent>(OPS_EVENTS_COLLECTION)
    .find(filter)
    .sort({ publishedAt: -1, _id: -1 })
    .limit(OPS_EVENT_SCAN_CAP)
    .toArray();
  return { events, fromAt, scannedEvents: events.length, scanCapped: events.length >= OPS_EVENT_SCAN_CAP };
}

export interface OpsLogPresence {
  present: boolean;
  newestEventAt: Date | null;
  newestEventAgeSeconds: number | null;
}

/**
 * "Is there an ops event log on this instance at all", plus the age of its
 * newest document of any reason.
 *
 * ⚠ `newestEventAt` is LAST-KNOWN PUBLISHER ACTIVITY AND IS NOT A HEALTH
 * SIGNAL. A healthy fleet legitimately publishes nothing for days, so recency
 * is a lower bound on when the publisher was last alive and never an upper
 * bound on health. KPR-454 exposes its counters through an in-memory
 * getSnapshot() with no telemetry document, so from outside the engine "no tool
 * failed" and "the publisher was never set" are the same observation (D9). The
 * rollup's unknown-past-horizon rule holds without this signal; the remedy is
 * an `ops_publisher_stats` heartbeat in KPR-454, which is a cross-child
 * addition and not this diff.
 */
export async function readOpsLogPresence(db: Db, now: Date): Promise<OpsLogPresence> {
  const events = db.collection<OpsEvent>(OPS_EVENTS_COLLECTION);
  // A missing collection counts 0 rather than throwing, which is what makes
  // edge case 1 (KPR-454 not deployed) a labelled empty result.
  const count = await events.countDocuments({}, { limit: 1 });
  if (count === 0) return { present: false, newestEventAt: null, newestEventAgeSeconds: null };
  const newest = await events.find({}).sort({ publishedAt: -1, _id: -1 }).limit(1).toArray();
  const at = newest[0]?.publishedAt ?? null;
  return {
    present: true,
    newestEventAt: at,
    newestEventAgeSeconds: at ? Math.round((now.getTime() - at.getTime()) / 1000) : null,
  };
}

// ── (b) The tool-health rollup (D4) ──

export type ToolOutcome = "failing" | "recovered" | "unknown";

export interface ToolHealthRow {
  tool: string;
  errorSig: string;
  outcome: ToolOutcome;
  lane?: string;
  eventCount: number;
  firstAt: Date;
  lastAt: Date;
  recoveredAt?: Date;
  ageSeconds: number;
}

/** ⚠ `"none"` means NO EMPTINESS SHAPE APPLIES — never "nothing notable". A view
 *  that is all `unknown` plus one `recovered` row lands here; read the counts. */
export type ToolHealthEmptiness =
  | "none"
  | "no-ops-event-log"
  | "no-keys-in-window"
  | "no-facts-in-horizon"
  | "all-recovered";

export interface ToolHealthResult {
  rows: ToolHealthRow[];
  summary: { failing: number; recovered: number; unknown: number; emptiness: ToolHealthEmptiness };
}

/**
 * D4. Keyed `(detail.tool, detail.errorSig)`; latest outcome resolved on the
 * log's own `(publishedAt, _id)` total order.
 *
 * ⚠ THE RECOVERY-KEY ASYMMETRY, which is not discoverable from the key: the
 * rollup is keyed (tool, errorSig) but KPR-454 D5 gives `tool-recovered` a
 * detailKeys of `tool` and `lane` ONLY — a recovery carries NO errorSig. So a
 * recovery cannot be matched to one row of the key space, and the rule is that
 * A RECOVERY FOR A TOOL RESOLVES EVERY errorSig ROW FOR THAT TOOL. That is not
 * a compromise: KPR-454 D4 already accepts that all error tokens for one tool
 * share one condition, and the tool coming back is a fact about the tool. An
 * implementation that quietly dropped recoveries because they failed to join on
 * errorSig would render every recovered tool as permanently `failing` — the
 * most likely wrong implementation, and what AC4 exists to fail.
 *
 * `events` MUST arrive newest-first and already scoped to the producer and
 * subject kind; `scanOpsEvents` is the only supported source.
 */
export function resolveToolHealth(
  events: OpsEvent[],
  opts: { now: Date; horizonMs: number; logPresent: boolean },
): ToolHealthResult {
  const horizonAt = opts.now.getTime() - opts.horizonMs;
  /** tool → the newest clearing fact for it. Keyed on the TOOL, never on the key. */
  const recoveries = new Map<string, OpsEvent>();
  const keys = new Map<
    string,
    { tool: string; errorSig: string; lane?: string; eventCount: number; latest: OpsEvent; firstAt: Date }
  >();

  for (const event of events) {
    const tool = detailString(event, "tool") ?? event.subject.id;
    if (event.clears !== undefined) {
      const held = recoveries.get(tool);
      if (!held || isAfter(event, held)) recoveries.set(tool, event);
      continue;
    }
    const errorSig = detailString(event, "errorSig") ?? UNKNOWN_ERROR_SIG;
    const key = `${tool} ${errorSig}`;
    const held = keys.get(key);
    if (!held) {
      keys.set(key, {
        tool,
        errorSig,
        lane: detailString(event, "lane"),
        eventCount: 1,
        latest: event,
        firstAt: event.publishedAt,
      });
      continue;
    }
    held.eventCount += 1;
    if (isAfter(event, held.latest)) {
      held.latest = event;
      held.lane = detailString(event, "lane") ?? held.lane;
    }
    if (event.publishedAt.getTime() < held.firstAt.getTime()) held.firstAt = event.publishedAt;
  }

  const rows: ToolHealthRow[] = [];
  for (const held of keys.values()) {
    const recovery = recoveries.get(held.tool);
    const recovered = recovery !== undefined && isAfter(recovery, held.latest);
    const latestAt = recovered ? recovery!.publishedAt : held.latest.publishedAt;
    const outcome: ToolOutcome = latestAt.getTime() < horizonAt ? "unknown" : recovered ? "recovered" : "failing";
    rows.push({
      tool: held.tool,
      errorSig: held.errorSig,
      outcome,
      ...(held.lane ? { lane: held.lane } : {}),
      eventCount: held.eventCount,
      firstAt: held.firstAt,
      lastAt: held.latest.publishedAt,
      ...(recovered ? { recoveredAt: recovery!.publishedAt } : {}),
      ageSeconds: Math.round((opts.now.getTime() - latestAt.getTime()) / 1000),
    });
  }
  rows.sort((a, b) => a.tool.localeCompare(b.tool) || a.errorSig.localeCompare(b.errorSig));

  const failing = rows.filter((r) => r.outcome === "failing").length;
  const recovered = rows.filter((r) => r.outcome === "recovered").length;
  const unknown = rows.filter((r) => r.outcome === "unknown").length;
  const emptiness: ToolHealthEmptiness = !opts.logPresent
    ? "no-ops-event-log"
    : rows.length === 0
      ? "no-keys-in-window"
      : failing === 0 && recovered === 0
        ? "no-facts-in-horizon"
        : failing === 0 && unknown === 0
          ? "all-recovered"
          : "none";

  return { rows, summary: { failing, recovered, unknown, emptiness } };
}

// ── (a) arm 1: open conditions (D5) ──

export type ConditionState = "open" | "unknown";

export interface OpenConditionRow {
  dedupeKey: string;
  producer: string;
  reasonId: string;
  subject: { kind: string; id: string };
  class: string;
  waiting: string;
  retry: string;
  generation: number;
  eventCount: number;
  firstAt: Date;
  lastAt: Date;
  state: ConditionState;
  /** D5: the stored `matchedSubscriptions` scalar, RENAMED at the rendering
   *  boundary so it is not read as a schema claim, and always accompanied by
   *  the instant below. Never a present-tense phrasing in either direction. */
  matchedAtPublish: number;
  matchedAtPublishAsOf: Date;
  /** KPR-453 canon: references a responder OPENS, never join keys. */
  evidence: string[];
}

/**
 * D5 arm 1, implemented GENERICALLY over any `subject.kind` — the contract's
 * rule is per view and the mechanism is identical. It is correct today and
 * returns only tool conditions, because KPR-454 keys deliberately on the tool
 * and no chartered child publishes workItem-subject conditions.
 *
 * An event carrying `clears` is a CLEARING FACT and is never listed as an open
 * condition of its own, even though it mints its own dedupeKey family
 * (KPR-454 D9 step 5): listing recoveries as permanently-open `informational`
 * conditions would be noise with no consumer.
 *
 * `informational` conditions that are NOT clearing facts ARE listed, and are
 * labelled. They can never be cleared (D3), so filtering them would be this
 * child deciding they do not matter — a policy call it may not hold.
 */
export function resolveOpenConditions(events: OpsEvent[], opts: { now: Date; horizonMs: number }): OpenConditionRow[] {
  const horizonAt = opts.now.getTime() - opts.horizonMs;
  const conditions = new Map<string, { latest: OpsEvent; eventCount: number; firstAt: Date }>();
  const clearings = new Map<string, OpsEvent[]>();

  for (const event of events) {
    if (event.clears !== undefined) {
      const held = clearings.get(event.clears);
      if (held) held.push(event);
      else clearings.set(event.clears, [event]);
      continue;
    }
    const held = conditions.get(event.dedupeKey);
    if (!held) {
      conditions.set(event.dedupeKey, { latest: event, eventCount: 1, firstAt: event.publishedAt });
      continue;
    }
    held.eventCount += 1;
    if (isAfter(event, held.latest)) held.latest = event;
    if (event.publishedAt.getTime() < held.firstAt.getTime()) held.firstAt = event.publishedAt;
  }

  const rows: OpenConditionRow[] = [];
  for (const [dedupeKey, held] of conditions) {
    const cleared = (clearings.get(dedupeKey) ?? []).some(
      (clearing) => isAfter(clearing, held.latest) && clearingIsLegal(held.latest, clearing),
    );
    if (cleared) continue;
    const event = held.latest;
    rows.push({
      dedupeKey,
      producer: event.producer,
      reasonId: event.reasonId,
      subject: { kind: event.subject.kind, id: event.subject.id },
      class: OPS_CLASSES.has(event.class) ? event.class : "unknown",
      waiting: event.waiting,
      retry: event.retry,
      generation: event.generation,
      eventCount: held.eventCount,
      firstAt: held.firstAt,
      lastAt: event.publishedAt,
      state: event.publishedAt.getTime() < horizonAt ? "unknown" : "open",
      matchedAtPublish: event.matchedSubscriptions,
      matchedAtPublishAsOf: event.publishedAt,
      evidence: (event.evidence ?? []).map((reference) => `${reference.kind}:${reference.id}`),
    });
  }
  rows.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime() || a.dedupeKey.localeCompare(b.dedupeKey));
  return rows;
}

// ── (a) arm 2: quiet turns (D5) ──

export type QuietFlag = "error" | "aborted" | "timedOut";

export interface QuietTurnRow {
  agentId: string;
  threadId: string;
  timestamp: Date;
  model: string;
  channelKind: string;
  /** WHICH FLAGS WERE SET. The `error` STRING is never carried. */
  flags: QuietFlag[];
}

export interface QuietTurnGroup {
  agentId: string;
  channelKind: string;
  error: number;
  aborted: number;
  timedOut: number;
  total: number;
}

export interface QuietTurnSection {
  windowMinutes: number;
  fromAt: Date;
  measurable: boolean;
  turnsInWindow: number;
  matched: number;
  ratio: string | null;
  byAgent: QuietTurnGroup[];
  recent: QuietTurnRow[];
  groupsTruncated: boolean;
  nextCursor: string | null;
}

/**
 * ⚠ `{ error: { $exists: true, $ne: null } }`, NOT the bare `$ne: null`, and
 * the reason is a verified divergence between MongoDB and the in-memory double
 * every test in this plan runs against: the double's `$ne` arm is
 * `!same(actual, value)` (src/obligations/testing/fake-db.ts:34-35) and
 * `same(undefined, null)` falls through to `a === b` ⇒ false
 * (src/obligations/types.ts:216-237), so `{ error: { $ne: null } }` MATCHES
 * EVERY ROW WITH NO `error` FIELD AT ALL there while excluding them in
 * MongoDB. With `$exists: true` ANDed in, the predicate agrees in both engines.
 * Without it, every successful turn in a fixture is reported as a failing one.
 */
export const QUIET_TURN_DISJUNCTS: ReadonlyArray<Filter<ActivityRecord>> = [
  { error: { $exists: true, $ne: null } },
  { aborted: true },
  { timedOut: true },
];

/** The projection is a bandwidth measure and NOTHING RESTS ON IT: the in-memory
 *  double's `project()` is a no-op (src/obligations/testing/fake-db.ts:252-254).
 *  It deliberately INCLUDES `error`, because the flag is derived from it; the
 *  string is converted to a boolean inside this module's own mapper and never
 *  leaves it. */
const QUIET_TURN_PROJECTION = {
  agentId: 1,
  threadId: 1,
  timestamp: 1,
  model: 1,
  channelKind: 1,
  error: 1,
  aborted: 1,
  timedOut: 1,
} as const;

function flagsOf(doc: Partial<ActivityRecord>): QuietFlag[] {
  const flags: QuietFlag[] = [];
  if (doc.error !== undefined && doc.error !== null) flags.push("error");
  if (doc.aborted === true) flags.push("aborted");
  if (doc.timedOut === true) flags.push("timedOut");
  return flags;
}

function toQuietTurnRow(doc: Partial<ActivityRecord> & { timestamp?: Date }): QuietTurnRow {
  return {
    agentId: typeof doc.agentId === "string" ? doc.agentId : "(unset)",
    threadId: typeof doc.threadId === "string" ? doc.threadId : "(unset)",
    timestamp: doc.timestamp instanceof Date ? doc.timestamp : new Date(0),
    model: typeof doc.model === "string" ? doc.model : "(unset)",
    channelKind: typeof doc.channelKind === "string" ? doc.channelKind : "(unset)",
    flags: flagsOf(doc),
  };
}

/**
 * D5 arm 2 — the arm with data. `error ∨ aborted ∨ timedOut` over
 * `activity_log`, ALWAYS under TURN_ACTIVITY_FILTER so KPR-456's delivery
 * receipts are excluded, within a bounded `timestamp` window.
 *
 * The union is what C12 requires and the measurement is why: 57 of the 65
 * `timedOut` rows in the measured window carried `error: null`, so a reader
 * keyed on `error` alone misses most timeouts, and the honest rate is 8.9 %
 * against the 5.0 % that field reports (2026-09-08; 9.1 % on a slid window).
 * No renderer here reads `costUsd` or `durationMs` as an outcome signal —
 * `turn-scaffold.ts:353` gives EVERY Lane B turn `costUsd: 0`.
 *
 * The index that serves this is the TTL index `{ timestamp: 1 }`
 * (src/activity/activity-logger.ts:40-43, an ordinary index as well as a TTL),
 * not the per-agent `{ agentId: 1, timestamp: -1 }` at :37, whose leading key
 * is unconstrained by a cross-agent window. NO INDEX IS ADDED either way:
 * adding one from a reader would be a write.
 */
export async function readQuietTurns(
  db: Db,
  opts: { now: Date; windowMs: number; limit: number; owner: string; cursor?: string },
): Promise<QuietTurnSection> {
  const fromAt = new Date(opts.now.getTime() - opts.windowMs);
  const activity = db.collection<ActivityRecord>(ACTIVITY_COLLECTION);
  const windowFilter: Filter<ActivityRecord> = { ...TURN_ACTIVITY_FILTER, timestamp: { $gte: fromAt } };
  const matchFilter: Filter<ActivityRecord> = { $and: [windowFilter, { $or: [...QUIET_TURN_DISJUNCTS] }] };

  const turnsInWindow = await activity.countDocuments(windowFilter);
  const matched = await activity.countDocuments(matchFilter);

  const grouped = await activity
    .find(matchFilter)
    .sort({ timestamp: -1, _id: -1 })
    .limit(ACTIVITY_MATCH_CAP)
    .project(QUIET_TURN_PROJECTION)
    .toArray();

  const groups = new Map<string, QuietTurnGroup>();
  for (const doc of grouped) {
    const row = toQuietTurnRow(doc as Partial<ActivityRecord>);
    const key = `${row.agentId} ${row.channelKind}`;
    const group = groups.get(key) ?? {
      agentId: row.agentId,
      channelKind: row.channelKind,
      error: 0,
      aborted: 0,
      timedOut: 0,
      total: 0,
    };
    for (const flag of row.flags) group[flag] += 1;
    group.total += 1;
    groups.set(key, group);
  }

  const after = decodeOpsCursor(opts.cursor, "quietTurns", opts.owner);
  const pageFilter: Filter<ActivityRecord> = after ? { $and: [matchFilter, afterFilter(after)] } : matchFilter;
  const page = await activity
    .find(pageFilter)
    .sort({ timestamp: -1, _id: -1 })
    .limit(opts.limit + 1)
    .project(QUIET_TURN_PROJECTION)
    .toArray();
  const hasMore = page.length > opts.limit;
  const pageRows = page.slice(0, opts.limit);
  const last = pageRows.at(-1) as (Partial<ActivityRecord> & { _id?: ObjectId }) | undefined;

  return {
    windowMinutes: Math.round(opts.windowMs / 60_000),
    fromAt,
    measurable: turnsInWindow > 0,
    turnsInWindow,
    matched,
    ratio: turnsInWindow > 0 ? `${((matched / turnsInWindow) * 100).toFixed(1)}%` : null,
    byAgent: [...groups.values()].sort((a, b) => b.total - a.total || a.agentId.localeCompare(b.agentId)),
    recent: pageRows.map((doc) => toQuietTurnRow(doc as Partial<ActivityRecord>)),
    groupsTruncated: matched > grouped.length,
    nextCursor:
      hasMore && last?.timestamp instanceof Date
        ? encodeOpsCursor("quietTurns", opts.owner, `${last.timestamp.toISOString()}|${String(last._id ?? "")}`)
        : null,
  };
}

function afterFilter(after: string): Filter<ActivityRecord> {
  const [iso, hex] = after.split("|");
  if (!iso || !hex || hex.length !== 24) return failOps("invalid_cursor");
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime()) || !ObjectId.isValid(hex)) return failOps("invalid_cursor");
  return { $or: [{ timestamp: { $lt: timestamp } }, { timestamp, _id: { $lt: new ObjectId(hex) } }] };
}

// ── Pipeline freshness (D9, edge case 4) ──

export type PipelineState = "ok" | "backlog" | "degraded" | "unknown";

export interface PipelineFreshness {
  present: boolean;
  state: PipelineState;
  /** What the document said, before the staleness coercion. */
  reportedState: string | null;
  heartbeatAgeSeconds: number | null;
  lastSuccessfulSweepAgeSeconds: number | null;
  stale: boolean;
  /** A fresh heartbeat beside a stale lastSuccessfulSweep is the
   *  running-but-never-succeeding signature — KPR-468's own wedge. */
  sweepSucceeding: boolean | null;
  cursorAt: Date | null;
  eventsBehind: number | null;
  /** KPR-468's count saturates at its own limit, so it is read as "at least N". */
  eventsBehindIsAtLeast: boolean;
  oldestUnappliedAt: Date | null;
  oldestUnappliedAgeSeconds: number | null;
  ingestFaults: number | null;
  sweepFaults: number | null;
}

interface HeartbeatDocLike {
  timestamp?: unknown;
  lastSuccessfulSweep?: unknown;
  cursorAt?: unknown;
  eventsBehind?: unknown;
  oldestUnappliedAt?: unknown;
  ingestFaults?: unknown;
  sweepFaults?: unknown;
  state?: unknown;
}

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const ageSeconds = (at: Date | null, now: Date): number | null =>
  at ? Math.round((now.getTime() - at.getTime()) / 1000) : null;

/**
 * Edge case 4's rule, applied to KPR-468's OWN liveness field — the faithful
 * reading of "copy verbatim" rather than a departure from it.
 *
 * `ObligationReader.heartbeat()` (src/obligations/reader.ts:47-57) coerces the
 * reported state to `unknown` past 120 s keyed on `lastSuccessfulSweep`,
 * because that is ITS only liveness field. KPR-468's heartbeat splits the two:
 * `timestamp` is written on EVERY tick including a degraded one
 * (kpr-468-plan-3b-notifier.md:352-357), `lastSuccessfulSweep` only after an
 * all-ok tick (:416, :424-426). Coercing on the latter would report a LIVE but
 * PERSISTENTLY DEGRADED notifier as stale and `unknown`, firing the doctor's
 * "engine may not be running" warn about an engine that is running fine and
 * failing loudly. Both ages are rendered either way, so an operator can see
 * the difference themselves.
 */
export async function readPipeline(db: Db, now: Date): Promise<PipelineFreshness> {
  const doc = (await db
    .collection(TELEMETRY_COLLECTION)
    .findOne({ kind: NOTIFIER_STATS_KIND })) as HeartbeatDocLike | null;
  if (!doc) {
    return {
      present: false,
      state: "unknown",
      reportedState: null,
      heartbeatAgeSeconds: null,
      lastSuccessfulSweepAgeSeconds: null,
      stale: true,
      sweepSucceeding: null,
      cursorAt: null,
      eventsBehind: null,
      eventsBehindIsAtLeast: true,
      oldestUnappliedAt: null,
      oldestUnappliedAgeSeconds: null,
      ingestFaults: null,
      sweepFaults: null,
    };
  }
  const beatAt = asDate(doc.timestamp);
  const beatAge = ageSeconds(beatAt, now);
  const stale = beatAge === null || beatAge * 1000 > HEARTBEAT_STALE_MS;
  const sweepAge = ageSeconds(asDate(doc.lastSuccessfulSweep), now);
  const reported = typeof doc.state === "string" ? doc.state : null;
  const known = reported === "ok" || reported === "backlog" || reported === "degraded";
  const oldestUnappliedAt = asDate(doc.oldestUnappliedAt);
  return {
    present: true,
    state: stale || !known ? "unknown" : (reported as PipelineState),
    reportedState: reported,
    heartbeatAgeSeconds: beatAge,
    lastSuccessfulSweepAgeSeconds: sweepAge,
    stale,
    sweepSucceeding: sweepAge === null ? false : sweepAge * 1000 <= HEARTBEAT_STALE_MS,
    cursorAt: asDate(doc.cursorAt),
    eventsBehind: asNumber(doc.eventsBehind),
    eventsBehindIsAtLeast: true,
    oldestUnappliedAt,
    oldestUnappliedAgeSeconds: ageSeconds(oldestUnappliedAt, now),
    ingestFaults: asNumber(doc.ingestFaults),
    sweepFaults: asNumber(doc.sweepFaults),
  };
}

// ── The cursor. src/obligations/reader.ts:19-39's shape, as a LOCAL COPY with
//    its own section enum: that module's zod enum is
//    "definitions" | "overdue" | "history" and widening it would be an edit to
//    KPR-456's module. ──

const opsCursorSchema = z
  .object({
    version: z.literal(1),
    section: z.enum(["tools", "quietTurns"]),
    owner: z.string().max(100),
    after: z.string().max(150),
  })
  .strict();

export type OpsCursorSection = z.infer<typeof opsCursorSchema>["section"];

export function encodeOpsCursor(section: OpsCursorSection, owner: string, after: string): string {
  return Buffer.from(JSON.stringify({ version: 1, section, owner, after })).toString("base64url");
}

export function decodeOpsCursor(
  value: string | undefined,
  section: OpsCursorSection,
  owner: string,
): string | undefined {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 500) return failOps("invalid_cursor");
    const parsed = opsCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
    if (parsed.section !== section || parsed.owner !== owner) return failOps("invalid_cursor");
    return parsed.after;
  } catch {
    return failOps("invalid_cursor");
  }
}

// ── Instance-scoped configuration the CLI needs and CliSelection does not carry ──

/**
 * `config.activity.retentionDays`, resolved out of process.
 *
 * Needed on all three paths: the two read paths compare `--stale-after` against
 * the event TTL for edge case 7's retention-truncation label, and the `ack`
 * path hands it to OpsNotifier's constructor, where it determines the
 * `expiresAt` KPR-468 writes on a `seen`/`dismissed` transition. Defaulting it
 * to 90 would retain a per-person behavioural record past an operator's own
 * retention posture (KPR-458 D9), which is the opposite of that section's
 * intent.
 *
 * The precedence mirrors selectInstance's own (src/cli/obligations.ts:51-56):
 * process env, then the instance's adjacent `.env`, then hive.yaml, then
 * src/config.ts:659's default. ONE DELIBERATE NARROWING: config.ts's
 * `optional()` also consults the Keychain, and this does not — a retention
 * value is not a credential, and reading a non-secret out of Honeypot would be
 * new behaviour rather than a copied precedent.
 *
 * `selectInstance` is NOT modified; this re-reads the path CliSelection already
 * carries.
 */
export function resolveActivityRetentionDays(selection: CliSelection, env = process.env): number {
  let fromYaml: unknown;
  try {
    const yaml: unknown = parseYaml(readFileSync(selection.configPath, "utf8"));
    if (yaml && typeof yaml === "object" && "activity" in yaml) {
      const activity = (yaml as { activity?: unknown }).activity;
      if (activity && typeof activity === "object" && "retentionDays" in activity) {
        fromYaml = (activity as { retentionDays?: unknown }).retentionDays;
      }
    }
  } catch {
    fromYaml = undefined;
  }
  const suffix = basename(selection.configPath).match(/^hive-(.+)\.yaml$/)?.[1];
  const envPath = resolve(dirname(selection.configPath), suffix ? ".env-" + suffix : ".env");
  const fileEnv = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  const raw = env.ACTIVITY_RETENTION_DAYS || fileEnv.ACTIVITY_RETENTION_DAYS || fromYaml;
  const parsed = parseInt(String(raw ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ACTIVITY_RETENTION_DAYS;
}
```

**Continue in [chunk 1b](kpr-455-plan-1b-view-tests.md)** — Steps 3–7 (the unit suite, the two empirical harness confirmations, the NV2 rehearsal, and this task's single commit). Do not commit from here: the module and its suite land together.
