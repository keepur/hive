# Memory Self-Management — Design Spec

**Date**: 2026-03-25
**Status**: Draft
**Scope**: Three-layer system for agents to proactively manage their own memory
**Depends on**: #24 (memory_purge) — Layer 3 only; Layers 1-2 are independent

## Problem

Agents only write to memory when explicitly asked. When they say "got it," there's no way to know whether they actually saved anything or just acknowledged the message. Stale memories accumulate (e.g., Milo's deprecated pipeline-review workflow) because the automated lifecycle sweep can't distinguish "outdated but still accessed" from "actively relevant." There is no agent-initiated memory hygiene.

## Design

Three layers, in order of implementation:

### Layer 1: Constitutional Norm (Prompt Change Only)

Update constitution section 9.1 and 10.2 to set explicit behavioral expectations for proactive memory management.

**Section 9.1** — add after current text:

> Agents are expected to actively manage their own memory. When you encounter new facts, decisions, corrections, preferences, or commitments during conversation, save them using `memory_save` without waiting to be asked. When you save a memory, always confirm by including the record ID in your response — this makes memory writes visible and verifiable. "Got it" without a record ID means you did not save it.

**Section 10.2 (Memory)** — extend the existing tool reference with behavioral guidance:

> You are responsible for keeping your memory accurate and current. If you learn something that contradicts an existing memory, update or forget the old record. If you make a commitment to a person, save it. If a workflow or process changes, update your memory to reflect the new state. Do not accumulate stale knowledge — actively maintain what you know.

**Cost**: Zero. Prompt text only.
**Expected effect**: Raises the floor on proactive memory writes. Won't be 100% reliable, especially for Haiku agents, but establishes the expectation and makes the absence of record IDs a visible signal.

### Layer 2: End-of-Conversation Reflection

After an agent completes a multi-turn conversation, inject one additional system turn prompting the agent to reflect on what was discussed and save anything worth remembering.

**Trigger condition**: Thread queue has drained (no more pending messages) AND the session had 3+ user turns AND the last response was not an error.

**Implementation**: In `agent-manager.ts`, after the `while (queue.length > 0)` loop exits (around line 221, before cleanup), check:
1. `turnCount >= reflectionMinTurns`
2. Last result was successful (`!lastResult.error`)
3. Source was interactive (`sender !== "system"`)

If all conditions met, send one more prompt to the same session via `runner.send()`:

```
[System — end of conversation reflection]
This conversation is wrapping up. Review what was discussed:
- Were any new facts, decisions, or commitments made?
- Did anything contradict or update what you previously knew?
- Should any existing memories be updated or forgotten?

If yes, use memory_save, memory_update, or memory_forget now.
If nothing worth saving, do nothing.
```

**Key design choices**:

- **Fires on queue drain, not per-response**: The reflection only triggers when the thread's message queue is empty — not after each individual response. This prevents mid-conversation reflection if multiple messages arrived while the agent was processing.
- **Same session**: The reflection runs in the same SDK session, so the agent has full conversation context. No need to summarize or re-inject anything.
- **Session ID persisted after reflection**: The reflection may produce tool calls (memory_save, etc.). The resulting `sessionId` must be saved via `sessionStore.set()` so the next real message in this thread picks up post-reflection state.
- **Response suppressed**: The reflection turn's response is not delivered to Slack/SMS. It's an internal housekeeping turn. Log cost and tool calls, but don't post.
- **Turn tracking**: Add a `turnCount` number to the per-thread state in agent-manager.ts (alongside the existing queue). Increment on each user message processed. This count is per-queue-lifecycle — if the queue drains and a new message arrives later, the count resets. This is intentional: each "conversation burst" gets its own reflection check.
- **No reflection on error**: If the last agent response errored (including session deletion), skip reflection — there's no valid session to reflect in.
- **Cost control**: One extra Haiku/Sonnet turn per qualifying conversation. At ~$0.002-0.01 per turn, this is negligible.
- **No reflection on scheduled tasks**: Only trigger on interactive conversations (sender !== "system"). Scheduled tasks are single-turn by design.
- **No reflection on single exchanges**: The 3-turn threshold filters out quick Q&A where there's nothing to remember.

**Config** (in `hive.yaml` under `memory:`):

```yaml
memory:
  reflectionMinTurns: 3    # minimum user turns before reflection fires
  reflectionEnabled: true   # kill switch
```

