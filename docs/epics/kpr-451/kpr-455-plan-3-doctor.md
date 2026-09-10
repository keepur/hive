# KPR-455 chunk 3 — The `hive doctor` section

**Task 3 of 5.** Read [the plan index](kpr-455-plan.md) and all eight chunk files before starting.

This is the spec's **deliberate divergence from the KPR-456 precedent**, which shipped its CLI with no doctor section. It is declined for a reason specific to this epic rather than to taste: an ops pipeline that has stopped is invisible until somebody thinks to look at it, and "thinking to look" is exactly what fails in the incident this epic was filed about. KPR-468 names its own worst case — a deterministically-faulting event wedges ingest, `eventsBehind` and `oldestUnappliedAt` grow without bound, and if it stands long enough the queued events age past the event TTL and are lost — and states that the heartbeat is the only signal. Putting that signal on the surface an operator already runs is the epic's own thesis applied to the epic's own machinery.

**The section is informational and NEVER flips the exit code** (KPR-296 canon: only the Datastore identity section may).

**Files**

- Modify: `src/cli/doctor-checks.ts` — one fetcher after `outageQueueStatsForDoctor` (`:585-608`)
- Modify: `src/cli/doctor.ts` — one renderer after `renderOutageQueueSection` (`:252-273`), one call in the post-check block after the outage-queue section (`:770-774`), one line in the `config not loaded` else-branch (`:794-814`)
- Create: `src/cli/ops-doctor.test.ts`

**Tier: `capable`.** Two of its branches are judgment rather than mechanism: `backlog` renders informationally while `degraded` warns (collapsing them re-introduces exactly the noise this epic removes), and the staleness coercion keys on `timestamp` rather than on `lastSuccessfulSweep` — which is edge case 4's rule applied to KPR-468's own liveness field, argued and ruled on in the plan index, and driven end to end by this chunk's own `opsPipelineForDoctor` case.

---

## Task 3: the section

- [ ] **Step 1:** Add the fetcher to `src/cli/doctor-checks.ts`, immediately after `outageQueueStatsForDoctor`'s closing brace (`:608` at this tree — key on the function name).

```typescript
/**
 * KPR-455 D2/D9: ops event pipeline snapshot. Reads KPR-468's
 * `ops_notifier_stats` heartbeat and `ops_events`' own recency, through the
 * SAME functions the `hive ops` read commands use — so the doctor and the CLI
 * cannot drift on the staleness rule. Returns null when Mongo is unreachable.
 *
 * Informational only. Nothing in this path writes, creates an index, or calls
 * any sibling's init().
 */
export interface OpsPipelineStats {
  pipeline: PipelineFreshness;
  log: OpsLogPresence;
}

export async function opsPipelineForDoctor(uri: string, dbName: string): Promise<OpsPipelineStats | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const now = new Date();
    return { pipeline: await readPipeline(db, now), log: await readOpsLogPresence(db, now) };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
```

Add to the imports at the top of `src/cli/doctor-checks.ts`:

```typescript
import { readOpsLogPresence, readPipeline, type OpsLogPresence, type PipelineFreshness } from "./ops-views.js";
```

⚠ **No `HEARTBEAT_STALE_MS` import.** An earlier draft imported it here with a conditional instruction to drop it if unused; it *is* unused, because the 120 s coercion happens inside `readPipeline` and this file only reads the resolved `stale` boolean off the result. Importing it would be an unused-import lint error and, worse, would invite a second staleness test on this side of the seam.

- [ ] **Step 2:** Add the renderer to `src/cli/doctor.ts`, immediately after `renderOutageQueueSection`'s closing brace (`:273` at this tree — key on the function name).

