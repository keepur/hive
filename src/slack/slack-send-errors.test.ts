import { describe, it, expect } from "vitest";
import { describeSendFailure } from "./slack-send-errors.js";

// D2's pinned format: `String(err)` on a @slack/web-api platform error. Every
// Slack-sourced fixture uses THIS shape so the match cannot silently drift to
// the bare-`message` shape; one case below uses the bare shape on purpose.
const slack = (code: string) => `Error: An API error occurred: ${code}`;

describe("describeSendFailure (KPR-492 D2)", () => {
  it("maps not_in_channel to an invite remedy and keeps the raw string", () => {
    const out = describeSendFailure("#dev", slack("not_in_channel"));
    expect(out).toContain("not a member of #dev");
    expect(out).toContain("invite it");
    expect(out).toContain("not_in_channel");
  });

  it("maps channel_not_found on a raw D… TARGET to the address-the-person remedy", () => {
    const out = describeSendFailure("D0123ABCD", slack("channel_not_found"));
    expect(out).toContain("between two other people");
    expect(out).toContain("@handle");
  });

  it("does NOT give DM advice for an @handle target whose post failed channel_not_found (keys on target — there is no resolved id to key on)", () => {
    // The two-argument negative test (spec D2, round 5). The post behind this
    // failure went to a D… the resolver opened; the mapper never sees it.
    const out = describeSendFailure("@lauren", slack("channel_not_found"));
    expect(out).not.toContain("between two other people");
    expect(out).toContain("visible to the hive bot");
  });

  it("maps channel_not_found on a name to the check-the-name remedy", () => {
    const out = describeSendFailure("dev", slack("channel_not_found"));
    expect(out).toContain("no channel or conversation dev is visible");
  });

  it("maps is_archived", () => {
    expect(describeSendFailure("#old", slack("is_archived"))).toContain("#old is archived");
  });

  it("maps cannot_dm_bot on a U… target (raised inside the resolver at rung 3, never at a post sink)", () => {
    // A U… is the only shape that reaches conversations.open with a bot user:
    // rung 5's map skips is_bot, so a bot @handle MISSES instead (spec D2, §9 —
    // round 7). An @handle fixture would feed the rung a code it cannot emit.
    expect(describeSendFailure("U0HIVEBOT", slack("cannot_dm_bot"))).toContain("bots cannot DM bots");
  });

  it("maps users_not_found — the PLURAL, users.lookupByEmail's real code for an unknown email (rung 4)", () => {
    // Plan-review round 3, blocking 1: the singular-only branch left this
    // unmapped, and "users_not_found".includes("user_not_found") is false.
    const out = describeSendFailure("a@b.com", slack("users_not_found"));
    expect(out).toContain("no active Slack user matches a@b.com");
    expect(out).toContain("users_not_found");
  });

  it("maps user_not_found on a U… target — conversations.open's code for a well-formed id no user carries (rung 3)", () => {
    // One test per D2 row, each fixture shaped like the target its row's rung
    // accepts (spec §9, round 6). A U… is what conversations.open receives; the
    // email rung never emits this singular (its miss is the plural, tested above).
    const out = describeSendFailure("U0GONE", slack("user_not_found"));
    expect(out).toContain("no active Slack user matches U0GONE");
    expect(out).toContain("user_not_found");
  });

  it("maps user_disabled on a U… target AND on an email target — conversations.open's deactivated-user code, reached at rung 3 and via the rung-4 deactivated-by-email path", () => {
    // Rung 4: users.lookupByEmail RETURNS a deactivated member (deleted: true)
    // rather than erroring, so the email path reaches openIm and it is
    // conversations.open that fails. One row, two target shapes (spec D4, round 6).
    expect(describeSendFailure("U0DEAD", slack("user_disabled"))).toContain("no active Slack user matches U0DEAD");
    const out = describeSendFailure("gone@dodihome.com", slack("user_disabled"));
    expect(out).toContain("no active Slack user matches gone@dodihome.com");
    expect(out).toContain("user_disabled");
  });

  it("maps missing_scope and ratelimited", () => {
    expect(describeSendFailure("@lauren", slack("missing_scope"))).toContain("missing a scope");
    expect(describeSendFailure("#dev", slack("ratelimited"))).toContain("rate-limited");
  });

  it("matches the CODE, not the prefix — the bare `message` shape maps too (slack-internal-api.test.ts:346 precedent)", () => {
    const out = describeSendFailure("#dev", "An API error occurred: not_in_channel");
    expect(out).toContain("invite it");
    expect(out).toContain("not_in_channel");
  });

  it("passes an unmapped Slack code through verbatim", () => {
    const raw = slack("some_new_slack_error");
    expect(describeSendFailure("#dev", raw)).toBe(raw);
  });

  it("passes a hive-authored resolver reason through verbatim (the mapper is additive)", () => {
    const raw = 'ambiguous — 2 users match "sam": @sam, @samantha (use their @handle, user id, or email)';
    expect(describeSendFailure("@sam", raw)).toBe(raw);
    expect(describeSendFailure("no-such", "unknown channel: no-such")).toBe("unknown channel: no-such");
  });
});
