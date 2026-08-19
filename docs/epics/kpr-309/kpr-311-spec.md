# KPR-311 Spec — W3.2: Router→adapter seam unification

**Epic:** KPR-309 · **Depends on:** KPR-310 (verdict delivered: SAFE-WITH-CONSTRAINTS) · **Status:** draft

## TL;DR

`ModelRouterResult` gains optional `{provider?, effort?}`. `prepareSpawn` merges the per-turn router result with the agent's static `resolveProviderModel(agent.model)` route into one **effective per-turn route**, and `runOneSpawnAttempt`/`createProviderAdapter` consume that route instead of re-resolving the static `agent.model` prefix. In W3 the effective provider is **clamped to the static provider** (this is what keeps the KPR-306 breaker permit — acquired on the static provider before the router runs, per R7 — correct by construction). The KPR-310 verdict authorizes the mechanism: per-turn `model` on non-streaming resume is safe on SDK 0.2.104; the seam's only new obligation from the verdict is observability plumbing for the per-model cold-cache cliff (tier now reaches the activity audit), not policy. Mechanically small; no classifier, no policy, no per-provider hardening.

## Key Points

- **Two halves finally talk:** the tier router (KPR-224) emits a per-turn model that today reaches only `runner.send(modelOverride)` on the Claude path; the provider-adapter layer (KPR-231–234) picks its adapter and pilot model from the *static* `agent.model` prefix. This ticket routes one merged decision through both.
- **`ModelRouterResult` += `provider?: AgentProviderId`, `effort?: ReasoningEffort`** — both optional; absent = inherit from the agent's static route. `routeModel` itself sets neither in W3.2 (this ticket); `effort` is never merged into the route — Claude-path delivery arrives in W3.3 (KPR-312) via the `SpawnShaping.effortOverride` parallel channel (no lift needed), while **pilot** delivery remains gated on the §5 clamp/gate lift. *[amended at KPR-312 spec gate (driver reconciliation)]*
- **Provider clamp (W3 invariant):** effective provider ≡ static provider. A router result naming a different provider is ignored with a warning (model+effort dropped too). Load-bearing for R7: the breaker permit is acquired on the static provider as the first statement of the withSpawnTicket lambda, *before* the router runs; the clamp keeps `acquire()`/`record()` keyed correctly without moving anything across the R7 boundary. `providerFor()` (dispatcher outage gate, KPR-307) also stays consistent.
- **Router call gated to Claude-static agents.** ⚠ Behavior change (delegated, non-blocking): today a router-enabled pilot agent (e.g. `codex/gpt-5.5:medium`) still gets a `routeModel` call whose Claude-model output the pilot ignores — but it *is* charged `routerCostUsd` and, worse, the Claude model is misattributed as `model` in turn telemetry + activity audit. W3 skips the router when the static provider ≠ `claude`, fixing both.
- **`modelOverride` threading is kept, not collapsed** ⚠ (delegated, non-blocking): `AgentProviderTurnRequest.modelOverride` and `runner.send(..., modelOverride, ...)` stay as-is — the Claude adapter consumes it, pilots keep ignoring it. Adapter *construction* (already per-spawn-attempt) is what newly consumes the route.
- **Cache-cliff hook = observability, not policy:** the verdict's C1–C3 make a per-turn model decision a per-turn cache decision. The seam's contribution: `shaping` carries the router tier through to `activityLogger.modelTier` (today hardcoded `undefined` with a "not currently passed through" comment), and per-turn cache read/creation tokens are already in `turnTelemetryStore`. That is the full substrate W3.3's cost-aware classifier needs. No cost logic here (YAGNI).
- **Retry reuses the first routing decision** ⚠ (delegated, non-blocking): the auth-rebuild second attempt reuses `shaping` unchanged (post-W2 shape already does this) — no re-route, no double `routerCostUsd`, and exactly one breaker `record()` on the finalized attempt (R7).
- **D2 anchoring:** of the anchored surfaces, **only the `spawnTurn` lambda differs** between this worktree (HEAD `0963a2b`) and `origin/kpr-305` (`b0f2ba3`) — the W2 breaker wrap — plus `finalizeSpawnResult`'s additive `timedOut`/`aborted` passthrough (R4, read-only here). This spec anchors those two surfaces to the **post-W2 (kpr-305) shape** and everything else to HEAD (line refs labeled per-surface). Mandatory re-confirm at HEAD at delivery; W3 delivery gates on the W2 epic merge.

