import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── MCP SDK mocks ──────────────────────────────────────────────────────────

let registeredTools: Record<string, (...args: any[]) => any> = {};

const mockConnect = vi.fn();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: (name: string, _schema: any, handler: (...args: any[]) => any) => {
      registeredTools[name] = handler;
    },
    connect: mockConnect,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// ── ConversationIndex mock ─────────────────────────────────────────────────

const mockSearch = vi.fn();
vi.mock("./conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(() => ({
    search: mockSearch,
  })),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeResult(overrides: Record<string, any> = {}) {
  return {
    agentId: "test-agent",
    threadId: "thread-1",
    channelId: "general",
    source: "slack",
    senderName: "User",
    timestampUnix: 1700000000,
    timestamp: "2026-03-20T00:00:00Z",
    inbound: "hello there",
    response: "hi back",
    score: 0.95,
    ...overrides,
  };
}

/**
 * Load the module fresh by resetting the module registry.
 * Set env vars BEFORE import so the module's top-level code picks them up.
 */
async function loadWithEnv(agentId: string, defaultAgent?: string) {
  registeredTools = {};

  process.env.AGENT_ID = agentId;
  if (defaultAgent !== undefined) {
    process.env.DEFAULT_AGENT = defaultAgent;
  } else {
    delete process.env.DEFAULT_AGENT;
  }

  // resetModules clears Vite's module cache so the next import re-executes top-level
  vi.resetModules();

  // Re-apply mocks after resetModules (they are hoisted but registry is cleared)
  vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
    McpServer: vi.fn().mockImplementation(() => ({
      registerTool: (name: string, _schema: any, handler: (...args: any[]) => any) => {
        registeredTools[name] = handler;
      },
      connect: mockConnect,
    })),
  }));
  vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
    StdioServerTransport: vi.fn(),
  }));
  vi.doMock("./conversation-index.js", () => ({
    ConversationIndex: vi.fn().mockImplementation(() => ({
      search: mockSearch,
    })),
  }));

  await import("./conversation-search-mcp-server.js");
}

// ── Cleanup ────────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.AGENT_ID = process.env.AGENT_ID;
  savedEnv.DEFAULT_AGENT = process.env.DEFAULT_AGENT;
  mockSearch.mockReset();
  mockConnect.mockReset();
});

afterEach(() => {
  if (savedEnv.AGENT_ID !== undefined) process.env.AGENT_ID = savedEnv.AGENT_ID;
  else delete process.env.AGENT_ID;
  if (savedEnv.DEFAULT_AGENT !== undefined) process.env.DEFAULT_AGENT = savedEnv.DEFAULT_AGENT;
  else delete process.env.DEFAULT_AGENT;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("conversation-search-mcp-server", () => {
  describe("DEFAULT_AGENT defaults to chief-of-staff", () => {
    it("denies non-chief-of-staff agent from searching others when env var unset", async () => {
      await loadWithEnv("some-agent");

      const handler = registeredTools["conversation_search"];
      expect(handler).toBeDefined();

      const result = await handler({ query: "test", agentId: "other-agent", limit: 10 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("chief-of-staff");
    });
  });

  describe("custom DEFAULT_AGENT", () => {
    it("allows the custom default agent to search other agents", async () => {
      await loadWithEnv("custom-boss", "custom-boss");
      mockSearch.mockResolvedValue([makeResult()]);

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "test", agentId: "other-agent", limit: 10 });
      expect(result.isError).toBeUndefined();
    });
  });

  describe("access control — self search", () => {
    it("any agent can search its own conversations (no agentId)", async () => {
      await loadWithEnv("regular-agent");
      mockSearch.mockResolvedValue([makeResult()]);

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "hello", limit: 10 });
      expect(result.isError).toBeUndefined();
      expect(mockSearch).toHaveBeenCalledWith("hello", "regular-agent", 10, undefined);
    });

    it("any agent can explicitly pass own agentId", async () => {
      await loadWithEnv("regular-agent");
      mockSearch.mockResolvedValue([makeResult()]);

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "hello", agentId: "regular-agent", limit: 5 });
      expect(result.isError).toBeUndefined();
      expect(mockSearch).toHaveBeenCalledWith("hello", "regular-agent", 5, undefined);
    });
  });

  describe("access control — cross-agent search", () => {
    it("default agent (chief-of-staff) can search other agents", async () => {
      await loadWithEnv("chief-of-staff");
      mockSearch.mockResolvedValue([makeResult({ agentId: "other-agent" })]);

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "project update", agentId: "other-agent", limit: 10 });
      expect(result.isError).toBeUndefined();
      expect(mockSearch).toHaveBeenCalledWith("project update", "other-agent", 10, undefined);
    });

    it("non-default agent gets access denied searching other agents", async () => {
      await loadWithEnv("regular-agent");

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "test", agentId: "other-agent", limit: 10 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Access denied");
      expect(result.content[0].text).toContain("chief-of-staff");
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it("denied message references custom DEFAULT_AGENT name", async () => {
      await loadWithEnv("regular-agent", "boss-agent");

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "test", agentId: "other-agent", limit: 10 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("boss-agent");
      expect(mockSearch).not.toHaveBeenCalled();
    });
  });

  describe("search results", () => {
    it("returns empty message when no results found", async () => {
      await loadWithEnv("test-agent");
      mockSearch.mockResolvedValue([]);

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "nonexistent", limit: 10 });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("No matching conversations found.");
    });

    it("formats results with count, sender, and score", async () => {
      await loadWithEnv("test-agent");
      mockSearch.mockResolvedValue([makeResult(), makeResult({ score: 0.85, senderName: "Bob" })]);

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "hello", limit: 10 });

      expect(result.content[0].text).toContain("Found 2 conversations:");
      expect(result.content[0].text).toContain("User");
      expect(result.content[0].text).toContain("Bob");
      expect(result.content[0].text).toContain("0.9500");
      expect(result.content[0].text).toContain("0.8500");
    });

    it("passes since parameter as unix timestamp", async () => {
      await loadWithEnv("test-agent");
      mockSearch.mockResolvedValue([]);

      const handler = registeredTools["conversation_search"];
      await handler({ query: "test", limit: 10, since: "2026-01-01" });

      const sinceArg = mockSearch.mock.calls[0][3];
      expect(sinceArg).toBe(Math.floor(new Date("2026-01-01").getTime() / 1000));
    });
  });

  describe("error handling", () => {
    it("returns error content when search throws", async () => {
      await loadWithEnv("test-agent");
      mockSearch.mockRejectedValue(new Error("Qdrant connection failed"));

      const handler = registeredTools["conversation_search"];
      const result = await handler({ query: "test", limit: 10 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Qdrant connection failed");
    });
  });
});
