# Conversation Recall

**Date:** 2026-03-15
**Status:** Draft
**Author:** May + Claude

## Problem

Agents have no memory of past conversations unless they explicitly write to their memory file. They frequently forget to do this, meaning knowledge dies with the session (7-day TTL). When a contact or topic comes up again in a new thread, the agent starts from zero.

## Goals

1. **Agent recall** — agents can search their own past conversations to recall prior interactions with contacts, projects, or topics
2. **Accountability** — May (or Mokie) can search any agent's conversation history to see what was said

## Non-Goals

- Cross-agent awareness (agents seeing each other's conversations)
- Automatic context injection into prompts
- Backfilling historical conversations from Slack
- Replacing the existing memory MCP (explicit memory remains for persistent notes, preferences, etc.)

## Design

### Data Flow

```
Inbound message + Agent response
  → Agent Manager (after response complete)
  → Fire-and-forget to embed pipeline
  → Embed text (Ollama bge-large, same as CRM/ops)
  → Store in Qdrant collection: "conversations"
```

The agent manager has access to both the WorkItem (inbound context) and the RunResult (agent response). Tap it there.

### Document Structure

Each document in Qdrant represents one conversation turn (inbound message + agent response paired together).

```typescript
interface ConversationDocument {
  // Qdrant payload fields
  agentId: string;           // "sdr", "customer-success", etc.
  threadId: string;          // for grouping turns in same thread
  channelId: string;         // Slack channel, SMS line, etc.
  source: string;            // ChannelKind: "slack" | "sms" | "email" | "scheduler" | "callback" | "internal" | "app"
  senderName: string;        // who sent the inbound message
  timestampUnix: number;     // Unix epoch seconds (for Qdrant range filtering)
  timestamp: string;         // ISO 8601 (for display)
  inbound: string;           // the message the agent received
  response: string;          // what the agent said back
}
```

**Embedding text:** Concatenation of inbound + response, so semantic search matches on either side of the conversation.

### MCP Server

New dedicated search server: `src/search/conversation-search-mcp-server.ts`

Follows the same pattern as `ops-search-mcp-server.ts` and `product-search-mcp-server.ts` — Qdrant client + Ollama embeddings, stdio subprocess per agent session.

One tool:

```
conversation_search(query, agentId?, limit?, since?)
```

- **query** (required) — semantic search query ("Ryan Steele kitchen project", "permit issues")
- **agentId** (optional) — defaults to calling agent's `AGENT_ID` env var. Chief-of-staff can pass any agent ID; other agents are restricted to their own.
- **limit** (optional) — max results, default 10
- **since** (optional) — ISO date string, converted to Unix epoch for Qdrant range filter on `timestampUnix`

Returns results ranked by relevance with timestamp, channel, sender, and the conversation turn.

**Access control:** The server receives `AGENT_ID` as an env var (same as all MCP servers). If `agentId` parameter differs from `AGENT_ID` and `AGENT_ID !== "chief-of-staff"`, reject the request.

### Integration Point

In `agent-manager.ts`, after a successful response (around line 172-193 where `runner.send()` returns and the result is processed):

```typescript
// After response is delivered
if (result.text) {
  conversationIndex.index({
    agentId,
    threadId: workItem.threadId,
    channelId: workItem.source.id,
    source: workItem.source.kind,
    senderName: workItem.senderName ?? "unknown",
    timestampUnix: Math.floor(Date.now() / 1000),
    timestamp: new Date().toISOString(),
    inbound: prompt,
    response: result.text,
  }).catch(err => log.warn("Conversation indexing failed", { err }));
}
```

Fire-and-forget — indexing failures must never block or fail message delivery.

**Scheduled tasks:** The `prompt` for scheduled tasks contains the schedule config text, which is noisy. For `source: "scheduler"`, use the task name from the schedule config as the inbound text instead.

### Infrastructure

- **Qdrant collection:** `conversations` — created on first write (upsert-if-not-exists), no startup initialization needed
- **Embeddings:** Ollama `bge-large` (same model and dimensionality as existing search servers, controlled by `KB_EMBED_MODEL`)
- **New MCP server:** `src/search/conversation-search-mcp-server.ts` — added to agent `servers` lists in agent.yaml

### Contact Name Extraction

Defer to search relevance rather than NER. The semantic search will match on names in the text naturally. The `senderName` field provides the message author for filtering.

## What Changes

| File | Change |
|------|--------|
| `src/agents/agent-manager.ts` | After response, fire-and-forget index call |
| `src/search/conversation-search-mcp-server.ts` | New file — MCP server with `conversation_search` tool |
| `src/search/conversation-index.ts` | New file — embed + store logic (shared between indexer and MCP server) |
| `src/agents/agent-runner.ts` | Register new MCP server in server map |
| `agents-templates/*/agent.yaml.tpl` | Add `conversation-search` to server lists |

## What Doesn't Change

- Existing memory MCP tools (read/write/list/history/rollback)
- Session store and session resumption
- Agent system prompt assembly
- Triage and model routing
- Existing search servers (CRM, ops, product)

## Risks

- **Token cost** — embedding every conversation turn costs Ollama compute (local, no API cost) but adds ~100ms latency per index call. Fire-and-forget mitigates this.
- **Storage** — at ~10-20 agent conversations per day, Qdrant storage is negligible.
- **Noise** — trivial messages ("thanks", "got it") get indexed too. Search relevance should naturally deprioritize these, but could add a minimum message length filter if needed.
- **Scheduled task output** — scheduled tasks produce useful context but noisy inbound text. Use the task name as inbound instead of the raw schedule config.
