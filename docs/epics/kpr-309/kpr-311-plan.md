# KPR-311 — Implementation Plan: Router→adapter seam unification (W3.2)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** `docs/epics/kpr-309/kpr-311-spec.md` (approved after 3 review rounds — authoritative; ⚠-flagged assumptions are settled, do not re-litigate).
**Epic:** KPR-309 (pre-register epic — no Decision Register of its own; R3/R4/R7 citations bind from W2's register, KPR-305 @ `af74cf7`). The provider clamp-lift decision is parked in the spec §5 only; expected pickup W3.5 (sidecar LLM registry ticket).

> **DELIVERY-CONTEXT NOTE (read first):** W3 is maturity-only right now. This plan executes **later**, after the W2 epic (`kpr-305`) merges to `main` and the operator re-opens W3 delivery. All code in this plan targets the **post-W2 shape** of `agent-manager.ts` — i.e. the `spawnTurn` lambda with the KPR-306 breaker wrap (`acquire()` first statement, single `finalResult` try/catch, exactly one `record()` per spawnTurn, single `recordSpawnObservability` call site) and `finalizeSpawnResult` with the additive `timedOut`/`aborted` passthrough (R4, read-only here). Line references labeled `kpr-305:` are from `origin/kpr-305` @ `b0f2ba3` at spec time; **Task 0 re-confirms every anchored surface at the then-current delivery HEAD before any edit** and defines the escape hatch if drift is found. Edits below anchor on unique code strings, not line numbers, so they survive line drift.

## Goal

`ModelRouterResult` gains dormant carriage-only `{provider?, effort?}`; `prepareSpawn` derives one **effective per-turn route** (router merged with the static `resolveProviderModel(agent.model)` route, provider-clamped to static); `createProviderAdapter`/`runOneSpawnAttempt` consume that route instead of re-resolving; the router is gated to Claude-static agents (fixes pilot cost-charge + telemetry/audit model misattribution); `activityLogger.modelTier` is filled (cache-cliff observability, KPR-310 C1–C3); the auth-rebuild retry reuses the first routing decision. No classifier changes, no policy, no non-Claude hardening, no registry.

## Architecture

Everything lands in the existing spawn pipeline inside `src/agents/agent-manager.ts`: `prepareSpawn` becomes the single place per turn that resolves the static `agent.model` prefix and merges the router decision into a `SpawnShaping.route`, which `runOneSpawnAttempt` passes into `createProviderAdapter(agentId, route)`. The KPR-306 breaker wrap is untouched — `acquire()` stays the first statement of the `withSpawnTicket` lambda (before the router), one `record()` fires on the finalized attempt, and the W3 provider clamp keeps `permit.provider ≡ shaping.route.provider` under stable registry state. A `?.model ?? ""` guard (mirroring the acquire site) makes `prepareSpawn` throw-free against the SIGUSR1 hot-reload removal race so a missing agent always fails **inside** the recorded try.

## Tech Stack

- TypeScript strict (no `any` without justification), Node 22+, ESM
- Vitest, tests beside source (`src/**/*.test.ts`) — existing `agent-manager.test.ts` mock harness (mocked `AgentRunner`, pilot adapter constructor spies, module-mocked `routeModel`)
- Logging via `createLogger` (`src/logging/logger.ts`)
- No new dependencies, no config keys, no DB schema changes

**Out of scope (do not touch):** `routeModel`'s classifier/prompt/tiers/fallback (`model-router.ts` logic — only the `ModelRouterResult` interface + type imports change), `error-classification.ts` (R3 frozen — read-only), `finalizeSpawnResult` / `RunResult` (R4 — read-only), `provider-circuit-breaker.ts`, `providerFor()`, sessionStore, all four adapter `runTurn` implementations, `AgentProviderTurnRequest` (⚠3: `modelOverride` threading kept, not collapsed), `agent-runner.ts`.

---

## Testing Contract

### Required Test Groups

**Unit — `required`** — all in `src/agents/agent-manager.test.ts` (everything under test runs through `spawnTurn` against the existing mock harness; `model-router.test.ts` needs no change — `routeModel` is module-mocked everywhere and the `ModelRouterResult` field additions are type-level until W3.3). The spec's numbered tests 1–7:

1. **Route derivation in `prepareSpawn`** — `src/agents/agent-manager.test.ts`, new `describe("router→adapter seam (KPR-311)")` nested in `spawnTurn shaping (KPR-224)`. Minimum assertions: (a) router-on merge — routed model reaches `runner.send` as `modelOverride`, routed `resourceLimits` reach position 6, and a router-set `effort` is dropped (turn behaves byte-identically to a no-effort route); (b) `sender === "system"` skip — `routeModel` not called, override/limits undefined (**currently unpinned**); (c) pilot gate — `routeModel` **not** called for a `codex/...` agent with router enabled, pilot constructor still gets static `{model, reasoningEffort}`; (d) router-off static passthrough and voice static route stay pinned by existing tests (`:625`, `:2182` — regression surface, not new code).
2. **Provider clamp** — same describe. Mocked `routeModel` returns `provider: "openai"` for a Claude-static agent → Claude adapter runs (OpenAI pilot constructor NOT called), `modelOverride` undefined, routed `resourceLimits` **retained** (D3), router cost added to `usage.costUsd`, `modelTier` still reaches the audit, clamp warning logged with `routerProvider`/`staticProvider`.
3. **`createProviderAdapter(agentId, route)` consumes the passed route** — same describe. Registry model mutated mid-turn (inside the `formatFilesForPrompt` mock, i.e. after `prepareSpawn`'s route resolution, before adapter construction): pilot constructor receives the **shaping route's** model/effort, not a re-resolve of the live `config.model`. (This test fails against pre-change code — negative-verify property.)
4. **Auth-rebuild retry reuses the routing decision** (integration through the spawn path) — same describe. First attempt returns `401 Unauthorized` with a resumable session, retry succeeds: `routeModel` called exactly once, both `runner.send` calls carry the same `modelOverride`.
5. **Observability `modelTier` fill** — same describe. Router on → `activityLogger.record` gets `modelTier` = routed tier; router off → `undefined`; router-enabled **pilot** agent → audit `model` is the pilot's static definition model and `routeModel` was never called (regression test for the misattribution fix).
6. **R7 invariant: breaker permit provider === effective route provider** — new `describe("router→adapter seam invariants (KPR-311)")` nested in `spawnTurn (KPR-216)` (post-W2 breaker surface). `acquire` spied: `"claude"` for a Claude-static agent whose turn runs the Claude adapter; `"codex"` for a pilot whose turn constructs the codex adapter. **Stable registry state only** — do NOT assert across a mid-turn registry mutation (the SIGUSR1 race legitimately violates it for pilot-static agents; benign, covered by test 7).
7. **Throw-safety under the SIGUSR1 removal race** — same describe. Agent vanishes from the registry immediately after breaker `acquire()`: `prepareSpawn` returns the degenerate static route **without throwing**, the `Unknown agent` failure surfaces inside the recorded try, breaker `record()` observed **exactly once** with a `non-provider` classification, breaker stays closed (`consecutiveHardFaults === 0`), and a subsequent turn on the same thread succeeds (no wedged probe permit, no lock leak).

**Integration — judged: not required beyond the above.** The spawn path is covered by the existing `agent-manager.test.ts` suite with mocked runners/adapters — tests 4, 6, 7 above run the **full** `spawnTurn` pipeline (ticket HOF, breaker wrap, shaping, adapter construction, retry, observability) at the highest fidelity available without a live SDK. No live-SDK integration is required: KPR-310's spike already proved the SDK-side behavior (`query({resume, model})` SAFE-WITH-CONSTRAINTS on 0.2.104), and this ticket adds **no new SDK call shape** — `modelOverride` threading to `runner.send` is byte-identical and already pinned by `claude-agent-adapter.test.ts`.

**E2E — `not-required`.** No user-facing flow changes. The only behavior change (pilot router gate) is cost/telemetry-only and fully observable at the unit surface; channels, dispatcher, and voice paths are untouched.

### Critical Flows
1. Claude-static agent, router on → routed model reaches `runner.send(modelOverride)`, routed limits reach `resourceLimits`, tier reaches `activityLogger.modelTier`, router cost reaches `usage.costUsd`.
2. Pilot agent (codex/openai/gemini static), router on → **no** router call, no cost, pilot constructed from static route, audit records the static pilot model.
3. Clamped router result (mismatched `provider`) → static route used, warn logged, model+effort dropped, `resourceLimits` retained, cost/tier recorded.
4. Auth-rebuild retry → same `shaping` (one route, one `routerCostUsd`), one breaker `record()` on the finalized attempt (R7).
5. SIGUSR1 mid-turn agent removal → no throw before the recorded try, no wedged permit.

### Regression Surface (must stay green, unmodified)
- `src/agents/agent-manager.test.ts` — `runner.send` 7-arg shape (`:601`, `:625`), router override + cost (`:2020`, `:2047`), pilot adapter routing (`:2070`, `:2103` `it.each`), observability payloads (`:2134`), voice carve-out (`:2182`), **post-W2:** `provider circuit breaker at the wrap point (KPR-306)` describe (acquire/record ordering, record-once under retry, fast-fail) + `providerFor + TurnResult timedOut/aborted propagation (KPR-307)` describe — these encode R7/R4.
- `src/agents/model-router.test.ts` — `resolveResourceLimits` only; untouched.
- `src/agents/provider-adapters/claude-agent-adapter.test.ts` — `runTurn`→`send` 7-arg delegation.
- `src/agents/provider-adapters/codex-subscription-adapter.test.ts`, `openai-agents-adapter.test.ts`, `gemini-adk-adapter.test.ts` — constructor-option consumption (the `CodexReasoningEffort` alias must keep these compiling unchanged).
- Post-W2: `src/agents/provider-circuit-breaker.test.ts`, `src/agents/provider-adapters/error-classification.test.ts`, `src/agents/circuit-breaker-heartbeat.test.ts`, `src/agents/agent-runner.test.ts` — read-only surfaces; any failure here means this change leaked across the R7/R3/R4 boundary.

### Commands
```bash
# Targeted (after each task)
npx vitest run src/agents/agent-manager.test.ts
npx vitest run src/agents/model-router.test.ts src/agents/provider-adapters/

# Full gate (Task 0 baseline + final task; env stubs required by config load in tests)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: all suites pass; `check` = typecheck + lint + format + test, zero failures.

### Harness Requirements
- Existing `agent-manager.test.ts` mock harness only: module-mocked `AgentRunner` (`mockRunnerSend`), hoisted pilot constructor spies (`mockCodexConstructor` etc.), module-mocked `routeModel`, mock registry with live `_agents` map, post-W2 real `ProviderCircuitBreakerRegistry` on the manager (`manager.circuitBreakers` is `readonly` public — spy with `vi.spyOn`).
- One harness tweak (Task 3): the logger mock's `warn` becomes a hoisted shared spy so the clamp warning is assertable. No other mock changes; no DB, no network, no live SDK.

### Non-Required Rationale
- No `model-router.test.ts` additions: `routeModel` never sets `provider`/`effort` in W3 (⚠7) — the fields are type-level carriage; testing them router-side would test nothing until W3.3.
- No adapter test changes: adapter `runTurn`/constructor contracts are unchanged; the alias keeps types identical.
- No E2E/live-SDK: see Integration/E2E judgments above.

### Verification Rules
1. A missing harness is not a skip reason — if a listed test doesn't exist at a task's Verify step, write it; do not mark the task done without running the listed commands and seeing the expected output.
2. When a test fails, fix the implementation, not the test — unless the test contradicts the spec's pinned semantics (clamp, pilot gate, effort-drop, R7 ordering), in which case the spec wins.
3. Spec/plan mismatch demotes to the spec lane: if executing this plan surfaces a conflict with `kpr-311-spec.md` (or Task 0 finds anchored-surface drift), stop and route the ticket back through dodi-dev:mature-ticket with a drift note — do not improvise a resolution in the delivery lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/agents/provider-adapters/types.ts` | modified | Neutral home for `ReasoningEffort` (new export) |
| `src/agents/provider-adapters/codex-subscription-adapter.ts` | modified | `CodexReasoningEffort` becomes a back-compat alias of `ReasoningEffort` |
| `src/agents/model-router.ts` | modified | `ModelRouterResult` += dormant `provider?`/`effort?` + JSDoc; type-only imports from `provider-adapters/types.js`. **No logic changes.** |
| `src/agents/agent-manager.ts` | modified | `SpawnShaping` interface; `prepareSpawn` rewrite (static-route-once, pilot gate, clamp, `?? ""` guard, docstring fix); `createProviderAdapter(agentId, route)`; `runOneSpawnAttempt` consumption; `recordSpawnObservability` signature + `modelTier` fill; `spawnTurn` observability call site; `ModelTier` type import |
| `src/agents/agent-manager.test.ts` | modified | Logger-warn capture tweak; new tests 1–7 in two nested describes |

No new files. One commit per task; every task leaves the tree green (`npm run typecheck` + scoped tests).

---

## Task 0 — Re-confirm anchored surfaces at delivery HEAD (mandatory, Gate 1 D2)

**Goal:** prove the post-W2 worktree matches every surface this plan's edits anchor on, before touching anything.

- [ ] Confirm delivery preconditions: you are in the W3 delivery worktree, branched from the epic branch **after** the W2 epic (`kpr-305`) merged. `git log --oneline -5` should show W2 history (KPR-306/307/308 commits or the W2 merge) beneath your branch point. If W2 is not in history: **STOP — the ticket's delivery gate has not been met.**
- [ ] Re-confirm each anchored surface by content (line numbers will have drifted; the strings must match exactly):

```bash
# 1. createProviderAdapter — old signature + internal re-resolve both present, once each:
grep -n 'private createProviderAdapter(agentId: string): AgentProviderAdapter' src/agents/agent-manager.ts
grep -n 'const route = resolveProviderModel(config.model);' src/agents/agent-manager.ts

# 2. Breaker wrap point (kpr-305:577-581 shape) — acquire first statement, static-provider keyed:
grep -n 'resolveProviderModel(this.registry.get(ctx.agentId)?.model ?? "")' src/agents/agent-manager.ts
grep -n 'this.circuitBreakers.acquire(route.provider' src/agents/agent-manager.ts

# 3. Record-once shape (kpr-305:639/:643) — exactly two record sites, thrown + finalized:
grep -n 'this.circuitBreakers.record(permit' src/agents/agent-manager.ts   # expect 2 hits

# 4. Single observability call site on the finalized result (kpr-305:646):
grep -n 'this.recordSpawnObservability(effectiveCtx, shaping.prompt, shaping.modelOverride' src/agents/agent-manager.ts   # expect 1 hit

# 5. prepareSpawn router block + stale docstring (kpr-305:1081 region):
grep -n 'appConfig.modelRouter.enabled && item.sender !== "system"' src/agents/agent-manager.ts
grep -n 'processQueue' src/agents/agent-manager.ts    # expect 4 hits on the kpr-305 shape: prepareSpawn docstring (1), recordSpawnObservability docstring (2), reflection swallow comment (1 — stays)

# 6. modelTier TODO (kpr-305 recordSpawnObservability):
grep -n 'modelTier: undefined, // Model router tier not currently passed through' src/agents/agent-manager.ts

# 7. runOneSpawnAttempt adapter construction:
grep -n 'const adapter = this.createProviderAdapter(ctx.agentId);' src/agents/agent-manager.ts

# 8. Types anchors:
grep -n 'export type CodexReasoningEffort =' src/agents/provider-adapters/codex-subscription-adapter.ts
grep -n 'export interface ModelRouterResult' src/agents/model-router.ts
grep -n 'export type AgentProviderId' src/agents/provider-adapters/types.ts

# 9. Read-only canon surfaces exist (R3/R7 — do not edit):
ls src/agents/provider-circuit-breaker.ts src/agents/provider-adapters/error-classification.ts
grep -n 'providerFor(agentId: string)' src/agents/agent-manager.ts
```

Every grep must hit (with the stated counts). Also open `prepareSpawn` and visually confirm its body still matches the pre-KPR-311 shape quoted in Task 2's "old code" blocks (voice carve-out first branch; prompt shaping; `let modelOverride ... if (appConfig.modelRouter.enabled ...)` block; 4-field return).

- [ ] Confirm the test-file anchors: `grep -n 'provider circuit breaker at the wrap point (KPR-306)' src/agents/agent-manager.test.ts` and `grep -n 'spawnTurn shaping (KPR-224)' src/agents/agent-manager.test.ts` both hit; `grep -n 'vi.mock("../logging/logger.js"' src/agents/agent-manager.test.ts` hits.
- [ ] Baseline gate:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: fully green before any edit.

**Escape hatch (drift found):** if any grep misses, hits a different count, or `prepareSpawn`'s body has been touched by an intervening ticket — **make no edits**. Demote the ticket to the spec lane (dodi-dev:mature-ticket) with a drift note listing exactly which anchors failed and what is there instead. The spec's anchoring section makes this re-confirm mandatory; improvising against drifted surfaces is out of contract.

**Commit:** none (read-only task).

---

## Task 1 — Types: neutral `ReasoningEffort` + dormant `ModelRouterResult` carriage fields

**Goal:** land the type layer (⚠6, spec §1). Pure type moves + additions; zero behavior.

- [ ] **`src/agents/provider-adapters/types.ts`** — add after the `AgentProviderId` export:

```ts
/**
 * Neutral reasoning-effort scale (KPR-311). Canonical home — pilot adapter
 * options and ModelRouterResult carriage both reference this. Values mirror
 * the codex effort suffix scale parsed by splitProviderModel.
 */
export type ReasoningEffort = "minimal" | "none" | "low" | "medium" | "high" | "xhigh";
```

- [ ] **`src/agents/provider-adapters/codex-subscription-adapter.ts`** — replace the local definition with a back-compat alias. Old:

```ts
export type CodexReasoningEffort = "minimal" | "none" | "low" | "medium" | "high" | "xhigh";
```

New:

```ts
/** Back-compat alias — KPR-311 moved the canonical type to types.ts. */
export type CodexReasoningEffort = ReasoningEffort;
```

and extend the existing `./types.js` import at the top of the file:

```ts
import type { AgentProviderAdapter, AgentProviderTurnRequest, ReasoningEffort } from "./types.js";
```

(The existing `CodexReasoningEffort` imports in `agent-manager.ts` and `CodexSubscriptionAdapterOptions.reasoningEffort` keep compiling unchanged — that is the point of the alias.)

- [ ] **`src/agents/model-router.ts`** — add one type-only import below the existing imports (type-only ⇒ erased at compile time ⇒ no runtime cycle with `types.ts`'s `ResourceLimits` import from this module):

```ts
import type { AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";
```

and replace the `ModelRouterResult` interface. Old:

```ts
export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
}
```

New (JSDoc adapted from spec §1 — same carriage-only contract; section pointers adjusted for in-source context):

```ts
export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
  /** Absent ⇒ inherit the agent's static provider (resolveProviderModel(agent.model)).
   *  Dormant in W3: routeModel never sets it, AND even if set it is inert — a value
   *  matching the static provider is a no-op, a mismatch is clamped to static (spec §2/§5).
   *  Carriage-only until the same pilot-gate/clamp lift as effort. */
  provider?: AgentProviderId;
  /** Dormant in W3: routeModel never sets it, AND the W3 merge drops it even if set
   *  (the claude route variant carries no effort; pilots never reach the merge — spec §7).
   *  Carriage-only until the pilot-gate/clamp lift. */
  effort?: ReasoningEffort;
}
```

**Do not touch anything else in `model-router.ts`** — `routeModel`'s signature, prompt, tiers, ceiling, fallback, and all return sites are unchanged (optional fields, never set in W3; R3-adjacent classifier freeze).

- [ ] Verify:

```bash
npm run typecheck
npx vitest run src/agents/model-router.test.ts src/agents/provider-adapters/ src/agents/agent-manager.test.ts
```
Expected: green, zero test-file changes needed.

- [ ] **Commit:** `KPR-311: W3.2 T1 — neutral ReasoningEffort + dormant ModelRouterResult carriage fields`

---

## Task 2 — The seam: `prepareSpawn` effective route, adapter consumption, `modelTier` fill

**Goal:** the whole `agent-manager.ts` change as one coherent, compile-green edit (the return-shape change forces these to land together): `SpawnShaping`, `prepareSpawn` rewrite (pilot gate + clamp + guard + merge + docstring fix), `createProviderAdapter(agentId, route)`, `runOneSpawnAttempt` consumption, `recordSpawnObservability` signature + `modelTier`, `spawnTurn` call site. **Nothing moves across the R7 boundary**: the `acquire()` first statement, the try/catch, both `record()` sites, and the retry's `shaping` reuse are all untouched.

All edits in `src/agents/agent-manager.ts`.

- [ ] **Import:** extend the model-router import. Old:

```ts
import { routeModel, type ResourceLimits } from "./model-router.js";
```

New:

```ts
import { routeModel, type ModelTier, type ResourceLimits } from "./model-router.js";
```

- [ ] **`SpawnShaping` interface** — insert directly after the `splitProviderModel` function (keeps route types adjacent). Not exported; tests exercise it through `spawnTurn`.

```ts
/**
 * KPR-311: per-turn spawn shaping — shaped prompt plus the effective
 * per-turn route. `route` is provider-clamped to the agent's static
 * provider (W3 invariant): it keeps the KPR-306 breaker permit — acquired
 * on the static provider before the router runs (R7) — keyed to the
 * provider that actually executes, and keeps providerFor() (KPR-307)
 * consistent. Lifting the clamp is parked in the spec (§5) for W3.5.
 */
interface SpawnShaping {
  prompt: string;
  /** Effective per-turn route — provider-clamped; consumed by createProviderAdapter. */
  route: ProviderModelRoute;
  /**
   * Claude-path per-turn model when the router chose ≠ static; threaded to
   * runner.send via AgentProviderTurnRequest.modelOverride + observability.
   * Derivation unchanged from KPR-224.
   */
  modelOverride: string | undefined;
  /** Router tier for activity-audit modelTier (cache-cliff observability hook, KPR-310 C1–C3). */
  routerTier: ModelTier | undefined;
  resourceLimits: ResourceLimits | undefined;
  routerCostUsd: number;
}
```

- [ ] **`prepareSpawn` — full replacement** (docstring included; fixes the stale `processQueue` mention in passing). Old body is the 4-field version anchored in Task 0 step 5. New:

```ts
  /**
   * KPR-224 + KPR-311: per-turn shaping for `spawnTurn` (its single caller
   * post-KPR-220). Centralizes:
   *  - sender identity prepending (`[user:X via Y in #Z]:` for team /
   *    `[Y in #Z, thread=ts]:` for slack-with-sender)
   *  - file-attachment text appending
   *  - effective per-turn route derivation (KPR-311): the model router's
   *    per-turn decision merged with the agent's static
   *    resolveProviderModel(agent.model) route. W3 invariants: the
   *    effective provider is clamped to the static provider, and the
   *    router only runs for Claude-static agents (pilot gate — pilots are
   *    constructor-baked; TIER_MODELS is Claude-only).
   *
   * Voice carve-out: voice has its own `systemPromptOverride` injection
   * (KPR-219) and explicitly bypasses prepending + model router. Returns
   * raw text + the static route for `ctx.channel === "voice"`.
   */
  private async prepareSpawn(ctx: TurnContext): Promise<SpawnShaping> {
    const item = ctx.workItem;

    // Static route — resolved ONCE per turn, here; createProviderAdapter
    // consumes it (KPR-311). The `?.model ?? ""` guard mirrors the breaker
    // acquire site (KPR-306): SIGUSR1 hot-reload can remove the agent
    // between spawnTurn's registry pre-check and this point, and an
    // unguarded dereference would throw OUTSIDE the recorded try — skipping
    // the breaker's record() and wedging a half-open probe permit for up to
    // PROBE_STALE_MS. The degenerate route ({provider:"claude", model:""})
    // flows on instead; the turn then fails INSIDE the recorded try via
    // createProviderAdapter's `Unknown agent` throw (classifyThrown →
    // non-provider → never trips).
    const agentConfig = this.registry.get(ctx.agentId);
    const staticRoute = resolveProviderModel(agentConfig?.model ?? "");

    // Voice carve-out: KPR-219 supplies its own systemPromptOverride and
    // explicitly bypasses prepending + model router. Pin via this branch so
    // future prepareSpawn edits cannot accidentally re-shape voice prompts.
    if (ctx.channel === "voice") {
      return { prompt: item.text, route: staticRoute, modelOverride: undefined, routerTier: undefined, resourceLimits: undefined, routerCostUsd: 0 };
    }

    const senderLabel = item.senderName ?? item.sender;
    const userId =
      item.source.kind === "team"
        ? (item.meta?.user as string | undefined)
        : undefined;

    let prompt: string;
    if (userId) {
      prompt = `[user:${userId} via ${senderLabel} in #${item.source.label}]: ${item.text}`;
    } else if (item.senderName) {
      const slackThreadTs = item.meta?.slackThreadTs as string | undefined;
      const slackTs = item.meta?.slackTs as string | undefined;
      const threadTs = slackThreadTs ?? slackTs;
      const threadHint = threadTs ? `, thread=${threadTs}` : "";
      prompt = `[${senderLabel} in #${item.source.label}${threadHint}]: ${item.text}`;
    } else {
      prompt = item.text;
    }

    if (item.files?.length) {
      prompt += formatFilesForPrompt(item.files);
    }

    // Router gate (KPR-311): skip when disabled, for system senders
    // (scheduler/cron), when the agent vanished mid-turn (guard above), or
    // when the agent's static provider isn't Claude (pilot gate — calling
    // the router for a pilot charged routerCostUsd for an output the pilot
    // ignores and misattributed the Claude model in telemetry/audit).
    if (!agentConfig || !appConfig.modelRouter.enabled || item.sender === "system" || staticRoute.provider !== "claude") {
      return { prompt, route: staticRoute, modelOverride: undefined, routerTier: undefined, resourceLimits: undefined, routerCostUsd: 0 };
    }

    try {
      const result = await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers);

      if (result.provider !== undefined && result.provider !== staticRoute.provider) {
        // W3 provider clamp: cross-provider per-turn routing is
        // unsupported — the breaker permit (KPR-306) and the dispatcher
        // outage gate (KPR-307 providerFor) key on the static provider.
        // Model + effort are dropped; routed resourceLimits are RETAINED
        // (provider-agnostic runner-side execution bounds for the Claude
        // turn that actually runs) and cost/tier are still recorded — the
        // router call happened. Unreachable in production until W3.3+
        // (routeModel never sets `provider` in W3); semantics pinned by
        // unit test so W3.3 lands against defined behavior.
        log.warn("Model router provider ignored — cross-provider per-turn routing unsupported (W3 clamp)", {
          agentId: ctx.agentId,
          routerProvider: result.provider,
          staticProvider: staticRoute.provider,
        });
        return { prompt, route: staticRoute, modelOverride: undefined, routerTier: result.tier, resourceLimits: result.resourceLimits, routerCostUsd: result.costUsd };
      }

      // Effective route. The claude ProviderModelRoute variant carries NO
      // reasoningEffort field, so a router-set `effort` is dropped here by
      // construction — carriage-only in W3 (spec §7).
      const route: ProviderModelRoute = { provider: "claude", model: result.model };
      return {
        prompt,
        route,
        modelOverride: result.model !== agentConfig.model ? result.model : undefined,
        routerTier: result.tier,
        resourceLimits: result.resourceLimits,
        routerCostUsd: result.costUsd,
      };
    } catch (err) {
      log.warn("Model router failed, using default", { agentId: ctx.agentId, error: String(err) });
      return { prompt, route: staticRoute, modelOverride: undefined, routerTier: undefined, resourceLimits: undefined, routerCostUsd: 0 };
    }
  }
```

(Behavior notes vs old code: the router-off/system/missing-agent paths return the identical `modelOverride: undefined, resourceLimits: undefined, routerCostUsd: 0` the old code produced — byte-identical adapter behavior, pinned by existing tests `:601`/`:625`. `routeModel`'s own internal sonnet fallback still means the catch rarely fires; its semantics are unchanged.)

> **Future note (non-scope):** `formatFilesForPrompt` can still throw in the acquire→try gap (same wedged-permit class the `?? ""` guard closes for the registry read); it is correctly untouched here — moving shaping across the wrap point would cross the R7 boundary — but flag it for a future W-series hardening ticket so it isn't lost.

- [ ] **`createProviderAdapter` — signature + delete the re-resolve.** Old (Task 0 anchors 1):

```ts
  private createProviderAdapter(agentId: string): AgentProviderAdapter {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle);
    const route = resolveProviderModel(config.model);
```

New:

```ts
  /**
   * KPR-311: the route is the effective per-turn route derived by
   * prepareSpawn (provider-clamped to static in W3) — the static
   * agent.model prefix is no longer re-resolved here, so the breaker
   * permit and the adapter always key off the same resolution (R7).
   * Single call site (runOneSpawnAttempt); parameter required, no default.
   */
  private createProviderAdapter(agentId: string, route: ProviderModelRoute): AgentProviderAdapter {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle);
```

Everything below (`if (route.provider === "claude")` through the Gemini branch, `buildPilotInstructions`, config fallbacks) is **unchanged** — it now reads the parameter instead of the deleted local.

- [ ] **`runOneSpawnAttempt` — consume `SpawnShaping`.** Replace the inline shaping type and the adapter line. Old:

```ts
  private async runOneSpawnAttempt(
    ctx: TurnContext,
    shaping: {
      prompt: string;
      modelOverride: string | undefined;
      resourceLimits: ResourceLimits | undefined;
      routerCostUsd: number;
    },
    ticket: SpawnTicket,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<RunResult> {
```

New:

```ts
  private async runOneSpawnAttempt(
    ctx: TurnContext,
    shaping: SpawnShaping,
    ticket: SpawnTicket,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<RunResult> {
```

Old (Task 0 anchor 7):

```ts
    const adapter = this.createProviderAdapter(ctx.agentId);
```

New:

```ts
    const adapter = this.createProviderAdapter(ctx.agentId, shaping.route);
```

The `adapter.runTurn({... modelOverride: shaping.modelOverride, resourceLimits: shaping.resourceLimits ...})` call and the `result.costUsd += shaping.routerCostUsd` line are **unchanged** (⚠3: threading kept, not collapsed — `agent-runner.ts` and `AgentProviderTurnRequest` are not touched).

- [ ] **`recordSpawnObservability` — take `shaping`, fill `modelTier`, fix stale docstring in passing.** Replace the function's docstring (two stale `processQueue` mentions — that path is gone post-KPR-220; the function's signature is being edited anyway, clean-wrap-over-debt) with:

```ts
  /**
   * KPR-224: post-spawn observability for `spawnTurn` (its single caller
   * post-KPR-220). Records turn telemetry (per-turn cache window),
   * conversation index (semantic recall), and activity audit. All three
   * fail-soft — telemetry/index/audit failures cannot cascade into the
   * turn pipeline.
   */
```

(The third-party `processQueue` mention in the reflection swallow comment elsewhere in the file is NOT ours — leave it.) Old signature:

```ts
  private recordSpawnObservability(
    ctx: TurnContext,
    prompt: string,
    modelOverride: string | undefined,
    result: RunResult,
  ): void {
```

New:

```ts
  private recordSpawnObservability(
    ctx: TurnContext,
    shaping: SpawnShaping,
    result: RunResult,
  ): void {
```

In the body, replace the three uses: `model: modelOverride ?? ...` → `model: shaping.modelOverride ?? ...` (both the telemetry and audit occurrences), `inbound: prompt` → `inbound: shaping.prompt`, and the audit line — old:

```ts
      modelTier: undefined, // Model router tier not currently passed through
```

new:

```ts
      modelTier: shaping.routerTier, // KPR-311: router tier reaches the audit (cache-cliff observability, KPR-310 C1–C3)
```

- [ ] **`spawnTurn` call site** (post-W2 single site, Task 0 anchor 4). Old:

```ts
      this.recordSpawnObservability(effectiveCtx, shaping.prompt, shaping.modelOverride, finalResult);
```

New:

```ts
      this.recordSpawnObservability(effectiveCtx, shaping, finalResult);
```

**Touch nothing else in the lambda** — `acquire()` stays the first statement, `prepareSpawn` stays after it (outside the try), the retry stays inside the try reusing `shaping`, both `record()` calls stay as-is.

- [ ] Verify (existing suite must pass **unmodified** — the seam change is behavior-preserving for every pinned case):

```bash
npm run typecheck
npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/ src/agents/model-router.test.ts
```
Expected: green. If any existing test fails, that is an implementation bug (rule 2) — the pinned `runner.send` 7-arg shape, pilot constructor args, voice carve-out, breaker ordering, and cost addition must all hold byte-identically.

- [ ] **Commit:** `KPR-311: W3.2 T2 — effective per-turn route: prepareSpawn merge + clamp + pilot gate, adapter consumption, modelTier fill`

---

## Task 3 — Tests 1–3: route derivation, provider clamp, adapter route consumption

All edits in `src/agents/agent-manager.test.ts`.

- [ ] **Harness tweak — capturable warn.** Replace the logger mock at the top of the file. Old:

```ts
// Mock logger
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

New:

```ts
// Mock logger — warn is a hoisted shared spy so KPR-311 clamp warnings are
// assertable (cleared by vi.clearAllMocks in beforeEach; nothing else
// asserts on logger calls).
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

- [ ] **Type import + router-result factory.** Extend the existing import from `./model-router.js`:

```ts
import { routeModel } from "./model-router.js";
import type { ModelRouterResult } from "./model-router.js";
```

and add beside the other `make*` helpers (module level, after `makeRunResult`):

```ts
function makeRouterResult(overrides: Partial<ModelRouterResult> = {}): ModelRouterResult {
  return {
    tier: "haiku",
    model: "claude-haiku-4-5-routed",
    costUsd: 0.001,
    durationMs: 50,
    resourceLimits: { timeoutMs: 60_000, maxTurns: 25, budgetUsd: 1 },
    ...overrides,
  };
}
```

- [ ] **New describe** — nested inside `describe("spawnTurn shaping (KPR-224)")`, after the voice carve-out test (uses that block's `makeCtx` + `mockConversationIndex` beforeEach):

```ts
    describe("router→adapter seam (KPR-311)", () => {
      afterEach(() => {
        (appConfig as any).modelRouter.enabled = false;
      });

      it("merges the routed model into the effective route and drops a router-set effort (carriage-only)", async () => {
        (appConfig as any).modelRouter.enabled = true;
        // effort set to prove the W3 merge drops it: the claude route
        // variant carries no effort field, so the turn must be
        // byte-identical to a no-effort route.
        vi.mocked(routeModel).mockResolvedValueOnce(
          makeRouterResult({ provider: "claude", effort: "high" }),
        );

        const item = makeWorkItem({ text: "route me", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));

        expect(routeModel).toHaveBeenCalledTimes(1);
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
        const [, , , , modelOverride, resourceLimits] = mockRunnerSend.mock.calls[0]!;
        expect(modelOverride).toBe("claude-haiku-4-5-routed");
        expect(resourceLimits).toEqual({ timeoutMs: 60_000, maxTurns: 25, budgetUsd: 1 });
      });

      it("skips the router for sender === 'system' (scheduler/cron)", async () => {
        (appConfig as any).modelRouter.enabled = true;
        const item = makeWorkItem({
          text: "execute your scheduled digest task",
          sender: "system",
          source: { kind: "sms", id: "line-1", label: "May" },
        });
        await manager.spawnTurn(makeCtx(item, "sms"));

        expect(routeModel).not.toHaveBeenCalled();
        const [, , , , modelOverride, resourceLimits] = mockRunnerSend.mock.calls[0]!;
        expect(modelOverride).toBeUndefined();
        expect(resourceLimits).toBeUndefined();
      });

      it("pilot gate: routeModel is never called for a non-Claude-static agent, even with the router enabled", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult()); // defined pre-fix behavior for negative-verify
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({
            id: "codex-pilot",
            name: "Codex Pilot",
            model: "codex/gpt-5.5:medium",
            coreServers: [],
            soul: "pilot soul",
            systemPrompt: "pilot system",
          }),
        );

        const item = makeWorkItem({ text: "hello codex", source: { kind: "sms", id: "line-1", label: "May" } });
        const result = await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

        // No router call → no cost, no misattributed override.
        expect(routeModel).not.toHaveBeenCalled();
        // Pilot constructed from the static route, exactly as with the router disabled.
        expect(mockCodexConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ model: "gpt-5.5", reasoningEffort: "medium" }),
        );
        expect(mockCodexRunTurn).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: undefined }));
        expect(result.finalMessage).toBe("codex response");
      });

      it("provider clamp: a router result naming a different provider is ignored — static route, warn, cost+tier+limits retained", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValueOnce(
          makeRouterResult({
            tier: "sonnet",
            model: "gpt-9-preview",
            provider: "openai",
            effort: "low",
            costUsd: 0.003,
            resourceLimits: { timeoutMs: 300_000, maxTurns: 50, budgetUsd: 5 },
          }),
        );
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ costUsd: 0.05, sessionId: "s-clamp" }));

        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );

        const item = makeWorkItem({ text: "clamp me", source: { kind: "sms", id: "line-1", label: "May" } });
        const result = await localManager.spawnTurn(makeCtx(item, "sms"));

        // Static route used: Claude adapter ran, no pilot constructed, no override.
        expect(mockOpenAIConstructor).not.toHaveBeenCalled();
        const [, , , , modelOverride, resourceLimits] = mockRunnerSend.mock.calls[0]!;
        expect(modelOverride).toBeUndefined();
        // D3: routed resourceLimits are RETAINED (provider-agnostic execution
        // bounds for the Claude turn that actually runs).
        expect(resourceLimits).toEqual({ timeoutMs: 300_000, maxTurns: 50, budgetUsd: 5 });
        // Clamp-path bookkeeping: router cost still charged, tier still audited.
        expect(result.usage.costUsd).toBeCloseTo(0.053, 5);
        expect(activityLogger.record).toHaveBeenCalledWith(expect.objectContaining({ modelTier: "sonnet" }));
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("cross-provider per-turn routing unsupported"),
          expect.objectContaining({ routerProvider: "openai", staticProvider: "claude" }),
        );
      });

      it("createProviderAdapter consumes the shaping route, not a re-resolve of the live registry model", async () => {
        const { formatFilesForPrompt } = await import("../files/file-processor.js");
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
        // Mutate the registry model AFTER prepareSpawn resolves the static
        // route (formatFilesForPrompt runs inside prepareSpawn, after the
        // route read) but BEFORE adapter construction. A re-resolve inside
        // createProviderAdapter would see gpt-9:low; the passed route must
        // carry gpt-5.5:medium. (Fails against pre-KPR-311 code.)
        vi.mocked(formatFilesForPrompt).mockImplementationOnce(() => {
          registry._agents.set(
            "codex-pilot",
            makeAgentConfig({
              id: "codex-pilot",
              name: "Codex Pilot",
              model: "codex/gpt-9:low",
              coreServers: [],
              soul: "",
              systemPrompt: "pilot system",
            }),
          );
          return "";
        });

        const item = makeWorkItem({
          text: "seam check",
          source: { kind: "sms", id: "line-1", label: "May" },
          files: [{ name: "doc.txt", url: "https://example.com/doc.txt" } as any],
        });
        await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

        expect(mockCodexConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ model: "gpt-5.5", reasoningEffort: "medium" }),
        );
      });
    });
