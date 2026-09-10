# KPR-468 plan — chunk 4: acknowledgement intake and the notifier singleton

Implements design **D7** in full — the seam KPR-455's inbound edge calls — plus **D10**'s singleton and its unset posture. One task, one commit.

**Intake is the one part of this component that is not swept.** It is a direct, bounded write on the acknowledging caller's own path, because an acknowledgement that takes a sweep interval to register invites the operator to press the button twice. It is **live from `init()`**, not from `start()`: it depends on nothing `start()` provides, a restart's ledger rows survive in Mongo, and the per-row latch is a no-op when no tick is running.

**The check order is load-bearing and is fixed.** Three of its steps are order-sensitive in ways a natural implementation gets wrong:

- **The replay check precedes legality**, because `dismissed` is **not** a "from" state in D7's table: a duplicated dismissal callback checked in the other order returns `refused: "illegal-transition"`, which is a lie about a no-op and exactly the kind of error an inbound edge would then try to handle.
- **The monotonicity guard sits on the same step as the replay check**, because `lastAckKey` alone records only the *last* applied act — the exact weakness D3 rejects for events — so a delayed duplicate of an **older** act slips past it, passes legality (`snoozed → seen` is legal), and **regresses the row**, cancelling a live snooze.
- **The `cleared` refusal precedes the legality check**, so the ordinary race in which a clearing fact lands between a delivery and the acknowledger's click returns the benign `row-cleared` rather than a generic illegality.

**And one derived value governs every clock-bearing write: `anchorAt = min(at, now)`.** `at` is the *caller's* assertion, and D6 names an agent tool call and an operator CLI invocation among the inbound surfaces, so it is not always a signed vendor timestamp. An `at` in the past is honest and is used as given; an `at` ahead of the server clock is not, and is pulled back. `anchorAt` governs the snooze ceiling, `stateAt`, `principalAt`, `expiresAt` and `lastAckAt`. **The one value that keeps the raw `at` is `lastAckKey`** — an idempotence key must be a pure function of the caller's input, or a retried duplicate whose `at` was clamped against a *later* `now` would derive a different key and re-apply.

---

### Task 6: `OpsIntake` and `notifier-singleton.ts`

**Files:**

- Create: `src/ops/intake.ts`
- Create: `src/ops/notifier-singleton.ts`
- Modify: `src/ops/notifier.ts` (replace the chunk-3 `accept` stub; add the deadline wrapper)
- Create: `src/ops/intake.integration.test.ts`

- [ ] **Step 1:** Create `src/ops/intake.ts`.

