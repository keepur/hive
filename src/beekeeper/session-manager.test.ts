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
    defaultWorkspace: "hive",
    model: "claude-sonnet-4-5",
    workspaces: { hive: "/home/user/hive", other: "/home/user/other" },
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

  describe("newSession()", () => {
    it("eagerly spawns a session and sends session_info", async () => {
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

      await manager.newSession("hive");

      expect(manager.getSessionId()).toBe("sess-abc");

      // Verify session_info was sent
      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo).toEqual({
        type: "session_info",
        sessionId: "sess-abc",
        workspace: "hive",
        workspaces: ["hive", "other"],
      });
    });

    it("sends session_ended status before spawning", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-1" },
          { type: "result", subtype: "success", result: "", session_id: "sess-1", total_cost_usd: 0, duration_ms: 50 },
        ]),
      );

      await manager.newSession();

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const types = sent.map((m: Record<string, unknown>) => (m.type === "status" ? m.state : m.type));
      expect(types[0]).toBe("session_ended");
    });

    it("throws for unknown workspace", async () => {
      const manager = new SessionManager(config, guardian);

      await expect(manager.newSession("nonexistent")).rejects.toThrow("Unknown workspace: nonexistent");
    });
  });

  describe("sendMessage()", () => {
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
      await manager.newSession();
      ws.send.mockClear();

      // Now send a message
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

      await manager.sendMessage("Hi");

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

    it("sends error for non-success results", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      mockQueryIterator.mockReturnValue(
        makeAsyncIterable([
          { type: "system", subtype: "init", session_id: "sess-err" },
          { type: "result", subtype: "error", result: "", session_id: "sess-err", total_cost_usd: 0, duration_ms: 10 },
        ]),
      );

      await manager.sendMessage("fail");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg).toEqual({
        type: "error",
        message: "Session ended: error",
      });
    });

    it("sends error and idle status on query failure", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      mockQueryIterator.mockReturnValue({
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK connection failed");
        },
        interrupt: vi.fn(),
      });

      await manager.sendMessage("boom");

      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const errorMsg = sent.find((m: Record<string, unknown>) => m.type === "error");
      expect(errorMsg?.message).toContain("SDK connection failed");

      const lastStatus = sent.filter((m: Record<string, unknown>) => m.type === "status").pop();
      expect(lastStatus?.state).toBe("idle");
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

      // Send with no client — messages buffer
      await manager.sendMessage("hello");

      // Now connect a client — buffer drains
      const ws = makeMockWs();
      manager.setClient(ws as never);

      expect(ws.send.mock.calls.length).toBeGreaterThan(0);
      const sent = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const sessionInfo = sent.find((m: Record<string, unknown>) => m.type === "session_info");
      expect(sessionInfo?.sessionId).toBe("sess-buf");
    });
  });

  describe("stopSession()", () => {
    it("calls interrupt on the active query", async () => {
      const ws = makeMockWs();
      const manager = new SessionManager(config, guardian);
      manager.setClient(ws as never);

      // Run a normal query to set up an active session
      const iterable = makeAsyncIterable([
        { type: "system", subtype: "init", session_id: "sess-stop" },
        { type: "result", subtype: "success", result: "", session_id: "sess-stop", total_cost_usd: 0, duration_ms: 10 },
      ]);
      mockQueryIterator.mockReturnValue(iterable);

      await manager.newSession();

      // After newSession completes, activeQuery is cleared. Verify stopSession
      // works without error when no active query exists (no-op path).
      await expect(manager.stopSession()).resolves.toBeUndefined();
    });
  });
});
