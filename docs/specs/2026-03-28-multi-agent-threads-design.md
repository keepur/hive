# Multi-Agent Threads — Design Spec

**Date**: 2026-03-28
**Status**: Draft
**Scope**: Enable multiple agents to participate in a single thread, like a meeting
**Labels**: routing, collaboration

## Problem

Today, thread affinity locks a conversation to a single agent. The moment one agent responds in a thread, `threadAgentMap` records `threadId → agentId`, and every subsequent message routes exclusively to that agent. Other agents never see those messages, even if the topic shifts to their domain.

This prevents natural multi-agent collaboration. In a real team meeting, multiple people sit in the same room, hear everything, and speak when they have something relevant to contribute. Hive can't do that today — once one person starts talking, everyone else leaves the room.

Fan-out exists for the first message when multiple agents are mentioned, but it's fire-and-forget: no thread memory, no persistent participant set. Follow-up messages fall back to single-agent resolution.

## Design

### Mental Model

- **Channels are rooms.** Any channel can host any kind of conversation.
- **Threads are meetings.** A thread is a conversation with a defined set of participants.
- **Mentions are invitations.** Naming an agent pulls them into the meeting.
- **Once in, you're in.** Agents stay for the life of the thread. No auto-removal.
- **No auto-join.** Domain relevance doesn't earn you a seat — you must be explicitly mentioned.

### How It Works

1. A message mentions multiple agents: *"Wyatt, River, Milo — let's discuss the spring campaign pricing"*
2. `findAllByName()` returns `[wyatt, river, milo]` (already works today)
3. Dispatcher creates a **participant set** for the thread: `threadParticipants[threadId] = Set { wyatt, river, milo }`
4. All three agents receive the message concurrently via existing fan-out (`Promise.all`)
5. Each agent independently decides whether to respond — non-responses are suppressed (existing behavior)
6. Next message in the thread: dispatcher checks `threadParticipants`, finds the set, fans out to all three
7. Mid-thread, someone writes *"Jessica, can you pull up the customer history?"* — Jessica is added to the participant set
8. From that point, all four agents see every message

### Single-Agent Threads (Unchanged)

When only one agent is resolved (single mention, channel mapping, default routing), behavior is identical to today:
- `threadAgentMap` stores the single agent
- Thread affinity works as before
- No participant set created

The participant set only comes into play when multiple agents are resolved for a thread.

### Transition: Single → Multi

If a thread starts with one agent (normal routing), and a later message mentions additional agents, the thread transitions from single-agent to multi-agent:
- The original agent is added to the new participant set
- The new agents are added
- `threadAgentMap` entry is removed (replaced by `threadParticipants`)
- From that point forward, all participants see every message

## Implementation

### Data Structures

**In-memory (dispatcher.ts):**
```typescript
// Existing — unchanged for single-agent threads
private threadAgentMap = new Map<string, string>();

// New — for multi-agent threads
private threadParticipants = new Map<string, Set<string>>();

// Existing — shared across both (TTL tracking)
private threadAgentLastSeen = new Map<string, number>();
```

### Routing Changes (resolveAgents)

The key structural change: `resolveAgents` must scan for new name mentions in threads that already have affinity, so mid-thread invitations work. Today it returns early at the thread continuity check before name mentions are evaluated.

