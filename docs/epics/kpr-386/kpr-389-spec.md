# KPR-389 — Meeting turn-kind awareness: conferenceRound into spawn shaping + preamble hardening

**Epic:** KPR-386 (meeting mode) — third child, follows merged KPR-387 + KPR-388 (epic branch @ 7f6d92f).
**Status:** draft (spec review pending).
**Decision-register canon:** C1–C13 bind this spec; C3/C4/C5/C6/C7/C10/C12 are directly load-bearing — interactions resolved in §Design and §Canon compliance.

## TL;DR

`conferenceRound` (0 = primary, 1 = peer reaction) is stamped into `WorkItem.meta` by the dispatcher but nothing downstream ever reads it, so a depth-1 reaction turn gets a full DM-grade spawn: the effort classifier runs on the multi-KB shaped conference prompt, `maxTurns`/`timeoutMs` are the agent's full work-turn limits, and the preamble actively invites workspace re-orientation (observed: 30–156s reaction turns dominated by Bash/Read/Grep, many ending suppressed). Fix, in one ticket: (1) thread the round into `TurnContext` and give round-1 turns a dedicated `prepareSpawn` branch — effort classifier skipped, effort pinned `low` on claude-runtime lanes, `resourceLimits` clamped to reaction caps (`min(agent, maxTurns 6 / timeoutMs 120s)`) on every lane, using the KPR-354 nested-delegate turn-scoped-override template; (2) harden `buildMeetingPreamble` — the transcript is already in prompt ∪ session, don't re-orient with tools, decline immediately with the C4-safe escape phrase — updating the C6 and C10 byte pins deliberately; (3) stamp `conferenceRound` + `injectionMode` + `resumedSession` + the perf split (`durationMs`/`llmMs`/`toolMs`/`toolCalls`/`effort`) into `agent_turn_telemetry` for before/after measurement. Round-0 primaries are byte-untouched on every path.

## Key Points

