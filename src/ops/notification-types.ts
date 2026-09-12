/**
 * KPR-468 (D2, D7, D9): the acknowledgement ledger's own types.
 *
 * KPR-454's `src/ops/types.ts` is a FROZEN surface this child consumes and
 * never edits (D12, integration point 3). Everything the ledger adds lives
 * here instead.
 */
import type { ObjectId } from "mongodb";
import type { OpsClass, OpsDetail, OpsEvidence, OpsRetry, OpsSubject, Waiting } from "./types.js";
// D6's two closed reason sets, imported so `NotificationAttempt.reason` can be
// typed CLOSED rather than as an open string — see that field's comment. This
// makes transport.ts ↔ notification-types.ts a cycle, and it is inert: both
// edges are `import type`, which this repo's tsconfig erases entirely (no
// `verbatimModuleSyntax`, `module: Node16`), so no runtime import is emitted in
// either direction. The alternative — declaring the two unions here and
// re-exporting them from transport.ts — was declined to keep D6's three closed
// sets transcribed verbatim in ONE file, which is what chunk 1's second
// prohibition is about.
import type { NonacceptanceReason, UncertaintyReason } from "./transport.js";

export const OPS_NOTIFICATIONS_COLLECTION = "ops_notifications";
export const OPS_POLICY_COLLECTION = "ops_policy";
/** The single operator-written policy document's `_id`. ZERO rows ship (D1). */
export const OPS_POLICY_ID = "ops";

/**
 * D7 rule 5 / D9: the reserved system principal — a fixed non-human id no
 * person or agent may hold, recorded on every unattended transition.
 *
 * The SHAPE is fixed here rather than left to prose, because "unambiguously
 * non-human" is a judgment a later reader re-makes. The embedded colon is a
 * character neither namespace that supplies a real actorId is expected to
 * produce: an agent_definitions id is lowercase-with-hyphens (CLAUDE.md,
 * Conventions) and a Slack user id is U/W plus uppercase alphanumerics.
 *
 * ⚠ That is a CONVENTION claim, not a checked one — the agent-id shape is
 * described in the admin tool's zod schema (src/admin/admin-mcp-server.ts:519)
 * but is regex-enforced NOWHERE, so a hand-inserted document could in
 * principle hold a colon. What makes the property safe is the DIRECTION of
 * the failure: an actor presenting this id is REFUSED by intake step 2 (D7),
 * never impersonated, so a collision costs that actor their acknowledgement
 * and costs the ledger nothing.
 */
export const OPS_SYSTEM_PRINCIPAL = "system:ops";

/** D7's closed six. Contract — nothing may be added to it here. */
export type OpsNotificationState = "pending" | "delivered" | "seen" | "dismissed" | "snoozed" | "cleared";

/**
 * D9: retained while WORKING, TTL'd from stateAt once STOPPED. These two
 * arrays are a partition of OpsNotificationState and `expiresAtFor` below is
 * a total map over it — deliberately NOT an enumeration of transitions, which
 * is what got `seen → snoozed` missed in an earlier draft of the spec.
 */
export const OPS_STOPPED_STATES = ["seen", "dismissed", "cleared"] as const;
export const OPS_WORKING_STATES = ["pending", "delivered", "snoozed"] as const;
/**
 * D5: the two states that carry a `nextNudgeAt` at all. Every transition OUT
 * of one unsets it, which is what makes "no non-working row is in any
 * delivery arm's index range" a type-bracketing property rather than a
 * convention — and what lets arm 2's index carry no `state` key.
 */
export const OPS_NUDGE_STATES = ["pending", "delivered"] as const;

/**
 * D2: a CLOSED union, one member per decline branch in D5's step list, and
 * nothing else. This is the one field on the row shaped like a future
 * error-message sink: a widened one would carry adapter or driver text onto
 * the ledger (C13) and would still pass AC12's negative test, whose
 * substrings are credential- and path-shaped rather than prose-shaped. The
 * union is also what makes the three gauges' `{stalledReason, state}` index a
 * bounded three-valued key rather than an open one.
 */
export type StalledReason = "subscription" | "cadence" | "transport";

export type AttemptOutcome = "accepted" | "rejected" | "unknown";

