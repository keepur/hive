# Conference Channels Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Enable meeting-style agent collaboration in `conf-` prefixed Slack channels with Haiku-based relevance classification, thread context injection, and depth-1 peer reactions.

**Architecture:** Conference channels add a new routing path in the dispatcher that detects `conf-` prefixed channels, maintains per-thread rosters, classifies which agents should respond via a Haiku classifier, and injects full thread history into each agent's context. After round-0 responses, a depth-1 reaction loop lets peers react to each other once per human message.

**Tech Stack:** TypeScript, Claude Agent SDK (`query()`), Slack Web API (`conversations.replies`), existing dispatcher/adapter infrastructure.

---

### Task 1: Meeting Classifier

**Files:**
- Create: `src/agents/meeting-classifier.ts`

This is a standalone module following the exact pattern of `src/agents/model-router.ts`. No dependencies on dispatcher or adapter.

- [ ] **Step 1:** Create `src/agents/meeting-classifier.ts`

```typescript
import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";

const log = createLogger("meeting-classifier");

export interface RosterMember {
  agentId: string;
  name: string;
  title?: string;
  role: string; // first line of soul
}

export interface ClassifyResult {
  respondAgentIds: string[];
  costUsd: number;
  durationMs: number;
}

const CLASSIFIER_PROMPT = `You are a meeting facilitator. Given a message and a list of meeting participants, decide which participants should respond.

Rules:
- If someone is addressed by name, they MUST be in the respond list.
- Pick participants whose expertise is directly relevant to the message.
- Fewer is better — don't trigger everyone for a question only one person can answer.
- If the message is clearly directed at one person, return only that person.
- If the message is a general question to the room, pick 2-3 most relevant.
- For "what does everyone think?" style questions, include all participants.

