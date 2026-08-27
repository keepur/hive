import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("./worker-claim-dedup.js", () => ({
  classifyClaimDedup: vi.fn(async () => ({ duplicateOfClaimId: null, costUsd: 0 })),
}));

import {
  MeetingScribe,
  scribeCharter,
  scribeTurnPrompt,
  SUMMARY_TEXT_CAP,
  type NoteActivityArgs,
  type ScribeMessage,
} from "./meeting-scribe.js";
import { MeetingWorkerPool, type WorkerPoolTurnContext } from "./meeting-worker-pool.js";
import { DEFAULT_MEETING_WORKERS_CONFIG, type MeetingWorkersConfig } from "./worker-pool-config.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- fake Mongo Db/collection
   harness (meeting-worker-pool.test.ts precedent): structurally simulated. */
type AnyDoc = Record<string, any>;

// ---------------------------------------------------------------------------
// Clock seam. A realistic epoch, orders of magnitude above scribeDebounceMs
// (90s) and 2 x scribeTimeoutMs (240s) — belt-and-braces on top of the
// `lastRun !== undefined` source check, NOT a substitute for it (D2b').
// ---------------------------------------------------------------------------
const BASE_EPOCH = 1_724_680_000_000;
let clock = new Date(BASE_EPOCH);
const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

beforeEach(() => {
  clock = new Date(BASE_EPOCH);
});

// ---------------------------------------------------------------------------
// Fake Mongo
// ---------------------------------------------------------------------------

/** Minimal query matcher for exactly the operators these services use. */
function matches(doc: AnyDoc, q: AnyDoc): boolean {
  for (const [k, v] of Object.entries(q)) {
    if (k === "_id") {
      if (String(doc._id) !== String(v)) return false;
    } else if (v && typeof v === "object" && "$lt" in v) {
      if (!(doc[k] < (v as { $lt: any }).$lt)) return false;
    } else if (doc[k] !== v) return false;
  }
  return true;
}

function makeFakeCollection() {
  const docs: AnyDoc[] = [];
  const createIndexCalls: Array<[AnyDoc, AnyDoc | undefined]> = [];
  const updateCalls: Array<[AnyDoc, AnyDoc, AnyDoc | undefined]> = [];
  const col = {
    docs,
    createIndexCalls,
    updateCalls,
    createIndex: vi.fn(async (spec: AnyDoc, opts?: AnyDoc) => {
      createIndexCalls.push([spec, opts]);
      return "";
    }),
    // Claim-ledger operators (the pool shares this Db in D2d/D2f).
    async insertOne(doc: AnyDoc) {
      // Simulates the partial-unique index { threadId, taskKey } WHERE status:"running".
      if (
        doc.status === "running" &&
        docs.some((d) => d.status === "running" && d.threadId === doc.threadId && d.taskKey === doc.taskKey)
      ) {
        const err: any = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
      }
      docs.push(doc);
      return { insertedId: doc._id };
    },
    async countDocuments(q: AnyDoc) {
      return docs.filter((d) => matches(d, q)).length;
    },
    find(q: AnyDoc) {
      const arr = docs.filter((d) => matches(d, q));
      return {
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return arr;
        },
      };
    },
    findOne: vi.fn(async (q: AnyDoc) => docs.find((d) => matches(d, q)) ?? null),
    async findOneAndUpdate(q: AnyDoc, u: AnyDoc) {
      const d = docs.find((x) => matches(x, q));
      if (!d) return null;
      Object.assign(d, u.$set);
      return d;
    },
    async updateOne(q: AnyDoc, u: AnyDoc, opts?: AnyDoc) {
      updateCalls.push([q, u, opts]);
      let d = docs.find((x) => matches(x, q));
      if (!d) {
        if (!opts?.upsert) return { modifiedCount: 0, upsertedCount: 0 };
        d = { _id: q._id };
        docs.push(d);
      }
      if (u.$set) Object.assign(d, u.$set);
      if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) d[k] = (d[k] ?? 0) + (v as number);
      if (u.$unset) for (const k of Object.keys(u.$unset)) delete d[k];
      return { modifiedCount: 1, upsertedCount: 0 };
    },
  };
  return col;
}

