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
 * KPR-492: `resolveConversation` and `resolveUserId` belong HERE, not in
 * individual tests — both handleSend and handleRead call the former, so a
 * missing stub resolves `undefined` and breaks every /send and /read test.
 */
function makeGateway(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    resolveChannelId: vi.fn().mockResolvedValue("C123"),
    resolveConversation: vi.fn().mockResolvedValue({ ok: true, id: "C123" }),
    resolveUserId: vi.fn().mockImplementation((u: string) => Promise.resolve({ ok: true, id: u })),
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

/** KPR-492 D1: minimal AgentRegistry mock — only `get` is read. */
function makeRegistry(agents: Record<string, { name: string; icon: string }> = {}): Record<string, unknown> {
  return { get: vi.fn((id: string) => agents[id]) };
}

async function startApi(
  gateway: Record<string, unknown>,
  agentManager: Record<string, unknown>,
  registry: Record<string, unknown> = makeRegistry(),
): Promise<{ api: SlackInternalApi; port: number; token: string; stop: () => Promise<void> }> {
  // Use a random high port for testing — pick one in the ephemeral range.
  const port = 50000 + Math.floor(Math.random() * 10000);
  const token = "test-token-abc";

  const api = new SlackInternalApi({
    port,
    authToken: token,
    gateway: gateway as never,
    agentManager: agentManager as never,
    registry: registry as never,
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
    expect(gateway.postAndRegister).toHaveBeenCalledWith("C123", "hello", "9999.8888", undefined);
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
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "reply", "7777.0001", undefined);
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
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "reply", "5555.0002", undefined);
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
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "broadcast", undefined, undefined);
    } finally {
      await ctx.stop();
    }
  });

  it("returns 400 for unknown channel", async () => {
    const gw = makeGateway({
      resolveConversation: vi.fn().mockResolvedValue({ ok: false, error: "unknown channel: no-such-channel" }),
    });
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
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "hello", undefined, undefined);
    } finally {
      await ctx.stop();
    }
  });
});