Respond with ONLY a JSON object: { "respond": ["agent-id-1", "agent-id-2"] }`;

function parseClassifierOutput(
  text: string,
  validIds: Set<string>,
): string[] | null {
  const extract = (raw: string): string[] | null => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.respond)) {
        return parsed.respond.filter((id: string) => validIds.has(id));
      }
    } catch {
      /* fall through */
    }
    return null;
  };

  // Try direct parse
  const direct = extract(text);
  if (direct) return direct;

  // Try finding JSON in text
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    const nested = extract(text.slice(braceStart, braceEnd + 1));
    if (nested) return nested;
  }

  return null;
}

function buildRosterContext(
  roster: RosterMember[],
  recentMessages?: string,
): string {
  const participants = roster
    .map(
      (r) =>
        `- ${r.agentId} (${r.name}${r.title ? `, ${r.title}` : ""}): ${r.role}`,
    )
    .join("\n");

  let prompt = `Participants:\n${participants}`;
  if (recentMessages) {
    prompt += `\n\nRecent thread context:\n${recentMessages}`;
  }
  return prompt;
}

export async function classifyMeetingMessage(
  messageText: string,
  roster: RosterMember[],
  recentMessages?: string,
): Promise<ClassifyResult> {
  const validIds = new Set(roster.map((r) => r.agentId));

  if (roster.length === 0) {
    return { respondAgentIds: [], costUsd: 0, durationMs: 0 };
  }

  // If only one participant, skip the classifier
  if (roster.length === 1) {
    return { respondAgentIds: [roster[0].agentId], costUsd: 0, durationMs: 0 };
  }

  const routerModel = config.modelRouter.model;
  let q: Query | null = null;
  let resultText = "";
  let costUsd = 0;
  let durationMs = 0;

  const deadline = setTimeout(() => {
    if (q) {
      log.warn("Meeting classifier timed out", {
        timeoutMs: config.modelRouter.timeoutMs,
      });
      q.close();
    }
  }, config.modelRouter.timeoutMs);

  try {
    const userPrompt = `${buildRosterContext(roster, recentMessages)}\n\nMessage:\n${messageText}`;

    q = query({
      prompt: userPrompt,
      options: {
        model: routerModel,
        systemPrompt: CLASSIFIER_PROMPT,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        persistSession: false,
        thinking: { type: "disabled" },
        disallowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Agent",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
        ],
        env: {
          ...process.env,
          ...(config.anthropic.apiKey
            ? { ANTHROPIC_API_KEY: config.anthropic.apiKey }
            : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined as unknown as string,
        },
      },
    });

    for await (const message of q) {
      const msg = message as SDKMessage;

      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              resultText = block.text;
            }
          }
        }
      }

      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        costUsd = result.total_cost_usd;
        durationMs = result.duration_ms;
        if (result.subtype === "success" && result.result) {
          resultText = result.result;
        }
      }
    }
  } catch (err) {
    log.warn("Meeting classifier query failed, selecting all roster members", {
      error: String(err),
    });
    return {
      respondAgentIds: [...validIds],
      costUsd: 0,
      durationMs: 0,
    };
  } finally {
    clearTimeout(deadline);
    q = null;
  }

  const parsed = parseClassifierOutput(resultText, validIds);
  if (!parsed) {
    log.warn("Meeting classifier parse failed, selecting all roster members", {
      rawText: resultText.slice(0, 200),
    });
    return { respondAgentIds: [...validIds], costUsd, durationMs };
  }

  log.info("Meeting classifier decision", {
    respond: parsed,
    rosterSize: roster.length,
    costUsd,
    durationMs,
  });

  return { respondAgentIds: parsed, costUsd, durationMs };
}
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 3:** Commit

```bash
git add src/agents/meeting-classifier.ts
git commit -m "feat: add meeting classifier for conference channels"
```

---

### Task 2: Thread History Fetch on SlackAdapter

**Files:**
- Modify: `src/channels/slack-adapter.ts`

Add a public method to fetch and format Slack thread history.

- [ ] **Step 1:** Add `ThreadMessage` interface and `fetchThreadHistory` method to `SlackAdapter`

After the existing `client` getter (line 184), add:

```typescript
export interface ThreadMessage {
  author: string;
  text: string;
  timestamp: Date;
  isBot: boolean;
}
```

Add this method to the `SlackAdapter` class:

```typescript
  /**
   * Fetch thread replies for context injection into conference channel agents.
   * Returns messages formatted with author names and timestamps.
   */
  async fetchThreadHistory(
    channelId: string,
    threadTs: string,
  ): Promise<ThreadMessage[]> {
    try {
      const result = await this.gateway.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
      });

      const messages: ThreadMessage[] = [];
      for (const msg of result.messages ?? []) {
        if (!msg.text && !msg.blocks) continue;

        let author = "Unknown";
        let isBot = false;

        if (msg.bot_id || msg.subtype === "bot_message") {
          // Bot message — try to extract agent name from formatted response
          // Agent responses are formatted as "icon *Name*: text"
          const nameMatch = msg.text?.match(/^\S+\s\*([^*]+)\*:/);
          author = nameMatch ? nameMatch[1] : msg.username ?? "Agent";
          isBot = true;
        } else if (msg.user) {
          // Human message — resolve display name
          try {
            const userInfo = await this.gateway.client.users.info({
              user: msg.user,
            });
            author = userInfo.user?.real_name ?? userInfo.user?.name ?? msg.user;
          } catch {
            author = msg.user;
          }
        }

        messages.push({
          author,
          text: msg.text ?? "",
          timestamp: new Date(parseFloat(msg.ts ?? "0") * 1000),
          isBot,
        });
      }

      return messages;
    } catch (err) {
      log.warn("Failed to fetch thread history", {
        channelId,
        threadTs,
        error: String(err),
      });
      return [];
    }
  }
