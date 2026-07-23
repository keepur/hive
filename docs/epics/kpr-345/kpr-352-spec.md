# KPR-352 — Gemini replication: Interactions API chaining + tool bridge, ADK deleted

**Child 7 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D6 ("Gemini: Interactions API `previous_interaction_id`; `runEphemeral` deleted") and §D8 (the `:effort`-on-gemini open ruling).
**Shape:** pattern replication — KPR-353's hive-owned dispatch loop married to KPR-350's server-side chaining posture, bound to the Gemini Interactions API. One deliberate deviation from the ticket sketch: **ADK is deleted, not upgraded** (§R).
**Depends on:** KPR-348 (bridge), KPR-349 (assembly), KPR-350 (self-heal arm + transition-pin shape), KPR-353 (dispatch-loop + flip-commit precedents), KPR-354 (delegate synthesis) — all merged in this baseline (@ 2f2eff5).
**Informs:** KPR-355 (matrix row facts, §D9), KPR-351 (gemini live legs are key-conditioned and non-gating, same posture as the openai flagship legs).
**Decision-register canon honored:** `BridgedTool[]` bound, not redesigned (zero `tool-bridge.ts` edits); `TOOL_EXECUTING_PROVIDERS` grows gemini **in the same commit** as the zero-tools flip — completing the set and dissolving it per KPR-349 canon (§D4); `SESSION_SEMANTICS` is the single session seam — this child changes the gemini **value** in the same PR as the mechanism (KPR-347 one-line rule); stale-handle self-heal rides KPR-350's semantics-gated manager arm (no new arm); assembly stays provider-blind; classify sites untouched (gemini ≡ openai at every tool-transport column already — KPR-348/354 one-code-path rule); nested delegate turns session-less/history-less/breaker-invisible (KPR-354).
**Provider-surface evidence (re-verified 2026-07-23, live docs):** Interactions API is GA (June 2026) and the recommended surface; `previous_interaction_id` gives server-side continuity (implicit caching rides it); retention **55 days paid tier / 1 day free tier**, `store` defaults `true` (opt-out `store=false` disables chaining); function tools are `{type:"function", name, description, parameters}` JSON schema, calls come back as `function_call` steps (`name`, `arguments`, `id`), results go back as `{type:"function_result", name, call_id, result:[{type:"text",…}]}` items on a chained follow-up; `thinking_level` ∈ {`minimal`,`low`,`medium`,`high`} (subset varies per model); **thought signatures are server-managed under `store:true` + chaining — no client replay obligation** (stateless mode would require verbatim thought-block resend; we never enter it); streaming = SSE events `interaction.created` (id) / `step.delta` (`text`, `arguments_delta`, …) / `interaction.completed` (usage); JS surface is `@google/genai` `client.interactions.create` — **not** ADK; **Vertex AI does not serve the Interactions API yet ("coming soon")** — API-key auth only; community-reported stale-chain faults: 403 "You do not have permission to access the content" on expired/foreign interaction ids, 400 on incompatible chained history.

## TL;DR

