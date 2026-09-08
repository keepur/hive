import { WebClient, ErrorCode, LogLevel, type WebClientOptions } from "@slack/web-api";
import type { Destination } from "./types.js";

export const NONACCEPTANCE = new Set([
  "not_authed",
  "invalid_auth",
  "token_expired",
  "token_revoked",
  "missing_scope",
  "no_permission",
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "ekm_access_denied",
  "restricted_action",
  "rate_limited",
  "ratelimited",
]);
export type PostOutcome =
  | { kind: "acknowledged"; ts: string; acknowledgedAt: Date }
  | { kind: "rejected"; reason: "authoritative_refusal" | "rate_limited"; retryAt: Date }
  | { kind: "unknown"; reason: "unconfirmed_response" | "identity_unverified" };
export interface ObligationPoster {
  post(destination: Destination, text: string): Promise<PostOutcome>;
}
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function attributedText(producer: string, text: string): string {
  return "[" + escapeSlack(producer) + "]\n" + text;
}
type Fetcher = NonNullable<WebClientOptions["fetch"]>;
const ENDPOINT = "https://slack.com/api/chat.postMessage";
const silentLogger = {
  setLevel: () => {},
  setName: () => {},
  getLevel: () => LogLevel.ERROR,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export class SlackObligationPoster implements ObligationPoster {
  constructor(
    private token: string,
    private registerEcho: (channel: string, ts: string) => void,
    private canSend: () => boolean,
    private clock: () => Date = () => new Date(),
    private fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}
  async post(destination: Destination, text: string): Promise<PostOutcome> {
    if (!this.canSend()) return { kind: "unknown", reason: "identity_unverified" };
    let slackOrigin = false;
    let status = 0;
    let retryAfter = 0;
    let rawRefusalCode: string | undefined;
    const client = new WebClient(this.token, {
      slackApiUrl: "https://slack.com/api/",
      allowAbsoluteUrls: false,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 20_000,
      logger: silentLogger,
      fetch: async (url, init) => {
        if (!this.canSend() || String(url) !== ENDPOINT) throw new Error("post_unavailable");
        const response = await this.fetcher(url, { ...init, redirect: "error" });
        status = response.status;
        slackOrigin = response.url === ENDPOINT && Boolean(response.headers.get("x-slack-req-id")?.trim());
        const seconds = Number(response.headers.get("retry-after"));
        retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        // The SDK synthesizes { ok: false, error: rawText } for malformed
        // JSON. Capture only an allow-listed code from the actual body as
        // the SDK consumes it; never retain raw text as refusal evidence.
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: response.headers,
          arrayBuffer: () => response.arrayBuffer(),
          json: () => response.json(),
          text: async () => {
            const body = await response.text();
            rawRefusalCode = undefined;
            try {
              const parsed = object(JSON.parse(body));
              if (parsed.ok === false && typeof parsed.error === "string" && NONACCEPTANCE.has(parsed.error))
                rawRefusalCode = parsed.error;
            } catch {
              /* malformed JSON supplies no nonacceptance evidence */
            }
            return body;
          },
        };
      },
    });
    try {
      const response = await client.chat.postMessage({
        channel: destination.channelId,
        ...(destination.threadTs ? { thread_ts: destination.threadTs } : {}),
        text,
        mrkdwn: false,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      });
      const acknowledgedAt = this.clock();
      if (
        slackOrigin &&
        status === 200 &&
        response.ok === true &&
        response.channel === destination.channelId &&
        typeof response.ts === "string" &&
        response.ts.trim().length > 0 &&
        response.ts.length <= 100
      ) {
        this.registerEcho(response.channel, response.ts);
        return { kind: "acknowledged", ts: response.ts, acknowledgedAt };
      }
      return { kind: "unknown", reason: "unconfirmed_response" };
    } catch (err) {
      const error = object(err);
      const data = object(error.data);
      const is429 = slackOrigin && status === 429 && error.code === ErrorCode.RateLimitedError;
      const refusal =
        slackOrigin &&
        status === 200 &&
        error.code === ErrorCode.PlatformError &&
        rawRefusalCode !== undefined &&
        data.ok === false &&
        data.error === rawRefusalCode;
      if (is429 || refusal) {
        const reported = Number(error.retryAfter);
        const delaySeconds = Math.max(30, retryAfter, Number.isFinite(reported) && reported > 0 ? reported : 0);
        return {
          kind: "rejected",
          reason:
            is429 || data.error === "rate_limited" || data.error === "ratelimited"
              ? "rate_limited"
              : "authoritative_refusal",
          retryAt: new Date(this.clock().getTime() + delaySeconds * 1000),
        };
      }
      return { kind: "unknown", reason: "unconfirmed_response" };
    }
  }
}
