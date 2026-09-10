# KPR-455 chunk 1b — The view module's unit suite

**Task 1 of 5, continued.** Read [the plan index](kpr-455-plan.md) and all seven chunk files before starting. **This chunk continues chunk 1's task: chunks 1 and 1b are ONE task and ONE commit**, and the commit block is at the end of this file. Read [chunk 1](kpr-455-plan-1-views.md) first — the module this suite drives is written there.

**Files**

- Create: `src/cli/ops-views.test.ts`

**Tier: `capable`.** This is where AC3, AC4 and AC16 become falsifiable, and where the two harness divergences the plan designs around are confirmed empirically rather than asserted.

---

- [ ] **Step 3:** Create `src/cli/ops-views.test.ts` — the pure surface.

```typescript
import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import type { OpsEvent } from "../ops/types.js";
import {
  clearingIsLegal,
  decodeOpsCursor,
  discoveryWindowMs,
  encodeOpsCursor,
  isAfter,
  resolveOpenConditions,
  resolveToolHealth,
  DEFAULT_LIMIT,
  DISCOVERY_WINDOW_FLOOR_MS,
  MAX_LIMIT,
  QUIET_TURN_DISJUNCTS,
  TOOL_HEALTH_STALE_AFTER_MINUTES,
  UNKNOWN_ERROR_SIG,
  WORK_STATUS_STALE_AFTER_MINUTES,
} from "./ops-views.js";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const HORIZON = TOOL_HEALTH_STALE_AFTER_MINUTES * 60_000;

function event(over: Partial<OpsEvent> = {}): OpsEvent {
  return {
    _id: new ObjectId(),
    schemaVersion: 1,
    publishedAt: ago(1),
    producer: "hive-runtime",
    reasonId: "tool-failed",
    class: "resource",
    retry: "transient",
    waiting: "nobody",
    subject: { kind: "tool", id: "mcp__slack__post" },
    generation: 0,
    dedupeKey: "hive-runtime:tool:mcp__slack__post:tool-failed:0",
    detail: { tool: "mcp__slack__post", errorSig: "timeout", lane: "claude" },
    evidence: [],
    matchedSubscriptions: 0,
    matchedSubscriptionIds: [],
    ...over,
  } as OpsEvent;
}

/** Newest-first, which is the order scanOpsEvents hands the resolvers. */
const desc = (events: OpsEvent[]) => [...events].sort((a, b) => (isAfter(a, b) ? -1 : 1));

describe("isAfter", () => {
  it("orders on publishedAt first", () => {
    expect(isAfter(event({ publishedAt: ago(1) }), event({ publishedAt: ago(2) }))).toBe(true);
  });

  it("breaks a publishedAt tie on _id, matching the log's own total order", () => {
    const older = new ObjectId();
    const newer = new ObjectId();
    const at = ago(5);
    expect(isAfter({ publishedAt: at, _id: newer }, { publishedAt: at, _id: older })).toBe(true);
    expect(isAfter({ publishedAt: at, _id: older }, { publishedAt: at, _id: newer })).toBe(false);
  });
});

describe("clearingIsLegal — KPR-458 D3's four outcomes plus two negatives", () => {
  const condition = (cls: string) => event({ class: cls as OpsEvent["class"] });
  const clearing = (over: Partial<OpsEvent> = {}) =>
    event({
      reasonId: "tool-recovered",
      class: "informational",
      clears: "hive-runtime:tool:mcp__slack__post:tool-failed:0",
      dedupeKey: "hive-runtime:tool:mcp__slack__post:tool-recovered:0",
      ...over,
    });

  it("resource is cleared by a same-producer clearing fact", () => {
    expect(clearingIsLegal(condition("resource"), clearing())).toBe(true);
  });

  it("judgment clears only with at least one evidence reference", () => {
    expect(clearingIsLegal(condition("judgment"), clearing())).toBe(false);
    expect(clearingIsLegal(condition("judgment"), clearing({ evidence: [{ kind: "workItem", id: "w1" }] }))).toBe(true);
  });

  it("integrity clears only with at least one evidence reference", () => {
    expect(clearingIsLegal(condition("integrity"), clearing())).toBe(false);
    expect(clearingIsLegal(condition("integrity"), clearing({ evidence: [{ kind: "workItem", id: "w1" }] }))).toBe(true);
  });

  it("informational is never cleared", () => {
    expect(clearingIsLegal(condition("informational"), clearing({ evidence: [{ kind: "workItem", id: "w1" }] }))).toBe(
      false,
    );
  });

  it("a clearing fact from a different producer never clears", () => {
    expect(clearingIsLegal(condition("resource"), clearing({ producer: "florist" }))).toBe(false);
  });

  it("an unrecognized class fails OPEN AS OPEN — the clearing fact is not legal", () => {
    expect(clearingIsLegal(condition("catastrophic"), clearing({ evidence: [{ kind: "workItem", id: "w1" }] }))).toBe(
      false,
    );
  });

  it("a clearing fact naming another dedupeKey never clears", () => {
    expect(clearingIsLegal(condition("resource"), clearing({ clears: "hive-runtime:tool:other:tool-failed:0" }))).toBe(
      false,
    );
  });
});

describe("resolveToolHealth", () => {
  it("reports failing for a condition inside the horizon", () => {
    const { rows, summary } = resolveToolHealth(desc([event({ publishedAt: ago(30) })]), {
      now: NOW,
      horizonMs: HORIZON,
      logPresent: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "mcp__slack__post", errorSig: "timeout", outcome: "failing", lane: "claude" });
    expect(summary).toMatchObject({ failing: 1, recovered: 0, unknown: 0, emptiness: "none" });
  });

  it("reports unknown when the latest fact is older than the horizon", () => {
    const outside = TOOL_HEALTH_STALE_AFTER_MINUTES + 1;
    const { rows, summary } = resolveToolHealth(desc([event({ publishedAt: ago(outside) })]), {
      now: NOW,
      horizonMs: HORIZON,
      logPresent: true,
    });
    expect(rows[0]!.outcome).toBe("unknown");
    expect(summary.emptiness).toBe("no-facts-in-horizon");
  });

  it("a recovery resolves EVERY errorSig row for its tool", () => {
    const events = desc([
      event({ publishedAt: ago(60), detail: { tool: "t1", errorSig: "timeout", lane: "claude" } }),
      event({ publishedAt: ago(50), detail: { tool: "t1", errorSig: "rejected", lane: "claude" } }),
      event({
        publishedAt: ago(10),
        reasonId: "tool-recovered",
        class: "informational",
        clears: "hive-runtime:tool:t1:tool-failed:0",
        dedupeKey: "hive-runtime:tool:t1:tool-recovered:0",
        detail: { tool: "t1", lane: "claude" },
      }),
    ]);
    const { rows, summary } = resolveToolHealth(events, { now: NOW, horizonMs: HORIZON, logPresent: true });
    expect(rows.map((r) => r.errorSig).sort()).toEqual(["rejected", "timeout"]);
    expect(rows.every((r) => r.outcome === "recovered")).toBe(true);
    expect(rows.every((r) => r.recoveredAt?.getTime() === ago(10).getTime())).toBe(true);
    expect(summary.emptiness).toBe("all-recovered");
  });

  it("a recovery OLDER than the newest failure does not recover the key", () => {
    const events = desc([
      event({
        publishedAt: ago(40),
        reasonId: "tool-recovered",
        clears: "hive-runtime:tool:t1:tool-failed:0",
        dedupeKey: "hive-runtime:tool:t1:tool-recovered:0",
        detail: { tool: "t1", lane: "claude" },
      }),
      event({ publishedAt: ago(20), detail: { tool: "t1", errorSig: "timeout", lane: "claude" } }),
    ]);
    const { rows } = resolveToolHealth(events, { now: NOW, horizonMs: HORIZON, logPresent: true });
    expect(rows[0]).toMatchObject({ outcome: "failing" });
    expect(rows[0]!.recoveredAt).toBeUndefined();
  });

  it("counts repeats and keeps the oldest instant as firstAt", () => {
    const events = desc([event({ publishedAt: ago(90) }), event({ publishedAt: ago(30) })]);
    const { rows } = resolveToolHealth(events, { now: NOW, horizonMs: HORIZON, logPresent: true });
    expect(rows[0]).toMatchObject({ eventCount: 2, firstAt: ago(90), lastAt: ago(30) });
  });

  it("keys a condition with no errorSig under the total fallback", () => {
    const { rows } = resolveToolHealth(desc([event({ detail: { tool: "t1", lane: "claude" } })]), {
      now: NOW,
      horizonMs: HORIZON,
      logPresent: true,
    });
    expect(rows[0]!.errorSig).toBe(UNKNOWN_ERROR_SIG);
  });

  it("labels an absent log distinctly from an empty window", () => {
    expect(resolveToolHealth([], { now: NOW, horizonMs: HORIZON, logPresent: false }).summary.emptiness).toBe(
      "no-ops-event-log",
    );
    expect(resolveToolHealth([], { now: NOW, horizonMs: HORIZON, logPresent: true }).summary.emptiness).toBe(
      "no-keys-in-window",
    );
  });
});

describe("resolveOpenConditions", () => {
  const HORIZON_W = WORK_STATUS_STALE_AFTER_MINUTES * 60_000;
  const condition = (over: Partial<OpsEvent> = {}) => event({ dedupeKey: "p:workItem:w1:blocked:0", ...over });
  const clearing = (over: Partial<OpsEvent> = {}) =>
    event({ clears: "p:workItem:w1:blocked:0", dedupeKey: "p:workItem:w1:unblocked:0", ...over });

  it("lists an uncleared condition as open, with matchedAtPublish and its instant", () => {
    const rows = resolveOpenConditions(desc([condition({ publishedAt: ago(30), matchedSubscriptions: 0 })]), {
      now: NOW,
      horizonMs: HORIZON_W,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "open", matchedAtPublish: 0, matchedAtPublishAsOf: ago(30) });
  });

  it("drops a condition cleared by a class-legal fact published after it", () => {
    const rows = resolveOpenConditions(
      desc([condition({ publishedAt: ago(30), class: "resource" }), clearing({ publishedAt: ago(10) })]),
      { now: NOW, horizonMs: HORIZON_W },
    );
    expect(rows).toEqual([]);
  });

  it("keeps a condition whose clearing fact predates it", () => {
    const rows = resolveOpenConditions(
      desc([condition({ publishedAt: ago(10), class: "resource" }), clearing({ publishedAt: ago(30) })]),
      { now: NOW, horizonMs: HORIZON_W },
    );
    expect(rows).toHaveLength(1);
  });

  it("marks a condition older than the horizon as unknown rather than dropping it", () => {
    const rows = resolveOpenConditions(
      desc([condition({ publishedAt: ago(WORK_STATUS_STALE_AFTER_MINUTES + 1) })]),
      { now: NOW, horizonMs: HORIZON_W },
    );
    expect(rows[0]!.state).toBe("unknown");
  });

  it("renders an unrecognized class as unknown and leaves the condition open", () => {
    const rows = resolveOpenConditions(
      desc([condition({ publishedAt: ago(30), class: "catastrophic" as OpsEvent["class"] }), clearing({ publishedAt: ago(10) })]),
      { now: NOW, horizonMs: HORIZON_W },
    );
    expect(rows[0]).toMatchObject({ class: "unknown", state: "open" });
  });

  it("never lists a clearing fact as an open condition of its own", () => {
    const rows = resolveOpenConditions(desc([clearing({ publishedAt: ago(10) })]), { now: NOW, horizonMs: HORIZON_W });
    expect(rows).toEqual([]);
  });

  it("renders evidence as kind:id references", () => {
    const rows = resolveOpenConditions(
      desc([condition({ publishedAt: ago(5), evidence: [{ kind: "workItem", id: "w1" }] })]),
      { now: NOW, horizonMs: HORIZON_W },
    );
    expect(rows[0]!.evidence).toEqual(["workItem:w1"]);
  });
});

describe("the cursor", () => {
  it("round-trips", () => {
    const token = encodeOpsCursor("tools", "dodi", "a|b");
    expect(decodeOpsCursor(token, "tools", "dodi")).toBe("a|b");
  });

  it("refuses another section, another owner, a non-base64url value and an over-long one", () => {
    const token = encodeOpsCursor("tools", "dodi", "a|b");
    expect(() => decodeOpsCursor(token, "quietTurns", "dodi")).toThrow("invalid_cursor");
    expect(() => decodeOpsCursor(token, "tools", "keepur")).toThrow("invalid_cursor");
    expect(() => decodeOpsCursor("not base64!", "tools", "dodi")).toThrow("invalid_cursor");
    expect(() => decodeOpsCursor("a".repeat(501), "tools", "dodi")).toThrow("invalid_cursor");
  });

  it("treats an absent cursor as the first page", () => {
    expect(decodeOpsCursor(undefined, "tools", "dodi")).toBeUndefined();
  });
});

describe("the resolved bounds", () => {
  it("keeps every discovery window at least as wide as its horizon", () => {
    for (const minutes of [TOOL_HEALTH_STALE_AFTER_MINUTES, WORK_STATUS_STALE_AFTER_MINUTES, 60, 100_000]) {
      expect(discoveryWindowMs(minutes * 60_000)).toBeGreaterThanOrEqual(minutes * 60_000);
    }
    expect(discoveryWindowMs(TOOL_HEALTH_STALE_AFTER_MINUTES * 60_000)).toBe(DISCOVERY_WINDOW_FLOOR_MS);
  });

  it("gives the two views different horizons, which is what D8 makes them", () => {
    expect(WORK_STATUS_STALE_AFTER_MINUTES).not.toBe(TOOL_HEALTH_STALE_AFTER_MINUTES);
  });

  it("keeps the page bounds in the obligations precedent's relationship", () => {
    expect(MAX_LIMIT).toBeGreaterThan(DEFAULT_LIMIT);
  });

  it("writes the error disjunct so it agrees with MongoDB and with the in-memory double", () => {
    // $ne: null alone matches a MISSING field in the double
    // (src/obligations/testing/fake-db.ts:34-35 with src/obligations/types.ts:216-237)
    // and excludes it in MongoDB. $exists: true is what reconciles them.
    expect(QUIET_TURN_DISJUNCTS[0]).toEqual({ error: { $exists: true, $ne: null } });
  });
});
```