- **Verified: the threading is 90% free.** `dispatchToAgent` (dispatcher.ts:1026–1035) already stamps `meta.conferenceRound` into the `effectiveItem` that flows into `runWorkItemTurn` → `TurnContext.workItem` → `prepareSpawn`. The ticket's "WorkItem meta → TurnContext → prepareSpawn" reduces to one typed parse helper + one optional `TurnContext` field; no dispatcher signature changes.
- **Effort per lane (verified):** the classifier (`routeModel`) runs only for claude-static, effort-capable, non-haiku agents (prepareSpawn:1763–1802) — and for a conference turn it runs on the *shaped* prompt (preamble + transcript), a pure waste on reactions. Lane A gets a clamped static `:effort` suffix; **Lane B adapters ignore `request.effort` entirely** (types.ts:112–120 — their effort is the constructor-time `:effort` suffix). So the round-1 pin is: claude + Lane A → `effortOverride: "low"`; Lane B → no effort change (caps still apply); classifier never called for round-1 on any lane.
- **maxTurns per lane (verified):** `SpawnShaping.resourceLimits` → `adapter.runTurn(request.resourceLimits)`. Claude lane: `AgentRunner.send` per-field fallback (`resourceLimits?.maxTurns ?? agentConfig.maxTurns` → SDK `Options.maxTurns`, runner:1954; `timeoutMs` deadline at runner:2026). Lane B: dispatch-loop round budget (`request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS`, e.g. codex adapter:270) + abort-signal wall clock. Lane A: currently `undefined` → runner legacy fallback. The KPR-354 template (`resourceLimits: { maxTurns, timeoutMs: 600_000, budgetUsd: 0 }`, agent-manager.ts:724) is the cited precedent for a turn-scoped literal override; this spec clamps rather than replaces (`min()` against the lane's base limits) so tighter operator config always wins.
- **Preamble hardening is pinned twice:** the C6 round-0 byte pin (dispatcher-conference.test.ts:501–510) and the C10 delta-shape pin's `PREAMBLE` helper (:516–523) both embed the full preamble text. Both are updated **deliberately in this ticket** — the only ticket licensed to (C6). The escape phrase stays `"No response needed."` verbatim: C4-safe (matches `NON_RESPONSE_PATTERNS`) and consistent with the C3-byte-intact round-1 terminal slot, which already instructs that exact phrase.
- **C10 honesty:** the hardened preamble says the thread is available "in this prompt and your session context" — true in full mode (prompt carries it) and delta mode (prompt ∪ session covers it, KPR-388's covering invariant). It never claims "the full transcript is in this prompt".
- **Telemetry surface (verified):** `agent_turn_telemetry` (turn-telemetry.ts) is token/cache-only today — no durations. Before/after measurement needs the perf split, so `TurnTelemetryDoc` gains optional `conferenceRound`/`injectionMode`/`resumedSession`/`durationMs`/`llmMs`/`toolMs`/`toolCalls`/`effort`; `ActivityRecord` gains optional `conferenceRound` (killed/errored turns never reach turn telemetry — the `result.sessionId && !aborted` gate — but always reach the activity log, so kill counts stay measurable). `resumedSession` (C7) is threaded into `recordSpawnObservability` from the same `!!finalAttemptSessionId` that feeds `finalizeSpawnResult`.
- **Outage replay (C12, verified):** a queued conference turn persists the *shaped* `effectiveItem` including `meta.conferenceRound`; replay resolves via `targetAgentId` (dispatcher.ts:816–819) with no conference fields — no re-injection, no mark bookkeeping — but the meta spread (outage-replay-processor.ts:107) preserves the round, so a replayed reaction keeps reaction shaping. Deliberate: same prompt, same turn kind, same caps.
- **⚠ Delegated assumptions** (flagged per contract): (1) cap values `REACTION_MAX_TURNS = 6` / `REACTION_TIMEOUT_MS = 120_000` are spec-chosen calibration (rationale §D3), not ticket-given; (2) round-1 kill suppression (§D5 fan-out leg + §D5b single-dispatch leg for replayed reactions — a clamp-killed reaction must not post `_No response._` into the meeting) is a small dispatcher addition implied but not named by the ticket; (3) the ticket's literal `"(no response)"` decline phrase is deliberately NOT adopted (§D4 rationale — C3/C4 coherence); (4) C5 lone-peer force-select is dispositioned measure-first with an explicit trigger (§C5), not code-changed here.
- **Risk: low.** One optional `TurnContext` field + one meta field + one shaping branch + one preamble string + additive optional telemetry fields. No new collections, no config keys, no provider-adapter changes, no session-store changes. Round-0 and non-conference turns are untouched by construction (branch keys strictly on `conferenceRound === 1`).

## Problem

Verified against merged code (epic branch @ 7f6d92f, KPR-387 + KPR-388 in):

1. **The round dies at the dispatcher boundary.** `dispatchToAgent` stamps `meta: { conferenceMode, conferenceHumanTs, conferenceRound }` (dispatcher.ts:1029–1034); `resolveConferenceAgents` sets round 0 (:1250), `triggerConferenceReactions` sets round 1 (:1460). Grep confirms no reader outside `dispatcher.ts` + its test. `prepareSpawn`, the model router, and `resourceLimits` resolution are all round-blind.
2. **Reactions pay full-turn resources.** A round-1 turn on a claude-static effort-capable agent runs `routeModel(item.text)` on the shaped prompt (preamble + transcript + peer reply — up to `MAX_CLASSIFIER_INPUT` 4000 chars) to decide the effort of a turn whose modal correct output is a decline. Its `maxTurns`/`timeoutMs` are the agent's work-turn limits (opus tier: 200 turns / 600s). Observed in `#conf-tahoe`: reaction turns of 30–156s dominated by tool time (grok: 79.9s turn = 70.3s tools / 9.5s model), many ending suppressed as `No response needed.` after the spend.
3. **The preamble invites the waste.** `buildMeetingPreamble` (:1350–1360) says nothing about the transcript already being present, so agents re-orient: Slack history fetches, workspace Grep/Read, team-mcp roster lookups — all before deciding they have nothing to add.
4. **Slow reactions block the agent's own primaries.** Per-thread lock key is `agentId:threadId`; a 2-minute reaction serializes ahead of that agent's next round-0 turn in the same meeting thread.
5. **No measurement surface.** `agent_turn_telemetry` records tokens/cache only; durations and tool/model split exist only in logs, and nothing anywhere records turn kind — before/after comparison for this fix is currently impossible.

## Goals

1. Round-1 reaction turns spawn cheap: no effort-classifier call, effort pinned `low` where deliverable, `maxTurns`/`timeoutMs` clamped to reaction caps — on all three lanes (claude, Lane A passthrough, Lane B native).
2. Round-0 primaries and all non-conference turns byte-identical to today on every path (shaping, effort, limits, prompt).
3. Hardened meeting preamble: no tool-based re-orientation, immediate C4-safe decline; true under both full and delta injection (C10); C6 + C10 byte pins updated deliberately.
4. `conferenceRound` (+ `injectionMode`, `resumedSession`, perf split) stamped into per-turn telemetry so the fix is measurable within one 14-day TTL window.
5. A clamp-killed reaction never posts noise into the meeting channel.

## Non-goals

- **Staleness culling** (skip a queued reaction when a newer human message arrived). Deferred with trigger, per ticket: file a follow-up only if post-fix telemetry still shows same-agent self-blocking (round-1 turns of the same agent delaying its round-0 turns — visible as lock-wait gaps between `createdAt` clusters in the new telemetry).
- **Per-turn tool-inventory restriction** for reactions. YAGNI until data says the preamble + caps are insufficient (ticket-explicit deferral).
- **Lane B per-turn effort delivery.** Lane B adapters consume effort at construction from the static `:effort` suffix and ignore `request.effort`; wiring a per-turn override is a provider-adapter change out of proportion to the win (caps + preamble carry the fix there). Re-open only if Lane B reaction telemetry stays pathological after this ticket.
- **Meeting-classifier changes** (`classifyMeetingMessage`) — including the C5 lone-peer shortcut (dispositioned measure-first, §C5) and the all-roster failure fallbacks (C1 semantics untouched).
- **Round-0 shaping of any kind** — explicitly untouched per ticket direction.
- **KPR-390 scope** (scribe/summary anchoring — C13's anchor site in the full-injection arm of `buildConferenceContext` is not touched).

## Design

### D1. Threading: meta → TurnContext → prepareSpawn

**Dispatcher (write side, one added field):** `dispatchToAgent`'s conference meta stamp gains the injection mode so telemetry can segment full vs delta turns:

```ts
meta: {
  ...item.meta,
  conferenceMode: true,
  conferenceHumanTs: resolved.conferenceHumanTs,
  conferenceRound: resolved.conferenceRound,
  conferenceInjectionMode: resolved.injectionMode,   // NEW — "full" | "delta" | undefined
},
```

**Typed parse helper** (agent-manager.ts, module scope — meta is untyped `Record<string, unknown>`):

```ts
/** KPR-389: typed read of the dispatcher's conference discriminator (C3 —
 *  meta.conferenceRound is the round-1 discriminator). Returns undefined for
 *  non-conference items and malformed values. Exported — the dispatcher's
 *  D5b single-dispatch suppression leg reads it too. */
export function conferenceRoundOf(item: WorkItem): 0 | 1 | undefined {
  const v = item.meta?.conferenceRound;
  return v === 0 || v === 1 ? v : undefined;
}
function conferenceInjectionModeOf(item: WorkItem): "full" | "delta" | undefined {
  const v = item.meta?.conferenceInjectionMode;
  return v === "full" || v === "delta" ? v : undefined;
}
```

**TurnContext** gains one optional field, set at the single channel ingress:

```ts
export interface TurnContext {
  …
  /** KPR-389: conference turn kind — 0 primary, 1 peer reaction. Set by
   *  runWorkItemTurn from WorkItem meta; undefined for every non-conference
   *  turn and for voice/reflection contexts (which never carry the meta). */
  conferenceRound?: 0 | 1;
}
```

`runWorkItemTurn` sets `conferenceRound: conferenceRoundOf(item)`. Reflection's ctx builder and voice's direct `spawnTurn` call are untouched (no meta ⇒ undefined anyway; the field is optional so no construction site breaks). Replay note: the meta survives outage replay (§E4), so a replayed reaction re-derives the same value through the same helper — no special casing.

### D2. Round-1 spawn shaping in prepareSpawn (per lane)

A dedicated branch inserted **after** prompt assembly (sender prefix / files / KPR-313 handoff prepend) and **before** the Lane A / Lane B / router branches — i.e. after prepareSpawn's current line ~1709, guarded so voice is structurally unreachable (the voice carve-out at :1665 returns earlier, and voice never carries the meta — double-safe):

```ts
// KPR-389: round-1 conference reactions spawn cheap — classifier skipped,
// effort pinned low where deliverable, limits clamped. Round 0 falls through
// to every existing path untouched.
if (ctx.conferenceRound === 1) {
  return this.shapeReactionTurn(prompt, staticRoute, staticTier, agentConfig, ctx.agentId);
}
```

`shapeReactionTurn` (new private method) resolves base limits per lane, clamps, and pins effort:

```ts
/** KPR-389: turn-scoped reaction caps. Template: KPR-354's nested-delegate
 *  literal override (agent-manager.ts — resourceLimits: { maxTurns, timeoutMs:
 *  600_000, budgetUsd: 0 }); here we clamp with min() instead of replacing so
 *  tighter operator config always wins. */
const REACTION_MAX_TURNS = 6;
const REACTION_TIMEOUT_MS = 120_000;

private shapeReactionTurn(
  prompt: string, staticRoute: ProviderModelRoute, staticTier: ModelTier,
  agentConfig: AgentConfig | undefined, agentId: string,
): SpawnShaping {
  // Degenerate guard (mirrors staticRoute's `?? ""` idiom): agent vanished
  // mid-turn ⇒ flow on; the turn fails inside the recorded try as today.
  if (!agentConfig) {
    return { prompt, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
  }
  // Base limits — config-accurate: exactly the values today's turn would
  // otherwise receive, so the min() invariant ("tighter operator config
  // always wins") holds on every reachable path:
  //   claude, router ON:  static-tier limits (resolveResourceLimits) — the
  //               router-on path's resourceLimits; the legacy triple is dead
  //               config there and is deliberately NOT folded in (folding it
  //               would newly activate config that has no effect today).
  //   claude, router OFF: agent-def legacy triple — today the router gate
  //               returns resourceLimits: undefined and the runner's
  //               per-field fallback applies agentConfig values; an
  //               operator's tightness may live there (e.g. maxTurns: 3) and
  //               must win the min(). The other two undefined-resolving
  //               claude paths are unreachable for round-1: reactions always
  //               carry a human sender (never "system"), and the router-catch
  //               belt-and-braces cannot fire because routeModel is never
  //               called here.
  //   Lane A + B: agent-def legacy triple (byte-identical to the Lane B
  //               branch construction at prepareSpawn:1748–1752; for Lane A
  //               this newly *materializes* the same values the runner's
  //               per-field fallback would have applied — no behavior change
  //               beyond the clamp).
  const legacy = { maxTurns: agentConfig.maxTurns, timeoutMs: agentConfig.timeoutMs ?? 300_000, budgetUsd: agentConfig.budgetUsd };
  const base = staticRoute.provider === "claude" && appConfig.modelRouter.enabled
    ? resolveResourceLimits(staticTier, agentConfig.resourceTiers)
    : legacy;
  const limits: ResourceLimits = {
    maxTurns: Math.min(base.maxTurns, REACTION_MAX_TURNS),
    timeoutMs: Math.min(base.timeoutMs, REACTION_TIMEOUT_MS),
    budgetUsd: base.budgetUsd,   // untouched — budget is not the reaction pathology
  };
  // Effort: claude-runtime lanes deliver via Options.effort ("low" is inside
  // the runner's {low,medium,high} narrowing at agent-runner.ts:1964). The
  // claude arm keeps the KPR-338 deliverability gate (haiku / off-catalog ⇒
  // undefined — pinning an undeliverable hint is a no-op at best). Lane B
  // ignores request.effort by contract (types.ts:112–120) ⇒ undefined.
  const effortOverride: ReasoningEffort | undefined =
    staticRoute.provider === "claude"
      ? (staticTier !== "haiku" && getLLMRegistry().supportsEffort(agentConfig.model) ? "low" : undefined)
      : isLaneAProvider(staticRoute.provider) ? "low" : undefined;
  return { prompt, route: staticRoute, resourceLimits: limits, routerCostUsd: 0, effortOverride };
}
```

What each lane actually receives (delivery mechanics verified):

| Lane | Effort | maxTurns | timeoutMs |
|---|---|---|---|
| claude (effort-capable) | `Options.effort = "low"` (runner:1964); **`routeModel` never called** — saves the sidecar call + its cost/latency on the shaped multi-KB prompt | `Options.maxTurns = min(base, 6)` (runner:1954) | runner deadline `min(base, 120s)` (runner:2026) |
| claude (haiku / off-catalog) | none (undeliverable — same as today) | `min(base, 6)` (haiku tier base is already 20/120s ⇒ 6/120s) | `min(base, 120s)` |
| Lane A (kimi/deepseek/grok) | `Options.effort = "low"` — overrides the clamped static `:effort` suffix for this turn only | `min(agent-def, 6)` — newly materialized limits object, values ≡ runner fallback | `min(agent-def ?? 300s, 120s)` |
| Lane B (openai/codex/gemini) | unchanged (constructor-time `:effort`; `request.effort` ignored) | dispatch-loop round budget `min(agent-def, 6)` (e.g. codex:270) | abort-signal deadline `min(agent-def ?? 300s, 120s)`; expiry = `TURN_DEADLINE_SUBTYPE`, breaker-inconclusive |

Claude-row `base` follows the D2 base rule: static-tier limits on router-enabled instances, the agent-def legacy triple when `modelRouter.enabled` is false — always the limits today's turn would actually have received.

**Cap calibration (⚠ spec-chosen):** `maxTurns 6` sits below KPR-354's delegate budgets (7 custom / 10 generic) because a reaction is strictly lighter than a delegated task — engage-or-decline over already-present context, with at most a couple of genuine lookups. `timeoutMs 120s` reuses the haiku-tier precedent for light turns (`RESOURCE_TIER_DEFAULTS.haiku.timeoutMs`), kills the observed 156s stragglers, and leaves honest sub-30s reactions untouched. Both are plain constants — trivially tunable when the new telemetry says otherwise.

**Breaker safety (verified):** deadline expiry on the claude lane surfaces as `timedOut`+`aborted` (classifies `aborted` — breaker-neutral); on Lane B as `TURN_DEADLINE_SUBTYPE` (breaker-inconclusive: never a trip, never a streak reset). Tight reaction clamps cannot trip a provider circuit.

### D3. Round-0 untouched — proof obligation

The only new code on the spawn path is the `ctx.conferenceRound === 1` branch. Round-0 conference items carry `meta.conferenceRound = 0` ⇒ helper returns `0` ⇒ branch not taken ⇒ control flows through the existing voice/Lane A/Lane B/router code byte-unchanged. Non-conference items carry no meta key ⇒ `undefined` ⇒ same. The test plan pins this negatively (a round-0 conference turn still invokes `routeModel`; a round-0 turn's `resourceLimits` deep-equals today's).

### D4. Preamble hardening (`buildMeetingPreamble`)

New literal (replaces dispatcher.ts:1350–1360; still one template string, flush-left continuation lines — the pins require it):

```ts
private buildMeetingPreamble(channelName: string, roster: RosterMember[]): string {
  const names = roster.map((r) => r.name).join(", ");
  return `You are in a meeting in #${channelName} with ${names}.

Meeting rules:
- The discussion so far is already in this prompt and your session context — do NOT re-read the channel, search the workspace, or re-orient with tools before speaking.
- If you have nothing meaningful to add, reply "No response needed." immediately — as your first output, with no tool calls first.
- Only use a tool if your reply genuinely needs information that is not already in this thread — never to re-read the meeting itself.
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;
}
```

Contract, line by line:

- **C4:** the escape phrase is `"No response needed."` — matches `NON_RESPONSE_PATTERNS[0]` (`/^no response (requested|needed|required|necessary)\.?$/i`) verbatim. The patterns are NOT widened; no widening is needed because the phrase is unchanged. Any future rewording must re-run the C4 check (a guard test makes that structural — §Test plan T6).
- **⚠ Deliberate deviation from the ticket's `"(no response)"` literal:** the C3-byte-intact round-1 terminal slot (`dispatchToAgent`:1020–1023) already instructs `respond with "No response needed."` and this ticket may not edit it (C3: contract byte-intact). Two different canonical decline phrases in one prompt would be incoherent; `"No response needed."` is kept as the single escape. `"(no response)"` remains pattern-matched (`NON_RESPONSE_PATTERNS[1]`) as drift tolerance, exactly as today.
- **C10:** "already in this prompt and your session context" is the covering-invariant phrasing — true in full mode (prompt carries the transcript) and delta mode (prompt delta ∪ resumed session covers the thread). The preamble never claims the full transcript is in the prompt.
- **Ordering:** the two anti-re-orientation rules are promoted to the top — they are the behavioral payload; the KPR-387-era rules survive verbatim below them.
- Applies to **both rounds** (the preamble is shared) — round-0 primaries also stop re-fetching a transcript they were just handed. This is a prompt-text change, not spawn shaping, so it does not violate "round-0 untouched" (which is a resources/shaping guarantee); the C6 pin update makes it deliberate and visible.

**Pin updates (both deliberate, this ticket only — C6):**
1. C6 round-0 byte pin — `dispatcher-conference.test.ts:501–510` `expectedPreamble` → new literal.
2. C10 delta-shape pin — the `PREAMBLE` helper at `:516–523` (feeds the delta pin at :585–587 and the empty-delta pin at :941) → new literal.

Grep for any other embedding of the old preamble text before merge (the reviewer-pin section :947+ reuses the helpers, so it updates for free).

### D5. Round-1 kill suppression (dispatcher)

⚠ Small addition implied by the clamps: today a timed-out/aborted turn delivers `_No response._` (`workResult.text = runResult.text || "_No response._"`). With a 120s reaction deadline, kills get more frequent, and a killed *reaction* posting filler into the meeting is exactly the noise this epic is removing. In `dispatchToAgent`, after the outage gates and mark bookkeeping (which already skip error/aborted turns — placement per C12/KPR-388 unchanged):

```ts
// KPR-389: a killed reaction is silent — never post filler into the meeting.
if (resolved.conferenceRound === 1 && (runResult.aborted || runResult.timedOut || (runResult.error && !runResult.text.trim()))) {
  log.info("Round-1 reaction suppressed (killed/errored)", { agentId, aborted: runResult.aborted, timedOut: runResult.timedOut, error: runResult.error?.slice(0, 120) });
  return;
}
```

Scope-guarded: keys on `resolved.conferenceRound === 1` (in-memory `ResolvedAgent`, never replay items — a replayed reaction resolves without conference fields and keeps KPR-307's replay failure handling untouched, §E4). Round-0 and normal turns keep today's delivery behavior. An errored reaction *with* text still delivers (it may be a real answer with a trailing warning — exit-code-1 convention).

**Placement / `recordTurnSuccess`:** the guard sits after the outage gates and mark bookkeeping and before the `isNonResponse` branch — its early return therefore also skips `recordTurnSuccess` (dispatcher.ts:1127) for an aborted-without-error reaction. **Intended:** a killed turn is not evidence of provider recovery; the KPR-307 outage episode ends on the next genuinely successful turn. Replay `done` resolution is unaffected — replays never reach this guard (they take the single-dispatch path, covered by D5b).

**Suppression outcome made queryable by round:** the existing `Non-response suppressed (fan-out)` log line (dispatcher.ts:1089) — which today logs only `{ agentId }` and fires for round-0 declines too — gains `conferenceRound: resolved.conferenceRound` (a number, redaction-safe: no message text). This is the discriminator the §C5 trigger counts against.

### D5b. Single-dispatch leg — replayed killed reactions

Goal 5 has a second reachable path: outage mid-meeting → reaction queued → replayed with caps intact (§E4) → killed again. The replayed item flows down `dispatch()`'s single-dispatch branch (never `dispatchToAgent`'s conference branch), where a timedOut+aborted, no-error, empty-text result with the breaker closed falls into the else-branch and delivers the `"_No response._"` filler (dispatcher.ts:336) before `recordTurnSuccess` resolves the doc `done` (:374). Fix: suppress **delivery only** on that leg — deliberately NOT an early return, because `recordTurnSuccess` is precisely what resolves the replayed doc `done` there (skipping it would burn replay attempts re-killing the same reaction until the attempt cap):

```ts
// KPR-389 D5b: single-dispatch leg of the round-1 kill suppression —
// reachable only by replayed reactions (live conference turns always route
// via dispatchToAgent). Discriminator is the meta (replay `resolved` carries
// no conference fields). Delivery-only suppression: recordTurnSuccess below
// still runs, so replay → done resolution is unharmed.
const killedReaction =
  conferenceRoundOf(item) === 1 && (runResult.aborted || runResult.timedOut) && !runResult.text.trim();

if (isNonResponse) {
  … existing branch, log gains conferenceRound: conferenceRoundOf(item) …
} else if (killedReaction) {
  log.info("Round-1 reaction suppressed on replay (killed)", { agentId, aborted: runResult.aborted, timedOut: runResult.timedOut });
} else {
  … existing delivery block, unchanged …
}
// recordTurnSuccess (:374) unchanged — runs for !error turns, resolving replay → done.
```

No error-arm here (unlike D5's fan-out guard): an errored replay already resolved via `resolveReplayRealFailure` (:318–321) before this point. The single-dispatch `Non-response suppressed` log line (:327) gains the same `conferenceRound: conferenceRoundOf(item)` field so the C5 suppression numerator doesn't read low across outage windows (advisory fold-in).

### D6. Telemetry stamping

**`recordSpawnObservability`** gains a fourth parameter, threaded from `spawnTurn` (the same value `finalizeSpawnResult` receives — C7):

```ts
this.recordSpawnObservability(effectiveCtx, shaping, finalResult, !!finalAttemptSessionId);
```

**`TurnTelemetryDoc` / `TurnTelemetryInput`** (turn-telemetry.ts) gain optional fields — all additive, `hitRatesByAgent` and its index untouched, 14-day TTL bounds the growth:

```ts
// KPR-389: turn-kind + perf split for conference before/after measurement.
conferenceRound?: number;            // 0 | 1; absent on non-conference turns
injectionMode?: "full" | "delta";    // KPR-388 injection mode, from meta
resumedSession?: boolean;            // C7 — finalized attempt launched with a handle
durationMs?: number;
llmMs?: number;
toolMs?: number;
toolCalls?: number;
effort?: string;                     // delivered effortOverride ("low" pin visible)
```

Record-site addition (inside the existing `result.sessionId && !result.aborted` gate):

```ts
const confRound = conferenceRoundOf(item);
this.turnTelemetryStore.record({
  …existing fields…,
  durationMs: result.durationMs, llmMs: result.llmMs, toolMs: result.toolMs, toolCalls: result.toolCalls,
  ...(shaping.effortOverride ? { effort: shaping.effortOverride } : {}),
  resumedSession,
  ...(confRound !== undefined ? { conferenceRound: confRound } : {}),
  ...(conferenceInjectionModeOf(item) ? { injectionMode: conferenceInjectionModeOf(item) } : {}),
});
```

**`ActivityRecord`** (activity/types.ts) gains `conferenceRound?: number`, stamped at the existing `activityLogger.record` site. Rationale: turn telemetry skips aborted turns (`!result.aborted` gate), so clamp-killed reactions would be invisible there; the activity log records every finalized turn, keeping kill counts and error rates measurable. No other activity fields added (it already carries `durationMs`/`toolCalls`/`toolSummary`/`error`).

**Measurement plan (what before/after looks like):** with KPR-387's fix already deployed (before-data exists in logs), one TTL window of post-deploy data answers: p50/p95 `durationMs` and `toolMs/durationMs` ratio for `conferenceRound: 1` vs `0`; suppression outcome via the round-tagged suppression logs (D5 fan-out + D5b single-dispatch — both legs carry `conferenceRound`, so the numerator doesn't read low across outage windows); kill counts via the activity log; `injectionMode`/`resumedSession` segmentation for KPR-388 efficacy; round-1 vs round-0 volume via the activity log's `conferenceRound` — turn telemetry undercounts round-1 because the `!aborted` gate drops killed reactions (feeds C5, below).

## C5 disposition — lone-peer force-select

**Mechanism (verified):** `classifyMeetingMessage` short-circuits `roster.length === 1` to select that member with no model call (meeting-classifier.ts:111–114). In the reaction pass, the "roster" is the unclaimed-peer list — so in any 2-agent meeting (or whenever exactly one peer remains unclaimed), every round-0 response **force-triggers** the sole peer's reaction turn, classifier never consulted. This is the highest-incidence source of the wasteful reactions this ticket cheapens.

**Decision: keep the shortcut; measure; tune in a follow-up on trigger.** Rationale: (a) this ticket makes the forced reaction cheap — low effort, ≤6 turns, ≤120s, preamble-driven immediate decline — collapsing the marginal cost of a wrong force-select from ~1–2.5 min of tool churn to seconds; (b) replacing the shortcut with a classifier call adds a sidecar call per round-0 response in exactly the small-meeting case where it's most frequent, and the right damper (classifier-always vs suppression-history vs round-1-only removal) is a judgment call that deserves data; (c) the KPR-387 pre-PR note dispositioned this to KPR-389 *as tuning input*, not as a mandated change.

**Explicit trigger for the follow-up ticket:** after ≥7 days of post-deploy telemetry, file a follow-up to route the *reaction pass only* through the classifier (dropping the `length === 1` shortcut for that call site, keeping round-0/DM semantics) if EITHER: round-1 turn volume exceeds round-0 volume for any instance (reaction inflation — query `activity_log` grouped by its new `conferenceRound` field; turn telemetry is not the volume counter because its `!aborted` gate drops killed reactions), OR >50% of round-1 turns end suppressed (count suppression log lines carrying `conferenceRound: 1` — the field D5 adds to the fan-out line and D5b adds to the single-dispatch line, so replayed declines across outage windows count too — against round-1 volume from `activity_log`). If neither fires, the shortcut stands and C5 closes with this spec as its record.

## Integration points

- `src/channels/dispatcher.ts` — `dispatchToAgent`: meta stamp gains `conferenceInjectionMode`; new round-1 kill-suppression guard + `conferenceRound` on the `Non-response suppressed (fan-out)` log line (D5). `dispatch()` single-dispatch branch: delivery-only kill suppression for replayed reactions + `conferenceRound` on the `Non-response suppressed` log line (D5b). `buildMeetingPreamble`: new literal (D4). Nothing else — `resolveConferenceAgents` / `triggerConferenceReactions` / `buildConferenceContext` / tracker / mark bookkeeping untouched (C1/C2/C12/C13).
- `src/agents/agent-manager.ts` — `conferenceRoundOf` / `conferenceInjectionModeOf` helpers; `TurnContext.conferenceRound`; `runWorkItemTurn` sets it; `prepareSpawn` round-1 branch + `shapeReactionTurn` + the two constants; `recordSpawnObservability` signature + stamping; `spawnTurn` call-site arg.
- `src/agents/turn-telemetry.ts` — additive optional fields on `TurnTelemetryDoc`/`TurnTelemetryInput`.
- `src/activity/types.ts` — `ActivityRecord.conferenceRound?`.
- `src/channels/dispatcher-conference.test.ts` — C6 + C10 pin updates (deliberate), new guards.
- `src/agents/agent-manager.test.ts` — round-1 shaping tests.
- Untouched: model-router.ts, all provider adapters, session-store, outage machinery, `AgentRunner`, meeting-classifier, `docs/providers.md` (no provider *behavior* contract changes — effort/limits are existing per-turn channels; reviewer should confirm this reading).

## Edge cases

- **E1 Round-0 / non-conference:** untouched by construction (D3); negatively pinned (T2).
- **E2 Delegate Task subagents inside a reaction:** claude lane — a Task call is one tool use in the parent loop; the SDK sub-session runs within the parent's 120s wall clock. Lane B — the KPR-354 nested runner keeps its own `{7|10, 600s}` limits, but the parent's clamped deadline abort-chains into the nested turn via `call.signal` (verified agent-manager.ts:718–724), so the 120s wall clock effectively bounds delegates too. A reaction that truly needs a delegate will likely be killed — accepted: reactions should not delegate, the preamble discourages tool use, and the kill is silent (D5).
- **E3 Voice / scheduler / cron / reflection / team / event one-shots:** none carry conference meta ⇒ `conferenceRound` undefined ⇒ zero change. Voice additionally returns at the carve-out before the branch.
- **E4 Outage replay (C12 — verified):** queued doc holds the shaped `effectiveItem` (conference meta + baked prompt). Replay pins `targetAgentId` ⇒ resolveAgents step 0 ⇒ bare `ResolvedAgent` ⇒ single-dispatch path: no re-injection, no tracker writes, no mark bookkeeping (C12 placement intact). `prepareSpawn` still sees `meta.conferenceRound = 1` ⇒ reaction caps apply on replay — deliberate (same prompt, same kind). D5's fan-out guard does NOT fire for replays (`resolved.conferenceRound` is undefined there); a replayed reaction killed *again* by the caps is suppressed by the single-dispatch leg (D5b, meta-discriminated) with `recordTurnSuccess` intact — errored replay failures keep KPR-307 semantics via `resolveReplayRealFailure`. Nit for future pins: the replayed item's `text` is `replayWrap`'d (outage-replay-processor.ts:102–103 — prompt-note wrapper; the queued doc keeps the original shaped text), so a test pinning replayed conference text must expect the wrapper, not the bare shaped prompt.
- **E5 C1 all-roster fallback interaction:** the *meeting* classifier's failure fallback selects all roster members. Round-0: all recorded at selection time ⇒ zero reactions (C1 stands, unaffected). Reaction pass: a fallback selects ALL unclaimed peers ⇒ a reaction storm — previously N full work turns, now N capped low-effort turns; this ticket bounds C1's worst case rather than changing it. The *effort* classifier (`routeModel`) is a different classifier: round-1 never calls it at all, so no interaction exists; its own fallback paths remain reachable only from round-0/non-conference turns.
- **E6 Per-thread lock:** reactions still serialize behind same-agent turns on `agentId:threadId`; the caps shrink the hold from minutes to ≤120s. Residual self-blocking is the staleness-culling trigger (Non-goals).
- **E7 Haiku / effort-incapable claude agents:** no effort pin (undeliverable, same as today); caps still clamp (haiku base 20/120s ⇒ 6/120s).
- **E8 KPR-313 provider handoff on a reaction:** handoff prepend happens before the round-1 branch (prompt already assembled) — annotation + reaction shaping compose; the handoff notice is inside the shaped prompt exactly as for any turn.
- **E9 Agent deleted mid-turn:** `shapeReactionTurn`'s `!agentConfig` guard mirrors the existing degenerate-route idiom — flows on, fails inside the recorded try, breaker unwedged (KPR-306 hazard respected).
- **E10 Malformed meta** (string `"1"`, negative, injected via replayed legacy docs): typed helper returns undefined ⇒ full-resource turn — fail-open to today's behavior, never a crash.

## Test plan

Conventions: negative-verify per repo rule (revert the source change → confirm the new test fails on pre-fix code) for T1/T3/T4; byte pins updated deliberately with KPR-389 comments.

- **T1 (shaping, claude lane):** agent-manager.test harness — a work item with `meta.conferenceRound: 1` on a claude effort-capable agent reaches `adapter.runTurn` with `effort: "low"`, `resourceLimits: { maxTurns: 6, timeoutMs: 120_000, budgetUsd: <tier> }` (opus-tier agent), and a `routeModel` spy records **zero** calls. Negative-verify: with the branch reverted, effort is classifier-driven and limits are tier defaults.
- **T2 (round-0 untouched, negative pin):** same harness, `conferenceRound: 0` — `routeModel` IS called (effort-capable claude agent), `resourceLimits` deep-equals the static-tier value, effort equals the classifier's output. Plus a non-conference item control.
- **T3 (Lane B):** codex/openai-routed agent, round 1 — `resourceLimits.maxTurns === min(agentDef.maxTurns, 6)`, `timeoutMs === min(agentDef.timeoutMs ?? 300_000, 120_000)`, `effort` undefined; round 0 — the existing Lane B branch values byte-identical.
- **T4 (Lane A):** grok-routed agent with `:high` suffix, round 1 — `effort: "low"` (pin overrides suffix), clamped limits object present; round 0 — `effort: "high"` (clamped suffix, today's path), `resourceLimits` undefined.
- **T5 (pins, deliberate):** update the C6 round-0 byte pin and the C10 `PREAMBLE` helper to the D4 literal; both suites green. The delta-mode pin (:585) and empty-delta pin (:941) update transitively via the helper — assert they still pin the full join shape.
- **T6 (C4 guard):** extract every double-quoted phrase from `buildMeetingPreamble("x", [jasper])` output and assert at least one matches `NON_RESPONSE_PATTERNS` — makes the C4 check structural against future rewording (widen-or-match enforced by test failure).
- **T7 (telemetry):** conference round-1 turn ⇒ `turnTelemetryStore.record` receives `conferenceRound: 1`, `injectionMode`, `resumedSession`, `durationMs`/`llmMs`/`toolMs`/`toolCalls`, `effort: "low"`; plain DM turn ⇒ conference fields absent, perf fields present. Activity record carries `conferenceRound`.
- **T8 (kill suppression, fan-out leg):** round-1 resolved agent whose turn returns `aborted: true` (and a `timedOut: true` variant) ⇒ no `deliver` call, mark untouched; round-0 aborted turn keeps today's delivery behavior (control).
- **T8b (kill suppression, single-dispatch leg):** item with `meta: { conferenceRound: 1, targetAgentId, outageReplay: true }` whose turn returns timedOut+aborted, no error, empty text ⇒ no `deliver` call (no `"_No response._"` filler) AND `recordTurnSuccess` still runs (replay doc resolves `done` — assert the release/`done` path). Control: same item returning real text delivers normally.
- **T9 (replay shaping):** item with `meta: { conferenceRound: 1, targetAgentId, outageReplay: true }` dispatches via the pinned-agent path and still receives reaction shaping (unit via `conferenceRoundOf` + a `runWorkItemTurn`-level assertion); the fan-out guard (D5) does not fire (replay `resolved` has no conference fields) — killed replays are covered by D5b/T8b.
- **T10 (helper):** `conferenceRoundOf` table test — `0`/`1`/`"1"`/`2`/`undefined`/missing meta.

## Canon compliance

- **C1/C2:** selection-time recording and tracker shape untouched — this spec adds no tracker reads/writes. E5 documents the all-roster interaction.
- **C3:** round-1 terminal slot (`reactionTo` framing text) byte-intact; `meta.conferenceRound` used as the discriminator exactly as licensed.
- **C4:** escape phrase preserved verbatim; T6 makes the match structural.
- **C5:** dispositioned explicitly (measure-first with a two-condition trigger) — see §C5.
- **C6/C10:** both preamble-bearing pins updated deliberately, in this ticket only, as a spec-level decision (D4), not a test fix.
- **C7:** `resumedSession` consumed for telemetry via the same `finalAttemptSessionId` source as `finalizeSpawnResult`.
- **C9/C10:** preamble language written to the covering invariant — true in full and delta modes.
- **C12:** mark bookkeeping placement untouched; replay verified to skip conference resolve while preserving meta (E4).
- **C13:** KPR-390's anchor site (`buildConferenceContext` full arm) untouched.
