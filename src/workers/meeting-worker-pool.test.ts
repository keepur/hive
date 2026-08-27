import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// The pool takes `dedup` as an injected dep — the real module (which imports
// config) must never load in this suite.
vi.mock("./worker-claim-dedup.js", () => ({
  classifyClaimDedup: vi.fn(async () => ({ duplicateOfClaimId: null, costUsd: 0 })),
}));

import {
  MeetingWorkerPool,
  WORKER_SERVER_DENYLIST,
  normalizedTaskKey,
  type WorkerPoolTurnContext,
} from "./meeting-worker-pool.js";
import { DEFAULT_MEETING_WORKERS_CONFIG } from "./worker-pool-config.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- fake Mongo Db/collection
   harness (callback-mcp-server.test.ts precedent): the pool's collection surface
   is simulated structurally, so the fixtures are deliberately untyped. */
type AnyDoc = Record<string, any>;

/** Minimal query matcher for exactly the operators the pool uses. */
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

function makeFakeClaims() {
  const docs: AnyDoc[] = [];
  const createIndexCalls: Array<[AnyDoc, AnyDoc | undefined]> = [];
  const col = {
    docs,
    createIndexCalls,
    async createIndex(spec: AnyDoc, opts?: AnyDoc) {
      createIndexCalls.push([spec, opts]);
      return "";
    },
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
    async findOne(q: AnyDoc) {
      return docs.find((d) => matches(d, q)) ?? null;
    },
    async findOneAndUpdate(q: AnyDoc, u: AnyDoc) {
      const d = docs.find((x) => matches(x, q));
      if (!d) return null;
      Object.assign(d, u.$set);
      return d;
    },
    async updateOne(q: AnyDoc, u: AnyDoc) {
      const d = docs.find((x) => matches(x, q));
      if (d) Object.assign(d, u.$set);
      return { modifiedCount: d ? 1 : 0 };
    },
  };
  return col;
}

function makeFixture(overrides?: {
  config?: Partial<typeof DEFAULT_MEETING_WORKERS_CONFIG>;
  registryAgents?: Record<string, AnyDoc>;
  dedup?: (...args: any[]) => any;
  runTurnImpl?: (req: any) => Promise<AnyDoc>;
}) {
  const claims = makeFakeClaims();
  const db = { collection: () => claims } as any;
  const agents: Record<string, AnyDoc> = overrides?.registryAgents ?? {
    boss: {
      id: "boss",
      name: "Jasper",
      model: "opus",
      coreServers: ["memory", "slack", "callback", "worker-pool", "code-search", "background", "keychain"],
      delegateServers: ["crm-search"],
      schedule: [{ cron: "0 9 * * *" }],
      budgetUsd: 2.5,
    },
  };
  const registry = { get: (id: string) => agents[id] as any };
  const onDispatch = vi.fn();
  const builtConfigs: AnyDoc[] = [];
  const abortSpy = vi.fn();
  const abortSpies: Array<ReturnType<typeof vi.fn>> = [];
  const runTurn = vi.fn(
    overrides?.runTurnImpl ?? (async () => ({ text: "report body", costUsd: 0.01, durationMs: 1200, toolCalls: 3 })),
  );
  const hooks = {
    buildWorkerAdapter: vi.fn((cfg: AnyDoc) => {
      builtConfigs.push(cfg);
      const abort = vi.fn(() => {
        abortSpy();
      });
      abortSpies.push(abort);
      return { provider: "claude", runTurn, abort, wasAborted: false } as any;
    }),
    breakerStateFor: vi.fn(() => null),
  };
  const dedup = vi.fn(overrides?.dedup ?? (async () => ({ duplicateOfClaimId: null, costUsd: 0 })));
  const pool = new MeetingWorkerPool({
    db,
    registry,
    onDispatch,
    config: { ...DEFAULT_MEETING_WORKERS_CONFIG, ...overrides?.config },
    dedup: dedup as any,
  });
  pool.bindManager(hooks as any);
  return { pool, claims, onDispatch, hooks, dedup, builtConfigs, abortSpy, abortSpies, runTurn, agents };
}

const meetingCtx: WorkerPoolTurnContext = {
  adapterId: "slack-main",
  channelId: "C123",
  channelKind: "slack",
  channelLabel: "conf-tahoe",
  threadId: "1724680000.100",
  slackTs: "1724680001.200",
  slackThreadTs: "1724680000.100",
};

