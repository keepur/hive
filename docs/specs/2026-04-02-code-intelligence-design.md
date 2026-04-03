# Code Intelligence — Design Spec

**Date**: 2026-04-02
**Status**: Draft
**Epic**: Code Intelligence

## Problem

Agents re-read the same source files every session. When Jasper spawns a `code_task`, the inner Claude Code session starts blind — no memory of past exploration, no index of what exists where. It Globs, Greps, and Reads its way through the codebase from scratch every time.

This gets worse as agents take on real PM and self-directed dev work. A task like "add validation to the catalog API" requires understanding the catalog module structure, existing patterns, related modules — context that was probably built in a previous session and thrown away.

Two gaps:

1. **No persistent code understanding** — insights from completed code_task sessions are lost
2. **No searchable codebase map** — agents can't ask "where is the routing logic?" without reading files

## Scope

Two features, one epic, one branch:

- **Part 1: Codebase Index** — searchable file-level summaries of Hive + dodi_v2
- **Part 2: Session Knowledge Capture** — persist code insights from completed code_task sessions

---

## Part 1: Codebase Index

### What

A nightly job that walks source files in Hive and dodi_v2, generates concise summaries, embeds them, and stores them in a searchable vector index. Agents query it via a new `code-search` MCP server.

### Indexer Pipeline

Runs as a standalone script (`scripts/code-index.ts`), triggered by crontab.

**Steps:**

1. **Discover files** — walk each repo, respect `.gitignore`, filter by extension and path
2. **Diff against last run** — compare file git SHAs to stored SHAs. Skip unchanged files
3. **Summarize** — send changed files to Claude Haiku in batches. Extract:
   - One-sentence summary of what the file does
   - Exported names (functions, classes, constants, types)
   - Key dependencies (imports from project modules, not node_modules)
   - File role tag: `entry`, `config`, `model`, `service`, `handler`, `util`, `test`, `type-defs`
4. **Embed** — generate vector from summary text using Ollama bge-large (same as memory system)
5. **Store** — upsert to Qdrant `code_index` collection + MongoDB `code_index` collection

**File filters:**

| Repo | Include paths | Include extensions | Exclude patterns |
|------|--------------|-------------------|-----------------|
| hive | `src/`, `plugins/dodi/` | `.ts` | `*.test.ts`, `*.spec.ts`, `dist/` |
| dodi_v2 | `src/modules/`, `src/apps/`, `src/services/` | `.ts`, `.tsx`, `.js` | `*.test.*`, `*.spec.*`, `node_modules/`, `.meteor/`, `dist/`, `build/` |

Estimated file count: ~3,000–5,000 across both repos. Full index: ~$2 in Haiku calls. Incremental: pennies.

**Batching strategy:**

Files are batched by size for Haiku calls. Each batch prompt includes 5–10 small files (under 200 lines each) or 1 large file (truncated to first 300 lines with a truncation note in the summary). Output is structured JSON per file.

**Error handling:** Per-file isolation. If a Haiku call fails for a batch, retry files individually. If a single file fails, log the error, skip it, and leave its prior SHA unchanged in MongoDB so it's retried next run. Never let one bad file block the rest of the index.

### Storage Schema

**MongoDB collection: `code_index`**

```
{
  _id: ObjectId,
  repo: string,              // "hive" | "dodi_v2"
  filePath: string,          // relative to repo root: "src/gateway/dispatcher.ts"
  gitSha: string,            // SHA of file content at index time
  summary: string,           // one-sentence description
  exports: string[],         // ["dispatchMessage", "DispatcherConfig"]
  dependencies: string[],    // ["./agent-runner", "../memory/memory-store"]
  role: string,              // "handler" | "service" | "model" | "util" | etc.
  language: string,          // "typescript" | "javascript" | "tsx"
  lineCount: number,
  qdrantPointId: string,     // deterministic UUIDv5 from `${repo}:${filePath}`
  indexedAt: Date,
  indexVersion: number        // schema version, start at 1
}
```

**Indexes:**
- `{ repo: 1, filePath: 1 }` — unique, for upsert
- `{ repo: 1, role: 1 }` — filter by file role
- `{ indexedAt: 1 }` — cleanup queries

**Qdrant collection: `code_index`**

- Vector: Ollama bge-large dimensions (1024)
- Distance: Cosine
- Payload: `{ repo, filePath, role, language, summary }` (denormalized for filter+display without MongoDB round-trip)
- Filters: `repo`, `role`, `language`

### MCP Server: `code-search`

New core MCP server at `src/code-index/code-search-mcp-server.ts`. Stdio process, standard pattern.

**Tools:**

**`code_search`** — semantic search over the codebase index

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Natural language query: "where is agent routing handled?" |
| `repo` | enum | no | Filter to `hive` or `dodi_v2`. Default: search both |
| `role` | string | no | Filter by file role tag |
| `limit` | number | no | Max results. Default: 10 |

Returns: list of `{ filePath, repo, summary, exports, role, score }` sorted by relevance.

