import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

const mockSearch = vi.fn(async () => []);

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    search: mockSearch,
  })),
}));

vi.mock("../search/embed-utils.js", () => ({
  embedOllama: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

import { buildCodeSearchTools } from "./code-search-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function makeFakeDb(): any {
  return {
    collection: () => ({
      findOne: vi.fn(async () => null),
      find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
    }),
  };
}

describe("code-search-mcp-server (in-process)", () => {
  it("code_search returns the empty-state message when Qdrant returns nothing", async () => {
    mockSearch.mockResolvedValueOnce([]);
    const tools = buildCodeSearchTools({ db: makeFakeDb() });
    const handler = getHandler(tools, "code_search");

    const res = await handler({ query: "where does X live?" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No matching files/);
  });

  it("code_lookup returns 'not in code index' when no record matches", async () => {
    const tools = buildCodeSearchTools({ db: makeFakeDb() });
    const handler = getHandler(tools, "code_lookup");

    const res = await handler({ filePath: "src/missing.ts" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/not in the code index/);
  });

  it("code_search reports the underlying error when embedOllama throws", async () => {
    const { embedOllama } = await import("../search/embed-utils.js");
    (embedOllama as any).mockRejectedValueOnce(new Error("ollama unavailable"));
    const tools = buildCodeSearchTools({ db: makeFakeDb() });
    const handler = getHandler(tools, "code_search");

    const res = await handler({ query: "anything" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/code_search error/);
  });
});
