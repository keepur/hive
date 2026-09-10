# KPR-455 chunk 2b — The CLI's fixtures and its own suite

**Task 2 of 5, continued.** Read [the plan index](kpr-455-plan.md) and all seven chunk files before starting. **This chunk continues chunk 2's task: chunks 2 and 2b are ONE task and ONE commit**, and the commit block is at the end of this file. Read [chunk 2](kpr-455-plan-2-cli.md) first — the module this suite drives is written there.

**Files**

- Create: `src/cli/testing/ops-cli-fixtures.ts` — the shared fixture module this suite and chunk 4's acceptance suite both import
- Create: `src/cli/ops.test.ts`

**Tier: `capable`.** NV8 runs here, and its assertion is the one that has to spy on `process.stdout.write` rather than on the CLI's own emit seam — an emit-based assertion goes green with `setLogLevel` deleted and proves nothing.

---

- [ ] **Step 4:** Create `src/cli/testing/ops-cli-fixtures.ts` — a **plain module**, not an export from a `.test.ts`.

⚠ **This has to be a plain module.** Vitest re-registers an imported test file's suites and file-scope hooks into the importer (KPR-454's measured probe, and the reason `src/ops/testing/notifier-harness.ts` exists), so chunk 4's acceptance suite cannot import these helpers out of `ops.test.ts`. A plain module additionally gets `tsc --noEmit` coverage, which `tsconfig.json` excludes `.test.ts` files from. It is excluded from both siblings' source scans by their existing `/testing/` filters.

```typescript
/* Fixtures for the `hive ops` CLI suites. A PLAIN MODULE — see the note above.
 * It fabricates no Mongo behaviour: the double is KPR-454's
 * src/ops/testing/fake-db.ts, used unchanged. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { FakeDb } from "../../ops/testing/fake-db.js";
import type { CliSelection } from "../obligations.js";
import type { OpsAcknowledgement, OpsIntakeResult } from "../../ops/notification-types.js";
import type { OpsCliDependencies, OpsNotifierLike } from "../ops.js";

const roots: string[] = [];

/** The instance fixture, on src/cli/obligations.test.ts:22-30's shape. */
export function fixture(instanceId = "demo", extraYaml = "") {
  const root = mkdtempSync(join(tmpdir(), "hive-ops-test-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const path = join(root, "hive.yaml");
  const uri = "mongodb://" + instanceId + ".invalid";
  const dbName = "hive_" + instanceId;
  writeFileSync(path, "instance:\n  id: " + instanceId + "\n" + extraYaml);
  writeFileSync(join(root, ".env"), "MONGODB_URI=" + uri + "\nMONGODB_DB=" + dbName + "\n");
  return { root, path, selection: { configPath: path, instanceId, uri, dbName } satisfies CliSelection };
}

/** Call from each suite's own afterEach — the module holds no hooks of its own. */
export function cleanupFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** Seeds the identity sentinel so verifySentinel returns `verified`.
 *  `matches()` (src/db/identity-sentinel.ts:74-76) reads instanceId and dbName
 *  only; the rest of the document is shape. */
export function stampSentinel(db: FakeDb, selection: CliSelection): void {
  db.collection("instance_identity").rows.set("identity_sentinel", {
    _id: "identity_sentinel",
    schemaVersion: 1,
    instanceId: selection.instanceId,
    dbName: selection.dbName,
    sentinelId: "test-sentinel",
    stampedAt: new Date(),
    stampedBy: { engineVersion: "test", hostname: "test", pid: 1 },
  });
}

export class ProgrammedNotifier implements OpsNotifierLike {
  readonly accepted: OpsAcknowledgement[] = [];
  initCalls = 0;
  constructor(
    private readonly outcomes: OpsIntakeResult[],
    private readonly initThrows = false,
  ) {}
  async init(): Promise<void> {
    this.initCalls += 1;
    if (this.initThrows) throw new Error("ops_notifications identity index unavailable");
  }
  async accept(input: OpsAcknowledgement): Promise<OpsIntakeResult> {
    // Stores the REFERENCE deliberately, so a test can prove the edge never
    // rebuilds the tuple between attempts.
    this.accepted.push(input);
    return this.outcomes[Math.min(this.accepted.length - 1, this.outcomes.length - 1)]!;
  }
}

/** A clock that MOVES on every call — the only way "minted exactly once" is
 *  falsifiable. A fixed clock cannot distinguish the two implementations. */
export function steppingClock(start = new Date("2026-01-10T12:00:00.000Z"), stepMs = 1_000): () => Date {
  let calls = 0;
  return () => new Date(start.getTime() + stepMs * calls++);
}

export function deps(
  db: FakeDb,
  selection: CliSelection,
  over: Partial<OpsCliDependencies> = {},
): OpsCliDependencies & { emitted: string[]; connects: number; notifier: ProgrammedNotifier } {
  const emitted: string[] = [];
  const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }]);
  let connects = 0;
  const base: OpsCliDependencies = {
    async connect(candidate) {
      expect(candidate).toEqual(selection);
      connects += 1;
      return { db: db.db, close: async () => {} };
    },
    clock: steppingClock(),
    emit: (text) => emitted.push(text),
    makeNotifier: () => notifier,
    sleep: async () => {},
    ...over,
  };
  return Object.assign(base, {
    emitted,
    notifier,
    get connects() {
      return connects;
    },
  });
}
```

