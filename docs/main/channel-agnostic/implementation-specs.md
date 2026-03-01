# Implementation Specs: Channel-Agnostic Architecture

## Phase 1: Core Types

### New file: `src/types/work-item.ts`

```typescript
export type ChannelKind = "slack" | "sms" | "email" | "scheduler" | "internal";

export interface ChannelRef {
  kind: ChannelKind;
  id: string;
  label: string;
}

export interface WorkItem {
  id: string;
  text: string;
  source: ChannelRef;
  sender: string;
  senderName?: string;
  threadId?: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

export interface WorkResult {
  text: string;
  agentId: string;
  workItem: WorkItem;
  costUsd: number;
  durationMs: number;
  error?: string;
}
```

Add bridge function in the same file:

```typescript
import type { IncomingMessage } from "./agent-config.js";

export function fromIncomingMessage(msg: IncomingMessage): WorkItem {
  return {
    id: msg.ts,
    text: msg.text,
    source: { kind: "slack", id: msg.channel, label: msg.channelName },
    sender: msg.user,
    threadId: msg.threadTs ? `slack:${msg.channel}:${msg.threadTs}` : undefined,
    timestamp: new Date(),
    meta: { slackTs: msg.ts, slackThreadTs: msg.threadTs },
  };
}
```

### Modify: `src/types/agent-config.ts`

Keep `IncomingMessage` (still used by `SlackGateway` event conversion and `MessageRouter` until Phase 5). Add re-exports:

```typescript
export type { WorkItem, WorkResult, ChannelRef, ChannelKind } from "./work-item.js";
```

### Modify: `src/agents/session-store.ts`

Rename `threadTs` parameter to `threadId` in all methods. Update `SessionDoc` interface:

```typescript
interface SessionDoc {
  _id: string; // "{agentId}:{threadId}"
  agentId: string;
  threadId: string; // was: threadTs
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Add fallback in `get()` for old-format keys:

```typescript
async get(agentId: string, threadId: string): Promise<string | undefined> {
  // Try new format first
  const doc = await this.collection.findOne({ _id: `${agentId}:${threadId}` });
  if (doc) return doc.sessionId;

  // Fallback: if threadId is slack:channel:ts format, try legacy key with just ts
  if (threadId.startsWith("slack:")) {
    const ts = threadId.split(":").pop();
    if (ts) {
      const legacy = await this.collection.findOne({ _id: `${agentId}:${ts}` });
      return legacy?.sessionId;
    }
  }
  return undefined;
}
```

---

## Phase 2: Dispatcher + ChannelAdapter Interface

### New file: `src/channels/channel-adapter.ts`

```typescript
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  start(onWorkItem: (item: WorkItem) => void): Promise<void>;
  deliver(result: WorkResult): Promise<void>;
  stop(): Promise<void>;
  onProcessingStart?(item: WorkItem): Promise<void>;
  onProcessingEnd?(item: WorkItem): Promise<void>;
}
```

### New file: `src/channels/dispatcher.ts`

Extract routing logic from `src/slack/message-router.ts` (`resolveAgent` method, lines 108-129). Reuse `AgentRegistry.findByName()`, `findByChannel()`, `findByKeyword()` — these already work with string labels.

```typescript
import { createLogger } from "../logging/logger.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { HealthReporter } from "../health/health-reporter.js";

const log = createLogger("dispatcher");

const STATUS_PATTERNS = [
  /^status\??$/i,
  /how.*(everyone|agents?|doing|running)/i,
  /^health\??$/i,
  /system status/i,
];

export class Dispatcher {
  private adapters = new Map<string, ChannelAdapter>();
  private registry: AgentRegistry;
  private agentManager: AgentManager;
  private healthReporter: HealthReporter;
  private defaultAgentId: string;
  private threadAgentMap = new Map<string, string>();
  private auditAdapter?: ChannelAdapter;
  private auditChannelId?: string;

