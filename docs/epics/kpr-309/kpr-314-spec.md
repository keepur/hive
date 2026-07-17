# KPR-314 Spec — W3.5: Sidecar LLM registry (PR #194 rescoped)

**Epic:** KPR-309 · **Depends on:** KPR-312 (shared `model-router.ts` + classifier call site; Gate 1 order W3.2 → W3.3 → … → W3.5) · **Status:** draft

## TL;DR

One small engine-internal registry (`src/llm/`) becomes the single owner of sidecar-LLM model metadata — model ids, per-MTok pricing, capabilities (json/structured-outputs/vision/effort), per-provider client factories — and the transport for the four **non-agentic** LLM call sites. Three of them (meeting classifier, memory lifecycle, and — pre-312 — the router classifier) today spawn a full Claude Code CLI subprocess per call via agent-SDK `query()`; the fourth (image description) is an inline raw Gemini fetch with its own hardcoded provider knowledge. After this ticket: meeting classifier and memory lifecycle call the registry's Anthropic provider (direct Messages API, shared keep-alive client, per-312 precedent); image description calls the registry's Gemini provider; the router classifier — already subprocess-free after KPR-312 — consumes the registry for the model/pricing/capability constants 312 hardcoded (⚠5 in 312's spec: "interim until W3.5") and routes its structured-outputs call through the registry's provider handle. PR #194's architecture is the rescope source: its types/registry/gemini-adapter/call-site-injection shapes are salvaged; its raw-fetch Anthropic adapter, OpenAI/openai-compatible adapters, and hive.yaml `llm:` config surface are dropped or re-derived (§4). **No agent-turn work**: the provider clamp-lift parked in KPR-311 §5 "for pickup by W3.5" is **not** lifted here (§5, ⚠1).

## Key Points

- **Four call sites, one registry, nothing speculative.** Sites and their current shapes (worktree @ epic head `7674d93`): router classifier (`src/agents/model-router.ts:136` `query()` — replaced by 312 with a direct `@anthropic-ai/sdk` `messages.parse`; 314 anchors on that post-312 shape), meeting classifier (`src/agents/meeting-classifier.ts:120` `query()`, model = `config.modelRouter.model`, $0.01 budget cap, all-roster fallback), memory lifecycle (`src/memory/memory-lifecycle.ts:90` — a single central `runDreamQuery()` `query()` helper serving mergeDuplicates/detectContradictions/promotePatterns/summarizeColdPhase, hardcoded `claude-haiku-4-5-20251001`, `AutoDreamBudget` accounting fed by subprocess `total_cost_usd`), image description (`src/files/file-processor.ts:53` `describeImageWithGemini` — raw `fetch` to `generativelanguage.googleapis.com`, module-level key set from `index.ts:102`).
- **The registry owns the catalog 312 punted:** model ids, pricing constants (312 plan Task 1's `TODO(KPR-314)` comment names this ticket), and capability flags. `costUsd` is **computed by the registry** from provider `usage` × catalog pricing — PR #194 typed `costUsd?` on its result but no code path ever populated it (§4, a defect this ticket fixes rather than inherits); the memory site's `AutoDreamBudget.record()` and the classifiers' cost telemetry depend on it.
- **Provider-generic interface, two shipped providers (D3: non-Claude pilot-grade).** `LLMProvider.generate(request)` with optional `jsonSchema` for structured output. Shipped: `anthropic` (built on `@anthropic-ai/sdk` ^0.82.0 — already a dependency; `messages.parse` + `jsonSchemaOutputFormat` when a schema is present, `messages.create` otherwise) and `gemini` (raw REST, salvaged nearly as-is from PR #194 / today's file-processor fetch). **No OpenAI / openai-compatible adapters** — no call site needs them (ticket non-goal; the interface is where a future one plugs in).
- ⚠ **No hive.yaml `llm:` block, no per-task alias env vars.** PR #194 shipped a full `providers`/`models`/`tasks` yaml surface + `MODEL_ROUTER_LLM`-style env aliases. Dropped per the simplicity/no-preemptive-levers posture: task→model bindings are code constants; the only operator knobs are the ones that exist today (`MODEL_ROUTER_MODEL`, `GEMINI_VISION_MODEL`, and the two API keys). A future multi-provider need re-adds config surface when it's real. *(Delegated, non-blocking — this is the largest deliberate divergence from PR #194.)*
- ⚠ **No-key behavior per site is preserved-or-degraded-honestly, never a hidden subprocess.** PR #194 deleted the Claude-SDK-subprocess fallback deliberately ("bypassed Honeypot, lied about usage, duplicated a code path") and this ticket keeps that posture. Consequence, stated plainly (same class as 312 ⚠1): on key-less subscription-auth instances (the operator's current dev posture), meeting classification degrades to all-roster selection and memory autoDream/cold-summary LLM phases skip — both today ride subscription auth through the subprocess and will stop doing LLM work after this ticket. Visibility: boot log + one informational `hive doctor` line (§3.6). Router classifier no-key mode is 312's, unchanged. Image description already no-ops without `GEMINI_API_KEY` — unchanged. *(Non-blocking, but the operator should know her dev instances hit this until keys are seeded.)*
- **Auth follows DOD-212/Honeypot exactly as today:** both keys already resolve env→Keychain via `config.ts` `optional()` (`ANTHROPIC_API_KEY` at `config.ts:151`, `GEMINI_API_KEY` at `:237`); `GEMINI_API_KEY` is already in the curated credential registry (`src/setup/credential-registry.ts:114`); `ANTHROPIC_API_KEY`'s curated entry rides 312 ⚠10 (picked up here if 312 dropped it). The registry constructs providers only for keys that resolve; keys never leave the engine process.
- **Serialization:** branches only after 312's child PR merges into the epic branch (shared `model-router.ts` + the classifier call). Disjoint from 313 — zero shared files (§6). The 311 §5 clamp-lift is **not** picked up (⚠1): this rescoped ticket is non-agentic by definition; the lift needs breaker re-keying (agent-turn work) and stays parked — the driver should re-park it against a named future ticket so 311 §5's "pickup by W3.5" pointer doesn't dangle.

## 1. Problem

**Subprocess cost/latency/fragility, three sites.** Pre-312, all three Anthropic-bound sites pay the same pathology KPR-122 eliminated for MCPs and 312 eliminates for the router: a full `claude` CLI process spawn per call, multi-second startup latency, CLI-scaffolding-inflated token cost (capped only by `maxBudgetUsd: 0.01`/`0.1`), env surgery (`CLAUDECODE: undefined as unknown as string`), free-text brace-scan output parsing, and `setTimeout`→`q.close()` kill paths (meeting classifier) or **no timeout at all** (memory lifecycle's `runDreamQuery` — an autoDream call can hang a sweep indefinitely). After 312 ships, the router is fixed but meeting classifier and memory lifecycle still spawn subprocesses — and memory autoDream is the highest-volume site (up to `maxContradictionPairsPerRun` + `maxClustersPerRun` + cold-summary pages of subprocess spawns per dream run).

**Scattered hardcoded model knowledge.** Model ids and pricing live in five places: `TIER_MODELS` + 312's interim pricing constants (`model-router.ts`), `config.modelRouter.model` borrowed by the meeting classifier as its model, a string-literal `claude-haiku-4-5-20251001` inside `runDreamQuery`, and `GEMINI_MODEL`/endpoint knowledge inline in `file-processor.ts`. Nothing owns capabilities (312 hardcodes "haiku rejects `effort`" as a prose rule; vision-capability is implicit in "it's the Gemini path"). Pricing drift means editing constants scattered across the tree.

**What PR #194 built and why the rescope.** PR #194 (branch `codex/multi-provider-sidecar-llm`, 21 files, OPEN/parked) was Phase 1 of a two-phase multi-provider plan: a provider-agnostic `src/llm/` registry (types, registry, provider-utils, three provider files — anthropic/openai/gemini, with openai-compatible as a config-level type served by the OpenAI adapter file, not a fourth adapter), the same four call sites migrated, a hive.yaml + env config surface, and secret hardening (all provider keys Honeypot-aware; the Anthropic subprocess fallback deleted). It parked because Phase 2 (multi-provider **agent runtime**, KPR-68) was canceled by the KPR-209 realignment — Phase 1 alone didn't unblock the vendor-lockin story it was built for. The rescope keeps what is true regardless of that story: the four non-agentic sites should not spawn subprocesses, and model metadata should have one owner. It drops what only made sense with Phase 2 attached: multi-provider breadth and operator-facing provider config.

## 2. Anchoring & canon (D2)

| Surface | State | Anchor |
|---|---|---|
| `model-router.ts` | 312 rewrites it (plan Task 1: full-file replacement — direct `messages.parse`, heuristics, no-key mode, interim pricing constants with `TODO(KPR-314)`) | **312's post-delivery shape**; 314 branches only after 312's child PR merges into the epic branch |
| `meeting-classifier.ts`, `memory-lifecycle.ts`, `file-processor.ts`, `index.ts` (wiring), `config.ts` (gemini block) | untouched by 310–313 | HEAD (`7674d93`) refs |
| `error-classification.ts`, breaker/permit machinery | W2 canon, R3/R7 frozen | **read-only for this ticket** — registry calls are never breaker-recorded or permit-gated (same stance 312 took for classifier calls, §7) |
| 311 §5 clamp-lift parking | "expected pickup by W3.5, the sidecar LLM registry *ticket*" | **not satisfied here** — see Non-goals + ⚠1 |
| Epic register | pre-register; the 312-gate amendment to 311's spec/plan is canon | this spec makes no canon amendments |

PR #194 does **not** rebase cleanly and is not treated as a code base: its diff base predates the current `memory-lifecycle.ts` (no `AutoDreamBudget`, no consolidation cursors — the PR's four inline `query()` replacements map onto code that no longer exists; today there is one central `runDreamQuery`) and predates 311/312 entirely. It is treated as a **design source** (§4); this ticket's branch cuts from the epic branch post-312.

## 3. Design

### 3.1 Registry shape (`src/llm/`)

New module, engine-internal, in-process (no MCP, no REST, no yaml):

```ts
// src/llm/types.ts (salvaged from PR #194, trimmed + extended)
export type LLMProviderId = "anthropic" | "gemini";           // union grows when a site needs it
export type LLMCapability = "json" | "structured-outputs" | "vision" | "effort";

export interface CatalogModel {
  id: string;                          // e.g. "claude-haiku-4-5-20251001", "gemini-2.5-flash"
  provider: LLMProviderId;
  capabilities: LLMCapability[];
  pricing?: {                          // USD per MTok; absent ⇒ cost unknown (never blocks the call)
    inputPerMTok: number;
    outputPerMTok: number;
  };
}

export interface LLMRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  jsonSchema?: object;                 // structured output; provider maps to its native mechanism
  images?: { mimeType: string; dataBase64: string }[];
}

export interface LLMResult {
  text: string;
  parsed?: unknown;                    // set when jsonSchema was honored natively
  model: string;
  provider: LLMProviderId;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;                    // computed by the registry from usage × catalog pricing
}

export interface LLMProvider {
  readonly id: LLMProviderId;
  generate(request: LLMRequest): Promise<LLMResult>;   // throws on transport/HTTP error — callers own fallback
}
```

**`LLMRegistry`** (`src/llm/registry.ts`, singleton via `getLLMRegistry()` as in PR #194):

- Constructor takes resolved keys from `config` (`config.anthropic.apiKey`, `config.gemini.apiKey`) and constructs a provider **only when its key resolves** (PR #194's gating rule, kept). No key ⇒ `hasProvider(id) === false`; task resolution for that provider throws a typed "provider unavailable" error the call sites catch into their per-site fallbacks.
- **Task bindings are code constants** — `const TASKS = { routerClassifier, meetingClassifier, memory, vision } as const`, each mapping to a catalog model id. The classifier-grade haiku entry's id honors `config.modelRouter.model` (env `MODEL_ROUTER_MODEL`) so today's operator override keeps steering both classifiers; the vision entry's id honors `config.gemini.visionModel` (env `GEMINI_VISION_MODEL`). The memory task is catalog-pinned haiku (no env override exists today; none added).
- `generateForTask(task, request-sans-model)` — resolves task → catalog model → provider, validates required capability (vision task ⇒ model must carry `"vision"`; schema-bearing request ⇒ `"structured-outputs"`|`"json"`), fills `maxOutputTokens` default from the site, executes, and **computes `costUsd`** from usage × pricing. Unknown model id (operator overrode `MODEL_ROUTER_MODEL` to something off-catalog) ⇒ call proceeds, `costUsd` undefined, one `log.warn` per process (observability degrades; behavior doesn't).
- Metadata accessors for 312's constants: `pricingFor(modelId)`, `supportsEffort(modelId)` (or equivalent — exact surface is plan detail, ⚠4). `TIER_MODELS`' tier→model mapping **stays in `model-router.ts`** — which model each tier means is routing policy; what each model costs/can do is registry catalog.

**Providers:**

- `anthropic-provider.ts` — **re-derived on `@anthropic-ai/sdk`** (not PR #194's raw fetch): one module-level shared client (`apiKey`, `maxRetries: 0` — callers own retry/fallback semantics, matching 312), `messages.parse` + `jsonSchemaOutputFormat` when `jsonSchema` present (312's exact GA mechanism), `messages.create` otherwise; per-request `timeoutMs` via SDK request options. Returns `parsed` from `parsed_output`, maps `usage`.
- `gemini-provider.ts` — salvaged from PR #194 / current `file-processor.ts` fetch: `generateContent` REST with inline base64 parts, `AbortSignal.timeout` (PR #194's `withTimeout` helper), `usageMetadata` mapped to usage. Pilot-grade per D3 — enough for the vision task, no more.

### 3.2 Router classifier (post-312 `model-router.ts`)

Not a re-replacement — 312 already killed the subprocess. 314's delta, in decreasing certainty:

1. **Pricing/metadata source (the 312 ⚠5 hand-off):** delete 312's interim haiku pricing constants; `routerCostUsd` math calls the registry (`pricingFor`/cost computation). The `TODO(KPR-314)` comment 312's plan Task 1 embeds is the exact anchor.
2. **Effort-capability from catalog:** 312 §3.2 rule 2 ("drop effort when final tier is haiku — haiku rejects the param") consults `supportsEffort(model)` instead of a hardcoded tier check. Same behavior for the current catalog; data-driven for the next model generation.
3. ⚠ **Transport through the registry provider (decided: yes, thin swap):** `routeModel`'s `messages.parse` call moves onto the registry's anthropic provider (`generateForTask("routerClassifier", {..., jsonSchema: ROUTER_SCHEMA})`), sharing the one keep-alive client with the meeting classifier and memory sites. Everything 312 specified — heuristics H1–H3, no-key mode (now derived from `hasProvider("anthropic")`, identical truth condition: key presence), `ROUTER_PROMPT_V2`, timeout default, sonnet fallback, `method` tags, effort emission rules — is **byte-for-byte behavior-preserved**; only the transport and cost math move. If implementation friction appears (e.g. the generic interface can't carry a 312 option cleanly), the fallback posture is metadata-only consumption (items 1–2) with 312's own client left in place — a plan-level decision, not a product one. *(Delegated, non-blocking.)*

### 3.3 Meeting classifier (`src/agents/meeting-classifier.ts`)

Replace the `query()` block (`:120-152`), the message-iteration loop, and the `setTimeout`/`q.close()` deadline with one registry call:

```ts
const result = await getLLMRegistry().generateForTask("meetingClassifier", {
  prompt: userPrompt,
  systemPrompt: CLASSIFIER_PROMPT,
  jsonSchema: RESPOND_SCHEMA,          // { respond: string[] } — kills the brace-scan on the happy path
  maxOutputTokens: 256,
  temperature: 0,
  timeoutMs: config.modelRouter.timeoutMs,   // keeps today's borrowed knob; no new config
});
```

- Model: the same classifier-grade haiku entry the router uses (preserves today's `config.modelRouter.model` coupling).
- `parseClassifierOutput` (with its valid-id filtering) is **kept** as the belt-and-braces path over `result.parsed ?? result.text` — the id-allowlist filter is business logic, not parse scaffolding.
- **Fallback semantics preserved:** any throw (timeout/429/5xx) or parse failure → all-roster selection with `costUsd: 0` — exactly today's failure paths (catch → all-roster `:177-185`, parse-fail → all-roster `:192-197`). Roster-size-0/1 short-circuits unchanged.
- **No-key steady state is a pre-check, not a per-message error:** `classifyMeetingMessage` checks `hasProvider("anthropic")` before calling and returns all-roster directly, with a **warn-once** (module-level flag) rather than one thrown-and-caught warn per meeting message — steady state ≠ incident (the same distinction 312 drew and §3.4 applies to memory). ⚠2 covers the operator-visible degradation.
- `costUsd`/`durationMs` in the `ClassifyResult` now come from the registry result (real numbers instead of subprocess `total_cost_usd`; today's dispatcher log lines at `dispatcher.ts:735`/`:842` keep working).

### 3.4 Memory lifecycle (`src/memory/memory-lifecycle.ts`)

The **only structural change is inside `runDreamQuery`** plus constructor injection (PR #194's pattern, adapted to current code):

- Constructor gains an injected client (`MemoryLlmClient` = `{ generateForTask(task, request): Promise<LLMResult>; hasProvider(id: LLMProviderId): boolean; estimateCostUsd(task, request): number | undefined }` — every registry fact the site consults is a member of the injected interface: `hasProvider` serves the no-key short-circuit, `estimateCostUsd` serves the per-call estimate gate below; the site never reaches around the injection to the singleton) — position and exact signature are plan detail; `index.ts:292` wiring passes `getLLMRegistry()`. `estimateCostUsd` is registry-implemented (catalog pricing × chars/4 input estimate + `maxOutputTokens` worst-case output; returns `undefined` when pricing is unknown — moot for the catalog-pinned memory task, and an `undefined` estimate never gates). Tests inject mocks (PR #194's `makeMockLlm` pattern, extended to return `usage`/`costUsd` so budget assertions work, expressing provider absence through `hasProvider` and pricing through a stubbable `estimateCostUsd` so the skip test is directly writable).
- `runDreamQuery(prompt, budget)` body: `canSpend()` pre-gate unchanged → per-call estimate gate (below; a gated skip returns `""`, which every phase caller already handles via its `if (!text) continue` rule) → `this.llm.generateForTask("memory", { prompt, maxOutputTokens, temperature: 0, timeoutMs: MEMORY_LLM_TIMEOUT_MS })` → `budget.record(result.costUsd ?? 0)` → return `result.text`. All four phase callers (merge/contradiction/promote/cold-summary), checkpointing, cursors, oversize handling, error accumulation: **untouched**.
- **Budget semantics change, stated honestly:** the subprocess enforced `maxBudgetUsd` as a hard per-call cap; a direct API call cannot pre-cap spend. Post-change the guardrails are: `canSpend()` pre-gate (run budget), `budget.record(costUsd)` post-call (actual computed cost, replacing subprocess-reported cost), and per-call worst case bounded by the estimate ceiling below — every call that executes carried an estimate ≤ `callBudgetUsd() × GATE_TOLERANCE` ($0.013 at defaults; see ⚠5(c) for the chars/4 honesty margin on actuals). The memory task is catalog-pinned haiku so pricing is always known — budget accounting can't silently zero out (§7 pricing-drift row). **Per-call knob disposition (decided: keep-and-repurpose; the gate is justified by outcome parity, not exact clearance):** `AutoDreamBudget.callBudgetUsd()` / `maxCallBudgetUsd` / the per-call sense of `maxBudgetUsd` no longer feed a subprocess hard cap; they are repurposed as the pre-gate's **per-call estimate ceiling with tolerance**: before each call, `this.llm.estimateCostUsd("memory", request)` — worst-case input (chars/4 **of the actual request as sent**) + `maxOutputTokens` output × catalog pricing — and **skip** the call when the estimate exceeds `callBudgetUsd() × GATE_TOLERANCE` (named constant, **1.3**), treating a skip exactly like today's empty-text result (`continue` to the next cluster/pair/topic — never a throw, never an abort). The tolerance exists because the estimate is deliberately conservative in two known ways — chars/4 **over**-counts English input ~5–10%, and the estimate charges the full `maxOutputTokens` allowance while real summaries run ~50–100 tokens — so a raw-ceiling gate would skip a narrow band (estimate ≈ $0.010–0.013, band width ≈ $0.001–0.003) of pages whose *actuals* land just under the $0.01 cap and complete today; ×1.3 absorbs exactly those biases, pushing the gate's skip set **strictly inside today's abort set at defaults**. Per-phase `maxOutputTokens` is spec-pinned: contradiction verdicts 32; cold-summary/merge/promote 256 (summaries and memory records are 2–5 sentences; 256 is generous). **The load-bearing claim is a parity theorem, made true by the tolerance within the estimator's envelope: at defaults, for content within chars/4's bias envelope (prose at ≲ 4.5 chars/token), the gate never skips anything today's cap would have completed.** Residual outside the envelope: token-sparse records (heavy markdown indentation, whitespace runs, repeated characters — true chars/token 6–10+) can estimate over the gate while their actuals land under today's cap; no fixed tolerance closes this (the chars/4 over-count is unbounded above on such content). This is a pre-existing estimator pathology — the same chars/4 heuristic already mis-shapes this content class in the oversize filter (`:817`) and page fitting (`:832-836`) today — surfacing in a new place, and it lands as a counted, visible skip rather than a silent one. Case analysis against the source: (1) merge/contradiction/promote already cap the **full sent prompt** at 8000 est. tokens (`:545-548`, `:650-652`, `:724-726`) — for these phases the gate estimate is ≤ $0.008 + pinned output ≤ $0.00928, far under the $0.013 gate. (2) Cold-summary's shrink loop fits **content only** (`:832-836`); the sent prompt adds a ~40-token preamble + ~6 tokens/entry of `- [type/importance] ` prefixes (`:841-849`) — a fitted page at defaults estimates ≈ **$0.00944**, comfortably under the gate (the wrapper grows ~$0.000006/entry; even the pre-tolerance $0.01 ceiling needed ~115+ entries to breach — default `pageSize` is 20). (3) The min-records residue, both halves: the min-records floor (`:833`/`:839`) can exit a page **at** min records still far over 8000 est. tokens (each record individually ≤ 8000 via the oversize filter `:817`) — a deep-over page (e.g. 3 near-cap records ≈ 24K tokens, estimate ≈ $0.0253) is **still gated** under ×1.3 ($0.0253 > $0.013), and is *identically starved today* (the subprocess attempts it, hard-aborts at the $0.01 actual-cost cap, yields `""` → `continue` → re-presents next run) — except the gate is **strictly cheaper** (no ~$0.01 spent per aborted attempt, every run); a shallow-over **band** page (e.g. estimate $0.01028) now **passes the gate and is attempted**, exactly as today — preserving the opportunistic completions whose actuals land under the cap (the class a raw-ceiling gate would have permanently skipped). Since the direct API has no mid-call abort, an attempted band page always completes; its actuals — nominally ≈ $0.010–0.013 (heuristic — see ⚠5(c)) — are recorded and consume run budget (the post-hoc exceedance rule below). Skip-vs-today direction is therefore one-sided at defaults: the gate may *complete* what today aborted, never *skip* what today completed. Skips are visible, not silent: **skip counts are accumulated per run and surfaced in the existing `autoDream complete` log line** (not just log-once), so a perpetually-skipped backlog — which under parity is exactly the backlog that was already perpetually cap-aborted — is now observable instead of burning budget invisibly. **Post-hoc exceedance, stated plainly:** a gate-passed call may still exceed `callBudgetUsd()` in actuals (the estimate is heuristic, and the tolerance deliberately admits the $0.010–0.013 band); the overshoot is recorded via `budget.record(costUsd)` and consumes run budget. Operator config keys keep their names and approximate meaning; the enforcement point moves from provider-side cap to caller-side estimate. Enumerated in ⚠5 as the operator-visible semantic change it is. *(Structural alternative considered and declined: gating on the shrink loop's content-only string would restore exactness for fitted pages but couples the gate to phase internals and misstates what is actually sent; the parity theorem covers the residue either way.)*
- **Plan note — dead subscription-limit break:** the per-agent catch's loop-break on `String(err).includes("hit your limit")` (`memory-lifecycle.ts:371`) matches a CLI-subscription error string that direct API errors never produce — delete it or re-key it to the API's rate-limit shape (plan decision); the adjacent `"autoDream run budget exhausted"` break survives unchanged.
- ⚠ **New timeout where none existed:** `runDreamQuery` today can hang forever; the registry call gets a bounded `timeoutMs` (plan constant, ~30s — generous for a haiku summarization call). Throw → **per-AGENT error handling** (stated precisely: the inner phase `try` at `:331-347` rethrows after recording `runError` for the checkpoint `finally`; the per-agent catch at `:367` pushes to `errors[]`) — so a throw aborts that agent's **remaining phases** and the run continues at the **next agent**, exactly today's granularity for a thrown phase. *(Delegated, non-blocking — strictly an improvement, but it is a behavior change on pathological calls.)*
- **No-key:** provider-unavailable throws on first call → the same per-agent catch → dream returns with errors recorded. To avoid an error-spam steady state, `dream()`/`summarizeColdPhase` short-circuit up front when `!this.llm.hasProvider("anthropic")` (log once, return zero-counts) — the same "steady state ≠ incident" distinction 312 drew with `no-key` vs `fallback`. Non-LLM sweep phases (scoring, tier moves, purge) are untouched — they never called the LLM.

### 3.5 Image description (`src/files/file-processor.ts`)

PR #194's shape salvaged nearly verbatim, updated wiring:

- `describeImageWithGemini` → `describeImage`; the inline Gemini fetch, `GEMINI_MODEL` constant, `geminiApiKey` module state, and `setGeminiApiKey` are deleted. `describeImage` calls the injected client's `generateForTask("vision", { prompt: IMAGE_DESCRIPTION_PROMPT, images: [...], maxOutputTokens: 2048, temperature: 0, timeoutMs })`.
- Injection (`setVisionLlmClient`) rather than direct `getLLMRegistry()` import — keeps the module import-cycle-free and unit-testable (PR #194's `file-processor.test.ts` is salvageable with minor updates). `index.ts:101-103` swaps `setGeminiApiKey(config.gemini.apiKey)` for `setVisionLlmClient(getLLMRegistry())`.
- **Fallback preserved exactly:** null on missing provider, thrown error, or empty text — callers (`downloadAndProcess`, `processImageBuffer`, used by `slack-gateway.ts:175` and `ws-adapter.ts`) already handle null as "metadata-only file entry". No behavior change for key-less instances (today: no key ⇒ null).
- Vision capability is validated at task resolution (§3.1) — binding the vision task to a non-vision model is a boot-time configuration error surfaced in logs, not a per-image 400.
- `config.gemini` **stays** (PR #194 deleted it wholesale; since then `agentModel` grew a consumer at `agent-manager.ts:431` — a pilot-adapter concern, out of scope). Only `visionModel` gains a second reader (the catalog); `apiKey` feeds the registry.

### 3.6 Config, auth, visibility

- **No new config keys. No hive.yaml surface.** Existing knobs keep their meanings: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (both already env→Honeypot via `optional()`), `MODEL_ROUTER_MODEL`, `GEMINI_VISION_MODEL`, `MODEL_ROUTER_TIMEOUT_MS`. Liberal-loader concerns are nil (nothing to ignore). PR #194's `OPENAI_*` hardening is moot — those providers aren't shipped.
- **Curated registry:** `GEMINI_API_KEY` already curated (`credential-registry.ts:114`). `ANTHROPIC_API_KEY` entry rides 312 ⚠10; if 312 dropped it under scope pressure, add it here (one line) — post-314 that key gates three sidecar behaviors, not one. ⚠ *(rider, droppable)*.
- **Doctor:** one informational (never-failing) line following 312's `model router:` precedent — e.g. `llm sidecar: anthropic ✓, gemini ✓` / `llm sidecar: anthropic ✗ (meeting classifier → all-roster, memory dream → skipped), gemini ✗ (image description → off)`. Exact copy is plan detail; the requirement is that a key-less instance's three degraded behaviors are visible in one place. Boot log lines at registry construction mirror it.
- **Security posture (DOD-212):** the engine process is the legitimate credential holder (same as MCP servers); keys resolve at registry construction from `config.ts` (env→Keychain), are held in provider instances, and never enter any agent-visible context. No subprocess fallback exists anywhere in the registry — degraded modes are deterministic, not credential-bypassing.

## 4. PR #194: salvaged vs re-derived vs dropped (file-level)

| PR #194 file | Verdict | Why |
|---|---|---|
| `src/llm/types.ts` | **Salvage, adapted** | Interface shapes (request/result/usage/provider) sound; trim provider union to 2, add `pricing`+`capabilities` to the catalog entry (PR #194 had capabilities but **no pricing — its `costUsd?` field was never populated by any code path**, a defect not an omission: meeting-classifier's migrated `costUsd = result.costUsd ?? 0` always logged 0), add `parsed`/`jsonSchema` |
| `src/llm/registry.ts` | **Salvage, simplified** | Key-gated provider construction, task→model→provider resolution, `generateForTask`, singleton accessor all kept; yaml-driven `providers`/`models`/`tasks` config input replaced by code constants; `generateWithModel` dropped (no consumer); cost computation added |
| `src/llm/provider-utils.ts` | **Salvage, partial** | `withTimeout`, `parseJsonResponse`, `requireApiKey`, `normalizeBaseUrl` kept for the gemini provider; `extractJsonObjectText`/`extractJsonArrayText` kept only if the meeting-classifier belt-and-braces path wants them (plan detail); `textPromptParts` (OpenAI-shape) dropped |
| `src/llm/providers/gemini-provider.ts` (+test) | **Salvage, near-verbatim** | Matches today's file-processor fetch semantics; REST + inline base64 + usage mapping |
| `src/llm/providers/anthropic-provider.ts` (+test) | **Re-derive** | PR #194 used raw `fetch` against the Messages REST API; 312 established `@anthropic-ai/sdk` + GA structured outputs (`messages.parse`) as the engine precedent (`knowledge-extractor.ts` was the original) — the SDK client gives keep-alive, typed usage, `parsed_output`, and per-request timeout for free |
| `src/llm/providers/openai-provider.ts` (+test — exports both `OpenAIProvider` and the config-level `OpenAICompatibleProvider` variant) | **Drop** | No call site needs them (ticket non-goal); the provider interface is the extension point |
| `src/config.ts` changes | **Re-derive, mostly drop** | `buildLlmConfig` yaml surface, `OPENAI_*` keys, `MODEL_ROUTER_LLM`-style task aliases all dropped; "keys via `optional()`" is already true on HEAD for both shipped providers; `config.gemini` must survive (`agentModel` consumer post-dates the PR) |
| `meeting-classifier.ts` migration | **Salvage the shape** | Same replacement structure (one `generateForTask` call, fallbacks intact); upgraded with `jsonSchema` |
| `memory-lifecycle.ts` migration (+test `makeMockLlm`) | **Re-derive on current code, salvage the injection pattern** | PR #194's base predates `AutoDreamBudget`, `runDreamQuery`, and consolidation cursors — its four inline replacements map onto deleted code; today one central helper migrates. Constructor-injected client + mock pattern carry over; budget cost accounting is new (the PR silently dropped per-call cost tracking) |
| `file-processor.ts` migration (+test) | **Salvage, near-verbatim** | `describeImage` + `setVisionLlmClient` injection + the three tests |
| `index.ts` wiring | **Salvage, adapted** | Same two touch points (vision client, lifecycle constructor arg) against current line positions |
| `model-router.ts` migration (+test) | **Discard entirely** | Superseded by 312 (structured outputs, heuristics, no-key mode — all richer than the PR's like-for-like transport swap); 314's router work is §3.2 against 312's shape |

## 5. Non-goals

- **No agent-turn multi-provider routing, no clamp/pilot-gate lift.** 311 §5 parked the provider clamp-lift "with expected pickup by W3.5, the sidecar LLM registry ticket" — the rescoped ticket text is exclusively non-agentic and the lift requires re-keying `acquire()`/breaker identity (agent-turn machinery), so **the lift stays parked**. ⚠1 flags the dangling pointer for the driver to re-park explicitly. `ModelRouterResult.provider` stays never-set; 312's `effortOverride` channel untouched.
- **No providers beyond anthropic + gemini.** OpenAI/openai-compatible adapters, keys, and config: dropped with the interface as the future extension point.
- **No operator config surface** — no hive.yaml `llm:` block, no new env vars, no registry REST/API/MCP exposure. The registry is engine-internal plumbing the four sites consume.
- **No embedding-pipeline, voice-adapter (`openai-translator.ts`), or `knowledge-extractor.ts` migration** — the first two were PR #194's own Phase-2 exclusions; knowledge-extractor already uses the direct SDK (no subprocess) and is not one of the four audited sites. A follow-up may fold it in for catalog/pricing consistency; not this ticket.
- **No cost-aware routing policy, no telemetry/heartbeat surface for the registry, no retry logic inside providers** (`maxRetries: 0`; call sites own fallback, as 312 established).

## 6. Serialization vs siblings (file-conflict discipline)

- **After 312 (hard gate, Gate 1 order):** shared `model-router.ts` (312's primary file; 314 edits its pricing/metadata/transport per §3.2 against 312's plan-defined post-state) and the classifier call site semantics. Also inherits 312's doctor-checks precedent (both add informational lines — sequenced, not conflicting). Re-confirm anchored refs at then-HEAD (Gate 1 D2).
- **Disjoint from 313 — verified file-by-file:** 313's exclusive files are `session-store.ts`, `voice-adapter.ts`; its shared files are `agent-manager.ts`, `provider-adapters/types.ts`, `claude-agent-adapter.ts` (313 spec §6). 314 touches **none of these five**. 314's files: `src/llm/*` (new), `model-router.ts`, `meeting-classifier.ts`, `memory-lifecycle.ts`, `file-processor.ts`, `index.ts`, `config.ts` (at most comment/`optional()` touches), `cli/doctor-checks.ts` (+ paired tests, + `setup/credential-registry.ts` if the ⚠ rider lands). 313 and 314 can proceed in parallel lanes once 312 merges; no coherence ruling needed.
- **W2 (R3/R7):** untouched. Registry/sidecar calls never route through provider adapters, are never breaker-recorded, never permit-gated — a sidecar fault must not count toward turn-provider health (312 §7 stance, extended to all four sites).

## 7. Edge cases

| Case | Behavior |
|---|---|
| Anthropic outage / 429 / 5xx / timeout | Per-site, bounded by `timeoutMs` + `maxRetries: 0`: router → 312's sonnet fallback (`method: "fallback"`); meeting classifier → all-roster (today's path); memory → per-**agent** catch (`:367`): the throwing agent's remaining phases abort, `errors[]` records it, run continues at the next agent (today's granularity); each logs warn |
| Gemini outage / 429 / 5xx / timeout | `describeImage` → null → metadata-only file entry (today's path) |
| Missing `ANTHROPIC_API_KEY` | Steady-state degraded modes (⚠2): router no-key heuristics (312), meeting classifier all-roster, memory LLM phases skip with one log; doctor line surfaces all three |
| Missing `GEMINI_API_KEY` | Vision provider absent → `describeImage` null — byte-identical to today |
| Malformed / non-schema output | Anthropic sites use native structured output; refusal/null-parsed → site fallback (router: sonnet fallback; meeting: `parseClassifierOutput` retry on text then all-roster). Memory prompts are free-text by design (verdict strings, summaries) — empty text → `continue`, today's rule |
| Contradiction verdict text drift | `runDreamQuery` output post-processing (`trim().toUpperCase()`, A_WINS/B_WINS/NO/UNCLEAR match) unchanged — unrecognized verdict already falls through safely |
| Pricing drift / stale catalog | Catalog constants ride engine releases (same maintenance class as `TIER_MODELS` today — no runtime pricing fetch, YAGNI). `costUsd` is observability for classifiers; for memory it gates `AutoDreamBudget` — the memory task is catalog-pinned so pricing is always resolvable, and run damage is independently capped by `maxClustersPerRun`/`maxContradictionPairsPerRun`/page loops |
| Off-catalog `MODEL_ROUTER_MODEL` override | Call proceeds; `costUsd` undefined + one warn; router's cost telemetry degrades, routing doesn't. A model lacking structured-outputs 400s → per-site fallback (312's misconfigured-model row, same noise-by-design) |
| Vision task bound to non-vision model | Capability check at resolution → logged error + null description (config error surfaced, no per-image 400 loop) |
| Oversized image / prompt | Existing bounds unchanged: file-processor size gates upstream; memory's 8000-token prompt budget + oversize flagging untouched |
| Concurrent calls | Shared keep-alive clients, no shared mutable request state; safe (same argument as 312 §7) |
| Registry construction with zero keys | Valid state: all Anthropic+Gemini sidecar features degraded, engine boots normally, doctor says so |

## 8. Testing surface

Existing pins that must stay green: 312's full `model-router.test.ts` suite (updated where pricing constants become registry lookups — assertions on `costUsd` math re-anchor to catalog values, heuristics/no-key/fallback pins unchanged), `agent-manager.test.ts` router mocks (shape unchanged), memory-lifecycle's entire suite (constructor updated with mock client — PR #194's diff demonstrates the exact mechanical sweep), dispatcher meeting-mode tests (classifier mocked at module boundary, unchanged), doctor/credentials pins (extend enumerations, never delete).

New tests:

1. **`src/llm/registry.test.ts`:** key-gated provider construction (no key ⇒ `hasProvider` false ⇒ typed unavailable error on task resolve); task→model→provider resolution; capability validation (vision/structured); cost computation from usage × pricing (exact math pinned); off-catalog model ⇒ `costUsd` undefined + single warn.
2. **`src/llm/providers/anthropic-provider.test.ts`** (mocked SDK client): schema request → `messages.parse` + `parsed` mapped; plain request → `messages.create`; usage mapping; timeout/error propagation (throws, no swallowing).
3. **`src/llm/providers/gemini-provider.test.ts`** (mocked fetch — salvage PR #194's): request shape (inline base64 parts), usage mapping, non-OK → throw, abort on timeout.
4. **`meeting-classifier.test.ts`:** happy path via mocked registry (`parsed` respected, id filtering still applied); throw → all-roster; parse-fail → all-roster; no-key (`hasProvider` false) → all-roster via pre-check with `generateForTask` never called and warn fired once across repeated calls; roster 0/1 short-circuits never touch the registry; `costUsd` passthrough.
5. **`memory-lifecycle.test.ts`:** mock client returns usage/cost → `budget.record` called with computed cost (including recording an actual that overshoots the estimate — post-hoc exceedance consumes run budget); `canSpend` pre-gate still short-circuits; estimate gate: mock `estimateCostUsd` above the ×1.3 gate → call skipped as empty-text `continue` (`generateForTask` not called), skip counted and surfaced in the completion log, and a cold-summary skip does **not** flip `drained` semantics beyond today's continue rule; clearance pinned against the **registry-side estimate math on the actual sent prompt** at the ×1.3 gate: a default-fitted cold-summary page **plus prompt wrapper** (preamble + per-entry prefixes, ≈ $0.00944 at 20 entries/256 output) passes; a shallow-over band page (estimate ≈ $0.01028) **passes under ×1.3** and is attempted (`generateForTask` called); a deep-over min-records page (e.g. 3 near-cap records, estimate ≈ $0.0253) is gated (skipped, not attempted); `GATE_TOLERANCE` pinned at 1.3; a phase throw → that agent's **remaining phases abort**, error recorded in `errors[]`, run continues at the **next agent** (per-agent granularity pinned); no-key (mock `hasProvider` false) → zero-counts + single log, `generateForTask` never called; timeout wired into request. Existing dream/sweep/checkpoint assertions unchanged.
6. **`file-processor.test.ts`:** salvage PR #194's three tests (configured client called with images+task, null when unconfigured, null on throw).
7. **`model-router.test.ts` additions:** cost math sourced from registry; effort-drop rule driven by `supportsEffort` (haiku catalog entry pinned effort-less; sonnet/opus pinned effort-capable).
8. **Doctor line test:** both key-permutations' strings pinned; line never flips doctor to failing.
9. **Manual smoke (plan step):** on a keyed dev instance — one Slack image upload described via registry; one forced meeting classification; one `dream()` cycle with budget log showing computed (non-zero) cost; one routed turn confirming router cost telemetry still populates.

## ⚠ Delegated assumptions

1. ⚠ **Clamp-lift stays parked (not lifted by W3.5 despite 311 §5's pointer).** The rescoped ticket is non-agentic; the lift needs breaker re-keying. The driver should re-park 311 §5's "pickup by W3.5" against a named future ticket so the canon pointer doesn't dangle. *Non-blocking — flagged as the one canon-hygiene action this spec requests of the driver.*
2. ⚠ **Key-less degradation for meeting classifier (all-roster) and memory LLM phases (skip)** — a real behavior change on subscription-auth instances that currently get these via subprocess; surfaced via boot log + doctor line, consistent with 312 ⚠1's accepted posture. *Non-blocking.*
3. ⚠ **No hive.yaml/env config surface for the registry** — task bindings are code constants; only pre-existing knobs (`MODEL_ROUTER_MODEL`, `GEMINI_VISION_MODEL`, keys) steer it. Largest deliberate divergence from PR #194. *Non-blocking.*
4. ⚠ **Router transport routed through the registry provider** (thin swap; 312 behavior byte-preserved) with metadata-only consumption as the sanctioned retreat if implementation friction appears; exact registry metadata accessor surface (`pricingFor`/`supportsEffort` vs a `CatalogModel` getter) is plan detail. *Non-blocking.*
5. ⚠ **Memory budget/timeout semantics change (operator-visible):** (a) new ~30s timeout where none exists today; (b) per-call enforcement moves from subprocess hard cap to caller-side **estimate ceiling** via `estimateCostUsd` — `callBudgetUsd()`/`maxCallBudgetUsd`/per-call `maxBudgetUsd` are kept-and-repurposed as the pre-call estimate gate, not deleted (names and approximate meaning survive; enforcement point moves); per-phase `maxOutputTokens` is spec-pinned (32 verdicts / 256 elsewhere) and the gate fires at `callBudgetUsd() × GATE_TOLERANCE` (1.3 — absorbs the estimate's known conservative biases: chars/4 English over-count + full-allowance output charging); the gate's guarantee is **outcome parity, one-sided at defaults** — it never skips anything today's cap would have completed, and may complete shallow-over band pages (estimate ≈ $0.010–0.013) that today cap-abort (§3.4: full-prompt-capped phases ≤ $0.00928; fitted cold-summary page + wrapper ≈ $0.00944; deep-over min-records residue ≈ $0.0253 gated where today it is attempted-and-cap-aborted to the same `""` → `continue`, strictly cheaper) — skips are treated as empty-text `continue` and counted in the `autoDream complete` log; a gate-passed call may still exceed `callBudgetUsd()` in actuals (tolerance-admitted band included) — the overshoot is recorded and consumes run budget; (c) honesty on the bound: the estimate rides chars/4, which under-counts 2–4× on CJK/token-dense text — a gate-passed call (estimate ≤ $0.013 at defaults) can cost ~$0.03–0.05 in actuals on such text; it is a heuristic bound, not a hard cap, with run-level damage still capped by `canSpend()` + loop count limits (and note the tolerance rationale assumes English-biased over-count — on CJK text the band reasoning inverts, which is why (c) exists). *Non-blocking.*
6. ⚠ **Doctor line copy, boot-log wording, `MemoryLlmClient` member ordering/position, provider-unavailable error type** — plan-level details (per-phase `maxOutputTokens` values are spec-pinned in §3.4, no longer delegated). *Non-blocking.*
7. ⚠ **`ANTHROPIC_API_KEY` curated-registry entry** — rides 312 ⚠10; one-line rider here if 312 dropped it; droppable under scope pressure. *Non-blocking.*
8. ⚠ **`knowledge-extractor.ts` left on its own direct SDK client** (not one of the four audited sites; no subprocess involved) — candidate for a later consistency sweep, deliberately excluded. *Non-blocking.*

No blocking product ambiguity: the PR #194 salvage decision decomposes cleanly (§4) — everything multi-provider-Phase-2-shaped drops, everything four-site-shaped survives as design or code; the one genuine judgment call (no config surface, ⚠3) follows the operator's standing simplicity posture and is reversible when a real need arrives.
