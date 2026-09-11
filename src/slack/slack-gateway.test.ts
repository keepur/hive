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
      conversations: { list: conversationsListMock },
    };
  });
  return {
    postMessageMock,
    notificationPostMessageMock,
    uploadV2Mock,
    conversationsListMock,
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