- [ ] **Step 5:** Create `src/cli/ops.test.ts`.

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FakeDb } from "../ops/testing/fake-db.js";
import { runOps } from "./ops.js";
import { cleanupFixtures, deps, fixture, ProgrammedNotifier, stampSentinel } from "./testing/ops-cli-fixtures.js";

vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: () => null }));

beforeEach(() => {
  for (const key of ["MONGODB_URI", "MONGODB_DB", "HIVE_HOME", "ACTIVITY_RETENTION_DAYS"]) vi.stubEnv(key, "");
  vi.stubEnv("HIVE_CONFIG", undefined);
});
afterEach(() => {
  cleanupFixtures();
  vi.unstubAllEnvs();
});

const payload = (d: { emitted: string[] }) => JSON.parse(d.emitted.at(-1)!);

describe("hive ops — argument parsing", () => {
  it("refuses an unknown subcommand, a stray positional and a stray handle before connecting", async () => {
    const f = fixture();
    const db = new FakeDb();
    for (const argv of [
      ["ops"],
      ["ops", "nope"],
      ["ops", "health", "extra", "more"],
      ["ops", "health", "handle"],
      ["ops", "ack"],
    ]) {
      const d = deps(db, f.selection);
      await expect(runOps([...argv, "--config", f.path], d)).rejects.toThrow(
        /invalid_command|unexpected_handle|handle_required/,
      );
      expect(d.connects).toBe(0);
    }
  });

  it("has NO --at flag, which strict parseArgs is what enforces", async () => {
    const f = fixture();
    const d = deps(new FakeDb(), f.selection);
    await expect(
      runOps(["ops", "ack", "h", "--act", "seen", "--actor", "U1", "--at", "2026-01-01T00:00:00Z", "--config", f.path], d),
    ).rejects.toThrow("command_failed");
    expect(d.connects).toBe(0);
  });

  it("refuses a missing or blank --actor, a bad act, a snooze with no --until and an unparseable --until, all before connecting", async () => {
    const f = fixture();
    const db = new FakeDb();
    const cases: Array<[string[], RegExp]> = [
      [["ops", "ack", "h", "--act", "seen"], /actor_required/],
      [["ops", "ack", "h", "--act", "seen", "--actor", "   "], /actor_required/],
      [["ops", "ack", "h", "--act", "shouted", "--actor", "U1"], /invalid_act/],
      [["ops", "ack", "h", "--act", "snoozed", "--actor", "U1"], /until_required/],
      [["ops", "ack", "h", "--act", "snoozed", "--actor", "U1", "--until", "tuesday"], /invalid_until/],
    ];
    for (const [argv, token] of cases) {
      const d = deps(db, f.selection);
      await expect(runOps([...argv, "--config", f.path], d)).rejects.toThrow(token);
      expect(d.connects).toBe(0);
      expect(d.notifier.initCalls).toBe(0);
    }
  });

  it("bounds --limit, --stale-after and --window", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    for (const [argv, token] of [
      [["ops", "health", "--limit", "0"], /invalid_limit/],
      [["ops", "health", "--limit", "101"], /invalid_limit/],
      [["ops", "health", "--stale-after", "0"], /invalid_stale_after/],
      [["ops", "stalled", "--window", "-5"], /invalid_window/],
    ] as Array<[string[], RegExp]>) {
      await expect(runOps([...argv, "--config", f.path], deps(db, f.selection))).rejects.toThrow(token);
    }
  });
});

