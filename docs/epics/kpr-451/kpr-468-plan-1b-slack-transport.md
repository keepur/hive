# KPR-468 plan — chunk 1b: the Slack ops transport

The second half of chunk 1, split at the Task 1 | Task 2 seam because the combined file ran to ~1,040 lines and this plan's bound is 1,000 (the KPR-454 chunk 2 / 2b precedent). **Read [chunk 1](kpr-468-plan-1-types.md) first** — this task consumes the `OpsTransport` interface, the closed reason sets, `NotificationView` and the constants that file creates, and it is governed by the same two prohibitions stated in its header:

- **`src/ops/**` imports nothing from `src/obligations/**`.** Not `escapeSlack`, not `NONACCEPTANCE`, not `PostOutcome`, not `ObligationPoster`. The hardening is copied by re-writing it here.
- **The three closed sets in `transport.ts` are KPR-458 D6 verbatim and are never extended by an adapter.**

One task, one commit.

---

### Task 2: `SlackOpsTransport`

**Files:**

- Create: `src/ops/slack-transport.ts`
- Create: `src/ops/slack-transport.test.ts`

**Read before writing.** This class is a **separate class from `SlackObligationPoster`** and the two are never merged (D6, epic canon: KPR-456's contract "does not supersede" and is not superseded). What is copied is the hardening, item for item, from `src/obligations/slack-post.ts:54-150`: the fixed `chat.postMessage` endpoint, `allowAbsoluteUrls: false`, `redirect: "error"`, the `x-slack-req-id` origin check, HTTP 200 **plus** `ok: true` **plus** a channel/ts shape check, `mrkdwn: false` / `parse: "none"` / `link_names: false` / no unfurl, and a bounded body. What is **not** copied is its `PostOutcome` type, its `NONACCEPTANCE` set as an import, or its `escapeSlack` — all three are re-declared here, because `src/ops/**` importing `src/obligations/**` is what chunk 6's isolation test forbids.

- [ ] **Step 1:** Create `src/ops/slack-transport.ts`.

```typescript
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
 * Slack channel ids only. The check's job is to catch a channel NAME
 * ("#ops"), a URL, or a user handle pasted where an id belongs — the actual
 * mis-registration — not to re-derive Slack's id grammar, because a check
 * stricter than the vendor UNLOADS a legitimate operator subscription (D6).
 */
const CHANNEL_ID = /^[CDG][A-Z0-9]{1,99}$/;

/** Bounded body. Not one of the spec's delegated numerics — an adapter payload bound. */
const MAX_BODY = 2_000;

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  getLevel: () => LogLevel.ERROR,
  setName() {},
} as unknown as WebClientOptions["logger"];

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Local, deliberately NOT imported from src/obligations/slack-post.ts. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

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
      if (error.code === ErrorCode.RequestError && String(error.message ?? "").includes("timeout")) {
        return { status: "unknown", reason: "timeout" };
      }
      // No raw error text is logged or returned — the reason is a closed-set token.
      log.warn("ops delivery uncertain", { adapterId: this.adapterId, code: String(error.code ?? "none") });
      return { status: "unknown", reason: "transport-fault" };
    }
  }
}
```

⚠ **Confirm `SLACK_POST_TIMEOUT_MS` landed in Task 1 Step 1** — it is in that step's constant block, beside `ATTEMPT_SPACING_MS`, and is the one constant in this file that lives in the shared types module rather than locally:

```bash
grep -n "SLACK_POST_TIMEOUT_MS" src/ops/notification-types.ts
```

- [ ] **Step 2:** Create `src/ops/slack-transport.test.ts`.

The suite drives the class through its injected `fetcher`, exactly as `src/obligations/slack-post.test.ts` drives KPR-456's poster — read that file for the response-shaping helpers before writing this one.

```typescript
import { describe, it, expect, vi } from "vitest";
import { SlackOpsTransport } from "./slack-transport.js";
import type { NotificationView } from "./transport.js";

const view = (over: Partial<NotificationView> = {}): NotificationView => ({
  handle: "65a1b2c3d4e5f60718293a4b",
  target: "C0123456",
  event: {
    producer: "hive-runtime",
    reasonId: "tool-failed",
    class: "resource",
    retry: "transient",
    waiting: "agent",
    subject: { kind: "tool", id: "gog" },
    generation: 0,
    dedupeKey: "hive-runtime:tool:gog:tool-failed:0",
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    detail: { tool: "gog", errorSig: "auth" },
    evidence: [],
  },
  ledger: {
    state: "pending",
    eventCount: 1,
    nudgeCount: 0,
    attemptCount: 0,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastEventAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  ...over,
});

const ENDPOINT = "https://slack.com/api/chat.postMessage";

function slackResponse(body: unknown, init: { status?: number; origin?: boolean } = {}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.origin !== false) headers.set("x-slack-req-id", "req-1");
  const response = new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  Object.defineProperty(response, "url", { value: ENDPOINT });
  return response;
}

describe("SlackOpsTransport.validateTarget (D6)", () => {
  const t = new SlackOpsTransport("xoxb-test", () => {});
  it("accepts a channel id and rejects the shapes an operator actually mis-registers", () => {
    expect(t.validateTarget("C0123456")).toBe(true);
    expect(t.validateTarget("D0123456")).toBe(true);
    expect(t.validateTarget("#ops")).toBe(false);
    expect(t.validateTarget("ops")).toBe(false);
    expect(t.validateTarget("https://slack.com/archives/C0123456")).toBe(false);
    expect(t.validateTarget("@may")).toBe(false);
    expect(t.validateTarget(undefined)).toBe(false);
    expect(t.validateTarget({ channelId: "C0123456" })).toBe(false);
  });
});

describe("SlackOpsTransport.deliver (D6, C8, C14)", () => {
  it("registers the echo on an accepted post and returns a reference, never a URL", async () => {
    const echo = vi.fn();
    const t = new SlackOpsTransport(
      "xoxb-test",
      echo,
      () => new Date(0),
      async () => slackResponse({ ok: true, channel: "C0123456", ts: "1725465600.000100" }),
    );
    const out = await t.deliver(view());
    expect(out).toEqual({
      status: "accepted",
      reference: { kind: "slackMessage", id: "C0123456:1725465600.000100" },
      at: new Date(0),
    });
    // Without this the post re-enters as a WorkItem and spawns a turn (C14).
    expect(echo).toHaveBeenCalledWith("C0123456", "1725465600.000100");
    expect(JSON.stringify(out)).not.toMatch(/https?:\/\//);
  });

  it("maps every allow-listed Slack code onto D6's closed set, and nothing else", async () => {
    const cases: Array<[string, string]> = [
      ["not_authed", "unauthenticated"],
      ["invalid_auth", "unauthenticated"],
      ["token_expired", "unauthenticated"],
      ["token_revoked", "unauthenticated"],
      ["missing_scope", "unauthorized"],
      ["no_permission", "unauthorized"],
      ["ekm_access_denied", "unauthorized"],
      ["restricted_action", "unauthorized"],
      ["channel_not_found", "target-unknown"],
      ["not_in_channel", "target-ineligible"],
      ["is_archived", "target-ineligible"],
      ["rate_limited", "refused-rate-limit"],
      ["ratelimited", "refused-rate-limit"],
    ];
    for (const [code, reason] of cases) {
      const t = new SlackOpsTransport(
        "xoxb-test",
        () => {},
        () => new Date(0),
        async () => slackResponse({ ok: false, error: code }),
      );
      expect(await t.deliver(view()), code).toEqual({ status: "rejected", reason });
    }
  });

  it("maps everything it cannot PROVE to unknown — never to rejected", async () => {
    // An unrecognized code is the case C8 turns on: an adapter that cannot
    // decide maps to `unknown`, never to `rejected`, because only `rejected`
    // would permit an automatic retry.
    const unrecognized = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async () => slackResponse({ ok: false, error: "some_new_slack_code" }),
    );
    expect((await unrecognized.deliver(view())).status).toBe("unknown");

    // A 200 that did not come from Slack's own endpoint (no x-slack-req-id).
    const spoofed = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async () => slackResponse({ ok: true, channel: "C0123456", ts: "1.1" }, { origin: false }),
    );
    expect((await spoofed.deliver(view())).status).toBe("unknown");

    // A malformed body supplies no nonacceptance evidence.
    const malformed = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async () => {
        const headers = new Headers({ "x-slack-req-id": "req-1" });
        const r = new Response("not json", { status: 200, headers });
        Object.defineProperty(r, "url", { value: ENDPOINT });
        return r;
      },
    );
    expect((await malformed.deliver(view())).status).toBe("unknown");

    // A transport throw.
    const thrown = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async () => {
        throw new Error("econnreset");
      },
    );
    expect((await thrown.deliver(view())).status).toBe("unknown");
  });

  it("never registers an echo on any non-accepted outcome", async () => {
    const echo = vi.fn();
    const t = new SlackOpsTransport(
      "xoxb-test",
      echo,
      () => new Date(0),
      async () => slackResponse({ ok: false, error: "channel_not_found" }),
    );
    await t.deliver(view());
    expect(echo).not.toHaveBeenCalled();
  });

  it("posts to the fixed endpoint with rendering disabled and no unfurl", async () => {
    let seenUrl = "";
    let body: Record<string, unknown> = {};
    const t = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async (url, init) => {
        seenUrl = String(url);
        body = Object.fromEntries(new URLSearchParams(String(init?.body)));
        return slackResponse({ ok: true, channel: "C0123456", ts: "1.1" });
      },
    );
    await t.deliver(view());
    expect(seenUrl).toBe(ENDPOINT);
    expect(body.mrkdwn).toBe("false");
    expect(body.parse).toBe("none");
    expect(body.link_names).toBe("false");
    expect(body.unfurl_links).toBe("false");
    expect(body.unfurl_media).toBe("false");
    expect(String(body.text).length).toBeLessThanOrEqual(2_000);
  });

  it("refuses an unvalidatable target before making any request", async () => {
    const fetcher = vi.fn();
    const t = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      fetcher as never,
    );
    expect(await t.deliver(view({ target: "#ops" }))).toEqual({ status: "rejected", reason: "target-unknown" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3:** Verify and commit.

```bash
npx vitest run src/ops/slack-transport.test.ts
npx tsc --noEmit
```

Expected: all cases pass; `tsc` exits 0.

**Also assert the separation by hand once, here, before chunk 6 automates it:**

```bash
grep -rn "obligations" src/ops/ || echo "OK — src/ops/ imports nothing from src/obligations/"
```

Expected: the `OK` line. A hit means the `escapeSlack`/`NONACCEPTANCE`/`PostOutcome` re-declaration was short-circuited by an import, which chunk 6's `notifier-isolation.test.ts` will fail on.

```bash
git add src/ops/slack-transport.ts src/ops/slack-transport.test.ts src/ops/notification-types.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): the Slack ops transport — vendor mapping, hardening, echo registration

D6: SlackOpsTransport, adapterId "slack", a separate class from KPR-456's
SlackObligationPoster with its hardening copied item for item and nothing
imported from src/obligations/. KPR-456's proven nonacceptance code list
projected onto D6's closed set with nothing added; payload-rejected has no
Slack mapping deliberately. Every accepted post registers its ts through
the echo callback (C14) and yields a reference, never a URL (C13).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
