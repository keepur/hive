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
] as const;

export async function preflightBotScopes(
  botToken: string,
  required: readonly string[] = REQUIRED_BOT_SCOPES,
): Promise<void> {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
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
