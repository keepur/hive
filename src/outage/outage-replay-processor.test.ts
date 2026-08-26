import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutageReplayProcessor } from "./outage-replay-processor.js";
import { OutageQueueStore, type OutageQueueDoc } from "./outage-queue-store.js";
import type { WorkItem } from "../types/work-item.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CONFIG = { enabled: true, replayIntervalMs: 15_000, maxAgeHours: 4, maxDepth: 500, maxReplayAttempts: 3 };

function makeDoc(overrides: Partial<OutageQueueDoc> = {}): OutageQueueDoc {
  const workItem: WorkItem = {
    id: overrides.itemId ?? "m1",
    text: "original question",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    threadId: "t1",
    timestamp: new Date("2026-07-07T10:00:00Z"),
  };
  return {
    itemId: "m1",
    agentId: "agent-a",
    provider: "claude",
    workItem,
    policy: "notify",
    status: "replaying",
    attempts: 0,
    enqueuedAt: new Date("2026-07-07T10:00:00Z"),
    lastAttemptAt: null,
    lastError: null,
    noticeSent: true,
    doneAt: null,
    ...overrides,
  };
}

function makeStore() {
  return {
    claimNext: vi.fn().mockResolvedValue(null),
    release: vi.fn().mockResolvedValue(undefined),
    statusOf: vi.fn().mockResolvedValue("done"),
    expireOlderThan: vi.fn().mockResolvedValue([]),
    recoverStaleReplaying: vi.fn().mockResolvedValue(0),
  };
}

function makeDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
    deliverOutageNotice: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OutageReplayProcessor (KPR-307 §7.4)", () => {
  let store: ReturnType<typeof makeStore>;
  let dispatcher: ReturnType<typeof makeDispatcher>;
  let processor: OutageReplayProcessor;

  beforeEach(() => {
    store = makeStore();
    dispatcher = makeDispatcher();
    processor = new OutageReplayProcessor(store as never, dispatcher as never, CONFIG);
  });

  afterEach(() => {
    processor.stop();
    vi.useRealTimers();
  });

  it("redispatches with the ORIGINAL id, wrapped text, pinned targetAgentId, and outageReplay meta", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc()).mockResolvedValueOnce(null);
    await processor.tick();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const item = dispatcher.dispatch.mock.calls[0][0] as WorkItem;
    expect(item.id).toBe("m1"); // no synthetic replay:<attempt>: id
    expect(item.text).toMatch(/^\[This message was received at .* during an AI service outage/);
    expect(item.text).toContain("original question");
    expect(item.meta).toMatchObject({ targetAgentId: "agent-a", outageReplay: true });
  });

  it("silent-policy docs get the minimal wrap variant", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc({ policy: "silent" })).mockResolvedValueOnce(null);
    await processor.tick();
    expect((dispatcher.dispatch.mock.calls[0][0] as WorkItem).text).toMatch(/^\[Replayed after an AI service outage/);
  });

  it("★ drain control re-reads status: continues through done/expired/failed, stops on pending", async () => {
    store.claimNext
      .mockResolvedValueOnce(makeDoc({ itemId: "a" }))
      .mockResolvedValueOnce(makeDoc({ itemId: "b" }))
      .mockResolvedValueOnce(makeDoc({ itemId: "c" }))
      .mockResolvedValueOnce(makeDoc({ itemId: "d" }))
      .mockResolvedValue(null);
    store.statusOf
      .mockResolvedValueOnce("done") // a → continue
      .mockResolvedValueOnce("expired") // b → continue
      .mockResolvedValueOnce("failed") // c → continue
      .mockResolvedValueOnce("pending"); // d fast-failed again → STOP

    await processor.tick();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(4);
    expect(store.claimNext).toHaveBeenCalledTimes(4); // never claimed a 5th while pending signaled stop
  });

  it("a dispatch() throw releases the doc back to pending and stops the drain", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc()).mockResolvedValue(null);
    dispatcher.dispatch.mockRejectedValueOnce(new Error("mongo hiccup"));

    await processor.tick();
    expect(store.release).toHaveBeenCalledWith("m1", "agent-a", "pending", expect.stringContaining("mongo hiccup"));
    expect(store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("a doc left in replaying (no outcome written) is defensively reverted and stops the drain", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc()).mockResolvedValue(null);
    store.statusOf.mockResolvedValueOnce("replaying");

    await processor.tick();
    expect(store.release).toHaveBeenCalledWith("m1", "agent-a", "pending", "no outcome recorded at dispatch");
  });

  it("expiry: one batched per-thread notice with the correct count; silent docs excluded", async () => {
    store.expireOlderThan.mockResolvedValueOnce([
      makeDoc({ itemId: "e1" }),
      makeDoc({ itemId: "e2" }), // same thread t1
      makeDoc({ itemId: "e3", policy: "silent" }), // silent — no notice
      makeDoc({
        itemId: "e4",
        workItem: {
          id: "e4",
          text: "x",
          source: { kind: "sms", id: "+1555", label: "line" },
          sender: "+1555",
          timestamp: new Date(),
        },
      }), // different (adapter, sender) group
    ]);

    await processor.tick();
    expect(dispatcher.deliverOutageNotice).toHaveBeenCalledTimes(2);
    const texts = dispatcher.deliverOutageNotice.mock.calls.map((c: any[]) => c[3]);
    expect(texts).toContain(
      "It's been a while since your message — I couldn't get to 2 earlier messages sent during the outage. Please re-send anything still needed if it's still relevant.",
    );
    expect(texts).toContain(
      "It's been a while since your message — I couldn't get to 1 earlier message sent during the outage. Please re-send anything still needed if it's still relevant.",
    );
  });

  it("expiry: fan-out to two agents counts as one user message (distinct itemIds, not raw docs)", async () => {
    // One user message fanned to two agents → two docs, same itemId, same thread.
    store.expireOlderThan.mockResolvedValueOnce([
      makeDoc({ itemId: "f1", agentId: "agent-a" }),
      makeDoc({ itemId: "f1", agentId: "agent-b" }),
    ]);

    await processor.tick();
    expect(dispatcher.deliverOutageNotice).toHaveBeenCalledTimes(1);
    const texts = dispatcher.deliverOutageNotice.mock.calls.map((c: any[]) => c[3]);
    expect(texts).toContain(
      "It's been a while since your message — I couldn't get to 1 earlier message sent during the outage. Please re-send anything still needed if it's still relevant.",
    );
  });

  it("tick is re-entrancy guarded", async () => {
    let resolveClaim!: (v: null) => void;
    store.claimNext.mockReturnValueOnce(new Promise((r) => (resolveClaim = r)));
    const first = processor.tick();
    await processor.tick(); // second tick while first in flight → no-op
    resolveClaim(null);
    await first;
    expect(store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("start() recovers stale replaying docs and ticks on the configured interval; stop() halts it", async () => {
    vi.useFakeTimers();
    processor.start();
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(1); // boot call fires BEFORE the first interval
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(2); // KPR-403: the sweep also rides every tick
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
    processor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1); // no further ticks
  });
});

