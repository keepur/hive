# KPR-314 — Implementation Plan: Sidecar LLM registry (W3.5, PR #194 rescoped)

> **For agentic workers:** Use dodi-dev:implement to run this plan.

**Spec:** `docs/epics/kpr-309/kpr-314-spec.md` (approved after 5 review rounds — authoritative; ⚠-flagged assumptions are settled, do not re-litigate).
**Epic:** KPR-309 (pre-register epic — R3/R7 bind from W2's register). The provider clamp-lift stays parked (spec ⚠1 — the driver re-parks 311 §5's pointer; nothing here touches breaker/permit machinery).

> **DELIVERY-CONTEXT NOTE (read first):** this plan runs after **three gates**: (1) the W2 epic merged (error-classification et al. exist — read-only for this ticket), (2) **KPR-311's child PR merged** into the epic branch, and (3) **KPR-312's child PR merged** into the epic branch — every `model-router.ts` / `doctor.ts` / `doctor-checks.ts` edit below is written against **312's plan-defined post-state** (`kpr-312-plan.md` — Task 1 full-file replacement, Task 6 doctor line, Task 7 optional credential entry). KPR-313 is verified disjoint (zero shared files, spec §6): this plan is indifferent to whether 313 has landed — none of its five files (`session-store.ts`, `voice-adapter.ts`, `agent-manager.ts`, `provider-adapters/types.ts`, `claude-agent-adapter.ts`) appear below. Edits anchor on unique code strings (router/doctor anchors are strings 312's plan itself introduces), never line numbers. **Task 0 re-confirms all gates and every anchored surface before any edit** and defines the demote-to-spec escape hatch.

## Goal