describe("hive ops — the identity guard", () => {
  it("fails identity_unverified on every subcommand, before any read and before any accept", async () => {
    const f = fixture();
    for (const argv of [
      ["ops", "health"],
      ["ops", "stalled"],
      ["ops", "ack", "65a1b2c3d4e5f60718293a4b", "--act", "seen", "--actor", "U1"],
    ]) {
      const db = new FakeDb();
      // No sentinel stamped: verifySentinel returns mismatch.
      const d = deps(db, f.selection);
      await expect(runOps([...argv, "--config", f.path], d)).rejects.toThrow("identity_unverified");
      expect(d.notifier.initCalls).toBe(0);
      expect(d.notifier.accepted).toHaveLength(0);
      expect(db.writes()).toBe(0);
    }
  });
});

describe("hive ops — the read paths", () => {
  it("emits exactly one JSON document, opens no init() and issues no write", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    for (const subcommand of ["health", "stalled"]) {
      const d = deps(db, f.selection);
      const exit = await runOps(["ops", subcommand, "--config", f.path, "--json"], d);
      expect(exit).toBe(0);
      expect(d.emitted).toHaveLength(1);
      expect(() => JSON.parse(d.emitted[0]!)).not.toThrow();
      expect(d.notifier.initCalls).toBe(0);
      expect(db.writes()).toBe(0);
    }
  });

  it("labels an absent ops event log rather than rendering an empty rollup as clean", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const d = deps(db, f.selection);
    await runOps(["ops", "health", "--config", f.path], d);
    const view = payload(d);
    expect(view.log.present).toBe(false);
    expect(view.summary.emptiness).toBe("no-ops-event-log");
    expect(view.tools).toEqual([]);
    expect(view.notes.absenceIsNotHealth).toContain("absence is not health");
    expect(view.notes.noOpsEventLog).toContain("not a statement that nothing is failing");
  });

  it("renders the two stalled arms as separate labelled sections and never as one number", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const d = deps(db, f.selection);
    await runOps(["ops", "stalled", "--config", f.path], d);
    const view = payload(d);
    expect(view).toHaveProperty("openConditions");
    expect(view).toHaveProperty("quietTurns");
    expect(JSON.stringify(view)).not.toMatch(/"stalledTotal"|"totalStalled"|"stalledCount"/);
    expect(view.notes.twoArms).toContain("never combined into one number");
  });

  it("labels a --stale-after longer than the instance's retention as truncated by retention", async () => {
    const f = fixture("demo", "activity:\n  retentionDays: 1\n");
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const d = deps(db, f.selection);
    await runOps(["ops", "health", "--stale-after", "10080", "--config", f.path], d);
    const view = payload(d);
    expect(view.discovery.retentionDays).toBe(1);
    expect(view.discovery.truncatedByRetention).toBe(true);
    expect(view.notes.truncatedByRetention).toContain("bounded by retention");
  });
});

