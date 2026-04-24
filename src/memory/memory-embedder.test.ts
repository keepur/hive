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
