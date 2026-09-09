import { describe, expect, it, vi } from "vitest";
import type { WebClientOptions } from "@slack/web-api";
import {
  classifyNoticeError,
  classifyNoticeResponse,
  noticeClientOptions,
  validatedNoticeFetch,
} from "./slack-notification-receipt.js";

const unknown = { kind: "outcome-unknown", reason: "delivery-unconfirmed" } as const;
const rejected = { kind: "not-accepted", reason: "delivery-unconfirmed" } as const;

describe("Slack notification receipt classification", () => {
  it("acknowledges only an exact channel and nonblank timestamp", () => {
    expect(classifyNoticeResponse({ ok: true, channel: "CNOTICE", ts: "123.456" }, "CNOTICE")).toEqual({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "123.456",
    });

    for (const value of [
      { ok: true, channel: "COTHER", ts: "123.456" },
      { ok: true, channel: "CNOTICE", ts: "" },
      { ok: true, channel: "CNOTICE", ts: "  " },
      { ok: true, channel: "CNOTICE" },
      { ok: false },
      { ok: false, error: "internal_error", channel: "CNOTICE", ts: "123.456" },
      { channel: "CNOTICE", ts: "123.456" },
      undefined,
    ]) {
      expect(classifyNoticeResponse(value, "CNOTICE")).toEqual(unknown);
    }
  });

  it.each([
    "channel_not_found",
    "not_in_channel",
    "is_archived",
    "invalid_auth",
    "not_authed",
    "account_inactive",
    "token_expired",
    "token_revoked",
    "missing_scope",
    "no_permission",
    "access_denied",
    "invalid_arguments",
    "invalid_arg_name",
    "no_text",
    "msg_too_long",
    "restricted_action",
    "restricted_action_read_only_channel",
    "restricted_action_thread_only_channel",
    "ekm_access_denied",
    "ratelimited",
    "rate_limited",
  ])("treats the documented string refusal %s as not accepted", (error) => {
    expect(classifyNoticeResponse({ ok: false, error }, "CNOTICE")).toEqual(rejected);
  });

  it.each(["internal_error", "fatal_error", "future_error"])(
    "keeps the uncertain API error %s outcome unknown",
    (error) => {
      expect(classifyNoticeResponse({ ok: false, error }, "CNOTICE")).toEqual(unknown);
    },
  );

  it.each([["channel_not_found"], { code: "channel_not_found" }, 4, null])(
    "does not coerce a non-string API error (%j)",
    (error) => {
      expect(classifyNoticeResponse({ ok: false, error }, "CNOTICE")).toEqual(unknown);
    },
  );

  it.each([null, [], { retryAfter: "120" }, { retryAfter: -1 }, { retryAfter: Number.POSITIVE_INFINITY }])(
    "rejects malformed response metadata (%j)",
    (response_metadata) => {
      expect(classifyNoticeResponse({ ok: false, error: "ratelimited", response_metadata }, "CNOTICE")).toEqual(
        unknown,
      );
    },
  );

  it("preserves valid rate delays and blocks unsafe millisecond values", () => {
    expect(
      classifyNoticeResponse({ ok: false, error: "ratelimited", response_metadata: { retryAfter: 0 } }, "CNOTICE"),
    ).toEqual({ ...rejected, retryAfterMs: 0 });
    expect(
      classifyNoticeResponse({ ok: false, error: "rate_limited", response_metadata: { retryAfter: 120 } }, "CNOTICE"),
    ).toEqual({ ...rejected, retryAfterMs: 120_000 });
    expect(
      classifyNoticeResponse({ ok: false, error: "ratelimited", response_metadata: { retryAfter: 1.0001 } }, "CNOTICE"),
    ).toEqual({ ...rejected, retryAfterMs: 1001 });
    expect(
      classifyNoticeResponse(
        { ok: false, error: "ratelimited", response_metadata: { retryAfter: 9_000_000_000_000 } },
        "CNOTICE",
      ),
    ).toEqual({ ...rejected, retryAfterMs: 9_000_000_000_000_000 });
    expect(
      classifyNoticeResponse(
        { ok: false, error: "ratelimited", response_metadata: { retryAfter: 9_007_199_254_741 } },
        "CNOTICE",
      ),
    ).toEqual({ ...rejected, retryBlocked: true });
    expect(
      classifyNoticeResponse(
        { ok: false, error: "ratelimited", response_metadata: { retryAfter: Number.MAX_VALUE } },
        "CNOTICE",
      ),
    ).toEqual({ ...rejected, retryBlocked: true });
  });

  it("classifies only structural Slack platform and rate-limit errors", () => {
    expect(
      classifyNoticeError(
        {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: "channel_not_found", response_metadata: {} },
        },
        "CNOTICE",
      ),
    ).toEqual(rejected);
    expect(classifyNoticeError({ code: "slack_webapi_rate_limited_error", retryAfter: 120 }, "CNOTICE")).toEqual({
      ...rejected,
      retryAfterMs: 120_000,
    });
    expect(
      classifyNoticeError({ code: "slack_webapi_rate_limited_error", retryAfter: 9_007_199_254_741 }, "CNOTICE"),
    ).toEqual({ ...rejected, retryBlocked: true });

    for (const error of [
      new Error("network"),
      { code: "slack_webapi_http_error", statusCode: 500 },
      { code: "slack_webapi_rate_limited_error", retryAfter: "120" },
      { code: "slack_webapi_platform_error", data: { ok: false, error: "internal_error" } },
    ]) {
      expect(classifyNoticeError(error, "CNOTICE")).toEqual(unknown);
    }
  });

  it("pins both replay controls, a 30-second timeout, one request, and a silent logger", () => {
    expect(noticeClientOptions.retryConfig).toEqual({ retries: 0 });
    expect(noticeClientOptions.rejectRateLimitedCalls).toBe(true);
    expect(noticeClientOptions.timeout).toBe(30_000);
    expect(noticeClientOptions.maxRequestConcurrency).toBe(1);
    expect(noticeClientOptions.logger?.getLevel()).toBe("error");
    expect(() => {
      noticeClientOptions.logger?.debug("secret");
      noticeClientOptions.logger?.info("secret");
      noticeClientOptions.logger?.warn("secret");
      noticeClientOptions.logger?.error("secret");
      noticeClientOptions.logger?.setLevel("debug" as never);
      noticeClientOptions.logger?.setName("test");
    }).not.toThrow();
  });
});