/** Seed a claim doc straight into the fake collection. */
function seedClaim(claims: ReturnType<typeof makeFakeClaims>, over: AnyDoc = {}): AnyDoc {
  const now = new Date();
  const taskText = (over.taskText as string) ?? "seeded task";
  const doc: AnyDoc = {
    _id: new ObjectId(),
    threadId: meetingCtx.threadId,
    source: {
      adapterId: "slack-main",
      channelId: "C123",
      channelKind: "slack",
      channelLabel: "conf-tahoe",
      slackTs: "1724680001.200",
      slackThreadTs: "1724680000.100",
    },
    taskText,
    taskKey: normalizedTaskKey(taskText),
    status: "running",
    bossAgentId: "boss",
    workerModel: "sonnet",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    ...over,
  };
  claims.docs.push(doc);
  return doc;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flush the void-detached spawn chain (real timers). */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const dispatchReq = (task: string, boss = "boss", ctx: WorkerPoolTurnContext = meetingCtx) => ({
  bossAgentId: boss,
  task,
  context: ctx,
});

describe("MeetingWorkerPool — claim ledger + gates (Task D)", () => {
  it("T1: concurrent identical dispatches produce exactly one claim; loser gets the claimant name", async () => {
    const f = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    const [a, b] = await Promise.all([
      f.pool.dispatch(dispatchReq("fetch Q2 numbers")),
      f.pool.dispatch(dispatchReq("fetch Q2 numbers")),
    ]);
    expect(f.claims.docs).toHaveLength(1);
    const winner = [a, b].find((r) => r.startsWith("Worker dispatched (claim "));
    const loser = [a, b].find((r) => r.startsWith("Already claimed by Jasper"));
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
  });

  it("T1: distinct tasks produce two claims and two workers", async () => {
    const f = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await f.pool.dispatch(dispatchReq("check the shipping backlog"));
    expect(f.claims.docs).toHaveLength(2);
    expect(f.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(2);
  });

  it("T1: perMeetingMax refuses with counts and inserts nothing", async () => {
    const f = makeFixture({ config: { perMeetingMax: 2 } });
    seedClaim(f.claims, { taskText: "one" });
    seedClaim(f.claims, { taskText: "two" });
    const res = await f.pool.dispatch(dispatchReq("three"));
    expect(res).toBe("This meeting already has 2/2 workers running — wait for one to report back.");
    expect(f.claims.docs).toHaveLength(2);
  });

  it("T1: cap overshoot is tolerated (check-then-act, no locking)", async () => {
    const gate = deferred<{ duplicateOfClaimId: null; costUsd: number }>();
    const f = makeFixture({
      config: { perMeetingMax: 3 },
      dedup: () => gate.promise,
      runTurnImpl: () => new Promise(() => {}),
    });
    seedClaim(f.claims, { taskText: "one" });
    seedClaim(f.claims, { taskText: "two" });
    const p1 = f.pool.dispatch(dispatchReq("three"));
    const p2 = f.pool.dispatch(dispatchReq("four"));
    await flush();
    gate.resolve({ duplicateOfClaimId: null, costUsd: 0 });
    const [r1, r2] = await Promise.all([p1, p2]);
    const running = f.claims.docs.filter((d) => d.status === "running");
    expect(running.length).toBeLessThanOrEqual(4); // perMeetingMax + 1
    expect(running.length).toBeGreaterThan(3); // overshoot actually happened
    expect(r1.startsWith("Worker dispatched")).toBe(true);
    expect(r2.startsWith("Worker dispatched")).toBe(true);
  });

  it("T2: dedup duplicate verdict blocks the insert; unique verdict stamps the doc; no open claims skips the call", async () => {
    // No open claims — dedup never called, no dedup field stamped.
    const clean = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    await clean.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    expect(clean.dedup).not.toHaveBeenCalled();
    expect(clean.claims.docs[0].dedup).toBeUndefined();

    // Duplicate verdict — no insert, claimed-by text.
    const dupFixture = makeFixture();
    const existing = seedClaim(dupFixture.claims, { taskText: "pull the Q2 revenue figures" });
    dupFixture.dedup.mockImplementation(async () => ({
      duplicateOfClaimId: existing._id.toString(),
      costUsd: 0.0004,
    }));
    const res = await dupFixture.pool.dispatch(dispatchReq("get Q2 revenue"));
    expect(res).toContain("Already claimed by Jasper");
    expect(res).toContain(existing._id.toString());
    expect(dupFixture.claims.docs).toHaveLength(1);

    // Unique verdict with an open claim — insert with the dedup stamp.
    const uniqueFixture = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    seedClaim(uniqueFixture.claims, { taskText: "pull the Q2 revenue figures" });
    uniqueFixture.dedup.mockImplementation(async () => ({ duplicateOfClaimId: null, costUsd: 0.0002 }));
    await uniqueFixture.pool.dispatch(dispatchReq("check the shipping backlog"));
    expect(uniqueFixture.claims.docs).toHaveLength(2);
    expect(uniqueFixture.claims.docs[1].dedup).toEqual({ compared: 1, verdict: "unique", costUsd: 0.0002 });
  });

  it("T2: a THROWING dedup dependency still inserts — fail-open is structural at the call site", async () => {
    // Not the sidecar's own rejecting-call path (covered above): this models
    // getLLMRegistry()/hasProvider() throwing BEFORE worker-claim-dedup's try,
    // i.e. an exception the sidecar cannot catch for us. §A2 forbids
    // fail-closed, so dispatch() must swallow it and claim anyway.
    const f = makeFixture({
      dedup: () => {
        throw new Error("llm registry not initialized");
      },
      runTurnImpl: () => new Promise(() => {}),
    });
    seedClaim(f.claims, { taskText: "pull the Q2 revenue figures" });
    const res = await f.pool.dispatch(dispatchReq("get Q2 revenue"));
    expect(res.startsWith("Worker dispatched")).toBe(true);
    expect(f.claims.docs).toHaveLength(2);
    expect(f.claims.docs[1].dedup).toEqual({ compared: 1, verdict: "unique", costUsd: 0 });

    // Async-rejecting variant of the same dependency fault.
    const rejecting = makeFixture({
      dedup: async () => {
        throw new Error("llm registry not initialized");
      },
      runTurnImpl: () => new Promise(() => {}),
    });
    seedClaim(rejecting.claims, { taskText: "pull the Q2 revenue figures" });
    expect((await rejecting.pool.dispatch(dispatchReq("get Q2 revenue"))).startsWith("Worker dispatched")).toBe(true);
    expect(rejecting.claims.docs).toHaveLength(2);
  });

  it("T2: sidecar fail-open verdict still inserts (no blocked dispatch)", async () => {
    const f = makeFixture({
      dedup: async () => ({ duplicateOfClaimId: null, costUsd: 0 }), // sidecar's fail-open shape
      runTurnImpl: () => new Promise(() => {}),
    });
    seedClaim(f.claims, { taskText: "pull the Q2 revenue figures" });
    const res = await f.pool.dispatch(dispatchReq("get Q2 revenue"));
    expect(res.startsWith("Worker dispatched")).toBe(true);
    expect(f.claims.docs).toHaveLength(2);
  });

  it("T5: gates — non-conf label, non-slack kind, missing thread, disabled, open breaker", async () => {
    const notConf = makeFixture();
    const r1 = await notConf.pool.dispatch(dispatchReq("x", "boss", { ...meetingCtx, channelLabel: "general" }));
    expect(r1).toContain("meeting-only (Slack conf-* channels)");
    expect(r1).toContain("bg_execute");
    expect(notConf.claims.docs).toHaveLength(0);

    const notSlack = makeFixture();
    const r2 = await notSlack.pool.dispatch(dispatchReq("x", "boss", { ...meetingCtx, channelKind: "sms" }));
    expect(r2).toContain("meeting-only");
    expect(notSlack.claims.docs).toHaveLength(0);

    const noThread = makeFixture();
    const r3 = await noThread.pool.dispatch(dispatchReq("x", "boss", { ...meetingCtx, threadId: undefined }));
    expect(r3).toContain("meeting-only");

    const disabled = makeFixture({ config: { enabled: false } });
    const r4 = await disabled.pool.dispatch(dispatchReq("x"));
    expect(r4).toContain("meetingWorkers.enabled: false");
    expect(disabled.claims.docs).toHaveLength(0);

    const open = makeFixture();
    open.hooks.breakerStateFor.mockReturnValue({ state: "open", enabled: true } as any);
    const r5 = await open.pool.dispatch(dispatchReq("x"));
    expect(r5).toContain("Provider outage (claude circuit open)");
    expect(open.claims.docs).toHaveLength(0);

    // Shadow mode (enabled:false) — the breaker never fast-fails a dispatch.
    const shadow = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    shadow.hooks.breakerStateFor.mockReturnValue({ state: "open", enabled: false } as any);
    const r6 = await shadow.pool.dispatch(dispatchReq("x"));
    expect(r6.startsWith("Worker dispatched")).toBe(true);

    // Null snapshot — proceeds.
    const nullBreaker = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    const r7 = await nullBreaker.pool.dispatch(dispatchReq("x"));
    expect(r7.startsWith("Worker dispatched")).toBe(true);
  });

  it("T1: engine-wide maxConcurrent saturation refuses", async () => {
    const f = makeFixture({ config: { maxConcurrent: 1 }, runTurnImpl: () => new Promise(() => {}) });
    await f.pool.dispatch(dispatchReq("first"));
    const res = await f.pool.dispatch(dispatchReq("second"));
    expect(res).toBe("Worker pool saturated (1/1 engine-wide) — retry shortly or do the work in your own turn.");
  });

  it("worker_status: empty ledger, then one line per claim with an 80-char preview", async () => {
    const f = makeFixture();
    expect(await f.pool.status(meetingCtx.threadId!)).toBe("No worker claims for this meeting yet.");
    const longTask = `${"a".repeat(80)}SECRET`;
    const doc = seedClaim(f.claims, { taskText: longTask });
    const out = await f.pool.status(meetingCtx.threadId!);
    expect(out).toContain(doc._id.toString());
    expect(out).toContain("running");
    expect(out).toContain("Jasper");
    expect(out).toContain("a".repeat(80));
    expect(out).not.toContain("SECRET");
  });

  it("worker_cancel: own running claim flips to cancelled; other boss / terminal / invalid id refuse", async () => {
    const f = makeFixture();
    const mine = seedClaim(f.claims, { taskText: "mine" });
    expect(await f.pool.cancel(mine._id.toString(), "boss")).toBe(`Cancelled claim ${mine._id.toString()}.`);
    expect(mine.status).toBe("cancelled");
    expect(mine.error).toBe("cancelled by dispatching boss");

    const theirs = seedClaim(f.claims, { taskText: "theirs", bossAgentId: "other" });
    expect(await f.pool.cancel(theirs._id.toString(), "boss")).toBe("Not yours — that claim was dispatched by other.");

    const done = seedClaim(f.claims, { taskText: "done one", status: "done" });
    expect(await f.pool.cancel(done._id.toString(), "boss")).toBe("Already finished (status: done).");

    expect(await f.pool.cancel("not-an-object-id", "boss")).toBe("Claim not found: not-an-object-id");
    const missing = new ObjectId().toString();
    expect(await f.pool.cancel(missing, "boss")).toBe(`Claim not found: ${missing}`);
  });

  it("index pin: partial-unique claim key, thread/status lookup, housekeeping TTL", async () => {
    const f = makeFixture();
    await f.pool.ensureIndexes();
    expect(f.claims.createIndexCalls).toEqual([
      [
        { threadId: 1, taskKey: 1 },
        { unique: true, partialFilterExpression: { status: "running" } },
      ],
      [{ threadId: 1, status: 1 }, undefined],
      [{ updatedAt: 1 }, { expireAfterSeconds: 604800 }],
    ]);
  });

  it("normalizedTaskKey: case/whitespace-insensitive, distinct texts differ", () => {
    expect(normalizedTaskKey("Fetch Q2  numbers")).toBe(normalizedTaskKey("fetch q2 numbers"));
    expect(normalizedTaskKey("  fetch q2 numbers\n")).toBe(normalizedTaskKey("fetch q2 numbers"));
    expect(normalizedTaskKey("fetch q2 numbers")).not.toBe(normalizedTaskKey("fetch q3 numbers"));
  });

  it("denylist covers the outbound/self-scheduling/escape-hatch surfaces", () => {
    for (const s of [
      "slack",
      "quo",
      "resend",
      "team",
      "event-bus",
      "callback",
      "schedule",
      "worker-pool",
      "background",
      "keychain",
      "code-task",
      "admin",
      "recall",
      "voice",
    ]) {
      expect(WORKER_SERVER_DENYLIST.has(s)).toBe(true);
    }
    // Memory servers deliberately stay (same trust domain).
    expect(WORKER_SERVER_DENYLIST.has("memory")).toBe(false);
    expect(WORKER_SERVER_DENYLIST.has("structured-memory")).toBe(false);
  });
});

describe("MeetingWorkerPool — spawn, completion, re-entry (Task E)", () => {
  it("T3: worker config clone — model pin, denylist-stripped coreServers, no delegates, sessionless turn", async () => {
    const f = makeFixture({ runTurnImpl: () => new Promise(() => {}) });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(1));
    const cfg = f.builtConfigs[0];
    expect(cfg.model).toBe("sonnet");
    expect(cfg.coreServers).toEqual(["memory", "code-search"]);
    expect(cfg.delegateServers).toEqual([]);
    expect(cfg.schedule).toEqual([]);
    expect(cfg.id).toBe("boss");

    const req = f.runTurn.mock.calls[0][0] as AnyDoc;
    expect(req.sessionId).toBeUndefined();
    expect(req.resourceLimits).toEqual({ maxTurns: 25, timeoutMs: 600_000, budgetUsd: 2.5 });
    expect(req.systemPromptOverride).toContain("Jasper");
    expect(req.systemPromptOverride).toContain("conf-tahoe");
    expect(req.systemPromptOverride).toContain("fetch Q2 numbers");
    expect(req.workItemContext).toEqual({
      adapterId: "slack-main",
      channelId: "C123",
      channelKind: "slack",
      channelLabel: "conf-tahoe",
      threadId: "1724680000.100",
      slackTs: "1724680001.200",
      slackThreadTs: "1724680000.100",
    });
  });

  it("T4: done completion stamps the ledger and re-enters the boss with the pinned WorkItem", async () => {
    const f = makeFixture();
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.onDispatch).toHaveBeenCalledTimes(1));
    const doc = f.claims.docs[0];
    expect(doc.status).toBe("done");
    expect(doc.resultText).toBe("report body");
    expect(typeof doc.durationMs).toBe("number");
    expect(doc.costUsd).toBe(0.01);
    expect(doc.toolCalls).toBe(3);

    const item = f.onDispatch.mock.calls[0][0] as AnyDoc;
    expect(item.id).toBe(`worker:${doc._id.toString()}`);
    expect(item.sender).toBe("system");
    expect(item.threadId).toBe("1724680000.100");
    expect(item.source).toEqual({ kind: "slack", id: "C123", label: "conf-tahoe", adapterId: "slack-main" });
    expect(item.meta).toEqual({
      slackTs: "1724680001.200",
      slackThreadTs: "1724680000.100",
      targetAgentId: "boss",
    });
    expect(item.text.startsWith("[Worker report — done] Task: ")).toBe(true);
    expect(item.text).toContain("report body");
    expect(item.text).toContain('reply "No response needed."');
  });

  it("T4: adapter error ⇒ failed claim + honest failure report", async () => {
    const f = makeFixture({
      runTurnImpl: async () => ({ text: "", error: "boom", costUsd: 0, durationMs: 5, toolCalls: 0 }),
    });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.onDispatch).toHaveBeenCalledTimes(1));
    expect(f.claims.docs[0].status).toBe("failed");
    expect(f.claims.docs[0].error).toBe("boom");
    const item = f.onDispatch.mock.calls[0][0] as AnyDoc;
    expect(item.text).toContain("The worker failed: boom");
  });

  it("T4: timeout ⇒ failed claim naming the wall clock", async () => {
    const f = makeFixture({
      runTurnImpl: async () => ({ text: "", timedOut: true, costUsd: 0, durationMs: 600_000, toolCalls: 1 }),
    });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.onDispatch).toHaveBeenCalledTimes(1));
    expect(f.claims.docs[0].status).toBe("failed");
    expect(f.claims.docs[0].error).toBe("worker timed out after 600000ms");
  });

  it("T4: completion drops when the claim already left running", async () => {
    const gate = deferred<AnyDoc>();
    const f = makeFixture({ runTurnImpl: () => gate.promise as Promise<AnyDoc> });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.runTurn).toHaveBeenCalled());
    // Simulate the watchdog winning the race.
    f.claims.docs[0].status = "expired";
    gate.resolve({ text: "report body", costUsd: 0.01, durationMs: 10, toolCalls: 1 });
    await flush();
    expect(f.claims.docs[0].status).toBe("expired");
    expect(f.claims.docs[0].resultText).toBeUndefined();
    expect(f.onDispatch).not.toHaveBeenCalled();
  });

  it("E12: oversized reports are truncated at the ledger cap", async () => {
    const f = makeFixture({
      runTurnImpl: async () => ({ text: "z".repeat(9000), costUsd: 0, durationMs: 10, toolCalls: 0 }),
    });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.onDispatch).toHaveBeenCalledTimes(1));
    const stored = f.claims.docs[0].resultText as string;
    expect(stored).toContain("…[truncated at 8000 chars]");
    expect(stored.startsWith("z".repeat(8000))).toBe(true);
    expect(stored.length).toBeLessThan(9000);
  });

  it("T5: boss gone or disabled ⇒ no re-entry item is constructed at all", async () => {
    const gone = deferred<AnyDoc>();
    const f = makeFixture({ runTurnImpl: () => gone.promise as Promise<AnyDoc> });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.runTurn).toHaveBeenCalled());
    delete f.agents.boss;
    gone.resolve({ text: "report body", costUsd: 0, durationMs: 10, toolCalls: 0 });
    await flush();
    expect(f.onDispatch).not.toHaveBeenCalled();
    expect(f.claims.docs[0].error).toBe("re-entry skipped: boss agent gone or disabled");

    const off = deferred<AnyDoc>();
    const g = makeFixture({ runTurnImpl: () => off.promise as Promise<AnyDoc> });
    await g.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(g.runTurn).toHaveBeenCalled());
    g.agents.boss.disabled = true;
    off.resolve({ text: "report body", costUsd: 0, durationMs: 10, toolCalls: 0 });
    await flush();
    expect(g.onDispatch).not.toHaveBeenCalled();
    expect(g.claims.docs[0].error).toBe("re-entry skipped: boss agent gone or disabled");
  });

  it("T11: an aborted worker turn leaves the claim to its owning path", async () => {
    const f = makeFixture({
      runTurnImpl: async () => ({ text: "", aborted: true, costUsd: 0, durationMs: 10, toolCalls: 0 }),
    });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await flush();
    expect(f.claims.docs[0].status).toBe("running");
    expect(f.onDispatch).not.toHaveBeenCalled();
  });

  it("T8: abortForBoss aborts only that boss's live workers", async () => {
    const f = makeFixture({
      registryAgents: {
        boss: {
          id: "boss",
          name: "Jasper",
          model: "opus",
          coreServers: ["memory"],
          delegateServers: [],
          schedule: [],
          budgetUsd: 2.5,
        },
        other: {
          id: "other",
          name: "Chloe",
          model: "opus",
          coreServers: ["memory"],
          delegateServers: [],
          schedule: [],
          budgetUsd: 2.5,
        },
      },
      runTurnImpl: () => new Promise(() => {}),
    });
    await f.pool.dispatch(dispatchReq("task one", "boss"));
    await f.pool.dispatch(dispatchReq("task two", "other"));
    await vi.waitFor(() => expect(f.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(2));
    f.pool.abortForBoss("boss");
    expect(f.abortSpies[0]).toHaveBeenCalledTimes(1);
    expect(f.abortSpies[1]).not.toHaveBeenCalled();
    expect(f.abortSpy).toHaveBeenCalledTimes(1);
  });

  it("T4/E13: cancel flips the claim, aborts the live worker, and drops the late completion", async () => {
    const gate = deferred<AnyDoc>();
    const f = makeFixture({ runTurnImpl: () => gate.promise as Promise<AnyDoc> });
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    await vi.waitFor(() => expect(f.runTurn).toHaveBeenCalled());
    const claimId = f.claims.docs[0]._id.toString();
    expect(await f.pool.cancel(claimId, "boss")).toBe(`Cancelled claim ${claimId}.`);
    expect(f.claims.docs[0].status).toBe("cancelled");
    expect(f.abortSpy).toHaveBeenCalledTimes(1);
    gate.resolve({ text: "report body", costUsd: 0.01, durationMs: 10, toolCalls: 1 });
    await flush();
    expect(f.claims.docs[0].status).toBe("cancelled");
    expect(f.claims.docs[0].resultText).toBeUndefined();
    expect(f.onDispatch).not.toHaveBeenCalled();
  });

  it("T6: restart sweep expires every running claim at boot and leaves terminal claims alone", async () => {
    const f = makeFixture();
    const a = seedClaim(f.claims, { taskText: "one" });
    const b = seedClaim(f.claims, { taskText: "two" });
    const c = seedClaim(f.claims, { taskText: "three", status: "done", resultText: "already reported" });
    await f.pool.start();
    f.pool.stop();
    expect(a.status).toBe("expired");
    expect(a.error).toBe("engine restarted mid-worker");
    expect(b.status).toBe("expired");
    expect(c.status).toBe("done");
    expect(c.resultText).toBe("already reported");
    expect(f.onDispatch).toHaveBeenCalledTimes(2);
    const texts = f.onDispatch.mock.calls.map((call) => (call[0] as AnyDoc).text as string);
    for (const t of texts) {
      expect(t.startsWith("[Worker report — expired] Task: ")).toBe(true);
      expect(t).toContain("re-dispatch if the room still needs it");
    }
  });

  it("review r1: a rejecting completion write on the boss-missing path never escapes as an unhandled rejection", async () => {
    // The detached `void spawnFetchWorker(doc)` chain: the boss-missing early
    // return awaits finishClaim OUTSIDE runWorkerTurn's try/catch, so a ledger
    // write failure in the same tick as a registry miss rejects the detached
    // promise — process-terminating under Node's default
    // --unhandled-rejections=throw. The terminal .catch is what keeps this at
    // zero.
    const f = makeFixture({ registryAgents: {}, runTurnImpl: () => new Promise(() => {}) });
    f.claims.findOneAndUpdate = async () => {
      throw new Error("mongo down");
    };
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const res = await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
      expect(res.startsWith("Worker dispatched")).toBe(true);
      await flush();
      // Let a late rejection surface before asserting.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", handler);
    }
    expect(rejections).toEqual([]);
    // Boss-missing path, not the turn path — no adapter was ever built.
    expect(f.hooks.buildWorkerAdapter).not.toHaveBeenCalled();
  });

  it("review r1: a failing restart sweep logs and start() still returns (interval-path parity)", async () => {
    const f = makeFixture();
    const realFind = f.claims.find.bind(f.claims);
    f.claims.find = (() => {
      throw new Error("ledger read failed");
    }) as any;
    await expect(f.pool.start()).resolves.toBeUndefined();
    f.claims.find = realFind as any;
    f.pool.stop();
  });
});

