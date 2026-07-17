# KPR-338 — Spec: Fixed-tier agents — remove per-turn tier selection, effort-only classifier

## TL;DR

Remove per-turn model-tier switching from the router entirely: every agent runs every turn at its statically configured model (`agentConfig.model`), and the complexity classifier's only remaining per-turn output is `effort` (low/medium/high). This supersedes the originally-filed "cost-aware switch-suppression policy" (tier hysteresis, C1-C3) — with no tier-switching left, there is nothing to suppress, and the prompt cache stays warm by construction. Escalating a conversation to a smarter brain becomes a roster-level concern (bring in a higher-tier agent), tracked separately in KPR-339.

## Key Points

- **Decision: tier is per-agent, not per-message.** `routeModel()` stops classifying tier; `agentConfig.model` is the only model any turn uses. Rationale: (1) UX — an agent must never "get dumber" mid-conversation; (2) cache — Anthropic's prompt cache is keyed per-model, so every tier switch was a full cache miss over the entire system-prompt prefix, making mid-thread downgrades plausibly net-negative on cost; (3) Anthropic's own guidance for mixed-tier work is one model per main loop, delegate elsewhere — which hive's roster already embodies (haiku front-line agents, opus chief-of-staff).
- **The classifier survives, effort-only.** Per-turn classifier call now emits `{effort}` alone, delivered via the existing KPR-312 channel (`SpawnShaping.effortOverride` → `Options.effort`, untouched). ROI case: `effort: low` on trivial turns cuts thinking-token latency/cost on sonnet/opus agents (KPR-312 Task 8 live evidence: 38-47% output-token reduction — recorded in PR #311's body and the KPR-312 Linear ticket). Named fallback if telemetry later shows it isn't earning its serial pre-turn latency: per-agent static default effort (the delivery seam already exists).
- **Haiku-static agents skip the classifier call** (replaces H1, inside the router-on branch): they can't vary effort (haiku rejects the param — KPR-312 drop rule) and they serve the highest trivial-message volume. Zero classifier cost/latency for Rae/Milo-class agents, with today's haiku-tier resource envelope preserved.
- **H2/H3 heuristics keep their current any-turn scope**, now emitting `effort: low` instead of `tier: haiku`. Decided: the mid-thread "yes"-continuation false-positive is acceptable now that a miss costs only effort level, not model/budget (pre-338 it ran approved complex work on a haiku turn with a $1 budget — this spec fixes that live hazard).
- **Resource limits: path-preserving, static-tier-sourced.** Tier-derived limits appear exactly where they appear today (the router-on path for claude-static, non-system, non-voice turns) — sourced from the agent's static tier instead of the classified tier. Every path that yields `resourceLimits: undefined` today (system-sender/reflection, router-off, voice, pilots, catch) still does, so the runner's per-agent legacy fallback (`agentConfig.timeoutMs/maxTurns/budgetUsd`) keeps its meaning and `modelRouter.enabled: false` still disables the envelope. Explicitly NOT effort-keyed.
- **Dead code removed, not stranded:** `SpawnShaping.routerTier` and `SpawnShaping.modelOverride` deleted; their three read-sites (runner `send` model override, turn-telemetry `model`, activity-audit `model`/`modelTier`) collapse to the static model/tier. `ceilingModel`, tier-cap logic, and the `ModelRouterResult.provider` carriage field leave the router — deleting `provider` also deletes prepareSpawn's clamp *branch* (unreachable without the field); the clamp *invariant* (route ≡ static) survives structurally and R-311.2's pilot gate is untouched.
- **⚠ Spec§2 is pinned at epic `8b1cdaa` (post-313); delivery is sequenced after KPR-314**, which rewrites the classifier's transport (sidecar registry `generateForTask`, no in-file Anthropic client, registry-computed cost, renamed test reset). §3.1 marks every 314-sensitive item; the deletions are transport-agnostic (drop tier from schema/prompt/result regardless of how the call is made). Re-anchor at delivery (Task-0 pattern).
- **Throw-safety preserved:** the static-tier limits derivation uses the guarded `agentConfig?.model ?? ""` form — prepareSpawn runs inside the breaker window where an unguarded dereference on a SIGUSR1-vanished agent would wedge a half-open probe permit (KPR-306 hazard, existing comment in `prepareSpawn`).
- **⚠ Non-blocking validation rider:** one telemetry query over `agent_turn_telemetry` (downgrade frequency; cache warm/cold ratio on downgraded turns) to quantify what the removed behavior was worth. Parallel with delivery, never gates it.
- **Register impact:** R-311.7/R-312.6's deferred "switch-suppression policy" is superseded-moot (premise removed). New R-338.x entries at delivery. (The KPR-309 decision register lives on the Linear epic — description "Decision Register — Canon" section + per-merge entry comments — not in this repo.)
- **Out of scope:** escalation path — KPR-339; per-thread manual model override (slash command) — rejected (reintroduces per-thread override state; puts model choice on the least-equipped party).

---

*Everything below is written for the planning/implementation agents.*

## 1. Background

### 1.1 Where tier switching came from

The v1 router (pre-W3) fronted every turn with a haiku classifier whose primary purpose was **latency** — a "howdy" should not wait on a heavy model's full turn. Cost saving via per-turn downgrade (sonnet/opus-ceiling agents getting haiku turns for trivial messages) was a secondary effect that became the shipped behavior: `routeModel(text, ceilingModel, …) → {tier, …}` with the classified tier capped at the agent's configured ceiling — **downgrade-only** (the ceiling cap means a turn was never upgraded above `agentConfig.model`).

KPR-312 (W3.3) removed the dominant latency cost (the per-turn CLI subprocess, ~up-to-8s) by moving classification to a direct structured-outputs call, and added the `effort` lever. The tier-selection behavior carried over unchanged.

### 1.2 Why per-turn tier switching is wrong

Three independent lines, each sufficient:

1. **UX.** A thread that gets an opus-quality answer on turn 1 and a haiku-quality answer on turn 2 reads as the agent "getting dumber." The operator's rule: once a conversation earns a higher intelligence level, it must not drop mid-thread. A ratchet (up-only) was considered and rejected in favor of the simpler invariant below.
2. **Cache economics.** Anthropic's prompt cache is keyed per-model: a tier switch is a **full cache miss** across tools+system+messages — the entire multi-thousand-token hive prefix (soul + systemPrompt + constitution + roster + toolkit + memory) reprocessed at full input price plus cache-write premium. A mid-thread downgrade with a warm cache plausibly costs *more* than staying on the higher tier's ~0.1× cached-read rate. The originally-envisioned fix (C1-C3 cache-cliff hysteresis, R-311.7/R-312.6) treated the symptom; removing switching removes the disease.
3. **Live correctness hazard.** `routeModel` classifies `item.text` only — no thread context. The H2 exact-match ack allowlist contains `"yes"`: a user replying "yes" to "want me to refactor the auth system?" currently executes the approved complex work on a haiku-model turn with haiku resource limits (120s timeout, 20 maxTurns, **$1 budget**). Under this spec the same miss costs `effort: low` on the agent's own model with its own limits — a mild degradation instead of a broken turn.

The remaining legitimate need per-turn switching served — "this conversation deserves a smarter brain than this agent has" — is a **roster-level** concern: bring a higher-tier agent into the thread (the human "let me talk to your manager" pattern). That is KPR-339, out of scope here.

### 1.3 The invariant this spec establishes

> **A turn's model is always `agentConfig.model`. No engine path overrides it.**

This composes with, and is the tier-axis analog of, KPR-311's provider clamp (R-311.1: effective provider ≡ static). Provider and tier are different axes (the provider clamp was forced by breaker/session mechanics; the tier clamp is earned by §1.2), but post-338 both read: an agent's engine identity is static per turn, changed only by operator action (`agent.model` edit → SIGUSR1) — which KPR-313's session-identity guard already handles cleanly at the thread boundary.

## 2. Current state — pinned at epic branch `8b1cdaa` (post-KPR-313, **pre-KPR-314**)

> **⚠ Delivery-context:** this table describes the code as of `8b1cdaa`. KPR-314 (sequenced before this ticket, §5) rewrites the classifier's *transport* — the call goes through the sidecar LLM registry (`generateForTask("routerClassifier")`), the in-file lazy Anthropic client and pricing constants are removed, no-key mode keys off registry provider availability, and the test reset hook is renamed. Rows marked **[314-sensitive]** will differ at delivery; the *tier semantics* this spec removes are unchanged by 314. Re-confirm all anchors against 314's landed post-state at delivery (Task-0 pattern).

| Surface | Today (`8b1cdaa`) |
| --- | --- |
| `routeModel(text, ceilingModel, resourceTierOverrides?, opts?)` (`src/agents/model-router.ts`) | Pure function → `{tier, model, costUsd, durationMs, resourceLimits, effort?, method?, provider?}`. H1: ceiling-haiku short-circuit → haiku result. H2: exact-match ack allowlist → haiku. H3: empty-text-no-files → haiku. Model path: classifies `{tier, effort}`, caps tier at ceiling, drops effort if post-cap tier is haiku. Fallbacks → sonnet-capped. No-key → agent default model. **[314-sensitive: transport, client, cost computation, no-key keying, effort-drop check shape]** |
| `prepareSpawn` (`src/agents/agent-manager.ts`) | Router gate (claude-static agents, non-system sender, non-voice, router enabled) → `routeModel(item.text, agentConfig.model, agentConfig.resourceTiers, {hasFiles})` → clamp branch (router-named provider ≠ static: drop model+effort, retain limits/cost/tier) or merge: `modelOverride` (routed ≠ static), `routerTier`, `resourceLimits`, `routerCostUsd`, `effortOverride`. Degenerate paths (voice carve-out, gate-skip, catch): `modelOverride/routerTier/resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined`. |
| `SpawnShaping` | `prompt, route, modelOverride, routerTier, resourceLimits, routerCostUsd, effortOverride` |
| Turn execution | `modelOverride` → `runner.send` arg 5 → SDK `Options.model`; `effortOverride` → `TurnRequest.effort` → `Options.effort`; `resourceLimits` → timeout/maxTurns/budget, with runner fallback to per-agent legacy config when `undefined` (`resourceLimits?.maxTurns ?? agentConfig.maxTurns`, etc.). |
| Consumers of the classified tier / `modelOverride` | (1) `runner.send` model override — the actual switch; (2) tier-derived `resourceLimits`; (3) activity-audit `modelTier` ← `shaping.routerTier`; (4) turn-telemetry `model` and activity-audit `model` ← `modelOverride ?? agentConfig.model`. |
| Pilot adapters | Receive `resourceLimits` in the turn request; `openai-agents-adapter` consumes `maxTurns`, `gemini-adk-adapter` consumes it as `maxLlmCalls`. Today pilots always receive `undefined` (gate-skip path). |

## 3. Design

### 3.1 `model-router.ts` — effort-only contract

New result and signature (transport per 314's landed shape):

```ts
export interface ModelRouterResult {
  costUsd: number;
  durationMs: number;
  /** KPR-312 semantics unchanged: {low, medium, high}, model-path only. */
  effort?: ReasoningEffort;
  /** "heuristic" | "model" | "no-key" | "fallback" — unchanged. */
  method?: "heuristic" | "model" | "no-key" | "fallback";
}

export async function routeModel(
  text: string,
  opts?: { hasFiles?: boolean },
): Promise<ModelRouterResult>;
```

- **Deleted (transport-agnostic — applies whatever 314 landed):** `tier`/`model`/`resourceLimits`/`provider` from the result; `ceilingModel`/`resourceTierOverrides` params; the tier rubric from the classifier prompt; `tier` from the output schema (`required: ["effort"]`); the ceiling-cap logic; the post-cap haiku effort-drop check (haiku-static agents no longer reach the call, §3.2 — but see the effort-support note below); `TIER_MODELS` and `TIER_RANK` (both file-local; their last consumers are the deletions above — this deliberately supersedes KPR-314's "`TIER_MODELS` stays in `model-router.ts`" ruling, which predates this spec). Deleting `provider` also removes prepareSpawn's clamp *branch* (§3.2) — the field was dormant carriage since KPR-311; its clamp-lift story lives with KPR-337 (verified in Linear: "Provider clamp lift — router-driven cross-provider agent turns", Backlog), **whose premise this spec weakens** — with the router no longer naming models/providers at all, "router-driven cross-provider turns" loses its driver; KPR-337 should re-evaluate against the escalation path (KPR-339) at pickup.
- **Effort-support residual (not fully moot):** post-338, effort is delivered against `agentConfig.model` itself, whereas pre-338 it only ever rode canonical tier-model ids (effort-capable by construction). The haiku-skip keys on the `modelToTier` substring heuristic, so a hypothetical non-"haiku"-named, effort-rejecting claude model id would receive `effort` and 400 the turn. Zero live exposure today (only the haiku family rejects effort and all its ids contain "haiku"), but 314's registry lands per-model `supportsEffort()` for exactly this — **the plan should gate effort delivery on `supportsEffort(agentConfig.model)`** (or the haiku-skip on it) rather than the substring heuristic alone.
- **Kept:** `modelToTier` — **kept and exported** (new consumer: `prepareSpawn`, §3.2); `resolveResourceLimits`/`RESOURCE_TIER_DEFAULTS`/`ResourceTierOverrides`; H2/H3 heuristics; truncation bound; no-key mode and `method` semantics. **[314-sensitive — keep as-landed by 314, do not resurrect `8b1cdaa` shapes:]** the classifier transport (registry `generateForTask` call), cost computation, no-key detection, test reset hook name, and the `supportsEffort` registry surface (which the note above promotes to the effort-delivery gate).
- **Heuristics:**
  - H1 (ceiling-is-haiku) is deleted as a text rule; superseded by the router-on haiku-skip in §3.2.
  - H2 (exact-match ack allowlist, unchanged membership, any-turn scope — decided) → `{effort: "low", method: "heuristic", costUsd: 0, durationMs: 0}`.
  - H3 (empty text, no files) → same as H2.
- **Fallback/refusal/no-key:** return `{method: "fallback" | "no-key"}` with **no effort key** (a $0 decision doesn't tune a lever it didn't reason about — unchanged principle). The sonnet-fallback *tier* concept disappears; a fallback simply means "no effort hint this turn."

### 3.2 `agent-manager.ts` — static tier, path-preserving limits

- **Router-on branch restructure.** Inside the existing router gate (claude-static provider, non-system sender, non-voice, router enabled — all conditions unchanged):
  1. Compute `staticTier = modelToTier(agentConfig?.model ?? "")` and `staticLimits = resolveResourceLimits(staticTier, agentConfig?.resourceTiers)` — **guarded form**: prepareSpawn runs inside the breaker window; an unguarded `agentConfig.model` dereference on a SIGUSR1-vanished agent would throw outside the recorded try and wedge a half-open probe permit (KPR-306 — the existing guard comment in `prepareSpawn` is the precedent).
  2. **Haiku-skip (replaces H1):** if `staticTier === "haiku"`, skip the `routeModel` call entirely — return the shaped result with `resourceLimits: staticLimits`, `effortOverride: undefined`, `routerCostUsd: 0`. Same envelope H1 produces today (haiku-tier limits), zero classifier spend/latency.
  3. Otherwise call `routeModel(item.text, {hasFiles})` and merge: `resourceLimits: staticLimits`, `effortOverride: result.effort`, `routerCostUsd: result.costUsd`. (No `modelOverride`, no `routerTier` — fields deleted.)
- **Path-preserving limits rule (deliberate):** tier-derived `resourceLimits` appear **exactly where they appear today — the router-on path — sourced from the static tier instead of the classified tier. No path that yields `undefined` today changes**: system-sender/reflection turns, router-off (`modelRouter.enabled: false`), voice carve-out, pilot (non-claude-static) agents, and the catch path all keep `resourceLimits: undefined`, preserving (a) the runner's per-agent legacy fallback (`agentConfig.timeoutMs/maxTurns/budgetUsd`) as live config surface, (b) reflection/cron turns' current envelope, (c) `modelRouter.enabled: false` disabling the envelope, and (d) pilots receiving no limits (both the openai and gemini adapters actively consume `maxTurns`/`maxLlmCalls` from the request — giving them a `modelToTier`-guessed envelope would be an unanalyzed behavior change on a surface this spec declares untouched; `modelToTier` is a Claude-id substring heuristic, meaningless on provider-prefixed ids). Explicitly NOT effort-keyed: an agent's resource envelope must not vary turn-to-turn with a classifier's judgment.
- **Clamp branch:** deleted with the `provider` field (§3.1). The clamp *invariant* — effective route ≡ static route — survives structurally: `routeModel` no longer names any provider or model, so there is nothing to clamp. R-311.2's pilot router gate (routeModel never runs for non-claude-static agents) is unchanged. The clamp branch's pinned unit test is removed-with-citation (§4.3), not weakened.
- **`SpawnShaping`:** delete `modelOverride` and `routerTier`. Keep `route`, `resourceLimits`, `routerCostUsd`, `effortOverride`, `prompt`.
- **Downstream `modelOverride` consumers (all three, deliberately):** (1) `runner.send` arg 5 becomes always-`undefined` — delete the plumbing (send signature, `AgentProviderTurnRequest`, adapter forwarding) **only if** the ripple stays mechanical; otherwise leave the parameter always-`undefined` with a hygiene-follow-up note — planner's call, stated in the plan. (2) turn-telemetry `model` and (3) activity-audit `model` — both currently `modelOverride ?? agentConfig.model` — collapse to `agentConfig.model`. Activity-audit `modelTier` ← `modelToTier(agentConfig.model)` (static; R-311.7's observability hook keeps its data feed).
- **Effort channel:** byte-untouched (R-312.3). Merge branch copies `result.effort` → `effortOverride`; degenerate paths `undefined`.

### 3.3 What does NOT change

Provider clamp *invariant* and pilot router gate (R-311.1/2 — see §3.2 for the branch-vs-invariant distinction); session-identity guard, never-persist rule, churn-mint rider (KPR-313 — all keyed on provider, not tier); voice adapter (passes `resourceLimits: undefined` today and continues to); pilot adapters and their turn-request shapes; `error-classification.ts` (R3); breaker wrap (R7); dispatcher/channels; runner legacy-config fallbacks; no config surface changes (`modelRouter.enabled` gates the classifier call and the tier-derived envelope exactly as today; `MODEL_ROUTER_MODEL`/`MODEL_ROUTER_TIMEOUT_MS` keep whatever meaning KPR-314 left them; the doctor's classifier-mode line stays accurate). **One wording sweep for the plan:** the no-key boot log ("non-obvious turns keep the agent default model") becomes vacuous once *every* turn keeps the agent default model — reword it to describe what no-key mode actually loses post-338 (per-turn effort hints).

### 3.4 Effort-classifier ROI (explicit)

The surviving per-turn call costs ~$0.0005 and ~0.3-0.5s serial latency on sonnet/opus non-heuristic turns. It earns its keep iff `effort: low` on trivial-but-not-allowlisted turns meaningfully cuts heavy-tier thinking latency/cost. Evidence the lever is real: KPR-312's Task 8 live-turn gate measured **38-47% output-token reduction** for `effort: "low"` vs no-effort on `claude-sonnet-4-6` across 3 pairs — recorded in [PR #311](https://github.com/keepur/hive/pull/311)'s body and the KPR-312 Linear ticket's Task 8 evidence comment. **Fallback if later judged not worth the serial call:** per-agent static default effort (config field, classifier off) — the delivery seam (`effortOverride`) already supports this; no re-architecture. Demotion decision is telemetry-driven, out of scope here.

### 3.5 Validation rider (non-blocking)

One query over `agent_turn_telemetry` + activity audit: (a) % of routed turns where classified tier < static tier (the deleted behavior's frequency); (b) cacheReadTokens vs cacheCreationTokens on those turns (warm-vs-cold split — was the "saving" real or cache-negative?). Recorded on the ticket for the record; informs nothing in this spec's scope (the UX/correctness cases stand alone) but closes the loop on the cost claim and feeds the §3.4 demotion decision later.

## 4. Testing contract (sketch — plan owns the full contract)

1. **Router unit (rewrite of the KPR-312/314 suite as landed):** H2/H3 → `{effort: "low", method: "heuristic"}`, no tier/model/limits/provider keys (assert key-absence); model path returns effort; fallback/refusal/no-key → no effort key; schema pin (`required: ["effort"]`, no tier in the output schema); transport pins carried over from 314's landed suite, mechanically updated.
2. **Manager:** router-on sonnet/opus turn → `routeModel` called with `(text, {hasFiles})` only, `resourceLimits` = static-tier limits, no model override delivered; haiku-static agent → `routeModel` never called, `resourceLimits` = haiku-tier limits (preserving today's H1 envelope), `effortOverride: undefined`; **path-preservation pins:** system-sender, router-off, voice, and pilot paths all still deliver `resourceLimits: undefined` (runner legacy fallback observed); telemetry/audit `model` = static model, audit `modelTier` = static tier; vanished-agent (registry returns undefined mid-turn) does not throw in the limits derivation.
3. **Regression surface:** KPR-311 seam/invariants (clamp-branch test removed-with-citation — the branch is deleted; the invariant is re-pinned as "shaped route ≡ static route on every path"), KPR-312 effort channel, KPR-313 guard/persist suites — assertion meanings preserved except where tier-selection was itself the asserted behavior (removed/rewritten with spec citation, never weakened).
4. **Negative-verify:** (a) disable the haiku-skip condition → the haiku-static "never called" test must fail; (b) re-source limits from a classified tier (mutate `staticLimits` to a routeModel-derived value) → the static-limits pin must fail; (c) restore router-on limits to a degenerate path (e.g. system-sender) → the path-preservation pin must fail.

## 5. Sequencing & ticket mechanics

- **After KPR-314** (shared `model-router.ts` surface; 314's plan anchors on the `TIER_MODELS`/pricing constants and lands the registry transport this spec then builds on — §2's 314-sensitivity markers are the reconciliation map; re-anchor at delivery, Task-0 pattern).
- KPR-338 repurposed in place (this spec); original "switch-suppression" scope superseded — register note at delivery marks R-311.7/R-312.6's deferred policy as moot-by-removal. (Register location: the KPR-309 Linear epic — description canon section + per-merge `# Decision Register Entry` comments.)
- Escalation path: KPR-339 (separate brainstorm before spec).
