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
    const unrecognized = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async () => slackResponse({ ok: false, error: "some_new_slack_code" }),
    );
    expect((await unrecognized.deliver(view())).status).toBe("unknown");

    const spoofed = new SlackOpsTransport(
      "xoxb-test",
      () => {},
      () => new Date(0),
      async () => slackResponse({ ok: true, channel: "C0123456", ts: "1.1" }, { origin: false }),
    );
    expect((await spoofed.deliver(view())).status).toBe("unknown");

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

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "an Object.prototype key (`%s`) as the Slack error code is unknown, never a nonacceptance",
    async (code) => {
      // ⚠ THE ABLE-TO-FAIL CASE for `in` versus hasOwnProperty: `in` walks the
      // prototype chain, so these read as members of the closed set and map to
      // `rejected` with a FUNCTION as the reason.
      const t = new SlackOpsTransport(
        "xoxb-test",
        () => {},
        () => new Date(0),
        async () => slackResponse({ ok: false, error: code }),
      );
      expect(await t.deliver(view())).toEqual({ status: "unknown", reason: "transport-fault" });
    },
  );

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
