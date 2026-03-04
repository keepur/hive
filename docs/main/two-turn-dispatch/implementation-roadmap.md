# Two-Turn Dispatch — Implementation Roadmap

## Design Summary

Every interactive message (Slack/SMS) passes through a fast Haiku triage before reaching the full agent. Triage is a standalone, disposable query — not part of the agent's session history.

### Technical Decisions

- **Triage model**: Haiku (`claude-haiku-4-5-20251001`) — fastest, cheapest
- **Triage is sessionless**: Uses `query()` with `tools: []`, `maxTurns: 1`, `persistSession: false`, no MCP servers
- **Structured output**: JSON `{ response, action }` with robust fallback parsing
- **Personality via soul**: Triage system prompt includes agent's `soul` (personality) but NOT full system prompt, memory, or constitution
- **Thread awareness**: Messages in existing threads bias toward `continue`

### UX Flow

```
User sends "good morning"       → Haiku: "Morning!" (done, $0.001, ~1s)
User sends "check my calendar"  → Haiku: "On it..." (ack, ~1s) → Sonnet: [full response]
Scheduler fires cron job         → Skip triage → Sonnet: [full response]
```

## Implementation Phases

### Phase 1: Config + Types (small, isolated)
- Add `triage` config block to `config.ts`
- Add `triageModel?` to `AgentConfig` interface
- Parse `triageModel` in `agent-registry.ts`

### Phase 2: Triage Module (standalone, testable)
- Create `src/agents/triage.ts`
- Haiku query with structured output
- JSON parse with fallback chain
- Timeout and error handling

### Phase 3: Dispatcher Integration (main change)
- Insert triage gate in `dispatch()` after agent resolution
- Handle `done` (deliver + return) and `continue` (deliver ack + proceed)
- Thread status management
- Task ledger compatibility

## Dependencies

- Claude Agent SDK `query()` — already imported in agent-runner.ts
- Haiku model availability — standard Anthropic API
- Task ledger merge — completed (Part 1 of this plan)

## Risks

- **SDK cold-start latency**: Each `query()` may spawn a subprocess. Mitigated by 10s timeout.
- **Haiku JSON compliance**: May wrap JSON in markdown fences. Mitigated by fallback parser.
- **Double-posting in assistant threads**: Slack AI Apps panel may render differently. Test needed.