```typescript
/**
 * KPR-468 D7: acknowledgement intake — the seam KPR-455's inbound edge calls.
 *
 * D12 item (5), and it belongs HERE rather than on the adapter: the ledger is
 * the only thing an acknowledgement writes, D6 bars an adapter from touching
 * it, and D7's rules are the same ones this component already enforces on
 * every other transition. Splitting intake into its own component would mean
 * two writers to one ledger enforcing one rule set, which is how the rule set
 * drifts.
 *
 * Records THE PRINCIPAL AND THE INSTANT AND NOTHING ELSE (D9): no display
 * name, no email, no device, no client, no location, and deliberately no
 * free-text reason for a dismissal.
 */
import { ObjectId, type Collection } from "mongodb";
import {
  HARD_SNOOZE_CEILING_MS,
  OPS_SYSTEM_PRINCIPAL,
  expiresAtFor,
  type OpsAcknowledgement,
  type OpsIntakeResult,
  type OpsNotification,
  type OpsNotificationState,
  type OpsPolicy,
} from "./notification-types.js";
import { WRITE } from "./notification-store.js";

/** D7's table: the four states an attributed act may transition FROM. */
const LEGAL_FROM: readonly OpsNotificationState[] = ["pending", "delivered", "seen", "snoozed"];

/** Signals a lost CAS to the one-retry loop. Never escapes this module. */
const LOST = Symbol("cas-lost");

/**
 * D7: the handle is the ledger row's `_id` rendered as a hex string, opaque by
 * contract. `ObjectId.isValid` also accepts 12-byte strings, so the hex
 * round-trip is what makes this total.
 */
export function parseHandle(handle: unknown): ObjectId | undefined {
  if (typeof handle !== "string" || handle.length !== 24) return undefined;
  if (!ObjectId.isValid(handle)) return undefined;
  const id = new ObjectId(handle);
  return id.toHexString() === handle.toLowerCase() ? id : undefined;
}

export class OpsIntake {
  constructor(
    private readonly notifications: Collection<OpsNotification>,
    private readonly retentionDays: number,
    private readonly clock: () => Date,
  ) {}

  /**
   * One indexed read plus one CAS. A lost CAS — a sweep tick moved the row
   * between read and write — retries ONCE and then returns unavailable.
   *
   * `policy` is THE COPY THE LAST TICK RETAINED, never a fresh read (D5). That
   * is what keeps this inside the "one indexed read plus one CAS" bound, and
   * it is why `?? HARD_SNOOZE_CEILING_MS` below covers TWO paths rather than
   * one: no ops_policy document registered, AND no tick having completed yet
   * (intake is live from init() while the sweep starts later, D10). Both
   * resolve to the hard ceiling, which is the correct answer for both.
   */
  async accept(input: OpsAcknowledgement, rowId: ObjectId, policy: OpsPolicy | null): Promise<OpsIntakeResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.attempt(input, rowId, policy);
      if (outcome !== LOST) return outcome;
    }
    return { state: "unavailable" };
  }

  private async attempt(
    input: OpsAcknowledgement,
    rowId: ObjectId,
    policy: OpsPolicy | null,
  ): Promise<OpsIntakeResult | typeof LOST> {
    // ── 1. Resolve the handle to exactly one row. ──
    const row = await this.notifications.findOne({ _id: rowId });
    if (!row) return { state: "refused", reason: "unknown-handle" };

    // ── 2. Attribute or refuse. ──
    // The OPS_SYSTEM_PRINCIPAL arm is an EXPLICIT REFUSAL, not an assumption.
    // Without it, a caller passing the reserved id — a mis-written KPR-455
    // edge, an operator command defaulting its actor, a transport handing back
    // its own service identity — lands seen/dismissed/snoozed attributed to
    // the system principal, which D7 rule 5 and C9 forbid ABSOLUTELY. Never
    // attributed to the adapter, to a service account, or to the system
    // principal.
    if (
      typeof input.actorId !== "string" ||
      input.actorId.trim().length === 0 ||
      input.actorId === OPS_SYSTEM_PRINCIPAL
    ) {
      return { state: "refused", reason: "unattributed" };
    }

    const now = this.clock();
    const at = input.at instanceof Date && !Number.isNaN(input.at.getTime()) ? input.at : now;
    // The one derived value that governs every clock-bearing write.
    const anchorAt = new Date(Math.min(at.getTime(), now.getTime()));

    // ── 3. Idempotence replay check, BEFORE legality — plus the monotonicity
    //       guard on the same step. ──
    // The key is a pure function of the CALLER'S INPUT (the raw `at`), or a
    // retried duplicate clamped against a later `now` would derive a different
    // key and re-apply.
    const lastAckKey = `${input.actorId}:${input.act}:${at.toISOString()}`;
    if (row.lastAckKey === lastAckKey) return { state: "noop", reason: "already-applied" };
    // ⚠ The anchor is `lastAckAt`, DELIBERATELY NOT `principalAt`, which is the
    // obvious-looking field and is wrong: principalAt advances on SYSTEM
    // transitions too (a delivery, a snooze expiry, a clear), so a nudge
    // landing one second after a human's click would make that human's
    // acknowledgement look stale and no-op it — losing a real act and nudging
    // forever, which is worse than the regression this guard prevents.
    if (row.lastAckAt !== undefined && anchorAt.getTime() <= row.lastAckAt.getTime()) {
      return { state: "noop", reason: "superseded" };
    }

    // ── 4. `cleared` refusal. ──
    // The ordinary race in which a clearing fact lands between a delivery and
    // the acknowledger's click. KPR-455's edge must treat this as BENIGN — a
    // no-op for the acknowledger, not an error they must surface.
    if (row.state === "cleared") return { state: "refused", reason: "row-cleared" };

    // ── 5. `integrity` dismissal refusal (D7 rule 3). ──
    if (input.act === "dismissed" && row.class === "integrity") {
      return { state: "refused", reason: "integrity-dismissal" };
    }

    // ── 6. Transition legality. ──
    if (!LEGAL_FROM.includes(row.state)) return { state: "refused", reason: "illegal-transition" };

    // ── 7. Snooze validation and the clamp. ──
    let snoozedUntil: Date | undefined;
    if (input.act === "snoozed") {
      const requested = input.snoozedUntil;
      // The refusal test is against anchorAt for the same reason the ceiling
      // is: with a bogus future `at`, a genuinely future snoozedUntil would
      // otherwise be refused as "not a pause".
      if (
        !(requested instanceof Date) ||
        Number.isNaN(requested.getTime()) ||
        requested.getTime() <= anchorAt.getTime()
      ) {
        return { state: "refused", reason: "snooze-not-future" };
      }
      const registered =
        typeof policy?.maxSnoozeMs === "number" && policy.maxSnoozeMs > 0
          ? policy.maxSnoozeMs
          : HARD_SNOOZE_CEILING_MS;
      const ceiling = Math.min(HARD_SNOOZE_CEILING_MS, registered);
      // CLAMPED AND APPLIED, NEVER REFUSED (D12): refusing would leave the row
      // unpaused and nudging, the opposite of what the acknowledger asked for.
      // Anchored on anchorAt rather than on `at` — that is what makes it a
      // CEILING rather than a caller-supplied value, on an `integrity` row
      // included.
      snoozedUntil = new Date(Math.min(requested.getTime(), anchorAt.getTime() + ceiling));
    }

    // ── 8. Apply, as ONE CAS conditioned on state, lastAckKey and lastAckAt. ──
    const set: Record<string, unknown> = {
      state: input.act,
      stateAt: anchorAt,
      principal: input.actorId,
      principalAt: anchorAt,
      lastAckKey,
      lastAckAt: anchorAt,
    };
    // nextNudgeAt is unset on ALL THREE acts: for seen/dismissed because both
    // stop nudging, and for snoozed as well, because the row is suppressed
    // until snoozedUntil and the expiry phase re-sets nextNudgeAt = now on the
    // way back into a working state. Unsetting it is also what keeps a
    // RETAINED forceDeliver out of arm 2's index range while the row is not
    // working, which is why arm 2's index carries no `state` key.
    const unset: Record<string, string> = { nextNudgeAt: "" };
    if (input.act === "snoozed") {
      set.snoozedUntil = snoozedUntil;
      // The snoozed arm deliberately does NOT clear forceDeliver — the
      // re-delivery is still owed after the pause.
    } else {
      unset.snoozedUntil = "";
      unset.forceDeliver = "";
    }
    // D9's state invariant, one pattern at every state-changing write. `seen`
    // and `dismissed` set it; `snoozed` unsets it — INCLUDING on the
    // `seen → snoozed` arm, where the row arrives carrying a live one.
    const expires = expiresAtFor(input.act, anchorAt, this.retentionDays);
    if (expires) set.expiresAt = expires;
    else unset.expiresAt = "";

    // ⚠ An absent precondition is written `{ $exists: false }`, NEVER a
    // literal `undefined`. Passing undefined happens to work against this repo
    // today only because `ignoreUndefined` is not set anywhere in src/ and the
    // driver therefore serializes undefined → null, which matches a missing
    // field; that is an accident of an unset client option, not a guarantee,
    // and a later MongoClient option would silently turn every FIRST
    // acknowledgement into a lost CAS.
    const result = await this.notifications.updateOne(
      {
        _id: rowId,
        state: row.state,
        ...(row.lastAckKey === undefined ? { lastAckKey: { $exists: false } } : { lastAckKey: row.lastAckKey }),
        ...(row.lastAckAt === undefined ? { lastAckAt: { $exists: false } } : { lastAckAt: row.lastAckAt }),
      },
      { $set: set, $unset: unset },
      WRITE,
    );
    if (result.matchedCount === 0) return LOST;

    return {
      state: "applied",
      rowState: input.act,
      // The clamped value is echoed back so the edge can tell the human what
      // it actually did (D12).
      ...(snoozedUntil ? { snoozedUntil } : {}),
    };
  }
}
```