## Problem statement

Hive has two per-turn model mechanisms that never talk:

1. **Tier router** (`src/agents/model-router.ts`, KPR-224): `prepareSpawn` (HEAD `agent-manager.ts:1055-1070`) calls `routeModel(item.text, agentConfig.model, ...)` and derives `modelOverride = route.model !== agentConfig.model ? route.model : undefined`. That string threads through `AgentProviderTurnRequest.modelOverride` → `ClaudeAgentAdapter.runTurn` → `runner.send()` (`agent-runner.ts:1495-1496`, `effectiveModel = modelOverride ?? this.agentConfig.model`). Claude-only in effect: `TIER_MODELS` (`model-router.ts:46-50`) are all Claude ids.
2. **Provider-adapter layer** (KPR-231–234): `createProviderAdapter` (HEAD `agent-manager.ts:396-434`) calls `resolveProviderModel(config.model)` — the **static** agent definition — to pick the adapter class and to bake model + reasoning effort into pilot adapter constructors (`CodexSubscriptionAdapter` / `OpenAIAgentsAdapter` / `GeminiAdkAdapter`). Pilot `runTurn` implementations ignore `request.modelOverride` and `resourceLimits` entirely.

Consequences today: the router's decision is invisible to adapter selection; pilots receive (and drop) Claude-model overrides while the operator is charged for the router call and telemetry/audit record the wrong model; there is no seam through which a future provider/effort-aware classifier (W3.3) could act. KPR-310 proved the SDK side is safe (`query({resume, model})` — continuity, attribution, stable session id, tool carryover, fault cleanliness all held on 0.2.104), so the remaining work is purely this engine-side seam.

## Anchoring & branch discipline (D2)

Verified by `git diff HEAD origin/kpr-305` scoped to the seam files:

| Surface | HEAD `0963a2b` | `origin/kpr-305` `b0f2ba3` | Anchor used |
|---|---|---|---|
| `resolveProviderModel` / `ProviderModelRoute` | `agent-manager.ts:137-172` | `:148-183` (`resolveProviderModel` at `:156`) | identical — HEAD refs |
| `createProviderAdapter` | `:396-434` | `:416-454` | identical — HEAD refs |
| `runOneSpawnAttempt` | `:963-1003` | `:1027` | identical — HEAD refs |
| `prepareSpawn` | `:1017-1073` | `:1081` | identical — HEAD refs |
| `spawnTurn` lambda | `:538-591` | `:568-660` — **differs**: breaker `acquire()` first statement (`:577-581`), single `finalResult` try/catch, `record()` at `:639` (thrown) / `:643` (finalized), observability after | **kpr-305 shape** — implementation targets this |
| `recordSpawnObservability` | `:1082-1152` (modelTier `undefined` at `:1140`) | same body | identical — HEAD refs |
| `finalizeSpawnResult` | `:1154-…` | **differs**: additive `timedOut`/`aborted` passthrough into `TurnResult` (`:1267-1268`, R4) | **kpr-305 shape** — read-only for this ticket |
| `model-router.ts`, `provider-adapters/types.ts`, all four adapters | — | no diff | identical — HEAD refs |
| `RunResult` | — | kpr-305 adds `timedOut?` (R4, additive) + `llmMs` exists on both | n/a |
| New on kpr-305 only | — | `provider-circuit-breaker.ts`, `error-classification.ts` (R3: exports frozen — **read-only** for this ticket), `providerFor()` at `:544` | read-only |

