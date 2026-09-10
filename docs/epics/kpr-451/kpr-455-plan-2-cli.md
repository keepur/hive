# KPR-455 chunk 2 — The CLI and the acknowledgement edge

**Task 2 of 5.** Read [the plan index](kpr-455-plan.md) and all seven chunk files before starting. This chunk creates the whole CLI in one file and one commit — the shell, the two read paths and the edge — plus its dispatch case in `src/cli.ts`. **The three subcommands and the `CliDependencies` seam they share are never separated**, which is the spec's own "Plan shape" constraint.

**Split, and it is a STEP seam rather than a task seam — the second recorded exception.** Chunks 2 and 2b are **one task and one commit**: this file carries Steps 1–3 (`src/cli/ops.ts` and the two `src/cli.ts` edits), [chunk 2b](kpr-455-plan-2b-cli-tests.md) carries Steps 4–8 (the shared fixture module, the suite, verification, NV8 and the commit). A commit that added the dispatch case without its suite would ship an operator-facing command with no coverage; the combined file ran to ~1,100 lines, over this plan's own bound. Read 2 and 2b as one unit.

**Files**

- Create: `src/cli/ops.ts`
- Create: `src/cli/testing/ops-cli-fixtures.ts` and `src/cli/ops.test.ts` (chunk 2b)
- Modify: `src/cli.ts` — usage lines beside `:140-143`, one `case "ops":` beside `:173-181`
- Read-only (verify, never edit): `src/cli/obligations.ts`, `src/db/identity-sentinel.ts`, `src/db/write-guard.ts`, `src/ops/notifier.ts`, `src/ops/notification-types.ts`

**Tier: `capable`.** The edge holds the two rules the spec asks a reviewer to check hardest: `at` is minted once and held fixed across every call in the invocation (so a retry is provably not a second act), and `unavailable` is UNKNOWN rather than failure. Both are one line away from being wrong in a way every happy-path test still passes.

---

## Task 2: `hive ops`

- [ ] **Step 1:** Create `src/cli/ops.ts`.

