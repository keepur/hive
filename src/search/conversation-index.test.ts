import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Qdrant client ──────────────────────────────────────────────────────

const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockUpsert = vi.fn();
const mockSearch = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: mockGetCollections,
    createCollection: mockCreateCollection,
    upsert: mockUpsert,
    search: mockSearch,
  })),
}));

// ── Mock fetch (Ollama embedding) ───────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock crypto.randomUUID ──────────────────────────────────────────────────

const mockRandomUUID = vi.fn();
vi.stubGlobal("crypto", { randomUUID: mockRandomUUID });

import { ConversationIndex, type ConversationDocument } from "./conversation-index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_VECTOR = [0.1, 0.2, 0.3];

function makeOllamaResponse(embeddings: number[][] = [FAKE_VECTOR]): Response {
  return {
    ok: true,
    json: async () => ({ embeddings }),
    text: async () => "",
  } as unknown as Response;
}

function makeDoc(overrides: Partial<ConversationDocument> = {}): ConversationDocument {
  return {
    agentId: "agent-a",
    threadId: "thread-1",
    channelId: "C123",
    source: "slack",
    senderName: "Alice",
    timestampUnix: 1700000000,
    timestamp: "2024-01-01T00:00:00.000Z",
    inbound: "hello there",
    response: "hi back",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ConversationIndex", () => {
  let index: ConversationIndex;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(makeOllamaResponse());
    mockRandomUUID.mockReturnValue("uuid-1234");
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);
    mockUpsert.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue([]);

    // Create a fresh instance each test so collectionReady resets
    index = new ConversationIndex("http://localhost:6333", "http://localhost:11434");
  });

  describe("ensureCollection", () => {
    it("creates collection on first call, skips on subsequent calls", async () => {
      await index.ensureCollection();

      expect(mockGetCollections).toHaveBeenCalledTimes(1);
      expect(mockCreateCollection).toHaveBeenCalledTimes(1);
      expect(mockCreateCollection).toHaveBeenCalledWith("conversations", {
        vectors: { size: FAKE_VECTOR.length, distance: "Cosine" },
      });

      // Second call should skip entirely — collectionReady is true
      await index.ensureCollection();

      expect(mockGetCollections).toHaveBeenCalledTimes(1);
      expect(mockCreateCollection).toHaveBeenCalledTimes(1);
    });

    it("skips creation if collection already exists", async () => {
      mockGetCollections.mockResolvedValue({
        collections: [{ name: "conversations" }],
      });

      await index.ensureCollection();

      expect(mockGetCollections).toHaveBeenCalledTimes(1);
      expect(mockCreateCollection).not.toHaveBeenCalled();
      // Should not call embed either — no test vector needed
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("index", () => {
    it("embeds inbound+response concatenation and upserts with correct payload", async () => {
      const doc = makeDoc();
      await index.index(doc);

      // Verify the embed call contains concatenated text
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        }),
      );

      // Parse the fetch body to verify concatenation
      const indexCall = mockFetch.mock.calls.find(
        (c) => typeof c[1]?.body === "string" && c[1].body.includes("hello there"),
      );
      expect(indexCall).toBeDefined();
      const body = JSON.parse(indexCall![1].body as string);
      expect(body.input).toBe("hello there\n\nhi back");

      // Verify upsert payload
      expect(mockUpsert).toHaveBeenCalledWith("conversations", {
        points: [
          {
            id: "uuid-1234",
            vector: FAKE_VECTOR,
            payload: {
              agentId: "agent-a",
              threadId: "thread-1",
              channelId: "C123",
              source: "slack",
              senderName: "Alice",
              timestampUnix: 1700000000,
              timestamp: "2024-01-01T00:00:00.000Z",
              inbound: "hello there",
              response: "hi back",
            },
          },
        ],
      });
    });

    it("uses crypto.randomUUID for point IDs", async () => {
      mockRandomUUID.mockReturnValue("custom-uuid-5678");

      await index.index(makeDoc());

      expect(mockRandomUUID).toHaveBeenCalled();
      expect(mockUpsert).toHaveBeenCalledWith(
        "conversations",
        expect.objectContaining({
          points: [expect.objectContaining({ id: "custom-uuid-5678" })],
        }),
      );
    });
  });

  describe("search", () => {
    it("builds correct filter with agentId match", async () => {
      mockSearch.mockResolvedValue([]);

      await index.search("query text", "agent-a", 5);

      expect(mockSearch).toHaveBeenCalledWith("conversations", {
        vector: FAKE_VECTOR,
        limit: 5,
        with_payload: true,
        filter: {
          must: [{ key: "agentId", match: { value: "agent-a" } }],
        },
      });
    });

    it("adds timestampUnix range filter when sinceUnix is provided", async () => {
      mockSearch.mockResolvedValue([]);

      await index.search("query text", "agent-a", 10, 1700000000);

      expect(mockSearch).toHaveBeenCalledWith("conversations", {
        vector: FAKE_VECTOR,
        limit: 10,
        with_payload: true,
        filter: {
          must: [
            { key: "agentId", match: { value: "agent-a" } },
            { key: "timestampUnix", range: { gte: 1700000000 } },
          ],
        },
      });
    });

    it("returns correctly typed ConversationResult array", async () => {
      mockSearch.mockResolvedValue([
        {
          score: 0.95,
          payload: {
            agentId: "agent-a",
            threadId: "thread-1",
            channelId: "C123",
            source: "slack",
            senderName: "Alice",
            timestampUnix: 1700000000,
            timestamp: "2024-01-01T00:00:00.000Z",
            inbound: "hello",
            response: "world",
          },
        },
        {
          score: 0.82,
          payload: {
            agentId: "agent-a",
            threadId: "thread-2",
            channelId: "C456",
            source: "sms",
            senderName: "Bob",
            timestampUnix: 1700001000,
            timestamp: "2024-01-01T00:16:40.000Z",
            inbound: "question",
            response: "answer",
          },
        },
      ]);

      const results = await index.search("test query", "agent-a", 10);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        agentId: "agent-a",
        threadId: "thread-1",
        channelId: "C123",
        source: "slack",
        senderName: "Alice",
        timestampUnix: 1700000000,
        timestamp: "2024-01-01T00:00:00.000Z",
        inbound: "hello",
        response: "world",
        score: 0.95,
      });
      expect(results[1]!.score).toBe(0.82);
      expect(results[1]!.senderName).toBe("Bob");
    });
  });
});