- [ ] **Step 4:** Verify.

```bash
npx tsc --noEmit
npx vitest run src/cli/ops-views.test.ts
npx prettier --check src/cli/ops-views.ts src/cli/ops-views.test.ts
npx eslint src/cli/ops-views.ts src/cli/ops-views.test.ts
```

**Expected:** `tsc` exits 0 with no output. Vitest reports one file, all tests passing, zero skipped — record the actual case count rather than predicting one. Prettier reports "All matched files use Prettier code style!" (run `npx prettier --write` on these two files and re-check if it does not). ESLint exits 0.

- [ ] **Step 5:** Confirm the two harness divergences empirically, so the guard in Step 3 is evidence rather than assertion.

```bash
cat > /tmp/kpr455-probe.mjs <<'EOF'
import { same } from "./dist/obligations/types.js";
// The double's $ne arm is !same(actual, expected). A missing field arrives as
// undefined; MongoDB's { $ne: null } EXCLUDES such a document.
console.log("double would match a missing field:", !same(undefined, null));
EOF
npm run build >/dev/null && node /tmp/kpr455-probe.mjs && rm /tmp/kpr455-probe.mjs
```

**Expected:** `double would match a missing field: true` — which is the divergence, confirmed rather than assumed. If it prints `false`, `same` has changed; re-read `src/obligations/types.ts:216-237`, and if `$ne: null` now agrees with MongoDB, keep `$exists: true` anyway (it is correct in both) and correct the comment in `ops-views.ts` and the index's harness-divergence section.

