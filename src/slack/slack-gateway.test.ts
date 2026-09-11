import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackGateway, __resetIdentityFallbackLatchForTests } from "./slack-gateway.js";

const warnSpy = vi.fn();
const errorSpy = vi.fn();

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: (...args: unknown[]) => errorSpy(...args),
    debug: vi.fn(),
  }),
}));

// Track ordinary and focused WebClient calls separately. Vitest hoists module
// factories, so every value they close over must be created by vi.hoisted.
const mocks = vi.hoisted(() => {
  const postMessageMock = vi.fn().mockResolvedValue({ ok: true, ts: "1234.5678", channel: "C123" });
  const notificationPostMessageMock = vi.fn().mockResolvedValue({
    ok: true,
    ts: "9000.0001",
    channel: "CNOTICE",
  });
  const uploadV2Mock = vi.fn().mockResolvedValue({ ok: true });
  const conversationsListMock = vi.fn().mockResolvedValue({ channels: [], response_metadata: { next_cursor: "" } });
  const notificationConversationsListMock = vi
    .fn()
    .mockResolvedValue({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
  const conversationsOpenMock = vi.fn().mockResolvedValue({ ok: true, channel: { id: "D0LAUREN" } });
  const usersListMock = vi.fn().mockResolvedValue({ members: [], response_metadata: { next_cursor: "" } });
  const usersLookupByEmailMock = vi.fn().mockResolvedValue({ ok: true, user: { id: "UEMAIL1" } });
  const authTestMock = vi.fn().mockResolvedValue({ ok: true, user_id: "UBOT", bot_id: "BBOT" });
  const socketHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const socketStartMock = vi.fn().mockResolvedValue(undefined);
  const socketDisconnectMock = vi.fn().mockResolvedValue(undefined);
  const webClientConstructorMock = vi.fn().mockImplementation(function (
    _token: string,
    options?: Record<string, unknown>,
  ) {
    if (options?.rejectRateLimitedCalls === true) {
      return {
        chat: { postMessage: notificationPostMessageMock },
        conversations: { list: notificationConversationsListMock },
      };
    }
    return {
      auth: { test: authTestMock },
      chat: { postMessage: postMessageMock },
      files: { uploadV2: uploadV2Mock },
      conversations: { list: conversationsListMock, open: conversationsOpenMock },
      users: { list: usersListMock, lookupByEmail: usersLookupByEmailMock },
    };
  });
  return {
    postMessageMock,
    notificationPostMessageMock,
    uploadV2Mock,
    conversationsListMock,
    conversationsOpenMock,
    usersListMock,
    usersLookupByEmailMock,
    notificationConversationsListMock,
    webClientConstructorMock,
    socketHandlers,
    socketStartMock,
    socketDisconnectMock,
  };
});

const {
  postMessageMock,
  notificationPostMessageMock,
  uploadV2Mock,
  conversationsListMock,
  conversationsOpenMock,
  usersListMock,
  usersLookupByEmailMock,
  notificationConversationsListMock,
  webClientConstructorMock,
  socketHandlers,
} = mocks;

vi.mock("@slack/web-api", () => ({
  WebClient: mocks.webClientConstructorMock,
}));

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => mocks.socketHandlers.set(event, handler)),
      start: mocks.socketStartMock,
      disconnect: mocks.socketDisconnectMock,
    };
  }),
}));

