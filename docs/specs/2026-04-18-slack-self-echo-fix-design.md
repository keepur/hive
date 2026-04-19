# Slack Self-Echo Runaway Fix

## Problem

When an agent calls the hosted Slack MCP's `slack_send_message` tool (`https://mcp.slack.com/mcp`, authed with `SLACK_MCP_TOKEN = xoxp-…`), Slack attributes the post to the token owner — a human user — and re-delivers it via Socket Mode as an **inbound message from that user**. The gateway's self-loop filter at `src/slack/slack-gateway.ts:105-108` only drops events tagged with the bot's `user_id`/`bot_id`, so user-token echoes slip through, get dispatched, and spawn new agent sessions.

Compounded by agents not threading their replies: each echo routes to a fresh session via channel mapping instead of queueing on the running thread.

### Incident: 2026-04-19 03:31 UTC, hive-dodi, `#agent-river`

May said "Hey River" (9 chars). Cascade:
- **03:31:14** May: "Hey River"
- **03:31:18** Session A (Sonnet) starts
- **03:31:23** Session A calls hosted-MCP `slack_send_message` with a quick ack
- **03:31:25** Ack arrives back as `user=U01467… (May)`, 60 chars
- **03:31:29** Session B spawns on the echo, confabulates "On it — putting the May content plan together now"
- **03:32:29 – 03:33:21** Session A (still running) emits a full content plan across 5 `slack_send_message` calls; each chunk loops back and spawns Sessions C, D, E
- Self-limits only because later sessions produce closure-sounding text

Single incident cost ≈ $0.60. Runaway is unbounded in principle.

## Root cause (corrected from first draft)

The adapter's **primary reply path is not the defect**. Agent final responses flow through `dispatcher → slack-adapter.deliver → slack-gateway.postMessage`, which uses `this.web` constructed with `SLACK_BOT_TOKEN` (gateway.ts:43-44, config.ts:96). Those posts carry `event.bot_id = <this bot>` and are correctly dropped by the existing filter at gateway.ts:107.

The defect is that **agents have direct access to the hosted MCP's `slack_send_message`** and use it to post mid-session (intermediate acks, cross-channel posts, progress updates). These posts bypass the adapter entirely and use the user token, producing the echo.

Secondary defect: the hosted MCP's sends don't set `thread_ts`, so the dispatcher's `threadAgentMap` (`src/channels/dispatcher.ts:36`) can't route echoes back to the originating session — each echo spawns a new parallel session instead of queueing on the running thread.

## Goals

1. Agents can still post to Slack mid-session (the capability is real — intermediate acks, multi-channel updates).
2. Outbound posts authored by agents are attributable to the bot and dropped by the gateway's self-loop filter.
3. Replies default to in-thread so a single conversation stays in one session, not N parallel sessions.
4. Containment: if a future MCP reintroduces user-auth posting, a secondary guard drops the echo with zero false positives.

## Non-goals

- Changing `SLACK_MCP_TOKEN` away from a user token — user auth is still useful for reads/searches if we keep any hosted-MCP access.
- Changing multi-agent thread participation semantics.
- Auditing every MCP for similar echo patterns (separate follow-up).

## Design

### Fix 1 — Replace hosted Slack MCP with a local stdio Slack MCP server

Build `src/slack/slack-mcp-server.ts`: a stdio MCP that exposes the Slack surface agents actually need, all backed by `SLACK_BOT_TOKEN` via `@slack/web-api` (already a dependency).

**Rationale vs. "just block `slack_send_message` on the hosted server":** the hosted MCP has no per-tool whitelist/blacklist mechanism. Options are (a) keep the whole hosted MCP including send (what we have — broken), (b) remove the whole hosted MCP from agents (loses read/search), or (c) replace it with a local server we fully control. (c) is the only clean answer.

