import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock MCP SDK — capture registered tool handlers, matching the pattern used by
// src/google/google-mcp-server.test.ts.
type ToolHandler = (...args: any[]) => any;
const registeredTools = new Map<string, { handler: ToolHandler }>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((name: string, _opts: unknown, handler: ToolHandler) => {
      registeredTools.set(name, { handler });
    }),
    connect: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

async function loadServer(env: Record<string, string> = {}) {
  registeredTools.clear();
  const original = { ...process.env };
  Object.assign(process.env, { QUO_API_KEY: "test-key", ...env });
  vi.resetModules();
  await import("./quo-mcp-server.js");
  for (const key of Object.keys(env)) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

function callTool(name: string, args: Record<string, unknown>) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

describe("quo-mcp-server", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("quo_list_messages", () => {
    it("sends participants as a plain array query param, not bracket notation", async () => {
      await loadServer();
      await callTool("quo_list_messages", { line: "PNmain", participant: "+15555550123" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.getAll("participants")).toEqual(["+15555550123"]);
      expect(calledUrl.searchParams.has("participants[]")).toBe(false);
    });
  });

  describe("quo_list_calls", () => {
    it("sends participants as a plain array query param, not bracket notation", async () => {
      await loadServer();
      await callTool("quo_list_calls", { line: "PNmain", participant: "+15555550123" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.getAll("participants")).toEqual(["+15555550123"]);
      expect(calledUrl.searchParams.has("participants[]")).toBe(false);
    });
  });

  describe("quo_list_conversations", () => {
    it("sends phoneNumbers as a plain array query param when a line filter is given", async () => {
      await loadServer();
      await callTool("quo_list_conversations", { line: "PNmain" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.getAll("phoneNumbers")).toEqual(["PNmain"]);
      expect(calledUrl.searchParams.has("phoneNumbers[]")).toBe(false);
    });
  });
});