describe("hive ops ack — the edge", () => {
  const HANDLE = "65a1b2c3d4e5f60718293a4b";
  const argv = (over: string[] = []) => ["ops", "ack", HANDLE, "--act", "seen", "--actor", "U0FAKE", ...over];

  it("mints `at` exactly once and re-issues the IDENTICAL tuple on unavailable", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const notifier = new ProgrammedNotifier([{ state: "unavailable" }]);
    const d = deps(db, f.selection, { makeNotifier: () => notifier });
    const exit = await runOps([...argv(), "--config", f.path], d);
    expect(exit).toBe(1);
    expect(notifier.accepted).toHaveLength(3);
    const [first, ...rest] = notifier.accepted;
    for (const call of rest) {
      expect(call.at.getTime()).toBe(first!.at.getTime());
      expect(call.actorId).toBe(first!.actorId);
      expect(call.act).toBe(first!.act);
      expect(call.handle).toBe(first!.handle);
    }
    const view = payload(d);
    expect(view.result).toBe("unavailable");
    expect(view.confirmed).toBe(false);
    expect(view.at).toBe(first!.at.toISOString());
    expect(view.message).toContain("MAY have applied");
    expect(view.message).not.toMatch(/nothing was recorded\.$/);
  });

  it("copies the handle verbatim and parses nothing out of it", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const notifier = new ProgrammedNotifier([{ state: "refused", reason: "unknown-handle" }]);
    const d = deps(db, f.selection, { makeNotifier: () => notifier });
    await runOps(["ops", "ack", "NOT-AN-OBJECTID", "--act", "seen", "--actor", "U1", "--config", f.path], d);
    expect(notifier.accepted[0]!.handle).toBe("NOT-AN-OBJECTID");
  });

  it("reports a throwing init() as notifier_init_failed and makes NO accept call", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const notifier = new ProgrammedNotifier([{ state: "applied", rowState: "seen" }], true);
    const d = deps(db, f.selection, { makeNotifier: () => notifier });
    await expect(runOps([...argv(), "--config", f.path], d)).rejects.toThrow("notifier_init_failed");
    expect(notifier.accepted).toHaveLength(0);
    // snake_case, so src/cli.ts:178's /^[a-z_]+$/ guard passes it through.
    expect(/^[a-z_]+$/.test("notifier_init_failed")).toBe(true);
  });

  it("reads snoozedUntil only on an applied result whose rowState is snoozed", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const until = new Date("2026-01-11T12:00:00.000Z");
    const clamped = new Date("2026-01-11T00:00:00.000Z");
    const snoozed = new ProgrammedNotifier([{ state: "applied", rowState: "snoozed", snoozedUntil: clamped }]);
    const dSnoozed = deps(db, f.selection, { makeNotifier: () => snoozed });
    await runOps(
      ["ops", "ack", HANDLE, "--act", "snoozed", "--actor", "U1", "--until", until.toISOString(), "--config", f.path],
      dSnoozed,
    );
    expect(payload(dSnoozed).snoozedUntil).toBe(clamped.toISOString());
    expect(payload(dSnoozed).message).toContain("CLAMPED");

    // The same echoed field on a non-snoozed rowState is NOT rendered.
    const seen = new ProgrammedNotifier([{ state: "applied", rowState: "seen", snoozedUntil: clamped }]);
    const dSeen = deps(db, f.selection, { makeNotifier: () => seen });
    await runOps([...argv(), "--config", f.path], dSeen);
    expect(payload(dSeen)).not.toHaveProperty("snoozedUntil");
  });

  it("passes a PAST --until through to intake rather than judging it locally", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const notifier = new ProgrammedNotifier([{ state: "refused", reason: "snooze-not-future" }]);
    const d = deps(db, f.selection, { makeNotifier: () => notifier });
    const exit = await runOps(
      ["ops", "ack", HANDLE, "--act", "snoozed", "--actor", "U1", "--until", "2020-01-01T00:00:00Z", "--config", f.path],
      d,
    );
    expect(notifier.accepted).toHaveLength(1);
    expect(payload(d).reason).toBe("snooze-not-future");
    expect(exit).toBe(1);
  });
});