- [ ] **Step 2:** Replace the `accept` stub in `src/ops/notifier.ts` and add the deadline wrapper.

Add to the imports:

```typescript
import { INTAKE_DEADLINE_MS } from "./notification-types.js";
import { OpsIntake, parseHandle } from "./intake.js";
```

Construct the intake in the constructor, beside `deliveryPhase`:

```typescript
    this.intake = new OpsIntake(this.store.notifications, retention, this.clock);
```

with the field `private readonly intake: OpsIntake;`. Then replace the stub whole:

```typescript
  /**
   * D6/D7/D10: the seam KPR-455's inbound edge calls. NEVER THROWS.
   *
   * `{ state: "unavailable" }` means exactly three things and no others: the
   * singleton is unset (pre-wiring, or a bare test construction — handled in
   * notifier-singleton.ts), init() did not complete, or stop() has begun.
   * It is deliberately NOT gated on start(): intake depends on nothing start()
   * provides, and gating it there would widen its dead window across the whole
   * Slack connect for no gain.
   */
  async accept(input: OpsAcknowledgement): Promise<OpsIntakeResult> {
    if (!this.initialized || this.stopping) return this.tallyIntake({ state: "unavailable" });
    // Step 1 of D7's order is split across two files ON PURPOSE: the parsed id
    // is the per-row latch's key, so it must be resolved before the lock is
    // taken. Intake re-uses the parsed value rather than re-parsing.
    const rowId = parseHandle(input.handle);
    if (!rowId) return this.tallyIntake({ state: "refused", reason: "unknown-handle" });
    try {
      const result = await this.withDeadline(
        this.withRowLock(String(rowId), () => this.intake.accept(input, rowId, this.policy ?? null)),
      );
      return this.tallyIntake(result);
    } catch (err) {
      log.warn("ops intake unavailable", { error: String(err) });
      return this.tallyIntake({ state: "unavailable" });
    }
  }

  /**
   * The losing side of this race keeps running to completion — deliberately.
   * It is one bounded CAS whose write is idempotent under the same
   * preconditions, so abandoning the result is safe; cancelling it is not
   * expressible against the driver and inventing an AbortController path here
   * would add a second way for a half-applied write to exist.
   */
  private withDeadline<T extends OpsIntakeResult>(work: Promise<T>): Promise<T | OpsIntakeResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ state: "unavailable" }), INTAKE_DEADLINE_MS);
      timer.unref?.();
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve({ state: "unavailable" });
        },
      );
    });
  }

  private tallyIntake(result: OpsIntakeResult): OpsIntakeResult {
    if (result.state === "applied") this.counters.intakeApplied += 1;
    else if (result.state === "noop") this.counters.intakeNoop += 1;
    else if (result.state === "refused") this.counters.intakeRefused += 1;
    else this.counters.intakeUnavailable += 1;
    return result;
  }
```

