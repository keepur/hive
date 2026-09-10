# KPR-455 chunk 4 — Acceptance suite

**Task 4 of 5.** Read [the plan index](kpr-455-plan.md) and all eight chunk files before starting.

Sixteen criteria as named `describe` blocks in one file, so they read as one list. **AC15 is hosted in chunk 5, not here** — its assertion is about `CLAUDE.md`, which Task 5 writes, and a test asserting a file the next commit creates would leave this commit red. Chunk 5 Step 2 appends it to this same file. Every other criterion has at least one real `it` here.

**Split, and it is a STEP seam rather than a task seam — the third recorded exception.** Chunks 4 and 4b are **one task and one commit**: this file carries Steps 1–8 (AC1–AC9, AC12, AC13, AC16 and the runs of NV1, NV4, NV5, NV6 and NV7), [chunk 4b](kpr-455-plan-4b-acceptance.md) carries Steps 9–11 (AC10, AC11, AC14, the NV2 and NV3 runs, the whole-suite verification and the commit). One test file, one commit; the seam is where the file crossed this plan's own 900-line bound after round 2's additions. Read 4 and 4b as one unit.

**Files**

- Create: `src/cli/ops.integration.test.ts` (appended to in [chunk 4b](kpr-455-plan-4b-acceptance.md))
- Read-only: `src/ops/testing/fake-db.ts`, `src/ops/testing/notifier-harness.ts`, `src/cli/testing/ops-cli-fixtures.ts` (chunk 2b)

**Tier: `capable`.** AC10 (chunk 4b) drives the single claim the spec asks a reviewer to press hardest — that intake's CAS, not the in-process latch, carries the no-blended-write property across processes — and it is the criterion most able to go green while asserting nothing.

---

## Task 4: the criteria

- [ ] **Step 1:** Create `src/cli/ops.integration.test.ts` — the header, fixtures and AC1/AC2.

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { FakeDb } from "../ops/testing/fake-db.js";
import { harness, sub } from "../ops/testing/notifier-harness.js";
import { OpsNotifier } from "../ops/notifier.js";
import type { OpsEvent } from "../ops/types.js";
import type { OpsIntakeResult } from "../ops/notification-types.js";
import type { ActivityRecord } from "../activity/types.js";
import { runOps } from "./ops.js";
import {
  cleanupFixtures,
  deps,
  fixture,
  ProgrammedNotifier,
  stampSentinel,
  steppingClock,
} from "./testing/ops-cli-fixtures.js";

vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: () => null }));

const NOW = new Date("2026-01-10T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const fixedClock = () => () => NOW;

beforeEach(() => {
  for (const key of ["MONGODB_URI", "MONGODB_DB", "HIVE_HOME", "ACTIVITY_RETENTION_DAYS"]) vi.stubEnv(key, "");
  vi.stubEnv("HIVE_CONFIG", undefined);
});
afterEach(() => {
  cleanupFixtures();
  vi.unstubAllEnvs();
});

// ── fixtures ──

async function seedEvent(db: FakeDb, over: Partial<OpsEvent> = {}): Promise<OpsEvent> {
  const doc: OpsEvent = {
    schemaVersion: 1,
    publishedAt: ago(30),
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
  const result = await db.collection("ops_events").insertOne(doc as Record<string, unknown>);
  return { ...doc, _id: result.insertedId as ObjectId };
}

/** A clearing fact for one tool. Carries NO errorSig, exactly as KPR-454 D5's
 *  `tool-recovered` detailKeys (`tool`, `lane`) do — which is the whole reason
 *  the rollup's recovery join is keyed on the tool (AC4). */
async function seedRecovery(db: FakeDb, tool: string, over: Partial<OpsEvent> = {}): Promise<OpsEvent> {
  return seedEvent(db, {
    reasonId: "tool-recovered",
    class: "informational",
    subject: { kind: "tool", id: tool },
    dedupeKey: `hive-runtime:tool:${tool}:tool-recovered:0`,
    clears: `hive-runtime:tool:${tool}:tool-failed:0`,
    clearsFamily: `hive-runtime:tool:${tool}:tool-failed`,
    detail: { tool, lane: "claude" },
    ...over,
  });
}

async function seedTurn(db: FakeDb, over: Partial<ActivityRecord> & Record<string, unknown> = {}): Promise<void> {
  await db.collection("activity_log").insertOne({
    agentId: "mokie",
    threadId: "T1",
    timestamp: ago(10),
    sender: "human",
    channel: "C1",
    channelKind: "slack",
    model: "claude-opus-5",
    costUsd: 0,
    durationMs: 1_620_000,
    inputTokens: 10,
    outputTokens: 10,
    contextWindow: 200_000,
    toolCalls: 3,
    toolSummary: "Read×3",
    compactions: 0,
    streamed: true,
    ...over,
  } as Record<string, unknown>);
}

async function ready(extraYaml = "") {
  const f = fixture("demo", extraYaml);
  const db = new FakeDb();
  stampSentinel(db, f.selection);
  return { f, db };
}

async function view(db: FakeDb, f: ReturnType<typeof fixture>, argv: string[], over = {}) {
  const d = deps(db, f.selection, { clock: fixedClock(), ...over });
  const exit = await runOps([...argv, "--config", f.path, "--json"], d);
  return { exit, payload: JSON.parse(d.emitted.at(-1)!), d };
}

/** Every key name in a payload, at any depth — used by AC1's field ban, which
 *  a substring scan would get wrong (a base64url cursor can hold anything). */
function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, into);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  return into;
}