**Delivery rule:** implementation branches from the epic branch *after* the W2 epic merge lands; at delivery, re-confirm every line reference above at then-HEAD before coding (mandatory per Gate 1 D2).

**Canon note:** epic KPR-309 is **pre-register** — it has no `## Decision Register — Canon` section of its own yet; every R1–R8 citation in this spec refers to **W2's register (KPR-305 @ `af74cf7`)**, which is binding but external canon. Consequently, the provider **clamp-lift decision is parked in this spec (§5) only** — it is *not* recorded in any decision register. Its expected pickup is **W3.5, the sidecar LLM registry ticket** (a work item, not a decision register); references to "W3.5" below mean that ticket.

## Design

### 1. Types

```ts
// provider-adapters/types.ts — neutral home (new)
export type ReasoningEffort = "minimal" | "none" | "low" | "medium" | "high" | "xhigh";
```

- `codex-subscription-adapter.ts` re-exports `export type CodexReasoningEffort = ReasoningEffort;` so the existing import in `agent-manager.ts` and adapter option types keep compiling unchanged. ⚠ Mechanical type move (delegated, non-blocking).
- `model-router.ts`:

```ts
import type { AgentProviderId } from "./provider-adapters/types.js";
import type { ReasoningEffort } from "./provider-adapters/types.js";

export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
  /** Absent ⇒ inherit the agent's static provider (resolveProviderModel(agent.model)).
   *  Dormant in W3: routeModel never sets it, AND even if set it is inert — a value
   *  matching the static provider is a no-op, a mismatch is clamped to static (§2/§5).
   *  Carriage-only until the §5 pilot-gate/clamp lift (the same lift that gates
   *  pilot effort delivery). */
  provider?: AgentProviderId;
  /** Dormant in W3.2 (this ticket): routeModel never sets it. Never merged into the
   *  route — the claude route variant carries no effort field; pilots never reach the
   *  merge (see §7). From W3.3 (KPR-312): routeModel emits it and prepareSpawn delivers
   *  it per-turn to the Claude adapter via SpawnShaping.effortOverride — a parallel
   *  channel like modelOverride. Pilot delivery still gated on the §5 lift.
   *  [amended at KPR-312 spec gate (driver reconciliation)] */
  effort?: ReasoningEffort;
}
```

The `types.ts → model-router.ts` import already exists (`ResourceLimits`); the reverse import is `import type` only, erased at compile time — no runtime cycle. `routeModel`'s signature and all its return sites are unchanged (optional fields, never set in W3.2 — W3.3 starts emitting `effort`). R3 untouched: no `error-classification.ts` change.

### 2. `prepareSpawn`: effective-route derivation

`prepareSpawn`'s return shape (currently `{prompt, modelOverride, resourceLimits, routerCostUsd}`) becomes:

```ts
interface SpawnShaping {
  prompt: string;
  /** Effective per-turn route — provider-clamped; consumed by createProviderAdapter. */
  route: ProviderModelRoute;
  /** Claude-path per-turn model when router chose ≠ static; threaded to runner.send + observability. Unchanged derivation. */
  modelOverride: string | undefined;
  /** Router tier for activity-audit modelTier (cache-cliff observability hook). */
  routerTier: ModelTier | undefined;
  resourceLimits: ResourceLimits | undefined;
  routerCostUsd: number;
}
```

Derivation, replacing the body at HEAD `:1055-1070`:

```
agentConfig = this.registry.get(ctx.agentId)                    // single registry read; MAY be undefined (SIGUSR1 hot-reload race — see guard note)
staticRoute = resolveProviderModel(agentConfig?.model ?? "")    // GUARD: mirrors the kpr-305:577 acquire pattern (`?.model ?? ""`); pure, never throws
if (!agentConfig || !modelRouter.enabled || sender === "system" || staticRoute.provider !== "claude"):
    → { route: staticRoute, modelOverride: undefined, routerTier: undefined, resourceLimits: undefined, routerCostUsd: 0 }
else:
    result = await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers)   // unchanged call, try/catch unchanged
    if (result.provider !== undefined && result.provider !== staticRoute.provider):
        log.warn("router provider ignored — cross-provider per-turn routing unsupported (W3 clamp)")
        → { route: staticRoute, modelOverride: undefined, routerTier: result.tier, resourceLimits: result.resourceLimits, routerCostUsd: result.costUsd }
    route = { provider: "claude", model: result.model }         // typechecks on the claude variant — it carries NO reasoningEffort field,
                                                                // so effort is never merged into the route; W3.3 (KPR-312) carries it
                                                                // beside the route via SpawnShaping.effortOverride
                                                                // [amended at KPR-312 spec gate (driver reconciliation)]
    modelOverride = result.model !== agentConfig.model ? result.model : undefined   // unchanged rule
    → { route, modelOverride, routerTier: result.tier, resourceLimits: result.resourceLimits, routerCostUsd: result.costUsd }
```

