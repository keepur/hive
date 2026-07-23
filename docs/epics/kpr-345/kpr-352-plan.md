# KPR-352 Implementation Plan — Gemini replication: Interactions API chaining + tool bridge, ADK deleted

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-352-spec.md](./kpr-352-spec.md) (final-round approved @ cab5116) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D6/§D8. Baseline: KPR-346/347/348/349/350/353/354/356 all merged; **all anchors below verified against this worktree's HEAD (epic branch @ cab5116).**

**Goal:** Make `gemini/…` a full Lane B citizen: rewrite the adapter on the Interactions API (`@google/genai`) with a bounded hive-owned dispatch loop executing KPR-348 `BridgedTool[]`, durable resume by `previous_interaction_id` chaining under `SESSION_SEMANTICS.gemini = "server-resumable"` with the existing KPR-350 self-heal arm, delegate Task synthesis via KPR-354 inheritance, `:effort` → `thinking_level` coercion — and `@google/adk` / `runEphemeral` deleted outright (spec §R).

**Architecture:** New `src/agents/provider-adapters/gemini-interactions-adapter.ts` (class `GeminiInteractionsAdapter`, `provider = "gemini"`) replaces `gemini-adk-adapter.ts` wholesale. The adapter mirrors `codex-subscription-adapter.ts`'s structure — per-spawn `ToolBridge` (incl. the KPR-354 `delegateRunner` one-liner), `connect()` in the try, `close()` in the finally, abort checks between rounds and tools — but drives `client.interactions.create` (streaming) instead of raw fetch: round 1 sends the prompt chained off the persisted handle, rounds N+1 send only `function_result` items chained off the prior round's just-minted id. `SESSION_SEMANTICS.gemini` flips to `"server-resumable"` (one line — persistence, normalization, KPR-313 guard, and the KPR-350 self-heal arm all inherit); the adapter tags round-1 400/403/404 failures that carried the persisted handle with a hive sentinel, and `isStaleServerHandleError` grows one regex alternate. `TOOL_EXECUTING_PROVIDERS` completes `{openai, codex, gemini}` and **dissolves** in the same commit as the tools flip (`toolsExecutable: true` literal; the builder's boolean param survives). The manager's nested-delegate switch gains a gemini branch. The Vertex OAuth path is deleted (`resolveGoogleVertexOAuthConfig` orphaned and removed); auth is API-key single path with a pre-request throw pinned to a new `auth`-row alternate.

**Tech stack:** TypeScript strict, vitest beside source, `@google/genai` ^2.13.0 (replaces `@google/adk` ^1.1.0 — the only dependency change), existing test scaffolding (injected-client mock, real `McpServer` over `InMemoryTransport`, module-level adapter mocks in manager tests).

**Decision-register canon honored (per task):**
- *Bridge bound, not redesigned* — `BridgedTool[]` consumed as-is; **zero `tool-bridge.ts` edits** (Task 6 empty-diff check).
- *One flip, one commit* — the adapter rewire (tools advertised + routed) AND the `TOOL_EXECUTING_PROVIDERS` dissolution land in **one commit** (Task 2), with the pre-352 pins (gemini `toolsExecutable: false`, adapter `tools: []`-equivalents) inverted in that commit; openai/codex pins untouched.
- *Set dissolves when all three execute* (KPR-349 canon) — gemini's join completes `LaneBProviderId` ⇒ the constant is **deleted**, `assembleProviderTurn` passes `toolsExecutable: true` unconditionally; the builder's provider-blind boolean param stays (re-arm seam for a hypothetical future non-executing provider — recorded).
- *`SESSION_SEMANTICS` is the single session seam* (KPR-347 one-line rule) — the gemini **value** changes in the same PR as the mechanism (Task 3); unions, other values, `persistsResumableHandle` untouched.
- *Stale-handle self-heal rides KPR-350's arm* — **zero arm changes**; only `isStaleServerHandleError` grows a gemini alternate (Task 3); **no new `FAULT_PATTERNS` row for stale handles, ever** (KPR-350 canon); redaction posture inherited (warn log drops the provider message).
- *Assembly provider-blind* — the only `turn-assembly.ts` edits are the set deletion + the `toolsExecutable` literal + doc comments; `prefix-builder.ts`/`toolkit-section.ts` untouched.
- *codex ≡ gemini at classify sites* — zero `tool-transport.ts` edits (KPR-348/354 one-code-path rule; gemini already emits at every column).
- *Nested delegates* (KPR-354) — session-less/history-less/breaker-invisible/budget-accounted, all inherited; the gemini branch is construction-only (Task 4).
- *Tool wrapper cannot throw; tool faults breaker-invisible; `llmMs` excludes tool time* — loop-local containment (unknown tool / bad streamed args → structured `function_result` text), `llmMs = max(0, durationMs − toolMs)`.

**Spec rulings reflected:** §R ADK deleted (no shim, no compatibility layer — file/class renamed so "Adk" can't lie to the next reader); §D3 tag scoped to round-1-carrying-the-persisted-handle only (mid-turn 4xx stays an ordinary provider fault — duplicate-side-effect guard, both sides pinned); §D5 coercion `none→minimal`/`xhigh→high` warn-once (pass-through rejected: a config-400 on a chained request would self-heal-reset continuity every turn); §D7 missing key = pre-request throw classifying `auth` (codex posture); `store: true` pinned explicitly every round; usage accumulates once per round from `interaction.completed` only; `RunResult.sessionId` is never fabricated — final round's interaction id on success, `request.sessionId ?? ""` on error/abort.

**Plan-time pins (spec §Open assumptions — all resolved, none blocking):**

| ⚠ Spec assumption | Plan-time resolution (probed 2026-07-23 on the dev Mac) |
|---|---|
| `@google/genai` version exposing `interactions` | **Pinned `^2.13.0`** (registry latest). Probe-verified: `client.interactions` exists with `create/get/delete/cancel`; streaming `create(params, options)` overloads return `Promise<Stream<InteractionSSEEvent>>`. |
| Abort-signal plumbing | SDK request options accept `fetchOptions: Omit<RequestInit,"method"\|"body">` — **`fetchOptions.signal`** carries the AbortController signal (d.ts-verified; docs note it takes precedence over `timeout`). Between-event/between-tool checks kept codex-style as belt-and-braces. Also pinned: **`maxRetries: 0`** (SDK-internal retries would mask rate-limit/5xx faults from the breaker). |
| Usage field names | d.ts-verified on `Usage`: **`total_input_tokens` / `total_output_tokens` / `total_cached_tokens`** — carried on the completed event's `interaction.usage`. `cacheReadTokens` maps from `total_cached_tokens`; `costUsd` stays 0 (matrix caveat). |
| Stale-handle status set {400,403,404} | Stays docs+community-sourced at plan time; **refined at Task 0** (fabricated/expired-id probe captures the live status+payload — fold observed statuses into `STALE_HANDLE_STATUSES` verbatim). |
| Manager default-model literal | **Pinned `gemini-3.6-flash`** — verified present in the live `generativelanguage.googleapis.com/v1beta/models` list (plan-time probe with the fleet key; value unprinted). `GEMINI_AGENT_MODEL` overrides. |
| Fleet gemini key status (T0 conditioning) | **`GEMINI_API_KEY` PRESENT** in Honeypot on both instances (`hive/dodi/GEMINI_API_KEY`, `hive/keepur/GEMINI_API_KEY`; presence-checked only). **T0 live legs RUN.** Tier (paid vs free — 55d vs 1d retention, training) recorded at Task 0; production-assignment tier caveat stays ops-level, engine-unenforced. |
| Function-call carriage (plan-time discovery, in-scope) | d.ts: `FunctionCallStep` = `{type:"function_call", id, name, arguments: object}` — **arguments arrive PARSED** (unlike codex's JSON-string), and the result item references `call_id` = the call's `id`. Streaming may deliver args via `arguments_delta` string deltas instead — the adapter harvests **dual-source** (completed `interaction.steps` primary, `step.start` + accumulated `arguments_delta` reconstruction fallback, id-deduped) — the exact KPR-353 spike-Delta-1 precedent. Task 0 records which source the live surface populates. |
| `thinking_level` values | d.ts: `"minimal" \| "low" \| "medium" \| "high"` — matches §D5's coercion table exactly. |
| Error status surfacing | SDK exports `ApiError extends Error { status: number }` — the §D3 tag and the `(status NNN)` fault strings key on it (plus a defensive `{status?: number}` read for mock shapes). Network-level throws pass through verbatim so `ECONNREFUSED` et al. reach the `connect-fail` row. |
| esbuild bundling | `@google/genai` is pure JS ⇒ bundled (NOT added to `build/bundle.ts` externals); `@google/adk` was never external. Task 5 gates on `npm run bundle` green. |

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `gemini-interactions-adapter.ts` — stream consumer (`consumeInteractionStream`/`applyInteractionEvent`/`harvestFunctionCalls` exported), tool advertisement (T1), dispatch loop (T2), stale-tag emission + scoping (T5 adapter half), effort coercion (T7), telemetry/usage keying (T8), abort (T9), missing-key throw (T10 adapter half) — all over an injected `GeminiInteractionsClient` mock; `error-classification.ts` auth-row alternate; `types.ts` semantics pins.
  - Reason: the loop, the tag scoping rule, the coercion table, and usage keying are deterministic contracts fully drivable by scripted event iterables.
  - Minimum assertions: the T1/T2/T5/T7/T8/T9/T10 blocks in "Critical Flows" below, each mapped to a step.

- Integration: **required**
  - Scope: (a) adapter↔bridge round-trip over a **real** in-process `McpServer` via the real `ToolBridge` (tool executes, `function_result` item posted on round 2, stats metered) — replicating the `openai-agents-adapter.test.ts:105-152` fixture patterns (replicate, don't cross-import); (b) **T3** manager-level session flip (persist real interaction id tagged `gemini`, churn-mint block, read-side normalization incl. legacy `""` and `gemini-pilot-` rows); (c) **T4** KPR-313 transition pins (claude↔gemini both directions, openai↔gemini both directions, gemini→codex history-clear — the KPR-350 obligation); (d) **T5** manager-level self-heal (tagged error → existing arm → one fresh retry; narrowness matrix); (e) **T6** assembly flip + dissolution through `assembleProviderTurn`; (f) T10 nested-delegate pins (session-less, id discarded).
  - Reason: the flip, the semantics flip, and the self-heal are cross-module by definition — the payoff of this child is that existing manager machinery fires for gemini unchanged, which only a manager-level test can prove.
  - Harness: **existing** — `agent-manager.test.ts:87-162` module-level adapter mocks (`mockGeminiConstructor`/`mockGeminiRunTurn` — module path swaps to `gemini-interactions-adapter.js`); the KPR-350 self-heal describe (`agent-manager.test.ts:2774-2830`) and KPR-313 describe (`:2350+`) are the shapes to mirror; `session-store.test.ts` fake-collection pattern; `turn-assembly.test.ts` mocked-runner pattern.
  - Minimum assertions: (a)–(f) above.

- E2E: **required** (manual, evidence-recorded — not in `npm run check`)
  - Scope: **T0, the plan's Task-0 live spike** (non-gating for design, gating for shape details) and a post-implementation live turn through the real adapter (Task 6), using the fleet key (`hive/keepur/GEMINI_API_KEY` via `security find-generic-password`).
  - Reason: the Interactions surface is live-unvalidated in this codebase; the spike resolves the delegated shape assumptions (stale statuses, call-carriage source, sibling-chaining) and the closing turn proves the delivered loop on the surface KPR-351-class validation will use.
  - Harness: **setup-required** — dev Mac, network to `generativelanguage.googleapis.com`, key from Honeypot exported into the driver's env (value never printed; interaction ids logged, payloads redacted to shapes). If the key turns out dead/quota-blocked, T0 degrades to the mocks+boundary posture (KPR-348 precedent) and the live legs are **recorded as deferred to the KPR-351-class pass — non-gating** (HUMAN_DIRECTIVE precedent); the docs-sourced status set then ships as-is (worst case documented in spec §Open assumptions: a missed status leaves today's churn-to-TTL behavior — no regression).
  - Minimum assertions: Task 0 legs (a)–(f) recorded in `docs/epics/kpr-345/kpr-352-spike-notes.md`; Task 6 live turn with ≥1 real tool call and a coherent second-turn chained resume.

### Critical Flows

- **T0 — live spike (key-conditioned, key PRESENT):** (a) chained two-turn context recall via `previous_interaction_id`; (b) function-tool round trip — tool advertised, `function_call` arrives (record WHICH source: completed `interaction.steps` vs `step.start`+`arguments_delta`), `function_result` follow-up accepted with the spec's `result: [{type:"text",…}]` shape; (c) `thinking_level` acceptance on `gemini-3.6-flash` (all four values); (d) fabricated + foreign-id resume → capture live status+payload (refines `STALE_HANDLE_STATUSES`); (e) sibling-chaining probe — fork a second child off an already-chained parent (mid-turn-error resume semantics); (f) usage field presence on `interaction.completed`. Shape deltas fold into Task 1 **verbatim** (contingency rules below); wholesale rejection of chaining or function tools = STOP, demote to spec lane.
- **T1 — tool advertisement:** mocked client — create params carry `{type:"function", name, description, parameters}` entries from a fixture `BridgedTool[]`; `store: true` and `system_instruction` present on **every** round's params; empty inventory still posts `tools: []`; the old `tools: []` pins die with the deleted ADK test file (negative-verify: Task 2's flip leg).
- **T2 — dispatch loop:** scripted event iterables — single round (no calls, text delivered); two rounds (round-2 params: `input` = `function_result` items **only**, `previous_interaction_id` = round-1's interaction id, no user prompt re-send); parallel calls (both executed sequentially, both results in ONE follow-up round, deduped by call id); hallucinated tool name / unparseable `arguments_delta` accumulation → structured `function_result` error text, no throw; `maxRounds` exhaustion → `error: "error_max_turns"` (and `maxTurns: 0` ⇒ zero `create` calls); final-reply semantics (round-1 think-aloud reaches `onStream`, `RunResult.text` is the final round's text only); dual-source harvest (completed-steps fixture AND streaming-reconstruction fixture both yield the call; both present → executed once).
- **T3 — session flip:** `SESSION_SEMANTICS.gemini === "server-resumable"` + `persistsResumableHandle` pin flips (types.test.ts); manager persists the final interaction id **tagged `gemini`** on success (inverts the `''+tag` pin at `agent-manager.test.ts:2483-2510`); errored turn returning a different id → churn-mint blocks; read-side returns the handle for tagged gemini rows (inverts `session-store.test.ts:74-77`); `sessionId: ""` tagged rows and legacy `gemini-pilot-` rows resume nothing (existing scrub pins pass unmodified).
- **T4 — KPR-313 transition pins (the KPR-350 obligation):** manager-level claude→gemini and gemini→claude — guard trips, fresh session, `sessionHandoff` set, annotation prepended (pilot variant for →gemini, claude variant for →claude), adopt-branch adopts; openai↔gemini both directions (server-resumable→server-resumable: guard trips on provider mismatch, neither handle survives); gemini→codex trips the existing awaited history-clear (provider-agnostic — no new code, pinned green). Mirrors the KPR-350 T5 describe at `agent-manager.test.ts:2431+`.
- **T5 — self-heal:** *(adapter half)* round-1 create rejection with status 403 while `request.sessionId` present → `RunResult.error` = `gemini interaction resume rejected (status 403): …`; **mid-turn round-N 403 (chained off the just-minted id) → UNTAGGED** `Gemini interaction request failed (403): …` (both sides of the scoping pinned — the tagged side AND the untagged side); round-1 403 with NO sessionId → untagged; round-1 429/500 with sessionId → untagged (`(429)`/`(500)` strings keep breaker weight). *(manager half)* tagged error + tagged-`gemini` session → existing arm fires: exactly one fresh retry (second `runTurn` gets `sessionId: undefined`), warn log **omits the provider message** (redaction pin), success overwrites the row; failed retry → error surfaces, stale handle survives (fresh-attempt error result carries `sessionId: ""` ⇒ no persist); record-once — breaker streak stays 0 in both stale→success and stale→failure shapes; narrowness matrix — the tagged string on a claude or codex route never triggers the arm (semantics gate). Also: `classifyTurnResult` on the tagged string alone would match `auth` — pinned as *the reason the arm must consume it* (assert the arm consumed it, i.e. no breaker record of the first attempt).
- **T6 — assembly flip + dissolution:** `TOOL_EXECUTING_PROVIDERS` no longer exists (compile-time — its import is gone; the membership pin at `turn-assembly.test.ts:110-112` is **retired with the constant**); `assembleProviderTurn` passes `toolsExecutable: true` for **all three** providers (gemini pin inverted, negative-verified; openai/codex pins pass unmodified); toolkit/skills/memory-tool-line rendering for `toolsExecutable: true` is already pinned provider-blind at the builder (KPR-349) — no `prefix-builder.ts` test edits.
- **T7 — effort:** `resolveProviderModel("gemini/gemini-3.6-flash:high")` route carries `reasoningEffort: "high"` (route-shape pin); adapter sends `generation_config: {thinking_level: "high"}`; `:none` → `minimal` and `:xhigh` → `high` coerced with warn-once per (agent, value); no suffix ⇒ **no** `generation_config` key in params; manager passes `route.reasoningEffort` to both parent and nested constructions (constructor-options pins).
- **T8 — telemetry:** `llmMs = max(0, durationMs − toolMs)` with nonzero `bridge.stats.toolMs`; `toolCalls`/`toolSummary` from `bridge.stats`; usage accumulated from `interaction.completed` only — a stream carrying usage-shaped fields on `step.stop` (`step_usage`) and event-level `metadata.total_usage` counts the completed value once (353's multi-count lesson); usage summed across two rounds; `cacheReadTokens` from `total_cached_tokens`; `costUsd === 0`.
- **T9 — abort:** mid-stream and mid-tool abort → `aborted: true`, `RunResult.sessionId === request.sessionId ?? ""` (never the mid-turn minted id), `bridge.close()` (prototype spy) called on every path incl. the missing-key throw path, no second create, no unhandled rejections.
- **T10 — auth + nested:** missing key (`apiKey` unset, `env: {}`) → pre-request throw with the exact message → `classifyThrown` = `auth` via the new row alternate (pinned per-alternate in `error-classification.test.ts`, the row's standing rule); nested gemini delegate — manager constructs `GeminiInteractionsAdapter` with nested assembly, `runTurn` receives **no `sessionId`**, nested result's id is discarded, `sessionStore.set` untouched by the nested turn (KPR-350 T6 / KPR-354 mirror; inverts the `mockGeminiConstructor` not-called pin at `agent-manager.test.ts:3472`).

### Regression Surface

- **Other adapters:** `openai-agents-adapter.ts`, `codex-subscription-adapter.ts`, `claude-agent-adapter.ts` + their test files — zero edits, suites pass unmodified (`openai-agents-adapter.ts` keeps its `envValue`/`isProviderAuthError` imports — those helpers stay).
- **Bridge/executor/transport/gate/prompt:** `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts`, `archetype-gate.ts`, `skill-index.ts`, `prefix-builder.ts`, `toolkit-section.ts`, `agent-runner.ts` — zero edits (Task 6 empty-diff); KPR-349's golden prefix suite passes untouched by construction.
- **Session plumbing:** `session-store.ts` **source** untouched (`FABRICATED_SESSION_ID` keeps `gemini-pilot-`); `turn-history-store.ts` untouched (gemini never gets a historyStore); write-side persist rules / churn-mint / KPR-313 guard logic-ordering (R7 window) / `finalizeSpawnResult` untouched — Task 3 changes only the matcher regex and the `SESSION_SEMANTICS` value. Every existing openai/codex KPR-313 and KPR-350 pin passes **unmodified**; only gemini-persist pins invert.
- **Breaker:** `error-classification.ts` gains exactly one auth-row alternate; `HARD_FAULT_KINDS`, row order, `TurnAssemblyError` boundary untouched; all existing classification pins pass unmodified.
- **Voice / Lane A / router:** untouched — gemini routes never enter the router-on path (pilot gate), `passthrough-providers.ts` untouched, `src/llm/` vision sidecar and `config.gemini.visionModel` untouched.
- **Config:** `config.ts` untouched (`gemini.apiKey`/`agentModel` already exist at `config.ts:367-371`); `index.ts` untouched (no new store to wire).

### Commands

- Fast loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/gemini-interactions-adapter.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/types.test.ts src/agents/provider-adapters/error-classification.test.ts src/agents/agent-manager.test.ts src/agents/session-store.test.ts`
- Full gate (every chunk commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.
- Bundle gate (Task 5): `npm run bundle` — exit 0, `pkg/server.min.js` produced, qdrant-stub guard green.
- E2E: scratch tsx drivers on the dev Mac (Tasks 0 and 6), evidence in `kpr-352-spike-notes.md` + the PR description.

### Harness Requirements

- `npm ci` in the worktree if `node_modules` absent (Task 1 runs `npm install` for the dependency swap — commit `package.json` + `package-lock.json`). Node 22/24 (dev-mode Node 26 broken per KPR-344).
- Unit/integration tests run with **no** live credentials, no network, no Mongo. **Guardrail: never construct `GeminiInteractionsAdapter` in a test without BOTH an injected `client` mock and an explicit `apiKey`** (the dev Mac's keychain holds a live key and future shells may export `GEMINI_API_KEY` — a missed injection would build a real SDK client). The `makeAdapter` helper in the new test file bakes both in; keep using it. The missing-key test passes `env: {}` (the adapter's env seam) — never rely on the ambient env being clean.
- Manager tests keep module-level adapter mocks (path swap: `vi.mock("./provider-adapters/gemini-interactions-adapter.js", …)`) — no real adapter, no SDK surface.
- Live legs (Tasks 0, 6): dev Mac, key via `export GEMINI_API_KEY=$(security find-generic-password -s hive/keepur/GEMINI_API_KEY -w)` inside the driver invocation only — value never printed, never committed. Spike driver runs from a scratchpad dir with its own `npm i @google/genai@2.13.0` (Task 0 runs before the worktree has the dep).

### Non-Required Rationale

- (none — all three groups required.)

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch — **and specifically if Task 0 shows the Interactions surface rejects chaining or function tools wholesale** — demote the ticket to the spec lane. Do not improvise an alternative protocol.
- Negative-verify discipline (operator standard) — six mandatory legs, each run against weakened code with the failing output recorded before restoring:
  1. **Tools flip (Task 2):** temporarily send `tools: []` in the adapter's create params → T1 advertisement tests fail → restore.
  2. **Dissolution (Task 2):** temporarily restore `const TOOL_EXECUTING_PROVIDERS = new Set(["openai","codex"])` + the `.has()` gate → the gemini `toolsExecutable: true` pin fails → restore.
  3. **Session flip (Task 3):** temporarily revert `SESSION_SEMANTICS.gemini` to `"stateless-replay"` → T3 persist + read-side pins and the types.test pin fail → restore.
  4. **Stale-tag scoping (Task 3):** temporarily drop the `round === 1 && persistedHandle` condition (tag every 4xx) → the T5 mid-turn-untagged pin fails → restore.
  5. **Matcher alternate (Task 3):** temporarily remove the gemini alternate from `isStaleServerHandleError` → the T5 manager heal test fails (no retry fires) → restore.
  6. **Usage keying (Task 1):** temporarily accumulate `step_usage` in the `step.stop` branch too → the T8 completed-only test fails (multi-count) → restore.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/epics/kpr-345/kpr-352-spike-notes.md` | create (Task 0) | T0 live-spike evidence + spike-outcome dependency table (KPR-348/353 precedent) |
| `package.json` / `package-lock.json` | modify (Task 1 adds `@google/genai`; Task 2 drops `@google/adk`) | dependency swap |
| `src/agents/provider-adapters/gemini-interactions-adapter.ts` | create (Task 1) | §D1/§D3-tag/§D5/§D7/§D8 — the full rewrite |
| `src/agents/provider-adapters/gemini-interactions-adapter.test.ts` | create (Task 1) | T1/T2, T5 adapter half, T7/T8/T9, T10 adapter half + bridge integration |
| `src/agents/provider-adapters/error-classification.ts` | modify (Task 1) | one `auth`-row alternate: `api.?key is not available` — nothing else |
| `src/agents/provider-adapters/error-classification.test.ts` | modify (Task 1) | per-alternate regression pin (the row's standing rule) |
| `src/agents/provider-adapters/gemini-adk-adapter.ts` | **DELETE** (Task 2) | §R — ADK dies |
| `src/agents/provider-adapters/gemini-adk-adapter.test.ts` | **DELETE** (Task 2) | dies with it (its KPR-347 `tools: []` pins are superseded by T1's inversions) |
| `src/agents/provider-adapters/turn-assembly.ts` | modify (Task 2 ONLY, flip commit) | delete `TOOL_EXECUTING_PROVIDERS`; `toolsExecutable: true` literal + doc comments — nothing else |
| `src/agents/provider-adapters/turn-assembly.test.ts` | modify (Task 2) | T6 pins (set pin retired, gemini pin inverted, openai/codex green) |
| `src/agents/provider-adapters/oauth-credentials.ts` | modify (Task 2) | delete `resolveGoogleVertexOAuthConfig` + now-orphaned Vertex helpers/types (§D7) |
| `src/agents/agent-manager.ts` | modify (Tasks 2, 3, 4) | route `reasoningEffort` + import swap + construction options + default-model literal (2); `isStaleServerHandleError` alternate (3); nested gemini branch (4) |
| `src/agents/agent-manager.test.ts` | modify (Tasks 2, 3, 4) | mock swap + constructor pins (2); T3/T4/T5 manager halves (3); T10 nested pins (4) |
| `src/agents/provider-adapters/types.ts` | modify (Task 3) | `SESSION_SEMANTICS.gemini` value (one line) + §D2/§D9 doc comments |
| `src/agents/provider-adapters/types.test.ts` | modify (Task 3) | gemini `persistsResumableHandle` pin flips true |
| `src/agents/session-store.test.ts` | modify (Task 3) | tagged-gemini read-side pin inverted; scrub pins green |
| `CLAUDE.md` | modify (Task 5) | §D9 riders — provider-adapters paragraph + dependency note |

**NOT touched (spec Integration table):** `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts`, `archetype-gate.ts`, `skill-index.ts`, `prefix-builder.ts`, `toolkit-section.ts`, `agent-runner.ts`, `session-store.ts` (source), `turn-history-store.ts`, `openai-agents-adapter.ts` (+test), `codex-subscription-adapter.ts` (+test), `claude-agent-adapter.ts`, `passthrough-providers.ts`, `config.ts`, `index.ts`, `build/bundle.ts`, `SESSION_SEMANTICS` beyond the gemini line, KPR-350 arm logic/ordering (R7 window), KPR-313 guard, `finalizeSpawnResult` rules, breaker acquire/record, openai/codex manager branches.

---

## Task 0 (Chunk 0): Live spike — shape resolution (key resolves ⇒ live legs run; non-gating for design)

**Files:**
- Create: `docs/epics/kpr-345/kpr-352-spike-notes.md`

The fleet key is PRESENT (plan-time presence check, both instances) — the live legs run. Unlike KPR-353's T0, this spike is **non-gating for the design** (mocks carry the contract per the KPR-348 evidence-gap canon) but **gating for shape details**: statuses, call-carriage source, and usage field names observed here are folded into Task 1 verbatim. Secret values never printed; interaction payloads logged as shapes/ids only.

- [ ] **Step 0.1: Write and run the spike driver (session scratchpad, never committed)**

`<scratchpad>/kpr352-spike/` — `npm init -y && npm i @google/genai@2.13.0`, then `kpr352-spike.ts` run with `GEMINI_API_KEY=$(security find-generic-password -s hive/keepur/GEMINI_API_KEY -w) npx tsx kpr352-spike.ts`. Complete driver:

```typescript
/** KPR-352 T0 spike — Gemini Interactions API capability probe.
 *  Legs: (a) previous_interaction_id chaining recalls context; (b) function
 *  tools round-trip (+ WHERE calls surface in the stream); (c) thinking_level
 *  acceptance on the pinned default model; (d) stale/foreign-id resume status
 *  capture; (e) sibling-chaining fork off an already-chained parent;
 *  (f) usage fields on interaction.completed.
 *  NEVER COMMIT. No secret values printed. */
import { GoogleGenAI, ApiError } from "@google/genai";

const MODEL = process.env.SPIKE_MODEL ?? "gemini-3.6-flash"; // plan-time pinned default
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("export GEMINI_API_KEY from Honeypot first");
const client = new GoogleGenAI({ apiKey });

const TOOL = {
  type: "function" as const,
  name: "get_current_time",
  description: "Return the current time in ISO-8601 format.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

interface RoundOut {
  id?: string;
  text: string;
  events: Set<string>;
  deltaTypes: Set<string>;
  completedSteps: unknown[];
  startedStepTypes: string[];
  argumentsDeltaSeen: boolean;
  usage?: Record<string, unknown>;
}

async function run(label: string, params: Record<string, unknown>): Promise<RoundOut> {
  const out: RoundOut = { text: "", events: new Set(), deltaTypes: new Set(), completedSteps: [], startedStepTypes: [], argumentsDeltaSeen: false };
  const stream = await (client.interactions as unknown as {
    create(p: Record<string, unknown>, o: Record<string, unknown>): Promise<AsyncIterable<Record<string, unknown>>>;
  }).create({ model: MODEL, stream: true, store: true, ...params }, { maxRetries: 0 });
  for await (const ev of stream) {
    const type = String(ev.event_type ?? "?");
    out.events.add(type);
    const interaction = ev.interaction as Record<string, unknown> | undefined;
    if ((type === "interaction.created" || type === "interaction.completed") && typeof interaction?.id === "string") out.id = interaction.id;
    if (type === "interaction.completed") {
      out.usage = interaction?.usage as Record<string, unknown> | undefined;
      if (Array.isArray(interaction?.steps)) out.completedSteps = interaction.steps;
    }
    if (type === "step.start") out.startedStepTypes.push(String((ev.step as Record<string, unknown> | undefined)?.type));
    if (type === "step.delta") {
      const delta = ev.delta as Record<string, unknown> | undefined;
      out.deltaTypes.add(String(delta?.type));
      if (delta?.type === "text") out.text += String(delta.text ?? "");
      if (delta?.type === "arguments_delta") out.argumentsDeltaSeen = true;
    }
  }
  console.log(`\n=== ${label}`);
  console.log("id:", out.id, "| events:", [...out.events].sort().join(","), "| deltas:", [...out.deltaTypes].sort().join(","));
  console.log("completed step types:", out.completedSteps.map((s) => (s as { type?: string }).type).join(","), "| step.start types:", out.startedStepTypes.join(","), "| args-delta seen:", out.argumentsDeltaSeen);
  console.log("usage keys:", out.usage ? Object.keys(out.usage).join(",") : "NONE", "| text:", JSON.stringify(out.text.slice(0, 120)));
  return out;
}

async function expectFailure(label: string, params: Record<string, unknown>): Promise<void> {
  try {
    await run(label, params);
    console.log(`${label}: UNEXPECTED SUCCESS`);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : (err as { status?: number }).status;
    console.log(`${label}: status=${status} message(first 300)=${String((err as Error).message).slice(0, 300)}`);
  }
}

// Leg (a): chaining recalls context.
const a1 = await run("LEG a1 — fresh", { input: "My favorite color is teal. Reply OK." });
const a2 = await run("LEG a2 — chained recall", { input: "What is my favorite color? One word.", previous_interaction_id: a1.id });
if (!/teal/i.test(a2.text)) console.log("LEG a: RECALL FAILED — chaining does not carry context?!");

// Leg (b): function tool round trip (also feeds the harvest-source question).
const b1 = await run("LEG b1 — tool call", { input: "What time is it right now? Use your tool.", tools: [TOOL] });
const call = [...b1.completedSteps, ...[]].find((s) => (s as { type?: string }).type === "function_call") as { id?: string; name?: string; arguments?: unknown } | undefined;
if (!call?.id) console.log("LEG b: function_call NOT in completed.steps — reconstruction source is authoritative (record step.start/arguments_delta observations above)");
const callId = call?.id ?? "MANUAL-FILL-FROM-STREAM";
const b2 = await run("LEG b2 — function_result follow-up", {
  input: [{ type: "function_result", name: "get_current_time", call_id: callId, result: [{ type: "text", text: new Date().toISOString() }] }],
  previous_interaction_id: b1.id,
  tools: [TOOL],
});
console.log("LEG b2 final text mentions a time:", /\d{4}|\d{1,2}:\d{2}/.test(b2.text));

// Leg (c): thinking_level acceptance.
for (const level of ["minimal", "low", "medium", "high"]) {
  try {
    await run(`LEG c — thinking_level=${level}`, { input: "Reply OK.", generation_config: { thinking_level: level } });
  } catch (err) {
    console.log(`LEG c thinking_level=${level}: REJECTED status=${(err as { status?: number }).status}`);
  }
}

// Leg (d): stale/foreign id resume — capture the live status set (§D3 refinement).
await expectFailure("LEG d1 — fabricated id", { input: "hello", previous_interaction_id: "interactions/nonexistent-kpr352-probe" });
await expectFailure("LEG d2 — malformed id", { input: "hello", previous_interaction_id: "not-even-shaped-like-an-id" });

// Leg (e): sibling chaining — fork a second child off an already-chained parent.
const e2 = await run("LEG e — sibling fork off a1 (a2 already chained from it)", { input: "What is my favorite color? One word.", previous_interaction_id: a1.id });
console.log("LEG e sibling fork recall:", /teal/i.test(e2.text) ? "OK" : "FAILED");

console.log("\nSPIKE COMPLETE — record verdicts in kpr-352-spike-notes.md");
```

- [ ] **Step 0.2: Record the outcome in `docs/epics/kpr-345/kpr-352-spike-notes.md`**

Structure per `kpr-353-spike-notes.md`: environment header (worktree/HEAD/node/date/model/key-source *name* only), per-leg verdict table, and a **spike-outcome dependency table**:

| Spike leg | Consumed by | Verdict | Notes |
|---|---|---|---|
| (a) chaining recalls context | Task 1 loop + Task 3 flip | … | |
| (b) function tools + result shape; call-carriage source | Task 1 harvest (which source populates) | … | observed step/field names verbatim |
| (c) thinking_level per model | Task 1 §D5 map | … | rejected levels ⇒ documented vendor-400 config fault |
| (d) stale-id status+payload | Task 1 `STALE_HANDLE_STATUSES` + Task 3 matcher | … | fold observed statuses verbatim |
| (e) sibling fork | §Edge "errored/aborted mid-loop" resume semantics | … | |
| (f) usage keys | Task 1 usage mapping | … | |

**Contingency rules (write them into the notes):** field-name/status deltas fold into Task 1 **verbatim** — in-scope adjustments, not redesigns. If leg (b) shows calls surface ONLY via streaming reconstruction, the dual-source harvest already covers it (record which source is live). If leg (d) returns statuses outside {400,403,404}, replace the set with the observed values. **If chaining (a/e) or function tools (b) are rejected wholesale: STOP, demote to the spec lane.** If the key is dead/quota-blocked: record it, run Tasks 1–5 on mocks (KPR-348 posture), mark live legs deferred to the KPR-351-class pass — non-gating.

- [ ] **Step 0.3: Commit the spike notes**

```bash
git add docs/epics/kpr-345/kpr-352-spike-notes.md
git commit -m "KPR-352: T0 live spike — Interactions chaining/function-tool/thinking-level/stale-status capability record"
```

---

## Task 1 (Chunk 1): `GeminiInteractionsAdapter` — the rewrite, standalone beside the old adapter

**Files:**
- Modify: `package.json` (+ lockfile) — add `"@google/genai": "^2.13.0"` to `dependencies` (run `npm install @google/genai@^2.13.0`)
- Create: `src/agents/provider-adapters/gemini-interactions-adapter.ts`
- Create: `src/agents/provider-adapters/gemini-interactions-adapter.test.ts`
- Modify: `src/agents/provider-adapters/error-classification.ts` (auth-row alternate ONLY)
- Modify: `src/agents/provider-adapters/error-classification.test.ts` (per-alternate pin)

Standalone and check-green by construction: nothing routes to the new adapter until Task 2, and the old ADK adapter (still routed) is untouched. The auth alternate lands here because the new adapter's missing-key throw is pinned against it in the same commit (row standing rule: alternates land with their sentinel).

- [ ] **Step 1.1: Add the dependency**

```bash
npm install @google/genai@^2.13.0
```

Expected: `package.json` gains the dep; `@google/adk` still present (removed in Task 2).

- [ ] **Step 1.2: Create `src/agents/provider-adapters/gemini-interactions-adapter.ts`**

Complete file (fold Task-0-observed field/status deltas in verbatim — the spike notes are the authority):

```typescript
import { ApiError, GoogleGenAI } from "@google/genai";
import type { RunResult } from "../agent-runner.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest, ReasoningEffort } from "./types.js";
import { envValue } from "./oauth-credentials.js";
import { createLogger } from "../../logging/logger.js";
import { ToolBridge, type BridgedTool } from "./tool-bridge.js";

const log = createLogger("gemini-adapter");

/** KPR-352 plan-time pin: Interactions-supported default (verified against the
 *  live model list 2026-07-23). GEMINI_AGENT_MODEL / agent model override. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
/** §D1: mirrors the codex adapter's round bound when resourceLimits is absent. */
const DEFAULT_MAX_ROUNDS = 10;

/**
 * §D3: statuses that mark a ROUND-1 resume-carrying create failure as a stale
 * persisted handle. Docs+community-sourced {400,403,404}; refined at T0
 * (spike leg d) — 429/5xx are deliberately excluded: rate limits and server
 * errors on a resume-carrying request are provider faults that must keep
 * breaker weight and must not cost thread context (KPR-350 narrowness).
 */
const STALE_HANDLE_STATUSES = new Set([400, 403, 404]);

/** §D3: hive sentinel — isStaleServerHandleError (agent-manager.ts) matches
 *  this prefix; the KPR-350 arm consumes it before it can reach the breaker
 *  (a raw stale-chain 403 would otherwise pattern-match the auth row and trip
 *  the gemini breaker as a phantom auth outage). */
const STALE_HANDLE_SENTINEL = "gemini interaction resume rejected";

/** §D5: :effort → thinking_level. minimal/low/medium/high pass through;
 *  none→minimal, xhigh→high coerced (warn-once). Coercion, not vendor-400
 *  pass-through: a config-400 on a chained round-1 request would be
 *  tag-eligible and silently reset thread continuity EVERY turn. */
const THINKING_LEVELS: Record<ReasoningEffort, "minimal" | "low" | "medium" | "high"> = {
  minimal: "minimal",
  none: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};
const COERCED_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(["none", "xhigh"]);
/** Warn-once per (agent, value) — module-level because adapters are per-spawn. */
const coercionWarned = new Set<string>();

/**
 * Narrow injection seam over @google/genai `client.interactions.create`
 * (streaming form only). The SDK's overloads key on `stream: true` literal
 * types in richly-typed param unions the adapter assembles dynamically, so
 * the default impl centralizes one structured cast; tests inject a scripted
 * iterable and never touch the SDK.
 */
export interface GeminiInteractionsClient {
  create(
    params: Record<string, unknown>,
    options: { fetchOptions: { signal: AbortSignal }; maxRetries: number },
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

function buildDefaultClient(apiKey: string): GeminiInteractionsClient {
  // Method call through the same object preserves `this` binding.
  return new GoogleGenAI({ apiKey }).interactions as unknown as GeminiInteractionsClient;
}

export interface GeminiInteractionsAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  /** config.gemini.apiKey (env-first via config.ts); falls back to
   *  GOOGLE_GENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY (§D7). */
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  /** Test seam — tests MUST always set this (harness guardrail: the dev
   *  machine holds live gemini credentials). */
  client?: GeminiInteractionsClient;
  /** Test seam for key resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** One harvested function call, both stream sources normalized (§D1). */
export interface GeminiFunctionCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Set when streamed arguments_delta text failed JSON.parse — containment. */
  argumentsError?: string;
}

export interface GeminiRoundState {
  text: string;
  interactionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** interaction.completed's interaction.steps (authoritative when present). */
  completedSteps: unknown[];
  /** step.start snapshots by step index (streaming reconstruction source). */
  startedSteps: Map<number, Record<string, unknown>>;
  /** Accumulated arguments_delta text by step index. */
  argumentsByIndex: Map<number, string>;
  sawCompleted: boolean;
}

export class GeminiInteractionsAdapter implements AgentProviderAdapter {
  readonly provider = "gemini" as const;

  private currentAbortController: AbortController | null = null;
  private aborted = false;

  constructor(private readonly options: GeminiInteractionsAdapterOptions) {}

  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    /** §D1: error/abort fallback — NEVER a fabricated id. Under
     *  server-resumable semantics a fabricated id would be persisted and later
     *  resumed as garbage; the gemini-pilot- fabrication died with this
     *  rewrite. "" persists nothing (finalize's falsy guard); an unchanged
     *  resumed id is a harmless same-id TTL refresh, and the pre-error chain
     *  state resumes next turn (deliberately NOT the mid-turn minted id). */
    const fallbackSessionId = request.sessionId ?? "";

    // KPR-352 (§D1): per-spawn tool bridge — the codex adapter's exact
    // construction (codex-subscription-adapter.ts:126-136), including the
    // KPR-354 §D6 delegateRunner one-liner. connect() inside the try
    // (fail-soft per server); close() in the finally.
    const bridge = new ToolBridge({
      inventory: this.options.assembly.toolInventory,
      inProcessServers: this.options.assembly.inProcessServers,
      gate: this.options.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.options.name,
      sessionCwd: this.options.assembly.sessionCwd,
      skillIndex: this.options.assembly.skillIndex,
      delegateRunner: this.options.assembly.delegateTurnRunner, // KPR-354 (§D6)
    });

    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    const abortedResult = (): RunResult =>
      this.buildResult({
        text: "",
        sessionId: fallbackSessionId,
        durationMs: Date.now() - startedAt,
        streamed,
        aborted: true,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });

    try {
      // §D7: API-key single path (Vertex OAuth deleted — Interactions is not
      // served on Vertex). Pre-request throw → classifyThrown "auth" (row
      // alternate pinned) → breaker → honest outage; `hive credentials add
      // GEMINI_API_KEY` recovers next spawn. The finally below still runs
      // bridge.close() on this path (T9).
      const env = this.options.env ?? process.env;
      const apiKey =
        this.options.apiKey ||
        envValue("GOOGLE_GENAI_API_KEY", env) ||
        envValue("GEMINI_API_KEY", env) ||
        envValue("GOOGLE_API_KEY", env);
      if (!apiKey) {
        throw new Error(
          "Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY",
        );
      }
      const client = this.options.client ?? buildDefaultClient(apiKey);

      const bridged = await bridge.connect();
      const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
      // §D1: BridgedTool[] → Interactions function tools (FunctionT shape —
      // name/cap edges are bridge-owned, KPR-348/349).
      const toolPayloads = bridged.map((bt) => ({
        type: "function" as const,
        name: bt.name,
        description: bt.description,
        parameters: bt.inputSchema,
      }));

      const thinkingLevel = this.resolveThinkingLevel();

      /** §D1: previous_interaction_id does double duty — round 1 resumes the
       *  persisted handle (undefined ⇒ fresh thread); rounds N+1 chain the
       *  prior round's just-minted id and send ONLY the function_result
       *  items (the server holds the rest). */
      let chainHead: string | undefined = request.sessionId || undefined;
      let input: unknown = request.prompt;
      let finalText = "";
      let lastInteractionId: string | undefined;

      // maxTurns 0 ⇒ zero create calls ⇒ error_max_turns (codex-identical
      // divergence pin: a zero budget honestly means "no model rounds").
      const maxRounds = request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS;
      let round = 0;
      for (;;) {
        round += 1;
        if (round > maxRounds) {
          return this.buildResult({
            text: "",
            sessionId: fallbackSessionId,
            durationMs: Date.now() - startedAt,
            streamed,
            aborted: false,
            error: "error_max_turns",
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            toolStats: bridge.stats,
          });
        }
        if (this.aborted || abortController.signal.aborted) return abortedResult();

        let stream: AsyncIterable<Record<string, unknown>>;
        try {
          stream = await client.create(
            {
              model: this.options.model || DEFAULT_GEMINI_MODEL,
              // Documented: system_instruction does NOT persist across chained
              // interactions — re-sent every round (§D2).
              system_instruction: request.systemPromptOverride ?? this.options.assembly.instructions,
              input,
              stream: true,
              // §D2 posture pin: chaining prerequisite — pinned, not
              // defaulted (the codex surface's hard-enforced opposite is the
              // live precedent for defaults flipping).
              store: true,
              ...(chainHead ? { previous_interaction_id: chainHead } : {}),
              ...(thinkingLevel ? { generation_config: { thinking_level: thinkingLevel } } : {}),
              tools: toolPayloads,
            },
            // maxRetries 0: single-attempt by design — retry policy belongs
            // to the breaker/outage layer; SDK-internal retries would mask
            // rate-limit/5xx faults from classification.
            { fetchOptions: { signal: abortController.signal }, maxRetries: 0 },
          );
        } catch (error) {
          throw this.describeCreateError(error, round, request.sessionId || undefined);
        }

        // Text deltas from EVERY round reach onStream (intermediate
        // think-aloud); RunResult.text is the final round's text only (§D1
        // final-reply semantics, 353 parity).
        const state = await consumeInteractionStream(stream, request.onStream, () => this.aborted);
        totals.inputTokens += state.inputTokens;
        totals.outputTokens += state.outputTokens;
        totals.cacheReadTokens += state.cacheReadTokens;
        if (state.interactionId) lastInteractionId = state.interactionId;
        finalText = state.text;

        if (this.aborted || abortController.signal.aborted) return abortedResult();

        const calls = harvestFunctionCalls(state);
        if (calls.length === 0) break;
        if (!state.interactionId) {
          // Can't chain the function_result round without the parent id.
          throw new Error("Gemini interaction stream ended without an interaction id");
        }

        // Sequential by design (KPR-353 pin: in-process handlers are not
        // concurrency-audited under one turn). All results ship in ONE
        // follow-up round.
        const resultItems: unknown[] = [];
        for (const call of calls) {
          if (this.aborted || abortController.signal.aborted) return abortedResult();
          const output = await executeFunctionCall(call, bridgedByName);
          resultItems.push({
            type: "function_result",
            name: call.name,
            call_id: call.id,
            result: [{ type: "text", text: output }],
          });
        }
        chainHead = state.interactionId;
        input = resultItems;
      }

      const durationMs = Date.now() - startedAt;
      if (this.aborted || abortController.signal.aborted) return abortedResult();

      return this.buildResult({
        // §D1: the FINAL round's interaction id — it transitively contains
        // the whole turn. A success without an id persists nothing (the
        // finalize path's falsy guard) rather than persisting a lie.
        text: finalText,
        sessionId: lastInteractionId ?? fallbackSessionId,
        durationMs,
        streamed,
        aborted: false,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (this.isAbortError(error, abortController)) {
        return this.buildResult({
          text: "",
          sessionId: fallbackSessionId,
          durationMs,
          streamed,
          aborted: true,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          toolStats: bridge.stats,
        });
      }
      return this.buildResult({
        text: "",
        sessionId: fallbackSessionId,
        durationMs,
        streamed,
        aborted: false,
        error: errorMessage(error),
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });
    } finally {
      await bridge.close(); // never throws/rejects (KPR-348 advisory 1)
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  abort(): void {
    this.aborted = true;
    this.currentAbortController?.abort();
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  /**
   * §D3: deterministic stale-handle detection — the adapter KNOWS whether the
   * failing create carried the persisted handle: round 1 is the only round
   * that chains request.sessionId; intra-turn rounds chain the prior round's
   * just-minted id, which cannot be a stale PERSISTED handle — tagging those
   * would let the manager's fresh-retry arm re-run the whole turn and
   * re-execute already-executed tool calls (duplicate sends/writes). Tagged
   * strings are the KPR-350 arm's food; everything else keeps its status text
   * for FAULT_PATTERNS. Network-level throws pass through VERBATIM so
   * ECONNREFUSED et al. reach the connect-fail row.
   */
  private describeCreateError(error: unknown, round: number, persistedHandle: string | undefined): Error {
    const status = extractStatus(error);
    const message = errorMessage(error);
    if (round === 1 && persistedHandle && status !== undefined && STALE_HANDLE_STATUSES.has(status)) {
      return new Error(`${STALE_HANDLE_SENTINEL} (status ${status}): ${message}`);
    }
    if (status !== undefined) {
      return new Error(`Gemini interaction request failed (${status}): ${message}`);
    }
    return error instanceof Error ? error : new Error(message);
  }

  /** §D5: no suffix ⇒ no generation_config sent (model-default thinking —
   *  the effort-less-codex parallel). */
  private resolveThinkingLevel(): string | undefined {
    const effort = this.options.reasoningEffort;
    if (!effort) return undefined;
    const level = THINKING_LEVELS[effort];
    if (COERCED_EFFORTS.has(effort)) {
      const key = `${this.options.name}:${effort}`;
      if (!coercionWarned.has(key)) {
        coercionWarned.add(key);
        log.warn("Gemini :effort suffix coerced to nearest thinking_level (KPR-352 §D5)", {
          agent: this.options.name,
          effort,
          thinkingLevel: level,
        });
      }
    }
    return level;
  }

  private isAbortError(error: unknown, abortController: AbortController): boolean {
    if (this.aborted || abortController.signal.aborted) return true;
    if (!error || typeof error !== "object") return false;
    const maybeAbort = error as { name?: unknown; code?: unknown };
    return maybeAbort.name === "AbortError" || maybeAbort.code === "ABORT_ERR";
  }

  private buildResult({
    text,
    sessionId,
    durationMs,
    streamed,
    aborted,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    error,
    toolStats,
  }: {
    text: string;
    sessionId: string;
    durationMs: number;
    streamed: boolean;
    aborted: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    error?: string;
    toolStats?: Readonly<{ toolCalls: number; toolMs: number; perTool: Map<string, number> }>;
  }): RunResult {
    const toolMs = toolStats?.toolMs ?? 0;
    const toolCalls = toolStats?.toolCalls ?? 0;
    const toolSummary =
      toolStats && toolStats.perTool.size > 0
        ? [...toolStats.perTool.entries()].map(([n, c]) => `${n}×${c}`).join(", ")
        : "none";
    return {
      text,
      sessionId,
      costUsd: 0, // no per-token billing wired — KPR-355 matrix caveat (Lane A precedent)
      durationMs,
      // §D8 (KPR-348 §D8 rule): the breaker's p95 window samples llmMs —
      // folding tool time in would let slow-but-healthy tools trip a healthy
      // gemini endpoint. Clamped for degenerate/mocked timing.
      llmMs: Math.max(0, durationMs - toolMs),
      toolMs,
      toolCalls,
      toolSummary,
      streamed,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted,
      ...(error ? { error } : {}),
    };
  }
}

/**
 * Consume one round's Interactions SSE stream. Usage accumulates ONCE per
 * round from interaction.completed only — step.stop step_usage and event
 * metadata never accumulate (353's multi-count lesson, T8-pinned). Thought
 * summary/signature deltas are ignored: signatures are server-managed under
 * store:true chaining and never touch hive (§D1).
 */
export async function consumeInteractionStream(
  stream: AsyncIterable<Record<string, unknown>>,
  onStream: ((chunk: string) => void) | undefined,
  isAborted: () => boolean = () => false,
): Promise<GeminiRoundState> {
  const state: GeminiRoundState = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    completedSteps: [],
    startedSteps: new Map(),
    argumentsByIndex: new Map(),
    sawCompleted: false,
  };
  for await (const event of stream) {
    if (isAborted()) break;
    applyInteractionEvent(event, state, onStream);
  }
  return state;
}

export function applyInteractionEvent(
  event: Record<string, unknown>,
  state: GeminiRoundState,
  onStream?: (chunk: string) => void,
): void {
  const type = stringField(event, "event_type");

  if (type === "step.delta") {
    const delta = objectField(event, "delta");
    const deltaType = stringField(delta, "type");
    if (deltaType === "text") {
      const text = stringField(delta, "text") ?? "";
      if (!text) return;
      state.text += text;
      onStream?.(text);
      return;
    }
    if (deltaType === "arguments_delta") {
      const index = numberField(event, "index");
      if (index === undefined) return;
      state.argumentsByIndex.set(
        index,
        (state.argumentsByIndex.get(index) ?? "") + (stringField(delta, "arguments") ?? ""),
      );
    }
    return; // thought_summary / thought_signature / media deltas: ignored
  }

  if (type === "step.start") {
    const step = objectField(event, "step");
    const index = numberField(event, "index");
    if (step && index !== undefined) state.startedSteps.set(index, step);
    return;
  }

  if (type === "interaction.created" || type === "interaction.completed") {
    const interaction = objectField(event, "interaction");
    const id = stringField(interaction, "id");
    if (id) state.interactionId = id;
    if (type !== "interaction.completed") return;
    state.sawCompleted = true;
    const usage = objectField(interaction, "usage");
    if (usage) {
      state.inputTokens += numberField(usage, "total_input_tokens") ?? 0;
      state.outputTokens += numberField(usage, "total_output_tokens") ?? 0;
      state.cacheReadTokens += numberField(usage, "total_cached_tokens") ?? 0;
    }
    const steps = interaction?.["steps"];
    if (Array.isArray(steps)) state.completedSteps = steps;
    return;
  }

  if (type === "error") {
    const error = objectField(event, "error");
    throw new Error(
      stringField(error, "message") ?? stringField(error, "code") ?? "Gemini interaction stream reported an error",
    );
  }
  // interaction.status_update / step.stop: no adapter-visible state.
}

/**
 * §D1 dual-source harvest (KPR-353 spike-Delta-1 precedent): completed
 * interaction.steps are authoritative (arguments arrive PARSED —
 * FunctionCallStep shape, plan-time verified); step.start + accumulated
 * arguments_delta reconstruct calls when the streaming completed payload
 * omits steps. Deduped by call id — the two sources never double-execute.
 */
export function harvestFunctionCalls(state: GeminiRoundState): GeminiFunctionCall[] {
  const calls: GeminiFunctionCall[] = [];
  const seen = new Set<string>();

  const push = (id: string | undefined, name: string | undefined, args: unknown, argumentsError?: string): void => {
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    calls.push({ id, name, arguments: args, ...(argumentsError ? { argumentsError } : {}) });
  };

  for (const step of state.completedSteps) {
    if (!step || typeof step !== "object") continue;
    const record = step as Record<string, unknown>;
    if (record.type !== "function_call") continue;
    push(stringField(record, "id"), stringField(record, "name"), record.arguments ?? {});
  }

  for (const [index, step] of state.startedSteps) {
    if (step.type !== "function_call") continue;
    const streamedArgs = state.argumentsByIndex.get(index);
    let args: unknown = step.arguments ?? {};
    let argumentsError: string | undefined;
    if (streamedArgs !== undefined && streamedArgs !== "") {
      try {
        args = JSON.parse(streamedArgs);
      } catch {
        argumentsError = "arguments were not valid JSON";
      }
    }
    push(stringField(step, "id"), stringField(step, "name"), args, argumentsError);
  }

  return calls;
}

/** §D1 loop-local containment (codex parity): unknown tool / bad streamed
 *  arguments become structured function_result text, never a throw. The
 *  bridge's own contract (KPR-348 §D3: execute NEVER throws) covers the rest —
 *  nothing in the dispatch loop escapes runTurn as a throw. */
async function executeFunctionCall(
  call: GeminiFunctionCall,
  bridgedByName: Map<string, BridgedTool>,
): Promise<string> {
  const bt = bridgedByName.get(call.name);
  if (!bt) return `Tool execution failed (${call.name}): unknown tool`;
  if (call.argumentsError) return `Tool execution failed (${call.name}): ${call.argumentsError}`;
  return bt.execute(call.arguments ?? {});
}

function extractStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return undefined;
}

function objectField(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field && typeof field === "object" ? (field as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" ? field : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
```

- [ ] **Step 1.3: Auth-row alternate in `error-classification.ts`**

Extend the `auth` row regex (`error-classification.ts:79`) with one alternate — `api.?key is not available` — and extend the row's doc comment (`:59-68`) to name it (same motion as `OAuth session is not available`):

```typescript
  [
    "auth",
    /\b401\b|\b403\b|authentication|unauthorized|invalid.?api.?key|OAuth session is not available|api.?key is not available|not.?authenticated|credentials\.json|ANTHROPIC_API_KEY|authToken|resolve authentication/i,
  ],
```

**Nothing else in the file changes** — no stale-handle row, ever (KPR-350 canon; note this in the commit message).

- [ ] **Step 1.4: Per-alternate pin in `error-classification.test.ts`**

Beside the existing `OAuth session is not available` pin (`:67`), add:

  - [ ] `"Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY"` → `classifyThrown` / `classifyTurnResult` ⇒ `{outcome:"fault", kind:"auth"}` (KPR-352 §D7 alternate — regression-pinned per the row's standing rule)

- [ ] **Step 1.5: Create `src/agents/provider-adapters/gemini-interactions-adapter.test.ts`**

Harness: `makeAssembly()` fixture (replicate the codex test file's shape — instructions, inventory entries, allow-all gate, `inProcessServers: {}`, `sessionCwd`); `makeClient(scripts: Array<Record<string,unknown>[] | Error>)` returning a `GeminiInteractionsClient` whose `create` records `(params, options)` per call and returns an async iterable over the next script (or rejects with the Error — give thrown errors a `status` property to model `ApiError`); `makeAdapter(overrides)` **always** sets `client` + `apiKey: "test-key"`. Event fixture helpers: `created(id)`, `textDelta(text)`, `argsDelta(index, fragment)`, `stepStart(index, step)`, `completed(id, {usage, steps})`, `errorEvent(message)`.

Required cases (each a named `it`; grouped by describe):

  - [ ] **T1 advertisement:** two bridged fixtures (one real in-process `McpServer` over `InMemoryTransport` + one static builtin — replicate `openai-agents-adapter.test.ts:105-152` patterns) → round-1 `create` params carry `{type:"function", name, description, parameters}` for each; `store === true`; `system_instruction === assembly.instructions`; `tools: []` posted when inventory empty
  - [ ] **T1:** `systemPromptOverride` wins over assembly instructions; both rounds of a two-round turn carry `store: true` + `system_instruction` (posture re-sent per round)
  - [ ] **T2 single round:** `created` + text deltas + `completed` (no calls) → `text` accumulated, `onStream` per delta, `RunResult.sessionId` = completed id, one `create` call, no `previous_interaction_id` when `request.sessionId` absent
  - [ ] **T2 resume:** `request.sessionId: "interactions/abc"` → round-1 params `previous_interaction_id === "interactions/abc"`
  - [ ] **T2 two rounds (completed-steps source):** round-1 `completed(id1, {steps: [function_call {id, name, arguments: {x: 1}}]})` → tool executed with `{x: 1}` (real bridge → real McpServer handler records the args); round-2 params: `input` = exactly one `{type:"function_result", name, call_id, result:[{type:"text", text}]}` item (no user prompt), `previous_interaction_id === id1`; `RunResult.text` = round-2 text only; round-1 deltas reached `onStream` (final-reply semantics)
  - [ ] **T2 streaming-reconstruction source:** round-1 delivers `stepStart(0, {type:"function_call", id, name})` + `argsDelta(0, '{"x":')` + `argsDelta(0, '1}')` + `completed(id1, {})` (no steps) → same execution and round-2 shape (dual-source fallback)
  - [ ] **T2 both sources populated:** completed steps AND started steps carry the same call id → executed ONCE (dedupe pin)
  - [ ] **T2 parallel calls:** two function_call steps → both executed sequentially, both `function_result` items in ONE round-2 `input`
  - [ ] **T2 containment:** hallucinated tool name → `function_result` text `Tool execution failed (nope): unknown tool`, loop continues to round 2, no throw; unparseable `arguments_delta` accumulation → `arguments were not valid JSON` result text
  - [ ] **T2 bounds:** `resourceLimits.maxTurns: 1` with a call-bearing round → `error: "error_max_turns"`; `maxTurns: 0` → `error_max_turns` with **zero** `create` calls
  - [ ] **T2 missing id:** call-bearing round whose stream carried no interaction id → `RunResult.error` = `Gemini interaction stream ended without an interaction id` (non-tagged)
  - [ ] **T5 tag emission:** `request.sessionId` present, round-1 `create` rejects with `{status: 403}` → `RunResult.error` starts `gemini interaction resume rejected (status 403):`
  - [ ] **T5 scoping — mid-turn untagged:** round 1 succeeds with a call, round-2 `create` rejects `{status: 403}` → error = `Gemini interaction request failed (403): …` (NOT tagged; the just-minted id is not a persisted handle)
  - [ ] **T5 scoping — no-resume untagged:** no `request.sessionId`, round-1 403 → untagged
  - [ ] **T5 scoping — status breadth:** resume-carrying round-1 rejects with 429 and 500 → untagged `(429)`/`(500)` strings (breaker weight preserved); 400 and 404 → tagged
  - [ ] **T5 network passthrough:** `create` rejects `new Error("connect ECONNREFUSED 10.0.0.1:443")` (no status) → error message verbatim (connect-fail row reachable)
  - [ ] **T7 effort:** `reasoningEffort: "high"` → params `generation_config: {thinking_level: "high"}`; `"none"` → `"minimal"` + warn logged (spy on logger) once across two adapters with the same name; `"xhigh"` → `"high"`; unset → params have NO `generation_config` key
  - [ ] **T8 telemetry:** usage on `completed` across two rounds sums (`total_input_tokens`/`total_output_tokens`/`total_cached_tokens` → `inputTokens`/`outputTokens`/`cacheReadTokens`); a stream carrying `step.stop` with `step_usage` and event-level `metadata.total_usage` counts the completed value ONLY (multi-count guard); `llmMs === max(0, durationMs − toolMs)` with a deliberately-slow bridged tool; `toolCalls`/`toolSummary` from `bridge.stats`; `costUsd === 0`
  - [ ] **T9 abort mid-stream:** `abort()` fired from an event callback → `aborted: true`, `sessionId === request.sessionId ?? ""`, no round-2 create, `bridge.close()` called (prototype spy), no unhandled rejections
  - [ ] **T9 abort mid-tool:** abort during tool execution → same assertions
  - [ ] **T9 error sessionId:** mid-turn error after round 1 minted `id1` → `RunResult.sessionId === request.sessionId ?? ""` (NEVER `id1` — pre-error chain state resumes next turn)
  - [ ] **T10 missing key:** `makeAdapter({ apiKey: undefined, env: {} })` → `RunResult.error` = the exact §D7 message; `classifyTurnResult(result)` ⇒ `kind: "auth"`; `bridge.close()` called (finally covers the throw path)
  - [ ] **provider id:** `adapter.provider === "gemini"`; `wasAborted` reflects `abort()`

  **Negative-verify leg 6 (mandatory, recorded):** temporarily accumulate `step_usage` in a `step.stop` branch of `applyInteractionEvent` → the T8 completed-only test fails (multi-count) → restore → green.

- [ ] **Step 1.6: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/gemini-interactions-adapter.test.ts src/agents/provider-adapters/error-classification.test.ts` → green.
Then: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0 (old ADK adapter still present and green).

```bash
git add package.json package-lock.json src/agents/provider-adapters/gemini-interactions-adapter.ts src/agents/provider-adapters/gemini-interactions-adapter.test.ts src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/error-classification.test.ts
git commit -m "KPR-352: GeminiInteractionsAdapter — Interactions dispatch loop on @google/genai, bridged tools, stale-tag, effort coercion (no stale-handle FAULT_PATTERNS row — KPR-350 canon; auth-row alternate pinned)"
```

---

## Task 2 (Chunk 2): THE FLIP — route to the new adapter, delete ADK, dissolve `TOOL_EXECUTING_PROVIDERS`, one commit

**Files:**
- Modify: `src/agents/agent-manager.ts` (import swap; route type + `resolveProviderModel`; parent construction)
- Delete: `src/agents/provider-adapters/gemini-adk-adapter.ts`, `src/agents/provider-adapters/gemini-adk-adapter.test.ts`
- Modify: `src/agents/provider-adapters/oauth-credentials.ts` (Vertex deletion — orphaned by the ADK delete)
- Modify: `src/agents/provider-adapters/turn-assembly.ts` (dissolution ONLY)
- Modify: `src/agents/provider-adapters/turn-assembly.test.ts` (T6 pins)
- Modify: `src/agents/agent-manager.test.ts` (mock swap + constructor pins)
- Modify: `package.json` (+ lockfile): `npm uninstall @google/adk`

Canon: the tools flip (new adapter routed = gemini advertises + executes tools) and the set dissolution are **one commit, one review surface**. The instruction honesty invariant holds within the commit: the moment gemini executes tools, its instructions gain the tool-dependent sections.

- [ ] **Step 2.1: `agent-manager.ts` — route + import + construction**

  - Import swap (`:33`): `import { GeminiInteractionsAdapter } from "./provider-adapters/gemini-interactions-adapter.js";` (delete the ADK import).
  - Route union (`:179`): `| { provider: "gemini"; model: string; reasoningEffort?: CodexReasoningEffort }`.
  - `resolveProviderModel` gemini branch (`:201-203`) stops discarding the suffix (§D5 / epic §D8 ruling):

```typescript
  if (provider === "gemini" || provider === "google-gemini") {
    return { provider: "gemini", model: providerModel, reasoningEffort };
  }
```

  - Parent construction (`:732-736`) becomes:

```typescript
    return new GeminiInteractionsAdapter({
      name: config.name,
      // KPR-352 plan-time pin: Interactions-supported default (pre-352
      // literal "gemini-2.5-flash" predates the surface).
      model: route.model || appConfig.gemini.agentModel || "gemini-3.6-flash",
      apiKey: appConfig.gemini.apiKey || undefined,
      reasoningEffort: route.reasoningEffort,
      assembly,
    });
```

  Boundary: **no other `agent-manager.ts` edits in this task** — the matcher (Task 3) and the nested branch (Task 4) land separately; arm logic/ordering, KPR-313 guard, `finalizeSpawnResult`, breaker acquire/record untouched throughout.

- [ ] **Step 2.2: Delete the ADK adapter + test; strip the Vertex path from `oauth-credentials.ts`**

```bash
git rm src/agents/provider-adapters/gemini-adk-adapter.ts src/agents/provider-adapters/gemini-adk-adapter.test.ts
npm uninstall @google/adk
```

In `oauth-credentials.ts`, delete (all verified orphaned once the ADK adapter dies — `openai-agents-adapter.ts` imports only `createCodexOpenAITokenProvider`/`envValue`/`isProviderAuthError`, which **stay**):
  - `resolveGoogleVertexOAuthConfig` (`:58-81`)
  - `GoogleVertexOAuthConfig`, `GoogleOAuthOptions` interfaces (`:12-22`)
  - `DEFAULT_VERTEX_LOCATION` (`:37`), `defaultGoogleAdcPath` (`:160-162`), `readGoogleAdcProject` (`:164-171`)

  §D7 revisit trigger (put in the commit message): when Vertex ships the Interactions API, re-adding an OAuth attempt is a new small ticket — this deletion is surface-driven.

- [ ] **Step 2.3: `turn-assembly.ts` — dissolution**

Delete the `TOOL_EXECUTING_PROVIDERS` constant (`:129-138`, incl. its doc comment) and replace its use in `assembleProviderTurn` (`:197`):

```typescript
    // KPR-352 (§D4): TOOL_EXECUTING_PROVIDERS completed {openai, codex,
    // gemini} = LaneBProviderId and DISSOLVED per KPR-349 canon — every
    // native Lane B adapter executes bridged tools, so the honesty gate is
    // vacuously open. The builder's `toolsExecutable: boolean` param SURVIVES
    // as the provider-blind seam (KPR-349 canon: never a provider id): a
    // future non-tool-executing LaneBProviderId addition must re-gate here
    // explicitly — that child's one-line concern.
    const toolsExecutable = true;
```

Also update the `ProviderTurnAssembly.instructions` doc comment (`:92-99`): "…with the tool-dependent sections (toolkit, file-tier guidance, skills) rendered unconditionally post-KPR-352 (`toolsExecutable: true` — Lane B invariant)". Nothing else in the file changes (provider-blind canon; Task 6 diff check).

- [ ] **Step 2.4: `turn-assembly.test.ts` — T6 pins**

  - [ ] **Retire** the membership pin (`:110-112`, "TOOL_EXECUTING_PROVIDERS is exactly {openai, codex}") with the constant — delete the `it` and the import.
  - [ ] **Invert** the gemini pin (`:114-120`): "KPR-352 §D4: toolsExecutable TRUE for gemini (flip commit — set completed and dissolved)" → expects `toolsExecutable: true`.
  - [ ] openai (`:100-103`) and codex (`:122-128`) `toolsExecutable: true` pins pass unmodified.

- [ ] **Step 2.5: `agent-manager.test.ts` — mock swap + constructor pins**

  - Swap the module mock (`:160-167`) to `vi.mock("./provider-adapters/gemini-interactions-adapter.js", () => ({ GeminiInteractionsAdapter: vi.fn().mockImplementation((options) => { mockGeminiConstructor(options); return { provider: "gemini", runTurn: mockGeminiRunTurn, abort: mockGeminiAbort, get wasAborted() { … } }; }) }))` — same shape as today, constructor name updated.
  - [ ] New constructor-options pin: a `gemini/gemini-3.6-flash:high`-modeled agent's spawn constructs the adapter with `model: "gemini-3.6-flash"`, `reasoningEffort: "high"`, `apiKey` from config, and the assembly (T7 manager half).
  - [ ] New default-model pin: model `gemini/` fallback path (empty `agentModel` config) → constructor `model: "gemini-3.6-flash"`.
  - [ ] Existing route-dispatch table (`:3238`), persist pins (`:2483+` — still `''+tag` until Task 3), providerFor pin (`:2279`), and not-called pins (`:2919`, `:3472`) pass with the renamed mock, **unmodified otherwise**.

- [ ] **Step 2.6: Negative-verify legs 1 + 2 (mandatory, recorded)**

  1. Temporarily hardcode `tools: []` in the new adapter's create params → T1 advertisement tests fail → restore → green.
  2. Temporarily restore `const TOOL_EXECUTING_PROVIDERS = new Set(["openai", "codex"])` + `const toolsExecutable = TOOL_EXECUTING_PROVIDERS.has(input.provider)` → the inverted gemini pin fails → restore → green.

- [ ] **Step 2.7: Verify + commit**

Run the fast loop + `npm run check` (env stubs) → exit 0. Confirm `grep -r "@google/adk" src/ package.json` → no hits; `grep -rn "runEphemeral\|GeminiAdkAdapter" src/` → no hits.

```bash
git add -A
git commit -m "KPR-352: THE FLIP — gemini routed to GeminiInteractionsAdapter, ADK + runEphemeral + Vertex OAuth deleted (spec §R), TOOL_EXECUTING_PROVIDERS completed and dissolved (§D4; builder boolean seam survives; Vertex revisit trigger: Interactions-on-Vertex ships)"
```

---

## Task 3 (Chunk 3): Session flip + self-heal binding — `server-resumable`, matcher alternate, T3/T4/T5

**Files:**
- Modify: `src/agents/provider-adapters/types.ts` (gemini value + doc comments)
- Modify: `src/agents/provider-adapters/types.test.ts`
- Modify: `src/agents/agent-manager.ts` (`isStaleServerHandleError` ONLY)
- Modify: `src/agents/agent-manager.test.ts` (T3/T4/T5 manager halves)
- Modify: `src/agents/session-store.test.ts` (read-side pin inversion)

Same PR as the mechanism (KPR-347 one-line rule). Everything downstream — write-side persistence, churn-mint, read-side normalization, KPR-313 guard, reflection re-resolve, the KPR-350 arm — inherits with **zero arm changes**; this task's code diff is one value, one regex alternate, and comments.

- [ ] **Step 3.1: `types.ts` — the flip + comments**

  - `SESSION_SEMANTICS.gemini: "stateless-replay"` → `"server-resumable"` (`:72`).
  - `server-resumable` doc bullet (`:25-28`) gains the gemini citation: *"…; gemini `previous_interaction_id` chaining — KPR-352: server retention 55d paid / 1d free vs 7d store TTL, stale handles self-heal through the same §D3 arm."*
  - `stateless-replay` bullet (`:42-54`): remove the gemini clauses ("gemini runs runEphemeral…", "gemini leaves this category when Interactions lands") — codex-only text now; the projection resolved.
  - Nothing else: unions, other values, `persistsResumableHandle` untouched (canon).

- [ ] **Step 3.2: `types.test.ts`**

  - [ ] Flip the gemini row of the equivalence table (`:17`): `["gemini", true]`, and update the describe/it wording (the "old Set membership preserved" framing no longer holds for gemini — reword the table comment to note gemini's KPR-352 exit).

- [ ] **Step 3.3: `agent-manager.ts` — matcher alternate (the ONLY manager edit in this task)**

`isStaleServerHandleError` (`:292-297`) gains the gemini alternate + doc-comment rider:

```typescript
export function isStaleServerHandleError(reason: string): boolean {
  return (
    /previous response[\s\S]{0,80}?(not found|expired|no longer (?:exists|available))/i.test(reason) ||
    /previous_response_id[\s\S]{0,80}?(not found|invalid|expired)/i.test(reason) ||
    // KPR-352 (§D3): the gemini adapter's hive-owned sentinel — emitted ONLY
    // for round-1 400/403/404 failures whose carried previous_interaction_id
    // was the persisted sessions-store handle (deterministic, not prose-
    // guessed; also keeps expired-handle 403s out of the auth row's breaker
    // streak).
    /gemini interaction resume rejected/i.test(reason)
  );
}
```

The arm itself (`:978-1012`) is **not touched** — it already gates on `sessionSemanticsFor(route.provider) === "server-resumable"`, which now includes gemini.

- [ ] **Step 3.4: `session-store.test.ts` — read-side pins**

  - [ ] Invert `:74-77`: a tagged `provider: "gemini"` row with a real id (use an Interactions-shaped id, e.g. `"interactions/abc123"`) now returns `sessionId: "interactions/abc123"` (was `undefined`).
  - [ ] Add: tagged gemini row with `sessionId: ""` (pre-352 write) → `sessionId: undefined` (no poisoned resume on upgrade day).
  - [ ] Existing `gemini-pilot-` fabricated-scrub pins (`:119`, `:168`) pass unmodified.

- [ ] **Step 3.5: `agent-manager.test.ts` — T3 persist pins**

  - [ ] Invert the gemini leg of the persist-rule test (`:2483-2510`): gemini spawn (mock returns `sessionId: "interactions/xyz"`) → `sessionStore.set(agentId, threadId, "interactions/xyz", "gemini", …)` — real handle + tag (codex leg stays `""+tag`, claude stays id+tag).
  - [ ] Churn-mint: gemini turn with `error` set, resumed `sessionId: "interactions/old"`, result `sessionId: "interactions/new"` → persist skipped + warn (existing rider, now live for gemini).
  - [ ] Errored fresh gemini turn (result `sessionId: ""`) → no persist (falsy guard).

- [ ] **Step 3.6: `agent-manager.test.ts` — T4 transition pins (the KPR-350 obligation)**

New describe mirroring `:2431+` (claude↔openai shapes), driven through `spawnTurn` with seeded session rows:

  - [ ] claude→gemini: seeded claude-tagged row + gemini-routed agent → guard trips, first `runTurn` gets `sessionId: undefined`, prompt carries the **pilot** handoff notice, row rewritten tagged `gemini` with the new interaction id
  - [ ] gemini→claude: seeded gemini-tagged `interactions/…` row + claude-routed agent → guard trips, fresh session, **claude** notice variant, adopt semantics per existing guard
  - [ ] openai→gemini and gemini→openai: server-resumable→server-resumable both directions — guard trips on provider mismatch, neither handle crosses
  - [ ] gemini→codex: guard trips AND the existing awaited `turnHistoryStore.clear` fires (provider-agnostic — spy pin); codex→gemini: guard trips, gemini turn starts a fresh chain
  - [ ] adopt branch: seeded gemini row matching the incoming provider → resumes the handle, no handoff

- [ ] **Step 3.7: `agent-manager.test.ts` — T5 manager self-heal legs**

New describe mirroring the KPR-350 shape (`:2774-2830`), with `TAGGED = "gemini interaction resume rejected (status 403): You do not have permission to access the content"`:

  - [ ] tagged error + seeded gemini-tagged row → exactly one fresh retry (`mockGeminiRunTurn` call 2 has `sessionId: undefined`); warn log does **not** contain the provider message (redaction pin — assert the logged args omit the error string); retry success (`sessionId: "interactions/new"`) overwrites the row
  - [ ] failed retry (fresh attempt errors, `sessionId: ""`) → error surfaces, no persist, seeded stale handle survives for next-turn re-trip
  - [ ] record-once: tagged→success records success (breaker streak 0); tagged→"boom" records non-provider (streak 0) — first attempts never reach the breaker
  - [ ] narrowness matrix: the tagged string on a **claude**-routed agent → no retry (semantics gate: client-transcript); on a **codex**-routed agent → no retry (stateless-replay); `isStaleServerHandleError` unit pins — tagged string true, `Gemini interaction request failed (403): …` false, openai alternates still true
  - [ ] no-sessionId guard: tagged error on a thread with no stored handle → no retry (arm requires `effectiveCtx.sessionId`)

- [ ] **Step 3.8: Negative-verify legs 3, 4, 5 (mandatory, recorded)**

  3. Revert `SESSION_SEMANTICS.gemini` to `"stateless-replay"` → Step 3.2/3.4/3.5 pins fail → restore.
  4. In the adapter, temporarily tag every 4xx (drop `round === 1 && persistedHandle`) → the Task-1 T5 mid-turn-untagged pin fails → restore.
  5. Remove the matcher alternate → Step 3.7's first heal test fails (no retry) → restore.

- [ ] **Step 3.9: Verify + commit**

Fast loop + `npm run check` (env stubs) → exit 0. **Verify KPR-350 openai pins passed unmodified** (`git diff --stat` shows no `agent-manager.test.ts` deletions in the `:2774-2830` describe beyond additions).

```bash
git add src/agents/provider-adapters/types.ts src/agents/provider-adapters/types.test.ts src/agents/agent-manager.ts src/agents/agent-manager.test.ts src/agents/session-store.test.ts
git commit -m "KPR-352: SESSION_SEMANTICS.gemini → server-resumable — previous_interaction_id chaining persisted via existing paths; stale-handle self-heal bound to the KPR-350 arm with one matcher alternate (zero arm changes)"
```

---

## Task 4 (Chunk 4): Delegate subagents — nested gemini branch (KPR-354 inheritance)

**Files:**
- Modify: `src/agents/agent-manager.ts` (nested-adapter switch ONLY)
- Modify: `src/agents/agent-manager.test.ts` (nested pins)

The bridge side shipped in Task 1 (`delegateRunner` one-liner); the partition already routes `claude-subagent` ⇒ `requires-hive-bridge` for gemini (one code path — zero `tool-transport.ts` edits). This task makes the manager's nested runner construct a gemini adapter instead of returning "provider does not execute tools".

- [ ] **Step 4.1: Nested branch (`agent-manager.ts:641-645`)**

Replace the `else` block:

```typescript
        } else if (route.provider === "gemini") {
          nested = new GeminiInteractionsAdapter({
            name: `${config.name}:${call.delegate}`,
            model: route.model || appConfig.gemini.agentModel || "gemini-3.6-flash",
            apiKey: appConfig.gemini.apiKey || undefined,
            reasoningEffort: route.reasoningEffort,
            assembly: nestedAssembly,
            // Session-less by construction (§D6): no sessionId flows into the
            // nested runTurn below, the nested turn starts a fresh chain, and
            // the D5.7 shaping discards the final id — nothing persists.
            // Accepted residue: unreferenced store:true interactions self-
            // expire at vendor retention (55d paid) — KPR-350's 30d shape.
          });
        } else {
          // Unreachable while LaneBProviderId = {openai, codex, gemini} —
          // kept as containment for a future provider that ships tool-less
          // (KPR-354 belt-and-braces; §D6).
          return `Delegate turn failed (${call.delegate}): provider ${String((route as { provider: string }).provider)} does not execute tools`;
        }
```

(All nested semantics — budget check-and-increment, lock exemption, abort chaining, never-throws shaping, breaker invisibility — are the existing closure's body, untouched.)

- [ ] **Step 4.2: T10 nested pins (`agent-manager.test.ts`)**

Mirror the KPR-350 §D5 / KPR-354 nested describes (`:4143+`):

  - [ ] gemini-routed parent whose bridge invokes the delegate runner → `mockGeminiConstructor` called a second time with `name: "Agent:… :delegate"`-shaped label, nested assembly, `reasoningEffort` passed; the `:3472` "not called" pin **inverts** accordingly
  - [ ] nested `runTurn` request has **no `sessionId`**; nested result's `sessionId` is discarded — `sessionStore.set` never called for the nested turn (session-less pin)
  - [ ] nested error → returned as `Delegate turn failed (…): …` text; parent turn completes; breaker records exactly once (parent result only)
  - [ ] budget: nested spawn increments `activeSpawnCount` and releases in finally (existing shape, gemini-parameterized)

- [ ] **Step 4.3: Verify + commit**

Fast loop + `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-352: nested delegate turns on gemini — KPR-354 inheritance (session-less, budget-accounted, breaker-invisible; unreachable else kept as containment)"
```

---

## Task 5 (Chunk 5): Documentation riders + bundle gate (§D9)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 5.1: CLAUDE.md riders**

In the **Provider adapters** section:
  - Adapter list line: `CodexSubscriptionAdapter / OpenAIAgentsAdapter / GeminiAdkAdapter` → `… / GeminiInteractionsAdapter`.
  - Replace the "gemini still advertises zero tools until KPR-352" clause: all three Lane B adapters execute real hive tools through the KPR-348 `ToolBridge`; gemini runs a bounded Interactions dispatch loop (KPR-352, codex-loop template).
  - Add the gemini resume sentence beside the KPR-350 openai one: gemini durable resume is `previous_interaction_id` chaining (KPR-352 — handle in `sessions`, 7d idle TTL < 55d paid retention (1d free tier — self-heal degrades idle threads to daily fresh context), `store: true` pinned, stale/expired handles self-heal via the same semantics-gated manager arm as openai; API-key auth only, no Vertex until Interactions ships there; `:effort` maps to `thinking_level` with `none→minimal`/`xhigh→high` coercion).
  - `TOOL_EXECUTING_PROVIDERS` references (turn-assembly description): note the set completed and dissolved in KPR-352 — assembly passes `toolsExecutable: true` unconditionally.
  - Delegate sentence: delegates now run on all three tool-executing surfaces (drop "both").
  - Dependency note: `@google/adk` → `@google/genai`.

- [ ] **Step 5.2: Bundle gate**

Run: `npm run bundle` → exit 0 (`@google/genai` bundles cleanly; `check-bundle-qdrant-stub.mjs` green). If esbuild chokes on SDK internals, add `"@google/genai"` to the `external` array in `build/bundle.ts` **as a recorded deviation** (it is a prod dep, so external resolution works at runtime) — otherwise `build/bundle.ts` stays untouched.

- [ ] **Step 5.3: Commit**

```bash
git add CLAUDE.md
git commit -m "KPR-352: CLAUDE.md riders — gemini Interactions adapter, server-resumable chaining, ADK→genai dependency swap (§D9)"
```

---

## Task 6 (Chunk 6): Final verification — full gate, boundary diffs, live e2e evidence

- [ ] **Step 6.1: Boundary empty-diff checks**

```bash
git diff <base>..HEAD --stat -- src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/builtin-executor.ts src/agents/provider-adapters/tool-transport.ts src/agents/provider-adapters/archetype-gate.ts src/agents/provider-adapters/skill-index.ts src/agents/prefix-builder.ts src/agents/agent-runner.ts src/agents/session-store.ts src/agents/turn-history-store.ts src/agents/provider-adapters/openai-agents-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/passthrough-providers.ts src/config.ts src/index.ts build/bundle.ts
```

Expected: **empty** (or `build/bundle.ts` only under the recorded Step-5.2 deviation). Also: `grep -rn "TOOL_EXECUTING_PROVIDERS\|runEphemeral\|@google/adk\|resolveGoogleVertexOAuthConfig\|gemini-adk" src/ package.json` → no hits.

- [ ] **Step 6.2: Full gate**

`SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0. `npm run bundle` → exit 0.

- [ ] **Step 6.3: Post-implementation live turn (evidence-recorded)**

Scratch tsx driver (scratchpad, never committed) constructing the **real** `GeminiInteractionsAdapter` with a minimal assembly (one real in-process trivial MCP tool, allow-all gate) and the Honeypot key: (1) turn 1 with a tool-forcing prompt → ≥1 real tool call executed, final text coherent, interaction id returned; (2) turn 2 passing turn 1's id as `sessionId` → context recalled; (3) a fabricated-id turn → `RunResult.error` carries the tagged sentinel with the live status. Append the transcript (ids + shapes, no key material) to `kpr-352-spike-notes.md`.

- [ ] **Step 6.4: PR evidence block**

The six negative-verify records (Steps 1.5, 2.6×2, 3.8×3), the T0 verdict table, the live-turn transcript, the §R note (ADK deleted, Vertex revisit trigger recorded), the free-tier caveat callout (1d retention + training — production gemini assignment needs a paid-tier key), and the §D4 dissolution callout (future non-executing provider must re-gate — the builder boolean survives) so KPR-355/KPR-351 inherit the row facts without surprises.

---

## Notes for the reviewer (plan-level decisions and their rationale)

1. **Task 1 lands the new adapter beside the old one; Task 2 is the flip commit.** The canon's "one flip, one commit" names the tools-advertisement flip + set dissolution as one review surface — that is Task 2 exactly (the commit where gemini's routed adapter first advertises tools is the commit where the set dissolves). Building the adapter first keeps the flip commit reviewable instead of a 1,200-line rewrite-plus-rewire.
2. **The dual-source function-call harvest** (completed steps + streaming reconstruction) is the KPR-353 spike-Delta-1 lesson applied proactively: the d.ts documents both carriages and streaming lifecycle payloads "may omit" full-response fields. Task 0 records which source the live surface populates; the dedupe makes both-populated safe.
3. **`arguments` arrive parsed** on completed `FunctionCallStep`s (d.ts-verified) — the codex JSON-string parse containment survives only on the streaming-reconstruction path, which is exactly where unparseable accumulations can occur.
4. **`maxRetries: 0`** is a plan-level addition inside the spec's telemetry-honesty envelope: SDK-internal retries would silently absorb 429/5xx faults the breaker must see, and would multiply stale-handle probes.
5. **The adapter's `env` option** exists solely so the missing-key test can't be poisoned by ambient dev-machine credentials — same hazard class as the codex `codexAuthPath` tmp-file guardrail.
6. **Session flip (Task 3) sequences after the flip (Task 2)**, so there is one intermediate commit where gemini executes tools but still persists `""` — coherent (every turn fresh-chains, exactly pre-352 continuity) and check-green; the PR lands both (KPR-347 same-PR rule satisfied).
7. **Stale-status set refinement is fold-in-verbatim** from Task 0's leg (d) — the spec ⚠-delegates the exact statuses; the plan gives the mechanism, not a guess frozen in code review.
8. **No `provider_turn_history` for gemini anywhere** — the nested branch passes no historyStore (there is none for gemini), and the KPR-313 clear stays provider-agnostic (no-op for gemini threads) — pinned via the gemini→codex transition test.