describe("AC1 — no policy, no rows", () => {
  it("issues no write and creates nothing on either read path", async () => {
    const { f, db } = await ready();
    await seedEvent(db);
    await seedTurn(db, { error: "boom" });
    for (const subcommand of ["health", "stalled"]) {
      const writesBefore = db.writes();
      const opsBefore = db.operations.length;
      await view(db, f, ["ops", subcommand]);
      expect(db.writes()).toBe(writesBefore);
      const during = db.operations.slice(opsBefore);
      expect(during.filter((o) => ["insertOne", "updateOne", "replaceOne", "deleteMany", "createIndex"].includes(o.operation))).toEqual(
        [],
      );
      // And no collection this child owns was touched at all.
      expect(during.map((o) => o.collection).sort()).not.toContain("ops_subscriptions");
      expect(during.map((o) => o.collection).sort()).not.toContain("ops_reasons");
    }
  });

  it("produces no owner, severity, escalatedTo, recipient or destination field in any renderer", async () => {
    const { f, db } = await ready();
    await seedEvent(db);
    await seedTurn(db, { timedOut: true });
    for (const subcommand of ["health", "stalled"]) {
      const { payload } = await view(db, f, ["ops", subcommand]);
      const keys = collectKeys(payload);
      for (const banned of ["owner", "severity", "escalatedTo", "assignee", "recipient", "destination", "channel", "priority", "loudness"])
        expect([...keys]).not.toContain(banned);
    }
  });
});

