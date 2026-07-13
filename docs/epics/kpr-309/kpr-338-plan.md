# KPR-338 — Implementation Plan: Fixed-tier agents — remove per-turn tier selection, effort-only classifier

> **For agentic workers:** Use dodi-dev:implement to run this plan.

**Spec:** `docs/epics/kpr-309/kpr-338-spec.md` (approved, fable-reviewed r2 clean — authoritative; the TL;DR/Key Points decisions are settled, do not re-litigate).
**Epic:** KPR-309. Binding register entries: R-311.1/R-311.2 (clamp invariant + pilot gate — this ticket deletes the clamp *branch* by deleting `ModelRouterResult.provider`; the *invariant* survives structurally), R-311.6 (prepareSpawn throw-free vs SIGUSR1), R-312.2 (no-key heuristics-only mode), R-312.3 (effort delivery chain — byte-untouched in meaning; carrier plumbing slims per §3.2), R-312.5 (`method` field), R-313.3 (stale `agent-manager.ts:686` park pointer — swept here, per its own canon note), R-314.2 (`TIER_MODELS`/`TIER_RANK` supersession pre-announced for this ticket), R-314.3 (registry transport contract — keep as-landed, never resurrect `8b1cdaa` shapes).

> **DELIVERY-CONTEXT NOTE (read first):** this plan is written against the epic branch at `53e9021` (**post-KPR-314** — the spec's §2 table was pinned pre-314 at `8b1cdaa`; every [314-sensitive] row has been reconciled against the actual merged post-state, and the code blocks below quote the *post-314* file contents). Edits anchor on unique code strings, never line numbers. **Task 0 re-confirms every anchored surface before any edit** and defines the demote-to-spec escape hatch. KPR-313's session-identity surfaces sit inside `agent-manager.ts` adjacent to our edits — they are **comment-sweep-only** territory here (the `:686` pointer); any behavioral drift into the guard block is a defect.

## Goal

Per-turn model-tier switching is removed from the engine: **a turn's model is always `agentConfig.model` — no engine path overrides it** (spec §1.3 invariant). The complexity classifier survives with exactly one per-turn output, `effort` (`low`/`medium`/`high`), delivered through the untouched KPR-312 channel (`SpawnShaping.effortOverride` → `AgentProviderTurnRequest.effort` → `Options.effort`). Haiku-static agents (and any agent whose static model cannot receive the effort param) skip the classifier call entirely — zero classifier cost/latency for the highest-volume trivial traffic. Resource limits stay path-preserving: tier-derived limits appear exactly where they appear today (the router-on path), sourced from the agent's **static** tier; every path that yields `resourceLimits: undefined` today still does, so the runner's per-agent legacy fallback, the voice/pilot/system carve-outs, and `modelRouter.enabled: false` all keep their meaning. Dead code leaves rather than strands: `SpawnShaping.routerTier`/`modelOverride`, `ModelRouterResult.{tier,model,resourceLimits,provider}`, the ceiling-cap, the clamp branch, `TIER_MODELS`, `TIER_RANK`, and the `modelOverride` plumbing through `AgentProviderTurnRequest`/`ClaudeAgentAdapter`/`runner.send` are all deleted. H2/H3 heuristics keep any-turn scope, now costing only an effort hint on a miss (fixing the live "yes"-on-approved-complex-work hazard: pre-338 that miss ran on a haiku model with a $1 budget). A non-blocking telemetry rider quantifies what the removed downgrade behavior was worth — it informs the record, never gates delivery.

## Architecture — plan-level decisions (spec left these to the plan; decided here, not re-litigated downstream)

- **D1 — Off-catalog static models (coherence note a): warn-once + conservative skip.** `supportsEffort(id)` is catalog-driven and returns `false` for unknown ids, which silently disables effort for an operator-set off-catalog static model. Decision: **warn** (once per model id per process), keep the conservative drop. Rationale: *extend-catalog* cannot enumerate ids that don't exist yet — the realistic failure mode is precisely an operator setting a model id newer than the shipped catalog; *silent-accept* loses a measured 38–47% output-token lever (KPR-312 Task 8) with zero operator signal; *warn-once* matches the registry's established off-catalog posture (R-314.2: off-catalog ⇒ undefined cost + warn-once, never blocks) and gives an actionable signal (update the engine, or fix the model id). Effort stays dropped — never emit a param that might 400 (R-312.3 lineage). Encoded in Task 1.
- **D2 — The classifier-skip condition subsumes the effort gate.** The spec offers gating effort delivery on `supportsEffort(agentConfig.model)` *or* keying the haiku-skip on it (spec §3.1 residual). This plan does both with one condition: prepareSpawn skips the `routeModel` call when `staticTier === "haiku" || !supportsEffort(agentConfig.model)`. When the classifier's only output is undeliverable, calling it is pure waste (~$0.0005 + 0.3–0.5s serial, per turn, forever); skipping guarantees deliverability at the merge, so the merge stays the spec's verbatim `effortOverride: result.effort`. The first disjunct is the spec-prescribed high-volume haiku rule (also catches off-catalog haiku *aliases* by substring, without a D1 warn); the second closes the §3.1 residual (a non-"haiku"-named effort-rejecting id can never 400 a turn) and carries the D1 warn.
- **D3 — `modelOverride` plumbing: delete fully (spec §3.2's preferred branch).** The ripple is mechanical and enumerable: one field (`AgentProviderTurnRequest.modelOverride`), one forwarding arg (`claude-agent-adapter.ts`), one `runner.send` param (sole call site is the adapter; `effectiveModel` collapses to `this.agentConfig.model`), plus positional updates in 6 test files. No always-`undefined` vestige, no hygiene follow-up. The effort channel's *meaning* is untouched (R-312.3); its positional index in `send` shifts 8th → 7th — recorded in the delivery-time R-338.x register entry, not a semantic change.
- **D4 — Audit `modelTier` becomes a static per-agent fact.** Spec §3.2 item 3: audit `modelTier` ← `modelToTier(agentConfig.model)`. Realized as: **every claude-static turn** audits its static tier (router on OR off — tier is no longer a router outcome, so coupling the audit column to the router path would be an artifact); **pilots audit `undefined`** (`modelToTier` is a Claude-id substring heuristic, meaningless on provider-prefixed ids — same reasoning the spec applies to pilot limits). The router-off pin flips undefined→static-tier: rewritten with citation, R-311.7's data feed keeps flowing (now as a static column the Task 8 rider can still join against).
- **D5 — Unusable classifier output maps to `fallback`.** Pre-338 the fallback condition included tier-validity (`TIER_RANK[parsed.tier] === undefined`). Post-338 the analog is effort-validity: `stopReason ∈ {refusal, max_tokens}`, missing `parsed`, or `parsed.effort ∉ {low, medium, high}` ⇒ `{method: "fallback"}` with **no effort key** (a $0 decision doesn't tune a lever it didn't reason about — unchanged principle). Schema enforcement makes the invalid-effort branch near-dead; it is kept as the structural translation of 312's condition.
- **Sequencing inside the ticket (compile-green per commit):** manager first, router second. Task 1 restructures `agent-manager.ts` against the *old* `routeModel` contract (result's tier/model/limits/provider simply ignored) — behavior is fully fixed-tier after Task 1. Task 2 then shrinks the router contract and updates the one call site. This avoids a single mega-commit spanning both files and both test suites; the cost is a small deliberate double-touch in `agent-manager.test.ts` (the `makeRouterResult` helper and the `routeModel` arg pins are updated again in Task 2 — flagged inline).

## Tech Stack

- TypeScript strict, Node 22+, ESM; **no new packages, no config-surface changes** (`modelRouter.enabled` / `MODEL_ROUTER_MODEL` / `MODEL_ROUTER_TIMEOUT_MS` keep their post-314 meanings; no hive.yaml keys added or removed)
- Vitest beside source; suites touched: `model-router.test.ts`, `agent-manager.test.ts`, `agent-runner.test.ts` (positional only), `provider-adapters/*.test.ts` (field-drop only)
- Logging via `createLogger`; log-redaction convention (no message text / input previews in logs)

**Out of scope (do not touch):** the KPR-313 session-identity guard/persist/handoff logic (comment sweep at `:686` only); breaker wrap + `error-classification.ts` (R3/R7); `resolveProviderModel`/`splitProviderModel`; pilot adapters' behavior and turn-request consumption (`resourceLimits`/`maxLlmCalls` reads stay — they keep receiving `undefined`); voice carve-out; dispatcher/channels/outage queue; `src/llm/` transport/catalog/pricing (wording-only edits in Task 4); doctor lines (verified accurate as-is — `modelRouterModeLine` is tier-neutral); `ResourceTierOverrides` type and the `resourceTiers` agent field (still consumed — by static-tier resolution now); H2 allowlist membership; `MAX_CLASSIFIER_INPUT`; reflection/scheduling; KPR-339 escalation (separate ticket); KPR-337 clamp-lift premise notes (Linear-side, driver's).

---

## Testing Contract

### Required Test Groups

**1. Router unit (`src/agents/model-router.test.ts`, Task 2 — rewrite of the 312/314 suite as landed):**
- `resolveResourceLimits` describe **byte-identical** (all 6 existing tests).
- H2 (each of the it.each strings) and H3 → `{effort: "low", method: "heuristic", costUsd: 0, durationMs: 0}`; **key-absence pins**: `"tier" in r === false`, `"model" in r === false`, `"resourceLimits" in r === false`, `"provider" in r === false`; `mockGenerateForTask` never called. H2 exact-match-only pins kept ("fire the sales team" and "thanks, also rewrite the contract" reach the model).
- H1 test **removed-with-citation** (kpr-338-spec §3.1: superseded by prepareSpawn's haiku-skip — pinned in group 2).
- H3-with-files → model path with `"(attachment-only message, no text)"` placeholder; truncation pin (4000 + marker) kept.
- Model path: request-shape pin — task `"routerClassifier"`, `maxOutputTokens: 100`, `timeoutMs: 4000`, `jsonSchema` present with `required: ["effort"]` and **no `tier` property**, `systemPrompt` contains `"Effort"` and does **not** contain `"Tiers:"`, `"haiku"`, `"sonnet"`, or `"opus"` (tier rubric gone), no `model` key (registry owns resolution). Returns `{effort, method: "model"}` with registry `costUsd`/`durationMs` passed through; off-catalog `costUsd: undefined` ⇒ `0`.
- Result-shape pin on the model path: the same four key-absence assertions as H2/H3.
- Fallbacks: refusal / null-`parsed` / `max_tokens` / **invalid `parsed.effort`** (D5) / thrown registry error → `{costUsd: 0, durationMs: 0, method: "fallback"}`, **no effort key**.
- No-key (`mockHasProvider` false): `{costUsd: 0, durationMs: 0, method: "no-key"}`, no effort key, `generateForTask` never called; heuristics still fire in no-key mode (H2 → heuristic).
- `supportsEffort` is **no longer consulted by the router** — assert `mockSupportsEffort` not called on the model path (the gate moved to prepareSpawn, group 2).

**2. Manager (`src/agents/agent-manager.test.ts`, Tasks 1–3):**
- Router-on **sonnet-static** turn: `routeModel` called (Task 1: legacy 4-arg shape; Task 2: exactly `(text, {hasFiles})` — 2 args), `resourceLimits` delivered = `RESOURCE_TIER_DEFAULTS.sonnet` resolved through the agent's `resourceTiers` overrides, effort delivered beside the route, **no model override anywhere** (send's model position is `undefined` in Tasks 1–2 and gone after Task 3).
- **Haiku-skip pin:** router-on haiku-static agent → `routeModel` **never called**, `resourceLimits` = haiku-tier static limits (today's H1 envelope preserved), `effortOverride: undefined`, `routerCostUsd` contribution 0.
- **D1/D2 pin:** router-on claude-static agent whose model `supportsEffort` mocks `false` (non-haiku-named off-catalog id) → `routeModel` never called, static limits still delivered, `log.warn` fired **once across two turns** (warn-once), no effort.
- **Path-preservation pins (spec §4.2):** system-sender, router-off, voice, and pilot paths all deliver `resourceLimits: undefined` (runner legacy fallback observed) and no effort; voice prompt passes raw (existing pin).
- Pilot gate (R-311.2) pins kept: `routeModel` never called for non-claude-static; pilot audits static prefixed model with `modelTier` property-present-and-undefined.
- **Clamp branch test removed-with-citation** (kpr-338-spec §3.2: branch deleted with `ModelRouterResult.provider`); **invariant re-pin** replaces it: on a router-on claude turn with `routeModel` resolving a full result, the Claude adapter runs (no pilot constructor), telemetry + audit `model` = the agent's static model, and send receives no model value — "shaped route ≡ static route on every path".
- **D4 pins:** audit `modelTier` = static tier on router-on AND router-off claude turns (router-off flips undefined→tier — rewritten with citation); pilot `modelTier` undefined.
- Effort channel: sonnet-static router-on turn delivers `effort` at send's effort position; auth-rebuild retry re-uses the shaping (routeModel once, same effort/limits both attempts); router cost still added to `TurnResult.usage.costUsd`.
- **Vanished-agent throw-safety (R-311.6):** existing SIGUSR1-removal-race test stays green — the static-tier/limits derivation must not add a throw surface (guarded `agentConfig?.model ?? ""` + derivation gated behind the `!agentConfig` early return).
- KPR-306 breaker describes, KPR-313 guard/persist describes, KPR-220 coordinator describes: **untouched and green** (any failure = leakage across R3/R7/313 surfaces).

**3. Plumbing deletion (Task 3):** `claude-agent-adapter.test.ts` pins the new 7-arg forwarding; `agent-runner.test.ts` resource-limits/effort describes pass with shifted positions (assertion meanings identical); pilot adapter suites drop `modelOverride` request keys (codex's "ignores Claude router modelOverride values" test removed-with-citation — the field no longer exists to ignore); `tsc` proves no `modelOverride` reference survives outside git history.

### Negative-verifies (repo convention: mutate source, observe the pinned test fail, restore, re-run green; never committed — record command + failing test name as evidence)
- **NV-a (haiku-skip, spec §4.4a):** in `prepareSpawn`, disable the skip condition (prefix with `false &&`). EXPECT: the "haiku-static agent never calls routeModel" pin fails (routeModel called). Restore, green.
- **NV-b (static-sourced limits, spec §4.4b — run during Task 1 while the legacy result shape still carries limits):** in the merge branch, replace `resourceLimits: staticLimits` with `result.resourceLimits`. EXPECT: the static-limits pin fails. Restore, green. (Post-Task 2 this mutation is a type error — the field is gone; that is itself the structural guarantee.)
- **NV-c (path preservation, spec §4.4c):** in the router-gate skip return, deliver computed static limits instead of `undefined`. EXPECT: the system-sender path-preservation pin fails. Restore, green.
- **NV-d (effort-capability gate, D1/D2):** drop the `!supportsEffort(...)` disjunct from the skip condition. EXPECT: the off-catalog warn-once/skip pin fails. Restore, green.

### Critical Flows
1. Sonnet/opus routed turn: heuristic miss → one `generateForTask("routerClassifier", ...)` → `{effort}` → `effortOverride` → `Options.effort`; model = static; limits = static tier; telemetry/audit model = static; audit modelTier = static tier.
2. Haiku-static turn (Rae/Milo class): zero classifier calls, haiku-tier limits, no effort — same envelope H1 produced, minus the router invocation.
3. Mid-thread `"yes"` on an opus agent (the §1.2(3) hazard): H2 fires → `effort: "low"` on the **opus** model with **opus** limits — approved complex work no longer lands on a $1-budget haiku turn.
4. Router-off / system-sender / voice / pilot turns: `resourceLimits: undefined` (runner falls back to per-agent legacy config), no effort, no classifier call.
5. No-key boot: heuristics-only; boot log + registry log describe the actual post-338 loss (per-turn effort hints); doctor line unchanged and accurate.
6. Off-catalog non-haiku static model: classifier skipped, one warn per model id, static limits still enforced.

### Regression Surface (must stay green)
- `model-router.test.ts` — `resolveResourceLimits` describe byte-identical; H2/H3 membership, truncation bound, no-key/`method` semantics (R-312.2/R-312.5) preserved with the new result shape.
- `agent-manager.test.ts` — KPR-306 breaker-wrap describes, KPR-307 providerFor/timedOut describes, KPR-313 session-identity + persist + churn-mint describes, KPR-220 coordinator/reflection describes: **zero assertion changes**. KPR-311/312 seam describes: assertion meanings preserved except where tier-selection was itself the asserted behavior — those are removed/rewritten **with spec citation in a comment**, never silently weakened.
- `agent-runner.test.ts` — effort-option describe (Options.effort mapping, no `thinking` key, defensive subset drop) and resource-limits fallback describe: same assertions, shifted positions.
- `src/llm/*` suites — untouched by Tasks 1–3; Task 4 touches only a log string and a comment (no test pins exist on either — verified).
- `provider-adapters/*.test.ts` — pilot `resourceLimits`/`maxLlmCalls` consumption pins unchanged.
- `doctor-checks.test.ts` — `modelRouterModeLine` pins unchanged (line verified tier-neutral).

### Commands
```bash
# Targeted (after each task)
npx vitest run src/agents/model-router.test.ts src/agents/agent-manager.test.ts
npx vitest run src/agents/agent-runner.test.ts src/agents/provider-adapters/
npx vitest run src/llm/ src/cli/doctor-checks.test.ts

# Full gate (Task 0 baseline + Task 6; env stubs required by config load in tests)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: all suites pass; `check` = typecheck + lint + format + test, zero failures. (Worktree/CI asymmetry reminder: confirm the output lists all four gates actually running — do not trust a pass that self-disabled on a `.claude/worktrees/` ignore fragment.)

### Harness Requirements
- **`agent-manager.test.ts`:** the `./model-router.js` mock changes from a factory (`{ routeModel: vi.fn() }`) to the spread-original pattern — `vi.mock("./model-router.js", async (importOriginal) => ({ ...(await importOriginal<object>()), routeModel: vi.fn() }))` — because `agent-manager.ts` now imports `modelToTier` and `resolveResourceLimits` as runtime values (real implementations wanted: the static-limits pins assert real resolution math). Add `vi.mock("../llm/registry.js", () => ({ getLLMRegistry: () => ({ supportsEffort: mockSupportsEffort }) }))` with hoisted `mockSupportsEffort` defaulting to the real-catalog shape `(m: string) => !m.includes("haiku")`. Register a sonnet-static fixture agent (`agent-s`, `model: "claude-sonnet-4-6"`) in `makeMockRegistry` — the harness default `claude-haiku-4-5` now *skips* the classifier, so every model-path test must run on `agent-s` (or set a per-test model override via `registry._agents.set`).
- **`model-router.test.ts`:** harness keeps the 314 registry mock (`mockGenerateForTask`/`mockHasProvider`/`mockSupportsEffort` + mutable config + `__resetRouterStateForTests()`); `makeLlmResult` parsed shape becomes `{ effort: string }`.
- Send-position map after Task 3 (for positional pins): `send(prompt, sessionId, onStream, context, resourceLimits, systemPromptOverride, effort)` — resourceLimits index 4, effort index 6.
- No DB, no network, no live SDK anywhere in the unit surface.

### Non-Required Rationale
- **No E2E / live-turn task:** the effort lever's live effect was measured in KPR-312 Task 8 (38–47% output-token reduction, recorded on PR #311 + the ticket); this ticket only changes *when* effort is computed, not how it is delivered. The epic's standing keyed smoke (R-314.8 — owed before the epic PR to main) includes ≥1 real classifier call, which post-338 exercises the effort-only schema against the live API.
- **No dispatcher/channel tests:** no shape any channel consumes changes (`TurnResult`, delivery, outage queue untouched).
- **No config/loader tests:** zero config keys added or removed.

### Verification Rules
1. A missing harness is not a skip reason — if a listed test doesn't exist at a task's Verify step, write it; do not mark the task done without running the listed commands and seeing the expected output.
2. When a test fails, fix the implementation, not the test — unless the test pinned behavior this spec removes (tier selection, model override, clamp branch, H1, router-off audit-tier absence), in which case remove/rewrite **with a spec citation** in the test comment.
3. Spec/plan mismatch demotes to the spec lane: if running this plan surfaces a conflict with `kpr-338-spec.md` (or Task 0 finds anchored-surface drift), stop and route back through dodi-dev:mature-ticket with a drift note — do not improvise in the delivery lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/agents/agent-manager.ts` | modified (T1) | `SpawnShaping` slim-down; prepareSpawn static-tier restructure + haiku/effort-capability skip + D1 warn-once; clamp branch deletion; observability collapse (D4); comment sweeps incl. `:686` → KPR-337 |
| `src/agents/model-router.ts` | modified (T1: export `modelToTier`; T2: contract shrink) | Effort-only `ModelRouterResult` + `routeModel(text, opts?)`; prompt/schema v3; `TIER_MODELS`/`TIER_RANK`/H1/cap/fallback-tier deletion; no-key log reword |
| `src/agents/agent-manager.test.ts` | modified (T1, T2, T3) | Contract group 2; harness mock changes; removed-with-citation entries |
| `src/agents/model-router.test.ts` | modified (T2) | Contract group 1 |
| `src/agents/provider-adapters/types.ts` | modified (T3) | Delete `AgentProviderTurnRequest.modelOverride`; comment refresh |
| `src/agents/provider-adapters/claude-agent-adapter.ts` | modified (T3) | 7-arg forwarding |
| `src/agents/agent-runner.ts` | modified (T3) | `send` drops the model param; `effectiveModel` collapses to static |
| `src/agents/agent-runner.test.ts`, `provider-adapters/*.test.ts` | modified (T3) | Positional/field mechanical sweep; contract group 3 |
| `src/llm/registry.ts` | modified (T4, log string only) | Construction-log parenthetical reword (coherence note b) |
| `src/llm/catalog.ts` | modified (T4, comment only) | Stale `TIER_MODELS` analogy reword |
| `CLAUDE.md`, `docs/architecture.md` | modified (T4) | Router description updates (no more "Haiku/Sonnet classification") |

One commit per task; every task leaves the tree green (`npm run typecheck` + scoped tests).

---

## Task 0 — Re-confirm gates and anchored surfaces at delivery HEAD (mandatory)

**Goal:** prove the delivery worktree carries KPR-314's landed post-state and that every surface this plan edits still matches by content, before any edit.

Operational notes: `grep -c` exits non-zero on zero matches — run expected-0 lines individually and judge by printed count, not exit code (or append `|| true`). The shell's ugrep wrapper mishandles `${var}` inside single-quoted patterns — every anchor below avoids `${`; if any grep behaves oddly, retry with `command grep`. Do not "fix" ignore-file entries mid-delivery.

- [ ] **Gate A — 314 in history:** `git log --oneline | command grep -i "kpr-314" | head` shows the KPR-314 merge (expected: `53e9021` or a descendant); `ls src/llm/registry.ts src/llm/catalog.ts` succeeds. If either fails: **STOP.**
- [ ] **Gate B — 311–313 in history:** `git log --oneline | command grep -iE "kpr-31[123]" | head` shows all three. If absent: **STOP.**
- [ ] **Gate C — 338 not yet applied:** `command grep -rn "KPR-338" src/ | head` → **0 hits**.
- [ ] Re-confirm anchored surfaces:

```bash
cd <worktree>

# 1. model-router.ts — post-314 shape this plan rewrites:
command grep -n 'const TIER_RANK: Record<ModelTier, number>' src/agents/model-router.ts     # 1 hit
command grep -n 'const TIER_MODELS: Record<ModelTier, string>' src/agents/model-router.ts   # 1 hit
command grep -n 'function modelToTier(model: string): ModelTier' src/agents/model-router.ts # 1 hit (unexported today)
command grep -n 'export function __resetRouterStateForTests' src/agents/model-router.ts     # 1 hit (314's rename — keep)
command grep -n 'generateForTask("routerClassifier"' src/agents/model-router.ts             # 1 hit (314 transport — keep)
command grep -n 'required: \["tier", "effort"\]' src/agents/model-router.ts                 # 1 hit (schema to shrink)
command grep -n 'non-obvious turns keep the agent default model' src/agents/model-router.ts # 1 hit (no-key log to reword)
command grep -c 'sonnetFallback' src/agents/model-router.ts                                 # expect 3 (def + 2 calls)
command grep -n 'provider?: AgentProviderId;' src/agents/model-router.ts                    # 1 hit (field to delete)
command grep -n 'supportsEffort(TIER_MODELS\[finalTier\])' src/agents/model-router.ts       # 1 hit (drop check to delete)

# 2. agent-manager.ts — prepareSpawn/SpawnShaping deletion surface:
command grep -n 'interface SpawnShaping' src/agents/agent-manager.ts                        # 1 hit
command grep -n 'modelOverride: string | undefined;' src/agents/agent-manager.ts            # 1 hit
command grep -n 'routerTier: ModelTier | undefined;' src/agents/agent-manager.ts            # 1 hit
command grep -n 'result.provider !== undefined && result.provider !== staticRoute.provider' src/agents/agent-manager.ts  # 1 hit (clamp branch)
command grep -n 'await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers' src/agents/agent-manager.ts   # 1 hit (call site)
command grep -n 'modelOverride: result.model !== agentConfig.model' src/agents/agent-manager.ts  # 1 hit (merge branch)
command grep -n 'modelTier: shaping.routerTier' src/agents/agent-manager.ts                 # 1 hit (audit read-site)
command grep -c 'shaping.modelOverride ?? this.registry.get(ctx.agentId)?.model' src/agents/agent-manager.ts  # expect 2 (telemetry + audit)
command grep -n 'modelOverride: shaping.modelOverride,' src/agents/agent-manager.ts         # 1 hit (runTurn request)
command grep -n 'W3.5/KPR-314' src/agents/agent-manager.ts                                  # 1 hit (stale park pointer, coherence note c)
command grep -n 'parked in the spec (§5) for W3.5' src/agents/agent-manager.ts              # 1 hit (SpawnShaping docstring staleness)
command grep -c 'modelOverride: undefined, routerTier: undefined, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined' src/agents/agent-manager.ts  # expect 3 (voice, gate-skip, catch)
command grep -n 'cross-provider per-turn routing unsupported' src/agents/agent-manager.ts   # 1 hit (clamp warn)

# 3. Plumbing surface (Task 3):
command grep -n 'modelOverride?: string;' src/agents/provider-adapters/types.ts             # 1 hit
command grep -n 'request.modelOverride,' src/agents/provider-adapters/claude-agent-adapter.ts  # 1 hit
command grep -n 'const effectiveModel = modelOverride ?? this.agentConfig.model;' src/agents/agent-runner.ts  # 1 hit
command grep -c 'effectiveModel' src/agents/agent-runner.ts                                 # expect 3

# 4. Registry/catalog wording surface (Task 4, coherence note b):
command grep -n 'router: heuristics-only per KPR-312' src/llm/registry.ts                   # 1 hit
command grep -n 'supportsEffort(modelId: string): boolean' src/llm/registry.ts              # 1 hit (kept — new consumer)
command grep -n 'class as TIER_MODELS' src/llm/catalog.ts                                   # 1 hit (comment wraps: "same maintenance / class as TIER_MODELS")

# 5. Test harness anchors:
command grep -n 'vi.mock("./model-router.js", () => ({' src/agents/agent-manager.test.ts    # 1 hit (mock to re-shape)
command grep -n 'function makeRouterResult' src/agents/agent-manager.test.ts                # 1 hit
command grep -n 'model: "claude-haiku-4-5",' src/agents/agent-manager.test.ts               # 1 hit (harness default — now skip-class)
command grep -n 'describe("routeModel — classifier v2 (KPR-312, registry transport KPR-314)"' src/agents/model-router.test.ts  # 1 hit
command grep -n 'describe("resolveResourceLimits"' src/agents/model-router.test.ts          # 1 hit (byte-preserve)
command grep -n 'ignores Claude router modelOverride values' src/agents/provider-adapters/codex-subscription-adapter.test.ts  # 1 hit (removed-with-citation in T3)

# 6. Docs wording surface (Task 4):
command grep -n 'Haiku/Sonnet classification, respects agent ceiling' CLAUDE.md             # 1 hit
command grep -cE 'Haiku ?/ ?Sonnet' docs/architecture.md                                    # expect 2
```

- [ ] **Spec-cite refresh:** read each hit in context and confirm: the router gate's four conditions are unchanged; the KPR-313 guard block sits *above* `prepareSpawn` and is not otherwise touched by any anchor above; pilot adapters read `resourceLimits?.maxTurns` (openai) / `maxLlmCalls` (gemini) from the turn request (path-preservation stakes). Any mismatch = drift.
- [ ] Baseline gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — fully green before any edit.

**Escape hatch (drift found):** if any grep misses or hits a different count — **make no edits**. Demote to the spec lane (dodi-dev:mature-ticket) with a drift note listing exactly which anchors failed and what is there instead.

**Commit:** none (read-only task).

---

## Task 1 — Manager goes fixed-tier: static-tier limits, effort-capability skip, `SpawnShaping` slim-down

**Goal:** after this task the engine's *behavior* is final — no turn ever runs a model other than `agentConfig.model`, haiku/effort-incapable agents skip the classifier, limits are static-tier-sourced and path-preserving, telemetry/audit read static facts. The router still has its old signature (Task 2 shrinks it); its tier/model/limits/provider outputs are simply no longer read.

### 1a. `src/agents/model-router.ts` — one-line export (T1's only router edit)

Change the `modelToTier` declaration to exported, with the new-consumer note:

```ts
/**
 * Infer tier from a model ID string. KPR-338: exported — prepareSpawn derives
 * the agent's STATIC tier for resource limits and audit (tier is a per-agent
 * fact now, never a per-turn decision). Claude-id substring heuristic —
 * meaningless on provider-prefixed pilot ids; callers gate on the
 * claude-static route.
 */
export function modelToTier(model: string): ModelTier {
```

### 1b. `src/agents/agent-manager.ts` — imports + instance state

- Line 12 import becomes (drop `type ModelTier` — no longer referenced after the `routerTier` field deletion; `modelToTier`'s return type is inferred):

```ts
import { routeModel, modelToTier, resolveResourceLimits, type ResourceLimits } from "./model-router.js";
```

- Add beside the other imports: `import { getLLMRegistry } from "../llm/registry.js";`
- Add an instance field on `AgentManager` (near the other private state): 

```ts
  /** KPR-338 D1: warn-once per model id when effort hints are disabled for an
   *  off-catalog (non-haiku-tier) static model — supportsEffort is
   *  conservative (unknown ⇒ false) and the operator deserves a signal. */
  private readonly effortIncapableWarned = new Set<string>();
```

### 1c. `SpawnShaping` — delete `modelOverride` + `routerTier`, refresh the docstring

Replace the interface and its docstring (lines ~200–229) with:

```ts
/**
 * KPR-311 → KPR-338: per-turn spawn shaping — shaped prompt plus the agent's
 * static route. Post-KPR-338 the route IS the static route on every path
 * (resolveProviderModel(agent.model)): the router no longer names models or
 * providers, so the W3 provider clamp (R-311.1) survives structurally rather
 * than as a branch. The route keeps the KPR-306 breaker permit — acquired on
 * the static provider before any shaping — keyed to the provider that
 * actually runs, and keeps providerFor() (KPR-307) consistent. Cross-provider
 * per-turn routing stays parked (kpr-311-spec §5 → KPR-337).
 */
interface SpawnShaping {
  prompt: string;
  /** The agent's static route — consumed by createProviderAdapter. */
  route: ProviderModelRoute;
  /**
   * KPR-312 → KPR-338: per-turn reasoning effort — the classifier's ONLY
   * surviving output. Carried BESIDE the route, never in it (R-312.3 channel,
   * meaning untouched). Set only by the router merge branch, which is only
   * reached when the static model is effort-capable (prepareSpawn's skip
   * guarantees deliverability); undefined on voice/skip/failure paths and
   * for pilots.
   */
  effortOverride: ReasoningEffort | undefined;
  /** Static-tier execution bounds — set ONLY on the router-on path (KPR-338
   *  path-preserving rule); undefined elsewhere so the runner's per-agent
   *  legacy fallback (timeoutMs/maxTurns/budgetUsd) stays live config. */
  resourceLimits: ResourceLimits | undefined;
  routerCostUsd: number;
}
```

### 1d. `prepareSpawn` — static tier, skip, merge

1. After the `staticRoute` line, add the guarded static-tier derivation (guarded for the same KPR-306 reason as `staticRoute` — the existing comment above it covers both):

```ts
    const agentConfig = this.registry.get(ctx.agentId);
    const staticRoute = resolveProviderModel(agentConfig?.model ?? "");
    // KPR-338: static tier — guarded like staticRoute (KPR-306 wedged-permit
    // hazard; see the comment above). Only meaningful on the claude-static
    // router-on path below.
    const staticTier = modelToTier(agentConfig?.model ?? "");
```

2. Voice return and router-gate return: drop the two deleted fields —

```ts
      return { prompt: item.text, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
```
```ts
      return { prompt, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
```
(The router-gate comment keeps its four-condition explanation; append `— R-311.2` if absent.)

3. Replace everything from the `try {` through the end of the catch (the routeModel call, clamp branch, merge, catch) with:

```ts
    // KPR-338: the turn's model is ALWAYS agentConfig.model (fixed-tier
    // invariant, kpr-338-spec §1.3). Execution bounds derive from the agent's
    // STATIC tier — same path that carried router-derived limits before
    // (path-preserving), explicitly NOT effort-keyed.
    const staticLimits = resolveResourceLimits(staticTier, agentConfig.resourceTiers);

    // Haiku-skip (replaces router H1) + effort-capability gate (kpr-338-spec
    // §3.1 residual, plan D1/D2): when the static model cannot receive the
    // effort param, the classifier's only remaining output is undeliverable —
    // skip the call entirely (zero classifier cost/latency; today's
    // haiku-tier envelope preserved). supportsEffort is catalog-driven
    // (KPR-314); unknown ids are conservatively false — warn once so an
    // off-catalog operator model doesn't silently lose the effort lever.
    if (staticTier === "haiku" || !getLLMRegistry().supportsEffort(agentConfig.model)) {
      if (staticTier !== "haiku" && !this.effortIncapableWarned.has(agentConfig.model)) {
        this.effortIncapableWarned.add(agentConfig.model);
        log.warn(
          "Per-turn effort hints disabled — agent model is not effort-capable in the LLM catalog (off-catalog id?)",
          { agentId: ctx.agentId, model: agentConfig.model },
        );
      }
      return { prompt, route: staticRoute, resourceLimits: staticLimits, routerCostUsd: 0, effortOverride: undefined };
    }

    try {
      const result = await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers, {
        // H3 guard (KPR-312): file-bearing messages must not short-circuit on
        // empty text — file content is appended into `prompt` above and never
        // reaches the classifier.
        hasFiles: Boolean(item.files?.length),
      });
      // Effort rides BESIDE the route (R-312.3, byte-untouched channel):
      // SpawnShaping.effortOverride → AgentProviderTurnRequest.effort →
      // Options.effort. The classifier's tier/model outputs are no longer
      // read (deleted from the contract in the next commit).
      return { prompt, route: staticRoute, resourceLimits: staticLimits, routerCostUsd: result.costUsd, effortOverride: result.effort };
    } catch (err) {
      // Belt-and-braces (routeModel owns its own fallback and should not
      // throw). Degenerate shape preserved: resourceLimits stays undefined on
      // this path (KPR-338 path-preserving rule — runner legacy fallback).
      log.warn("Model router failed, using defaults", { agentId: ctx.agentId, error: String(err) });
      return { prompt, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
    }
```

Note the Task-1 `routeModel` call keeps the legacy 4-arg signature — Task 2 shrinks it to `(item.text, { hasFiles })`. The clamp branch (and its warn) is **gone** in this commit: `result.provider` is never read again.

### 1e. `runOneSpawnAttempt` — stop passing a model

Delete the line `modelOverride: shaping.modelOverride,` from the `adapter.runTurn({...})` request (the optional field on `AgentProviderTurnRequest` survives, always-undefined, until Task 3 deletes it).

### 1f. `recordSpawnObservability` — static facts (D4)

- Telemetry: `model: shaping.modelOverride ?? this.registry.get(ctx.agentId)?.model` → `model: this.registry.get(ctx.agentId)?.model`
- Audit: `model: shaping.modelOverride ?? this.registry.get(ctx.agentId)?.model ?? "unknown"` → `model: this.registry.get(ctx.agentId)?.model ?? "unknown"`
- Audit tier:

```ts
      // KPR-338 D4: tier is a static per-agent fact — audited on every
      // claude-static turn (R-311.7's observability feed, now static).
      // Pilots carry no tier: modelToTier is a Claude-id substring heuristic,
      // meaningless on provider-prefixed ids.
      modelTier: shaping.route.provider === "claude" ? modelToTier(shaping.route.model) : undefined,
```

### 1g. Comment sweeps (the load-bearing three + a grep-guided pass)

- **`:686` park pointer (coherence note c, R-313.3 canon):** in the session-identity guard comment, `(parked: kpr-311-spec §5 → W3.5/KPR-314)` → `(parked: kpr-311-spec §5 → KPR-337)`. Comment-only — the guard's code is untouchable here.
- **spawnTurn shaping comment (~line 712-718):** "recordSpawnObservability sees prompt / modelOverride in scope" → "recordSpawnObservability sees the shaped prompt/effort in scope".
- **`prepareSpawn` docstring (~lines 1176–1192):** rewrite the route-derivation bullet: the router no longer merges a per-turn decision — the route is the static `resolveProviderModel(agent.model)` on every path; the classifier contributes effort only (KPR-338); keep the sender-prepend/file-append/voice-carve-out bullets as-is; drop the "TIER_MODELS is Claude-only" parenthetical.
- Then `command grep -n "modelOverride\|routerTier\|clamp\|ceiling\|W3.5" src/agents/agent-manager.ts` and update any straggler comments (e.g. the `createProviderAdapter`-adjacent "provider-clamped to static in W3" phrasing → "static by construction post-KPR-338 (clamp invariant, R-311.1)"). Expected post-sweep: zero `modelOverride`/`routerTier` hits in this file.

### 1h. `agent-manager.test.ts` — harness + rewritten pins

- **Harness:** swap the router mock to the spread-original pattern and add the registry mock (see Testing Contract → Harness Requirements for exact code); add `agent-s` (`model: "claude-sonnet-4-6"`) to `makeMockRegistry`.
- **`model router resource limits` describe — rewrite:**
  - "passes resource limits from router to runner.send()" → "delivers STATIC-tier limits on the router-on path" — `agent-s`, `routeModel` mocked to a legacy-shape result whose `resourceLimits`/`model`/`tier` are junk sentinels; assert send position 5 (current 8-arg shape) equals `RESOURCE_TIER_DEFAULTS.sonnet` and position 4 (model) is `undefined`. Add a variant with `resourceTiers: { sonnet: { budgetUsd: 2 } }` on the agent asserting the merged override.
  - "passes undefined resource limits when model router is disabled" — kept as-is (path preservation).
  - New: **haiku-skip pin** — router-on turn on `agent-a` (haiku default): `expect(routeModel).not.toHaveBeenCalled()`, limits = `RESOURCE_TIER_DEFAULTS.haiku`, effort position `undefined`.
  - New: **D1 warn-once pin** — agent with `model: "claude-nova-9"` and `mockSupportsEffort.mockReturnValue(false)`: two turns on different threads → `routeModel` never called, limits = sonnet defaults (substring default tier), `mockLogWarn` called exactly once with the "effort hints disabled" string.
- **`spawnTurn shaping` describe:** "calls model router and uses override + resourceLimits in runner.send" → rewritten on `agent-s` asserting no override + static limits (citation comment: kpr-338-spec §3.2). "adds router cost to TurnResult.usage.costUsd" → kept, on `agent-s`.
- **`router→adapter seam (KPR-311)` describe:**
  - "merges the routed model into the effective route…" → rewritten: "delivers effort beside the static route (KPR-312 channel; KPR-338: no model merge)" — `agent-s`, effort `"high"` in the mocked result: send position 7 = `"high"`, position 4 = `undefined`, limits = static sonnet.
  - "provider clamp…" test **deleted** with citation comment (`// KPR-338 §3.2: clamp branch deleted with ModelRouterResult.provider; invariant re-pinned below`), replaced by **"shaped route ≡ static route on every path"**: router-on `agent-s` turn with a full mocked result → no pilot constructor called, telemetry `model` = `"claude-sonnet-4-6"`, audit `model` = `"claude-sonnet-4-6"`, send model position `undefined`.
  - "activity audit modelTier: routed tier when the router ran, undefined when disabled" → rewritten per D4: router-on `agent-s` → `modelTier: "sonnet"`; router-off `agent-s` → **`modelTier: "sonnet"` as well** (citation: KPR-338 D4 — static fact, was undefined pre-338); pilot → property present and `undefined` (kept).
  - "auth-rebuild retry reuses the first routing decision" → kept on `agent-s`; assert `routeModel` once and both send calls carry identical limits/effort, model position `undefined` on both.
  - "skips the router for sender === 'system'", "pilot gate", "createProviderAdapter consumes the shaping route", "misattribution fix" → kept (mechanical shape updates only).
  - **effort delivery channel** describe: "threads hasFiles into routeModel's 4th arg" kept this task (updated to 2nd arg in Task 2); "delivers effort even when the routed model equals the agent model" → retitle "delivers effort with no model override anywhere (KPR-338)"; router-off/system/voice/pilot no-effort pins kept.
- **Negative-verifies NV-a, NV-b, NV-c, NV-d** (Testing Contract): run now, record evidence, restore.

**Verify:**
```bash
npx vitest run src/agents/model-router.test.ts src/agents/agent-manager.test.ts   # green
npx vitest run src/agents/                                                        # green (306/307/313/220 untouched)
npm run typecheck                                                                 # green
command grep -c "routerTier\|shaping.modelOverride" src/agents/agent-manager.ts   # 0
```

**Commit:** `KPR-338: fixed-tier manager — static-tier limits, effort-capability skip, SpawnShaping slim-down`

---

## Task 2 — Effort-only classifier: `model-router.ts` contract shrink

**Goal:** `routeModel(text, opts?) → {costUsd, durationMs, effort?, method?}`. Tier leaves the schema, prompt, result, and file. Transport stays exactly as KPR-314 landed it (registry `generateForTask`, registry-computed cost, `hasProvider` no-key keying, renamed test seam) — do not resurrect any `8b1cdaa` shape.

### 2a. `src/agents/model-router.ts` — replace the contract region

Keep byte-identical: the imports block minus `AgentProviderId` (drop it — its only use was the deleted `provider` field), `ModelTier`, `ResourceLimits`, `ResourceTierOverrides`, `RESOURCE_TIER_DEFAULTS`, `resolveResourceLimits`, `MAX_CLASSIFIER_INPUT`, `ACK_ALLOWLIST`, the exported `modelToTier` (from Task 1), `noKeyModeAnnounced` + `__resetRouterStateForTests`.

Delete: `TIER_RANK`, `TIER_MODELS` (R-314.2's pre-announced supersession — their last consumers die in this rewrite), `heuristicHaiku`, `sonnetFallback`, `ROUTER_PROMPT_V2`, the old `ModelRouterResult`, the old `ROUTER_SCHEMA`, the old `routeModel`.

Add, in their place:

```ts
/**
 * KPR-338: effort-only result. The router no longer names tiers, models,
 * providers, or resource limits — a turn's model is always agentConfig.model
 * (fixed-tier invariant, kpr-338-spec §1.3); execution bounds derive from the
 * agent's static tier in prepareSpawn. The tier-axis analog of KPR-311's
 * provider clamp (R-311.1): an agent's engine identity is static per turn,
 * changed only by operator action.
 */
export interface ModelRouterResult {
  costUsd: number;
  durationMs: number;
  /** KPR-312 semantics unchanged: emitted by the model path only
   *  (method: "model"), ∈ {low, medium, high} (schema-constrained; the subset
   *  valid on both ReasoningEffort and the SDK's EffortLevel). H2/H3
   *  heuristics emit "low". Delivered beside the route via
   *  SpawnShaping.effortOverride → AgentProviderTurnRequest.effort →
   *  Options.effort — prepareSpawn only routes here when the static model is
   *  effort-capable (KPR-338 skip), so no drop rule is needed in this file. */
  effort?: ReasoningEffort;
  /** KPR-312: how the decision was made — heuristic short-circuit, model
   *  call, key-less mode, or failure fallback. Observability-only. "no-key"
   *  (unconfigured — steady state, surface once) is deliberately distinct
   *  from "fallback" (API failing — incident to alarm on). */
  method?: "heuristic" | "model" | "no-key" | "fallback";
}

/**
 * KPR-338: classifier v3 prompt — the tier rubric is gone (tier is a
 * per-agent fact, not a per-turn decision); only the KPR-312 effort rubric
 * survives. No prompt-cache marker: far below the cacheable minimum.
 */
const ROUTER_PROMPT_V3 = `You are an effort classifier. Decide how much reasoning effort an AI agent should spend on a user message.

Effort levels:
- **low**: Greetings, acknowledgments, routine lookups, status checks, yes/no answers, short factual questions, single simple actions.
- **medium**: Typical multi-step work — drafting emails/messages, summarizing data, moderate analysis, tool-heavy workflows. Most tasks land here.
- **high**: Consequential judgment, strategic planning, intricate multi-part work, nuanced analysis — anything where getting it wrong has real consequences.

Rules:
- When in doubt, pick medium.
- Short messages do NOT automatically mean low effort — "fire the sales team" is short but demands high effort.
- Judge the TASK complexity, not the message length.`;

/** Strict output schema — KPR-314 mechanism unchanged (registry wraps it in
 *  the SDK's jsonSchemaOutputFormat); KPR-338: effort is the only field. */
const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["effort"],
  additionalProperties: false,
} as const;

function heuristicLow(): ModelRouterResult {
  return { costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" };
}

/**
 * Failure/no-reasoning fallback — NO effort key (a $0 decision doesn't tune a
 * lever it didn't reason about — unchanged KPR-312 principle). The pre-338
 * sonnet-fallback *tier* concept is gone: a fallback now simply means "no
 * effort hint this turn".
 */
function classifierFallback(): ModelRouterResult {
  return { costUsd: 0, durationMs: 0, method: "fallback" };
}
```

And the new `routeModel` (replacing the old one wholesale):

```ts
/**
 * Classify a message's per-turn reasoning effort (KPR-338: the classifier's
 * only remaining output — tier selection was removed; the turn's model is
 * always the agent's static model, and haiku-static / effort-incapable agents
 * never reach this call at all — prepareSpawn skips them).
 *
 * KPR-312 heuristics H2–H3 (first match wins) short-circuit before any
 * registry work; the model path is one structured-outputs call through the
 * KPR-314 sidecar registry. Key-less instances run heuristics-only
 * (`method: "no-key"`).
 *
 * NOTE (KPR-312 §7): this call deliberately does NOT route through the
 * provider adapters — never breaker-recorded, never permit-gated. A
 * classifier fault must not count toward turn-provider health; its own
 * timeout + fallback bounds damage to one cheap fallback per turn.
 *
 * @param opts.hasFiles — file-bearing messages must not be mis-short-circuited
 *   by the empty-text rule (H3): the router only sees `item.text`, while file
 *   content is appended into the assembled prompt downstream.
 */
export async function routeModel(
  text: string,
  opts?: { hasFiles?: boolean },
): Promise<ModelRouterResult> {
  const trimmed = text.trim();

  // H2 — exact-match ack/greeting allowlist (membership unchanged; any-turn
  // scope decided in kpr-338-spec §1.2(3): a miss now costs an effort hint on
  // the agent's own model, not a model/budget downgrade).
  if (ACK_ALLOWLIST.has(trimmed.toLowerCase())) {
    return heuristicLow();
  }

  // H3 — empty text and no files: nothing to classify. File-bearing items
  // skip this — files mean real work the classifier can't see.
  if (trimmed.length === 0 && !opts?.hasFiles) {
    return heuristicLow();
  }

  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) {
    // No-key mode (KPR-312 §3.3, truth condition unchanged): heuristics-only.
    // KPR-338: every turn keeps the agent's static model by construction —
    // what no-key mode actually loses now is per-turn effort hints.
    if (!noKeyModeAnnounced) {
      noKeyModeAnnounced = true;
      log.info(
        "Model router running heuristics-only (no ANTHROPIC_API_KEY) — no per-turn effort hints; every turn runs the agent's static model regardless",
      );
    }
    return { costUsd: 0, durationMs: 0, method: "no-key" };
  }

  // Model path — bound the classifier input (same pattern as knowledge-extractor).
  const truncated =
    trimmed.length > MAX_CLASSIFIER_INPUT
      ? trimmed.slice(0, MAX_CLASSIFIER_INPUT) + "\n[...truncated]"
      : trimmed;
  // Empty text + files reaches the model path (H3 skipped) — the API rejects
  // empty text blocks, so classify a placeholder instead.
  const classifierInput = truncated.length > 0 ? truncated : "(attachment-only message, no text)";

  try {
    const result = await registry.generateForTask("routerClassifier", {
      prompt: classifierInput,
      systemPrompt: ROUTER_PROMPT_V3,
      maxOutputTokens: 100,
      jsonSchema: ROUTER_SCHEMA,
      timeoutMs: config.modelRouter.timeoutMs, // per-request wall clock (KPR-314)
    });

    // KPR-312's fallback conditions, translated to the effort-only contract
    // (plan D5): unusable output = refusal/max_tokens stop, missing parsed
    // output, or an out-of-enum effort (near-dead under schema enforcement).
    const parsed = result.parsed as { effort?: string } | undefined;
    const effort: ReasoningEffort | undefined =
      parsed?.effort === "low" || parsed?.effort === "medium" || parsed?.effort === "high"
        ? parsed.effort
        : undefined;
    if (result.stopReason === "refusal" || result.stopReason === "max_tokens" || effort === undefined) {
      log.warn("Model router returned unusable output — no effort hint this turn", {
        stopReason: result.stopReason,
        hasParsedOutput: Boolean(parsed),
      });
      return classifierFallback();
    }

    // KPR-314: cost computed by the registry (usage × catalog pricing).
    // Off-catalog MODEL_ROUTER_MODEL override ⇒ undefined ⇒ 0: cost telemetry
    // degrades, routing doesn't (registry warns once).
    const costUsd = result.costUsd ?? 0;
    // Log-redaction convention: no message text / input previews.
    log.info("Model router decision", { effort, costUsd, durationMs: result.durationMs });
    return { costUsd, durationMs: result.durationMs, effort, method: "model" };
  } catch (err) {
    // maxRetries: 0 — any timeout / 429 / 5xx / 404 (misconfigured
    // MODEL_ROUTER_MODEL) lands here. Operator-visible noise by design.
    log.warn("Model router call failed — no effort hint this turn", { error: String(err) });
    return classifierFallback();
  }
}
```

### 2b. `src/agents/agent-manager.ts` — shrink the call site

`routeModel(item.text, agentConfig.model, agentConfig.resourceTiers, { ... })` → `routeModel(item.text, { ... })` (comment block on `hasFiles` unchanged).

### 2c. `src/agents/model-router.test.ts` — rewrite (contract group 1)

Keep the 314 harness (registry mock, mutable config, logger mock, reset seam) and the `resolveResourceLimits` describe **byte-identical**. `makeLlmResult` takes `{ effort: string } | null`. Rewrite the `routeModel` describe as `describe("routeModel — effort-only classifier (KPR-338, registry transport KPR-314)")` implementing every pin in Testing Contract group 1. Representative new pins (write all of group 1, these anchor the style):

```ts
    it("H2: exact-match ack → {effort: low, method: heuristic}, no tier/model/limits keys, no registry call", async () => {
      const r = await routeModel("thanks");
      expect(r).toEqual({ costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" });
      expect("tier" in r).toBe(false);
      expect("model" in r).toBe(false);
      expect("resourceLimits" in r).toBe(false);
      expect("provider" in r).toBe(false);
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it("schema pin: effort is the only required field; tier is gone from the output schema", async () => {
      await routeModel("draft the quarterly summary");
      const req = mockGenerateForTask.mock.calls[0]![1];
      expect(req.jsonSchema.required).toEqual(["effort"]);
      expect("tier" in req.jsonSchema.properties).toBe(false);
    });

    it("prompt pin: effort rubric only — no tier rubric survives", async () => {
      await routeModel("draft the quarterly summary");
      const sys: string = mockGenerateForTask.mock.calls[0]![1].systemPrompt;
      expect(sys).toContain("Effort");
      for (const gone of ["Tiers:", "haiku", "sonnet", "opus"]) expect(sys).not.toContain(gone);
    });

    it("supportsEffort is not consulted — the deliverability gate moved to prepareSpawn (KPR-338)", async () => {
      await routeModel("summarize this thread");
      expect(mockSupportsEffort).not.toHaveBeenCalled();
    });
```

H1's old test carries: `// KPR-338 §3.1: H1 deleted — superseded by prepareSpawn's haiku-skip (pinned in agent-manager.test.ts)`.

### 2d. `agent-manager.test.ts` — the deliberate double-touch

- `makeRouterResult` becomes:

```ts
function makeRouterResult(overrides: Partial<ModelRouterResult> = {}): ModelRouterResult {
  return { costUsd: 0.001, durationMs: 50, method: "model", ...overrides };
}
```
- Every `mockResolvedValue*(...)` router stub drops tier/model/limits/provider keys (they are now excess-property type errors — the compiler enumerates the sites).
- "threads hasFiles into routeModel's **4th** arg" → **2nd** arg: `expect(vi.mocked(routeModel).mock.calls[0]![1]).toEqual({ hasFiles: false })`; add the exact-args pin `expect(vi.mocked(routeModel)).toHaveBeenCalledWith("no files", { hasFiles: false })` (router-on `agent-s` — nothing else is passed: no ceiling, no overrides).

**Verify:**
```bash
npx vitest run src/agents/model-router.test.ts src/agents/agent-manager.test.ts  # green
npm run typecheck                                                                # green
command grep -c "TIER_MODELS\|TIER_RANK" src/agents/model-router.ts              # 0
command grep -rn "TIER_MODELS\|TIER_RANK" src/ --include="*.ts" | command grep -v catalog.ts | wc -l  # 0 (catalog comment swept in T4)
```

**Commit:** `KPR-338: effort-only classifier — routeModel contract shrink, tier rubric/schema/constants deleted`

---

## Task 3 — Delete the `modelOverride` plumbing end-to-end (plan D3)

**Goal:** no always-`undefined` vestige survives. The effort channel and `resourceLimits` channel shift one position left in `runner.send`; their meanings are untouched (R-312.3 — the positional note lands in the delivery-time register entry).

### 3a. `src/agents/provider-adapters/types.ts`

Delete `modelOverride?: string;` from `AgentProviderTurnRequest`. Refresh the `effort` field comment: drop the "(same tested precedent as modelOverride/resourceLimits)" phrasing → "(same tested precedent as resourceLimits)". Add one line to the interface docstring if present: `// KPR-338: no per-turn model — a turn's model is always the agent's static model.`

### 3b. `src/agents/provider-adapters/claude-agent-adapter.ts`

Remove `request.modelOverride,` from the `runner.send(...)` forwarding (now 7 args, order: prompt, sessionId, onStream, workItemContext, resourceLimits, systemPromptOverride, effort).

### 3c. `src/agents/agent-runner.ts`

- `send` signature: remove `modelOverride?: string,` (param 5).
- `const effectiveModel = modelOverride ?? this.agentConfig.model;` → `const effectiveModel = this.agentConfig.model;`
- In the send-entry log object: delete `modelOverride: modelOverride ? true : false,` (the `model: effectiveModel` field stays — it now always reports the static model).
- The other `model: effectiveModel` use (SDK options) is unchanged.

### 3d. Test sweep (mechanical, compiler-guided)

- `claude-agent-adapter.test.ts`: drop `modelOverride: "claude-haiku-4-5",` from the request literal; the `toHaveBeenCalledWith` pin drops the `"claude-haiku-4-5"` positional (7 args).
- `agent-runner.test.ts`: resource-limits positional call gains one fewer `undefined` pad (limits at position 5 of the call → 5th arg); effort calls `send("hi", undefined, undefined, undefined, undefined, undefined, "low")` (effort now 7th arg). Assertions unchanged.
- `codex-subscription-adapter.test.ts`: delete the `it("ignores Claude router modelOverride values", ...)` test with citation comment (`// KPR-338 D3: modelOverride deleted from AgentProviderTurnRequest — nothing left to ignore`); drop the `modelOverride` key from the remaining request literal (the surviving pin: the adapter runs its constructor-baked model).
- `openai-agents-adapter.test.ts` / `gemini-adk-adapter.test.ts`: "uses systemPromptOverride and ignores modelOverride" → retitle "uses systemPromptOverride" and drop the `modelOverride` key; the systemPromptOverride assertion is the surviving substance.
- `agent-manager.test.ts`: shift every `mockRunnerSend` positional pin (old index 4 model → gone; limits 5→4; systemPromptOverride 6→5; effort 7→6). Replace `expect.objectContaining({ modelOverride: undefined })` on pilot runTurn requests with `expect("modelOverride" in req).toBe(false)` on the captured request. Where Task 1 pinned "model position is undefined", replace with an arity pin: `expect(mockRunnerSend.mock.calls[0]!.length).toBe(7)` on one representative test (the type system enforces the rest).

**Verify:**
```bash
command grep -rn "modelOverride" src/ --include="*.ts" | wc -l   # 0
npx vitest run src/agents/ && npm run typecheck                  # green
```

**Commit:** `KPR-338: delete modelOverride plumbing — types, adapter forwarding, runner.send param`

---

## Task 4 — Wording sweeps: no-key logs, catalog comment, docs (coherence note b)

**Goal:** no surviving text describes the removed behavior. (The `model-router.ts` boot-log reword shipped inside Task 2; this task covers everything outside that file.)

- **`src/llm/registry.ts`** construction log (the coherence-note-b parenthetical):

```ts
        "LLM sidecar: anthropic unavailable (no ANTHROPIC_API_KEY) — meeting classifier degrades to all-roster, memory dream LLM phases skip (router: heuristics-only, no per-turn effort hints — KPR-338)",
```
(Verified: no test pins this string — `registry.test.ts` has zero hits on "heuristics-only".)

- **`src/llm/catalog.ts`** header comment (wraps across two lines): `Constants ride engine releases — same maintenance / class as TIER_MODELS; no runtime pricing fetch (spec §7).` → `Constants ride engine releases — same maintenance class the router's TIER_MODELS constants once were (deleted by KPR-338); no runtime pricing fetch (spec §7).`
- **`CLAUDE.md`:** line `→ Model Router (Haiku/Sonnet classification, respects agent ceiling)` → `→ Model Router (effort-only classifier — every turn runs the agent's static model, KPR-338)`; key-files line `src/agents/model-router.ts — complexity classifier for model selection` → `src/agents/model-router.ts — per-turn effort classifier (KPR-338: models are static per agent; the classifier tunes reasoning effort only)`.
- **`docs/architecture.md`:** both `Haiku / Sonnet` router mentions updated to the same effort-only description.
- **Verified-no-change (record, don't edit):** `doctor-checks.ts` `modelRouterModeLine` strings are tier-neutral and stay accurate ("LLM classification" = the effort classifier; "heuristics-only" unchanged); `hive.yaml.example` has no router-tier wording; `config.ts` `modelRouter` comments are transport-scoped (KPR-312) and accurate.

**Verify:**
```bash
command grep -rn "Haiku/Sonnet\|Haiku / Sonnet" CLAUDE.md docs/architecture.md | wc -l   # 0
command grep -rn "heuristics-only per KPR-312" src/ | wc -l                              # 0
npx vitest run src/llm/ src/cli/doctor-checks.test.ts                                    # green
```

**Commit:** `KPR-338: wording sweeps — no-key log strings, catalog comment, CLAUDE.md/architecture docs`

---

## Task 5 — NON-BLOCKING validation rider: what was the removed downgrade worth? (spec §3.5)

**Never gates delivery.** Runs in parallel with (or after) Tasks 1–4; if the dev-instance DBs are unreachable, record that on the ticket and move on — no retry obligation, no code impact. Read-only: `.aggregate`/`.find` only, no writes.

Run against the operator's live instances (dodi + keepur Mongo, same Mini). For each instance DB:

```bash
mongosh "<instance mongo uri>" --quiet --eval '
  const defs = Object.fromEntries(db.agent_definitions.find({}, {id:1, model:1}).toArray().map(d => [d.id, d.model]));
  const tier = m => !m ? "?" : m.includes("opus") ? "opus" : m.includes("haiku") ? "haiku" : "sonnet";
  const rank = { haiku: 0, sonnet: 1, opus: 2 };
  // (a) downgrade frequency: audited routed turns whose classified tier < static tier
  let routed = 0, downgraded = 0;
  db.activity_log.find({ modelTier: { $exists: true, $ne: null } }).forEach(r => {
    const s = tier(defs[r.agentId]); if (s === "?") return;
    routed++; if (rank[r.modelTier] < rank[s]) downgraded++;
  });
  print(JSON.stringify({ routed, downgraded, pct: routed ? (100*downgraded/routed).toFixed(1) : "n/a" }));
  // (b) cache warm/cold split on downgraded vs same-model turns
  const stats = { down: {read:0, create:0, n:0}, same: {read:0, create:0, n:0} };
  db.agent_turn_telemetry.find({ model: { $exists: true } }).forEach(t => {
    const s = defs[t.agentId]; if (!s) return;
    const b = t.model !== s ? stats.down : stats.same;
    b.read += t.cacheReadTokens ?? 0; b.create += t.cacheCreationTokens ?? 0; b.n++;
  });
  print(JSON.stringify(stats));
'
```

Post the two JSON blobs per instance, plus a 3–5 sentence reading (downgrade frequency; whether downgraded turns skew cache-cold — i.e. whether the "saving" was cache-negative), as a Linear comment on KPR-338 titled **"§3.5 validation rider evidence"**. This feeds the §3.4 effort-classifier demotion decision later; it changes nothing in this plan regardless of outcome.

**Commit:** none (evidence lands on the ticket, not the repo).

---

## Task 6 — Full gate

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck + lint + format + test all green, and the output shows all four actually ran (worktree/CI asymmetry check). Then re-run the four Task-verify greps (`modelOverride` 0 hits, `routerTier` 0 hits, `TIER_MODELS|TIER_RANK` 0 hits outside git history, `W3.5/KPR-314` 0 hits).

**Commit:** none if clean; fixups commit as `KPR-338: post-gate fixups` only if the gate surfaced format/lint deltas.

---

## Assumptions

1. **Epic branch at delivery ≥ `53e9021`** (KPR-314 merged) with no further `model-router.ts`/`agent-manager.ts` churn between plan and delivery — Task 0 re-verifies and STOPs on drift.
2. **`getLLMRegistry()` is safe to call from `prepareSpawn`** — construction is key-gated but never throws on missing keys, and `supportsEffort` is pure catalog lookup needing no provider (verified in `src/llm/registry.ts`).
3. **The three Spec-Gate coherence notes are resolved as:** (a) warn-once + conservative skip (plan D1, encoded in Task 1); (b) `registry.ts` construction-log parenthetical swept in Task 4; (c) `agent-manager.ts:686` park pointer swept to KPR-337 in Task 1g.
4. **D4's audit change** (router-off claude turns now audit their static `modelTier`, previously undefined) is within spec §3.2 item 3's mandate; the Task-8-era `hive doctor`/dashboards do not key on `modelTier` absence (verified: no doctor read of `modelTier`).
5. **R-312.3's "send 8th param" wording** is descriptive, not contractual — D3's positional shift (effort → 7th) is recorded in the delivery-time R-338.x register entry (driver's job, with the R-311.7/R-312.6 moot-by-removal note per spec §5).
6. **Interim state between Tasks 1 and 2 is behaviorally final and safe:** the legacy router's internal effort-drop only ever suppresses effort (never emits an undeliverable one for a ≤-ceiling tier), so Task 1's merge cannot deliver effort to an effort-rejecting model even before Task 2 lands.
7. **Task 5's rider** requires reachable dodi/keepur Mongo instances; unavailability degrades to a recorded note, never a block.
8. **No plugin/seed/operator-skill surface** references `routerTier`, `modelOverride`, or `ModelRouterResult` fields (engine-internal types; verified zero hits outside `src/`).
