# Conference Channels — Design Spec

**Date**: 2026-04-20
**Status**: Draft
**Scope**: Meeting-style agent collaboration in dedicated conference channels
**Labels**: routing, collaboration, channels
**Builds on**: [Multi-Agent Threads](2026-03-28-multi-agent-threads-design.md)

## Problem

Multi-agent threads (shipped in the earlier spec) let you name multiple agents and have them all participate in a thread. But agents are blind to each other — Agent A doesn't see Agent B's response, so they can't build on each other's ideas. And every agent in the thread is triggered on every message, even when only one or two are relevant.

May wants to run meetings in Slack. The experience: create a `#conf-*` channel, start a thread with a roll call ("Jasper, River, Chloe — join meeting"), and have a natural discussion where agents read the full thread, respond when relevant, and react to each other — without runaway loops or wasted compute.

## Design

### Mental Model

- **Conference channels are meeting rooms.** Any channel with a `conf-` prefix activates meeting behavior.
- **Threads are meetings.** Each thread in a conference channel is an independent meeting with its own roster.
- **Roll call sets the roster.** The first message names who's in the meeting. Only roster members participate.
- **Pull people in mid-meeting.** "Let's grab Wyatt" adds Wyatt to the roster. He gets the full thread context.
- **Agents read the room.** Before responding, agents receive the full thread history — they know what everyone said.
- **Not everyone speaks every time.** A Haiku classifier picks which roster members are relevant to each message, so agents aren't triggered when they have nothing to add.
- **One round of reactions.** Agent responses go through the classifier once more — peers can react to what was said. Then the floor returns to the human. No deeper chaining.

### How It Works

**Round 0 — Human speaks:**

1. Human posts in a `conf-` channel thread
2. Dispatcher detects the `conf-` prefix → meeting mode
3. Dispatcher resolves the **thread roster** (agent names from the thread, accumulated over time)
4. **Meeting classifier** (Haiku) evaluates: given this message, the roster, and each agent's role — who should respond?
5. For each selected agent: fetch the full Slack thread via `conversations.replies`, inject it as context alongside a meeting preamble, spawn session
6. Agents respond → posted to Slack thread

**Round 1 — Agents react to each other (depth 1):**

7. Each agent response is collected as it completes
8. Classifier runs again on each agent response: which *other* roster members should react?
9. Selected peers are triggered with the updated thread context (now including round 0 responses)
10. Each agent gets at most **one reaction turn per human message** — tracked to prevent re-triggering
11. Reactions posted to Slack thread. Round ends. Floor returns to human.

**Mid-meeting — Adding participants:**

12. Human writes "Let's grab Wyatt. Wyatt, what do you think about X?"
13. Dispatcher detects new name mention → adds Wyatt to thread roster
14. Wyatt receives full thread context from the start of the meeting
15. Normal round 0 + round 1 flow applies

### Conference Channel Detection

A channel is a conference channel if its name starts with `conf-`. No configuration needed — the prefix is the convention. Examples: `#conf-strategy`, `#conf-keepur`, `#conf-weekly`.

**Routing priority:** Conference detection runs in `resolveAgents` after priority overrides (`targetAgentId`, team routing, origin routing) but **before** the dedicated channel check (`findByChannel`). This ensures `conf-` channels always enter conference mode, even if an agent happens to list a `conf-` channel in its `channels` array. The check uses `item.source.label` (already resolved to the channel name by the adapter before the WorkItem reaches the dispatcher) — no Slack API call needed.

```
// In resolveAgents, after priority overrides:
if (item.source.kind === "slack" && item.source.label.startsWith("conf-")) {
  return this.resolveConferenceAgents(item);
}
// ... existing dedicated channel check (findByChannel), thread routing, etc.
```

**Implementation note:** The existing `findByChannel` call (currently at line ~287) must physically come AFTER this new guard. If the existing code is structured as a priority chain, the `conf-` check is inserted above the dedicated channel check — the `findByChannel` block moves down, or the `conf-` check short-circuits with an early return before `findByChannel` is reached. The `source.kind === "slack"` guard ensures non-Slack items (SMS, scheduler, internal callbacks) never enter conference mode.

Non-`conf-` channels use existing routing (single-agent, multi-agent threads, etc.) unchanged.

### Thread Roster

The roster is the set of agents participating in a meeting thread. It's distinct from the `threadParticipants` map in the existing multi-agent threads system — conference channels use their own tracking because the behavior differs (classifier gating, thread injection, depth-1 reactions).