- [ ] **Step 6:** Rehearse NV2 against this suite. This is a rehearsal, not the confirmation — chunk 4 Step 9 runs the same mutation against AC16 and that run is the one recorded.

In `src/cli/ops-views.ts`, replace `clearingIsLegal`'s `switch` block with `return condition.class !== "informational";`, then run `npx vitest run src/cli/ops-views.test.ts`.

**Predicted failure — exactly three cases red:** `clearingIsLegal › judgment clears only with at least one evidence reference` (the zero-evidence assertion reports `true`), `clearingIsLegal › integrity clears only with at least one evidence reference` (same), and `resolveOpenConditions › renders an unrecognized class as unknown and leaves the condition open` (the row is gone — `rows[0]` is `undefined` and the `toMatchObject` throws on it). **Predicted green:** the `resource` case, the `informational` case, the different-producer case and the wrong-`dedupeKey` case — the mutation agrees with the rule on the first two and never reaches the switch on the last two. Record which cases actually went red; **a wrong prediction here is a finding about the harness or the fixture, not something to adjust the prediction to match.**

**Restore the file** (`git checkout -- src/cli/ops-views.ts`) and re-run the suite to confirm green before committing.

- [ ] **Step 7:** Commit.

```bash
git add src/cli/ops-views.ts src/cli/ops-views.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-455): ops view resolvers — tool health, open conditions, quiet turns

The module every rendered outcome in this child comes from: the resolved
bounds, the (publishedAt, _id) comparator, KPR-458 D3's class-legality rule
applied over two events, the tool-health rollup with its recovery-key
asymmetry, the generic open-condition view, the measured
`error OR aborted OR timedOut` quiet-turn read under TURN_ACTIVITY_FILTER, the
pipeline-freshness read and the cursor codec. Read-only in every direction: no
write, no init(), no collection or index created, no OpsNotifier constructed.

Two harness divergences designed around and guarded: the in-memory double's
`$ne: null` matches a missing field (so the error disjunct carries
`$exists: true`), and its `project()` is a no-op (so no redaction claim rests
on a projection — the flag is derived and the string dropped inside the read).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