type FakeCollection = ReturnType<typeof makeFakeCollection>;

function makeFakeDb() {
  const collections = new Map<string, FakeCollection>();
  const requested = new Set<string>();
  const col = (name: string): FakeCollection => {
    requested.add(name);
    let c = collections.get(name);
    if (!c) {
      c = makeFakeCollection();
      collections.set(name, c);
    }
    return c;
  };
  const db = { collection: (name: string) => col(name) } as any;
  return { db, col, collections, requested };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

// ---------------------------------------------------------------------------
// Fake pool (capabilities only — runRoleTurn + hasCapacity)
// ---------------------------------------------------------------------------

const DEFAULT_SUMMARY = "Running summary: Jasper and Chloe agreed to ship Friday.";

function makeFakePool() {
  const pending = new Map<string, (o: any) => void>();
  const abortByThread = new Map<string, ReturnType<typeof vi.fn>>();
  let impl: (args: any) => Promise<any> = async () => ({
    text: DEFAULT_SUMMARY,
    costUsd: 0.002,
    durationMs: 400,
  });
  const runRoleTurn = vi.fn(async (args: any) => {
    const threadId = args.workItemContext.threadId as string;
    const abort = vi.fn();
    abortByThread.set(threadId, abort);
    args.onAbortHandle?.(abort);
    return impl(args);
  });
  const hasCapacity = vi.fn(() => true);
  return {
    runRoleTurn,
    hasCapacity,
    abortByThread,
    /** Swap the turn implementation (empty text, error outcomes, …). */
    setImpl(next: (args: any) => Promise<any>) {
      impl = next;
    },
    /** Turn-holds: runRoleTurn never resolves until release(threadId, …). */
    hold() {
      impl = (args: any) => new Promise((resolve) => pending.set(args.workItemContext.threadId as string, resolve));
    },
    release(threadId: string, outcome: any) {
      const r = pending.get(threadId);
      pending.delete(threadId);
      r?.(outcome);
    },
  };
}

type FakePool = ReturnType<typeof makeFakePool>;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const THREAD = "1724680000.100";

const meetingCtx: WorkerPoolTurnContext = {
  adapterId: "slack-main",
  channelId: "C123",
  channelKind: "slack",
  channelLabel: "conf-tahoe",
  threadId: THREAD,
  slackTs: "1724680001.200",
  slackThreadTs: THREAD,
};

function bossConfig(): AnyDoc {
  return {
    id: "boss",
    name: "Jasper",
    model: "opus",
    coreServers: ["memory", "slack", "callback", "worker-pool"],
    delegateServers: ["crm-search"],
    schedule: [{ cron: "0 9 * * *" }],
    budgetUsd: 2.5,
  };
}

/** Six messages, ts 1724680001.000 … 1724680006.000, 6…1 minutes old. */
function makeHistory(count = 6): ScribeMessage[] {
  const authors = ["Jasper", "Chloe"];
  return Array.from({ length: count }, (_, i) => ({
    author: authors[i % authors.length],
    text: `message ${i + 1}`,
    timestamp: new Date(BASE_EPOCH - (count + 1 - (i + 1)) * 60_000),
    ts: `172468000${i + 1}.000`,
  }));
}

function makeArgs(over?: {
  threadId?: string;
  messages?: number;
  history?: ScribeMessage[];
  baseAgentId?: string;
  channelLabel?: string;
  roster?: Array<{ name: string }>;
}): NoteActivityArgs {
  return {
    threadId: over?.threadId ?? THREAD,
    history: over?.history ?? makeHistory(over?.messages ?? 6),
    channelLabel: over?.channelLabel ?? "conf-tahoe",
    roster: over?.roster ?? [{ name: "Jasper" }, { name: "Chloe" }],
    baseAgentId: over?.baseAgentId ?? "boss",
    source: {
      adapterId: "slack-main",
      channelId: "C123",
      channelKind: "slack",
      slackTs: "1724680001.200",
      slackThreadTs: THREAD,
    },
  };
}

function makeScribe(over?: {
  config?: Partial<MeetingWorkersConfig>;
  agents?: Record<string, AnyDoc>;
  now?: () => Date;
  fake?: FakeDb;
  pool?: any;
}) {
  const fake = over?.fake ?? makeFakeDb();
  const config: MeetingWorkersConfig = { ...DEFAULT_MEETING_WORKERS_CONFIG, ...over?.config };
  const agents: Record<string, AnyDoc> = over?.agents ?? { boss: bossConfig() };
  const registry = { get: (id: string) => agents[id] as any };
  const pool: FakePool = over?.pool ?? makeFakePool();
  const scribe = new MeetingScribe({
    db: fake.db,
    registry: registry as any,
    pool: pool as any,
    config,
    now: over?.now ?? (() => clock),
  });
  return { scribe, fake, config, agents, registry, pool, summaries: fake.col("meeting_summaries") };
}

type Fixture = ReturnType<typeof makeScribe>;

/** Real pool on a shared fake Db — used by the structural / capacity cases. */
function makeRealPool(
  fake: FakeDb,
  over?: {
    config?: Partial<MeetingWorkersConfig>;
    runTurnImpl?: (req: any) => Promise<AnyDoc>;
    agents?: Record<string, AnyDoc>;
  },
) {
  const agents = over?.agents ?? { boss: bossConfig() };
  const registry = { get: (id: string) => agents[id] as any };
  const onDispatch = vi.fn();
  const builtConfigs: AnyDoc[] = [];
  const runTurn = vi.fn(
    over?.runTurnImpl ?? (async () => ({ text: "report body", costUsd: 0.01, durationMs: 1200, toolCalls: 3 })),
  );
  const buildWorkerAdapter = vi.fn((cfg: AnyDoc) => {
    builtConfigs.push(cfg);
    return { provider: "claude", runTurn, abort: vi.fn(), wasAborted: false } as any;
  });
  const hooks = { buildWorkerAdapter, breakerStateFor: vi.fn(() => null) };
  const config: MeetingWorkersConfig = { ...DEFAULT_MEETING_WORKERS_CONFIG, ...over?.config };
  const pool = new MeetingWorkerPool({
    db: fake.db,
    registry: registry as any,
    onDispatch,
    config,
    dedup: vi.fn(async () => ({ duplicateOfClaimId: null, costUsd: 0 })) as any,
  });
  pool.bindManager(hooks as any);
  return { pool, hooks, onDispatch, builtConfigs, runTurn, agents, config };
}

/** Flush the void-detached scribe chain (real timers). */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Everything a scribe write would change — deliberately excludes `updating`
 *  and `updatedAt` so a gated call is allowed "at most the updating flag". */
function summarySnapshot(col: FakeCollection): AnyDoc[] {
  return col.docs.map((d) => ({
    _id: String(d._id),
    summaryText: d.summaryText,
    coveredThroughTs: d.coveredThroughTs,
    version: d.version,
  }));
}

const emptyTurn = async () => ({ text: "", durationMs: 5 });

// ===========================================================================

describe("MeetingScribe — role params + prompt pins (T7)", () => {
  it("D2a: pins role params, containment, workItemContext and the base config", async () => {
    const f = makeScribe();
    const args = makeArgs();
    f.scribe.noteActivity(args);
    await flush();

    expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1);
    const call = f.pool.runRoleTurn.mock.calls[0][0] as any;

    // Role params — all seven scribe config keys land where they belong.
    expect(call.role.model).toBe("haiku");
    expect(call.role.coreServers).toEqual([]); // C22 containment — deep-equal, not just falsy
    expect(call.role.maxTurns).toBe(4);
    expect(call.role.timeoutMs).toBe(120_000);

    // Charter — byte-exact against the exported builder AND against literals.
    expect(call.role.charter).toBe(scribeCharter("conf-tahoe"));
    expect(call.role.charter.split("\n")[0]).toBe(
      "You are the scribe for a meeting in #conf-tahoe. You maintain one running",
    );
    expect(call.role.charter.split("\n").at(-1)).toBe(
      "You have no tools and no messaging surface. Your final message IS the summary.",
    );

    // Base is the live registry object, not a clone.
    expect(call.base).toBe(f.agents.boss);

    // All seven workItemContext fields.
    expect(call.workItemContext).toEqual({
      adapterId: "slack-main",
      channelId: "C123",
      channelKind: "slack",
      channelLabel: "conf-tahoe",
      threadId: THREAD,
      slackTs: "1724680001.200",
      slackThreadTs: THREAD,
    });
  });

  it("D2a: pins the first-run prompt byte-exact (no prior summary ⇒ sentinel)", async () => {
    const f = makeScribe();
    const args = makeArgs();
    f.scribe.noteActivity(args);
    await flush();

    const call = f.pool.runRoleTurn.mock.calls[0][0] as any;
    expect(call.prompt).toBe(scribeTurnPrompt("conf-tahoe", args.roster, undefined, args.history, clock));
    expect(call.prompt.startsWith("Meeting: #conf-tahoe\nParticipants: Jasper, Chloe\n\n")).toBe(true);
    expect(call.prompt).toContain(
      "CURRENT SUMMARY:\n(none yet — this is the first summary of this meeting.)\n\nNEW MESSAGES:\n",
    );
    // `Author (n min ago): text` body shape, one line per new message.
    const body = call.prompt.split("NEW MESSAGES:\n")[1].split("\n");
    expect(body).toHaveLength(6);
    expect(body[0]).toMatch(/^Jasper \(\d+ min ago\): message 1$/);
    expect(body[5]).toMatch(/^Chloe \(\d+ min ago\): message 6$/);
  });

  it("D2a: pins the subsequent-run prompt byte-exact (prior summary carried in)", async () => {
    const f = makeScribe();
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "PRIOR SUMMARY TEXT",
      coveredThroughTs: "1724680000.500", // below every history ts ⇒ all 6 still novel
      version: 2,
      updatedAt: new Date(BASE_EPOCH - 300_000),
    });
    const args = makeArgs();
    f.scribe.noteActivity(args);
    await flush();

    const call = f.pool.runRoleTurn.mock.calls[0][0] as any;
    expect(call.prompt).toBe(scribeTurnPrompt("conf-tahoe", args.roster, "PRIOR SUMMARY TEXT", args.history, clock));
    expect(call.prompt).toContain("CURRENT SUMMARY:\nPRIOR SUMMARY TEXT\n\nNEW MESSAGES:\n");
    expect(call.prompt).not.toContain("(none yet");
  });
});

