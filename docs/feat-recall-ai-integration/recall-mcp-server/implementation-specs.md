# Implementation Specs: Recall.ai MCP Server

## File Changes

### NEW: `src/recall/recall-mcp-server.ts`

Standalone stdio MCP server. Pattern: `src/tasks/task-mcp-server.ts`.

**Env vars consumed:**
- `RECALL_API_KEY` (required) — API key from Recall.ai dashboard
- `RECALL_API_REGION` (optional, default `us-west-2`) — AWS region

**Base URL:** `https://${RECALL_API_REGION}.recall.ai/api/v1`

**Auth header:** `Authorization: Token ${RECALL_API_KEY}`

**API helper:** `async function api(method, path, body?)` — same pattern as task-mcp-server lines 25-36, but with `Authorization: Token` instead of `X-API-Key`.

**Tools:**

#### `recall_create_bot`
- Input: `meeting_url: string`, `bot_name?: string` (default "Hive Notetaker")
- POST `/bot/` with body:
  ```json
  {
    "meeting_url": "<url>",
    "bot_name": "<name>",
    "recording_config": {
      "transcript": {
        "provider": { "recall_ai": { "language": "en" } }
      }
    }
  }
  ```
- Returns: summary with bot ID, status, meeting URL, and next-step guidance

#### `recall_get_bot`
- Input: `bot_id: string`
- GET `/bot/${bot_id}/`
- Returns: status, meeting URL, bot name, inline transcript (`[Speaker]: text`), download URL if available

#### `recall_get_transcript`
- Input: `bot_id: string`
- GET `/bot/${bot_id}/transcript/`
- Returns: formatted transcript with speaker labels, or "not available" message

#### `recall_list_bots`
- Input: `limit?: number` (default 10)
- GET `/bot/?page_size=${limit}`
- Returns: pipe-delimited list: `id | status | meeting_url | bot_name`

#### `recall_leave_call`
- Input: `bot_id: string`
- POST `/bot/${bot_id}/leave_call/`
- Returns: confirmation message

### MODIFY: `src/config.ts`

Add after `resend` block (line ~104), before `scheduler`:

```typescript
recall: {
  apiKey: optional("RECALL_API_KEY", ""),
  region: optional("RECALL_API_REGION", "us-west-2"),
},
```

### MODIFY: `src/agents/agent-runner.ts`

Add in `buildMcpServers()` after the Linear block (line ~199), before Background (line ~201):

```typescript
// Recall.ai — meeting bots and transcription
if (config.recall.apiKey) {
  servers["recall"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/recall/recall-mcp-server.js")],
    env: {
      RECALL_API_KEY: config.recall.apiKey,
      RECALL_API_REGION: config.recall.region,
    },
  };
}
```

### MODIFY: `agents-templates/chief-of-staff/agent.yaml.tpl`

Add `- recall` to the `servers:` list (after line 25).

### MODIFY: `agents-templates/chief-of-staff/system-prompt.md.tpl`

Add to "Your Tools" section (after line 47):
```
- **Recall MCP** — `recall_create_bot` (send notetaker to meeting), `recall_get_bot` (status + transcript), `recall_get_transcript` (full transcript), `recall_list_bots`, `recall_leave_call`
```

Add meeting guidance section (before "When You Receive a Message"):
```
**Meeting transcription**: You can send a Recall.ai notetaker bot to Zoom meetings. Use `recall_create_bot` with the meeting URL, then poll with `recall_get_bot`. After the meeting ends, use `recall_get_transcript` for the full transcript. The bot appears as "Hive Notetaker" by default.
```

### MODIFY: `.env.example`

Add at end:
```
# Recall.ai (meeting transcription)
RECALL_API_KEY=
RECALL_API_REGION=us-west-2
```

## Testing

1. TypeScript compiles: `npm run build`
2. MCP server starts: `RECALL_API_KEY=test RECALL_API_REGION=us-west-2 node dist/recall/recall-mcp-server.js`
3. Agent template regeneration: `npx tsx setup/generate-agents.ts --force`
4. End-to-end: ask chief-of-staff to join a test Zoom meeting
