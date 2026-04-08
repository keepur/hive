# Voice Pipeline (Vapi) — Design Spec

**Date**: 2026-04-08
**Issue**: #105
**Status**: Draft

## Problem

Hive agents can text (Slack, SMS, WebSocket) but can't talk. We want agents to make and receive phone calls — real conversations, not scripted bots. Jessica should be able to call a customer, tell them their cabinets are ready, coordinate a viewing appointment, and schedule delivery — all with her full context, memory, CRM access, and personality.

Beyond phone calls, the same voice pipeline should eventually power push-to-talk in the keepur-ios app (ChatGPT voice mode style). The architecture must support both transports.

## Design Decisions

### Voice orchestration: Vapi (pay for the hard part)

Turn detection, interruption handling, barge-in, silence thresholds — that's genuinely hard work. Vapi handles all of it, plus STT and TTS. We pay ~$0.05/min for orchestration and bring our own LLM.

Why not Retell/Bland? They run *their* LLM on the call. We need Claude as the brain — with the agent's full system prompt, memory, and tools.

Why not Twilio ConversationRelay? Only solves telephony. We'd need a separate solution for iOS push-to-talk. Vapi covers both (phone + Web/iOS SDK).

Why not Quo/OpenPhone (Sona)? Sona is a closed auto-receptionist — no custom LLM, no outbound, no tool calling. Quo stays our SMS channel.

### LLM routing: Custom LLM endpoint (Claude is the brain)

Vapi's custom LLM feature sends an OpenAI-compatible `/chat/completions` request to our server. We translate it to Claude API format, inject the agent's full context (soul, system prompt, memory), call Claude, and stream the response back in OpenAI format.

This means the agent on the phone is the *real* agent — same personality, same tools, same memory as when they're texting on Slack.

### Transport: Cloudflare Tunnel (already have infra)

Vapi needs to reach our endpoint. We already run Cloudflare Tunnel (`dodi-shop`) for the WebSocket/iOS connection at `shop.dodihome.com`. We add a new route (e.g., `voice.dodihome.com` or a path on the existing tunnel) pointing to the voice HTTP server.

## Architecture

```
Outbound call (agent-initiated):
  Agent (Jessica) calls voice_call tool via MCP
    → Voice MCP server calls Vapi API: create call
    → Vapi dials customer, streams audio
    → Vapi sends transcribed text to Hive (POST /chat/completions)
    → Voice adapter translates OpenAI → Claude, injects agent context
    → Claude responds with text (+ optional tool calls)
    → Voice adapter translates Claude → OpenAI format
    → Vapi speaks the response via TTS

Inbound call (customer-initiated):
  Customer dials Vapi phone number
    → Vapi answers, streams audio
    → Same /chat/completions flow as above
    → Agent identified by phone number → assistant mapping in config

Tool calls during live call:
  Claude responds with tool_call in the /chat/completions response
    → Vapi detects tool_call, sends webhook to our server URL
    → Voice adapter executes tool via agent's MCP servers
    → Returns result to Vapi
    → Vapi feeds result back into next /chat/completions request
```

## Components

### 1. Voice Adapter (`src/channels/voice/voice-adapter.ts`)

HTTP server that Vapi calls. Two endpoints:

**`POST /v1/chat/completions`** — Custom LLM endpoint
- Receives OpenAI-format messages from Vapi (conversation history as transcribed text)
- Identifies the agent from Vapi call metadata: each Vapi assistant is created with `metadata.hive_agent_id` set to the Hive agent ID (e.g., `"chief-of-staff"`). Vapi includes the full assistant object in the `/chat/completions` request body. The voice adapter extracts `hive_agent_id` from the request metadata and uses it to load the agent config from the registry. A `voice.assistants` mapping in hive.yaml maps Vapi assistant IDs to Hive agent IDs as a fallback/override. For the PoC with a single agent, this can be hardcoded initially and made dynamic in Phase 3.
- Builds agent system prompt via a new shared function in `src/agents/prompt-builder.ts`:
  ```typescript
  buildVoiceSystemPrompt(
    agentConfig: AgentConfig,
    memoryManager: MemoryManager,
  ): Promise<string>
  ```
  Assembly order: soul → systemPrompt → constitution → agent memory (hot-tier structured memory or legacy blob) → date/time stamp (last). This matches the main `buildSystemPrompt`'s static prefix (soul → systemPrompt → constitution) but omits the tool summary and delegate description sections that appear between constitution and memory in the main path. Those are excluded because tools are handled separately by the OpenAI translation layer, and delegates don't apply to voice calls. Date/time goes last for prompt cache efficiency (same reasoning as the main prompt).
