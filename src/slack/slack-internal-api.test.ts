import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackInternalApi } from "./slack-internal-api.js";
import type { WorkItem } from "../types/work-item.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---- helpers ----------------------------------------------------------------

function makeWorkItem(channelId: string, meta?: Record<string, unknown>): WorkItem {
  return {
    id: "wi-1",
    text: "Hello",
    source: { kind: "slack", id: channelId, label: "test-channel" },
    sender: "U123",
    threadId: "T1",
    timestamp: new Date(),
    meta,
  };
}

/**
 * Minimal gateway mock — only the methods called by SlackInternalApi.
 */
function makeGateway(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    resolveChannelId: vi.fn().mockResolvedValue("C123"),
    postAndRegister: vi.fn().mockResolvedValue({ ok: true, ts: "1000.0001", channel: "C123" }),
    readChannel: vi.fn().mockResolvedValue([{ ts: "1.0", text: "hi" }]),
    listChannels: vi.fn().mockResolvedValue([{ id: "C123", name: "general" }]),
    readUser: vi.fn().mockResolvedValue({ id: "U123", name: "alice" }),
    ...overrides,
  };
}

/**
 * Minimal agent-manager mock.
 */
function makeAgentManager(workItems: WorkItem[] = []): Record<string, unknown> {
  return {
    getActiveWorkItems: vi.fn().mockReturnValue(workItems),
  };
}

async function startApi(
  gateway: Record<string, unknown>,
  agentManager: Record<string, unknown>,
): Promise<{ api: SlackInternalApi; port: number; token: string; stop: () => Promise<void> }> {
  // Use a random high port for testing — pick one in the ephemeral range.
  const port = 50000 + Math.floor(Math.random() * 10000);
  const token = "test-token-abc";

  const api = new SlackInternalApi({
    port,
    authToken: token,
    gateway: gateway as never,
    agentManager: agentManager as never,
  });
  await api.start();

  return { api, port, token, stop: () => api.stop() };
}

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
  authToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken !== undefined) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ---- tests ------------------------------------------------------------------