describe("AC2 — no engine wiring", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("is imported by no spawn-path module", () => {
    for (const path of [
      "src/agents/agent-runner.ts",
      "src/agents/agent-manager.ts",
      "src/channels/dispatcher.ts",
      "src/agents/provider-adapters/tool-bridge.ts",
    ]) {
      const source = read(path);
      expect(source, `${path} must not reach into the CLI`).not.toMatch(/from\s+["'][^"']*\/cli\//);
      expect(source).not.toContain("cli/ops");
    }
  });

  it("adds nothing to index.ts or to the boot-order guard — the TEXT assertion, because a test cannot see a diff", () => {
    const index = read("src/index.ts");
    expect(index).not.toContain("cli/ops");
    expect(index).not.toContain("runOps");
    expect(index).not.toContain("opsPipelineForDoctor");
    const guard = read("src/boot-order.test.ts");
    for (const anchor of ["runOps", "cli/ops", "opsViews", "opsReader", "opsPipeline"]) expect(guard).not.toContain(anchor);
  });
});
```

- [ ] **Step 2:** Append AC3 — stale ⇒ unknown, on three limbs.

```typescript
describe("AC3 — stale means unknown, and absence is never health", () => {
  it("reports failing for a fact just inside the horizon", async () => {
    const { f, db } = await ready();
    await seedEvent(db, { publishedAt: ago(1439) }); // one minute inside 24 h
    const { payload } = await view(db, f, ["ops", "health"]);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]).toMatchObject({ outcome: "failing", tool: "mcp__slack__post", errorSig: "timeout" });
  });

  it("reports UNKNOWN for the same fact just outside the horizon", async () => {
    const { f, db } = await ready();
    await seedEvent(db, { publishedAt: ago(1441) }); // one minute outside 24 h
    const { payload } = await view(db, f, ["ops", "health"]);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].outcome).toBe("unknown");
    expect(payload.summary).toMatchObject({ failing: 0, recovered: 0, unknown: 1 });
  });

  it("omits a key with no fact at all AND says in its own words that absence is not health", async () => {
    const { f, db } = await ready();
    await seedEvent(db, { detail: { tool: "other-tool", errorSig: "timeout", lane: "claude" } });
    const { payload } = await view(db, f, ["ops", "health"]);
    expect(payload.tools.map((row: { tool: string }) => row.tool)).toEqual(["other-tool"]);
    // The FIELD, not a rendering: D2's output-shape rule is what makes this
    // assertable rather than aspirational.
    expect(payload.notes.absenceIsNotHealth).toContain("absence is not health");
    expect(payload.notes.discoveryWindow).toContain("never 'never'");
  });
});
```

- [ ] **Step 3 (NV4):** Negative-verify stale ⇒ unknown.

In `resolveToolHealth`, delete the `latestAt.getTime() < horizonAt` branch so `outcome` falls through to `recovered ? "recovered" : "failing"`, then run `npx vitest run src/cli/ops.integration.test.ts -t "AC3"`.

**Predicted failure — exactly one case red:** `AC3 › reports UNKNOWN for the same fact just outside the horizon`, reporting `"failing"` where `"unknown"` was expected, and the companion `summary` assertion failing on `{ failing: 1, unknown: 0 }`. **Predicted green:** limb 1 (inside the horizon — the mutation agrees with the rule there) and limb 3 (an absence, which no outcome branch can produce), and every AC16 case — though AC16 is NOT the cross-check it looks like: its six limbs are the four classes plus the two negatives, none of them is about staleness, and they are green here for the trivial reason that they never exercise a horizon at all.

⚠ **The real cross-check lives in the unit suite, so this mutation is a TWO-COMMAND run.** Also run `npx vitest run src/cli/ops-views.test.ts` and predict `resolveOpenConditions › marks a condition older than the horizon as unknown rather than dropping it` **stays green** — that is the OTHER view's own staleness branch, held by `resolveOpenConditions` rather than by `resolveToolHealth`. **If it goes red, the two views have been collapsed onto one horizon and D8's "the horizon is a property of the view" has been violated; report that rather than adjusting the prediction.**

**Restore** and re-run before continuing.

- [ ] **Step 4:** Append AC4 and AC5, then run NV1.

```typescript
describe("AC4 — the recovery-key asymmetry", () => {
  it("resolves EVERY errorSig row for a tool from one recovery", async () => {
    const { f, db } = await ready();
    await seedEvent(db, { publishedAt: ago(60), detail: { tool: "t1", errorSig: "timeout", lane: "claude" } });
    await seedEvent(db, { publishedAt: ago(50), detail: { tool: "t1", errorSig: "rejected", lane: "claude" } });
    await seedRecovery(db, "t1", { publishedAt: ago(10) });
    const { payload } = await view(db, f, ["ops", "health"]);
    expect(payload.tools).toHaveLength(2);
    expect(payload.tools.map((row: { errorSig: string }) => row.errorSig).sort()).toEqual(["rejected", "timeout"]);
    for (const row of payload.tools) {
      expect(row.outcome).toBe("recovered");
      expect(row.recoveredAt).toBe(ago(10).toISOString());
    }
    expect(payload.summary.emptiness).toBe("all-recovered");
    expect(payload.notes.recoveryClearsEveryErrorSig).toContain("every `errorSig` row");
  });

  it("does not recover a key whose newest failure postdates the recovery", async () => {
    const { f, db } = await ready();
    await seedRecovery(db, "t1", { publishedAt: ago(40) });
    await seedEvent(db, { publishedAt: ago(20), detail: { tool: "t1", errorSig: "timeout", lane: "claude" } });
    const { payload } = await view(db, f, ["ops", "health"]);
    expect(payload.tools[0]).toMatchObject({ outcome: "failing" });
    expect(payload.tools[0].recoveredAt).toBeUndefined();
  });
});

