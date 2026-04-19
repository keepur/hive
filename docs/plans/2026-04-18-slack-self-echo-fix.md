# Slack Self-Echo Fix Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace the hosted Slack MCP with a local stdio MCP that forwards tool calls via a localhost HTTP endpoint in the hive process. The hive process owns the WebClient, echo cache, and active-WorkItem tracking — making posting, cache-registration, and threading-fallback atomic in-process. Eliminates the user-token echo cascade.

**Architecture:** Local MCP = thin stdio RPC shim → `POST /internal/slack/*` on hive process → gateway's bot-token `WebClient` + `outboundTsCache` + `activeWorkItems`. Inbound Slack events are filtered by `ts` presence in the echo cache. Threading is agent-explicit with server-side fallback via `activeWorkItems[agentId]` matching the posted channel.

**Tech stack:** Node HTTP server (existing pattern from `background-task-manager`), `@slack/web-api`, `@modelcontextprotocol/sdk`, Vitest.

**Spec reference:** `docs/specs/2026-04-18-slack-self-echo-fix-design.md`

---

## File Map

**Create:**
- `src/slack/slack-internal-api.ts` — localhost HTTP server exposing `/internal/slack/{send,read,search,channels,users}`, bearer auth, localhost-bound
- `src/slack/slack-mcp-server.ts` — stdio MCP server; thin shim forwarding tool calls to the internal API via `fetch`
- `src/slack/outbound-ts-cache.ts` — TTL Set keyed on Slack `ts`, 120s eviction
- `tests/slack/outbound-ts-cache.test.ts`
- `tests/slack/slack-internal-api.test.ts`

**Modify:**
- `src/slack/slack-gateway.ts` — add `outboundTsCache`, `resolveChannelId()` inverse lookup, echo-suppression filter, `registerOutboundTs()` method exposed to adapter + internal API
- `src/channels/slack-adapter.ts` — capture `ts` from `gateway.postMessage()` return, register in cache
- `src/agents/agent-manager.ts` — add `activeWorkItems: Map<string, WorkItem[]>` state, set/clear hooks in `processThreadQueue`, expose read accessor; extend prompt preamble with `thread=<ts>`
- `src/agents/agent-runner.ts` — switch `servers["slack"]` between hosted and local MCP based on `slack.localMcpServer` flag; wire the local MCP's env (`HIVE_INTERNAL_URL`, `HIVE_INTERNAL_TOKEN`)
- `src/config.ts` — add `slack.localMcpServer` flag, add `slackInternal.port`/`authToken` config block
- `src/index.ts` — start `slack-internal-api` server on boot when flag is on
- `shared/constitution.md` — add threading directive (pass `thread_ts` from preamble; use `force_root` for broadcasts)
- `hive.yaml.example` — document the new `slack.localMcpServer` flag
- `tests/slack/slack-gateway.test.ts` — add cases for echo suppression + `resolveChannelId`

---

## Task 1: Outbound TS Cache

**Files:**
- Create: `src/slack/outbound-ts-cache.ts`
- Test: `tests/slack/outbound-ts-cache.test.ts`

- [ ] **Step 1:** Create the cache module.

```typescript
// src/slack/outbound-ts-cache.ts
import { createLogger } from "../logging/logger.js";

const log = createLogger("outbound-ts-cache");

export interface OutboundTsCacheOptions {
  ttlMs?: number;
  maxSize?: number;
}

export class OutboundTsCache {
  private entries = new Map<string, number>(); // key `${channel}:${ts}` → expiry epoch ms
  private ttlMs: number;
  private maxSize: number;

  constructor(opts: OutboundTsCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.maxSize = opts.maxSize ?? 10_000;
  }

  register(channel: string, ts: string): void {
    this.evictExpired();
    if (this.entries.size >= this.maxSize) {
      // Drop oldest (Map preserves insertion order)
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
    this.entries.set(this.key(channel, ts), Date.now() + this.ttlMs);
  }

  has(channel: string, ts: string): boolean {
    const expiry = this.entries.get(this.key(channel, ts));
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.entries.delete(this.key(channel, ts));
      return false;
    }
    return true;
  }

  size(): number {
    return this.entries.size;
  }

  private key(channel: string, ts: string): string {
    return `${channel}:${ts}`;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(k);
    }
  }
}
```

- [ ] **Step 2:** Test.

