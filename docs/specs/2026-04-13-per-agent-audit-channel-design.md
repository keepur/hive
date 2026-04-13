# Per-Agent Audit Channel

## Problem

Every non-Slack conversation (SMS, iMessage, WS/app, WebSocket) emits an audit log to Slack so humans can read the transcript. Today there is **one global audit channel** — `config.slack.auditChannel`, currently set to `jessica`. All audit logs land in `#agent-jessica` regardless of which agent actually handled the message.

This was fine when Jessica was the only agent handling external traffic. It breaks now that multiple agents do:

- Sige handles the dodi-shop iOS app (KPR-10 origin routing, live 2026-04-13).
- Rae/Milo handle SMS.
- Future agents will handle more origins.

Observed during KPR-10 testing: May sent a message from the shop app, Sige responded correctly, and the audit log posted to `#agent-jessica`. Wrong channel for "what's Sige doing today."

## Goal

**Audit logs follow the agent.** Whoever handled the message gets the audit mirror in their own channel. No manual per-origin configuration.

## Non-goals

- Changing the audit *payload* format (sender, summary, cost, duration all stay the same).
- Per-origin audit routing (e.g. shop-app → channel A, SMS → channel B). The origin is a routing concern; audit follows the agent.
- Auditing Slack-sourced conversations. Slack messages already live in their original channel — audit mirroring is only for non-Slack sources (`sms`, `imessage`, `app`, `team`, `scheduler`).

## Design

### Source of truth: `agent.homeBase`

Every agent definition already has a `homeBase` field (KPR-6) naming their primary Slack channel. All 10 active agents have it set:

```
chief-of-staff → agent-mokie
customer-success → agent-jessica
executive-assistant → agent-rae
marketing-manager → agent-river
product-manager → agent-chloe
product-specialist → agent-wyatt
production-support → agent-sige
sdr → agent-milo
vp-engineering → agent-jasper
nora → agent-nora
```

No schema change needed. `homeBase` is the per-agent audit channel.

### Resolution

At startup, `src/index.ts` currently resolves the single configured channel name to a channel ID via `conversations.list`. Replace with a map built at startup:

```ts
// src/index.ts, around line 272
const channels = await slackClient.conversations.list({ ... });
const channelIdByName = new Map<string, string>(
  (channels.channels ?? []).map((c: any) => [c.name, c.id]),
);
dispatcher.setAuditChannelResolver(slackAdapter, channelIdByName);
```

Pass the whole name→ID map into the dispatcher, not a single ID.

### Dispatcher changes

Replace the single-channel field with a resolver:

```ts
// src/channels/dispatcher.ts
private auditAdapter?: ChannelAdapter;
private auditChannelIds?: Map<string, string>; // channelName → channelId
private fallbackAuditChannelId?: string;        // optional global fallback

setAuditChannelResolver(
  adapter: ChannelAdapter,
  channelIdByName: Map<string, string>,
  fallbackChannelId?: string,
): void {
  this.auditAdapter = adapter;
  this.auditChannelIds = channelIdByName;
  this.fallbackAuditChannelId = fallbackChannelId;
}
```

In `postAuditLog`:

```ts
const agentConfig = this.registry.get(result.agentId);
const homeBase = agentConfig?.homeBase;
const channelId =
  (homeBase && this.auditChannelIds?.get(homeBase)) ??
  this.fallbackAuditChannelId;

if (!channelId) {
  log.warn("No audit channel for agent", {
    agentId: result.agentId,
    homeBase,
  });
  return;
}
```

Then use `channelId` in the `auditItem.source.id` instead of `this.auditChannelId`.

### Fallback behavior

- Agent has `homeBase` that resolves to a known channel → post there. (All current agents hit this path.)
- Agent has `homeBase` but Slack lookup missed (channel renamed/deleted) → fall back to global `slack.auditChannel` if set, else skip with a warning.
- Agent has no `homeBase` at all → same fallback path.

Global `slack.auditChannel` in `hive.yaml` becomes the **fallback**, not the primary. We can leave it set to `jessica` during the transition and later unset it if desired.

### Skip rule: don't mirror to the same channel

If the source message already came from the agent's own Slack channel (rare for non-Slack sources, but possible for `team` channels backed by Slack DMs), skip the audit — it would be a duplicate in the same channel. Current code doesn't guard this because the global channel was always different from the source channel. Add:

```ts
if (result.workItem.source.kind === "slack" && result.workItem.source.id === channelId) {
  return;
}
```

Keep current guard: audit only fires for non-Slack sources in the first place (check existing `postAuditLog` call site).

## Files to change

- `src/channels/dispatcher.ts` — replace `auditChannelId` with map-based resolver; update `postAuditLog` to pick per-agent channel.
- `src/index.ts` — build name→ID map from `conversations.list`, pass to `setAuditChannelResolver` along with optional fallback ID.
- `src/channels/dispatcher.test.ts` — tests for:
  - audit lands in agent's `homeBase` channel
  - falls back to global channel when `homeBase` is missing/unresolvable
  - skips when neither is available
  - still uses existing payload format (icon, summary, cost)

## Out of scope / follow-ups

- **Auditing channel renames at runtime.** The name→ID map is built once at startup. If a Slack channel is renamed mid-session, audits for that agent will fall back. Acceptable — channel renames are rare and a Hive restart fixes it.
- **Retiring the global `slack.auditChannel` config.** Leave it in place as a fallback. Deletion can happen later once we're confident every agent has a resolvable `homeBase`.
- **Per-origin audit fan-out.** If someone later wants shop-app audits mirrored to *both* Sige's channel and a shared `#shop-transcripts`, that's a separate feature — not this one.

## Testing

1. Unit: dispatcher tests above.
2. Manual: send message from dodi-shop iOS → verify audit appears in `#agent-sige`, not `#agent-jessica`.
3. Manual: send SMS to Rae → verify audit appears in `#agent-rae`.
4. Manual: temporarily set an agent's `homeBase` to a bogus channel name → verify audit falls back to global and logs the warning.

## Risk

Low. Change is additive on the read side (resolver lookup), and the fallback preserves existing behavior for any edge case. Worst case: a misconfigured agent drops its audit — detectable by the warn log.