describe("AC5 — latest outcome is the log's own total order", () => {
  it("breaks a publishedAt tie on _id, whatever order the documents were inserted in", async () => {
    const { f, db } = await ready();
    const at = ago(20);
    // Mint in order so `second._id > first._id`, then INSERT OUT OF ORDER.
    const first = { publishedAt: at, detail: { tool: "t1", errorSig: "timeout", lane: "claude" } };
    const second = { publishedAt: at, detail: { tool: "t1", errorSig: "timeout", lane: "laneB" } };
    const a = await seedEvent(db, first);
    const b = await seedEvent(db, second);
    expect(String(b._id) > String(a._id)).toBe(true);
    const { payload } = await view(db, f, ["ops", "health"]);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].lane).toBe("laneB");
    expect(payload.tools[0].eventCount).toBe(2);
  });

  it("asks the driver for the log's own sort, rather than sorting in memory", async () => {
    const { f, db } = await ready();
    await seedEvent(db);
    const before = db.operations.length;
    await view(db, f, ["ops", "health"]);
    const find = db.operations.slice(before).find((o) => o.collection === "ops_events" && o.operation === "find");
    expect(find).toBeDefined();
  });
});
```

⚠ The second AC5 case asserts the read happened, not the sort spec — **the in-memory double records the filter and options but not the cursor's `sort()`**, so a sort-spec assertion here would be unfalsifiable. The behavioural first case is what pins the order, and it is false of any implementation that ignores `_id`.

**NV1 — the recovery-key asymmetry.** In `resolveToolHealth`, key the `recoveries` map on `` `${tool} ${errorSig}` `` (deriving `errorSig` from the clearing event's own `detail`) rather than on `tool`, then run `npx vitest run src/cli/ops.integration.test.ts -t "AC4"`.

**Predicted failure — exactly one case red:** `AC4 › resolves EVERY errorSig row for a tool from one recovery`. Both rows report `outcome: "failing"` and `recoveredAt` is `undefined`, because a `tool-recovered` event carries no `errorSig` at all — the mutated key is `` `t1 (unset)` `` and matches neither condition row — so the `summary.emptiness` assertion fails on `"none"` too. **Predicted green:** `AC4 › does not recover a key whose newest failure postdates the recovery` (it expects `failing` already, so the mutation cannot distinguish it), all three AC3 limbs (limb 1 is deliberately written against a failure rather than a recovery, precisely so the two criteria fail independently), and both AC5 cases (no recovery is seeded).

**Restore** and re-run before continuing.

- [ ] **Step 5:** Append AC6, then run NV6.

```typescript
describe("AC6 — C12, both limbs", () => {
  it("yields ZERO stalled-turn rows from cost alone", async () => {
    const { f, db } = await ready();
    // Every Lane B turn carries costUsd: 0 — turn-scaffold.ts:353 — and the
    // longest zero-cost run in the measured window was a 27-minute SUCCESSFUL
    // turn. Cost is a billing field; on a subscription lane it carries no
    // outcome information.
    for (let i = 0; i < 5; i += 1) await seedTurn(db, { threadId: `T${i}`, costUsd: 0, durationMs: 1_620_000 });
    const { payload } = await view(db, f, ["ops", "stalled"]);
    expect(payload.quietTurns.matched).toBe(0);
    expect(payload.quietTurns.recent).toEqual([]);
    expect(payload.quietTurns.turnsInWindow).toBe(5);
    expect(payload.quietTurns.measurable).toBe(true);
  });

  it("yields a row for EVERY member of the measured union, including timedOut turns carrying error: null", async () => {
    const { f, db } = await ready();
    for (let i = 0; i < 3; i += 1) await seedTurn(db, { threadId: `TO${i}`, timedOut: true, error: null });
    for (let i = 0; i < 2; i += 1) await seedTurn(db, { threadId: `AB${i}`, aborted: true });
    await seedTurn(db, { threadId: "ER0", error: "boom" });
    for (let i = 0; i < 40; i += 1) await seedTurn(db, { threadId: `OK${i}` });
    const { payload } = await view(db, f, ["ops", "stalled", "--limit", "50"]);
    expect(payload.quietTurns.turnsInWindow).toBe(46);
    expect(payload.quietTurns.matched).toBe(6);
    expect(payload.quietTurns.ratio).toBe("13.0%");
    const flags = payload.quietTurns.recent.map((row: { flags: string[] }) => row.flags.join("+")).sort();
    expect(flags).toEqual(["aborted", "aborted", "error", "timedOut", "timedOut", "timedOut"]);
  });

  it("has no renderer that reads costUsd or durationMs as an outcome signal", () => {
    for (const path of ["src/cli/ops.ts", "src/cli/ops-views.ts"]) {
      const source = readFileSync(path, "utf8");
      // The words may appear in a COMMENT explaining why they are not read;
      // they must never appear in a filter, a projection or a rendered field.
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
        .join("\n");
      expect(code).not.toContain("costUsd");
      expect(code).not.toContain("durationMs");
    }
  });

  it("reports an empty window as unmeasurable rather than as no failures", async () => {
    const { f, db } = await ready();
    const { payload } = await view(db, f, ["ops", "stalled"]);
    expect(payload.quietTurns.measurable).toBe(false);
    expect(payload.quietTurns.windowMinutes).toBe(1440);
    expect(payload.quietTurns.ratio).toBeNull();
    expect(payload.notes.unmeasurableWindow).toContain("not 'no failures'");
  });
});
```

**NV6 — the measured union.** Replace `QUIET_TURN_DISJUNCTS` with the single entry `[{ error: { $exists: true, $ne: null } }]`, then run `npx vitest run src/cli/ops.integration.test.ts -t "AC6"`.

**Predicted failure — exactly one case red:** `AC6 › yields a row for EVERY member of the measured union…`, with `matched` reporting **1** instead of 6, `ratio` reporting `"2.2%"`, and the `flags` array reporting `["error"]`. **Predicted green:** the cost limb (it asserts an ABSENCE, and a narrower filter cannot produce one), the source scan, and the unmeasurable-window case. **Also predicted green: the harness-divergence guard in `ops-views.test.ts`** — the mutation keeps `$exists: true` on the surviving disjunct, so that guard does not double as a union test, which is why the union has its own criterion.

**Restore** and re-run before continuing.

- [ ] **Step 6:** Append AC7, then run NV5.

```typescript
describe("AC7 — no error text, no receipts", () => {
  it("contains no substring of any fixture row's error value", async () => {
    const { f, db } = await ready();
    const secret = "ECONNREFUSED /Users/mokie/.hive/credentials sk-ant-notarealkey";
    await seedTurn(db, { threadId: "ER0", error: secret });
    const { payload } = await view(db, f, ["ops", "stalled"]);
    const rendered = JSON.stringify(payload);
    for (const token of secret.split(" ")) expect(rendered).not.toContain(token);
    // What IS rendered is that the flag was set, plus the thread and the agent
    // — the responder's next two steps.
    expect(payload.quietTurns.recent[0]).toMatchObject({ threadId: "ER0", agentId: "mokie", flags: ["error"] });
    expect(payload.notes.noErrorText).toContain("never the `error` string");
  });

  it("excludes KPR-456 delivery receipts, behaviourally AND structurally", async () => {
    const { f, db } = await ready();
    await seedTurn(db, { threadId: "OK0" });
    await seedTurn(db, { threadId: "ER0", error: "boom" });
    // ⚠ THE FIXTURE IS A RECEIPT PLUS AN `error` FIELD, AND IT HAS TO BE.
    // A schema-faithful receipt (src/obligations/types.ts:145-158) carries none
    // of error / aborted / timedOut, so it fails the union test on its own and
    // this limb would pass with TURN_ACTIVITY_FILTER deleted — green while
    // asserting nothing. This document is the adversarial input that actually
    // separates a filtered read from an unfiltered one.
    await db.collection("activity_log").insertOne({
      recordKind: "delivery_receipt",
      receiptId: "r1",
      obligationId: "daily-brief",
      dueAt: ago(15),
      producerAgentId: "mokie",
      destination: { kind: "slack", id: "C1" },
      providerMessageTs: "1700000000.0001",
      acknowledgedAt: ago(14),
      timestamp: ago(14),
      schemaVersion: 1,
      error: "boom",
    });
    const before = db.operations.length;
    const { payload } = await view(db, f, ["ops", "stalled"]);
    expect(payload.quietTurns.matched).toBe(1);
    expect(payload.quietTurns.turnsInWindow).toBe(2);
    expect(payload.quietTurns.recent.map((row: { threadId: string }) => row.threadId)).toEqual(["ER0"]);
    // The structural companion: the filter the reader actually sent carries the
    // shared constant rather than a hand-written duplicate.
    const reads = db.operations
      .slice(before)
      .filter((o) => o.collection === "activity_log" && ["find", "countDocuments"].includes(o.operation));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(JSON.stringify(read.context.filter)).toContain('"recordKind":{"$ne":"delivery_receipt"}');
  });
});
```

**NV5 — `TURN_ACTIVITY_FILTER`.** Delete the `...TURN_ACTIVITY_FILTER` spread from `windowFilter` in `readQuietTurns`, then run `npx vitest run src/cli/ops.integration.test.ts -t "AC7"`.

**Predicted failure — exactly one case red, and it aborts at its FIRST assertion:** `AC7 › excludes KPR-456 delivery receipts, behaviourally AND structurally`. Vitest throws out of a case on the first failing `expect`, so what is actually observed is one line — `expected 2 to be 1` on `payload.quietTurns.matched`, the receipt's `error: "boom"` now satisfying the union — and the `turnsInWindow`, `recent` and structural assertions in the same case **never execute**. Record that, not a three-assertion set. Stated for the record only, because a reader will otherwise expect to see them: had the case continued, `turnsInWindow` would report 3; `recent` would report `["ER0", "(unset)"]` (the page sorts `timestamp: -1`, and the `ago(10)` error row precedes the `ago(14)` receipt, whose absent `threadId` renders through the row mapper's total fallback rather than throwing); and the structural half would fail because the recorded filter no longer contains `recordKind`.

**Predicted green — and each for its own reason, which is what makes the prediction checkable:** `AC7 › contains no substring of any fixture row's error value` (the mutation changes WHICH rows are read, never what is rendered from one, and that fixture seeds no receipt); **every AC6 case**, because AC6 seeds no receipt at all, so its `turnsInWindow` and `matched` counts are identical under both implementations; and every AC1/AC3/AC8 case, none of which reads `activity_log`. **If any AC6 case goes red, a receipt has leaked into a shared fixture** — the per-case `ready()` helper mints a fresh `FakeDb`, so that would mean the helper was changed to share one; report it rather than adjusting the prediction.

