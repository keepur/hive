# Agent Memory Lifecycle — Design Spec

**Date**: 2026-03-21
**Status**: Draft

## Problem

Agent memory today is a freeform markdown blob (`memory.md`) stored in MongoDB and injected verbatim into every session's system prompt. There is:

- **No lifecycle management** — nothing prunes, summarizes, or archives memory
- **No size limits** — a bloated memory.md silently eats context window tokens
- **No structure** — content is whatever the agent decided to write; impossible to age out individual entries
- **No retrieval** — agents must know the exact file path to read; no semantic search
- **No guidance** — agents are told they *can* write memory but not *how* to manage it

Every token in memory.md competes with the actual conversation. As the agent fleet grows, this becomes a silent quality degradation vector — agents give worse answers because their context is full of stale notes.

## Design

Replace the file-based memory system with **structured memory records** managed by a **three-tier lifecycle**. Agents control what gets written; the system controls sizing, aging, and summarization.

### Memory Records

Each memory entry is a discrete MongoDB document with agent-provided content and system-managed metadata.

**Agent-provided fields** (via `memory_save`):

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | The memory itself — a fact, note, task, preference, etc. |
| `type` | enum | `fact`, `task`, `interaction`, `preference`, `decision` |
| `topic` | string | Freeform tag (e.g., `"customer:jones"`, `"project:kitchen-reno"`) |
| `importance` | enum | `critical`, `high`, `medium`, `low` |

**System-managed fields**:

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Unique record ID |
| `agentId` | string | Owning agent |
| `tier` | enum | `hot`, `warm`, `cold` |
| `createdAt` | Date | When first saved |
| `updatedAt` | Date | Last modification |
| `lastAccessedAt` | Date | Last time recalled or injected |
| `accessCount` | number | Total recall/injection count |
| `sourceChannel` | string | Auto-populated from `CHANNEL_ID` env var at save time |
| `sourceThread` | string | Auto-populated from `THREAD_ID` env var at save time |
| `pinned` | boolean | If true, bypasses lifecycle scoring — stays hot until unpinned |
| `supersededBy` | ObjectId? | Points to newer record that replaced this one |
| `summaryGroup` | ObjectId? | Set during cold summarization — points to the summary record |
| `summarized` | boolean | Set to true when cold record has been included in a summary |
| `qdrantPointId` | string | UUID used as the Qdrant point ID (set on embed, used for update/delete) |

**MongoDB collection**: `agent_memory` (new — avoids collision with legacy `memory` collection during migration).

**Indexes**:
- `{ agentId: 1, tier: 1 }` — hot tier injection queries
- `{ agentId: 1, topic: 1 }` — topic-based lookups
- `{ agentId: 1, updatedAt: 1 }` — lifecycle sweeper
- `{ agentId: 1, type: 1 }` — type-filtered queries

### Memory Types

| Type | What it captures | Example | Typical lifecycle |
|------|-----------------|---------|-------------------|
| `fact` | Durable knowledge about people, projects, preferences | "Jones prefers shaker-style cabinets" | Long-lived, ages slowly |
| `task` | Action items, follow-ups, commitments | "Follow up with Jones by Friday 3/28" | Short-lived, completed tasks demote fast |
| `interaction` | Key moments from conversations | "Jones called upset about delivery delay, resolved with 10% credit" | Medium-lived, summarizes well |
| `preference` | How someone likes things done, communication style | "Jones prefers email over phone" | Long-lived, similar to facts |
| `decision` | Choices made and their rationale | "Went with oak over maple for Jones kitchen — budget constraint" | Long-lived, important for consistency |
| `summary` | System-generated compression of cold records by topic | "Jones project: shaker oak cabinets, $45K budget, 6-week timeline..." | System-only type, not agent-writable. Inherits importance `medium`. |

### Three-Tier Lifecycle