// ===========================================================================

interface GateRow {
  name: string;
  config?: Partial<MeetingWorkersConfig>;
  /** Construct the blocked state; returns the args for the gated call. */
  arrange: (f: Fixture) => Promise<NoteActivityArgs>;
  /** Lift EXACTLY this gate; returns the args for the positive control. */
  lift: (f: Fixture, blocked: NoteActivityArgs) => Promise<NoteActivityArgs>;
}

const gateRows: GateRow[] = [
  {
    name: "gate 1 — meetingWorkers.enabled false",
    config: { enabled: false },
    arrange: async () => makeArgs(),
    lift: async (f, blocked) => {
      f.config.enabled = true;
      return blocked;
    },
  },
  {
    name: "gate 1 — scribeEnabled false",
    config: { scribeEnabled: false },
    arrange: async () => makeArgs(),
    lift: async (f, blocked) => {
      f.config.scribeEnabled = true;
      return blocked;
    },
  },
  {
    // ⚠ Seeded state — can only be built by first performing a real run, so the
    // seeding call is mockClear()'d before the row's own assertion.
    name: "gate 2a — a run is already in flight on this thread",
    arrange: async (f) => {
      f.pool.hold();
      const args = makeArgs();
      f.scribe.noteActivity(args);
      await flush();
      expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1); // the seeding run is live
      f.pool.runRoleTurn.mockClear();
      advance(200_000); // past scribeDebounceMs — gate 3 must not be what blocks
      return args;
    },
    lift: async (f, blocked) => {
      // Resolve with EMPTY text: no summary write ⇒ novelty survives, so the
      // control can re-run with the same args.
      f.pool.release(blocked.threadId, { text: "", durationMs: 5 });
      await flush();
      advance(200_000); // the settled run stamped lastRunAt
      return blocked;
    },
  },
  {
    name: "gate 5a — scribeMaxConcurrent reached",
    config: { scribeMaxConcurrent: 2 },
    arrange: async (f) => {
      f.pool.hold();
      f.scribe.noteActivity(makeArgs({ threadId: "T-a" }));
      await flush();
      f.scribe.noteActivity(makeArgs({ threadId: "T-b" }));
      await flush();
      expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(2);
      f.pool.runRoleTurn.mockClear();
      return makeArgs({ threadId: "T-c" });
    },
    lift: async (f, blocked) => {
      f.pool.release("T-a", { text: "", durationMs: 5 });
      await flush();
      return blocked; // T-c has no lastRunAt, so gate 3 is not in play
    },
  },
  {
    name: "gate 3 — within scribeDebounceMs of the last run",
    arrange: async (f) => {
      f.pool.setImpl(emptyTurn); // seed without writing a summary (keeps novelty)
      const args = makeArgs();
      f.scribe.noteActivity(args);
      await flush();
      expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1);
      f.pool.runRoleTurn.mockClear();
      advance(10_000); // < 90_000
      return args;
    },
    lift: async (f, blocked) => {
      advance(200_000);
      return blocked;
    },
  },
  {
    name: "gate 4 — fewer than scribeMinNewMessages new messages",
    arrange: async () => makeArgs({ messages: 3 }),
    lift: async () => makeArgs({ messages: 6 }),
  },
  {
    name: "gate 5b — pool.hasCapacity() false",
    arrange: async (f) => {
      f.pool.hasCapacity.mockReturnValue(false);
      return makeArgs();
    },
    lift: async (f, blocked) => {
      f.pool.hasCapacity.mockReturnValue(true);
      return blocked;
    },
  },
  {
    name: "E8 — base agent missing from the registry",
    arrange: async () => makeArgs({ baseAgentId: "ghost" }),
    lift: async (f, blocked) => {
      f.agents.ghost = { ...bossConfig(), id: "ghost" };
      return blocked;
    },
  },
  {
    name: "E8 — base agent disabled",
    arrange: async (f) => {
      f.agents.boss.disabled = true;
      return makeArgs();
    },
    lift: async (f, blocked) => {
      f.agents.boss.disabled = false;
      return blocked;
    },
  },
];