/**
 * D7/D2: one entry of the `attempts[]` RING. Never a rendered string, never a
 * raw transport error — `reason` is only ever a member of D6's two closed
 * reason sets (C13, and the KPR-457 canon that raw diagnostics stay out of
 * allow-listed fields).
 *
 * The field is therefore TYPED closed, not merely documented closed. It is the
 * one field on this row an adapter's own output flows into verbatim
 * (`record()` writes `outcome.reason`), so an open `string` here would make
 * C13 a convention rather than a compile error — the same argument
 * `StalledReason` is closed for, applied to the field that actually receives
 * adapter data.
 */
export interface NotificationAttempt {
  at: Date;
  outcome: AttemptOutcome;
  reason?: NonacceptanceReason | UncertaintyReason;
  adapterId: string;
}

/** D6: a reference, never a URL (C13). */
export interface DeliveryReference {
  kind: string;
  id: string;
}

/**
 * D2: the `ops_notifications` document. D7's field list is contract and is
 * carried verbatim; the engine-internal additions are grouped at the bottom
 * so a reader can tell contract from mechanism at a glance. Nothing added is
 * a new FACT — every one is a watermark, a TTL derivation, or a snapshot of a
 * value the accept path already validated against its registry allow-list.
 */
export interface OpsNotification {
  /** Its hex string is the D6 acknowledgement handle. */
  _id?: ObjectId;
  subscriptionId: string;
  subscriberId: string;

  // D7 snapshot, so a reader needs no join.
  dedupeKey: string;
  producer: string;
  reasonId: string;
  class: OpsClass;
  waiting: Waiting;
  retry: OpsRetry;
  subject: OpsSubject;
  generation: number;

  // D7 event linkage. Every event reference on this row is the ObjectId's
  // 24-char lowercase HEX STRING, not an ObjectId. Hex order is byte-identical
  // to ObjectId order, KPR-454's own resolver already treats `String(_id)` as
  // the canonical total order, and it keeps the apply-if-newer comparison a
  // plain string comparison in both the driver and the test double.
  firstEventId: string;
  latestEventId: string;
  eventCount: number;
  firstSeenAt: Date;
  lastEventAt: Date;

  // D7 state.
  state: OpsNotificationState;
  stateAt: Date;
  principal: string;
  principalAt: Date;
  snoozedUntil?: Date;

  // D7 delivery.
  attempts: NotificationAttempt[];
  attemptCount: number;
  /** The LAST attempt's outcome — which, until a reopened row's first new attempt, is the previous occurrence's. */
  lastOutcome?: AttemptOutcome;
  /**
   * OCCURRENCE-scoped: set by an accepted outcome, unset only by the
   * `cleared → pending` reopen. Its presence is "accepted in this occurrence",
   * which is what snooze expiry's `delivered`-or-`pending` choice reads.
   */
  deliveryReference?: DeliveryReference;

  // D7 nudging.
  nudgeCount: number;
  lastNudgeAt?: Date;
  nextNudgeAt?: Date;

  // ── engine-internal, this child's ──
  /** D3: the (publishedAt, _id) watermark that makes every application idempotent. */
  appliedThroughAt: Date;
  appliedThroughId: string;
  /** D7's table: the event evidencing a clear or a reopen. */
  stateEventId?: string;
  /** Snapshot of the latest applied event's allow-listed detail/evidence, so delivery reads no event. */
  latestDetail: OpsDetail;
  latestEvidence: OpsEvidence[];
  /** D7 intake idempotence: `${actorId}:${act}:${at.toISOString()}` of the last applied act, from the RAW `at`. */
  lastAckKey?: string;
  /** D7 intake monotonicity: the clock-ANCHORED instant of the last applied act. */
  lastAckAt?: Date;
  /** D5: sparse `true`; a non-cadence re-delivery is owed (reopen, snooze expiry). */
  forceDeliver?: true;
  /** D5: sparse; the tick declined to attempt this row and why. */
  stalledAt?: Date;
  stalledReason?: StalledReason;
  /** D9: set only while the row is STOPPED; the TTL index keys on it. */
  expiresAt?: Date;
}

/**
 * D1/D5: the single operator-written policy document. ZERO rows ship — its
 * content is the deployment gate, and D11 makes every value here operator
 * data an engineering child may not supply (KPR-456 canon).
 */
export interface OpsPolicy {
  _id: string;
  /** D8's table, keyed exactly as D8 keys it: `<class>:<retry>`. At most 8 entries. */
  cadence?: Record<string, number>;
  /** D5's named cadence profiles. A profile SUBSTITUTES the table wholesale. */
  profiles?: Record<string, number>;
  minNudgeIntervalMs?: number;
  maxSnoozeMs?: number;
}

// ── Acknowledgement intake (D7) — the seam KPR-455's inbound edge calls ──