**Tool surface (v1, mirroring what agents currently use):**
- `slack_send_message(channel, text, thread_ts?, blocks?, force_root?)` — `chat.postMessage`
- `slack_read_channel(channel, limit?)` — `conversations.history`
- `slack_search_messages(query, limit?)` — `search.messages` (requires user token; see scope note)
- `slack_list_channels(query?)` — `conversations.list`
- `slack_read_user_profile(user)` — `users.info`

**Send semantics:**
- **Threading is agent-explicit, not auto-injected.** The tool accepts `thread_ts` as a parameter. The agent-runner already prepends `[senderName in #channel, thread <ts>]`-style context to user messages (`src/agents/agent-manager.ts` prompt assembly) — we extend this preamble to include `thread_ts` verbatim, and the tool description instructs the agent to pass it back when replying in-thread.
- **`force_root: true`** is an explicit boolean for broadcast/scheduled posts that should land at channel root. This is the escape hatch for things like morning reports. Chosen over `thread_ts: null` per reviewer feedback — MCP JSON schemas handle booleans cleanly, agents tend to omit-vs-null inconsistently.
- System prompt addendum (constitution-level): "When replying to a user message, pass `thread_ts` from the preamble. Only omit `thread_ts` or set `force_root: true` for unprompted broadcasts."

**Why not plumb thread context via env vars?** MCP subprocesses are long-lived across many turns; env is set once at spawn and is stale by turn 2. Threading responsibility lives with the agent (who sees fresh per-turn context in the prompt), not with the tool subprocess. This was the B1 defect in the v1 draft.

**Search tool scope caveat:** `search.messages` requires `search:read`, which is a user-token scope. If we need search, we can either (i) keep a small hosted-MCP surface for search-only, (ii) use a user token inside the local server for search specifically while using bot token for everything else (keeps tool origins unified), or (iii) drop search until a follow-up. Decision deferred to implementation kickoff — agents' actual search usage on hive-dodi is low.

### Fix 2 — Agent-runner selects bot token per instance

`config.ts` already has per-instance Slack configs (`slack`, `slackJasper`). Agent-runner's `buildAllServerConfigs()` passes the instance-appropriate `SLACK_BOT_TOKEN` into the local MCP server's env at spawn. Same selection logic as `getBotIdForInstance` / `config.slack`.

### Fix 3 — Local MCP is a thin RPC shim; hive process owns the WebClient and cache

The local Slack MCP is a stdio subprocess and cannot share memory with the gateway. Rather than have the subprocess hold its own WebClient and call a separate registration endpoint (which introduces an ordering race between post and cache registration), the local MCP is a **thin RPC shim**: the subprocess forwards tool calls to a localhost HTTP endpoint on the hive process, which owns the WebClient, the echo cache, and the active-WorkItem tracking. This makes the post and the cache registration atomic from Slack's perspective — by the time the hive process returns the `ts` to the subprocess, the `ts` is already in the cache, and the Socket Mode listener and cache writer are in the same process.

**Endpoints** (localhost, bearer auth — see token note below):

- **`POST /internal/slack/send`** with body `{ agent_id, channel, text, thread_ts?, blocks?, force_root? }` → runs the threading fallback (Fix 4), calls `chat.postMessage` via the instance-appropriate bot WebClient, writes the returned `ts` into `outboundTsCache`, returns `{ ok, ts, channel }` to the subprocess. All three operations happen in-process, synchronously, before the response returns.
- **`POST /internal/slack/read`**, **`/search`**, **`/channels`**, **`/users`** — corresponding thin shims for the read tools. These don't touch the cache but share the bot-token WebClient.

**Gateway filter:** add one check before dispatching:
```
if outboundTsCache.has(event.ts) → drop (log: echo suppressed)
```

The adapter's existing reply path (`slack-adapter.deliver → gateway.postMessage → chat.postMessage`) also writes into `outboundTsCache` on success. Every bot-token outbound — whether adapter-initiated or agent-initiated — registers its `ts` before any Slack echo could race back through Socket Mode.

**Keyed on `ts`, not text-hash.** Slack's `ts` is workspace-unique per message. Zero false positives.