describe("SlackInternalApi — auth", () => {
  let port: number;
  let token: string;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const ctx = await startApi(makeGateway(), makeAgentManager());
    port = ctx.port;
    token = ctx.token;
    stop = ctx.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await post(port, "/internal/slack/send", { channel: "C1", text: "hi" }, undefined);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("returns 401 when bearer token is wrong", async () => {
    const res = await post(port, "/internal/slack/send", { channel: "C1", text: "hi" }, "wrong-token");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("returns 405 for non-POST requests", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/slack/send`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(405);
    expect(json).toMatchObject({ ok: false });
  });

  it("returns 404 for unknown paths", async () => {
    const res = await post(port, "/internal/slack/unknown", {}, token);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe("SlackInternalApi — /internal/slack/send", () => {
  let port: number;
  let token: string;
  let gateway: ReturnType<typeof makeGateway>;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    gateway = makeGateway();
    const ctx = await startApi(gateway, makeAgentManager());
    port = ctx.port;
    token = ctx.token;
    stop = ctx.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("passes explicit thread_ts through to postAndRegister", async () => {
    const res = await post(
      port,
      "/internal/slack/send",
      { agent_id: "river", channel: "C123", text: "hello", thread_ts: "9999.8888" },
      token,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ts: "1000.0001" });
    expect(gateway.postAndRegister).toHaveBeenCalledWith("C123", "hello", "9999.8888");
  });

  it("uses threading fallback from active WorkItem when thread_ts is absent", async () => {
    const workItem = makeWorkItem("C123", { slackThreadTs: "7777.0001", slackTs: "7777.0000" });
    const agentManager = makeAgentManager([workItem]);
    const gw = makeGateway();
    const ctx = await startApi(gw, agentManager);

    try {
      const res = await post(
        ctx.port,
        "/internal/slack/send",
        { agent_id: "river", channel: "C123", text: "reply" },
        ctx.token,
      );
      expect(res.status).toBe(200);
      // Should use slackThreadTs from the active WorkItem
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "reply", "7777.0001");
    } finally {
      await ctx.stop();
    }
  });

  it("falls back to slackTs when slackThreadTs is absent in the active WorkItem", async () => {
    const workItem = makeWorkItem("C123", { slackTs: "5555.0002" });
    const agentManager = makeAgentManager([workItem]);
    const gw = makeGateway();
    const ctx = await startApi(gw, agentManager);

    try {
      const res = await post(
        ctx.port,
        "/internal/slack/send",
        { agent_id: "river", channel: "C123", text: "reply" },
        ctx.token,
      );
      expect(res.status).toBe(200);
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "reply", "5555.0002");
    } finally {
      await ctx.stop();
    }
  });

  it("skips threading fallback when force_root is true", async () => {
    const workItem = makeWorkItem("C123", { slackThreadTs: "7777.0001" });
    const agentManager = makeAgentManager([workItem]);
    const gw = makeGateway();
    const ctx = await startApi(gw, agentManager);

    try {
      const res = await post(
        ctx.port,
        "/internal/slack/send",
        { agent_id: "river", channel: "C123", text: "broadcast", force_root: true },
        ctx.token,
      );
      expect(res.status).toBe(200);
      // force_root: should pass undefined as threadTs, not the WorkItem's ts
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "broadcast", undefined);
    } finally {
      await ctx.stop();
    }
  });

  it("returns 400 for unknown channel", async () => {
    const gw = makeGateway({ resolveChannelId: vi.fn().mockResolvedValue(null) });
    const ctx = await startApi(gw, makeAgentManager());

    try {
      const res = await post(ctx.port, "/internal/slack/send", { channel: "no-such-channel", text: "hi" }, ctx.token);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: "unknown channel: no-such-channel" });
    } finally {
      await ctx.stop();
    }
  });

  it("does not call the fallback when active WorkItem is on a different channel", async () => {
    // WorkItem is on C999, but we're sending to C123
    const workItem = makeWorkItem("C999", { slackThreadTs: "7777.0001" });
    const agentManager = makeAgentManager([workItem]);
    const gw = makeGateway();
    const ctx = await startApi(gw, agentManager);

    try {
      await post(ctx.port, "/internal/slack/send", { agent_id: "river", channel: "C123", text: "hello" }, ctx.token);
      // No matching WorkItem for C123 — threadTs should be undefined
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "hello", undefined);
    } finally {
      await ctx.stop();
    }
  });
});

describe("SlackInternalApi — /internal/slack/search", () => {
  let port: number;
  let token: string;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const ctx = await startApi(makeGateway(), makeAgentManager());
    port = ctx.port;
    token = ctx.token;
    stop = ctx.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("returns 501 with deferred message", async () => {
    const res = await post(port, "/internal/slack/search", { query: "anything" }, token);
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ ok: false, error: "search deferred pending tool-parity audit" });
  });
});

describe("SlackInternalApi — /internal/slack/read", () => {
  let port: number;
  let token: string;
  let gateway: ReturnType<typeof makeGateway>;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    gateway = makeGateway();
    const ctx = await startApi(gateway, makeAgentManager());
    port = ctx.port;
    token = ctx.token;
    stop = ctx.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("returns messages from the channel", async () => {
    const res = await post(port, "/internal/slack/read", { channel: "C123", limit: 10 }, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, messages: [{ ts: "1.0", text: "hi" }] });
    expect(gateway.readChannel).toHaveBeenCalledWith("C123", 10);
  });

  it("returns 400 when channel is missing", async () => {
    const res = await post(port, "/internal/slack/read", {}, token);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe("SlackInternalApi — /internal/slack/channels", () => {
  let port: number;
  let token: string;
  let gateway: ReturnType<typeof makeGateway>;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    gateway = makeGateway();
    const ctx = await startApi(gateway, makeAgentManager());
    port = ctx.port;
    token = ctx.token;
    stop = ctx.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("returns channels list", async () => {
    const res = await post(port, "/internal/slack/channels", {}, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channels: [{ id: "C123", name: "general" }] });
  });

  it("passes query to gateway.listChannels", async () => {
    await post(port, "/internal/slack/channels", { query: "general" }, token);
    expect(gateway.listChannels).toHaveBeenCalledWith("general");
  });
});

describe("SlackInternalApi — /internal/slack/users", () => {
  let port: number;
  let token: string;
  let gateway: ReturnType<typeof makeGateway>;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    gateway = makeGateway();
    const ctx = await startApi(gateway, makeAgentManager());
    port = ctx.port;
    token = ctx.token;
    stop = ctx.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("returns user info", async () => {
    const res = await post(port, "/internal/slack/users", { user: "U123" }, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, user: { id: "U123", name: "alice" } });
    expect(gateway.readUser).toHaveBeenCalledWith("U123");
  });

  it("returns 400 when user is missing", async () => {
    const res = await post(port, "/internal/slack/users", {}, token);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false });
  });
});