- **Missing-agentConfig throw-safety (guard choice: mirror the acquire pattern's `?? ""`, not just the existing `if (agentConfig)`):** `prepareSpawn` executes **between** the breaker `acquire()` (kpr-305 `:577-581`) and the recording try/catch (kpr-305 `:631` ff.). SIGUSR1 hot-reload can remove the agent between `spawnTurn`'s registry pre-check and this point; an unguarded `agentConfig.model` dereference would throw a TypeError that **skips `record()`** and can wedge a half-open probe permit for up to `PROBE_STALE_MS` (360s). The `?.model ?? ""` form is chosen because it (a) never throws, (b) is the same expression as the acquire site's resolution, so `permit.provider ≡ shaping.route.provider` holds **whenever both reads observe the same registry state** — the two reads are temporally separate, so in the removal race itself the invariant can break for a *pilot*-static agent (permit acquired on codex/openai/gemini, degenerate shaping route `""` → `{provider: "claude", model: ""}`); that mismatch is benign because the turn fails inside the recorded try (`Unknown agent` → `classifyThrown` → `non-provider`), which never trips the breaker — and (c) the `!agentConfig` disjunct keeps the router from running. The turn then fails inside the recorded try — `createProviderAdapter`'s `Unknown agent` throw — where `classifyThrown` + `record()` fire normally.

- **Voice carve-out** (HEAD `:1028-1030`) stays the first branch and now returns `route: staticRoute` with everything else empty — voice keeps bypassing prepending + router entirely (KPR-219; pinned by the existing carve-out test).
- **Clamp-path bookkeeping:** on a clamped (mismatched-provider) result, `routerCostUsd` is still added to the turn cost (the call happened) and `routerTier` still reaches the audit; only the model/effort decision is dropped. In W3 this branch is unreachable in production (router never sets `provider`) — it exists so W3.3 lands against defined semantics, and it gets a unit test now.
- **Pilot gate:** `staticRoute.provider !== "claude"` short-circuits *before* `routeModel` — no router call, no cost, no misattributed override. This is the D3 precedence rule made concrete: an adapter that cannot switch per-turn simply never receives a per-turn decision.
- **Stale docstring (plan fixes in passing):** `prepareSpawn`'s KPR-224 docstring still says it serves "both `spawnTurn` (per-turn path) and `processQueue` (legacy path)" — `processQueue` is gone post-KPR-220 and `spawnTurn` is the single caller at HEAD. The plan should correct the comment while rewriting this body.

### 3. `createProviderAdapter` consumes the route

Signature: `createProviderAdapter(agentId: string, route: ProviderModelRoute)` (single call site; parameter required, no default — YAGNI). Body change: delete `const route = resolveProviderModel(config.model)` (HEAD `:401`); use the passed route for the adapter-class switch and pilot constructor `model`/`reasoningEffort`. Everything else (runner construction, `buildPilotInstructions`, config fallbacks like `appConfig.codex.agentModel`) is unchanged.

In W3 the passed route is behaviorally identical to the static resolution for pilots (router never runs for them) and differs for Claude only in that it *may* carry the routed model — which the Claude branch doesn't read (the runner gets the model via `modelOverride`; see §4). The point of the signature change is that the static `agent.model` prefix is now resolved in exactly one place per turn (`prepareSpawn`), and `agree(breaker-acquire-route, shaping.route.provider)` becomes a testable invariant rather than a coincidence of two call sites — scoped to turns where both registry reads observe the same state; the SIGUSR1 removal race can benignly violate it (see §2 guard note), so tests must not assert it across a mid-turn registry mutation.

### 4. `runOneSpawnAttempt` and `modelOverride` threading

At HEAD `:977`: `const adapter = this.createProviderAdapter(ctx.agentId)` → `this.createProviderAdapter(ctx.agentId, shaping.route)`. The `adapter.runTurn({... modelOverride: shaping.modelOverride, resourceLimits: shaping.resourceLimits ...})` call is **unchanged**.

Decision — *threading kept, not collapsed*: `AgentProviderTurnRequest.modelOverride` remains the Claude-path per-turn model channel (`agent-runner.ts:1495-1496` is tested code; collapsing the model into `AgentRunner`/`ClaudeAgentAdapter` construction would touch the runner's signature for zero behavior gain). Pilots continue to ignore `modelOverride`/`resourceLimits` at `runTurn` — with the pilot gate in §2, they now correctly never receive one. Provider + static (suffix-parsed) effort ride the route into *construction*, which is already per-spawn-attempt (fresh adapter per attempt, HEAD `:974-977`), so no lifecycle change is needed anywhere.

### 5. R7 interaction (breaker wrap-point)

Post-W2 lambda order (kpr-305 `:568-660`): breaker `acquire()` on `resolveProviderModel(static).provider` → sessionId re-resolve → `prepareSpawn` (router) → `runOneSpawnAttempt` (+ auth-rebuild retry) → exactly one `record()` on the finalized attempt. This ticket **moves nothing across that boundary**:

- The router stays inside `prepareSpawn`, after `acquire()` — exactly where the KPR-310 verdict says the model choice can keep binding ("the resumed session accepts any model at turn boundary").
- The provider clamp guarantees `shaping.route.provider === permit.provider` (both derive from the same pure `resolveProviderModel(agentConfig.model)`), so `record()` classification stays keyed to the provider that actually ran. **Lifting the clamp later requires re-keying or moving `acquire()` — explicitly out of scope. This clamp-lift decision is parked here (this spec, §5) and nowhere else — the epic has no decision register yet (see Canon note) — with expected pickup by W3.5, the sidecar LLM registry *ticket*.**
- The auth-rebuild retry reuses `shaping` (kpr-305 `:611-627` already does) — same route, same model, no re-route; the breaker records only the finalized attempt. A re-route on retry would double `routerCostUsd` and make "which model ran this turn" ambiguous for telemetry.

### 6. Cold-cache-cliff policy hook (verdict C1–C3)

The verdict frames switch cost as a router-*policy* input; the epic's W3.3 owns policy. This ticket's whole obligation is that the seam exposes enough to build it:

1. **Decision object reaches the seam:** `ModelRouterResult` (tier, model, cost, provider?, effort?) flows intact into `prepareSpawn`'s merge — effort is never merged into the route, and a mismatched `provider` is clamped; only tier/model/cost/limits flow onward through the route in this ticket. W3.3 (KPR-312) changes what `routeModel` returns and delivers `effort` on the Claude path via the `SpawnShaping.effortOverride` parallel channel (no lift needed, per §7); delivering `provider` — or `effort` to a **pilot** — remains gated on the clamp/gate lift parked in §5. *[amended at KPR-312 spec gate (driver reconciliation)]*
2. **Per-turn switch visibility:** `recordSpawnObservability` sets `modelTier: shaping.routerTier` in the activity audit (HEAD `:1140` today: `modelTier: undefined // Model router tier not currently passed through`). Signature: pass `shaping` (or add the tier param) — implementation detail for the plan.
3. **Switch cost is already measurable:** `turnTelemetryStore` records `cacheReadTokens`/`cacheCreationTokens` per turn (HEAD `:1101-1102`); a cold switch shows as `cacheRead=0, cacheCreation≫0` exactly as in the spike's M2/M4/M6 rows.

No cost model, no TTL tracking, no switch-suppression logic in this ticket.

### 7. Effort contract: today vs later

- **Today (this ticket):** `effort?` exists on `ModelRouterResult` but is never set. Static effort still comes from the `:suffix` parse in `resolveProviderModel`/`splitProviderModel` and reaches the codex pilot constructor via the route. The Claude adapter ignores effort entirely (hive sets no `thinking` config; verdict M9 is informative-only); the claude `ProviderModelRoute` variant deliberately gains **no** `reasoningEffort` field. `OpenAIAgentsAdapter` continues not receiving `reasoningEffort` in its constructor call — pre-existing shape, not changed here.
- **Later — honest statement of the dependency:** under this design, a router-set `effort` can **never** reach a pilot constructor: the pilot gate (§2) means `routeModel` never runs for non-Claude-static agents, and the clamp (§5) forbids routing *to* a pilot provider — so the §2 merge branch is only ever reachable for Claude-static agents, whose route variant carries no effort. Activating `effort?` for a **pilot** therefore depends on lifting the pilot gate and/or the provider clamp — the same decision parked in §5 for W3.5 (the sidecar LLM registry ticket). The **Claude** path needs no lift: W3.3 (KPR-312) emits `effort` and delivers it per-turn via `SpawnShaping.effortOverride` → `AgentProviderTurnRequest.effort` → an effort mapping in `ClaudeAgentAdapter`/runner — a parallel channel beside the route, mirroring `modelOverride`, leaving the clamp, gate, and route shape untouched. This seam's (W3.2's) own contract remains **carriage, not interpretation or delivery**. *[amended at KPR-312 spec gate (driver reconciliation) — the original clause gated delivery "to any adapter" on the §5 lift; that gate is pilot-only.]*

## D3: non-Claude adapters (pilot-grade)

Precedence/fallback rule, explicit: **static agent.model prefix wins for any non-Claude provider.**

| Case | Behavior |
|---|---|
| Static provider ≠ claude (codex/openai/gemini) | Router skipped entirely; route = static; pilot constructed exactly as today |
| Router result carries `provider` ≠ static provider | Clamped: warn once per occurrence, model+effort dropped, static route used; cost/tier still recorded. **Routed `resourceLimits` are retained**: they are provider-agnostic runner-side execution bounds (timeout/turns/budget) for the Claude turn that actually executes — dropping them would silently strip the tier's guardrails while still charging the router call; only the model/effort decision would mis-key the adapter/breaker, so only it is dropped |
| Router result carries `provider` === static provider (or absent) | Normal merge (§2) |

Rationale: pilots are constructor-baked per D3 and stay pilot-grade in W3; the dispatcher outage gate (`providerFor`) and breaker permit both key on the static provider; and `TIER_MODELS` can only name Claude models anyway. Per-provider hardening (per-provider tier tables, effort maps, cross-provider cost policy) is out of scope.

## Edge cases

| Case | Behavior |
|---|---|
| `modelRouter.enabled: false` | Route = static, `modelOverride`/`routerTier` undefined, zero router cost — byte-identical adapter behavior to today (existing test pins the `runner.send` args) |
| `sender === "system"` (scheduler/cron) | Same as disabled — gate unchanged (HEAD `:1058`) |
| Voice (`ctx.channel === "voice"`) | Carve-out branch returns static route, raw prompt, no router — unchanged semantics (KPR-219; pinned by existing test). Voice's direct `spawnTurn` + `systemPromptOverride` path untouched |
| Agent ceiling | Unchanged: `routeModel` caps at `modelToTier(agentConfig.model)` (`model-router.ts:195-200`). With the pilot gate, the ceiling heuristic now only ever sees Claude ids, where its substring match is sound |
| Router returns model === `agentConfig.model` | `modelOverride` undefined (unchanged rule); runner uses the agent default; audit records static model + routed tier |
| `routeModel` throws / times out / parse-fails | Internal sonnet fallback and prepareSpawn's try/catch unchanged — result is still a Claude model, merge proceeds normally |
| Auth-rebuild retry (2nd attempt) | Reuses first attempt's `shaping` — same route/model/effort, no re-route, one `record()` on the finalized attempt (R7) |
| Bogus routed model id (verdict M8 shape) | SDK throws; classifies `non-provider` per frozen R3 taxonomy — breaker-safe; distinguishable `bad-model` kind is W3.3's (KPR-312's) call, not this seam's |
| Non-Claude agent + router enabled | **Changed:** router skipped (was: called, output ignored by pilot, Claude model misattributed in telemetry/audit, cost charged). New behavior: no call, static pilot model in audit |
| Unknown agent id / SIGUSR1 hot-reload race | `prepareSpawn` never throws on a missing agent (`?.model ?? ""` guard, §2) — the degenerate static route flows on and `createProviderAdapter`'s `Unknown agent` throw fires **inside** the recorded try, so `classifyThrown` + breaker `record()` run and no probe permit wedges (`spawnTurn` still pre-checks the registry for the common case) |

