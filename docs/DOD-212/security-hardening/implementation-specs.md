# DOD-212: Implementation Specs

## Stream A: MCP Command Injection Fix

### A1. `src/google/google-mcp-server.ts`

**Import change**: `execSync` → `execFileSync` from `node:child_process`

**Helper refactor**:
```typescript
function gog(args: string[]): string {
  const fullArgs = [...args, ...(ACCOUNT ? ["-a", ACCOUNT] : []), "--json", "--results-only", "--no-input"];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function gogPlain(args: string[]): string {
  const fullArgs = [...args, ...(ACCOUNT ? ["-a", ACCOUNT] : []), "--plain", "--no-input"];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}
```

**GOG resolution**: `execFileSync("which", ["gog"], { encoding: "utf-8" }).trim()`

**Tool call site conversions** (9 tools):
- `gmail_search`: `gog(["gmail", "search", query, `--max=${max}`])`
- `gmail_get`: `gog(["gmail", "get", messageId])`
- `gmail_thread`: `gog(["gmail", "thread", "get", threadId])`
- `gmail_send`: `gogPlain(["send", "--to", to, "--subject", subject, "--body", body, "--force", ...(cc ? ["--cc", cc] : []), ...(threadId ? ["--thread-id", threadId] : [])])`
- `calendar_list`: `gog(["cal", "calendars"])`
- `calendar_events`: Build dynamically with `--today`, `--days=N`, `--from`, `--to`, `--max`
- `calendar_search`: `gog(["cal", "search", query, ...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])])`
- `calendar_create`: `gogPlain(["cal", "create", calendarId, "--summary", summary, "--from", from, "--to", to, "--force", ...(description ? ["--description", description] : []), ...(location ? ["--location", location] : []), ...(attendees ? ["--attendees", attendees] : [])])`
- `calendar_freebusy`: `gog(["cal", "freebusy", calendarIds, "--from", from, "--to", to])`

### A2. `src/keychain/keychain-mcp-server.ts`

**Import change**: `execSync` → `execFileSync`

**Remove `run()` helper entirely.**

**`secret_get`**:
```typescript
const password = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
  { encoding: "utf-8", timeout: 5000 }).trim();
```

**`secret_list`**: Replace shell pipeline with JS parsing:
```typescript
const raw = execFileSync("security", ["dump-keychain"], { encoding: "utf-8", timeout: 5000 });
// Parse: find blocks with svce="hive", extract acct= values
const accounts: string[] = [];
const blocks = raw.split("keychain:");
for (const block of blocks) {
  if (block.includes(`"svce"<blob>="${SERVICE}"`)) {
    const acctMatch = block.match(/"acct"<blob>="([^"]+)"/);
    if (acctMatch) accounts.push(acctMatch[1]);
  }
}
```

### A3. `src/drive/drive-mcp-server.ts`

**Import change**: `execSync` → `execFileSync`

**Helper refactor**:
```typescript
function gws(args: string[]): string {
  return execFileSync(GWS, args, { encoding: "utf-8", timeout: 60_000 }).trim();
}
```

**GWS resolution**: `execFileSync("which", ["gws"], { encoding: "utf-8" }).trim()`

**Tool call site conversions**:
- `drive_upload`: `gws(["drive", "files", "create", "--params", params, "--json", meta, "--upload", file_path])` and `gws(["drive", "files", "get", "--params", fields])`
- `drive_download`: `gws(["drive", "files", "get", "--params", fields])` and `gws(["drive", "files", "export", "--params", exportParams, "--output", localPath])`
- `drive_list`: `gws(["drive", "files", "list", "--params", params])`

---

## Stream B: Background Task Auth + Webhook Secret

### B1. `src/config.ts`

Add to `background` section:
```typescript
background: {
  port: parseInt(optional("BG_TASK_PORT", "3100"), 10),
  authToken: optional("BG_TASK_AUTH_TOKEN", "") || randomUUID(),
},
```

Add to `recall` section:
```typescript
recall: {
  // ...existing fields
  webhookSecret: optional("RECALL_WEBHOOK_SECRET", ""),
},
```

Import `randomUUID` from `node:crypto`.

### B2. `src/index.ts`

Pass auth token to BackgroundTaskManager:
```typescript
const bgTaskManager = new BackgroundTaskManager(config.background.port, config.background.authToken, (item) => ...);
```

Pass webhook secret to MeetingMonitor:
```typescript
meetingMonitor = new MeetingMonitor(config.recall.monitorPort, config.recall.webhookSecret, (item) => ...);
```

Log warning if Recall enabled but no webhook secret:
```typescript
if (config.recall.apiKey && !config.recall.webhookSecret) {
  log.error("Real-time transcript delivery disabled — RECALL_WEBHOOK_SECRET not set");
}
```

### B3. `src/background/background-task-manager.ts`

**Constructor**: Add `authToken` parameter:
```typescript
constructor(port: number, authToken: string, onComplete: (item: WorkItem) => void) {
  this.port = port;
  this.authToken = authToken;
  this.onComplete = onComplete;
}
```

**Auth check in `handleRequest()`** — add at top of method, before any route matching:
```typescript
const authHeader = req.headers.authorization;
if (authHeader !== `Bearer ${this.authToken}`) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return;
}
```