// ---------------------------------------------------------------------------
// KPR-403: deadline-aware periodic re-sweep of replaying orphans
// ---------------------------------------------------------------------------

describe("OutageReplayProcessor — periodic stale-replaying re-sweep (KPR-403)", () => {
  it("KPR-403: tick order is sweep → expire → drain; same-tick recovery feeds the same tick's drain by construction", async () => {
    // NEGATIVE-VERIFY prediction (Step 4): pre-fix tick() has no sweep step —
    // the "recover" label never appears and this row fails.
    const store = makeStore();
    const dispatcher = makeDispatcher();
    const processor = new OutageReplayProcessor(store as never, dispatcher as never, CONFIG);
    const order: string[] = [];
    store.recoverStaleReplaying.mockImplementation(async () => {
      order.push("recover");
      return 0;
    });
    store.expireOlderThan.mockImplementation(async () => {
      order.push("expire");
      return [];
    });
    store.claimNext.mockImplementation(async () => {
      order.push("drain");
      return null;
    });
    await processor.tick();
    expect(order).toEqual(["recover", "expire", "drain"]);
  });

  it("KPR-403: a sweep rejection is caught — expire and drain still run", async () => {
    // Pin, passes both ways by design pre-/post-fix (pre-fix the sweep is
    // simply absent): the point is that a Mongo hiccup in the sweep must
    // never starve expiry or the drain (spec §Edge-5).
    const store = makeStore();
    const dispatcher = makeDispatcher();
    const processor = new OutageReplayProcessor(store as never, dispatcher as never, CONFIG);
    store.recoverStaleReplaying.mockRejectedValueOnce(new Error("mongo hiccup"));
    await processor.tick(); // must not throw
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
    expect(store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("★ KPR-403 Q2: a crash-orphan younger than its bound at boot is recovered by a later tick and replayed", async () => {
    // The Q2 headline pin, on the REAL store + REAL processor tick: mock
    // choreography here would only test the mocks. The mini driver fake
    // below covers exactly the surface this flow touches; query-shape
    // fidelity (ordering, upserts, CAS) is the store suite's job.
    let clock = Date.parse("2026-07-07T12:00:00Z");
    const coll = new MiniOutageCollection();
    const realStore = new OutageQueueStore(coll as never, () => new Date(clock));
    const workItem: WorkItem = {
      id: "m1",
      text: "original question",
      source: { kind: "slack", id: "C1", label: "general" },
      sender: "user1",
      threadId: "t1",
      timestamp: new Date("2026-07-07T10:00:00Z"),
    };
    // Fresh-claimed orphan: the process crashed 10s after claimNext stamped it.
    coll.docs.push({
      _id: "d1",
      itemId: "m1",
      agentId: "agent-a",
      provider: "claude",
      workItem,
      policy: "notify",
      enqueueOrigin: "fast-fail",
      deadlineMs: 300_000,
      status: "replaying",
      attempts: 0,
      enqueuedAt: new Date(clock - 10_000),
      lastAttemptAt: new Date(clock - 10_000),
      lastError: null,
      noticeSent: true,
      doneAt: null,
    });
    const dispatcher = {
      // Dispatcher-authored outcome (§5-2g): a successful replay releases done.
      dispatch: vi.fn().mockImplementation(async (item: WorkItem) => {
        await realStore.release(item.id, "agent-a", "done");
      }),
      deliverOutageNotice: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new OutageReplayProcessor(realStore as never, dispatcher as never, CONFIG, () => new Date(clock));

    // Boot-time sweep (start()'s call, 10s after the crash): orphan is far
    // under its 360s bound — correctly untouched. Pre-fix, nothing would
    // EVER look at it again (expiry is pending-only; TTL needs a Date doneAt).
    expect(await realStore.recoverStaleReplaying()).toBe(0);
    expect(coll.docs[0].status).toBe("replaying");

    clock += 400_000; // past deadlineMs 300s + 60s grace
    await processor.tick(); // sweep → expire → drain in ONE tick

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const replayed = dispatcher.dispatch.mock.calls[0][0] as WorkItem;
    expect(replayed.meta).toMatchObject({ targetAgentId: "agent-a", outageReplay: true });
    expect(coll.docs[0].status).toBe("done"); // recovered → claimed → replayed → released
  });
});

// KPR-403 T6 harness: minimal driver fake for the REAL OutageQueueStore —
// equality + $lt + Date-equality matching, $set/$setOnInsert application.
// Deliberately tiny and test-local (repo convention: harness beside its
// subject); the store suite's FakeOutageCollection remains the authority on
// full query-shape fidelity.
function miniMatches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { $lt?: unknown };
      if ("$lt" in c && !(val !== null && (val as never) < (c.$lt as never))) return false;
    } else if (val instanceof Date && cond instanceof Date) {
      if (val.getTime() !== cond.getTime()) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function miniApply(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  for (const [k, v] of Object.entries((update.$set as Record<string, unknown>) ?? {})) doc[k] = v;
}

class MiniOutageCollection {
  docs: Record<string, unknown>[] = [];

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const doc = this.docs.find((d) => miniMatches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    miniApply(doc, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (miniMatches(doc, filter)) {
        miniApply(doc, update);
        modifiedCount++;
      }
    }
    return { modifiedCount };
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>) {
    // Sort ignored: T6 stages at most one candidate; ordering fidelity is
    // the store suite's job (KPR-400 F2 rows).
    const doc = this.docs.find((d) => miniMatches(d, filter));
    if (!doc) return null;
    miniApply(doc, update);
    return { ...doc };
  }

  async findOne(filter: Record<string, unknown>) {
    const doc = this.docs.find((d) => miniMatches(d, filter));
    return doc ? { ...doc } : null;
  }

  find(filter: Record<string, unknown>) {
    const results = this.docs.filter((d) => miniMatches(d, filter)).map((d) => ({ ...d }));
    return { toArray: async () => results };
  }
}
