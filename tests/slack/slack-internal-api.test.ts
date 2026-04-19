import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SlackInternalApi } from "../../src/slack/slack-internal-api.js";
import type { SlackGateway } from "../../src/slack/slack-gateway.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { WorkItem } from "../../src/types/work-item.js";

const AUTH_TOKEN = "test-token-123";

interface MockGateway {
  resolveChannelId: ReturnType<typeof vi.fn>;
  postForInternalApi: ReturnType<typeof vi.fn>;
  historyForChannel: ReturnType<typeof vi.fn>;
  listConversations: ReturnType<typeof vi.fn>;
  userInfo: ReturnType<typeof vi.fn>;
}

interface MockAgentManager {
  getActiveWorkItems: ReturnType<typeof vi.fn>;
}

function makeMockGateway(): MockGateway {
  return {
    resolveChannelId: vi.fn(async (name: string) => (name === "unknown" ? null : `C_${name}`)),
    postForInternalApi: vi.fn(async () => "9999.8888"),
    historyForChannel: vi.fn(async () => [{ text: "hello" }]),
    listConversations: vi.fn(async () => [{ id: "C1", name: "general" }]),
    userInfo: vi.fn(async () => ({ id: "U1", name: "alice" })),
  };
}

function makeMockAgentManager(): MockAgentManager {
  return {
    getActiveWorkItems: vi.fn(() => [] as WorkItem[]),
  };
}

async function findPort(): Promise<number> {
  return 30000 + Math.floor(Math.random() * 5000);
}

async function post(
  port: number,
  path: string,
  body: unknown,
  auth?: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== undefined) headers["Authorization"] = auth;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

describe("SlackInternalApi", () => {
  let gateway: MockGateway;
  let agentManager: MockAgentManager;
  let api: SlackInternalApi;
  let port: number;

  beforeEach(async () => {
    gateway = makeMockGateway();
    agentManager = makeMockAgentManager();
    port = await findPort();
    api = new SlackInternalApi({
      port,
      authToken: AUTH_TOKEN,
      gateway: gateway as unknown as SlackGateway,
      agentManager: agentManager as unknown as AgentManager,
    });
    await api.start();
  });

  afterEach(async () => {
    await api.stop();
  });

  it("rejects with 401 on missing/wrong bearer", async () => {
    const noAuth = await post(port, "/internal/slack/send", { agent_id: "a", channel: "c", text: "hi" });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await post(
      port,
      "/internal/slack/send",
      { agent_id: "a", channel: "c", text: "hi" },
      "Bearer wrong-token",
    );
    expect(wrongAuth.status).toBe(401);
  });

  it("/send with explicit thread_ts passes it through", async () => {
    const r = await post(
      port,
      "/internal/slack/send",
      { agent_id: "river", channel: "agent-river", text: "hello", thread_ts: "1111.2222" },
      `Bearer ${AUTH_TOKEN}`,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, ts: "9999.8888", channel: "C_agent-river" });
    expect(gateway.postForInternalApi).toHaveBeenCalledWith("C_agent-river", "hello", "1111.2222", undefined);
  });

  it("/send without thread_ts uses matching active WorkItem's slackThreadTs", async () => {
    const item: WorkItem = {
      id: "w1",
      text: "incoming",
      source: { kind: "slack", id: "C_agent-river", label: "agent-river" },
      sender: "U1",
      timestamp: new Date(),
      meta: { slackThreadTs: "5555.6666", slackTs: "7777.8888" },
    };
    agentManager.getActiveWorkItems.mockReturnValue([item]);

    const r = await post(
      port,
      "/internal/slack/send",
      { agent_id: "river", channel: "agent-river", text: "hello" },
      `Bearer ${AUTH_TOKEN}`,
    );
    expect(r.status).toBe(200);
    expect(agentManager.getActiveWorkItems).toHaveBeenCalledWith("river");
    expect(gateway.postForInternalApi).toHaveBeenCalledWith("C_agent-river", "hello", "5555.6666", undefined);
  });

  it("/send with force_root ignores active work items and posts at root", async () => {
    const item: WorkItem = {
      id: "w1",
      text: "incoming",
      source: { kind: "slack", id: "C_agent-river", label: "agent-river" },
      sender: "U1",
      timestamp: new Date(),
      meta: { slackThreadTs: "5555.6666" },
    };
    agentManager.getActiveWorkItems.mockReturnValue([item]);

    const r = await post(
      port,
      "/internal/slack/send",
      { agent_id: "river", channel: "agent-river", text: "broadcast", force_root: true },
      `Bearer ${AUTH_TOKEN}`,
    );
    expect(r.status).toBe(200);
    expect(gateway.postForInternalApi).toHaveBeenCalledWith("C_agent-river", "broadcast", undefined, undefined);
  });

  it("/send with unresolved channel returns 404", async () => {
    const r = await post(
      port,
      "/internal/slack/send",
      { agent_id: "river", channel: "unknown", text: "hi" },
      `Bearer ${AUTH_TOKEN}`,
    );
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, error: "channel_not_found" });
    expect(gateway.postForInternalApi).not.toHaveBeenCalled();
  });

  it("/read resolves channel and returns history", async () => {
    const r = await post(
      port,
      "/internal/slack/read",
      { channel: "agent-river", limit: 10 },
      `Bearer ${AUTH_TOKEN}`,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, messages: [{ text: "hello" }] });
    expect(gateway.historyForChannel).toHaveBeenCalledWith("C_agent-river", 10);
  });

  it("/search returns 501", async () => {
    const r = await post(port, "/internal/slack/search", { query: "x" }, `Bearer ${AUTH_TOKEN}`);
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({ ok: false });
  });
});