**`spawnTask()` interface change**:
```typescript
private async spawnTask(body: {
  command: string;
  args?: string[];
  cwd?: string;
  context: BackgroundTaskContext;
}): Promise<BackgroundTask> {
```

**Remove `shell: true`** from spawn call:
```typescript
const child = spawn(body.command, body.args ?? [], {
  cwd,
  detached: true,
  stdio: ["ignore", logFd, logFd],
});
```

**Update BackgroundTask interface**: Add `args` field, update `command` to store display string:
```typescript
command: body.command + (body.args?.length ? " " + body.args.join(" ") : ""),
```

### B4. `src/background/background-task-mcp-server.ts`

**Add auth token**: Read `BG_AUTH_TOKEN` from env, include in all requests:
```typescript
const AUTH_TOKEN = process.env.BG_AUTH_TOKEN ?? "";

async function bgApi(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // ...
}
```

**Change `bg_execute` tool schema**:
```typescript
inputSchema: {
  command: z.string().describe("Executable name or path (e.g. 'npm', 'git', '/path/to/deploy.sh')"),
  args: z.array(z.string()).optional().describe("Arguments array (e.g. ['test', '--coverage']). Each argument is a separate element — no shell quoting needed."),
  cwd: z.string().optional().describe("Working directory (absolute path). Defaults to $HOME."),
},
```

**Update tool handler**: Send structured body:
```typescript
async ({ command, args, cwd }) => {
  const result = await bgApi("POST", "/tasks", {
    command,
    args,
    cwd,
    context: buildContext(),
  });
  const displayCmd = command + (args?.length ? " " + args.join(" ") : "");
  // ...use displayCmd in response text
}
```

### B5. `src/recall/meeting-monitor.ts`

**Constructor**: Add `webhookSecret` parameter:
```typescript
constructor(port: number, webhookSecret: string, onUpdate: (item: WorkItem) => void) {
  this.port = port;
  this.webhookSecret = webhookSecret;
  this.onUpdate = onUpdate;
}
```

**Start method**: Log if no secret:
```typescript
if (!this.webhookSecret) {
  log.error("Webhook verification disabled — RECALL_WEBHOOK_SECRET not set. All webhook requests will be rejected.");
}
```

**Webhook route** in `handleRequest()`:
```typescript
// POST /webhook/transcript/<secret> — receive real-time transcript from Recall
if (req.method === "POST" && url.pathname.startsWith("/webhook/transcript")) {
  if (!this.webhookSecret) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Webhook verification not configured" }));
    return;
  }
  if (url.pathname !== `/webhook/transcript/${this.webhookSecret}`) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  const body = await this.readBody(req);
  this.handleTranscriptWebhook(body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
  return;
}
```

### B6. `src/recall/recall-mcp-server.ts`

**Add env var**: `const WEBHOOK_SECRET = process.env.RECALL_WEBHOOK_SECRET ?? "";`

**In `recall_join_meeting`**: Conditionally configure realtime endpoints:
```typescript
if (MEETING_MONITOR_PUBLIC_URL && WEBHOOK_SECRET) {
  botBody.recording_config.realtime_endpoints = [
    {
      type: "webhook",
      url: `${MEETING_MONITOR_PUBLIC_URL}/webhook/transcript/${WEBHOOK_SECRET}`,
      events: ["transcript.data", "transcript.partial_data"],
    },
  ];
} else if (MEETING_MONITOR_PUBLIC_URL && !WEBHOOK_SECRET) {
  // Don't configure realtime endpoints — note this in response
}
```

Update response to include note when webhook is disabled.

---

## Stream C: Agent Runner + Logs + SMS

### C1. `src/agents/agent-runner.ts`

**Permission bypass** (lines 433-434):
- Add `disallowedTools` list (ship regardless of spike result)
- Remove or keep bypass flags depending on spike outcome

**Auth token env vars** — add to background MCP server config (around line 262):
```typescript
BG_AUTH_TOKEN: config.background.authToken,
```

Add to recall MCP server config (around line 245):
```typescript
RECALL_WEBHOOK_SECRET: config.recall.webhookSecret,
```

**Log redaction**:
- Line 421: Remove `promptPreview: prompt.slice(0, 200)` — keep `promptLength`
- Line 519: Remove `inputPreview: JSON.stringify(block.input).slice(0, 120)` — keep `tool: block.name`

### C2. `src/channels/ws/device-registry.ts`

- Line 63: `log.info("Device created", { id: device._id, name })` — remove `pairingCode`
- Line 74: `log.warn("Pairing code invalid or expired")` — remove `{ code }`
- Line 124: `log.info("Pairing code refreshed", { deviceId })` — remove `code`

### C3. `src/slack/slack-gateway.ts`

- Line 100: Remove `text: event.text?.slice(0, 100)`
- Line 103: Remove `attachmentFallback: event.attachments?.[0]?.fallback?.slice(0, 100)`

### C4. `src/channels/sms-adapter.ts`

Add initial poll before setInterval (line 53-54):
```typescript
this.poll(onWorkItem);
this.interval = setInterval(() => this.poll(onWorkItem), 30_000);
```

---

## Testing Requirements

See plan verification section for full test matrix (13 items). Key tests:
- Unit: injection literals passed to execFileSync helpers
- E2E: agent MCP tool call with malicious input
- Curl: background API auth on all endpoints
- Curl: webhook route with correct/wrong/missing secret
- Runtime: permission bypass spike
