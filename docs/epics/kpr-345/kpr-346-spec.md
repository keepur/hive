# KPR-346 — Lane A passthrough (Kimi + DeepSeek) + resolved-provider ops attribution

**Epic:** KPR-345 (two-lane provider-agnostic runtime) — child 1, Lane A.
**Epic spec:** `docs/epics/kpr-345/kpr-345-spec.md` §D1, §D2, §D8, Risks (⚠ Kimi/DeepSeek fidelity).
**Baseline:** epic branch `kpr-345` @ 8e0a7ec (post-KPR-347/348/349/353 — SESSION_SEMANTICS, turn-assembly, tool bridge, codex replay all landed). All file:line refs verified at this baseline.

## TL;DR

Route `kimi/…` and `deepseek/…` model prefixes through the existing `ClaudeAgentAdapter` — the full hive runtime (MCP tools, skills, hooks, memory, subagents, resume) comes for free — with per-spawn env substitution on the CLI subprocess: `ANTHROPIC_BASE_URL` to the vendor's Anthropic-compat endpoint, a Honeypot-resolved vendor key, foreign-model pins, and `ENABLE_TOOL_SEARCH=false`. Because every operational surface (breaker permit, outage queue, telemetry, session provider tag, KPR-313 transition guard) already keys on the *route* provider from `resolveProviderModel`, growing `AgentProviderId` + routing the new prefixes gives resolved-provider attribution by construction; this child adds the table, the env mechanics, the `:effort` survival, and the tests/pins that make the attribution non-regressable — plus live-endpoint validation before any production reassignment.

## Key Points

- **In scope:** passthrough-provider table (`kimi`, `deepseek` — vendor-operated Anthropic-compat endpoints only); per-spawn env injection via a new optional `AgentRunner` passthrough config; `AgentProviderId` + `ProviderModelRoute` union growth; `SESSION_SEMANTICS` entries as `client-transcript` (compile-forced by the exhaustive Record — write side `finalizeSpawnResult` and read side `SessionStore.normalizeRef` both follow automatically); `:effort` suffix survival into the Claude adapter's existing effort channel; curated-credential registry entries; live-endpoint validation.
- **Decision-register canon honored:** `LaneBProviderId` is **never touched** — Lane A ids join `AgentProviderId` only; `TOOL_EXECUTING_PROVIDERS` and the whole turn-assembly path are unreachable for Lane A (the `createProviderAdapter` Lane A branch returns before `assembleProviderTurn`).
- **Ops attribution is mostly by-construction:** breaker acquire (`agent-manager.ts:672-676`), `providerFor()` (dispatcher outage gate), session persist (`finalizeSpawnResult` route arg), and the KPR-313 guard all consume `resolveProviderModel(...).provider` already. A Kimi outage trips the `kimi` breaker and queues `kimi` turns; Claude is untouched. The child pins this with tests, it does not re-plumb seams.
- **Credentials:** vendor keys (`KIMI_API_KEY`, `DEEPSEEK_API_KEY`) resolve **per spawn** via `process.env` → Honeypot Keychain (`hive/<instanceId>/<KEY>`), the standard secret-env pattern. A missing key throws `TurnAssemblyError` → classifies `non-provider` → never trips the foreign breaker, never engages the outage queue. No `ANTHROPIC_API_KEY` anywhere; passthrough spawns explicitly neutralize the runner's conditional `ANTHROPIC_API_KEY` injection.
- **Documented caveats (parity-matrix feed, not fixed here):** no Anthropic server-side tools (WebFetch/WebSearch); tool-search deferral forced off; CLI-computed `costUsd` uses Claude pricing (nominal for foreign models); vendor cache economics differ; only `low|medium|high` effort values are deliverable through SDK `Options.effort`.
- ⚠ **Validation gate before production reassignment:** CLI credential precedence on a subscription-logged-in machine (does injected `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` outrank the logged-in OAuth session?) is a **spike, not an assumption** — V1 below. If env does not win, the child is blocked until a supported override is found.
- ⚠ **Endpoint fidelity** for hooks round-trips, subagent (Task) traffic, streaming, and multi-turn resume is vendor-doc-claimed only — V2 validates against live Kimi and DeepSeek endpoints.
- **Out of scope:** translation proxies; Lane B anything; voice-lane Claude pin (epic ruling, unassigned child — Lane A voice turns still run the Claude runtime so nothing breaks); cost normalization; `hive doctor` changes (breaker/outage sections are provider-dynamic already).