```
┌─────────────────────────────────────────────────────┐
│                    AGENT SESSION                     │
│                                                      │
│  System Prompt:                                      │
│    soul + role + constitution + [HOT MEMORY]         │
│                                                      │
│  Tools:                                              │
│    memory_save  → writes to hot tier                 │
│    memory_recall → searches all tiers (semantic)     │
│    memory_update → modifies existing record          │
│    memory_pin    → locks record in hot tier          │
│    memory_unpin  → returns record to normal scoring  │
│    memory_forget → explicit delete                   │
│                                                      │
└─────────────────────────────────────────────────────┘
         │ writes                    │ reads
         ▼                          ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│   HOT TIER     │  │   WARM TIER    │  │   COLD TIER    │
│                │  │                │  │                │
│ Auto-injected  │  │ On-demand via  │  │ Summarized,    │
│ into every     │──│ memory_recall  │──│ searchable     │
│ session prompt │  │ (semantic)     │  │ (compressed)   │
│                │  │                │  │                │
│ Budget: ~3000  │  │ No size limit  │  │ Summaries only │
│ tokens/agent   │  │ Full records   │  │ by topic       │
└────────────────┘  └────────────────┘  └────────────────┘
         │                   │                   │
         └───────────────────┴───────────────────┘
                    All in MongoDB
                    All in Qdrant (vectors)
```

#### Hot Tier

- **Injected** into the system prompt at session start, formatted as structured entries under `## Your Memory`
- **Budget**: ~3,000 tokens per agent (configurable in `hive.yaml`). This is enough for 15-25 concise entries.
- **What lives here**: Recent high-importance memories, pinned memories, active tasks, frequently accessed facts
- **Overflow**: When budget is exceeded, lowest-scoring hot memories are demoted to warm

#### Warm Tier

- **Not injected** — available only via `memory_recall` (semantic search)
- **No size limit** — all non-summarized records live here after demotion from hot
- **What lives here**: Older facts, completed tasks, past interactions, medium-importance items
- **Promotion**: Warm memories that get recalled frequently are promoted back to hot (if budget allows)

#### Cold Tier

- **Summarized** — the lifecycle sweeper batches cold records by topic and generates a summary
- **Original records preserved** in MongoDB but marked `tier: "cold"` with a `summaryGroup` reference
- **Summary records**: New `type: "summary"` entries in warm tier, containing compressed knowledge from multiple cold records
- **What lives here**: Old low-importance memories, superseded information, historical interaction logs

### Lifecycle Scoring

Each memory gets a **retention score** that determines tier placement. The sweeper computes this on each run.

```
score = (importance_weight × 0.4) + (recency_weight × 0.3) + (access_weight × 0.2) + (type_weight × 0.1)
```

| Factor | Weight | Calculation |
|--------|--------|-------------|
| Importance | 0.4 | critical=1.0, high=0.75, medium=0.5, low=0.25 |
| Recency | 0.3 | Exponential decay from `updatedAt`. Half-life: 7 days |
| Access frequency | 0.2 | Normalized `accessCount` relative to agent's median |
| Type | 0.1 | decision=1.0, fact=0.8, preference=0.8, summary=0.6, task=0.5, interaction=0.3 |

**Tier thresholds** (configurable):
- Hot: score ≥ 0.6
- Warm: score ≥ 0.3
- Cold: score < 0.3

**Pinned memories** bypass scoring — they stay hot until unpinned.

### Agent-Facing Tools

The memory MCP server exposes these tools (replacing the current file-based tools):

#### `memory_save(content, type, topic, importance)`

Save a new memory record.

- Creates record in MongoDB with `tier: "hot"` by default
- Embeds content via Ollama and upserts vector to Qdrant
- Returns the record ID
- If hot tier budget is exceeded after save, triggers immediate budget enforcement (demotes lowest-scoring entry)

#### `memory_recall(query, filters?)`

Semantic search across all tiers.

- Embeds query via Ollama, searches Qdrant with `agentId` filter
- Optional filters: `{ type?, topic?, tier?, importance?, limit? }`
- Default limit: 10 results
- Returns records with relevance score, tier, and metadata
- Increments `accessCount` and updates `lastAccessedAt` on returned records

#### `memory_update(id, content, importance?)`

Update an existing memory record.

- Updates content and/or importance
- Re-embeds and updates Qdrant vector
- Resets recency (updates `updatedAt`)
- Record may be re-scored and promoted/demoted on next sweep

#### `memory_pin(id)`

Pin a memory to the hot tier.