describe("MeetingWorkerPool — watchdog interval (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("T6: the 60s interval expires only past-deadline claims, aborts the live worker, and re-enters once", async () => {
    const f = makeFixture({
      config: { claimTtlMinutes: 1.5 }, // expiresAt = dispatch + 90s
      runTurnImpl: () => new Promise(() => {}),
    });
    await f.pool.start(); // empty ledger — restart sweep is a no-op
    expect(f.onDispatch).not.toHaveBeenCalled();

    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    const doc = f.claims.docs[0];
    expect(doc.status).toBe("running");

    // Tick 1 at T+60s: predicate false (90_000 < 60_000 is false) — a real
    // predicate-false pin, not "no tick yet".
    await vi.advanceTimersByTimeAsync(60_000);
    expect(doc.status).toBe("running");
    expect(f.onDispatch).not.toHaveBeenCalled();

    // Tick 2 at T+120s: past the deadline.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(doc.status).toBe("expired");
    expect(doc.error).toBe("claim TTL expired");
    expect(f.abortSpy).toHaveBeenCalledTimes(1);
    expect(f.onDispatch).toHaveBeenCalledTimes(1);
    const item = f.onDispatch.mock.calls[0][0] as AnyDoc;
    expect((item.text as string).startsWith("[Worker report — expired]")).toBe(true);
    expect(item.text).toContain("re-dispatch if the room still needs it");
    f.pool.stop();
  });

  it("T8: stop() aborts every live worker and genuinely clears the interval", async () => {
    const f = makeFixture({
      config: { claimTtlMinutes: 1.5 },
      runTurnImpl: () => new Promise(() => {}),
    });
    await f.pool.start();
    await f.pool.dispatch(dispatchReq("fetch Q2 numbers"));
    const doc = f.claims.docs[0];

    f.pool.stop();
    expect(f.abortSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(doc.status).toBe("running"); // no sweep fired — the timer is cleared
    expect(f.onDispatch).not.toHaveBeenCalled();
  });
});

