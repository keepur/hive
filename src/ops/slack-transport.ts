/**
 * KPR-468 D6: the ONE transport adapter this child ships.
 *
 * A SEPARATE CLASS from KPR-456's SlackObligationPoster, deliberately and
 * permanently: that poster returns KPR-456's own PostOutcome taxonomy under a
 * contract epic canon preserves in force, and a DRY-motivated unification
 * would make one contract's change a silent change to the other. The
 * HARDENING below is copied item for item from src/obligations/slack-post.ts
 * :54-150; nothing is imported from that module.
 */
import { WebClient, ErrorCode, LogLevel, type WebClientOptions } from "@slack/web-api";
import { createLogger } from "../logging/logger.js";
import {
  renderRemediation,
  type DeliveryOutcome,
  type NonacceptanceReason,
  type NotificationView,
  type OpsTransport,
} from "./transport.js";
import { SLACK_POST_TIMEOUT_MS } from "./notification-types.js";

const log = createLogger("ops-slack-transport");
const ENDPOINT = "https://slack.com/api/chat.postMessage";

/**
 * D6: KPR-456's PROVEN code list (slack-post.ts:4-18) projected onto D6's
 * closed NonacceptanceReason set, with NOTHING ADDED.
 *
 * `payload-rejected` is in D6's type and has NO Slack mapping, deliberately:
 * D6 (carrying KPR-456's rule into both contracts) admits a new nonacceptance
 * mapping only with documented evidence that the response PROVES
 * nonacceptance, plus a classifier test. Everything else — timeout, malformed
 * body, unrecognized code, crash after submission — is `unknown`.
 */
const NONACCEPTANCE: Record<string, NonacceptanceReason> = {
  not_authed: "unauthenticated",
  invalid_auth: "unauthenticated",
  token_expired: "unauthenticated",
  token_revoked: "unauthenticated",
  missing_scope: "unauthorized",
  no_permission: "unauthorized",
  ekm_access_denied: "unauthorized",
  restricted_action: "unauthorized",
  channel_not_found: "target-unknown",
  not_in_channel: "target-ineligible",
  is_archived: "target-ineligible",
  rate_limited: "refused-rate-limit",
  ratelimited: "refused-rate-limit",
};

/**
 * Slack CONVERSATION ids only. The check's job is to catch a channel NAME
 * ("#ops"), a URL, or a user handle pasted where an id belongs — the actual
 * mis-registration — not to re-derive Slack's id grammar, because a check
 * stricter than the vendor UNLOADS a legitimate operator subscription (D6).
 *
 * `U…`/`W…` USER ids are deliberately OUT, and the remedy is registration
 * rather than a wider regex: to deliver to a person, register the `D…`
 * conversation id `conversations.open` returns for them, not their user id.
 * Stated here because the operator's only symptom is the unloaded-subscription
 * warn in reloadSubscriptions, and that warn's reader needs the fix at hand.
 */
const CHANNEL_ID = /^[CDG][A-Z0-9]{1,99}$/;

/** Bounded body. Not one of the spec's delegated numerics — an adapter payload bound. */
const MAX_BODY = 2_000;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setLevel: () => {},
  getLevel: () => LogLevel.ERROR,
  setName: () => {},
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Local, deliberately NOT imported from src/obligations/slack-post.ts. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Taken from the SDK's own option type rather than hand-rolled — it is what
 * GUARANTEES the injected fetcher is assignable to `WebClientOptions.fetch`,
 * and it survives an SDK signature change instead of drifting from it.
 * `src/obligations/slack-post.ts:31` spells it the same way.
 */
type Fetcher = NonNullable<WebClientOptions["fetch"]>;

export class SlackOpsTransport implements OpsTransport {
  readonly adapterId = "slack";

  /**
   * EXACTLY two arguments (D10): the bot token and the echo-registration
   * callback. Everything else — the endpoint, the mapping, the hardening
   * constants — is code-resident, and it is handed no target: the target
   * rides each NotificationView (D6). The two trailing parameters are test
   * seams with production defaults, on the SlackObligationPoster shape.
   */
  constructor(
    private readonly token: string,
    private readonly registerEcho: (channel: string, ts: string) => void,
    private readonly clock: () => Date = () => new Date(),
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}

  validateTarget(target: unknown): boolean {
    return typeof target === "string" && CHANNEL_ID.test(target);
  }

