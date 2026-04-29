import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ lastSeenRowId: 42 })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

const mockGetNewMessages = vi.fn().mockReturnValue([]);
const mockGetMaxRowId = vi.fn().mockReturnValue(100);
const mockDbClose = vi.fn();

vi.mock("./imessage-db.js", () => ({
  IMessageDb: vi.fn(() => ({
    getNewMessages: mockGetNewMessages,
    getMaxRowId: mockGetMaxRowId,
    close: mockDbClose,
  })),
}));

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockMongoClose = vi.fn().mockResolvedValue(undefined);
const mockFindOne = vi.fn().mockResolvedValue(null);
const mockInsertOne = vi.fn().mockResolvedValue(undefined);
const mockCollection = vi.fn(() => ({
  findOne: mockFindOne,
  insertOne: mockInsertOne,
}));
const mockMongoDb = vi.fn(() => ({
  collection: mockCollection,
}));

vi.mock("mongodb", () => ({
  MongoClient: vi.fn(() => ({
    connect: mockConnect,
    db: mockMongoDb,
    close: mockMongoClose,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    slackChannel: "imessage-mirror",
    hotWindowMs: 60_000,
    coldIntervalMs: 30_000,
    hotIntervalMs: 2_000,
    ...overrides,
  };
}

function makeGateway() {
  return {
    client: {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [{ name: "imessage-mirror", id: "C_MIRROR" }],
        }),
      },
    },
    postMessage: vi.fn().mockResolvedValue("1234567890.123456"),
  };
}

function makeWorkResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "Hello from agent",
    agentId: "mokie",
    workItem: {
      id: "imsg-101",
      text: "Hi",
      source: { kind: "imessage" as const, id: "imessage", label: "imessage" },
      sender: "+15551234567",
      threadId: "imessage:+15551234567",
      timestamp: new Date(),
    },
    ...overrides,
  };
}

async function createAdapter(configOverrides: Record<string, unknown> = {}) {
  const { IMessageAdapter } = await import("./imessage-adapter.js");
  const config = makeConfig(configOverrides);
  const gateway = makeGateway();
  const mockDb = { collection: mockCollection } as any;
  const adapter = new IMessageAdapter(config as any, mockDb, gateway as any, "test-instance");
  return { adapter, gateway };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IMessageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  // -------------------------------------------------------------------------
  // Adaptive polling
  // -------------------------------------------------------------------------

  describe("adaptive polling", () => {
    it("skips poll in cold mode when cold interval has not elapsed", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      // After start, one immediate poll fires. Clear to isolate subsequent ticks.
      mockGetNewMessages.mockClear();

      // Advance less than coldIntervalMs (30s) — should skip
      vi.advanceTimersByTime(10_000);
      expect(mockGetNewMessages).not.toHaveBeenCalled();

      await adapter.stop();
    });

    it("polls when cold interval has fully elapsed", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      mockGetNewMessages.mockClear();

      // Advance past coldIntervalMs (30s) — should trigger poll
      vi.advanceTimersByTime(32_000);
      expect(mockGetNewMessages).toHaveBeenCalled();

      await adapter.stop();
    });

    it("polls on every tick during hot window", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();

      // Simulate a message arriving to enter hot mode
      mockGetNewMessages.mockReturnValueOnce([
        {
          rowId: 200,
          text: "Hey!",
          sender: "+15559999999",
          handleRowId: 10,
          service: "iMessage",
          date: new Date(),
        },
      ]);

      await adapter.start(onWorkItem);

      // Initial poll consumed the message, now in hot mode
      mockGetNewMessages.mockClear();
      mockGetNewMessages.mockReturnValue([]);

      // Advance by one hot interval tick (2s) — should poll because we're hot
      vi.advanceTimersByTime(2_000);
      expect(mockGetNewMessages).toHaveBeenCalledTimes(1);

      // Another tick
      vi.advanceTimersByTime(2_000);
      expect(mockGetNewMessages).toHaveBeenCalledTimes(2);

      await adapter.stop();
    });
  });

  // -------------------------------------------------------------------------
  // deliver
  // -------------------------------------------------------------------------

  describe("deliver", () => {
    it("calls osascript via execFileSync", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const result = makeWorkResult();
      await adapter.deliver(result as any);

      expect(mockExecFileSync).toHaveBeenCalledWith("osascript", expect.arrayContaining(["-e"]));

      await adapter.stop();
    });

    it("retries once on first send failure", async () => {
      vi.useRealTimers(); // need real timers for the 500ms delay

      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error("AppleScript failed");
      });

      const result = makeWorkResult();
      await adapter.deliver(result as any);

      // Called twice: first attempt + retry
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);

      await adapter.stop();
    });

    it("skips delivery when result has error", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const result = makeWorkResult({ error: "Agent failed" });
      await adapter.deliver(result as any);

      expect(mockExecFileSync).not.toHaveBeenCalled();

      await adapter.stop();
    });
  });

  // -------------------------------------------------------------------------
  // sendViaAppleScript escaping
  // -------------------------------------------------------------------------

  describe("sendViaAppleScript escaping", () => {
    it("escapes double quotes in message text", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const result = makeWorkResult({ text: 'He said "hello" to me' });
      await adapter.deliver(result as any);

      // The escaped text should contain \" instead of "
      const scriptArgs = mockExecFileSync.mock.calls[0][1] as string[];
      const sendLine = scriptArgs.find((a: string) => a.includes("send "));
      expect(sendLine).toContain('\\"hello\\"');

      await adapter.stop();
    });

    it("escapes backslashes in message text", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const result = makeWorkResult({ text: "path\\to\\file" });
      await adapter.deliver(result as any);

      const scriptArgs = mockExecFileSync.mock.calls[0][1] as string[];
      const sendLine = scriptArgs.find((a: string) => a.includes("send "));
      expect(sendLine).toContain("path\\\\to\\\\file");

      await adapter.stop();
    });
  });

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  describe("stop", () => {
    it("clears interval and closes the chat.db handle (shared mongo is owned by the host process)", async () => {
      const { adapter } = await createAdapter();
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      await adapter.stop();

      expect(mockDbClose).toHaveBeenCalled();

      // Advancing timers should not trigger any more polls
      mockGetNewMessages.mockClear();
      vi.advanceTimersByTime(60_000);
      expect(mockGetNewMessages).not.toHaveBeenCalled();
    });
  });
});