describe("MeetingScribe — gating table (T8)", () => {
  it.each(gateRows)("D2b: $name blocks the run; lifting it admits exactly one", async (row) => {
    const f = makeScribe({ config: row.config });
    const args = await row.arrange(f);

    const before = summarySnapshot(f.summaries);
    f.scribe.noteActivity(args);
    await flush();

    expect(f.pool.runRoleTurn).not.toHaveBeenCalled();
    expect(summarySnapshot(f.summaries)).toEqual(before);

    // ⚠ Paired positive control — without it, a harness that never runs at all
    // makes every row pass vacuously.
    const controlArgs = await row.lift(f, args);
    f.scribe.noteActivity(controlArgs);
    await flush();

    expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1);
    expect((f.pool.runRoleTurn.mock.calls[0][0] as any).workItemContext.threadId).toBe(controlArgs.threadId);
  });

  it("D2b′: a first-ever run is admitted under a clock epoch BELOW scribeDebounceMs", async () => {
    // ⚠ The sentinel discriminator. With `(now - (lastRun ?? 0)) < debounce`,
    // 50_000 - 0 < 90_000 blocks the first-ever run on every thread and every
    // "no run" assertion above would pass for the wrong reason.
    const lowEpoch = new Date(50_000);
    const f = makeScribe({ now: () => lowEpoch });
    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================

describe("MeetingScribe — write path + single-flight (T9)", () => {
  it("D2c: a successful turn upserts the summary, max ts, $inc version, and clears updating", async () => {
    const f = makeScribe();
    f.scribe.noteActivity(makeArgs());
    await flush();

    const doc = f.summaries.docs.find((d) => String(d._id) === THREAD)!;
    expect(doc.summaryText).toBe(DEFAULT_SUMMARY);
    expect(doc.coveredThroughTs).toBe("1724680006.000"); // max ts of the fed messages
    expect(doc.version).toBe(1);
    expect(doc.updating).toBeUndefined();

    // Exactly one write carried the summary, and it was an upsert.
    const summaryWrites = f.summaries.updateCalls.filter((c) => c[1].$set?.summaryText !== undefined);
    expect(summaryWrites).toHaveLength(1);
    expect(summaryWrites[0][2]).toEqual({ upsert: true });
    expect(summaryWrites[0][1].$inc).toEqual({ version: 1 });
    expect(summaryWrites[0][1].$unset).toEqual({ updating: "" });
  });

  it("D2c: version is incremented, not overwritten, on an existing doc", async () => {
    const f = makeScribe();
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "old",
      coveredThroughTs: "1724680000.500",
      version: 3,
      updatedAt: new Date(BASE_EPOCH - 300_000),
    });
    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(f.summaries.docs[0].version).toBe(4);
    expect(f.summaries.docs[0].summaryText).toBe(DEFAULT_SUMMARY);
  });

  it("D2c: a runaway summary is hard-truncated at SUMMARY_TEXT_CAP", async () => {
    const f = makeScribe();
    f.pool.setImpl(async () => ({ text: "x".repeat(5000), durationMs: 10 }));
    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(f.summaries.docs[0].summaryText).toHaveLength(SUMMARY_TEXT_CAP);
    expect(SUMMARY_TEXT_CAP).toBe(2500);
  });

  it.each([
    { name: "error", outcome: { error: "adapter blew up", durationMs: 9 } },
    { name: "timedOut", outcome: { timedOut: true, text: "partial", durationMs: 9 } },
    { name: "aborted", outcome: { aborted: true, text: "partial", durationMs: 9 } },
    { name: "empty text", outcome: { text: "   ", durationMs: 9 } },
    { name: "null outcome (hooks unbound)", outcome: null },
  ])("D2c: a $name outcome leaves the prior summary intact and clears updating", async ({ outcome }) => {
    const f = makeScribe();
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "PRIOR",
      coveredThroughTs: "1724680000.500",
      version: 7,
      updatedAt: new Date(BASE_EPOCH - 300_000),
    });
    f.pool.setImpl(async () => outcome);
    f.scribe.noteActivity(makeArgs());
    await flush();

    const doc = f.summaries.docs[0];
    expect(doc.summaryText).toBe("PRIOR");
    expect(doc.coveredThroughTs).toBe("1724680000.500");
    expect(doc.version).toBe(7);
    expect(doc.updating).toBeUndefined();
    expect(f.summaries.updateCalls.some((c) => c[1].$set?.summaryText !== undefined)).toBe(false);
  });

  it("D2c: gate 2b — a fresh `updating` stamp abandons the trigger; a stale one is overridden", async () => {
    // 2 x scribeTimeoutMs = 240_000.
    const fresh = makeScribe();
    fresh.summaries.docs.push({
      _id: THREAD,
      updating: { startedAt: new Date(BASE_EPOCH - 60_000) },
      updatedAt: new Date(BASE_EPOCH - 60_000),
    });
    fresh.scribe.noteActivity(makeArgs());
    await flush();
    expect(fresh.pool.runRoleTurn).not.toHaveBeenCalled();

    const stale = makeScribe();
    stale.summaries.docs.push({
      _id: THREAD,
      updating: { startedAt: new Date(BASE_EPOCH - 300_000) },
      updatedAt: new Date(BASE_EPOCH - 300_000),
    });
    stale.scribe.noteActivity(makeArgs());
    await flush();
    expect(stale.pool.runRoleTurn).toHaveBeenCalledTimes(1);
    expect(stale.summaries.docs[0].summaryText).toBe(DEFAULT_SUMMARY);
  });
});