```

- [ ] **Step 2:** Add the `ThreadMessage` export to the import surface

The `ThreadMessage` interface should be exported from the file so the dispatcher can use it. Place the interface definition above the class (after imports, before line 19).

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 4:** Commit

```bash
git add src/channels/slack-adapter.ts
git commit -m "feat: add fetchThreadHistory to SlackAdapter for conference channels"
```

---

### Task 3: Dispatcher Conference Mode

**Files:**
- Modify: `src/channels/dispatcher.ts`
- Modify: `src/index.ts`

This is the core task — adds conference detection, roster tracking, context injection, and depth-1 reactions to the dispatcher.

- [ ] **Step 1:** Add imports and types

Add to the import block at the top of `dispatcher.ts`:

```typescript
import type { SlackAdapter, ThreadMessage } from "./slack-adapter.js";
import {
  classifyMeetingMessage,
  type RosterMember,
} from "../agents/meeting-classifier.js";
```

Add the `ResolvedAgent` interface after the `NON_RESPONSE_PATTERNS` block (after line 28):

```typescript
/** Extended resolved-agent type carrying optional conference metadata */
interface ResolvedAgent {
  agentId: string;
  conferenceMode?: boolean;
  conferenceHumanTs?: string;
  conferenceRound?: number; // 0 = human-triggered, 1 = peer reaction
  threadContext?: string;
  meetingPreamble?: string;
}
```

- [ ] **Step 2:** Add conference state maps and setter

Add to the private fields block (after line 44, after `retryQueue` and `teamStore`):

```typescript
  private slackAdapter?: SlackAdapter;
  private meetingRosters = new Map<string, Set<string>>(); // threadId → agent IDs
  // Map<threadId, Map<humanMessageTs, Set<agentId>>> — tracks which agents reacted in round 1
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
```

Add the setter method after `setAuditChannel` (after line 79):

```typescript
  setSlackAdapter(adapter: SlackAdapter): void {
    this.slackAdapter = adapter;
  }
```

- [ ] **Step 3:** Add conference detection to `resolveAgents`

Insert the conference check after origin routing (after line 282, before the dedicated channel check at line 284):

```typescript
    // 0.7 Conference channel — meeting mode with classifier-gated fan-out
    if (item.source.kind === "slack" && item.source.label.startsWith("conf-")) {
      return this.resolveConferenceAgents(item);
    }
```

- [ ] **Step 4:** Add `resolveConferenceAgents` method

Add this private method to the class (before `resolveAgents`, or after the sweep method):

```typescript
  private async resolveConferenceAgents(
    item: WorkItem,
  ): Promise<ResolvedAgent[]> {
    const threadId = item.threadId ?? item.id;

    // Build/update roster from name mentions
    const roster = this.meetingRosters.get(threadId) ?? new Set<string>();
    const newMentions = this.registry.findAllByName(item.text);
    for (const agent of newMentions) {
      roster.add(agent.id);
    }
    this.meetingRosters.set(threadId, roster);
    this.threadAgentLastSeen.set(threadId, Date.now());

    if (roster.size === 0) {
      log.debug("Conference channel — no roster yet", {
        channel: item.source.label,
        threadId,
      });
      return [];
    }

    // Build roster member list for classifier
    const rosterMembers: RosterMember[] = [];
    for (const agentId of roster) {
      const agent = this.registry.get(agentId);
      if (!agent || agent.disabled) continue;
      rosterMembers.push({
        agentId: agent.id,
        name: agent.name,
        title: agent.title,
        role: agent.soul.split("\n")[0], // first line of soul as role summary
      });
    }

    if (rosterMembers.length === 0) {
      return [];
    }

    // Fetch thread context for injection and classifier recency
    let threadContext = "";
    let recentMessages = "";
    if (this.slackAdapter) {
      const channelId = item.source.id;
      const threadTs =
        (item.meta?.slackThreadTs as string) ??
        (item.meta?.slackTs as string) ??
        threadId;
      const history = await this.slackAdapter.fetchThreadHistory(
        channelId,
        threadTs,
      );
      threadContext = this.formatThreadContext(
        history,
        item.source.label,
        rosterMembers,
      );
      // Last 5 messages for classifier recency context
      recentMessages = history
        .slice(-5)
        .map((m) => `${m.author}: ${m.text.slice(0, 200)}`)
        .join("\n");
    }

    // Run classifier
    const classification = await classifyMeetingMessage(
      item.text,
      rosterMembers,
      recentMessages,
    );

    log.info("Conference classifier result", {
      channel: item.source.label,
      threadId,
      roster: [...roster],
      selected: classification.respondAgentIds,
      costUsd: classification.costUsd,
    });

    const preamble = this.buildMeetingPreamble(
      item.source.label,
      rosterMembers,
    );

    return classification.respondAgentIds.map((agentId) => ({
      agentId,
      conferenceMode: true,
      conferenceHumanTs: item.meta?.slackTs as string,
      conferenceRound: 0,
      threadContext,
      meetingPreamble: preamble,
    }));
  }