  constructor(
    registry: AgentRegistry,
    agentManager: AgentManager,
    healthReporter: HealthReporter,
    defaultAgentId: string,
  ) { ... }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  setAuditChannel(adapter: ChannelAdapter, channelId: string): void {
    this.auditAdapter = adapter;
    this.auditChannelId = channelId;
  }

  async dispatch(item: WorkItem): Promise<void> {
    // 1. Intercept status queries
    if (STATUS_PATTERNS.some(p => p.test(item.text.trim()))) {
      const statusText = this.healthReporter.formatForSlack();
      const adapter = this.adapters.get(item.source.kind);
      if (adapter) {
        await adapter.deliver({
          text: statusText,
          agentId: "system",
          workItem: item,
          costUsd: 0,
          durationMs: 0,
        });
      }
      return;
    }

    // 2. Resolve agent
    const agentId = this.resolveAgent(item);
    if (!agentId) {
      log.warn("No agent found for work item", { source: item.source, text: item.text.slice(0, 50) });
      return;
    }

    const threadId = item.threadId ?? item.id;
    this.threadAgentMap.set(threadId, agentId);

    // 3. Notify adapter that processing started
    const adapter = this.adapters.get(item.source.kind);
    await adapter?.onProcessingStart?.(item);

    try {
      // 4. Send to agent
      const runResult = await this.agentManager.sendMessage(agentId, item);

      const workResult: WorkResult = {
        text: runResult.text || "_No response._",
        agentId,
        workItem: item,
        costUsd: runResult.costUsd,
        durationMs: runResult.durationMs,
        error: runResult.error,
      };

      // 5. Deliver response back through source channel
      if (adapter) {
        await adapter.deliver(workResult);
      }

      // 6. Audit log for cross-channel activity
      if (this.auditAdapter && item.source.kind !== this.auditAdapter.kind) {
        await this.postAuditLog(workResult);
      }
    } catch (err) {
      const errorResult: WorkResult = {
        text: `Something went wrong: ${String(err)}`,
        agentId,
        workItem: item,
        costUsd: 0,
        durationMs: 0,
        error: String(err),
      };
      if (adapter) await adapter.deliver(errorResult);
      log.error("Dispatch failed", { agentId, error: String(err) });
    } finally {
      await adapter?.onProcessingEnd?.(item);
    }
  }

  private resolveAgent(item: WorkItem): string | null {
    // 1. Thread continuity
    if (item.threadId) {
      const existing = this.threadAgentMap.get(item.threadId);
      if (existing) return existing;
    }
    // 2. Name addressing
    const named = this.registry.findByName(item.text);
    if (named) return named.id;
    // 3. Channel mapping (source.label matches agent channels[])
    const channelAgent = this.registry.findByChannel(item.source.label);
    if (channelAgent) return channelAgent.id;
    // 4. Keyword match
    const keyword = this.registry.findByKeyword(item.text);
    if (keyword) return keyword.id;
    // 5. Default
    return this.defaultAgentId;
  }

  private async postAuditLog(result: WorkResult): Promise<void> {
    if (!this.auditAdapter || !this.auditChannelId) return;

    const agentConfig = this.registry.get(result.agentId);
    const agentName = agentConfig?.name ?? result.agentId;
    const icon = result.workItem.source.kind === "sms" ? ":phone:" : ":incoming_envelope:";
    const senderDisplay = result.workItem.senderName ?? result.workItem.sender;
    const summary = result.text.length > 300
      ? result.text.slice(0, 300) + "..."
      : result.text;

    const auditItem: WorkItem = {
      id: `audit:${result.workItem.id}`,
      text: `${icon} *${agentName}* handled ${result.workItem.source.kind} from ${senderDisplay}:\n> ${summary}\n_($${result.costUsd.toFixed(3)} · ${(result.durationMs / 1000).toFixed(1)}s)_`,
      source: { kind: "internal", id: this.auditChannelId, label: "audit" },
      sender: "system",
      timestamp: new Date(),
    };

    // Post directly to audit channel via the audit adapter's gateway
    // The audit adapter needs a special method or we post via its deliver
    // For Slack: use postMessage directly
    await this.auditAdapter.deliver({
      text: auditItem.text,
      agentId: "system",
      workItem: auditItem,
      costUsd: 0,
      durationMs: 0,
    });
  }
}
```

---

## Phase 3: AgentManager Accepts WorkItem

### Modify: `src/agents/agent-manager.ts`

Change `sendMessage()` signature:

```typescript
// Before (line 50):
async sendMessage(agentId: string, message: IncomingMessage, onStream?: StreamCallback): Promise<RunResult>

