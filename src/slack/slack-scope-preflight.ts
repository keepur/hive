import { createLogger } from "../logging/logger.js";

const log = createLogger("slack-scope-preflight");

// chat:write.customize is required by slack-adapter's identity-mode delivery path
// (SlackGateway.postSingle passes `username`/`icon_url` to chat.postMessage when the
// adapter supplies an identity). Without it, identity-mode posts silently fall back
// to plain bot posts — preflight here fails loud rather than degrading silently.
export const REQUIRED_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
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
    throw new Error(`Slack auth.test failed: ${body.error ?? "unknown"}`);
  }
  const header = res.headers.get("x-oauth-scopes") ?? "";
  const granted = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = required.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    throw new Error(`Slack bot token missing required scopes: ${missing.join(", ")}`);
  }
  log.info("Slack scope preflight passed", { required: [...required] });
}
