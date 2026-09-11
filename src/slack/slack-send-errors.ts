/**
 * KPR-492 D2: turn a Slack failure into text that names the remedy.
 *
 * `postSingle` used to swallow the Slack error and `postAndRegister` reported
 * the useless `"postMessage returned no ts"`, so an agent asking "why did my
 * message not land?" got a sentence about a missing timestamp instead of
 * `not_in_channel`. This module is the other half: a pure, dependency-free
 * mapper over Slack's error codes.
 *
 * `handleSend` runs BOTH failure sources through it — the resolver's reason on
 * the 400 path and the post sink's error on the 500 path. Four of the codes
 * below (`cannot_dm_bot`, `user_not_found`, `user_disabled`, `users_not_found`)
 * are raised by `conversations.open` / `users.lookupByEmail` INSIDE the resolver
 * and never reach a `chat.postMessage` sink at all, so mapping only the sink
 * would leave them permanently unreachable.
 *
 * The mapper is ADDITIVE, never lossy: an unmapped Slack code and a
 * hive-authored resolver reason (ambiguity, "is a person, not a channel",
 * "unknown channel: …") both pass through verbatim.
 */

/** The in-repo tighter DM-id shape (precedent: slack-gateway.ts:653, :661, :712). */
const DM_ID = /^D[A-Z0-9]+$/;

/**
 * @param target the string the AGENT supplied (`#dev`, `@lauren`, `D0123…`).
 * @param raw    the Slack error string as written by the sink or the resolver —
 *   `String(err)` on a `@slack/web-api` platform error is
 *   `"Error: An API error occurred: <code>"`; the in-repo fixture at
 *   `slack-internal-api.test.ts:346` uses the bare `message` form
 *   `"An API error occurred: <code>"`. Every row below matches the CODE as a
 *   substring and never depends on the prefix (spec D2, "error-string format, pinned").
 *
 * Two arguments, by construction (spec D2, round 5). Rounds 2–4 carried a third
 * `resolvedId` parameter that no row read, kept on the argument that it made the
 * `channel_not_found` row's keying-on-`target` testable. It did not: the negative
 * case — an `@lauren` target whose post failed `channel_not_found` must NOT get
 * the DM advice — is fully expressible against this signature, and a parameter
 * the function cannot see cannot be mis-keyed on. Code-enforce, don't
 * prose-enforce: the wrong branch is unrepresentable rather than tested-for.
 * (The dead parameter lint-passed only because `no-unused-vars` defaults to
 * `after-used`, `eslint.config.js:12` — a warning that never fired.)
 */
export function describeSendFailure(target: string, raw: string): string {
  const advice = adviceFor(target, raw);
  return advice ? `${advice} (slack error: ${raw})` : raw;
}

function adviceFor(target: string, raw: string): string | undefined {
  if (raw.includes("not_in_channel")) {
    return `the hive bot is not a member of ${target} — invite it to that channel (the bot transport does not post to channels it has not joined)`;
  }
  if (raw.includes("channel_not_found")) {
    // Keys on TARGET — the only id this function can see. A user-form send
    // (@lauren, U…, an email) resolves THROUGH conversations.open to a legitimate
    // D… id, and advice keyed on that id would tell an agent its own freshly-opened
    // DM "is between two other people". The message fires only when the agent
    // actually handed in a raw D…, which is the one case where it is true.
    return DM_ID.test(target)
      ? `${target} is a DM between two other people — address the person directly (@handle, U…, or their email) so the bot opens its own DM`
      : `no channel or conversation ${target} is visible to the hive bot — check the name, or invite the bot if it is private`;
  }
  if (raw.includes("is_archived")) return `${target} is archived`;
  if (raw.includes("cannot_dm_bot")) return `${target} resolves to a bot user; bots cannot DM bots`;
  // Three codes, two methods, one remedy. Spec D2's table is PROVENANCE — one row
  // per code, naming the method that emits it and the rung it runs at — and this
  // branch is a MATCHER that folds the rows sharing a remedy. Do not "fix" it to
  // one-to-one, and do not add a code here without a D2 row naming the emitting
  // call. The rows: `users.lookupByEmail` (rung 4) fails the PLURAL
  // `users_not_found` for an unknown email — and
  // `"users_not_found".includes("user_not_found")` is FALSE (the `s` breaks the
  // substring), so matching the singular alone left spec edge 9 unmapped on the DM
  // surface this ticket was reprioritized around (plan-review round 3, blocking 1);
  // `conversations.open` (rung 3; rung 5 only via a stale map entry) fails the
  // singular `user_not_found` for a well-formed id no user carries and
  // `user_disabled` for a deactivated one — and `user_disabled` ALSO carries the
  // rung-4 deactivated-by-email path, because `lookupByEmail` RETURNS a deactivated
  // member (`deleted: true`) rather than erroring, so `openIm` is what fails. All
  // three are vendor strings nothing in this repo can verify: Task 0 Step 3b's live
  // probes confirm them, and a probe returning a different code is a one-line edit
  // here plus a D2 row. `user_is_deleted` (round 3's fourth substring) is
  // deliberately NOT matched: no D2 row claims it, no method is known to emit it,
  // and an unmatched code passes through verbatim anyway (the additive rule
  // below), so an agent would still read it.
  if (raw.includes("users_not_found") || raw.includes("user_not_found") || raw.includes("user_disabled")) {
    return `no active Slack user matches ${target}`;
  }
  if (raw.includes("missing_scope")) {
    return `the hive Slack app is missing a scope for this send — see the boot scope preflight`;
  }
  if (raw.includes("ratelimited")) return `Slack rate-limited this send; retry shortly`;
  return undefined;
}
