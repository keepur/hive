# KPR-468 plan — chunk 1: types and the transport interface

Implements design **D2** (the row shape, the closed unions, the reserved principal), **D6** (the transport interface, `NotificationView`, `remediation`, the one adapter) and **D9**'s `expiresAt` state invariant as a pure function. One task, one commit — Task 2, the Slack adapter, is in [chunk 1b](kpr-468-plan-1b-slack-transport.md), split off at the task seam to keep both files under the 1,000-line bound.

This chunk is written first because it is what keeps chunks 2, 3 and 4 independent: ingest, delivery and intake all mutate the same row, and the spec is explicit that the type module is what makes the split work rather than a stylistic preference ("Chunks 2, 3 and 4 all touch the same row shape, so the type module in chunk 1 is what keeps them independent; do not attempt one chunk").

**Two prohibitions that hold for this chunk AND for chunk 1b.**

- **`src/ops/**` imports nothing from `src/obligations/**`.** Not the `escapeSlack` helper, not `NONACCEPTANCE`, not `PostOutcome`, not the `ObligationPoster` interface. KPR-456's poster is a separate contract that epic canon preserves in force, and a DRY-motivated import would make one contract's change a silent change to the other. What is copied is the _hardening_, item for item, by re-writing it here. `src/ops/notifier-isolation.test.ts` (chunk 6) asserts the absence of the import.
- **The three closed sets in `transport.ts` are KPR-458 D6 verbatim and are never extended by an adapter.** `DeliveryOutcome`, `NonacceptanceReason`, `UncertaintyReason`. An adapter maps everything it cannot prove to `unknown`.

---

### Task 1: `notification-types.ts` and `transport.ts`

**Files:**

- Create: `src/ops/notification-types.ts`
- Create: `src/ops/transport.ts`
- Create: `src/ops/notification-types.test.ts`
- Create: `src/ops/transport.test.ts`

- [ ] **Step 1:** Create `src/ops/notification-types.ts`.

Read the inline comments as normative — four of them record a decision against a named alternative.

```typescript
/**
 * KPR-468 (D2, D7, D9): the acknowledgement ledger's own types.
 *
 * KPR-454's `src/ops/types.ts` is a FROZEN surface this child consumes and
 * never edits (D12, integration point 3). Everything the ledger adds lives
 * here instead.
 */
import type { ObjectId } from "mongodb";
import type { OpsClass, OpsDetail, OpsEvidence, OpsRetry, OpsSubject, Waiting } from "./types.js";

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
 */
export interface NotificationAttempt {
  at: Date;
  outcome: AttemptOutcome;
  reason?: string;
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
  lastOutcome?: AttemptOutcome;
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
  subscriptionUnresolved: number;
  transportUnbound: number;
  cadenceUnresolved: number;
  reasonUnknown: number;
  subscriptionUnloaded: number;
  intakeApplied: number;
  intakeNoop: number;
  intakeRefused: number;
  intakeUnavailable: number;
  cursorReinitialized: number;
  ingestFaults: number;
  sweepFaults: number;
  subscriptionReloadFaults: number;
  policyReadFaults: number;
  indexFailures: number;
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
    subscriptionUnresolved: 0,
    transportUnbound: 0,
    cadenceUnresolved: 0,
    reasonUnknown: 0,
    subscriptionUnloaded: 0,
    intakeApplied: 0,
    intakeNoop: 0,
    intakeRefused: 0,
    intakeUnavailable: 0,
    cursorReinitialized: 0,
    ingestFaults: 0,
    sweepFaults: 0,
    subscriptionReloadFaults: 0,
    policyReadFaults: 0,
    indexFailures: 0,
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
```

- [ ] **Step 2:** Create `src/ops/transport.ts`.

