# Implementation Plan: Conversation Recall

**Spec:** `docs/specs/2026-03-15-conversation-recall-design.md`
**Date:** 2026-03-15

## Tasks

### Task 1: Create conversation index module

**File:** `src/search/conversation-index.ts` (new)

Create the embed + store module. This is the write-side of the system — called fire-and-forget from agent-manager after each response.

- Export `ConversationDocument` interface (agentId, threadId, channelId, source, senderName, timestampUnix, timestamp, inbound, response)
- Export `ConversationIndex` class:
  - Constructor takes Qdrant URL and Ollama URL
  - Lazy-init QdrantClient and ensure collection exists on first write (create-if-not-exists with correct vector size)
  - `index(doc: ConversationDocument): Promise<void>` — embed concatenation of `inbound + "\n\n" + response`, upsert point with payload
  - `search(query: string, agentId: string, limit: number, sinceUnix?: number): Promise<ConversationResult[]>` — embed query, search with agentId filter + optional timestampUnix range filter, return formatted results
- Use `embedOllama()` from `search-shared.ts` for embeddings
- Use UUID v4 for point IDs
- Collection name: `conversations`
- Handle Qdrant range filter for `sinceUnix` using `must` conditions with `range` filter (not `match`)
- Reference: `search-shared.ts` for embed function, `ops-search-mcp-server.ts` for Qdrant patterns

### Task 2: Create conversation search MCP server

**File:** `src/search/conversation-search-mcp-server.ts` (new)

Follow the exact pattern of `ops-search-mcp-server.ts`:
- Import McpServer, StdioServerTransport, z
- Create `ConversationIndex` instance
- Register one tool: `conversation_search`
  - Params: query (string, required), agentId (string, optional), limit (number, optional, default 10), since (string, optional — ISO date)
  - Access control: read `AGENT_ID` from env. If `agentId` param provided and differs from `AGENT_ID`, reject unless `AGENT_ID === "chief-of-staff"`
  - Convert `since` ISO string to Unix epoch for the range filter
  - Format results showing: index, timestamp, channel, sender, inbound snippet, response snippet, score
- Connect via StdioServerTransport

### Task 3: Register server in agent-runner

**File:** `src/agents/agent-runner.ts`

In `buildMcpServers()`, add `conversation-search` entry after the other search servers (after ops-search, around line 368):

```typescript
servers["conversation-search"] = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/search/conversation-search-mcp-server.js")],
  env: { ...searchEnv, AGENT_ID: this.agentConfig.id },
};
```

Note: uses `searchEnv` (shared Qdrant/Ollama config) plus `AGENT_ID` for access control.

### Task 4: Wire up fire-and-forget indexing in agent-manager

**File:** `src/agents/agent-manager.ts`

- Import `ConversationIndex` from `../search/conversation-index.js`
- Create a singleton `ConversationIndex` instance (lazy, same pattern as other singletons)
- After `item.resolve(result)` (line 193), add fire-and-forget indexing:
  ```typescript
  if (result.text && !result.error) {
    conversationIndex.index({
      agentId,
      threadId,
      channelId: item.message.source.id,
      source: item.message.source.kind,
      senderName: item.message.senderName ?? "unknown",
      timestampUnix: Math.floor(Date.now() / 1000),
      timestamp: new Date().toISOString(),
      inbound: prompt,
      response: result.text,
    }).catch(err => log.warn("Conversation indexing failed", { agentId, error: String(err) }));
  }
  ```
- For scheduler source: the `prompt` contains schedule config which is noisy, but acceptable for v1. Can refine later.

### Task 5: Add conversation-search to all agent templates

**Files:** All `agents-templates/*/agent.yaml.tpl`

Add `conversation-search` to the `servers` list in every agent template. Place it near the other search servers.

Agents: chief-of-staff, customer-success, devops, executive-assistant, marketing-manager, product-manager, product-specialist, production-support, sdr, vp-engineering.

### Task 6: Build and verify

- Run `npm run typecheck` to verify no type errors
- Run `npm run build` to compile
- Run `npm run check` for full quality gate
- Verify the new files are in `dist/search/`
