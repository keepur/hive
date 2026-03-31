import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the SDK query function
const mockQueryIterator = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const iter = mockQueryIterator();
    iter.interrupt = vi.fn();
    return iter;
  }),
}));

import { SessionManager } from "./session-manager.js";
import { ToolGuardian } from "./tool-guardian.js";
import type { BeekeeperConfig } from "./types.js";

function makeConfig(overrides: Partial<BeekeeperConfig> = {}): BeekeeperConfig {
  return {
    port: 3099,
    model: "claude-sonnet-4-5",
    confirmOperations: [],
    jwtSecret: "test-jwt-secret",
    adminSecret: "test-admin-secret",
    mongoUri: "mongodb://localhost:27017",
    mongoDbName: "test-db",
    ...overrides,
  };
}

function makeMockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  };
}

// Helper to create an async iterable from an array of SDK messages
function makeAsyncIterable(messages: Record<string, unknown>[]) {
  let interrupted = false;
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        if (interrupted) break;
        yield msg;
      }
    },
    interrupt: vi.fn(() => {
      interrupted = true;
    }),
  };
  return iterable;
}

describe("SessionManager", () => {
  let config: BeekeeperConfig;
  let guardian: ToolGuardian;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig();
    guardian = new ToolGuardian([]);
  });

  describe("newSession(cwd)", () => {
    it("eagerly spawns a session and sends session_info with cwd, returns sessionId", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-abc" },
          {
            type: "result",
            subtype: "success",
            result: "Ready",
            session_id: "sess-abc",
            total_cost_usd: 0.001,
            duration_ms: 100,
          },
        ]),
      );

      const sessionId = await manager.newSession("/home/user/hive");

      expect(sessionId).toBe("sess-abc");

      // Verify session_info was sent with cwd (not workspace/workspaces)
      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toEqual({
        type: "session_info",
        sessionId: "sess-abc",
        path: "/home/user/hive",
      });
    });
  });

  describe("sendMessage(sessionId, text)", () => {
    it("streams text chunks to client", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      // First spawn a session
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-1" },
          { type: "result", subtype: "success", result: "", session_id: "sess-1", total_cost_usd: 0, duration_ms: 50 },
        ]),
      );
      const sessionId = await manager.newSession("/tmp/test");
      ws.send.mockClear();

      // Now send a message using sessionId
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "Hello",
            session_id: "sess-1",
            total_cost_usd: 0.01,
            duration_ms: 200,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "Hi");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const textChunk = sent.find((m: Record<string, unknown>) => m.type === "message" && m.text === "Hello");
      expect(textChunk).toEqual({
        type: "message",
        text: "Hello",
        sessionId: "sess-1",
        final: false,
      });

      // Final sentinel
      const final = sent.find((m: Record<string, unknown>) => m.type === "message" && m.final === true);
      expect(final).toBeDefined();
    });

    it("sends error for unknown sessionId", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      await manager.sendMessage("nonexistent-session", "Hi");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg).toEqual({
        type: "error",
        message: "Unknown session: nonexistent-session",
        sessionId: "nonexistent-session",
      });
    });

    it("sends error when session is busy", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      // Create a session that will stay busy (never resolves)
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sess-busy" };
          // Hang until resolved
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-busy",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      // Start newSession but don't await — it will be "busy" since the query hangs
      const newSessionPromise = manager.newSession("/tmp/test");

      // Wait a tick for the session to register as busy
      await new Promise((r) => setTimeout(r, 10));

      // The session is still in progress (busy), but it hasn't gotten its real ID yet.
      // We need to test sendMessage on a session that's already created but busy.
      // Let's use a different approach: create a session, then send two messages rapidly.

      // Resolve the first query to complete session creation
      resolveQuery?.();
      await newSessionPromise;

      // Now make the next query hang
      let resolveSecond: (() => void) | undefined;
      const hangingIterable2 = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveSecond = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-busy",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable2);

      ws.send.mockClear();

      // Send first message (will hang)
      const firstMsgPromise = manager.sendMessage("sess-busy", "First");

      // Wait a tick for state to be set to busy
      await new Promise((r) => setTimeout(r, 10));

      // Try to send second message while first is busy
      await manager.sendMessage("sess-busy", "Second");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg).toEqual({
        type: "error",
        message: "Session is busy",
        sessionId: "sess-busy",
      });

      // Clean up: resolve the hanging query
      resolveSecond?.();
      await firstMsgPromise;
    });
  });

  describe("clearSession(sessionId)", () => {
    it("removes session and sends session_cleared", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-clear" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-clear",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      const sessionId = await manager.newSession("/tmp/test");
      ws.send.mockClear();

      const result = await manager.clearSession(sessionId);

      expect(result).toBe(true);

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const clearedMsg = sent.find((m: Record<string, unknown>) => m.type === "session_cleared");
      expect(clearedMsg).toEqual({
        type: "session_cleared",
        sessionId: "sess-clear",
      });

      // Session should no longer exist — sending a message should error
      ws.send.mockClear();
      await manager.sendMessage(sessionId, "after clear");
      const errorSent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = errorSent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg?.message).toContain("Unknown session");
    });
  });

  describe("listSessions()", () => {
    it("sends session_list message with active sessions", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-a" },
          { type: "result", subtype: "success", result: "", session_id: "sess-a", total_cost_usd: 0, duration_ms: 10 },
        ]),
      );
      await manager.newSession("/home/user/hive");

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-b" },
          { type: "result", subtype: "success", result: "", session_id: "sess-b", total_cost_usd: 0, duration_ms: 10 },
        ]),
      );
      await manager.newSession("/home/user/other");

      ws.send.mockClear();
      manager.listSessions();

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const listMsg = sent.find((m: Record<string, unknown>) => m.type === "session_list");
      expect(listMsg).toBeDefined();
      expect((listMsg as any).sessions).toHaveLength(2);
      expect((listMsg as any).sessions).toEqual(
        expect.arrayContaining([
          { sessionId: "sess-a", path: "/home/user/hive", state: "idle" },
          { sessionId: "sess-b", path: "/home/user/other", state: "idle" },
        ]),
      );
    });
  });

  describe("error handling", () => {
    it("SDK failure sends error with sessionId", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      // Create a session first
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-err" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-err",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );
      const sessionId = await manager.newSession("/tmp/test");
      ws.send.mockClear();

      // Make next query throw
      mockQueryIterator.mockReturnValue({
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK connection failed");
        },
        interrupt: vi.fn(),
      });

      await manager.sendMessage(sessionId, "boom");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg?.message).toContain("SDK connection failed");
      expect(errorMsg?.sessionId).toBe("sess-err");

      const lastStatus = sent.filter((m: Record<string, unknown>) => m.type === "status").pop();
      expect(lastStatus?.state).toBe("idle");
      expect(lastStatus?.sessionId).toBe("sess-err");
    });
  });

  describe("output buffering", () => {
    it("buffers messages when no client connected, drains on setClient()", async () => {
      const manager = new SessionManager(config, guardian);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-buf" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-buf",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      // Spawn session with no client — messages buffer
      await manager.newSession("/tmp/test");

      // Now connect a client — buffer drains
      const ws = makeMockWs();
      manager.setClient(ws as never);

      expect(ws.send.mock.calls.length).toBeGreaterThan(0);
      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo?.sessionId).toBe("sess-buf");
      expect(sessionInfo?.path).toBe("/tmp/test");
    });
  });
});
