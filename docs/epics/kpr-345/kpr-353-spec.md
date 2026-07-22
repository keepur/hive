# KPR-353 — Codex replication: tool bridge on the subscription surface, stateless-replay history, documented

**Child 8 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D6 (this child's design section — "Codex: honest statelessness"), §D4 (the bridge this child binds), §D3 (session-semantics descriptor — value untouched here).
**Shape:** pattern replication (KPR-348's bridge + KPR-349's assembly, bound to the codex surface) **plus** the one net-new piece the pattern can't supply: hive-persisted turn history replayed client-side.
**Depends on:** KPR-347, KPR-348, KPR-349 — all merged in this baseline (@ 08bf962). **KPR-350 is filed as a dependency and ruled NOT load-bearing in §R below** (HUMAN_DIRECTIVE, May 2026-07-21) — this child sequences directly after KPR-349.
**Informs:** KPR-351 (subscription-first live validation runs on THIS surface — keepur/Luna — once this lands, per the 2026-07-21 directive), KPR-352 (gemini replicates the same flip shape), KPR-355 (matrix row facts collected here), KPR-350 (types.ts comment correction hands the codex-replay projection back — §R3).
**Decision-register canon honored:** codex ≡ openai at every classify site (no `tool-transport.ts` changes needed — already test-pinned); `SESSION_SEMANTICS` values untouched (codex stays `stateless-replay`); **bridge bound, not redesigned** — `BridgedTool[]` consumed as-is, zero `tool-bridge.ts` edits; `TOOL_EXECUTING_PROVIDERS` grows `codex` **in the same commit** as the adapter's stub flip; assembly stays provider-blind (`toolsExecutable: boolean`, never a provider id); auth-split canon (subscription OAuth → chatgpt.com backend, not api.openai.com) drives §D5.
**Provider-surface evidence:** the KPR-348 spike (kpr-348-spike-notes.md:204-215, 258-263, 292) proved live that the codex subscription token 401s against `api.openai.com` Responses and that the working path is the adapter's own `https://chatgpt.com/backend-api/codex/responses` POST. Unlike the openai lane's credential gap, **this surface has a live fleet credential** (`~/.codex/auth.json` PRESENT) — the plan's step-0 spike runs real turns.

## TL;DR

Make `codex/…` turns execute real hive tools and carry honest thread continuity. Tools: bind KPR-348's provider-neutral `BridgedTool[]` to Responses-schema function tools in the existing raw-fetch adapter and run a bounded hive-owned dispatch loop (execute `function_call` items via the bridged `execute`, append `function_call_output` items, re-POST) — flipping `tools: []` (`codex-subscription-adapter.ts:93`) and adding `codex` to `TOOL_EXECUTING_PROVIDERS` in the same commit, which lights up toolkit/skills/memory-tool-claims in its instructions with zero assembly changes. Continuity: subscription OAuth hard-enforces `store: false`, so there is no server handle to persist — a new Mongo-backed `TurnHistoryStore` keeps each thread's Responses input items (assistant output **including encrypted reasoning items**, tool-call/output pairs) and the adapter replays them client-side on the next turn, trimmed whole-turns-oldest-first under a byte budget, cleared on KPR-313 provider handoff. `SESSION_SEMANTICS.codex` stays `stateless-replay` — the matrix label is the truth, now with a working implementation behind it. Auth stays single-path codex OAuth: no `runWithAuthFallback` analog (§D5 ruling — an API key cannot authenticate against the chatgpt.com backend, and the fleet is subscription-first by directive).

## Key Points

- **§R ruling (the directive's central question): KPR-350 is not load-bearing for this child.** Every mechanism KPR-350 builds is OpenAI-server-side (Conversations API / `previous_response_id`, descriptor wiring for a *resumable* provider); codex's surface has no server-side resume by construction and its replay machinery is net-new hive persistence with zero shared code. KPR-353 slots directly after KPR-349. Full argument + the one stale artifact it supersedes in §R.
- **Replication means binding, and the binding is small.** The bridge core, guardrail gate, builtin executor, skill index, and prompt assembly all arrive via `ProviderTurnAssembly` — already constructed for codex (`agent-manager.ts:514-521`). The adapter work is: construct `ToolBridge` (the openai adapter's exact pattern, `openai-agents-adapter.ts:54-68`), render `BridgedTool[]` as Responses `{type:"function", name, description, parameters, strict:false}` entries, and own the tool loop (the Agents SDK ran openai's loop; raw fetch means codex runs its own — §D2).
- **One flip, one commit, one review surface (canon):** `tools: []` → bridged tools AND `TOOL_EXECUTING_PROVIDERS` = `{openai}` → `{openai, "codex"}` (`turn-assembly.ts:94`) land together; the 347/349 pins that assert the old state (`codex-subscription-adapter.test.ts:274` "posts tools: []", `turn-assembly.test.ts:107-108,119-122`) are inverted in the same change. Gemini's pins stay.
- **History is hive's, bounded, and fail-soft in both directions.** `TurnHistoryStore` (new, beside `session-store.ts`): per-(agent, thread, provider) doc of turn records; read-failure ⇒ run the turn fresh with a warn (a Mongo blip must never surface "ECONNREFUSED" into `RunResult.error` where it would pattern-match connect-fail and trip the codex breaker — §D3); write-failure ⇒ warn and drop. Only successful, non-aborted turns persist. Trim = whole turns, oldest first, under a serialized-char budget constant (no config knob — simplicity canon).
- **Session plumbing is already correct and untouched:** `persistsResumableHandle(stateless-replay) === false` keeps writing `sessionId: ""` rows (`agent-manager.ts:1488`), the read side keeps scrubbing (`session-store.ts:107-154`), and the KPR-313 guard already covers codex transitions. This child adds exactly one manager-side line class: the guard's handoff branch also clears replay history (§D4) — stale pre-handoff history must not resurrect after a codex→claude→codex round trip.
- **Auth ruling (§D5):** codex keeps its single OAuth path (`createCodexOpenAITokenProvider`, endpoint pinned to the chatgpt.com backend). No API-key fallback is added — the spike proved the surfaces are disjoint, and the OPENAI_API_KEY posture is optional/deferred by directive. The openai adapter's own (doomed) codex-oauth attempt is out of scope here, flagged to KPR-350/351.
- **Poisoned-replay self-heal (§D7):** a 4xx on a request that replayed history (stale/foreign encrypted reasoning after a mid-thread model change) retries once fresh and clears the doc — one bounded reset instead of a permanently broken thread (the KPR-313 scrub philosophy, applied to replay).
- **Live evidence is finally cheap here:** the fleet holds a working codex subscription credential. Plan step 0 is a live spike — function-tool advertisement, `function_call` event shape over the backend's SSE, `include: ["reasoning.encrypted_content"]` acceptance, and next-request replay acceptance — before any dependent chunk. KPR-351 (Luna, keepur) then runs the production-grade validation on this same surface.
- ⚠ Delegated assumptions (§Open assumptions): the chatgpt.com backend's function-tool + encrypted-reasoning behavior is codex-CLI-proven in the wild but spike-verified here, not docs-guaranteed; replay token re-billing is a documented caveat (subscription quota, not dollars), not something this child optimizes.

## §R — Ruling: the KPR-350 dependency is not load-bearing

**Ruling: NO — KPR-353 does not depend on KPR-350. It sequences directly after KPR-349.**

The filed dependency came from the epic's "replicate the proven pattern" framing (children 7/8 depend on 3,4,5), which predates the KPR-348 auth-split discovery. Examined mechanism by mechanism against this baseline:

1. **KPR-350's scope is OpenAI-server-side resume.** Its three deliverables — pick Conversations API vs `previous_response_id` chaining, wire the chosen ref through session persistence, extend the KPR-313 guard where needed — all operate on `api.openai.com` server state. Codex has **no server-side resume to wire**: `store: false` is hard-enforced on the subscription surface (epic §D6, spike-confirmed), so there is no ref to persist, no descriptor value to change, no Conversations analog. The "pattern" KPR-353 replicates is 348's *bridge*, not 350's *resume* — and the bridge is merged.
2. **The session plumbing codex needs already shipped in KPR-347/KPR-313.** `SESSION_SEMANTICS.codex = "stateless-replay"` (`types.ts:64`) with `persistsResumableHandle` false drives both the write side (empty-`sessionId` row, `agent-manager.ts:1470,1488`) and the read side (`session-store.ts:116-122` normalizes to no-handle; `:42` scrubs legacy `codex-pilot-` ids). The KPR-313 transition guard (`agent-manager.ts:704-723`) is provider-generic over the union and already fires on codex↔anything transitions. Nothing KPR-350 adds touches this.
3. **The auth surfaces are provably disjoint** (kpr-348-spike-notes.md:204-215, 292): the codex subscription token 401s against `api.openai.com` Responses; KPR-350's Conversations/`previous_response_id` work happens entirely on that surface with a Responses-capable credential the fleet doesn't even hold yet. No credential, endpoint, or wiring KPR-350 produces transfers to `chatgpt.com/backend-api/codex`.
4. **The replay store is net-new and codex-owned.** KPR-350 builds no client-replay machinery — that's the *opposite* of its job (OpenAI resumes server-side precisely so the client doesn't replay). The `TurnHistoryStore` (§D3) shares no code path with anything in 350's scope.
5. **File-collision risk between the reordered children is negligible:** 350 will touch `openai-agents-adapter.ts` session fields and possibly `SESSION_SEMANTICS.openai`'s value; 353 touches the codex adapter, one set literal in `turn-assembly.ts`, one comment in `types.ts`, and net-new files.

**The one artifact that encoded the old assumption — superseded here:** the `SESSION_SEMANTICS` doc comment at `types.ts:43` says "codex gains replay in KPR-350." That was a KPR-347-era projection written before the auth split was understood. This child corrects the comment (replay = KPR-353; the *value* `stateless-replay` is untouched, per canon) in the same PR — so KPR-350's spec drafter inherits a truthful baseline and doesn't double-build codex replay.

**Consequence (the directive's payoff):** KPR-353 is implementable now; KPR-351's subscription-first live validation (Luna on keepur, per May's 2026-07-21 directive) unblocks on this child alone, without waiting for a Responses-capable OpenAI credential or the Conversations decision.

## Problem

Post-347/348/349 the codex adapter is the best-instrumented dead end in the fleet: it receives a full `ProviderTurnAssembly` (real inventory, gate, in-process server instances, skill index, memory bundle) and posts `tools: []` (`codex-subscription-adapter.ts:90-93`), gets honesty-gated instructions with no toolkit/skills (`turn-assembly.ts:94,152` — codex ∉ `TOOL_EXECUTING_PROVIDERS`), and fabricates a per-turn session id that the store correctly refuses to persist — so every turn is amnesiac. Three gaps: no tool execution, no thread continuity, and a stale cross-reference (`types.ts:43`) pointing continuity work at the wrong child.

## Goals

- G1: `codex/…` turns execute every bridgeable tool class through the KPR-348 bridge — same `BridgedTool[]`, same gate, same containment — via a bounded adapter-owned Responses tool loop.
- G2: `TOOL_EXECUTING_PROVIDERS` grows `codex` in the flip commit; codex instructions gain toolkit/file-tier-guidance/skills and the memory block's tool-instruction lines with zero assembly-code changes (KPR-349's gate does the work).
- G3: Thread continuity via hive-persisted history: assistant output items **including encrypted reasoning** and tool-call/output pairs replayed client-side; `store: false` posted always; no resumable handle ever persisted.
- G4: History lifecycle is safe: bounded (whole-turn trim under a byte budget), fail-soft on read and write (no Mongo error strings reachable by the fault classifier), persisted only for successful non-aborted turns, cleared on KPR-313 provider handoff, TTL-reaped.
- G5: Honest telemetry: `toolCalls`/`toolMs`/`toolSummary` from `bridge.stats`; `llmMs = durationMs − toolMs` (the breaker's p95 window must not eat tool time — 348 §D8 rule); usage summed across loop rounds.
- G6: Auth ruled and documented: single OAuth path, no API-key fallback; matrix row facts recorded for child 10.

## Non-goals

- Gemini anything — KPR-352 (its zero-tools stub, its `TOOL_EXECUTING_PROVIDERS` line, its Interactions-based exit from `stateless-replay`).
- `SESSION_SEMANTICS` **value** changes — codex stays `stateless-replay` (canon; it is the truthful label for this surface permanently, not transitionally).
- OpenAI adapter changes — including its codex-oauth fallback attempt (`openai-agents-adapter.ts:190-215`), which the spike proved 401s. Flagged to KPR-350/351 (it's openai-lane auth surface); not touched here.
- Bridge internals (`tool-bridge.ts`), builtin executor, gate, prompt builder — consumed as-is, zero edits (canon: bind, don't redesign).
- Subagent parity (Task) — child 9; `claude-subagent` entries stay partition-omitted.
- History summarization/compression, cross-provider history migration (epic ruling: fresh session + KPR-313 annotation is the bridge), per-thread/config replay knobs (constants only), provider-side prompt-cache tuning.
- Parity matrix document itself — child 10 (this spec's §D8 lists the row facts).
- The pre-existing missing-OAuth classification (`error-classification.ts:79` maps "OAuth session is not available" → `auth`, a hard fault) — pre-existing, deliberate KPR-306 posture, unchanged (an un-logged-in codex fast-fails into the honest-outage path, which is operationally right even when the root cause is config; noted for the matrix).

## Design

### D1 — Tool advertisement: `BridgedTool[]` → Responses function tools

`runTurn()` constructs the bridge exactly as the openai adapter does (`openai-agents-adapter.ts:54-68`): per-spawn, from `assembly.{toolInventory, inProcessServers, guardrailGate, skillIndex, sessionCwd}` + the turn's `workItemContext` + the adapter's abort signal; `connect()` inside the try (fail-soft per server, an all-failed bridge yields `[]` and the turn runs tool-less); `close()` in the `finally`. The last-mile binding replaces the SDK `tool()` call with payload JSON:

```ts
tools: bridged.map((bt) => ({
  type: "function",
  name: bt.name,                 // Claude-lane-identical: mcp__<server>__<tool>, Bash, Read, … (348 canon)
  description: bt.description,
  parameters: bt.inputSchema,     // bridge-normalized JSON schema
  strict: false,
}))
```

The 347 flip-comment block at `codex-subscription-adapter.ts:90-93` is deleted. Name/cap edges (sanitization, 128-cap with the KPR-349 pinned tier) are bridge-owned already — nothing to re-implement.

**Same commit (canon):** `TOOL_EXECUTING_PROVIDERS` → `new Set(["openai", "codex"])` (`turn-assembly.ts:94`), pin update at `turn-assembly.test.ts:107-108` (which itself documents "352/353 grow it"), inversion of the `toolsExecutable false for codex` pin (`:119-122`) and the adapter's `tools: []` pin (`codex-subscription-adapter.test.ts:274-293`). Codex instructions immediately carry toolkit/skills/file-tier guidance and the memory block's `memory_recall`/"memory MCP server" lines — KPR-349 §D3/§D5 built the gate so this child's flip is one set literal; the builder still never sees a provider id.

### D2 — The dispatch loop (hive-owned, bounded)

The Agents SDK ran openai's loop; raw fetch means the codex adapter owns its own — the Responses function-calling round-trip, kept deliberately minimal:

```
inputItems = [...replayedHistory, userMessageItem]          // §D3; history [] on first turn
for round in 1..maxRounds:
    POST { model, instructions, reasoning, input: inputItems, stream: true, store: false,
           include: ["reasoning.encrypted_content"], tools }
    state = consumeCodexSse(...)                             // extended: captures response.output items
    inputItems.push(...state.outputItems)                    // messages, reasoning (encrypted), function_calls
    calls = state.outputItems.filter(type === "function_call")
    if calls.empty: break                                    // final round — state.text is the reply
    for each call:                                           // sequential; bridge tools are not
        out = await bridgedByName[call.name].execute(parseArgs(call.arguments))   //   concurrency-hardened
        inputItems.push({ type: "function_call_output", call_id: call.call_id, output: out })
persistHistory(thisTurnItems)                                // §D3; success only
```

- **SSE consumer extension:** `applyResponsePayload` (`codex-subscription-adapter.ts:333-342`) additionally captures `response.output` from the `response.completed` payload into `state.outputItems` (the full item array — message, reasoning-with-`encrypted_content`, `function_call`). Text deltas keep streaming to `onStream` across all rounds (intermediate think-aloud text streams like the openai lane's).
- **Containment is inherited, with two loop-local additions:** `BridgedTool.execute` never throws (348 §D3). The loop adds: unknown `call.name` (model hallucinated a tool) → a `function_call_output` with structured error text, not a throw; unparseable `call.arguments` JSON → same. Nothing in the loop can escape `runTurn` as a throw.
- **Bound:** `maxRounds = request.resourceLimits?.maxTurns ?? 10` (mirrors the openai adapter's SDK default when `resourceLimits` is absent). Exhaustion sets `RunResult.error = "error_max_turns"` — deliberately the SDK sentinel string, already pinned `non-provider` (`error-classification.ts:57`); no history persist.
- **Usage accumulation:** input/output/cache-read tokens **summed across rounds** (`applyResponsePayload` currently overwrites; becomes additive per completed response). `costUsd` stays 0 (subscription).
- **Abort:** the existing controller aborts the in-flight fetch; the loop additionally checks `this.aborted` between rounds and between tool executions; the bridge already holds the signal. Aborted result via the existing path; `bridge.close()` in the `finally`; no persist.

### D3 — Stateless-replay history: `TurnHistoryStore`

New `src/agents/turn-history-store.ts` (beside `session-store.ts`, same `withRetry` fail-soft idiom), collection **`provider_turn_history`**:

```ts
interface TurnHistoryDoc {
  _id: string;                    // "{agentId}:{threadId}:{provider}"
  agentId: string; threadId: string; provider: AgentProviderId;
  turns: { at: Date; items: unknown[] }[];   // items = opaque Responses input items, verbatim
  updatedAt: Date;
}
```

- **API:** `load(agentId, threadId, provider): Promise<unknown[]>` (flattened turn items, oldest-first; `[]` on miss **or on any Mongo failure** — warn-and-continue), `append(agentId, threadId, provider, items): Promise<void>` (push one turn record + trim; fail-soft void), `clear(agentId, threadId): Promise<void>` (all providers for the thread — provider-agnostic so the KPR-313 hook stays generic; catch-swallowed at the call site). Items are stored verbatim and opaque — hive never introspects reasoning content; `encrypted_content` is provider-opaque ciphertext by design (nothing readable enters Mongo beyond what `sessions`-class storage already holds).
- **What a turn record holds:** the user message item + every output item from every round (assistant messages, **reasoning items with `encrypted_content`** — the ticket's headline requirement, required for model quality on replayed multi-round turns) + the `function_call_output` items hive appended. Replay = exact re-post, which is what the Responses stateless contract expects (and what the codex CLI itself does with its rollouts).
- **Trim (constants, not config):** whole turns dropped oldest-first while `JSON.stringify(turns).length > HISTORY_CHAR_BUDGET = 200_000` (~50k tokens replayed worst-case; re-billed against subscription quota each turn — documented matrix caveat, mitigated by the backend's prompt caching, whose hits the adapter already surfaces via `cacheReadTokens`). Whole-turn granularity keeps `function_call`/`function_call_output` pairs and their reasoning items intact — a split pair is a malformed replay.
- **Persist policy:** success only — `error` or `aborted` turns never persist (an errored turn's item may be re-delivered by the retry/outage path; persisting it would duplicate the user message on replay). TTL index on `updatedAt`, 7 days — deliberately identical to `sessions` so a thread's continuity artifacts age out together.
- **Breaker-safety invariant (the fail-soft's real reason):** history I/O runs inside `runTurn`, *outside* the `TurnAssemblyError` boundary — so a raw Mongo throw reaching the adapter's catch would put "connect ECONNREFUSED" into `RunResult.error`, pattern-match `connect-fail` (`error-classification.ts:74`), and count toward the **codex** breaker's trip streak. Therefore the store's methods never throw and never return Mongo error text; degradation is logged, invisible to classification (contract-tested, T3).
- **Wiring:** instantiated beside `SessionStore` and injected through `AgentManager`'s constructor (the existing store pattern, `agent-manager.ts:364,416,428`); `init()` creates the TTL + `{agentId, threadId}` indexes; passed to `CodexSubscriptionAdapter` via new optional options `historyStore?`, `agentId?` (`config.id` — the options' existing `name` is the display name and stays logging-only). Thread key from `request.workItemContext.threadId`; absent context (bare test constructions, hypothetical direct spawns) ⇒ replay and persist both skip. Docs rider: CLAUDE.md's engine-written-collections list gains `provider_turn_history`.

### D4 — Session-identity interplay (KPR-313): one hook, nothing re-derived

- `SESSION_SEMANTICS`, `persistsResumableHandle`, write-side scrubbing (`agent-manager.ts:1470,1488`), read-side normalization and `codex-pilot-` scrub (`session-store.ts:42,107-154`): **all untouched.** The codex `sessions` row keeps doing its two real jobs — thread→agent mapping and the transition guard's provider tag — with `sessionId: ""`.
- **The one addition:** the KPR-313 guard's handoff branch (`agent-manager.ts:713-722`) also fires `this.turnHistory.clear(ctx.agentId, ctx.threadId).catch(…)` — fire-and-forget, catch-swallowed (the same R7-window posture as the session store's lazy scrub, `session-store.ts:143-148`; no new throw surface inside the breaker window). Rationale: history validity is contiguous-same-provider by construction. After codex→claude, the thread's real context lives in claude turns the codex history never saw; on the claude→codex return the guard fires again and clears, so the codex turn starts fresh **with** the KPR-313 §3.4 handoff annotation (which `prepareSpawn` already prepends — provider-agnostic, nothing to add). Stale history can never coexist with a handoff.
- The adopt-branch (`agent-manager.ts:706-712` — a queued same-thread predecessor already switched providers) needs no hook: the predecessor's own guard trip already cleared.
- `result.sessionId` semantics unchanged (`responseId ?? codex-pilot-…`, never persisted) — continuity now lives in the history store, not the session handle, which is exactly what `stateless-replay` declares.

### D5 — Auth ruling: single-path OAuth, no fallback analog

**Ruling: the codex adapter keeps exactly its current auth path** — `createCodexOpenAITokenProvider` (`oauth-credentials.ts:39-56`) bearer against the pinned chatgpt.com backend — **and gains no `runWithAuthFallback` analog.**

- The openai adapter's fallback exists to bridge two credentials onto one endpoint (oauth-then-API-key against `api.openai.com`). Codex is the inverse: one credential, one endpoint, and the *other* credential class (an `OPENAI_API_KEY`) does not authenticate against `chatgpt.com/backend-api` at all — a fallback attempt would convert every real auth outage into two failed round-trips.
- Fleet posture seals it: subscription-first is the designed steady state (2026-07-21 directive: vendor `OPENAI_API_KEY` optional/deferred; KPR-351 validates on this surface with subscription auth).
- The **openai** adapter's codex-oauth *attempt* (`openai-agents-adapter.ts:193-204`) — spike-proven to 401 — is that lane's concern; recorded here as evidence, handed to KPR-350/351, untouched (non-goal).
- Missing/expired OAuth behavior is unchanged: pre-request throw message classifies `auth` (`error-classification.ts:79` names the exact string) → after three turns the codex breaker opens and the honest-outage machinery (KPR-307) takes over. Operator remediation is `codex login`; matrix-noted.

### D6 — Telemetry and result shape

`buildResult` (`codex-subscription-adapter.ts:180-220`) stops hardcoding the tool zeros: `toolCalls`/`toolMs`/`toolSummary` from `bridge.stats` (the openai adapter's exact rendering, `openai-agents-adapter.ts:256-262`), and **`llmMs = max(0, durationMs − toolMs)`** — the 348 §D8 breaker rule: the p95 latency window samples `llmMs`, and folding tool time in would let slow-but-healthy tools trip a healthy codex endpoint. Tokens summed per §D2. `streamed`/abort/error paths keep their shapes.

### D7 — Poisoned-replay self-heal

Replayed items can go stale in ways hive can't validate locally — the canonical case: the agent's codex *model* is changed mid-thread and the backend rejects another model's `encrypted_content` with a 4xx. Containment: **if the initial POST of a turn fails with a 4xx AND the request replayed non-empty history, retry once with history dropped and clear the doc** (log at warn). One retry, first round only, 4xx only (5xx/network are provider faults that must keep their classification and breaker weight — no retry, no clear). A non-replay 4xx never retries. This mirrors KPR-313's "one bounded reset beats an unbounded failure mode" scrub philosophy; without it, a poisoned thread 4xxs forever until TTL.

### D8 — Documentation riders (the ticket's "documented" half)

- `types.ts:43` comment correction per §R (value untouched).
- CLAUDE.md: `provider_turn_history` added to the engine-written-collections list; the provider-adapters overview paragraph's "pilots still advertise zero tools" claim updated (openai + codex now execute; gemini remains the zero-tools pilot until KPR-352).
- **Matrix row facts for child 10 (KPR-355):** tools = full (all four transport classes via the shared bridge; same builtin set and claude-only omissions as openai); memory/skills/guardrails = full (shared assembly + gate); resume = **`stateless-replay`** — client-side replay of hive-persisted history incl. encrypted reasoning, bounded window (~200k chars, whole-turn trim), 7-day TTL, replay re-bills tokens against subscription quota (offset by backend prompt caching); subagents = n/a until child 9; server-side tools = n/a; effort = static `:effort` suffix; auth = codex subscription OAuth only (`codex login`), outage classification includes local logged-out state.

## Integration points

| Seam | This ticket | Must NOT touch |
|---|---|---|
| `codex-subscription-adapter.ts` | bridge construction + Responses tool binding (§D1), dispatch loop + SSE output-item capture + usage summing (§D2), history replay/persist calls (§D3), self-heal retry (§D7), telemetry (§D6), options `historyStore?`/`agentId?` | endpoint/headers/`store:false` posture, OAuth path (§D5), SSE parser contract for existing event types, abort controller shape |
| `turn-assembly.ts` | one line: `TOOL_EXECUTING_PROVIDERS` += `"codex"` (§D1, flip commit) | everything else — builder stays provider-blind (canon) |
| new `turn-history-store.ts` | the store (§D3) | — |
| `agent-manager.ts` | inject `TurnHistoryStore`; pass `historyStore`/`agentId` in the codex branch (`:514-521`); handoff-branch `clear` (+`.catch`) (§D4) | guard logic/ordering (R7 window), `finalizeSpawnResult` persistence rules, breaker acquire/record, `resolveProviderModel` |
| `types.ts` | `:41` comment correction only (§R) | `SESSION_SEMANTICS` values, unions, `persistsResumableHandle` |
| `index.ts` (or manager ctor site) | construct + `init()` the store beside `SessionStore` | — |
| CLAUDE.md | §D8 riders | — |
| `tool-bridge.ts`, `builtin-executor.ts`, `prefix-builder.ts`, `agent-runner.ts`, `tool-transport.ts`, `session-store.ts`, `openai-agents-adapter.ts`, `gemini-adk-adapter.ts`, `oauth-credentials.ts` | **none** | everything (bind-don't-redesign; codex ≡ openai classify pins already hold) |

## Edge cases

- **First turn on a thread / history miss:** `input` = the user message alone — today's behavior, now upgraded from "always" to "first turn only."
- **History read failure:** fresh turn + warn; `RunResult.error` untouched by store internals (breaker-safety invariant, §D3); continuity degrades for one turn, delivery doesn't.
- **Model hallucinates a tool name / bad arguments JSON:** structured `function_call_output` error text; loop continues (§D2).
- **Gate deny:** denial text as the `function_call_output`; turn continues (PreToolUse parity — bridge behavior, inherited).
- **maxRounds exhausted:** `error_max_turns` (non-provider by existing pin), no persist.
- **Abort mid-loop:** aborted result, bridge closed, no persist; between-round and between-tool checks close the raw-fetch gaps the SDK loop didn't have.
- **Thread with no `workItemContext.threadId`:** stateless turn (no replay, no persist) — the pre-353 behavior as the floor.
- **Trim boundary:** a single turn larger than the whole budget (pathological tool output) keeps only that turn, trimmed last — never split mid-turn.
- **Provider round trip codex→claude→codex:** both transitions trip the guard; history cleared both times; the second codex era starts fresh with the handoff annotation (§D4).
- **Replayed encrypted reasoning rejected (4xx):** one fresh retry + clear (§D7); 5xx/network keep full breaker weight, no retry.
- **Reflection turns on a codex agent:** same path — replay in, persist out; reflection context accretes like any turn.
- **Codex not logged in:** unchanged pre-existing behavior — auth-classified fast-fails → breaker → honest outage; `codex login` recovers (§D5).

## Testing contract sketch

Vitest beside source; `npm run check` green. Negative-verify discipline per fleet standard (bug-fix/inversion tests demonstrably fail on pre-flip source).

- **T0 — live spike (plan step 0, credential present in fleet):** against the real subscription backend — one turn advertising a trivial function tool → `function_call` arrives in `response.completed` output; `include: ["reasoning.encrypted_content"]` accepted and items present; a second request replaying round-1 items + `function_call_output` accepted and coherent; recorded transcript. This is the assumption gate for §D2/§D3 shapes.
- **T1 — tool advertisement:** mocked fetch — body carries Responses-shaped function tools from a fixture `BridgedTool[]`; the 347 `tools: []` pin inverted for codex (negative-verify: fails pre-flip); gemini pins untouched and green.
- **T2 — dispatch loop:** scripted SSE sequences — single round (no calls); two rounds (call → output appended → second POST's `input` contains user item + round-1 output items incl. a reasoning item + `function_call_output`); gate-deny → denial text as output, loop continues; unknown tool name and bad-JSON arguments → structured error outputs, no throw; maxRounds → `error_max_turns` + `classifyTurnResult` non-provider.
- **T3 — history store:** load/append/clear round-trip; whole-turn trim at budget (oldest dropped, pairs intact); success-only persist (error/aborted turns leave the doc untouched); **breaker-safety pin:** a store whose collection ops reject with `ECONNREFUSED`-shaped errors yields `[]`/void, the turn completes, and `classifyTurnResult` sees success — no Mongo text anywhere in `RunResult.error`.
- **T4 — KPR-313 interplay:** manager-level — handoff branch calls `clear` (spy) with catch-swallow (rejected clear doesn't throw in the guard window); adopt branch doesn't; sessions row still written with `sessionId: ""` provider `codex` (existing pins stay green).
- **T5 — assembly flip:** `TOOL_EXECUTING_PROVIDERS` = `{openai, codex}` (pin updated); codex `assembleProviderTurn` instructions now carry toolkit/skills markers and the memory tool-claim lines (KPR-349 T2's mirror, inverted for codex; negative-verify pre-flip); gemini still stripped.
- **T6 — telemetry:** nonzero `stats.toolMs` ⇒ `llmMs = durationMs − toolMs` (clamped); usage summed across two mocked rounds; `toolSummary` rendering.
- **T7 — self-heal:** 4xx on a replayed first POST → exactly one fresh retry + `clear` called; 4xx with empty history → no retry; 5xx with history → no retry, error result classifies `server-error` (breaker weight preserved).
- **T8 — abort:** mid-round and mid-tool-execution abort → `aborted: true`, `bridge.close()` spied on every path, no persist, no unhandled rejections.

## Open assumptions

**Blocking (spike-gated, plan step 0):**
- ⚠ The chatgpt.com backend accepts function tools, emits `function_call` output items, honors `include: ["reasoning.encrypted_content"]`, and accepts replayed item lists on this schema — codex-CLI-proven in the wild and consistent with the epic's provider-surface research, but T0 verifies live before dependent chunks (the fleet credential makes this cheap, unlike the openai lane's still-open gap).

**Non-blocking (⚠ delegated/documented):**
- ⚠ Replay re-bills input tokens each turn against subscription quota; backend prompt caching offsets it (`cacheReadTokens` already surfaced). Accepted cost of honest statelessness; matrix-listed, not optimized here.
- ⚠ `HISTORY_CHAR_BUDGET = 200_000` is a first-cut constant; if live use shows quota pain or truncation pain, the constant moves — not a config knob (simplicity canon).
- ⚠ Sequential tool execution within a round (§D2) trades latency for bridge-tool safety (hive's in-process handlers aren't concurrency-audited under one turn); parallelizing is a follow-up lever, deliberately not pre-built.
- ⚠ KPR-350, when specced, should confirm it inherits the §R comment correction and builds nothing codex-shaped; if 350 changes `SESSION_SEMANTICS.openai` to `conversation-store`, codex is unaffected by construction.