**Restore** and re-run before continuing.

- [ ] **Step 7:** Append AC8 and AC16. The tests land here; **[chunk 4b](kpr-455-plan-4b-acceptance.md) Step 9 hosts the NV2 and NV3 runs** — do not run them from this step.

```typescript
describe("AC8 — matchedSubscriptions is rendered as a past-tense fact", () => {
  const openCondition = (over: Partial<OpsEvent> = {}) => ({
    subject: { kind: "workItem", id: "w1" },
    dedupeKey: "hive-runtime:workItem:w1:blocked:0",
    reasonId: "blocked",
    ...over,
  });

  it("renders an unmatched open condition with its count AND the publish instant", async () => {
    const { f, db } = await ready();
    await seedEvent(db, openCondition({ publishedAt: ago(60), matchedSubscriptions: 0, matchedSubscriptionIds: [] }));
    const { payload } = await view(db, f, ["ops", "stalled"]);
    expect(payload.openConditions.rows).toHaveLength(1);
    expect(payload.openConditions.rows[0]).toMatchObject({
      matchedAtPublish: 0,
      matchedAtPublishAsOf: ago(60).toISOString(),
      state: "open",
    });
  });

  it("uses no present-tense phrasing in EITHER direction, including a nonzero stamp", async () => {
    const { f, db } = await ready();
    await seedEvent(db, openCondition({ publishedAt: ago(60), matchedSubscriptions: 0 }));
    await seedEvent(
      db,
      openCondition({
        publishedAt: ago(50),
        dedupeKey: "hive-runtime:workItem:w2:blocked:0",
        subject: { kind: "workItem", id: "w2" },
        matchedSubscriptions: 2,
        matchedSubscriptionIds: ["s1", "s2"],
      }),
    );
    const { payload } = await view(db, f, ["ops", "stalled"]);
    const rendered = JSON.stringify(payload).toLowerCase();
    for (const phrase of ["claimed by nobody", "unclaimed", "nobody is on this", "is claimed", "claimed by"])
      expect(rendered).not.toContain(phrase);
    expect([...collectKeys(payload)]).not.toContain("matchedSubscriptions");
    expect(payload.notes.matchedAtPublish).toContain("past-tense fact");
  });
});

describe("AC16 — arm 1's clearing test, four class outcomes and two negatives", () => {
  const KEY = "hive-runtime:workItem:w1:blocked:0";

  async function drive(
    cls: string,
    clearing: Partial<OpsEvent> | null,
  ): Promise<{ rows: Array<{ dedupeKey: string; class: string; state: string }> }> {
    const { f, db } = await ready();
    await seedEvent(db, {
      publishedAt: ago(60),
      class: cls as OpsEvent["class"],
      reasonId: "blocked",
      subject: { kind: "workItem", id: "w1" },
      dedupeKey: KEY,
    });
    if (clearing)
      await seedEvent(db, {
        publishedAt: ago(30),
        reasonId: "unblocked",
        class: "informational",
        subject: { kind: "workItem", id: "w1" },
        dedupeKey: "hive-runtime:workItem:w1:unblocked:0",
        clears: KEY,
        clearsFamily: "hive-runtime:workItem:w1:unblocked",
        evidence: [],
        ...clearing,
      });
    const { payload } = await view(db, f, ["ops", "stalled"]);
    return { rows: payload.openConditions.rows };
  }

  const EVIDENCE = { evidence: [{ kind: "workItem", id: "w1" }] };

  it("resource: a same-producer clearing fact CLEARS", async () => {
    expect((await drive("resource", {})).rows).toEqual([]);
  });

  it("judgment: cleared only with evidence, open with none", async () => {
    expect((await drive("judgment", {})).rows).toHaveLength(1);
    expect((await drive("judgment", EVIDENCE)).rows).toEqual([]);
  });

  it("integrity: cleared only with evidence, open with none", async () => {
    expect((await drive("integrity", {})).rows).toHaveLength(1);
    expect((await drive("integrity", EVIDENCE)).rows).toEqual([]);
  });

  it("informational: NEVER cleared", async () => {
    expect((await drive("informational", EVIDENCE)).rows).toHaveLength(1);
  });

  it("a clearing fact from a DIFFERENT producer does not clear", async () => {
    const rows = (await drive("resource", { producer: "florist" })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(KEY);
  });

  it("an unrecognized class stays OPEN and renders class: unknown", async () => {
    // The forward-compatibility limb, hand-seeded because no producer can emit
    // it: `class` is contract-fixed vocabulary (kpr-458-design.md:370), so a
    // fifth value is a contract revision rather than registry data. It goes red
    // against the plausible mis-implementation `if (class !== "informational")
    // return true`.
    const rows = (await drive("catastrophic", EVIDENCE)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ class: "unknown", state: "open" });
  });
});
```

⚠ **`drive()` mints a fresh instance per call** (`ready()` builds a new `FakeDb` and a new temp-dir fixture each time), which is why the two-limb cases can call it twice without their fixtures interfering. That is load-bearing for NV5's prediction above, and it is why the seeding is inside `drive` rather than in a `beforeEach`.

- [ ] **Step 8:** Append AC9, AC12 and AC13, then run NV7.

```typescript
describe("AC9 — the edge's six obligations, one test per row of D7's table", () => {
  const HANDLE = "65a1b2c3d4e5f60718293a4b";
  const base = ["ops", "ack", HANDLE, "--act", "seen", "--actor", "U0FAKE"];

  it("one act per invocation: every accept call carries an identical tuple and `at` is minted exactly once", async () => {
    const { f, db } = await ready();
    const notifier = new ProgrammedNotifier([{ state: "unavailable" }]);
    // A clock that MOVES on every call — without it "minted once" is
    // unfalsifiable, because a re-minted `at` on a single-call path is
    // indistinguishable from a minted-once one.
    const clock = steppingClock();
    const d = deps(db, f.selection, { clock, makeNotifier: () => notifier });
    await runOps([...base, "--config", f.path, "--json"], d);
    expect(notifier.accepted.length).toBeGreaterThan(1);
    const first = notifier.accepted[0]!;
    for (const call of notifier.accepted)
      expect([call.handle, call.act, call.actorId, call.at.getTime()]).toEqual([
        first.handle,
        first.act,
        first.actorId,
        first.at.getTime(),
      ]);
  });

  it("issues no ledger and no ops_subscriptions query of its own", async () => {
    const { f, db } = await ready();
    const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }]);
    const before = db.operations.length;
    const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
    await runOps([...base, "--config", f.path, "--json"], d);
    // The injected notifier performs no I/O, so ANY ops_notifications or
    // ops_subscriptions operation in this window belongs to the edge itself.
    for (const op of db.operations.slice(before))
      expect(["ops_notifications", "ops_subscriptions"]).not.toContain(op.collection);
  });

  it("refuses a missing actor before any connection", async () => {
    const { f, db } = await ready();
    const d = deps(db, f.selection, { clock: fixedClock() });
    await expect(runOps(["ops", "ack", HANDLE, "--act", "seen", "--config", f.path], d)).rejects.toThrow(
      "actor_required",
    );
    expect(d.connects).toBe(0);
  });

  it("passes `at` at full millisecond precision, unrounded", async () => {
    const { f, db } = await ready();
    const odd = new Date("2026-01-10T12:00:00.137Z");
    const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }]);
    const d = deps(db, f.selection, { clock: () => odd, makeNotifier: () => notifier });
    await runOps([...base, "--config", f.path, "--json"], d);
    expect(notifier.accepted[0]!.at.getTime()).toBe(odd.getTime());
    expect(notifier.accepted[0]!.at.getMilliseconds()).toBe(137);
  });

  it("accepts no --at flag under strict parseArgs", async () => {
    const { f, db } = await ready();
    const d = deps(db, f.selection, { clock: fixedClock() });
    await expect(
      runOps([...base, "--at", "2026-01-01T00:00:00Z", "--config", f.path], d),
    ).rejects.toThrow("command_failed");
  });

  it("reads snoozedUntil only when rowState is snoozed", async () => {
    const { f, db } = await ready();
    const until = new Date("2026-01-12T00:00:00.000Z");
    for (const [rowState, expected] of [
      ["snoozed", until.toISOString()],
      ["seen", undefined],
    ] as const) {
      const notifier = new ProgrammedNotifier([{ state: "applied", rowState, snoozedUntil: until }]);
      const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
      await runOps([...base, "--config", f.path, "--json"], d);
      expect(JSON.parse(d.emitted.at(-1)!).snoozedUntil).toBe(expected);
    }
  });
});