  /**
   * The adapter owns rendering. Nothing rendered here ever reaches the ledger
   * (C13, AC12) — the ledger stores the template and its allow-listed
   * parameters, never this string.
   */
  private render(n: NotificationView): string {
    const e = n.event;
    const lines = [
      `[${escapeSlack(e.producer)}] ${escapeSlack(e.reasonId)} — ${e.class}/${e.retry}, waiting: ${e.waiting}`,
      `subject: ${escapeSlack(e.subject.kind)}:${escapeSlack(e.subject.id)} (epoch ${e.generation})`,
      `seen ${n.ledger.eventCount}x since ${n.ledger.firstSeenAt.toISOString()}; nudge ${n.ledger.nudgeCount}`,
    ];
    if (n.remediation) lines.push(escapeSlack(renderRemediation(n.remediation.template, n.remediation.parameters)));
    if (e.evidence.length > 0) {
      lines.push(`evidence: ${e.evidence.map((r) => `${escapeSlack(r.kind)}:${escapeSlack(r.id)}`).join(", ")}`);
    }
    lines.push(`ref: ${escapeSlack(n.handle)}`);
    const body = lines.join("\n");
    return body.length <= MAX_BODY ? body : body.slice(0, MAX_BODY - 1) + "…";
  }

  async deliver(n: NotificationView): Promise<DeliveryOutcome> {
    if (!this.validateTarget(n.target)) return { status: "rejected", reason: "target-unknown" };
    const channel = n.target as string;
    let slackOrigin = false;
    let status = 0;
    let rawRefusalCode: string | undefined;

    const client = new WebClient(this.token, {
      slackApiUrl: "https://slack.com/api/",
      allowAbsoluteUrls: false,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: SLACK_POST_TIMEOUT_MS,
      logger: silentLogger,
      fetch: async (url, init) => {
        if (String(url) !== ENDPOINT) throw new Error("post_unavailable");
        const response = await this.fetcher(url, { ...init, redirect: "error" });
        status = response.status;
        slackOrigin = response.url === ENDPOINT && Boolean(response.headers.get("x-slack-req-id")?.trim());
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: response.headers,
          arrayBuffer: () => response.arrayBuffer(),
          json: () => response.json(),
          text: async () => {
            // Capture only an ALLOW-LISTED code from the actual body as the SDK
            // consumes it; never retain raw text as refusal evidence (C13).
            const raw = await response.text();
            rawRefusalCode = undefined;
            try {
              const parsed = object(JSON.parse(raw));
              if (parsed.ok === false && typeof parsed.error === "string" && parsed.error in NONACCEPTANCE) {
                rawRefusalCode = parsed.error;
              }
            } catch {
              /* malformed JSON supplies no nonacceptance evidence */
            }
            return raw;
          },
        };
      },
    });

    try {
      const response = await client.chat.postMessage({
        channel,
        text: this.render(n),
        mrkdwn: false,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      });
      const at = this.clock();
      if (
        slackOrigin &&
        status === 200 &&
        response.ok === true &&
        response.channel === channel &&
        typeof response.ts === "string" &&
        response.ts.trim().length > 0 &&
        response.ts.length <= 100
      ) {
        // D6/C14: NOT hygiene. Without this the post re-enters the bot's own
        // listener as a WorkItem and SPAWNS AN AGENT TURN — D10 invariant (b)
        // violated, and a turn that then fails a tool republishes and the loop
        // closes. src/slack/slack-gateway.ts:608.
        this.registerEcho(response.channel, response.ts);
        return {
          status: "accepted",
          // A REFERENCE, never a URL (C13).
          reference: { kind: "slackMessage", id: `${response.channel}:${response.ts}` },
          at,
        };
      }
      return { status: "unknown", reason: "ambiguous-response" };
    } catch (err) {
      const error = object(err);
      const data = object(error.data);
      const is429 = slackOrigin && status === 429 && error.code === ErrorCode.RateLimitedError;
      if (is429) return { status: "rejected", reason: "refused-rate-limit" };
      const proven =
        slackOrigin &&
        status === 200 &&
        error.code === ErrorCode.PlatformError &&
        rawRefusalCode !== undefined &&
        data.ok === false &&
        data.error === rawRefusalCode;
      if (proven) return { status: "rejected", reason: NONACCEPTANCE[rawRefusalCode!] };
      // A STRING HEURISTIC, kept deliberately: the SDK collapses every
      // transport failure onto one RequestError code, so "timeout" vs.
      // "transport-fault" is only separable from the message. Its failure mode
      // is benign in BOTH directions — both branches return `unknown`, which is
      // the same C8 treatment (never re-sent, surfaced as uncertainty), so a
      // mis-classification changes a diagnostic label and nothing else. Do not
      // grow this into a second string test that decides anything real.
      if (error.code === ErrorCode.RequestError && String(error.message ?? "").includes("timeout")) {
        return { status: "unknown", reason: "timeout" };
      }
      // No raw error text is logged or returned — the reason is a closed-set token.
      log.warn("ops delivery uncertain", { adapterId: this.adapterId, code: String(error.code ?? "none") });
      return { status: "unknown", reason: "transport-fault" };
    }
  }
}