**Concurrent thread note:** an agent can have up to `maxConcurrent` threads active (default 3, `agent-manager.ts:151`). The local MCP subprocess is one per agent session, shared across all its threads. Since the subprocess is a stateless shim, it doesn't need to know which thread is active — it just forwards the agent's tool call arguments. The hive endpoint resolves context from (a) explicit `thread_ts` passed by the agent, or (b) the fallback below.

### Fix 4 — Threading: agent-explicit with server-side fallback

Threading is primarily the agent's responsibility, with a defensive fallback so instruction drift doesn't reintroduce the cascade.

**Agent path (common case):**
- `agent-runner` extends the per-turn preamble from `[senderName in #channel]` to `[senderName in #channel, thread=<ts>]`.
- System prompt instruction: "When replying to a user message, pass `thread_ts` from the preamble. Set `force_root: true` only for unprompted broadcasts."

**Server fallback (when the agent omits `thread_ts` on a non-`force_root` call):**
- `POST /internal/slack/send` inspects new `AgentManager` state (`activeWorkItems: Map<agentId, WorkItem[]>`) — the in-flight WorkItems for that agent at the moment of the call.
- `/internal/slack/send` normalizes `channel` to a Slack channel ID first (via the gateway's existing channel-name cache used by `resolveChannelName`, inverse lookup). Agents may pass names like `agent-river` or IDs like `C0AHZ…`; both resolve to the same key before matching.
- If exactly one active WorkItem matches the resolved channel ID, use its `thread_ts` (falling back to its message `ts` if the inbound was top-level — reply creates a new thread).
- If multiple match, use the most recently started.
- If none match (proactive post, scheduled sweep, cross-channel notification), post at channel root.

**New state — `activeWorkItems`:** `AgentManager` currently tracks `state.currentSessionId` post-turn, not per-turn work. We add:
- A `Map<agentId, WorkItem[]>` set when `processThreadQueue` begins a turn and cleared on completion. Guarded by per-thread serialization, so per `(agentId, threadKey)` there's at most one entry at a time.
- Read-only access from the `/internal/slack/send` handler.

**`force_root: true`** bypasses the fallback and posts at channel root. Used by scheduled broadcasts and cross-channel notifications where threading would be wrong.

**Why not just force threading unconditionally?** Breaks scheduled morning reports, cross-channel pings, and any legitimate top-level post. The `force_root` switch is agent-authored intent.

### Internal endpoint auth — risk-accept

The subprocess authenticates to `/internal/slack/*` using `HIVE_INTERNAL_TOKEN` plumbed into its env at spawn. Because agents run with `bypassPermissions` and have Bash access, an agent can read the subprocess env and extract this token. We explicitly **risk-accept** this exposure:

- Agents already have full Slack capability via the MCP tool itself. Reading the internal token gives them no capability they don't already have via the sanctioned tool surface.
- The internal endpoint is bound to localhost only and not reachable from other hosts. Token leak is not a lateral-movement risk unless the host itself is compromised, at which point the attacker has everything.
- The endpoint is scoped to Slack operations, not credential retrieval. It cannot exfil Keychain or other sensitive state.

This mirrors the `BG_TASK_AUTH_TOKEN` posture — same mechanism, same risk-acceptance.

### Fix 5 — Observability

- Log counter: `slack-gateway: outbound echo suppressed` with `channel, ts, age_ms`. Alert if rate > 5/min (indicates a regression).
- Log counter: `dispatcher: session spawn rate` per (channel, 60s window). Alert if > 3 — would have caught the incident in under a minute.
- Both land in existing Loki/log-grep path; no new infra.

### DM / channel-kind rules

Applies to the threading system-prompt guidance and the `force_root` escape hatch:

- `event.channel` prefix `D` → DM. Agent should reply without `thread_ts` (DMs don't need threading). Tool doesn't enforce — agent decides per preamble guidance.
- Prefix `G` → group DM. Same as DM.
- Prefix `C` → public channel. Thread by default.
- Private channel IDs also start with `C` (Slack doesn't distinguish in ID prefix). Same rule: thread by default.

## Rollout

**Mutual exclusion:** when `slack.localMcpServer: true`, `agent-runner`'s `buildAllServerConfigs()` registers the local MCP **instead of** the hosted MCP — never both at once. Tool names are identical between the two servers, so running them concurrently would cause SDK tool-name collisions. Rollback is a flag flip (config wiring swaps back), not a live dual-registration.

**Prerequisite before step 5: tool-parity audit.** Grep the last 30 days of `agent-runner` logs on hive-dodi for `tool call started` + `mcp__slack__` and enumerate every hosted-Slack tool agents actually invoke. For each, decide: port to local MCP v1, port in v2, or drop. Includes the search-scope decision below. This audit gates step 5; don't skip it.

1. Land local Slack MCP server + internal HTTP endpoint + echo cache behind feature flag `slack.localMcpServer: true` in `hive.yaml`.
2. Pre-flight check on startup: verify bot token has `chat:write`, `chat:write.public`, `chat:write.customize`, `channels:history`, `channels:read`, `users:read`. Fail loudly if missing; don't silently fall back. (Token rotations mid-run surface as tool errors, not startup failures — known gap, acceptable for v1.)
3. Enable on personal instance first. 24h burn-in. Verify:
   - No duplicate posts in channels.
   - Replies threaded correctly on user messages.
   - Scheduled morning reports still post to channel root.
   - Echo-suppression counter stays at 0 (if non-zero, investigate).
4. Enable on hive-dodi. Same checks. 48h watch.
5. **After tool-parity audit closes:** remove hosted Slack MCP from agent seeds. Echo cache stays on permanently.

## Rollback

If the local server misbehaves:
- Flip `slack.localMcpServer: false` → agent-runner falls back to hosted MCP wiring.
- Hosted MCP's `slack_send_message` remains exposed during burn-in specifically so rollback doesn't strip send capability.
- System prompt addendum (threading guidance) is benign for hosted MCP too — no prompt rollback needed.
- Only full-rollback concern: if a new agent seed has been written to rely on a local-only tool name, that agent breaks. Mitigation: keep tool names identical to hosted MCP (`slack_send_message`, `slack_read_channel`, etc.) so the only thing switching is transport.

## Impact

- **User-visible:** none if we keep posting as the bot (current behavior). If we later add per-agent username/avatar rendering via `chat:write.customize`, that's a separate follow-up.
- **Agent-visible:** same tool names, one new parameter (`force_root`), one preamble field (`thread_ts` in the `[senderName in #channel]` header). Minimal prompt churn.
- **Cost:** removes runaway risk. Incident-class loops become impossible once hosted-MCP send is gone.

## Test plan

- Unit: local MCP `slack_send_message` → bot-token WebClient call; `thread_ts` passes through; `force_root` suppresses threading.
- Unit: echo cache adds on successful post, drops matching inbound, expires after TTL.
- Integration: stand up a test channel, call the tool, confirm no inbound event dispatches to dispatcher.
- Reproduce: replay the "Hey River" incident against the new code. Expect one session, one threaded reply, zero cascade.
- Regression: scheduled morning report posts to channel root with `force_root: true`. Verify thread_ts not set.
- Scope failure: start with a token missing `chat:write` — preflight must fail startup.

## Open items

**Gating step 5 (hosted-MCP removal):**
- **Search scope:** keep hosted MCP just for search, use user token inside local server for search only (bot token for everything else), or drop search? Requires the tool-parity audit output to decide.
- **Tool parity audit:** 30-day hosted-MCP tool usage on hive-dodi. Output feeds the v1 tool surface and the search decision.

**Nice-to-have (doesn't gate rollout):**
- **Per-agent identity:** do we want `username` / `icon_url` override on posts, or stick with bot identity? Requires `chat:write.customize`. Can ship as v2.