describe("SlackInternalApi — /internal/slack/search removed (KPR-492 D5)", () => {
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

  it("returns 404 — the route is gone, not deferred", async () => {
    const res = await post(port, "/internal/slack/search", { query: "anything" }, token);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: "not found" });
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

  // --- regression: name -> ID resolution on the read path ----------------------
  // conversations.history only accepts channel IDs. handleSend resolved names but
  // handleRead passed the raw string straight through, so every name-based read
  // failed with channel_not_found. The original read test only ever passed "C123",
  // so the gap survived a release.
  it("resolves a bare channel name to an ID before reading", async () => {
    (gateway.resolveConversation as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, id: "C0AK579G9DL" });

    const res = await post(port, "/internal/slack/read", { channel: "general", limit: 10 }, token);

    expect(res.status).toBe(200);
    expect(gateway.resolveConversation).toHaveBeenCalledWith("general", false);
    // The ID must reach the gateway — never the raw name.
    expect(gateway.readChannel).toHaveBeenCalledWith("C0AK579G9DL", 10);
  });

  it("passes channel IDs through untouched", async () => {
    const res = await post(port, "/internal/slack/read", { channel: "C123", limit: 5 }, token);

    expect(res.status).toBe(200);
    expect(gateway.readChannel).toHaveBeenCalledWith("C123", 5);
  });

  it("returns 400 with the channel name when it cannot be resolved", async () => {
    (gateway.resolveConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "unknown channel: no-such-channel",
    });

    const res = await post(port, "/internal/slack/read", { channel: "no-such-channel" }, token);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: "unknown channel: no-such-channel" });
    expect(gateway.readChannel).not.toHaveBeenCalled();
  });

  it("surfaces the underlying Slack error instead of a generic message", async () => {
    const failing = makeGateway({
      readChannel: vi.fn().mockResolvedValue(undefined),
      lastReadError: "An API error occurred: not_in_channel",
    });
    const ctx = await startApi(failing, makeAgentManager());

    const res = await post(ctx.port, "/internal/slack/read", { channel: "general" }, ctx.token);

    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain("not_in_channel");
    expect(String(res.body.error)).toContain("general");
    await ctx.stop();
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

describe("SlackInternalApi — per-agent identity + addressing (KPR-492 D1/D2/D4)", () => {
  const registry = () => makeRegistry({ grant: { name: "Grant", icon: ":seedling:" } });

  it("resolves identity from the registry and hands it to postAndRegister", async () => {
    const gw = makeGateway();
    const ctx = await startApi(gw, makeAgentManager(), registry());
    try {
      await post(ctx.port, "/internal/slack/send", { agent_id: "grant", channel: "C123", text: "hi" }, ctx.token);
      expect(gw.postAndRegister).toHaveBeenCalledWith("C123", "hi", undefined, { name: "Grant", icon: ":seedling:" });
    } finally {
      await ctx.stop();
    }
  });

  it("posts plainly (identity undefined) when agent_id is unknown or absent", async () => {
    const gw = makeGateway();
    const ctx = await startApi(gw, makeAgentManager(), registry());
    try {
      await post(ctx.port, "/internal/slack/send", { agent_id: "ghost", channel: "C123", text: "hi" }, ctx.token);
      await post(ctx.port, "/internal/slack/send", { channel: "C123", text: "hi" }, ctx.token);
      expect(gw.postAndRegister).toHaveBeenNthCalledWith(1, "C123", "hi", undefined, undefined);
      expect(gw.postAndRegister).toHaveBeenNthCalledWith(2, "C123", "hi", undefined, undefined);
    } finally {
      await ctx.stop();
    }
  });

  it("handleSend asks for the full ladder (allowUserForms = true)", async () => {
    const gw = makeGateway();
    const ctx = await startApi(gw, makeAgentManager(), registry());
    try {
      await post(ctx.port, "/internal/slack/send", { channel: "@lauren", text: "hi" }, ctx.token);
      expect(gw.resolveConversation).toHaveBeenCalledWith("@lauren", true);
    } finally {
      await ctx.stop();
    }
  });

  it.each([["@lauren"], ["U0LAUREN"], ["lauren@dodihome.com"]])(
    "posts %s to the IM the resolver returned",
    async (target) => {
      const gw = makeGateway({ resolveConversation: vi.fn().mockResolvedValue({ ok: true, id: "D0LAUREN" }) });
      const ctx = await startApi(gw, makeAgentManager(), registry());
      try {
        const res = await post(
          ctx.port,
          "/internal/slack/send",
          { agent_id: "grant", channel: target, text: "hi" },
          ctx.token,
        );
        expect(res.status).toBe(200);
        expect(gw.postAndRegister).toHaveBeenCalledWith("D0LAUREN", "hi", undefined, {
          name: "Grant",
          icon: ":seedling:",
        });
      } finally {
        await ctx.stop();
      }
    },
  );

  it("maps a POST failure into a 500 whose body names the remedy", async () => {
    const gw = makeGateway({
      postAndRegister: vi.fn().mockResolvedValue({ ok: false, error: "An API error occurred: not_in_channel" }),
    });
    const ctx = await startApi(gw, makeAgentManager(), registry());
    try {
      const res = await post(ctx.port, "/internal/slack/send", { channel: "#dev", text: "hi" }, ctx.token);
      expect(res.status).toBe(500);
      expect(String(res.body.error)).toContain("invite it");
      expect(String(res.body.error)).toContain("not_in_channel");
    } finally {
      await ctx.stop();
    }
  });

  it("maps a RESOLVER failure into a 400 whose body names the remedy (handleSend maps both sources)", async () => {
    const gw = makeGateway({
      resolveConversation: vi.fn().mockResolvedValue({ ok: false, error: "An API error occurred: cannot_dm_bot" }),
    });
    const ctx = await startApi(gw, makeAgentManager(), registry());
    try {
      // U… — the shape rung 3 (conversations.open) accepts for a bot user; the
      // resolver is mocked here, so this is consistency with Task 1's fixture, not reachability.
      const res = await post(ctx.port, "/internal/slack/send", { channel: "U0HIVEBOT", text: "hi" }, ctx.token);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("bots cannot DM bots");
    } finally {
      await ctx.stop();
    }
  });

  it("handleRead asks for channel forms only (allowUserForms = false)", async () => {
    const gw = makeGateway({
      resolveConversation: vi.fn().mockResolvedValue({
        ok: false,
        error:
          '"@lauren" is a person, not a channel — this tool reads channels only (DM history is not available on the bot transport)',
      }),
    });
    const ctx = await startApi(gw, makeAgentManager());
    try {
      const res = await post(ctx.port, "/internal/slack/read", { channel: "@lauren" }, ctx.token);
      expect(gw.resolveConversation).toHaveBeenCalledWith("@lauren", false);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("is a person, not a channel");
      expect(gw.readChannel).not.toHaveBeenCalled();
    } finally {
      await ctx.stop();
    }
  });

  it("handleRead surfaces a resolver reason VERBATIM — never through the send-path mapper", async () => {
    // Discriminating fixture (round-3 advisory): a reason carrying a Slack CODE.
    // The person-flavoured reason above has no code, so `not.toContain("invite")`
    // held whether or not handleRead mapped — it certified nothing. A rung-1/2/6
    // resolver can never actually emit a coded string (resolveChannelId swallows
    // API errors), so this is synthetic, and that is the point: if handleRead
    // ever routed through describeSendFailure, THIS fails and nothing else does.
    const coded = "Error: An API error occurred: not_in_channel";
    const gw = makeGateway({ resolveConversation: vi.fn().mockResolvedValue({ ok: false, error: coded }) });
    const ctx = await startApi(gw, makeAgentManager());
    try {
      const res = await post(ctx.port, "/internal/slack/read", { channel: "dev" }, ctx.token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(coded); // byte-verbatim: no "invite it", no "(slack error: …)" wrapper
    } finally {
      await ctx.stop();
    }
  });
});

describe("SlackInternalApi — /internal/slack/users resolution (KPR-492 D4)", () => {
  it("passes a U… straight through to users.info (the id-case regression guard)", async () => {
    const gw = makeGateway();
    const ctx = await startApi(gw, makeAgentManager());
    try {
      const res = await post(ctx.port, "/internal/slack/users", { user: "U123" }, ctx.token);
      expect(res.status).toBe(200);
      expect(gw.resolveUserId).toHaveBeenCalledWith("U123");
      expect(gw.readUser).toHaveBeenCalledWith("U123");
    } finally {
      await ctx.stop();
    }
  });

  it("resolves a display name before users.info", async () => {
    const gw = makeGateway({ resolveUserId: vi.fn().mockResolvedValue({ ok: true, id: "U0LAUREN" }) });
    const ctx = await startApi(gw, makeAgentManager());
    try {
      await post(ctx.port, "/internal/slack/users", { user: "Lauren" }, ctx.token);
      expect(gw.readUser).toHaveBeenCalledWith("U0LAUREN");
    } finally {
      await ctx.stop();
    }
  });

  it("returns 400 with the resolver's reason verbatim and never calls users.info", async () => {
    const reason = 'ambiguous — 2 users match "alex": @alex.a, @alex.b (use their @handle, user id, or email)';
    const gw = makeGateway({ resolveUserId: vi.fn().mockResolvedValue({ ok: false, error: reason }) });
    const ctx = await startApi(gw, makeAgentManager());
    try {
      const res = await post(ctx.port, "/internal/slack/users", { user: "alex" }, ctx.token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(reason);
      expect(gw.readUser).not.toHaveBeenCalled();
    } finally {
      await ctx.stop();
    }
  });

  it("keeps 500 for a users.info failure (today's behaviour, unchanged)", async () => {
    const gw = makeGateway({ readUser: vi.fn().mockResolvedValue(undefined) });
    const ctx = await startApi(gw, makeAgentManager());
    try {
      const res = await post(ctx.port, "/internal/slack/users", { user: "U123" }, ctx.token);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ ok: false, error: "failed to look up user" });
    } finally {
      await ctx.stop();
    }
  });
});