```typescript
// tests/slack/outbound-ts-cache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutboundTsCache } from "../../src/slack/outbound-ts-cache.js";

describe("OutboundTsCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("registers and finds a ts", () => {
    const c = new OutboundTsCache();
    c.register("C1", "1.1");
    expect(c.has("C1", "1.1")).toBe(true);
  });

  it("misses on wrong channel", () => {
    const c = new OutboundTsCache();
    c.register("C1", "1.1");
    expect(c.has("C2", "1.1")).toBe(false);
  });

  it("expires after TTL", () => {
    const c = new OutboundTsCache({ ttlMs: 1000 });
    c.register("C1", "1.1");
    vi.advanceTimersByTime(1001);
    expect(c.has("C1", "1.1")).toBe(false);
  });

  it("evicts oldest at max size", () => {
    const c = new OutboundTsCache({ maxSize: 2 });
    c.register("C1", "1");
    c.register("C1", "2");
    c.register("C1", "3");
    expect(c.has("C1", "1")).toBe(false);
    expect(c.has("C1", "3")).toBe(true);
  });
});
```

Run: `npm test -- outbound-ts-cache`
Expected: all 4 pass.

- [ ] **Step 3:** Commit.

```bash
git add src/slack/outbound-ts-cache.ts tests/slack/outbound-ts-cache.test.ts
git commit -m "feat(slack): add outbound ts cache for self-echo suppression"
```

---

## Task 2: Gateway integration — echo filter + inverse channel lookup

**Files:**
- Modify: `src/slack/slack-gateway.ts`
- Modify: `tests/slack/slack-gateway.test.ts`

- [ ] **Step 1:** Import and instantiate the cache; add `resolveChannelId()` inverse lookup; add `registerOutboundTs()` accessor.

At the top of `src/slack/slack-gateway.ts`, after existing imports:
```typescript
import { OutboundTsCache } from "./outbound-ts-cache.js";
```

Add to the class body near `channelNameCache` (around line 37):
```typescript
private outboundTsCache = new OutboundTsCache();
// Inverse of channelNameCache for name → id resolution. Populated lazily.
private channelIdCache = new Map<string, string>();
```

Add two new methods near `resolveChannelName()`:
```typescript
registerOutboundTs(channel: string, ts: string): void {
  this.outboundTsCache.register(channel, ts);
}

isOutboundEcho(channel: string, ts: string): boolean {
  return this.outboundTsCache.has(channel, ts);
}

async resolveChannelId(nameOrId: string): Promise<string | null> {
  // Accept either C… (already an ID) or a bare name like "agent-river"
  if (nameOrId.startsWith("C") || nameOrId.startsWith("D") || nameOrId.startsWith("G")) {
    return nameOrId;
  }
  const name = nameOrId.replace(/^#/, "");
  const cached = this.channelIdCache.get(name);
  if (cached) return cached;
  try {
    // Fetch via conversations.list, populate both caches as we see entries.
    let cursor: string | undefined;
    do {
      const res = await this.web.conversations.list({ limit: 1000, cursor, exclude_archived: true, types: "public_channel,private_channel" });
      for (const ch of res.channels ?? []) {
        if (ch.id && ch.name) {
          this.channelNameCache.set(ch.id, ch.name);
          this.channelIdCache.set(ch.name, ch.id);
        }
      }
      cursor = (res as any).response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (err) {
    log.warn("channel id resolve failed", { name, error: (err as Error).message });
    return null;
  }
  return this.channelIdCache.get(name) ?? null;
}
```

- [ ] **Step 2:** Add the echo-suppression filter inside the `message` event handler in `start()` — immediately after the existing self-loop filter block (currently lines 105-108).

Find:
```typescript
if (event.bot_id && event.bot_id === this.botId) return;
if (event.bot_id && this.peerBotIds.has(event.bot_id)) return;
```

Append right after:
```typescript
// Suppress self-echoes from agent-initiated sends routed through the local Slack API.
if (event.ts && event.channel && this.outboundTsCache.has(event.channel, event.ts)) {
  log.info("Outbound echo suppressed", { channel: event.channel, ts: event.ts });
  return;
}
```

- [ ] **Step 3:** Update `postSingle` (around line 370) to populate the cache on every successful post. Find the return of `ts` (currently around line 378) and add the register call before returning:

```typescript
// after: const res = await this.web.chat.postMessage({...});
// at: if (res.ok && res.ts) this.outboundTsCache.register(channelId, res.ts);
```