// After:
async sendMessage(agentId: string, message: WorkItem, onStream?: StreamCallback): Promise<RunResult>
```

Update `QueuedMessage` interface:

```typescript
// Before:
interface QueuedMessage {
  message: IncomingMessage;
  ...
}
// After:
interface QueuedMessage {
  message: WorkItem;
  ...
}
```

Update `processQueue()` thread key extraction (line 76):

```typescript
// Before:
const threadKey = item.message.threadTs ?? item.message.ts;

// After:
const threadKey = item.message.threadId ?? item.message.id;
```

Update import:

```typescript
// Before:
import type { AgentConfig, AgentState, AgentStatus, IncomingMessage } from "../types/agent-config.js";
// After:
import type { AgentConfig, AgentState, AgentStatus } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";
```

### Modify: `src/slack/message-router.ts`

Add bridge at the `route()` call site (line 87):

```typescript
import { fromIncomingMessage } from "../types/work-item.js";

// Line 87, change:
const result = await this.agentManager.sendMessage(agentId, msg);
// To:
const result = await this.agentManager.sendMessage(agentId, fromIncomingMessage(msg));
```

### Modify: `src/scheduler/scheduler.ts`

Update `checkCronJobs()` (lines 95-102) to build WorkItem directly:

```typescript
import type { WorkItem } from "../types/work-item.js";

// Replace the IncomingMessage object with:
const workItem: WorkItem = {
  id: `sched:${job.agentId}:${job.task}:${Date.now()}`,
  text: `[Scheduled task: ${job.task}] Execute your scheduled "${job.task}" task now.`,
  source: { kind: "scheduler", id: job.agentId, label: "scheduler" },
  sender: "system",
  threadId: `scheduler:${job.agentId}:${job.task}:${now.toISOString().split("T")[0]}`,
  timestamp: now,
};
this.agentManager.sendMessage(job.agentId, workItem).catch(...);
```

---

## Phase 4: SMS Adapter

### New file: `src/channels/sms-adapter.ts`

Reuse polling logic from `src/scheduler/jobs/sms-poller.ts` (lines 89-168). Key changes:
- Remove all Slack references (no `gateway`, no `postMessage`, no `slackChannelIds`)
- Remove `MessageRouter` dependency
- Add `deliver()` method that sends SMS via Quo API
- Emit `WorkItem` instead of `IncomingMessage`

```typescript
import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";

const log = createLogger("sms-adapter");
const QUO_BASE = "https://api.openphone.com/v1";

interface SmsLine {
  id: string;       // phoneNumberId
  label: string;    // "May (CEO)"
  number: string;   // "(650) 649-3009"
}

export class SmsAdapter implements ChannelAdapter {
  readonly kind = "sms" as const;
  private apiKey: string;
  private lines: SmsLine[];
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastSeen = new Map<string, string>(); // phoneNumberId → ISO timestamp
  private onWorkItem: ((item: WorkItem) => void) | null = null;

  constructor(apiKey: string, lines: SmsLine[]) {
    this.apiKey = apiKey;
    this.lines = lines;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    this.onWorkItem = onWorkItem;
    for (const line of this.lines) {
      this.lastSeen.set(line.id, new Date().toISOString());
    }
    if (this.lines.length > 0) {
      this.interval = setInterval(() => this.poll(), 30_000);
      log.info("SMS adapter started", { lines: this.lines.map(l => l.label) });
    }
  }