**Priority overrides (unchanged, always checked first):**
- `targetAgentId` (callbacks, internal routing) → return single agent, no fan-out, even in multi-agent threads
- Dedicated channel mapping → return channel owner, skip name scanning (prevents name collisions, e.g. a customer named "Jasper" in #agent-jessica)

**Thread participant resolution (new, runs after priority overrides):**
```
if threadId exists:
  newMentions = findAllByName(message.text)

  if threadId in threadParticipants:
    if newMentions is not empty:
      threadParticipants[threadId] = threadParticipants[threadId] ∪ newMentions
      update threadAgentLastSeen
    return all participants

  if threadId in threadAgentMap:
    if newMentions is not empty AND newMentions includes agents beyond the current one:
      // Single → multi transition
      threadParticipants[threadId] = { threadAgentMap[threadId] } ∪ newMentions
      delete threadAgentMap[threadId]
      update threadAgentLastSeen
      return all participants
    else:
      return single agent (existing behavior)

  // No in-memory affinity — check persisted sessions
  agents = findAgentsForThread(threadId)
  if agents.length > 1:
    threadParticipants[threadId] = Set(agents)
    return all participants
  else if agents.length == 1:
    threadAgentMap[threadId] = agents[0]
    return single agent

// No thread affinity at all — fall through to normal resolution
// (channel mapping, name mentions, adapter default, keyword match, global default)
```

This ensures mid-thread mentions like *"Jessica, can you weigh in?"* are always detected, whether the thread is single-agent or multi-agent.

Persisted session recovery is now integrated into the main resolution flow above (no separate restart path needed).

### Dispatch Path for Multi-Agent Threads

Multi-agent threads always use the fan-out path (`dispatchToAgent` per participant via `Promise.all`). The fan-out path differs from the single-agent path in two ways:
- **Triage**: Still runs per-agent, but does not post the "continue" ack message (appropriate for multi-agent — no single agent should claim the thread with an ack)
- **Lifecycle hooks**: Skips `onProcessingStart`/`onProcessingEnd` (designed for 1:1 conversations)

These differences are correct for multi-agent threads. No changes needed to `dispatchToAgent` internals.

The fan-out path **must update `threadAgentLastSeen`** on every dispatch to keep the TTL alive:
```
threadAgentLastSeen[threadId] = Date.now()
```
Today the fan-out path skips this (since it doesn't set affinity). This is the only addition to the fan-out path.

### Persistence (session-store.ts)

Add a method to find **all** agents for a thread (not just the most recent):

```typescript
async findAgentsForThread(threadId: string): Promise<string[]> {
  const docs = await this.collection
    .find({ threadId }, { projection: { agentId: 1 } })
    .toArray();
  return [...new Set(docs.map(d => d.agentId))];
}
```

Expose via `agent-manager.ts` as `findAgentsForThread(threadId)` (mirrors the existing `findAgentForThread` singular wrapper). The dispatcher calls through agent-manager, not session-store directly — consistent with the existing pattern.

### Sweep

Update `sweep()` to clean up both maps. Today it only deletes from `threadAgentMap`:

```typescript
sweep(threadTtlMs: number): SweepResult {
  const cutoff = Date.now() - threadTtlMs;
  let pruned = 0;
  for (const [id, ts] of this.threadAgentLastSeen) {
    if (ts < cutoff) {
      this.threadAgentMap.delete(id);
      this.threadParticipants.delete(id);  // NEW
      this.threadAgentLastSeen.delete(id);
      pruned++;
    }
  }
  return { component: "dispatcher", pruned, retried: 0, bytesFreed: 0, errors: [] };
}
```

### Agent Behavior — Meeting Etiquette

Add a new section to each constitution template. Placement: after the existing behavioral rules, before any instance-specific sections.

- `setup/templates/constitution.md.tpl` — add after the last numbered section
- `setup/templates/constitution-business.md.tpl` — add after section 11 (before closing)
- `setup/templates/constitution-personal.md.tpl` — add after section 11 (before closing)

Content:

```
## Group Conversations

When you are in a conversation with other agents:
- Only speak when the topic is in your area of expertise
- Don't repeat or rephrase what another agent just said
- If you have nothing meaningful to add, respond with "No response needed."
- Keep responses focused — don't try to cover someone else's domain
```

After editing, run `npm run setup:agents` to regenerate agent configs, then update the `shared/constitution.md` memory record in MongoDB to match.

This is lightweight, non-invasive, and leverages the existing non-response suppression pattern.

## What Changes

| Component | Change |
|-----------|--------|
| `dispatcher.ts` | Add `threadParticipants` map. Restructure `resolveAgents` to scan name mentions in existing threads. Update fan-out to persist participants and refresh `threadAgentLastSeen`. Handle single→multi transition. Update `sweep()` to clean `threadParticipants`. |
| `session-store.ts` | Add `findAgentsForThread()` (plural) for multi-agent recovery |
| `agent-manager.ts` | Add `findAgentsForThread()` wrapper (mirrors existing singular `findAgentForThread`) |
| `setup/templates/constitution*.md.tpl` | Add meeting etiquette section to all three constitution templates |
| `dispatcher.test.ts` | Tests for multi-agent threads, participant accumulation, single→multi transition, sweep cleanup, restart recovery |

## What Doesn't Change

- Single-agent thread routing (most threads)
- Dedicated channel routing
- Triage, model router, concurrency limits
- Agent manager thread queues (already keyed by `agentId:threadId`)
- Non-response suppression
- Fan-out mechanics (`Promise.all` dispatch)
- `dispatchToAgent` internals (no triage/lifecycle changes — fan-out path is correct as-is for multi-agent)

## Edge Cases

**All participants stay silent**: Every agent responds "no response needed." Message is consumed but no visible reply. This is acceptable — same as a meeting where nobody has input.

**Thread started by system/scheduler**: No name mentions, single-agent. Works as today.

**Agent disabled mid-thread**: Disabled agents are filtered out at dispatch time (existing behavior). Participant set retains them but dispatch skips them.

**Concurrency limits**: Each agent has independent concurrency limits. If Wyatt is at capacity, his message is queued per existing agent-manager logic. Other participants are unaffected. Note: a 3-agent thread sends 3 concurrent requests — this could saturate an agent's default concurrency limit of 3 if it's already handling other threads. This is acceptable since the agent-manager already handles queueing gracefully.

**Restart recovery**: Multiple session docs for one threadId → `threadParticipants`. Single doc → `threadAgentMap`. Zero docs → normal resolution.

**Response ordering**: Agents respond at different speeds — faster agents reply first in the Slack thread. A slower agent may respond minutes later to a point others already addressed. This is acceptable (meeting etiquette prompt helps) and matches real-world async communication. No ordering guarantees.

**TTL sweep expiration**: When a multi-agent thread goes idle past the sweep TTL, the participant set is lost. The next message in that thread falls through to normal resolution, which may resolve fewer agents than the original set. Users can re-mention agents to rebuild the group. This is a known tradeoff of the "once in, you're in" mental model — it holds during active conversation but not across long idle periods.

## Cost

Multi-agent threads multiply agent invocations per message (one per participant). For a 4-agent thread, each message costs ~4x a single-agent message. This is by design — the user explicitly invited those agents. The meeting etiquette prompt + non-response suppression minimize wasted tokens from irrelevant responses (agents that say "no response needed" are cheap Haiku calls via model router).

## Non-Goals

- Auto-joining agents based on topic/domain relevance
- Classifier to determine which agents should respond
- New channel configuration or channel types
- Agent-to-agent awareness (seeing each other's responses before replying)
- Removing agents from a thread mid-conversation