- Translates to Claude API format
- Calls Claude via Anthropic SDK
- Streams response back in OpenAI SSE format
- Handles tool calls: returns OpenAI-format tool_call responses

**`POST /v1/tools`** — Tool execution endpoint (Phase 2)
- Receives tool call requests from Vapi
- Routes to appropriate MCP server (calendar, CRM, catalog, etc.)
- Returns results in Vapi's expected format (`{ results: [{ toolCallId, result }] }`)
- Note: Vapi configures tool server URLs **per-tool** in each tool's `server.url` field (not as a global assistant-level setting). Each Vapi tool definition must point its `server.url` to `voice.dodihome.com/v1/tools`. This is a Phase 2 concern.

**Port**: `portBase + 5` (default `3105`), configurable via `ports.voice` in hive.yaml (following the named-port pattern: `ports.recall`, `ports.ws`, `ports.adminApi`, etc.).

**Authentication**: Vapi sends a `server-secret` header on every request (configured in the Vapi assistant dashboard). The voice adapter validates this against `config.voice.serverSecret` and rejects requests where it's missing or wrong. Fail-closed — no secret configured means the endpoint refuses all requests. Follows the same pattern as `RECALL_WEBHOOK_SECRET` and `BG_TASK_AUTH_TOKEN`.

**Not a ChannelAdapter**: Unlike Slack, SMS, and WebSocket adapters, the voice adapter does NOT implement the `ChannelAdapter` interface and does NOT go through the Dispatcher. Vapi's custom LLM protocol is synchronous request/response — Vapi sends transcribed text, we return Claude's response inline. There's no WorkItem, no triage gate, no async delivery. The adapter calls Claude directly via the Anthropic SDK. Dispatcher integration comes in Phase 3 (inbound routing).

### 2. Voice MCP Server (`src/voice/voice-mcp-server.ts`)

Agent-facing MCP server — lets agents initiate and monitor calls.

**Tools:**

`voice_call` — Initiate an outbound call
- `to`: Phone number (E.164)
- `goal`: What the agent wants to accomplish on this call (injected into system prompt for the call)
- `context`: Optional additional context (order details, customer history, etc.)
- Returns: `call_id`, initial status

`voice_call_status` — Check call status
- `call_id`: The call to check
- Returns: status (ringing/in-progress/ended), duration, transcript (if ended), outcome summary
- In PoC, fetches status and transcript directly from the Vapi API (`GET /v2/call/{call_id}`). MongoDB persistence of call logs is deferred to a later phase.

`voice_list_calls` — List recent calls
- `limit`: Number of calls (default 10)
- Returns: Recent calls with status, duration, summary

### 3. OpenAI ↔ Claude Translation Layer (`src/channels/voice/openai-translator.ts`)

Stateless translation between OpenAI and Claude message formats:

- OpenAI `messages[]` → Claude `messages[]` (role mapping, tool call format differences)
- Claude response → OpenAI SSE chunks (streaming `delta` format)
- Tool call format translation (Claude's `tool_use` blocks ↔ OpenAI's `tool_calls` array)

This is a well-understood mapping — both APIs are documented and the differences are mechanical.

### 4. Call Session State

During a live call, we need to track:
- Which agent is on the call
- Call ID (Vapi) → agent ID mapping
- Channel context for tool routing (so CRM writes go to the right place)

Store in-memory during the call (`Map<vapiCallId, CallSession>`). Sessions are evicted after 2 hours (max reasonable call duration) via a periodic sweep, preventing leaks from crashed calls or lost webhooks. Persist call logs to MongoDB after the call ends for transcript storage and audit.

**MongoDB collection**: `voice_calls` — call_id, agent_id, phone_number, direction, started_at, ended_at, transcript, duration_ms, outcome.

