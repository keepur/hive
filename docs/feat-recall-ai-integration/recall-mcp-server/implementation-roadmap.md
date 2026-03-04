# Implementation Roadmap: Recall.ai MCP Server

## Design Summary

New MCP server (`src/recall/recall-mcp-server.ts`) that wraps the Recall.ai REST API, following the established stdio subprocess pattern used by all other Hive MCP servers. No new dependencies — uses Node built-in `fetch`, existing `@modelcontextprotocol/sdk`, and `zod`.

**Key decisions:**
- Real-time transcription via `recall_ai` provider (not async post-processing)
- No webhooks — agents poll on demand using `recall_get_bot`
- Region: `us-west-2` (configurable via `RECALL_API_REGION`)
- Auth: `Authorization: Token {key}` header

## Implementation Phases

### Phase 1: Core (single batch, all parallelizable)

| Stream | Files | Description |
|--------|-------|-------------|
| A: MCP Server | `src/recall/recall-mcp-server.ts` | New file: 5 tools wrapping Recall.ai API |
| B: Config + Wiring | `src/config.ts`, `src/agents/agent-runner.ts` | Add config block + register MCP server |
| C: Agent Templates | `agents-templates/chief-of-staff/agent.yaml.tpl`, `system-prompt.md.tpl`, `.env.example` | Enable recall for chief-of-staff |

All three streams are independent and can be implemented in parallel.

### Phase 2: Verification

1. `npm run build` — TypeScript compilation
2. Set `RECALL_API_KEY` in `.env`
3. Regenerate agents: `npx tsx setup/generate-agents.ts --force`
4. Test standalone MCP server launch
5. End-to-end test with a real Zoom meeting

## Dependencies

- Recall.ai account with API key (already created)
- No new npm packages needed

## Risks

- **API response shape**: Recall.ai transcript format may differ slightly from docs. Defensive coding (optional chaining, fallbacks) mitigates this.
- **Trailing slashes**: Recall uses Django — all endpoints need trailing slashes or requests may 301.
- **Rate limits**: 300 req/min is generous for polling; no throttling needed initially.