- Sets `pinned: true` — bypasses lifecycle scoring
- Record stays hot until explicitly unpinned
- Use case: critical facts that must always be in context (e.g., "Jones is allergic to cedar")

#### `memory_unpin(id)`

Remove pin from a memory, returning it to normal lifecycle scoring.

- Sets `pinned: false` — record will be scored on next sweep and may be demoted
- No-op if record is not pinned

#### `memory_forget(id)`

Explicit delete.

- Removes from MongoDB and Qdrant
- No soft delete — if the agent says forget, it's gone
- Original content remains in `memory_versions` for admin recovery if needed

### System Prompt Injection

The `buildSystemPrompt()` method in `agent-runner.ts` changes from loading a markdown blob to querying structured records.

**New injection format**:

```markdown
## Your Memory

### Active Tasks
- [2026-03-21] Follow up with Jones about cabinet finish selection (high)
- [2026-03-20] Send revised quote to Smith by EOD Monday (critical)

### Key Facts
- Jones prefers shaker-style cabinets, oak, soft-close hinges (high)
- Smith project budget: $45K, timeline: 6 weeks from approval (high)

### Recent Decisions
- [2026-03-19] Went with oak over maple for Jones — budget constraint (medium)

### Pinned
- Company holiday closure: March 28-31, no deliveries (critical, pinned)

---
You have 47 additional memories available via `memory_recall`. Use it to search for context before starting tasks.
```

**Budget enforcement**: The injection queries hot-tier records ordered by score, renders them into sections by type, and truncates at the token budget (~3,000 tokens). Any records that don't fit are silently demoted to warm — the agent can still access them via `memory_recall`.

**Token counting**: Use a fast approximation (chars / 4) rather than a tokenizer dependency. Close enough for budget enforcement. Note: this over-counts for English and under-counts for CJK text. For bilingual agents (e.g., Sige), the effective budget may be slightly off — acceptable for a soft budget, and can be tuned per-agent if needed.

### Background Lifecycle Sweeper

Integrates with the existing `Sweeper` class (`src/sweeper/sweeper.ts`), which runs on a 5-minute interval. The memory lifecycle sweep uses a cycle counter (like the existing gateway sweep pattern) to run every 72nd cycle (~6 hours). The `MemoryLifecycle` instance is added to `SweeperTargets` and exposes a `sweep(): Promise<SweepResult>` method matching the existing pattern.

**Each run**:

1. **Score all records** — compute retention score for every non-pinned memory across all agents
2. **Enforce tiers** — move records to correct tier based on score thresholds
3. **Enforce hot budget** — for each agent, if hot tier exceeds token budget, demote lowest-scoring entries to warm
4. **Promote warm records** — if a warm record's score now qualifies for hot (from frequent access), and budget allows, promote it
5. **Summarize cold batches** — group cold records by `(agentId, topic)`, and for groups with 5+ records, generate a summary using Haiku (cheapest model). The summary becomes a new warm-tier record of `type: "summary"`. Original cold records are marked `summarized: true`.
6. **Clean up** — delete summarized cold records older than 90 days (originals no longer needed after summary exists)

**Summarization prompt** (for Haiku):
```
Summarize the following memory entries for agent {agentId} about topic "{topic}".
Preserve key facts, decisions, and outcomes. Discard routine interactions.
Be concise — aim for 2-5 sentences.

{entries}
```

### Semantic Search (Qdrant)

**Collection**: `agent_memory` (single collection, filtered by `agentId`)

**Vector config**: Same as existing conversation index — Ollama `bge-large` embeddings (1024 dimensions).

**Payload fields stored in Qdrant** (for filtering):
- `agentId` (string)
- `type` (string)
- `topic` (string)
- `tier` (string)
- `importance` (string)
- `createdAt` (integer, unix timestamp)

**Point ID mapping**: Each memory record gets a `qdrantPointId` (UUID, generated via `crypto.randomUUID()`) stored in MongoDB. This UUID is used as the Qdrant point ID, enabling `memory_update` and `memory_forget` to target the exact vector for upsert/delete. Same pattern as `conversation-index.ts`.