export type OpsAck = "seen" | "dismissed" | "snoozed";

export interface OpsAcknowledgement {
  /** The handle from the NotificationView; opaque, never parsed by the caller. */
  handle: string;
  act: OpsAck;
  /** A stable id — a Slack user id, an agent slug; never a display name. */
  actorId: string;
  /** The instant of the VENDOR act, not the edge's receipt time. */
  at: Date;
  /** Required for "snoozed". */
  snoozedUntil?: Date;
}

export type OpsIntakeRefusal =
  | "unknown-handle"
  | "unattributed"
  | "row-cleared"
  | "integrity-dismissal"
  | "snooze-not-future"
  | "illegal-transition";

export type OpsIntakeResult =
  | { state: "applied"; rowState: OpsNotificationState; snoozedUntil?: Date }
  | { state: "noop"; reason: "already-applied" | "superseded" }
  | { state: "refused"; reason: OpsIntakeRefusal }
  | { state: "unavailable" };

// ── D8's counters ──

/**
 * D8: exposed by getSnapshot() and mirrored to the heartbeat. `ingestFaults`
 * is deliberately SEPARATE from `sweepFaults`: it is the one counter whose
 * RATE AGAINST A STATIC cursorAt distinguishes a transient fault from a
 * wedged ingest (D8(b)), and collapsing the two loses that signal.
 */
export interface OpsNotifierCounters {
  eventsApplied: number;
  rowsCreated: number;
  rowsRenewed: number;
  renewalStale: number;
  rowsCleared: number;
  clearRefused: number;
  clearNoRow: number;
  deliveriesAccepted: number;
  deliveriesRejected: number;
  deliveriesUnknown: number;
  transportFaults: number;
  /**
   * D8: the record write that did not land. It counts the one write in this
   * component that happens AFTER an irreversible external side effect (a
   * posted Slack message, its ts already registered), on ALL THREE of its
   * failure shapes — a lost CAS, a write that threw, and a write withheld
   * because KPR-294's write guard engaged during the post — so a miss loses
   * the attempt's whole record, and a row still in a working state can be
   * re-attempted: a duplicate post with no ledger trace.
   *
   * The three shapes are treated IDENTICALLY everywhere, and that is
   * deliberate: each one marks the delivery phase not-ok, so the tick's
   * heartbeat reads `degraded` whichever shape fired. A lost CAS is not the
   * milder of them — no in-process writer can cause one (below), so it means
   * a writer OUTSIDE this process's latch moved a row mid-post (a second
   * engine, a hand edit), which an operator needs to see at least as much as
   * a storage fault.
   *
   * The lost-CAS shape is kept from firing by the per-row latch TOGETHER WITH
   * the delivery phase's pre-post re-read (delivery.ts, attemptRow step 4) —
   * the latch alone did not, because the arm's scan copy predates it. With
   * both, no in-process writer can reach it; it is COUNTED rather than left
   * silent because those two mechanisms are exactly what a future edit
   * changes. The thrown shape is an ordinary storage fault and is reachable
   * whenever Mongo is. The withheld shape is bounded to ONE post per
   * engagement: every tick after it is skipped whole (identityUnverifiedSkips).
   */
  deliveryRecordLost: number;
  subscriptionUnresolved: number;
  transportUnbound: number;
  cadenceUnresolved: number;
  reasonUnknown: number;
  subscriptionUnloaded: number;
  intakeApplied: number;
  intakeNoop: number;
  intakeRefused: number;
  intakeUnavailable: number;
  /** D7: an `at` that was not a usable Date and was substituted with `now`. */
  intakeInvalidAt: number;
  cursorReinitialized: number;
  ingestFaults: number;
  sweepFaults: number;
  subscriptionReloadFaults: number;
  policyReadFaults: number;
  indexFailures: number;
  /**
   * KPR-294/KPR-456: a sweep tick that did nothing — or stopped short at a
   * phase or row boundary — because the DB identity write guard was engaged.
   * At most one per tick. While engaged the tick reads nothing, posts nothing
   * and writes nothing (its heartbeat included, which the guard would refuse
   * anyway), so this counter reaches the heartbeat on the first tick after
   * the guard disengages; getSnapshot() carries it live.
   */
  identityUnverifiedSkips: number;
}