### 5. Configuration

**hive.yaml** additions:
**hive.yaml**:
```yaml
voice:
  provider: vapi
  publicUrl: "https://voice.dodihome.com"  # Tunnel endpoint Vapi calls
  assistants:                               # Vapi assistant ID → Hive agent ID
    asst_abc123: chief-of-staff

instance:
  ports:
    voice: 3105                            # Or portBase + 5
```

**`.env`** (secrets — following the `QUO_API_KEY` / `RECALL_WEBHOOK_SECRET` pattern):
```
VAPI_API_KEY=...              # For outbound call initiation
VAPI_SERVER_SECRET=...        # Validates inbound Vapi requests
```

**`config.ts`** block (typed config, matching the pattern of `recall`, `codeTask`, etc.):
```typescript
voice: {
  enabled: !!hive.voice?.provider,
  provider: (hive.voice?.provider as string) ?? "",
  publicUrl: (hive.voice?.publicUrl as string) ?? "",
  assistants: (hive.voice?.assistants ?? {}) as Record<string, string>,
  apiKey: optional("VAPI_API_KEY", ""),
  serverSecret: optional("VAPI_SERVER_SECRET", ""),
  port: parseInt(optional("VOICE_PORT", String(ports.voice ?? portBase + 5)), 10),
}
```

**Vapi dashboard setup** (manual, one-time):
- Create assistant(s) with custom LLM URL pointing to `voice.dodihome.com/v1/chat/completions`
- Tool server URLs are configured per-tool in each tool's `server.url` field (Phase 2 — not needed for PoC)
- Pick voice per agent (May chooses)
- Provision or import phone number

### 6. Agent Wiring

Voice MCP server added to `buildAllServerConfigs()` in agent-runner.ts, gated on `config.voice` being present. Env vars passed to the MCP server process: `VAPI_API_KEY` (from `config.voice.apiKey`, loaded from `.env`), `VAPI_PHONE_NUMBER_ID`, `AGENT_ID`, `AGENT_NAME`. Follows the same pattern as the Quo MCP server wiring (lines 231–243 of agent-runner.ts). Added to agent `coreServers` lists as needed — start with chief-of-staff only for PoC.

**No `ChannelKind` change in PoC.** The voice adapter bypasses the Dispatcher entirely (see Component 1). Adding `"voice"` to `ChannelKind` is deferred to Phase 3 when inbound calls integrate with the Dispatcher and need triage/routing decisions.

## PoC Scope (Phase 1)

Build just enough to prove Claude can have a real phone conversation via Vapi:

1. **Voice adapter** with `/v1/chat/completions` endpoint (OpenAI ↔ Claude translation, agent context injection)
2. **Voice MCP server** with `voice_call` and `voice_call_status`
3. **Vapi account setup** — assistant, phone number, custom LLM URL
4. **Cloudflare Tunnel route** for voice endpoint
5. **Config + Keychain** wiring

### PoC explicitly defers:
- Inbound call routing (needs phone number → agent mapping + dispatcher integration)
- Live tool calling during calls (needs tool execution endpoint + MCP server bridging)
- iOS push-to-talk (Vapi iOS SDK integration, keepur-ios changes)
- Multiple agents with different voices
- Call recording/transcript persistence to MongoDB
- Call cost tracking

### PoC success criteria:
- Mokie tells an agent to call a phone number with a goal
- The phone rings, a voice answers as the agent
- A natural two-way conversation happens with Claude as the brain
- Agent gets the transcript back after the call ends

## Future Phases

**Phase 2 — Live tools**: Tool execution endpoint, so the agent can check calendars, look up orders, and book appointments mid-call.

**Phase 3 — Inbound**: Phone number → agent routing, dispatcher integration, ring-to-answer flow. Customers call in and talk to Jessica/Wyatt directly.

**Phase 4 — iOS push-to-talk**: Vapi Web/iOS SDK in keepur-ios. Same voice pipeline, different transport. Push-to-talk UX in the app.

**Phase 5 — Multi-agent voices**: Each agent gets their own voice. May picks voices for Jessica, Wyatt, etc.