- [ ] **Step 3:** Create `src/ops/notifier-singleton.ts`.

```typescript
/**
 * KPR-468 D10: the module-global singleton, on KPR-454's
 * publisher-singleton.ts precedent (itself the provider-registry.ts pattern).
 *
 * UNSET ⇒ every intake call returns { state: "unavailable" }, which keeps the
 * pre-wiring boot window and every bare test construction correct BY
 * CONSTRUCTION rather than by a caller remembering to check.
 */
import type { OpsIntakeResult, OpsAcknowledgement } from "./notification-types.js";
import type { OpsNotifier } from "./notifier.js";

let current: OpsNotifier | undefined;

export function setOpsNotifier(notifier: OpsNotifier): void {
  current = notifier;
}

export function opsNotifier(): OpsNotifier | undefined {
  return current;
}

export function __resetOpsNotifierForTests(): void {
  current = undefined;
}

/**
 * The whole of the seam KPR-455's inbound edge calls. A free function rather
 * than an exported instance so an unset singleton is a correct answer instead
 * of a crash — and so that child needs no knowledge of this module's lifecycle.
 */
export function acceptOpsAcknowledgement(input: OpsAcknowledgement): Promise<OpsIntakeResult> {
  return current ? current.accept(input) : Promise.resolve({ state: "unavailable" });
}
```

⚠ **Naming collision, the same trap KPR-454's plan flags for its own singleton.** This module exports a reader named `opsNotifier()`. `src/index.ts` imports **only** `setOpsNotifier`, so the local `const opsNotifier` in chunk 5 is unambiguous — but the boot-order anchors are the literal strings `await opsNotifier.init()` and `setOpsNotifier(`, so the local variable name is load-bearing for the guard and **the reader import must never be added to `index.ts` without renaming one of the two.**

- [ ] **Step 4:** Create `src/ops/intake.integration.test.ts`.

Cover, at minimum, each of the following as a named case. Chunk 6 re-drives the subset that maps to AC8/AC10; these are the module's own.