// ===========================================================================

describe("MeetingScribe — structural isolation (T10)", () => {
  it("D2d: a scribe run touches no claim ledger, no re-entry seam, and no other collection", async () => {
    const fake = makeFakeDb();
    const rp = makeRealPool(fake);
    const claims = fake.col("meeting_worker_claims");
    const f = makeScribe({ fake, pool: rp.pool as any, agents: rp.agents });

    f.scribe.noteActivity(makeArgs());
    await flush();

    // The turn actually ran (otherwise the three assertions below are vacuous).
    expect(rp.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(1);
    expect(rp.runTurn).toHaveBeenCalledTimes(1);
    expect(f.summaries.docs[0].summaryText).toBe("report body");

    expect(claims.docs).toHaveLength(0);
    expect(rp.onDispatch).not.toHaveBeenCalled();
    expect([...fake.requested].sort()).toEqual(["meeting_summaries", "meeting_worker_claims"]);
  });

  it("D2e: T11 — five noteActivity calls in one tick admit exactly one run", async () => {
    const f = makeScribe();
    f.pool.hold();
    const args = makeArgs();
    for (let i = 0; i < 5; i++) f.scribe.noteActivity(args);
    await flush();
    expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1);
  });
});

describe("MeetingScribe — capacity isolation (T12)", () => {
  it("D2f: a live scribe does not consume a fetch-worker dispatch slot", async () => {
    const fake = makeFakeDb();
    // perMeetingMax 10 so the engine-wide cap is the only thing under test.
    const rp = makeRealPool(fake, {
      config: { maxConcurrent: 4, perMeetingMax: 10 },
      runTurnImpl: () => new Promise(() => {}),
    });
    const f = makeScribe({
      fake,
      pool: rp.pool as any,
      agents: rp.agents,
      config: { maxConcurrent: 4, perMeetingMax: 10 },
    });

    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(rp.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(1); // scribe adapter is live

    for (const task of ["fetch one", "fetch two", "fetch three", "fetch four"]) {
      const res = await rp.pool.dispatch({ bossAgentId: "boss", task, context: meetingCtx });
      expect(res.startsWith("Worker dispatched (claim ")).toBe(true);
      expect(res).not.toContain("Worker pool saturated");
      await flush();
    }
    // 1 scribe + 4 fetch workers. A registered scribe refuses the fourth ⇒ 4.
    expect(rp.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(5);
  });

  it("D2f: at maxConcurrent 1, a live scribe still leaves hasCapacity() true", async () => {
    const fake = makeFakeDb();
    const rp = makeRealPool(fake, {
      config: { maxConcurrent: 1 },
      runTurnImpl: () => new Promise(() => {}),
    });
    const f = makeScribe({ fake, pool: rp.pool as any, agents: rp.agents, config: { maxConcurrent: 1 } });

    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(rp.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(1);
    expect(rp.pool.hasCapacity()).toBe(true); // registration would make it 1 < 1 = false
  });
});

// ===========================================================================

describe("MeetingScribe — getSummary guards (D2g)", () => {
  it("returns undefined for an absent doc", async () => {
    const f = makeScribe();
    await expect(f.scribe.getSummary(THREAD)).resolves.toBeUndefined();
  });

  it("returns undefined for a failed-first-run stub doc", async () => {
    const f = makeScribe();
    f.summaries.docs.push({ _id: THREAD, updating: { startedAt: clock }, updatedAt: clock });
    await expect(f.scribe.getSummary(THREAD)).resolves.toBeUndefined();

    // …and for a doc with text but no coverage mark.
    f.summaries.docs[0].summaryText = "text but no coverage";
    await expect(f.scribe.getSummary(THREAD)).resolves.toBeUndefined();
  });

  it("returns the summary when both fields are present", async () => {
    const f = makeScribe();
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "S",
      coveredThroughTs: "1724680006.000",
      version: 1,
      updatedAt: clock,
    });
    await expect(f.scribe.getSummary(THREAD)).resolves.toEqual({
      summaryText: "S",
      coveredThroughTs: "1724680006.000",
    });
  });

  it("short-circuits BEFORE the read when the scribe is disabled (E10)", async () => {
    const f = makeScribe({ config: { scribeEnabled: false } });
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "S",
      coveredThroughTs: "1724680006.000",
      version: 1,
      updatedAt: clock,
    });
    await expect(f.scribe.getSummary(THREAD)).resolves.toBeUndefined();
    expect(f.summaries.findOne).not.toHaveBeenCalled();

    const off = makeScribe({ config: { enabled: false } });
    await expect(off.scribe.getSummary(THREAD)).resolves.toBeUndefined();
    expect(off.summaries.findOne).not.toHaveBeenCalled();
  });

  it("contains a throwing read", async () => {
    const f = makeScribe();
    f.summaries.findOne.mockRejectedValueOnce(new Error("mongo down"));
    await expect(f.scribe.getSummary(THREAD)).resolves.toBeUndefined();
  });
});

