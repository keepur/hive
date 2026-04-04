import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActivityRecord } from "./types.js";

// Mock logger
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ActivityLogger } from "./activity-logger.js";

function makeRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    agentId: "test-agent",
    threadId: "thread-1",
    timestamp: new Date(),
    sender: "user1",
    senderName: "Alice",
    channel: "general",
    channelKind: "slack",
    model: "claude-haiku-4-5",
    costUsd: 0.01,
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    contextWindow: 200000,
    toolCalls: 1,
    toolSummary: "memory:1x/0.2s",
    compactions: 0,
    streamed: false,
    ...overrides,
  };
}

function makeMockCollection() {
  return {
    createIndex: vi.fn().mockResolvedValue("ok"),
    insertMany: vi.fn().mockResolvedValue({ insertedCount: 1 }),
    estimatedDocumentCount: vi.fn().mockResolvedValue(0),
  };
}

function makeMockDb(collection: ReturnType<typeof makeMockCollection>) {
  return {
    collection: vi.fn().mockReturnValue(collection),
  };
}

function makeConfig(
  overrides: Partial<{ enabled: boolean; bufferSize: number; flushIntervalMs: number; retentionDays: number }> = {},
) {
  return {
    enabled: true,
    bufferSize: 200,
    flushIntervalMs: 30000,
    retentionDays: 90,
    ...overrides,
  };
}

