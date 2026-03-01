# User Story: Channel-Agnostic Agent Architecture

## Story

**As a** Hive owner,
**I want** my agents to handle work from any channel (SMS, email, Slack, etc.) without routing everything through Slack,
**So that** agents can respond directly through the source channel (text back via SMS, reply to email), Slack is just my conversation channel with the hive, and adding new integrations doesn't require rearchitecting the system.

## Acceptance Criteria

1. **SMS flows directly**: When someone texts the Quo number, the assigned agent processes it and replies via SMS — no Slack roundtrip. The owner sees an audit log in Slack showing what happened.

2. **Slack still works**: DMs to Hive, channel messages, assistant thread events — all work exactly as before. Agents respond in threads, suggested prompts appear, thinking indicators show.

3. **Channel-agnostic agent core**: Agents receive a `WorkItem` (text + source + sender) and return a text response. They don't know or care whether it came from Slack, SMS, or email. The framework handles delivery.

4. **Audit visibility**: When an agent handles work from a non-Slack channel, a summary is posted to an audit channel in Slack (e.g., ":phone: Rae replied to SMS from John Smith: 'Your cabinets are ready...'").

5. **Escalation path**: If an agent doesn't know how to handle something, it can escalate to the owner via Slack instead of replying to the source.

6. **Session continuity**: Multi-turn conversations work per-channel. An SMS thread with a contact maintains context across messages. A Slack thread maintains context. Sessions are keyed by channel-agnostic thread IDs.

7. **Scheduled tasks unaffected**: Cron jobs fire agents with `WorkItem` payloads. No Slack dependency for scheduled work.

8. **Builds at every phase**: Each implementation phase produces a compilable, runnable system. No big-bang cutover.

## Out of Scope

- Email adapter (Gmail via gog) — future, but architecture supports it
- ClickUp/Linear adapter — future
- Multi-channel streaming (real-time token streaming is Slack-only for now)
- Changes to MCP servers or agent prompts (agents are already tool-capable)
