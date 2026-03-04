# Implementation Specs: Real-Time Meeting Participation

## File Changes

### NEW: `src/recall/meeting-monitor.ts`

Host-side service. Pattern: `src/background/background-task-manager.ts`.

**Constructor**: `(port: number, onUpdate: (item: WorkItem) => void)`

**HTTP server** on `127.0.0.1:{port}`:

| Route | Method | Body / Action |
|-------|--------|---------------|
| `/meetings/start` | POST | `{ botId, botName, meetingUrl, apiKey, region, context }` → start polling, return `{ sessionId }` |
| `/meetings/:id/stop` | POST | Stop polling, dispatch final WorkItem |
| `/meetings` | GET | List active sessions |

**Interfaces:**

```typescript
interface MeetingMonitorContext {
  agentId: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

interface MeetingSession {
  id: string;                    // UUID
  botId: string;
  botName: string;
  meetingUrl: string;
  apiKey: string;
  region: string;
  context: MeetingMonitorContext;
  lastSegmentIndex: number;
  pendingSegments: { speaker: string; text: string }[];
  lastDispatchTime: number;
  idlePollCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  status: "monitoring" | "ended" | "error";
}
```

**Constants:**
- `POLL_INTERVAL_MS = 15_000`
- `BATCH_WINDOW_MS = 30_000`
- `IDLE_FLUSH_POLLS = 2`
- `TERMINAL_STATUSES = ["done", "fatal", "call_ended", "media_expired", "recording_permission_denied"]`

**Polling logic** (per session, `setInterval(POLL_INTERVAL_MS)`):
1. `GET https://{region}.recall.ai/api/v1/bot/{botId}/transcript/` with `Authorization: Token {apiKey}`
2. Parse response: `Array.isArray(result) ? result : (result.results ?? [])`
3. New entries at index `>= lastSegmentIndex` → extract `{ speaker, text: words.map(w => w.text).join(" ") }`
4. Append to `pendingSegments`, update `lastSegmentIndex`
5. If no new segments: increment `idlePollCount`
6. Dispatch if: `(Date.now() - lastDispatchTime >= BATCH_WINDOW_MS && pendingSegments.length > 0)` OR `(idlePollCount >= IDLE_FLUSH_POLLS && pendingSegments.length > 0)`
7. Every 3rd poll: `GET /api/v1/bot/{botId}/` → check `status_changes[-1].code` for terminal status
8. If terminal: dispatch final WorkItem with all segments, clear interval

**WorkItem for transcript batch:**
```typescript
{
  id: `meeting:${botId}:${Date.now()}`,
  text: `[Meeting transcript update — ${botName}]\nBot ID: ${botId}\n\nNew transcript:\n${segments}\n\n---\nUse recall_send_chat if you have relevant input. Otherwise respond "No response needed."`,
  source: { kind: context.channelKind, id: context.channelId, label: context.channelLabel, adapterId: context.adapterId },
  sender: "system",
  threadId: context.threadId,
  timestamp: new Date(),
  meta: { slackTs: context.slackTs, slackThreadTs: context.slackThreadTs, meetingBotId: botId },
}
```

**WorkItem for meeting end:** Same shape but text starts with `[Meeting ended — ${botName}]`, includes full transcript, and prompts: "Produce a summary: key decisions, action items with owners, and open questions."

---

### MODIFY: `src/config.ts`

Add `monitorPort` to recall block (after `region`, before closing brace):
```typescript
monitorPort: parseInt(optional("MEETING_MONITOR_PORT", "3101"), 10),
```

### MODIFY: `.env.example`

Add after `RECALL_API_REGION`:
```
MEETING_MONITOR_PORT=3101
```

### MODIFY: `src/recall/recall-mcp-server.ts`

**New env vars** (read at top):
```typescript
const MEETING_MONITOR_API = process.env.MEETING_MONITOR_API ?? "";
const AGENT_ID = process.env.RECALL_AGENT_ID ?? "";
```