describe("hive ops — stdout discipline", () => {
  it("carries exactly one JSON document even when a dependency logs a warning", async () => {
    const f = fixture();
    const db = new FakeDb();
    stampSentinel(db, f.selection);
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const { createLogger } = await import("../logging/logger.js");
      const noisy = createLogger("kpr455-probe");
      const d = deps(db, f.selection, {
        // The default emit is console.log, which is what the real CLI uses.
        emit: (text) => console.log(text),
        makeNotifier: () => {
          noisy.warn("registry audit anomaly");
          noisy.info("loaded reasons");
          return new ProgrammedNotifier([{ state: "applied", rowState: "seen" }]);
        },
      });
      await runOps(["ops", "ack", "65a1b2c3d4e5f60718293a4b", "--act", "seen", "--actor", "U1", "--config", f.path, "--json"], d);
    } finally {
      write.mockRestore();
    }
    const stdout = chunks.join("");
    // ⚠ Spying on process.stdout.write, NOT on deps.emit: the logger writes
    // straight to process.stdout (src/logging/logger.ts:22) and never passes
    // through the CLI's emit seam, so an emit-based assertion would go green
    // with setLogLevel deleted and prove nothing (NV8).
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
    expect(stdout).not.toContain('"level":"warn"');
    expect(stdout).not.toContain('"level":"info"');
  });
});
```

- [ ] **Step 6:** Verify.

```bash
npx tsc --noEmit
npx vitest run src/cli/ops.test.ts src/cli/ops-views.test.ts
npx vitest run src/cli/obligations.test.ts src/boot-order.test.ts
npx prettier --check src/cli/ops.ts src/cli/ops.test.ts src/cli.ts
npx eslint src/cli/ops.ts src/cli/ops.test.ts src/cli.ts
node dist/cli.js --help | sed -n '/^  ops /p'
```

**Expected:** `tsc` exits 0. Both new suites pass with zero skipped; `obligations.test.ts` and `boot-order.test.ts` pass **unchanged** — the second one is the standing evidence that this child adds no anchor. Prettier and ESLint exit clean. The `--help` grep prints the three `ops` lines (run `npm run build` first if `dist/` is stale).

- [ ] **Step 7 (NV8):** Negative-verify `setLogLevel("error")`.

Delete the `setLogLevel("error");` line at the top of `runOps`, then run `npx vitest run src/cli/ops.test.ts`.

**Predicted failure — exactly one case red:** `hive ops — stdout discipline › carries exactly one JSON document even when a dependency logs a warning`. The captured stdout now holds the two logger lines ahead of the payload, so `JSON.parse(stdout.trim())` throws (`Unexpected non-whitespace character after JSON at position …`) and the two `not.toContain` assertions would also fail. **Predicted green: every other case in the file** — they read the payload through `deps.emit`, which the mutation does not touch, and `ops-views.test.ts` never constructs a logger at all.

**Restore** (`git checkout -- src/cli/ops.ts`) and re-run the suite to confirm green. Record the actual failing case name and the actual error text.

- [ ] **Step 8:** Commit.

```bash
git add src/cli/ops.ts src/cli/testing/ops-cli-fixtures.ts src/cli/ops.test.ts src/cli.ts
git commit -m "$(cat <<'EOF'
feat(KPR-455): hive ops CLI — health, stalled, and the acknowledgement edge

One module on the runObligations shape: explicit instance selection, a sentinel
verified before any read, a WriteGuard-wrapped handle, strict parseArgs, one
JSON document on stdout, and no init() on the two read paths.

The edge converts one operator act into one accept(...) call on KPR-468's
intake, hosted in this process. `at` is minted ONCE at parse and held fixed
across every call in the invocation, so the retry on `unavailable` is a retry
and never a second act; `unavailable` renders as UNKNOWN with exit 1 meaning
NOT CONFIRMED; `refused: row-cleared` is benign at exit 0; a throwing init() is
`notifier_init_failed` with no accept call made. There is no --at flag.

setLogLevel("error") at entry on all three subcommands, because this repo's
logger writes every level below `error` to stdout and would otherwise corrupt
the JSON document that is this command's whole contract.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
