import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebClientOptions } from "@slack/web-api";

const captured = vi.hoisted(() => ({ entries: [] as unknown[][] }));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    debug: (...values: unknown[]) => captured.entries.push(values),
    info: (...values: unknown[]) => captured.entries.push(values),
    warn: (...values: unknown[]) => captured.entries.push(values),
    error: (...values: unknown[]) => captured.entries.push(values),
  }),
}));

const socket = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), start: socket.start, disconnect: socket.disconnect };
  }),
}));

import { SlackGateway } from "./slack-gateway.js";
import { noticeClientOptions } from "./slack-notification-receipt.js";

type NoticeFetch = NonNullable<WebClientOptions["fetch"]>;
type FetchCall = { url: string; init: Parameters<NoticeFetch>[1] };

function response(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

function recordingFetch(makeResponse: (call: FetchCall) => Response | Promise<Response>): {
  fetch: NoticeFetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch: NoticeFetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return makeResponse(call);
  };
  return { fetch, calls };
}

const unknown = { kind: "outcome-unknown", reason: "delivery-unconfirmed" } as const;

describe("Slack notification receipt SDK integration", () => {
  beforeEach(() => {
    captured.entries.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    expect(noticeClientOptions.timeout).toBe(30_000);
  });

  it("uses the real WebClient for one plain post with the injected fetch and token", async () => {
    const transport = recordingFetch(() => response(JSON.stringify({ ok: true, channel: "CNOTICE", ts: "123.456" })));
    const gateway = new SlackGateway("xapp-test", "xoxb-notification-token", { fetch: transport.fetch });

    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "123.456",
    });

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe("https://slack.com/api/chat.postMessage");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer xoxb-notification-token" }));
    const body = new URLSearchParams(call.init?.body as string);
    expect(Object.fromEntries(body)).toEqual({
      channel: "CNOTICE",
      text: "catalog changed",
      mrkdwn: "false",
      parse: "none",
      link_names: "false",
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect(gateway.isOutboundEcho("CNOTICE", "123.456")).toBe(true);
  });

  it("rejects a post rate limit promptly after one request and preserves the lower bound", async () => {
    const transport = recordingFetch(() => response("rate limited", 429, { "Retry-After": "120" }));
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: transport.fetch });
    const startedAt = Date.now();

    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
      retryAfterMs: 120_000,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects a lookup rate limit promptly after one request and preserves the lower bound", async () => {
    const transport = recordingFetch(() => response("rate limited", 429, { "Retry-After": "120" }));
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: transport.fetch });
    const gate = { check: vi.fn().mockResolvedValue(true), current: vi.fn(() => true) };

    await expect(gateway.resolveNotificationChannel("catalog-notices", gate)).resolves.toEqual({
      channelId: null,
      retryAfterMs: 120_000,
      retryBlocked: undefined,
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe("https://slack.com/api/conversations.list");
  });

  it.each([
    ["HTTP 500", () => response("server detail", 500)],
    ["network throw", () => Promise.reject(new Error("network detail"))],
  ])("keeps %s unknown after exactly one physical request", async (_case, result) => {
    const transport = recordingFetch(() => result());
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: transport.fetch });

    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual(unknown);
    expect(transport.calls).toHaveLength(1);
  });

  it.each(["internal_error", "fatal_error"])("keeps Slack %s conservatively unknown", async (error) => {
    const transport = recordingFetch(() => response(JSON.stringify({ ok: false, error })));
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: transport.fetch });

    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual(unknown);
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    ["invalid JSON error text", 200, "channel_not_found", undefined],
    ["truncated JSON", 200, '{"ok":false', undefined],
    ["array error", 200, '{"ok":false,"error":["channel_not_found"]}', undefined],
    ["object error", 200, '{"ok":false,"error":{"code":"channel_not_found"}}', undefined],
    ["number error", 200, '{"ok":false,"error":4}', undefined],
    ["null error", 200, '{"ok":false,"error":null}', undefined],
    ["missing ok", 200, '{"error":"channel_not_found"}', undefined],
    ["nonboolean ok", 200, '{"ok":"false","error":"channel_not_found"}', undefined],
    ["null metadata", 200, '{"ok":false,"error":"channel_not_found","response_metadata":null}', undefined],
    ["array metadata", 200, '{"ok":false,"error":"channel_not_found","response_metadata":[]}', undefined],
    [
      "string metadata delay",
      200,
      '{"ok":false,"error":"channel_not_found","response_metadata":{"retryAfter":"120"}}',
      undefined,
    ],
    [
      "negative metadata delay",
      200,
      '{"ok":false,"error":"channel_not_found","response_metadata":{"retryAfter":-1}}',
      undefined,
    ],
    ["junk 429 delay", 429, "rate limited", "120junk"],
    ["negative 429 delay", 429, "rate limited", "-1"],
    ["fractional 429 delay", 429, "rate limited", "1.5"],
    ["exponent 429 delay", 429, "rate limited", "1e2"],
    ["empty 429 delay", 429, "rate limited", ""],
    ["missing 429 delay", 429, "rate limited", undefined],
    ["nonfinite 429 delay", 429, "rate limited", "9".repeat(400)],
    ["malformed 200 delay", 200, '{"ok":false,"error":"channel_not_found"}', "120junk"],
  ])("rejects raw %s before SDK normalization", async (_case, status, body, retryAfter) => {
    const headers = retryAfter === undefined ? undefined : { "Retry-After": retryAfter };
    const transport = recordingFetch(() => response(body, status, headers));
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: transport.fetch });

    const result = await gateway.postNotificationReceipt("CNOTICE", "catalog changed");

    expect(result).toEqual(unknown);
    expect(result).not.toHaveProperty("retryAfterMs");
    expect(result).not.toHaveProperty("retryBlocked");
    expect(transport.calls).toHaveLength(1);
  });

  it("allows a validated JSON refusal and a valid rate header through the real SDK", async () => {
    const refusal = recordingFetch(() =>
      response('{"ok":false,"error":"channel_not_found"}', 200, { "Retry-After": "120" }),
    );
    const refusedGateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: refusal.fetch });
    await expect(refusedGateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
      retryAfterMs: 120_000,
    });
    expect(refusal.calls).toHaveLength(1);

    const rate = recordingFetch(() => response("rate limited", 429, { "Retry-After": "120" }));
    const limitedGateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: rate.fetch });
    await expect(limitedGateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
      retryAfterMs: 120_000,
    });
    expect(rate.calls).toHaveLength(1);
  });

  it("marks a finite Retry-After whose millisecond conversion is unsafe as blocked", async () => {
    const transport = recordingFetch(() => response("rate limited", 429, { "Retry-After": "9007199254741" }));
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch: transport.fetch });

    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
      retryBlocked: true,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("uses the real SDK AbortSignal timeout and continues observing the held request", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch: NoticeFetch = async (_url, init) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    };
    const originalTimeout = noticeClientOptions.timeout;
    let gateway: SlackGateway;
    try {
      noticeClientOptions.timeout = 20;
      gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch });
    } finally {
      noticeClientOptions.timeout = originalTimeout;
    }

    await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual(unknown);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps an invocation held until its injected fetch settles, including after gateway stop", async () => {
    let settle!: (value: Response) => void;
    const calls: string[] = [];
    const fetch: NoticeFetch = async (url) => {
      calls.push(String(url));
      return new Promise<Response>((resolve) => {
        settle = resolve;
      });
    };
    const gateway = new SlackGateway("xapp-test", "xoxb-test", { fetch });
    const observed = vi.fn();
    const pending = gateway.postNotificationReceipt("CNOTICE", "catalog changed").then(observed);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await gateway.stop();
    expect(observed).not.toHaveBeenCalled();
    settle(response('{"ok":true,"channel":"CNOTICE","ts":"123.456"}'));
    await pending;

    expect(observed).toHaveBeenCalledWith({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "123.456",
    });
    expect(calls).toHaveLength(1);
  });

  it("does not expose raw malformed body or token sentinels through captured logs", async () => {
    const bodySentinel = "RAW_BODY_SENTINEL_channel_not_found";
    const tokenSentinel = "xoxb-TOKEN_SENTINEL";
    const transport = recordingFetch(() => response(bodySentinel));
    const gateway = new SlackGateway("xapp-test", tokenSentinel, { fetch: transport.fetch });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(gateway.postNotificationReceipt("CNOTICE", "catalog changed")).resolves.toEqual(unknown);
      const output = JSON.stringify([...captured.entries, ...consoleWarn.mock.calls, ...consoleError.mock.calls]);
      expect(output).not.toContain(bodySentinel);
      expect(output).not.toContain(tokenSentinel);
      expect(transport.calls).toHaveLength(1);
    } finally {
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });
});