**New helper** `monitorApi()`:
```typescript
async function monitorApi(method: string, path: string, body?: object): Promise<any> {
  if (!MEETING_MONITOR_API) throw new Error("Meeting monitor not configured");
  const res = await fetch(`${MEETING_MONITOR_API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Monitor API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return {};
  return res.json();
}
```

**New helper** `buildContext()`:
```typescript
function buildContext() {
  return {
    agentId: AGENT_ID,
    adapterId: process.env.RECALL_ADAPTER_ID ?? "",
    channelId: process.env.RECALL_CHANNEL_ID ?? "",
    channelKind: process.env.RECALL_CHANNEL_KIND ?? "internal",
    channelLabel: process.env.RECALL_CHANNEL_LABEL ?? "",
    threadId: process.env.RECALL_THREAD_ID ?? "",
    slackTs: process.env.RECALL_SLACK_TS ?? "",
    slackThreadTs: process.env.RECALL_SLACK_THREAD_TS ?? "",
  };
}
```

**New tool: `recall_join_meeting`** (register after `recall_create_bot`):
- Input: `meeting_url: z.string()`, `bot_name: z.string().optional().default("Hive Assistant")`
- POST to Recall API `/bot/` (same as create_bot, with `recallai_streaming` provider)
- POST to `MEETING_MONITOR_API/meetings/start` with `{ botId: bot.id, botName: bot_name, meetingUrl: meeting_url, apiKey: API_KEY, region: REGION, context: buildContext() }`
- Return: bot ID, session ID, "you'll receive transcript updates in this thread"

**New tool: `recall_send_chat`** (register after `recall_join_meeting`):
- Input: `bot_id: z.string()`, `message: z.string()`
- POST to Recall API `/bot/${bot_id}/send_chat_message/` with `{ to: "everyone", message }`
- Return: confirmation text

### MODIFY: `src/agents/agent-runner.ts`

Update the `recall` section in `buildMcpServers()`. Replace current env block with:
```typescript
env: {
  RECALL_API_KEY: config.recall.apiKey,
  RECALL_API_REGION: config.recall.region,
  MEETING_MONITOR_API: `http://127.0.0.1:${config.recall.monitorPort}`,
  RECALL_AGENT_ID: this.agentConfig.id,
  RECALL_ADAPTER_ID: context?.adapterId ?? "",
  RECALL_CHANNEL_ID: context?.channelId ?? "",
  RECALL_CHANNEL_KIND: context?.channelKind ?? "internal",
  RECALL_CHANNEL_LABEL: context?.channelLabel ?? "",
  RECALL_THREAD_ID: context?.threadId ?? "",
  RECALL_SLACK_TS: context?.slackTs ?? "",
  RECALL_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
},
```

### MODIFY: `src/index.ts`

Import and wire MeetingMonitor. After BackgroundTaskManager setup:
```typescript
import { MeetingMonitor } from "./recall/meeting-monitor.js";

let meetingMonitor: MeetingMonitor | undefined;
if (config.recall.apiKey) {
  meetingMonitor = new MeetingMonitor(
    config.recall.monitorPort,
    (item) => dispatcher.dispatch(item).catch((err) => {
      log.error("Meeting monitor dispatch failed", { error: String(err) });
    }),
  );
  await meetingMonitor.start();
  log.info("Meeting monitor started", { port: config.recall.monitorPort });
}
```

In shutdown handler, add before `agentManager.stopAll()`:
```typescript
meetingMonitor?.stop();
```

### MODIFY: `agents-templates/chief-of-staff/system-prompt.md.tpl`

Replace the existing "Meeting Transcription" section with:
```markdown
## Meeting Participation

You can join meetings as an active participant using `recall_join_meeting`. Once joined:
- You'll receive periodic transcript updates showing what's being said
- Use `recall_send_chat` to send messages into the meeting chat
- Only chime in when someone addresses you, asks a question you can answer, or you have directly relevant input
- Keep chat messages concise (1-2 sentences)
- If nothing requires your input, respond with exactly: "No response needed."
- When the meeting ends, produce a summary: key decisions, action items with owners, and open questions

For passive recording only (no participation), use `recall_create_bot` instead.
```

Also update the "Your Tools" Recall MCP line to:
```
- **Recall MCP** — `recall_join_meeting` (join meeting as active participant), `recall_send_chat` (send chat message into meeting), `recall_create_bot` (passive recording), `recall_get_bot` (check status/transcript), `recall_get_transcript` (full transcript), `recall_list_bots`, `recall_leave_call`
```

## Testing

1. TypeScript compiles: `npm run build`
2. MeetingMonitor HTTP responds: `curl http://127.0.0.1:3101/meetings`
3. Regenerate agents: `npx tsx setup/generate-agents.ts --force`
4. End-to-end: ask chief-of-staff to join a Zoom meeting, verify transcript updates and chat