describe("MeetingWorkerPool — runRoleTurn (KPR-409 sibling)", () => {
  const roleArgs = (over: AnyDoc = {}) => ({
    base: {
      id: "boss",
      name: "Jasper",
      model: "opus",
      coreServers: ["memory", "slack", "worker-pool"],
      delegateServers: ["crm-search"],
      schedule: [{ cron: "0 9 * * *" }],
      budgetUsd: 2.5,
    } as any,
    role: { model: "haiku", coreServers: [], maxTurns: 4, timeoutMs: 120_000, charter: "CHARTER" },
    prompt: "summarize this",
    workItemContext: meetingCtx as any,
    ...over,
  });

  it("clones the base config with the role's model/servers, delegateServers [] and schedule []", async () => {
    const f = makeFixture();
    await f.pool.runRoleTurn(roleArgs());
    expect(f.builtConfigs).toHaveLength(1);
    expect(f.builtConfigs[0]).toMatchObject({
      id: "boss",
      model: "haiku",
      coreServers: [],
      delegateServers: [],
      schedule: [],
      budgetUsd: 2.5,
    });
  });

  it("passes the charter as systemPromptOverride, runs sessionless, and binds the base budget", async () => {
    const f = makeFixture();
    await f.pool.runRoleTurn(roleArgs());
    const req = f.runTurn.mock.calls[0][0];
    expect(req.systemPromptOverride).toBe("CHARTER");
    expect(req.sessionId).toBeUndefined();
    expect(req.resourceLimits).toEqual({ maxTurns: 4, timeoutMs: 120_000, budgetUsd: 2.5 });
  });

  // ⚠ Two cases, because at maxConcurrent: 4 the assertion
  // `hasCapacity() === true` is INSENSITIVE to the bug: one wrongly-registered
  // role turn gives liveWorkers.size 1, and `1 < 4` is still true. Only the
  // dispatch-admission count discriminates there. The maxConcurrent: 1 case is
  // the one where hasCapacity() itself genuinely flips.
  it("T12 (pool half, maxConcurrent 1): a live role turn leaves hasCapacity() true", async () => {
    const f = makeFixture({ config: { maxConcurrent: 1 }, runTurnImpl: () => new Promise(() => {}) });
    void f.pool.runRoleTurn(roleArgs());
    await flush();
    // Discriminating: if runRoleTurn registered in liveWorkers, size would be
    // 1 and `1 < 1` would make this false.
    expect(f.pool.hasCapacity()).toBe(true);
  });

  it("T12 (pool half, maxConcurrent 4): a live role turn consumes no dispatch slot", async () => {
    // ⚠ perMeetingMax raised: the default is 3, and four dispatches on ONE
    // thread would be refused by the per-meeting cap before the engine-wide
    // cap is ever reached — which would make this test pass for the wrong
    // reason. maxConcurrent stays at its default 4 (the value under test).
    const f = makeFixture({
      config: { maxConcurrent: 4, perMeetingMax: 10 },
      runTurnImpl: () => new Promise(() => {}),
    });
    void f.pool.runRoleTurn(roleArgs());
    await flush();
    const results = [];
    for (const t of ["a", "b", "c", "d"]) results.push(await f.pool.dispatch(dispatchReq(t)));
    // Discriminating: with the role turn wrongly in liveWorkers, the 4th
    // dispatch sees size 4 >= 4 and is refused.
    expect(results.every((r) => r.startsWith("Worker dispatched (claim "))).toBe(true);
    expect(results.some((r) => r.includes("Worker pool saturated"))).toBe(false);
    expect(f.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(5); // 1 role + 4 fetch
    expect(f.pool.hasCapacity()).toBe(false); // now genuinely full, on fetch workers alone
  });

  it("touches no claim ledger and fires no re-entry", async () => {
    const f = makeFixture();
    await f.pool.runRoleTurn(roleArgs());
    expect(f.claims.docs).toHaveLength(0);
    expect(f.onDispatch).not.toHaveBeenCalled();
  });

  it("invokes onAbortHandle synchronously with a working abort, and never throws on adapter failure", async () => {
    const f = makeFixture({
      runTurnImpl: async () => {
        throw new Error("boom");
      },
    });
    let handle: (() => void) | undefined;
    const out = await f.pool.runRoleTurn(
      roleArgs({
        onAbortHandle: (a: () => void) => {
          handle = a;
        },
      }),
    );
    expect(handle).toBeTypeOf("function");
    handle!();
    expect(f.abortSpy).toHaveBeenCalled();
    expect(out?.error).toContain("boom");
  });

  it("returns null when manager hooks are not bound", async () => {
    const claims = makeFakeClaims();
    const pool = new MeetingWorkerPool({
      db: { collection: () => claims } as any,
      registry: { get: () => undefined } as any,
      onDispatch: vi.fn(),
      config: { ...DEFAULT_MEETING_WORKERS_CONFIG },
    });
    expect(await pool.runRoleTurn(roleArgs())).toBeNull();
  });
});