```typescript
import { parseArgs } from "node:util";
import { ObjectId, type Db } from "mongodb";
import { ZodError } from "zod";
import { setLogLevel } from "../logging/logger.js";
import { verifySentinel } from "../db/identity-sentinel.js";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import { ObligationError } from "../obligations/types.js";
import { selectInstance, type CliDependencies, type CliSelection } from "./obligations.js";
import { OpsNotifier } from "../ops/notifier.js";
import type { OpsAcknowledgement, OpsIntakeRefusal, OpsIntakeResult } from "../ops/notification-types.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  OpsCliError,
  QUIET_TURN_WINDOW_MINUTES,
  ROLLUP_PRODUCER,
  TOOL_HEALTH_STALE_AFTER_MINUTES,
  TOOL_SUBJECT_KIND,
  WORK_STATUS_STALE_AFTER_MINUTES,
  discoveryWindowMs,
  decodeOpsCursor,
  encodeOpsCursor,
  failOps,
  readOpsLogPresence,
  readPipeline,
  readQuietTurns,
  resolveActivityRetentionDays,
  resolveOpenConditions,
  resolveToolHealth,
  scanOpsEvents,
  type OpsCursorSection,
  type ToolHealthRow,
} from "./ops-views.js";

/**
 * KPR-455 — `hive ops health | stalled | ack`.
 *
 * The reader reads; the edge captures and calls. Neither holds policy: there is
 * no owner table, no severity, no recipient, no cadence, no escalation and no
 * hive.yaml key here, and this child registers ZERO rows of KPR-458 D11's third
 * column. The two read paths create nothing and write nothing. The `ack` path's
 * only writes are the ones KPR-468's own code performs — `init()`'s
 * ensureIndexes() and intake's CAS.
 *
 * Structure copied from `runObligations` (src/cli/obligations.ts): explicit
 * instance selection, a sentinel verified BEFORE any read, a WriteGuard-wrapped
 * handle, strict parseArgs, base64url cursors, one JSON document on stdout, and
 * NO init() ON READ PATHS (that file's comment at :139, and store.init() called
 * on `register` alone at :144).
 */

/** ⚠ THE EDGE'S RETRY BUDGET, and it is sized for the fault it actually meets.
 *  KPR-468 names a DETERMINISTIC `unavailable`: the delivery phase holds a
 *  per-row latch for up to 11 s and intake's 5 s deadline covers latch
 *  acquisition. That latch is IN-PROCESS, and this edge hosts its own notifier
 *  in a second process — so the CLI never queues behind the engine's latch and
 *  never meets that path. What it meets is the LOST CAS (kpr-468-design.md:417),
 *  which clears as soon as the colliding tick's write lands, i.e. inside one
 *  round trip. Three attempts at sub-second spacing cover a collision and its
 *  immediate successor; each attempt already carries intake's own 5 s deadline,
 *  so the honest worst case is ~16 s. */
export const ACK_ATTEMPTS = 3;
export const ACK_BACKOFF_MS = [250, 750] as const;

/** The seam AC10 drives against KPR-468's REAL notifier and AC11 drives against
 *  a programmed one. Deliberately the two methods and nothing else: this edge
 *  never calls registerTransport() and never calls start(), because intake
 *  depends on neither and starting a sweep from a CLI would be a second
 *  deliverer. */
export interface OpsNotifierLike {
  init(): Promise<void>;
  accept(input: OpsAcknowledgement): Promise<OpsIntakeResult>;
}

export interface OpsCliDependencies extends CliDependencies {
  makeNotifier(db: Db, activityRetentionDays: number): OpsNotifierLike;
  sleep(ms: number): Promise<void>;
}

export const opsDefaults: OpsCliDependencies = {
  async connect(selection) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(selection.uri, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10_000 });
    try {
      await client.connect();
      return { db: client.db(selection.dbName), close: () => client.close() };
    } catch (err) {
      await client.close();
      throw err;
    }
  },
  clock: () => new Date(),
  emit: (text) => console.log(text),
  makeNotifier: (db, activityRetentionDays) => new OpsNotifier(db, activityRetentionDays),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
};

/**
 * Returns the PROCESS EXIT CODE rather than signalling by throwing, which is a
 * deliberate departure from `runObligations`.
 *
 * src/cli.ts:178 prints a thrown message only when it matches /^[a-z_]+$/, and
 * KPR-468's refusal vocabulary is kebab-case (`row-cleared`,
 * `integrity-dismissal`) — that guard would swallow every one of them into a
 * generic failure string. So CONTRACT REFUSALS ARE DATA in the JSON payload,
 * paired with a returned exit code, and the thrown path stays reserved for
 * CLI-local snake_case tokens (`invalid_command`, `actor_required`,
 * `until_required`, `identity_unverified`, `notifier_init_failed`).
 */
export async function runOps(argv: string[], deps: OpsCliDependencies = opsDefaults): Promise<number> {
  // D8. This repo's logger writes EVERY level below `error` to STDOUT
  // (src/logging/logger.ts:22). The ack path's init() re-runs KPR-454's
  // registry audit, which warns per anomalous row — unguarded, those lines
  // interleave with this command's JSON document and break every `| jq`.
  // Applied UNIFORMLY across all three subcommands so the property is not
  // path-dependent, rather than on `ack` alone. One clause of honesty:
  // setLogLevel sets a module-global seeded from LOG_LEVEL (:5), so this
  // silently overrides an operator's LOG_LEVEL for the life of the process and
  // does not restore it — acceptable for a short-lived CLI whose whole contract
  // is one JSON document on stdout, and genuine errors still reach stderr.
  // The precedent `runObligations` sets nothing; this is a deliberate
  // divergence, not a copy.
  setLogLevel("error");
  try {
    return await executeOps(argv, deps);
  } catch (err) {
    if (err instanceof OpsCliError) throw err;
    // selectInstance's own tokens (config_missing, instance_id_mismatch, …) are
    // already snake_case and already pass src/cli.ts:178's guard.
    if (err instanceof ObligationError) throw err;
    if (err instanceof ZodError) throw new OpsCliError("invalid_input");
    throw new OpsCliError("command_failed");
  }
}

const ACTS = ["seen", "dismissed", "snoozed"] as const;
type Act = (typeof ACTS)[number];

function positiveMinutes(raw: string | undefined, fallback: number, token: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return failOps(token);
  return value;
}

async function executeOps(argv: string[], deps: OpsCliDependencies): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      instance: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: String(DEFAULT_LIMIT) },
      cursor: { type: "string" },
      "stale-after": { type: "string" },
      window: { type: "string" },
      act: { type: "string" },
      actor: { type: "string" },
      until: { type: "string" },
      // ⚠ THERE IS NO `--at`, DELIBERATELY. Offering one would let a caller
      // assert an instant, and an edge that accepts a caller-supplied act time
      // is manufacturing an act it did not witness — the same bar D6 sets
      // against read receipts, channel visits, reactions and elapsed time.
      // `strict: true` is what makes its absence enforceable (AC9).
    },
  });

  const [command, subcommand, handle, extra] = parsed.positionals;
  if (command !== "ops" || extra) return failOps("invalid_command");
  if (!["health", "stalled", "ack"].includes(subcommand ?? "")) return failOps("invalid_command");
  if (subcommand !== "ack" && handle) return failOps("unexpected_handle");
  if (subcommand === "ack" && !handle) return failOps("handle_required");

  const limit = Number(parsed.values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return failOps("invalid_limit");

  // Every local refusal on the ack path is decided HERE, before any connection
  // is opened — "attribute or refuse", and a refusal that needed a database
  // would be neither.
  let act: Act | undefined;
  let snoozedUntil: Date | undefined;
  if (subcommand === "ack") {
    if (!ACTS.includes((parsed.values.act ?? "") as Act)) return failOps("invalid_act");
    act = parsed.values.act as Act;
    // ⚠ `--actor` is REQUIRED, with no default, no $USER fallback and no
    // hostname fallback. Attribution is a record, not an authorization: the
    // edge checks only that a value is present and non-blank and passes it
    // through. Every judgment about the VALUE — including the refusal of the
    // reserved system principal — belongs to intake, and duplicating it here
    // would be a second enforcer of a rule set intake already owns.
    if (!parsed.values.actor?.trim()) return failOps("actor_required");
    if (act === "snoozed") {
      // A snooze with no target is not a pause.
      if (!parsed.values.until?.trim()) return failOps("until_required");
      const until = new Date(parsed.values.until);
      // An UNPARSEABLE value is CLI input this command cannot form, so it is
      // refused locally. A parseable value that is not in the future is passed
      // THROUGH and refused by intake as `snooze-not-future`, because judging
      // the instant is intake's job and this edge holds no policy (edge case 8).
      if (Number.isNaN(until.getTime())) return failOps("invalid_until");
      snoozedUntil = until;
    }
  }

  // ⚠ MINTED EXACTLY ONCE, before anything that can block, and used for BOTH
  // roles: the views' `now` and — on the ack path — the act's own `at`, at full
  // millisecond precision. For a CLI the INVOCATION IS THE ACT, so there is no
  // upstream instant to preserve and no receipt time to substitute. Holding it
  // fixed across every call in this invocation is what makes the retry on
  // `unavailable` a RETRY rather than a second act, and `lastAckKey` is then
  // the mechanism that keeps a possibly-applied `snoozed` from moving the pause
  // twice. A RE-RUN BY THE HUMAN IS NOT THIS: a fresh invocation mints a fresh
  // `at`, derives a different idempotence key, and is a genuinely new act.
  const now = deps.clock();

  const selection = selectInstance(parsed.values);
  const retentionDays = resolveActivityRetentionDays(selection);
  const connection = await deps.connect(selection);
  try {
    // Before ANY read and before any accept(...) — the same guard that keeps a
    // query from answering out of another instance's database, and it matters
    // more on a write path (edge case 9). Read against the RAW handle, as the
    // sentinel contract requires.
    const identity = await verifySentinel(connection.db, {
      instanceId: selection.instanceId,
      dbName: selection.dbName,
    });
    if (identity.state !== "verified") return failOps("identity_unverified");
    const guard = new WriteGuard({ instanceId: selection.instanceId, dbName: selection.dbName });
    const db = guardDb(connection.db, guard);

    let result: unknown;
    let exit = 0;
    if (subcommand === "health") {
      result = await health(db, { now, selection, retentionDays, limit, cursor: parsed.values.cursor, parsed });
    } else if (subcommand === "stalled") {
      result = await stalled(db, { now, selection, retentionDays, limit, cursor: parsed.values.cursor, parsed });
    } else {
      const acked = await runAck(db, deps, {
        now,
        retentionDays,
        input: {
          handle: handle!,
          act: act!,
          actorId: parsed.values.actor!.trim(),
          at: now,
          ...(snoozedUntil ? { snoozedUntil } : {}),
        },
      });
      result = acked.result;
      exit = acked.exit;
    }
    // Exactly one JSON document on stdout, on every path. `--json` selects
    // compact over indented, the precedent at src/cli/obligations.ts:185.
    deps.emit(JSON.stringify(result, null, parsed.values.json ? undefined : 2));
    return exit;
  } finally {
    await connection.close();
  }
}

interface ReadOptions {
  now: Date;
  selection: CliSelection;
  retentionDays: number;
  limit: number;
  cursor: string | undefined;
  parsed: { values: { "stale-after"?: string; window?: string } };
}

function page<T>(
  rows: T[],
  limit: number,
  cursor: string | undefined,
  section: OpsCursorSection,
  owner: string,
  key: (row: T) => string,
): { rows: T[]; nextCursor: string | null; truncated: boolean } {
  const after = decodeOpsCursor(cursor, section, owner);
  const remaining = after ? rows.filter((row) => key(row) > after) : rows;
  const slice = remaining.slice(0, limit);
  const truncated = remaining.length > slice.length;
  const last = slice.at(-1);
  return {
    rows: slice,
    nextCursor: truncated && last ? encodeOpsCursor(section, owner, key(last)) : null,
    truncated,
  };
}

/**
 * (b) The tool-health rollup.
 *
 * Scoped `producer: hive-runtime` + `subject.kind: tool` — KPR-458 D8's own
 * scoping and KPR-454 D4's own subject. Clearing events are identified
 * STRUCTURALLY by the presence of `clears`, never by hardcoding the reason id,
 * which keeps the resolver generic within the producer (C16).
 *
 * `activity_log` cannot answer this question at all: it carries `toolCalls` (a
 * count) and `toolSummary` (a name×count string) at src/activity/types.ts:25-26
 * and NO per-tool outcome, so `ops_events` is the only source, which is why the
 * rollup is empty until KPR-454 has been running.
 */
async function health(db: Db, opts: ReadOptions): Promise<unknown> {
  const staleAfterMinutes = positiveMinutes(
    opts.parsed.values["stale-after"],
    TOOL_HEALTH_STALE_AFTER_MINUTES,
    "invalid_stale_after",
  );
  const horizonMs = staleAfterMinutes * 60_000;
  const windowMs = discoveryWindowMs(horizonMs);
  const retentionMs = opts.retentionDays * 86_400_000;
  const presence = await readOpsLogPresence(db, opts.now);
  const scan = await scanOpsEvents(db, {
    now: opts.now,
    windowMs,
    scope: { producer: ROLLUP_PRODUCER, "subject.kind": TOOL_SUBJECT_KIND },
  });
  const rollup = resolveToolHealth(scan.events, { now: opts.now, horizonMs, logPresent: presence.present });
  const pipeline = await readPipeline(db, opts.now);
  const paged = page<ToolHealthRow>(
    rollup.rows,
    opts.limit,
    opts.cursor,
    "tools",
    opts.selection.instanceId,
    (row) => `${row.tool} ${row.errorSig}`,
  );
  const truncatedByRetention = horizonMs > retentionMs;
  return {
    command: "ops.health",
    instanceId: opts.selection.instanceId,
    generatedAt: opts.now,
    producer: ROLLUP_PRODUCER,
    subjectKind: TOOL_SUBJECT_KIND,
    staleAfterMinutes,
    discovery: {
      fromAt: scan.fromAt,
      windowMinutes: Math.round(windowMs / 60_000),
      scannedEvents: scan.scannedEvents,
      scanCapped: scan.scanCapped,
      truncatedByRetention,
      retentionDays: opts.retentionDays,
    },
    log: presence,
    summary: rollup.summary,
    tools: paged.rows,
    pagedSection: "tools",
    nextCursor: paged.nextCursor,
    truncated: paged.truncated,
    pipeline,
    // D2: every sentence this command promises is a STRING FIELD on the result
    // object, assertable by a test on the payload rather than dependent on a
    // rendering nobody has fixed.
    notes: {
      absenceIsNotHealth:
        "A tool that is not listed here is not reported healthy. It published no fact inside the discovery window, and absence is not health.",
      staleIsUnknown:
        "Past the staleness horizon the outcome is `unknown` — never `healthy`, never `resolved`, never `ok`. A self-reported recovery is a fact like any other and is subject to the same horizon.",
      newestEventIsNotHealth:
        "`log.newestEventAt` is last-known publisher activity, NOT a health signal: a healthy fleet legitimately publishes nothing for days, and this reader cannot distinguish 'no tool failed' from 'the publisher was never set'.",
      recoveryClearsEveryErrorSig:
        "A recovery carries no `errorSig`, so a recovery for a tool resolves every `errorSig` row for that tool.",
      limitIsNotAScanBound:
        "`--limit` caps output rows, not documents scanned. The discovery window and the ops-event retention are what bound this command.",
      discoveryWindow:
        "Absence means 'published no fact inside the discovery window', never 'never'. The window is always at least as wide as the staleness horizon.",
      ...(truncatedByRetention
        ? {
            truncatedByRetention: `The requested staleness horizon exceeds this instance's ops-event retention (${opts.retentionDays} days), so results are bounded by retention rather than by the horizon.`,
          }
        : {}),
      ...(presence.present
        ? {}
        : {
            noOpsEventLog:
              "No ops event log on this instance: KPR-454's publisher has never run here, or the log has aged out. This is not a statement that nothing is failing.",
          }),
    },
  };
}