```typescript
/** One title, used by BOTH the renderer and the `config not loaded`
 *  else-branch, because a section whose two spellings drift is a section an
 *  operator cannot grep for. */
export const OPS_PIPELINE_SECTION_TITLE = "Ops event pipeline (KPR-455)";

/** The doctor warns when the oldest unapplied event has aged past this fraction
 *  of the event TTL — an age against an age, which is the one form of KPR-468
 *  D5's TTL-outrun signal a SINGLE SAMPLE can see. Half leaves an operator the
 *  same margin again to act. Declared ABOVE its only use: a `const` read from a
 *  function declared earlier in the file is correct at runtime but reads as a
 *  TDZ bug, and trips `no-use-before-define` if that rule is ever enabled. */
const RETENTION_FRACTION_WARN = 0.5;

/**
 * KPR-455 D2/D9: informational ops-pipeline liveness. NEVER affects the exit
 * code — KPR-296 canon reserves that for the Datastore identity section alone.
 *
 * ⚠ `state: "backlog"` RENDERS AND DOES NOT WARN. KPR-468's heartbeat carries
 * `ok | backlog | degraded`: all phases succeeded with no backlog ⇒ ok, all
 * succeeded WITH backlog ⇒ backlog, any phase failed ⇒ degraded
 * (kpr-468-design.md:282). A backlog means the sweep is working and behind — a
 * normal, self-correcting state after a burst — so warning on it would put a ⚠
 * on healthy operation, which is the noise this epic exists to remove. What
 * escalates a backlog is the INDEPENDENT condition already in the list: an
 * `oldestUnappliedAt` aged against the activity retention, which is KPR-468
 * D5's TTL-outrun measure and warns whatever `state` says.
 *
 * ⚠ SINGLE-SAMPLE LIMITATION, printed rather than papered over. KPR-468's wedge
 * signature is `ingestFaults` climbing WHILE `cursorAt` stands still — a rate
 * against a static value, which one read cannot see.
 */
export function renderOpsPipelineSection(
  stats: OpsPipelineStats | null,
  activityRetentionDays: number,
  emit: (line: string) => void = console.log,
): void {
  emit(`\n${OPS_PIPELINE_SECTION_TITLE}`);
  if (stats === null) {
    emit("  ○ unavailable — mongo unreachable");
    return;
  }
  const p = stats.pipeline;
  if (!p.present) {
    emit("  ○ no heartbeat yet — start the engine and re-check");
    // The publisher and the notifier are separate components, so an absent
    // heartbeat says nothing about whether events are being published.
    emit(`  events: ${stats.log.present ? `newest ${ageLabel(stats.log.newestEventAgeSeconds)} ago` : "no ops event log"}`);
    return;
  }
  const beat = ageLabel(p.heartbeatAgeSeconds);
  const sweep = p.lastSuccessfulSweepAgeSeconds === null ? "never" : `${ageLabel(p.lastSuccessfulSweepAgeSeconds)} ago`;
  emit(
    `  state=${p.state}${p.reportedState && p.reportedState !== p.state ? ` (reported ${p.reportedState})` : ""} ` +
      `heartbeat ${beat} ago, last successful sweep ${sweep}`,
  );
  emit(
    `  behind=at least ${p.eventsBehind ?? "?"} oldest-unapplied=${
      p.oldestUnappliedAt ? `${ageLabel(p.oldestUnappliedAgeSeconds)} old` : "none"
    } cursor=${p.cursorAt ? p.cursorAt.toISOString() : "unset"} ingestFaults=${p.ingestFaults ?? "?"} sweepFaults=${p.sweepFaults ?? "?"}`,
  );
  emit(
    `  events: ${stats.log.present ? `newest ${ageLabel(stats.log.newestEventAgeSeconds)} ago (last-known publisher activity, NOT a health signal)` : "no ops event log"}`,
  );

  if (p.stale) emit("  ⚠ heartbeat is stale — engine may not be running, or the notifier's sweep is not writing");
  if (p.reportedState === "degraded") emit("  ⚠ a sweep phase is failing — check engine logs (ops-notifier)");
  if ((p.ingestFaults ?? 0) > 0)
    emit("  ⚠ ingest faults recorded — a deterministically-faulting event wedges ingest until an operator intervenes");
  const retentionSeconds = activityRetentionDays * 86_400;
  if ((p.oldestUnappliedAgeSeconds ?? 0) > retentionSeconds * RETENTION_FRACTION_WARN)
    emit(
      `  ⚠ oldest unapplied event has aged past ${RETENTION_FRACTION_WARN * 100}% of the ${activityRetentionDays}d event retention — events can age out unapplied`,
    );
  emit("  (one read cannot see a rate: run twice a minute apart to tell a blip from a wedge)");
}

function ageLabel(seconds: number | null): string {
  if (seconds === null) return "?";
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
```

Add to the imports at the top of `src/cli/doctor.ts`:

```typescript
import { opsPipelineForDoctor, type OpsPipelineStats } from "./doctor-checks.js";
```

(the existing import block from `./doctor-checks.js` is the one to extend — do not add a second import statement from the same module).