```

- [ ] **Step 5:** Add helper methods for context formatting and preamble

```typescript
  private formatThreadContext(
    history: ThreadMessage[],
    channelName: string,
    roster: RosterMember[],
  ): string {
    if (history.length === 0) return "";

    const participantNames = roster.map((r) => r.name).join(", ");
    const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;

    // If thread is very long, include first 5 + last 100 messages
    let messages = history;
    if (history.length > 105) {
      const first = history.slice(0, 5);
      const last = history.slice(-100);
      messages = [...first, ...last];
    }

    const formatted = messages
      .map((m) => {
        const ago = this.formatTimeAgo(m.timestamp);
        return `${m.author} (${ago}): ${m.text}`;
      })
      .join("\n");

    return `${header}\n\n${formatted}`;
  }

  private formatTimeAgo(timestamp: Date): string {
    const seconds = Math.floor((Date.now() - timestamp.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  private buildMeetingPreamble(
    channelName: string,
    roster: RosterMember[],
  ): string {
    const names = roster.map((r) => r.name).join(", ");
    return `You are in a meeting in #${channelName} with ${names}.

Meeting rules:
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- If you have nothing meaningful to add, respond with "No response needed."
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;
  }
```

- [ ] **Step 6:** Update `resolveAgents` return type and `dispatchToAgent` signature

Change the `resolveAgents` signature (line 254) from:
```typescript
  private async resolveAgents(item: WorkItem): Promise<{ agentId: string }[]> {
```
to:
```typescript
  private async resolveAgents(item: WorkItem): Promise<ResolvedAgent[]> {
```

Change the `dispatchToAgent` signature (line 434) from:
```typescript
  private async dispatchToAgent(item: WorkItem, resolved: { agentId: string }): Promise<void> {
```
to:
```typescript
  private async dispatchToAgent(item: WorkItem, resolved: ResolvedAgent): Promise<void> {
```

- [ ] **Step 7:** Add conference context injection and reaction hook in `dispatchToAgent`

After `const { agentId } = resolved;` (line 435), add conference context injection using a new variable (TypeScript does not allow reassigning function parameters):

```typescript
    // Conference mode: inject thread context + preamble into the WorkItem
    let effectiveItem = item;
    if (resolved.conferenceMode) {
      const contextPrefix = [
        resolved.meetingPreamble,
        "",
        resolved.threadContext,
        "",
        "---",
        `[New message]:`,
      ]
        .filter(Boolean)
        .join("\n");
      effectiveItem = {
        ...item,
        text: `${contextPrefix}\n${item.text}`,
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
        },
      };
    }
```

Then replace all subsequent references to `item` in `dispatchToAgent` with `effectiveItem` — specifically the calls to `agentManager.sendMessage(agentId, effectiveItem)`, `adapter.deliver(...)` where `workItem: effectiveItem`, and the `triggerConferenceReactions` call.

After the response is delivered (after the `if (adapter)` block that calls `adapter.deliver`, around line 467), add the depth-1 reaction hook:

```typescript
        // Conference mode: trigger depth-1 peer reactions
        if (
          resolved.conferenceMode &&
          resolved.conferenceRound === 0 &&
          !isNonResponse
        ) {
          this.triggerConferenceReactions(
            runResult.text,
            effectiveItem,
            agentId,
          ).catch((err) =>
            log.warn("Conference reaction trigger failed", {
              error: String(err),
            }),
          );
        }
```

- [ ] **Step 8:** Add `triggerConferenceReactions` method

```typescript
  private async triggerConferenceReactions(
    responseText: string,
    originalItem: WorkItem,
    respondingAgentId: string,
  ): Promise<void> {
    const threadId = originalItem.threadId ?? originalItem.id;
    const humanTs = originalItem.meta?.conferenceHumanTs as string;
    if (!humanTs) return;

    const roster = this.meetingRosters.get(threadId);
    if (!roster) return;

    // Get or create reaction tracker for this thread + human message
    if (!this.meetingReactionTracker.has(threadId)) {
      this.meetingReactionTracker.set(threadId, new Map());
    }
    const threadTracker = this.meetingReactionTracker.get(threadId)!;
    const reacted = threadTracker.get(humanTs) ?? new Set<string>();
    threadTracker.set(humanTs, reacted);

    // Build roster of peers who haven't reacted yet.
    // IMPORTANT: Claim peers in `reacted` synchronously BEFORE the async classifier call
    // to prevent concurrent round-0 responders from double-triggering the same peer.
    const peerMembers: RosterMember[] = [];
    for (const agentId of roster) {
      if (agentId === respondingAgentId) continue;
      if (reacted.has(agentId)) continue;
      const agent = this.registry.get(agentId);
      if (!agent || agent.disabled) continue;
      reacted.add(agentId); // claim before await — prevents race with concurrent calls
      peerMembers.push({
        agentId: agent.id,
        name: agent.name,
        title: agent.title,
        role: agent.soul.split("\n")[0],
      });
    }

    if (peerMembers.length === 0) return;

    // Classify which peers should react to this response
    const classification = await classifyMeetingMessage(
      responseText,
      peerMembers,
    );

    if (classification.respondAgentIds.length === 0) return;

    log.info("Conference depth-1 reactions", {
      threadId,
      respondingAgent: respondingAgentId,
      peers: classification.respondAgentIds,
    });

    // Re-fetch thread context (now includes the round-0 response)
    let threadContext = "";
    let preamble = "";
    if (this.slackAdapter) {
      const channelId = originalItem.source.id;
      const threadTs =
        (originalItem.meta?.slackThreadTs as string) ??
        (originalItem.meta?.slackTs as string) ??
        threadId;
      const history = await this.slackAdapter.fetchThreadHistory(
        channelId,
        threadTs,
      );
      const allRosterMembers: RosterMember[] = [];
      for (const agentId of roster) {
        const agent = this.registry.get(agentId);
        if (!agent || agent.disabled) continue;
        allRosterMembers.push({
          agentId: agent.id,
          name: agent.name,
          title: agent.title,
          role: agent.soul.split("\n")[0],
        });
      }
      threadContext = this.formatThreadContext(
        history,
        originalItem.source.label,
        allRosterMembers,
      );
      preamble = this.buildMeetingPreamble(
        originalItem.source.label,
        allRosterMembers,
      );
    }

    // Dispatch reactions concurrently (peers already claimed in reacted set above)
    const reactionDispatches = classification.respondAgentIds.map(
      (agentId) => {
        const resolved: ResolvedAgent = {
          agentId,
          conferenceMode: true,
          conferenceHumanTs: humanTs,
          conferenceRound: 1,
          threadContext,
          meetingPreamble: preamble,
        };
        return this.dispatchToAgent(originalItem, resolved);
      },
    );

    await Promise.all(reactionDispatches);
  }
```

- [ ] **Step 9:** Update multi-agent fan-out to skip `threadParticipants` for conference mode

Change the fan-out block in `dispatch()` (lines 138-149) from:

```typescript
    if (activeList.length > 1) {
      const threadId = item.threadId ?? item.id;
      // Persist participant set so follow-up messages fan out to all participants
      if (!this.threadParticipants.has(threadId)) {
        this.threadParticipants.set(threadId, new Set(activeList.map((r) => r.agentId)));
      }
      this.threadAgentLastSeen.set(threadId, Date.now());
      log.info("Multi-agent fan-out", { agents: activeList.map((r) => r.agentId) });
      await Promise.all(activeList.map((r) => this.dispatchToAgent(item, r)));
      return;
    }
```

to:

```typescript
    if (activeList.length > 1) {
      const threadId = item.threadId ?? item.id;
      // Conference mode tracks roster separately — don't write to threadParticipants
      const isConference = activeList.some((r) => r.conferenceMode);
      if (!isConference && !this.threadParticipants.has(threadId)) {
        this.threadParticipants.set(threadId, new Set(activeList.map((r) => r.agentId)));
      }
      this.threadAgentLastSeen.set(threadId, Date.now());
      log.info(isConference ? "Conference fan-out" : "Multi-agent fan-out", {
        agents: activeList.map((r) => r.agentId),
      });
      await Promise.all(activeList.map((r) => this.dispatchToAgent(item, r)));
      return;
    }
```

- [ ] **Step 10:** Update `sweep()` to clean conference maps

Change the sweep method (lines 508-520) from:

```typescript
  sweep(threadTtlMs: number): SweepResult {
    const cutoff = Date.now() - threadTtlMs;
    let pruned = 0;
    for (const [id, ts] of this.threadAgentLastSeen) {
      if (ts < cutoff) {
        this.threadAgentMap.delete(id);
        this.threadParticipants.delete(id);
        this.threadAgentLastSeen.delete(id);
        pruned++;
      }
    }
    return { component: "dispatcher", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }
```

to:

```typescript
  sweep(threadTtlMs: number): SweepResult {
    const cutoff = Date.now() - threadTtlMs;
    let pruned = 0;
    for (const [id, ts] of this.threadAgentLastSeen) {
      if (ts < cutoff) {
        this.threadAgentMap.delete(id);
        this.threadParticipants.delete(id);
        this.meetingRosters.delete(id);
        this.meetingReactionTracker.delete(id);
        this.threadAgentLastSeen.delete(id);
        pruned++;
      }
    }
    return { component: "dispatcher", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }
```

- [ ] **Step 11:** Wire `setSlackAdapter` in `src/index.ts`

After the `dispatcher.registerAdapter(slackAdapter)` call (line 235), add:

```typescript
  dispatcher.setSlackAdapter(slackAdapter);
```

- [ ] **Step 12:** Verify

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 13:** Commit

```bash
git add src/channels/dispatcher.ts src/index.ts
git commit -m "feat: add conference channel routing with classifier and depth-1 reactions"
```

---

### Task 4: Tests

**Files:**
- Create: `src/agents/__tests__/meeting-classifier.test.ts`
- Create: `src/channels/__tests__/dispatcher-conference.test.ts`

- [ ] **Step 1:** Test the classifier output parser

```typescript
import { describe, it, expect } from "vitest";

// We need to test parseClassifierOutput — it's not exported, so test via classifyMeetingMessage
// or extract and export the parser. For now, test the public interface with mocked SDK.

describe("meeting-classifier", () => {
  // Parser logic tests via direct import if we export parseClassifierOutput for testing
  describe("parseClassifierOutput", () => {
    // Import the function — may need to export it as a named export for testing
    it.todo("parses valid JSON response");
    it.todo("extracts JSON from surrounding text");
    it.todo("filters out invalid agent IDs");
    it.todo("returns null for unparseable text");
  });
});
```

- [ ] **Step 2:** Test dispatcher conference routing

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("dispatcher conference mode", () => {
  describe("resolveAgents", () => {
    it.todo(
      "routes conf- prefixed channels to resolveConferenceAgents",
    );
    it.todo("skips conference mode for non-slack items");
    it.todo("skips conference mode for non-conf channels");
    it.todo("builds roster from name mentions across messages");
    it.todo("returns empty array when no agents named");
  });

  describe("context injection", () => {
    it.todo("prepends thread context and preamble to WorkItem text");
    it.todo("sets conferenceMode and conferenceHumanTs in meta");
  });

  describe("depth-1 reactions", () => {
    it.todo("triggers peer reactions after round-0 response");
    it.todo("does not trigger reactions after round-1 response");
    it.todo("tracks reacted agents to prevent double-triggering");
    it.todo("does not trigger reactions for non-responses");
  });

  describe("fan-out isolation", () => {
    it.todo(
      "conference fan-out does not write to threadParticipants",
    );
    it.todo(
      "non-conference fan-out still writes to threadParticipants",
    );
  });

  describe("sweep", () => {
    it.todo("cleans up meetingRosters on TTL expiry");
    it.todo("cleans up meetingReactionTracker on TTL expiry");
  });
});
```

Note: Full test implementation depends on the mocking strategy for the Claude Agent SDK `query()` function and the Slack WebClient. The test stubs above define the critical test surface. Implement the mocks following any existing test patterns in the repo.

- [ ] **Step 3:** Verify

Run: `npm run test`
Expected: All tests pass (including new ones)

- [ ] **Step 4:** Commit

```bash
git add src/agents/__tests__/meeting-classifier.test.ts src/channels/__tests__/dispatcher-conference.test.ts
git commit -m "test: add conference channel tests"
```

---

### Task 5: Full Check and Build

- [ ] **Step 1:** Run full check suite

Run: `npm run check`
Expected: typecheck + lint + format + test all pass

- [ ] **Step 2:** Fix any lint/format issues

Run: `npm run format -- --write` if needed

- [ ] **Step 3:** Build

Run: `npm run build`
Expected: Clean build, compiled JS in `dist/`

- [ ] **Step 4:** Final commit if any fixes

```bash
git add -A
git commit -m "chore: lint and format fixes for conference channels"
```
