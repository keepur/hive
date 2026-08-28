# KPR-392 — Grok promotion: first-class native adapter on the shared implementation layer

**Epic:** KPR-385 (Provider first-class-ness) · **Type:** feature (behavior-bearing) · **Status:** spec draft · **Depends on:** KPR-391 (merged @ `def333d`)

## TL;DR

Grok graduates from Lane A passthrough (Claude runtime pointed at the CLIProxyAPI gateway, Claude-shaped prompts, client-transcript sessions, xhigh inexpressible) to full Lane B citizenship: a native `GrokGatewayAdapter` built on the KPR-391 layers (`LaneBTurnScaffold` + `runBoundedDispatchLoop` + a fourth `LaneBProviderModule` entry — the C6 contract's fourth in-tree consumer), speaking the gateway's OpenAI **chat-completions** surface with **stateless-replay** session semantics on the existing `provider_turn_history` machinery. Auth posture is unchanged: the gateway keeps the `grok login` subscription OAuth; hive's credential remains `GROK_GATEWAY_KEY` (env→Honeypot, per spawn), and no `XAI_API_KEY` exists anywhere in this design.

## Key Points

- **Gateway surface decision (investigated live):** the pinned gateway (v7.2.134, loopback `:8317`) exposes all three surfaces — `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages` (probed 2026-08-25: models list + malformed-body POSTs; route-existence confirmed without running completions). The adapter targets **`/v1/chat/completions`**: it is the thinnest translation path (OpenAI-compat in → xAI's OpenAI-format backend, near-passthrough), the surface beekeeper already proved live on this same gateway+OAuth session (KPR-370/378), and the KPR-384 lesson — cross-shape translation layers breed quirks — argues directly against routing through the gateway's Responses→chat-completions translation when a native-shape surface exists.
- **Session semantics decision (part of this spec): `stateless-replay`.** The gateway is a stateless translation proxy (no persistence tier; upstream `previous_response_id` handling is bugged even for genuine OpenAI backends — CLIProxyAPI issues #2596/#2594), xAI's subscription backend offers no documented server-side retention reachable through it, and chat completions is inherently whole-context-per-request anyway. Continuity = hive-persisted replay via the existing shape-agnostic `TurnHistoryStore` (`provider_turn_history`, opaque items, per-(agent, thread, provider) keying, 200k-char whole-turn trim, 7d TTL, provider-handoff clear already provider-agnostic). `SESSION_SEMANTICS.grok` flips `client-transcript` → `stateless-replay`.
- **Module shape (C6/C7):** `grokModule` joins `LANE_B_PROVIDER_MODULES`; `LaneBProviderId` grows `"grok"` (compile-forcing the tool-transport compatibility columns). `LaneBModuleDeps.providerConfig` gains one optional field, `baseUrl` — caller-resolved like the rest of the slice (C7), a deliberate pre-freeze ABI stress per C6. The manager resolves `GROK_GATEWAY_KEY` (env→Honeypot, per spawn — `hive credentials add` keeps next-spawn effect) and the validated `GROK_GATEWAY_URL` override into that slice; missing key stays a `TurnAssemblyError` (breaker-invisible).
- **Effort — xhigh becomes expressible:** the `:effort` suffix delivers as chat-completions `reasoning_effort`, verbatim for `{low, medium, high, xhigh}`; `minimal`/`none` coerce to `low` with a warn-once (gemini precedent). The Lane A clamp that dropped xhigh no longer applies to grok.
- **C5 from birth:** all stream-phase and non-stream error decoration is status-prefixed (`<status> <body>`) so `FAULT_PATTERNS` classification sees the status — grok must NOT inherit codex's `response.failed` message-only drop (KPR-395).
- **Lane A retirement is a hard cutover:** grok leaves `PASSTHROUGH_PROVIDERS`/`LaneAProviderId`; no dual-lane config flag (simplicity canon). Rollback = per-agent model change + SIGUSR1, or `hive rollback` to the prior engine. Upgrade cost: each live grok thread silently starts fresh context once (same provider id ⇒ no KPR-313 annotation fires) — accepted and documented.
- **Out of scope:** any xAI-direct endpoint or `XAI_API_KEY` (operator-settled 2026-08-24 — do not re-ask), gateway version bumps, moving openai onto the hive loop (C1), KPR-394 plugin loading itself, voice-on-grok validation, cost/pricing normalization.
- ⚠ **Delegated assumptions (validation-gated, not design-gated):** the gateway's chat-completions surface handles streamed `tool_calls` + `stream_options.include_usage` for the grok backend correctly (proven for plain completions via beekeeper; the tools leg gets one live smoke at implementation), and grok-4.6 accepts `reasoning_effort: "xhigh"` through the gateway. Residual risk: xAI's `required`-array validator quirk resurfacing on its OpenAI surface — mitigation is a one-line adapter-local schema normalization (`required: []` where absent), added only if validation bites.

---

## 1. Problem

KPR-384 made grok *work* (Lane A passthrough through the operator-hosted CLIProxyAPI gateway), but as a second-class citizen, documented as such across `docs/providers.md`:

- **Double translation:** hive speaks Claude-shaped `/v1/messages` at the gateway, which re-translates to xAI's OpenAI-format backend. Every turn crosses two format boundaries; rows 1–15 of the grok column describe behavior "observed through that translation layer".
- **Session semantics are a fiction:** `client-transcript` resume replays the Claude CLI transcript against a cold vendor cache — no native continuity model at all.
- **xhigh inexpressible:** the Lane A `{low,medium,high}` clamp drops grok's native top reasoning level (`clampLaneAEffort`, warn-once-then-drop).
- **Nominal cost accounting:** Claude pricing math on a grok turn (row 15 caveat).
- **No Lane B guarantees:** no partitioned tool inventory, no guardrail-gate bridge path, no bounded dispatch loop, no real token counts, no wall-clock-deadline semantics of its own — everything is inherited Claude-lane behavior pointed at a foreign backend.

KPR-391 built the implementation layer precisely so that provider #4 is "API-shape glue + auth + session strategy + a `SESSION_SEMANTICS` line + config defaults" (its Goal 1). Grok is provider #4, and C6 names this ticket the contract's fourth consumer — the last gate before the KPR-394 ABI freeze.

## 2. Goals

1. `grok/<model>[:<effort>]` routes to a native Lane B adapter with real turn assembly (`assembleProviderTurn`: Lane B system prompt, partitioned inventory, fail-closed guardrail gate), real hive tool execution via `ToolBridge`, delegate Task subagents, and the scaffold-owned #407 deadline — the full Lane B guarantee set.
2. A ruled, implemented session-semantics model (stateless-replay) instead of cold-cache transcript replay.
3. `:xhigh` expressible end to end.
4. Real token counts; `costUsd: 0` (subscription/gateway billing out of cost-telemetry scope, codex/gemini precedent).
5. Auth posture byte-compatible with KPR-384 operations: same `GROK_GATEWAY_KEY`, same env→Honeypot per-spawn resolution, same `GROK_GATEWAY_URL` override with the same https-or-loopback validation, gateway keeps the OAuth session.
6. `docs/providers.md` grok column rewritten as a Lane B column (KPR-355 duty), plus the Lane A prose/footnote cleanup.

## 3. Non-goals

- **No xAI-direct path, no `XAI_API_KEY`** — the gateway remains the sanctioned (operator-owned) middlebox; a future gateway retirement is its own ticket if xAI ever fixes its compat validator.
- **No gateway changes** — version stays operator-pinned (v7.2.134); this ticket consumes its existing surface. No new gateway config, no `api-keys` changes.
- **No server-side session chaining** — ruled out in §4.2; not a deferred maybe.
- **No dual-lane transition flag** — hard cutover (§4.7); rollback is engine- or agent-level, not a config lever.
- **No shared "OpenAI chat-completions driver" abstraction** — grok's wire shape is grok-module code per C9's division (generic SSE framing is shared; event application is per-adapter). If a second chat-completions provider ever lands, extraction is that ticket's call.
- **No changes** to scaffold/loop/bridge/assembly/classification behavior, to the other three modules, to kimi/deepseek Lane A, or to the breaker/outage machinery — grok plugs into all of them as-is.
- **No voice validation** — the parity matrix's voice ruling (Claude-lane models for voice agents) is unchanged.

## 4. Design

### 4.1 Gateway surface: `/v1/chat/completions`

Live probe of the pinned gateway (2026-08-25, read-only: `GET /v1/models` + empty-JSON POSTs that fail validation before any completion):

| Route | Result | Meaning |
|---|---|---|
| `GET /v1/models` | 200, OpenAI-format list incl. `grok-4.6`, `grok-4.5` (plus imagine/video/composer ids) | models surface live |
| `POST /v1/chat/completions` `{}` | 400 `model_not_found` (OpenAI error shape) | route exists |
| `POST /v1/responses` `{}` | 400 `model_not_found` (OpenAI error shape) | route exists |
| `POST /v1/messages` `{}` | 400 (Anthropic error shape) | the KPR-384 Lane A surface |
| unknown routes | 404 | probes are discriminating |

Chat completions is chosen over Responses:

1. **Thinnest translation.** xAI's backend is OpenAI-format ("translates to the vendor's OpenAI-format backend" — KPR-384). Chat-completions-in is near-passthrough; Responses-in adds a cross-shape translation exactly like the Anthropic→OpenAI layer whose quirks forced KPR-384 in the first place.
2. **Proven surface.** Beekeeper runs live against this gateway's chat-completions surface on the same OAuth session (KPR-370/378, parity-matrix row 17 evidence).
3. **Upstream Responses handling is the project's known weak spot** (issues #2596/#2594: `previous_response_id` chaining broken, round-robin breaks stateful flows). We would not use chaining (§4.2), but the signal about surface maturity stands.
4. Chat completions costs hive one new wire shape (request body + `chat.completion.chunk` application) — precisely the per-provider surface KPR-391 shrank the job to. The SSE framing (`data:` lines, `[DONE]`) is already shared (`sse.ts`, C9).

### 4.2 Session semantics: `stateless-replay`

Ruled here, per the ticket. Server-side chaining (openai/gemini-style `server-resumable`) is not viable:

- The gateway is a stateless translation proxy — no persistence tier of its own; anything "stored" would live at the vendor.
- xAI's subscription backend, reached through the gateway, documents no retention/chaining surface; even if a `store`-like field were silently accepted, a handle chained through an operator-restartable middlebox against an undocumented vendor retention window fails the retention arithmetic that justified `server-resumable` for openai (KPR-350) and gemini (KPR-352).
- Chat completions is whole-context-per-request by construction — replay is not an add-on, it is how the API works.

Therefore grok adopts the codex model minus codex's quirks:

- `SESSION_SEMANTICS.grok: "stateless-replay"` (one line; `persistsResumableHandle` ⇒ false, so no session handles are ever written — the write side is automatic).
- **History:** `TurnHistoryStore` reused unchanged — it stores opaque `unknown[]` items keyed `{agentId}:{threadId}:{provider}`, so grok's items are chat-completions messages (`user` / `assistant` incl. `tool_calls` / `tool` results; the system prompt is **never** stored — it assembles fresh each turn). Success-only whole-turn append with fail-soft `.catch`, 200k-char whole-turn trim, 7d TTL, and the manager's provider-handoff clear all apply verbatim (the clear is already provider-agnostic — `agent-manager.ts:979`).
- **No codex-style in-adapter 4xx self-heal in v1.** Codex's poisoned-replay heal (KPR-353 §D7, the loop's `onRequestError` restart affordance) exists because encrypted-reasoning items can go stale against backend key rotation. Grok's replay items are plain chat messages hive itself composed; a 4xx on them is a real request-shape bug, not a poisoned-history symptom — heal-by-clear would mask it. The loop hook stays unused (gemini precedent); revisit only on live evidence.
- **No encrypted-reasoning replay** — nothing in the chat-completions surface emits it; the codex effort-gated replay caveat does not port.
- **Fallback sessionId (C3):** grok takes the scaffold defaults — `fallbackSessionId` = `request.sessionId ?? ""`, no fabrication (codex's uuid is pilot legacy, explicitly not copied), and the default `interruptionSessionId`. Success sessionId = the loop's `lastProviderRoundId ?? fallback`, feeding the chat-completion `id` through — cosmetic under stateless-replay (never persisted), harmless, and keeps the loop formula untouched.

### 4.3 Module + construction seam (C6/C7/C8)

`grokModule` in `provider-modules.ts` — the fourth `LANE_B_PROVIDER_MODULES` entry, and deliberately the C6 freeze-gate consumer:

```ts
const grokModule: LaneBProviderModule = {
  provider: "grok",
  createAdapter: (args) =>
    new GrokGatewayAdapter({
      name: args.name,
      model: args.route.model || args.deps.providerConfig?.agentModel || "grok-4.6",
      apiKey: args.deps.providerConfig?.apiKey,     // GROK_GATEWAY_KEY, caller-resolved
      baseUrl: args.deps.providerConfig?.baseUrl,   // validated gateway URL, caller-resolved
      reasoningEffort: args.route.reasoningEffort,
      assembly: args.assembly,
      // C8 analog: history wiring in PRIMARY context only — nested grok
      // delegate turns provably never touch provider_turn_history.
      ...(args.context === "primary"
        ? { historyStore: args.deps.turnHistoryStore, agentId: args.deps.agentId }
        : {}),
    }),
};
```

- **ABI extension (pre-freeze, C6-sanctioned):** `LaneBModuleDeps.providerConfig` gains `baseUrl?: string`. Nothing else on the contract moves.
- **Caller-resolved slice (C7):** in `createProviderAdapter`, the grok arm of `moduleDeps.providerConfig` is built per spawn: `agentModel: appConfig.grok.agentModel`; `apiKey:` `GROK_GATEWAY_KEY` via the same env→Honeypot chain as today (per spawn — credential rotation keeps its next-spawn effect; missing/empty throws `TurnAssemblyError` with the existing `hive credentials add GROK_GATEWAY_KEY` remediation text, breaker-invisible by instanceof); `baseUrl:` default `http://127.0.0.1:8317`, `GROK_GATEWAY_URL` override validated by `assertSafeBaseUrlOverride` (exported from `passthrough-providers.ts`, where kimi/deepseek keep using it) — https, or http to loopback only, verbatim KPR-384 semantics. The module never reaches into Keychain or `process.env` — the engine resolves, the module consumes (DOD-212 posture, load-bearing for KPR-394).
- **Nested delegates:** nothing new — the manager's `delegateTurnRunner` already constructs through the module table; grok inherits budget accounting (`spawnBudget ≥ 2` note applies), lock exemption, abort chaining, the 600s nested backstop, D5.7 shaping, and breaker invisibility. The C8 history omission is the module rule above.

### 4.4 The adapter: `GrokGatewayAdapter` (`grok-gateway-adapter.ts`)

Scaffold + shared loop, per the KPR-391 shape (§4.4's table gains a grok column):

| Concern | grok |
|---|---|
| Engine | `LaneBTurnScaffold` + `runBoundedDispatchLoop` |
| Round transport | raw `fetch` → `{baseUrl}/v1/chat/completions`, `stream: true`, `stream_options: {include_usage: true}`, `Authorization: Bearer <gateway key>` |
| Stream consume | `sse.ts` framing (`splitSseEvents`/`parseSseEvent`/`isSseDone`) + grok-local `chat.completion.chunk` application: text deltas → `onStream`, `tool_calls` fragment assembly (index-keyed id/name/arguments concatenation), `usage` capture from the final chunk, `finish_reason` bookkeeping |
| Tool payloads | bridged inventory → OpenAI function tools; harvest = assembled `tool_calls`; `executeCall` → bridge → append `role: "tool"` message; `callId` hook = `tool_call.id` (dedup belt) |
| Session strategy | §4.2 — history replay: `load()` before round 1 (messages = replayed history + this turn's user message), success-only whole-turn `append()`; primary context only |
| Auth | constructor-injected gateway key (never resolved in-adapter); a gateway 401/403 (key removed from the `api-keys` allowlist mid-flight) surfaces as a status-prefixed error → `auth` fault |
| Error decoration | **C5 from birth:** non-2xx round → `Grok gateway request failed: <status> <body-excerpt>`; stream-phase error/`finish_reason` anomalies equally status-prefixed — never message-only |
| Effort | §4.5 |
| Deadline / abort / bridge / result | scaffold-owned (C2) — nothing adapter-local |
| Fallback sessionId | scaffold defaults (C3, §4.2) |

`maxTurns: 0` ⇒ immediate `error_max_turns` with no network call, and all four abort checkpoints, arrive free with the loop (C10-pinned there already). The 128-tool cap, pinned tier, omission logging, skill index + `load_skill`, and the delegate Task synthesis all arrive free with assembly/bridge.

### 4.5 Effort mapping — xhigh now expressible

Route `:effort` → request `reasoning_effort`: `low`/`medium`/`high`/`xhigh` deliver verbatim; `minimal` and `none` coerce to `low` with a warn-once per (agent, model) (gemini's coercion pattern; chat completions has no "off" lever and `none` must not silently drop — Lane A's drop behavior is exactly what this ticket retires). No suffix ⇒ field omitted (vendor default). ⚠ The accepted value set through the gateway is a validation item; a rejected value surfaces as a status-prefixed 400 (attributable, not silent).

### 4.6 Error classification & ops

No new fault kinds, no `FAULT_PATTERNS` edits expected — decoration is designed to hit existing rows:

- Gateway down / unreachable → `ECONNREFUSED`/`fetch failed` → `connect-fail`. **Deliberate:** the loopback gateway is part of grok's route infrastructure; its death is a grok outage — trips only the grok breaker, engages the honest-outage queue (KPR-306/307 keying on the route provider is unchanged).
- Gateway key rejected → status-prefixed 401/403 → `auth`. Missing key → `TurnAssemblyError` (config fault, breaker-invisible) — the KPR-384 negative-verify posture (message contains "authentication"; the instanceof short-circuit is the guarantee) carries over.
- xAI 429/5xx pass through the gateway status-prefixed → `rate-limit`/`server-error`.
- `error_max_turns`, `error_turn_deadline` — loop/scaffold-owned, already classified (non-provider / turn-deadline-inconclusive).

### 4.7 Lane A retirement & rollback

Hard cutover, one PR:

- `passthrough-providers.ts`: grok row deleted; `LaneAProviderId` = `"kimi" | "deepseek"`; `isLaneAProvider` body shrinks; `assertSafeBaseUrlOverride` exported for the manager's grok arm. Kimi/deepseek byte-identical.
- `agent-manager.ts`: `ProviderModelRoute` grok member moves to the Lane B shape; the two Lane A branches (`createProviderAdapter` lines 579/595) drop grok; `clampLaneAEffort` no longer sees grok (full suffix set flows to the route); the Lane A session-handoff-notice arm no longer matches grok (it takes the Lane B variant correctly by construction).
- `types.ts`: `LaneBProviderId` = `"openai" | "gemini" | "codex" | "grok"`; `SESSION_SEMANTICS.grok` → `"stateless-replay"`; the "Lane A must never gain a compatibility column" canon comments updated to reflect the promotion (kimi/deepseek keep the guarantee).
- `tool-transport.ts`: every compatibility record gains a grok column (compile-forced by the union), values mirroring codex's.

**Rollback:** per-agent — set `model` back to a Claude id (or any other provider) + SIGUSR1, effective next spawn. Fleet — `hive rollback` restores the prior engine where grok is Lane A. Post-rollback residue is inert: `provider_turn_history` grok docs are unread by Lane A and TTL out in 7d; no session handles were written (stateless-replay), so Lane A resumes from empty and mints fresh CLI sessions.

**Upgrade migration cost (accepted):** an existing grok thread's Lane A transcript is unreadable by Lane B; its first post-upgrade turn starts fresh context with an empty history store. The provider id doesn't change, so the KPR-313 handoff annotation deliberately does not fire — a one-time, per-thread silent reset, called out in the release notes rather than special-cased in code (no one-shot levers). Stale Lane A grok session rows are ignored (adapter uses history, not `request.sessionId`) and TTL out.

### 4.8 Model catalog & parity matrix

- **Catalog (KPR-381): no code change.** Grok stays a curated `agent_model_catalog` provider (already seeded with `grok-4.6`/`grok-4.5` — still the only subscription-reachable ids). The live gateway `/v1/models` is deliberately NOT adopted as a resolution source: it lists imagine/video/composer ids the agent lane cannot use, and curation is the ruled posture for subscription-auth providers. Ops note: no refresh needed unless xAI's subscription set changes.
- **Parity matrix (KPR-355 duty):** the grok column exits the Lane A group and is rewritten row by row to Lane B values — headline cells: row 1 hive-owned bounded chat-completions dispatch loop via the gateway; rows 2–9 the standard Lane B cells (fail-soft MCP, hive builtin executor, `claude-only` server-side tools, 128-cap, index+`load_skill`, memory `full`, no-PreCompact guardrail gate); row 10 `caveat(hive-persisted replay via self-hosted gateway)`; row 11 delegates-only; row 12 `caveat(reasoning_effort; xhigh expressible; minimal/none coerce to low)`; row 13 uncached per-spawn; row 15 `caveat(costUsd 0; real token counts)` — the nominal-Claude-pricing caveat retires; row 16 unchanged in substance (gateway API key via Honeypot, gateway owns OAuth); row 17 `unit-tested; live validation gated on post-merge rollout`. Lane A prose, footnotes 5/6/10/11/12/15/16, ruled non-goal 1, and a dated history entry all updated in the same PR; the grok-cost-attribution revisit trigger stays.

## 5. Integration points

- `provider-modules.ts` / `provider-module.ts`: fourth entry; `providerConfig.baseUrl` extension (§4.3). Both manager construction sites get grok for free through the table.
- `agent-manager.ts`: §4.7 route/branch edits + the grok `moduleDeps` slice resolution. Breaker permit/record, outage gate, `finalizeSpawnResult`, self-heal arms (grok qualifies for neither `server-resumable` arm — correct by semantics gating), reflection, telemetry: untouched.
- `turn-assembly.ts` / `tool-bridge.ts` / `builtin-executor.ts` / `archetype-gate.ts` / `skill-index.ts`: unchanged consumers — grok flows through on the widened union.
- `turn-history-store.ts`: unchanged (shape-agnostic, provider-keyed).
- `sse.ts`: consumed as-is (C9 — framing shared, event application grok-local).
- `error-classification.ts`: unchanged (§4.6).
- `config.ts`: unchanged — `grok.agentModel` (`GROK_AGENT_MODEL`) survives as the module default chain's middle link; `GROK_GATEWAY_KEY`/`GROK_GATEWAY_URL` stay per-spawn-resolved, never boot-time.
- `docs/providers.md`: §4.8.

## 6. Edge cases

1. **Gateway restarts mid-turn** → in-flight fetch fails (`ECONNRESET`/`fetch failed`) → `connect-fail`, breaker-attributed to grok; next turn reconnects (stateless — nothing to heal).
2. **`required`-array quirk on the OpenAI surface:** believed Anthropic-validator-specific (KPR-384 bisect), but the same schemas now travel a new path. If live validation 400s on a tool schema, the mitigation is an adapter-local normalization (`parameters.required ??= []`) in the request builder — one line, no bridge/transport change. Not built preemptively.
3. **Streamed `tool_calls` fragmentation:** chunks deliver id/name/arguments incrementally by index; the application code must assemble before harvest and never emit partial calls. A chunk stream ending without `finish_reason` (gateway drop) surfaces as a status-prefixed stream error (C5), not a silent empty harvest.
4. **Usage absent** (gateway omits `include_usage` support): totals stay 0 — degrades to openai's documented row-15 posture rather than failing the turn; flagged by the validation smoke. ⚠
5. **History at the char budget:** whole-turn trim drops oldest turns — long grok threads degrade gracefully to recent-context, same as codex.
6. **Concurrent same-thread turns:** serialized by the per-thread lock as everywhere; history append is per-turn whole-turn, so no interleaved-item corruption window beyond what codex already tolerates.
7. **`grok/:high` (suffix without model):** parses `:high` as the model id — vendor 400s, config error, matching the documented Lane-wide behavior (footnote 12); unchanged.
8. **Model id not in the subscription set** (e.g. `grok/grok-3-mini` while the gateway account lacks it): gateway/vendor 4xx, status-prefixed; the `bad-model` row only matches its SDK prose, so this classifies by status — acceptable, matches codex behavior for the same mistake.
9. **Nested grok delegate hits its deadline** → scaffold deadline sentinel → manager maps to the existing prose Task text — all inherited, nothing grok-specific.

## 7. Testing implications

C10's zero-expectation-edit standard governs the **shared layers**: scaffold, loop, sse, bridge, assembly, classification, and the 223 manager tests pass unedited — except tests that pin grok's Lane A behavior (grok rows in `passthrough-providers.test.ts`, any manager Lane A grok arms), which are removed/rewritten as enumerated, deliberate behavior-bearing deltas in the plan (this is a feature ticket; the enumeration keeps the delta honest).

New tests (additive, modeled on the gemini/codex suites):

- **Adapter:** request-body shape (messages incl. replayed history, tools, `stream_options`, `reasoning_effort` mapping + warn-once coercion); chunk application (text deltas, fragmented `tool_calls` assembly, usage capture); harvest/dedup/`executeCall` round-trip through a mocked bridge; C5 status-prefixed decoration on non-2xx and stream-phase errors; history success-only append / no-append-on-error / no-append-on-deadline; `request.sessionId` ignored by transport; scaffold-default fallback `""` (no fabrication).
- **Module/registry:** primary-vs-nested construction parity — nested omits `historyStore`/`agentId` (C8 analog, mirroring the codex module test); default model chain (`route → agentModel → "grok-4.6"`).
- **Manager:** grok routes Lane B (adapter construction, no passthrough resolution); missing `GROK_GATEWAY_KEY` → `TurnAssemblyError`, breaker-invisible; `GROK_GATEWAY_URL` validation preserved (loopback-http ok, cleartext off-box refused).
- **Classification crosscheck:** grok's characteristic decorated strings (gateway 401, 429, 5xx, `ECONNREFUSED`, deadline sentinel) → expected `ProviderFaultKind` rows, in `classification-crosscheck.test.ts`.
- **Negative verification** (repo practice): (a) strip the status prefix from the stream-error decoration and confirm the crosscheck test fails — proves C5 is pinned, not incidental; (b) throw the missing-key message as a plain `Error` and confirm it would classify `auth` — proves the `TurnAssemblyError` wrapper is load-bearing (the KPR-384 leg, re-run on the new arm).
- **Live smoke (implementation-gated, operator-run):** one grok turn on a dev instance through the real gateway — tools executing, streamed text, usage present, `:xhigh` accepted — closing the ⚠ assumptions; plus the standing V4–V6 rollout validation absorbing the Lane B switch.

## 8. Open assumptions

- ⚠ Gateway chat-completions handles streamed `tool_calls` for the grok backend (beekeeper proved plain completions; tools leg is the live-smoke gate). Fallback if broken: this is a gateway-version conversation with the operator, not an adapter redesign — the wire shape is correct OpenAI-compat.
- ⚠ `reasoning_effort: "xhigh"` accepted through the gateway for grok-4.6 (vendor-undocumented; smoke-validated). A rejection surfaces attributably (status-prefixed 400).
- ⚠ `stream_options.include_usage` honored; absent-usage degrades to zero counts (edge 4), not a failure.
- ⚠ The `required`-array quirk stays Anthropic-surface-only; mitigation pre-designed (edge 2), not pre-built.
- ⚠ `providerConfig.baseUrl` as the ABI extension shape (vs a grok-private options channel) — C6 sanctions stressing the contract pre-freeze; trivially revisable at plan review.
- ⚠ No in-adapter 4xx heal for grok v1 (§4.2 reasoning) — revisit on live evidence, not preemptively.
- Canon consulted: epic Decision Register C1–C10 (all honored; C5, C6, C7, C8, C9 load-bearing above), KPR-391 spec/plan, `docs/providers.md`, CLAUDE.md §Provider adapters + §Grok, KPR-384 (PR #398) history. No open product questions — the one operator-settled matter (no `XAI_API_KEY`, gateway posture) is preserved, not reopened.