describe("SlackGateway.postMessage — message length handling", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  it("posts short messages normally (≤3900 chars)", async () => {
    const text = "Hello world";
    await gateway.postMessage("C123", text, "thread-1");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", text, thread_ts: "thread-1" }),
    );
  });

  it("posts messages at exactly 3900 chars as single message", async () => {
    const text = "a".repeat(3900);
    await gateway.postMessage("C123", text);

    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });

  it("splits messages between 3901-8000 chars into multiple messages", async () => {
    // Build a message slightly over 3900 chars with paragraph breaks
    const paragraph = "x".repeat(1900);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    // text is 1900 + 2 + 1900 + 2 + 1900 = 5704 chars

    await gateway.postMessage("C123", text, "thread-1");

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    // First chunk should NOT have continuation marker
    const firstCall = postMessageMock.mock.calls[0][0];
    expect(firstCall.text).not.toContain("_(cont.)_");
    // Second chunk SHOULD have continuation marker
    const secondCall = postMessageMock.mock.calls[1][0];
    expect(secondCall.text).toContain("_(cont.)_");
  });

  it("splits on paragraph boundaries (double newline) first", async () => {
    const part1 = "a".repeat(2000);
    const part2 = "b".repeat(2000);
    const part3 = "c".repeat(500);
    const text = `${part1}\n\n${part2}\n\n${part3}`;
    // 2000 + 2 + 2000 + 2 + 500 = 4504

    await gateway.postMessage("C123", text);

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    // First chunk should end near a paragraph boundary
    const firstChunk = postMessageMock.mock.calls[0][0].text;
    expect(firstChunk.length).toBeLessThanOrEqual(3900);
  });

  it("falls back to single newline split when no paragraph breaks", async () => {
    const line = "x".repeat(100);
    const lines = Array(50).fill(line).join("\n"); // 50 * 100 + 49 = 5049

    await gateway.postMessage("C123", lines);

    expect(postMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of postMessageMock.mock.calls) {
      // Each chunk (before cont. prefix) should be within limits
      expect(call[0].text.length).toBeLessThanOrEqual(3900 + 12); // 12 for "_(cont.)_ " prefix
    }
  });

  it("hard-cuts text with no whitespace", async () => {
    const text = "x".repeat(5000); // no whitespace at all
    await gateway.postMessage("C123", text);

    expect(postMessageMock.mock.calls.length).toBe(2);
    // First chunk should be exactly 3900 chars
    expect(postMessageMock.mock.calls[0][0].text).toBe("x".repeat(3900));
  });

  it("uploads as file for messages >8000 chars", async () => {
    const text = "This is a long response. " + "x".repeat(8100);
    await gateway.postMessage("C123", text, "thread-1", { name: "Remy", icon: ":wrench:" });

    // Should post summary first, then upload file
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const summaryCall = postMessageMock.mock.calls[0][0];
    expect(summaryCall.text).toContain("_(full response attached)_");

    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
    expect(uploadV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123",
        thread_ts: "thread-1",
        content: text,
        title: "Remy response",
      }),
    );
    // Filename should use agent name
    const uploadCall = uploadV2Mock.mock.calls[0][0];
    expect(uploadCall.filename).toMatch(/^remy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
  });

  it("falls back to 'hive' filename when no identity provided", async () => {
    const text = "y".repeat(8100);
    await gateway.postMessage("C123", text);

    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
    const uploadCall = uploadV2Mock.mock.calls[0][0];
    expect(uploadCall.filename).toMatch(/^hive-/);
    expect(uploadCall.title).toBe("hive response");
  });

  it("falls back to split when file upload fails", async () => {
    uploadV2Mock.mockRejectedValueOnce(new Error("upload_failed"));
    const text = "y".repeat(8100);
    await gateway.postMessage("C123", text);

    // 1 summary post + split posts (fallback)
    expect(postMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Upload was attempted
    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
  });

  it("preserves identity across split chunks", async () => {
    const text = "a".repeat(5000);
    const identity = { name: "Remy", icon: ":wrench:" };
    await gateway.postMessage("C123", text, undefined, identity);

    for (const call of postMessageMock.mock.calls) {
      expect(call[0].username).toBe("Remy");
      expect(call[0].icon_emoji).toBe(":wrench:");
    }
  });

  it("preserves thread_ts across all split chunks", async () => {
    const text = "a".repeat(5000);
    await gateway.postMessage("C123", text, "thread-99");

    for (const call of postMessageMock.mock.calls) {
      expect(call[0].thread_ts).toBe("thread-99");
    }
  });

  it("trims summary to sentence boundary for file upload", async () => {
    const text = "First sentence. Second sentence. Third sentence is very long. " + "x".repeat(8000);
    await gateway.postMessage("C123", text);

    const summaryText = postMessageMock.mock.calls[0][0].text as string;
    expect(summaryText).toContain("_(full response attached)_");
    // Should end at a sentence boundary, not mid-word
    const beforeAttached = summaryText.split("\n\n_(full response attached)_")[0];
    expect(beforeAttached).toMatch(/[.!?]$/);
  });
});

describe("SlackGateway — outbound echo suppression", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registerOutboundTs + isOutboundEcho round-trip", () => {
    gateway.registerOutboundTs("C1", "1111.2222");
    expect(gateway.isOutboundEcho("C1", "1111.2222")).toBe(true);
    expect(gateway.isOutboundEcho("C1", "9999.9999")).toBe(false);
    expect(gateway.isOutboundEcho("C2", "1111.2222")).toBe(false);
  });

  it("postMessage registers the returned ts in the cache", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "5555.6666", channel: "C123" });
    await gateway.postMessage("C123", "hello");
    expect(gateway.isOutboundEcho("C123", "5555.6666")).toBe(true);
  });

  it("postAndRegister returns ok+ts on success", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "7777.8888", channel: "C456" });
    const result = await gateway.postAndRegister("C456", "hello world");
    expect(result.ok).toBe(true);
    expect(result.ts).toBe("7777.8888");
  });

  it("postAndRegister returns ok:false when postMessage returns no ts", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: false, ts: undefined, channel: undefined });
    const result = await gateway.postAndRegister("C456", "hello world");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("postMessage returned no ts");
  });
});