- [ ] **Step 3:** Call it from the post-check block in `src/cli/doctor.ts`, immediately after the `renderOutageQueueSection(...)` call (`:771-774` at this tree).

```typescript
    // KPR-455: ops event pipeline (informational — KPR-296 canon: only
    // identity-class incidents flip the exit code). Placed after the outage
    // queue so the two "is the engine's background work alive" sections sit
    // together.
    const opsPipeline = await opsPipelineForDoctor(config.mongo.uri, config.mongo.dbName);
    renderOpsPipelineSection(opsPipeline, config.activity.retentionDays);
```

- [ ] **Step 4:** Add the else-branch line in `src/cli/doctor.ts`, immediately after the outage-queue pair in the `config not loaded` block (`:807-808` at this tree).

```typescript
    console.log(`\n${OPS_PIPELINE_SECTION_TITLE}`);
    console.log("  ○ skipped: config not loaded");
```

⚠ **This is the entry a new section reliably forgets.** A section that renders under `if (config)` and prints nothing under `else` reads to an operator as "this hive has no ops pipeline" rather than "the doctor could not tell", which is the same absence-is-not-health defect this child exists to remove, one level up.

- [ ] **Step 5:** Create `src/cli/ops-doctor.test.ts`.

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderOpsPipelineSection, OPS_PIPELINE_SECTION_TITLE } from "./doctor.js";
import { opsPipelineForDoctor, type OpsPipelineStats } from "./doctor-checks.js";
import { FakeDb } from "../ops/testing/fake-db.js";
import { NOTIFIER_STATS_KIND } from "../ops/notification-store.js";
import type { PipelineFreshness } from "./ops-views.js";

/* ⚠ `vi.hoisted`, not a bare top-level `const`: `vi.mock`'s factory is hoisted
 * above the module's own initialisers, and a factory closing over a plain
 * `const` fails with "cannot access before initialization". This slot is how
 * each case programs the driver without re-mocking the module. */
const driver = vi.hoisted(() => ({ db: null as unknown, connectThrows: false, closes: 0 }));

/* Only `MongoClient` is replaced — `ObjectId` and everything else stay real,
 * which matters because `ops-views.ts` and the double both import them. */
vi.mock("mongodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongodb")>();
  class FakeMongoClient {
    async connect(): Promise<void> {
      if (driver.connectThrows) throw new Error("ECONNREFUSED 127.0.0.1:27017");
    }
    db(): unknown {
      return driver.db;
    }
    async close(): Promise<void> {
      driver.closes += 1;
    }
  }
  // The cast is the honest one: this stub implements the three members the
  // fetcher uses and nothing else, and `typeof actual.MongoClient` is what the
  // module's consumers are typed against.
  return { ...actual, MongoClient: FakeMongoClient as unknown as typeof actual.MongoClient };
});

const RETENTION_DAYS = 90;

function pipeline(over: Partial<PipelineFreshness> = {}): PipelineFreshness {
  return {
    present: true,
    state: "ok",
    reportedState: "ok",
    heartbeatAgeSeconds: 12,
    lastSuccessfulSweepAgeSeconds: 12,
    stale: false,
    sweepSucceeding: true,
    cursorAt: new Date("2026-01-10T11:59:00.000Z"),
    eventsBehind: 0,
    eventsBehindIsAtLeast: true,
    oldestUnappliedAt: null,
    oldestUnappliedAgeSeconds: null,
    ingestFaults: 0,
    sweepFaults: 0,
    ...over,
  };
}

function stats(over: Partial<PipelineFreshness> = {}, logPresent = true): OpsPipelineStats {
  return {
    pipeline: pipeline(over),
    log: { present: logPresent, newestEventAt: logPresent ? new Date() : null, newestEventAgeSeconds: logPresent ? 30 : null },
  };
}

function render(input: OpsPipelineStats | null, retentionDays = RETENTION_DAYS): string[] {
  const lines: string[] = [];
  renderOpsPipelineSection(input, retentionDays, (line) => lines.push(line));
  return lines;
}

const warns = (lines: string[]) => lines.filter((line) => line.includes("⚠"));