One engine-internal registry (`src/llm/`) becomes the single owner of sidecar-LLM model metadata — catalog (ids, per-MTok pricing, capabilities), task→model bindings as code constants, per-provider client factories (anthropic on `@anthropic-ai/sdk` per 312's precedent; gemini raw REST salvaged from PR #194) — and the transport for the four non-agentic call sites. Meeting classifier and memory lifecycle stop spawning Claude Code CLI subprocesses; image description stops carrying inline Gemini provider knowledge; the router classifier (already subprocess-free post-312) hands its interim pricing constants to the registry (the `TODO(KPR-314)` hand-off), consults `supportsEffort` from the catalog, and routes its structured-outputs call through the registry's shared anthropic provider (312 behavior byte-preserved; metadata-only retreat sanctioned per spec ⚠4). `costUsd` is **computed by the registry** from provider usage × catalog pricing — fixing PR #194's never-populated `costUsd?` defect. Memory's per-call cap becomes a caller-side estimate gate at `callBudgetUsd() × GATE_TOLERANCE (1.3)` with one-sided outcome parity at defaults, counted skips in the `autoDream complete` log, a new ~30s timeout, and per-phase `maxOutputTokens` pins (verdicts 32, others 256). No-key instances degrade honestly (meeting → all-roster warn-once; memory LLM phases → skip, log-once; vision → null) — never a hidden subprocess. Keys stay env→Honeypot via existing `optional()` resolution. One informational `hive doctor` line surfaces the degradations. **No** hive.yaml `llm:` block, no new env vars, no OpenAI adapters, no clamp-lift, no agent-turn routing.

## Architecture

- **`src/llm/` layout (decision, spec left to plan):** `types.ts` (interfaces), `catalog.ts` (model data + pure cost-estimate math — deliberately **config-free** so tests and the memory suite import real estimate math without dragging in `config.ts` env loading), `registry.ts` (`LLMRegistry` class, task bindings reading `config`, lazy `getLLMRegistry()` singleton + `__resetLLMRegistryForTests()` — same seam pattern as `archetypes/registry.ts`), `provider-utils.ts` (salvaged `requireApiKey`/`withTimeout`/`parseJsonResponse`; `normalizeBaseUrl`/`textPromptParts`/`extractJson*` dropped — no consumer: the gemini base URL is a constant post-config-surface-drop, and the meeting classifier keeps its own `parseClassifierOutput` brace-scan), `providers/anthropic-provider.ts` + `providers/gemini-provider.ts`. No barrel `index.ts` (PR #194 had one; direct imports are the repo norm).
- **Providers are dumb transports:** `generate(request)` throws on transport/HTTP error, `maxRetries: 0` — call sites own fallback (312 stance). The **registry** owns task resolution, capability validation, cost computation, off-catalog warn-once. `LLMResult` carries `stopReason?` (plan extension to the spec's §3.1 sketch — required so the router's refusal/`max_tokens` fallback conditions stay byte-for-byte 312's; spec ⚠4/⚠6 delegate exact surface to the plan).
- **Catalog pricing only where consumed:** haiku carries `{inputPerMTok: 1, outputPerMTok: 5}` (the exact constants 312's Task 1 embedded — this is the hand-off). Sonnet/opus/gemini entries carry capabilities only (no call site computes their cost; `pricing?` absent ⇒ `costUsd` undefined, never blocks — spec §3.1). Effort-capability: sonnet/opus `"effort"`, haiku not (312 §3.2 rule 2, now data).
- **Sidecar calls never touch W2 machinery:** no breaker `acquire()`/`record()`, no permits, no provider adapters (spec §6). R3/R7 read-only.
- **Injection seams:** memory lifecycle takes a constructor-injected `MemoryLlmClient` (4th parameter, required — the typechecker forces the full call-site sweep); file-processor takes `setVisionLlmClient()` module injection (PR #194's shape); router and meeting classifier call `getLLMRegistry()` directly and their tests module-mock `../llm/registry.js`.

## Tech Stack

- TypeScript strict, Node 22+, ESM; **no new packages** (`@anthropic-ai/sdk` ^0.82.0 already installed — `messages.parse`/`messages.create` + per-request `{ timeout }` options + `jsonSchemaOutputFormat` helper; gemini is raw `fetch`)
- Vitest beside source; harnesses touched: `model-router.test.ts` (312's, re-anchored), `meeting-classifier.test.ts`, `memory-lifecycle.test.ts` (899 lines, 19 constructor call sites), new `src/llm/*` + `src/files/file-processor.test.ts` suites, `doctor-checks.test.ts`
- Logging via `createLogger`; log-redaction convention (no prompt/message text in logs)
- Config: zero new keys. Existing knobs keep meaning: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (both env→Keychain via `optional()` on HEAD), `MODEL_ROUTER_MODEL`, `MODEL_ROUTER_TIMEOUT_MS`, `GEMINI_VISION_MODEL`. `config.ts` is expected to need **no edits** (Task 0 verifies both `optional()` lines exist).

**Out of scope (do not touch):** provider clamp/pilot gate (311 §5 stays parked), breaker wrap and `error-classification.ts` (R3/R7), `TIER_MODELS` tier→model values (routing policy stays in `model-router.ts`), 312's heuristics H1–H3 / `ROUTER_PROMPT_V2` text / no-key semantics / effort delivery channel, `knowledge-extractor.ts` (spec ⚠8), embedding pipeline, `openai-translator.ts`, `agent-manager.ts` `config.gemini.agentModel` consumer, any hive.yaml surface, OpenAI/openai-compatible providers, retry logic inside providers.

---

## Testing Contract

### Required Test Groups

**Unit — `required`** — spec §8 tests 1–8, realized as:

1. **Registry** (`src/llm/registry.test.ts`, Task 2): key-gated construction (no key ⇒ `hasProvider(id) === false`; task resolve throws `LLMProviderUnavailableError`); task→model→provider resolution (`meetingClassifier`/`routerClassifier` honor mocked `config.modelRouter.model`; `vision` honors `config.gemini.visionModel`; `memory` pinned to `claude-haiku-4-5-20251001`); capability validation (vision task bound to a catalog non-vision model ⇒ `LLMCapabilityError` + `log.error` once; schema-bearing request against a structured-outputs model passes); cost computed from usage × catalog pricing — **pinned exactly**: usage `{input: 500, output: 10}` on haiku ⇒ `costUsd` 0.00055 (re-anchor of 312's constant math); off-catalog model id ⇒ call proceeds, `costUsd` undefined, **single** `log.warn` across repeated calls; `estimateCostUsd` pins via `estimateCostUsdFromPricing` (haiku pricing, `maxOutputTokens: 256`): 32,640-char prompt ⇒ **0.00944**, 36,000-char ⇒ **0.01028**, 96,000-char ⇒ **0.02528** (the spec §3.4 fitted-page / shallow-band / deep-over triple); `estimateCostUsd` for the pricing-less vision task ⇒ undefined; `supportsEffort` real-catalog pins: haiku false, sonnet true, opus true, unknown id false.
2. **Anthropic provider** (`src/llm/providers/anthropic-provider.test.ts`, Task 2, mocked SDK): schema request ⇒ `messages.parse` with `output_config.format` + `parsed` mapped from `parsed_output`; plain request ⇒ `messages.create`, no `parse`; usage/stopReason mapping; per-request `{ timeout: timeoutMs }` option; images mapped to base64 image blocks before the text block; thrown SDK error propagates (no swallowing); constructor `{apiKey, maxRetries: 0}`.
3. **Gemini provider** (`src/llm/providers/gemini-provider.test.ts`, Task 2, stubbed fetch — salvage PR #194's): request shape (inline base64 parts before text, `system_instruction`, `generationConfig` maxOutputTokens/temperature), usage mapping from `usageMetadata`, non-OK ⇒ throw with status + body slice, `AbortSignal` present when `timeoutMs` set, key never logged.
4. **Meeting classifier** (`src/agents/meeting-classifier.test.ts`, Task 4, mocked registry): happy path — `parsed` respected via the belt-and-braces path, id-allowlist filtering still applied; request-shape pin (task `"meetingClassifier"`, `jsonSchema` present, `maxOutputTokens: 256`, `temperature: 0`, `timeoutMs` = `config.modelRouter.timeoutMs`); registry throw ⇒ all-roster with `costUsd: 0`; parse-fail (garbage text, no `parsed`) ⇒ all-roster with the call's real `costUsd`; **no-key**: `hasProvider` false ⇒ all-roster via pre-check, `generateForTask` **never called**, `log.warn` fired **once across repeated calls**; roster 0/1 short-circuits never touch the registry; `costUsd`/`durationMs` passthrough from `LLMResult`.
5. **Memory lifecycle** (`src/memory/memory-lifecycle.test.ts`, Tasks 5–6): mock client returns usage/`costUsd` ⇒ `budget.record` called with computed cost, including a **post-hoc exceedance** case (gate-passed call whose actual `costUsd` 0.012 > `callBudgetUsd()` 0.01 — recorded, consumes run budget, visible in `DreamResult.spentUsd`); `canSpend()` pre-gate still throws `"autoDream run budget exhausted"`; **estimate gate**: stubbed `estimateCostUsd` above `callBudgetUsd() × 1.3` ⇒ call skipped as empty-text `continue` (`generateForTask` **not called**), skip counted and surfaced (`DreamResult.gateSkips` + the `autoDream complete` log field), and a cold-summary gate-skip does **not** flip `drained` beyond today's continue rule (checkpoint not reset); **clearance pinned against real registry-side estimate math on the actual sent prompt** (mock `estimateCostUsd` delegates to `estimateCostUsdFromPricing` with haiku pricing): a default-fitted cold-summary page + wrapper (≈$0.0094) **passes** and is attempted; a shallow-over band page (content-only fitted stop at min-records, estimate ≈$0.0103) **passes under ×1.3** and is attempted; a deep-over min-records page (3 near-cap records, estimate ≈$0.0253) is **gated** (skipped, not attempted); `GATE_TOLERANCE` pinned `=== 1.3`; per-phase `maxOutputTokens` pins — contradiction verdict requests carry 32, merge/promote/cold-summary carry 256; a phase throw ⇒ that agent's **remaining phases abort**, error recorded in `errors[]`, run continues at the **next agent** (per-agent granularity pinned); **no-key**: `hasProvider` false ⇒ `dream()` returns zero counts, `generateForTask` never called (repeat call also silent — no error spam), `runConsolidationForAgent` returns early with an explicit error string; `timeoutMs: 30_000` wired into every request; the `"hit your limit"` loop-break is **gone** (a rejecting mock with that string no longer breaks the agent loop — the run continues to the next agent). Existing dream/sweep/checkpoint/cursor assertions unchanged (constructor sweep only).
6. **Image description** (`src/files/file-processor.test.ts`, Task 7 — salvage PR #194's three + two): configured client called with `"vision"` task, images + `maxOutputTokens: 2048` + `timeoutMs`; null when unconfigured; null on throw; **silent** null on `LLMProviderUnavailableError` (no warn — steady state ≠ incident); null on empty text.
7. **Router registry consumption** (`src/agents/model-router.test.ts`, Task 3): 312's suite re-anchored — heuristics H1–H3 pins byte-equivalent (assert `mockGenerateForTask` never called instead of `mockParse`); model path returns tier/effort with `costUsd`/`durationMs` **passed through from the registry result** (0.00055 pin moves to registry.test.ts; here passthrough is pinned); request-shape pin (task `"routerClassifier"`, `systemPrompt` containing "Effort" and not the v1 pleas, `maxOutputTokens: 100`, `jsonSchema` present, `timeoutMs: 4000`); refusal / null-`parsed` / `max_tokens` `stopReason` ⇒ sonnet fallback `method: "fallback"`; thrown ⇒ fallback; **effort-drop rule driven by `supportsEffort`** — post-cap haiku model (mock returns false) drops effort, sonnet (true) keeps it, and mock call args pin that `supportsEffort` receives `TIER_MODELS[finalTier]`; **no-key mode** keyed off `hasProvider("anthropic")` false ⇒ agent-default model, resolved default-tier limits, `method: "no-key"`, `generateForTask` never called. Existing `resolveResourceLimits` describe untouched.
8. **Doctor line** (`src/cli/doctor-checks.test.ts`, Task 8): all four `llmSidecarLine` key-permutation strings pinned verbatim; helper is a pure string producer — no failure channel (structural: wiring only `console.log`s it, never touches `allPassed`).

**Negative-verifies (mutations — repo convention; run, observe failure, restore; never committed):**
- **N1 (the PR #194 defect fix):** in `registry.ts`, disable the cost computation (return the provider result without `costUsd`). EXPECT: registry cost pin (test 1) AND meeting-classifier `costUsd` passthrough (test 4) fail. Restore, green.
- **N2 (estimate gate):** in `memory-lifecycle.ts`, comment out the gate branch in `runDreamQuery`. EXPECT: the deep-over gated test and the `gateSkips` surfacing test fail (`generateForTask` called). Restore, green.

**Integration — judged: not required beyond the above.** Every provider contract branch is SDK-typed or REST-shaped and pinned under mocks; the spawn/dispatcher paths consume these sites through already-tested module boundaries (`agent-manager.test.ts` mocks `routeModel`; `dispatcher-conference.test.ts` mocks `meeting-classifier.js` — both shapes unchanged). Live-API verification is the Task 9 manual smoke (spec §8 test 9), which exercises all four sites on a keyed dev instance.

**E2E — `not-required`.** No user-facing flow changes shape; degraded no-key modes are unit-pinned and doctor-surfaced (spec ⚠2 accepted posture).

### Critical Flows
1. Meeting message, key present: roster ≥2 → one `generateForTask("meetingClassifier", ...)` → parsed respond list → id filter → dispatcher logs real `costUsd`.
2. Meeting message, no key: `hasProvider` pre-check → all-roster, zero registry calls, one warn per process.
3. autoDream run: `canSpend` → estimate gate (×1.3) → `generateForTask("memory", ...)` (≤30s) → `budget.record(costUsd)`; gated page ⇒ `""` → `continue`, skip counted, surfaced in the complete log.
4. Routed turn: heuristic miss → `generateForTask("routerClassifier", ...)` → registry-computed cost → effort dropped iff `!supportsEffort(TIER_MODELS[finalTier])` — merge/delivery channel (312) untouched.
5. Slack image upload: `describeImage` → `generateForTask("vision", ...)` on gemini → description, or null → metadata-only entry (today's path).
6. Zero-key boot: engine boots normally, registry constructs with no providers, boot log + doctor line say so.

### Regression Surface (must stay green)
- `src/agents/model-router.test.ts` — 312's heuristics/model-path/no-key/fallback pins survive re-anchoring (same behavioral assertions, transport mock swapped); pre-existing `resolveResourceLimits` describe byte-identical.
- `src/agents/agent-manager.test.ts` — untouched (module-mocks `routeModel`; `ModelRouterResult` shape unchanged). 311/312 describes all pass.
- `src/agents/agent-runner.test.ts`, `src/agents/provider-adapters/**` (incl. `error-classification.test.ts`), `provider-circuit-breaker.test.ts`, `circuit-breaker-heartbeat.test.ts` — untouched W2/311/312 surfaces; any failure means this change leaked across R3/R7.
- `src/memory/memory-lifecycle.test.ts` — every existing describe (scoring, sweep, purge, dream, KPR-241 cold-summary/cursor/checkpoint) passes with only the mechanical constructor/mock sweep.
- `src/channels/dispatcher-conference.test.ts` — untouched (mocks `../agents/meeting-classifier.js`; `ClassifyResult` shape unchanged).
- `src/agents/meeting-classifier.test.ts` — existing `parseClassifierOutput` describe byte-identical.
- `src/cli/doctor-checks.test.ts`, `doctor.test.ts`, `credentials.test.ts`, `src/setup/credential-registry.test.ts` — existing pins; if any enumerates registry entries, **extend, never delete**.
- Slack-gateway/ws-adapter suites (if any touch file handling) — `downloadAndProcess`/`processImageBuffer` signatures unchanged.

### Commands
```bash
# Targeted (after each task)
npx vitest run src/llm/
npx vitest run src/agents/model-router.test.ts src/agents/agent-manager.test.ts
npx vitest run src/agents/meeting-classifier.test.ts src/channels/dispatcher-conference.test.ts
npx vitest run src/memory/memory-lifecycle.test.ts
npx vitest run src/files/file-processor.test.ts
npx vitest run src/cli/doctor-checks.test.ts src/cli/doctor.test.ts src/cli/credentials.test.ts src/setup/credential-registry.test.ts

# Full gate (Task 0 baseline + Task 10; env stubs required by config load in tests)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: all suites pass; `check` = typecheck + lint + format + test, zero failures. (Worktree/CI asymmetry reminder: confirm the output lists all four gates actually running — do not trust a pass that self-disabled on a `.claude/worktrees/` ignore fragment.)

### Harness Requirements
- **`src/llm/registry.test.ts`:** `vi.mock("../config.js")` with a hoisted **mutable** config (`anthropic.apiKey`, `gemini.apiKey`, `modelRouter.model`, `gemini.visionModel` toggled per test); `vi.mock` both provider modules with spy classes (constructor + `generate`); hoisted logger capture (`vi.mock("../logging/logger.js")` returning shared spies) for the warn-once/error-once pins; `beforeEach` → `__resetLLMRegistryForTests()` where the singleton is exercised (class-under-test is mostly constructed directly with explicit keys).
- **Provider tests:** anthropic — `vi.mock("@anthropic-ai/sdk")` default-export class with `messages.parse`/`messages.create` spies (312's Task 2 pattern); the real `jsonSchemaOutputFormat` runs unmocked (pure). gemini — `vi.stubGlobal("fetch", ...)` (PR #194's pattern), `vi.unstubAllGlobals()` in `afterEach`.
- **`model-router.test.ts`:** replace 312's `@anthropic-ai/sdk` mock with `vi.mock("../llm/registry.js")` (hoisted `mockGenerateForTask`/`mockHasProvider`/`mockSupportsEffort`); keep the mutable config mock (still pins `timeoutMs`); `__resetRouterStateForTests()` in `beforeEach`.
- **`meeting-classifier.test.ts`:** add `vi.mock("../llm/registry.js")` + hoisted logger capture; config mock gains `modelRouter: { model, timeoutMs }`.
- **`memory-lifecycle.test.ts`:** delete the `@anthropic-ai/claude-agent-sdk` mock; `makeMockLlm()` factory (defaults: `hasProvider` true, `estimateCostUsd` 0.001, `generateForTask` resolves `{text, costUsd: 0}` — cost 0 preserves every existing budget pin, matching the old subprocess mock's undefined `total_cost_usd`); gate-clearance tests import `estimateCostUsdFromPricing` from `../llm/catalog.js` (config-free by design).
- **`file-processor.test.ts`:** logger mock only; client injected via `setVisionLlmClient`, reset via `resetVisionLlmClientForTests()`.
- No DB, no network, no live SDK anywhere in the unit surface.

### Non-Required Rationale
- No live provider tests: Messages API / Gemini REST contracts are vendor-side; mocked tests pin *our* mapping of every branch. Task 9's manual smoke covers reality once.
- No dispatcher test changes: both call sites keep their exported signatures (`ClassifyResult`, `describeImage` consumers unchanged).
- No hive.yaml loader test: nothing added, nothing to ignore (spec §3.6 — liberal-loader concerns nil).
- No `agent-manager.test.ts` changes: `ModelRouterResult` fields and `routeModel` signature are unchanged by 314.

### Verification Rules
1. A missing harness is not a skip reason — if a listed test doesn't exist at a task's Verify step, write it; do not mark the task done without running the listed commands and seeing the expected output.
2. When a test fails, fix the implementation, not the test — unless the test contradicts the spec's pinned semantics (gate parity semantics, warn-once rules, per-agent catch granularity, no-key shapes, capability rules), in which case the spec wins.
3. Spec/plan mismatch demotes to the spec lane: if running this plan surfaces a conflict with `kpr-314-spec.md` (or Task 0 finds anchored-surface drift), stop and route back through dodi-dev:mature-ticket with a drift note — do not improvise in the delivery lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/llm/types.ts` | **new** | Provider/request/result/catalog interfaces (PR #194 salvage, trimmed to 2 providers, + `pricing`/`capabilities`/`parsed`/`jsonSchema`/`stopReason`) |
| `src/llm/catalog.ts` | **new** | `LLM_CATALOG` data (the pricing/capability constants 312 punted), `catalogModel()`, pure `estimateCostUsdFromPricing()` — config-free |
| `src/llm/provider-utils.ts` | **new** | `requireApiKey`, `withTimeout`, `parseJsonResponse` (PR #194 salvage, partial) |
| `src/llm/errors.ts` | **new** | Typed sidecar errors (`LLMProviderUnavailableError`, `LLMCapabilityError`) — config-free so call sites/tests import them without dragging `config.ts` |
| `src/llm/providers/anthropic-provider.ts` | **new** | Re-derived on `@anthropic-ai/sdk`: shared keep-alive client, `maxRetries: 0`, `messages.parse` when `jsonSchema` present else `messages.create`, per-request timeout |
| `src/llm/providers/gemini-provider.ts` | **new** | PR #194 salvage near-verbatim: `generateContent` REST, inline base64, `AbortSignal.timeout`, usage mapping |
| `src/llm/registry.ts` | **new** | `LLMRegistry` (key-gated provider construction, `TASKS` code constants, `generateForTask`, `estimateCostUsd`, `pricingFor`, `supportsEffort`, cost computation, typed errors, warn-once), `getLLMRegistry()` + test reset |
| `src/llm/registry.test.ts`, `src/llm/providers/anthropic-provider.test.ts`, `src/llm/providers/gemini-provider.test.ts` | **new** | Testing Contract groups 1–3 |
| `src/agents/model-router.ts` | modified | §3.2: pricing constants → registry; effort drop via `supportsEffort`; transport via `generateForTask("routerClassifier")`; no-key via `hasProvider`; 312 behavior otherwise byte-preserved |
| `src/agents/model-router.test.ts` | modified | Mock swap SDK→registry; contract group 7 |
| `src/agents/meeting-classifier.ts` | modified | §3.3: subprocess → `generateForTask("meetingClassifier")`, `RESPOND_SCHEMA`, warn-once no-key pre-check, fallbacks preserved |
| `src/agents/meeting-classifier.test.ts` | modified (additive) | Contract group 4; existing describe untouched |
| `src/memory/memory-lifecycle.ts` | modified | §3.4: injected `MemoryLlmClient`, estimate gate + `GATE_TOLERANCE`, 30s timeout, per-phase `maxOutputTokens`, skip counting, no-key short-circuits, dead `"hit your limit"` break deleted |
| `src/memory/memory-types.ts` | modified (additive) | `DreamResult.gateSkips?: number` |
| `src/memory/memory-lifecycle.test.ts` | modified | SDK mock → `makeMockLlm`, 19-site constructor sweep, contract group 5 |
| `src/files/file-processor.ts` | modified | §3.5: `describeImage` + `setVisionLlmClient` injection; inline Gemini fetch/key state deleted |
| `src/files/file-processor.test.ts` | **new** | Contract group 6 (PR #194 salvage + 2) |
| `src/index.ts` | modified | 2 touch points: vision client injection; `MemoryLifecycle` 4th arg |
| `src/cli/doctor-checks.ts` | modified (additive) | `llmSidecarLine()` pure helper |
| `src/cli/doctor.ts` | modified (additive) | Emit the line (config-loaded + skipped branches, after 312's model-router line) |
| `src/cli/doctor-checks.test.ts` | modified (additive) | Contract group 8 |
| `src/setup/credential-registry.ts` | conditional rider | `ANTHROPIC_API_KEY` entry **only if** 312 Task 7 was dropped (spec ⚠7) |

One commit per task; every task leaves the tree green (`npm run typecheck` + scoped tests).

---

## Task 0 — Re-confirm gates and anchored surfaces at delivery HEAD (mandatory, Gate 1 D2)

**Goal:** prove the delivery worktree carries W2, 311, AND 312 before touching anything, and that every pre-314 surface this plan edits still matches by content. Line numbers cited in the spec (`:371`, `:367`, `:331-347`, `:817`, `:832-836`, `index.ts:102`, `:292`) are refreshed here by string.

Operational notes (same as 312's Task 0): `grep -c` exits non-zero on zero matches — run expected-0 lines individually and judge by printed count, not exit code (or append `|| true`). Do not "fix" `.prettierignore` entries mid-delivery.

- [ ] **Gate A — W2 in history:** `git log --oneline | grep -i "kpr-30[5678]" | head` shows W2 commits; `ls src/agents/provider-adapters/error-classification.ts` succeeds. If either fails: **STOP.**
- [ ] **Gate B — 311 landed:** `git log --oneline | grep -i "kpr-311" | head` shows 311 commits (or its child-PR merge). If absent: **STOP.**
- [ ] **Gate C — 312 landed:** `git log --oneline | grep -i "kpr-312" | head` shows 312 commits (or its child-PR merge). If absent: **STOP.**
- [ ] Re-confirm anchored surfaces:

```bash
# 1. 312's post-state in model-router.ts (strings 312's plan Task 1 introduces):
grep -n 'TODO(KPR-314)' src/agents/model-router.ts                             # 1 hit — the pricing hand-off comment
grep -n 'const ROUTER_INPUT_USD_PER_MTOK = 1' src/agents/model-router.ts       # 1 hit
grep -n 'const ROUTER_OUTPUT_USD_PER_MTOK = 5' src/agents/model-router.ts      # 1 hit
grep -n 'const ROUTER_PROMPT_V2' src/agents/model-router.ts                    # 1 hit
grep -n 'const OUTPUT_FORMAT = jsonSchemaOutputFormat' src/agents/model-router.ts  # 1 hit
grep -n 'export function __resetRouterClientForTests' src/agents/model-router.ts   # 1 hit
grep -n 'let noKeyModeAnnounced = false' src/agents/model-router.ts            # 1 hit
grep -n 'function getClient(): Anthropic | null' src/agents/model-router.ts    # 1 hit
grep -n 'output_config: { format: OUTPUT_FORMAT }' src/agents/model-router.ts  # 1 hit
grep -n 'method: "no-key"' src/agents/model-router.ts                          # 1 hit
grep -c 'sonnetFallback' src/agents/model-router.ts                            # expect 3 (def + 2 calls)
grep -n 'finalTier === "haiku" || effort === undefined' src/agents/model-router.ts # 1 hit (the tier-check the catalog replaces)

# 2. 312's test harness (mock swap surface):
grep -n 'vi.mock("@anthropic-ai/sdk"' src/agents/model-router.test.ts          # 1 hit
grep -n 'function makeParseResponse' src/agents/model-router.test.ts           # 1 hit
grep -n 'describe("routeModel — classifier v2 (KPR-312)"' src/agents/model-router.test.ts  # 1 hit
grep -n 'describe("resolveResourceLimits"' src/agents/model-router.test.ts     # 1 hit (byte-preserved)

# 3. Meeting classifier pre-314 shape (untouched by 310–313):
grep -n 'maxBudgetUsd: 0.01' src/agents/meeting-classifier.ts                  # 1 hit (the subprocess to delete)
grep -n 'export function parseClassifierOutput' src/agents/meeting-classifier.ts # 1 hit (kept)
grep -n 'CLAUDECODE: undefined as unknown as string' src/agents/meeting-classifier.ts # 1 hit
grep -c 'respondAgentIds: \[...validIds\]' src/agents/meeting-classifier.ts    # expect 2 (catch + parse-fail fallbacks)

# 4. Memory lifecycle pre-314 shape:
grep -n 'private async runDreamQuery' src/memory/memory-lifecycle.ts           # 1 hit
grep -c 'runDreamQuery' src/memory/memory-lifecycle.ts                         # expect 5 (def + 4 phase calls)
grep -n '"claude-haiku-4-5-20251001"' src/memory/memory-lifecycle.ts           # 1 hit (inside runDreamQuery)
grep -n 'hit your limit' src/memory/memory-lifecycle.ts                        # 1 hit (the dead break)
grep -n 'autoDream run budget exhausted' src/memory/memory-lifecycle.ts        # expect 2 (throw + break match)
grep -n 'private store: MemoryStore' src/memory/memory-lifecycle.ts            # 1 hit (constructor anchor)
grep -n 'class AutoDreamBudget' src/memory/memory-lifecycle.ts                 # 1 hit
grep -n 'log.info("autoDream complete"' src/memory/memory-lifecycle.ts         # 1 hit
grep -n 'runError = String(err);' src/memory/memory-lifecycle.ts               # 1 hit (inner-phase rethrow, spec :331-347)
grep -c 'errors.push(`${agentId}: ${err}`);' src/memory/memory-lifecycle.ts    # expect 2 (sweep + dream per-agent catch, spec :367)
grep -c 'new MemoryLifecycle(' src/memory/memory-lifecycle.test.ts             # expect 19 (mechanical sweep size; recount if drifted)
grep -n 'vi.mock("@anthropic-ai/claude-agent-sdk"' src/memory/memory-lifecycle.test.ts # 1 hit (mock to delete)
grep -n 'interface DreamResult' src/memory/memory-types.ts                     # 1 hit

# 5. File processor + index wiring pre-314 shape:
grep -c 'describeImageWithGemini' src/files/file-processor.ts                  # expect 3 (def + 2 calls); 0 hits elsewhere in src/
grep -n 'export function setGeminiApiKey' src/files/file-processor.ts          # 1 hit
grep -n 'let geminiApiKey = ""' src/files/file-processor.ts                    # 1 hit
grep -n 'setGeminiApiKey(config.gemini.apiKey);' src/index.ts                  # 1 hit
grep -n 'import { setGeminiApiKey } from "./files/file-processor.js";' src/index.ts # 1 hit
grep -n 'const memoryLifecycle = new MemoryLifecycle(' src/index.ts            # 1 hit
grep -c 'config.autoDream,' src/index.ts                                       # expect 2 (memoryLifecycle ctor 4th arg + sweeper dreamConfig — the ctor site is the one the memoryLifecycle anchor above pins; Task 5 edits only that one)

# 6. Config + credentials + doctor anchors:
grep -n 'apiKey: optional("ANTHROPIC_API_KEY", "")' src/config.ts              # 1 hit
grep -n 'apiKey: optional("GEMINI_API_KEY", "")' src/config.ts                 # 1 hit
grep -n 'visionModel: optional("GEMINI_VISION_MODEL", "gemini-2.5-flash")' src/config.ts # 1 hit
grep -n 'GEMINI_API_KEY' src/setup/credential-registry.ts                      # 1 hit
grep -c 'ANTHROPIC_API_KEY' src/setup/credential-registry.ts                   # 0 or ≥1 — RECORD IT: decides the Task 8 rider
grep -n 'export function modelRouterModeLine' src/cli/doctor-checks.ts         # 1 hit (312 Task 6)
grep -n 'modelRouterModeLine(Boolean(config.anthropic.apiKey))' src/cli/doctor.ts # 1 hit (placement anchor)
grep -n 'model router: skipped (config not loaded)' src/cli/doctor.ts          # 1 hit (skipped-branch anchor)

# 7. 314 not yet applied (expected 0 hits — run individually):
ls src/llm 2>/dev/null                                                          # no such directory
grep -rn 'getLLMRegistry' src | grep -v '\.md'                                  # 0 hits
grep -rn 'GATE_TOLERANCE\|llmSidecarLine\|setVisionLlmClient\|MemoryLlmClient' src # 0 hits

# 8. SDK surface (npm ci first if node_modules absent):
node -e 'console.log(require("@anthropic-ai/sdk/package.json").version)'       # 0.82.x
grep -n 'output_config?: OutputConfig' node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts | head -1  # hit
grep -n 'jsonSchemaOutputFormat' node_modules/@anthropic-ai/sdk/helpers/json-schema.d.ts  # hit
grep -rn 'timeout?: number' node_modules/@anthropic-ai/sdk/internal/request-options.d.ts | head -1  # hit (per-request timeout option; path may vary by SDK layout — any RequestOptions.timeout hit passes)
```

- [ ] **Spec-cite refresh:** confirm the spec's behavioral claims about the four sites still hold by reading the greps above in context — in particular that `runDreamQuery` has **no timeout** today, that every phase caller handles `""` via `if (!text/…) continue`, and that the meeting classifier's two fallback paths return all-roster. Any mismatch = drift.
- [ ] Baseline gate:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: fully green before any edit.

**Escape hatch (drift found):** if any grep misses or hits a different count (except the recorded-either-way `ANTHROPIC_API_KEY` rider check and the SDK-path variance noted inline), or 312's landed router/doctor shape differs from `kpr-312-plan.md`'s quoted blocks beyond whitespace — **make no edits**. Demote to the spec lane (dodi-dev:mature-ticket) with a drift note listing exactly which anchors failed and what is there instead. The spec's sanctioned partial retreat (⚠4 metadata-only router consumption) is an in-plan decision at Task 3, not an excuse to improvise elsewhere.

**Commit:** none (read-only task).

---

## Task 1 — `src/llm/` module: types, catalog, provider-utils, providers, registry

**Goal:** the whole spec §3.1 in one compile-green addition. Nothing else imports it yet.

- [ ] **`src/llm/types.ts`** (new — PR #194 salvage, adapted per spec §4):

```ts
/**
 * KPR-314: sidecar LLM registry types (spec §3.1). Salvaged from PR #194's
 * src/llm/types.ts, trimmed to the two shipped providers and extended with
 * pricing/capabilities (the PR typed costUsd? but never populated it — the
 * registry now computes it), parsed/jsonSchema (structured outputs), and
 * stopReason (needed so the router's KPR-312 refusal/max_tokens fallback
 * conditions survive the transport swap byte-for-byte).
 *
 * NON-AGENTIC ONLY: these types serve the four sidecar call sites (router
 * classifier, meeting classifier, memory lifecycle, image description).
 * Agent turns route through provider adapters — never through this module.
 */

export type LLMProviderId = "anthropic" | "gemini"; // union grows when a site needs it

export type LLMCapability = "json" | "structured-outputs" | "vision" | "effort";

/** USD per million tokens. */
export interface LLMPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface CatalogModel {
  id: string; // e.g. "claude-haiku-4-5-20251001", "gemini-2.5-flash"
  provider: LLMProviderId;
  capabilities: LLMCapability[];
  /** Absent ⇒ cost unknown (never blocks the call — costUsd stays undefined). */
  pricing?: LLMPricing;
}

export interface LLMImageInput {
  mimeType: string;
  dataBase64: string;
}

export interface LLMRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Structured output; the provider maps it to its native mechanism. */
  jsonSchema?: object;
  images?: LLMImageInput[];
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMResult {
  text: string;
  /** Set when jsonSchema was honored natively (anthropic parsed_output). */
  parsed?: unknown;
  model: string;
  provider: LLMProviderId;
  durationMs: number;
  /** Provider-reported stop/finish reason, normalized as an opaque string
   *  (anthropic stop_reason; gemini finishReason). Callers that need 312's
   *  refusal/max_tokens fallback semantics read it; others ignore it. */
  stopReason?: string;
  usage?: LLMUsage;
  /** Computed by the REGISTRY from usage × catalog pricing — never by the
   *  provider (PR #194's defect: typed but never populated). */
  costUsd?: number;
}

export interface LLMProvider {
  readonly id: LLMProviderId;
  /** Throws on transport/HTTP error — callers own fallback (spec §3.1). */
  generate(request: LLMRequest): Promise<LLMResult>;
}

/** The four audited call sites — task bindings are code constants (spec ⚠3). */
export type LLMTask = "routerClassifier" | "meetingClassifier" | "memory" | "vision";

/** What call sites pass to generateForTask — the registry fills the model. */
export type LLMTaskRequest = Omit<LLMRequest, "model">;
```

- [ ] **`src/llm/catalog.ts`** (new — deliberately config-free: pure data + pure math, importable by any test without env stubs):

```ts
import type { CatalogModel, LLMPricing, LLMTaskRequest } from "./types.js";

/**
 * KPR-314: the single owner of sidecar-LLM model metadata (spec §3.1) —
 * the catalog KPR-312 punted (its model-router.ts TODO(KPR-314) pricing
 * constants land here). Constants ride engine releases — same maintenance
 * class as TIER_MODELS; no runtime pricing fetch (spec §7).
 *
 * Pricing is present only where a call site consumes computed cost:
 * haiku feeds router/meeting-classifier cost telemetry and the memory
 * AutoDreamBudget (the memory task is catalog-pinned to haiku, so budget
 * accounting can never silently zero out — spec §7 pricing-drift row).
 * Sonnet/opus/gemini entries exist for capability lookups (supportsEffort,
 * vision validation); their pricing is absent ⇒ costUsd undefined, which
 * never blocks a call.
 */
export const LLM_CATALOG: readonly CatalogModel[] = [
  {
    // Classifier-grade + memory-task model. Pricing moved verbatim from
    // KPR-312's interim ROUTER_INPUT_USD_PER_MTOK=1 / ROUTER_OUTPUT_USD_PER_MTOK=5.
    // No "effort": claude-haiku-4-5 rejects the param (312 §3.2 rule 2, now data).
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    capabilities: ["json", "structured-outputs"],
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    capabilities: ["json", "structured-outputs", "vision", "effort"],
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    capabilities: ["json", "structured-outputs", "vision", "effort"],
  },
  {
    // Default vision-task model (config.gemini.visionModel default).
    id: "gemini-2.5-flash",
    provider: "gemini",
    capabilities: ["json", "vision"],
  },
];

export function catalogModel(id: string): CatalogModel | undefined {
  return LLM_CATALOG.find((m) => m.id === id);
}

/**
 * Pre-call worst-case cost estimate (spec §3.4): chars/4 input estimate on
 * the ACTUAL request as sent (prompt + systemPrompt) + full maxOutputTokens
 * allowance, × catalog pricing. Deliberately conservative in two known ways
 * (chars/4 over-counts English ~5-10%; real outputs run far under the
 * allowance) — the memory gate's GATE_TOLERANCE (×1.3) absorbs exactly
 * those biases. A heuristic bound, not a hard cap (spec ⚠5(c): chars/4
 * under-counts 2-4× on CJK/token-dense text).
 *
 * Pure function — exported so tests (and the memory suite's realistic mock)
 * pin gate clearance against the real math without importing config-bound
 * registry code.
 */
export function estimateCostUsdFromPricing(pricing: LLMPricing, request: LLMTaskRequest): number {
  const inputTokens = Math.ceil((request.prompt.length + (request.systemPrompt?.length ?? 0)) / 4);
  const outputTokens = request.maxOutputTokens ?? 0;
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}
```

- [ ] **`src/llm/provider-utils.ts`** (new — PR #194 salvage, partial per spec §4: `normalizeBaseUrl` dropped with the config surface, `textPromptParts` was OpenAI-shaped, `extractJson*` unneeded — the meeting classifier keeps its own `parseClassifierOutput`):

```ts
/** KPR-314: shared provider helpers, salvaged from PR #194's provider-utils. */

export function requireApiKey(providerId: string, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`LLM provider '${providerId}' is missing an API key`);
  }
  return apiKey;
}

export function withTimeout(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

export async function parseJsonResponse<T>(response: Response, providerId: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM provider '${providerId}' returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}
```

- [ ] **`src/llm/errors.ts`** (new — config-free by construction: `file-processor.ts` and tests import these without touching `config.ts`):

```ts
import type { LLMCapability, LLMProviderId, LLMTask } from "./types.js";

/** Typed "provider unavailable" error — call sites catch into their per-site fallbacks. */
export class LLMProviderUnavailableError extends Error {
  constructor(
    readonly providerId: LLMProviderId,
    readonly task: LLMTask,
  ) {
    super(`LLM provider '${providerId}' unavailable (no API key resolved) — task '${task}' cannot run`);
    this.name = "LLMProviderUnavailableError";
  }
}

/** Typed capability-mismatch error — a boot-time configuration fault, not a per-call 400. */
export class LLMCapabilityError extends Error {
  constructor(task: LLMTask, modelId: string, capability: LLMCapability) {
    super(`LLM task '${task}' is bound to model '${modelId}' which lacks required capability '${capability}'`);
    this.name = "LLMCapabilityError";
  }
}
```

- [ ] **`src/llm/providers/anthropic-provider.ts`** (new — **re-derived** on `@anthropic-ai/sdk` per spec §4; PR #194's raw-fetch adapter discarded):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { LLMProvider, LLMRequest, LLMResult } from "../types.js";
import { requireApiKey } from "../provider-utils.js";

/** Applied when a call site omits maxOutputTokens (the API requires max_tokens). */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * KPR-314: direct Messages API transport for the anthropic sidecar tasks —
 * one shared keep-alive client (the same motivation as KPR-122's in-process
 * MCPs and KPR-312's router client, which this replaces as the shared
 * instance). maxRetries: 0 — callers own retry/fallback semantics (312).
 * Structured output via messages.parse + jsonSchemaOutputFormat (GA — 312's
 * exact mechanism); plain generation via messages.create.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey: requireApiKey("anthropic", apiKey),
      maxRetries: 0,
    });
  }

  async generate(request: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const content: Anthropic.ContentBlockParam[] = [
      ...(request.images ?? []).map(
        (img): Anthropic.ImageBlockParam => ({
          type: "image",
          source: {
            type: "base64",
            // Callers pass real image mimetypes; the API rejects others — a
            // caller error surfaced as a thrown 400, per the throw contract.
            media_type: img.mimeType as Anthropic.Base64ImageSource["media_type"],
            data: img.dataBase64,
          },
        }),
      ),
      { type: "text", text: request.prompt },
    ];
    const params = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [{ role: "user" as const, content }],
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    // Per-request wall clock (TS SDK unit: ms) — replaces 312's client-level timeout.
    const requestOptions = request.timeoutMs ? { timeout: request.timeoutMs } : undefined;

    if (request.jsonSchema) {
      const response = await this.client.messages.parse(
        {
          ...params,
          output_config: {
            format: jsonSchemaOutputFormat(
              request.jsonSchema as Parameters<typeof jsonSchemaOutputFormat>[0],
            ),
          },
        },
        requestOptions,
      );
      return this.toResult(request.model, response, response.parsed_output ?? undefined, started);
    }

    const response = await this.client.messages.create(params, requestOptions);
    return this.toResult(request.model, response, undefined, started);
  }

  private toResult(
    model: string,
    response: Anthropic.Message,
    parsed: unknown,
    started: number,
  ): LLMResult {
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      ...(parsed !== undefined ? { parsed } : {}),
      model,
      provider: this.id,
      durationMs: Date.now() - started,
      stopReason: response.stop_reason ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
```

Implementation notes: if `messages.parse`'s response type is not assignable to `Anthropic.Message` for `toResult` (parsed-message wrapper types vary), widen the parameter to the narrowest common structural type (`{ content; stop_reason; usage }`) — do not use `any`. If `jsonSchemaOutputFormat`'s parameter type accepts our `object` directly, drop the cast.

- [ ] **`src/llm/providers/gemini-provider.ts`** (new — PR #194 salvage near-verbatim; constructor simplified to a bare key since the config surface is dropped; pilot-grade per spec D3):

```ts
import type { LLMProvider, LLMRequest, LLMResult } from "../types.js";
import { parseJsonResponse, requireApiKey, withTimeout } from "../provider-utils.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * KPR-314: Gemini REST transport (generateContent + inline base64) —
 * salvaged from PR #194 / the previous file-processor.ts inline fetch.
 * Pilot-grade (spec D3): enough for the vision task, no more. jsonSchema
 * requests degrade to responseMimeType json (no schema enforcement) — no
 * shipped call site sends a schema to gemini.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = requireApiKey("gemini", apiKey);
  }

  async generate(request: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const parts: Array<Record<string, unknown>> = [{ text: request.prompt }];
    for (const image of request.images ?? []) {
      parts.unshift({
        inline_data: { mime_type: image.mimeType, data: image.dataBase64 },
      });
    }

    const response = await fetch(
      `${BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: withTimeout(request.timeoutMs),
        body: JSON.stringify({
          ...(request.systemPrompt
            ? { system_instruction: { parts: [{ text: request.systemPrompt }] } }
            : {}),
          contents: [{ role: "user", parts }],
          generationConfig: {
            ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.jsonSchema ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    );

    const body = await parseJsonResponse<GeminiResponse>(response, this.id);
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

    return {
      text,
      model: request.model,
      provider: this.id,
      durationMs: Date.now() - started,
      stopReason: candidate?.finishReason,
      usage: body.usageMetadata
        ? {
            inputTokens: body.usageMetadata.promptTokenCount,
            outputTokens: body.usageMetadata.candidatesTokenCount,
          }
        : undefined,
    };
  }
}
```

- [ ] **`src/llm/registry.ts`** (new — PR #194's registry salvaged, simplified: yaml config input → code constants; `generateWithModel` dropped; cost computation added):

```ts
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { LLM_CATALOG, catalogModel, estimateCostUsdFromPricing } from "./catalog.js";
import { LLMCapabilityError, LLMProviderUnavailableError } from "./errors.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { GeminiProvider } from "./providers/gemini-provider.js";
import type {
  CatalogModel,
  LLMCapability,
  LLMPricing,
  LLMProvider,
  LLMProviderId,
  LLMResult,
  LLMTask,
  LLMTaskRequest,
  LLMUsage,
} from "./types.js";

const log = createLogger("llm-registry");

/** The memory task is catalog-pinned — no env override exists today; none added (spec §3.1). */
const MEMORY_MODEL_ID = "claude-haiku-4-5-20251001";

interface TaskBinding {
  provider: LLMProviderId;
  /** Resolved per call so today's env overrides keep steering (spec §3.1). */
  modelId(): string;
  requiredCapability?: LLMCapability;
}

/**
 * Task bindings are code constants (spec ⚠3 — no yaml/env alias surface).
 * The classifier-grade entry honors config.modelRouter.model (MODEL_ROUTER_MODEL)
 * for BOTH classifiers — preserving today's coupling (the meeting classifier
 * borrows the router's model). The vision entry honors config.gemini.visionModel
 * (GEMINI_VISION_MODEL). The memory task is catalog-pinned haiku.
 */
const TASKS: Record<LLMTask, TaskBinding> = {
  routerClassifier: { provider: "anthropic", modelId: () => config.modelRouter.model },
  meetingClassifier: { provider: "anthropic", modelId: () => config.modelRouter.model },
  memory: { provider: "anthropic", modelId: () => MEMORY_MODEL_ID },
  vision: { provider: "gemini", modelId: () => config.gemini.visionModel, requiredCapability: "vision" },
};

export class LLMRegistry {
  private readonly providers = new Map<LLMProviderId, LLMProvider>();
  private readonly warnedOffCatalog = new Set<string>();
  private readonly erroredCapability = new Set<LLMTask>();

  /** Providers are constructed ONLY for keys that resolve (PR #194's gating rule, kept). */
  constructor(keys: { anthropicApiKey: string; geminiApiKey: string }) {
    if (keys.anthropicApiKey) this.providers.set("anthropic", new AnthropicProvider(keys.anthropicApiKey));
    if (keys.geminiApiKey) this.providers.set("gemini", new GeminiProvider(keys.geminiApiKey));
    // Boot visibility (spec §3.6): mirror of the hive doctor line. Steady
    // state, log once at construction — never per call.
    log.info("LLM registry constructed", {
      anthropic: this.providers.has("anthropic"),
      gemini: this.providers.has("gemini"),
      catalogModels: LLM_CATALOG.length,
    });
    if (!this.providers.has("anthropic")) {
      log.info(
        "LLM sidecar: anthropic unavailable (no ANTHROPIC_API_KEY) — meeting classifier degrades to all-roster, memory dream LLM phases skip (router: heuristics-only per KPR-312)",
      );
    }
    if (!this.providers.has("gemini")) {
      log.info("LLM sidecar: gemini unavailable (no GEMINI_API_KEY) — image description off");
    }
  }

  hasProvider(id: LLMProviderId): boolean {
    return this.providers.has(id);
  }

  /**
   * Resolve task → catalog model → provider, validate capabilities, fire the
   * call, and compute costUsd from usage × catalog pricing (spec §3.1).
   * Throws: LLMProviderUnavailableError (no key), LLMCapabilityError
   * (misbound task), or the provider's transport error — callers own fallback.
   */
  async generateForTask(task: LLMTask, request: LLMTaskRequest): Promise<LLMResult> {
    const binding = TASKS[task];
    const provider = this.providers.get(binding.provider);
    if (!provider) throw new LLMProviderUnavailableError(binding.provider, task);

    const modelId = binding.modelId();
    const model = catalogModel(modelId);
    if (!model) {
      // Off-catalog override (e.g. MODEL_ROUTER_MODEL set to an unknown id):
      // the call proceeds — observability degrades, behavior doesn't. One
      // warn per model id per process. Capability checks are skipped (we
      // can't know); an incapable model 400s → per-site fallback (spec §7).
      if (!this.warnedOffCatalog.has(modelId)) {
        this.warnedOffCatalog.add(modelId);
        log.warn("LLM model id not in catalog — costUsd will be undefined (cost telemetry degraded)", {
          task,
          model: modelId,
        });
      }
    } else {
      this.validateCapabilities(task, binding, model, request);
    }

    const result = await provider.generate({ ...request, model: modelId });
    const costUsd = this.computeCostUsd(modelId, result.usage);
    return costUsd !== undefined ? { ...result, costUsd } : result;
  }

  /**
   * Pre-call worst-case estimate for the task's bound model (spec §3.4's
   * memory gate). undefined when pricing is unknown — an undefined estimate
   * never gates (moot for the catalog-pinned memory task).
   */
  estimateCostUsd(task: LLMTask, request: LLMTaskRequest): number | undefined {
    const pricing = this.pricingFor(TASKS[task].modelId());
    return pricing ? estimateCostUsdFromPricing(pricing, request) : undefined;
  }

  /** Metadata accessor for KPR-312's hand-off (spec §3.2 item 1 / ⚠4). */
  pricingFor(modelId: string): LLMPricing | undefined {
    return catalogModel(modelId)?.pricing;
  }

  /** Catalog-driven effort capability (spec §3.2 item 2). Unknown id ⇒ false —
   *  never emit a param that might 400 (conservative). */
  supportsEffort(modelId: string): boolean {
    return catalogModel(modelId)?.capabilities.includes("effort") ?? false;
  }

  private validateCapabilities(
    task: LLMTask,
    binding: TaskBinding,
    model: CatalogModel,
    request: LLMTaskRequest,
  ): void {
    const missing =
      binding.requiredCapability && !model.capabilities.includes(binding.requiredCapability)
        ? binding.requiredCapability
        : request.jsonSchema &&
            !model.capabilities.some((c) => c === "structured-outputs" || c === "json")
          ? ("structured-outputs" as const)
          : undefined;
    if (!missing) return;
    // Configuration error surfaced once per task in logs (spec §3.5: "a
    // boot-time configuration error surfaced in logs, not a per-image 400").
    if (!this.erroredCapability.has(task)) {
      this.erroredCapability.add(task);
      log.error("LLM task bound to a model lacking a required capability", {
        task,
        model: model.id,
        missing,
      });
    }
    throw new LLMCapabilityError(task, model.id, missing);
  }

  private computeCostUsd(modelId: string, usage: LLMUsage | undefined): number | undefined {
    const pricing = catalogModel(modelId)?.pricing;
    if (!pricing || usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      return undefined;
    }
    return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
  }
}

// ── Singleton (PR #194's accessor shape; reset seam per archetypes/registry.ts precedent) ──
let registry: LLMRegistry | null = null;

export function getLLMRegistry(): LLMRegistry {
  return (registry ??= new LLMRegistry({
    anthropicApiKey: config.anthropic.apiKey,
    geminiApiKey: config.gemini.apiKey,
  }));
}

/** Test-only seam. */
export function __resetLLMRegistryForTests(): void {
  registry = null;
}
```

- [ ] Verify:

```bash
npm run typecheck
npx vitest run src/llm/ || true   # no tests yet — expect "no test files found"; typecheck is the gate here
```
Expected: typecheck green.

- [ ] **Commit:** `KPR-314: W3.5 T1 — src/llm registry: catalog (312 pricing hand-off), anthropic SDK provider, gemini REST provider, task bindings`

---

## Task 2 — Registry + provider unit tests (contract groups 1–3)

- [ ] **`src/llm/registry.test.ts`** (new):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLog, mockConfig, mockAnthropicGenerate, mockGeminiGenerate, anthropicCtor, geminiCtor } =
  vi.hoisted(() => ({
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockConfig: {
      anthropic: { apiKey: "ant-key" },
      gemini: { apiKey: "gem-key", visionModel: "gemini-2.5-flash" },
      modelRouter: { model: "claude-haiku-4-5-20251001", timeoutMs: 4000 },
    },
    mockAnthropicGenerate: vi.fn(),
    mockGeminiGenerate: vi.fn(),
    anthropicCtor: vi.fn(),
    geminiCtor: vi.fn(),
  }));

vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));
vi.mock("../config.js", () => ({ config: mockConfig }));
vi.mock("./providers/anthropic-provider.js", () => ({
  AnthropicProvider: class {
    id = "anthropic" as const;
    generate = mockAnthropicGenerate;
    constructor(key: string) {
      anthropicCtor(key);
    }
  },
}));
vi.mock("./providers/gemini-provider.js", () => ({
  GeminiProvider: class {
    id = "gemini" as const;
    generate = mockGeminiGenerate;
    constructor(key: string) {
      geminiCtor(key);
    }
  },
}));

import { LLMRegistry, getLLMRegistry, __resetLLMRegistryForTests } from "./registry.js";
import { LLMProviderUnavailableError, LLMCapabilityError } from "./errors.js";
import { LLM_CATALOG, catalogModel, estimateCostUsdFromPricing } from "./catalog.js";

const HAIKU_PRICING = { inputPerMTok: 1, outputPerMTok: 5 };

function makeProviderResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "out",
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic" as const,
    durationMs: 5,
    stopReason: "end_turn",
    usage: { inputTokens: 500, outputTokens: 10 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetLLMRegistryForTests();
  mockConfig.modelRouter.model = "claude-haiku-4-5-20251001";
  mockConfig.gemini.visionModel = "gemini-2.5-flash";
  mockAnthropicGenerate.mockResolvedValue(makeProviderResult());
  mockGeminiGenerate.mockResolvedValue(makeProviderResult({ provider: "gemini", model: "gemini-2.5-flash" }));
});

describe("LLMRegistry — key-gated construction", () => {
  it("constructs a provider only when its key resolves", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    expect(r.hasProvider("anthropic")).toBe(true);
    expect(r.hasProvider("gemini")).toBe(false);
    expect(anthropicCtor).toHaveBeenCalledWith("a");
    expect(geminiCtor).not.toHaveBeenCalled();
  });

  it("zero keys is a valid state — boots, both providers absent", () => {
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "" });
    expect(r.hasProvider("anthropic")).toBe(false);
    expect(r.hasProvider("gemini")).toBe(false);
  });

  it("throws typed unavailable error on task resolve without a key", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "" });
    await expect(r.generateForTask("meetingClassifier", { prompt: "p" })).rejects.toBeInstanceOf(
      LLMProviderUnavailableError,
    );
    expect(mockAnthropicGenerate).not.toHaveBeenCalled();
  });

  it("getLLMRegistry is a singleton keyed off config", () => {
    expect(getLLMRegistry()).toBe(getLLMRegistry());
  });
});

describe("LLMRegistry — task resolution", () => {
  it("classifier tasks honor config.modelRouter.model; memory is catalog-pinned; vision honors visionModel", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "g" });
    await r.generateForTask("routerClassifier", { prompt: "p" });
    await r.generateForTask("meetingClassifier", { prompt: "p" });
    await r.generateForTask("memory", { prompt: "p" });
    await r.generateForTask("vision", { prompt: "p" });
    expect(mockAnthropicGenerate.mock.calls.map((c) => c[0].model)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20251001",
    ]);
    expect(mockGeminiGenerate.mock.calls[0][0].model).toBe("gemini-2.5-flash");
  });

  it("request fields pass through to the provider", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    await r.generateForTask("memory", { prompt: "p", maxOutputTokens: 256, temperature: 0, timeoutMs: 30_000 });
    expect(mockAnthropicGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "p", maxOutputTokens: 256, temperature: 0, timeoutMs: 30_000 }),
    );
  });
});

describe("LLMRegistry — cost computation (the PR #194 defect fix)", () => {
  it("computes costUsd from usage × catalog pricing — 500 in / 10 out on haiku = $0.00055 (KPR-312's math re-anchored)", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    const result = await r.generateForTask("memory", { prompt: "p" });
    expect(result.costUsd).toBeCloseTo(0.00055, 8);
  });

  it("costUsd undefined when the model has no catalog pricing (gemini vision)", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "g" });
    const result = await r.generateForTask("vision", { prompt: "p" });
    expect(result.costUsd).toBeUndefined();
  });

  it("costUsd undefined when the provider returned no usage", async () => {
    mockAnthropicGenerate.mockResolvedValueOnce(makeProviderResult({ usage: undefined }));
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    const result = await r.generateForTask("memory", { prompt: "p" });
    expect(result.costUsd).toBeUndefined();
  });

  it("off-catalog model id: call proceeds, costUsd undefined, ONE warn across repeated calls", async () => {
    mockConfig.modelRouter.model = "my-custom-haiku";
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    const r1 = await r.generateForTask("routerClassifier", { prompt: "p" });
    const r2 = await r.generateForTask("routerClassifier", { prompt: "p" });
    expect(r1.costUsd).toBeUndefined();
    expect(r2.costUsd).toBeUndefined();
    expect(mockAnthropicGenerate).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });
});