## Problem / Context

Verified current state at `kpr-345` @ 8e0a7ec:

- `resolveProviderModel` (`src/agents/agent-manager.ts:174-192`) knows `codex|openai-codex`, `openai`, `gemini|google-gemini`; unknown prefixes fall back to Claude — so `kimi/kimi-k2` today silently runs the **Claude** model string `kimi/kimi-k2` against Anthropic (a bad-model fault at best).
- `AgentProviderId = "claude" | "openai" | "gemini" | "codex"` (`src/agents/provider-adapters/types.ts:4`). `SESSION_SEMANTICS` is an exhaustive `Record<AgentProviderId, SessionSemantics>` (`types.ts:62-67`) — adding a provider id without declaring semantics is a compile error. Both the write side (`finalizeSpawnResult` → `persistsResumableHandle(sessionSemanticsFor(route.provider))`, `agent-manager.ts:1498,1516`) and the read side (`SessionStore.normalizeRef`, `session-store.ts:116-122`, unknown-provider fail-closed) key on it. **The old `RESUMABLE_SESSION_PROVIDERS` set is gone** — the ticket's "session-resumability keying extension" is, post-KPR-347, exactly two Record entries.
- The breaker permit is acquired on `resolveProviderModel(agent.model).provider` before any spend (`agent-manager.ts:672-676`); `providerFor()` (`:639-643`) feeds the dispatcher's outage gate (`dispatcher.ts:561,705`); the KPR-313 session-identity guard compares `sessionProvider !== route.provider` (`:716`); the handoff notice variant keys on `staticRoute.provider === "claude"` (`:1349`).
- `AgentRunner.send()` uses `this.agentConfig.model` verbatim as the CLI model (`agent-runner.ts:1803`) and owns the spawn env block (`:1911-1919`), including the conditional `ANTHROPIC_API_KEY` spread and the always-pinned `ENABLE_TOOL_SEARCH` (KPR-329).
- Vendor precedent (epic, researched 2026-07-19): Kimi ships `https://api.moonshot.ai/anthropic`; DeepSeek ships `https://api.deepseek.com/anthropic`; both document the `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + model-pin + `ENABLE_TOOL_SEARCH=false` pattern for Claude Code.

## Design

### D1 — Passthrough-provider table

New module `src/agents/provider-adapters/passthrough-providers.ts`:

```ts
export type LaneAProviderId = "kimi" | "deepseek";

export interface PassthroughProviderDef {
  id: LaneAProviderId;
  displayName: string;          // "Kimi (Moonshot AI)" / "DeepSeek"
  baseUrl: string;              // vendor-operated Anthropic-compat endpoint
  authTokenKey: string;         // Honeypot/env var name: KIMI_API_KEY / DEEPSEEK_API_KEY
  defaultModel: string;         // used when the prefix carries no model (e.g. bare "kimi/")
}

export const PASSTHROUGH_PROVIDERS: Readonly<Record<LaneAProviderId, PassthroughProviderDef>> = {
  kimi:     { id: "kimi",     displayName: "Kimi (Moonshot AI)", baseUrl: "https://api.moonshot.ai/anthropic",  authTokenKey: "KIMI_API_KEY",     defaultModel: "<pinned at plan time from vendor docs>" },
  deepseek: { id: "deepseek", displayName: "DeepSeek",           baseUrl: "https://api.deepseek.com/anthropic", authTokenKey: "DEEPSEEK_API_KEY", defaultModel: "<pinned at plan time from vendor docs>" },
};

