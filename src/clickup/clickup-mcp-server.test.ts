import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock MCP SDK — capture registered tools
type ToolHandler = (...args: any[]) => any;
const registeredTools = new Map<string, { handler: ToolHandler; inputSchema: Record<string, unknown> }>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((name: string, opts: { inputSchema?: Record<string, unknown> }, handler: ToolHandler) => {
      registeredTools.set(name, { handler, inputSchema: opts.inputSchema ?? {} });
    }),
    connect: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

async function loadServer() {
  registeredTools.clear();
  process.env.CLICKUP_API_TOKEN = "pk_test_token";
  vi.resetModules();
  await import("./clickup-mcp-server.js");
}

/** Build a fake task. */
function task(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, status: { status: "open" }, url: `https://app.clickup.com/t/${id}`, ...extra };
}

/**
 * Fake the ClickUp workspace-task endpoint with real pagination semantics,
 * and — critically — mimic the API's actual behaviour of SILENTLY IGNORING
 * unknown query params such as `name=` / `search=`.
 */
function mockWorkspace(allTasks: any[]) {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    requestedUrls.push(url);
    const u = new URL(url);
    const page = Number(u.searchParams.get("page") ?? "0");
    const listIds = u.searchParams.getAll("list_ids[]");

    // Structured filters DO work server-side.
    let pool = allTasks;
    if (listIds.length) pool = pool.filter((t) => listIds.includes(t.list?.id));
    if (u.searchParams.get("include_closed") !== "true") {
      pool = pool.filter((t) => t.status?.status !== "closed");
    }
    // NOTE: `name` / `search` deliberately NOT applied — this is the real bug.

    const pageSize = 100;
    const slice = pool.slice(page * pageSize, (page + 1) * pageSize);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tasks: slice }),
    } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requestedUrls };
}

async function callSearch(args: Record<string, unknown>): Promise<string> {
  const tool = registeredTools.get("clickup_search_tasks");
  if (!tool) throw new Error("clickup_search_tasks not registered");
  const res = await tool.handler(args);
  return res.content[0].text;
}

