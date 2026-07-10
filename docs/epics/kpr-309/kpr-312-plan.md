# KPR-312 — Implementation Plan: Classifier v2 — no subprocess, structured outputs, effort-aware (W3.3)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** `docs/epics/kpr-309/kpr-312-spec.md` (approved after 3 review rounds — authoritative; ⚠-flagged assumptions are settled, do not re-litigate).
**Epic:** KPR-309 (pre-register epic — R3/R7 citations bind from W2's register, KPR-305 @ `af74cf7`). The provider clamp-lift stays parked in KPR-311's spec §5 (pickup W3.5 / KPR-314); nothing here touches it.

> **DELIVERY-CONTEXT NOTE (read first):** this plan executes **after two gates**: (1) the W2 epic (`kpr-305`) has merged to `main`/the epic branch — it carries `src/agents/provider-adapters/error-classification.ts`, which does not exist at spec-time HEAD `0a8ac3d`; and (2) **KPR-311's child PR has merged into the epic branch** — every `agent-manager.ts` / `provider-adapters/types.ts` / `model-router.ts` edit below is written against 311's plan-defined post-state (`kpr-311-plan.md` @ `8142cee`, as amended at the KPR-312 spec gate): `SpawnShaping` exists, `ModelRouterResult` carries dormant `provider?`/`effort?`, `ReasoningEffort` lives in `types.ts`, `createProviderAdapter(agentId, route)` consumes the shaping route. Edits anchor on unique code strings (many of them strings 311's plan itself introduces), not line numbers. **Task 0 re-confirms both gates and every anchored surface before any edit** and defines the demote-to-spec escape hatch.

## Goal

`routeModel`'s per-turn Claude Code CLI subprocess (`query()`, 8s timeout, $0.01/turn cap, free-text brace-scan parsing) is replaced by one direct `@anthropic-ai/sdk` structured-outputs call (`client.messages.parse` + `output_config.format`, haiku, shared keep-alive client, `maxRetries: 0`, 4s timeout). Deterministic heuristics H1–H3 short-circuit obvious cases for $0/~0ms. Key-less instances run **heuristics-only mode** (agent-default model, default-tier limits, `method: "no-key"`, boot log + new informational `hive doctor` line). The classifier emits `effort ∈ {low, medium, high}` (dropped when the post-cap tier is haiku), delivered to Claude turns via a channel **beside** the route — `SpawnShaping.effortOverride` → `AgentProviderTurnRequest.effort` → `runner.send` 8th param → SDK `Options.effort` — leaving 311's clamp, pilot gate, and route shape untouched. Two verdict riders: additive `bad-model` fault kind (last `FAULT_PATTERNS` row, never breaker-eligible) and the runner `is_error === true` guard in the subtype-keyed result branch. `ModelRouterResult` gains the additive `method` observability field. No cost-aware switch policy, no registry, no non-Claude classifier, no `thinking` config (all deferred/non-goals).

## Architecture

- **`src/agents/model-router.ts` stays the classifier's home** (decision, spec left layout to the plan): the complexity classifier *is* the model router's body — `TIER_MODELS`, `TIER_RANK`, `modelToTier`, `resolveResourceLimits`, and the fallback shapes are all consumed only here; extracting a `complexity-classifier.ts` would split those constants from their single consumer for a file that ends at ~330 lines, and KPR-314 (W3.5 registry) already names `model-router.ts` as its rebase surface for `TIER_MODELS`/pricing. One file, one responsibility: "message → per-turn routing decision."
- **The classifier call never routes through provider adapters** — no breaker `acquire()`/`record()`, no `providerFor()` pre-check (spec §7): its own `maxRetries: 0` + 4s timeout + sonnet fallback bounds damage to one cheap fallback per turn; during a real Anthropic outage the *turns themselves* surface breaker-eligible faults.
- **Effort rides beside the route, never in it.** 311's clamp/gate/merge are untouched except: one field copy in the merge branch (`effortOverride: result.effort`), one added call-site argument (`{hasFiles}`), one field in the `runTurn` request. The route object and `ProviderModelRoute` types do not change.
- **Test seam for the Anthropic client** (decision, spec delegated): `routeModel` is a free function, so constructor injection (knowledge-extractor's class pattern) doesn't apply. The client is a module-level lazy singleton (`getClient()`, spec §3.1 shape) plus an exported `__resetRouterClientForTests()` reset hook — the same seam pattern as `__resetRegistryForTests` in `src/archetypes/registry.ts` — and tests module-mock `@anthropic-ai/sdk`'s default export class (mirroring how `agent-runner.test.ts` module-mocks `@anthropic-ai/claude-agent-sdk`). No production-code DI indirection beyond the reset hook.

## Tech Stack

- TypeScript strict (no `any` without justification), Node 22+, ESM
- `@anthropic-ai/sdk` **^0.82.0 — already a dependency, no new packages** (verified installed: 0.82.0; `messages.parse` + `output_config` at `resources/messages/messages.d.ts:1908`; `jsonSchemaOutputFormat` at `helpers/json-schema.d.ts`; `SDKResultSuccess.is_error: boolean` and `Options.effort?: EffortLevel` typed in `@anthropic-ai/claude-agent-sdk/sdk.d.ts` :2620/:1193)
- Vitest, tests beside source; existing harnesses: `agent-runner.test.ts` (mockQuery + `getCapturedOptions`), `agent-manager.test.ts` (module-mocked `routeModel`, `makeRouterResult` from 311 T3, pilot constructor spies), `doctor-checks.test.ts`
- Logging via `createLogger`; **log-redaction convention applies** — the v2 decision log drops the old `textPreview` field (message text must not reach logs)
- Config: env-only keys, no hive.yaml surface → KPR-225 F3 liberal-loader rules trivially satisfied (nothing to add, nothing to ignore)

**Out of scope (do not touch):** 311's route merge/clamp/pilot gate logic, `createProviderAdapter` body, breaker wrap (`acquire()` first statement, record-once, retry `shaping` reuse — R7), `finalizeSpawnResult`/`RunResult` shape (R4), `provider-circuit-breaker.ts`, `providerFor()`, pilot adapters (`codex-subscription-adapter.ts`, `openai-agents-adapter.ts`, `gemini-adk-adapter.ts`), `HARD_FAULT_KINDS` membership and all existing `FAULT_PATTERNS` rows (R3 — additive row only), `TIER_MODELS` values, any `thinking` config, prompt-cache markers on the router prompt.

---

## Testing Contract

### Required Test Groups

**Unit — `required`** — spec §8 tests 1–8, realized as:

1. **Heuristics** (`src/agents/model-router.test.ts`, Task 2): H1 (ceiling haiku), H2 (exact-match ack/greeting, case-insensitive), H3 (empty text, no files) each → haiku, `costUsd: 0`, `method: "heuristic"`, **no `effort` key**, `messages.parse` never called. Negatives: `"fire the sales team"` (short but not allowlisted) and empty-text-**with**-files both reach the model path. Truncation: input > 4000 chars → classifier `content` is the 4000-char slice + `"\n[...truncated]"`; the returned result is otherwise normal.
2. **Model path — mocked `Anthropic` client** (`model-router.test.ts`, Task 2): parsed `{tier, effort}` → correct `TIER_MODELS` model, `method: "model"`, effort carried, `costUsd` computed from `usage` at $1/$5 per MTok, `durationMs` ≥ 0, tier-resolved `resourceLimits`; ceiling cap (opus→sonnet) preserves effort; **haiku result drops effort** (key absent, not `undefined`-valued); refusal stop / null `parsed_output` / `max_tokens` stop / thrown timeout → sonnet fallback with `method: "fallback"`, `costUsd: 0`, no effort; **no-key mode** → agent-default model + **resolved default-tier `resourceLimits`**, `method: "no-key"`, Anthropic constructor never invoked; client constructed once with `{apiKey, timeout: config.modelRouter.timeoutMs, maxRetries: 0}` and reused across calls.
3. **Effort threading** (`src/agents/agent-manager.test.ts`, Task 4): router-on merge copies `result.effort` → `shaping.effortOverride` → `runner.send` position 7 — including when the routed model equals the agent model (no `modelOverride`, effort still delivered — spec §7 edge row); `routeModel` receives the new 4th arg `{hasFiles}` reflecting `item.files`; router-off, system-sender, and **voice** paths deliver `undefined`; clamped-provider branch drops it; pilot `runTurn` request carries `effort: undefined`.
4. **Runner options mapping** (`src/agents/agent-runner.test.ts`, Task 4): `send(..., effort)` maps `effort` into the `query()` options (pinned via `getCapturedOptions()`); the key is **absent** when no effort passed; **no `thinking` key is ever set** (asserted in both cases); out-of-subset values (defensive) are dropped.
5. **Fault classifier** (`src/agents/provider-adapters/error-classification.test.ts`, Task 5): the **verbatim M8 string** (pinned character-for-character) → `{outcome: "fault", kind: "bad-model"}` via **both** `classifyTurnResult` and `classifyThrown`; `HARD_FAULT_KINDS.has("bad-model") === false`; last-row placement pinned (a string matching an earlier row still classifies as that row); all existing per-alternate row regressions untouched. **Negative-verify** (mutation): with the new row commented out, the M8 tests fail (`non-provider`).
6. **Runner `is_error` guard** (`agent-runner.test.ts`, Task 5): synthetic M8-shaped result (`subtype: "success"`, `is_error: true`, error text in `result`) → `RunResult.error` set to the text, `RunResult.text` NOT adopted; `is_error: false` control still adopts text. **Negative-verify** (mutation): with the guard disabled, the test fails (text adopted, error undefined).
7. **Delivery verification (manual, gated — Task 8):** one live run confirming SDK `Options.effort: "low"` is **accepted** on `claude-sonnet-4-6` via the CLI path and **meaningfully alters spend** vs. an effort-less control — equal spend is not a pass (accepted-but-ignored is the failure the gate detects); no-delta pairs are repeated, and persistent no-delta = gate failed (spec ⚠3/⚠4 — M9 tested `thinking` only; `effort` was never exercised by the spike). Evidence recorded before hand-off.
8. **Doctor line** (`src/cli/doctor-checks.test.ts`, Task 6): `modelRouterModeLine(true)` → `"model router: LLM classification"`; `modelRouterModeLine(false)` → `"model router: heuristics-only (no ANTHROPIC_API_KEY)"` (strings pinned verbatim); the helper is a pure string producer with no failure channel, and its `doctor.ts` wiring never touches `allPassed` (structural — see Task 6).

**Integration — judged: not required beyond the above.** The spawn path (tests 3) runs through the full `spawnTurn` pipeline in the existing `agent-manager.test.ts` harness — breaker wrap, shaping, adapter construction, retry — the highest fidelity available without a live SDK. The classifier call itself is a single non-streaming `messages.parse` whose contract (schema-constrained output, refusal semantics, usage fields) is SDK-typed and pinned by the mocked-client tests; a live-API integration test would burn quota to re-test Anthropic's own contract. The one genuinely unverified surface (SDK `effort` acceptance) is covered by the manual gate (test 7).

**E2E — `not-required`.** No user-facing flow changes shape; channels/dispatcher/voice untouched. The no-key behavior change is unit-pinned and doctor-surfaced.

### Critical Flows
1. Routed turn, key present: heuristic miss → one `messages.parse` call → `{tier, effort, method: "model"}` → merge → `modelOverride`/`resourceLimits`/`effortOverride` → `runner.send` → `query()` options carry `effort`, never `thinking`.
2. Routed turn, "thanks": H2 → haiku, $0, no API call, no effort.
3. Key-less instance: heuristic miss → agent-default model, default-tier limits, `method: "no-key"`, no client construction; doctor shows the heuristics-only line.
4. Classifier API failure: throw/refusal/null-parse → sonnet-capped fallback ≤4s, `method: "fallback"`, turn proceeds; breaker never consulted.
5. Turn-side bogus model (M8): SDK result `subtype: "success"` + `is_error: true` → runner sets `error` → classification `bad-model` → breaker-neutral.

### Regression Surface (must stay green)
- `src/agents/agent-manager.test.ts` — **311's suites**: `router→adapter seam (KPR-311)` describe (Task 4 amends test 1a's comment/assertions and appends one clamp assertion — the rest byte-identical), `router→adapter seam invariants (KPR-311)` describe, plus the KPR-224 shaping pins, KPR-306 breaker-wrap describe, KPR-307 propagation describe, pilot `it.each` routing, voice carve-out.
- `src/agents/model-router.test.ts` — existing `resolveResourceLimits` describe unchanged (new mocks at file top must not disturb it).
- `src/agents/provider-adapters/error-classification.test.ts` — **W2 suite**: every existing per-alternate row pin, `classifyThrown`, `HARD_FAULT_KINDS` sorted-membership test — assertions all unmodified (R3 boundary; the new describe is additive; the one exception is a **title-only** rename of the stale HARD_FAULT_KINDS `it` title, Task 5).
- `src/agents/provider-circuit-breaker.test.ts`, `src/agents/circuit-breaker-heartbeat.test.ts` — untouched W2 breaker suites; any failure means this change leaked across R7/R3.
- `src/agents/provider-adapters/claude-agent-adapter.test.ts` — **updated for the 8th arg** (Task 4); the abort/provider test unchanged.
- `codex-subscription-adapter.test.ts`, `openai-agents-adapter.test.ts`, `gemini-adk-adapter.test.ts` — untouched (pilots never see effort).
- `src/agents/agent-runner.test.ts` — all existing describes (the send-signature change is additive-optional; the `is_error` guard only fires on `is_error: true`, which no existing fixture sets).
- `src/cli/doctor-checks.test.ts`, `doctor.test.ts`, `src/cli/credentials.test.ts` — existing pins (Task 7's registry entry may require extending an enumerating pin — extend, never delete).

### Commands
```bash
# Targeted (after each task)
npx vitest run src/agents/model-router.test.ts
npx vitest run src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts src/agents/provider-adapters/
npx vitest run src/cli/doctor-checks.test.ts

# Full gate (Task 0 baseline + Task 9; env stubs required by config load in tests)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: all suites pass; `check` = typecheck + lint + format + test, zero failures. (Worktree/CI asymmetry reminder: confirm the check output actually lists all four gates running — do not trust a pass that self-disabled on a `.claude/worktrees/` ignore fragment.)

### Harness Requirements
- **`model-router.test.ts` (new mocks, Task 2):** `vi.mock("@anthropic-ai/sdk")` replacing the default-export class with a stub whose `messages.parse` is a hoisted `mockParse` spy and whose constructor records its options (`mockAnthropicCtor`); `vi.mock("../config.js")` with a hoisted **mutable** config object so tests toggle `anthropic.apiKey`; `vi.mock("../logging/logger.js")` (standard stub). The real `jsonSchemaOutputFormat` helper is NOT mocked (pure function, separate subpath, no network). `beforeEach` calls the new `__resetRouterClientForTests()` so client construction is order-independent.
- **`agent-manager.test.ts`:** 311's harness as-landed — module-mocked `routeModel`, `makeRouterResult` factory, `mockRunnerSend`, pilot constructor/runTurn spies. No new mocks.
- **`agent-runner.test.ts`:** existing `mockQuery`/`mockMessages`/`getCapturedOptions` harness. No new mocks.
- **`doctor-checks.test.ts` / `error-classification.test.ts`:** pure-function tests, no mocks.
- No DB, no network, no live SDK anywhere in the unit surface.

### Non-Required Rationale
- No live classifier-API test: schema compilation/caching, refusal shape, and `parsed_output` semantics are Anthropic-side contracts typed by the SDK; the mocked-client tests pin *our* handling of every branch.
- No pilot-adapter test changes: pilots receive `effort: undefined` under the gate and ignore the field — the same tested precedent as `modelOverride`/`resourceLimits` (311 §4).
- No hive.yaml loader test: `config.modelRouter` keys are env-only, unchanged names; only a default value changes (Task 1) and defaults aren't loader surface.

### Verification Rules
1. A missing harness is not a skip reason — if a listed test doesn't exist at a task's Verify step, write it; do not mark the task done without running the listed commands and seeing the expected output.
2. When a test fails, fix the implementation, not the test — unless the test contradicts the spec's pinned semantics (heuristic order, effort-drop rules, no-key shape, last-row placement, no-`thinking` invariant), in which case the spec wins.
3. Spec/plan mismatch demotes to the spec lane: if executing this plan surfaces a conflict with `kpr-312-spec.md` (or Task 0 finds anchored-surface drift), stop and route the ticket back through dodi-dev:mature-ticket with a drift note — do not improvise a resolution in the delivery lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/agents/model-router.ts` | rewritten body | Classifier v2: heuristics, lazy client, `messages.parse` call, `method` field, effort emission rules, `ROUTER_PROMPT_V2`, pricing constants, test reset hook. `resolveResourceLimits`/`RESOURCE_TIER_DEFAULTS`/`TIER_MODELS` unchanged. |
| `src/config.ts` | 1 line | `MODEL_ROUTER_TIMEOUT_MS` default 8000 → 4000 |
| `src/agents/model-router.test.ts` | modified | New mocks + heuristics/model-path/no-key describes; existing `resolveResourceLimits` describe untouched |
| `src/agents/agent-manager.ts` | modified | `SpawnShaping.effortOverride`; 5 return-site fills; `{hasFiles}` call-site arg; `runTurn` `effort` field; import + merge-comment update |
| `src/agents/provider-adapters/types.ts` | modified | `AgentProviderTurnRequest.effort?: ReasoningEffort` |
| `src/agents/provider-adapters/claude-agent-adapter.ts` | modified | Forward `request.effort` as `send`'s 8th arg |
| `src/agents/agent-runner.ts` | modified | `send` optional 8th param + options mapping (Task 3); `is_error` guard (Task 5) |
| `src/agents/agent-manager.test.ts` | modified | Test 1a amended + clamp assertion + new `effort delivery channel (KPR-312)` describe |
| `src/agents/provider-adapters/claude-agent-adapter.test.ts` | modified | 8-arg delegation |
| `src/agents/agent-runner.test.ts` | modified | Effort-options describe + `is_error` guard describe |
| `src/agents/provider-adapters/error-classification.ts` | modified (additive) | `"bad-model"` kind + last `FAULT_PATTERNS` row + JSDoc touch-ups |
| `src/agents/provider-adapters/error-classification.test.ts` | modified (additive) | `bad-model` describe with verbatim M8 string |
| `src/cli/doctor-checks.ts` | modified | `modelRouterModeLine()` pure helper |
| `src/cli/doctor.ts` | modified | Emit the mode line (config-loaded + skipped branches) |
| `src/cli/doctor-checks.test.ts` | modified | Mode-line describe |
| `src/setup/credential-registry.ts` | modified (optional rider, Task 7) | `ANTHROPIC_API_KEY` curated entry |

No new files. One commit per task; every task leaves the tree green (`npm run typecheck` + scoped tests).

---

## Task 0 — Re-confirm anchored surfaces at delivery HEAD (mandatory, Gate 1 D2)

**Goal:** prove the delivery worktree carries BOTH the post-W2 surfaces AND 311's landed shapes before touching anything.

- [ ] **Gate A — W2 in history:** `git log --oneline | grep -i "kpr-30[5678]" | head` shows W2 commits (or the W2 epic merge). `ls src/agents/provider-adapters/error-classification.ts` succeeds. If either fails: **STOP — delivery gate not met.**
- [ ] **Gate B — 311 landed:** `git log --oneline | grep -i "kpr-311" | head` shows 311's task commits (or its child-PR merge). If absent: **STOP.**
- [ ] Re-confirm each anchored surface by content (line numbers will have drifted; strings must match with the stated counts). Two operational notes:
  - **`grep`/`grep -c` exit non-zero on zero matches** — the expected-0-hits lines (`effortOverride`, `bad-model`, `model router`, runner `effort`) will "fail" a `set -e` shell or look like errors; run them individually and judge by the printed count/output, not the exit code (or append `|| true`).
  - **The `.prettierignore` `agents/`-scoped entry is what shields these single-line anchors** (e.g. the 7-param `send` signature) from being rewrapped by Prettier — it is load-bearing for this plan's string anchoring. Do **not** "fix"/remove that ignore entry mid-delivery; if a formatting cleanup wants it gone, that's a separate ticket after 312 lands.

```bash
# 1. 311 shapes in agent-manager.ts (all from kpr-311-plan.md Task 2):
grep -n 'interface SpawnShaping' src/agents/agent-manager.ts                                  # 1 hit
grep -n 'routerTier: ModelTier | undefined;' src/agents/agent-manager.ts                      # 1 hit
grep -c 'modelOverride: undefined, routerTier: undefined, resourceLimits: undefined, routerCostUsd: 0 }' src/agents/agent-manager.ts   # expect 3 (voice, gate-skip, catch)
grep -n 'routerTier: result.tier, resourceLimits: result.resourceLimits, routerCostUsd: result.costUsd }' src/agents/agent-manager.ts  # 1 hit (clamp)
grep -n 'routerCostUsd: result.costUsd,' src/agents/agent-manager.ts                          # 1 hit (merge return)
grep -n 'await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers)' src/agents/agent-manager.ts  # 1 hit
grep -n 'const adapter = this.createProviderAdapter(ctx.agentId, shaping.route);' src/agents/agent-manager.ts    # 1 hit (311 shape)
grep -n 'systemPromptOverride: ctx.systemPromptOverride,' src/agents/agent-manager.ts         # 1 hit (runTurn call)
grep -n 'effortOverride' src/agents/agent-manager.ts                                          # 0 hits (312 not yet applied)
grep -n 'import type { AgentProviderAdapter, AgentProviderId } from "./provider-adapters/types.js";' src/agents/agent-manager.ts  # 1 hit — FULL line pinned (kpr-305:33, untouched by 311; AgentProviderId is consumed by providerFor(), Task 3 must keep it)

# 2. Types (311 Task 1):
grep -n 'export type ReasoningEffort' src/agents/provider-adapters/types.ts                   # 1 hit
grep -n 'systemPromptOverride?: string;' src/agents/provider-adapters/types.ts                # 1 hit
grep -n 'effort?: ReasoningEffort;' src/agents/model-router.ts                                # 1 hit (dormant carriage field)
grep -n 'import type { AgentProviderId, ReasoningEffort }' src/agents/model-router.ts         # 1 hit (311 type import)

# 3. model-router.ts pre-312 body:
grep -n 'export interface ModelRouterResult' src/agents/model-router.ts                       # 1 hit
grep -c 'parseRouterOutput' src/agents/model-router.ts                                        # expect 2 (def + call)
grep -n 'maxBudgetUsd: 0.01' src/agents/model-router.ts                                       # 1 hit (the subprocess to delete)

# 4. agent-runner.ts anchors:
grep -n 'async send(prompt: string, sessionId?: string, onStream?: StreamCallback, context?: WorkItemContext, modelOverride?: string, resourceLimits?: ResourceLimits, systemPromptOverride?: string)' src/agents/agent-runner.ts  # 1 hit
grep -n 'maxBudgetUsd: resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,' src/agents/agent-runner.ts  # 1 hit
grep -n 'resultText = result.result || resultText;' src/agents/agent-runner.ts                # 1 hit
grep -cn 'effort' src/agents/agent-runner.ts                                                  # expect 0

# 5. W2 fault classifier (kpr-305 shape, R3 read-mostly):
grep -n '\["server-error", ' src/agents/provider-adapters/error-classification.ts             # 1 hit (current last row)
grep -c 'bad-model' src/agents/provider-adapters/error-classification.ts                      # expect 0
# M8 string still matches no existing row (spec §5 W2-gate re-verify):
npx tsx -e 'import("./src/agents/provider-adapters/error-classification.js" as string).catch(()=>import("./src/agents/provider-adapters/error-classification.ts" as string)).then((m:any)=>{const c=m.classifyThrown(new Error("There'"'"'s an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it."));console.log(c.kind);process.exit(c.kind==="non-provider"?0:1)})'
# expect output: non-provider (exit 0). If any existing row matches it, STOP (spec §5).

# 6. Config + adapter + doctor anchors:
grep -n 'MODEL_ROUTER_TIMEOUT_MS", "8000"' src/config.ts                                      # 1 hit
grep -n 'apiKey: optional("ANTHROPIC_API_KEY", "")' src/config.ts                             # 1 hit
grep -n 'request.systemPromptOverride,' src/agents/provider-adapters/claude-agent-adapter.ts  # 1 hit
grep -n 'renderMemoryLifecycleSection(memoryRows' src/cli/doctor.ts                           # 1 hit
grep -rn 'model router' src/cli/doctor.ts src/cli/doctor-checks.ts                            # 0 hits

# 7. Test-file anchors:
grep -n 'router→adapter seam (KPR-311)' src/agents/agent-manager.test.ts                      # 1 hit
grep -n 'function makeRouterResult' src/agents/agent-manager.test.ts                          # 1 hit (311 T3)
grep -n 'without merging a router-set effort into the route' src/agents/agent-manager.test.ts # 1 hit (test 1a, amended in Task 4)
grep -n 'function getCapturedOptions' src/agents/agent-runner.test.ts                         # 1 hit
grep -n 'describe("resolveResourceLimits"' src/agents/model-router.test.ts                    # 1 hit
grep -n '7-arg\|current Hive turn shape' src/agents/provider-adapters/claude-agent-adapter.test.ts  # ≥1 hit
grep -n 'describe("HARD_FAULT_KINDS"' src/agents/provider-adapters/error-classification.test.ts    # 1 hit

# 8. SDK surface (install deps first if node_modules is absent: npm ci):
node -e 'console.log(require("@anthropic-ai/sdk/package.json").version)'                      # 0.82.x
grep -n 'output_config?: OutputConfig' node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts | head -1   # hit
grep -n 'jsonSchemaOutputFormat' node_modules/@anthropic-ai/sdk/helpers/json-schema.d.ts      # hit
grep -n 'effort?: EffortLevel' node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts           # 1 hit (Options)
```

- [ ] Baseline gate:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: fully green before any edit.

**Escape hatch (drift found):** if any grep misses or hits a different count, if the M8 pre-check classifies anything other than `non-provider`, or if 311's `prepareSpawn`/`SpawnShaping` shape differs from the kpr-311-plan Task 2 blocks this plan quotes — **make no edits**. Demote to the spec lane (dodi-dev:mature-ticket) with a drift note listing exactly which anchors failed and what is there instead.

**Commit:** none (read-only task).

---

## Task 1 — Classifier v2: `model-router.ts` rewrite + timeout default

**Goal:** the whole spec §3.1–§3.3 in one compile-green edit — subprocess out, structured-outputs call in, heuristics, no-key mode, `method` field, effort emission rules.

- [ ] **`src/config.ts`** — one line (spec ⚠6; operator-set values honored unchanged). Old:

```ts
    timeoutMs: parseInt(optional("MODEL_ROUTER_TIMEOUT_MS", "8000"), 10),
```

New:

```ts
    // KPR-312: 8000 → 4000 — the CLI-startup headroom is gone; a direct haiku
    // call at p50 ~0.5s doesn't need 8s before falling back.
    timeoutMs: parseInt(optional("MODEL_ROUTER_TIMEOUT_MS", "4000"), 10),
```

- [ ] **`src/agents/model-router.ts`** — full file replacement with the content below. Preserved verbatim from the post-311 file: `ModelTier`, `ResourceLimits`, `ResourceTierOverrides`, `RESOURCE_TIER_DEFAULTS`, `resolveResourceLimits`, `TIER_RANK`, `TIER_MODELS`, `modelToTier`, and `ModelRouterResult.provider`'s 311 JSDoc. Deleted: the `@anthropic-ai/claude-agent-sdk` import, `ROUTER_PROMPT`, `parseRouterOutput`, and the entire `query()`/deadline body. If the post-311 file differs from this expectation beyond comment whitespace, that is Task 0 drift — stop.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import type { AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";

const log = createLogger("model-router");

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ResourceLimits {
  timeoutMs: number;
  maxTurns: number;
  budgetUsd: number;
}

/** Per-agent override map — only specified fields override the tier default */
export type ResourceTierOverrides = Partial<Record<ModelTier, Partial<ResourceLimits>>>;

/** Global defaults per tier — these fire when no per-agent override exists */
export const RESOURCE_TIER_DEFAULTS: Record<ModelTier, ResourceLimits> = {
  haiku:  { timeoutMs: 120_000,  maxTurns: 20,  budgetUsd: 1  },
  sonnet: { timeoutMs: 300_000,  maxTurns: 50,  budgetUsd: 5  },
  opus:   { timeoutMs: 600_000,  maxTurns: 200, budgetUsd: 50 },
};

/**
 * Resolve resource limits for a tier, applying per-agent overrides on top of global defaults.
 */
export function resolveResourceLimits(
  tier: ModelTier,
  agentOverrides?: ResourceTierOverrides,
): ResourceLimits {
  const defaults = RESOURCE_TIER_DEFAULTS[tier];
  const overrides = agentOverrides?.[tier];
  if (!overrides) return { ...defaults };
  return {
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    maxTurns: overrides.maxTurns ?? defaults.maxTurns,
    budgetUsd: overrides.budgetUsd ?? defaults.budgetUsd,
  };
}

/** Ordered from least to most capable */
const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** Map tier names to actual model IDs */
const TIER_MODELS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

/**
 * KPR-312: interim classifier pricing (claude-haiku-4-5), USD per million
 * tokens — the direct API returns token usage, not total_cost_usd, so
 * routerCostUsd is computed here. Cache fields are ignored: the router
 * prompt (~300 tok) is far below haiku's 4096-token cacheable minimum.
 * TODO(KPR-314): the W3.5 sidecar LLM registry owns model metadata/pricing.
 */
const ROUTER_INPUT_USD_PER_MTOK = 1;
const ROUTER_OUTPUT_USD_PER_MTOK = 5;

/** KPR-312 §3.3: classifier input bound — bounds worst-case cost/latency. */
const MAX_CLASSIFIER_INPUT = 4000;

/**
 * KPR-312 H2: exact-match ack/greeting allowlist (case-insensitive, trimmed).
 * EXACT MATCH ONLY — no substring/length heuristics, so "fire the sales team"
 * can never short-circuit. Membership is a plan-level constant (spec ⚠8).
 */
const ACK_ALLOWLIST: ReadonlySet<string> = new Set([
  "hi", "hello", "hey",
  "thanks", "thank you", "thx",
  "ok", "okay",
  "yes", "no", "yep", "nope",
  "got it", "sounds good", "sure", "will do",
  "👍",
]);

/** Infer tier from a model ID string */
function modelToTier(model: string): ModelTier {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
  /** Absent ⇒ inherit the agent's static provider (resolveProviderModel(agent.model)).
   *  Dormant in W3: routeModel never sets it, AND even if set it is inert — a value
   *  matching the static provider is a no-op, a mismatch is clamped to static (spec §2/§5).
   *  Carriage-only until the spec §5 pilot-gate/clamp lift (the same lift that
   *  gates pilot effort delivery). */
  provider?: AgentProviderId;
  /** KPR-312: emitted by the model path only (method: "model"), ∈ {low, medium, high}
   *  (schema-constrained; the subset valid on both ReasoningEffort and the agent
   *  SDK's EffortLevel). Dropped inside routeModel when the post-cap tier is haiku
   *  (claude-haiku-4-5 rejects the effort param). Never merged into the route —
   *  delivered beside it via SpawnShaping.effortOverride → AgentProviderTurnRequest.effort
   *  → SDK Options.effort. Pilot delivery still gated on the 311 spec §5 lift. */
  effort?: ReasoningEffort;
  /** KPR-312: how the decision was made — heuristic short-circuit, model call,
   *  key-less mode, or failure fallback. Observability-only. "no-key"
   *  (unconfigured — steady state, surface once) is deliberately distinct from
   *  "fallback" (API failing — incident to alarm on). */
  method?: "heuristic" | "model" | "no-key" | "fallback";
}

/**
 * KPR-312: classifier v2 system prompt. Changes vs v1: adds the effort rubric,
 * drops the "Respond with ONLY a JSON object" plea (structured outputs enforce
 * the shape), drops the dead scheduled/cron rule (prepareSpawn gates the router
 * with sender !== "system"; every scheduler/cron/callback producer sets it).
 * No prompt-cache marker: ~300 tokens is far below haiku-4-5's 4096-token
 * cacheable minimum.
 */
const ROUTER_PROMPT_V2 = `You are a model router. Classify the complexity of a user message: decide which AI model tier should handle it, and how much reasoning effort the turn deserves.

Tiers:
- **haiku**: Greetings, simple factual questions, acknowledgments, status checks, yes/no answers, brief lookups, routine updates. Fast and cheap.
- **sonnet**: Multi-step tasks, drafting emails/messages, summarizing data, moderate analysis, tool-heavy workflows, most day-to-day business work. Balanced.
- **opus**: Complex reasoning, strategic planning, nuanced judgment calls, multi-faceted analysis, creative problem-solving, anything where getting it wrong has real consequences. Maximum intelligence.

Effort (how hard the chosen tier should work on this turn):
- **low**: Routine lookups, short answers, single simple actions within the chosen tier.
- **medium**: Typical multi-step work — most tasks land here.
- **high**: Consequential judgment, intricate multi-part work, high cost of getting it wrong.

Rules:
- When in doubt, pick sonnet — it handles most things well.
- Short messages are NOT automatically haiku — "fire the sales team" is short but definitely opus.
- Look at the TASK complexity, not the message length.`;

/** Strict output schema — server-compiled once, 24h-cached (GA, no beta header). */
const OUTPUT_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  properties: {
    tier: { type: "string", enum: ["haiku", "sonnet", "opus"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["tier", "effort"],
  additionalProperties: false,
} as const);

// ── Anthropic client (module-level, lazy, shared) ──────────────────────
// KPR-312: one keep-alive client for all classifier calls — no per-turn
// process/connection churn (the same motivation as KPR-122's in-process
// MCPs). Null ⇔ no ANTHROPIC_API_KEY ⇔ heuristics-only mode.
let client: Anthropic | null = null;
let noKeyModeAnnounced = false;

function getClient(): Anthropic | null {
  if (!config.anthropic.apiKey) return null; // key checked every call — mode follows live config
  return (client ??= new Anthropic({
    apiKey: config.anthropic.apiKey,
    timeout: config.modelRouter.timeoutMs, // ms — per-request wall clock (TS SDK unit)
    maxRetries: 0, // fail fast into the sonnet fallback; retrying would stack timeouts
  }));
}

/** Test-only seam (precedent: __resetRegistryForTests in archetypes/registry.ts). */
export function __resetRouterClientForTests(): void {
  client = null;
  noKeyModeAnnounced = false;
}

function heuristicHaiku(resourceTierOverrides?: ResourceTierOverrides): ModelRouterResult {
  return {
    tier: "haiku",
    model: TIER_MODELS.haiku,
    costUsd: 0,
    durationMs: 0,
    resourceLimits: resolveResourceLimits("haiku", resourceTierOverrides),
    method: "heuristic",
  };
}

/**
 * Failure fallback — same tier semantics as v1's error path (sonnet capped at
 * ceiling), minus up to 8 seconds of subprocess. Never emits effort (a $0
 * decision shouldn't tune a lever it didn't reason about).
 */
function sonnetFallback(
  ceilingTier: ModelTier,
  resourceTierOverrides?: ResourceTierOverrides,
): ModelRouterResult {
  const fallbackTier: ModelTier = TIER_RANK[ceilingTier] >= TIER_RANK.sonnet ? "sonnet" : ceilingTier;
  return {
    tier: fallbackTier,
    model: TIER_MODELS[fallbackTier],
    costUsd: 0,
    durationMs: 0,
    resourceLimits: resolveResourceLimits(fallbackTier, resourceTierOverrides),
    method: "fallback",
  };
}

/**
 * Classify a message and return the recommended model tier (+ per-turn effort).
 * The result is capped at `ceilingModel` — the agent's configured maximum.
 *
 * KPR-312: deterministic heuristics (H1–H3, first match wins) short-circuit
 * before any client/API work; the model path is one direct structured-outputs
 * call (client.messages.parse) — the per-turn Claude Code CLI subprocess is
 * gone. Key-less instances run heuristics-only (`method: "no-key"`).
 *
 * NOTE (spec §7): this call deliberately does NOT route through the provider
 * adapters — never breaker-recorded, never permit-gated. A classifier fault
 * must not count toward turn-provider health; its own timeout + fallback
 * bounds damage to one cheap fallback per turn.
 *
 * @param opts.hasFiles — file-bearing messages must not be mis-short-circuited
 *   by the empty-text rule (H3): the router only sees `item.text`, while file
 *   content is appended into the assembled prompt downstream.
 */
export async function routeModel(
  text: string,
  ceilingModel: string,
  resourceTierOverrides?: ResourceTierOverrides,
  opts?: { hasFiles?: boolean },
): Promise<ModelRouterResult> {
  const ceilingTier = modelToTier(ceilingModel);

  // H1 — ceiling is already the cheapest tier: skip everything (v1 behavior, kept verbatim).
  if (ceilingTier === "haiku") {
    return heuristicHaiku(resourceTierOverrides);
  }

  const trimmed = text.trim();

  // H2 — exact-match ack/greeting allowlist.
  if (ACK_ALLOWLIST.has(trimmed.toLowerCase())) {
    return heuristicHaiku(resourceTierOverrides);
  }

  // H3 — empty text and no files: nothing to classify. File-bearing items skip
  // this — files mean real work the classifier can't see.
  if (trimmed.length === 0 && !opts?.hasFiles) {
    return heuristicHaiku(resourceTierOverrides);
  }

  const anthropic = getClient();
  if (!anthropic) {
    // No-key mode (spec §3.3): keep the agent's default model with its default
    // tier's resource limits — conservative, never a wrong upshift. Announce
    // once per boot; `hive doctor` carries the standing line.
    if (!noKeyModeAnnounced) {
      noKeyModeAnnounced = true;
      log.info(
        "Model router running heuristics-only (no ANTHROPIC_API_KEY) — non-obvious turns keep the agent default model",
      );
    }
    const tier = modelToTier(ceilingModel);
    return {
      tier,
      model: ceilingModel,
      costUsd: 0,
      durationMs: 0,
      resourceLimits: resolveResourceLimits(tier, resourceTierOverrides),
      method: "no-key",
    };
  }

  // Model path — bound the classifier input (same pattern as knowledge-extractor).
  const truncated =
    trimmed.length > MAX_CLASSIFIER_INPUT
      ? trimmed.slice(0, MAX_CLASSIFIER_INPUT) + "\n[...truncated]"
      : trimmed;
  // Empty text + files reaches the model path (H3 skipped) — the API rejects
  // empty text blocks, so classify a placeholder instead.
  const classifierInput = truncated.length > 0 ? truncated : "(attachment-only message, no text)";

  const startedAt = Date.now();
  try {
    const response = await anthropic.messages.parse({
      model: config.modelRouter.model, // default claude-haiku-4-5-20251001
      max_tokens: 100,
      system: ROUTER_PROMPT_V2,
      messages: [{ role: "user", content: classifierInput }],
      output_config: { format: OUTPUT_FORMAT },
    });

    const parsed = response.parsed_output;
    if (
      response.stop_reason === "refusal" ||
      response.stop_reason === "max_tokens" ||
      !parsed ||
      TIER_RANK[parsed.tier as ModelTier] === undefined
    ) {
      log.warn("Model router returned unusable output, defaulting to sonnet", {
        stopReason: response.stop_reason,
        hasParsedOutput: Boolean(parsed),
      });
      return sonnetFallback(ceilingTier, resourceTierOverrides);
    }

    const requested = parsed.tier as ModelTier;
    const effort: ReasoningEffort | undefined =
      parsed.effort === "low" || parsed.effort === "medium" || parsed.effort === "high"
        ? parsed.effort
        : undefined;
    const costUsd =
      (response.usage.input_tokens * ROUTER_INPUT_USD_PER_MTOK +
        response.usage.output_tokens * ROUTER_OUTPUT_USD_PER_MTOK) /
      1_000_000;
    const durationMs = Date.now() - startedAt;

    // Cap at ceiling (kept from v1).
    let finalTier = requested;
    if (TIER_RANK[requested] > TIER_RANK[ceilingTier]) {
      finalTier = ceilingTier;
      log.debug("Model router capped by ceiling", { requested, ceiling: ceilingTier });
    }

    // Log-redaction convention: no message text / input previews (v1's
    // textPreview is deliberately dropped).
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
      // §3.2 rule 2: drop effort when the FINAL (post-cap) tier is haiku —
      // claude-haiku-4-5 rejects the effort param; emitting it would 400 the turn.
      ...(finalTier === "haiku" || effort === undefined ? {} : { effort }),
    };
  } catch (err) {
    // maxRetries: 0 — any timeout / 429 / 5xx / 404 (misconfigured
    // MODEL_ROUTER_MODEL) lands here. Operator-visible noise by design.
    log.warn("Model router call failed, defaulting to sonnet", { error: String(err) });
    return sonnetFallback(ceilingTier, resourceTierOverrides);
  }
}
```

Implementation notes for the executor:
- If `response.parsed_output`'s inferred type is already the schema literal union (expected — `jsonSchemaOutputFormat` + `as const` gives `{tier: "haiku"|"sonnet"|"opus"; effort: "low"|"medium"|"high"} | null`), the two `as ModelTier` casts and the effort narrowing collapse to plain assignments — prefer the inferred types and delete the redundant narrowing **only if** `npm run typecheck` stays green without them. If inference yields a looser type, keep the runtime guards exactly as written (no `any`).
- Do NOT add a `providerFor()`/breaker touch, a retry loop, or a `thinking` key anywhere in this file.

- [ ] Verify:

```bash
npm run typecheck
npx vitest run src/agents/model-router.test.ts src/agents/agent-manager.test.ts
```
Expected: green. `model-router.test.ts` (still `resolveResourceLimits`-only at this point) passes untouched; `agent-manager.test.ts` passes because `routeModel` is module-mocked there — the signature change is additive-optional.

- [ ] **Commit:** `KPR-312: W3.3 T1 — classifier v2: direct structured-outputs call, heuristics H1-H3, no-key mode, method field`

---

## Task 2 — Classifier tests (spec tests 1–2)

All edits in `src/agents/model-router.test.ts`. The existing `resolveResourceLimits` describe stays byte-identical; mocks and new describes are added around it.

- [ ] **Replace the file's import header** (old two-line header → mocks + imports):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (KPR-312) ────────────────────────────────────────────────────
// The Anthropic client is a module-level lazy singleton in model-router.ts;
// tests mock the SDK's default-export class (mirrors agent-runner.test.ts's
// module mock of the agent SDK) and reset the singleton via the exported
// __resetRouterClientForTests() seam so construction is order-independent.
const { mockParse, mockAnthropicCtor, mockConfig } = vi.hoisted(() => ({
  mockParse: vi.fn(),
  mockAnthropicCtor: vi.fn(),
  mockConfig: {
    anthropic: { apiKey: "test-key" },
    modelRouter: { enabled: true, model: "claude-haiku-4-5-20251001", timeoutMs: 4000 },
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { parse: mockParse };
    constructor(opts: unknown) {
      mockAnthropicCtor(opts);
    }
  },
}));
// NOTE: "@anthropic-ai/sdk/helpers/json-schema" is deliberately NOT mocked —
// jsonSchemaOutputFormat is a pure function; the real helper runs at module load.

vi.mock("../config.js", () => ({ config: mockConfig }));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  routeModel,
  resolveResourceLimits,
  RESOURCE_TIER_DEFAULTS,
  __resetRouterClientForTests,
  type ModelRouterResult,
} from "./model-router.js";
```

- [ ] **Append the new describes** after the existing `resolveResourceLimits` block:

```ts
function makeParseResponse(
  parsed: { tier: string; effort: string } | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    stop_reason: "end_turn",
    parsed_output: parsed,
    usage: { input_tokens: 500, output_tokens: 10 },
    ...overrides,
  };
}

describe("routeModel — classifier v2 (KPR-312)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.anthropic.apiKey = "test-key";
    __resetRouterClientForTests();
    mockParse.mockResolvedValue(makeParseResponse({ tier: "sonnet", effort: "medium" }));
  });

  describe("heuristics (H1–H3)", () => {
    it("H1: haiku ceiling short-circuits — $0, method heuristic, no effort, no API call", async () => {
      const r = await routeModel("do something elaborate", "claude-haiku-4-5-20251001");
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, durationMs: 0, method: "heuristic" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
      expect("effort" in r).toBe(false);
      expect(mockParse).not.toHaveBeenCalled();
      expect(mockAnthropicCtor).not.toHaveBeenCalled();
    });

    it.each(["thanks", "Thanks", "  ok  ", "THANK YOU", "👍", "got it", "will do"])(
      "H2: exact-match ack %j → haiku heuristic, no API call",
      async (msg) => {
        const r = await routeModel(msg, "claude-opus-4-7");
        expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
        expect("effort" in r).toBe(false);
        expect(mockParse).not.toHaveBeenCalled();
      },
    );

    it("H2 is exact-match only: 'fire the sales team' goes to the model", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "opus", effort: "high" }));
      const r = await routeModel("fire the sales team", "claude-opus-4-7");
      expect(mockParse).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ tier: "opus", method: "model" });
    });

    it("H2 is exact-match only: 'thanks, also rewrite the contract' goes to the model", async () => {
      await routeModel("thanks, also rewrite the contract", "claude-opus-4-7");
      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    it("H3: empty text without files → haiku heuristic", async () => {
      const r = await routeModel("   ", "claude-opus-4-7", undefined, { hasFiles: false });
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("H3: empty text WITH files is not short-circuited — model path with placeholder input", async () => {
      await routeModel("", "claude-opus-4-7", undefined, { hasFiles: true });
      expect(mockParse).toHaveBeenCalledTimes(1);
      const req = mockParse.mock.calls[0]![0];
      expect(req.messages[0].content).toBe("(attachment-only message, no text)");
    });

    it("truncates classifier input above the bound; classification proceeds", async () => {
      const huge = "x".repeat(6000);
      const r = await routeModel(huge, "claude-opus-4-7");
      const content: string = mockParse.mock.calls[0]![0].messages[0].content;
      expect(content.length).toBe(4000 + "\n[...truncated]".length);
      expect(content.endsWith("[...truncated]")).toBe(true);
      expect(r.method).toBe("model");
    });
  });

  describe("model path (mocked Anthropic client)", () => {
    it("constructs the client once with apiKey/timeout/maxRetries:0 and reuses it", async () => {
      await routeModel("draft the quarterly summary", "claude-opus-4-7");
      await routeModel("draft another quarterly summary", "claude-opus-4-7");
      expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
      expect(mockAnthropicCtor).toHaveBeenCalledWith({
        apiKey: "test-key",
        timeout: 4000,
        maxRetries: 0,
      });
      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("returns parsed tier + effort with usage-derived cost and tier limits", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "sonnet", effort: "medium" }));
      const r = await routeModel("summarize this thread", "claude-opus-4-7");
      expect(r.tier).toBe("sonnet");
      expect(r.model).toBe("claude-sonnet-4-6");
      expect(r.effort).toBe("medium");
      expect(r.method).toBe("model");
      // (500 in × $1 + 10 out × $5) / 1M
      expect(r.costUsd).toBeCloseTo(0.00055, 8);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
      // Request shape pin: structured outputs, v2 prompt, no thinking key.
      const req = mockParse.mock.calls[0]![0];
      expect(req.model).toBe("claude-haiku-4-5-20251001");
      expect(req.max_tokens).toBe(100);
      expect(req.output_config?.format).toBeDefined();
      expect("thinking" in req).toBe(false);
      expect(req.system).toContain("Effort");
      expect(req.system).not.toContain("Respond with ONLY a JSON object");
      expect(req.system).not.toContain("Scheduled/cron");
    });

    it("ceiling cap (opus→sonnet) preserves effort", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "opus", effort: "high" }));
      const r = await routeModel("complex judgment call", "claude-sonnet-4-6");
      expect(r.tier).toBe("sonnet");
      expect(r.effort).toBe("high");
      expect(r.method).toBe("model");
    });

    it("drops effort when the final tier is haiku (haiku rejects the param)", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "haiku", effort: "low" }));
      const r = await routeModel("quick status check please", "claude-opus-4-7");
      expect(r.tier).toBe("haiku");
      expect(r.method).toBe("model");
      expect("effort" in r).toBe(false);
    });

    it.each([
      ["refusal stop", makeParseResponse(null, { stop_reason: "refusal" })],
      ["null parsed_output", makeParseResponse(null)],
      ["max_tokens stop", makeParseResponse({ tier: "sonnet", effort: "low" }, { stop_reason: "max_tokens" })],
    ])("%s → sonnet fallback, method fallback, no effort", async (_label, resp) => {
      mockParse.mockResolvedValueOnce(resp);
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", model: "claude-sonnet-4-6", costUsd: 0, method: "fallback" });
      expect("effort" in r).toBe(false);
    });

    it("thrown API error (timeout/429/5xx/404) → sonnet fallback", async () => {
      mockParse.mockRejectedValueOnce(new Error("408 request timed out"));
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", costUsd: 0, durationMs: 0, method: "fallback" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });
  });

  describe("no-key mode", () => {
    beforeEach(() => {
      mockConfig.anthropic.apiKey = "";
      __resetRouterClientForTests();
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
      expect(mockAnthropicCtor).not.toHaveBeenCalled();
      expect(mockParse).not.toHaveBeenCalled();
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
npx vitest run src/agents/model-router.test.ts
```
Expected: green — the pre-existing `resolveResourceLimits` tests AND all new tests.

- [ ] **Commit:** `KPR-312: W3.3 T2 — classifier v2 unit tests: heuristics, model path, fallbacks, no-key mode`

---

## Task 3 — Effort delivery channel (source): `effortOverride` → `TurnRequest.effort` → `Options.effort`

**Goal:** spec §3.4 — the parallel channel beside the route, mirroring the `modelOverride` precedent. Route object, clamp, gate, breaker wrap: untouched. All four files land together (the adapter forward needs both the types field and the runner param).

- [ ] **`src/agents/provider-adapters/types.ts`** — add to `AgentProviderTurnRequest` after `systemPromptOverride?: string;`:

```ts
  /**
   * KPR-312: per-turn reasoning effort from the model router's complexity
   * classifier — a parallel channel beside the route (the route carries no
   * effort). Claude adapter forwards it to runner.send → SDK Options.effort;
   * pilots ignore it (same tested precedent as modelOverride/resourceLimits),
   * and under the KPR-311 pilot gate they never receive one.
   */
  effort?: ReasoningEffort;
```

(`ReasoningEffort` is defined in this same file post-311 — no import change.)

- [ ] **`src/agents/provider-adapters/claude-agent-adapter.ts`** — old:

```ts
      request.systemPromptOverride,
    );
```

New:

```ts
      request.systemPromptOverride,
      request.effort,
    );
```

- [ ] **`src/agents/agent-runner.ts`** — three edits:

1. Add a type-only import below the existing imports (type-only ⇒ erased ⇒ no runtime cycle with `types.ts`'s type-only imports from this module):

```ts
import type { ReasoningEffort } from "./provider-adapters/types.js";
```

2. `send` signature — old:

```ts
  async send(prompt: string, sessionId?: string, onStream?: StreamCallback, context?: WorkItemContext, modelOverride?: string, resourceLimits?: ResourceLimits, systemPromptOverride?: string): Promise<RunResult> {
```

New:

```ts
  async send(prompt: string, sessionId?: string, onStream?: StreamCallback, context?: WorkItemContext, modelOverride?: string, resourceLimits?: ResourceLimits, systemPromptOverride?: string, effort?: ReasoningEffort): Promise<RunResult> {
```

3. Options mapping — old (inside the `query()` options object):

```ts
        maxTurns: resourceLimits?.maxTurns ?? this.agentConfig.maxTurns,
        maxBudgetUsd: resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,
```

New:

```ts
        maxTurns: resourceLimits?.maxTurns ?? this.agentConfig.maxTurns,
        maxBudgetUsd: resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,
        // KPR-312: per-turn reasoning effort from the complexity classifier.
        // ReasoningEffort and the SDK's EffortLevel overlap but neither is a
        // superset (ReasoningEffort has minimal/none/xhigh; EffortLevel has
        // max) — only the shared {low, medium, high} subset is deliverable
        // (routeModel emits nothing else; the narrowing also satisfies the
        // SDK's EffortLevel type). Deliberately NO `thinking` key: toggling
        // thinking config turn-to-turn invalidates the messages-tier prompt
        // cache — the exact cost class KPR-312 avoids.
        ...(effort === "low" || effort === "medium" || effort === "high" ? { effort } : {}),
```

- [ ] **`src/agents/agent-manager.ts`** — five edits:

1. Extend the types import — old (kpr-305:33, untouched by 311 — `AgentProviderId` is consumed by `providerFor()` and MUST be kept):

```ts
import type { AgentProviderAdapter, AgentProviderId } from "./provider-adapters/types.js";
```

New:

```ts
import type { AgentProviderAdapter, AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";
```

2. `SpawnShaping` — insert after the `routerTier: ModelTier | undefined;` field (keep 311's surrounding JSDoc intact):

```ts
  /**
   * KPR-312: per-turn reasoning effort for the Claude turn — carried BESIDE
   * the route, never in it (the claude ProviderModelRoute variant has no
   * effort field; clamp and pilot gate untouched). Set only by the router
   * merge branch; undefined on voice/skip/clamp/failure paths and for pilots.
   */
  effortOverride: ReasoningEffort | undefined;
```

(The field is required-`| undefined`, matching 311's style — the typechecker then forces every return site below, which is the point.)

3. `prepareSpawn` return sites — four mechanical fills plus the merge:
   - The three degenerate returns (voice carve-out, router-gate skip, catch) — each currently ends `resourceLimits: undefined, routerCostUsd: 0 };` → each becomes `resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };`
   - The clamp return — currently ends `resourceLimits: result.resourceLimits, routerCostUsd: result.costUsd };` → becomes `resourceLimits: result.resourceLimits, routerCostUsd: result.costUsd, effortOverride: undefined };` (clamp drops model + effort; limits/cost/tier retained — 311 D3 unchanged)
   - The merge return — old:

```ts
      return {
        prompt,
        route,
        modelOverride: result.model !== agentConfig.model ? result.model : undefined,
        routerTier: result.tier,
        resourceLimits: result.resourceLimits,
        routerCostUsd: result.costUsd,
      };
```

New:

```ts
      return {
        prompt,
        route,
        modelOverride: result.model !== agentConfig.model ? result.model : undefined,
        routerTier: result.tier,
        resourceLimits: result.resourceLimits,
        routerCostUsd: result.costUsd,
        // KPR-312: emission rules live inside routeModel (model-path only,
        // {low,medium,high}, dropped post-cap for haiku) — trust the field.
        effortOverride: result.effort,
      };
```

   Also update 311's merge comment above the `const route: ProviderModelRoute = ...` line — old (the amended-at-spec-gate wording):

```ts
      // Effective route. The claude ProviderModelRoute variant carries NO
      // reasoningEffort field — effort is never merged into the route; W3.3
      // (KPR-312) carries it beside the route via SpawnShaping.effortOverride
      // (spec §7). [amended at KPR-312 spec gate (driver reconciliation)]
```

New:

```ts
      // Effective route. The claude ProviderModelRoute variant carries NO
      // reasoningEffort field — effort is never merged into the route; it is
      // carried beside it (KPR-312): SpawnShaping.effortOverride →
      // AgentProviderTurnRequest.effort → SDK Options.effort.
```

4. Router call site — old:

```ts
      const result = await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers);
```

New:

```ts
      const result = await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers, {
        // H3 guard (KPR-312): file-bearing messages must not short-circuit on
        // empty text — file content is appended into `prompt` above and never
        // reaches the classifier.
        hasFiles: Boolean(item.files?.length),
      });
```

5. `runOneSpawnAttempt` `runTurn` call — old:

```ts
      systemPromptOverride: ctx.systemPromptOverride,
    });
```

New:

```ts
      systemPromptOverride: ctx.systemPromptOverride,
      effort: shaping.effortOverride,
    });
```

**Touch nothing else** — `acquire()` stays the first statement, both `record()` sites stay, the retry reuses `shaping` (same effort, no re-route — R7/311).

- [ ] Verify (existing suites must pass unmodified — every change is additive-optional at the pinned surfaces):

```bash
npm run typecheck
npx vitest run src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts src/agents/provider-adapters/ src/agents/model-router.test.ts
```
Expected: green. The `runner.send` 7-arg pins still pass (arg 8 is simply beyond their destructuring); pilot `runTurn` `objectContaining` pins tolerate the added `effort: undefined` key. If `claude-agent-adapter.test.ts`'s strict `toHaveBeenCalledWith` fails on the missing 8th arg, that is expected only if the pin uses exact-arity matching — in that case fold the Task 4 adapter-test update into this task's verify (do not weaken the pin).

- [ ] **Commit:** `KPR-312: W3.3 T3 — effort delivery channel: SpawnShaping.effortOverride → TurnRequest.effort → SDK Options.effort`

---

## Task 4 — Effort channel tests (spec tests 3–4)

- [ ] **`src/agents/provider-adapters/claude-agent-adapter.test.ts`** — update the delegation test for the 8th arg. In the first test, add `effort: "low",` to the `runTurn({...})` request (after `systemPromptOverride: "voice prompt",`) and add `"low",` as the 8th expected argument in the `toHaveBeenCalledWith(...)` (after `"voice prompt",`).

- [ ] **`src/agents/agent-manager.test.ts`** — three edits inside the `router→adapter seam (KPR-311)` describe:

1. **Amend 311's test 1a** (anchor: title `"merges the routed model into the effective route without merging a router-set effort into the route"`) — full replacement:

```ts
      it("merges the routed model into the effective route and delivers router effort beside it (KPR-312)", async () => {
        (appConfig as any).modelRouter.enabled = true;
        // The route object still carries no effort (the claude variant has no
        // such field); the value travels BESIDE it via SpawnShaping.effortOverride
        // → runner.send position 7 (KPR-312).
        vi.mocked(routeModel).mockResolvedValueOnce(
          makeRouterResult({
            provider: "claude",
            tier: "sonnet",
            model: "claude-sonnet-4-6-routed",
            effort: "high",
          }),
        );

        const item = makeWorkItem({ text: "route me", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));

        expect(routeModel).toHaveBeenCalledTimes(1);
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
        const [, , , , modelOverride, resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        expect(modelOverride).toBe("claude-sonnet-4-6-routed");
        expect(resourceLimits).toEqual({ timeoutMs: 60_000, maxTurns: 25, budgetUsd: 1 });
        expect(effort).toBe("high");
      });
```

2. **Append one assertion to 311's provider-clamp test** (anchor: title `"provider clamp: a router result naming a different provider is ignored — static route, warn, cost+tier+limits retained"`), after the `expect(resourceLimits).toEqual(...)` line:

```ts
        // KPR-312: the clamp drops effort along with the model.
        expect(mockRunnerSend.mock.calls[0]![7]).toBeUndefined();
```

3. **New nested describe** appended inside the same `router→adapter seam (KPR-311)` block:

```ts
      describe("effort delivery channel (KPR-312)", () => {
        it("threads hasFiles into routeModel's 4th arg", async () => {
          (appConfig as any).modelRouter.enabled = true;
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult());

          const noFiles = makeWorkItem({ text: "no files", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn(makeCtx(noFiles, "sms"));
          expect(vi.mocked(routeModel).mock.calls[0]![3]).toEqual({ hasFiles: false });

          const withFiles = makeWorkItem({
            text: "",
            source: { kind: "sms", id: "line-1", label: "May" },
            files: [{ name: "doc.txt", url: "https://example.com/doc.txt" } as any],
          });
          await manager.spawnTurn({ ...makeCtx(withFiles, "sms"), threadId: "sms:line-1:files" });
          expect(vi.mocked(routeModel).mock.calls[1]![3]).toEqual({ hasFiles: true });
        });

        it("router-off and system-sender paths deliver no effort", async () => {
          (appConfig as any).modelRouter.enabled = false;
          const off = makeWorkItem({ text: "plain", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn(makeCtx(off, "sms"));
          expect(mockRunnerSend.mock.calls[0]![7]).toBeUndefined();

          (appConfig as any).modelRouter.enabled = true;
          const sys = makeWorkItem({
            text: "execute your scheduled digest task",
            sender: "system",
            source: { kind: "sms", id: "line-1", label: "May" },
          });
          await manager.spawnTurn({ ...makeCtx(sys, "sms"), threadId: "sms:line-1:sys" });
          expect(routeModel).not.toHaveBeenCalled();
          expect(mockRunnerSend.mock.calls[1]![7]).toBeUndefined();
        });

        it("voice path delivers no effort (carve-out — router never runs)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "high" }));
          // Mirror the existing voice carve-out test's ctx/item construction (rule 1).
          const item = makeWorkItem({ text: "voice turn", source: { kind: "ws", id: "voice-1", label: "voice" } });
          await manager.spawnTurn({ ...makeCtx(item, "voice"), threadId: "voice:1" });
          expect(routeModel).not.toHaveBeenCalled();
          expect(mockRunnerSend.mock.calls[0]![7]).toBeUndefined();
        });

        it("delivers effort even when the routed model equals the agent model (no override — spec §7 edge row)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          const agentModel = registry._agents.get("agent-a")!.model; // the harness's default Claude agent
          vi.mocked(routeModel).mockResolvedValueOnce(
            makeRouterResult({ tier: "sonnet", model: agentModel, effort: "low" }),
          );

          const item = makeWorkItem({ text: "same model", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn(makeCtx(item, "sms"));

          const [, , , , modelOverride, , , effort] = mockRunnerSend.mock.calls[0]!;
          expect(modelOverride).toBeUndefined(); // unchanged rule: no override when router picks the agent model
          expect(effort).toBe("low"); // effort works with or without a model switch
        });

        it("pilot runTurn request carries effort: undefined (gate: router never ran)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "high" }));
          registry._agents.set(
            "codex-pilot",
            makeAgentConfig({
              id: "codex-pilot",
              name: "Codex Pilot",
              model: "codex/gpt-5.5:medium",
              coreServers: [],
              soul: "",
              systemPrompt: "pilot system",
            }),
          );

          const item = makeWorkItem({ text: "hello codex", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

          expect(routeModel).not.toHaveBeenCalled();
          const req = mockCodexRunTurn.mock.calls[0]![0];
          expect(req.effort).toBeUndefined();
        });
      });
```

(Adapt `makeCtx`/`makeWorkItem`/`afterEach` router-disable usage to the describe's landed 311 shape — rule 1; the `afterEach` resetting `modelRouter.enabled` already exists in this block per 311 T3.)

- [ ] **`src/agents/agent-runner.test.ts`** — new top-level describe (mirror the setup of the `AgentRunner resource limits override (via send)` describe — same `beforeEach` reset pattern, reuse `makeRunner`/`getCapturedOptions`):

```ts
describe("AgentRunner effort option (KPR-312, via send)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  it("maps effort into query options and never sets thinking", async () => {
    const runner = makeRunner();
    await runner.send("hi", undefined, undefined, undefined, undefined, undefined, undefined, "low");
    const opts = getCapturedOptions();
    expect(opts.effort).toBe("low");
    expect("thinking" in opts).toBe(false);
  });

  it("omits the effort key entirely when no effort is passed", async () => {
    const runner = makeRunner();
    await runner.send("hi");
    const opts = getCapturedOptions();
    expect("effort" in opts).toBe(false);
    expect("thinking" in opts).toBe(false);
  });

  it("drops values outside the SDK-deliverable subset (defensive)", async () => {
    const runner = makeRunner();
    await runner.send("hi", undefined, undefined, undefined, undefined, undefined, undefined, "xhigh" as never);
    expect("effort" in getCapturedOptions()).toBe(false);
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts src/agents/provider-adapters/claude-agent-adapter.test.ts
```
Expected: green, including all pre-existing 311/W2 describes.

- [ ] **Commit:** `KPR-312: W3.3 T4 — effort channel tests: manager threading, adapter 8-arg, runner options mapping`

---

## Task 5 — Verdict riders: `bad-model` fault kind + runner `is_error` guard (spec tests 5–6)

**Goal:** KPR-310 verdict follow-through (spec §6). Additive under R3 — frozen exports untouched, existing rows untouched, new row LAST.

- [ ] **`src/agents/provider-adapters/error-classification.ts`** — three additive edits:

1. Union — old:

```ts
  | "server-error" // 5xx / overloaded / service unavailable
  | "non-provider"; // everything else — NEVER trips the breaker
```

New:

```ts
  | "server-error" // 5xx / overloaded / service unavailable
  | "bad-model" // rejected/unknown model id (KPR-312, M8) — config fault, NEVER trips the breaker
  | "non-provider"; // everything else — NEVER trips the breaker
```

2. `HARD_FAULT_KINDS` JSDoc — old:

```ts
/** Every kind that counts toward the trip streak — all except non-provider. */
```

New:

```ts
/** Every kind that counts toward the trip streak — all except non-provider
 * and bad-model (a rejected model id is operator config error, not provider
 * unhealth — KPR-312, same reasoning as the non-provider bucketing, now
 * countable instead of invisible). */
```

(The set's membership itself is **unchanged**.)

3. `FAULT_PATTERNS` — append a new row **after** the `server-error` row (last position: the table is first-match-wins, so appending after every existing row makes existing-row precedence provably unchanged):

```ts
  [
    // KPR-312 (KPR-310 M8): "There's an issue with the selected model
    // (claude-nonexistent-9). It may not exist or you may not have access to
    // it." — the SDK's rejected-model surface. LAST row by design; the M8
    // string matches no earlier row (verified at delivery, Task 0).
    "bad-model",
    /issue with the selected model|may not exist or you may not have access/i,
  ],
```

(The row's element type `Exclude<ProviderFaultKind, "non-provider" | "timeout">` admits `"bad-model"` automatically once the union gains it.)

- [ ] **`src/agents/agent-runner.ts`** — the `is_error` guard. Old (inside the `msg.type === "result"` handling):

```ts
          if (result.subtype === "success") {
            resultText = result.result || resultText;
          } else {
```

New:

```ts
          if (result.subtype === "success") {
            if (result.is_error === true) {
              // KPR-312 (KPR-310 M8): the SDK can emit subtype "success" with
              // is_error: true and the error text in `result` (observed for a
              // rejected model id). Adopting that text as the reply mis-reads
              // the turn — classify it as an error. In M8 a subsequent SDK
              // throw rescued the turn anyway; this guard keeps classification
              // correct even if a future SDK version stops throwing.
              error = result.result || "unknown error (is_error result)";
            } else {
              resultText = result.result || resultText;
            }
          } else {
```

(`is_error: boolean` is typed on `SDKResultSuccess` — no cast.)

- [ ] **`src/agents/provider-adapters/error-classification.test.ts`** — append (existing describes untouched):

```ts
describe("bad-model (KPR-312 — KPR-310 verdict anomaly 1, M8)", () => {
  // Pinned VERBATIM, character-for-character, so pattern drift against the
  // observed SDK surface is caught (spec §6).
  const M8_ERROR =
    "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.";

  it("classifies the verbatim M8 string via classifyTurnResult", () => {
    expect(classifyTurnResult({ error: M8_ERROR })).toEqual({
      outcome: "fault",
      kind: "bad-model",
      message: M8_ERROR,
    });
  });

  it("classifies the verbatim M8 string via classifyThrown (the path M8 actually took)", () => {
    expect(classifyThrown(new Error(M8_ERROR))).toMatchObject({ kind: "bad-model" });
  });

  it("classifies the FULL observed M8 throw shape (SDK wrapper prefix + M8 text)", () => {
    // The observed throw wraps the M8 text — classifyThrown String()s it into
    // "Error: Claude Code returned an error result: <M8 text>"; the row must
    // match inside that envelope, not only the bare substring.
    expect(
      classifyThrown(new Error(`Claude Code returned an error result: ${M8_ERROR}`)),
    ).toMatchObject({ kind: "bad-model" });
  });

  it("matches each alternate independently", () => {
    expect(faultKind("issue with the selected model")).toBe("bad-model");
    expect(faultKind("It may not exist or you may not have access to it")).toBe("bad-model");
  });

  it("is never breaker-eligible", () => {
    expect(HARD_FAULT_KINDS.has("bad-model")).toBe(false);
  });

  it("is the LAST row — earlier rows keep precedence on overlapping strings", () => {
    // A string matching both server-error and bad-model classifies server-error
    // (first match wins), proving the appended row cannot re-bucket old inputs.
    expect(faultKind("503 issue with the selected model")).toBe("server-error");
  });
});
```

- [ ] **`src/agents/provider-adapters/error-classification.test.ts`** — title-only touch-up: the existing `describe("HARD_FAULT_KINDS")` pin's `it` title reads "…every kind except non-provider", which becomes stale once the union gains `bad-model`. Rename the **title only** to end "…except non-provider and bad-model" — the assertions (sorted-membership equality + `has("non-provider") === false`) stay byte-identical per R3; the `has("bad-model") === false` assertion lives in the new describe above.

- [ ] **`src/agents/agent-runner.test.ts`** — append:

```ts
describe("AgentRunner is_error result guard (KPR-312, via send)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  it("treats subtype success + is_error true as an error, not a response (M8 shape)", async () => {
    const M8_ERROR =
      "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.";
    mockMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: M8_ERROR,
        total_cost_usd: 0.0001,
        duration_ms: 50,
        session_id: "s-m8",
      },
    ];
    const runner = makeRunner();
    const result = await runner.send("hello");
    expect(result.error).toBe(M8_ERROR);
    expect(result.text).toBe(""); // error text NOT adopted as the reply
  });

  it("still adopts result text when is_error is false", async () => {
    mockMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "fine",
        total_cost_usd: 0.001,
        duration_ms: 10,
        session_id: "s-ok",
      },
    ];
    const runner = makeRunner();
    const result = await runner.send("hello");
    expect(result.text).toBe("fine");
    expect(result.error).toBeUndefined();
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/agents/provider-adapters/error-classification.test.ts src/agents/agent-runner.test.ts
```
Expected: green, including every pre-existing per-alternate row pin.

- [ ] **Negative-verify (mutations — repo convention for bug-fix-shaped tests; do not commit either mutation):**
  1. Comment out the new `bad-model` row in `FAULT_PATTERNS`, run the error-classification suite → EXPECT the three M8/alternate tests to fail (classified `non-provider`); restore, re-run, green.
  2. In `agent-runner.ts`, change the guard condition `result.is_error === true` to `false`, run the runner suite → EXPECT the M8-shape test to fail (`result.text` adopts the error string, `result.error` undefined); restore, re-run, green.

- [ ] **Commit:** `KPR-312: W3.3 T5 — verdict riders: bad-model fault kind (last-row, breaker-neutral) + runner is_error guard`

---

## Task 6 — Doctor visibility: classifier-mode line (spec test 8)

**Goal:** one **informational, never-failing** line (spec §3.5). The doctor deliberately surfaces nothing about `ANTHROPIC_API_KEY` today (`requiredEnvVarsFromConfig` excludes optional-with-fallback keys — spec #157); that derivation is untouched.

- [ ] **`src/cli/doctor-checks.ts`** — append the pure helper (after `requiredEnvVarsFromConfig`):

```ts
/**
 * KPR-312: one informational line for `hive doctor` — which mode the model
 * router's complexity classifier runs in. Key-less (subscription-auth)
 * instances run heuristics-only: a deliberate steady state, never a failing
 * check (spec #157: ANTHROPIC_API_KEY is optional-with-fallback and must not
 * false-positive). Pure string producer — no failure channel by construction.
 */
export function modelRouterModeLine(apiKeyPresent: boolean): string {
  return apiKeyPresent
    ? "model router: LLM classification"
    : "model router: heuristics-only (no ANTHROPIC_API_KEY)";
}
```

- [ ] **`src/cli/doctor.ts`** — two edits:

1. Extend the existing import from `./doctor-checks.js` with `modelRouterModeLine`.
2. In the config-loaded post-check block, after the `renderMemoryLifecycleSection(memoryRows, ...)` call (placement: last informational section — the KPR-296 identity-first ordering comment stays true), add:

```ts
    // KPR-312: model-router classifier mode — informational only, never
    // contributes to allPassed. ANTHROPIC_API_KEY resolves env→Keychain via
    // config.ts optional(); presence ⇔ LLM classification path.
    console.log(`\n${modelRouterModeLine(Boolean(config.anthropic.apiKey))}`);
```

And in the `else` (config-not-loaded) branch, after the memory-lifecycle skipped line:

```ts
    console.log("\nmodel router: skipped (config not loaded)");
```

- [ ] **`src/cli/doctor-checks.test.ts`** — extend the first import from `./doctor-checks.js` with `modelRouterModeLine` and append:

```ts
describe("modelRouterModeLine (KPR-312)", () => {
  it("reports LLM classification when a key resolves", () => {
    expect(modelRouterModeLine(true)).toBe("model router: LLM classification");
  });

  it("reports heuristics-only when no key resolves", () => {
    expect(modelRouterModeLine(false)).toBe("model router: heuristics-only (no ANTHROPIC_API_KEY)");
  });

  it("is informational by construction — both modes yield a printable line, no failure channel", () => {
    // The doctor wiring only console.logs this string; it never touches
    // allPassed (structural — the helper cannot return a failure signal).
    for (const mode of [true, false]) {
      expect(modelRouterModeLine(mode).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/cli/doctor-checks.test.ts src/cli/doctor.test.ts
npm run typecheck
```
Expected: green (doctor.test.ts is regression surface — the new line must not break any output-shape pins; if a doctor.test.ts pin asserts full output ordering, extend the expected output rather than moving the line).

- [ ] **Commit:** `KPR-312: W3.3 T6 — hive doctor informational line: model-router classifier mode`

---

## Task 7 — Optional rider: curated-registry entry for `ANTHROPIC_API_KEY` (spec ⚠10 — droppable)

**Droppable under scope pressure** — if review rounds or gate pressure make this contentious, delete the task and note the drop in the hand-off.

- [ ] **`src/setup/credential-registry.ts`** — append to `CREDENTIAL_REGISTRY`:

```ts
  {
    server: "model-router",
    title: "Anthropic API",
    description:
      "Direct Anthropic API key — powers the model router's LLM complexity classifier (KPR-312). Key-less instances run heuristics-only routing.",
    helpUrl: "https://console.anthropic.com/settings/keys",
    kind: "secret",
    fields: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" }],
  },
```

(`config.ts` already resolves `ANTHROPIC_API_KEY` env→Keychain via `optional()` — Honeypot `hive/<id>/ANTHROPIC_API_KEY` — so this is registry-listing only; no engine wiring.)

- [ ] Verify:

```bash
npx vitest run src/cli/credentials.test.ts
grep -rn "CREDENTIAL_REGISTRY" src --include="*.test.ts"
```
Expected: green. If any test enumerates registry entries/keys, **extend** the expectation with the new entry (never delete existing pins).

- [ ] **Commit:** `KPR-312: W3.3 T7 — curated credentials registry entry for ANTHROPIC_API_KEY`

---

## Task 8 — GATED: manual live-turn effort verification (spec ⚠3/⚠4, test 7)

**This is a delivery gate.** The KPR-310 spike never exercised the SDK `effort` option (M9 tested `thinking: adaptive` only). One live check confirms `effort: "low"` is accepted and alters spend on `claude-sonnet-4-6` **via the CLI path** (`query()` — the exact option the runner now sets). Runs on any dev machine with working Claude Code auth (subscription auth is fine — this exercises the turn-side option, not the classifier key).

- [ ] Write the throwaway script (scratchpad/tmp — **not committed**), e.g. `/tmp/kpr312-verify-effort.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function run(label: string, effort?: "low") {
  const q = query({
    prompt: "Explain in a few sentences why the sky is blue.",
    options: {
      model: "claude-sonnet-4-6",
      maxTurns: 1,
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
      ...(effort ? { effort } : {}),
    },
  });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "result") {
      console.log(label, JSON.stringify({
        subtype: m.subtype,
        is_error: m.is_error,
        cost_usd: m.total_cost_usd,
        output_tokens: m.usage?.output_tokens,
      }));
    }
  }
}

await run("control(no-effort)");
await run("effort=low", "low");
```

- [ ] Run from the repo root (needs the installed deps):

```bash
npx tsx /tmp/kpr312-verify-effort.ts
```

- [ ] **Evidence to record** (paste all output lines into the ticket/PR body as the ⚠4 verification record):
  1. **Acceptance:** the `effort=low` run completes with `subtype: "success"` and `is_error: false` — no 400/invalid-option error mentioning `effort`.
  2. **Spend delta (must be MEANINGFUL, not merely ≤):** the `effort=low` run's `output_tokens` / `cost_usd` is meaningfully **below** the control's — equal-or-near-equal spend is NOT a pass; a silently-ignored option produces exactly that signature, which is the failure this gate exists to detect. Record all numbers verbatim.
  3. **Inconclusive branch:** if one pair shows no meaningful delta, repeat the pair (run the script 2–3 times — per-run variance is real; judge the pattern across pairs, not one sample). A **persistent** no-delta across pairs = the option is being accepted-but-ignored → treat as **gate failed**, same handling as outright rejection below.
- [ ] Optional secondary (only if a dev instance has `ANTHROPIC_API_KEY` seeded): send one routed sonnet-tier Slack message and confirm the engine log shows `Model router decision` with an `effort` field and the turn completes without error.
- [ ] **If the effort option is rejected OR persistently ignored (no delta across repeated pairs):** **STOP — do not proceed to Task 9.** Demote to the spec lane with the exact outputs; the effort-delivery half of the ticket needs a spec-level decision (the classifier half is independent and stands).

**Commit:** none (evidence recorded in ticket/PR, script is throwaway).

---

## Task 9 — Full gate

- [ ] Run the complete check from the worktree root:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck, ESLint, Prettier, and the full Vitest suite all pass. (Worktree/CI quality-gate asymmetry: confirm the output actually lists all four gates running — a pass that self-disabled on a `.claude/worktrees/` ignore fragment is not a pass.)

- [ ] If Prettier reformats any touched file, apply (`npm run format`) and commit.
- [ ] **Commit** (only if format/lint produced changes): `KPR-312: W3.3 T9 — format/lint pass`

Done — hand off to dodi-dev:review with the Task 8 evidence attached. No Linear writes, no PR from this plan (the lane's submit skill owns that).

---

## Assumptions

1. **Double delivery gate**: this plan executes after the W2 epic merge AND after KPR-311's child PR lands on the epic branch; Task 0 verifies both by content and hard-stops (demote to spec lane) on drift. All ⚠1–⚠10 spec assumptions are settled — implemented here without re-litigation.
2. **File layout — classifier stays in `model-router.ts`** (spec delegated): the classifier is the router's body; its constants (`TIER_MODELS`, `TIER_RANK`, fallback shapes) have no other consumer, and KPR-314 already names this file as its pricing/model-metadata rebase surface. No new module.
3. **Client test seam**: module-level lazy singleton (knowledge-extractor's `new Anthropic()` precedent, adapted for a free function) + exported `__resetRouterClientForTests()` (mirrors `__resetRegistryForTests` in `archetypes/registry.ts`); tests module-mock `@anthropic-ai/sdk`'s default export. Chosen over constructor/parameter injection — `routeModel` has no constructor, and a params-object client would leak test plumbing into the 311-shaped call site.
4. **Effort narrowing at the runner boundary**: `ReasoningEffort` and SDK `EffortLevel` overlap but neither is a superset of the other (`minimal`/`none`/`xhigh` vs `max`) — `send` accepts `ReasoningEffort` and delivers only the shared `{low, medium, high}` subset (per the spec) via a literal guard (routeModel emits nothing else; the guard doubles as the TS narrowing and a belt-and-suspenders drop for future emitters).
5. **Doctor placement**: the mode line renders as the last post-check informational output (after memory lifecycle), preserving the KPR-296 identity-first ordering; the testable contract lives in the pure `modelRouterModeLine` helper.
6. **H2 allowlist (17 entries) and the 4000-char truncation bound** are the plan-pinned constants (spec ⚠8); exact-match-only discipline is spec-binding.
7. **Empty-text-with-files classifier input** uses the placeholder `"(attachment-only message, no text)"` — the API rejects empty text blocks; H3's skip means this path is reachable.
8. **`textPreview` dropped** from the router decision log (log-redaction convention — no message text in logs); v1 carried it, v2 does not.
9. **311's test 1a is amended, not preserved**: its "turn byte-identical to a no-effort route" premise is exactly what this ticket delivers; the test flips to a positive delivery pin per the coordinated canon amendment (spec §3.4/§5).
10. **`npm run check` needs the three Slack env stubs** in a fresh worktree — environment quirk, not a product change.
11. **Task 7 registry entry uses `server: "model-router"`** — the registry's `server` field keys wizard grouping, not MCP wiring; droppable under scope pressure (spec ⚠10).