/**
 * (a) The stalled-work view — TWO ARMS, rendered as two labelled sections and
 * never merged. They answer different questions from different stores with
 * different keys and different horizons; a combined "stalled work" number over
 * both would be an invented aggregate with no meaning, and inventing one is the
 * shape of a severity axis.
 */
async function stalled(db: Db, opts: ReadOptions): Promise<unknown> {
  const staleAfterMinutes = positiveMinutes(
    opts.parsed.values["stale-after"],
    WORK_STATUS_STALE_AFTER_MINUTES,
    "invalid_stale_after",
  );
  const windowMinutes = positiveMinutes(opts.parsed.values.window, QUIET_TURN_WINDOW_MINUTES, "invalid_window");
  const horizonMs = staleAfterMinutes * 60_000;
  const discoveryMs = discoveryWindowMs(horizonMs);
  const retentionMs = opts.retentionDays * 86_400_000;
  const presence = await readOpsLogPresence(db, opts.now);
  const scan = await scanOpsEvents(db, { now: opts.now, windowMs: discoveryMs });
  const open = resolveOpenConditions(scan.events, { now: opts.now, horizonMs });
  const quiet = await readQuietTurns(db, {
    now: opts.now,
    windowMs: windowMinutes * 60_000,
    limit: opts.limit,
    owner: opts.selection.instanceId,
    cursor: opts.cursor,
  });
  const pipeline = await readPipeline(db, opts.now);
  const openRows = open.slice(0, opts.limit);
  return {
    command: "ops.stalled",
    instanceId: opts.selection.instanceId,
    generatedAt: opts.now,
    openConditions: {
      staleAfterMinutes,
      discovery: {
        fromAt: scan.fromAt,
        windowMinutes: Math.round(discoveryMs / 60_000),
        scannedEvents: scan.scannedEvents,
        scanCapped: scan.scanCapped,
        truncatedByRetention: horizonMs > retentionMs,
        retentionDays: opts.retentionDays,
      },
      log: presence,
      rows: openRows,
      truncated: open.length > openRows.length,
    },
    quietTurns: quiet,
    pagedSection: "quietTurns.recent",
    nextCursor: quiet.nextCursor,
    pipeline,
    notes: {
      twoArms:
        "Two arms, two questions, two stores. `openConditions` is published ops-event state; `quietTurns` is measured turn outcome. They are never combined into one number.",
      matchedAtPublish:
        "`matchedAtPublish` is the count of subscriptions matched AT PUBLICATION, with the instant it describes. It is a past-tense fact: a zero does not mean nobody is listening now, and a nonzero does not mean somebody is.",
      openConditionsArmIsEmpty:
        "This arm is generic over any subject kind and is expected to be empty today: no chartered producer publishes workItem-subject conditions, and KPR-454 keys deliberately on the tool.",
      informationalNeverClears:
        "An `informational` condition has no clearing act (KPR-458 D3), so it stays listed. That is the class's meaning, not a defect.",
      unrecognizedClassStaysOpen:
        "A condition whose stored class this reader does not recognize renders `unknown` and STAYS OPEN — a clearing fact against it is not treated as class-legal.",
      quietTurnsHaveNoPushPath:
        "Quiet turns live in `activity_log`. Nothing publishes them into `ops_events`, so no subscription can match them and no notifier can nudge on them: this view is pull only.",
      noErrorText:
        "This view reports THAT an outcome flag was set, never the `error` string. A caller who needs it reads the row in Mongo, deliberately.",
      ...(quiet.measurable
        ? {}
        : {
            unmeasurableWindow:
              "No turn rows at all in this window — activity logging may be disabled or the collection may be absent. This is 'unmeasurable', not 'no failures'.",
          }),
    },
  };
}