describe("LLMRegistry — capability validation", () => {
  it("vision task bound to a catalog non-vision model throws LLMCapabilityError with ONE log.error", async () => {
    mockConfig.gemini.visionModel = "claude-haiku-4-5-20251001"; // catalog entry, no "vision"
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "g" });
    await expect(r.generateForTask("vision", { prompt: "p" })).rejects.toBeInstanceOf(LLMCapabilityError);
    await expect(r.generateForTask("vision", { prompt: "p" })).rejects.toBeInstanceOf(LLMCapabilityError);
    expect(mockGeminiGenerate).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });

  it("schema-bearing request passes on a structured-outputs model", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    await expect(
      r.generateForTask("meetingClassifier", { prompt: "p", jsonSchema: { type: "object" } }),
    ).resolves.toBeDefined();
  });
});

describe("catalog metadata (spec §3.2 pins)", () => {
  it("supportsEffort: haiku false, sonnet true, opus true, unknown false", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    expect(r.supportsEffort("claude-haiku-4-5-20251001")).toBe(false);
    expect(r.supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(r.supportsEffort("claude-opus-4-7")).toBe(true);
    expect(r.supportsEffort("mystery-model")).toBe(false);
  });

  it("haiku pricing is KPR-312's constants ($1/$5 per MTok)", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    expect(r.pricingFor("claude-haiku-4-5-20251001")).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(r.pricingFor("gemini-2.5-flash")).toBeUndefined();
  });

  it("every catalog id is unique and provider-typed", () => {
    expect(new Set(LLM_CATALOG.map((m) => m.id)).size).toBe(LLM_CATALOG.length);
    expect(catalogModel("claude-haiku-4-5-20251001")?.provider).toBe("anthropic");
  });
});