**Roster resolution:**
- Parse agent names from all messages in the thread (using existing `findAllByName`)
- Accumulate — once named, an agent stays in the roster for the thread's lifetime
- Store in a new `meetingRosters` map: `Map<threadId, Set<agentId>>`
- On restart: recover by re-scanning thread messages (via `conversations.replies`) or from persisted sessions

**Roster vs. threadParticipants:** Conference channel threads use `meetingRosters` exclusively. The existing `threadParticipants` map is not used for `conf-` channels — conference detection runs before any `threadParticipants` check, and conference-mode fan-out must NOT write to `threadParticipants`. This avoids mixing meeting semantics (classifier-gated, context-injected) with the existing multi-agent thread semantics (all participants triggered on every message).

**TTL tracking:** Conference-mode dispatches must update `threadAgentLastSeen[threadId] = Date.now()` on every dispatch, same as multi-agent threads. The `sweep()` method cleans up `meetingRosters` and `meetingReactionTracker` alongside `threadParticipants` using the same TTL.

### Meeting Classifier

A lightweight Haiku call that decides which roster members should respond to a given message. Same architectural pattern as the model router.

**Input:**
- Message text (the human message or agent response being classified)
- Roster: list of `{ agentId, name, title, role }` (from agent definitions — `name`, `title`, `soul` summary)
- Thread summary: last few messages for recency context (not the full thread — keep classifier input small)

**Output:**
```json
{ "respond": ["jasper", "river"] }
```

**Prompt (sketch):**
```
You are a meeting facilitator. Given a message and a list of meeting participants,
decide which participants should respond.

Rules:
- If someone is addressed by name, they MUST be in the respond list.
- Pick participants whose expertise is directly relevant to the message.
- Fewer is better — don't trigger everyone for a question only one person can answer.
- If the message is clearly directed at one person, return only that person.
- If the message is a general question to the room, pick 2-3 most relevant.
- For "what does everyone think?" style questions, include all roster members.

Respond with ONLY a JSON object: { "respond": ["agent-id-1", "agent-id-2"] }
```

**Configuration:**
- Model: Haiku (same as model router)
- Max budget: $0.01 per classification
- Max turns: 1
- Timeout: 8s (same as model router)
- No tools allowed

**Cost:** ~$0.0001 per classification call. With depth-1 reactions, worst case is 1 + N classifier calls per human message (1 for the human message + 1 per agent response). At N=4 agents, that's ~$0.0005 — effectively free.

### Thread Context Injection

When an agent is triggered in a conference channel, the dispatcher pre-fetches the thread history and injects it into the agent's context. The agent sees the full conversation before their first turn — no tool call needed.

**Fetch mechanism:**
- Slack adapter exposes a new public method: `fetchThreadHistory(channelId, threadTs): Promise<ThreadMessage[]>`
- Calls `this.gateway.client.conversations.replies({ channel, ts, limit: 200 })`
- Returns array of `{ author, text, timestamp }` (author resolved to display name or agent name)

**Dispatcher access:** The dispatcher needs a typed reference to `SlackAdapter` (not just the generic `ChannelAdapter` interface) to call `fetchThreadHistory`. Add a `setSlackAdapter(adapter: SlackAdapter): void` setter method on Dispatcher (following the existing pattern used by `setRetryQueue`, `setTeamStore`, and `setAuditChannel` for late-bound optional dependencies). Called in `index.ts` after both Dispatcher and SlackAdapter are constructed. This keeps the generic adapter interface clean while giving conference mode the Slack-specific API it needs. Conference mode is inherently Slack-specific (channel names, thread replies), so this coupling is appropriate.

