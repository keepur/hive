# Implementation Roadmap: Channel-Agnostic Architecture

## Design Summary

Replace the current Slack-centric message flow with a channel-agnostic architecture. A new `Dispatcher` receives `WorkItem` objects from channel adapters (Slack, SMS, future: email, ClickUp), resolves the right agent, sends the work to `AgentManager`, and delivers the response back through the source channel adapter.

**Key decisions:**
- `WorkItem` is a plain data object (not a callback) — serializable, loggable, retryable
- Thread IDs are channel-agnostic strings (`sms:{phoneId}:{contact}`, `slack:{channel}:{threadTs}`)
- Agent responses are auto-delivered by the framework. Agents don't call channel-specific tools to reply.
- `SlackGateway` survives unchanged — `SlackAdapter` wraps it
- Routing logic (name/channel/keyword/default) is extracted from `MessageRouter` into `Dispatcher`

## Implementation Phases

### Phase 1: Core types
**Risk: None** — additive only, no behavior change.
- New `WorkItem`, `WorkResult`, `ChannelRef` types
- Bridge function `fromIncomingMessage()` for gradual migration
- Rename `threadTs` → `threadId` in SessionStore

### Phase 2: Dispatcher + ChannelAdapter interface
**Risk: None** — dead code until wired.
- `ChannelAdapter` interface definition
- `Dispatcher` with routing logic extracted from `MessageRouter`

### Phase 3: AgentManager migration
**Risk: Low** — same data, different shape. Bridge function preserves behavior.
- `AgentManager.sendMessage()` accepts `WorkItem`
- Existing callers use `fromIncomingMessage()` bridge
- Scheduler builds `WorkItem` directly

### Phase 4: SMS Adapter
**Risk: Medium** — changes SMS flow. Slack path unchanged.
- `SmsAdapter`: Quo polling + SMS reply delivery
- Wire into Dispatcher. SMS no longer touches Slack.
- Audit log posts to Slack after agent responds.
- Delete `SmsPoller`.

### Phase 5: Slack Adapter
**Risk: Medium** — changes Slack message flow to use same Dispatcher pattern.
- `SlackAdapter`: wraps `SlackGateway`, converts events ↔ `WorkItem`
- Moves assistant thread UX (prompts, status) into adapter
- Delete `MessageRouter`.

### Phase 6: Cleanup
**Risk: None** — remove deprecated code.
- Remove `IncomingMessage` type and bridge function
- Clean up `index.ts` wiring

## Dependencies

```
Phase 1 ──▶ Phase 3 ──▶ Phase 4
Phase 2 ──▶ Phase 4
Phase 2 ──▶ Phase 5
Phase 3 ──▶ Phase 5
Phase 5 ──▶ Phase 6
Phase 4 ──▶ Phase 6
```

Phases 1 and 2 can run in parallel. Phases 4 and 5 can run in parallel (after 2+3 complete). Phase 6 runs last.

## Risks

1. **Session key migration**: Old sessions keyed by `{agentId}:{threadTs}`, new by `{agentId}:{threadId}`. Mitigated by fallback lookup in `SessionStore.get()` — try new format first, fall back to old. Old sessions expire via 7-day TTL.

2. **SMS double-reply**: Agent might use `quo_send_sms` tool AND framework auto-delivers. Mitigated by system prompt context: agent is told its response will be sent automatically. `quo_send_sms` remains available for proactive outreach to *different* numbers.

3. **Integration channel filtering**: Current `SlackGateway` has `integrationChannels` set for bot messages. With SMS off Slack, the `quo-may` channel no longer needs integration filtering. The `SlackAdapter` manages this.