export function freshCounters(): OpsNotifierCounters {
  return {
    eventsApplied: 0,
    rowsCreated: 0,
    rowsRenewed: 0,
    renewalStale: 0,
    rowsCleared: 0,
    clearRefused: 0,
    clearNoRow: 0,
    deliveriesAccepted: 0,
    deliveriesRejected: 0,
    deliveriesUnknown: 0,
    transportFaults: 0,
    deliveryRecordLost: 0,
    subscriptionUnresolved: 0,
    transportUnbound: 0,
    cadenceUnresolved: 0,
    reasonUnknown: 0,
    subscriptionUnloaded: 0,
    intakeApplied: 0,
    intakeNoop: 0,
    intakeRefused: 0,
    intakeUnavailable: 0,
    intakeInvalidAt: 0,
    cursorReinitialized: 0,
    ingestFaults: 0,
    sweepFaults: 0,
    subscriptionReloadFaults: 0,
    policyReadFaults: 0,
    indexFailures: 0,
    identityUnverifiedSkips: 0,
  };
}

// ── The numeric bounds (plan index, "Numeric bounds resolved at plan time") ──
// No hive.yaml key ships for any of these; each is a code change.

export const SWEEP_INTERVAL_MS = 30_000;
export const SUBSCRIPTION_RELOAD_MS = 60_000;
export const INGEST_PAGE_SIZE = 200;
export const INGEST_EVENT_BUDGET = 1_000;
export const EXPIRY_PAGE_SIZE = 200;
export const DELIVERY_BUDGET_MS = 10_000;
/**
 * Bounds the READ per delivery arm. Far larger than a tick can attempt
 * (DELIVERY_BUDGET_MS / ATTEMPT_SPACING_MS ≈ 10), so it never decides WHAT is
 * delivered — it only keeps an arm's scan from materializing a huge ledger.
 * Declared here with every other bound rather than being appended by chunk 3:
 * a "complete new-file payload" a later chunk edits is the one place this
 * plan's completeness rule would have bent, for no gain.
 */
export const DELIVERY_ARM_PAGE_SIZE = 200;
export const ATTEMPT_SPACING_MS = 1_000;
/** Half of KPR-456's 20 s: a 20 s hang would let one row consume two-thirds of a 30 s tick. */
export const SLACK_POST_TIMEOUT_MS = 10_000;
export const INTAKE_DEADLINE_MS = 5_000;
export const GAUGE_COUNT_LIMIT = 500;
export const STALL_RECHECK_MS = 300_000;
export const STALL_JITTER_FRACTION = 0.2;
/** D7: a contract-fixed cap chosen by the implementing child, and not large. */
export const ATTEMPTS_RING_CAP = 5;
/**
 * D7/D12: the contract-side ceiling that makes a clamp ALWAYS exist. A
 * registered `maxSnoozeMs` can only tighten it. Without it an unregistered
 * deployment would admit an unbounded snooze — the terminal state ruling 2
 * forbids, reachable through a surface D6 opens to an agent tool call.
 */
export const HARD_SNOOZE_CEILING_MS = 7 * 86_400_000;
/** D9: the behavioural half must age before the event log, for ANY operator setting. */
export const LEDGER_RETENTION_CAP_DAYS = 30;

export function ledgerRetentionDays(activityRetentionDays: number): number {
  return Math.min(LEDGER_RETENTION_CAP_DAYS, activityRetentionDays);
}

/**
 * D9, stated as an INVARIANT on the resulting state rather than as a list of
 * transitions: every write that changes `state` also writes `expiresAt`, to
 * `stateAt + retention` when the new state is stopped and to UNSET otherwise.
 * Returns `undefined` for "unset it".
 *
 * The enumeration form is what missed `seen → snoozed` in an earlier draft:
 * a `seen` row carries a live expiresAt, and a subscriber who then snoozes it
 * moves it into a WORKING state, where a retained TTL would delete it mid-pause.
 */
export function expiresAtFor(state: OpsNotificationState, stateAt: Date, retentionDays: number): Date | undefined {
  return (OPS_STOPPED_STATES as readonly string[]).includes(state)
    ? new Date(stateAt.getTime() + retentionDays * 86_400_000)
    : undefined;
}

/**
 * D5: a bounded, jittered re-check for a row the tick declined. Exported so
 * the delivery phase and its tests share one derivation. Jitter is a FRACTION
 * so the de-herding scales if the interval is ever changed.
 */
export function stallRecheckAt(now: Date, random: () => number = Math.random): Date {
  const jitter = (random() * 2 - 1) * STALL_RECHECK_MS * STALL_JITTER_FRACTION;
  return new Date(now.getTime() + STALL_RECHECK_MS + jitter);
}