  async deliver(result: WorkResult): Promise<void> {
    // Send SMS reply via Quo API
    const to = result.workItem.sender;                    // E.164 phone number
    const fromId = result.workItem.source.id;             // phoneNumberId
    const text = result.text;

    if (result.error) {
      log.warn("Skipping SMS delivery for error result", { error: result.error });
      return;
    }

    try {
      const res = await fetch(`${QUO_BASE}/messages`, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromId,
          to: [to],
          content: text,
        }),
      });
      if (!res.ok) {
        log.error("SMS send failed", { status: res.status, body: await res.text() });
      } else {
        log.info("SMS reply sent", { to, fromLine: fromId, textLength: text.length });
      }
    } catch (err) {
      log.error("SMS send error", { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // Reuse quoApi() and poll() from src/scheduler/jobs/sms-poller.ts
  // but emit WorkItem instead of posting to Slack:

  private async quoApi(path: string, params: Record<string, string> = {}): Promise<any> {
    // Same as sms-poller.ts lines 89-99
    const url = new URL(`${QUO_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.append(k, v);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: this.apiKey },
    });
    if (!res.ok) throw new Error(`Quo API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async poll(): Promise<void> {
    for (const line of this.lines) {
      try {
        const convResult = await this.quoApi("/conversations", {
          "phoneNumbers[]": line.id,
          updatedAfter: this.lastSeen.get(line.id)!,
          maxResults: "20",
        });

        const conversations = convResult.data ?? [];
        if (conversations.length === 0) continue;

        for (const conv of conversations) {
          const participant = conv.participants?.[0];
          if (!participant) continue;

          const msgResult = await this.quoApi("/messages", {
            phoneNumberId: line.id,
            "participants[]": participant,
            maxResults: "10",
            createdAfter: this.lastSeen.get(line.id)!,
          });

          const messages = (msgResult.data ?? [])
            .filter((m: any) => m.direction === "incoming")
            .reverse();

          for (const msg of messages) {
            if (!msg.text) continue;

            const workItem: WorkItem = {
              id: msg.id,
              text: `SMS from ${msg.from} → ${line.label}:\n${msg.text}`,
              source: { kind: "sms", id: line.id, label: line.label },
              sender: msg.from,
              threadId: `sms:${line.id}:${msg.from}`,
              timestamp: new Date(msg.createdAt),
              meta: { quoMessageId: msg.id, lineNumber: line.number },
            };

            log.info("SMS received", { from: msg.from, line: line.label, textLength: msg.text.length });
            this.onWorkItem?.(workItem);
          }
        }

        this.lastSeen.set(line.id, new Date().toISOString());
      } catch (err) {
        log.error("SMS poll failed", { line: line.label, error: String(err) });
      }
    }
  }
}
```

### Modify: `src/index.ts`

Replace SMS poller wiring with SMS adapter + Dispatcher:

```typescript
import { Dispatcher } from "./channels/dispatcher.js";
import { SmsAdapter } from "./channels/sms-adapter.js";

// After agentManager, healthReporter, messageRouter are created:
const dispatcher = new Dispatcher(registry, agentManager, healthReporter, config.agents.defaultAgent);

// SMS adapter — direct path, no Slack
const smsAdapter = new SmsAdapter(config.quo.apiKey, config.sms.lines);
dispatcher.registerAdapter(smsAdapter);
if (config.quo.apiKey && config.sms.lines.length > 0) {
  await smsAdapter.start((item) => dispatcher.dispatch(item));
}

// TODO Phase 5: Replace MessageRouter with SlackAdapter + Dispatcher
// For now, Slack still uses MessageRouter directly
```

Remove: SmsPoller import, SmsPoller instantiation, `setIgnoreFilter` call, `smsPoller.stop()` in shutdown.
Add: `smsAdapter.stop()` in shutdown.

### Delete: `src/scheduler/jobs/sms-poller.ts`

Entirely replaced by `SmsAdapter`.

### Modify: `src/slack/slack-gateway.ts`

Remove the `ignoreTs` field and `setIgnoreFilter()` method (lines added in the dedup fix). No longer needed since SMS doesn't touch Slack.

---

## Phase 5: Slack Adapter

### New file: `src/channels/slack-adapter.ts`

Wraps `SlackGateway`. Converts its events to `WorkItem`, delivers responses via `postMessage`.

```typescript
import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { SlackGateway, ThreadStartedEvent, ThreadContextChangedEvent } from "../slack/slack-gateway.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { formatError } from "../slack/response-formatter.js";

const log = createLogger("slack-adapter");

const DEFAULT_PROMPTS = [
  { title: "Daily briefing", message: "What's on my plate today?" },
  { title: "Open tasks", message: "Show me all open tasks from Linear" },
  { title: "System status", message: "How's everyone doing?" },
  { title: "Quick note", message: "I need to remember something..." },
];

export class SlackAdapter implements ChannelAdapter {
  readonly kind = "slack" as const;
  private gateway: SlackGateway;
  private registry: AgentRegistry;
  private onWorkItem: ((item: WorkItem) => void) | null = null;
  // Track thread contexts for assistant threads
  private threadContextMap = new Map<string, string>();

  constructor(gateway: SlackGateway, registry: AgentRegistry) {
    this.gateway = gateway;
    this.registry = registry;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    this.onWorkItem = onWorkItem;

    // Register integration channels (for bot message filtering)
    const allAgentChannels = this.registry.getAll().flatMap(a => a.channels);
    this.gateway.addIntegrationChannels(allAgentChannels);

    // Convert Slack message events → WorkItem
    this.gateway.onMessage((msg) => {
      const workItem: WorkItem = {
        id: msg.ts,
        text: msg.text,
        source: { kind: "slack", id: msg.channel, label: msg.channelName },
        sender: msg.user,
        threadId: msg.threadTs ? `slack:${msg.channel}:${msg.threadTs}` : undefined,
        timestamp: new Date(),
        meta: { slackTs: msg.ts, slackThreadTs: msg.threadTs },
      };
      this.onWorkItem?.(workItem);
    });

    // Assistant thread events
    this.gateway.onThreadStarted(async (event) => {
      await this.gateway.setThreadStatus(event.channel, event.threadTs, "Getting ready...");
      await this.gateway.setSuggestedPrompts(event.channel, event.threadTs, DEFAULT_PROMPTS);
      await this.gateway.setThreadStatus(event.channel, event.threadTs, "");
      if (event.context.channelId) {
        this.threadContextMap.set(event.threadTs, event.context.channelId);
      }
    });

    this.gateway.onThreadContextChanged(async (event) => {
      if (event.context.channelId) {
        this.threadContextMap.set(event.threadTs, event.context.channelId);
      }
    });

    await this.gateway.start();
  }

  async deliver(result: WorkResult): Promise<void> {
    const { workItem } = result;
    const channel = workItem.source.id;
    const slackThreadTs = (workItem.meta?.slackThreadTs as string) ?? (workItem.meta?.slackTs as string);

    const agentConfig = this.registry.get(result.agentId);
    const identity = agentConfig
      ? { name: agentConfig.name, icon: agentConfig.icon || undefined }
      : undefined;

    // For bot/integration messages, don't thread (Slack won't let us reply to another bot)
    const isIntegration = workItem.sender?.startsWith("B") || workItem.sender === "integration";
    const replyThread = isIntegration ? undefined : slackThreadTs;

    const text = result.error ? formatError(result.error) : (result.text || "_No response._");
    await this.gateway.postMessage(channel, text, replyThread, identity);
  }

  async onProcessingStart(item: WorkItem): Promise<void> {
    const slackThreadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string);
    const isIntegration = item.sender?.startsWith("B") || item.sender === "integration";
    if (!isIntegration && slackThreadTs) {
      await this.gateway.setThreadStatus(item.source.id, slackThreadTs, "Thinking...");
    }
  }

  async onProcessingEnd(item: WorkItem): Promise<void> {
    const slackThreadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string);
    const isIntegration = item.sender?.startsWith("B") || item.sender === "integration";
    if (!isIntegration && slackThreadTs) {
      await this.gateway.setThreadStatus(item.source.id, slackThreadTs, "");
    }
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  /** Expose gateway for audit log posting to specific channels */
  get client() { return this.gateway.client; }
}
```

### Modify: `src/index.ts`

Replace MessageRouter with SlackAdapter + Dispatcher:

```typescript
import { SlackAdapter } from "./channels/slack-adapter.js";
// Remove: import { MessageRouter }
// Remove: messageRouter creation, onMessage handler, onThreadStarted, onThreadContextChanged

const gateway = new SlackGateway(config.slack.appToken, config.slack.botToken);
const slackAdapter = new SlackAdapter(gateway, registry);

dispatcher.registerAdapter(slackAdapter);
// Set Slack as audit channel (resolve channel ID for e.g. #agent-activity or #general)
dispatcher.setAuditChannel(slackAdapter, auditChannelId);

await slackAdapter.start((item) => dispatcher.dispatch(item));
```

### Delete: `src/slack/message-router.ts`

Routing logic now in `Dispatcher.resolveAgent()`. Slack delivery in `SlackAdapter.deliver()`. Thread UI in `SlackAdapter`.

### Modify: `src/health/health-query.ts`

Change `isStatusQuery` to accept `WorkItem`:

```typescript
import type { WorkItem } from "../types/work-item.js";

export function isStatusQuery(item: WorkItem): boolean {
  return STATUS_PATTERNS.some((p) => p.test(item.text.trim()));
}
```

This function moves into `Dispatcher.dispatch()` — the dispatcher intercepts status queries before routing to an agent.

---

## Phase 6: Cleanup

### Modify: `src/types/agent-config.ts`

Remove `IncomingMessage` interface entirely. All callers now use `WorkItem`.

### Delete: `fromIncomingMessage()` from `src/types/work-item.ts`

No longer needed — all callers create `WorkItem` directly.

### Modify: `src/index.ts`

Final clean wiring (see plan file "Wiring after all phases" section).

---

## Directory Structure After

```
src/
  types/
    agent-config.ts           (AgentConfig, AgentState — no IncomingMessage)
    work-item.ts              (NEW: WorkItem, WorkResult, ChannelRef, ChannelKind)
  channels/
    channel-adapter.ts        (NEW: ChannelAdapter interface)
    dispatcher.ts             (NEW: routing + delivery + audit)
    slack-adapter.ts          (NEW: wraps SlackGateway)
    sms-adapter.ts            (NEW: Quo API polling + sending)
  agents/
    agent-manager.ts          (accepts WorkItem)
    agent-runner.ts           (unchanged)
    agent-registry.ts         (unchanged)
    session-store.ts          (threadId instead of threadTs)
  slack/
    slack-gateway.ts          (unchanged — internal to SlackAdapter)
    response-formatter.ts     (unchanged)
  scheduler/
    scheduler.ts              (uses WorkItem directly)
    jobs/
      heartbeat.ts            (unchanged)
  health/
    health-reporter.ts        (unchanged)
    health-query.ts           (accepts WorkItem)
  ...everything else unchanged...
```

**Deleted files:**
- `src/slack/message-router.ts`
- `src/scheduler/jobs/sms-poller.ts`

---

## Testing

1. **After Phase 1**: `npm run build` compiles. Start Hive — works identically.
2. **After Phase 3**: Slack DM → agent → response in thread. Scheduled tasks fire. Same behavior.
3. **After Phase 4**: Send test SMS → agent responds via SMS (no Slack message). Check Slack for audit log.
4. **After Phase 5**: Slack DM → agent → response in thread. Assistant thread prompts appear. Status query works. Verify `MessageRouter` is fully removed.
5. **After Phase 6**: `npm run build` — no references to `IncomingMessage` remain. Full flow test.