```

- [ ] Verify:

```bash
npx vitest run src/agents/agent-manager.test.ts
```
Expected: all green including the 5 new tests.

- [ ] Negative-verify (recommended, per repo review convention) — pin the new tests against pre-seam code. At this point HEAD **is** the T2 commit (`KPR-311: W3.2 T2 — …`; the Task 3 test edits are uncommitted), so `HEAD~1` (the T1 commit) carries the pre-seam `agent-manager.ts` while keeping the T1 type fields the test file needs to compile:

```bash
git checkout HEAD~1 -- src/agents/agent-manager.ts
npx vitest run src/agents/agent-manager.test.ts   # EXPECT FAILURES: pilot-gate, route-consumption, and clamp tests fail on pre-KPR-311 code
git checkout HEAD -- src/agents/agent-manager.ts  # restore the T2 source
npx vitest run src/agents/agent-manager.test.ts   # green again
```

- [ ] **Commit:** `KPR-311: W3.2 T3 — seam unit tests: route derivation, provider clamp, adapter route consumption`

---

## Task 4 — Tests 4–5: retry route-reuse + observability `modelTier`

Append inside the same `router→adapter seam (KPR-311)` describe from Task 3.

- [ ] Add:

```ts
      it("auth-rebuild retry reuses the first routing decision — routeModel called exactly once, same override on both attempts", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult());
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "recovered", sessionId: "s2" }));

        const item = makeWorkItem({ text: "retry me", source: { kind: "sms", id: "line-1", label: "May" } });
        // sessionId present — the auth-rebuild retry only fires on resumable turns.
        await manager.spawnTurn(makeCtx(item, "sms", "s1"));

        expect(routeModel).toHaveBeenCalledTimes(1); // no re-route, no double routerCostUsd
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        expect(mockRunnerSend.mock.calls[0]![4]).toBe("claude-haiku-4-5-routed");
        expect(mockRunnerSend.mock.calls[1]![4]).toBe("claude-haiku-4-5-routed");
      });

      it("activity audit modelTier: routed tier when the router ran, undefined when disabled", async () => {
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );

        // Router on → tier reaches the audit.
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ tier: "opus", model: "claude-opus-4-7" }));
        const item1 = makeWorkItem({ text: "tier check", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item1, "sms"));
        expect(activityLogger.record).toHaveBeenLastCalledWith(
          expect.objectContaining({ modelTier: "opus", model: "claude-opus-4-7" }),
        );

        // Router off → undefined (pre-KPR-311 behavior preserved). Assert the
        // property EXISTS and is undefined — objectContaining({modelTier:
        // undefined}) would also pass on an absent key.
        (appConfig as any).modelRouter.enabled = false;
        const item2 = makeWorkItem({ text: "no tier", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item2, "sms"));
        const offArg = activityLogger.record.mock.calls.at(-1)![0];
        expect("modelTier" in offArg).toBe(true);
        expect(offArg.modelTier).toBeUndefined();
      });

      it("misattribution fix: a router-enabled pilot agent audits its static model, no tier, no router call", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult()); // would misattribute pre-fix
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
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );

        const item = makeWorkItem({ text: "audit me", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

        expect(routeModel).not.toHaveBeenCalled();
        // Static pilot model in the audit — NOT a Claude router output.
        expect(activityLogger.record).toHaveBeenCalledWith(
          expect.objectContaining({ model: "codex/gpt-5.5:medium" }),
        );
        // modelTier: property present AND undefined (see comment above).
        const pilotArg = activityLogger.record.mock.calls.at(-1)![0];
        expect("modelTier" in pilotArg).toBe(true);
        expect(pilotArg.modelTier).toBeUndefined();
      });