describe("estimateCostUsd (the memory gate's math — spec §3.4 triple)", () => {
  it.each([
    [32_640, 0.00944], // fitted cold-summary page + wrapper (8,160 est. input tokens)
    [36_000, 0.01028], // shallow-over band page (9,000 est. input tokens)
    [96_000, 0.02528], // deep-over min-records page (24,000 est. input tokens; spec's ≈$0.0253)
  ])("prompt of %i chars at 256 max output ⇒ $%f", (chars, expected) => {
    const estimate = estimateCostUsdFromPricing(HAIKU_PRICING, {
      prompt: "x".repeat(chars),
      maxOutputTokens: 256,
    });
    expect(estimate).toBeCloseTo(expected, 8);
  });

  it("registry-level estimate uses the task's bound model pricing; pricing-less task ⇒ undefined", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "g" });
    expect(r.estimateCostUsd("memory", { prompt: "x".repeat(32_640), maxOutputTokens: 256 })).toBeCloseTo(
      0.00944,
      8,
    );
    expect(r.estimateCostUsd("vision", { prompt: "p", maxOutputTokens: 2048 })).toBeUndefined();
  });

  it("systemPrompt chars count toward the input estimate", () => {
    const withSystem = estimateCostUsdFromPricing(HAIKU_PRICING, {
      prompt: "x".repeat(4000),
      systemPrompt: "y".repeat(4000),
      maxOutputTokens: 0,
    });
    expect(withSystem).toBeCloseTo(0.002, 8); // 2000 tokens × $1/MTok
  });
});
```

- [ ] **`src/llm/providers/anthropic-provider.test.ts`** (new — mocked SDK, 312's Task 2 mock pattern):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockParse, mockCreate, mockCtor } = vi.hoisted(() => ({
  mockParse: vi.fn(),
  mockCreate: vi.fn(),
  mockCtor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { parse: mockParse, create: mockCreate };
    constructor(opts: unknown) {
      mockCtor(opts);
    }
  },
}));
// jsonSchemaOutputFormat deliberately NOT mocked — pure helper, no network.

import { AnthropicProvider } from "./anthropic-provider.js";

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockParse.mockResolvedValue(makeMessage({ parsed_output: { ok: true } }));
  mockCreate.mockResolvedValue(makeMessage());
});

describe("AnthropicProvider", () => {
  it("constructs one client with apiKey and maxRetries: 0; empty key throws", () => {
    new AnthropicProvider("k");
    expect(mockCtor).toHaveBeenCalledWith({ apiKey: "k", maxRetries: 0 });
    expect(() => new AnthropicProvider("")).toThrow("missing an API key");
  });

  it("schema request → messages.parse with output_config; parsed mapped from parsed_output", async () => {
    const p = new AnthropicProvider("k");
    const result = await p.generate({
      model: "claude-haiku-4-5-20251001",
      prompt: "classify",
      systemPrompt: "sys",
      maxOutputTokens: 100,
      jsonSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 4000,
    });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    const [params, opts] = mockParse.mock.calls[0]!;
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.max_tokens).toBe(100);
    expect(params.system).toBe("sys");
    expect(params.output_config?.format).toBeDefined();
    expect(opts).toEqual({ timeout: 4000 });
    expect(result.parsed).toEqual({ ok: true });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.provider).toBe("anthropic");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("plain request → messages.create, no parse, parsed key absent", async () => {
    const p = new AnthropicProvider("k");
    const result = await p.generate({ model: "m", prompt: "summarize", maxOutputTokens: 256, temperature: 0 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockParse).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0);
    expect("parsed" in result).toBe(false);
    expect(result.text).toBe('{"ok":true}');
  });

  it("no timeoutMs ⇒ no request options object", async () => {
    const p = new AnthropicProvider("k");
    await p.generate({ model: "m", prompt: "x" });
    expect(mockCreate.mock.calls[0]![1]).toBeUndefined();
  });

  it("images map to base64 image blocks BEFORE the text block", async () => {
    const p = new AnthropicProvider("k");
    await p.generate({
      model: "m",
      prompt: "describe",
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
    });
    const content = mockCreate.mock.calls[0]![0].messages[0].content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(content[1]).toEqual({ type: "text", text: "describe" });
  });

  it("propagates thrown SDK errors (no swallowing — callers own fallback)", async () => {
    mockCreate.mockRejectedValueOnce(new Error("529 overloaded"));
    const p = new AnthropicProvider("k");
    await expect(p.generate({ model: "m", prompt: "x" })).rejects.toThrow("529 overloaded");
  });
});
```

- [ ] **`src/llm/providers/gemini-provider.test.ts`** (new — salvage PR #194's stubbed-fetch suite, adapted to the bare-key constructor + `generate` rename):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { GeminiProvider } from "./gemini-provider.js";

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function geminiBody(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiProvider", () => {
  it("throws without an API key", () => {
    expect(() => new GeminiProvider("")).toThrow("missing an API key");
  });

  it("sends generateContent with inline base64 parts before text, system_instruction, generationConfig", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeOkResponse(geminiBody("a cat")));
    vi.stubGlobal("fetch", fetchSpy);
    const p = new GeminiProvider("gem-key");
    const result = await p.generate({
      model: "gemini-2.5-flash",
      prompt: "describe",
      systemPrompt: "be thorough",
      maxOutputTokens: 2048,
      temperature: 0,
      timeoutMs: 30_000,
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(url).toContain("key=gem-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
    expect(body.contents[0].parts[1]).toEqual({ text: "describe" });
    expect(body.system_instruction.parts[0].text).toBe("be thorough");
    expect(body.generationConfig).toEqual({ maxOutputTokens: 2048, temperature: 0 });
    expect(result.text).toBe("a cat");
    expect(result.stopReason).toBe("STOP");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 8 });
  });

  it("no timeoutMs ⇒ no abort signal", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeOkResponse(geminiBody("x")));
    vi.stubGlobal("fetch", fetchSpy);
    await new GeminiProvider("k").generate({ model: "m", prompt: "p" });
    expect(fetchSpy.mock.calls[0]![1].signal).toBeUndefined();
  });

  it("non-OK response throws with status and body slice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("quota exceeded", { status: 429 })));
    await expect(new GeminiProvider("k").generate({ model: "m", prompt: "p" })).rejects.toThrow(
      "LLM provider 'gemini' returned 429: quota exceeded",
    );
  });

  it("never leaks the API key into thrown errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    const err = (await new GeminiProvider("gem-secret")
      .generate({ model: "m", prompt: "p" })
      .catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("gem-secret");
  });

  it("empty candidates yield empty text (caller treats as failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeOkResponse({})));
    const result = await new GeminiProvider("k").generate({ model: "m", prompt: "p" });
    expect(result.text).toBe("");
    expect(result.usage).toBeUndefined();
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/llm/
npm run typecheck
```
Expected: all new suites green.

- [ ] **Negative-verify N1 (the PR #194 defect):** in `registry.ts`'s `generateForTask`, temporarily return `result` without the costUsd merge. Run `npx vitest run src/llm/registry.test.ts` → EXPECT the $0.00055 pin to fail. Restore, re-run, green. (Do not commit the mutation.)

- [ ] **Commit:** `KPR-314: W3.5 T2 — registry + provider unit tests: key gating, task resolution, cost math, estimate pins, capability validation`

---

## Task 3 — Router classifier: registry consumption (spec §3.2, the 312 hand-off)

**Goal:** delete 312's interim pricing constants (item 1), catalog-drive the effort drop (item 2), and swap the transport onto the registry provider (item 3, thin swap) — heuristics, no-key truth condition, prompt, fallback shapes, `method` tags all byte-preserved. Source and tests land together (the transport swap invalidates 312's SDK-level mocks immediately).

**Sanctioned retreat (spec ⚠4):** if the generic interface can't carry a 312 option cleanly at implementation time, keep 312's module-level client for transport and consume metadata only (items 1–2: pricing via `pricingFor`/registry `costUsd` is then computed locally from that pricing; effort via `supportsEffort`). Record the retreat in the commit body and hand-off. Do NOT invent a third shape.

All edits in `src/agents/model-router.ts` against 312's plan-defined post-state (Task 0 verified the anchors).

- [ ] **Imports** — old:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
```

New:

```ts
import { getLLMRegistry } from "../llm/registry.js";
```

- [ ] **Delete the pricing constants** — the block 312's plan Task 1 introduced (JSDoc beginning `KPR-312: interim classifier pricing` through the two consts `ROUTER_INPUT_USD_PER_MTOK` / `ROUTER_OUTPUT_USD_PER_MTOK`, including the `TODO(KPR-314)` line — this plan is that TODO's discharge).

