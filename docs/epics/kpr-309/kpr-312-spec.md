# KPR-312 Spec — W3.3: Classifier v2 — no subprocess, structured outputs, effort-aware

**Epic:** KPR-309 · **Depends on:** KPR-310 (verdict: SAFE-WITH-CONSTRAINTS), KPR-311 (seam — carriage fields; spec-ready canon) · **Status:** draft

## TL;DR

Replace the model router's per-turn Claude Code CLI subprocess (`query()` in `src/agents/model-router.ts`, 8s timeout, $0.01/turn budget cap) with a direct `@anthropic-ai/sdk` call (`client.messages.parse` + GA structured outputs, already a dependency at ^0.82.0, precedent in `knowledge-extractor.ts`). The classifier emits `{tier, effort}` against a strict JSON schema; deterministic heuristics short-circuit obvious cases for $0/0ms. `effort` rides KPR-311's carriage field (`ModelRouterResult.effort`) and is **delivered to the Claude turn via a channel disjoint from 311's route merge** — a new optional `AgentProviderTurnRequest.effort` threaded to `runner.send()` → SDK `Options.effort` — leaving 311's provider clamp, pilot gate, and route shape untouched. Two verdict-mandated hardenings ride along: an additive `bad-model` fault kind in W2's frozen taxonomy (R3-compliant, never breaker-eligible) and an `is_error` guard in the runner's subtype-keyed result handling.

## Key Points