const REFUSAL_MESSAGES: Record<OpsIntakeRefusal, string> = {
  "unknown-handle": "No ledger row resolves from this handle on this instance. Copy the `ref:` line from the message.",
  unattributed: "Intake refused the actor id. An act must be attributed to a real principal.",
  "row-cleared": "The condition resolved between the delivery and this act. Nothing was recorded, and nothing is owed.",
  "integrity-dismissal": "An `integrity` condition cannot be dismissed. It clears only on authoritative evidence.",
  "snooze-not-future": "`--until` is not in the future relative to the act. A snooze with no future target is not a pause.",
  "illegal-transition": "The row's current state does not admit this act.",
};

/**
 * (c) The KPR-458 D6 inbound acknowledgement edge.
 *
 * ONE ACT PER INVOCATION, and the only permitted repeat is the IDENTICAL
 * `(actorId, act, at)` tuple on `unavailable` — which KPR-468's intake asks for
 * by name (kpr-468-plan-4-intake.md:307-314): "`unavailable` means UNKNOWN, NOT
 * 'did not apply', and it is SAFE TO RETRY … a retry of the SAME
 * (actorId, act, at) is the correct response, because `lastAckKey` makes it
 * return `{ state: 'noop', reason: 'already-applied' }` if it did land and
 * apply it if it did not. An edge that treats `unavailable` as a failure and
 * surfaces an error to the human is reading it wrong."
 *
 * The edge reads no ledger, reads no ops_subscriptions and holds no state. It
 * does not pre-validate the handle, pre-check the transition or pre-clamp the
 * snooze: each would be the edge holding policy, D6 bars all three, and each
 * would be a second enforcer of a rule set intake already owns.
 */