describe("the ops event pipeline doctor section", () => {
  it("prints its title on every branch", () => {
    for (const input of [null, stats(), stats({ present: false })]) {
      expect(render(input)[0]).toContain(OPS_PIPELINE_SECTION_TITLE);
    }
  });

  it("reports mongo unreachable without warning", () => {
    const lines = render(null);
    expect(lines.join("\n")).toContain("unavailable — mongo unreachable");
    expect(warns(lines)).toEqual([]);
  });

  it("prints the no-heartbeat line and makes no health claim", () => {
    const lines = render(stats({ present: false, state: "unknown", reportedState: null }));
    expect(lines.join("\n")).toContain("○ no heartbeat yet — start the engine and re-check");
    expect(lines.join("\n")).not.toMatch(/healthy|ok\b/i);
  });

  it("state backlog renders informationally and produces NO warn", () => {
    const lines = render(
      stats({ state: "backlog", reportedState: "backlog", eventsBehind: 500, oldestUnappliedAt: new Date(), oldestUnappliedAgeSeconds: 300 }),
    );
    expect(lines.join("\n")).toContain("state=backlog");
    expect(lines.join("\n")).toContain("behind=at least 500");
    expect(warns(lines)).toEqual([]);
  });

  it("a backlog whose oldest unapplied event crosses the retention fraction DOES warn", () => {
    const lines = render(
      stats({
        state: "backlog",
        reportedState: "backlog",
        eventsBehind: 500,
        oldestUnappliedAt: new Date(),
        oldestUnappliedAgeSeconds: 60 * 86_400,
      }),
    );
    expect(warns(lines).join("\n")).toContain("event retention");
  });

  it("warns on degraded, on a stale heartbeat and on non-zero ingest faults", () => {
    expect(warns(render(stats({ state: "degraded", reportedState: "degraded" }))).join("\n")).toContain(
      "a sweep phase is failing",
    );
    expect(
      warns(render(stats({ stale: true, state: "unknown", reportedState: "ok", heartbeatAgeSeconds: 900 }))).join("\n"),
    ).toContain("heartbeat is stale");
    expect(warns(render(stats({ ingestFaults: 3 }))).join("\n")).toContain("ingest faults recorded");
  });

  it("renders a degraded state even when the heartbeat is fresh but sweeps never succeed", () => {
    // The running-but-never-succeeding signature: the staleness coercion keys
    // on `timestamp` (written every tick) rather than on `lastSuccessfulSweep`
    // (written only after an all-ok tick), so `degraded` stays reportable.
    const lines = render(stats({ state: "degraded", reportedState: "degraded", lastSuccessfulSweepAgeSeconds: null }));
    expect(lines.join("\n")).toContain("last successful sweep never");
    expect(warns(lines).join("\n")).toContain("a sweep phase is failing");
  });

  it("labels event recency as last-known publisher activity and not as health", () => {
    expect(render(stats()).join("\n")).toContain("NOT a health signal");
    expect(render(stats({}, false)).join("\n")).toContain("no ops event log");
  });

  it("always prints the single-sample limitation", () => {
    expect(render(stats()).join("\n")).toContain("run twice a minute apart");
  });

  it("returns void, so no caller can route it into allPassed", () => {
    expect(renderOpsPipelineSection(stats(), RETENTION_DAYS, () => {})).toBeUndefined();
  });
});

