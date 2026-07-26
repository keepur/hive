import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted warn spy — the fail-soft degradation warnings are assertable.
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockLogWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { TurnHistoryStore, HISTORY_CHAR_BUDGET } from "./turn-history-store.js";

function makeMockDb() {
  const findOne = vi.fn().mockResolvedValue(null);
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
  const createIndex = vi.fn().mockResolvedValue("ix");
  const collection = vi.fn().mockReturnValue({
    findOne, updateOne, deleteMany, createIndex,
  });
  return { db: { collection } as any, mocks: { findOne, updateOne, deleteMany, createIndex, collection } };
}

describe("TurnHistoryStore — stateless-replay history (KPR-353 §D3)", () => {
  let store: TurnHistoryStore;
  let mocks: ReturnType<typeof makeMockDb>["mocks"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const m = makeMockDb();
    store = new TurnHistoryStore(m.db);
    mocks = m.mocks;
    await store.init();
  });

  it("init() creates the TTL index and the {agentId,threadId} index on provider_turn_history", () => {
    expect(mocks.collection).toHaveBeenCalledWith("provider_turn_history");
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { updatedAt: 1 },
      { expireAfterSeconds: 604800 },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith({ agentId: 1, threadId: 1 });
  });

  it("load miss → []", async () => {
    mocks.findOne.mockResolvedValueOnce(null);
    await expect(store.load("a", "t", "codex")).resolves.toEqual([]);
    expect(mocks.findOne).toHaveBeenCalledWith({ _id: "a:t:codex" });
  });

  it("load hit with two turns → flattened items, oldest-first", async () => {
    mocks.findOne.mockResolvedValueOnce({
      _id: "a:t:codex",
      agentId: "a",
      threadId: "t",
      provider: "codex",
      turns: [
        { at: new Date(), items: [{ n: 1 }, { n: 2 }] },
        { at: new Date(), items: [{ n: 3 }] },
      ],
      updatedAt: new Date(),
    });
    await expect(store.load("a", "t", "codex")).resolves.toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });

  it("append first turn → updateOne upsert with _id a:t:codex, one turn record verbatim, $set.provider codex", async () => {
    mocks.findOne.mockResolvedValueOnce(null);
    const items = [{ role: "user", text: "hi" }, { type: "reasoning", encrypted_content: "xyz" }];
    await store.append("a", "t", "codex", items);

    expect(mocks.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = mocks.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ _id: "a:t:codex" });
    expect(options).toEqual({ upsert: true });
    expect(update.$set.agentId).toBe("a");
    expect(update.$set.threadId).toBe("t");
    expect(update.$set.provider).toBe("codex");
    expect(update.$set.turns).toHaveLength(1);
    expect(update.$set.turns[0].items).toEqual(items);
  });

  it("append with existing doc → new record appended after existing turns", async () => {
    mocks.findOne.mockResolvedValueOnce({
      _id: "a:t:codex",
      agentId: "a",
      threadId: "t",
      provider: "codex",
      turns: [{ at: new Date(), items: [{ n: 1 }] }],
      updatedAt: new Date(),
    });
    await store.append("a", "t", "codex", [{ n: 2 }]);

    const [, update] = mocks.updateOne.mock.calls[0]!;
    expect(update.$set.turns).toHaveLength(2);
    expect(update.$set.turns[0].items).toEqual([{ n: 1 }]);
    expect(update.$set.turns[1].items).toEqual([{ n: 2 }]);
  });

  it("append with empty items → no collection call at all", async () => {
    await store.append("a", "t", "codex", []);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it("trim: seeded turns exceeding the budget → oldest dropped, newest present and intact", async () => {
    // Two big existing turns, each ~150k serialized chars → adding a third pushes
    // total over HISTORY_CHAR_BUDGET (200k), so the oldest turn(s) are trimmed.
    const big = "x".repeat(150_000);
    mocks.findOne.mockResolvedValueOnce({
      _id: "a:t:codex",
      agentId: "a",
      threadId: "t",
      provider: "codex",
      turns: [
        { at: new Date(), items: [{ tag: "oldest", pad: big }] },
        { at: new Date(), items: [{ tag: "middle", pad: big }] },
      ],
      updatedAt: new Date(),
    });
    const newestItems = [{ tag: "newest" }];
    await store.append("a", "t", "codex", newestItems);

    const [, update] = mocks.updateOne.mock.calls[0]!;
    const writtenTurns = update.$set.turns as { items: { tag: string }[] }[];
    // At least the oldest was dropped.
    expect(writtenTurns.length).toBeLessThan(3);
    const tags = writtenTurns.map((t) => t.items[0]!.tag);
    expect(tags).not.toContain("oldest");
    // Newest turn present and its items array is intact (unsplit).
    const newest = writtenTurns[writtenTurns.length - 1]!;
    expect(newest.items).toEqual(newestItems);
    expect(JSON.stringify(update.$set.turns).length).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
  });

  it("single over-budget turn kept whole (turns.length > 1 guard)", async () => {
    mocks.findOne.mockResolvedValueOnce(null);
    const huge = "y".repeat(HISTORY_CHAR_BUDGET + 50_000);
    const items = [{ a: 1 }, { b: 2 }, { pad: huge }];
    await store.append("a", "t", "codex", items);

    const [, update] = mocks.updateOne.mock.calls[0]!;
    expect(update.$set.turns).toHaveLength(1);
    // Unsplit — the whole items array survives even though it blows the budget.
    expect(update.$set.turns[0].items).toEqual(items);
  });

  it("clear calls deleteMany({agentId, threadId}) with no provider (provider-agnostic §D4)", async () => {
    await store.clear("a", "t");
    expect(mocks.deleteMany).toHaveBeenCalledWith({ agentId: "a", threadId: "t" });
  });

  // ── Breaker-safety never-rejects pins (§D3): a Mongo throw must never escape,
  //    and no Mongo error text may reach the resolved value (it would trip the
  //    codex breaker via connect-fail classification).
  it("never-rejects: findOne rejecting connect-fail → load resolves [] with a warn, no error text", async () => {
    mocks.findOne.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:27017"));
    const result = await store.load("a", "t", "codex");
    expect(result).toEqual([]);
    expect(mockLogWarn).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("never-rejects: updateOne rejecting connect-fail → append resolves void with a warn, no error text", async () => {
    mocks.findOne.mockResolvedValueOnce(null);
    mocks.updateOne.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:27017"));
    const result = await store.append("a", "t", "codex", [{ n: 1 }]);
    expect(result).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalled();
    expect(JSON.stringify(result ?? null)).not.toContain("ECONNREFUSED");
  });

  it("never-rejects: deleteMany rejecting connect-fail → clear resolves void with a warn, no error text", async () => {
    mocks.deleteMany.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:27017"));
    const result = await store.clear("a", "t");
    expect(result).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalled();
    expect(JSON.stringify(result ?? null)).not.toContain("ECONNREFUSED");
  });
});