async function runAck(
  db: Db,
  deps: OpsCliDependencies,
  opts: { now: Date; retentionDays: number; input: OpsAcknowledgement },
): Promise<{ result: unknown; exit: number }> {
  const notifier = deps.makeNotifier(db, opts.retentionDays);
  try {
    // D8: required, not optional — KPR-468 D10 fixes `{ state: "unavailable" }`
    // for a notifier whose init() did not complete. On a cold instance this
    // MATERIALISES ops_notifications and its indexes: the sibling's schema, by
    // the sibling's own idempotent code. registerTransport() and start() are
    // never called.
    await notifier.init();
  } catch {
    // ⚠ The one init() fault that means THE LEDGER'S IDENTITY INDEX IS
    // UNAVAILABLE. Reported as a CLI-local failure and NEVER as
    // `unknown-handle` (which would tell the operator their handle was wrong
    // when their database is) and never as `unavailable`. snake_case so
    // src/cli.ts:178's /^[a-z_]+$/ guard passes the token through. No
    // accept(...) call is made.
    return failOps("notifier_init_failed");
  }

  let outcome: OpsIntakeResult = { state: "unavailable" };
  let attempts = 0;
  for (let attempt = 0; attempt < ACK_ATTEMPTS; attempt += 1) {
    attempts = attempt + 1;
    // THE IDENTICAL TUPLE, every time. `opts.input` is never rebuilt.
    outcome = await notifier.accept(opts.input);
    if (outcome.state !== "unavailable") break;
    if (attempt < ACK_ATTEMPTS - 1) await deps.sleep(ACK_BACKOFF_MS[attempt] ?? 0);
  }
  return renderAck(outcome, opts.input, attempts);
}