describe("ActivityLogger", () => {
  let mockCollection: ReturnType<typeof makeMockCollection>;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCollection = makeMockCollection();
    mockDb = makeMockDb(mockCollection);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connect", () => {
    it("creates indexes and starts flush timer", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      expect(mockDb.collection).toHaveBeenCalledWith("activity_log");
      expect(mockCollection.createIndex).toHaveBeenCalledTimes(2);
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ agentId: 1, timestamp: -1 });
      expect(mockCollection.createIndex).toHaveBeenCalledWith(
        { timestamp: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60 },
      );
      expect(mockCollection.estimatedDocumentCount).toHaveBeenCalled();

      await logger.stop();
    });

    it("skips setup when disabled", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ enabled: false }));
      await logger.connect();

      expect(mockDb.collection).not.toHaveBeenCalled();
      expect(mockCollection.createIndex).not.toHaveBeenCalled();
    });

    it("computes TTL from retentionDays", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ retentionDays: 30 }));
      await logger.connect();

      expect(mockCollection.createIndex).toHaveBeenCalledWith(
        { timestamp: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60 },
      );

      await logger.stop();
    });
  });

  describe("record", () => {
    it("buffers records without flushing immediately", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ bufferSize: 200 }));
      await logger.connect();

      logger.record(makeRecord());
      logger.record(makeRecord());

      // No flush yet — buffer not full
      expect(mockCollection.insertMany).not.toHaveBeenCalled();

      await logger.stop();
    });

    it("drops records when disabled", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ enabled: false }));
      await logger.connect();

      logger.record(makeRecord());

      // No collection access — disabled
      expect(mockCollection.insertMany).not.toHaveBeenCalled();
    });

    it("drops records when not connected", () => {
      // Don't call connect()
      const logger = new ActivityLogger(mockDb as any, makeConfig());

      logger.record(makeRecord());

      expect(mockCollection.insertMany).not.toHaveBeenCalled();
    });

    it("triggers flush when buffer reaches bufferSize", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ bufferSize: 3 }));
      await logger.connect();

      logger.record(makeRecord({ agentId: "a1" }));
      logger.record(makeRecord({ agentId: "a2" }));

      // Not yet at threshold
      expect(mockCollection.insertMany).not.toHaveBeenCalled();

      logger.record(makeRecord({ agentId: "a3" }));

      // Flush is async fire-and-forget — wait for microtask
      await vi.advanceTimersByTimeAsync(0);

      expect(mockCollection.insertMany).toHaveBeenCalledTimes(1);
      expect(mockCollection.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ agentId: "a1" }),
          expect.objectContaining({ agentId: "a2" }),
          expect.objectContaining({ agentId: "a3" }),
        ]),
        { ordered: false },
      );

      await logger.stop();
    });
  });

  describe("flush", () => {
    it("does nothing when buffer is empty", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      await logger.flush();

      expect(mockCollection.insertMany).not.toHaveBeenCalled();

      await logger.stop();
    });

    it("sends buffered records via insertMany", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      logger.record(makeRecord({ agentId: "flush-1" }));
      logger.record(makeRecord({ agentId: "flush-2" }));

      await logger.flush();

      expect(mockCollection.insertMany).toHaveBeenCalledTimes(1);
      expect(mockCollection.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ agentId: "flush-1" }),
          expect.objectContaining({ agentId: "flush-2" }),
        ]),
        { ordered: false },
      );

      await logger.stop();
    });

    it("clears the buffer after successful flush", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      logger.record(makeRecord());
      await logger.flush();

      // Second flush should be a no-op (buffer empty)
      await logger.flush();

      expect(mockCollection.insertMany).toHaveBeenCalledTimes(1);

      await logger.stop();
    });

    it("retries once on first failure then succeeds", async () => {
      mockCollection.insertMany
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce({ insertedCount: 1 });

      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      logger.record(makeRecord());
      await logger.flush();

      // Called twice: first attempt failed, retry succeeded
      expect(mockCollection.insertMany).toHaveBeenCalledTimes(2);

      await logger.stop();
    });

    it("drops batch after retry also fails", async () => {
      mockCollection.insertMany
        .mockRejectedValueOnce(new Error("DB down"))
        .mockRejectedValueOnce(new Error("still down"));

      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      logger.record(makeRecord());

      // Should not throw — drops gracefully
      await expect(logger.flush()).resolves.toBeUndefined();

      expect(mockCollection.insertMany).toHaveBeenCalledTimes(2);

      // Buffer should be empty (batch was spliced out and dropped)
      await logger.flush();
      expect(mockCollection.insertMany).toHaveBeenCalledTimes(2);

      await logger.stop();
    });
  });

  describe("periodic flush", () => {
    it("flushes on timer interval", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ flushIntervalMs: 5000 }));
      await logger.connect();

      logger.record(makeRecord());

      // Advance past flush interval
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockCollection.insertMany).toHaveBeenCalledTimes(1);

      await logger.stop();
    });

    it("flushes multiple times over multiple intervals", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ flushIntervalMs: 1000 }));
      await logger.connect();

      logger.record(makeRecord({ agentId: "batch-1" }));
      await vi.advanceTimersByTimeAsync(1000);

      logger.record(makeRecord({ agentId: "batch-2" }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCollection.insertMany).toHaveBeenCalledTimes(2);

      await logger.stop();
    });

    it("periodic flush with empty buffer is a no-op", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ flushIntervalMs: 1000 }));
      await logger.connect();

      // Don't record anything
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCollection.insertMany).not.toHaveBeenCalled();

      await logger.stop();
    });
  });

  describe("stop", () => {
    it("clears flush timer and drains buffer", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      logger.record(makeRecord());
      logger.record(makeRecord());

      await logger.stop();

      // Buffer should have been flushed on stop
      expect(mockCollection.insertMany).toHaveBeenCalledTimes(1);
      expect(mockCollection.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ agentId: "test-agent" })]),
        { ordered: false },
      );
    });

    it("does nothing when buffer is empty on stop", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await logger.connect();

      await logger.stop();

      expect(mockCollection.insertMany).not.toHaveBeenCalled();
    });

    it("is safe to call stop without connect", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig());
      await expect(logger.stop()).resolves.toBeUndefined();
    });

    it("drops records after stop (connected = false)", async () => {
      const logger = new ActivityLogger(mockDb as any, makeConfig({ flushIntervalMs: 1000 }));
      await logger.connect();

      await logger.stop();

      // Record after stop — dropped silently because connected is now false
      logger.record(makeRecord());
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockCollection.insertMany).not.toHaveBeenCalled();
    });
  });
});
