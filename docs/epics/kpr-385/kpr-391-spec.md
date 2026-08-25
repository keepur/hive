# KPR-391 — Provider adapter implementation layer: extract shared Lane B machinery into a reusable base

**Epic:** KPR-385 (Provider first-class-ness) · **Type:** refactor + paved-path deliverable · **Status:** spec draft

## TL;DR

The three Lane B adapters (codex, openai, gemini) hand-clone ~400 lines of identical turn machinery — abort lifecycle, ToolBridge wiring, result building, error containment, and (codex/gemini) the bounded tool-dispatch loop — so fixes land in one adapter and not its siblings, and provider #4 means a fourth clone. This ticket extracts that machinery into two in-engine layers (a per-turn scaffold all three adapters sit on, plus a shared bounded dispatch loop for the raw-API adapters) and a per-provider module registry that collapses `createProviderAdapter`'s twin construction switches, migrating all three adapters behavior-preservingly: no `docs/providers.md` row changes, no session-semantics changes, no error-classification outcome changes, no KPR-354 delegate behavior changes.

## Key Points

- **In scope:** extract `LaneBTurnScaffold` (adapter lifecycle: abort controller, bridge construct/close, catch/finally containment, `RunResult` building) + `runBoundedDispatchLoop` (round budget, `error_max_turns`, abort checkpoints, totals accumulation, sequential tool execution) + a `LaneBProviderModule` registry (one construction entry per provider, used by both the top-level and the nested-delegate construction sites in `agent-manager.ts`; the module interface is **self-contained** — no engine-internal type leakage — because it is the embryonic provider-plugin contract, KPR-394); migrate codex/openai/gemini onto them.
- **Out of scope:** grok's adapter itself (KPR-392), dynamic plugin loading of provider modules (sequenced follow-up KPR-394 — this ticket's registry stays a static in-engine table, but the module interface is deliberately designed as the contract that surface will load), Lane A/passthrough restructure, ToolBridge/turn-assembly/tool-transport/error-classification behavior changes, tool-call parallelization, fixing known sibling-divergence bugs (see codex stream-phase status drop — filed as follow-up, not fixed here).
- **Hard constraint — behavior-preserving:** every error-message string, sessionId fallback, self-heal trigger, abort checkpoint placement, and `RunResult` field is load-bearing (breaker classification regexes, `isStaleServerHandleError` sentinel, session persistence). The primary verification is that the full existing suites — 108 adapter tests (44 codex / 37 gemini / 27 openai) + 223 manager tests, vitest runtime counts at head `c5cc74c` — pass **without editing test expectations** (import/wiring changes only).
- **Key boundary decision:** openai migrates onto the **scaffold only** and keeps the Agents SDK's own loop as its engine — forcing it onto the hive-owned loop would change behavior. Codex and gemini migrate onto scaffold **and** shared loop. The extraction is honest about the 2-of-3 split rather than faking a 3-of-3 abstraction.
- **Session machinery stays per-provider strategy code** behind named seams: openai's `previous_response_id`, gemini's `previous_interaction_id` + stale-handle sentinel, codex's `TurnHistoryStore` replay + in-adapter 4xx heal are genuinely different session models. `SESSION_SEMANTICS` remains the sole declarative descriptor; the manager's KPR-350/351/352 self-heal arm is untouched.
- **Grok anticipation (KPR-392, not designed here):** the loop and scaffold seams are transport-agnostic (raw `fetch` and SDK clients both fit), and codex's generic SSE **framing** parser is extracted to a shared util — grok's OpenAI-format gateway speaks the same framing. Provider #4 = one module file (round transport + auth + session strategy) + one registry entry + a `SESSION_SEMANTICS` line.
- ⚠ **Delegated assumption:** scaffold is an abstract base class (statefulness of `abort()`/`wasAborted` makes inheritance the natural fit); the loop is a standalone function, not part of the base.
- ⚠ **Delegated assumption:** the three adapter classes keep their names, exported helpers, and constructor-option shapes exactly, so tests and the manager wiring stay stable; the module registry wraps the constructors rather than replacing the classes.
- **Risk:** subtle behavior drift hiding in "obviously equivalent" consolidation (e.g. codex fabricates a fallback sessionId, gemini pins `""`; codex checks history **before** auth, gemini auth before connect). Mitigated by parameterizing those points explicitly and by the no-test-edits rule; the epic has no `## Decision Register — Canon` section yet (pre-register epic — noted, not a blocker), so prior canon is CLAUDE.md's Provider adapters section + the KPR-345 epic specs.