**Embed on write**: Every `memory_save` and `memory_update` embeds the content and upserts the vector using the record's `qdrantPointId`. Summary records are also embedded.

**Search**: `memory_recall` embeds the query, searches Qdrant with `agentId` filter + any additional filters, returns top-k results. The Qdrant payload includes the MongoDB `_id` so results can be enriched with full record metadata.

### Shared Memory

The `shared/` namespace (constitution, business-context) is **not part of this system**. It remains as-is:
- Loaded by `MemoryManager.read()` during system prompt assembly
- Not structured records, not tiered, not in Qdrant
- Managed manually or via admin tools

This is intentional — shared memory is stable reference material, not agent working memory. It doesn't need lifecycle management.

### Access Control

Unchanged from current system:
- Agents can only save/recall/update/forget their own memories (`agentId` enforced server-side)
- No agent can access another agent's memory records or vectors
- `AGENT_ID` env var set by agent-runner, validated on every operation

### Configuration

New section in `hive.yaml`:

```yaml
memory:
  hotBudgetTokens: 3000          # per-agent hot tier token budget
  sweepIntervalHours: 6          # lifecycle sweeper frequency
  hotThreshold: 0.6              # minimum score for hot tier
  warmThreshold: 0.3             # minimum score for warm tier
  recencyHalfLifeDays: 7         # exponential decay half-life
  coldSummaryMinRecords: 5       # minimum cold records per topic before summarizing
  coldRetentionDays: 90          # days to keep original cold records after summarization
```

## Migration

### Phase 1: Deploy new system alongside old

- New `agent_memory` collection + Qdrant collection created
- New memory MCP server tools available
- Old `memory_read`/`memory_write`/`memory_list` still work (legacy paths)
- `buildSystemPrompt()` still injects legacy `memory.md` if it exists

### Phase 2: Migrate existing memory

One-time migration script (`setup/migrate-memory.ts`):

1. For each agent, read `agents/{id}/memory.md` from legacy `memory` collection
2. If content exceeds 4,000 tokens (~16K chars), chunk by section headers or paragraph boundaries before sending to Haiku
3. Send each chunk to Haiku with prompt: "Split this into individual memory entries. For each, classify type (fact/task/interaction/preference/decision), suggest a topic tag, and rate importance (critical/high/medium/low). Return as JSON array."
4. Create structured records in `agent_memory`, embed and index in Qdrant
5. Also migrate other per-agent `.md` files (not just `memory.md`) — these become `type: "fact"` records with topic derived from filename
6. Mark legacy files as migrated (don't delete yet)

### Phase 3: Cut over

- `buildSystemPrompt()` switches to hot-tier injection
- Legacy `memory_read`/`memory_write` tools removed from MCP server
- New tools are the only interface
- Agent system prompt templates updated with new memory tool instructions
- Legacy `memory` and `memory_versions` collections archived

### Phase 4: Cleanup

- Remove legacy memory code paths
- Drop archived collections after 30-day bake period

## Files Changed

| File | Change |
|------|--------|
| `src/memory/memory-mcp-server.ts` | Replace file-based tools with record-based tools |
| `src/memory/memory-manager.ts` | Add structured record CRUD, hot-tier query, token budgeting |
| `src/memory/memory-lifecycle.ts` | **New** — scoring engine, tier enforcement, sweeper |
| `src/memory/memory-embedder.ts` | **New** — Qdrant integration for memory vectors |
| `src/agents/agent-runner.ts` | Change `buildSystemPrompt()` to use structured hot-tier injection |
| `src/sweeper/sweeper.ts` | Add memory lifecycle sweep to existing sweeper (cycle counter pattern) |
| `setup/migrate-memory.ts` | **New** — one-time migration script |
| `hive.yaml` | Add `memory:` configuration section |
| `agents-templates/*/system-prompt.md.tpl` | Update memory tool documentation |

## Out of Scope

- **Cross-agent memory sharing** — agents cannot read each other's memories. If this is needed later, it's a separate feature.
- **Shared memory lifecycle** — `shared/` files remain manually managed.
- **Memory analytics/dashboard** — no UI for viewing memory state. Admin can query MongoDB directly.
- **Real-time memory sync** — no push notifications when memory changes. Agents see current state at session start.