describe("SlackGateway — resolveChannelId", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  it("returns C… IDs unchanged without hitting the API", async () => {
    const result = await gateway.resolveChannelId("C0123456789");
    expect(result).toBe("C0123456789");
    expect(conversationsListMock).not.toHaveBeenCalled();
  });

  it("returns D… IDs unchanged without hitting the API", async () => {
    const result = await gateway.resolveChannelId("D9876543210");
    expect(result).toBe("D9876543210");
    expect(conversationsListMock).not.toHaveBeenCalled();
  });

  it("returns G… IDs unchanged without hitting the API", async () => {
    const result = await gateway.resolveChannelId("G1122334455");
    expect(result).toBe("G1122334455");
    expect(conversationsListMock).not.toHaveBeenCalled();
  });

  it("hits conversations.list for a bare channel name and populates both caches", async () => {
    conversationsListMock.mockResolvedValueOnce({
      channels: [
        { id: "C111AAA", name: "agent-river" },
        { id: "C222BBB", name: "general" },
      ],
      response_metadata: { next_cursor: "" },
    });

    const result = await gateway.resolveChannelId("agent-river");
    expect(result).toBe("C111AAA");
    expect(conversationsListMock).toHaveBeenCalledTimes(1);

    // Second call should use cache — no additional API call
    const result2 = await gateway.resolveChannelId("agent-river");
    expect(result2).toBe("C111AAA");
    expect(conversationsListMock).toHaveBeenCalledTimes(1);
  });

  it("strips leading # from channel name before lookup", async () => {
    conversationsListMock.mockResolvedValueOnce({
      channels: [{ id: "C333CCC", name: "agent-milo" }],
      response_metadata: { next_cursor: "" },
    });

    const result = await gateway.resolveChannelId("#agent-milo");
    expect(result).toBe("C333CCC");
  });

  it("returns null for an unknown channel name", async () => {
    conversationsListMock.mockResolvedValueOnce({
      channels: [],
      response_metadata: { next_cursor: "" },
    });

    const result = await gateway.resolveChannelId("nonexistent-channel");
    expect(result).toBeNull();
  });
});