---

## 1. Problem

`AgentProviderAdapter` (`src/agents/provider-adapters/types.ts`) is a 4-member contract — `provider`, `runTurn()`, `abort()`, `wasAborted` — not an implementation. Everything between the contract and the vendor wire is hand-cloned per adapter:

| Cloned machinery | codex (679 ln) | gemini (706 ln) | openai (322 ln) |
|---|---|---|---|
| `abort()` / `wasAborted` / `currentAbortController` | 383–401 | 378–396 | 153–160 |
| `isAbortError()` (byte-identical ×3) | 396–401 | 456–461 | 234–239 |
| ToolBridge construction block (11 identical option lines; comments literally cite each other's line numbers) | 126–136 | 158–168 | 46–56 |
| `buildResult()` (~50 ln; codex ≡ gemini, openai = token-less variant) | 403–454 | 463–514 | 241–287 |
| catch → `isAbortError` → aborted-vs-error result; finally → `bridge.close()` + controller clear | 347–380 | 343–375 | 123–150 |
| `abortedResult()` closure carrying accumulated totals + bridge stats | 149–160 | 172–183 | — |
| Bounded dispatch loop skeleton: `maxRounds = resourceLimits?.maxTurns ?? 10`, round counter, `error_max_turns` result, abort checkpoints, per-round stream consume → totals accumulation, harvest, sequential tool execution, chain next input | 204–321 | 229–324 | (Agents SDK loop) |
| `executeFunctionCall` containment (unknown tool / bad JSON args → text, never throw) | 57–70 | 665–673 | (SDK `errorFunction`) |
| `errorMessage` / `objectField` / `stringField` helpers | ×3 / ×2 / ×2 | | |

Total: roughly **400 of the 1,707 adapter lines are clones** — and the gemini adapter's own header comment says it: its loop was built "on the codex-loop template" (KPR-352), its bridge block is "the codex adapter's exact construction".

The cost is not the lines; it's the divergence. Live example: PR #405 (`2423f1f`, 2026-08-24) fixed status preservation on **stream-phase** errors — in gemini only (`describeStreamError`). Codex's stream-phase `response.failed` path (`codex-subscription-adapter.ts:577–581`) still throws message-only with no status prefix, so a mid-stream 429/5xx on codex can still reach the classifier bare — the exact bug class just fixed on its sibling. Every new provider (KPR-392's grok is next) starts as a fourth clone of whichever sibling looks closest and inherits whichever fixes that sibling happened to get.

## 2. Goals

1. A new provider's Lane B adapter is: **API-shape glue** (round transport, stream consumption, tool-payload shape) + **auth resolution** + **session strategy** + a `SESSION_SEMANTICS` line + config defaults — not a clone of loop/lifecycle/result machinery.
2. Codex, openai, and gemini run on the extracted layers with **zero observable behavior change**.
3. A fix to shared machinery (an abort-checkpoint bug, a totals-accumulation bug, an error-containment gap) lands once and covers every Lane B provider structurally.
4. `agent-manager.ts` constructs adapters (top-level **and** nested delegate) through one per-provider module table instead of two hand-maintained if/else chains that must agree.

## 3. Non-goals

- **No dynamic plugin loading — sequencing, not posture.** The registry in this ticket is a static in-engine `Record<LaneBProviderId, LaneBProviderModule>`; nothing here is loadable from outside `src/`. However (operator decision 2026-08-25, reversing the earlier no-engine-extension-points stance): the `LaneBProviderModule` interface is deliberately designed as the contract a future provider-plugin surface will load — KPR-394 makes provider modules loadable via `hive plugin add` (curated-registry distribution per DOD-212, `secret-env`/Honeypot auth), and is gated on this contract surviving four in-tree consumers (three migrations + KPR-392's grok) before freezing. What this imposes on THIS ticket is exactly one design constraint: contract self-containment (see §4.3).
- **No grok adapter.** KPR-392 designs it; this ticket only leaves seams a gateway-fronted OpenAI-format provider can use without modification of the base.
- **No behavior changes**, including deliberate improvements: the codex stream-phase status drop above is *not* fixed here (that changes a classification outcome) — it becomes a one-line follow-up ticket that the new structure makes trivial.
- **No changes** to `ToolBridge`, `assembleProviderTurn`/`ProviderTurnAssembly`, `tool-transport.ts`, `error-classification.ts`, `SESSION_SEMANTICS` values, the manager's self-heal arms, `finalizeSpawnResult`, or Lane A / `ClaudeAgentAdapter` / `passthrough-providers.ts`.
- **No unification of self-heal semantics.** Codex heals in-adapter (4xx-on-replay → clear + one fresh retry, round budget reset); gemini/openai heal at the manager (sentinel/prose match → `isStaleServerHandleError` → one fresh-context retry). These are distinct, ruled designs (KPR-350 §D3, KPR-352 §D3, KPR-353 §D7) and stay per-provider.
- **No tool-call parallelization** (sequential-by-design pin from KPR-353 carries over verbatim).
- **No restructuring of adapter test files** beyond import paths; new tests are additive files for the new layers.

## 4. Extraction design

Three new units, all in `src/agents/provider-adapters/`:

### 4.1 `LaneBTurnScaffold` (abstract base class) — all three adapters

Owns everything an adapter does that is not provider API shape:

- **Abort lifecycle:** `currentAbortController` / `aborted` fields, `abort()`, `wasAborted`, `isAbortError()` — today's byte-identical triplicate.
- **Turn framing:** `startedAt`, fresh `AbortController` per `runTurn`, `streamed` flag, **fallback-session policy hook** (`protected fallbackSessionId(request): string` — codex overrides to fabricate `codex-pilot-${uuid}`, gemini/openai keep the default `request.sessionId ?? ""`; unifying this would change persisted `state.currentSessionId`/`newSessionId` behavior, so it is a hook, not a constant).
- **ToolBridge construct + close:** builds the bridge from `assembly` + request context (today's 11-line identical block, including the KPR-354 `delegateRunner` line); `close()` in the finally, always, including pre-request throw paths (pinned today by gemini T10, `gemini-interactions-adapter.test.ts:725–742`).
- **Containment frame:** the try/catch/finally — catch → `isAbortError` → aborted result; else error result via `errorMessage()`; finally → bridge close + controller clear. Provider code inside the frame *returns or throws*; nothing it throws escapes `runTurn`.
- **Result building:** the single `buildResult()` — `llmMs = max(0, durationMs − toolMs)` clamp (KPR-348 §D8 breaker rule), `toolSummary` `name×count` formatting, `costUsd: 0`, zero-filled Claude-only fields. The openai variant's zero token counts fall out of it passing zero totals (its documented row-15 caveat), not of a second builder.
- **Turn accumulator:** `{inputTokens, outputTokens, cacheReadTokens}` totals + last-seen provider id, owned by the scaffold, written by provider round code — so aborted/errored results carry accumulated totals + bridge stats exactly as today.

The provider subclass implements one abstract method, ~"executeTurn(harness)": receives `{request, bridge, signal, isAborted(), totals, …}`, performs auth resolution, `bridge.connect()`, and its dispatch, and returns a `TurnOutcome` (`{text, sessionId, error?}` — `error_max_turns` and friends are outcome errors, not throws, preserving accumulated totals). **Ordering inside executeTurn stays provider-owned**: codex's history-load-before-auth ordering (KPR-353 T4-pinned deterministic degradation) and openai/gemini's auth-before-connect fast-fail are preserved verbatim because the scaffold does not sequence them.

### 4.2 `runBoundedDispatchLoop` (standalone function) — codex + gemini now, grok next

Generic over a per-round state type; extracts the cloned loop skeleton:

- Round budget: `maxRounds = resourceLimits?.maxTurns ?? 10`, `??` passing 0 through ⇒ immediate `error_max_turns` with **no network call** (the codex/gemini-identical divergence pin — preserved as loop behavior, openai continues handing 0 to its SDK).
- Abort checkpoints at today's exact placements: pre-round, post-stream-consume, pre-each-tool-execution.
- Per-round: provider `executeRound(round, input, chainState)` → round state; loop accumulates totals, tracks last provider round id, applies **final-reply semantics** (all rounds stream to `onStream`; `text` is the final round's only).
- Function-call harvest via provider hook; empty harvest ⇒ break; **sequential** execution through a shared containment wrapper (unknown tool / bad-args → structured text — today's `executeFunctionCall` twins); provider hook shapes the next round's input (`function_call_output` items vs `function_result` round).
- Call-id dedup hook (codex's `seenCallIds` guard; gemini's harvest dedups internally — the hook is optional).
- **Restart affordance:** a provider `onRequestError(err, roundContext)` hook may answer "restart-fresh" (reset round counter and input) — this is codex's §D7 poisoned-replay heal (`round = 0`, history cleared, one shot: the once-only guard lives in the codex hook, as today via `selfHealed`). Gemini does not use it; its stale-handle path is error *decoration* (`describeCreateError` sentinel) consumed by the manager arm.

Not in the loop: wire protocol, payload shapes, session chaining values, error decoration — those are the provider round driver.

### 4.3 `LaneBProviderModule` registry — the construction seam

A static in-engine table `LANE_B_PROVIDER_MODULES: Record<LaneBProviderId, LaneBProviderModule>` where a module supplies:

- `provider: LaneBProviderId`
- `createAdapter(args): AgentProviderAdapter` where `args` carries `{config, route, assembly, context: "primary" | "nested", deps}` — `deps` being the manager-owned handles a module may need (`appConfig` slices, `turnHistoryStore`). The **module** decides what applies per context: codex wires `historyStore`/`agentId` only when `context === "primary"` (the KPR-354 G4 guarantee — nested turns provably never touch `provider_turn_history` — moves from a call-site omission to a module rule); gemini/openai construct identically in both contexts. Model default chains (`route.model || appConfig.X.agentModel || literal`) move into the modules verbatim.

**Contract self-containment (KPR-394 pre-requisite):** `LaneBProviderModule`, its `createAdapter` argument shape, and every type reachable from them form the future plugin ABI. They live in a dedicated contract module importable without pulling engine internals: `deps` is an explicit, minimal, documented capability surface (named handles the engine passes in — never `import`-your-way-into-`agent-manager`), and the contract references only types that are already public adapter-surface types (`AgentProviderAdapter`, `ProviderTurnAssembly`, `SESSION_SEMANTICS` entries, resolved config slices) — no `AgentManager`, registry, or dispatcher types. Two concretions: `route` gets a contract-owned shape (`{model, reasoningEffort}` — `ProviderModelRoute` is currently module-private to `agent-manager.ts:176` and either relocates into the contract module or is mirrored there); and the contract's transitive type closure (`RunResult`, `WorkItemContext`, `StreamCallback` from agent-runner.ts, `ResourceLimits` from model-router.ts) stays type-only-imported for now — re-homing or re-exporting those declarations from the contract module is deferred to KPR-394's ABI freeze, noted here so it doesn't surprise. This costs nothing structurally today and is the one thing that cannot be retrofitted cheaply after KPR-394 freezes the surface.

Both `createProviderAdapter`'s Lane B tail and the nested `delegateTurnRunner`'s if/else chain become module lookups. The nested runner's *semantics* — budget check-and-increment atomicity, lock exemption, abort chaining, D5.7 result shaping, session/history omission — stay in `agent-manager.ts` unchanged; only the `new XAdapter({...})` branches collapse. The "provider does not execute tools" containment branch survives as the registry-miss path.

Additionally extracted because KPR-392's gateway speaks the same framing: codex's generic **SSE framing** parser (`parseSseEvent`, the blank-line event splitter in `consumeBufferedSseEvents`, `[DONE]` handling) moves to a small shared util (`sse.ts`); the codex-specific *event application* (`applyCodexEvent`, usage/output-item capture) stays in the codex module. ⚠ Delegated assumption — cheap now, immediately consumed by the next ticket; if review judges it premature it drops without affecting the rest.

### 4.4 What a provider module supplies (the per-provider surface, summarized)

| Concern | codex | openai | gemini |
|---|---|---|---|
| Engine | scaffold + shared loop | scaffold + Agents SDK loop | scaffold + shared loop |
| Round transport | raw fetch → chatgpt.com Responses SSE | `Runner.run` | `@google/genai` Interactions stream |
| Auth | OAuth token provider (`oauth-credentials.ts`) | `OPENAI_API_KEY` (verbatim error string — auth row match) | key chain + verbatim missing-key error |
| Session strategy | history replay (`TurnHistoryStore`) + success-only persist + in-adapter 4xx heal | `previousResponseId` + `store:true`/`truncation:auto` pins | `previous_interaction_id` chain + `store:true` pin + stale-handle sentinel decoration |
| Error decoration | `responseErrorMessage` (status-prefixed) | SDK messages pass through | `describeCreateError`/`describeStreamError` |
| Effort | `reasoning.effort` passthrough | parsed-not-delivered (unchanged) | `thinking_level` map + `none/xhigh` coercion warn-once |
| Fallback sessionId | fabricated uuid | `""` | `""` (no-fabrication pin, KPR-352 §D1) |

## 5. Migration approach

Behavior-preserving, adapter-at-a-time, each step leaving `npm run check` green:

1. **Introduce scaffold + loop + module types** with their own unit tests (no adapter touched yet).
2. **Migrate codex** (richest surface: history, heal, SSE) onto scaffold + loop + SSE util. Existing 44 codex tests (vitest runtime count) run unedited (import paths at most). Exported test surfaces (`consumeCodexSse`, `consumeBufferedSseEvents`, option interfaces) keep their names and homes via re-export if files split.
3. **Migrate gemini** onto scaffold + loop. 37 tests unedited; `harvestFunctionCalls`, `applyInteractionEvent`, `__resetCoercionWarnedForTests` keep their exports.
4. **Migrate openai** onto scaffold only. 27 tests unedited.
5. **Introduce the module registry**; rewire `createProviderAdapter` (both sites). 223 manager tests unedited — they pin the nested-delegate G4/D5 behavior and the assembly seam.
6. Sweep: delete the now-dead per-adapter clones; verify `docs/providers.md` untouched (`git diff --stat` shows no docs change).

Test-edit discipline (hard rule for the implementing session): existing test **expectations** may not change. A migration step that "needs" an expectation edit is a behavior change — stop and re-derive.

## 6. Integration points

- `src/agents/agent-manager.ts`: `createProviderAdapter` (both construction sites) → registry lookups. `resolveProviderModel`, `SpawnShaping`, breaker permit/record, self-heal arms, `finalizeSpawnResult`, `runOneSpawnAttempt`'s abort-window closure: **unchanged**.
- `src/agents/provider-adapters/turn-assembly.ts`, `tool-bridge.ts`, `tool-transport.ts`, `builtin-executor.ts`, `archetype-gate.ts`: unchanged consumers/producers; the scaffold consumes `ProviderTurnAssembly` exactly as adapters do today.
- `src/agents/provider-adapters/error-classification.ts`: unchanged; the spec pins that no extracted code alters an error string (see §7).
- `src/agents/turn-history-store.ts`: unchanged; handle moves from a codex constructor arg at the call site to a module dep — same object, same calls, same ordering.
- `types.ts`: `LaneBProviderId`, `SESSION_SEMANTICS`, `AgentProviderAdapter` unchanged. (`partitionInventoryForProvider`'s `LaneBProviderId` keying means grok-as-Lane-B will grow the union + compatibility columns — explicitly KPR-392's one-line concerns, unchanged by this ticket.)

## 7. Edge cases the extraction must preserve (checklist)

1. **Error strings are contract.** `FAULT_PATTERNS` rows, `isStaleServerHandleError` alternates, the gemini `STALE_HANDLE_SENTINEL` prefix, openai's "OpenAI API key is not available…" verbatim, codex's "Codex OAuth session is not available…", `error_max_turns` — none may change by a character.
2. **Self-heal asymmetry:** codex in-adapter heal fires only for round-1 4xx on non-empty replay, once, resets round budget, clears history, no heal on 5xx/network; gemini sentinel only for round-1 + persisted-handle + status-400 + message discriminator (never mid-stream, never intra-turn chain ids); openai relies on vendor prose matched at the manager. The manager's adopt-or-fresh (KPR-351 R2) contender re-read is untouched.
3. **Session identity:** codex fabricated fallback id vs gemini/openai `""`; gemini returns the *final* round's interaction id; codex returns `lastResponseId ?? fallback`; error turns' churn-mint rider and `persistsResumableHandle` writes in `finalizeSpawnResult` see identical values before/after.
4. **`maxTurns: 0`** ⇒ no network call + `error_max_turns` (codex/gemini); passed through to SDK (openai).
5. **Abort:** checkpoint placement (pre-round / post-stream / pre-tool), aborted results carrying accumulated totals + bridge stats, `runTurn` re-entry resetting `aborted`, the manager-owned early-abort synthesis (`synthesizeAbortedResult`) all unchanged; nested delegate abort chaining (contained listener, KPR-354 D5.5) unchanged.
6. **Delegate nesting:** nested codex gets no historyStore (G4), nested turns are session-less (no `sessionId` into `runTurn`, final id discarded), depth-1 structural (no `delegateTurnRunner` on nested assemblies), budget accounting/lock exemption verbatim.
7. **Breaker math:** exactly the current `llmMs` clamp; `TurnAssemblyError` boundary unchanged (assembly faults classify non-provider); nested faults stay breaker-invisible tool text.
8. **Streaming:** intermediate rounds reach `onStream`; final text = last round; openai's stream/non-stream branch and `result.completed` await unchanged.
9. **History persistence:** success-only append, whole-turn items (user + all rounds' outputs + function_call_outputs), fail-soft `.catch` belts — verbatim.
10. **Warn-once state:** gemini's module-level `coercionWarned` set (and its test reset hook) keeps module-level lifetime.
- **Non-success sessionId policy (three-way, preserved exactly):** codex aborted and max-turns results use `lastResponseId ?? fallback` while its catch-error result uses the bare fallback; gemini uses the bare fallback on all non-success paths despite tracking `lastInteractionId`; openai has no last-id tracking. The scaffold owns both result paths after extraction, so this asymmetry is an explicit parameterization, not an accidental unification target.

## 8. Verification strategy

- **Primary pin — existing suites unedited:** 44 codex + 37 gemini + 27 openai + 223 manager + turn-assembly/tool-bridge/error-classification tests all pass with no expectation edits. (Counts are vitest runtime output at head `c5cc74c` — `it.each` expansion makes static `it(` greps differ; verify against vitest output, not grep.) This is the behavior-preservation proof; the suites already pin every §7 item (they were written as pins by KPR-350–354).
- **New tests (additive):**
  - Scaffold: bridge closed on success/error/abort/pre-request-throw paths; abort containment; `buildResult` clamp + toolSummary; fallback-session hook behavior per policy.
  - Loop: round budget incl. 0; `error_max_turns` with accumulated totals; abort at each checkpoint; sequential execution order; dedup hook; restart affordance resets budget exactly once; final-text semantics.
  - Registry: per-provider construction parity (primary vs nested arg differences — codex historyStore omission when nested), registry-miss containment text.
  - One cross-check test asserting each adapter's characteristic error strings still classify to the same `ProviderFaultKind` (guards the §7.1 contract at the classification boundary, not just string equality).
- **Negative verification** (per repo practice): temporarily reintroduce a known-divergence (e.g. drop the loop's post-stream abort checkpoint; separately, drop the scaffold's finally-close of the ToolBridge) and confirm the migrated adapters' existing tests fail — evidence the old pins actually exercise the new shared code path.
- **Docs check:** `docs/providers.md` has zero diff in the PR.
- Live smoke (optional, operator-run): one codex turn on keepur (the KPR-351-validated surface) post-merge — same bar as prior Lane B refactors.

## 9. Open assumptions

- ⚠ Abstract-base-class scaffold + standalone loop function (vs full composition) — routine engineering choice, revisable in the plan without spec impact.
- ⚠ openai stays on the Agents SDK loop (scaffold-only migration) — treating "move openai to the hive loop" as a future behavior-bearing ticket, not this one.
- ⚠ SSE framing util extracted now for KPR-392 reuse (drop if review deems it premature).
- ⚠ Adapter class names, files, exported test surfaces, and constructor-option shapes preserved (re-exports where files split) — keeps tests and manager wiring stable; a later cosmetic rename is out of scope.
- ⚠ Codex stream-phase status-drop divergence documented as follow-up ticket, not fixed here.
- Note: epic KPR-385 has no `## Decision Register — Canon` section (pre-register epic). Canon consulted instead: CLAUDE.md Provider adapters section; `docs/epics/kpr-345/` specs/plans for KPR-347/348/349/350/351/352/353/354; `docs/providers.md` (KPR-355).
