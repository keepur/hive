import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock MCP SDK — capture registered tools so we can drive handlers directly.
type ToolHandler = (...args: any[]) => any;
const registeredTools = new Map<string, { opts: any; handler: ToolHandler }>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function () {
    return {
      registerTool: vi.fn((name: string, opts: any, handler: ToolHandler) => {
        registeredTools.set(name, { opts, handler });
      }),
      connect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock fetch so handler doesn't open a network socket.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

async function loadServer(env: Record<string, string> = {}) {
  registeredTools.clear();
  mockFetch.mockReset();
  const original = { ...process.env };
  // Required env so the bootstrap doesn't `process.exit(1)`.
  process.env.HIVE_INTERNAL_URL = env.HIVE_INTERNAL_URL ?? "http://127.0.0.1:3106";
  process.env.HIVE_INTERNAL_TOKEN = env.HIVE_INTERNAL_TOKEN ?? "test-token";
  if (env.HIVE_AGENT_ID !== undefined) {
    process.env.HIVE_AGENT_ID = env.HIVE_AGENT_ID;
  } else {
    delete process.env.HIVE_AGENT_ID;
  }
  vi.resetModules();
  await import("./slack-mcp-server.js");
  // Restore env
  process.env = original;
}

function callTool(name: string, args: Record<string, any>) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

describe("slack-mcp-server (local stdio)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("slack_send_message", () => {
    it("includes posted_as: AGENT_ID in success response (KPR-174)", async () => {
      await loadServer({ HIVE_AGENT_ID: "jessica" });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, ts: "1234.5678", channel: "C123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await callTool("slack_send_message", {
        channel: "C123",
        text: "hello",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
      expect(parsed.ok).toBe(true);
      expect(parsed.ts).toBe("1234.5678");
      expect(parsed.channel).toBe("C123");
      expect(parsed.posted_as).toBe("jessica");
    });

    it("omits posted_as when HIVE_AGENT_ID is unset", async () => {
      await loadServer({});
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, ts: "9.9", channel: "C9" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await callTool("slack_send_message", {
        channel: "C9",
        text: "hi",
      });

      const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
      expect(parsed.posted_as).toBeUndefined();
    });

    it("returns isError on internal API failure", async () => {
      await loadServer({ HIVE_AGENT_ID: "jessica" });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "unknown channel: foo" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await callTool("slack_send_message", {
        channel: "foo",
        text: "hi",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("unknown channel");
    });
  });

  describe("tool surface (KPR-492 D4/D5)", () => {
    it("registers exactly the four remaining tools — slack_search_messages is gone", async () => {
      await loadServer({});
      expect([...registeredTools.keys()].sort()).toEqual([
        "slack_list_channels",
        "slack_read_channel",
        "slack_read_user_profile",
        "slack_send_message",
      ]);
      expect(registeredTools.has("slack_search_messages")).toBe(false);
    });

    it("slack_send_message.channel advertises the full ladder, incl. Slack mention syntax (rung 0)", async () => {
      await loadServer({});
      const desc = registeredTools.get("slack_send_message")!.opts.inputSchema.channel.description as string;
      expect(desc).toContain("user ID (U…)");
      expect(desc).toContain("@handle");
      expect(desc).toContain("email");
      expect(desc).toContain("<@U…>");
      expect(desc).toContain("prefix with @ to address a person");
    });

    it("slack_read_channel.channel does NOT advertise @handle/email and DOES name the im:history dependency", async () => {
      await loadServer({});
      const desc = registeredTools.get("slack_read_channel")!.opts.inputSchema.channel.description as string;
      expect(desc).not.toContain("@handle");
      expect(desc).not.toContain("email");
      expect(desc).not.toContain("<@U…>"); // the §5.3 sync guard, in both directions
      expect(desc).toContain("im:history");
      expect(desc).toContain("not a supported form");
    });
  });
});