### Layer 3: Scheduled Memory Review

A cron-triggered task where agents review their hot-tier memories and clean up stale records. Complements the automated lifecycle sweep (which handles scoring math) with agent judgment.

**New tool: `memory_review`**

Returns the agent's full hot-tier memory with staleness signals, formatted for review:

```
Your hot-tier memories (17 records):

[ID: 67abc...] topic:"pipeline-review" type:task importance:high
  Created: 2026-02-15 | Last accessed: 2026-03-01 | Access count: 3
  Content: "Morning pipeline review uses custom format with..."
  ⚠ Not accessed in 24 days

[ID: 67def...] topic:"customer:jones" type:fact importance:critical
  Created: 2026-03-20 | Last accessed: 2026-03-25 | Access count: 12
  Content: "Jones project — kitchen reno, maple cabinets..."

...

Review each memory. For stale or outdated records, use memory_purge (bulk by filter) or memory_forget (single by ID).
For records that need correction, use memory_update.
```

**Dependency on #24 (memory_purge)**: The review tool works with existing `memory_forget` for single deletions, but bulk cleanup (e.g., "purge all records with topic:pipeline-review") requires `memory_purge`. Without #24, agents can still review and delete one-by-one — just less efficient for large cleanup.

**Structured memory gate**: `memory_review` is registered in `structured-memory-mcp-server.ts`, which is only wired into agent sessions when `config.memory.structured === true`. The cron schedule entry fires regardless. If structured memory is disabled, the agent receives the scheduled task prompt but has no `memory_review` tool — it will respond that it can't perform the review. This is acceptable (non-destructive), but the system prompt task description should include: "If you don't have the memory_review tool available, skip this task."

**Staleness signals included**:
- Days since last access
- Access count (low count + old = likely stale)
- Warning flag (⚠) for records not accessed in 14+ days

**Why a dedicated tool instead of `memory_recall`**: `memory_recall` is semantic search — you need a query. For a review, the agent needs to see *everything* in hot tier, sorted for reviewability, with metadata that `memory_recall` doesn't surface (access count, last access date, age). Different purpose, different output format.

**Schedule**: Add to each agent template's `agent.yaml`:

```yaml
schedule:
  - cron: "0 6 * * 0"    # Sundays at 6am
    task: memory-review
```

Weekly is sufficient — this is a safety net, not the primary mechanism (Layer 1 and 2 handle real-time). Can be overridden per-agent via `schedule_overrides` collection.

**System prompt addition**: Add a `memory-review` task description to each agent's system prompt template:

> **memory-review**: Review your hot-tier memories for accuracy and relevance. Call `memory_review` to see all hot records with staleness data. Purge or update anything outdated. This is your housekeeping — keep your memory clean and current.

## Implementation Phases

| Phase | What | Size | Ships Independently |
|-------|------|------|---------------------|
| 1 | Constitutional norm (prompt text) | Trivial | Yes |
| 2 | End-of-conversation reflection | Small-Medium | Yes (after Phase 1) |
| 3 | `memory_review` tool + cron schedule | Small | Yes (after #24 ships) |

Phase 1 can ship today. Phases 2 and 3 are independent of each other.

## Files to Change

### Phase 1
| File | Change |
|------|--------|
| `setup/templates/constitution.md.tpl` | Update sections 9.1 and 10.2 |

### Phase 2
| File | Change |
|------|--------|
| `src/agents/agent-manager.ts` | Add turn counting per thread; inject reflection prompt after qualifying conversations |
| `src/config.ts` | Add `reflectionMinTurns`, `reflectionEnabled` to memory config |

### Phase 3
| File | Change |
|------|--------|
| `src/memory/structured-memory-mcp-server.ts` | Register `memory_review` tool |
| `src/memory/memory-store.ts` | Add `getHotTierWithStats()` method (returns access count, last access, age) |
| Agent templates `agent.yaml` | Add `memory-review` cron entry |
| Agent templates `system-prompt.md.tpl` | Add `memory-review` task description |

## Not In Scope

- Cross-agent memory review (admin reviewing another agent's memory)
- Automated stale-memory detection (the lifecycle sweep already handles scoring-based demotion; this adds human-like judgment on top)
- Mid-conversation reflection interrupts (too jarring, cost scales with conversation length)
- Memory write verification at the platform level (e.g., checking that `memory_save` was actually called) — the record ID confirmation norm is the lightweight version of this