**`code_lookup`** — direct file info retrieval

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `filePath` | string | yes | Relative file path |
| `repo` | string | no | Which repo. Default: search both |

Returns: full index record for the file (summary, exports, dependencies, role), or "not indexed" if absent.

**Env vars:** `MONGODB_URI`, `MONGODB_DB`, `QDRANT_URL`, `OLLAMA_URL`

**Agent access:** Add `code-search` to `coreServers` for Jasper, Mokie, and Chloe (agents that work with code or do PM). Not all agents — Rae, Milo, and other chat-focused agents don't need it. Each agent's definition must include `"code-search"` in its `coreServers` array for `filterCoreServers()` to pass it through.

### Pre-fetch Integration

When the code_task manager spawns a new task, it queries the code index with the task prompt and prepends relevant context:

```
## Codebase Context (auto-retrieved)
Based on your task, these files are likely relevant:
- src/catalog/catalog-api.ts — REST API endpoints for catalog CRUD (exports: getCatalogItem, updateCatalogItem)
- src/catalog/catalog-store.ts — MongoDB data access layer for catalog (exports: CatalogStore)
- src/catalog/types.ts — TypeScript interfaces for catalog domain (exports: CatalogItem, CatalogFamily)

Use code_search for additional exploration. Results may be stale — verify by reading files.
```

This costs one Qdrant query (~1ms) per task spawn. The inner session starts informed instead of blind.

**Implementation:** Factor pre-fetch into a standalone `CodeIndexPrefetcher` class (`src/code-index/prefetcher.ts`) with its own Qdrant/Ollama/MongoDB connections. Injected into `CodeTaskManager` via `CodeTaskManagerOptions`:

```typescript
// In CodeTaskManagerOptions (optional — prefetch degrades gracefully if absent)
prefetcher?: CodeIndexPrefetcher;
```

`src/index.ts` constructs the prefetcher and passes it in. `CodeTaskManager.spawnTask()` calls `prefetcher.getContext(prompt)` if available.

`CodeIndexPrefetcher.getContext(prompt)`:
1. Embeds the task prompt via Ollama
2. Queries `code_index` Qdrant collection (top 8 results, score > 0.65 — tunable via config, calibrate after first index run)
3. Queries `agent_memory` Qdrant collection filtered to `topic: /^code:/` (top 5 results)
4. Formats as markdown and returns (caller prepends to prompt)

### Crontab Entry

```
0 5 * * *  cd /Users/mokie/github/hive && npx tsx scripts/code-index.ts >> logs/code-index.log 2>&1
```

Runs at 5am, after HubSpot pipeline (3am) and embed pass (4am). Incremental — only re-indexes files with changed git SHAs.

### Manual Trigger

```bash
npx tsx scripts/code-index.ts                    # full index
npx tsx scripts/code-index.ts --repo hive        # hive only
npx tsx scripts/code-index.ts --repo dodi_v2     # dodi only
npx tsx scripts/code-index.ts --full             # force re-index all files
```

---

## Part 2: Session Knowledge Capture

### What

When a `code_task` completes, automatically extract code insights from the session output and persist them to the agent's structured memory. Future sessions can recall these insights via `memory_recall` or receive them via pre-fetch.

### How It Works

**Post-completion extraction** — decoupled from the completion notification path.

`fireCompletion()` is fire-and-forget today. Knowledge extraction must not delay or block the completion callback to Jasper. Implementation:

1. `fireCompletion()` delivers the completion notification to Jasper as it does today (unchanged)
2. After `onComplete` fires, spawn extraction as an independent async side-effect — `extractKnowledge(task).catch(log)`. Failures are logged, never propagated.
3. `KnowledgeExtractor.extract(task)`:
   a. Read the session output (already captured as the task result)
   b. Send output to Haiku with an extraction prompt:
      - "Extract code insights from this session. For each file the session read or modified, note: what it does, key patterns found, gotchas encountered, architectural decisions made. Return as JSON array."
   c. For each extracted insight:
      - Delete any existing records with matching `agentId` + `topic` (prevents unbounded duplicates)
      - Call `MemoryStore.save()` with:
        - `agentId`: the agent that spawned the task (from `CodeTaskContext`)
        - `type`: `"fact"`
        - `topic`: `"code:<repo>:<filePath>"` (e.g., `"code:hive:src/gateway/dispatcher.ts"`)
        - `importance`: `"medium"` (default; `"high"` if the session modified the file)
        - `content`: the extracted insight
   d. Embed and upsert to Qdrant `agent_memory` collection (existing flow)

**Why Haiku post-extraction instead of in-session writing:**
- Reliable — doesn't depend on the inner session remembering to save
- Cheap — one Haiku call per completed task (~$0.001)
- Clean — no new tools or MCP servers needed in the inner session
- Consistent — extraction prompt is tuned once, applies to all tasks

### Staleness

Code knowledge has a natural expiration: the code changes. Two mechanisms handle this:

1. **Delete-before-save** — before saving a new insight for `code:hive:src/foo.ts`, the extractor deletes any existing non-pinned records with the same `agentId` + `topic`. This keeps exactly one insight per file per agent. Simple, no new `MemoryStore` methods needed — just a `deleteMany()` call before `save()`. (The `supersededBy` field exists in the schema but has no implementation — we don't use it.)

2. **Natural lifecycle decay** — insights that aren't refreshed by new sessions decay via the 7-day half-life. Old insights about files the agent hasn't touched in weeks naturally cool to warm/cold tiers and eventually get summarized or purged.

### Pre-fetch Integration (shared with Part 1)

The `prefetchContext()` method in code_task manager queries **both** sources:

1. `code_index` Qdrant collection — structural knowledge ("this file exports X, depends on Y")
2. `agent_memory` Qdrant collection — experiential knowledge ("last time we modified this file, we found that...")

Both are returned in the context block, clearly labeled:

```
## Codebase Context (auto-retrieved)
Relevant files:
- src/catalog/catalog-api.ts — REST API endpoints for catalog CRUD

Previous session insights:
- catalog-api.ts: Validation middleware is applied per-route, not globally. The updateCatalogItem handler expects familyId in the body, not params.
```

### Memory Lifecycle Interaction

Session knowledge records participate in the existing lifecycle:

- **Type weight**: `fact` = 0.8 (appropriate — code knowledge is factual)
- **Importance**: `medium` (0.5) by default, `high` (0.75) for modified files
- **Decay**: 7-day half-life means insights from last week score ~0.5 on recency. Recent work stays warm; old insights naturally cool
- **Cold summarization**: the lifecycle summarizer groups by exact topic match, not prefix. Since we store one record per file (delete-before-save), individual file topics won't accumulate 5+ cold records. Cross-file rollup (e.g., "everything about the gateway") is a future enhancement — not needed for v1
- **Pinning**: agents can pin critical code insights via `memory_pin` if they want to preserve them

No changes to the memory system schema or lifecycle scoring are needed. The existing machinery handles code knowledge well.

---

## What This Does NOT Include

- **AST parsing / tree-sitter** — overkill for v1. Natural language summaries with embeddings are sufficient.
- **Real-time indexing** — nightly is fine. Code doesn't change fast enough to need live re-indexing. Manual trigger covers urgent cases.
- **Cross-agent knowledge sharing** — session knowledge is per-agent (scoped by `agentId`). A future enhancement could add a `shared` pseudo-agent for team-wide insights. Not needed yet — Jasper is the primary code_task consumer.
- **Inner session MCP server** — the inner Claude Code session doesn't get `code-search` directly. It gets pre-fetched context in the prompt. If we find that insufficient, we add it to the repo's `.claude/mcp-config.json` later.
- **dodi-shop-ios / marketing repos** — out of scope per decision.

---

## New Components

| Component | Path | Type |
|-----------|------|------|
| Indexer script | `src/code-index/indexer.ts` | Nightly cron job |
| Index types | `src/code-index/code-index-types.ts` | Shared types |
| Code search MCP | `src/code-index/code-search-mcp-server.ts` | Core MCP server (stdio) |
| Prefetcher | `src/code-index/prefetcher.ts` | Injected into CodeTaskManager |
| Entry script | `scripts/code-index.ts` | CLI entry point |
| Knowledge extractor | `src/code-task/knowledge-extractor.ts` | Post-completion extraction |

## Modified Components

| Component | Change |
|-----------|--------|
| `src/code-task/code-task-manager.ts` | Accept optional `prefetcher` in options, call it in `spawnTask()`. Spawn knowledge extraction after `onComplete`. |
| `src/agents/agent-runner.ts` | Add `code-search` to `buildAllServerConfigs()`. Update Jasper/Mokie/Chloe agent definitions to include `code-search` in `coreServers`. |
| `src/index.ts` | Construct `CodeIndexPrefetcher`, pass to `CodeTaskManager` via options |
| `hive.yaml` | Add `codeIndex` config section (repo paths, cron toggle) |

## Config

New `codeIndex` section in `hive.yaml`:

```yaml
codeIndex:
  enabled: true
  repos:
    hive:
      path: ~/github/hive
      include: ["src/**", "plugins/dodi/**"]
      extensions: [".ts"]
      exclude: ["*.test.ts", "*.spec.ts"]
    dodi_v2:
      path: ~/dev/dodi_v2
      include: ["src/modules/**", "src/apps/**", "src/services/**"]
      extensions: [".ts", ".tsx", ".js"]
      exclude: ["*.test.*", "*.spec.*"]
  sessionKnowledge:
    enabled: true
    extractOnComplete: true
```

## Estimated Cost

| Item | Cost | Frequency |
|------|------|-----------|
| Full index (Haiku summaries, ~4000 files) | ~$2 | Once |
| Incremental index (Haiku, ~50 changed files) | ~$0.03 | Nightly |
| Session knowledge extraction (Haiku) | ~$0.001 | Per code_task |
| Embeddings (Ollama, local) | $0 | Always |
| Qdrant storage (local) | $0 | Always |

---

## Open Questions

None. Ship it.