export function renderAck(
  outcome: OpsIntakeResult,
  input: OpsAcknowledgement,
  attempts: number,
): { result: unknown; exit: number } {
  const base = {
    command: "ops.ack",
    handle: input.handle,
    act: input.act,
    actor: input.actorId,
    at: input.at,
    attempts,
  };
  switch (outcome.state) {
    case "applied":
      return {
        result: {
          ...base,
          result: "applied",
          rowState: outcome.rowState,
          // D7: `snoozedUntil` is read ONLY on an applied result whose rowState
          // is `snoozed`. It is retained-but-inert on a cleared or reopened
          // row, so rendering it anywhere else would be reading a fact that is
          // not one.
          ...(outcome.rowState === "snoozed" && outcome.snoozedUntil ? { snoozedUntil: outcome.snoozedUntil } : {}),
          confirmed: true,
          message:
            outcome.rowState === "snoozed"
              ? "Applied. `snoozedUntil` is the CLAMPED value intake actually wrote, which may be earlier than the one requested."
              : "Applied.",
        },
        exit: 0,
      };
    case "noop":
      return {
        result: {
          ...base,
          result: "noop",
          reason: outcome.reason,
          confirmed: true,
          message:
            outcome.reason === "already-applied"
              ? "Already applied. This act was recorded before; nothing changed."
              : "Superseded by a later act on this row. Nothing changed.",
        },
        exit: 0,
      };
    case "refused":
      return {
        result: {
          ...base,
          result: "refused",
          reason: outcome.reason,
          confirmed: true,
          // D7 step 4: `row-cleared` is BENIGN. The condition resolved between
          // the delivery and the click; nothing is recorded and this edge must
          // not surface it as an error the human has to handle.
          ...(outcome.reason === "row-cleared" ? { benign: true } : {}),
          message: REFUSAL_MESSAGES[outcome.reason],
        },
        exit: outcome.reason === "row-cleared" ? 0 : 1,
      };
    default:
      return {
        result: {
          ...base,
          result: "unavailable",
          confirmed: false,
          message:
            `UNKNOWN — not "nothing was recorded". The act ${input.act} on handle ${input.handle} at ` +
            `${input.at.toISOString()} MAY have applied; this command retried the identical act and could not confirm it. ` +
            `Exit 1 means NOT CONFIRMED, not failed. ` +
            (input.act === "snoozed"
              ? "`--until` is absolute and re-snoozing MOVES the pause rather than extending it, so a re-run with the same `--until` yields the same instant unless it exceeded the 7-day hard ceiling. Re-check before re-running — this command ships no ledger view, so that means the notifier's next nudge or a deliberate Mongo read — and if the pause did land longer than wanted, one further `hive ops ack <handle> --act seen` ends it."
              : "`seen` and `dismissed` are effect-idempotent, so re-running is harmless whatever happened."),
        },
        exit: 1,
      };
  }
}