```typescript
/**
 * KPR-468 D6: KPR-458's transport interface, transcribed UNCHANGED. The three
 * closed sets below are contract; an adapter never extends them and maps
 * everything it cannot prove to `unknown`.
 */
import type { OpsClass, OpsDetail, OpsEvidence, OpsRetry, OpsSubject, Waiting } from "./types.js";
import type { DeliveryReference, OpsNotificationState } from "./notification-types.js";

/** Proof that nothing was accepted. C8's ONLY retry-permitting status. */
export type NonacceptanceReason =
  | "unauthenticated"
  | "unauthorized"
  | "target-unknown"
  | "target-ineligible"
  | "payload-rejected"
  | "refused-rate-limit";

/** Everything else. Never re-sent, always surfaced as uncertainty (C8). */
export type UncertaintyReason = "timeout" | "transport-fault" | "ambiguous-response" | "crashed-after-submission";

export type DeliveryOutcome =
  | { status: "accepted"; reference: DeliveryReference; at: Date }
  | { status: "rejected"; reason: NonacceptanceReason }
  | { status: "unknown"; reason: UncertaintyReason };

/**
 * D6: STRUCTURED, never a pre-rendered string. It carries the RESOLVED
 * target, which is a faithful reading of D6 rather than an amendment —
 * `deliver` takes exactly one argument, so the target the notifier resolved
 * from `subscription.transport.target` must ride the view. D6 bars an adapter
 * from CHOOSING or DISCOVERING a recipient; being handed one is the point.
 *
 * NEVER in this view: a rendered message string, a subscriber id, a channel
 * or person NAME, a severity, an owner, or anything D2 lists as explicitly
 * absent. The adapter owns rendering, because a Slack block, an SMS body and
 * a push payload are different artifacts of the same fact.
 */
export interface NotificationView {
  /** Opaque; names one ledger row. Confers no authority (D7, D9). */
  handle: string;
  /** Adapter-scoped, resolved by the notifier, opaque to it. */
  target: unknown;
  event: {
    producer: string;
    reasonId: string;
    class: OpsClass;
    retry: OpsRetry;
    waiting: Waiting;
    subject: OpsSubject;
    generation: number;
    dedupeKey: string;
    publishedAt: Date;
    detail: OpsDetail;
    evidence: OpsEvidence[];
  };
  remediation?: { template: string; parameters: OpsDetail };
  ledger: {
    state: OpsNotificationState;
    eventCount: number;
    nudgeCount: number;
    attemptCount: number;
    firstSeenAt: Date;
    lastEventAt: Date;
  };
}

export interface OpsTransport {
  readonly adapterId: string;
  /** Shape check, run at SUBSCRIPTION LOAD time (D6, D10) — not at code registration. */
  validateTarget(target: unknown): boolean;
  deliver(n: NotificationView): Promise<DeliveryOutcome>;
}

/**
 * D6: `{key}` substitution over ALLOW-LISTED parameters only. Pure. Offered to
 * adapters, never imposed — the ledger stores no rendered string (C13, AC12).
 *
 * Three properties, each deliberate:
 *  - `hasOwnProperty` rather than `key in`, so a template naming `constructor`
 *    or `__proto__` cannot read the prototype chain (the KPR-407 discipline).
 *  - An UNDECLARED placeholder is left untouched rather than blanked, so a
 *    template/registry mismatch is visible to a responder instead of silently
 *    producing a sentence with a hole in it.
 *  - No length cap is applied here and none is needed: the template is
 *    registry-bounded by KPR-454's OPS_REMEDIATION_MAX and each substituted
 *    value is registry-bounded by its declared `maxLength`, so the render is
 *    bounded by construction. Adapters still bound their own payloads.
 */
export function renderRemediation(template: string, detail: OpsDetail): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(detail, key) ? String(detail[key]) : whole,
  );
}
```

- [ ] **Step 3:** Create `src/ops/notification-types.test.ts`.

