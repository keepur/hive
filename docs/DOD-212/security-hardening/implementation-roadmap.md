# DOD-212: Implementation Roadmap

## Design Summary

Six vulnerabilities from an external security review, remediated in priority order. All fixes are backward-compatible at the service level. The background task tool schema is a breaking change for agent behavior (structured args vs shell strings) but agents adapt naturally since LLMs handle structured arguments well.

Key technical decisions:
- **execFileSync over execSync**: Eliminates shell invocation entirely — no escaping needed
- **Structured tool schema for background tasks**: Agents provide `{ command, args }` directly instead of shell strings — avoids both injection and fragile parsing
- **Secret path token for webhooks**: Pragmatic interim containment; header-based HMAC is a follow-up
- **Auto-generated auth token for background API**: Acceptable because both sides restart together
- **Required webhook secret**: Fail-closed because Recall callbacks outlive restarts

## Implementation Phases

### Batch 1 (Parallel — no dependencies between files)

| Stream | Files | Description |
|--------|-------|-------------|
| A: MCP Command Injection | `google-mcp-server.ts`, `keychain-mcp-server.ts`, `drive-mcp-server.ts` | execSync → execFileSync |
| B: Background + Webhook + Config | `config.ts`, `index.ts`, `background-task-manager.ts`, `background-task-mcp-server.ts`, `meeting-monitor.ts`, `recall-mcp-server.ts` | Auth tokens, structured spawn, webhook secret |
| C: Agent Runner + Logs + SMS | `agent-runner.ts`, `device-registry.ts`, `slack-gateway.ts`, `sms-adapter.ts` | Permission bypass, log redaction, initial poll |

All three streams are independent — they touch completely different files except `agent-runner.ts` (Stream C) and config pass-through for auth tokens (Stream B writes config, Stream C reads it in agent-runner). Resolution: Stream C handles agent-runner env var pass-through for both BG and Recall tokens since it already owns that file.

### Post-Implementation

- Runtime spike for Phase 2 (permission bypass) — manual verification
- Build + test validation

## Risk Considerations

- **Permission bypass spike may fail**: If SDK gates MCP tools under default mode, we ship partial mitigation (disallowedTools only) and open a follow-up
- **Background task schema change**: Agents must provide structured args — could cause initial tool call failures until agents adapt to new schema description. Low risk since schema descriptions guide LLM behavior.
- **Webhook secret deployment**: Must set `RECALL_WEBHOOK_SECRET` in both dev and deploy `.env` files before deploying, or real-time transcripts will be disabled