describe("validatedNoticeFetch", () => {
  type NoticeFetch = NonNullable<WebClientOptions["fetch"]>;

  it("forwards the SDK signal and replays one validated body without another fetch", async () => {
    const controller = new AbortController();
    const raw = new Response('{"ok":true,"channel":"CNOTICE","ts":"123.456"}', { status: 200 });
    const fetcher = vi.fn<NoticeFetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return raw;
    });
    const fetch = validatedNoticeFetch(fetcher);

    const response = await fetch("https://slack.test/api/chat.postMessage", { signal: controller.signal });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('{"ok":true,"channel":"CNOTICE","ts":"123.456"}');
    expect(await response.json()).toEqual({ ok: true, channel: "CNOTICE", ts: "123.456" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["channel_not_found", {}],
    ['{"ok":false', {}],
    ['{"ok":false,"error":["channel_not_found"]}', {}],
    ['{"ok":false,"error":{"code":"channel_not_found"}}', {}],
    ['{"ok":false,"error":4}', {}],
    ['{"ok":false,"error":null}', {}],
    ['{"error":"channel_not_found"}', {}],
    ['{"ok":"false","error":"channel_not_found"}', {}],
    ['{"ok":false,"error":"channel_not_found","response_metadata":null}', {}],
    ['{"ok":false,"error":"channel_not_found","response_metadata":{"retryAfter":"120"}}', {}],
    ['{"ok":false,"error":"channel_not_found"}', { "Retry-After": "120junk" }],
  ])("rejects malformed HTTP 200 input before SDK normalization: %s", async (body, headers) => {
    const fetch = validatedNoticeFetch(async () => new Response(body, { status: 200, headers }));
    await expect(fetch("https://slack.test/api/chat.postMessage")).rejects.toThrow(
      "Malformed notification transport response",
    );
  });

  it.each([undefined, "", "-1", "1.5", "1e2", "120junk", "Infinity"])(
    "rejects an invalid HTTP 429 Retry-After header (%s)",
    async (retryAfter) => {
      const headers = retryAfter === undefined ? undefined : { "Retry-After": retryAfter };
      const fetch = validatedNoticeFetch(async () => new Response("rate limited", { status: 429, headers }));
      await expect(fetch("https://slack.test/api/chat.postMessage")).rejects.toThrow(
        "Malformed notification transport response",
      );
    },
  );

  it("passes a valid 429 and unrelated HTTP failures through without reading their bodies", async () => {
    const rate = new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } });
    const failure = new Response("server detail", { status: 500 });
    expect(await validatedNoticeFetch(async () => rate)("https://slack.test/api/chat.postMessage")).toBe(rate);
    expect(await validatedNoticeFetch(async () => failure)("https://slack.test/api/chat.postMessage")).toBe(failure);
    expect(rate.bodyUsed).toBe(false);
    expect(failure.bodyUsed).toBe(false);
  });

  it("keeps the invocation pending while a raw response body read is unsettled", async () => {
    let release!: (body: string) => void;
    const body = new Promise<string>((resolve) => {
      release = resolve;
    });
    const raw = {
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://slack.test/api/chat.postMessage",
      headers: new Headers(),
      text: () => body,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    const fetch = validatedNoticeFetch(async () => raw);
    const observed = vi.fn();
    const pending = fetch("https://slack.test/api/chat.postMessage").then(observed);

    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    release('{"ok":true,"channel":"CNOTICE","ts":"123.456"}');
    await pending;
    expect(observed).toHaveBeenCalledTimes(1);
  });
});