describe("SlackGateway — explicit notification receipts", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    notificationPostMessageMock.mockReset().mockResolvedValue({
      ok: true,
      ts: "9000.0001",
      channel: "CNOTICE",
    });
    notificationConversationsListMock
      .mockReset()
      .mockResolvedValue({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  it("constructs a separate focused client with both replay controls and the request bound", () => {
    expect(webClientConstructorMock).toHaveBeenCalledTimes(2);
    expect(webClientConstructorMock.mock.calls[0]).toEqual(["xoxb-test"]);
    expect(webClientConstructorMock.mock.calls[1]?.[0]).toBe("xoxb-test");
    expect(webClientConstructorMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 30_000,
        maxRequestConcurrency: 1,
        fetch: expect.any(Function),
        logger: expect.any(Object),
      }),
    );
  });

  it("posts exactly one plain bounded message and registers only a validated receipt", async () => {
    const result = await gateway.postNotificationReceipt("CNOTICE", "catalog changed");

    expect(result).toEqual({ kind: "acknowledged", channelId: "CNOTICE", messageTs: "9000.0001" });
    expect(notificationPostMessageMock).toHaveBeenCalledTimes(1);
    expect(notificationPostMessageMock).toHaveBeenCalledWith({
      channel: "CNOTICE",
      text: "catalog changed",
      mrkdwn: false,
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(uploadV2Mock).not.toHaveBeenCalled();
    expect(gateway.isOutboundEcho("CNOTICE", "9000.0001")).toBe(true);
  });

  it("does not register malformed or mismatched success responses", async () => {
    notificationPostMessageMock.mockResolvedValueOnce({ ok: true, channel: "COTHER", ts: "9000.0002" });
    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
    });
    expect(gateway.isOutboundEcho("COTHER", "9000.0002")).toBe(false);

    notificationPostMessageMock.mockResolvedValueOnce({ ok: true, channel: "CNOTICE", ts: "" });
    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
    });
    expect(gateway.isOutboundEcho("CNOTICE", "")).toBe(false);
  });

  it.each([
    ["invalid channel", "channel", "text"],
    ["blank text", "CNOTICE", "  "],
    ["overlong text", "CNOTICE", "x".repeat(3901)],
  ])("rejects %s without making a request", async (_case, channel, text) => {
    await expect(gateway.postNotificationReceipt(channel, text)).resolves.toEqual({
      kind: "not-accepted",
      reason: "invalid-state",
    });
    expect(notificationPostMessageMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(uploadV2Mock).not.toHaveBeenCalled();
  });

  it("returns immediately from the first lookup page that contains the channel", async () => {
    notificationConversationsListMock.mockResolvedValueOnce({
      ok: true,
      channels: [{ id: "CNOTICE", name: "catalog-notices" }],
      response_metadata: { next_cursor: "unused-page" },
    });
    notificationConversationsListMock.mockRejectedValueOnce(new Error("unused page must not run"));
    const gate = { check: vi.fn().mockResolvedValue(true), current: vi.fn(() => true) };

    await expect(gateway.resolveNotificationChannel("#catalog-notices", gate)).resolves.toEqual({
      channelId: "CNOTICE",
    });
    expect(notificationConversationsListMock).toHaveBeenCalledTimes(1);
    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(gate.current).toHaveBeenCalledTimes(1);
    expect(gateway.notificationChannelMatches("catalog-notices", "CNOTICE")).toBe(true);
    expect(gateway.notificationChannelMatches("#catalog-notices", "COTHER")).toBe(false);
  });

  it("honors lookup gates before each physical request", async () => {
    const gate = { check: vi.fn().mockResolvedValue(false), current: vi.fn(() => true) };
    await expect(gateway.resolveNotificationChannel("catalog-notices", gate)).resolves.toEqual({ channelId: null });
    expect(notificationConversationsListMock).not.toHaveBeenCalled();
    expect(gate.current).not.toHaveBeenCalled();
  });

  it("propagates focused lookup rate limits without mutable gateway error state", async () => {
    notificationConversationsListMock.mockRejectedValueOnce({
      code: "slack_webapi_rate_limited_error",
      retryAfter: 120,
    });
    const gate = { check: vi.fn().mockResolvedValue(true), current: vi.fn(() => true) };
    await expect(gateway.resolveNotificationChannel("catalog-notices", gate)).resolves.toEqual({
      channelId: null,
      retryAfterMs: 120_000,
      retryBlocked: undefined,
    });
  });

  it("suppresses the inbound event matching an acknowledged notification timestamp", async () => {
    const onMessage = vi.fn();
    gateway.onMessage(onMessage);
    await gateway.start();
    await gateway.postNotificationReceipt("CNOTICE", "catalog changed");

    const handler = socketHandlers.get("message");
    expect(handler).toBeDefined();
    const ack = vi.fn().mockResolvedValue(undefined);
    await handler?.({ event: { channel: "CNOTICE", ts: "9000.0001", user: "UOTHER", text: "echo" }, ack });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("SlackGateway — per-agent identity + error sink (KPR-492 D1/D2/D3)", () => {
  let gateway: SlackGateway;

  // The hoisted defaults, re-established around EVERY test in this describe.
  // `vi.clearAllMocks()` clears call history but NOT implementations, and several
  // tests below use the non-`Once` `mockRejectedValue` (the split path posts an
  // unknown number of chunks, so counting `Once`s would be a guess). Without the
  // afterEach the LAST test's persistent rejection leaks forward to every later
  // describe in the file — harmless today only because Task 3's describes never
  // post, which is not a property to rely on.
  const restoreDefaults = () => {
    postMessageMock.mockResolvedValue({ ok: true, ts: "1234.5678", channel: "C123" });
    uploadV2Mock.mockResolvedValue({ ok: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    restoreDefaults();
    __resetIdentityFallbackLatchForTests();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  afterEach(() => {
    restoreDefaults();
  });

  it("forwards an emoji identity as username + icon_emoji", async () => {
    await gateway.postAndRegister("C123", "hello", undefined, { name: "Grant", icon: ":seedling:" });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", username: "Grant", icon_emoji: ":seedling:" }),
    );
  });

  it("forwards a URL identity as icon_url", async () => {
    await gateway.postAndRegister("C123", "hello", undefined, {
      name: "Grant",
      icon: "https://example.com/grant.png",
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ username: "Grant", icon_url: "https://example.com/grant.png" }),
    );
  });

  it('sends username only when icon is "" (the five agents with an empty icon — §10 step 1 owns the data)', async () => {
    await gateway.postAndRegister("C123", "hello", undefined, { name: "Grant", icon: "" });
    const payload = postMessageMock.mock.calls[0][0];
    expect(payload.username).toBe("Grant");
    expect(payload.icon_emoji).toBeUndefined();
    expect(payload.icon_url).toBeUndefined();
  });

  it("returns the real Slack error instead of 'postMessage returned no ts'", async () => {
    postMessageMock.mockRejectedValueOnce(new Error("An API error occurred: not_in_channel"));
    const result = await gateway.postAndRegister("C123", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not_in_channel");
    expect(result.error).not.toBe("postMessage returned no ts");
  });

  it("never cross-attributes errors between concurrent sends (the per-call sink)", async () => {
    postMessageMock
      .mockRejectedValueOnce(new Error("An API error occurred: not_in_channel"))
      .mockRejectedValueOnce(new Error("An API error occurred: is_archived"));
    const [a, b] = await Promise.all([gateway.postAndRegister("C111", "one"), gateway.postAndRegister("C222", "two")]);
    const errors = [a.error, b.error].sort();
    expect(errors[0]).toContain("is_archived");
    expect(errors[1]).toContain("not_in_channel");
  });

  it("retries plain exactly once when the identity post throws, and posts the message", async () => {
    postMessageMock
      .mockRejectedValueOnce(new Error("An API error occurred: missing_scope"))
      .mockResolvedValueOnce({ ok: true, ts: "1.1", channel: "C123" });
    const result = await gateway.postAndRegister("C123", "hello", undefined, { name: "Grant", icon: ":seedling:" });
    expect(result.ok).toBe(true);
    expect(postMessageMock).toHaveBeenCalledTimes(2);
    expect(postMessageMock.mock.calls[1][0].username).toBeUndefined();
  });

  // ── Step 4's forwarding, pinned per branch ──────────────────────────────
  // Every assertion above posts a SHORT message, so all of them route through
  // postMessage's postSingle branch and would stay green with the errorSink
  // argument dropped from postSplit and/or postAsFile. The THREE below are the
  // only ones that fail in that state, and they fail in a known pattern (Task 11
  // rows g/h): dropping `:505` fails the first two (the upload-failure fallback
  // re-enters postSplit and hits `:505` too); dropping `:557` fails exactly the
  // second; dropping `:545` fails exactly the third.

  it("carries the real error out of the postSplit branch (>SLACK_MAX_CHARS)", async () => {
    postMessageMock.mockRejectedValue(new Error("An API error occurred: not_in_channel"));
    const result = await gateway.postAndRegister("C123", "x".repeat(5000));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not_in_channel");
    expect(result.error).not.toBe("postMessage returned no ts");
  });

  it("carries the real error out of the postAsFile upload-failure fallback (`:557`)", async () => {
    // The third forwarding. Summary post succeeds, uploadV2 FAILS, so postAsFile
    // falls back into postSplit (`:557`) and every chunk then fails. With `:557`
    // alone dropped, postSplit receives errorSink: undefined, `:505` forwards
    // nothing, and the result regresses to "postMessage returned no ts" while
    // the postSplit-branch test above and the postAsFile-branch test below both
    // still pass. This is the only case that pins `:557` (Task 11 row h).
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "1.0", channel: "C123" });
    postMessageMock.mockRejectedValue(new Error("An API error occurred: not_in_channel"));
    uploadV2Mock.mockRejectedValueOnce(new Error("upload failed"));
    const result = await gateway.postAndRegister("C123", "x".repeat(9000));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not_in_channel");
    expect(result.error).not.toBe("postMessage returned no ts");
  });

  it("carries the real error out of the postAsFile branch (>SPLIT_MAX_CHARS)", async () => {
    // The summary post fails; the upload SUCCEEDS, so postAsFile returns the
    // summary's undefined ts and postAndRegister reads the sink. This pins the
    // `:545` forwarding specifically — the upload-failure fallback at `:557`
    // would otherwise mask it by re-entering postSplit.
    postMessageMock.mockRejectedValue(new Error("An API error occurred: is_archived"));
    // uploadV2 keeps the beforeEach default ({ ok: true }) — deliberately.
    const result = await gateway.postAndRegister("C123", "x".repeat(9000));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("is_archived");
    expect(result.error).not.toBe("postMessage returned no ts");
  });

  // ── D3: the once-per-process latch (INSIDE this describe — needs its beforeEach) ──
  it("emits the chat:write.customize error exactly once per process across two failures", async () => {
    postMessageMock
      .mockRejectedValueOnce(new Error("missing_scope"))
      .mockResolvedValueOnce({ ok: true, ts: "1.1", channel: "C1" })
      .mockRejectedValueOnce(new Error("missing_scope"))
      .mockResolvedValueOnce({ ok: true, ts: "2.2", channel: "C1" });
    await gateway.postAndRegister("C1", "a", undefined, { name: "Grant", icon: ":seedling:" });
    await gateway.postAndRegister("C1", "b", undefined, { name: "Grant", icon: ":seedling:" });
    const customizeErrors = errorSpy.mock.calls.filter((c) => String(c[0]).includes("chat:write.customize"));
    expect(customizeErrors).toHaveLength(1);
    const identityWarns = warnSpy.mock.calls.filter(
      (c) => c[0] === "Failed to post with identity, falling back to plain post",
    );
    expect(identityWarns).toHaveLength(2);
  });
});

// Shared by both D4 describes below: the hoisted defaults for the mocks Task 3
// added, re-established after every test because several tests use persistent
// (non-`Once`) implementations. Same rationale as Task 2's restoreDefaults.
const restoreResolverDefaults = () => {
  usersListMock.mockResolvedValue({ members: [], response_metadata: { next_cursor: "" } });
  conversationsListMock.mockResolvedValue({ channels: [], response_metadata: { next_cursor: "" } });
  conversationsOpenMock.mockResolvedValue({ ok: true, channel: { id: "D0LAUREN" } });
  usersLookupByEmailMock.mockResolvedValue({ ok: true, user: { id: "UEMAIL1" } });
};

describe("SlackGateway — resolveConversation ladder (KPR-492 D4)", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreResolverDefaults();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  afterEach(() => {
    restoreResolverDefaults();
  });

  it("rung 0: <@U…> and <@U…|label> unwrap to the id — conversations.open sees the U…, users.list is NEVER called", async () => {
    // The unwrap yields an ID, not a handle, so rung 3 (not rung 5) serves it.
    // A users.list call here would mean the mention was treated as "@U0123".
    await expect(gateway.resolveConversation("<@U0123>", true)).resolves.toEqual({ ok: true, id: "D0LAUREN" });
    await expect(gateway.resolveConversation("<@U0123|lauren>", true)).resolves.toEqual({ ok: true, id: "D0LAUREN" });
    expect(conversationsOpenMock).toHaveBeenCalledWith({ users: "U0123" });
    expect(usersListMock).not.toHaveBeenCalled();
  });

  it("rung 0: <#C…|name> and <#C…> unwrap to the channel id with no API call", async () => {
    await expect(gateway.resolveConversation("<#C0456|dev>", true)).resolves.toEqual({ ok: true, id: "C0456" });
    await expect(gateway.resolveConversation("<#C0456>", true)).resolves.toEqual({ ok: true, id: "C0456" });
    expect(conversationsListMock).not.toHaveBeenCalled();
    expect(conversationsOpenMock).not.toHaveBeenCalled();
  });

  it("rung 0: a <@…> that is not mention-shaped is NOT unwrapped and falls through as today", async () => {
    // "<@lauren>" carries no id; it reaches rung 6 and fails the name lookup
    // exactly as it did pre-KPR-492 — the unwrap is two regexes, not a parser.
    conversationsListMock.mockResolvedValue({ channels: [], response_metadata: { next_cursor: "" } });
    await expect(gateway.resolveConversation("<@lauren>", true)).resolves.toEqual({
      ok: false,
      error: "unknown channel: <@lauren>",
    });
    expect(conversationsOpenMock).not.toHaveBeenCalled();
    expect(usersListMock).not.toHaveBeenCalled();
  });

  it("rung 1: C…/G… ids pass through with no API call", async () => {
    await expect(gateway.resolveConversation("C0123456789", true)).resolves.toEqual({ ok: true, id: "C0123456789" });
    await expect(gateway.resolveConversation("G1122334455", true)).resolves.toEqual({ ok: true, id: "G1122334455" });
    expect(conversationsListMock).not.toHaveBeenCalled();
    expect(conversationsOpenMock).not.toHaveBeenCalled();
  });

  it("rung 2: a D… id passes through verbatim with no API call", async () => {
    await expect(gateway.resolveConversation("D9876543210", true)).resolves.toEqual({ ok: true, id: "D9876543210" });
    expect(conversationsOpenMock).not.toHaveBeenCalled();
    expect(conversationsListMock).not.toHaveBeenCalled();
  });

  it("rung 3: a U… id opens an IM", async () => {
    await expect(gateway.resolveConversation("U0LAUREN", true)).resolves.toEqual({ ok: true, id: "D0LAUREN" });
    expect(conversationsOpenMock).toHaveBeenCalledWith({ users: "U0LAUREN" });
  });

  it("rung 4: an email resolves through users.lookupByEmail then opens an IM", async () => {
    await expect(gateway.resolveConversation("lauren@dodihome.com", true)).resolves.toEqual({
      ok: true,
      id: "D0LAUREN",
    });
    expect(usersLookupByEmailMock).toHaveBeenCalledWith({ email: "lauren@dodihome.com" });
    expect(conversationsOpenMock).toHaveBeenCalledWith({ users: "UEMAIL1" });
  });

  it("rung 5: an @handle resolves through users.list then opens an IM", async () => {
    usersListMock.mockResolvedValueOnce({
      members: [{ id: "U0LAUREN", name: "lauren", profile: { display_name: "Lauren" } }],
      response_metadata: { next_cursor: "" },
    });
    await expect(gateway.resolveConversation("@lauren", true)).resolves.toEqual({ ok: true, id: "D0LAUREN" });
    expect(conversationsOpenMock).toHaveBeenCalledWith({ users: "U0LAUREN" });
  });

  it("rung 6: a bare name (and a #-prefixed one) resolves as a channel", async () => {
    conversationsListMock.mockResolvedValue({
      channels: [{ id: "C111AAA", name: "agent-river" }],
      response_metadata: { next_cursor: "" },
    });
    await expect(gateway.resolveConversation("agent-river", true)).resolves.toEqual({ ok: true, id: "C111AAA" });
    await expect(gateway.resolveConversation("#agent-river", true)).resolves.toEqual({ ok: true, id: "C111AAA" });
  });

  it("rung 6: an unresolvable name keeps today's error string", async () => {
    conversationsListMock.mockResolvedValue({ channels: [], response_metadata: { next_cursor: "" } });
    await expect(gateway.resolveConversation("no-such-channel", true)).resolves.toEqual({
      ok: false,
      error: "unknown channel: no-such-channel",
    });
  });

  it("allowUserForms=false: channel rungs behave identically", async () => {
    await expect(gateway.resolveConversation("C0123456789", false)).resolves.toEqual({ ok: true, id: "C0123456789" });
    await expect(gateway.resolveConversation("D9876543210", false)).resolves.toEqual({ ok: true, id: "D9876543210" });
  });

  it.each([["U0LAUREN"], ["@lauren"], ["lauren@dodihome.com"], ["<@U0LAUREN>"]])(
    "allowUserForms=false: %s is rejected on shape with ZERO API calls",
    async (target) => {
      // The fourth case pins rung 0 under `false`: an unwrapped mention is a
      // U… and shape-rejects like one — the unwrap widens encodings, not paths.
      const result = await gateway.resolveConversation(target, false);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("is a person, not a channel");
      // All THREE counts. A literal fall-through-to-rung-6 implementation returns
      // { ok: false } too and would pass a return-value-only assertion while paging
      // the whole workspace on every mistargeted read — conversations.list is the
      // count that distinguishes them.
      expect(conversationsOpenMock).not.toHaveBeenCalled();
      expect(usersLookupByEmailMock).not.toHaveBeenCalled();
      expect(conversationsListMock).not.toHaveBeenCalled();
    },
  );

  it("memoizes the opened IM per user id", async () => {
    await gateway.resolveConversation("U0LAUREN", true);
    await gateway.resolveConversation("U0LAUREN", true);
    expect(conversationsOpenMock).toHaveBeenCalledTimes(1);
  });

  // ── D4 log redaction (round 5) ────────────────────────────────────────────
  // `users:read.email` makes every colleague's address reachable to this
  // process. The tool RESULT carries the target and the candidates (the agent
  // supplied the target; the list is its remedy); the LOG carries form + code.

  it("redacts the address on an email miss: warn carries form + code, never the email", async () => {
    usersLookupByEmailMock.mockRejectedValueOnce(new Error("An API error occurred: users_not_found"));
    const result = await gateway.resolveConversation("lauren@dodihome.com", true);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("users_not_found"); // the tool result keeps the code
    const warns = JSON.stringify(warnSpy.mock.calls);
    expect(warns).toContain("slack target resolution failed");
    expect(warns).toContain('"form":"email"');
    expect(warns).toContain('"code":"users_not_found"');
    expect(warns).not.toContain("lauren@dodihome.com");
    expect(warns).not.toContain("dodihome");
  });

  it("redacts the handle and every candidate on an ambiguous @handle", async () => {
    usersListMock.mockResolvedValue({
      members: [
        { id: "U1", name: "alex.a", profile: { display_name: "Alex" } },
        { id: "U2", name: "alex.b", profile: { display_name: "Alex" } },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await gateway.resolveConversation("@alex", true);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("@alex.a"); // candidates go to the agent…
    const warns = JSON.stringify(warnSpy.mock.calls);
    expect(warns).toContain('"form":"handle"');
    expect(warns).toContain('"code":"ambiguous"');
    expect(warns).not.toContain("alex"); // …and never to the log — not the handle, not a candidate
  });
});

describe("SlackGateway — resolveUserId (KPR-492 D4)", () => {
  let gateway: SlackGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreResolverDefaults();
    gateway = new SlackGateway("xapp-test", "xoxb-test");
  });

  afterEach(() => {
    restoreResolverDefaults();
  });

  it("passes U… and W… through verbatim with users.list never called (the handleUsers regression guard)", async () => {
    await expect(gateway.resolveUserId("U123ABC")).resolves.toEqual({ ok: true, id: "U123ABC" });
    await expect(gateway.resolveUserId("W123ABC")).resolves.toEqual({ ok: true, id: "W123ABC" });
    expect(usersListMock).not.toHaveBeenCalled();
  });

  it("strips a leading @ itself — @alice and alice resolve to the same id with users.list called exactly once across the pair (the handleUsers raw-pass-through guard)", async () => {
    // Spec D4 (round 6): rung 5 strips before calling, but handleUsers hands
    // slack_read_user_profile's raw input to resolveUserId, so the strip must live
    // here. PERSISTENT mock, deliberately: against an implementation WITHOUT the
    // strip, `@alice` misses a POPULATED map, rebuilds (count 2) and returns
    // ok:false — this test then fails on both assertions, not on an exhausted
    // fixture. Rung 5's own `slice(1)` keeps every ladder test green without the
    // strip, which is why this pin exists (Task 11 row j).
    usersListMock.mockResolvedValue({
      members: [{ id: "UALICE", name: "alice" }],
      response_metadata: { next_cursor: "" },
    });
    await expect(gateway.resolveUserId("@alice")).resolves.toEqual({ ok: true, id: "UALICE" });
    await expect(gateway.resolveUserId("alice")).resolves.toEqual({ ok: true, id: "UALICE" });
    expect(usersListMock).toHaveBeenCalledTimes(1);
  });

  it("prefers an exact user.name over a display-name match, and skips deleted AND bot members", async () => {
    // PERSISTENT mock, deliberately (plan-review round 3, blocking 3). Every miss
    // below triggers the one-rebuild miss policy, which re-pages users.list. With
    // a `Once` fixture the `ghost` lookup's rebuild consumed it and rebuilt from
    // the hoisted EMPTY default, so `hivebot` then missed whether or not is_bot
    // was filtered — the bot half certified nothing. With the same roster served
    // on every page-through, `hivebot` resolving ok:true is exactly what an
    // implementation that indexes bots (and would then open an IM to one, edge 8)
    // does, and this test fails against it.
    usersListMock.mockResolvedValue({
      members: [
        { id: "UNAME", name: "sam", profile: { display_name: "Other" } },
        { id: "UDISPLAY", name: "samantha", profile: { display_name: "sam" } },
        { id: "UDEAD", name: "ghost", deleted: true },
        { id: "UBOT", name: "hivebot", is_bot: true },
      ],
      response_metadata: { next_cursor: "" },
    });
    await expect(gateway.resolveUserId("sam")).resolves.toEqual({ ok: true, id: "UNAME" });
    await expect(gateway.resolveUserId("ghost")).resolves.toMatchObject({ ok: false });
    await expect(gateway.resolveUserId("hivebot")).resolves.toMatchObject({ ok: false });
    // 1 build + 1 rebuild per miss — pins that both misses were REAL misses against
    // a populated map, not artefacts of an exhausted fixture.
    expect(usersListMock).toHaveBeenCalledTimes(3);
  });

  it("a users.list FAILURE surfaces as a Slack-coded error, never as a false 'no such user'", async () => {
    // Round-3 advisory, applied: pre-fix the catch swallowed the error, the flag
    // was set, and the empty map produced "no active Slack user matches" for a
    // ratelimited / missing_scope / transport fault — the exact false
    // does-not-exist the miss policy exists to avoid.
    usersListMock.mockRejectedValue(new Error("An API error occurred: missing_scope"));
    const result = await gateway.resolveUserId("lauren");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("missing_scope");
    expect(result.ok === false && result.error).not.toContain("no active Slack user matches");
    // Still bounded: the first build + the one forced rebuild, no hot loop.
    expect(usersListMock).toHaveBeenCalledTimes(2);
  });

  it("errors and names the candidates on an ambiguous display name — never guesses", async () => {
    usersListMock.mockResolvedValueOnce({
      members: [
        { id: "U1", name: "alex.a", profile: { display_name: "Alex" } },
        { id: "U2", name: "alex.b", profile: { display_name: "Alex" } },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await gateway.resolveUserId("alex");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("ambiguous");
    expect(result.ok === false && result.error).toContain("@alex.a");
    expect(result.ok === false && result.error).toContain("@alex.b");
  });

  it("caches: a second lookup does not re-page users.list", async () => {
    usersListMock.mockResolvedValueOnce({
      members: [{ id: "U0LAUREN", name: "lauren" }],
      response_metadata: { next_cursor: "" },
    });
    await gateway.resolveUserId("lauren");
    await gateway.resolveUserId("lauren");
    expect(usersListMock).toHaveBeenCalledTimes(1);
  });

  it("miss policy: re-pages exactly once and resolves a member added between page-throughs", async () => {
    usersListMock.mockResolvedValueOnce({ members: [], response_metadata: { next_cursor: "" } }).mockResolvedValueOnce({
      members: [{ id: "UNEW", name: "newbie" }],
      response_metadata: { next_cursor: "" },
    });
    await expect(gateway.resolveUserId("newbie")).resolves.toEqual({ ok: true, id: "UNEW" });
    expect(usersListMock).toHaveBeenCalledTimes(2);
  });

  it("miss policy: a second miss errors and does NOT page a third time", async () => {
    usersListMock.mockResolvedValue({ members: [], response_metadata: { next_cursor: "" } });
    const result = await gateway.resolveUserId("nobody");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("no active Slack user matches");
    expect(usersListMock).toHaveBeenCalledTimes(2);
  });

  it("sweep() clears the user and IM caches", async () => {
    usersListMock.mockResolvedValue({
      members: [{ id: "U0LAUREN", name: "lauren" }],
      response_metadata: { next_cursor: "" },
    });
    await gateway.resolveConversation("@lauren", true);
    gateway.sweep();
    await gateway.resolveConversation("@lauren", true);
    expect(usersListMock.mock.calls.length).toBeGreaterThan(1);
    expect(conversationsOpenMock).toHaveBeenCalledTimes(2);
  });
});
