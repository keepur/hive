# Borrow from Claude Code — Architecture Audit & Game Plan

**Date:** 2026-04-02
**Epic:** Borrow from Claude Code
**Origin:** Claude Code source leak analysis (March 31 2026, npm v2.1.88 source map exposure)

## Background

On March 31, Anthropic accidentally shipped a 60MB source map in their npm package. The community reconstructed 512,000 lines of TypeScript — the full Claude Code codebase. The root cause was a `.npmignore` miss (Bun generates source maps by default). This was a packaging error, not a hack.

Mokie (Chief of Staff agent) did the initial research synthesis. This document captures the full audit: what's relevant to Hive, where we're aligned or ahead, and — most importantly — where we should borrow their ideas and what to build.

### Our posture on code secrecy

We don't care. Our distribution model ships code to customer edge machines — source is assumed public. Our moat is operational (agent memory corpus, deployment infrastructure, behavioral tuning from hundreds of hours of iteration), not architectural secrecy. This audit is about learning from their 512K lines, not protecting ours.

---

## What the Leak Revealed (Relevant to Hive)

### 1. Agentic Architecture

Lead agent + subagents pattern. A primary Claude instance coordinates the session, spawns isolated subagents for parallel work. Each subagent gets its own context window and restricted toolset. Forked subagents share cached context from the parent (prompt caching optimization), so spawning 5 costs barely more than 1. Every tool defines its own input schema, permission level, and execution logic independently — no shared mutable state.

### 2. Three-Layer Context Compression

- **MicroCompact** — local edits, no API cost (pure text reduction)
- **AutoCompact** — triggers near context limits, generates structured summaries with a reserved token buffer (headroom so you never hit the wall)
- **FullCompact** — full conversation compression with selective file re-injection
- **SYSTEM_PROMPT_DYNAMIC_BOUNDARY** — separates static instructions from dynamic context so prompt caching works efficiently

### 3. KAIROS — Unshipped Always-On Daemon

Referenced 150+ times. Fully built but feature-flagged:
- Watches, logs, and proactively acts with a 15-second blocking budget (longer tasks deferred)
- **autoDream** system does "memory consolidation" while idle — merges observations, removes contradictions, converts insights into facts
- Append-only daily log files for auditability

### 4. 44 Feature Flags

Beyond KAIROS: voice mode (push-to-talk), ULTRAPLAN (offloads to cloud Opus for 30+ min), coordinator mode, and a Tamagotchi pet called Buddy with 18 species.

### 5. Model Codenames

- Capybara = Claude 4.6 (Sonnet class)
- Fennec = Opus 4.6
- Numbat = unreleased, still testing
- Internal notes: Capybara v8 has 29-30% false claims rate (regression from v4's 16.7%)

### 6. Supply Chain Attack

Between 00:21 and 03:29 UTC on March 31, a malicious axios package (containing a RAT) was pushed to npm — timed to catch anyone rushing to install/update Claude Code. Reminder: lock dependencies, verify checksums, use lockfiles.

---

## Audit: Where We Stand

### Where Hive Is Aligned or Ahead

| Area | Assessment | Detail |
|---|---|---|
| **Multi-agent orchestration** | Ahead | Claude Code uses a lead + subagent model (one primary, ephemeral children). Hive runs a fleet of persistent peers with a flat Dispatcher. DB-native agent definitions with hot-reload via change streams, per-agent model ceilings, fan-out to multiple agents simultaneously, multi-agent thread tracking with session persistence across restarts. Their subagents are ephemeral task workers; ours are always-on employees with memory, schedules, and identity. |
| **Tool-level permission gating** | Aligned | Claude Code defines permissions per-tool in the tool schema. Hive does it at the server level via `coreServers`/`delegateServers` allowlists, plus in-server gates (memory scoped by `AGENT_ID`, tool registration gated by mode). Different mechanism, same outcome. Delegate subagent recursion prevention (`disallowedTools: ["Agent"]`) is identical in both. |
| **Always-on daemon** | Ahead (of shipped CC) | KAIROS is unshipped, feature-flagged. Hive agents are already persistent daemons via LaunchAgent with KeepAlive, crash recovery, and orphan detection. Agents self-schedule cron jobs, set callbacks, emit events, and survive restarts with full session recovery from MongoDB. |
| **Per-turn model routing** | Unique advantage | Claude Code uses one model per session. Hive's Haiku classifier picks the right model tier per-turn, capped at the agent's ceiling. A thread can start at Haiku for "thanks!" and escalate to Sonnet for "let me change my order." Real cost optimization they don't have. |
| **Cross-agent coordination** | Ahead | Claude Code subagents only report back to the lead agent. Hive agents emit domain events (`deals:won`, `cases:opened`) that subscribing agents pick up asynchronously via the event bus. Genuine decoupled coordination, not just delegation. |

### Where We Should Borrow From Their Playbook

---

## Priority 1: Conversation Context Compaction

**The gap:** Hive has zero conversation compaction. When a long thread approaches the model's context window limit, the session fails or degrades silently. The SDK handles it however it handles it — we have no visibility or control.

**What Claude Code does:** Three distinct strategies — MicroCompact (local text reduction, no API cost), AutoCompact (triggered before hitting the wall, generates structured summary with reserved token buffer), FullCompact (full conversation compression with selective file re-injection).

**What to build:**

1. **Token tracking per session.** After each `runner.send()`, capture token usage from SDK response and track cumulative per-thread in session metadata.

2. **Auto-compact trigger.** When a session crosses ~70% of the model's context window (~140K for Sonnet's 200K), fire a compaction turn before the next user message. This turn asks the model to summarize the conversation into a structured format (key decisions, open threads, referenced files), then starts a new session with that summary injected as system context.