- [ ] **Schema constant** — old (312's `OUTPUT_FORMAT = jsonSchemaOutputFormat({...} as const);` block). New:

```ts
/** Strict output schema — KPR-314: passed raw to the registry's anthropic
 *  provider, which wraps it in the SDK's jsonSchemaOutputFormat (GA,
 *  server-compiled + cached — 312's exact mechanism, one layer down). */
const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["haiku", "sonnet", "opus"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["tier", "effort"],
  additionalProperties: false,
} as const;
```

- [ ] **Client section** — old (312's `// ── Anthropic client (module-level, lazy, shared) ──…` comment block, `let client`, `let noKeyModeAnnounced`, `function getClient()`, and `__resetRouterClientForTests`). New:

```ts
// ── Transport (KPR-314) ────────────────────────────────────────────────
// The classifier call rides the LLM registry's shared anthropic provider —
// one keep-alive client across router + meeting classifier + memory sites.
// No-key mode derives from hasProvider("anthropic") (identical truth
// condition to 312's getClient() null check: key presence).
let noKeyModeAnnounced = false;

/** Test-only seam (renamed from 312's __resetRouterClientForTests — the
 *  router no longer holds a client; the registry has its own reset). */
export function __resetRouterStateForTests(): void {
  noKeyModeAnnounced = false;
}
```

- [ ] **No-key branch** — old:

```ts
  const anthropic = getClient();
  if (!anthropic) {
```

New:

```ts
  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) {
```

(The branch body — announce-once log, agent-default model, default-tier limits, `method: "no-key"` — is untouched.)

- [ ] **Model path** — old (312's block from `const startedAt = Date.now();` through the end of the `try`'s return, exclusive of the `catch`). New:

```ts
  try {
    const result = await registry.generateForTask("routerClassifier", {
      prompt: classifierInput,
      systemPrompt: ROUTER_PROMPT_V2,
      maxOutputTokens: 100,
      jsonSchema: ROUTER_SCHEMA,
      timeoutMs: config.modelRouter.timeoutMs, // per-request wall clock (was 312's client-level timeout)
    });

    // KPR-312's fallback conditions, byte-preserved across the transport
    // swap (LLMResult.stopReason exists for exactly this).
    const parsed = result.parsed as { tier?: string; effort?: string } | undefined;
    if (
      result.stopReason === "refusal" ||
      result.stopReason === "max_tokens" ||
      !parsed ||
      TIER_RANK[parsed.tier as ModelTier] === undefined
    ) {
      log.warn("Model router returned unusable output, defaulting to sonnet", {
        stopReason: result.stopReason,
        hasParsedOutput: Boolean(parsed),
      });
      return sonnetFallback(ceilingTier, resourceTierOverrides);
    }

    const requested = parsed.tier as ModelTier;
    const effort: ReasoningEffort | undefined =
      parsed.effort === "low" || parsed.effort === "medium" || parsed.effort === "high"
        ? parsed.effort
        : undefined;
    // KPR-314: cost computed by the registry (usage × catalog pricing — the
    // 312 TODO hand-off). Off-catalog MODEL_ROUTER_MODEL override ⇒ undefined
    // ⇒ 0: cost telemetry degrades, routing doesn't (registry warns once).
    const costUsd = result.costUsd ?? 0;
    const durationMs = result.durationMs;

    // Cap at ceiling (kept from v1).
    let finalTier = requested;
    if (TIER_RANK[requested] > TIER_RANK[ceilingTier]) {
      finalTier = ceilingTier;
      log.debug("Model router capped by ceiling", { requested, ceiling: ceilingTier });
    }

    // Log-redaction convention: no message text / input previews.
    log.info("Model router decision", {
      tier: finalTier,
      requested,
      effort,
      ceiling: ceilingTier,
      costUsd,
      durationMs,
    });

    return {
      tier: finalTier,
      model: TIER_MODELS[finalTier],
      costUsd,
      durationMs,
      resourceLimits: resolveResourceLimits(finalTier, resourceTierOverrides),
      method: "model",
      // KPR-312 §3.2 rule 2, catalog-driven since KPR-314: drop effort when
      // the FINAL (post-cap) model doesn't support the param (haiku today —
      // same behavior, now data instead of a hardcoded tier check).
      ...(effort === undefined || !registry.supportsEffort(TIER_MODELS[finalTier])
        ? {}
        : { effort }),
    };
  } catch (err) {
```

(The `catch` body — warn + `sonnetFallback` — is untouched.)

- [ ] Typecheck checkpoint: `npm run typecheck` — expect only `model-router.test.ts` runtime failures ahead (mock swap next), types green.

- [ ] **`src/agents/model-router.test.ts`** — two replacements; the pre-existing `resolveResourceLimits` describe stays byte-identical between them.

1. Replace 312's mocks header (the `vi.hoisted` block, the `vi.mock("@anthropic-ai/sdk", …)` block + its NOTE comment, the config/logger mocks, and the import list) with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (KPR-312 harness, re-anchored by KPR-314) ────────────────────
// The classifier's transport is the LLM registry (KPR-314); tests mock the
// registry module instead of the Anthropic SDK. Behavior pins carried over
// from 312 unchanged: heuristics, fallback shapes, no-key mode, effort rules.
const { mockGenerateForTask, mockHasProvider, mockSupportsEffort, mockConfig } = vi.hoisted(() => ({
  mockGenerateForTask: vi.fn(),
  mockHasProvider: vi.fn(() => true),
  // Real-catalog shape: haiku effort-less, sonnet/opus effort-capable.
  mockSupportsEffort: vi.fn((model: string) => !model.includes("haiku")),
  mockConfig: {
    anthropic: { apiKey: "test-key" },
    modelRouter: { enabled: true, model: "claude-haiku-4-5-20251001", timeoutMs: 4000 },
  },
}));

vi.mock("../llm/registry.js", () => ({
  getLLMRegistry: () => ({
    generateForTask: mockGenerateForTask,
    hasProvider: mockHasProvider,
    supportsEffort: mockSupportsEffort,
  }),
}));

vi.mock("../config.js", () => ({ config: mockConfig }));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  routeModel,
  resolveResourceLimits,
  RESOURCE_TIER_DEFAULTS,
  __resetRouterStateForTests,
  type ModelRouterResult,
} from "./model-router.js";
```

2. Replace the entire `describe("routeModel — classifier v2 (KPR-312)")` block (and 312's `makeParseResponse` helper above it) with the block below — the same behavioral pins re-anchored, plus the KPR-314 additions (request shape, cost passthrough, `supportsEffort` rules):

```ts
function makeLlmResult(
  parsed: { tier: string; effort: string } | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    text: parsed ? JSON.stringify(parsed) : "",
    ...(parsed ? { parsed } : {}),
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic" as const,
    durationMs: 7,
    stopReason: "end_turn",
    usage: { inputTokens: 500, outputTokens: 10 },
    costUsd: 0.00055,
    ...overrides,
  };
}