- `parseHandle` accepts a 24-char lowercase hex string and rejects: a 12-char string (`ObjectId.isValid` accepts it), a 23- or 25-char string, a non-hex string, a non-string, `undefined`, and an uppercase-hex handle round-tripping to a different literal.
- **Step order:** a duplicated `dismissed` returns `{ state: "noop", reason: "already-applied" }` and **not** `refused: "illegal-transition"` — the case that proves the replay check precedes legality.
- **Monotonicity:** `seen` at `t1`, `snoozed` at `t2 > t1`, then a replay of the `seen` ⇒ `{ state: "noop", reason: "superseded" }`, with `state`, `snoozedUntil` and `expiresAt` byte-identical.
- **The anchor choice:** a system transition (a delivery, a snooze expiry) between a human's act and its callback does **not** supersede that callback — false of any implementation guarding on `principalAt`.
- **Attribution:** a missing, blank, whitespace-only and non-string `actorId` each refuse `unattributed`; an `actorId` equal to `OPS_SYSTEM_PRINCIPAL` refuses `unattributed` and leaves the row byte-identical.
- **`cleared`:** every one of the three acts on a `cleared` row refuses `row-cleared` and records nothing.
- **`integrity`:** `dismissed` on an `integrity` row refuses; `seen` and `snoozed` on the same row apply.
- **Legality:** an act on a `dismissed` row (with a *different* ack key, so the replay check does not absorb it) refuses `illegal-transition`.
- **The clamp:** a snooze beyond a registered `maxSnoozeMs` is applied clamped and echoed; with `policy === null` it clamps to `HARD_SNOOZE_CEILING_MS`; a registered maximum **larger** than the hard ceiling still yields the hard ceiling; an absent, non-`Date`, `NaN`, past and equal-to-`anchorAt` `snoozedUntil` each refuse `snooze-not-future`.
- **The anchor:** `at = now + 10 years` with `snoozedUntil = at + 1 day` on an `integrity` row applies with `snoozedUntil ≤ now + HARD_SNOOZE_CEILING_MS` and `stateAt ≈ now`; a following honest act by the same actor is **not** superseded; `lastAckKey` still derives from the **raw** `at`, so the retried duplicate of that same call returns `already-applied`.
- **D9's invariant:** `seen` sets `expiresAt`; `dismissed` sets it; `snoozed` **unsets** it, including on the `seen → snoozed` arm where the row arrives carrying a live one.
- **`forceDeliver`:** `snoozed` on a row carrying `forceDeliver: true` **retains** the flag and unsets `nextNudgeAt`; `seen` and `dismissed` clear both.
- **Re-snoozing** an already-`snoozed` row moves `snoozedUntil` and nothing else beyond the attribution and idempotence marks.
- **The CAS:** a filter built for a row with no `lastAckAt` uses `{ $exists: false }` — assert against the double's `operations` log, because a literal `undefined` passes today only by accident; a lost CAS retries once and then returns `unavailable`.
- **Availability:** `accept` before `init()` completes, after `stop()`, and through `acceptOpsAcknowledgement` with the singleton unset all return `{ state: "unavailable" }` and never throw; with `init()` complete and `start()` **never called**, an act on an existing row **applies**.
- **No policy read:** driving an `accept` asserts **zero** `ops_policy` reads in the double's `operations` log (the retained-copy rule, D5).
- **The latch:** an intake and a delivery attempt on the same row serialize, and the loser observes a CAS failure rather than a merged write.

- [ ] **Step 5:** Verify.

```bash
npx vitest run src/ops/intake.integration.test.ts src/ops/delivery.integration.test.ts src/ops/ingest.integration.test.ts
npx tsc --noEmit
```

- [ ] **Step 6:** **Negative-verify the monotonicity guard and its anchor** (Verification Rule 6).

- Delete the `lastAckAt` check from step 3 **and** its clause from the step-8 CAS filter. Re-run: `a delayed duplicate of an older act is superseded, not applied` must **fail** — the replayed `seen` applies, the row leaves `snoozed`, `snoozedUntil` is unset. Predict and confirm that `a duplicated dismissal returns noop/already-applied` **stays green**; that is exactly why the two cases are written separately.
- Restore, then change the guard's anchor from `row.lastAckAt` to `row.principalAt`. Re-run: the **inverse** pair — the delayed-duplicate case goes green again, and `a system transition between a human act and its callback does not supersede that callback` **fails**, with the callback returning `superseded` and a real act lost.

Restore.

- [ ] **Step 7:** Commit.

```bash
git add src/ops/intake.ts src/ops/notifier-singleton.ts src/ops/notifier.ts src/ops/intake.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): acknowledgement intake and the notifier singleton

D7/D10: the eight-step check order — resolve, attribute or refuse
(including an explicit refusal of the reserved system principal, which is
what makes C9 true rather than assumed), the idempotence replay check
BEFORE legality with a lastAckAt monotonicity guard beside it, the
cleared refusal, the integrity-dismissal refusal, legality, snooze
validation and the clamp, then one CAS.

Every clock-bearing write is anchored at min(at, now), so a caller cannot
buy an unbounded snooze, stretch or shorten a per-person retention
horizon, or lock a row out of future acknowledgement with a bad
timestamp. lastAckKey alone keeps the raw `at`, so a retried duplicate
still derives the same key. The clamp always exists: a contract-side hard
ceiling lives in code and a registered maximum can only tighten it.

Intake is live from init(), never gated on start(), and an unset
singleton answers { state: "unavailable" } by construction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
