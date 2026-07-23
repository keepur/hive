import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted warn spy — scrub warnings and the .catch-swallow are assertable.
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockLogWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { SessionStore } from "./session-store.js";

function makeMockDb() {
  const findOne = vi.fn().mockResolvedValue(null);
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
  const createIndex = vi.fn().mockResolvedValue("ix");
  const countDocuments = vi.fn().mockResolvedValue(0);
  const find = vi.fn();
  const collection = vi.fn().mockReturnValue({
    findOne, updateOne, deleteOne, deleteMany, createIndex, countDocuments, find,
  });
  return { db: { collection } as any, mocks: { findOne, updateOne, deleteOne } };
}

const KEY = "agent-a:sms:line-1:t1";
function doc(sessionId: string, provider?: string) {
  return {
    _id: KEY,
    agentId: "agent-a",
    threadId: "sms:line-1:t1",
    sessionId,
    ...(provider ? { provider } : {}),
  };
}

describe("SessionStore — StoredSessionRef normalization + scrub (KPR-313)", () => {
  let store: SessionStore;
  let mocks: ReturnType<typeof makeMockDb>["mocks"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const m = makeMockDb();
    store = new SessionStore(m.db);
    mocks = m.mocks;
    await store.init();
  });

  it("set() writes the provider tag into $set", async () => {
    await store.set("agent-a", "sms:line-1:t1", "s-1", "claude", undefined);
    const [filter, update] = mocks.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ _id: KEY });
    expect(update.$set).toMatchObject({ sessionId: "s-1", provider: "claude" });
  });

  it("tagged resumable row round-trips; tagged rows are never scrubbed", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("s-1", "claude"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "s-1",
      provider: "claude",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it('sessionId:"" pilot row ⇒ { sessionId: undefined, provider } — thread-mapping row, nothing resumable', async () => {
    mocks.findOne.mockResolvedValueOnce(doc("", "codex"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: undefined,
      provider: "codex",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it("belt-and-braces: non-resumable tag with a non-empty id yields NO handle (and no scrub)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("resp_abc", "gemini"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: undefined,
      provider: "gemini",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it("openai-tagged resp_ row IS resumable (previousResponseId chaining)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("resp_abc", "openai"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "resp_abc",
      provider: "openai",
    });
  });

  it("KPR-346: kimi-tagged row IS resumable (Lane A client-transcript ⇒ handle returned)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("sess-kimi-1", "kimi"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "sess-kimi-1",
      provider: "kimi",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it("KPR-347 fail-closed: out-of-union provider tag on a row yields NO handle (old .has() scrub posture preserved)", async () => {
    // KPR-346: kimi joined the union (Lane A), so this fail-closed pin now uses
    // a genuinely out-of-union provider string — behavior of the source is
    // unchanged (any unknown provider ⇒ stateless-replay ⇒ no handle).
    mocks.findOne.mockResolvedValueOnce(doc("some-real-looking-id", "some-future-provider"));
    const ref = await store.get("agent-a", "sms:line-1:t1");
    expect(ref?.sessionId).toBeUndefined();
    expect(ref?.provider).toBe("some-future-provider"); // provenance passes through; handle does not
  });

  it("legacy untagged plain uuid grandfathers as claude (fleet-upgrade no-op)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("3f2a77aa-1111-4222-8333-444455556666"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "3f2a77aa-1111-4222-8333-444455556666",
      provider: "claude",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it.each(["codex-pilot-9d0e", "gemini-pilot-9d0e", "resp_9d0e"])(
    "scrubs legacy untagged fabricated id %s: absent ref, warn, id-guarded lazy delete",
    async (sessionId) => {
      mocks.findOne.mockResolvedValue(doc(sessionId));
      await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
        sessionId: undefined,
        provider: undefined,
      });
      expect(mocks.deleteOne).toHaveBeenCalledWith({ _id: KEY, sessionId });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("fabricated session id"),
        expect.objectContaining({ key: KEY }),
      );
    },
  );

  it("scrub warns once per key across repeated reads (lazy delete may repeat, warn must not)", async () => {
    mocks.findOne.mockResolvedValue(doc("codex-pilot-abc"));
    await store.get("agent-a", "sms:line-1:t1");
    await store.get("agent-a", "sms:line-1:t1");
    const scrubWarns = mockLogWarn.mock.calls.filter(([msg]) =>
      String(msg).includes("fabricated session id"),
    );
    expect(scrubWarns).toHaveLength(1);
  });

  it("legacy-slack fallback path returns the same normalized shape (and scrubs the legacy row)", async () => {
    mocks.findOne
      .mockResolvedValueOnce(null) // canonical key miss
      .mockResolvedValueOnce({
        _id: "agent-a:1712.34",
        agentId: "agent-a",
        threadId: "1712.34",
        sessionId: "codex-pilot-zzz",
      });
    await expect(store.get("agent-a", "slack:C123:1712.34")).resolves.toEqual({
      sessionId: undefined,
      provider: undefined,
    });
    expect(mocks.findOne).toHaveBeenNthCalledWith(2, { _id: "agent-a:1712.34" });
    expect(mocks.deleteOne).toHaveBeenCalledWith({ _id: "agent-a:1712.34", sessionId: "codex-pilot-zzz" });
  });

  it("no row anywhere ⇒ undefined (not a ref)", async () => {
    mocks.findOne.mockResolvedValue(null);
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toBeUndefined();
  });

  it("§8.8 scrub throw-safety: a rejecting deleteOne is .catch-swallowed — ref still returned, warn logged, no unhandled rejection", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("gemini-pilot-boom"));
    mocks.deleteOne.mockRejectedValueOnce(new Error("mongo blip"));
    const ref = await store.get("agent-a", "sms:line-1:t1");
    expect(ref).toEqual({ sessionId: undefined, provider: undefined });
    // Let the floating deleteOne rejection settle; the .catch must have eaten it.
    await new Promise((r) => setImmediate(r));
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Lazy scrub delete failed"),
      expect.objectContaining({ error: expect.stringContaining("mongo blip") }),
    );
  });

  it("findOne failure fail-softs to undefined (unchanged degraded mode — fresh turn, guard no-op)", async () => {
    mocks.findOne.mockRejectedValueOnce(new Error("down"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toBeUndefined();
  });
});