Use the actual returned `res.channel` (Slack returns it) as the cache key — matches the inbound event's `event.channel`.

- [ ] **Step 4:** Test — add to `tests/slack/slack-gateway.test.ts`.

```typescript
// Simplified — integrate with existing mocking
describe("outbound echo suppression", () => {
  it("drops inbound events whose ts matches a registered outbound", async () => {
    const gw = new SlackGateway({ /* test deps */ } as any);
    gw.registerOutboundTs("C1", "1111.2222");
    expect(gw.isOutboundEcho("C1", "1111.2222")).toBe(true);
    expect(gw.isOutboundEcho("C1", "9999.9999")).toBe(false);
  });
});
```

Run: `npm test -- slack-gateway`
Expected: existing tests still pass + new case passes.

- [ ] **Step 5:** Commit.

```bash
git add src/slack/slack-gateway.ts tests/slack/slack-gateway.test.ts
git commit -m "feat(slack): add outbound echo suppression and channel-id resolver to gateway"
```

---

## Task 3: Adapter writes to cache after send

**Files:**
- Modify: `src/channels/slack-adapter.ts`

- [ ] **Step 1:** Adapter already calls `this.gateway.postMessage(...)` at line 142. `postMessage` internally calls `postSingle`, which now registers the `ts` in Task 2 Step 3. **No adapter change needed** — gateway-side registration covers both adapter and internal API paths uniformly.

Verify by reading lines 123-150: `deliver()` does not need to touch the cache because gateway already does it for every post.

- [ ] **Step 2:** Remove this task's entry from the plan's "Files modified" list if no change is actually needed. Mark this task completed in the worktree plan document.

No commit for Task 3.

---

## Task 4: AgentManager — activeWorkItems state + preamble extension

**Files:**
- Modify: `src/agents/agent-manager.ts`

- [ ] **Step 1:** Add `activeWorkItems` state. Near the existing state field declarations (lines 54-66 per exploration):

```typescript
// Keyed by agentId → list of currently in-flight WorkItems (one per active thread).
private activeWorkItems = new Map<string, WorkItem[]>();
```

Add a public read accessor:
```typescript
getActiveWorkItems(agentId: string): WorkItem[] {
  return this.activeWorkItems.get(agentId) ?? [];
}
```

- [ ] **Step 2:** Set/clear hooks in `processThreadQueue`.

At the top of the `while` loop that processes each item (near line 157 where `this.processing.add(threadKey)` happens), push the current item:

```typescript
// At the start of processing this item
const active = this.activeWorkItems.get(agentId) ?? [];
active.push(item);
this.activeWorkItems.set(agentId, active);
```

In the `finally` that runs after the item (where the current code calls `this.processing.delete(threadKey)`), pop the item:

```typescript
// In finally
const remaining = (this.activeWorkItems.get(agentId) ?? []).filter((w) => w.id !== item.id);
if (remaining.length === 0) this.activeWorkItems.delete(agentId);
else this.activeWorkItems.set(agentId, remaining);
```

- [ ] **Step 3:** Extend the per-turn preamble (around line 204-208 per exploration).

Find:
```typescript
if (item.message.senderName) {
  prompt = `[${senderLabel} in #${item.message.source.label}]: ${item.message.text}`;
}
```

Replace with:
```typescript
if (item.message.senderName) {
  const slackThreadTs = (item.message.meta as any)?.slackThreadTs;
  const slackTs = (item.message.meta as any)?.slackTs;
  const threadHint = slackThreadTs ? `, thread=${slackThreadTs}` : slackTs ? `, thread=${slackTs}` : "";
  prompt = `[${senderLabel} in #${item.message.source.label}${threadHint}]: ${item.message.text}`;
}
```

The thread hint is informational; agents are instructed (Task 8) to pass it back as `thread_ts` in the Slack send tool.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(agents): track activeWorkItems and expose thread hint in preamble"
```

---

## Task 5: Config — flag, port, token

**Files:**
- Modify: `src/config.ts`
- Modify: `hive.yaml.example`

- [ ] **Step 1:** Add to the `slack` section (around line 94-99):

```typescript
slack: {
  appToken: required("SLACK_APP_TOKEN"),
  botToken: required("SLACK_BOT_TOKEN"),
  mcpToken: optional("SLACK_MCP_TOKEN", ""),
  auditChannel: optional("SLACK_AUDIT_CHANNEL", hive.slack?.auditChannel ?? ""),
  localMcpServer: Boolean(hive.slack?.localMcpServer ?? false),
},
```

