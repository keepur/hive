import { describe, expect, it, vi } from "vitest";
import type { WebClientOptions } from "@slack/web-api";
import { NONACCEPTANCE, SlackObligationPoster } from "./slack-post.js";
import { SPEC_REFUSALS } from "./testing/refusals.js";

const ENDPOINT = "https://slack.com/api/chat.postMessage";
const now = () => new Date("2026-09-07T08:00:00.000Z");
const destination = { kind: "slack" as const, channelId: "C00000001", threadTs: "1725696000.000001" };
export function slackResponse(
  body: unknown,
  status = 200,
  provenance = true,
  retryAfter?: string,
  url = ENDPOINT,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (provenance) headers.set("x-slack-req-id", "fixture-request");
  if (retryAfter) headers.set("retry-after", retryAfter);
  const response = new Response(JSON.stringify(body), { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
describe("dedicated Slack obligation transport", () => {
  it("requires complete acknowledgement and records the echo with explicit threading", async () => {
    const fetcher = vi.fn(async (...args: Parameters<NonNullable<WebClientOptions["fetch"]>>) => {
      void args;
      return slackResponse({ ok: true, channel: destination.channelId, ts: "1.000001" });
    });
    const echo = vi.fn();
    const poster = new SlackObligationPoster("fixture-token", echo, () => true, now, fetcher);
    expect(await poster.post(destination, "complete text")).toEqual({
      kind: "acknowledged",
      ts: "1.000001",
      acknowledgedAt: now(),
    });
    expect(echo).toHaveBeenCalledWith(destination.channelId, "1.000001");
    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain("thread_ts");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(ENDPOINT);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
  it("pins exactly the thirteen approved refusal codes", () => {
    expect(SPEC_REFUSALS).toHaveLength(13);
    expect([...NONACCEPTANCE].sort()).toEqual([...SPEC_REFUSALS].sort());
  });
  it.each(SPEC_REFUSALS)("only retries authoritative refusal %s", async (error) => {
    const fetcher = vi.fn(async () => slackResponse({ ok: false, error }));
    const poster = new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher);
    expect((await poster.post(destination, "x")).kind).toBe("rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid_auth", "not_in_channel"])("does not treat raw text %s as a JSON refusal", async (body) => {
    const fetcher = vi.fn(async () => {
      const response = new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-slack-req-id": "fixture",
        },
      });
      Object.defineProperty(response, "url", { value: ENDPOINT });
      return response;
    });
    const echo = vi.fn();
    expect(
      await new SlackObligationPoster("fixture", echo, () => true, now, fetcher).post(destination, "x"),
    ).toMatchObject({ kind: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(echo).not.toHaveBeenCalled();
  });
  it("rejects a Slack 429 without SDK retries and honors Retry-After", async () => {
    const fetcher = vi.fn(async () => slackResponse({ ok: false, error: "ratelimited" }, 429, true, "120"));
    const result = await new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher).post(destination, "x");
    expect(result).toEqual({ kind: "rejected", reason: "rate_limited", retryAt: new Date(now().getTime() + 120_000) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["internal_error", "fatal_error", "service_unavailable", "new_future_code"])(
    "keeps %s unknown",
    async (error) => {
      const fetcher = vi.fn(async () => slackResponse({ ok: false, error }));
      const result = await new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher).post(
        destination,
        "x",
      );
      expect(result.kind).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [{ ok: true, channel: "C99999999", ts: "1" }, 200, true],
    [{ ok: true, channel: destination.channelId }, 200, true],
    [{ ok: true, ts: "1" }, 200, true],
    [{ ok: false, error: "invalid_auth" }, 200, false],
    [{ ok: false, error: "invalid_auth" }, 502, true],
    [{ ok: false, error: "ratelimited" }, 429, false],
  ] as const)("defaults malformed/proxy/unproven response to unknown", async (body, status, provenance) => {
    const fetcher = vi.fn(async () => slackResponse(body, status, provenance));
    const poster = new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher);
    expect((await poster.post(destination, "x")).kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["https://proxy.invalid/api/chat.postMessage", "https://slack.com/api/other"])(
    "requires the exact response URL for an allowlisted body from %s",
    async (url) => {
      const fetcher = vi.fn(async () => slackResponse({ ok: false, error: "invalid_auth" }, 200, true, undefined, url));
      const echo = vi.fn();
      expect(
        await new SlackObligationPoster("fixture", echo, () => true, now, fetcher).post(destination, "x"),
      ).toMatchObject({ kind: "unknown" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(echo).not.toHaveBeenCalled();
    },
  );
  it("rejects a redirect at the physical fetch boundary without retry", async () => {
    const fetcher = vi.fn(async (...args: Parameters<NonNullable<WebClientOptions["fetch"]>>) => {
      expect(String(args[0])).toBe(ENDPOINT);
      expect(args[1]).toMatchObject({ redirect: "error" });
      throw new TypeError("fetch failed: unexpected redirect");
    });
    const echo = vi.fn();
    expect(
      await new SlackObligationPoster("fixture", echo, () => true, now, fetcher).post(destination, "x"),
    ).toMatchObject({ kind: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(echo).not.toHaveBeenCalled();
  });
  it("does not retry timeout or send through an engaged identity guard", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("timeout");
    });
    const poster = new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher);
    expect((await poster.post(destination, "x")).kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const blocked = new SlackObligationPoster("fixture", vi.fn(), () => false, now, fetcher);
    expect((await blocked.post(destination, "x")).kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