- **The subprocess is gone, not wrapped.** `routeModel`'s body swaps `query({model: routerModel, systemPrompt: ROUTER_PROMPT, ...})` — a full Claude Code CLI process spawn per turn — for one `messages.parse` call on a module-level shared `Anthropic` client (HTTP keep-alive; no per-turn process churn, the same motivation as KPR-122's in-process MCPs).
- **Structured outputs are GA, no beta header.** SDK 0.82.0 ships non-beta `client.messages.parse()` with `output_config: {format: ...}` (`resources/messages/messages.d.ts:1908`) and the zod-free `jsonSchemaOutputFormat` helper (`helpers/json-schema.d.ts:12`). The classifier model (default `claude-haiku-4-5-20251001`, `config.modelRouter.model`) supports structured outputs. The brace-scanning `parseRouterOutput` free-text parser is deleted.
- ⚠ **Auth reality — no API key ⇒ heuristics-only mode.** The CLI subprocess rides subscription auth; a direct API call requires `ANTHROPIC_API_KEY` (`config.anthropic.apiKey`, env→Keychain via `optional()`). On key-less instances (the operator's current dev posture) classifier v2 runs **heuristics-only**: obvious cases still short-circuit, everything else keeps the agent's default model with its default tier's resource limits (§3.3, tagged `method: "no-key"` — conservative, never a wrong upshift). Visibility: a boot-time log line **plus a new one-line informational `hive doctor` entry** (§3.5) — the doctor deliberately excludes `ANTHROPIC_API_KEY` from its required-env derivation (`doctor-checks.ts:49-63`, spec #157: optional-with-fallback keys "must not false-positive") and surfaces **nothing** about it today. *(Delegated, non-blocking — flagged prominently because it changes routing behavior on subscription-auth instances.)*
- **Effort delivery is honest and scoped:** classifier emits `effort ∈ {low, medium, high}` only alongside sonnet/opus tiers (haiku-4-5 rejects the `effort` param). It flows `ModelRouterResult.effort` (311's carriage field, which 312 now populates — *emission* anticipated by 311 ⚠7) → `SpawnShaping.effortOverride` (new) → `AgentProviderTurnRequest.effort` (new optional) → `runner.send` → SDK `Options.effort` (`EffortLevel`, sdk.d.ts:1193). The **route** still carries no effort; the clamp and pilot gate are untouched. 311 §7's broader clause gating delivery "to any adapter" on the §5 lift overreached — that lift is a pilot-only prerequisite — and is superseded for the Claude path via a coordinated canon amendment (§3.4).
- **Deterministic heuristics, first match wins:** haiku ceiling (exists today) → exact-match ack/greeting allowlist → empty text (no files). Heuristic hits cost $0, ~0ms, and are tagged `method: "heuristic"` on the result. Long messages don't short-circuit — the classifier input is truncated instead.
- **Verdict follow-through (KPR-310 §KPR-312):** additive `bad-model` kind + pattern row in `error-classification.ts` (frozen module, additive evolution allowed; the M8 string matches no existing row) and an `is_error === true` guard in `agent-runner.ts:1930`'s subtype-keyed result branch. Both small, both grounded in M8's exact observed shape.
- **No routeModel signature break:** `routeModel(text, ceilingModel, resourceTierOverrides)` gains one optional 4th param (`opts?: {hasFiles?: boolean}`) so file-bearing messages can't be mis-short-circuited by the empty-text rule. 311's merge call site changes by one argument + one field copy.

## 1. Problem

Three defects in the current classifier (`src/agents/model-router.ts`, HEAD `0963a2b` — file is byte-identical between HEAD and `origin/kpr-305`, verified via `git diff`):

**1. Per-turn CLI subprocess.** `routeModel` (`:110-212`) runs the Claude Agent SDK's `query()` — which spawns a full `claude` CLI process — for every routed turn:

```ts
q = query({
  prompt: text,
  options: {
    model: routerModel,
    systemPrompt: ROUTER_PROMPT,
    permissionMode: "bypassPermissions",
    maxTurns: 1,
    maxBudgetUsd: 0.01,
    persistSession: false,
    disallowedTools: ["Bash", "Read", ...],
    env: { ...process.env, ..., CLAUDECODE: undefined as unknown as string },
  },
});
```

Cost: up to the $0.01 `maxBudgetUsd` cap per turn (the CLI's own preamble/tool scaffolding inflates tokens beyond the ~250-token rubric). Latency: CLI startup + haiku call, bounded only by the 8s `config.modelRouter.timeoutMs` (`config.ts:305`), with a `setTimeout` → `q.close()` kill path (`:128-133`). Fragility: subprocess spawn/exit churn per turn (the exact pathology KPR-122 removed for MCPs), env surgery (`CLAUDECODE: undefined as unknown as string`), and free-text output parsing.

**2. No structured contract.** `parseRouterOutput` (`:82-104`) attempts `JSON.parse` on the raw assistant text, then falls back to scanning for `{...}` between brace indices. The prompt begs "Respond with ONLY a JSON object" and parse failure silently degrades to sonnet.

**3. Tier-only output.** The router can only act by swapping models. Per KPR-310 C1–C3, a model swap to a cache-cold model pays full prefix re-creation ($0.0343 vs $0.0050 control at ~7.7k tokens; ~7× at haiku pricing, ~89× at opus — and hive prefixes are much larger). An effort adjustment on the *same* model is the cheaper lever for routine turns (`output_config.effort` is not part of the prompt-cache prefix; verdict M9 additionally showed a thinking-config cell with no cache or fault difference, informative-only). Today hive passes no `thinking`/`effort` config at all — verified: the `query()` options block in `agent-runner.ts:1744-1786` sets neither.

Also vestigial: the `ROUTER_PROMPT` rule about "Scheduled/cron tasks that say 'execute your scheduled X task'" is dead — `prepareSpawn` gates the router with `item.sender !== "system"` (`agent-manager.ts:1058`), and every scheduler/cron/callback producer sets `sender: "system"` (`scheduler.ts:234,297,388`, `agent-manager.ts:894`, `dispatcher.ts:932`). Classifier v2's prompt drops that rule.

## 2. Anchoring & canon (D2)

| Surface | State | Anchor |
|---|---|---|
| `model-router.ts` | identical HEAD ↔ `origin/kpr-305` (empty diff) | HEAD refs; **312's primary file** |
| `prepareSpawn` / `SpawnShaping` / `createProviderAdapter` | KPR-311 rewrites these (spec §2/§3, plan at `8142cee`) | **311's post-delivery shape** — 312 branches after 311's child PR merges into the epic branch |
| `agent-runner.ts` (`send` signature `:1495`, query options `:1744`, result handling `:1930`) | untouched by 311 | HEAD refs |
| `provider-adapters/types.ts` (`AgentProviderTurnRequest`) | 311 adds `ReasoningEffort` type here | 311 shape |
| `error-classification.ts` | exists on `origin/kpr-305` only; frozen exports (`classifyTurnResult(input: TurnFaultInput)`, `HARD_FAULT_KINDS`, `classifyThrown`), additive evolution allowed | **kpr-305 shape** — W3 delivery gates on the W2 epic merge (rule inherited from 311 D2) |

**Canon note:** epic KPR-309 is **pre-register** — no decision register of its own. R3/R7 citations here refer to W2's register (KPR-305 @ `af74cf7`), binding external canon. The provider clamp-lift is parked in **KPR-311's spec §5 only** (pickup: W3.5 / KPR-314 ticket); nothing in this spec touches it. 311's clamp/gate/route design is spec-ready canon for this epic — this spec extends around it, never through it.

**Two classifiers, one word — keep them distinct.** W2's `error-classification.ts` is the **fault** classifier (turn outcomes → breaker taxonomy). This ticket's subject is the model-router **complexity** classifier (message → tier/effort). §6 of this spec touches the fault classifier once, additively, under R3's "extend the row in the same change" rule; everything else here is the complexity classifier.

## 3. Design

### 3.1 Direct API classification call

Module-level lazy client in `model-router.ts` (precedent: `src/code-task/knowledge-extractor.ts:24`'s `new Anthropic()`, which calls `messages.create` directly today):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.anthropic.apiKey) return null;          // heuristics-only mode
  return (client ??= new Anthropic({
    apiKey: config.anthropic.apiKey,
    timeout: config.modelRouter.timeoutMs,            // per-request wall clock
    maxRetries: 0,                                    // fail fast into the sonnet fallback
  }));
}
```

The call (replacing the whole `query()` block, deadline timer, and `parseRouterOutput`):

```ts
const OUTPUT_FORMAT = jsonSchemaOutputFormat({
  type: "object",
  properties: {
    tier:   { type: "string", enum: ["haiku", "sonnet", "opus"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["tier", "effort"],
  additionalProperties: false,
} as const);

const response = await client.messages.parse({
  model: config.modelRouter.model,                    // default claude-haiku-4-5-20251001
  max_tokens: 100,
  system: ROUTER_PROMPT_V2,
  messages: [{ role: "user", content: truncated /* §3.3 */ }],
  output_config: { format: OUTPUT_FORMAT },
});
if (response.stop_reason === "refusal" || !response.parsed_output) → sonnet fallback;
const { tier, effort } = response.parsed_output;
```

- **No beta header** — structured outputs are GA in 0.82.0 (`output_config.format`; the older `output_format` param is deprecated). One-time server-side schema compilation on first request, 24h-cached thereafter.
- **`ROUTER_PROMPT_V2`**: current tier rubric (haiku/sonnet/opus descriptions, "when in doubt sonnet", "short ≠ haiku") + an effort rubric (`low` = routine/lookup within the chosen tier, `medium` = typical multi-step, `high` = consequential judgment) − the "Respond with ONLY a JSON object" plea − the dead cron rule (§1). No prompt-cache marker: ~300 tokens is far below haiku-4-5's 4096-token cacheable minimum.
- **Cost accounting:** the direct API returns token usage, not `total_cost_usd`. `costUsd` is computed from `response.usage` with named haiku pricing constants ($1/$5 per MTok input/output) beside `TIER_MODELS`, commented as interim until the W3.5 registry owns model metadata. ⚠ Hardcoded pricing (delegated, non-blocking). `durationMs` measured locally.
- **Failure semantics unchanged in shape:** any throw (timeout, 429, 5xx, 404 on a misconfigured `MODEL_ROUTER_MODEL`), a refusal stop, or a null `parsed_output` logs a warning and returns the existing fallback — sonnet capped at ceiling, `costUsd: 0`, `resourceLimits` resolved for the fallback tier, `method: "fallback"`, **no effort**. Today's behavior for the same conditions, minus 8 seconds of subprocess.

### 3.2 Result shape

`ModelRouterResult` (as amended by 311 — carriage fields already present) gains one additive field and starts populating one:

```ts
export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
  provider?: AgentProviderId;      // 311 — still never set by routeModel (clamp stays dormant)
  effort?: ReasoningEffort;        // 311 carriage — NOW emitted by routeModel (emission anticipated by
                                   // 311 ⚠7; delivery clause amended at this spec gate, §3.4)
  /** How the decision was made — heuristic short-circuit, model call, key-less mode, or failure fallback. */
  method?: "heuristic" | "model" | "no-key" | "fallback";   // NEW, additive, observability-only
}
```

`"no-key"` is deliberately distinct from `"fallback"`: an unconfigured instance (no `ANTHROPIC_API_KEY`) and a failing API are different operator signals — the former is a steady state to surface once, the latter is an incident to alarm on.

`effort` emission rules (all enforced inside `routeModel`, so callers can trust the field):

1. Emitted only from the model path (`method: "model"`), value ∈ `{low, medium, high}` (schema-constrained; the subset valid on both 311's `ReasoningEffort` scale and the agent SDK's `EffortLevel`).
2. **Dropped when the final tier is haiku** (post-ceiling-cap): `claude-haiku-4-5` rejects the `effort` param — emitting it would 400 the actual turn.
3. Never emitted by heuristics or fallbacks (a $0 decision shouldn't tune a lever it didn't reason about).

### 3.3 Deterministic pre-classifier heuristics

Signature: `routeModel(text, ceilingModel, resourceTierOverrides?, opts?: {hasFiles?: boolean})` — one additive optional param; the router still never sees channel/sender (those gates live in `prepareSpawn` per 311 and stay there).

Order, first match wins, all before any client/API work:

| # | Rule | Result | Rationale |
|---|---|---|---|
| H1 | `ceilingTier === "haiku"` | haiku, $0 | Exists today (`:119-121`) — kept verbatim |
| H2 | trimmed text exact-matches the ack/greeting allowlist (case-insensitive): `hi, hello, hey, thanks, thank you, thx, ok, okay, yes, no, yep, nope, got it, sounds good, 👍, sure, will do` ⚠ *(exact list delegated to plan; exact-match only — no length threshold, so "fire the sales team" can never short-circuit)* | haiku, $0 | Greetings/acks are the canonical haiku case in the existing rubric |
| H3 | trimmed text is empty **and** `!opts?.hasFiles` | haiku, $0 | Nothing to classify; file-bearing items skip this — files mean real work, and the router can't judge them: it receives `item.text` only, while file content is appended into the assembled *prompt* (`prepareSpawn` `:1051-1053`, just **before** the router block at `:1058`) and never reaches the classifier |
| — | heuristic miss | no key → **no-key mode** (below); key present → model path (§3.1) | |

Honesty note on the $0: a heuristic hit is free on the **classifier side** only. If the resulting tier differs from the previous turn's model, the turn still pays any cold-cache switch cost (KPR-310 C1–C3) — weighing that is the deferred cost-aware policy (§9), not the heuristics' job.

**No-key mode:** heuristic-missing turns return

```ts
{
  tier: modelToTier(ceilingModel),
  model: ceilingModel,                                          // the agent's own configured model
  costUsd: 0,
  durationMs: 0,
  resourceLimits: resolveResourceLimits(modelToTier(ceilingModel), resourceTierOverrides),
  method: "no-key",
}
```

`resourceLimits` is non-optional on `ModelRouterResult`, so the shape must carry it; returning the **resolved default-tier limits** (rather than loosening the field to optional) is chosen because it (a) typechecks against 311's interface untouched, (b) mirrors the existing H1 and error-fallback shapes, which both resolve limits for their tier, and (c) keeps the tier guardrails (timeout/maxTurns/budget caps) active rather than falling back to raw `agentConfig.maxTurns`/`budgetUsd`. `modelOverride` then derives to `undefined` in `prepareSpawn` (no override). **Operator-visible delta, stated honestly:** today a key-less subscription instance gets *full LLM routing* through the CLI; after this ticket it gets (1) tier selection pinned at the agent default — no more haiku downshifts or opus upshifts beyond H1–H3 — and (2) resource limits resolved for the *default* tier instead of the *routed* tier. For the majority of turns the current rubric routes to the default tier anyway ("when in doubt, pick sonnet"), where both deltas are nil. One `log.info` at first invocation announces the mode; §3.5 adds the doctor line.

**Input truncation (model path):** classifier input is `text.slice(0, MAX_CLASSIFIER_INPUT)` (constant, ~4000 chars) with a `[...truncated]` suffix when cut — same pattern as `src/code-task/knowledge-extractor.ts:35-36`. Bounds worst-case classifier cost/latency regardless of message size.

### 3.4 Effort delivery — the honest path to the Claude turn

Per 311, the route's claude variant deliberately carries no effort, and effort is never merged into the route. **This spec does not change that.** But one 311 sentence must be reconciled, not merely flagged: 311 §7 stated that "delivery of effort **to any adapter** additionally depends on the pilot-gate/clamp lift" parked in its §5. That clause **overreached** — the lift is a *pilot*-delivery prerequisite only. Nothing about the clamp or the gate blocks a Claude-path channel that never touches the route: the clamp constrains which *provider* the route may name, and the gate constrains who gets a router call at all; neither constrains how a Claude-static turn's shaping carries an effort value beside the route. **This spec supersedes that sentence for the Claude path**, recorded as a canon amendment at the KPR-312 spec gate (driver reconciliation — the epic is pre-register, so the amendment is executed as surgical, marked edits to `kpr-311-spec.md` — §1 `effort?` JSDoc, Key Points bullet 2, §2 merge comment, §6 item 1, §7 delivery clause, ⚠7 — and the matching `kpr-311-plan.md` Task 1 embedded JSDoc + Task 2 embedded merge comment, shipped alongside this spec). 311's own §7 already named the Claude-path mechanism ("an effort→thinking-config mapping in `ClaudeAgentAdapter`/runner"); this ticket builds it as a parallel, additive channel mirroring the `modelOverride` precedent:

1. **`SpawnShaping.effortOverride?: ReasoningEffort`** (new field). In 311's §2 merge branch (Claude-static agents only — the only place the merge runs, courtesy of 311's pilot gate), one added line: `effortOverride: result.effort`. The clamped-provider branch and all static/skip branches leave it `undefined`. The **route object is untouched**.
2. **`AgentProviderTurnRequest.effort?: ReasoningEffort`** (new optional field in `provider-adapters/types.ts`). `runOneSpawnAttempt` passes `effort: shaping.effortOverride` in the existing `runTurn(...)` call. Pilots ignore it — the same tested precedent as `modelOverride`/`resourceLimits` (311 §4); with the pilot gate they also never receive one.
3. **`ClaudeAgentAdapter.runTurn`** forwards it; **`runner.send`** (`agent-runner.ts:1495`) gains an optional 8th parameter and maps it into the `query()` options:

```ts
// in the options object at agent-runner.ts:1744 ff.
...(effort ? { effort } : {}),   // ReasoningEffort "low"|"medium"|"high" ⊂ SDK EffortLevel
```

**What is deliberately NOT set: `thinking`.** Setting `thinking: {type: "adaptive"}` only on effort-bearing turns would toggle the thinking config turn-to-turn, which invalidates the messages-tier prompt cache — the exact cost class this ticket is avoiding. Passing `effort` alone leaves the CLI's own thinking defaults in place and rides `output_config.effort`, which is not part of the cached prefix. Emitted effort only accompanies sonnet/opus effective models (§3.2 rule 2), both of which accept the param.

**Dormant vs delivered, stated plainly:**
- *Delivered by this ticket:* per-turn effort on Claude-path turns routed to sonnet/opus tiers.
- *Dormant:* `ModelRouterResult.provider` (never set; clamp stays inert per 311); effort to **pilot** adapters (requires the gate/clamp lift parked in 311 §5 → W3.5); any explicit `thinking` config.
- ⚠ *Delivery-gate verification:* the spike never exercised the SDK `effort` option (M9 tested `thinking: adaptive` only, informative, PASS). The plan must include one manual verification turn on a live instance confirming `effort: "low"` is accepted and alters spend on `claude-sonnet-4-6` via the CLI path. *(Delegated, non-blocking.)*

### 3.5 Config & migration

- `config.modelRouter` keeps its three env-only keys — same names, no hive.yaml surface, so KPR-225 F3 liberal-loader rules are trivially satisfied (nothing to ignore). `MODEL_ROUTER_ENABLED`, `MODEL_ROUTER_MODEL` semantics unchanged.
- ⚠ `MODEL_ROUTER_TIMEOUT_MS` **default drops 8000 → 4000** (the CLI-startup headroom is gone; a direct haiku call at p50 ~0.5s doesn't need 8s before falling back). Operator-set values are honored unchanged. *(Delegated, non-blocking.)*
- No new config keys, no levers: heuristics are always on (they're strictly-dominant fast paths), mode is inferred from key presence. Allowlist and truncation bound are named constants.
- **Doctor visibility (in scope):** `hive doctor` today says nothing about the router's auth mode — `requiredEnvVarsFromConfig` (`doctor-checks.ts:49-63`) derives only `required(...)` keys and deliberately excludes `ANTHROPIC_API_KEY` as optional-with-fallback (spec #157). Add one **informational** (never-failing) line reporting the classifier mode: `model router: LLM classification` when a key resolves, `model router: heuristics-only (no ANTHROPIC_API_KEY)` otherwise. Placement: the doctor's existing informational output (there is no model-router section today; the plan picks the adjacent section).
- Rollout: no data migration, no agent-definition change. Instances with a key get the new call path on upgrade; key-less instances get no-key mode with the boot log line + doctor line. `ANTHROPIC_API_KEY` already resolves env→Keychain (`config.ts:20-22`, Honeypot `hive/<id>/ANTHROPIC_API_KEY`); it is *not* in the curated `hive credentials` registry — ⚠ recommend adding the registry entry as a one-line rider so operators can seed it via the paved path *(delegated, non-blocking; drop if scope pressure)*.

## 4. Cost / latency budget

| | Current (CLI subprocess) | Target (direct API, model path) | Heuristic hit |
|---|---|---|---|
| Cost / routed turn | ≤ $0.01 (`maxBudgetUsd` cap); typical unmeasured but CLI-scaffolding-inflated ⚠ estimate | ~$0.001 (≤ ~300 sys + ~1000 input tok @ $1/MTok + ~15 out @ $5/MTok) | $0 |
| Latency | typical multi-second (CLI spawn + call); hard ceiling 8s ⚠ estimate | p50 well under 1s; hard ceiling 4s | ~0ms |
| Process churn | 1 subprocess spawn+exit per routed turn | 0 (shared keep-alive client) | 0 |
| Parse failures | free-text brace-scan, silent sonnet degrade | schema-enforced; `parsed_output` null only on refusal/truncation edge | n/a |

⚠ Current-path figures are bounded-by-config estimates, not measured — the plan may capture one day of `routerCostUsd`/`durationMs` from existing logs before cut-over for a before/after note, but per the first-principles-bench pattern the analytic bound suffices for delivery.

## 5. Serialization vs siblings (file-conflict discipline)

- **After 311:** this ticket branches from the epic branch only after KPR-311's child PR merges — 312's `prepareSpawn` edit (one field copy + one call-site arg) is written against 311's merged §2 derivation, and `ModelRouterResult.effort`/`ReasoningEffort` must exist. Re-confirm all §2-anchored line refs at then-HEAD (mandatory per Gate 1 D2).
- **Before 314:** Gate 1 orders 312 delivery ahead of KPR-314 (W3.5 sidecar LLM registry). `model-router.ts` is 312's primary file and 314's secondary (`TIER_MODELS`, pricing); 314 rebases on 312's merged shape and inherits the pricing-constants TODO (§3.1).
- **W2 gate:** the `bad-model` addition (§6) edits `error-classification.ts`, which reaches this epic only via the W2 epic merge — same delivery gate 311 already imposes. If W2's module has evolved past `af74cf7` at delivery, re-verify the M8 string still matches no existing row before adding the new one.
- Files exclusively 312's in this epic: `model-router.ts` (body), `agent-runner.ts` (`send` param, options mapping, `is_error` guard), `error-classification.ts` (additive row), `cli/doctor-checks.ts`/doctor renderer (one informational line). Shared with 311 (sequenced, not conflicting): `agent-manager.ts` (`SpawnShaping` + merge line + `runTurn` arg), `provider-adapters/types.ts` (one optional field), `claude-agent-adapter.ts` (one forwarded arg).
- **Canon amendment shipped with this spec:** the driver-reconciliation edits to `kpr-311-spec.md` (§1 `effort?` JSDoc, Key Points bullet 2, §2 merge comment, §6 item 1, §7 delivery clause, ⚠7) and `kpr-311-plan.md` (Task 1 embedded JSDoc + Task 2 embedded merge comment), each marked "amended at KPR-312 spec gate" (§3.4). If 311 has already been implemented when 312 delivers, the amended JSDoc/comments land in source as part of 312's Tasks touching `model-router.ts`/`agent-manager.ts`.

## 6. Fault-classifier rider: `bad-model` kind (verdict anomaly 1)

**Decision: in scope**, because (a) the verdict aims the recommendation at this ticket, (b) classifier v2 is precisely the component that could emit a stale/retired model id fleet-wide once `TIER_MODELS` drifts (and 314's registry lands *after* 312), and (c) R3 permits additive evolution ("any future sentinel addition must extend the row in the same change") with frozen names/signatures untouched.

Additive changes to `src/agents/provider-adapters/error-classification.ts` (kpr-305 shape):

1. `ProviderFaultKind` union += `"bad-model"` — a config fault, **not** added to `HARD_FAULT_KINDS` (a rejected model id is not provider unhealth; it must never trip the breaker — same reasoning the verdict endorsed for the `non-provider` bucketing, now countable instead of invisible).
2. New `FAULT_PATTERNS` row: `["bad-model", /issue with the selected model|may not exist or you may not have access/i]` — grounded in M8's observed string: *"There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it."* **Placement: last, after `server-error`** — the table is first-match-wins, so appending after every existing row makes existing-row precedence provably unchanged (any string an old row matched still matches that row first); the verdict already confirmed the M8 string matches no existing row, so the new row is reachable. Both `classifyThrown` (the SDK-throw path M8 actually took) and `classifyTurnResult` route through the same table.
3. Tests: the **verbatim M8 error string** (exact text above, pinned character-for-character so pattern drift is caught) via both entry points → `{outcome: "fault", kind: "bad-model"}`; assertion that `HARD_FAULT_KINDS.has("bad-model") === false`; existing rows unchanged (regression-pinned per-alternate suite stays green).

**Runner hardening (same anomaly, other half):** `agent-runner.ts:1930` keys success on `result.subtype === "success"` alone — the exact mis-read the verdict flags (M8's result message is `subtype: "success"` + `is_error: true` with the error text in `result`). Add the discriminating check: when `result.is_error === true`, set `error` from `result.result` instead of adopting it as `resultText`. In M8 the subsequent SDK throw rescues the turn anyway; this guard makes the classification correct even if a future SDK version stops throwing. One conditional + one test.

No other fault-classifier changes; no rewrite; frozen exports untouched.

## 7. Edge cases

| Case | Behavior |
|---|---|
| `modelRouter.enabled: false` / `sender === "system"` / voice | Unchanged — gated in `prepareSpawn` before `routeModel` (311 shape); classifier never runs |
| Ceiling = haiku | H1 short-circuit, $0 (unchanged from today) |
| "thanks" / "ok" etc. | H2 → haiku, $0, `method: "heuristic"` — exact match only; "fire the sales team" goes to the model |
| Empty text, no files | H3 → haiku, $0 |
| Empty text **with** files | Not short-circuited → model path (or agent-default in no-key mode) |
| Huge message (> truncation bound) | Truncated classifier input; classification proceeds; turn prompt unaffected |
| No `ANTHROPIC_API_KEY` | No-key mode: H1–H3 apply; otherwise agent-default model + default-tier resource limits, no override, no effort, `method: "no-key"`; boot log line + doctor info line |
| Classifier API timeout / 429 / 5xx / network | `maxRetries: 0` → catch → sonnet-capped fallback, `costUsd: 0`, warn — same shape as today's failure path, ≤4s instead of ≤8s |
| Classifier API outage vs W2 breaker | **Classifier calls do not route through provider adapters and are never breaker-recorded or permit-gated** — a classifier fault must not count toward turn-provider health (its own timeout+fallback bounds damage; during a real Anthropic outage the turns themselves surface breaker-eligible faults). No `providerFor()` pre-check either — coupling for at most one bounded fallback per turn fails YAGNI |
| Misconfigured `MODEL_ROUTER_MODEL` (404 / no structured-output support → 400) | Classifier-side: falls into the sonnet fallback + warn every routed turn (operator-visible noise by design). Turn-side bogus model (M8): SDK throw → `bad-model` kind (§6), breaker-neutral |
| Structured-output refusal / `parsed_output` null / `stop_reason: "max_tokens"` | Sonnet-capped fallback (refusals may not match schema per API contract) |
| Classifier says opus, agent ceiling sonnet | Capped to sonnet (existing `TIER_RANK` cap, kept); effort survives the cap (still sonnet-valid) |
| Classifier tier haiku (post-cap) with effort emitted | Effort dropped inside `routeModel` (§3.2 rule 2) — haiku rejects the param |
| Router returns model === agent model | `modelOverride` undefined (unchanged rule); `effortOverride` still delivered — effort works with or without a model switch |
| Auth-rebuild retry | Reuses first attempt's `shaping` (311/R7) — same effort, no re-route, no double cost |
| Concurrent turns | Shared client, no shared mutable state in `routeModel`; safe |
| Reflection turns | Reflection prompts route like any non-system item today — unchanged (they carry the agent as sender) |

## 8. Testing surface

Existing pins that must stay green: `agent-manager.test.ts` router tests (`routeModel` mocked — mock return values gain `effort`/`method` fields where asserted), 311's new route-derivation/clamp/pilot-gate tests, `claude-agent-adapter.test.ts` delegation shape (updated for the 8th arg), pilot adapter tests (unchanged — pilots never see effort).

New tests:

1. **`model-router.test.ts` — heuristics:** H1/H2/H3 hit paths ($0, `method: "heuristic"`, no effort); "fire the sales team" and file-bearing empty-text do **not** short-circuit; truncation applied above the bound.
2. **Model path (mocked `Anthropic` client):** parsed `{tier, effort}` → correct model/effort/cost math from `usage`; ceiling cap (opus→sonnet) preserves effort; haiku result drops effort; refusal / null `parsed_output` / thrown timeout → sonnet fallback with `method: "fallback"`, no effort; no-key mode → agent-default model **with resolved default-tier `resourceLimits`**, `method: "no-key"`, client never constructed.
3. **Effort threading (agent-manager):** router-on merge copies `result.effort` → `shaping.effortOverride` → `runTurn({effort})`; router-off/system/voice/pilot paths leave it undefined; clamped-provider branch drops it.
4. **Runner:** `send` maps `effort` into query options (pinned options shape) and omits the key when absent; **no `thinking` key ever set**.
5. **Fault classifier (§6):** M8 string → `bad-model` via `classifyThrown` and `classifyTurnResult`; not in `HARD_FAULT_KINDS`; existing per-row regressions untouched.
6. **Runner `is_error` guard:** synthetic M8-shaped result message (`subtype: "success"`, `is_error: true`) → `error` set, text not adopted. Negative-verify: revert the guard, confirm the test fails on pre-fix code.
7. **Delivery verification (manual, plan step):** one live routed turn on a dev instance with `effort: "low"` emitted — confirm acceptance + spend delta (⚠ §3.4).
8. **Doctor line (`doctor-checks.test.ts`):** one assertion per mode — key resolves → `model router: LLM classification`; absent → `model router: heuristics-only (no ANTHROPIC_API_KEY)`; the line is informational and never flips the doctor to failing.

## 9. Non-goals

- **No seam changes** — 311 owns the route merge, provider clamp, pilot gate; all untouched. Effort travels beside the route, never in it.
- **No cost-aware switch-suppression policy** — C1–C3-aware tier hysteresis (weighing model savings vs cache re-creation) is future work; 311 §6's substrate (`modelTier` in the activity audit + per-turn cache tokens in telemetry) exists precisely so it can be designed from data. This ticket's effort lever reduces the *need* for switches; it does not model their cost.
- **No model/pricing registry** — `TIER_MODELS` and the interim pricing constants stay hardcoded (W3.5 / KPR-314).
- **No fault-classifier rewrite** — one additive kind + row under R3 rules (§6); frozen exports untouched.
- **No non-Claude classifier paths** — the pilot gate means `routeModel` never runs for non-Claude-static agents; `TIER_MODELS` stays Claude-only.
- **No explicit `thinking` config, no session-identity work (313), no streaming/batching of classifier calls, no prompt-cache marker on the router prompt** (below haiku's cacheable minimum).

## ⚠ Delegated assumptions

1. ⚠ **No-key ⇒ heuristics-only mode** — subscription-auth instances lose LLM tier classification; non-obvious turns run at the agent-default model with **default-tier resource limits** (today's key-less behavior is full LLM routing with routed-tier limits — the delta is nil for turns the rubric already routes to the default tier, §3.3). Visibility = boot log + a **new** informational doctor line (the doctor deliberately surfaces nothing about `ANTHROPIC_API_KEY` today). *Non-blocking, but the operator should be aware her current dev instances are in this mode until a key is seeded.*
2. ⚠ **Effort delivered via parallel channel** (`SpawnShaping.effortOverride` → `TurnRequest.effort` → SDK `Options.effort`), route untouched — supersedes 311 §7's "delivery to any adapter needs the §5 lift" clause for the Claude path (pilot-only prerequisite), executed as a coordinated canon amendment to 311's spec + plan at this spec gate (§3.4). *Non-blocking.*
3. ⚠ **Effort scale `{low, medium, high}`**, dropped for haiku tiers; no `thinking` key ever set (cache-toggle avoidance). *Non-blocking.*
4. ⚠ **SDK `effort` option unverified by the spike** (M9 was thinking-only, informative) — one manual live-turn verification gates delivery. *Non-blocking.*
5. ⚠ **Hardcoded haiku pricing constants** for `routerCostUsd` until W3.5's registry. *Non-blocking.*
6. ⚠ **Timeout default 8000→4000ms**, `maxRetries: 0`; operator-set env values honored. *Non-blocking.*
7. ⚠ **`bad-model` kind + runner `is_error` guard in scope** as verdict riders (additive under R3; one conditional in the runner). *Non-blocking.*
8. ⚠ **Heuristic allowlist contents and truncation bound** are plan-level constants (exact-match-only discipline is spec-binding; the phrase list is not). *Non-blocking.*
9. ⚠ **`method` field on `ModelRouterResult`** — additive observability tag (`heuristic`/`model`/`no-key`/`fallback`; unconfigured ≠ API-down); 311's carriage contract unaffected. *Non-blocking.*
10. ⚠ **Curated-registry entry for `ANTHROPIC_API_KEY`** — optional one-line rider (`credential-registry.ts`) so `hive credentials add` covers the classifier's key; droppable under scope pressure. *Non-blocking.*

No blocking product ambiguity: the one genuine product-shaped question (what happens on subscription-auth instances) has a safe, conservative, operator-visible default (assumption 1), and everything else is covered by Gate 1 D2/D3, the KPR-310 verdict, and KPR-311's spec-ready canon.