describe("routeModel — classifier v2 (KPR-312, registry transport KPR-314)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasProvider.mockReturnValue(true);
    mockSupportsEffort.mockImplementation((model: string) => !model.includes("haiku"));
    __resetRouterStateForTests();
    mockGenerateForTask.mockResolvedValue(makeLlmResult({ tier: "sonnet", effort: "medium" }));
  });

  describe("heuristics (H1–H3) — 312 pins, transport-agnostic", () => {
    it("H1: haiku ceiling short-circuits — $0, method heuristic, no effort, no registry call", async () => {
      const r = await routeModel("do something elaborate", "claude-haiku-4-5-20251001");
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, durationMs: 0, method: "heuristic" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
      expect("effort" in r).toBe(false);
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it.each(["thanks", "Thanks", "  ok  ", "THANK YOU", "👍", "got it", "will do"])(
      "H2: exact-match ack %j → haiku heuristic, no registry call",
      async (msg) => {
        const r = await routeModel(msg, "claude-opus-4-7");
        expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
        expect("effort" in r).toBe(false);
        expect(mockGenerateForTask).not.toHaveBeenCalled();
      },
    );

    it("H2 is exact-match only: 'fire the sales team' goes to the model", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "opus", effort: "high" }));
      const r = await routeModel("fire the sales team", "claude-opus-4-7");
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ tier: "opus", method: "model" });
    });

    it("H2 is exact-match only: 'thanks, also rewrite the contract' goes to the model", async () => {
      await routeModel("thanks, also rewrite the contract", "claude-opus-4-7");
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
    });

    it("H3: empty text without files → haiku heuristic", async () => {
      const r = await routeModel("   ", "claude-opus-4-7", undefined, { hasFiles: false });
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it("H3: empty text WITH files is not short-circuited — model path with placeholder input", async () => {
      await routeModel("", "claude-opus-4-7", undefined, { hasFiles: true });
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
      const req = mockGenerateForTask.mock.calls[0]![1];
      expect(req.prompt).toBe("(attachment-only message, no text)");
    });

    it("truncates classifier input above the bound; classification proceeds", async () => {
      const huge = "x".repeat(6000);
      const r = await routeModel(huge, "claude-opus-4-7");
      const prompt: string = mockGenerateForTask.mock.calls[0]![1].prompt;
      expect(prompt.length).toBe(4000 + "\n[...truncated]".length);
      expect(prompt.endsWith("[...truncated]")).toBe(true);
      expect(r.method).toBe("model");
    });
  });

  describe("model path (mocked registry)", () => {
    it("KPR-314 request shape: routerClassifier task, v2 prompt, schema, 100 tokens, config timeout", async () => {
      await routeModel("draft the quarterly summary", "claude-opus-4-7");
      const [task, req] = mockGenerateForTask.mock.calls[0]!;
      expect(task).toBe("routerClassifier");
      expect(req.maxOutputTokens).toBe(100);
      expect(req.timeoutMs).toBe(4000);
      expect(req.jsonSchema).toBeDefined();
      expect(req.systemPrompt).toContain("Effort");
      expect(req.systemPrompt).not.toContain("Respond with ONLY a JSON object");
      expect(req.systemPrompt).not.toContain("Scheduled/cron");
      expect("model" in req).toBe(false); // the registry owns model resolution
    });

    it("returns parsed tier + effort with registry-computed cost/duration passed through", async () => {
      mockGenerateForTask.mockResolvedValueOnce(
        makeLlmResult({ tier: "sonnet", effort: "medium" }, { costUsd: 0.00042, durationMs: 11 }),
      );
      const r = await routeModel("summarize this thread", "claude-opus-4-7");
      expect(r.tier).toBe("sonnet");
      expect(r.model).toBe("claude-sonnet-4-6");
      expect(r.effort).toBe("medium");
      expect(r.method).toBe("model");
      expect(r.costUsd).toBe(0.00042); // passthrough — the math itself is pinned in registry.test.ts
      expect(r.durationMs).toBe(11);
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });

    it("off-catalog cost degradation: registry costUsd undefined ⇒ 0 (routing unaffected)", async () => {
      mockGenerateForTask.mockResolvedValueOnce(
        makeLlmResult({ tier: "sonnet", effort: "low" }, { costUsd: undefined }),
      );
      const r = await routeModel("summarize", "claude-opus-4-7");
      expect(r.costUsd).toBe(0);
      expect(r.method).toBe("model");
    });

    it("ceiling cap (opus→sonnet) preserves effort", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "opus", effort: "high" }));
      const r = await routeModel("complex judgment call", "claude-sonnet-4-6");
      expect(r.tier).toBe("sonnet");
      expect(r.effort).toBe("high");
      expect(r.method).toBe("model");
    });

    it("drops effort when the final model is effort-less per the CATALOG (haiku today)", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "haiku", effort: "low" }));
      const r = await routeModel("quick status check please", "claude-opus-4-7");
      expect(r.tier).toBe("haiku");
      expect(r.method).toBe("model");
      expect("effort" in r).toBe(false);
      expect(mockSupportsEffort).toHaveBeenCalledWith("claude-haiku-4-5-20251001");
    });

    it("keeps effort when supportsEffort says yes — consulted on the POST-CAP model", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "opus", effort: "high" }));
      const r = await routeModel("hard problem", "claude-sonnet-4-6");
      expect(mockSupportsEffort).toHaveBeenCalledWith("claude-sonnet-4-6");
      expect(r.effort).toBe("high");
    });

    it("effort-drop follows the catalog, not the tier name (next-model-generation proof)", async () => {
      mockSupportsEffort.mockReturnValue(true); // a future effort-capable haiku
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "haiku", effort: "low" }));
      const r = await routeModel("quick check", "claude-opus-4-7");
      expect(r.effort).toBe("low");
    });

    it.each([
      ["refusal stop", makeLlmResult(null, { stopReason: "refusal" })],
      ["null parsed", makeLlmResult(null)],
      ["max_tokens stop", makeLlmResult({ tier: "sonnet", effort: "low" }, { stopReason: "max_tokens" })],
    ])("%s → sonnet fallback, method fallback, no effort", async (_label, resp) => {
      mockGenerateForTask.mockResolvedValueOnce(resp);
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", model: "claude-sonnet-4-6", costUsd: 0, method: "fallback" });
      expect("effort" in r).toBe(false);
    });

    it("thrown registry/API error (timeout/429/5xx/404) → sonnet fallback", async () => {
      mockGenerateForTask.mockRejectedValueOnce(new Error("408 request timed out"));
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", costUsd: 0, durationMs: 0, method: "fallback" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });
  });

  describe("no-key mode (truth condition: hasProvider)", () => {
    beforeEach(() => {
      mockHasProvider.mockReturnValue(false);
      __resetRouterStateForTests();
    });

    it("heuristic-missing turns keep the agent default model with resolved default-tier limits", async () => {
      const r = await routeModel("summarize the quarter", "claude-opus-4-7");
      expect(r).toEqual({
        tier: "opus",
        model: "claude-opus-4-7",
        costUsd: 0,
        durationMs: 0,
        resourceLimits: RESOURCE_TIER_DEFAULTS.opus,
        method: "no-key",
      } satisfies ModelRouterResult);
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it("resolves default-tier limits through per-agent overrides", async () => {
      const r = await routeModel("draft an email", "claude-sonnet-4-6", {
        sonnet: { timeoutMs: 99_000 },
      });
      expect(r.method).toBe("no-key");
      expect(r.resourceLimits).toEqual({ ...RESOURCE_TIER_DEFAULTS.sonnet, timeoutMs: 99_000 });
    });

    it("heuristics still fire in no-key mode", async () => {
      const r = await routeModel("thanks", "claude-opus-4-7");
      expect(r.method).toBe("heuristic");
      expect(r.tier).toBe("haiku");
    });
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/agents/model-router.test.ts src/agents/agent-manager.test.ts
npm run typecheck
```
Expected: green — `resolveResourceLimits` describe untouched, every re-anchored 312 pin passes, `agent-manager.test.ts` passes unmodified (it module-mocks `routeModel`; result shape unchanged).

- [ ] **Commit:** `KPR-314: W3.5 T3 — router classifier on the registry: pricing hand-off discharged, catalog-driven effort drop, transport swap (312 behavior preserved)`

---

## Task 4 — Meeting classifier migration (spec §3.3)

**Goal:** subprocess out, one `generateForTask` call in; `parseClassifierOutput` and all fallback semantics preserved; warn-once no-key pre-check.

- [ ] **`src/agents/meeting-classifier.ts`** — full-file replacement (207 → ~150 lines; `RosterMember`, `ClassifyResult`, `parseClassifierOutput`, `buildRosterContext`, `CLASSIFIER_PROMPT`'s rules preserved verbatim where shown):

```ts
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { getLLMRegistry } from "../llm/registry.js";

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

// KPR-314: the "Respond with ONLY a JSON object" plea is gone — structured
// outputs enforce the shape (same evolution 312 made for the router prompt).
const CLASSIFIER_PROMPT = `You are a meeting facilitator. Given a message and a list of meeting participants, decide which participants should respond.

Rules:
- If someone is addressed by name, they MUST be in the respond list.
- Pick participants whose expertise is directly relevant to the message.
- Fewer is better — don't trigger everyone for a question only one person can answer.
- If the message is clearly directed at one person, return only that person.
- If the message is a general question to the room, pick 2-3 most relevant.
- For "what does everyone think?" style questions, include all participants.`;

/** { respond: string[] } — kills the brace-scan on the happy path (spec §3.3). */
const RESPOND_SCHEMA = {
  type: "object",
  properties: {
    respond: { type: "array", items: { type: "string" } },
  },
  required: ["respond"],
  additionalProperties: false,
} as const;

export function parseClassifierOutput(
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

// KPR-314: no-key is a steady state, not an incident (312's distinction) —
// warn once per process, not once per meeting message.
let noKeyWarned = false;

/** Test-only seam. */
export function __resetMeetingClassifierStateForTests(): void {
  noKeyWarned = false;
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

  // KPR-314: no-key pre-check — all-roster directly, never a thrown-and-caught
  // error per message (spec §3.3). Doctor + boot log carry the standing notice.
  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) {
    if (!noKeyWarned) {
      noKeyWarned = true;
      log.warn(
        "Meeting classifier has no ANTHROPIC_API_KEY — selecting all roster members for every meeting message",
      );
    }
    return { respondAgentIds: [...validIds], costUsd: 0, durationMs: 0 };
  }

  let resultText = "";
  let parsedOutput: unknown;
  let costUsd = 0;
  let durationMs = 0;

  try {
    const userPrompt = `${buildRosterContext(roster, recentMessages)}\n\nMessage:\n${messageText}`;

    // KPR-314: one registry call replaces the per-message Claude Code CLI
    // subprocess (query(), $0.01 cap, setTimeout→q.close() deadline, env
    // surgery). Model: the same classifier-grade entry the router uses
    // (preserves today's config.modelRouter.model coupling); timeout keeps
    // the borrowed knob — no new config (spec §3.3).
    const result = await registry.generateForTask("meetingClassifier", {
      prompt: userPrompt,
      systemPrompt: CLASSIFIER_PROMPT,
      jsonSchema: RESPOND_SCHEMA,
      maxOutputTokens: 256,
      temperature: 0,
      timeoutMs: config.modelRouter.timeoutMs,
    });
    resultText = result.text;
    parsedOutput = result.parsed;
    costUsd = result.costUsd ?? 0;
    durationMs = result.durationMs;
  } catch (err) {
    // Timeout / 429 / 5xx / capability error — today's catch → all-roster path.
    log.warn("Meeting classifier call failed, selecting all roster members", {
      error: String(err),
    });
    return {
      respondAgentIds: [...validIds],
      costUsd: 0,
      durationMs: 0,
    };
  }

  // Belt-and-braces (spec §3.3): parseClassifierOutput over parsed ?? text —
  // the valid-id allowlist filter is business logic, not parse scaffolding.
  const candidate = parsedOutput !== undefined ? JSON.stringify(parsedOutput) : resultText;
  const parsed = parseClassifierOutput(candidate, validIds);
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

- [ ] **`src/agents/meeting-classifier.test.ts`** — additive. Replace the file's mock header (keep the existing `parseClassifierOutput` describe byte-identical):

Old header (logger mock + `vi.mock("../config.js", () => ({ config: {} }))` + import):

```ts
const { mockGenerateForTask, mockHasProvider, mockWarn } = vi.hoisted(() => ({
  mockGenerateForTask: vi.fn(),
  mockHasProvider: vi.fn(() => true),
  mockWarn: vi.fn(),
}));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../config.js", () => ({
  config: { modelRouter: { model: "claude-haiku-4-5-20251001", timeoutMs: 4000 } },
}));

vi.mock("../llm/registry.js", () => ({
  getLLMRegistry: () => ({
    generateForTask: mockGenerateForTask,
    hasProvider: mockHasProvider,
  }),
}));

import { beforeEach } from "vitest";
import {
  classifyMeetingMessage,
  parseClassifierOutput,
  __resetMeetingClassifierStateForTests,
  type RosterMember,
} from "./meeting-classifier.js";
```

(Adjust the first `import { describe, it, expect, vi } from "vitest";` line to include `beforeEach` instead of a second import if cleaner — rule: existing describe untouched.)

Then append:

```ts
describe("classifyMeetingMessage (KPR-314 — registry transport)", () => {
  const roster: RosterMember[] = [
    { agentId: "jasper", name: "Jasper", role: "VP Engineering" },
    { agentId: "river", name: "River", role: "Marketing Manager" },
    { agentId: "jessica", name: "Jessica", role: "Customer Success" },
  ];

  function makeResult(overrides: Record<string, unknown> = {}) {
    return {
      text: '{"respond":["jasper"]}',
      parsed: { respond: ["jasper"] },
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic" as const,
      durationMs: 9,
      usage: { inputTokens: 400, outputTokens: 12 },
      costUsd: 0.00046,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasProvider.mockReturnValue(true);
    __resetMeetingClassifierStateForTests();
    mockGenerateForTask.mockResolvedValue(makeResult());
  });

  it("happy path: parsed respond list honored, cost/duration passed through", async () => {
    const r = await classifyMeetingMessage("jasper, thoughts?", roster);
    expect(r).toEqual({ respondAgentIds: ["jasper"], costUsd: 0.00046, durationMs: 9 });
  });

  it("request shape: meetingClassifier task, schema, 256 tokens, temp 0, borrowed router timeout", async () => {
    await classifyMeetingMessage("hello all", roster, "recent context");
    const [task, req] = mockGenerateForTask.mock.calls[0]!;
    expect(task).toBe("meetingClassifier");
    expect(req.jsonSchema).toBeDefined();
    expect(req.maxOutputTokens).toBe(256);
    expect(req.temperature).toBe(0);
    expect(req.timeoutMs).toBe(4000);
    expect(req.prompt).toContain("jasper (Jasper");
    expect(req.prompt).toContain("Recent thread context:\nrecent context");
    expect(req.systemPrompt).toContain("meeting facilitator");
    expect(req.systemPrompt).not.toContain("Respond with ONLY a JSON object");
  });

  it("id-allowlist filter still applies over parsed output (belt-and-braces)", async () => {
    mockGenerateForTask.mockResolvedValueOnce(
      makeResult({ parsed: { respond: ["jasper", "not-a-real-agent"] } }),
    );
    const r = await classifyMeetingMessage("q", roster);
    expect(r.respondAgentIds).toEqual(["jasper"]);
  });

  it("no parsed output: falls back to brace-scanning the text", async () => {
    mockGenerateForTask.mockResolvedValueOnce(
      makeResult({ parsed: undefined, text: 'Sure! { "respond": ["river"] } hope that helps' }),
    );
    const r = await classifyMeetingMessage("q", roster);
    expect(r.respondAgentIds).toEqual(["river"]);
  });

  it("registry throw → all-roster with costUsd 0 (today's failure path)", async () => {
    mockGenerateForTask.mockRejectedValueOnce(new Error("timeout"));
    const r = await classifyMeetingMessage("q", roster);
    expect(new Set(r.respondAgentIds)).toEqual(new Set(["jasper", "river", "jessica"]));
    expect(r.costUsd).toBe(0);
  });

  it("parse failure → all-roster, but the call's real cost is kept", async () => {
    mockGenerateForTask.mockResolvedValueOnce(
      makeResult({ parsed: undefined, text: "no json here at all" }),
    );
    const r = await classifyMeetingMessage("q", roster);
    expect(new Set(r.respondAgentIds)).toEqual(new Set(["jasper", "river", "jessica"]));
    expect(r.costUsd).toBe(0.00046);
  });

  it("no-key: all-roster via pre-check — generateForTask NEVER called, warn fired once across calls", async () => {
    mockHasProvider.mockReturnValue(false);
    const r1 = await classifyMeetingMessage("q", roster);
    const r2 = await classifyMeetingMessage("q again", roster);
    expect(new Set(r1.respondAgentIds)).toEqual(new Set(["jasper", "river", "jessica"]));
    expect(r2.respondAgentIds.length).toBe(3);
    expect(mockGenerateForTask).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("roster 0/1 short-circuits never touch the registry", async () => {
    expect(await classifyMeetingMessage("q", [])).toEqual({
      respondAgentIds: [],
      costUsd: 0,
      durationMs: 0,
    });
    expect(await classifyMeetingMessage("q", [roster[0]])).toEqual({
      respondAgentIds: ["jasper"],
      costUsd: 0,
      durationMs: 0,
    });
    expect(mockGenerateForTask).not.toHaveBeenCalled();
    expect(mockHasProvider).not.toHaveBeenCalled();
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/agents/meeting-classifier.test.ts src/channels/dispatcher-conference.test.ts
npm run typecheck
```
Expected: green — existing `parseClassifierOutput` pins untouched; `dispatcher-conference.test.ts` unmodified (module-mocks the classifier).

- [ ] **Commit:** `KPR-314: W3.5 T4 — meeting classifier on the registry: subprocess out, structured output + belt-and-braces parse, warn-once no-key pre-check`

---

## Task 5 — Memory lifecycle migration (spec §3.4): source + wiring + mechanical test sweep

**Goal:** the only structural change is inside `runDreamQuery` plus constructor injection; estimate gate at `callBudgetUsd() × GATE_TOLERANCE`; ~30s timeout; per-phase `maxOutputTokens`; counted skips; no-key short-circuits; dead `"hit your limit"` break **deleted** (decision per spec's plan note: direct-API errors never produce the CLI-subscription string; a 429 is a per-agent fault the existing catch already records — re-keying to an SDK error shape would force this module to import the SDK it just stopped using. The adjacent `"autoDream run budget exhausted"` break survives unchanged). All four phase callers, checkpointing, cursors, oversize handling, error accumulation: untouched.

- [ ] **`src/memory/memory-types.ts`** — additive field on `DreamResult`, after `summarized?: number; // KPR-241`:

```ts
  /** KPR-314: runDreamQuery calls skipped by the per-call estimate gate
   *  (callBudgetUsd × GATE_TOLERANCE). A perpetually-skipped backlog is
   *  observable here + in the autoDream-complete log instead of burning
   *  budget invisibly (spec §3.4). */
  gateSkips?: number;
```

- [ ] **`src/memory/memory-lifecycle.ts`** — edits in file order:

1. Imports — old:

```ts
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
```

New:

```ts
import type { LLMProviderId, LLMResult, LLMTaskRequest } from "../llm/types.js";
```

2. After `const log = createLogger("memory-lifecycle");`, insert:

```ts
/**
 * KPR-314: every registry fact this module consults is a member of the
 * injected interface — the site never reaches around the injection to the
 * singleton (spec §3.4). LLMRegistry satisfies it structurally; tests
 * inject mocks (makeMockLlm).
 */
export interface MemoryLlmClient {
  generateForTask(task: "memory", request: LLMTaskRequest): Promise<LLMResult>;
  hasProvider(id: LLMProviderId): boolean;
  estimateCostUsd(task: "memory", request: LLMTaskRequest): number | undefined;
}

/** KPR-314: bounded call where none existed (the subprocess could hang a
 *  sweep indefinitely — spec §1). Generous for a haiku summarization call. */
const MEMORY_LLM_TIMEOUT_MS = 30_000;

/**
 * KPR-314 estimate-gate tolerance (spec §3.4, exported for the test pin).
 * The pre-call estimate is deliberately conservative (chars/4 over-counts
 * English input ~5-10%; the full maxOutputTokens allowance is charged while
 * real outputs run ~50-100 tokens) — ×1.3 absorbs exactly those biases so
 * the gate's skip set stays strictly inside today's abort set at defaults:
 * one-sided parity — it never skips anything today's cap completed, and may
 * complete shallow-over band pages today's cap aborted (strictly cheaper).
 */
export const GATE_TOLERANCE = 1.3;

/** KPR-314 per-phase output pins (spec §3.4): contradiction verdicts are
 *  one word; summaries and memory records are 2-5 sentences. */
const VERDICT_MAX_OUTPUT_TOKENS = 32;
const DREAM_MAX_OUTPUT_TOKENS = 256;
```

3. `AutoDreamBudget` — add after `llmCalls = 0;`:

```ts
  gateSkips = 0;
```

and after the `record` method:

```ts
  recordGateSkip(): void {
    this.gateSkips++;
  }
```

4. Constructor — old:

```ts
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
    private dreamConfig?: DreamConfig,
    private getActiveAgentIds?: () => Promise<Set<string>>,
  ) {}
```

New (required 4th param — the typechecker forces every call-site update, which is the point):

```ts
  constructor(
    private store: MemoryStore,
    private embedder: MemoryEmbedder,
    private config: MemoryLifecycleConfig,
    private llm: MemoryLlmClient, // KPR-314: injected registry (index.ts passes getLLMRegistry())
    private dreamConfig?: DreamConfig,
    private getActiveAgentIds?: () => Promise<Set<string>>,
  ) {}
```

5. Add an instance field + helper near the constructor (steady-state visibility, once per process — one MemoryLifecycle per boot):

```ts
  private noKeyLogged = false;

  /** KPR-314: no-key is a steady state, not an incident (312's distinction). */
  private llmAvailable(): boolean {
    if (this.llm.hasProvider("anthropic")) return true;
    if (!this.noKeyLogged) {
      this.noKeyLogged = true;
      log.info(
        "autoDream LLM phases skipped — no ANTHROPIC_API_KEY (scoring/tier/purge sweeps unaffected)",
      );
    }
    return false;
  }
```

6. `runDreamQuery` — full replacement of the method body:

```ts
  private async runDreamQuery(
    prompt: string,
    budget: AutoDreamBudget,
    maxOutputTokens: number = DREAM_MAX_OUTPUT_TOKENS,
  ): Promise<string> {
    if (!budget.canSpend()) throw new Error("autoDream run budget exhausted");

    const request: LLMTaskRequest = {
      prompt,
      maxOutputTokens,
      temperature: 0,
      timeoutMs: MEMORY_LLM_TIMEOUT_MS,
    };

    // KPR-314 estimate gate (spec §3.4): the subprocess's per-call hard cap
    // is gone (a direct API call can't pre-cap spend); callBudgetUsd() is
    // kept-and-repurposed as a caller-side estimate ceiling with tolerance.
    // Worst-case estimate on the ACTUAL request as sent; skip = today's
    // empty-text result ("" → every phase caller continues) — never a throw,
    // never an abort, counted and surfaced in the autoDream-complete log.
    // An undefined estimate never gates (moot: the memory task is
    // catalog-pinned haiku, pricing always known).
    const estimate = this.llm.estimateCostUsd("memory", request);
    const gateUsd = budget.callBudgetUsd() * GATE_TOLERANCE;
    if (estimate !== undefined && estimate > gateUsd) {
      budget.recordGateSkip();
      log.debug("autoDream: call skipped by estimate gate", { estimate, gateUsd, maxOutputTokens });
      return "";
    }

    // Post-hoc exceedance is by design (spec ⚠5): a gate-passed call may
    // exceed callBudgetUsd() in actuals — recorded, consumes run budget.
    const result = await this.llm.generateForTask("memory", request);
    budget.record(result.costUsd ?? 0);
    return result.text;
  }
```

7. `dream()` — insert the no-key short-circuit after the `enabled` check:

```ts
    if (!this.dreamConfig?.enabled) {
      return { merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] };
    }
    // KPR-314: no provider ⇒ LLM phases can do no work — return zero-counts
    // up front instead of an error-spam steady state (spec §3.4). Non-LLM
    // sweep phases live in sweep(), untouched.
    if (!this.llmAvailable()) {
      return { merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] };
    }
```

8. `dream()` — delete the dead subscription-limit break. Old:

```ts
          if (String(err).includes("autoDream run budget exhausted")) break;
          if (String(err).includes("hit your limit")) break;
```

New:

```ts
          if (String(err).includes("autoDream run budget exhausted")) break;
          // KPR-314: the CLI-subscription "hit your limit" break is gone —
          // direct API errors never produce that string; a 429 is recorded
          // per-agent by this catch and the run continues (damage bounded by
          // canSpend() + per-phase loop caps).
```

9. `dream()` completion log + return — add `gateSkips`, and keep it visible on an **all-skipped** run: the completion log is gated on `totalActions > 0` and the sweeper drops zero-action results — without widening the guard, a perpetually-gated backlog (exactly the scenario the counter exists for, spec §3.4) would surface nowhere. Old:

```ts
    const totalActions = merged + contradictions + promoted + flaggedForReview + summarized;
    if (totalActions > 0) {
```

New:

```ts
    const totalActions = merged + contradictions + promoted + flaggedForReview + summarized;
    // KPR-314: an all-skipped run (totalActions 0, gateSkips > 0) must still
    // emit the completion log — counted skips are the observability surface
    // for a perpetually-gated backlog (spec §3.4).
    if (totalActions > 0 || budget.gateSkips > 0) {
```

Then in the `log.info("autoDream complete", {...})` object, after `llmCalls: budget.llmCalls,` add:

```ts
        gateSkips: budget.gateSkips,
```

In the `return {...}` after `llmCalls: budget.llmCalls,` add:

```ts
      gateSkips: budget.gateSkips,
```

10. `runConsolidationForAgent` — the operator-invoked path keeps skip visibility too: add `gateSkips: number` to the method's return-type literal and to **all three** return sites — the `!this.dreamConfig` early return gains `gateSkips: 0`, the final return gains `gateSkips: budget.gateSkips`, and insert after the `if (!this.dreamConfig)` early return (operator-invoked: an explicit error beats silent zero-counts):

```ts
    if (!this.llmAvailable()) {
      return {
        summarized: 0,
        merged: 0,
        contradictions: 0,
        promoted: 0,
        pagesProcessed: 0,
        drained: false,
        spentUsd: 0,
        gateSkips: 0,
        errors: ["no ANTHROPIC_API_KEY — autoDream LLM phases unavailable"],
      };
    }
```

11. `detectContradictions` — the verdict call pins 32 output tokens. Old:

```ts
          const verdict = (await this.runDreamQuery(prompt, budget)).trim().toUpperCase();
```

New:

```ts
          // KPR-314: verdicts are one word — 32-token pin (spec §3.4).
          const verdict = (await this.runDreamQuery(prompt, budget, VERDICT_MAX_OUTPUT_TOKENS))
            .trim()
            .toUpperCase();
```

(`mergeDuplicates`, `promotePatterns`, `summarizeColdPhase` keep their two-arg calls — the 256 default. `summarizeColdPhase` itself is unchanged: both public entry points are gated, which covers the private phase.)

- [ ] **`src/index.ts`** — two edits:

1. Import (alongside the existing memory imports):

```ts
import { getLLMRegistry } from "./llm/registry.js";
```

2. Constructor — old:

```ts
    config.autoDream,
    async () => new Set(registry!.listIds()),
  );
```

New:

```ts
    // KPR-314: injected sidecar-LLM client — autoDream's runDreamQuery rides
    // the registry's anthropic provider (no more per-call CLI subprocess).
    getLLMRegistry(),
    config.autoDream,
    async () => new Set(registry!.listIds()),
  );
```

(Insertion point is the 4th argument — after the `MemoryLifecycleConfig` object literal, before `config.autoDream`. The `getLLMRegistry()` call here is also the boot-time construction point: the registry's construction log lines fire during startup.)

- [ ] **`src/memory/memory-lifecycle.test.ts`** — mechanical sweep (existing assertions byte-identical):

1. Delete the `vi.mock("@anthropic-ai/claude-agent-sdk", …)` block (the `// ── SDK mock (used by summarizeCold)` section).
2. Convert the file's logger mock to hoisted shared spies (Task 6's all-skipped log-emission pin needs a capturable logger; existing tests assert nothing on the logger, and `vi.clearAllMocks()` in each `beforeEach` keeps them independent):

```ts
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));
```

3. Add the mock factory after `makeMockEmbedder()`:

```ts
// ── Mock LLM client (KPR-314 — replaces the SDK subprocess mock) ────────
// Defaults preserve legacy pins exactly: costUsd 0 matches the old mock's
// absent total_cost_usd; estimateCostUsd 0.001 clears every default gate.
function makeMockLlm(overrides: Record<string, unknown> = {}, ...texts: string[]) {
  let i = 0;
  return {
    generateForTask: vi.fn().mockImplementation(async () => {
      const text = texts[i] ?? texts[texts.length - 1] ?? "Summary text";
      i++;
      return {
        text,
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic" as const,
        durationMs: 1,
        costUsd: 0,
      };
    }),
    hasProvider: vi.fn(() => true),
    estimateCostUsd: vi.fn(() => 0.001),
    ...overrides,
  };
}
```

4. Sweep every `new MemoryLifecycle(` call (19 at spec time — Task 0 recounted): insert `makeMockLlm()` as the **4th argument** (after the config object, before any `dreamConfig`/roster args). Where a test needs to assert against the client, hoist it: `const llm = makeMockLlm(); … new MemoryLifecycle(store as any, embedder as any, defaultConfig, llm, …)`. `npm run typecheck` is the completeness check — zero remaining constructor errors.
5. Any existing summarizeCold test that asserted the SDK mock's `query` call count re-anchors to `llm.generateForTask` (same counts — one call per page/cluster/pair; texts via `makeMockLlm({}, "Summary text")`).

- [ ] Verify:

```bash
npx vitest run src/memory/memory-lifecycle.test.ts
npm run typecheck
```
Expected: every pre-existing describe green with only the constructor/mock sweep. If any existing budget pin fails, the mock default drifted from `costUsd: 0` — fix the mock, not the pin.

- [ ] **Commit:** `KPR-314: W3.5 T5 — memory lifecycle on the registry: injected client, estimate gate (×1.3), 30s timeout, per-phase output pins, counted skips, dead limit-break removed`

---

## Task 6 — Memory lifecycle new tests (contract group 5)

All edits in `src/memory/memory-lifecycle.test.ts` — one new describe appended; existing describes untouched. Reuse the file's `makeMockStore`/`makeMockEmbedder`/`makeRecord` helpers and the KPR-241 cold-summary harness patterns (rule 1: if a listed fixture doesn't exist, build it from those helpers).

- [ ] Append:

```ts
import { GATE_TOLERANCE } from "./memory-lifecycle.js";
import { estimateCostUsdFromPricing } from "../llm/catalog.js";

// Real registry-side estimate math (config-free import by design) — the gate
// clearance pins run against the ACTUAL sent prompt, wrapper included.
const HAIKU_PRICING = { inputPerMTok: 1, outputPerMTok: 5 };
function realisticEstimate() {
  return vi.fn((_task: "memory", req: { prompt: string; systemPrompt?: string; maxOutputTokens?: number }) =>
    estimateCostUsdFromPricing(HAIKU_PRICING, req),
  );
}

describe("MemoryLifecycle — sidecar LLM registry (KPR-314)", () => {
  // dreamConfig with today's defaults: run $0.05, call $0.01 → gate $0.013.
  const dreamDefaults = {
    enabled: true,
    cooldownMinutes: 0,
    minNewMemories: 0,
    similarityThreshold: 0.9,
    patternMinCount: 3,
    maxClustersPerRun: 5,
    maxContradictionPairsPerRun: 5,
    maxPromotionsPerRun: 5,
    maxRunBudgetUsd: 0.05,
    maxCallBudgetUsd: 0.01,
    coldSummaryPageSize: 20,
    coldSummaryPromptTokenBudget: 8000,
  };
  // Config with min-records 3 for the deep-over/band constructions.
  const gateConfig = { ...defaultConfig, coldSummaryMinRecords: 3 };

  let store: ReturnType<typeof makeMockStore>;
  let embedder: ReturnType<typeof makeMockEmbedder>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeMockStore();
    embedder = makeMockEmbedder();
  });

  /** One agent, one cold topic, `contents` as the page. */
  function wireColdSummary(contents: string[]) {
    store.getAgentIds.mockResolvedValue(["agent-1"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue(["topic-a"]);
    store.getColdByTopicPaged.mockResolvedValue(
      contents.map((content) => makeRecord({ _id: new ObjectId(), content, type: "interaction", importance: "medium", topic: "topic-a" })),
    );
    // Other phases idle:
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());
  }

  it("pins GATE_TOLERANCE at 1.3", () => {
    expect(GATE_TOLERANCE).toBe(1.3);
  });

  it("records the registry-computed cost, including post-hoc exceedance of callBudgetUsd", async () => {
    const llm = makeMockLlm();
    llm.generateForTask.mockResolvedValue({
      text: "Summary text",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      durationMs: 1,
      usage: { inputTokens: 9000, outputTokens: 90 },
      costUsd: 0.012, // > maxCallBudgetUsd 0.01 — tolerance-admitted band actuals
    });
    wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(result.spentUsd).toBeCloseTo(0.012, 8); // overshoot recorded, consumes run budget
    expect(result.gateSkips).toBe(0);
  });

  it("wires the 30s timeout and temperature 0 into every memory request", async () => {
    const llm = makeMockLlm();
    wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    await lifecycle.dream();
    expect(llm.generateForTask).toHaveBeenCalledWith(
      "memory",
      expect.objectContaining({ timeoutMs: 30_000, temperature: 0, maxOutputTokens: 256 }),
    );
  });

  it("cold-summary/merge/promote requests carry 256 max output tokens; contradiction verdicts carry 32", async () => {
    const llm = makeMockLlm({}, "Summary text", "NO");
    const idA = new ObjectId();
    const idB = new ObjectId();
    store.getAgentIds.mockResolvedValue(["agent-1"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue([]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    store.getFactsAndDecisionsByTopic.mockResolvedValue(
      new Map([["t", [
        makeRecord({ _id: idA, type: "fact", content: "A", topic: "t" }),
        makeRecord({ _id: idB, type: "fact", content: "B", topic: "t" }),
      ]]]),
    );
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    await lifecycle.dream();
    const verdictCall = llm.generateForTask.mock.calls.find((c: any[]) =>
      String(c[1].prompt).includes("contradict"),
    );
    expect(verdictCall![1].maxOutputTokens).toBe(32);
  });

  describe("estimate gate — clearance against real estimate math (spec §3.4 case analysis)", () => {
    it("a default-fitted cold-summary page + wrapper passes the ×1.3 gate and is attempted (≈$0.0094)", async () => {
      const llm = makeMockLlm({ estimateCostUsd: realisticEstimate() });
      // 20 records × 1,596 chars: content-only est. 7,985 tok ≤ 8,000 — the
      // shrink loop does not fire; the SENT prompt adds preamble + prefixes.
      wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(1596)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(llm.generateForTask).toHaveBeenCalledTimes(1);
      const estimate = llm.estimateCostUsd.mock.results[0]!.value as number;
      expect(estimate).toBeGreaterThan(0.008); // wrapper counted (bare 8,000-tok content = $0.0093 incl. output)
      expect(estimate).toBeLessThan(0.013); // clears the gate
      expect(result.gateSkips).toBe(0);
    });

    it("a shallow-over band page (min-records stop above the content budget) PASSES under ×1.3 and is attempted (≈$0.0103)", async () => {
      const llm = makeMockLlm({ estimateCostUsd: realisticEstimate() });
      // 3 records × 12,000 chars: content est. 9,000 tok > 8,000 but the
      // shrink loop can't go below coldSummaryMinRecords (3) — sent anyway,
      // exactly today's behavior; estimate ≈ $0.0103 ∈ (0.01, 0.013].
      wireColdSummary(Array.from({ length: 3 }, () => "m".repeat(12_000)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(llm.generateForTask).toHaveBeenCalledTimes(1); // attempted — the class a raw ceiling would have permanently skipped
      const estimate = llm.estimateCostUsd.mock.results[0]!.value as number;
      expect(estimate).toBeGreaterThan(0.01);
      expect(estimate).toBeLessThan(0.013);
      expect(result.gateSkips).toBe(0);
    });

    it("a deep-over min-records page is GATED — skipped without spend, counted, surfaced (≈$0.0253)", async () => {
      const llm = makeMockLlm({ estimateCostUsd: realisticEstimate() });
      // 3 records × 31,900 chars: each ≤ 8,000 tok (passes the oversize
      // filter) but the page est. ≈ 24,000 tok — today this is attempted and
      // cap-aborted (~$0.01 burned, "" returned); the gate skips it for $0.
      wireColdSummary(Array.from({ length: 3 }, () => "m".repeat(31_900)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(llm.generateForTask).not.toHaveBeenCalled();
      const estimate = llm.estimateCostUsd.mock.results[0]!.value as number;
      expect(estimate).toBeGreaterThan(0.013);
      expect(result.gateSkips).toBe(1);
      expect(result.spentUsd).toBe(0);
    });

    it("a gate skip behaves as empty text: continue, no throw, drained semantics unchanged, checkpoint preserved", async () => {
      const llm = makeMockLlm({ estimateCostUsd: vi.fn(() => 99) }); // force-gate everything
      wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(result.errors).toEqual([]);
      expect(result.summarized).toBe(0);
      expect(result.gateSkips).toBeGreaterThan(0);
      // The skipped topic's records remain ≥ min-records ⇒ the end-of-topics
      // probe reports not-drained ⇒ dream()'s finally must NOT reset the
      // checkpoint to idle (today's continue rule, unchanged).
      const markCalls = store.markAutoDreamRun.mock.calls.map((c: any[]) => c[1]);
      expect(markCalls.some((u: any) => u.phase === "idle")).toBe(false);
      // Blocking pin: the completion log fires on an ALL-SKIPPED run
      // (totalActions 0) and carries the skip count — the guard widening
      // in Task 5 step 9 is load-bearing for spec §3.4's observability claim.
      expect(mockLog.info).toHaveBeenCalledWith(
        "autoDream complete",
        expect.objectContaining({ gateSkips: result.gateSkips }),
      );
    });
  });

  it("canSpend pre-gate still throws run-budget exhaustion (recorded per agent, loop break preserved)", async () => {
    const llm = makeMockLlm();
    llm.generateForTask.mockResolvedValue({
      text: "Summary text", model: "claude-haiku-4-5-20251001", provider: "anthropic",
      durationMs: 1, costUsd: 0.05, // one call exhausts the run budget
    });
    wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
    store.getAgentIds.mockResolvedValue(["agent-1", "agent-2"]);
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(result.errors.some((e) => e.includes("autoDream run budget exhausted"))).toBe(true);
  });

  it("a phase throw aborts that AGENT's remaining phases; the run continues at the next agent", async () => {
    const llm = makeMockLlm();
    llm.generateForTask
      .mockRejectedValueOnce(new Error("429 rate limited")) // agent-1's first LLM call
      .mockResolvedValue({
        text: "Summary text", model: "claude-haiku-4-5-20251001", provider: "anthropic",
        durationMs: 1, costUsd: 0,
      });
    store.getAgentIds.mockResolvedValue(["agent-1", "agent-2"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue(["topic-a"]);
    store.getColdByTopicPaged.mockResolvedValue(
      Array.from({ length: 20 }, () => makeRecord({ _id: new ObjectId(), content: "m".repeat(400), topic: "topic-a" })),
    );
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("agent-1");
    // Agent-1 aborted after 1 call (remaining phases skipped); agent-2's
    // cold-summary call still ran: 2 total.
    expect(llm.generateForTask).toHaveBeenCalledTimes(2);
    // KPR-314: a 429-shaped error no longer breaks the agent loop (the dead
    // "hit your limit" break is gone) — pinned by agent-2 having run at all.
  });

  it("the removed subscription-limit break: an error CONTAINING 'hit your limit' no longer aborts the run", async () => {
    const llm = makeMockLlm();
    llm.generateForTask
      .mockRejectedValueOnce(new Error("You've hit your limit for today"))
      .mockResolvedValue({
        text: "Summary text", model: "claude-haiku-4-5-20251001", provider: "anthropic",
        durationMs: 1, costUsd: 0,
      });
    store.getAgentIds.mockResolvedValue(["agent-1", "agent-2"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue(["topic-a"]);
    store.getColdByTopicPaged.mockResolvedValue(
      Array.from({ length: 20 }, () => makeRecord({ _id: new ObjectId(), content: "m".repeat(400), topic: "topic-a" })),
    );
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(llm.generateForTask.mock.calls.length).toBeGreaterThanOrEqual(2); // agent-2 ran
    expect(result.errors).toHaveLength(1);
  });

  describe("no-key steady state", () => {
    it("dream() short-circuits to zero counts; generateForTask never called; repeatable without error spam", async () => {
      const llm = makeMockLlm({ hasProvider: vi.fn(() => false) });
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const r1 = await lifecycle.dream();
      const r2 = await lifecycle.dream();
      expect(r1).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
      expect(r2.errors).toEqual([]);
      expect(llm.generateForTask).not.toHaveBeenCalled();
      expect(store.getAgentIds).not.toHaveBeenCalled();
    });

    it("runConsolidationForAgent returns an explicit operator-facing error", async () => {
      const llm = makeMockLlm({ hasProvider: vi.fn(() => false) });
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const r = await lifecycle.runConsolidationForAgent("agent-1", { maxPages: 3 });
      expect(r.errors).toEqual(["no ANTHROPIC_API_KEY — autoDream LLM phases unavailable"]);
      expect(r.gateSkips).toBe(0); // field present on the operator path too
      expect(llm.generateForTask).not.toHaveBeenCalled();
    });
  });
});
```

Implementation notes: `ObjectId` and `makeRecord` already exist in this file; extend `makeRecord` usage, don't fork it. If `makeMockStore()`'s method set lacks any store method used above, add the missing `vi.fn()` to the factory (additive). Exact estimate values in comments are derived from `estimateCostUsdFromPricing` — the assertions use range pins (gate-relative), so ±wrapper-size drift can't flake.

- [ ] Verify:

```bash
npx vitest run src/memory/memory-lifecycle.test.ts
```
Expected: green — new describe AND every pre-existing describe.

- [ ] **Negative-verify N2 (the gate):** comment out the `if (estimate !== undefined && estimate > gateUsd)` block in `runDreamQuery`, re-run the suite → EXPECT the deep-over gated test and the force-gate skip test to fail (`generateForTask` called, `gateSkips` 0). Restore, re-run, green. (Do not commit the mutation.)

- [ ] **Commit:** `KPR-314: W3.5 T6 — memory gate + registry tests: parity triple, exceedance, per-agent granularity, no-key, output-token pins`

---

## Task 7 — Image description migration (spec §3.5)

**Goal:** PR #194's shape salvaged nearly verbatim; inline Gemini fetch, `GEMINI_MODEL` constant, `geminiApiKey` module state, and `setGeminiApiKey` deleted; `config.gemini` survives untouched.

- [ ] **`src/files/file-processor.ts`** — three edits:

1. Add the type import after the existing imports:

```ts
import type { LLMTaskRequest, LLMResult } from "../llm/types.js";
import { LLMProviderUnavailableError } from "../llm/errors.js";
```

(`errors.ts` is config-free by construction — no import cycle, no config load.)

2. Replace the block from `let geminiApiKey = "";` through the end of `describeImageWithGemini` (everything Task 0 anchored at §5) with:

```ts
const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image in detail. If it contains text, extract all of it. If it's a diagram, architecture drawing, or technical image, describe all labels, relationships, and structure. If it's a screenshot of messages or a conversation, transcribe everything. Be thorough.";

/** KPR-314: generous single-image bound (was: none on the raw fetch). */
const VISION_TIMEOUT_MS = 30_000;

/**
 * KPR-314 (PR #194's injection shape): the registry is injected rather than
 * imported — keeps this module unit-testable and import-cycle-free. The
 * vision task's model/provider knowledge lives in the registry catalog;
 * this module no longer knows Gemini exists.
 */
interface VisionLlmClient {
  generateForTask(task: "vision", request: LLMTaskRequest): Promise<LLMResult>;
}

let visionLlmClient: VisionLlmClient | undefined;

export function setVisionLlmClient(client: VisionLlmClient): void {
  visionLlmClient = client;
}

/** Test-only seam. */
export function resetVisionLlmClientForTests(): void {
  visionLlmClient = undefined;
}

export async function describeImage(buffer: Buffer, mimetype: string): Promise<string | null> {
  if (!visionLlmClient) return null;

  try {
    const result = await visionLlmClient.generateForTask("vision", {
      prompt: IMAGE_DESCRIPTION_PROMPT,
      images: [{ mimeType: mimetype, dataBase64: buffer.toString("base64") }],
      maxOutputTokens: 2048,
      temperature: 0,
      timeoutMs: VISION_TIMEOUT_MS,
    });
    if (!result.text) return null;
    log.info("Image described", {
      provider: result.provider,
      model: result.model,
      chars: result.text.length,
    });
    return result.text;
  } catch (e: unknown) {
    // Missing GEMINI_API_KEY ⇒ silent null — byte-identical to today's
    // key-less behavior (steady state ≠ incident). Everything else
    // (timeout / 429 / 5xx / capability misbinding) warns and degrades to
    // the metadata-only entry callers already handle.
    if (e instanceof LLMProviderUnavailableError) return null;
    log.warn("Image description failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
```

3. Rename the two internal call sites — in `downloadAndProcess` and `processImageBuffer`, `await describeImageWithGemini(buffer, …)` → `await describeImage(buffer, …)`. (Task 0 verified no callers exist outside this file.)

- [ ] **`src/index.ts`** — swap the wiring:

Old:

```ts
import { setGeminiApiKey } from "./files/file-processor.js";
```

```ts
  // Initialize Gemini vision for image processing
  if (config.gemini.apiKey) {
    setGeminiApiKey(config.gemini.apiKey);
    log.info("Gemini vision enabled", { model: config.gemini.visionModel });
  }
```

New:

```ts
import { setVisionLlmClient } from "./files/file-processor.js";
```

```ts
  // KPR-314: image description rides the LLM registry's vision task —
  // provider/model/key knowledge lives in the catalog, not here. Key-less
  // instances degrade to null descriptions inside describeImage (unchanged
  // behavior); the registry's construction log reports provider presence.
  setVisionLlmClient(getLLMRegistry());
```

(`getLLMRegistry` is already imported by Task 5's edit — one import serves both touch points.)

- [ ] **`src/files/file-processor.test.ts`** (new — PR #194's three tests salvaged + the two KPR-314 additions):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { describeImage, resetVisionLlmClientForTests, setVisionLlmClient } from "./file-processor.js";
import { LLMProviderUnavailableError } from "../llm/errors.js";

describe("describeImage (KPR-314)", () => {
  beforeEach(() => {
    resetVisionLlmClientForTests();
  });

  it("uses the configured vision LLM task when available", async () => {
    const client = {
      generateForTask: vi.fn().mockResolvedValue({
        text: "image description",
        model: "gemini-2.5-flash",
        provider: "gemini",
        durationMs: 1,
      }),
    };
    setVisionLlmClient(client);

    const result = await describeImage(Buffer.from("image-bytes"), "image/png");

    expect(result).toBe("image description");
    expect(client.generateForTask).toHaveBeenCalledWith(
      "vision",
      expect.objectContaining({
        images: [{ mimeType: "image/png", dataBase64: Buffer.from("image-bytes").toString("base64") }],
        maxOutputTokens: 2048,
        temperature: 0,
        timeoutMs: 30_000,
      }),
    );
  });

  it("returns null when no vision client is configured", async () => {
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });

  it("returns null when the LLM call throws", async () => {
    const client = { generateForTask: vi.fn().mockRejectedValue(new Error("boom")) };
    setVisionLlmClient(client);
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });

  it("returns null silently on provider-unavailable (key-less steady state — byte-identical to today)", async () => {
    const client = {
      generateForTask: vi.fn().mockRejectedValue(new LLMProviderUnavailableError("gemini", "vision")),
    };
    setVisionLlmClient(client);
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });

  it("returns null on empty text", async () => {
    const client = {
      generateForTask: vi.fn().mockResolvedValue({
        text: "",
        model: "gemini-2.5-flash",
        provider: "gemini",
        durationMs: 1,
      }),
    };
    setVisionLlmClient(client);
    expect(await describeImage(Buffer.from("x"), "image/png")).toBeNull();
  });
});
```

(The vision-capability-misbinding case is pinned in `registry.test.ts` (Task 2), not here — the capability check lives at task resolution.)

- [ ] Verify:

```bash
npx vitest run src/files/file-processor.test.ts
npm run typecheck
grep -rn 'describeImageWithGemini\|setGeminiApiKey' src   # expect 0 hits
```
Expected: green; the old surface fully gone.

- [ ] **Commit:** `KPR-314: W3.5 T7 — image description on the registry vision task: injection, silent key-less null, inline Gemini fetch deleted`

---

## Task 8 — Doctor visibility + conditional credential rider (spec §3.6)

**Goal:** one informational, never-failing line following 312's `model router:` precedent; a key-less instance's three degraded behaviors visible in one place.

- [ ] **`src/cli/doctor-checks.ts`** — append after `modelRouterModeLine` (312 Task 6):

```ts
/**
 * KPR-314: one informational line for `hive doctor` — sidecar LLM provider
 * presence and what degrades without each key. Key-less is a deliberate
 * steady state (subscription-auth instances), never a failing check —
 * pure string producer, no failure channel by construction (312 precedent).
 */
export function llmSidecarLine(anthropicPresent: boolean, geminiPresent: boolean): string {
  const anthropic = anthropicPresent
    ? "anthropic ✓"
    : "anthropic ✗ (meeting classifier → all-roster, memory dream → skipped)";
  const gemini = geminiPresent ? "gemini ✓" : "gemini ✗ (image description → off)";
  return `llm sidecar: ${anthropic}, ${gemini}`;
}
```

- [ ] **`src/cli/doctor.ts`** — two edits:

1. Extend the `./doctor-checks.js` import with `llmSidecarLine`.
2. Directly after 312's mode line (anchor: `modelRouterModeLine(Boolean(config.anthropic.apiKey))`):

```ts
    // KPR-314: sidecar LLM registry presence — informational only, never
    // touches allPassed. Both keys resolve env→Keychain via config optional().
    console.log(`\n${llmSidecarLine(Boolean(config.anthropic.apiKey), Boolean(config.gemini.apiKey))}`);
```

And after the skipped-branch anchor (`"model router: skipped (config not loaded)"`):

```ts
    console.log("\nllm sidecar: skipped (config not loaded)");
```

- [ ] **`src/cli/doctor-checks.test.ts`** — extend the import, append:

```ts
describe("llmSidecarLine (KPR-314)", () => {
  it("pins all four key permutations verbatim", () => {
    expect(llmSidecarLine(true, true)).toBe("llm sidecar: anthropic ✓, gemini ✓");
    expect(llmSidecarLine(false, true)).toBe(
      "llm sidecar: anthropic ✗ (meeting classifier → all-roster, memory dream → skipped), gemini ✓",
    );
    expect(llmSidecarLine(true, false)).toBe(
      "llm sidecar: anthropic ✓, gemini ✗ (image description → off)",
    );
    expect(llmSidecarLine(false, false)).toBe(
      "llm sidecar: anthropic ✗ (meeting classifier → all-roster, memory dream → skipped), gemini ✗ (image description → off)",
    );
  });

  it("is informational by construction — every mode yields a printable line, no failure channel", () => {
    for (const a of [true, false]) {
      for (const g of [true, false]) {
        expect(llmSidecarLine(a, g).length).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Conditional rider (spec ⚠7, droppable):** consult Task 0's recorded `grep -c 'ANTHROPIC_API_KEY' src/setup/credential-registry.ts`.
  - **≥1** (312 Task 7 landed): no edit. Optionally widen that entry's `description` to mention the three sidecar consumers — only if trivially safe against existing pins; otherwise leave it.
  - **0** (312 dropped it): append to `CREDENTIAL_REGISTRY`:

```ts
  {
    server: "llm-sidecar",
    title: "Anthropic API",
    description:
      "Direct Anthropic API key — powers the model-router classifier, meeting classifier, and memory autoDream (KPR-312/KPR-314). Key-less instances degrade: heuristics-only routing, all-roster meetings, skipped dream LLM phases.",
    helpUrl: "https://console.anthropic.com/settings/keys",
    kind: "secret",
    fields: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" }],
  },
```

  If any credentials/registry test enumerates entries or keys, **extend** the expectation (never delete). If the rider becomes contentious in review, drop it and note the drop in the hand-off.

- [ ] Verify:

```bash
npx vitest run src/cli/doctor-checks.test.ts src/cli/doctor.test.ts src/cli/credentials.test.ts src/setup/credential-registry.test.ts
npm run typecheck
```
Expected: green (if a `doctor.test.ts` pin asserts full output ordering, extend the expected output rather than moving the line).

- [ ] **Commit:** `KPR-314: W3.5 T8 — hive doctor llm-sidecar line (+ credential-registry rider if 312 dropped it)`

---

## Task 9 — GATED: manual smoke on a keyed dev instance (spec §8 test 9)

**This is a delivery gate** — the four migrated sites exercised once against reality. Needs a dev instance with `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` resolvable (env or Honeypot: `hive/<id>/<KEY>`), engine rebuilt (`npm run build` / `npm run bundle`) and restarted (`launchctl kickstart -k gui/$(id -u)/com.hive.<id>.agent`).

- [ ] **Boot + doctor:** engine log shows `LLM registry constructed` with both providers true; `hive doctor` shows `llm sidecar: anthropic ✓, gemini ✓` and never flips the exit verdict.
- [ ] **Image description:** upload one image to a Slack channel the agent watches → log shows `Image described` with `provider: "gemini"`; the agent's reply reflects the content. (No key on the instance? Then instead verify the null path: metadata-only entry, no warn spam.)
- [ ] **Meeting classification:** trigger one meeting-mode message on a multi-agent channel → dispatcher log `Conference classifier result` shows a non-zero `costUsd` (real registry cost, not subprocess `total_cost_usd`) and a sensible respond list.
- [ ] **Memory dream:** force one consolidation (operator path — e.g. the admin/console `runConsolidationForAgent` surface, or wait for a scheduled dream) → `autoDream complete` log shows non-zero `spentUsd`, `llmCalls ≥ 1`, and a `gateSkips` field (0 is fine).
- [ ] **Router:** send one routed non-heuristic message → `Model router decision` log shows non-zero `costUsd` and, for a sonnet/opus decision, an `effort` field; the turn completes.
- [ ] **Evidence:** paste the five log excerpts into the ticket/PR body. Redaction rules apply — no message text.
- [ ] **If any site misbehaves against the live API** (schema rejected, timeout mis-unit, cost wildly off): STOP, fix if mechanical, otherwise demote to the spec lane with the evidence.

**Commit:** none (evidence recorded in ticket/PR).

---

## Task 10 — Full gate

- [ ] From the worktree root:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck, ESLint, Prettier, full Vitest — zero failures. Confirm the output lists all four gates actually running (worktree/CI asymmetry check).

- [ ] If Prettier reformats any touched file: `npm run format`, re-run check.
- [ ] **Commit** (only if format/lint produced changes): `KPR-314: W3.5 T10 — format/lint pass`

Done — hand off to dodi-dev:review with the Task 9 evidence attached. No Linear writes, no PR from this plan (the lane's submit skill owns that). Hand-off notes must state: whether the Task 8 rider landed, and whether Task 3 took the sanctioned metadata-only retreat (⚠4).

---

## Assumptions

1. **Triple delivery gate**: runs after W2 + 311 + 312 are on the epic branch; Task 0 verifies by content and hard-stops (demote to spec lane) on drift. 313 is disjoint — indifferent either way. All spec ⚠1–⚠8 are settled; ⚠1's clamp-lift re-park is the driver's action, not this plan's.
2. **File layout**: `src/llm/{types,catalog,errors,provider-utils,registry,providers/*}` — catalog + estimate math AND the typed errors split out config-free so tests and `file-processor.ts` import them without env stubs; no barrel index.
3. **`LLMResult.stopReason`** added beyond the spec's §3.1 sketch — the minimum surface that lets the router's 312 refusal/`max_tokens` fallback conditions survive the transport swap byte-for-byte (spec ⚠4/⚠6 delegate exact surfaces to the plan).
4. **Catalog pricing only for haiku** ($1/$5 — 312's constants, verbatim hand-off). Sonnet/opus/gemini entries are capability-only: no call site consumes their cost, `pricing?` is spec-optional, and unconsumed constants are drift liability. Adding pricing later is one catalog line.
5. **`MemoryLifecycle` constructor**: `llm` is the required 4th parameter (store, embedder, config, llm, dreamConfig?, getActiveAgentIds?) — PR #194's position; required-ness makes the typechecker enforce the 19-site test sweep.
6. **`"hit your limit"` break deleted** (spec offered delete-or-re-key): the string is CLI-subscription-specific; re-keying to an API rate-limit shape would re-import SDK error types into a module that just shed them, and the per-agent catch + `canSpend()` + loop caps already bound damage.
7. **Belt-and-braces path** feeds `JSON.stringify(result.parsed) ?? result.text` through the **unchanged** `parseClassifierOutput` — one id-filter code path instead of two.
8. **`describeImage` no-key silence** via typed `LLMProviderUnavailableError` catch (not a `hasProvider` pre-check) — keeps the injected `VisionLlmClient` interface at one method and the module provider-agnostic.
9. **No-key gating at the two public entry points** (`dream()`, `runConsolidationForAgent`) covers the private `summarizeColdPhase` — there is no third caller.
10. **`__resetRouterClientForTests` renamed** to `__resetRouterStateForTests` (the router no longer holds a client) — its only consumers are in the test file this plan already rewrites.
11. **Doctor line placement**: immediately after 312's `model router:` line in both branches — sequenced with 312's precedent, testable contract in the pure helper.
12. **Plan constants**: memory timeout 30s, vision timeout 30s, meeting-classifier `maxOutputTokens` 256 (spec §3.3), anthropic provider default `max_tokens` 1024 (API requires one; all shipped call sites pass their own).
13. **Gate skips surface** as `DreamResult.gateSkips?` + `runConsolidationForAgent`'s return + the `autoDream complete` log line, whose emission guard widens to `totalActions > 0 || budget.gateSkips > 0` so an all-skipped run stays visible (additive optional — no consumer breaks); the estimate-gate tests pin outcomes via ranges relative to the $0.013 gate so wrapper-size drift can't flake exact-dollar assertions (the exact $0.00944/$0.01028/$0.02528 pins live in `registry.test.ts` against synthetic prompts).
14. **`npm run check` needs the three Slack env stubs** in a fresh worktree — environment quirk, not a product change.
