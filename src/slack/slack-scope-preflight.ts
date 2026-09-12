import { createLogger } from "../logging/logger.js";

const log = createLogger("slack-scope-preflight");

// Scopes the local Slack MCP / slack-adapter benefit from when present.
// `chat:write.customize` enables identity-mode posts (per-agent username/icon);
// without it, posts silently fall back to plain bot identity. The preflight
// surfaces missing scopes as a warning rather than a fatal error — a single
// optional Slack feature should not crash hive startup.
//
// `chat:write.public` (post to channels the bot isn't a member of) is
// intentionally NOT required: least-privilege default is "agents only act in
// channels they're invited to." Operators who want broader posting can grant
// it to their app and add it to their own required list if they care.
export const REQUIRED_BOT_SCOPES = [
  "chat:write",
  "chat:write.customize",
  "channels:history",
  "channels:read",
  "users:read",
  // KPR-492 D4: engine code now calls conversations.open (im:write) and
  // users.lookupByEmail (users:read.email) on the send path. This is the
  // engine's DECLARED list, a subset of what setup/slack-manifest.yaml grants
  // (the manifest already carried im:write; D11 adds users:read.email there) —
  // slack-scope-preflight.test.ts pins the manifest as a superset of this list.
  // `im:history` is deliberately NOT here (spec §3, §5.3): the manifest grants
  // it, but the engine does not depend on it — reading DM history is a
  // non-goal, and it is why slack_read_channel does not get the user rungs.
  "im:write",
  "users:read.email",
] as const;

/**
 * KPR-492 D10: bound for the single `auth.test` diagnostic. A module constant,
 * not config — this is a bug fix, not a lever. 10 s matches the in-repo idiom
 * for a bounded outbound fetch (`admin-mcp-server.ts:311`, `grok-oauth.ts:27`)
 * and the dispatcher's own `connect: { timeout: 10_000 }`, so the post-handshake
 * phase gets a bound of the same magnitude as the handshake instead of 30× it.
 * No retry: retrying a diagnostic multiplies the worst-case boot delay.
 * Exported so the test can pin the production value.
 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * `timeoutMs` is a TEST SEAM, not configuration (spec D10, round 5). It exists
 * because the stall test cannot be driven any other way: `AbortSignal.timeout()`
 * schedules on Node's internal timer machinery and makes zero calls to
 * `globalThis.setTimeout`, so `vi.useFakeTimers()` never advances it — a
 * fake-timer test either waits the real 10 s (past vitest's cap) or never fires.
 * Shaped like the existing optional `required` parameter: trailing, defaulted to
 * the constant. index.ts keeps calling this with ONE argument. No hive.yaml key,
 * no env var, no doctor line — a reader reaching for a knob should stop here.
 */
export async function preflightBotScopes(
  botToken: string,
  required: readonly string[] = REQUIRED_BOT_SCOPES,
  timeoutMs: number = PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  // KPR-492 D10: BOTH halves, together. The try/catch stops a DNS/TLS rejection
  // from exiting main() (index.ts awaits this unguarded and the module tail is
  // `main().catch(… process.exit(1))` — a crash-loop under launchd KeepAlive).
  // The AbortSignal lives INSIDE the try so its TimeoutError DOMException lands
  // in the very same handler, closing the stall path a try/catch is blind to.
  // One signal covers `res.json()` too: the WHATWG/undici contract keeps it live
  // until the body is consumed. This honours the function's own header contract
  // — "a single optional Slack feature should not crash hive startup".
  //
  // `res` is declared OUTSIDE the try because `:36` reads
  // `res.headers.get("x-oauth-scopes")` after the parse. The bare
  // `let res: Response;` needs NO `!` assertion and NO `| undefined` widening:
  // the catch returns unconditionally, so TypeScript's control-flow analysis
  // proves definite assignment at the read. Verified under --strict on the
  // repo's own tsc 6.0.3 at 46d3d9d — do not "fix" it.
  // Do NOT widen the try to the whole function: that would silently convert a
  // future logic bug in the scope comparison into a "Slack unreachable" warning.
  let res: Response;
  let body: { ok: boolean; error?: string };
  try {
    res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = (await res.json()) as { ok: boolean; error?: string };
  } catch (err) {
    log.warn("Slack auth.test unreachable — skipping scope preflight", { error: String(err) });
    return;
  }
  if (!body.ok) {
    log.warn("Slack auth.test failed — skipping scope preflight", { error: body.error ?? "unknown" });
    return;
  }
  const header = res.headers.get("x-oauth-scopes") ?? "";
  const granted = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = required.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    log.warn("Slack bot token missing recommended scopes — some features may degrade silently", {
      missing,
      required: [...required],
      note: "Identity-mode posts fall back to plain bot identity if chat:write.customize is missing. Grant the scope and reinstall the app to enable it.",
    });
    return;
  }
  log.info("Slack scope preflight passed", { required: [...required] });
}
