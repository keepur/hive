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
    iter.interrupt = vi.fn(iter.interrupt);
    return iter;
  }),
}));

import { SessionManager } from "./session-manager.js";
import { ToolGuardian } from "./tool-guardian.js";
import { QuestionRelayer } from "./question-relayer.js";
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
    dataDir: "/tmp/beekeeper-test-data",
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
  let questionRelayer: QuestionRelayer;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig();
    guardian = new ToolGuardian([]);
    questionRelayer = new QuestionRelayer();
  });

  describe("newSession(cwd)", () => {
    it("eagerly spawns a session and sends session_info with cwd, returns sessionId", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const busyStatus = sent.find((m: Record<string, unknown>) => m.type === "status" && m.state === "busy");
      expect(busyStatus).toEqual({
        type: "status",
        state: "busy",
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
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

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
      const manager = new SessionManager(config, guardian, questionRelayer);

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
      manager.addClient("test-device", ws as never);

      expect(ws.send.mock.calls.length).toBeGreaterThan(0);
      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo?.sessionId).toBe("sess-buf");
      expect(sessionInfo?.path).toBe("/tmp/test");
    });
  });

  describe("slash commands", () => {
    // Helper: create a session and return its ID + cleared ws mock
    async function setupSession(manager: SessionManager, ws: ReturnType<typeof makeMockWs>) {
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-cmd" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );
      const sessionId = await manager.newSession("/tmp/test");
      ws.send.mockClear();
      return sessionId;
    }

    it("/help sends command list as message", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      await manager.sendMessage(sessionId, "/help");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const helpMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
      );
      expect(helpMsg).toBeDefined();
      expect(helpMsg.text).toContain("/clear");
      expect(helpMsg.text).toContain("/help");
      expect(helpMsg.text).toContain("/status");
      expect(helpMsg.final).toBe(true);
    });

    it("/status sends session metadata as message", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      await manager.sendMessage(sessionId, "/status");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const statusMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Session:"),
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.text).toContain("sess-cmd");
      expect(statusMsg.text).toContain("/tmp/test");
      expect(statusMsg.text).toContain("idle");
      expect(statusMsg.final).toBe(true);
    });

    it("/clear sends context_cleared, destroys session, creates new one", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Mock for the new session created by /clear
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-fresh" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-fresh",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // context_cleared should be the FIRST message sent
      expect(sent[0]).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });

      // New session_info should appear
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.sessionId).toBe("sess-fresh");

      // Old session should be gone
      ws.send.mockClear();
      await manager.sendMessage(sessionId, "after clear");
      const errorSent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = errorSent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg?.message).toContain("Unknown session");
    });

    it("unknown /command falls through to SDK as normal text", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Mock for the SDK query that receives the unknown command as text
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "I don't know that command" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/unknown foo bar");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      // Should NOT see context_cleared or any command response
      expect(sent.find((m: Record<string, unknown>) => m.type === "context_cleared")).toBeUndefined();
      // Should see the SDK response streamed through
      const textMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && m.text === "I don't know that command",
      );
      expect(textMsg).toBeDefined();
    });

    it("/help works even when session is busy", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Make the session busy
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      const queryPromise = manager.sendMessage(sessionId, "Make me busy");
      await new Promise((r) => setTimeout(r, 10));

      ws.send.mockClear();

      // /help should work despite busy state
      await manager.sendMessage(sessionId, "/help");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const helpMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
      );
      expect(helpMsg).toBeDefined();

      // Clean up
      resolveQuery?.();
      await queryPromise;
    });

    it("/clear is case-insensitive", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-fresh2" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-fresh2",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/CLEAR");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      expect(sent[0]).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });
    });

    it("/clear works when session is busy — interrupts active query", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Make the session busy with a hanging query
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(() => {
          resolveQuery?.();
        }),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      const queryPromise = manager.sendMessage(sessionId, "Make me busy");
      await new Promise((r) => setTimeout(r, 10));

      ws.send.mockClear();

      // Mock for the new session created by /clear
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-cleared" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cleared",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      // /clear should work despite busy state
      await manager.sendMessage(sessionId, "/clear");

      // Wait for the hanging query to finish
      await queryPromise;

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // interrupt() should have been called
      expect(hangingIterable.interrupt).toHaveBeenCalled();

      // context_cleared should appear
      const cleared = sent.find((m: Record<string, unknown>) => m.type === "context_cleared");
      expect(cleared).toEqual({ type: "context_cleared", oldSessionId: sessionId, sessionId });

      // New session should exist
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.sessionId).toBe("sess-cleared");
    });

    it("/status works when session is busy — reports busy state", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Make the session busy
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      const queryPromise = manager.sendMessage(sessionId, "Make me busy");
      await new Promise((r) => setTimeout(r, 10));

      ws.send.mockClear();

      // /status should work despite busy state and report busy
      await manager.sendMessage(sessionId, "/status");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const statusMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("State:"),
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.text).toContain("busy");
      expect(statusMsg.final).toBe(true);

      // Clean up
      resolveQuery?.();
      await queryPromise;
    });

    it("\"/\" alone (empty command name) falls through to SDK as normal text", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Just a slash" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      // Should NOT see any command response (no context_cleared, no help text)
      expect(sent.find((m: Record<string, unknown>) => m.type === "context_cleared")).toBeUndefined();
      // Should see the SDK response — fell through to normal query
      const textMsg = sent.find((m: Record<string, unknown>) => m.type === "message" && m.text === "Just a slash");
      expect(textMsg).toBeDefined();
    });

    it("\"/ clear\" (space after slash) falls through to SDK — not parsed as /clear", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Not a command" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "/ clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      // Should NOT trigger /clear
      expect(sent.find((m: Record<string, unknown>) => m.type === "context_cleared")).toBeUndefined();
      // Should see SDK response
      const textMsg = sent.find((m: Record<string, unknown>) => m.type === "message" && m.text === "Not a command");
      expect(textMsg).toBeDefined();
    });

    it("/help with trailing whitespace still works", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      await manager.sendMessage(sessionId, "/help   ");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const helpMsg = sent.find(
        (m: Record<string, unknown>) => m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
      );
      expect(helpMsg).toBeDefined();
      expect(helpMsg.final).toBe(true);
    });

    it("/clear when interrupt() throws — logs error but still creates new session", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Make the session busy with a hanging query whose interrupt() throws
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            resolveQuery = resolve;
          });
          yield {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 50,
          };
        },
        interrupt: vi.fn(() => {
          resolveQuery?.();
          throw new Error("interrupt failed");
        }),
      };
      mockQueryIterator.mockReturnValueOnce(hangingIterable);

      const queryPromise = manager.sendMessage(sessionId, "Make me busy");
      await new Promise((r) => setTimeout(r, 10));

      ws.send.mockClear();

      // Mock for the new session created by /clear
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-after-err" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-after-err",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      // /clear should succeed despite interrupt() throwing
      await manager.sendMessage(sessionId, "/clear");
      await queryPromise;

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // context_cleared should still be sent
      const cleared = sent.find((m: Record<string, unknown>) => m.type === "context_cleared");
      expect(cleared).toBeDefined();

      // New session should be created despite the error
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.sessionId).toBe("sess-after-err");
    });

    it("/clear when newSession() SDK fails — sends error, does not throw", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Mock newSession's query to throw — runQuery catches internally
      mockQueryIterator.mockReturnValueOnce({
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK connection failed");
        },
        interrupt: vi.fn(),
      });

      // Should not throw — handleClear wraps newSession in try/catch
      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // context_cleared should still be sent
      const cleared = sent.find((m: Record<string, unknown>) => m.type === "context_cleared");
      expect(cleared).toBeDefined();

      // Error from runQuery should reach the client
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("SDK connection failed");

      // Old session should be gone
      ws.send.mockClear();
      await manager.sendMessage(sessionId, "after clear");
      const errorSent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      expect(errorSent.find((m: Record<string, unknown>) => m.type === "error")).toBeDefined();
    });

    it("concurrent /clear calls — second call is a no-op", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Mock for the new session created by first /clear
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-only-one" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-only-one",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      // Fire two /clear calls concurrently
      const [result1, result2] = await Promise.all([
        manager.sendMessage(sessionId, "/clear"),
        manager.sendMessage(sessionId, "/clear"),
      ]);

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // Only ONE context_cleared should be sent
      const clearedMessages = sent.filter((m: Record<string, unknown>) => m.type === "context_cleared");
      expect(clearedMessages).toHaveLength(1);

      // Only ONE new session should be created
      const sessionInfoMessages = sent.filter((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfoMessages).toHaveLength(1);
      expect(sessionInfoMessages[0].sessionId).toBe("sess-only-one");
    });

    it("text not starting with / goes to SDK normally", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi!" } },
          },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-cmd",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      await manager.sendMessage(sessionId, "Hello there");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const textMsg = sent.find((m: Record<string, unknown>) => m.type === "message" && m.text === "Hi!");
      expect(textMsg).toBeDefined();
    });
  });
});