- [ ] **Step 2:** Add a new `slackInternal` block near `background` (mirror its port+authToken pattern; reference exploration output for the exact existing template):

```typescript
slackInternal: {
  port: Number(hive.slackInternal?.port ?? (portBase + 7)), // pick offset not already used
  authToken: process.env.SLACK_INTERNAL_TOKEN || randomUUID(),
},
```

Verify the offset +7 doesn't collide with existing port assignments (scan `src/config.ts` for all `portBase + N` usages before committing).

- [ ] **Step 3:** Update `hive.yaml.example` with:

```yaml
slack:
  localMcpServer: false   # set true to use local bot-token Slack MCP instead of hosted MCP
slackInternal:
  # port is auto-derived from instance portBase if omitted
```

- [ ] **Step 4:** Commit.

```bash
git add src/config.ts hive.yaml.example
git commit -m "feat(config): add slack.localMcpServer flag and slackInternal port/token"
```

---

## Task 6: Internal API — HTTP endpoints

**Files:**
- Create: `src/slack/slack-internal-api.ts`
- Test: `tests/slack/slack-internal-api.test.ts`

- [ ] **Step 1:** Create the server. Mirror `src/background/background-task-manager.ts` structure (raw `http.createServer`, 127.0.0.1-bound, bearer auth).

Key implementation points (full code in implementation):

- Constructor takes `{ port, authToken, gateway: SlackGateway, agentManager: AgentManager }`.
- Routes (POST JSON, bearer auth):
  - `/internal/slack/send` → body `{ agent_id, channel, text, thread_ts?, blocks?, force_root? }`. Resolves `channel` via `gateway.resolveChannelId(channel)`. If `thread_ts` is absent and `!force_root`: look up `agentManager.getActiveWorkItems(agent_id)`, filter entries whose `source.channelId === resolvedChannelId`, pick most recent, use `meta.slackThreadTs` (fallback `meta.slackTs`). Post via `gateway.postSingle(resolvedChannelId, text, thread_ts, blocks)`. `postSingle` already registers `ts` in the cache (Task 2 Step 3). Return `{ ok: true, ts, channel: resolvedChannelId }`.
  - `/internal/slack/read` → body `{ channel, limit? }` → `conversations.history`.
  - `/internal/slack/channels` → body `{ query? }` → `conversations.list` with optional name filter.
  - `/internal/slack/users` → body `{ user }` → `users.info`.
  - `/internal/slack/search` — **deferred pending tool-parity audit (per spec).** Stub returning 501.
- All responses include `{ ok, ... }` or `{ ok: false, error }`.
- Bearer auth: reject with 401 if `Authorization: Bearer <token>` is missing or wrong.
- Bind to `127.0.0.1` only.

Start / stop methods mirroring `BackgroundTaskManager`.

- [ ] **Step 2:** Unit test. Stub `gateway.postSingle` to return `{ ts: "X" }`; send a POST with bearer auth; assert 200 + correct payload passed to `postSingle`. Test threading fallback: seed `agentManager.getActiveWorkItems("river")` with a WorkItem, call `/send` without `thread_ts`, assert `postSingle` received the fallback ts.

Run: `npm test -- slack-internal-api`
Expected: at least 4 cases (auth fail, send with thread_ts, send with fallback, send with force_root) pass.

- [ ] **Step 3:** Commit.

```bash
git add src/slack/slack-internal-api.ts tests/slack/slack-internal-api.test.ts
git commit -m "feat(slack): add internal HTTP API for bot-token Slack operations"
```

---

## Task 7: Local Slack MCP server (stdio shim)

**Files:**
- Create: `src/slack/slack-mcp-server.ts`

- [ ] **Step 1:** Implement. Follow the pattern in `src/keychain/keychain-mcp-server.ts`. Each tool forwards args to the internal API via `fetch` with the bearer token from env. Tool names must match the hosted MCP exactly:
  - `slack_send_message` → `POST /internal/slack/send`
  - `slack_read_channel` → `POST /internal/slack/read`
  - `slack_search_messages` — registered but returns "search deferred pending tool-parity audit" (from /search 501 response).
  - `slack_list_channels` → `POST /internal/slack/channels`
  - `slack_read_user_profile` → `POST /internal/slack/users`

