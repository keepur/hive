# Two-Turn Dispatch — User Story

## Story

**As** a user messaging an agent on Slack or SMS,
**I want** an immediate acknowledgment when my request requires research or tool use,
**so that** I know the agent received my message and is working on it (instead of 1-4 minutes of silence).

**As** the system operator,
**I want** simple messages (greetings, thanks, yes/no) handled cheaply by Haiku,
**so that** we don't waste Sonnet budget on trivial interactions.

## Acceptance Criteria

1. **Simple messages** (greetings, confirmations, chit-chat) get a single fast response from Haiku (~1s, ~$0.001) — no Sonnet invocation
2. **Complex messages** (questions needing lookups, tasks, analysis) get an immediate ack posted to Slack, followed by the full agent response
3. **Non-interactive sources** (scheduler, background tasks, meetings, internal) bypass triage entirely — existing single-turn flow
4. **Thread continuity** works: messages in existing threads default to "continue" (agent needs session context)
5. **Triage failures** never block the full agent — errors fall through gracefully
6. **Kill switch**: `TRIAGE_ENABLED=false` disables triage globally, reverting to single-turn behavior
7. **Agent personality**: triage responses match the agent's character (uses soul/personality)
8. **Logging**: triage decisions logged with agent ID, action, cost, duration

## Out of Scope

- Background agent sessions (bg_agent) — future work
- Streaming responses — explicitly rejected (Slack streaming was problematic)
- Triage for non-interactive channels — these don't need it
- Per-agent triage enable/disable — global switch is sufficient for now
