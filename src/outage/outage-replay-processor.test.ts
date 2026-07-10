import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutageReplayProcessor } from "./outage-replay-processor.js";
import type { OutageQueueDoc } from "./outage-queue-store.js";
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
    expect(texts).toContain("Service is back — I couldn't get to 2 earlier messages from during the outage. Please re-send anything still needed.");
    expect(texts).toContain("Service is back — I couldn't get to 1 earlier message from during the outage. Please re-send anything still needed.");
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
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
    processor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1); // no further ticks
  });
});
