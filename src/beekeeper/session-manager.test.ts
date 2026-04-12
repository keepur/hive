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

// newSession() now returns as soon as `system/init` fires; the welcome
// stream continues in the background. Tests that interact with the session
// right after creation must wait for the welcome stream to drain so the
// session is idle before further assertions.
async function drainWelcome(manager: SessionManager, sessionId: string): Promise<void> {
  const slot = (manager as unknown as { sessions: Map<string, { queryDone?: Promise<unknown> }> }).sessions.get(
    sessionId,
  );
  if (slot?.queryDone) {
    try {
      await slot.queryDone;
    } catch {
      // handled inside runQuery
    }
  }
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

    it("non-clear path still emits status(thinking) and session_info on init", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-plain" },
          {
            type: "result",
            subtype: "success",
            result: "Ready",
            session_id: "sess-plain",
            total_cost_usd: 0.001,
            duration_ms: 10,
          },
        ]),
      );

      // Call newSession WITHOUT suppressClientSignals (the non-clear path).
      await manager.newSession("/tmp/test");
      await drainWelcome(manager, "sess-plain");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // status(thinking) is emitted
      expect(sent.find((m: Record<string, unknown>) => m.type === "status" && m.state === "thinking")).toBeDefined();

      // session_info for the new sessionId is emitted
      const sessionInfo = sent.find(
        (m: Record<string, unknown>) => m.type === "session_info" && m.sessionId === "sess-plain",
      );
      expect(sessionInfo).toBeDefined();
      expect(sessionInfo.path).toBe("/tmp/test");
    });

    it("swaps the pending session key for the real SDK session id", async () => {
      // Guards against regressions in the pending-* → real ID map-key swap
      // inside newSession. If the swap is skipped or uses the wrong key, stale
      // pending-* entries would leak to clients via listSessions/getActiveSessions.
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-real" },
          {
            type: "result",
            subtype: "success",
            result: "Ready",
            session_id: "sess-real",
            total_cost_usd: 0.001,
            duration_ms: 10,
          },
        ]),
      );

      await manager.newSession("/tmp/test");
      await drainWelcome(manager, "sess-real");

      const active = manager.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0].sessionId).toBe("sess-real");
      expect(active.find((s) => s.sessionId.startsWith("pending-"))).toBeUndefined();
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
      await drainWelcome(manager, sessionId);
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
      await drainWelcome(manager, "sess-busy");

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
      await drainWelcome(manager, sessionId);
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
      const idA = await manager.newSession("/home/user/hive");
      await drainWelcome(manager, idA);

      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-b" },
          { type: "result", subtype: "success", result: "", session_id: "sess-b", total_cost_usd: 0, duration_ms: 10 },
        ]),
      );
      const idB = await manager.newSession("/home/user/other");
      await drainWelcome(manager, idB);

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
      await drainWelcome(manager, sessionId);
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
      await drainWelcome(manager, sessionId);
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
        (m: Record<string, unknown>) =>
          m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
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
        (m: Record<string, unknown>) =>
          m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Session:"),
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.text).toContain("sess-cmd");
      expect(statusMsg.text).toContain("/tmp/test");
      expect(statusMsg.text).toContain("idle");
      expect(statusMsg.final).toBe(true);
    });

    it("/clear sends session_replaced, destroys session, creates new one", async () => {
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

      const replaced = sent.find((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replaced).toBeDefined();
      expect(replaced.oldSessionId).toBe(sessionId);
      expect(replaced.newSessionId).toBe("sess-fresh");
      expect(replaced.path).toBeDefined();

      expect(sent.find((m: Record<string, unknown>) => m.type === "context_cleared")).toBeUndefined();

      // Old session should be gone
      ws.send.mockClear();
      await manager.sendMessage(sessionId, "after clear");
      const errorSent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = errorSent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg?.message).toContain("Unknown session");
    });

    it("/clear: session_replaced fires before any new-session signals reach the client", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Fresh session mock: init event, then a text delta from the welcome stream, then result.
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-new" },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Ready." },
            },
            session_id: "sess-new",
          },
          {
            type: "result",
            subtype: "success",
            result: "Ready.",
            session_id: "sess-new",
            total_cost_usd: 0.001,
            duration_ms: 10,
          },
        ]),
      );

      ws.send.mockClear();
      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // (a) session_replaced must appear on the wire
      const replacedIdx = sent.findIndex((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replacedIdx).toBeGreaterThanOrEqual(0);

      // (b) No session_info or status(thinking) for the new sessionId is ever emitted (suppressed)
      const newSessionInfo = sent.find(
        (m: Record<string, unknown>) => m.type === "session_info" && m.sessionId === "sess-new",
      );
      expect(newSessionInfo).toBeUndefined();

      const newThinking = sent.find(
        (m: Record<string, unknown>) => m.type === "status" && m.state === "thinking" && m.sessionId === "sess-new",
      );
      expect(newThinking).toBeUndefined();

      // (c) Every welcome-stream message for the new sessionId arrives AFTER session_replaced.
      //     Ordering is deterministic because onInit resolves the init deferred synchronously
      //     from inside runQuery's for-await loop, which queues newSession's continuation
      //     (and therefore handleClear's session_replaced emit) as a microtask BEFORE the
      //     for-await loop's next iteration is scheduled.
      const newSessionMessageIndices = sent
        .map((m: Record<string, unknown>, idx: number) => ({ m, idx }))
        .filter(({ m }: { m: Record<string, unknown> }) => m.type === "message" && m.sessionId === "sess-new")
        .map(({ idx }: { idx: number }) => idx);
      expect(newSessionMessageIndices.length).toBeGreaterThan(0);
      for (const idx of newSessionMessageIndices) {
        expect(idx).toBeGreaterThan(replacedIdx);
      }
    });

    it("/clear: when SDK completes without emitting init, sends error and does not hang", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);
      const sessionId = await setupSession(manager, ws);

      // Pathological mock: SDK yields a result without ever emitting system/init.
      mockQueryIterator.mockReturnValueOnce(
        makeAsyncIterable([
          {
            type: "result",
            subtype: "error",
            result: "",
            session_id: "never-initialized",
            total_cost_usd: 0,
            duration_ms: 5,
          },
        ]),
      );

      ws.send.mockClear();
      await manager.sendMessage(sessionId, "/clear");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));

      // An error message matching the handleClear failure path must be emitted.
      // Note: runQuery also emits a leaked "Session ended: error" for the
      // pathological SDK result (known + acceptable leak documented in the spec);
      // we specifically assert against the authoritative handleClear error here.
      const errorMsg = sent.find(
        (m: Record<string, unknown>) =>
          m.type === "error" &&
          typeof m.message === "string" &&
          /failed to start new session/i.test(m.message as string),
      );
      expect(errorMsg).toBeDefined();

      // No session_replaced was emitted
      expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();
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
      // Should NOT see session_replaced or any command response
      expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();
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
        (m: Record<string, unknown>) =>
          m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
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
      const replaced = sent.find((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replaced).toBeDefined();
      expect(replaced.oldSessionId).toBe(sessionId);
      expect(typeof replaced.newSessionId).toBe("string");
      expect(replaced.path).toBeDefined();
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

      const replaced = sent.find((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replaced).toBeDefined();
      expect(replaced.oldSessionId).toBe(sessionId);
      expect(typeof replaced.newSessionId).toBe("string");
      expect(replaced.path).toBeDefined();
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
        (m: Record<string, unknown>) =>
          m.type === "message" && typeof m.text === "string" && (m.text as string).includes("State:"),
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.text).toContain("busy");
      expect(statusMsg.final).toBe(true);

      // Clean up
      resolveQuery?.();
      await queryPromise;
    });

    it('"/" alone (empty command name) falls through to SDK as normal text', async () => {
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
      // Should NOT see any command response (no session_replaced, no help text)
      expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();
      // Should see the SDK response — fell through to normal query
      const textMsg = sent.find((m: Record<string, unknown>) => m.type === "message" && m.text === "Just a slash");
      expect(textMsg).toBeDefined();
    });

    it('"/ clear" (space after slash) falls through to SDK — not parsed as /clear', async () => {
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
      expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();
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
        (m: Record<string, unknown>) =>
          m.type === "message" && typeof m.text === "string" && (m.text as string).includes("Available commands"),
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

      const replaced = sent.find((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replaced).toBeDefined();
      expect(replaced.oldSessionId).toBe(sessionId);
      expect(typeof replaced.newSessionId).toBe("string");
      expect(replaced.path).toBeDefined();
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

      expect(sent.find((m: Record<string, unknown>) => m.type === "error")).toBeDefined();
      expect(sent.find((m: Record<string, unknown>) => m.type === "session_replaced")).toBeUndefined();

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

      const replacedMessages = sent.filter((m: Record<string, unknown>) => m.type === "session_replaced");
      expect(replacedMessages).toHaveLength(1);
      expect(replacedMessages[0].newSessionId).toBe("sess-only-one");
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

  // ── Session Reaping Tests ──────────────────────────────────────────

  describe("reapStaleSessions()", () => {
    it("interrupts queries running longer than maxQueryLifetimeMs", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      // Create a query that hangs (never yields result)
      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sess-stale" };
          // Hang until resolved
          await new Promise<void>((r) => {
            resolveQuery = r;
          });
        },
        interrupt: vi.fn(() => {
          resolveQuery?.();
        }),
      };

      mockQueryIterator.mockReturnValue(hangingIterable);
      const sessionId = await manager.newSession("/tmp/test");

      // The welcome query is now busy and hanging
      const sessions = (
        manager as unknown as { sessions: Map<string, { state: string; queryStartedAt: number | null }> }
      ).sessions;
      const slot = sessions.get(sessionId);
      expect(slot?.state).toBe("busy");

      // Backdate queryStartedAt to simulate an old query
      if (slot) {
        slot.queryStartedAt = Date.now() - 10 * 60 * 60 * 1000; // 10 hours ago
      }

      const result = await manager.reapStaleSessions({
        maxQueryLifetimeMs: 8 * 60 * 60 * 1000, // 8h
        idleSessionTtlMs: 72 * 60 * 60 * 1000,
      });

      expect(result.interruptedQueries).toBe(1);
      expect(hangingIterable.interrupt).toHaveBeenCalled();

      // Wait for runQuery to finish
      if (slot && (slot as Record<string, unknown>).queryDone) {
        try {
          await (slot as Record<string, unknown>).queryDone;
        } catch {
          // expected
        }
      }
    });

    it("does not interrupt queries within maxQueryLifetimeMs", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      let resolveQuery: (() => void) | undefined;
      const hangingIterable = {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sess-fresh" };
          await new Promise<void>((r) => {
            resolveQuery = r;
          });
        },
        interrupt: vi.fn(() => {
          resolveQuery?.();
        }),
      };

      mockQueryIterator.mockReturnValue(hangingIterable);
      const sessionId = await manager.newSession("/tmp/test");

      // queryStartedAt is recent (just created) — should not be reaped
      const result = await manager.reapStaleSessions({
        maxQueryLifetimeMs: 8 * 60 * 60 * 1000,
        idleSessionTtlMs: 72 * 60 * 60 * 1000,
      });

      expect(result.interruptedQueries).toBe(0);
      expect(hangingIterable.interrupt).not.toHaveBeenCalled();

      // Cleanup
      resolveQuery?.();
      const sessions = (manager as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;
      const slot = sessions.get(sessionId);
      if (slot?.queryDone) {
        try {
          await slot.queryDone;
        } catch {
          // expected
        }
      }
    });

    it("prunes idle sessions older than idleSessionTtlMs", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-idle" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-idle",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      const sessionId = await manager.newSession("/tmp/test");
      await drainWelcome(manager, sessionId);

      // Backdate lastActivityAt
      const sessions = (manager as unknown as { sessions: Map<string, { lastActivityAt: number }> }).sessions;
      const slot = sessions.get(sessionId);
      if (slot) {
        slot.lastActivityAt = Date.now() - 100 * 60 * 60 * 1000; // 100 hours ago
      }

      const result = await manager.reapStaleSessions({
        maxQueryLifetimeMs: 8 * 60 * 60 * 1000,
        idleSessionTtlMs: 72 * 60 * 60 * 1000, // 72h
      });

      expect(result.prunedIdleSessions).toBe(1);
      expect(sessions.has(sessionId)).toBe(false);
    });

    it("does not prune idle sessions within idleSessionTtlMs", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-recent" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-recent",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      const sessionId = await manager.newSession("/tmp/test");
      await drainWelcome(manager, sessionId);

      // lastActivityAt is recent — should not be pruned
      const result = await manager.reapStaleSessions({
        maxQueryLifetimeMs: 8 * 60 * 60 * 1000,
        idleSessionTtlMs: 72 * 60 * 60 * 1000,
      });

      expect(result.prunedIdleSessions).toBe(0);
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
      expect(sessions.has(sessionId)).toBe(true);
    });

    it("returns zeros when nothing is stale", async () => {
      const manager = new SessionManager(config, guardian, questionRelayer);

      const result = await manager.reapStaleSessions({
        maxQueryLifetimeMs: 8 * 60 * 60 * 1000,
        idleSessionTtlMs: 72 * 60 * 60 * 1000,
      });

      expect(result.interruptedQueries).toBe(0);
      expect(result.prunedIdleSessions).toBe(0);
    });
  });

  describe("session slot tracking fields", () => {
    it("sets queryStartedAt when runQuery begins and clears on completion", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian, questionRelayer);
      manager.addClient("test-device", ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-track" },
          {
            type: "result",
            subtype: "success",
            result: "",
            session_id: "sess-track",
            total_cost_usd: 0,
            duration_ms: 10,
          },
        ]),
      );

      const sessionId = await manager.newSession("/tmp/test");
      await drainWelcome(manager, sessionId);

      const sessions = (
        manager as unknown as {
          sessions: Map<string, { queryStartedAt: number | null; lastActivityAt: number }>;
        }
      ).sessions;
      const slot = sessions.get(sessionId);

      // After query completes, queryStartedAt should be null
      expect(slot?.queryStartedAt).toBeNull();
      // lastActivityAt should be recent
      expect(slot?.lastActivityAt).toBeGreaterThan(Date.now() - 5000);
    });
  });
});
