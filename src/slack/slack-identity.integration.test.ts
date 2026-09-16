import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => {
  const postMessageMock = vi.fn().mockResolvedValue({ ok: true, ts: "1234.5678", channel: "C123" });
  const conversationsOpenMock = vi.fn().mockResolvedValue({ ok: true, channel: { id: "D0LAUREN" } });
  const conversationsListMock = vi.fn().mockResolvedValue({ channels: [], response_metadata: { next_cursor: "" } });
  const usersListMock = vi.fn().mockResolvedValue({
    members: [{ id: "U0LAUREN", name: "lauren", profile: { display_name: "Lauren" } }],
    response_metadata: { next_cursor: "" },
  });
  const usersLookupByEmailMock = vi.fn().mockResolvedValue({ ok: true, user: { id: "U0LAUREN" } });
  const webClientConstructorMock = vi.fn().mockImplementation(function (
    _token: string,
    options?: Record<string, unknown>,
  ) {
    if (options?.rejectRateLimitedCalls === true) {
      return { chat: { postMessage: vi.fn() }, conversations: { list: vi.fn() } };
    }
    return {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: "UBOT", bot_id: "BBOT" }) },
      chat: { postMessage: postMessageMock },
      files: { uploadV2: vi.fn() },
      conversations: { list: conversationsListMock, open: conversationsOpenMock },
      users: { list: usersListMock, lookupByEmail: usersLookupByEmailMock },
    };
  });
  return { postMessageMock, conversationsOpenMock, usersListMock, webClientConstructorMock };
});

vi.mock("@slack/web-api", () => ({ WebClient: mocks.webClientConstructorMock }));
vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { SlackGateway } from "./slack-gateway.js";
import { SlackInternalApi } from "./slack-internal-api.js";

const { postMessageMock, conversationsOpenMock } = mocks;

/**
 * KPR-492: the only test that crosses the SlackInternalApi ↔ SlackGateway seam.
 * A real internal API over a real gateway over a mocked WebClient — an identity
 * object dropped BETWEEN the two modules is invisible to every unit group.
 */
describe("KPR-492 integration — agent_id becomes username on chat.postMessage", () => {
  let api: SlackInternalApi;
  let port: number;
  const token = "integration-token";

  beforeEach(async () => {
    vi.clearAllMocks();
    const gateway = new SlackGateway("xapp-test", "xoxb-test");
    api = new SlackInternalApi({
      // OS-assigned: a random 50000-59999 pick could collide with a parallel
      // worker's port-0 server — see startApi() in slack-internal-api.test.ts.
      port: 0,
      authToken: token,
      gateway,
      agentManager: { getActiveWorkItems: () => [] } as never,
      registry: {
        get: (id: string) => (id === "grant" ? { id: "grant", name: "Grant", icon: ":seedling:" } : undefined),
      } as never,
    });
    await api.start();
    port = api.listeningPort;
    if (port === 0) throw new Error("SlackInternalApi did not bind");
  });

  afterEach(async () => {
    await api.stop();
  });

  async function send(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/internal/slack/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch (err) {
      throw new Error(
        `non-JSON response: HTTP ${res.status}, body ${JSON.stringify(text.slice(0, 200))} (${String(err)})`,
        { cause: err },
      );
    }
  }

  it("carries the agent's name and icon all the way to chat.postMessage", async () => {
    const res = await send({ agent_id: "grant", channel: "C123", text: "hello from Grant" });
    expect(res.status).toBe(200);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "hello from Grant",
        username: "Grant",
        icon_emoji: ":seedling:",
      }),
    );
  });

  it("addresses an @handle by opening an IM and posting to the returned D…", async () => {
    const res = await send({ agent_id: "grant", channel: "@lauren", text: "hi Lauren" });
    expect(res.status).toBe(200);
    expect(conversationsOpenMock).toHaveBeenCalledWith({ users: "U0LAUREN" });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D0LAUREN", username: "Grant", icon_emoji: ":seedling:" }),
    );
  });
});