/** Exported for the test that asserts a handle is copied VERBATIM and never
 *  parsed by this edge — the value is opaque by contract. */
export function handleIsOpaqueTo(input: OpsAcknowledgement): boolean {
  return typeof input.handle === "string" && !(input.handle as unknown as ObjectId | undefined)?.toHexString;
}
```

⚠ **`handleIsOpaqueTo` earns its place or it goes.** It exists so AC9's "the edge parses nothing out of the handle" limb has something to assert against rather than being a claim about code nobody reads. If the implementer finds a cleaner assertion — a source scan for `ObjectId(` inside `src/cli/ops.ts`, say — prefer that and delete this helper; do **not** keep both.

- [ ] **Step 2:** Add the usage lines to `src/cli.ts`. Insert immediately after the existing `obligations deactivate` line (`:143` at this tree — key on the string, not the number).

```typescript
  obligations deactivate <obligation-id> --reason <text>
  ops health [--stale-after <minutes>] [--limit <n>] [--json]
  ops stalled [--stale-after <minutes>] [--window <minutes>] [--json]
  ops ack <handle> --act <seen|dismissed|snoozed> --actor <id> [--until <iso8601>]
```

- [ ] **Step 3:** Add the dispatch case to `src/cli.ts`, immediately after the closing brace of `case "obligations": { … }` (`:182` at this tree).

```typescript
  case "ops": {
    try {
      const { runOps } = await import("./cli/ops.js");
      // runOps RETURNS the exit code: KPR-468's refusal tokens are kebab-case
      // and would be swallowed by the /^[a-z_]+$/ guard below, so contract
      // refusals travel as data in the JSON payload with a nonzero exit.
      process.exitCode = await runOps(process.argv.slice(2));
    } catch (err) {
      console.error(err instanceof Error && /^[a-z_]+$/.test(err.message) ? err.message : "ops_command_failed");
      process.exitCode = 1;
    }
    break;
  }
```

**Continue in [chunk 2b](kpr-455-plan-2b-cli-tests.md)** — Steps 4–8 (the shared fixture module, the CLI suite, verification, NV8, and this task's single commit). Do not commit from here: `src/cli/ops.ts`, the two `src/cli.ts` edits, the fixtures and the suite land in one commit.