## Non-goals

- **No classifier changes** — `routeModel`'s prompt, tiers, ceiling logic, fallback: untouched (W3.3 / KPR-312).
- **No session-identity guards** (W3.4 / KPR-313) — `finalizeSpawnResult`/sessionStore untouched.
- **No provider/model registry** (W3.5, the sidecar LLM registry ticket) — `TIER_MODELS` stays a hardcoded Claude table.
- **No per-provider hardening** (D3) — pilots stay pilot-grade; no per-provider tier tables or effort maps.
- **No cost-aware routing policy** — observability substrate only (§6).
- **No cross-provider per-turn switching** — clamped (§5); lifting it is future work tied to breaker re-keying.
- **No streaming `setModel()` path** — verdict ruled it unnecessary (not UNSAFE); non-streaming resume only.
- **No R3/R4 surface changes** — `error-classification.ts` read-only; `RunResult` additions not needed here.

## Testing surface

**"Both sides are tested code" — what actually pins current behavior:**

- `src/agents/agent-manager.test.ts`
  - `passes resource limits from router to runner.send()` (~`:601`) and the disabled-router sibling (~`:625`) — pin the exact 7-arg `runner.send` shape incl. `modelOverride`/`resourceLimits` position.
  - `calls model router and uses override + resourceLimits in runner.send` (~`:2020`), `adds router cost to TurnResult.usage.costUsd` (~`:2047`) — pin override derivation + cost addition.
  - `routes codex-prefixed agents to the Codex subscription adapter` (~`:2070`) — pins pilot constructor args `{model: "gpt-5.5", reasoningEffort: "medium"}` **and** `runTurn({modelOverride: undefined})` (router disabled in that test).
  - `routes %s through the matching pilot adapter` (openai / gemini / openai-codex, ~`:2105`) — pins adapter-class selection from the static prefix.
  - `voice carve-out: passes raw text ... skips model router` (~`:2185`) — pins the carve-out.
  - Observability test (~`:2135`) — pins telemetry/index/audit payloads.