```typescript
import { describe, it, expect } from "vitest";
import {
  OPS_SYSTEM_PRINCIPAL,
  OPS_STOPPED_STATES,
  OPS_WORKING_STATES,
  OPS_NUDGE_STATES,
  expiresAtFor,
  ledgerRetentionDays,
  stallRecheckAt,
  STALL_RECHECK_MS,
  STALL_JITTER_FRACTION,
  type OpsNotificationState,
} from "./notification-types.js";

describe("OPS_SYSTEM_PRINCIPAL (D2, C9)", () => {
  // This asserts a property OF THE CONSTANT, not of any real id. The agent-id
  // shape is a documented convention with no regex enforcement anywhere, so
  // what actually carries C9 is intake's step-2 REFUSAL (chunk 4). These two
  // assertions are what make that refusal decidable rather than a prose judgment.
  it("matches neither the agent-id shape nor the Slack user-id shape", () => {
    expect(OPS_SYSTEM_PRINCIPAL).not.toMatch(/^[a-z0-9-]+$/);
    expect(OPS_SYSTEM_PRINCIPAL).not.toMatch(/^[UW][A-Z0-9]+$/);
    expect(OPS_SYSTEM_PRINCIPAL).toContain(":");
  });
});

describe("D9 expiresAt state invariant", () => {
  const ALL: OpsNotificationState[] = ["pending", "delivered", "seen", "dismissed", "snoozed", "cleared"];
  const at = new Date("2026-01-01T00:00:00.000Z");

  it("is a TOTAL map over D7's six states, not an enumeration of transitions", () => {
    // The enumeration form is what missed `seen → snoozed`. Driving all six
    // states is what makes this able to fail for an omitted arm.
    for (const state of ALL) {
      const expires = expiresAtFor(state, at, 30);
      if ((OPS_STOPPED_STATES as readonly string[]).includes(state)) {
        expect(expires, state).toEqual(new Date(at.getTime() + 30 * 86_400_000));
      } else {
        expect(expires, state).toBeUndefined();
      }
    }
  });

  it("partitions the six states and scopes nextNudgeAt to the two working NON-snoozed ones", () => {
    expect([...OPS_STOPPED_STATES, ...OPS_WORKING_STATES].sort()).toEqual([...ALL].sort());
    expect([...OPS_NUDGE_STATES]).toEqual(["pending", "delivered"]);
    expect(OPS_WORKING_STATES).toContain("snoozed");
    expect(OPS_NUDGE_STATES).not.toContain("snoozed");
  });
});

describe("ledgerRetentionDays (D9)", () => {
  it("composes against the event TTL so the behavioural half always ages first", () => {
    expect(ledgerRetentionDays(90)).toBe(30); // the config.ts:659 default
    expect(ledgerRetentionDays(14)).toBe(14); // a shortened activity retention
    expect(ledgerRetentionDays(30)).toBe(30);
  });
});

describe("stallRecheckAt (D5)", () => {
  it("stays inside ±STALL_JITTER_FRACTION of the interval at both extremes", () => {
    const now = new Date(1_000_000);
    const span = STALL_RECHECK_MS * STALL_JITTER_FRACTION;
    expect(stallRecheckAt(now, () => 0).getTime()).toBe(now.getTime() + STALL_RECHECK_MS - span);
    expect(stallRecheckAt(now, () => 1).getTime()).toBe(now.getTime() + STALL_RECHECK_MS + span);
    expect(stallRecheckAt(now, () => 0.5).getTime()).toBe(now.getTime() + STALL_RECHECK_MS);
  });

  it("is always strictly in the future — an unset or already-due value is the D5 failure", () => {
    const now = new Date(1_000_000);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(stallRecheckAt(now, () => r).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
```

- [ ] **Step 4:** Create `src/ops/transport.test.ts`.

```typescript
import { describe, it, expect } from "vitest";
import { renderRemediation } from "./transport.js";

describe("renderRemediation (D6, C13)", () => {
  it("substitutes declared keys and emits no value that was not in the allow-listed detail", () => {
    const out = renderRemediation("Restart {tool} on {host}", { tool: "gog", host: "mini" });
    expect(out).toBe("Restart gog on mini");
  });

  it("leaves an UNDECLARED placeholder untouched rather than blanking it", () => {
    // A template/registry mismatch must be visible to a responder, not turned
    // into a sentence with a hole in it.
    expect(renderRemediation("Restart {tool} on {host}", { tool: "gog" })).toBe("Restart gog on {host}");
  });

  it("never reads the prototype chain (KPR-407 discipline)", () => {
    expect(renderRemediation("{constructor}/{toString}/{__proto__}", {})).toBe("{constructor}/{toString}/{__proto__}");
  });

  it("renders numbers and booleans without coercing anything else in", () => {
    expect(renderRemediation("{n} retries, deterministic={d}", { n: 3, d: false })).toBe(
      "3 retries, deterministic=false",
    );
  });
});
```

- [ ] **Step 5:** Verify and commit.

```bash
npx vitest run src/ops/notification-types.test.ts src/ops/transport.test.ts
npx tsc --noEmit
```

Expected: all cases pass, `tsc` exits 0. `tsc` is the load-bearing half of this step — the row shape and the two closed unions are what chunks 2–4 compile against, and a wrong optionality here surfaces three chunks later as a cast.

```bash
git add src/ops/notification-types.ts src/ops/transport.ts src/ops/notification-types.test.ts src/ops/transport.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): ops notification types and the D6 transport interface

D2/D7/D9: the ops_notifications row shape, D7's closed six states, the
closed three-valued StalledReason, the reserved system principal and its
shape pin, the D9 expiresAt state invariant as a total map, and every
numeric bound this ticket fixes. D6's OpsTransport, NotificationView and
both closed reason sets transcribed unchanged, plus the pure
renderRemediation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
