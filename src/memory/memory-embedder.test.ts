import { describe, it, expect, vi } from "vitest";
import { MemoryEmbedder } from "./memory-embedder.js";

function embedderWithStubClient(client: Record<string, unknown>) {
  const embedder = new MemoryEmbedder();
  // Bypass construction and ensureCollection by injecting a ready client.
  (embedder as unknown as { qdrant: unknown; collectionReady: boolean }).qdrant = client;
  (embedder as unknown as { qdrant: unknown; collectionReady: boolean }).collectionReady = true;
  return embedder;
}

describe("MemoryEmbedder.findSimilar — orphan pointId handling", () => {
  it("returns [] when Qdrant 404s on the positive example (orphan Mongo record)", async () => {
    const query = vi.fn().mockRejectedValue(new Error("Not Found: Point with id abc does not exists!"));
    const embedder = embedderWithStubClient({ query });

    const result = await embedder.findSimilar("orphan-point-id", "nora", 0.9, 10);

    expect(result).toEqual([]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("rethrows unexpected errors", async () => {
    const query = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const embedder = embedderWithStubClient({ query });

    await expect(embedder.findSimilar("some-point", "nora", 0.9, 10)).rejects.toThrow("Connection refused");
  });

  it("returns mapped points on success", async () => {
    const query = vi.fn().mockResolvedValue({
      points: [
        { id: "pt-1", score: 0.95, payload: { mongoId: "mongo-1" } },
        { id: "pt-2", score: 0.91, payload: { mongoId: "mongo-2" } },
      ],
    });
    const embedder = embedderWithStubClient({ query });

    const result = await embedder.findSimilar("source-point", "nora", 0.9, 10);

    expect(result).toEqual([
      { mongoId: "mongo-1", score: 0.95, pointId: "pt-1" },
      { mongoId: "mongo-2", score: 0.91, pointId: "pt-2" },
    ]);
  });
});

describe("MemoryEmbedder.upsert truncation (KPR-241)", () => {
  it("does not truncate content under the embed cap", async () => {
    const embedder = new MemoryEmbedder("http://qdrant.test", "http://ollama.test");
    const upsertSpy = vi.fn().mockResolvedValue({});
    (embedder as any).getClient = () => ({ upsert: upsertSpy });
    (embedder as any).embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    (embedder as any).collectionReady = true;
    await embedder.upsert("p1", "short content", {
      agentId: "a", mongoId: "m", type: "fact", topic: "t", tier: "hot", importance: "medium", createdAt: 1,
    });
    const upsertCall = upsertSpy.mock.calls[0][1];
    expect(upsertCall.points[0].payload.truncated).toBeUndefined();
  });

  it("truncates content over the embed cap and sets truncated:true", async () => {
    const embedder = new MemoryEmbedder("http://qdrant.test", "http://ollama.test");
    const upsertSpy = vi.fn().mockResolvedValue({});
    const embedSpy = vi.fn().mockResolvedValue([0.1, 0.2]);
    (embedder as any).getClient = () => ({ upsert: upsertSpy });
    (embedder as any).embed = embedSpy;
    (embedder as any).collectionReady = true;
    const longContent = "x".repeat(7000);
    await embedder.upsert("p1", longContent, {
      agentId: "a", mongoId: "m", type: "fact", topic: "t", tier: "hot", importance: "medium", createdAt: 1,
    });
    expect(embedSpy.mock.calls[0][0].length).toBeLessThanOrEqual(6100);
    expect(upsertSpy.mock.calls[0][1].points[0].payload.truncated).toBe(true);
  });
});

describe("MemoryEmbedder.setTierPayload (KPR-241)", () => {
  it("calls Qdrant setPayload with the given pointIds and tier", async () => {
    const embedder = new MemoryEmbedder("http://qdrant.test", "http://ollama.test");
    const setPayloadSpy = vi.fn().mockResolvedValue({});
    (embedder as any).getClient = () => ({ setPayload: setPayloadSpy });
    (embedder as any).collectionReady = true;
    await embedder.setTierPayload(["p1", "p2"], "cold");
    expect(setPayloadSpy).toHaveBeenCalledWith("agent_memory", {
      payload: { tier: "cold" },
      points: ["p1", "p2"],
    });
  });

  it("returns early without calling Qdrant when pointIds is empty", async () => {
    const embedder = new MemoryEmbedder();
    const setPayloadSpy = vi.fn();
    (embedder as any).getClient = () => ({ setPayload: setPayloadSpy });
    await embedder.setTierPayload([], "warm");
    expect(setPayloadSpy).not.toHaveBeenCalled();
  });

  it("swallows Qdrant errors (best-effort)", async () => {
    const embedder = new MemoryEmbedder();
    const setPayloadSpy = vi.fn().mockRejectedValue(new Error("network down"));
    (embedder as any).getClient = () => ({ setPayload: setPayloadSpy });
    (embedder as any).collectionReady = true;
    await expect(embedder.setTierPayload(["p1"], "warm")).resolves.toBeUndefined();
  });
});