describe("AC12 — write side effects confined to the ack path", () => {
  it("calls init() on ack and on NEITHER read path", async () => {
    const { f, db } = await ready();
    const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }]);
    for (const argv of [["ops", "health"], ["ops", "stalled"]]) {
      const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
      await runOps([...argv, "--config", f.path, "--json"], d);
    }
    expect(notifier.initCalls).toBe(0);
    const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
    await runOps(["ops", "ack", "65a1b2c3d4e5f60718293a4b", "--act", "seen", "--actor", "U1", "--config", f.path, "--json"], d);
    expect(notifier.initCalls).toBe(1);
  });

  it("reports a throwing init() as notifier_init_failed, never as unknown-handle or unavailable, with no accept call", async () => {
    const { f, db } = await ready();
    const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }], true);
    const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
    await expect(
      runOps(["ops", "ack", "65a1b2c3d4e5f60718293a4b", "--act", "seen", "--actor", "U1", "--config", f.path], d),
    ).rejects.toThrow("notifier_init_failed");
    expect(notifier.accepted).toHaveLength(0);
    expect(d.emitted).toEqual([]);
  });
});

describe("AC13 — the identity guard", () => {
  it("fails identity_unverified on every subcommand before any read and any accept", async () => {
    const f = fixture();
    for (const argv of [
      ["ops", "health"],
      ["ops", "stalled"],
      ["ops", "ack", "65a1b2c3d4e5f60718293a4b", "--act", "seen", "--actor", "U1"],
    ]) {
      const db = new FakeDb();
      await seedEvent(db);
      const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }]);
      const before = db.operations.length;
      const d = deps(db, f.selection, { clock: fixedClock(), makeNotifier: () => notifier });
      await expect(runOps([...argv, "--config", f.path], d)).rejects.toThrow("identity_unverified");
      const during = db.operations.slice(before).map((o) => o.collection);
      expect(during).toEqual(["instance_identity"]);
      expect(notifier.initCalls).toBe(0);
      expect(notifier.accepted).toHaveLength(0);
    }
  });
});
```

**NV7 — `at` minted once.** In `executeOps`, move `const now = deps.clock();` so the ack path re-reads the clock inside `runAck`'s retry loop (pass `deps.clock()` into each `accept` call instead of `opts.input`), then run `npx vitest run src/cli/ops.integration.test.ts -t "AC9"` and `-t "AC11"`.

**Predicted failure — TWO cases red, and the report must name both:** `AC9 › one act per invocation: every accept call carries an identical tuple and `at` is minted exactly once` (the second call's `at` is 1 000 ms later than the first, so the `toEqual` on the four-element tuple fails on the timestamp) and `AC11 › unavailable renders as UNKNOWN with the act, handle and fixed at` (the rendered `at` is the LAST attempt's rather than the invocation's). **Predicted green:** AC9's other five cases and every other AC11 outcome — each resolves on the first `accept` call, where a re-minted `at` is indistinguishable from a minted-once one. That indistinguishability is precisely why AC9's tuple case is driven through a notifier programmed to return `unavailable`; a happy-path-only suite cannot see this mutation at all.

**Restore** and re-run before continuing.

**Continue in [chunk 4b](kpr-455-plan-4b-acceptance.md)** — Steps 9–11 (AC10, AC11, AC14, the NV2 and NV3 runs, the whole-suite verification and this task's single commit). Do not commit from here: the whole acceptance file lands in one commit.