describe("clickup_search_tasks", () => {
  beforeEach(async () => {
    await loadServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filters by name client-side (regression: API ignores `name=` and returned everything)", async () => {
    mockWorkspace([
      task("aaa", "Fix OAuth token refresh"),
      task("bbb", "Write Q3 board deck"),
      task("ccc", "Renew insurance policy"),
    ]);

    const out = await callSearch({ workspace_id: "123", query: "OAuth" });

    expect(out).toContain("aaa");
    expect(out).not.toContain("bbb");
    expect(out).not.toContain("ccc");
    expect(out).toContain("1 match(es)");
  });

  it("returns a genuine no-match instead of the newest 100 tasks", async () => {
    mockWorkspace([task("aaa", "Fix OAuth token refresh"), task("bbb", "Write Q3 board deck")]);

    const out = await callSearch({ workspace_id: "123", query: "zzz-nonexistent" });

    expect(out).toContain("No tasks found");
    expect(out).not.toContain("aaa");
    expect(out).not.toContain("bbb");
  });

  it("never sends the unsupported `name`/`search` param to the API", async () => {
    const { requestedUrls } = mockWorkspace([task("aaa", "thing")]);

    await callSearch({ workspace_id: "123", query: "thing" });

    for (const u of requestedUrls) {
      expect(u).not.toMatch(/[?&]name=/);
      expect(u).not.toMatch(/[?&]search=/);
    }
  });

  it("requires ALL whitespace-separated terms to match", async () => {
    mockWorkspace([
      task("aaa", "Gmail OAuth consent screen"),
      task("bbb", "Gmail inbox check"),
      task("ccc", "OAuth refresh for Slack"),
    ]);

    const out = await callSearch({ workspace_id: "123", query: "Gmail OAuth" });

    expect(out).toContain("aaa");
    expect(out).not.toContain("bbb");
    expect(out).not.toContain("ccc");
  });

  it("matches case-insensitively", async () => {
    mockWorkspace([task("aaa", "Fix OAUTH Token Refresh")]);
    const out = await callSearch({ workspace_id: "123", query: "oauth token" });
    expect(out).toContain("aaa");
  });

  it("paginates past the 100-task page cap", async () => {
    const many = Array.from({ length: 250 }, (_, i) => task(`t${i}`, `filler ${i}`));
    many.push(task("needle", "the special needle task"));
    mockWorkspace(many);

    const out = await callSearch({ workspace_id: "123", query: "needle" });

    expect(out).toContain("needle");
    expect(out).toContain("251 tasks");
  });

  it("flags a truncated scan so 'no match' is not trusted blindly", async () => {
    const many = Array.from({ length: 250 }, (_, i) => task(`t${i}`, `filler ${i}`));
    mockWorkspace(many);

    const out = await callSearch({ workspace_id: "123", query: "nothing-here", max_pages: 1 });

    expect(out).toContain("No tasks found");
    expect(out).toContain("SCAN TRUNCATED");
  });

  it("does not flag truncation when the whole workspace was scanned", async () => {
    mockWorkspace([task("aaa", "alpha"), task("bbb", "beta")]);
    const out = await callSearch({ workspace_id: "123", query: "nothing-here" });
    expect(out).not.toContain("SCAN TRUNCATED");
  });

  it("reports scan scope so a no-match result is auditable", async () => {
    mockWorkspace([task("aaa", "alpha")]);
    const out = await callSearch({ workspace_id: "123", query: "nothing" });
    expect(out).toMatch(/scanned \d+ tasks across \d+ page\(s\)/);
  });

  it("warns that closed tasks were skipped when include_closed is not set", async () => {
    mockWorkspace([task("aaa", "alpha")]);
    const out = await callSearch({ workspace_id: "123", query: "nothing" });
    expect(out).toContain("closed tasks NOT scanned");
  });

  it("finds a closed duplicate when include_closed is set", async () => {
    mockWorkspace([
      task("open1", "Council Roundtable — August 10", { status: { status: "open" } }),
      task("closed1", "Council Roundtable — August 10", { status: { status: "closed" } }),
    ]);

    const withClosed = await callSearch({
      workspace_id: "123",
      query: "Council Roundtable",
      include_closed: true,
    });
    expect(withClosed).toContain("2 match(es)");

    const withoutClosed = await callSearch({ workspace_id: "123", query: "Council Roundtable" });
    expect(withoutClosed).toContain("1 match(es)");
  });

  it("refuses an empty query rather than returning everything", async () => {
    mockWorkspace([task("aaa", "alpha"), task("bbb", "beta")]);

    const tool = registeredTools.get("clickup_search_tasks")!;
    const res = await tool.handler({ workspace_id: "123", query: "   " });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("empty");
  });

  it("narrows the API call when list_ids is supplied", async () => {
    const { requestedUrls } = mockWorkspace([
      task("aaa", "in scope", { list: { id: "L1" } }),
      task("bbb", "in scope too", { list: { id: "L2" } }),
    ]);

    const out = await callSearch({ workspace_id: "123", query: "scope", list_ids: ["L1"] });

    expect(requestedUrls.some((u) => u.includes("list_ids%5B%5D=L1"))).toBe(true);
    expect(out).toContain("aaa");
    expect(out).not.toContain("bbb");
  });

  it("can match descriptions and custom fields when asked", async () => {
    mockWorkspace([task("aaa", "Opaque title", { description: "root cause was an invalid_grant error" })]);

    const off = await callSearch({ workspace_id: "123", query: "invalid_grant" });
    expect(off).toContain("No tasks found");

    const on = await callSearch({ workspace_id: "123", query: "invalid_grant", search_descriptions: true });
    expect(on).toContain("aaa");
  });

  it("deduplicates tasks repeated across pages", async () => {
    // Same task id appearing twice must not be double-counted.
    const dupe = task("same", "repeated task");
    mockWorkspace([dupe, ...Array.from({ length: 99 }, (_, i) => task(`x${i}`, `other ${i}`)), dupe]);

    const out = await callSearch({ workspace_id: "123", query: "repeated" });
    expect(out).toContain("1 match(es)");
  });
});