describe("opsPipelineForDoctor — the fetcher, not the renderer", () => {
  beforeEach(() => {
    driver.db = null;
    driver.connectThrows = false;
    driver.closes = 0;
  });

  it("returns null when Mongo is unreachable, and still closes the client", async () => {
    // The fetcher's OWN null branch. `render(null)` exercises the RENDERER's
    // null branch and says nothing about this one; without this case the
    // fetcher has no test at all.
    driver.connectThrows = true;
    expect(await opsPipelineForDoctor("mongodb://demo.invalid", "hive_demo")).toBeNull();
    expect(driver.closes).toBe(1);
  });

  it("⚠ THE DEPARTURE end to end: a fresh heartbeat beside a NEVER-SUCCEEDING sweep still reports degraded", async () => {
    // The one case that distinguishes the two staleness rules through the
    // doctor's own path. `readPipeline` coerces past 120 s on `timestamp` —
    // KPR-468 writes it on EVERY tick including a degraded one — rather than on
    // `lastSuccessfulSweep`, which advances only after an all-ok tick. Under
    // the other rule this row would render `state: unknown` two minutes in and
    // the section would print "engine may not be running" about an engine that
    // is running and failing, which is this epic's own thesis inverted.
    // (The coercion itself is unit-pinned in `ops-views.test.ts`; what this
    // case adds is that the fetcher and the renderer preserve it.)
    const db = new FakeDb();
    await db.collection("telemetry").insertOne({
      kind: NOTIFIER_STATS_KIND,
      timestamp: new Date(Date.now() - 30_000),
      lastSuccessfulSweep: null,
      state: "degraded",
      eventsBehind: 3,
      cursorAt: new Date(Date.now() - 60_000),
      ingestFaults: 0,
      sweepFaults: 2,
    });
    driver.db = db.db;
    const fetched = await opsPipelineForDoctor("mongodb://demo.invalid", "hive_demo");
    expect(fetched).not.toBeNull();
    expect(fetched!.pipeline).toMatchObject({
      present: true,
      stale: false,
      state: "degraded",
      reportedState: "degraded",
      sweepSucceeding: false,
    });
    // ops_events was never written to, so the log reads absent — and that is
    // reported as absent rather than as health.
    expect(fetched!.log.present).toBe(false);
    expect(driver.closes).toBe(1);
    // And the renderer carries it through: the degraded warn fires, the
    // stale-heartbeat warn does not, and the sweep reads "never".
    const lines = render(fetched);
    expect(lines.join("\n")).toContain("last successful sweep never");
    expect(warns(lines).join("\n")).toContain("a sweep phase is failing");
    expect(warns(lines).join("\n")).not.toContain("heartbeat is stale");
  });
});
```

- [ ] **Step 6:** Verify.

```bash
npx tsc --noEmit
npx vitest run src/cli/ops-doctor.test.ts
npx vitest run src/cli/doctor.test.ts src/cli/doctor-checks.test.ts
npx prettier --check src/cli/doctor.ts src/cli/doctor-checks.ts src/cli/ops-doctor.test.ts
npx eslint src/cli/doctor.ts src/cli/doctor-checks.ts src/cli/ops-doctor.test.ts
# The else-branch is the entry a new section forgets — assert BOTH spellings exist.
grep -c "OPS_PIPELINE_SECTION_TITLE" src/cli/doctor.ts
```

**Expected:** `tsc` exits 0. The new suite passes with zero skipped. The two existing doctor suites pass **unchanged**. Prettier and ESLint clean. The grep prints **3** (the declaration, the renderer's own emit, and the else-branch line).

- [ ] **Step 7 (NV9):** Negative-verify the `backlog` branch.

In `renderOpsPipelineSection`, change the degraded warn's condition from `p.reportedState === "degraded"` to `p.reportedState !== "ok"`, then run `npx vitest run src/cli/ops-doctor.test.ts`.

**Predicted failure — exactly one case red:** `the ops event pipeline doctor section › state backlog renders informationally and produces NO warn`, with `warns(lines)` reporting one element (`"  ⚠ a sweep phase is failing — check engine logs (ops-notifier)"`) against an expected `[]`. **Predicted green: every other case**, including all four warn cases and both `opsPipelineForDoctor` cases — the mutation only WIDENS the warn set, each of the four already expects a warn, the fetcher's null case renders no state line at all, and the departure case's `reportedState` is already `"degraded"`, so none of them can distinguish the two implementations. That asymmetry is exactly why the `backlog` case is written as a negative assertion on the warn count rather than as a positive assertion on the rendered line; a positive-only suite would go green under this mutation and prove nothing.

Note also the second-order prediction: `a backlog whose oldest unapplied event crosses the retention fraction DOES warn` **stays green for the wrong reason** under the mutation (two warns instead of one), which is why it asserts on the warn text rather than on the count.

**Restore** (`git checkout -- src/cli/doctor.ts`) and re-run to confirm green.

- [ ] **Step 8:** Commit.

```bash
git add src/cli/doctor.ts src/cli/doctor-checks.ts src/cli/ops-doctor.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-455): informational ops event pipeline section in hive doctor

The epic's own thesis applied to the epic's own machinery: a feed that has gone
quiet is indistinguishable from a healthy one, and that failure mode applies to
the ops feed itself. The section reads KPR-468's ops_notifier_stats heartbeat
and ops_events' recency through the same functions the CLI uses, so the two
cannot drift on the staleness rule.

Informational and never contributes to allPassed (KPR-296 canon). Warns on a
stale heartbeat, on state degraded, on non-zero ingest faults, and on an oldest
unapplied event aged past half the activity retention. `state: backlog` renders
informationally and does NOT warn on its own — a backlog is the sweep working
and behind. The config-not-loaded else-branch prints its own skipped line.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