Env vars read at startup: `HIVE_INTERNAL_URL`, `HIVE_INTERNAL_TOKEN`, `HIVE_AGENT_ID` (for `agent_id` in `/send`).

- [ ] **Step 2:** Build artifact is compiled by the existing `tsc` step.

Run: `npm run build`
Expected: no errors, new `dist/slack/slack-mcp-server.js` exists.

- [ ] **Step 3:** Commit.

```bash
git add src/slack/slack-mcp-server.ts
git commit -m "feat(slack): add local stdio MCP server forwarding to internal API"
```

---

## Task 8: Agent-runner — switch hosted vs local

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** Replace the Slack MCP section (around lines 250-258) with a flag-gated switch:

```typescript
// Slack MCP — either local stdio (bot token, self-echo-safe) or hosted HTTP (user token).
if (config.slack.localMcpServer) {
  servers["slack"] = {
    type: "stdio",
    command: "node",
    args: [mcpPath("slack/slack-mcp-server.js")],
    env: {
      HIVE_INTERNAL_URL: `http://127.0.0.1:${config.slackInternal.port}`,
      HIVE_INTERNAL_TOKEN: config.slackInternal.authToken,
      HIVE_AGENT_ID: this.agentConfig.id,
    },
  };
} else {
  const slackMcpToken = config.slack.mcpToken;
  if (slackMcpToken) {
    servers["slack"] = {
      type: "http",
      url: "https://mcp.slack.com/mcp",
      headers: { Authorization: `Bearer ${slackMcpToken}` },
    };
  }
}
```

- [ ] **Step 2:** Commit.

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agents): swap hosted Slack MCP for local stdio when flag is on"
```

---

## Task 9: Boot the internal API server

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1:** After the gateway and agentManager are initialized, conditionally start the internal API:

```typescript
import { SlackInternalApi } from "./slack/slack-internal-api.js";

// …after gateway and agentManager exist:
let slackInternalApi: SlackInternalApi | null = null;
if (config.slack.localMcpServer) {
  slackInternalApi = new SlackInternalApi({
    port: config.slackInternal.port,
    authToken: config.slackInternal.authToken,
    gateway,
    agentManager,
  });
  await slackInternalApi.start();
}
```

Add shutdown hook alongside existing shutdown logic:
```typescript
if (slackInternalApi) await slackInternalApi.stop();
```

- [ ] **Step 2:** Commit.

```bash
git add src/index.ts
git commit -m "feat(index): start slack-internal-api when local MCP is enabled"
```

---

## Task 10: Constitution addendum

**Files:**
- Modify: `shared/constitution.md`

- [ ] **Step 1:** Append a section:

```markdown
## Slack posting

When you reply to a user in Slack via `slack_send_message`:

- The inbound prompt preamble shows `[sender in #channel, thread=<ts>]`. Pass that `<ts>` as `thread_ts` in your send call so your reply lands in the same conversation.
- Use `force_root: true` **only** when you are posting an unprompted broadcast (scheduled digest, cross-channel notification). Never set it when replying to a user message.
- Omitting both `thread_ts` and `force_root` is acceptable — the system will default to the current thread if one is active.
```

- [ ] **Step 2:** Re-render constitution (if there's a setup step for this) and commit.

```bash
npm run setup:constitution   # if script exists
git add shared/constitution.md
git commit -m "docs(constitution): add Slack threading guidance"
```

---

## Task 11: End-to-end smoke test (manual, documented)

**Files:** none (document in PR body)

- [ ] **Step 1:** With `slack.localMcpServer: true` on personal instance:
  1. Send a DM to an agent — verify single reply, no duplicate.
  2. Send a channel message — verify reply is threaded.
  3. Trigger a scheduled broadcast — verify it lands at channel root.
  4. Check logs for `Outbound echo suppressed` counter — should be 0 under normal operation.

- [ ] **Step 2:** Record observations in PR description.

---

## Quality gate

After all tasks, run:
```bash
npm run check
```
Expected: typecheck + lint + prettier + vitest all pass. Fix any failures before submitting.

---

## Rollback

If the feature flag misbehaves after merge:
1. Set `slack.localMcpServer: false` in the instance's `hive.yaml`.
2. Send SIGUSR1 or restart; agent-runner re-wires to the hosted MCP.
3. The internal API server is not started; echo cache keeps running (harmless — hosted MCP posts carry user identity, don't touch cache).

---

Plan saved to `docs/plans/2026-04-18-slack-self-echo-fix.md`. Ready to execute?
