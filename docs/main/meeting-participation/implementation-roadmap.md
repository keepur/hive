# Implementation Roadmap: Real-Time Meeting Participation

## Design Summary

New host-side service (`MeetingMonitor`) that polls Recall.ai transcript API every 15s, batches new segments, and dispatches them as WorkItems every 30s to the originating agent/thread. Two new MCP tools (`recall_join_meeting`, `recall_send_chat`) enable agents to start active participation and send chat messages into meetings.

**Key decisions:**
- Own HTTP server on port 3101 (separate from BackgroundTaskManager on 3100)
- Polling-based (no webhooks — avoids needing a public endpoint)
- 15s poll / 30s dispatch batching — balances responsiveness vs cost (~$0.50-2.00/hour meeting)
- Transcript diffing by segment index (Recall API returns ordered, append-only array)
- Agent decides when to chime in — system prompt guidance, not code logic

## Implementation Phases

### Phase 1: Config + Core Service (parallelizable)

| Stream | Files | Description |
|--------|-------|-------------|
| A: Config | `src/config.ts`, `.env.example` | Add `recall.monitorPort` |
| B: MeetingMonitor | `src/recall/meeting-monitor.ts` | New file: HTTP server, polling, transcript diffing, WorkItem dispatch |
| C: MCP Tools + Wiring | `src/recall/recall-mcp-server.ts`, `src/agents/agent-runner.ts` | Add tools + pass env vars |

Streams A, B, and C are independent.

### Phase 2: Integration (depends on Phase 1)

| Stream | Files | Description |
|--------|-------|-------------|
| D: Index wiring | `src/index.ts` | Instantiate MeetingMonitor, wire to dispatcher, shutdown |
| E: Agent prompts | `agents-templates/chief-of-staff/system-prompt.md.tpl` | Meeting participation guidance |

### Phase 3: Verification

1. `npm run build` — TypeScript compilation
2. `curl http://127.0.0.1:3101/meetings` — MeetingMonitor responds
3. Regenerate agents, restart Hive
4. End-to-end: ask Mokie to join a test Zoom meeting

## Dependencies

- Recall.ai account with API key (already configured)
- No new npm packages needed
- Follows existing patterns from `src/background/background-task-manager.ts`

## Risks

- **Recall transcript API response shape**: May differ from docs. Defensive coding with `Array.isArray()` checks and fallbacks.
- **Cost per meeting**: Each transcript dispatch costs one agent inference. Mitigated by 30s batching and "No response needed." pattern.
- **Context window**: Long meetings accumulate context. Claude SDK handles truncation automatically.
- **Meeting monitor state lost on restart**: Acceptable for v1. Agent session persists in MongoDB, so user can re-engage in the same Slack thread.