3. **Selective re-injection.** The summary tags which files/memory records were actively referenced. On session restart, re-inject those specifically rather than the full hot-tier dump.

**Key files:** `agent-manager.ts` (token tracking, compaction trigger), `agent-runner.ts` (summary injection on session restart), `session-store.ts` (persist token counts).

**Why it matters:** This is the difference between Jasper's code_task sessions dying at the 3-hour mark and running indefinitely. Also affects Jessica's long customer threads and Milo's multi-day sales conversations.

**Estimated scope:** ~500-800 lines of new code.

---

## Priority 2: Static/Dynamic System Prompt Separation for Cache Efficiency

**The gap:** Every call to `buildSystemPrompt()` prepends the current date/time at position 1. This changes every minute, killing Anthropic's prompt caching. Soul, constitution, and system prompt are static content (~2-4K tokens) that could be cached — but can't because they're concatenated with dynamic content.

**What Claude Code does:** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` pattern explicitly separates static instructions from dynamic context. The API caches the static prefix and only reprocesses the dynamic suffix.

**What to build:** Restructure `buildSystemPrompt()` to return two parts:

- **Static (cacheable):** soul + systemPrompt + constitution + delegate summaries
- **Dynamic (per-turn):** date/time + hot-tier memory + thread-specific context

Use the Claude SDK's array-format system prompt. Static part first (cached), dynamic part second. Move date/time to the end of the dynamic section, not the beginning of the static section.

**Key files:** `agent-runner.ts` (`buildSystemPrompt()` refactor and `query()` call).

**Why it matters:** With 10+ agents running multiple threads, full prompt processing on every turn is expensive. Caching the static prefix could save 30-50% of input token costs across the board.

**Estimated scope:** ~100-200 lines, mostly rearranging existing code.

---

## Priority 3: autoDream — Proactive Memory Consolidation

**The gap:** Hive's memory lifecycle sweeper runs every 6 hours and only does tier reclassification and cold summarization. It doesn't merge observations, resolve contradictions, or convert repeated patterns into facts.

End-of-conversation reflection is close but reactive — fires only when a conversation ends, relies on the agent deciding what's worth saving. No process looks across all of an agent's recent memories to consolidate them.

**What Claude Code's autoDream does:**
- Runs during idle periods (no active user interaction)
- Reviews recent observations/interactions
- Merges duplicate or overlapping memories
- Identifies contradictions and resolves them (newer wins, or flags for review)
- Promotes patterns across multiple interactions to "fact" tier

**What to build:**

1. **Duplicate detection.** For each agent, embed all hot+warm records and find clusters with cosine similarity > 0.85. Merge clusters into single consolidated records.

2. **Contradiction detection.** For records tagged as `fact` or `decision`, use a Haiku call to check for contradicting pairs. Keep newer, demote/forget older.

3. **Pattern promotion.** Same topic in 3+ `interaction` records across different conversations → generate a `fact` summary, promote to hot. Individual interactions decay to cold normally.

4. **Run timing.** After existing lifecycle sweep, or triggered by detected idle (no messages dispatched in 30+ minutes).

**Key files:** `memory-lifecycle.ts` (new consolidation methods), `memory-embedder.ts` (Qdrant similarity queries), new Haiku calls for contradiction detection.

**Why it matters:** Without this, agent memory gets noisy. Milo has 15 memories about the same prospect that never consolidate. Jasper has conflicting architectural decisions from different conversations. Reflection catches some of this, but only sees the current conversation — can't cross-reference.

**Estimated scope:** ~400-600 lines plus tests.

---

## Priority 4: Feature Flags for Gradual Autonomy Rollout

**The gap:** Hive has exactly two meaningful feature flags: `memory.structured` and `externalComms.enabled`. Claude Code has 44. The point isn't the number — it's the pattern: every new autonomous capability ships behind a flag, enableable per-agent, per-instance, or globally.

**What to build:** A lightweight flag system in `AgentDefinition` and `hive.yaml`:

- `autonomy.selfSchedule` — can the agent modify its own cron schedules?
- `autonomy.emitEvents` — can the agent emit events to other agents?
- `autonomy.backgroundTasks` — can the agent spawn background processes?
- `autonomy.codeTask` — can the agent delegate to Claude Code CLI?
- `autonomy.reflection` — does end-of-conversation reflection run?
- `autonomy.compaction` — does auto-compaction trigger? (when built)
- `autonomy.autoDream` — does memory consolidation run? (when built)

Per-agent flags in the `AgentDefinition` doc, with instance-level defaults in `hive.yaml`.

**Why this matters for the product:** When code ships to customer edge machines, the customer needs to control what agents can do autonomously. Feature flags are the product interface for that control. Not about hiding features — about giving customers a trust dial they can turn up gradually.

**Estimated scope:** ~200-300 lines. Schema change to `AgentDefinition`, guard checks in relevant code paths, `hive.yaml` defaults.

---

## Priority 5: Agent Activity Log (Observation Log)

**The gap:** Hive logs mixed structured JSON to stdout — operational errors, debug traces, and agent activity in one stream. Claude Code's KAIROS uses append-only daily log files specifically for agent observations and actions.

**What to build:** Separate `agent-activity` log per agent, append-only, daily rotation:

```
logs/activity/jasper/2026-04-02.jsonl
logs/activity/milo/2026-04-02.jsonl
```

Each line: timestamp, action type (message_received, tool_called, memory_saved, event_emitted, schedule_fired, callback_set), summary, token cost, model used.

**Why it matters for the product:** This is the auditability layer that makes "always-on autonomous agents on your edge machine" palatable to a business owner. "What did my agents do today?" should be answerable by reading one file. Also raw material for the autoDream consolidation pass.

**Estimated scope:** ~150-200 lines. New logger utility, hook into `AgentManager.processMessage()` completion, daily rotation.

---

## Sources

- [VentureBeat: Claude Code's source code appears to have leaked](https://venturebeat.com/)
- [The New Stack: Inside Claude Code's leaked source — swarms, daemons, and 44 features](https://thenewstack.io/)
- [WaveSpeedAI: Claude Code Architecture Deep Dive](https://wavespeedai.com/)
- [WaveSpeedAI: BUDDY, KAIROS & Every Hidden Feature](https://wavespeedai.com/)
- [Blockchain Council: Technical Takeaways for LLM Developers](https://www.blockchain-council.org/)
- [Alex Kim: Fake tools, frustration regexes, undercover mode](https://alexkim.substack.com/)
- [Layer5: 512,000 Lines, a Missing .npmignore](https://layer5.io/)
- [The Hacker News: Claude Code Leaked via npm Packaging Error](https://thehackernews.com/)
- [VentureBeat: 5 Actions Enterprise Security Leaders Should Take](https://venturebeat.com/)
- [ClaudeFast: Claude Code Source Leak — Everything Found](https://claudefast.com/)
- [Superframeworks: What 512K Lines Reveal](https://superframeworks.com/)
- [DEV Community: Accident, Incompetence, or Best PR Stunt](https://dev.to/)