Make `gemini/…` a full Lane B citizen by rewriting the adapter on the Interactions API: bind KPR-348's `BridgedTool[]` as Interactions function tools inside a bounded hive-owned dispatch loop (KPR-353's template — @google/genai is a plain API client, so the loop is ours), and get durable resume by `previous_interaction_id` chaining (KPR-350's template — the handle lives in `sessions`, is rewritten every turn, and stale handles self-heal through the **existing** semantics-gated manager arm once `SESSION_SEMANTICS.gemini` flips to `server-resumable`). `runEphemeral` dies by deleting the `@google/adk` dependency outright — the ticket's "ADK sessions" leg is dissolved by ruling (§R): ADK's session services are a client-side SQL-backed replay layer that the Interactions API's server-side state makes redundant, and ADK's runner is a second agent runtime hive doesn't need. The same commit adds gemini to `TOOL_EXECUTING_PROVIDERS`, which completes the set `{openai, codex, gemini}` and dissolves it (§D4). §D8 is ruled: `:effort` on gemini routes maps to `thinking_level` with a small coercion table (§D5).

## Key Points

- **§R ruling (ticket-title deviation, argued):** "Interactions API + ADK sessions" becomes "Interactions API, ADK deleted." ADK sessions solve the problem Interactions' server-side state already solves, in a foreign persistence stack (async SQL drivers), behind a second agent loop. The codex adapter proved a raw-surface hive-owned loop is small, testable, and containment-friendly; gemini gets the same, plus server continuity codex can't have. HUMAN_DIRECTIVE precedent (KPR-353's drafter dissolved its filed dep) covers evaluating the sketch against the live surface.
- **Session semantics: gemini `stateless-replay` → `server-resumable`** — one line in `SESSION_SEMANTICS`, same PR as the mechanism (KPR-347 canon). Everything downstream is inherited, not built: write-side persistence (`persistsResumableHandle`), read-side normalization, the KPR-313 transition guard, and — the replication payoff — **KPR-350's stale-handle self-heal arm fires for gemini with zero arm changes** (it gates on `sessionSemanticsFor(route) === "server-resumable"`, the exact seam KPR-347 built for this moment). Only the matcher grows a gemini alternate (§D3).
- **Deterministic stale-handle detection (deliberate improvement on KPR-350's letter, same philosophy):** the adapter owns the request, so it *knows* whether the failed POST carried a `previous_interaction_id` and which one — it tags **round-1** 400/403/404 failures **whose carried id is the persisted sessions-store handle** with a hive sentinel string (intra-turn rounds, which always carry the prior round's just-minted id, stay ordinary provider faults), and `isStaleServerHandleError` matches the tag instead of guessing Google's error prose. This also defuses a real breaker hazard: gemini's documented stale-chain fault is a **403**, which would otherwise pattern-match the `auth` row and let expired handles trip the gemini breaker as a fake auth outage.
- **Flip + dissolution in one commit (KPR-349 canon):** `tools: []` → bridged tools AND gemini joins `TOOL_EXECUTING_PROVIDERS` = all of `LaneBProviderId` ⇒ the set is deleted and the assembly passes `toolsExecutable: true` unconditionally (the builder keeps its provider-blind boolean param). Gemini instructions immediately gain toolkit/file-tier-guidance/skills and the memory tool-instruction lines; the KPR-354 "Delegated capability MCPs" toolkit subsection lights up too.
- **Delegate subagents arrive nearly free (KPR-354 obligation):** `delegateRunner: this.options.assembly.delegateTurnRunner` in the bridge construction (one line, adapter precedent) + a gemini branch in the manager's nested-adapter switch (the current `else` returns "provider does not execute tools" — now reachable only as belt-and-braces). Nested turns: session-less (no chaining in, ids discarded), budget-accounted, breaker-invisible — all inherited.
- **§D8 ruled:** `resolveProviderModel` stops discarding `:effort` on gemini routes; the adapter maps it to `generation_config.thinking_level` with a static coercion — `none→minimal`, `xhigh→high`, the four native values pass through (warn-once on coercion). Pure pass-through was rejected because a vendor-400 on a chained request would trigger the self-heal and **silently reset thread continuity every turn** under a misconfigured suffix; coercion removes that trap. Model-level mismatches (e.g. a pro model rejecting `minimal`) stay vendor-400 config faults, codex-identical, documented.
- **Auth ruling:** API-key single path (`GEMINI_API_KEY`/`GOOGLE_GENAI_API_KEY`/`GOOGLE_API_KEY`, `config.gemini.apiKey` first). The Vertex OAuth attempt is **deleted** — the Interactions API is not served on Vertex yet; revisit trigger recorded (§D7). Missing key = pre-request throw classifying `auth` (codex posture: persistent misconfig trips the breaker into honest outage rather than erroring raw forever); one auth-row alternate added, pinned.
- ⚠ **Delegated assumptions:** live-unvalidated surface (fleet gemini key status checked at plan step 0 — the vision sidecar's `GEMINI_API_KEY` may make the spike cheap; otherwise mocks + boundary posture per KPR-348 precedent); free-tier retention is 1 day (self-heal degrades gracefully; matrix caveat) and free-tier data trains — production gemini assignment needs a paid-tier key (ops caveat); exact `@google/genai` version exposing `interactions`, abort-signal plumbing, and usage field names pinned at plan time.
- **Out of scope:** the `src/llm/` gemini vision sidecar (generateContent — untouched); voice (pins Claude lane, epic ruling); cross-provider history carry; per-turn router effort tuning for foreign models (KPR-322 rule); Vertex support; parity-matrix doc itself (KPR-355).

## §R — Ruling: ADK is deleted, not upgraded

The ticket sketch ("Interactions API + ADK sessions") dates from the epic's 2026-07-19 research, which noted ADK-TS `DatabaseSessionService` as gemini's session facility. Re-verified against the live surface, the two halves of the sketch contradict each other, and the ADK half loses:

1. **Interactions API server-side state makes ADK sessions redundant.** ADK sessions are client-side event-history persistence replayed into each model call — the `stateless-replay` shape. Gemini now has a first-class server-resumable surface (`previous_interaction_id`, 55-day paid retention, implicit-caching benefits). Choosing client replay when the server offers a handle would repeat codex's pattern *without codex's excuse* (codex hard-enforces `store:false`; gemini defaults `store:true`).
2. **ADK's persistence stack is foreign.** `DatabaseSessionService` wants an async SQL driver (sqlite+aiosqlite / asyncpg / aiomysql class). Hive's continuity store is Mongo (`sessions`, 7d TTL). Adopting ADK sessions means a second database technology for strictly less capability than one line of `SESSION_SEMANTICS`.
3. **ADK is a second agent runtime inside hive's runtime.** Hive is the orchestration layer above provider SDKs (KPR-209); the Lane B pattern that won is: provider SDK for *transport*, hive for the loop, gate, and containment (codex proved the raw-surface loop; openai kept its SDK loop only because the Agents SDK carried the tool executor). ADK's `LlmAgent`/`Runner` duplicate what `ToolBridge` + the dispatch loop + `archetype-gate` already own — and ADK's model path speaks `generateContent`, with public issue reports of Interactions integration breaking its own session compatibility.
4. **Deletion is the honest form of "delete runEphemeral".** `runEphemeral` has no non-ADK analog; removing ADK removes it, its event-shape helpers (`extractTextChunks`, `toStructuredEvents` handling), and the `@google/adk` package dependency (used nowhere else — verified). `@google/genai` (the Interactions-capable SDK) is added in its place.

**Consequence:** `gemini-adk-adapter.ts` is replaced by `gemini-interactions-adapter.ts` (class `GeminiInteractionsAdapter`, `provider = "gemini"` unchanged). The file/class rename is deliberate — "Adk" in the name would be a lie the next reader pays for.

## Problem

Post-350/353/354, gemini is the last Lane B dead end: its adapter receives a full `ProviderTurnAssembly` and advertises `tools: []` behind a KPR-347 flip-comment; its instructions are honesty-stripped (no toolkit/skills/memory tool-lines); `runEphemeral` gives every turn amnesia behind a fabricated `gemini-pilot-…` id the store rightly refuses to persist; the manager's delegate runner hard-returns "provider does not execute tools" for it; and `resolveProviderModel` silently discards a configured `:effort`. Meanwhile both proven templates (350's chaining + self-heal, 353's dispatch loop + flip mechanics) sit merged, waiting to be bound.

## Goals

- G1: `gemini/…` turns execute every bridgeable tool class through the KPR-348 bridge via a bounded adapter-owned Interactions dispatch loop; `runEphemeral` and `@google/adk` deleted.
- G2: `TOOL_EXECUTING_PROVIDERS` completes and dissolves in the flip commit; gemini instructions gain the tool-dependent sections with zero builder changes.
- G3: Durable resume by `previous_interaction_id` chaining: `SESSION_SEMANTICS.gemini = "server-resumable"`, handle persisted/rewritten via existing manager paths, `store:true` pinned explicitly.
- G4: Stale/expired chain handles self-heal through the existing KPR-350 manager arm — adapter-tagged detection, matcher alternate, breaker-invisible.
- G5: Delegate Task synthesis live on gemini (KPR-354 inheritance: one-line bridge pass + manager nested branch).
- G6: §D8 ruled: `:effort` → `thinking_level` with coercion; route carries `reasoningEffort` for gemini.
- G7: Honest telemetry (`bridge.stats`, `llmMs = durationMs − toolMs`, usage from `interaction.completed`), honest classification (no new breaker-visible fault class that isn't a provider fault), matrix row facts recorded.

## Non-goals

- ADK in any form (§R). No ADK sessions, no `LlmAgent`, no compatibility shim.
- `provider_turn_history` for gemini — server-side chaining needs no replay store; the KPR-313 handoff `clear()` stays provider-agnostic and is a harmless no-op for gemini threads.
- Vertex AI support — Interactions is not served there yet; the deleted Vertex OAuth path returns only when the surface exists (§D7 revisit trigger). The `src/llm/` gemini vision sidecar and its `visionModel` config are untouched.
- Session-handoff notice text: Lane B keeps the pilot variant (KPR-346 canon keys the Claude variant on Claude-runtime lane membership). Gemini now *has* a recall tool, so the variant choice is newly conservative for all three Lane B providers equally — candidate follow-up, not this child.
- `conversation-store` occupancy, SDK-side session objects, thought-summary surfacing (`thinking_summaries` not requested), tool_choice tuning, parallel tool execution (sequential pinned, 353 precedent), per-turn router effort for foreign models, translation proxies.
- Bridge internals, builtin executor, gate, prompt builder, classify sites — consumed as-is (bind-don't-redesign canon).

## Design

### D1 — Adapter rewrite: Interactions dispatch loop (KPR-353's template on @google/genai)

`GeminiInteractionsAdapter.runTurn()` mirrors the codex adapter's structure — per-spawn `ToolBridge` (construction verbatim from `codex-subscription-adapter.ts:127-136`, **including `delegateRunner: this.options.assembly.delegateTurnRunner`** — the KPR-354 one-liner), `connect()` in the try, `close()` in the finally, abort controller + between-round/between-tool abort checks:

```
chainHead = request.sessionId            // previous_interaction_id for round 1; undefined ⇒ fresh thread
input     = [userText]
for round in 1..maxRounds:
    interaction = client.interactions.create({
        model, system_instruction: instructions, input,
        previous_interaction_id: chainHead,        // omitted when undefined
        store: true,                               // §D2 posture pin — chaining prerequisite, pinned not defaulted
        stream: true,
        generation_config: { thinking_level },     // §D5, only when effort configured
        tools: bridged.map(bt => ({ type: "function", name: bt.name,
                                    description: bt.description, parameters: bt.inputSchema })),
    })
    consume SSE: interaction.created → id; step.delta{text} → onStream; arguments_delta → accumulate;
                 interaction.completed → usage (accumulate once per round); error event → throw
    chainHead = interaction.id                     // intra-turn rounds chain the same way turns do
    calls = completed function_call steps (dedupe by call id)
    if calls.empty: break                          // final round — its text is RunResult.text
    input = calls.map(execute via bridgedByName →  // sequential (353 pin); unknown name / bad args
            { type: "function_result", name, call_id, result: [{type:"text", text: out}] })
```

- **Chaining does double duty:** the same `previous_interaction_id` mechanism carries inter-turn resume (round 1 resumes the persisted handle) and intra-turn tool rounds (round N+1 sends *only* the `function_result` items — server holds the rest). `RunResult.sessionId` = the **final** round's interaction id (it transitively contains the whole turn); on error/abort, `sessionId` falls back to `request.sessionId ?? ""` (openai's `extractSessionId` shape) — **never a fabricated id**: under `server-resumable` semantics a fabricated id would be persisted and later resumed as garbage. The `gemini-pilot-` fabrication dies with the rewrite.
- **Bound:** `maxRounds = request.resourceLimits?.maxTurns ?? 10`; `maxTurns 0` ⇒ immediate `error_max_turns` with zero POSTs (codex-identical divergence, same pin).
- **Containment:** loop-local additions identical to codex `executeFunctionCall` — hallucinated tool name and unparseable arguments become structured `function_result` error text; gate denials are already model-visible text via the bridge; nothing in the loop escapes `runTurn` as a throw.
- **Streaming:** `text` deltas from every round reach `onStream` (intermediate think-aloud); `RunResult.text` is the final round's text only (353 final-reply semantics). Thought-summary/`thought_signature` deltas are ignored — signatures are server-managed under stateful mode (evidence header) and never touch hive.
- **Error strings carry the HTTP status** (`Gemini interaction request failed (429): …`) so the existing `FAULT_PATTERNS` rows classify network/429/401/5xx faults with full breaker weight — except round-1 4xx that carried the persisted handle, which are tagged first (§D3; intra-turn rounds always classify ordinarily).

### D2 — Session semantics flip + posture pin (KPR-350's template)

- `SESSION_SEMANTICS.gemini: "stateless-replay"` → `"server-resumable"` — one line, same PR as the mechanism; the `stateless-replay` doc comment's "gemini leaves this category when Interactions lands" projection resolves. **Everything downstream inherits:** `persistsResumableHandle` now persists the gemini handle (`finalizeSpawnResult`, churn-mint rider included), `SessionStore.normalizeRef` returns it for tagged gemini rows, the KPR-313 guard covers gemini transitions generically, reflection re-resolve is provider-blind. Pre-352 tagged gemini rows hold `sessionId: ""` (written under `stateless-replay`) and normalize to no-handle — no poisoned resume on upgrade day; legacy untagged `gemini-pilot-` rows already scrub (`FABRICATED_SESSION_ID`, untouched).
- **`store: true` pinned explicitly** in every create call (code-enforce canon; it is the API default *today* — the codex surface's hard-enforced opposite is the live precedent for defaults flipping).
- **Retention arithmetic (paid tier):** hive horizon = `sessions` 7d idle TTL, handle rewritten every successful turn ⇒ resumed handle age ≤ 7d < 55d server retention — same never-expired-by-arithmetic property as openai's 7d < 30d. **Free tier: 1d retention inverts the arithmetic** — a >1-day-idle thread resumes a dead handle; the §D3 self-heal turns that into one fresh-context turn per expiry instead of a broken thread. Matrix caveat, not engineered around.
- **No truncation analog exists** on this surface (openai's `truncation:"auto"` has no documented Interactions counterpart). A context-overflow rejection on a long chain arrives as a resume-carrying 4xx ⇒ lands in the §D3 self-heal ⇒ chain restarts fresh. Honest degradation, documented; revisit if the API grows a context-management knob.
- `system_instruction` does not persist across chained interactions (documented) — re-sent every round from `assembly.instructions`, which hive does anyway by construction.

### D3 — Stale-chain self-heal: adapter-tagged, existing arm (the replication payoff)

**Failure modes:** expired interaction id (55d/1d retention; community reports 403 "You do not have permission to access the content" — sometimes far earlier than documented), foreign/rotated key or org (same 403 shape), incompatible chained history after surface migrations (400 class), deleted interactions (404 class).

**Detection is hive-owned, not string-guessed:** the adapter knows whether the failing POST carried `previous_interaction_id` — and which id. The tag is pinned to **round-1 failures where the carried `previous_interaction_id` === `request.sessionId`** (the handle read from the sessions store) — mirroring KPR-353 §D7's first-round-4xx-on-non-empty-replay scoping. Intra-turn rounds always carry the prior round's just-minted id (§D1), which cannot be a stale *persisted* handle; a mid-turn 400/403/404 stays an ordinary provider fault (classifier unchanged) — tagging it would fire the manager's fresh-retry arm and re-run the whole turn, re-executing already-executed tool calls (duplicate side effects: sends, writes). When a round-1 create carrying the persisted handle fails with status **400/403/404**, the adapter sets `RunResult.error` to a sentinel-prefixed string:

```
gemini interaction resume rejected (status 403): <provider message>
```

**One matcher alternate, zero arm changes:** `isStaleServerHandleError` (`agent-manager.ts:292`) gains `/gemini interaction resume rejected/i`. The existing KPR-350 arm — semantics-gated `server-resumable`, `sessionId` present, one fresh retry, record-once on the finalized attempt, write-path self-correct (no scrub), churn-mint keeps the stale handle on a failed retry — fires for gemini **unchanged**. This is exactly the seam KPR-347/350 built; the spec's job is to bind it, and the binding is one regex alternate.

- **Why the tag matters for the breaker:** the raw 403 text would match the `auth` `FAULT_PATTERNS` row — three stale-handle turns would trip the gemini breaker as a phantom auth outage and engage the outage queue. By construction the tag is only emitted when `sessionId` was resumed on a `server-resumable` route, so the arm always consumes it and the finalized (retry) result is what reaches the breaker. Belt-and-braces: T-pin that the tagged string classifies as the arm's food and — canon (KPR-350): **no new `FAULT_PATTERNS` row** for stale handles, ever.
- **Status breadth {400,403,404}, deliberately excluding 429/5xx:** rate limits and server errors on a resume-carrying request are provider faults that must keep breaker weight and must not cost thread context (KPR-350's narrowness rationale). 400-class over-trigger (residual config faults) costs one bounded extra attempt + one context reset per turn — same accepted waste shape as 350's re-trip bound; the §D5 effort coercion removes the dominant config-400 class. ⚠ Statuses are community-sourced; refined against live capture (plan step 0 spike if a key resolves, else first live validation).
- **Retry is fresh and unannotated** (350 posture, same block); redaction: the warn log drops the provider message (it may embed the interaction id — KPR-350 redaction ratification applies).

### D4 — Flip + dissolution: `TOOL_EXECUTING_PROVIDERS` completes and dies

Same commit as the adapter's tool advertisement (KPR-349 canon: the set and the flip are one review surface):

- Gemini joins the set ⇒ set == `LaneBProviderId` ⇒ **dissolve per canon** ("set dissolves when all three execute"): delete the `TOOL_EXECUTING_PROVIDERS` constant; `assembleProviderTurn` passes `toolsExecutable: true` unconditionally (comment: Lane B invariant post-352 — every native adapter executes bridged tools). The builder's `toolsExecutable: boolean` param **stays** — it is the provider-blind seam (KPR-349 canon: never a provider id), costs nothing, and re-arms the honesty gate if a future non-executing provider ever joins `LaneBProviderId` (an explicit one-line concern for that child).
- Effect on gemini instructions: toolkit + file-tier guidance + skills sections and the memory block's tool-instruction lines (`mcp__structured-memory__memory_recall` naming, KPR-349 §D5 option (a)) render for gemini with zero builder edits; the KPR-354 "Delegated capability MCPs" toolkit subsection lights when the agent has `delegateServers`.
- Test motion: `turn-assembly.test.ts:109-110` membership pin is **retired with the constant**; replaced by pins that gemini assembly passes `toolsExecutable: true` and gemini instructions carry toolkit/skills markers + memory tool-lines (KPR-349 T2's mirror, negative-verified pre-flip); the gemini `tools: []` adapter pins invert; openai/codex pins stay green.

### D5 — §D8 ruling: `:effort` → `thinking_level`, coerced

- `resolveProviderModel`'s gemini branch stops discarding the parsed suffix: the route becomes `{ provider: "gemini"; model: string; reasoningEffort?: CodexReasoningEffort }`; the manager passes it to the adapter as `reasoningEffort` (codex option shape).
- Adapter mapping to `generation_config.thinking_level`: `minimal|low|medium|high` pass through; **`none → minimal`, `xhigh → high`**, warn-once per (agent, value) on coercion (Lane A's clamp-and-warn precedent, `agent-manager.ts:1499` shape). No suffix ⇒ no `generation_config.thinking_level` field sent (model default thinking — the effort-less-codex parallel, KPR-353 canon).
- **Why coerce instead of pass-through-and-let-vendor-400 (the kimi/codex posture):** unique to this surface, a config-400 on a *chained* request would be tag-eligible (§D3) and trigger a context-resetting self-heal **every turn** — a misconfigured suffix silently lobotomizing a thread is a worse failure than a coerced approximation. Model-level mismatches hive can't know statically (e.g. pro-tier models rejecting `minimal`) remain vendor-400 config faults, codex-identical, documented non-goal.
- Per-turn router effort tuning stays Claude-only (`src/llm/catalog.ts`, KPR-322 rule) — foreign models pass through untuned; static suffix only. Matrix-noted.

### D6 — Delegate subagents: KPR-354 inheritance

- Bridge construction passes `delegateRunner` (§D1 — the obligation's one line). The partition already routes `claude-subagent` ⇒ `requires-hive-bridge` for gemini (one code path, `tool-transport.ts:92-121`), so Task synthesis lights up by construction.
- Manager: the nested-adapter switch (`agent-manager.ts:624-645`) gains a gemini branch constructing a nested `GeminiInteractionsAdapter` with `buildNestedDelegateAssembly`'s output, model fallback `route.model || appConfig.gemini.agentModel || <default>` (parent-identical). The unreachable `else` stays as containment (belt-and-braces for a future `LaneBProviderId` growth).
- Nested semantics all inherited from KPR-354 canon: budget-accounted (`spawnBudget ≥ 2` guidance applies to gemini delegate users), lock-exempt, abort-chained, **session-less** — nested `runTurn` gets no `sessionId`, so the nested turn starts a fresh chain; intra-turn rounds still chain internally (loop mechanics); the final nested id is discarded and never persisted. ⚠ Accepted residue: nested chains leave unreferenced `store:true` interactions that self-expire at vendor retention (55d paid) — the same accepted shape as KPR-350's 30d nested residue.

### D7 — Auth ruling: API-key single path, Vertex deleted

- **Kept:** key resolution `options.apiKey` (wired from `config.gemini.apiKey`) → `GOOGLE_GENAI_API_KEY` → `GEMINI_API_KEY` → `GOOGLE_API_KEY` (existing precedence, `envValue` semantics; `config.ts` env-first resolution unchanged).
- **Deleted:** the Vertex OAuth attempt chain (`buildAuthAttempts` / `runWithAuthFallback` / `resolveGoogleVertexOAuthConfig` usage) — the Interactions API is not served on Vertex ("coming soon"), so the attempt can only 404/misroute. `resolveGoogleVertexOAuthConfig` itself is deleted from `oauth-credentials.ts` if this was its last consumer (verified at plan time; clean-wrap canon). **Revisit trigger (recorded for the register):** when Vertex ships the Interactions API, re-adding an OAuth attempt is a new small ticket — the single-path ruling here is surface-driven, not preference-driven.
- **Missing key:** pre-request throw `"Gemini API key is not available; set GEMINI_API_KEY (hive credentials add) or GOOGLE_API_KEY"` — codex posture (KPR-353 §D5 note: persistent local misconfig fast-fails into the breaker's honest-outage path, operationally right). The `auth` `FAULT_PATTERNS` row gains one alternate — `api.?key is not available` — same motion as the codex `OAuth session is not available` alternate, regression-pinned per-alternate (the row's standing rule). The throw either precedes bridge construction or, if ordered after it, still reaches `bridge.close()` through the finally — no leaked bridge on the missing-key path (T9 asserts it).
- Ops attribution: gemini faults trip the `gemini` breaker/outage queue only (route-keyed, existing canon).

### D8 — Telemetry and result shape

Codex-identical rendering: `toolCalls`/`toolMs`/`toolSummary` from `bridge.stats`; `llmMs = max(0, durationMs − toolMs)` (breaker p95 rule); usage accumulated **once per round from `interaction.completed` only** (`total_input_tokens`/`total_output_tokens`; interim events never accumulate — 353's multi-count lesson pinned); `costUsd` 0 (no per-token billing wired; matrix-noted like Lane A's nominal-cost caveat); `cacheReadTokens` mapped if the usage object surfaces a cached-token field, else 0 (⚠ field name verified at plan time; implicit caching exists on chained interactions). `contextWindow`/`compactions` stay 0.

### D9 — Documentation riders + KPR-355 row facts

- CLAUDE.md: provider-adapters paragraph — gemini now executes real tools via the bridge (the "gemini still advertises zero tools until KPR-352" clause dies); gemini resume = `previous_interaction_id` chaining (server-resumable, 55d/7d arithmetic, self-heal shared with openai); `@google/adk` → `@google/genai` dependency note.
- `types.ts`: `SESSION_SEMANTICS` comment updates (gemini's exit from `stateless-replay` recorded; `server-resumable` comment gains the gemini/Interactions citation). Values beyond the gemini line untouched.
- **Matrix row facts (KPR-355):** tools = full (all four transport classes, same builtin set and claude-only omissions as openai/codex); memory/skills/guardrails = full (shared assembly + gate); resume = **`server-resumable`** — `previous_interaction_id` chaining, handle in `sessions` (7d idle TTL, rewritten per turn), vendor retention 55d paid / **1d free tier** (self-heal degrades free-tier idle threads to daily fresh context), `store:true` pinned ⇒ no-retention deployments unsupported for chaining (ZDR-caveat analog), thought signatures server-managed, **no truncation/compaction analog** (overflow ⇒ self-heal chain restart); subagents = delegate Task synthesis (general-purpose Task claude-only); effort = `:effort` → `thinking_level` with `none→minimal`/`xhigh→high` coercion, per-model level support varies (vendor-400 config fault); auth = API key only, **no Vertex** until Interactions ships there; server-side tools (google_search etc.) = not wired (n/a); live-unvalidated pending a funded/production key decision (kimi/deepseek row precedent).

## Integration points

| Seam | This ticket | Must NOT touch |
|---|---|---|
| `gemini-adk-adapter.ts` → `gemini-interactions-adapter.ts` | full rewrite (§D1-D3, §D5, §D7, §D8); ADK imports gone | `provider = "gemini"`; `AgentProviderAdapter` contract |
| `types.ts` | `SESSION_SEMANTICS.gemini` value (one line) + doc comments (§D2, §D9) | unions, other values, `persistsResumableHandle` |
| `turn-assembly.ts` | delete `TOOL_EXECUTING_PROVIDERS`; `toolsExecutable: true` literal (§D4) | builder param shape, everything else (provider-blind canon) |
| `agent-manager.ts` | gemini route carries `reasoningEffort` (§D5); adapter construction options (apiKey/model/effort); nested gemini branch (§D6); `isStaleServerHandleError` gemini alternate (§D3); default-model literal bump (§Open assumptions) | arm logic/ordering (R7 window), KPR-313 guard, `finalizeSpawnResult` rules, breaker acquire/record, openai/codex branches |
| `error-classification.ts` | one `auth`-row alternate: `api.?key is not available` (§D7), pinned | everything else; **no stale-handle row** (KPR-350 canon) |
| `oauth-credentials.ts` | delete `resolveGoogleVertexOAuthConfig` iff orphaned (§D7) | codex/openai credential paths |
| `package.json` | drop `@google/adk`, add `@google/genai` (version pinned at plan time; bundling externals checked) | — |
| CLAUDE.md | §D9 riders | — |
| `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts`, `prefix-builder.ts`, `agent-runner.ts`, `session-store.ts`, `turn-history-store.ts`, `openai-agents-adapter.ts`, `codex-subscription-adapter.ts` | **none** | everything (bind-don't-redesign; classify sites already emit gemini correctly) |

## Edge cases

- **First turn / no stored handle:** no `previous_interaction_id`; fresh chain; final id persisted tagged `gemini`.
- **Stale/expired/foreign handle (incl. free-tier 1d expiry and the community early-403):** tagged ⇒ existing arm ⇒ one fresh retry ⇒ write path self-corrects; failed retry preserves the stale handle for next turn's re-trip (bounded waste, never a dead thread).
- **Context overflow on a long chain:** resume-carrying 4xx ⇒ self-heal chain restart (no truncation analog — §D2); the reset is the compaction substitute, annotationless (350 posture).
- **Errored/aborted mid-loop:** `sessionId` falls back to `request.sessionId ?? ""`; churn-mint rider blocks persist; pre-error chain state resumes next turn. Orphaned mid-turn interactions self-expire vendor-side.
- **Parallel `function_call` steps:** all executed sequentially (dedupe by call id), all `function_result` items sent in one follow-up round.
- **Hallucinated tool / bad arguments JSON / gate deny:** structured `function_result` text, loop continues (353 parity).
- **`maxTurns 0`:** `error_max_turns`, zero POSTs, non-provider (pinned).
- **Provider round trip claude→gemini→claude:** KPR-313 guard trips both directions — fresh session + §3.4 annotation (pilot variant); the guard's `turnHistoryStore.clear` is a no-op for gemini threads; gemini's server chain ages out vendor-side (no delete hook, 350-identical). **Pinned both directions — the KPR-350 obligation this child owes.**
- **gemini↔codex transition:** guard trips; codex direction also clears `provider_turn_history` (existing provider-agnostic clear); gemini direction starts a fresh chain. Covered by the same pins.
- **Legacy rows:** tagged pre-352 gemini rows (`sessionId:""`) resume nothing; untagged `gemini-pilot-` rows scrub on read (existing). No migration.
- **Reflection turns:** provider-blind post-lock re-resolve carries the gemini handle; reflection accretes on the chain like any turn.
- **Nested delegate turn:** fresh unpersisted chain, id discarded, budget slot held, faults = Task text (§D6).
- **Missing API key:** pre-request throw → `auth` classification → breaker → honest outage; `hive credentials add GEMINI_API_KEY` recovers next spawn.

## Testing contract sketch

Vitest beside source; `npm run check` green; negative-verify discipline (flip/inversion pins fail on pre-352 source).

- **T0 — live spike (plan step 0, key-conditioned):** if a `GEMINI_API_KEY`-class credential resolves on the dev machine (the vision sidecar may already hold one), run against the real surface: one chained two-turn exchange (context recall via `previous_interaction_id`), one function-tool round trip, `thinking_level` acceptance per target model, and a fabricated/expired-id resume to capture the live stale-handle status+payload (refines §D3 statuses in place). No key ⇒ mocks + boundary posture (KPR-348 precedent), live legs recorded for the KPR-351-class validation pass, non-gating (HUMAN_DIRECTIVE precedent).
- **T1 — tool advertisement:** mocked client — create payload carries Interactions-shaped function tools from a fixture `BridgedTool[]`; gemini `tools: []` pins inverted (negative-verify); `store: true` and `system_instruction` present on every round's payload.
- **T2 — dispatch loop:** scripted SSE streams — single round; two rounds (round-2 payload = `function_result` items only + `previous_interaction_id` = round-1 id); parallel calls (both executed, one follow-up round); hallucinated name / bad-JSON args → structured `function_result`, no throw; `maxRounds` → `error_max_turns`; final-reply semantics (round-1 think-aloud reaches `onStream`, not `RunResult.text`).
- **T3 — session flip:** `SESSION_SEMANTICS.gemini === "server-resumable"` pin (replaces the stateless pin); manager persists the final interaction id tagged `gemini` on success; errored turn → churn-mint blocks; read-side returns the handle for tagged gemini rows; `""` rows and `gemini-pilot-` legacy rows resume nothing.
- **T4 — KPR-313 transition pins (the KPR-350 obligation):** manager-level claude→gemini and gemini→claude — fresh session, `sessionHandoff` set, annotation prepended, adopt-branch adopts; openai↔gemini (server-resumable→server-resumable, both directions) — guard trips, fresh session, neither provider's handle survives the crossing; gemini→codex trips the history clear (provider-agnostic, existing); mirrors KPR-350 T5's shape.
- **T5 — self-heal:** round-1 403 carrying the persisted handle (mocked) → adapter emits the tagged error → matcher hits → exactly one fresh retry (no `previous_interaction_id`) → success overwrites the row; failed retry → stale handle preserved; **mid-turn round-N 403 (carrying round-(N−1)'s just-minted id) → untagged, ordinary provider fault — no fresh retry, no duplicate tool execution (both sides of the scoping pinned)**; non-resume 403 → untagged, classifies `auth` with breaker weight; resume-carrying 429/5xx → untagged, full weight, no heal; tagged-string matcher-narrowness pins (client-transcript/stateless routes: arm dead — extends KPR-350 T3's matrix).
- **T6 — assembly flip + dissolution:** `TOOL_EXECUTING_PROVIDERS` gone; `assembleProviderTurn` passes `toolsExecutable: true` for all three providers; gemini instructions carry toolkit/skills markers + memory tool-lines (KPR-349 T2 mirror, negative-verified); openai/codex instruction pins unchanged.
- **T7 — effort:** `gemini/<model>:high` route carries `reasoningEffort`; adapter sends `thinking_level: "high"`; `:none`→`minimal`, `:xhigh`→`high` coerced with warn; no suffix ⇒ no `generation_config.thinking_level`.
- **T8 — telemetry:** `llmMs` clamp with nonzero `toolMs`; usage accumulated from `interaction.completed` only across two rounds with interim events carrying usage-shaped fields (353 T6 mirror).
- **T9 — abort:** mid-round and mid-tool abort → `aborted: true`, `bridge.close()` on every path, no persist, no unhandled rejections; missing-key pre-request throw path leaves no un-closed bridge (throw precedes construction, or the finally still runs `close()` — asserted, §D7).
- **T10 — auth:** missing key → pre-request throw → `classifyThrown` = `auth` (new row-alternate pinned per-alternate); nested gemini delegate: no `sessionId` in, id discarded, no session persist (KPR-350 T6 mirror).

## Open assumptions

**Blocking:** none. (T0 gates shape details, not the design — mocks carry the contract if no key resolves, per the KPR-348 evidence-gap canon.)

**Non-blocking (⚠ delegated):**
- ⚠ `@google/genai` version exposing `client.interactions` (docs conflict: "1.33.0+" vs "2.3.0+") — plan pins the installed version and verifies the method surface + abort-signal plumbing (SDK `abortSignal` request option, else codex-style between-event checks only); esbuild bundling externals checked (`build/bundle.ts`).
- ⚠ Stale-handle status set {400,403,404} and the free-tier/paid retention behavior are docs+community-sourced; refined at T0 or first live validation. Worst case: a missed status leaves today's churn-to-TTL behavior (no regression); an over-tag costs one bounded retry + context reset per turn.
- ⚠ Usage field names (`total_input_tokens` etc.) and cached-token surfacing verified at plan time; `costUsd` stays 0 (matrix caveat, Lane A precedent).
- ⚠ Manager default-model literal (`"gemini-2.5-flash"`) is pre-Interactions; bumped to an Interactions-supported default (candidate `gemini-3.6-flash`) pinned at plan time against the live model list (`GEMINI_AGENT_MODEL` overrides; KPR-346 plan-time-pin precedent).
- ⚠ Free-tier keys: 1-day retention **and** data-use-for-training — production gemini assignment should use a paid-tier key; ops/matrix caveat, engine-unenforced.
- ⚠ Dissolving `TOOL_EXECUTING_PROVIDERS` removes the honesty gate as a named constant; a future `LaneBProviderId` addition must re-gate explicitly if it ships tool-less (recorded for that child's spec; the builder's boolean seam survives to make it one line).