- `src/agents/model-router.test.ts` — `resolveResourceLimits` only; `routeModel` is mocked everywhere else, so the `ModelRouterResult` field additions are type-level and need no router-side test until W3.3.
- `src/agents/provider-adapters/claude-agent-adapter.test.ts` — pins the `runTurn`→`send` delegation shape (7 args in order).
- Pilot adapter tests (`codex-subscription-adapter.test.ts`, `openai-agents-adapter.test.ts`, `gemini-adk-adapter.test.ts`) — pin constructor-option consumption; unchanged.
- **Post-W2 merge:** kpr-305 adds ~150 lines to `agent-manager.test.ts` (breaker acquire/record ordering, `providerFor`) — the implementation must keep these green; they encode R7.

**New tests the plan must add:**

1. Unit — route derivation in `prepareSpawn`: router-on merge (routed model on a claude route that carries no effort — including that a router-set `effort` is never merged into the route; in W3.2, before KPR-312's `effortOverride` channel, the turn is byte-identical to a no-effort route), router-off/static passthrough, `sender === "system"` skip (currently unpinned!), pilot gate (`routeModel` **not** called for `codex/...` agent with router enabled), voice static route.
2. Unit — provider clamp: mocked `routeModel` returning `provider: "openai"` for a Claude-static agent → static route used, warn logged, cost/tier still recorded.
3. Unit — `createProviderAdapter(agentId, route)`: Claude route → `ClaudeAgentAdapter`; pilot route → pilot constructor receives `route.model`/`route.reasoningEffort` (not a re-resolve of `config.model`).
4. Integration (spawn path) — auth-rebuild retry calls `routeModel` exactly once (route reuse across attempts).
5. Observability — `activityLogger.record` receives `modelTier` = routed tier when router on, `undefined` when off; pilot-agent audit records the pilot's static model (regression test for the misattribution fix).
6. Invariant — breaker permit provider === `shaping.route.provider` for claude and pilot agents **under stable registry state** (post-W2 merge; asserts the clamp holds at the R7 wrap point). Do **not** assert this across a mid-turn registry mutation — the SIGUSR1 removal race legitimately violates it for pilot-static agents (benign; covered by test 7 instead).
7. Throw-safety — registry entry removed after `spawnTurn`'s pre-check (SIGUSR1 hot-reload race): `prepareSpawn` returns the degenerate static route without throwing; the `Unknown agent` failure surfaces inside the recorded try (breaker `record()` observed exactly once, no wedged probe permit).

## ⚠ Delegated assumptions

1. ⚠ **Provider clamp** — router cannot switch providers in W3; mismatched `provider` → static wins + warn. Derived from R7 + D3. *Non-blocking.*
2. ⚠ **Pilot router gate** — `routeModel` skipped when static provider ≠ claude; behavior change that removes a wasted classifier call and fixes model misattribution in telemetry/audit for router-enabled pilot agents. *Non-blocking.*
3. ⚠ **`modelOverride` threading kept** — no collapse into runner/adapter constructors; `AgentProviderTurnRequest` unchanged. *Non-blocking.*
4. ⚠ **Retry reuses first routing decision** — no re-route on the auth-rebuild second attempt. *Non-blocking.*
5. ⚠ **`activityLogger.modelTier` fill is in-scope** — one-line close of an existing TODO in the touched function, mandated by the verdict's policy-input framing as the observability hook. *Non-blocking.*
6. ⚠ **`ReasoningEffort` moves to `provider-adapters/types.ts`** with `CodexReasoningEffort` back-compat alias. *Non-blocking, mechanical.*
7. ⚠ **`routeModel` never sets `provider`/`effort` in W3.2 (this ticket)** — fields land dormant here; W3.3 (KPR-312) emits `effort` and delivers it on the **Claude** path via the `SpawnShaping.effortOverride` parallel channel (§7); `provider` stays dormant, and **pilot** effort delivery remains gated on the §5 lift. *Non-blocking. [amended at KPR-312 spec gate (driver reconciliation)]*

No blocking product ambiguity found — Gate 1 D2/D3 plus the KPR-310 verdict cover every decision above.