```

- [ ] Verify:

```bash
npx vitest run src/agents/agent-manager.test.ts
```
Expected: green.

- [ ] **Commit:** `KPR-311: W3.2 T4 — retry route-reuse + modelTier observability tests`

---

## Task 5 — Tests 6–7: R7 invariant + SIGUSR1 throw-safety (post-W2 breaker surface)

- [ ] Add a new describe nested inside `describe("spawnTurn (KPR-216)")` (sibling of the post-W2 `provider circuit breaker at the wrap point (KPR-306)` describe, placed after the KPR-307 describe; uses that block's local `smsCtx` helper):

```ts
    describe("router→adapter seam invariants (KPR-311)", () => {
      it("breaker permit provider === effective route provider for claude and pilot agents (stable registry state)", async () => {
        // R7: acquire() keys on the static provider before the router runs;
        // the W3 clamp makes shaping.route.provider agree whenever both
        // registry reads observe the same state. NOT asserted across a
        // mid-turn registry mutation (see the SIGUSR1 race test below).
        const acquireSpy = vi.spyOn(manager.circuitBreakers, "acquire");

        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:seam-claude" }));
        expect(acquireSpy).toHaveBeenLastCalledWith("claude", expect.objectContaining({ agentId: "agent-a" }));
        expect(mockRunnerSend).toHaveBeenCalledTimes(1); // Claude adapter ran — same provider as the permit

        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:seam-codex" }));
        expect(acquireSpy).toHaveBeenLastCalledWith("codex", expect.objectContaining({ agentId: "codex-pilot" }));
        expect(mockCodexConstructor).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.5" }));
      });

      it("SIGUSR1 removal race: prepareSpawn never throws on a vanished agent — failure lands inside the recorded try, record() once, no wedged permit", async () => {
        const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
        // Flip the registry to "agent removed" the instant the breaker
        // permit is issued: the acquire-site read (argument evaluation)
        // still sees the agent; every later read — prepareSpawn's guarded
        // read and createProviderAdapter's — sees undefined. This is the
        // hot-reload race the `?.model ?? ""` guard exists for.
        let vanished = false;
        const realAcquire = manager.circuitBreakers.acquire.bind(manager.circuitBreakers);
        vi.spyOn(manager.circuitBreakers, "acquire").mockImplementation((provider, meta) => {
          const permit = realAcquire(provider, meta);
          vanished = true;
          return permit;
        });
        registry.get.mockImplementation((id: string) =>
          vanished && id === "agent-a" ? undefined : registry._agents.get(id),
        );

        // Rejects with the createProviderAdapter throw — NOT a TypeError
        // from an unguarded agentConfig.model dereference in prepareSpawn.
        await expect(manager.spawnTurn(smsCtx({ threadId: "sms:line-1:hot-reload" }))).rejects.toThrow(
          /Unknown agent: agent-a/,
        );

        // Exactly one record(), on the permit acquired pre-removal,
        // classified non-provider (never trips) from the thrown error.
        expect(recordSpy).toHaveBeenCalledTimes(1);
        const [permit, classification] = recordSpy.mock.calls[0]!;
        expect(permit.provider).toBe("claude");
        expect(classification).toEqual({
          outcome: "fault",
          kind: "non-provider",
          message: expect.stringContaining("Unknown agent"),
        });
        const snap = manager.circuitBreakers.stateFor("claude")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0);

        // No wedge, no lock leak: restore the registry, same thread runs clean.
        registry.get.mockImplementation((id: string) => registry._agents.get(id));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:hot-reload" }));
        expect(result.finalMessage).toBe("response");
      });
    });