**Injection format (prepended to the agent's WorkItem text):**

```
[Meeting thread in #conf-keepur — participants: Jasper, River, Chloe]

May (2 min ago): Let's discuss the Q3 product roadmap. What are the priorities?
Jasper (1 min ago): From an engineering perspective, we need to finish the API migration first...
River (45s ago): Marketing has three campaigns planned that depend on the new catalog features.

---
[New message from May]:
Chloe, what does the product backlog look like for those catalog features?
```

**Context limits:**
- Cap at 200 messages (Slack API default page size) — meetings shouldn't be longer than this
- If the thread is very long, include only the last 100 messages plus the first 5 (to capture the roll call and initial context)
- Total injected context should stay under ~8K tokens to leave room for the agent's own system prompt and tools

### Meeting Preamble

Injected alongside thread context. Standard across all agents — not per-agent customizable.

```
You are in a meeting in #conf-keepur with Jasper, River, and Chloe.

Meeting rules:
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- If you have nothing meaningful to add, respond with "No response needed."
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.
```

This replaces the constitution's "Group Conversations" section for conference channel interactions — it's more specific and includes the participant list.

### Depth-1 Reaction Tracking

To prevent infinite loops, the system tracks which agents have already reacted in the current round.

**Per human message, track:**
```typescript
// Map<threadId, Map<humanMessageTs, Set<agentId>>>
private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
```

**Rules:**
- An agent can respond in round 0 (triggered by human message) AND in round 1 (triggered by a peer's response) — but not both for the same stimulus
- An agent that responded in round 0 can be triggered in round 1 by a *different* agent's response
- Each agent gets at most one round-1 reaction per human message
- The tracker is keyed by the originating human message timestamp, so overlapping conversations in the same thread don't interfere
- Tracker entries are cleaned up on sweep (same TTL as thread roster)

### Dispatcher Flow (Conference Mode)

Conference detection placement is specified in the "Conference Channel Detection" section above — it runs after priority overrides but before the dedicated channel check, using `item.source.label`.

`resolveConferenceAgents(item)`:
```
threadId = item.threadId or item.id  // thread or new top-level message

// Build/update roster
roster = meetingRosters.get(threadId) or new Set()
newMentions = registry.findAllByName(item.text)
for each mention: roster.add(mention.agentId)
meetingRosters.set(threadId, roster)

if roster is empty:
  // No agents named yet — don't trigger anyone
  return []

// Run classifier
selectedAgents = await meetingClassifier.classify(item.text, roster, recentThreadContext)

// Return selected agents with conference metadata
return selectedAgents.map(id => ({
  agentId: id,
  conferenceMode: true,
  conferenceHumanTs: item.meta?.slackTs,  // originating human message ts, threaded to round 1
  threadContext: fetchedThreadHistory,
  meetingPreamble: buildPreamble(channelName, roster)
}))
```

**Resolved object type:** The existing `dispatchToAgent(item, resolved: { agentId: string })` signature must be widened to carry optional conference metadata:

```typescript
interface ResolvedAgent {
  agentId: string;
  conferenceMode?: boolean;
  conferenceHumanTs?: string;
  threadContext?: string;
  meetingPreamble?: string;
}
```

The multi-agent fan-out path in `dispatch()` (currently at line ~142-148) must be aware of this: when `conferenceMode` is set, the fan-out must NOT write to `threadParticipants` — conference threads are tracked exclusively via `meetingRosters`.

The dispatch path checks `conferenceMode` and:
1. Injects thread context + preamble into the WorkItem text before sending to the agent. Also writes `meta.conferenceHumanTs = resolved.conferenceHumanTs` and `meta.conferenceMode = true` into the WorkItem's `meta` object — this threads the originating human message timestamp through to the reaction flow.
2. After the agent responds, triggers the depth-1 reaction flow **internally** — inline in `dispatchToAgent` after `agentManager.sendMessage()` returns. This is NOT a Slack event listener. The dispatcher already awaits the agent response; the reaction hook runs in the same async flow, using the response text directly. The Slack gateway bot filter is never involved.

### Depth-1 Reaction Flow

After an agent responds in round 0:

```
onAgentResponse(response, originalItem):
  if not conferenceMode: return

  threadId = originalItem.threadId
  humanTs = originalItem.meta.conferenceHumanTs  // the originating human message ts, threaded through from round 0

  // Check if this response should trigger peer reactions
  roster = meetingRosters.get(threadId)
  reacted = meetingReactionTracker.get(threadId)?.get(humanTs) or new Set()

  // Classifier: who should react to this agent's response?
  peers = roster minus response.agentId minus reacted
  if peers is empty: return

  selectedPeers = await meetingClassifier.classify(response.text, peers, updatedThreadContext)

  for each peer in selectedPeers:
    if reacted.has(peer): continue  // already reacted this round
    reacted.add(peer)
    // Dispatch with updated thread context (includes the response that triggered this)
    dispatch peer with conferenceMode, updated thread context, round=1

  // Store reaction tracking
  meetingReactionTracker.get(threadId).set(humanTs, reacted)
```

Round 1 responses do NOT trigger further reactions — the `round=1` flag stops recursion.

## What Changes

| Component | Change |
|-----------|--------|
| `dispatcher.ts` | New `resolveConferenceAgents()` method. New `meetingRosters` map. New `meetingReactionTracker` map. Conference channel detection in `resolveAgents` (before dedicated channel check). Post-response hook for depth-1 reactions (inline in `dispatchToAgent`). Sweep cleanup for new maps via `threadAgentLastSeen`. New `setSlackAdapter(adapter: SlackAdapter): void` setter method. Conference fan-out must NOT write to `threadParticipants`. |
| `slack-adapter.ts` | New `fetchThreadHistory(channelId, threadTs)` method that calls `conversations.replies` and formats results. |
| New: `meeting-classifier.ts` | Haiku classifier (same pattern as `model-router.ts`) — takes message + roster → returns agent IDs to trigger. |
| `index.ts` | Call `dispatcher.setSlackAdapter(slackAdapter)` after constructing SlackAdapter. |
| `dispatcher.ts` (dispatch path) | Conference-mode WorkItems get thread context + preamble injected before agent spawn. |

## What Doesn't Change

- Slack gateway bot filter — stays as-is, we don't need to process our own bot messages
- Existing multi-agent thread routing (`threadParticipants`) — conference channels use a separate code path
- Agent definitions — no new fields needed
- Team MCP server / event bus — not involved
- `hive.yaml` — no new configuration
- Single-agent threads — completely unchanged
- Non-`conf-` multi-agent threads — use existing behavior

## Edge Cases

**Empty roll call:** Human posts in `#conf-*` without naming anyone. No roster → no agents triggered. Message sits in Slack unanswered. Human can follow up with names.

**Agent not found:** Human names someone who isn't an agent (e.g., a human team member). `findAllByName` returns nothing for that name — it's silently skipped. Only valid agent names enter the roster.

**All agents say "No response needed":** Valid outcome. Non-response suppression (existing `NON_RESPONSE_PATTERNS`) hides empty responses. Thread shows only the human's message.

**Classifier picks no one:** Valid outcome for off-topic messages or pure informational statements. No agents triggered.

**Agent disabled mid-meeting:** Disabled agents are filtered out at dispatch time (existing). Roster retains them but they're skipped.

**Very long meetings:** Thread context injection is capped at 200 messages. For marathon meetings, agents lose early context but retain the most recent exchanges. This is acceptable — real meetings have the same problem.

**Concurrent human messages:** Two humans post at the same time in the same thread. Each message gets its own classifier call and round 0/1 cycle. The reaction tracker is keyed per human message timestamp, so the rounds don't interfere. Agents may receive overlapping dispatches — existing agent-manager thread queuing handles serialization.

**Restart recovery:** `meetingRosters` is in-memory. On restart, the roster is rebuilt from the thread by fetching `conversations.replies` and re-scanning for agent names on the next message in that thread. Graceful degradation — the first post-restart message may miss some context, but the roster rebuilds quickly.

**Conference channel without a thread:** Human posts a top-level message (not in a thread) to `#conf-strategy`. This starts a new meeting. The message IS the thread parent. Subsequent replies in that thread are the meeting. Top-level messages without replies are effectively one-message meetings.

## Cost

Per human message in a meeting with N roster members:

| Component | Calls | Cost per call | Total |
|-----------|-------|---------------|-------|
| Classifier (round 0) | 1 | ~$0.0001 | ~$0.0001 |
| Agent sessions (round 0) | 1-N | Varies by model tier | Varies |
| Classifier (round 1) | 0-N | ~$0.0001 | ~$0.000N |
| Agent reactions (round 1) | 0-N | Varies by model tier | Varies |

The classifier cost is negligible. The real cost is agent sessions. With a 4-agent meeting where the classifier selects 2 agents per round:

- Round 0: 1 classifier + 2 agent sessions
- Round 1: 2 classifiers + maybe 1-2 reaction sessions
- Total: ~3-4 classifier calls (~$0.0004) + 3-4 agent sessions

Compared to the existing multi-agent thread approach (all 4 agents on every message), the classifier typically reduces agent invocations by 30-60% depending on conversation topic.

## Non-Goals

- Per-channel agent rosters in config (roster is per-thread via roll call)
- Removing agents from a meeting mid-thread
- Agent-initiated meetings (agents starting threads in conference channels)
- Cross-thread meeting awareness (each thread is independent)
- Persistent meeting state beyond thread lifetime
- Custom meeting preambles per agent or per channel
