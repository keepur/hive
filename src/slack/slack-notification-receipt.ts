import type { WebClientOptions } from "@slack/web-api";
import type { NoticeRetry, SendResult } from "../admin/model-catalog-notification.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const object = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function validEnvelope(value: unknown): value is Record<string, unknown> {
  if (
    !isObject(value) ||
    typeof value.ok !== "boolean" ||
    (value.ok === false && typeof value.error !== "string") ||
    (Object.hasOwn(value, "error") && typeof value.error !== "string")
  )
    return false;
  if (!Object.hasOwn(value, "response_metadata")) return true;
  const metadata = value.response_metadata;
  return isObject(metadata) && (!Object.hasOwn(metadata, "retryAfter") || seconds(metadata.retryAfter));
}

type NoticeFetch = NonNullable<WebClientOptions["fetch"]>;

export function validatedNoticeFetch(fetcher: NoticeFetch = globalThis.fetch): NoticeFetch {
  return async (url, init) => {
    const response = await fetcher(url, init);
    if (response.status !== 200 && response.status !== 429) return response;

    const malformed = () => new Error("Malformed notification transport response");
    const retryHeader = response.headers.get("retry-after");
    if (retryHeader !== null && (!/^[0-9]+$/.test(retryHeader) || !seconds(Number(retryHeader)))) {
      throw malformed();
    }
    if (response.status === 429) {
      if (retryHeader === null) throw malformed();
      return response;
    }

    let body: string;
    try {
      body = await response.text();
      if (!validEnvelope(JSON.parse(body))) throw malformed();
    } catch {
      throw malformed();
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: response.headers,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
}

const refused = new Set([
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
]);

function delay(value: unknown): NoticeRetry {
  if (!seconds(value)) return {};
  const milliseconds = Math.ceil(value * 1000);
  return Number.isSafeInteger(milliseconds) ? { retryAfterMs: milliseconds } : { retryBlocked: true };
}

export const noticeClientOptions: WebClientOptions = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  timeout: 30_000,
  maxRequestConcurrency: 1,
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    setLevel() {},
    getLevel() {
      return "error" as ReturnType<NonNullable<WebClientOptions["logger"]>["getLevel"]>;
    },
    setName() {},
  },
};

export function classifyNoticeResponse(value: unknown, channelId: string): SendResult {
  if (!validEnvelope(value)) return { kind: "outcome-unknown", reason: "delivery-unconfirmed" };
  const retry = delay(object(value.response_metadata).retryAfter);
  if (value.ok === true && value.channel === channelId && typeof value.ts === "string" && value.ts.trim()) {
    return { kind: "acknowledged", channelId, messageTs: value.ts };
  }
  if (
    value.ok === false &&
    typeof value.error === "string" &&
    (refused.has(value.error) || value.error === "ratelimited" || value.error === "rate_limited")
  ) {
    return { kind: "not-accepted", reason: "delivery-unconfirmed", ...retry };
  }
  return { kind: "outcome-unknown", reason: "delivery-unconfirmed", ...retry };
}

export function classifyNoticeError(error: unknown, channelId: string): SendResult {
  const value = object(error);
  if (value.code === "slack_webapi_platform_error") return classifyNoticeResponse(value.data, channelId);
  if (value.code === "slack_webapi_rate_limited_error" && seconds(value.retryAfter)) {
    return { kind: "not-accepted", reason: "delivery-unconfirmed", ...delay(value.retryAfter) };
  }
  return { kind: "outcome-unknown", reason: "delivery-unconfirmed" };
}