export function isLaneAProvider(p: AgentProviderId): p is LaneAProviderId;
```

Adding the next compat vendor is a table row + one `AgentProviderId` union member + one `SESSION_SEMANTICS` entry (compile-forced) — no new code path. Only officially vendor-operated endpoints qualify (epic ruling; translation proxies ruled out). No prefix aliases (YAGNI — `moonshot/` etc. can be added as routing aliases later if wanted).

Per-spawn resolved shape handed to the runner:

```ts
export interface PassthroughSpawnConfig {
  provider: LaneAProviderId;
  model: string;                // resolved foreign model id (prefix + effort stripped)
  baseUrl: string;
  authToken: string;            // resolved credential — lives only in the spawn env path
}
```

### D2 — Routing: union growth + prefix resolution

- `AgentProviderId` grows to `"claude" | "openai" | "gemini" | "codex" | "kimi" | "deepseek"` (`types.ts:4`). **`LaneBProviderId` is untouched** (canon; its doc comment already anticipates this child).
- `SESSION_SEMANTICS` gains `kimi: "client-transcript"`, `deepseek: "client-transcript"` — the CLI's session ids are local transcript handles independent of the completions endpoint; resume replays the transcript client-side (cold vendor cache, re-billed tokens — documented caveat). The exhaustive Record makes omission a compile error; write/read persistence behavior follows with zero further changes.
- `ProviderModelRoute` (`agent-manager.ts:166-170`) gains `| { provider: "kimi" | "deepseek"; model: string; reasoningEffort?: CodexReasoningEffort }`. TS narrowing then **forces** the `createProviderAdapter` Lane A branch — the actual forcing site is `assembleProviderTurn`'s `provider: LaneBProviderId` parameter (`turn-assembly.ts:135`), consumed at `agent-manager.ts:518`: it rejects the widened route until the Lane A branch is inserted before it (the final `GeminiAdkAdapter` return never reads `route.provider`, so the fallthrough itself would compile).
- `resolveProviderModel` gains two prefix arms mirroring the codex arm, both running `splitProviderModel` so `:effort` survives parsing:
  - `kimi` → `{ provider: "kimi", model, reasoningEffort }`
  - `deepseek` → `{ provider: "deepseek", model, reasoningEffort }`
  - Unknown-prefix → Claude fallback unchanged (KPR-231).

### D3 — `createProviderAdapter` Lane A branch

Immediately after the `claude` branch (`agent-manager.ts:505-507`), **before** `assembleProviderTurn` — Lane A must never enter the Lane B assembly path:

```ts
if (route.provider === "kimi" || route.provider === "deepseek") {
  const passthrough = resolvePassthroughSpawn(route, appConfig); // D4; throws TurnAssemblyError on missing credential
  return new ClaudeAgentAdapter(new AgentRunner(config, ..., { laneAPassthrough: passthrough }));
}
```

`AgentRunner` gains one optional trailing constructor param (options object `{ laneAPassthrough?: PassthroughSpawnConfig }` — a trailing options bag rather than an 11th positional, plan's discretion on exact shape). `ClaudeAgentAdapter` is unchanged; its `readonly provider = "claude"` stays as-is per canon (the adapter class is an execution-path detail; every ops surface keys on the route).

Model resolution chain: `route.model || appConfig.<provider>.agentModel || table.defaultModel` — mirrors the codex/openai/gemini pattern (`agent-manager.ts:525,538,545`).

### D4 — Credential resolution + failure mode

`resolvePassthroughSpawn` resolves the credential **per spawn**: `process.env[authTokenKey] || fromKeychain(config.instance.id, authTokenKey)` — the exact secret-env pattern the runner already uses for plugin stdio servers (`agent-runner.ts:914`). Per-spawn (not boot-time `optional()`) so `hive credentials add KIMI_API_KEY` takes effect on the next spawn without a restart, and no vendor secret sits in the long-lived config object.

Missing/empty credential → `throw new TurnAssemblyError("Passthrough credential missing: <KEY> (hive credentials add <KEY>)")`:

- The throw happens inside `runOneSpawnAttempt` → inside spawnTurn's recorded try → `classifyThrown` short-circuits `TurnAssemblyError` to `non-provider` (`error-classification.ts:126-129`) **before** the pattern tables — critical, because a plain-Error message mentioning "API key" would regex-match the `auth` fault row and count toward the foreign breaker's trip streak.
- Result: operator-visible error, no breaker trip, no outage-queue episode. Config fault, not provider fault (epic D2).

Keychain read cost (one `execFileSync security` call per spawn) is microseconds-scale and matches existing per-spawn stdio-server resolution; no caching (rotation-friendly, simplicity canon).

### D5 — Per-spawn env substitution (the runner side)

In `send()`, when `laneAPassthrough` is set:

1. **Model:** `effectiveModel = passthrough.model` (overrides `agentConfig.model`, which still holds the prefixed string `kimi/...` for telemetry/audit attribution — `recordSpawnObservability` and the activity log deliberately keep reading `agentConfig.model`).
2. **Env block** (appended after the existing entries in the `query()` options env, `agent-runner.ts:1911-1919`, so the pins win):

```ts
...(passthrough ? {
  ANTHROPIC_BASE_URL: passthrough.baseUrl,
  ANTHROPIC_AUTH_TOKEN: passthrough.authToken,
  ANTHROPIC_API_KEY: undefined,            // neutralize conditional injection + any ambient value
  ANTHROPIC_MODEL: passthrough.model,       // main-loop pin (CLI --model also set via options.model)
  ANTHROPIC_SMALL_FAST_MODEL: passthrough.model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: passthrough.model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: passthrough.model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: passthrough.model,
  CLAUDE_CODE_SUBAGENT_MODEL: passthrough.model,   // Task subagents never request a Claude id from a foreign endpoint
  ENABLE_TOOL_SEARCH: "false",              // forced regardless of agent toolSearch / hive.yaml mode
} : {})
```

The `undefined`-scrub pattern is established (`CLAUDECODE: undefined`, `:1915`). `ENABLE_TOOL_SEARCH` is forced `"false"` for passthrough spawns — `tool_reference` blocks are unsupported on translation endpoints (same failure mode as the KPR-329 proxy note); the `resolveToolSearchMode` call is bypassed for passthrough (log the forced mode at debug; no `ToolSearchSource` union change — the source type stays untouched).

3. Everything else — MCP servers, skills, hooks, prefix cache, memory, `strict-mcp-config`, session resume via `options.resume` — runs the existing Claude-lane code untouched (parity by construction). All-pins-to-one-model is deliberate v1 posture (no per-tier foreign model mapping; a future table field can differentiate fast-model economics if wanted — YAGNI now).

### D6 — `:effort` survival

`splitProviderModel` already parses the suffix; D2 carries it on Lane A routes. Delivery into the Claude adapter's existing effort channel happens in `prepareSpawn`: the current non-Claude early return (`agent-manager.ts:1359-1361`, router pilot gate — correctly skipped for Lane A too: foreign ids are off-catalog, `supportsEffort` is false, KPR-322 rule stands) splits so Lane A routes return `effortOverride: clampLaneAEffort(staticRoute.reasoningEffort)`:

- `low|medium|high` pass through → `AgentProviderTurnRequest.effort` → `runner.send` → SDK `Options.effort` (the runner's existing `{low,medium,high}` narrowing at `agent-runner.ts:1894` is the deliverable set).
- `minimal|none|xhigh` → warn once per agent-model (reuse the `effortIncapableWarned`-style once-guard pattern) and drop to `undefined` — explicit at the shaping seam rather than silently swallowed by the runner's narrowing.
- Whether the foreign endpoint honors, ignores, or rejects the effort param is validation item V4; static-suffix-only (no per-turn tuning) is epic canon (D8).
- The Lane A split returns `resourceLimits: undefined` (the runner's per-agent legacy fallback applies) — do **not** compute Claude static-tier limits for foreign models. `SpawnShaping.effortOverride`'s doc comment ("Set only by the router merge branch", `agent-manager.ts:218-224`) is updated when this branch lands.

### D7 — Resolved-provider ops attribution (by construction + pinned)

The provider-identity invariant (epic D8): route provider ≠ adapter class. Post-union-growth, each surface keys correctly **without modification** — the child's job is to pin each with a test:

| Surface | Mechanism (already route-keyed) | Result for `kimi/…` agent |
|---|---|---|
| Breaker permit + record | `acquire(route.provider)` at `agent-manager.ts:672-676`; record on same permit | Kimi faults trip the `kimi` breaker only; lazy per-provider breaker creation (`provider-circuit-breaker.ts:472`) needs no registry change |
| Outage queue + honest notices | dispatcher `providerFor(agentId)` (`dispatcher.ts:561,705`) → route provider | `kimi` outage episodes; Claude turns unaffected |
| Telemetry / audit | `agent_turn_telemetry.model` + activity log read `agentConfig.model` (prefixed string); `modelTier` stays Claude-only (`:1476`) | provider attribution via the prefixed model string; `circuit_breaker_stats` heartbeat picks up the `kimi` breaker automatically |
| Session provider tag | `finalizeSpawnResult` persists `route.provider` (`:1516`); semantics `client-transcript` → real handle persisted | resume works within-provider; `SessionStore.normalizeRef` returns the handle for `kimi`-tagged rows |
| KPR-313 guard | `sessionProvider !== route.provider` (`:716`) | `claude→kimi` (or reverse, or `kimi→deepseek`) = fresh session + memory-handoff annotation; `kimi→kimi` resumes. The KPR-353 `turnHistoryStore.clear` on handoff fires harmlessly (no replay rows exist for Lane A) |
| Handoff notice variant | condition at `:1349` currently `=== "claude"` | **one real change:** the Claude-variant notice (with the `conversation_search` clause) must be used for Lane A too — Lane A agents have full tools. New condition: Claude-runtime lane membership (`provider === "claude" || isLaneAProvider(provider)`), not Lane B membership, so future ids fail toward the tool-free variant |
| Error classification | provider-neutral pattern tables; foreign 401/429/5xx strings from the CLI's `RunResult.error` match the same rows | correct fault kinds against the `kimi` breaker. Note: a foreign 401 also matches `isAuthRebuildResumeError` → one harmless resume-strip retry before classification — accepted, identical to Claude-lane behavior |

Frozen surfaces stay frozen: Open-Circuit Contract fields, `HARD_FAULT_KINDS`, `llmMs` semantics — untouched.

### D8 — Config + curated credentials

- `src/config.ts`: add `kimi: { agentModel: optional("KIMI_AGENT_MODEL", "") }` and `deepseek: { agentModel: optional("DEEPSEEK_AGENT_MODEL", "") }` — same shape as codex/openai/gemini. (These are non-secret model ids; the secret keys deliberately do NOT get boot-time `optional()` entries — D4 resolves them per spawn.)
- `src/setup/credential-registry.ts`: two `CredentialEntry` rows (`kind: "secret"`, fields `KIMI_API_KEY` / `DEEPSEEK_API_KEY`, vendor console `helpUrl`s) so `hive credentials add KIMI_API_KEY` works through the curated registry — the paved path (DOD-212; no raw-env instructions in docs).
- No hive.yaml section, no per-agent flags, no kill switch: an operator opts in per agent by setting `model: kimi/…` via `admin_agent_update` + SIGUSR1, and rolls back the same way (simplicity canon — the model field IS the lever).

## Edge cases

- **Bare prefix** (`model: "kimi/"`): route.model `""` → falls to `config.kimi.agentModel` → table `defaultModel`. Same chain as codex today.
- **Slashless passthrough name** (`model: "kimi"`): no `/` ⇒ routes to Claude as a (bad) bare model id — pre-existing behavior shared with `codex`; documented, not changed here.
- **Registry hot-reload mid-turn:** the `?.model ?? ""` guards at acquire (`:672`) and `prepareSpawn` (`:1305`) already produce the degenerate claude route; unchanged behavior, no new throw surface in the R7 window (credential resolution throws inside the recorded try, not the acquire window).
- **`:effort`-only suffix on Lane A** (e.g. `kimi/:high`): `splitProviderModel` handles it (model `""` → default chain).
- **Voice channel on a Lane A agent:** runs the Claude runtime against the foreign endpoint (works by construction, latency uncharacterized). The epic's voice-pin ruling (voice pins Claude lane) is not yet implemented anywhere and is not this child; parity matrix (child 10) lists voice as a Lane A caveat until then.
- **Reflection turns:** provider-agnostic (post-quiescence debounce, same spawn path) — run against the foreign endpoint like any turn.
- **`ANTHROPIC_BASE_URL` ambient in process.env:** the runner spreads `...process.env` first; the passthrough block overrides. For **non**-passthrough spawns an ambient base URL passes through today — pre-existing behavior, out of scope.
- **CLI cost reporting:** `costUsd` computed by the CLI against Claude pricing — nominal for foreign models. Documented caveat; telemetry/audit fields are otherwise correct. Budget enforcement (`maxBudgetUsd`) consequently tracks nominal pricing — acceptable, documented.
- **Foreign-endpoint bad model id:** surfaces as the SDK's rejected-model string or a vendor 4xx → `bad-model`/`non-provider` classification — config fault, never trips (existing taxonomy).

## Testing surface

Unit (all colocated `*.test.ts`, existing harness patterns):

1. `resolveProviderModel`: `kimi/m`, `deepseek/m`, `kimi/m:high` (effort survives), `kimi/` (empty model), unknown-prefix fallback unchanged; `providerFor` maps a kimi-model agent → `"kimi"` (extend the KPR-307 block at `agent-manager.test.ts:2255`).
2. `types.test.ts` pins: `SESSION_SEMANTICS` covers kimi/deepseek as `client-transcript`; `LaneBProviderId` set unchanged (regression pin per canon); `persistsResumableHandle` true for both.
3. `createProviderAdapter`: Lane A route → `ClaudeAgentAdapter` (never `assembleProviderTurn` — spy/flag); missing credential → `TurnAssemblyError` whose classification is `non-provider` (breaker-invisible — assert via `classifyThrown`).
4. Passthrough env builder (export the pure helper): exact pin set, `ANTHROPIC_API_KEY: undefined` neutralization, `ENABLE_TOOL_SEARCH: "false"` regardless of agent/hive toolSearch mode, effectiveModel override while `agentConfig.model` stays prefixed.
5. `finalizeSpawnResult` + `SessionStore`: kimi turn persists real sessionId with `provider: "kimi"`; `normalizeRef` returns the handle; unknown-provider row still fails closed.
6. KPR-313 guard: `claude→kimi` trips handoff (fresh + annotation, **Claude-variant notice** — pin the conversation_search clause); `kimi→kimi` resumes; `kimi→deepseek` trips.
7. Breaker attribution: three hard faults on kimi turns open the `kimi` circuit; a subsequent claude-agent turn acquires cleanly (extend existing registry tests).
8. `prepareSpawn` Lane A: router skipped (no `routeModel` call), `effortOverride` = clamped route effort; `xhigh` → undefined + one warn.

Negative-verify (feedback canon): for the routing tests, confirm they fail against the pre-change `resolveProviderModel` (unknown-prefix fallback would yield `claude`).

## Live-endpoint validation (gate before any production reassignment)

Run on a dev machine with an active Claude subscription login (the fleet's steady state — this is the hazardous configuration, deliberately). Needs one funded Kimi key and one funded DeepSeek key seeded via `hive credentials add`.

- **V1 — credential precedence spike (BLOCKING).** Minimal SDK `query()` (or a dev-instance agent turn) with the passthrough env injected. Verify the request actually lands at the vendor: (a) response model id is the foreign model, (b) vendor console usage ticks, and (c) the **negative control** — an intentionally invalid vendor token must produce a vendor 401, *not* a successful completion via the subscription OAuth path. If the logged-in OAuth session outranks the injected env, evaluate in order: `ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN` (with the no-key posture note: this is a *vendor* key in a subprocess env, not an Anthropic key); CLI settings overrides (`apiKeyHelper` / force-login-method surfaces) via `options.extraArgs`/settings; escalate to QUESTIONS_FOR_HUMAN if no supported override exists. Document the winning mechanism in the spec's implementation notes. If the winner is the `ANTHROPIC_API_KEY`-as-carrier fallback, record it as an explicit `# Decision Register Entry` at that time — it is canon-adjacent to the no-ANTHROPIC_API_KEY posture and warrants an auditable ruling, not an implementation note.
- **V2 — full-runtime fidelity, per vendor.** One real dev agent reassigned to `kimi/…` then `deepseek/…`: MCP tool round-trips (in-process + stdio), hooks firing (archetype PreToolUse), skill load, a Task subagent spawn (verify the subagent-model pin held — no Claude id in vendor logs), streaming partials, and a second turn resuming the first's session id (context retained, `sessions` row tagged with the Lane A provider).
- **V3 — server-side tool absence.** Invoke WebSearch/WebFetch on the foreign endpoint; record the observed failure shape. Ruling default: leave as a documented caveat + matrix row (client-side substitutes exist: brave-search, browser/CDP). If the failure is turn-fatal rather than tool-error-shaped, file a follow-up to strip server-side tools from passthrough spawns — not in this child unless trivially small (clean-wrap canon).
- **V4 — `:effort` delivery.** Turn with `:high` — confirm the vendor accepts or ignores `Options.effort` without a turn-fatal error.
- **V5 — breaker/outage attribution live.** Point the table's baseUrl at an unreachable host on a dev instance: three turns → `kimi` circuit opens (`circuit_breaker_stats` shows provider `kimi`), honest-outage notice fires once, turns queue and replay on restore; a Claude agent on the same instance keeps working throughout.
- **V6 — KPR-313 transition.** Reassign a threaded agent `claude→kimi` mid-thread: handoff annotation observed, fresh session; reassign back and verify the inverse.

Validation results land as a short evidence section appended to this spec (or the plan's verification log), per verify-before-claims.

## Open assumptions (delegated)

- ⚠ V1 outcome unknown (blocking gate, spike scoped above). All other design elements are independent of its resolution except the exact auth env var name, isolated in the table (`authTokenKey` semantics) and the env builder.
- ⚠ Exact pin-set sufficiency (`ANTHROPIC_SMALL_FAST_MODEL` inclusion; whether any additional `CLAUDE_CODE_*` model env exists in the current CLI) — verified during V2 by asserting no Claude model id appears in vendor-side logs; pin list adjusted at plan time against the CLI version hive ships.
- ⚠ Default model ids for the table (`kimi-k2` family / `deepseek-chat` family) move fast — pinned at plan time from current vendor docs, overridable via `KIMI_AGENT_MODEL`/`DEEPSEEK_AGENT_MODEL` without a code change.
- Non-blocking: voice-pin child remains unassigned at the epic level (Lane A does not worsen voice behavior); parity-matrix rows for kimi/deepseek are child 10's artifact, fed by V2–V4 results.