describe("MeetingScribe — ensureIndexes (D2h)", () => {
  it("creates exactly the updatedAt TTL index", async () => {
    const f = makeScribe();
    await f.scribe.ensureIndexes();
    expect(f.summaries.createIndexCalls).toEqual([[{ updatedAt: 1 }, { expireAfterSeconds: 604800 }]]);
  });

  it("rejects on failure — the caller owns the .catch, not this method", async () => {
    const f = makeScribe();
    f.summaries.createIndex.mockRejectedValueOnce(new Error("index build failed"));
    await expect(f.scribe.ensureIndexes()).rejects.toThrow("index build failed");
  });
});

describe("MeetingScribe — stop() (D2i)", () => {
  it("aborts every live run, contains a throwing abort, and forgets settled runs", async () => {
    const f = makeScribe();
    f.pool.hold();
    f.scribe.noteActivity(makeArgs({ threadId: "T-a" }));
    await flush();
    f.scribe.noteActivity(makeArgs({ threadId: "T-b" }));
    await flush();

    const abortA = f.pool.abortByThread.get("T-a")!;
    const abortB = f.pool.abortByThread.get("T-b")!;
    abortA.mockImplementation(() => {
      throw new Error("abort blew up");
    });

    expect(() => f.scribe.stop()).not.toThrow();
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1); // the throw did not stop the loop
  });

  it("holds no handle for a settled run", async () => {
    const f = makeScribe();
    f.scribe.noteActivity(makeArgs());
    await flush();
    const abort = f.pool.abortByThread.get(THREAD)!;
    expect(abort).not.toHaveBeenCalled();

    f.scribe.stop();
    expect(abort).not.toHaveBeenCalled(); // handle cleared in the shared finally
  });
});