```

- [ ] **Negative-verify the guard** (repo convention for bug-fix-shaped tests): temporarily change `resolveProviderModel(agentConfig?.model ?? "")` in `prepareSpawn` to `resolveProviderModel(agentConfig!.model)`, run the race test, confirm it fails (TypeError propagates, `recordSpy` never called — the wedge the guard prevents), revert. Do not commit the mutation.
- [ ] Verify:

```bash
npx vitest run src/agents/agent-manager.test.ts
```
Expected: green, including both new tests and the untouched KPR-306/307 describes.

- [ ] **Commit:** `KPR-311: W3.2 T5 — R7 permit/route invariant + SIGUSR1 throw-safety tests`

---

## Task 6 — Full gate

- [ ] Run the complete check from the worktree root:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck, ESLint, Prettier, and the full Vitest suite all pass. (Reminder — worktree/CI quality-gate asymmetry: do not trust a pass that self-disabled because of a `.claude/worktrees/` ignore fragment; confirm the check output actually lists the four gates running.)

- [ ] If Prettier reformats any touched file, apply (`npm run format`) and fold into the final commit.
- [ ] **Commit** (only if format/lint produced changes): `KPR-311: W3.2 T6 — format/lint pass`

Done — hand off to dodi-dev:review. No Linear writes, no PR from this plan (the lane's submit skill owns that).

---

## Assumptions

1. **Post-W2 execution**: the delivery worktree branches from the epic branch after `kpr-305` merges; Task 0 verifies this by content and hard-stops (demote to spec lane) on drift. All ⚠1–⚠7 delegated assumptions in the spec are settled — this plan implements them without re-litigation.
2. **`smsCtx` and the KPR-306 describe exist post-W2** in `agent-manager.test.ts` exactly as on `origin/kpr-305` @ `b0f2ba3` (Task 0 greps confirm); Task 5's tests nest beside them and use `manager.circuitBreakers` (public readonly on kpr-305).
3. **`recordSpawnObservability` takes the whole `shaping`** (spec §6.2 left the choice open): chosen over an extra tier param because both remaining uses (`prompt`, `modelOverride`) already come from shaping and the single post-W2 call site makes the swap one line.
4. **Audit/telemetry `model` expression unchanged** (`shaping.modelOverride ?? registry model`): with the pilot gate, pilots naturally audit their static definition model (`codex/gpt-5.5:medium`) — the spec's misattribution fix needs no further change to that expression.
5. **Test-file logger mock may share one hoisted `warn` spy** across all `createLogger` instances — nothing in the existing suite asserts logger behavior, and `vi.clearAllMocks()` in `beforeEach` isolates tests.
6. **`npm run check` needs the three Slack env stubs** in a fresh worktree (`SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`); this is an environment quirk, not a product change.
7. **`ProviderModelRoute`/`SpawnShaping` stay non-exported** in `agent-manager.ts` — no external consumer exists; tests observe behavior through `spawnTurn` (YAGNI; W3.5's registry ticket can export what it needs).
