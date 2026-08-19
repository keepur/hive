# KPR-346 Implementation Plan — Lane A passthrough (Kimi + DeepSeek) + resolved-provider ops attribution

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-346-spec.md](./kpr-346-spec.md) (signed off @ 8e0a7ec, committed @ 16ccb50) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D1/§D2/§D8. Baseline: epic branch `kpr-345` — KPR-347/348/349/353 all landed; **all file:line anchors below re-verified against this worktree's HEAD 16ccb50** (identical tree to 8e0a7ec plus the spec commit).

**Goal:** Route `kimi/…` and `deepseek/…` model prefixes through the existing `ClaudeAgentAdapter`/`AgentRunner` (full hive runtime for free) with per-spawn env substitution — vendor Anthropic-compat base URL + Honeypot-resolved vendor key + foreign-model pins + tool-search forced off — and pin the by-construction resolved-provider ops attribution (breaker, outage queue, sessions, KPR-313 guard) with tests.

**Architecture:** A new dependency-light table module `src/agents/provider-adapters/passthrough-providers.ts` owns the Lane A provider defs (`kimi`, `deepseek`), per-spawn credential resolution (`resolvePassthroughSpawn` — throws `TurnAssemblyError` on missing key), and the pure env builder (`buildPassthroughEnv`). `AgentProviderId` + `SESSION_SEMANTICS` grow two entries (`client-transcript`); `resolveProviderModel` gains two prefix arms mirroring codex; `createProviderAdapter` gains a Lane A branch returning `ClaudeAgentAdapter` **before** `assembleProviderTurn` is reachable; `AgentRunner` gains one trailing options bag and, in `send()`, a passthrough env spread appended last so the pins win. `prepareSpawn` splits its non-Claude early return so Lane A delivers the static `:effort` suffix (clamped to `{low,medium,high}`) through the Claude adapter's existing effort channel. The KPR-313 handoff-notice condition widens from `=== "claude"` to Claude-runtime lane membership. Config + curated-credential registry rows make `hive credentials add KIMI_API_KEY` the paved path.

**Tech stack:** TypeScript strict, vitest beside source, existing harnesses (`agent-runner.test.ts` mocked-`query` + `getCapturedOptions()`; `agent-manager.test.ts` mocked runner/adapters/config; `session-store.test.ts` fake collection). No new dependencies.

**Decision-register canon honored (per task):**
- *`LaneBProviderId` never touched* — Lane A ids join `AgentProviderId` only (`types.ts:4`); the `LaneBProviderId` union (`types.ts:15`) and `TOOL_EXECUTING_PROVIDERS` are untouched; a compile-time pin freezes the Lane B set (Task 1).
- *Unknown DB provider strings fail closed* — `SessionStore.normalizeRef`'s `?? "stateless-replay"` posture (`session-store.ts:116-122`) is untouched; Task 1 adds a kimi-tagged-row positive pin plus keeps the unknown-provider scrub pin green.
- *No ANTHROPIC_API_KEY seeding* — vendor keys resolve per spawn via `process.env → fromKeychain` (the `agent-runner.ts:914` secret-env pattern); passthrough spawns explicitly neutralize the runner's conditional `ANTHROPIC_API_KEY` injection (`ANTHROPIC_API_KEY: undefined` in the spread). The spike's fallback ladder (Task 0) requires a `# Decision Register Entry` before any `ANTHROPIC_API_KEY`-as-carrier mechanism is adopted.
- *Credential faults are breaker-invisible* — missing key throws `TurnAssemblyError` inside the recorded try; `classifyThrown` short-circuits it to `non-provider` **before** the pattern tables (`error-classification.ts:126-129`). The guarantee comes from the instanceof short-circuit, and the thrown message deliberately contains the word "authentication" so that as a plain `Error` it WOULD regex-match the `auth` fault row — which is exactly what makes the Task 3 negative-verify leg meaningful (swap the typed wrapper for a plain `Error` and the breaker-invisibility test genuinely fails). Pinned in Tasks 1 + 3.
- *Breaker taxonomy frozen; llmMs excludes tool time* — zero edits to `error-classification.ts`, `provider-circuit-breaker.ts`, or any telemetry math; Lane A turns run the Claude runner whose `llmMs` semantics are unchanged.
- *Simplicity / model-field-is-the-lever* — no hive.yaml section, no kill switch, no per-tier foreign model mapping (all pins to one model, deliberate v1), no prefix aliases.

**D1 default-model pins (vendor-doc verified 2026-07-23):**
- **Kimi:** base URL `https://api.moonshot.ai/anthropic` (Moonshot's documented Claude Code pattern: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + model pins, per the Kimi-K2 agent-support docs and the `/anthropic/v1/messages` compat endpoint — [MoonshotAI/Kimi-K2#129](https://github.com/MoonshotAI/Kimi-K2/issues/129)). Default model **`kimi-k3`** — Moonshot's flagship since 2026-07-16 ([platform.kimi.ai models overview](https://platform.kimi.ai/docs/api/models-overview) lists `kimi-k3` latest; launch coverage [CNBC 2026-07-17](https://www.cnbc.com/2026/07/17/moonshot-ai-kimi-k3-model-openai-anthropic-china.html)); current Claude Code setup guides pin every `ANTHROPIC_DEFAULT_*` at `kimi-k3` against this endpoint ([codeagentswarm guide](https://www.codeagentswarm.com/en/guides/kimi-k3-with-claude-code)) — the same all-pins-to-one shape as spec §D5. Operator-overridable via `KIMI_AGENT_MODEL` (D8).
- **DeepSeek:** base URL `https://api.deepseek.com/anthropic`; default model **`deepseek-v4-pro`** — DeepSeek's own Claude Code integration doc recommends `ANTHROPIC_MODEL=deepseek-v4-pro` on this endpoint ([api-docs.deepseek.com — Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)). `deepseek-chat` is **deprecated 2026-07-24** (aliases `deepseek-v4-flash` non-thinking) and must not be the pin. The vendor recommends `deepseek-v4-flash` for the haiku/subagent pins; hive's v1 all-pins-to-one posture (spec §D5) deliberately diverges — recorded as a parity-matrix caveat, not implemented. Operator-overridable via `DEEPSEEK_AGENT_MODEL`.

**Spec rulings reflected:** V1 is a **blocking pre-implementation spike** (Task 0 — Tasks 1–5 do not start until its precedence legs are green); V2–V6 are a delivery-time checklist with graceful degradation (funded vendor keys optional/deferred/non-gating per HUMAN_DIRECTIVE precedent — keys absent ⇒ document + defer, code still ships, production reassignment stays gated); the `resolveToolSearchMode` call is bypassed for passthrough with no `ToolSearchSource` union change; `agentConfig.model` keeps the prefixed string for telemetry/audit while `options.model` gets the foreign id; Lane A `resourceLimits` stays `undefined` (runner legacy fallback — no Claude static-tier math for foreign models).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `passthrough-providers.ts` (table shape, model-resolution chain, credential resolution + `TurnAssemblyError`, env-builder exact pin set); `types.ts` growth pins (`types.test.ts`); `session-store.ts` kimi-row normalization (additive test only — zero source edits); `agent-runner.ts` passthrough env substitution over the mocked-`query` harness; `agent-manager.ts` routing arms + `:effort` survival + clamp.
  - Reason: every new behavior is a deterministic pure contract (table lookup, string parsing, env record shape) fully drivable without network/Mongo.
  - Minimum assertions: the T1/T2/T4/T5 blocks in Critical Flows below, each mapped to a step.

- Integration: **required**
  - Scope: manager-level flows through `spawnTurn` over the existing mocked-runner/adapter harness: (a) Lane A route → `ClaudeAgentAdapter` path (runner constructed with the passthrough bag; no pilot adapter constructor, no assembly — `buildProviderPrompt` never called); (b) missing-credential `TurnAssemblyError` rejection that is **breaker-invisible** (circuit stays closed after repeated throws); (c) breaker attribution (three hard faults on kimi turns open the `kimi` circuit; a claude agent acquires cleanly); (d) KPR-313 guard transitions (`claude→kimi` handoff with **Claude-variant** notice, `kimi→kimi` resume, `kimi→deepseek` trip); (e) `finalizeSpawnResult` persists the real handle with `provider: "kimi"`.
  - Reason: the child's core claim is by-construction attribution across module boundaries — only spawnTurn-level tests prove the seams key on the route.
  - Harness: **existing** — `agent-manager.test.ts` (mocked `AgentRunner` at `:87-108`, config mock at `:54-63`, `smsCtx`/`makeRunResult`/fake sessionStore, KPR-313 describe at `:2350`, KPR-306/307 describes at `:2066`/`:2255`); `agent-runner.test.ts` `getCapturedOptions()` (`:216-219`) + `fromKeychain` mock.
  - Minimum assertions: (a)–(e) above.

- E2E: **required** (manual, evidence-recorded — not in `npm run check`)
  - Scope: **Task 0, the V1 credential-precedence spike (BLOCKING gate)** — SDK-level, needs **no funded vendor account** (local-listener leg + invalid-token vendor negative control); plus the Task 5 delivery-time V2–V6 checklist (funded-key legs, graceful degradation).
  - Reason: the spec's one blocking assumption — injected `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` must outrank the dev machine's logged-in subscription OAuth session — is spike-resolved, not docs-guaranteed. If env does not win, the child is blocked (spec §V1).
  - Harness: **setup-required** — dev Mac with an active Claude subscription login (the fleet steady state — deliberately the hazardous configuration). Scratch tsx drivers in the session scratchpad (KPR-353 Task-0 precedent), never committed. No secret values printed (the spike token is deliberately fake; real keys, if present for optional legs, are presence-only).
  - Minimum assertions: Task 0 legs L1–L2 recorded in `docs/epics/kpr-345/kpr-346-spike-notes.md`; Task 5 checklist rows each marked done or explicitly deferred-with-reason.

### Critical Flows

- **T0 — V1 precedence spike (gate):** L1 local-listener probe — the SDK `query()` with the passthrough env block sends its request to the injected base URL carrying the injected token, and the turn errors rather than silently completing via OAuth against api.anthropic.com. L2 vendor negative control — invalid key-shaped token against the real Kimi and DeepSeek endpoints produces a vendor 401-shaped turn error, **not** a successful completion. **If env loses: STOP — walk the spec's fallback ladder (Task 0 contingency), do not improvise; escalate to QUESTIONS_FOR_HUMAN if no supported override exists.**
- **T1 — routing:** `kimi/m` → `{provider:"kimi", model:"m"}`; `deepseek/m` likewise; `kimi/m:high` → effort survives; `kimi/` → model `""`; `kimi/:high` → model `":high"` + **no** effort (the `colon <= 0` guard leaves the leading-colon string intact; vendor 4xx bad-model config fault, same as pre-existing `codex/:high`); unknown prefix (`mystery/m`) → claude fallback unchanged; slashless `kimi` → claude (pre-existing, documented); `providerFor` maps a kimi-model agent → `"kimi"` (extend the KPR-307 block at `agent-manager.test.ts:2255`). **Negative-verify: these fail against pre-change `resolveProviderModel` (fallback yields claude).**
- **T2 — semantics + persistence:** `SESSION_SEMANTICS` covers kimi/deepseek as `client-transcript`; `persistsResumableHandle` true for both; exhaustiveness pin lists six ids; Lane B compile pin unchanged; kimi turn through `finalizeSpawnResult` persists the real sessionId with `provider: "kimi"`; `SessionStore.normalizeRef` returns the handle for a kimi-tagged row; unknown-provider row still fails closed.
- **T3 — adapter selection + credential fault:** kimi route → runner constructed **with** `{ laneAPassthrough }`, `runner.send` called, zero pilot-adapter constructions, `buildProviderPrompt` (assembly) never called; missing credential → `spawnTurn` rejects with `/Passthrough credential missing \(authentication\): KIMI_API_KEY/`, and after three consecutive such rejections the kimi breaker still admits (breaker-invisible). **Negative-verify: swap the `TurnAssemblyError` throw for a plain `Error` → the breaker-invisibility test fails (the deliberately auth-matching message hits the `auth` row and trips).**
- **T4 — env substitution (runner):** exact pin set from `buildPassthroughEnv` (base URL, auth token, five model pins + `CLAUDE_CODE_SUBAGENT_MODEL`, `ENABLE_TOOL_SEARCH: "false"`); `ANTHROPIC_API_KEY` is `undefined` even though the runner-test config mock carries `anthropic.apiKey: "test-key"` and an ambient `process.env.ANTHROPIC_API_KEY` is set; `options.model` is the foreign id while `agentConfig.model` stays prefixed; `ENABLE_TOOL_SEARCH` is `"false"` even with `agentConfig.toolSearch: "on"`; `options.resume` still carries the sessionId; a non-passthrough spawn's env contains **no** `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` keys (regression — with ambient `process.env` values for both scrubbed/restored around the describe). **Negative-verify: drop the `buildPassthroughEnv` spread → pins fail.**
- **T5 — `:effort` survival + clamp:** `kimi/m:high` agent turn → `runner.send` receives `effort: "high"` (7th positional arg); router never called (`routeModel` zero calls — KPR-322 rule stands); `kimi/m:xhigh` → `effort: undefined` + exactly one warn per agent-model (second turn: no second warn); `resourceLimits` undefined on the Lane A path.
- **T6 — breaker attribution:** three hard-fault kimi turns (runner resolves `RunResult.error: "connect ECONNREFUSED"`) → 4th kimi turn rejects `ProviderCircuitOpenError`; a claude-model agent turn on the same manager still runs (extend the KPR-306 describe patterns at `agent-manager.test.ts:2066`).
- **T7 — KPR-313 transitions:** `claude→kimi` trips handoff — resume stripped, prompt starts with the **Claude-variant** notice (pin the `conversation_search` clause — Lane A agents have full tools); `kimi→kimi` resumes (`sessionArg === "s-1"`, no notice); `kimi→deepseek` trips. The guard's `turnHistoryStore.clear` fires harmlessly (existing mock, no Lane A rows).

### Regression Surface

- **Lane B:** `turn-assembly.ts`, `tool-bridge.ts`, `tool-transport.ts`, all three pilot adapters + their test files — **zero edits**; suites pass unmodified. `TOOL_EXECUTING_PROVIDERS` pin (`turn-assembly.test.ts:107-109`) stays exactly `{openai, codex}`.
- **Claude lane:** prefix builder + golden suite (`prefix-builder.golden.test.ts`) untouched — passthrough spawns use the identical prompt path. Existing `ENABLE_TOOL_SEARCH` pins (`agent-runner.test.ts:2745+`) pass unmodified (non-passthrough behavior is byte-identical).
- **Breaker/classification:** `error-classification.ts`, `provider-circuit-breaker.ts` untouched; every KPR-306/307 pin passes unmodified.
- **Session plumbing:** `session-store.ts` source untouched (additive test only); `finalizeSpawnResult` logic untouched (it consumes the grown union transparently); all KPR-313 pins at `agent-manager.test.ts:2350+` pass unmodified.
- **Codex replay:** `turn-history-store.ts` + KPR-353 wiring untouched; the handoff-clear call is provider-agnostic already.
- **Routing fallback:** unknown-prefix → claude (KPR-231) pinned before and after.

### Commands

- Fast loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/passthrough-providers.test.ts src/agents/provider-adapters/types.test.ts src/agents/session-store.test.ts src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts`
- Full gate (every chunk commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.
- E2E: scratch tsx drivers on the dev Mac (Tasks 0, 5); evidence in `kpr-346-spike-notes.md` + the PR description.

### Harness Requirements

- `npm ci` in the worktree if `node_modules` absent. Node 22/24 (dev-mode Node 26 broken per KPR-344).
- Unit/integration tests: no network, no Mongo, no real keychain — `agent-manager.test.ts` **must add** `vi.mock("../keychain/from-keychain.js")` (the default `resolveSecret` shells out to `security` on darwin; an unmocked miss would exec a real subprocess per test). `agent-runner.test.ts` already mocks it.
- Manager tests set `process.env.KIMI_API_KEY`/`DEEPSEEK_API_KEY` in the Lane A describe's `beforeEach` (env wins over keychain in the resolution chain) and delete them in `afterEach`.
- Task 0/5 live legs: dev Mac with active Claude subscription login; network to `api.moonshot.ai` / `api.deepseek.com`; funded vendor keys OPTIONAL (only the deferred-able Task 5 legs need them).

### Non-Required Rationale

- (none — all three groups required.)

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch — **and specifically if Task 0's precedence legs fail with no supported override on the spec's ladder** — demote the ticket to the spec lane. Do not improvise.
- Negative-verify discipline (operator standard) — four mandatory legs, each run against weakened code with the failing output recorded before restoring:
  1. **Routing (Task 3):** temporarily delete the two new `resolveProviderModel` arms → T1 routing tests fail (kimi/m resolves claude) → restore.
  2. **Env spread (Task 2):** temporarily remove the `...(passthrough ? buildPassthroughEnv(passthrough) : {})` spread → T4 pin tests fail → restore.
  3. **Credential-fault classification (Task 3):** temporarily replace `TurnAssemblyError` with plain `Error` in `resolvePassthroughSpawn` → the T3 breaker-invisibility test fails — the message deliberately contains "authentication", so the plain `Error` hits the `auth` pattern row, counts toward the trip streak, and the 4th spawn rejects `ProviderCircuitOpenError` → restore. (This leg is only meaningful BECAUSE the message is auth-matching: it proves the instanceof short-circuit, not message luck, is what keeps the fault breaker-invisible.)
  4. **Notice condition (Task 3):** temporarily revert the handoff-notice condition to `staticRoute.provider === "claude"` → the T7 `claude→kimi` Claude-variant pin fails (pilot variant, no `conversation_search`) → restore.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/epics/kpr-345/kpr-346-spike-notes.md` | create (Task 0) | V1 precedence-spike evidence + contingency record; Task 5 V2–V6 checklist verdicts |
| `src/agents/provider-adapters/passthrough-providers.ts` | create (Task 1) | Lane A table (§D1), `resolvePassthroughSpawn` (§D4), `buildPassthroughEnv` (§D5 pure half), `isLaneAProvider` |
| `src/agents/provider-adapters/passthrough-providers.test.ts` | create (Task 1) | table/resolution/env-builder unit pins + `classifyThrown` breaker-invisibility pin |
| `src/agents/provider-adapters/types.ts` | modify (Task 1) | `AgentProviderId` + two `SESSION_SEMANTICS` entries (§D2) — `LaneBProviderId` untouched |
| `src/agents/provider-adapters/types.test.ts` | modify (Task 1) | six-id exhaustiveness, kimi/deepseek resumable-true, Lane B compile pin |
| `src/agents/session-store.test.ts` | modify (Task 1, additive) | kimi-tagged-row handle returned; unknown-provider fail-closed stays green |
| `src/agents/agent-runner.ts` | modify (Task 2) | trailing options bag; `effectiveModel` override; tool-search bypass; env spread (§D5) |
| `src/agents/agent-runner.test.ts` | modify (Task 2, additive) | T4 env-substitution describe |
| `src/agents/agent-manager.ts` | modify (Task 3) | route union + prefix arms (§D2); Lane A adapter branch (§D3); `prepareSpawn` effort split + clamp (§D6); handoff-notice condition (§D7); `SpawnShaping.effortOverride` doc comment |
| `src/agents/agent-manager.test.ts` | modify (Task 3, additive + config-mock/keychain-mock extension) | T1/T3/T5/T6/T7 |
| `src/config.ts` | modify (Task 3) | `kimi`/`deepseek` `agentModel` sections (§D8) — lands with its first consumer so the Chunk 3 gate typechecks |
| `src/setup/credential-registry.ts` | modify (Task 4) | `KIMI_API_KEY` / `DEEPSEEK_API_KEY` curated rows (§D8) |
| `CLAUDE.md` | modify (Task 4) | Provider-adapters paragraph rider (Lane A passthrough) |

**NOT touched (spec canon):** `turn-assembly.ts` (+test), `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts`, `error-classification.ts`, `provider-circuit-breaker.ts`, `session-store.ts` source, `turn-history-store.ts`, all three pilot adapters (+tests), `claude-agent-adapter.ts`, `prefix-builder.ts`, `toolkit-section.ts`, `model-router.ts`, `LaneBProviderId`, `TOOL_EXECUTING_PROVIDERS`, `SESSION_SEMANTICS` **existing values**, `finalizeSpawnResult` logic, breaker acquire/record sites, `providerFor`, dispatcher, doctor.

---

## Task 0 (Chunk 0): V1 credential-precedence spike — BLOCKING gate (⚠ blocks Tasks 1–5)

**Files:**
- Create: `docs/epics/kpr-345/kpr-346-spike-notes.md`

The spec's one blocking assumption: on a subscription-logged-in machine, does the injected `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env outrank the OAuth session? Answerable with **no funded vendor account** — L1 needs only a local listener; L2 needs only an invalid key-shaped token. **Nothing after this task may start until L1 and L2 are green.** No secret values printed (the spike token is deliberately fake).

- [ ] **Step 0.1: Write and run the spike driver (session scratchpad, never committed)**

`<scratchpad>/kpr346-spike.ts`, run with `npx tsx` from the worktree (symlink `node_modules` per the KPR-348/353 precedent). Complete driver:

```typescript
/** KPR-346 V1 spike — CLI credential precedence on a subscription-logged-in Mac.
 *  L1: local listener — injected base URL + token actually used (deterministic, no vendor).
 *  L2: vendor negative control — invalid token → vendor 401, NOT an OAuth completion.
 *  NEVER COMMIT. The token is fake by design; never print real credentials. */
import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";

const FAKE_TOKEN = "sk-kpr346-fake-precedence-probe";

function passthroughEnv(baseUrl: string): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
    ANTHROPIC_API_KEY: undefined, // scrub conditional/ambient injection — mirrors §D5
    ANTHROPIC_MODEL: "kimi-k3",
    ANTHROPIC_SMALL_FAST_MODEL: "kimi-k3",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3",
    CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDECODE: undefined,
  };
}

async function runTurn(label: string, baseUrl: string, model: string): Promise<{ error?: string; text?: string }> {
  console.log(`\n=== ${label} (base=${baseUrl}, model=${model})`);
  const q = query({
    prompt: "Reply with the single word: pong",
    options: {
      model,
      maxTurns: 1,
      env: passthroughEnv(baseUrl),
      settingSources: [],
      extraArgs: { "strict-mcp-config": null },
    },
  });
  let out: { error?: string; text?: string } = {};
  try {
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      if (msg.type === "result") {
        const m = msg as { subtype?: string; result?: string; is_error?: boolean };
        out = m.is_error || (m.subtype && m.subtype !== "success")
          ? { error: `${m.subtype}: ${String(m.result ?? "").slice(0, 500)}` }
          : { text: String(m.result ?? "").slice(0, 200) };
      }
    }
  } catch (err) {
    out = { error: String(err).slice(0, 500) };
  }
  console.log(out.error ? `turn ERROR: ${out.error}` : `turn OK: ${out.text}`);
  return out;
}

// ── L1: local listener — where does the request go, and with which credential? ──
const hits: Array<{ path: string; scheme: string; bearerMatches: boolean; xApiKeyMatches: boolean }> = [];
const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  hits.push({
    path: req.url ?? "",
    scheme: auth.split(" ")[0] ?? "none",
    // Fake token — safe to compare, never print real ones. The CLI may carry
    // ANTHROPIC_AUTH_TOKEN as either `Authorization: Bearer …` or `x-api-key`;
    // both count as "injected credential used" for the auto-verdict.
    bearerMatches: auth === `Bearer ${FAKE_TOKEN}`,
    xApiKeyMatches: req.headers["x-api-key"] === FAKE_TOKEN,
  });
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "kpr346 probe" } }));
});
await new Promise<void>((r) => server.listen(8377, "127.0.0.1", r));

const l1 = await runTurn("L1 — local listener probe", "http://127.0.0.1:8377", "kimi-k3");
server.close();
console.log("L1 listener hits:", JSON.stringify(hits, null, 1));
// Either header form counts — the raw hit dump above is the authority; record
// in the spike notes WHICH header carried the token (feeds the Task 2 pin set).
const l1EnvWins = hits.length > 0 && hits.some((h) => h.bearerMatches || h.xApiKeyMatches) && !!l1.error;
console.log(`L1 verdict: env ${l1EnvWins ? "WINS" : "LOSES"} (request reached listener with injected token, turn errored honestly)`);

// ── L2: vendor negative controls — invalid token must yield a vendor 401, not an OAuth completion. ──
const kimi = await runTurn("L2a — Kimi negative control", "https://api.moonshot.ai/anthropic", "kimi-k3");
const dseek = await runTurn("L2b — DeepSeek negative control", "https://api.deepseek.com/anthropic", "deepseek-v4-pro");
for (const [name, r] of [["kimi", kimi], ["deepseek", dseek]] as const) {
  if (!r.error) throw new Error(`L2 FAILED (${name}): turn COMPLETED — OAuth fallback occurred; env did not win`);
  console.log(`L2 verdict (${name}): env WINS — vendor rejected the fake token, no OAuth fallback`);
}
if (!l1EnvWins) throw new Error("L1 FAILED — injected base URL/token not used; walk the fallback ladder (Step 0.2)");
console.log("\nALL PRECEDENCE LEGS GREEN");
```

Also record `npx claude --version` (or the SDK's bundled CLI version) in the notes — the precedence finding is CLI-version-scoped.

- [ ] **Step 0.2: Contingency ladder (only if a leg fails — spec §V1, in order)**

  1. `ANTHROPIC_API_KEY` as the carrier instead of `ANTHROPIC_AUTH_TOKEN` (re-run the driver with the swap). If this is the winner, it is canon-adjacent to the no-ANTHROPIC_API_KEY posture: **record an explicit `# Decision Register Entry` in the spike notes** (vendor key in a subprocess env, not an Anthropic key) before adopting — the table's `authTokenKey` semantics and `buildPassthroughEnv` are the only code that changes.
  2. CLI settings overrides (`apiKeyHelper` / force-login-method surfaces) via `options.extraArgs`/settings.
  3. No supported override → **STOP: escalate to QUESTIONS_FOR_HUMAN, demote to the spec lane.** Tasks 1–5 do not start.

- [ ] **Step 0.3: Record the outcome in `docs/epics/kpr-345/kpr-346-spike-notes.md`**

Structure per the KPR-353 precedent: environment header (worktree/HEAD/node/CLI version/date), per-leg verdict table (L1 listener-hit fields, L2 error shapes verbatim-truncated), the winning auth mechanism named explicitly, contingency entries if any, and a placeholder "V2–V6 delivery checklist" section Task 5 fills in. Bind each leg to its consumer:

| Spike leg | Consumed by | Verdict | Notes |
|---|---|---|---|
| L1 env precedence (base URL + token used) | Task 2 env builder (§D5) | … | auth scheme observed (Bearer vs x-api-key) |
| L2 vendor 401 negative control | Task 2 + §D7 classification row (foreign 401 → auth kind) | … | error strings verbatim (truncated) |

- [ ] **Step 0.4: Commit the spike notes**

```bash
git add docs/epics/kpr-345/kpr-346-spike-notes.md
git commit -m "KPR-346: V1 spike — CLI credential precedence record (env wins / fallback ladder outcome)"
```

---

## Task 1 (Chunk 1): Passthrough table + union growth + semantics — §D1/§D2

**Files:**
- Create: `src/agents/provider-adapters/passthrough-providers.ts`
- Create: `src/agents/provider-adapters/passthrough-providers.test.ts`
- Modify: `src/agents/provider-adapters/types.ts` (union + two Record entries)
- Modify: `src/agents/provider-adapters/types.test.ts`
- Modify (additive): `src/agents/session-store.test.ts`

Standalone-green: nothing routes to the new ids yet (`resolveProviderModel` still falls back to claude), so behavior is unchanged; the compile-forced `SESSION_SEMANTICS` growth lands with the union in the same commit.

- [ ] **Step 1.1: Grow the union + semantics in `src/agents/provider-adapters/types.ts`**

Line 4:

```typescript
export type AgentProviderId = "claude" | "openai" | "gemini" | "codex" | "kimi" | "deepseek";
```

`SESSION_SEMANTICS` (`types.ts:62-67`) gains two entries (existing values untouched):

```typescript
export const SESSION_SEMANTICS: Readonly<Record<AgentProviderId, SessionSemantics>> = {
  claude: "client-transcript",
  openai: "server-resumable",
  gemini: "stateless-replay",
  codex: "stateless-replay",
  // KPR-346 (§D2): Lane A passthrough — the Claude CLI's session ids are
  // local transcript handles independent of the completions endpoint; resume
  // replays the transcript client-side (cold vendor cache, re-billed tokens —
  // documented parity-matrix caveat).
  kimi: "client-transcript",
  deepseek: "client-transcript",
};
```

`LaneBProviderId` (`types.ts:15`) is **not edited** — its doc comment already anticipates this child.

- [ ] **Step 1.2: Create `src/agents/provider-adapters/passthrough-providers.ts`**

```typescript
import { fromKeychain } from "../../keychain/from-keychain.js";
import { TurnAssemblyError } from "./error-classification.js";
import type { AgentProviderId } from "./types.js";

/**
 * KPR-346 (epic KPR-345 §D1): Lane A passthrough providers — vendors that
 * operate an official Anthropic-compatible endpoint, run through the FULL
 * Claude-lane runtime (ClaudeAgentAdapter/AgentRunner: MCP tools, skills,
 * hooks, memory, subagents, resume) with per-spawn env substitution only.
 * Translation proxies are ruled out (epic canon); only vendor-operated
 * endpoints qualify. Adding the next compat vendor is: one table row + one
 * AgentProviderId union member + one SESSION_SEMANTICS entry (compile-forced)
 * + two resolveProviderModel-style prefix arms — no new code path.
 *
 * Lane A ids join AgentProviderId only. LaneBProviderId is NEVER touched:
 * these providers must never gain a tool-transport compatibility column or a
 * bridge path (decision-register canon).
 */
export type LaneAProviderId = "kimi" | "deepseek";

export interface PassthroughProviderDef {
  id: LaneAProviderId;
  displayName: string;
  /** Vendor-operated Anthropic-compat endpoint (never a translation proxy). */
  baseUrl: string;
  /** Honeypot/env credential name — resolved PER SPAWN (env → Keychain). */
  authTokenKey: string;
  /**
   * Fallback model when neither the route (`kimi/<model>`) nor config
   * (`KIMI_AGENT_MODEL` / `DEEPSEEK_AGENT_MODEL`) names one. Pinned at plan
   * time from vendor docs (2026-07-23):
   *  - kimi-k3: Moonshot flagship since 2026-07-16, served on the
   *    /anthropic endpoint (platform.kimi.ai models overview).
   *  - deepseek-v4-pro: DeepSeek's own Claude Code integration doc pins
   *    ANTHROPIC_MODEL=deepseek-v4-pro (deepseek-chat is deprecated
   *    2026-07-24 and must not be used).
   */
  defaultModel: string;
}

export const PASSTHROUGH_PROVIDERS: Readonly<Record<LaneAProviderId, PassthroughProviderDef>> = {
  kimi: {
    id: "kimi",
    displayName: "Kimi (Moonshot AI)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    authTokenKey: "KIMI_API_KEY",
    defaultModel: "kimi-k3",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authTokenKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-pro",
  },
};

export function isLaneAProvider(p: AgentProviderId): p is LaneAProviderId {
  return p === "kimi" || p === "deepseek";
}

/** Per-spawn resolved shape handed to the runner (§D1). The credential lives
 *  only in this object's short spawn-env path — never in long-lived config. */
export interface PassthroughSpawnConfig {
  provider: LaneAProviderId;
  /** Resolved foreign model id (prefix + :effort already stripped). */
  model: string;
  baseUrl: string;
  authToken: string;
}

/**
 * KPR-346 (§D4): per-spawn credential + model resolution. Credential chain is
 * the standard secret-env pattern (agent-runner.ts plugin stdio servers):
 * process.env first, then Honeypot Keychain (hive/<instanceId>/<KEY>) — per
 * spawn, not boot-time, so `hive credentials add` takes effect on the next
 * spawn without a restart. Model chain mirrors codex/openai/gemini:
 * route.model || configured agentModel || table default.
 *
 * Missing/empty credential throws TurnAssemblyError — classifyThrown
 * short-circuits it to non-provider BEFORE the pattern tables
 * (error-classification.ts:126-129). The breaker-invisibility guarantee is
 * the instanceof short-circuit, NOT the message: the message below
 * deliberately contains "authentication" so that, thrown as a plain Error,
 * it WOULD match the `auth` fault row and count toward the foreign
 * breaker's trip streak — which is exactly what the negative-verify leg
 * exploits to prove the typed wrapper is load-bearing. Config fault, not
 * provider fault (epic §D2).
 */
export function resolvePassthroughSpawn(
  provider: LaneAProviderId,
  routeModel: string,
  opts: {
    /** appConfig.<provider>.agentModel — non-secret, boot-time config. */
    configuredModel: string;
    instanceId: string;
    /** Test seam only; defaults to env → Keychain. */
    resolveSecret?: (instanceId: string, key: string) => string;
  },
): PassthroughSpawnConfig {
  const def = PASSTHROUGH_PROVIDERS[provider];
  const resolve =
    opts.resolveSecret ?? ((instanceId: string, key: string) => process.env[key] || fromKeychain(instanceId, key));
  const authToken = resolve(opts.instanceId, def.authTokenKey);
  if (!authToken) {
    throw new TurnAssemblyError(
      `Passthrough credential missing (authentication): ${def.authTokenKey} — seed it via \`hive credentials add ${def.authTokenKey}\``,
    );
  }
  return {
    provider,
    model: routeModel || opts.configuredModel || def.defaultModel,
    baseUrl: def.baseUrl,
    authToken,
  };
}

/**
 * KPR-346 (§D5): the passthrough env pin set, spread LAST into the runner's
 * query() env so every pin wins over process.env and the runner's own
 * entries.
 *  - ANTHROPIC_API_KEY: undefined scrubs both the runner's conditional
 *    injection and any ambient value (established pattern: CLAUDECODE).
 *  - All model pins point at ONE model — deliberate v1 posture (no per-tier
 *    foreign mapping, YAGNI); CLAUDE_CODE_SUBAGENT_MODEL ensures Task
 *    subagents never request a Claude id from a foreign endpoint.
 *  - ENABLE_TOOL_SEARCH forced "false": tool_reference blocks are
 *    unsupported on vendor compat endpoints (same failure mode as the
 *    KPR-329 proxy note).
 */
export function buildPassthroughEnv(p: PassthroughSpawnConfig): Record<string, string | undefined> {
  return {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.authToken,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_SMALL_FAST_MODEL: p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model,
    CLAUDE_CODE_SUBAGENT_MODEL: p.model,
    ENABLE_TOOL_SEARCH: "false",
  };
}
```

If Task 0's ladder landed on a different auth carrier (e.g. `ANTHROPIC_API_KEY`), fold the spike notes' recorded mechanism into `buildPassthroughEnv` verbatim here — the change is isolated to this function + its pins (and carries the Decision Register Entry requirement from Step 0.2).

- [ ] **Step 1.3: Create `src/agents/provider-adapters/passthrough-providers.test.ts`**

Cases (each a named `it`; mock `../../keychain/from-keychain.js`):

  - [ ] table shape: both entries carry the exact base URLs (`https://api.moonshot.ai/anthropic`, `https://api.deepseek.com/anthropic`), key names (`KIMI_API_KEY`, `DEEPSEEK_API_KEY`), and default models (`kimi-k3`, `deepseek-v4-pro`)
  - [ ] `isLaneAProvider`: true for kimi/deepseek, false for claude/openai/gemini/codex
  - [ ] model chain: route model wins; empty route → configuredModel; both empty → table default
  - [ ] credential chain: `process.env.KIMI_API_KEY` wins; env empty → `fromKeychain(instanceId, "KIMI_API_KEY")` consulted (assert call args); both empty → throws `TurnAssemblyError` with message matching `/Passthrough credential missing \(authentication\): KIMI_API_KEY/` and `/hive credentials add/`
  - [ ] **breaker-invisibility pin:** `classifyThrown(thrownFromResolve)` → `{ outcome: "fault", kind: "non-provider" }` — and the control: `classifyThrown(new Error(sameMessage))` classifies `auth` (the message is deliberately auth-matching via "authentication", so this control proves the instanceof short-circuit — not the message — is load-bearing; negative-verify leg 3's unit half)
  - [ ] `buildPassthroughEnv`: deep-equals the exact 10-key record above for a sample config (pin `ANTHROPIC_API_KEY: undefined` present-as-key via `Object.keys` containment + value undefined)
  - [ ] credential never leaks into the model-resolution result fields other than `authToken` (spot check)

- [ ] **Step 1.4: Update `src/agents/provider-adapters/types.test.ts`**

  - [ ] extend the `it.each` equivalence pin with `["kimi", true]`, `["deepseek", true]`
  - [ ] exhaustiveness pin now expects `["claude", "codex", "deepseek", "gemini", "kimi", "openai"]`
  - [ ] add the Lane B compile pin (canon — fails to typecheck if the union changes in either direction):

```typescript
import type { LaneBProviderId } from "./types.js";

it("LaneBProviderId stays exactly {openai, gemini, codex} — Lane A never joins (KPR-346 canon pin)", () => {
  // Compile-time exhaustiveness in both directions; runtime assert is a formality.
  const laneB: Record<LaneBProviderId, true> = { openai: true, gemini: true, codex: true };
  expect(Object.keys(laneB)).toHaveLength(3);
});
```

- [ ] **Step 1.5: Additive `src/agents/session-store.test.ts` case**

In the normalizeRef/get describe (fake-collection harness at `:11-24`): a stored row `{ sessionId: "sess-kimi-1", provider: "kimi" }` → `get()` returns `{ sessionId: "sess-kimi-1", provider: "kimi" }` (client-transcript ⇒ handle returned). Confirm the existing unknown-provider fail-closed case still passes unmodified.

- [ ] **Step 1.6: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/passthrough-providers.test.ts src/agents/provider-adapters/types.test.ts src/agents/session-store.test.ts` → green.
Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/provider-adapters/passthrough-providers.ts src/agents/provider-adapters/passthrough-providers.test.ts src/agents/provider-adapters/types.ts src/agents/provider-adapters/types.test.ts src/agents/session-store.test.ts
git commit -m "KPR-346: Lane A passthrough table + AgentProviderId/SESSION_SEMANTICS growth (client-transcript), credential resolution breaker-invisible"
```

---

## Task 2 (Chunk 2): Runner env substitution — §D5

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify (additive): `src/agents/agent-runner.test.ts`

Standalone-green: no production caller passes the new options bag until Task 3, so every existing spawn is byte-identical.

- [ ] **Step 2.1: Constructor options bag**

Add the import (top of `agent-runner.ts`, beside the other provider-adapters imports):

```typescript
import { buildPassthroughEnv, type PassthroughSpawnConfig } from "./provider-adapters/passthrough-providers.js";
```

Add the exported options interface + private field, and extend the constructor (`agent-runner.ts:341`) with one trailing param (options bag, not an 11th positional — plan discretion exercised per spec §D3):

```typescript
/** KPR-346: optional per-spawn runner options (currently Lane A only). */
export interface AgentRunnerOptions {
  /** Set by AgentManager.createProviderAdapter for kimi/deepseek routes —
   *  triggers §D5 env substitution in send(). Absent ⇒ vanilla Claude spawn. */
  laneAPassthrough?: PassthroughSpawnConfig;
}
```

```typescript
  private readonly laneAPassthrough?: PassthroughSpawnConfig;

  constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = [], skillIndex: SkillIndex = new Map(), eventSubscribersJson = "{}", prefetcher?: CodeIndexPrefetcher, teamRoster?: TeamRoster, db?: Db, prefixCache?: PrefixCache, memoryLifecycle?: MemoryLifecycle, runnerOptions?: AgentRunnerOptions) {
    // …existing body unchanged, plus:
    this.laneAPassthrough = runnerOptions?.laneAPassthrough;
```

- [ ] **Step 2.2: `send()` substitution**

Replace `agent-runner.ts:1803`:

```typescript
    // KPR-346 (§D5): Lane A passthrough — the CLI model is the FOREIGN id;
    // agentConfig.model keeps the prefixed string (kimi/…) so telemetry and
    // the activity log attribute the provider via the model string untouched.
    const passthrough = this.laneAPassthrough;
    const effectiveModel = passthrough?.model ?? this.agentConfig.model;
```

Add `...(passthrough ? { passthroughProvider: passthrough.provider } : {})` to the "Sending prompt to agent" log object (`:1805-1811`).

Replace the tool-search block (`:1861-1874`):

```typescript
    // KPR-329: resolve tool-search mode for this spawn. The env value is
    // always pinned (see env block below) so hive owns the policy — the CLI's
    // implicit default is never in play.
    // KPR-346 (§D5): passthrough spawns BYPASS resolveToolSearchMode — tool
    // search is forced off (tool_reference blocks are unsupported on vendor
    // Anthropic-compat endpoints; same failure mode as the KPR-329 proxy
    // note). No ToolSearchSource union change — the forced mode is logged,
    // not sourced.
    let toolSearchEnvValue: string;
    if (passthrough) {
      toolSearchEnvValue = "false";
      log.debug("Tool search forced off for Lane A passthrough spawn", {
        agent: this.agentConfig.id,
        provider: passthrough.provider,
      });
    } else {
      const toolSearch = resolveToolSearchMode(
        this.agentConfig.toolSearch,
        config.toolSearch.mode,
        config.toolSearch.source,
      );
      log.debug("Tool search mode resolved", {
        agent: this.agentConfig.id,
        mode: toolSearch.mode,
        source: toolSearch.source,
      });
      warnIfToolSearchForceDisabled();
      toolSearchEnvValue = toolSearch.mode === "on" ? "true" : toolSearch.mode === "off" ? "false" : "auto";
    }
```

Update the env block (`:1911-1919`) — the passthrough spread is LAST so its pins win over every prior entry:

```typescript
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined,
          // KPR-329: always pinned — overrides any ambient ENABLE_TOOL_SEARCH.
          ENABLE_TOOL_SEARCH: toolSearchEnvValue,
          // KPR-346 (§D5): Lane A pins — base URL, vendor token, foreign-model
          // pins (incl. subagents), ANTHROPIC_API_KEY scrub, tool search off.
          ...(passthrough ? buildPassthroughEnv(passthrough) : {}),
        },
```

(`options.model` at `:1879` already reads `effectiveModel` — no edit needed there.)

- [ ] **Step 2.3: Runner tests (new describe, `agent-runner.test.ts`)**

Harness: existing `makeRunner`-style construction but passing the trailing options bag; `getCapturedOptions()` (`:216-219`); the config mock already carries `anthropic: { apiKey: "test-key" }` (`:163`) — exactly the conditional injection the scrub must beat. Helper:

```typescript
const PASSTHROUGH = {
  provider: "kimi" as const,
  model: "kimi-k3",
  baseUrl: "https://api.moonshot.ai/anthropic",
  authToken: "tok-test",
};
function makePassthroughRunner(overrides: Partial<AgentConfig> = {}) {
  return new AgentRunner(
    makeAgentConfig({ model: "kimi/kimi-k3", ...overrides }),
    memoryManager as any, [], new Map(), "{}",
    undefined, undefined, undefined, undefined, undefined,
    { laneAPassthrough: PASSTHROUGH },
  );
}
```

Cases:

  - [ ] `options.model === "kimi-k3"` while the constructed `agentConfig.model` stays `"kimi/kimi-k3"`
  - [ ] exact env pins: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and all five model pins + `CLAUDE_CODE_SUBAGENT_MODEL` equal to `"kimi-k3"`
  - [ ] `ANTHROPIC_API_KEY` scrub: with the config mock's `apiKey: "test-key"` **and** `process.env.ANTHROPIC_API_KEY = "ambient"` set (deleted in `finally`), captured `env.ANTHROPIC_API_KEY` is `undefined`
  - [ ] `ENABLE_TOOL_SEARCH === "false"` even with `toolSearch: "on"` on the agent config (forced regardless of agent/hive mode)
  - [ ] resume preserved: `send(prompt, "sess-1")` → `options.resume === "sess-1"`
  - [ ] regression: a vanilla runner (no options bag) captures **no** `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` keys and keeps the existing `ENABLE_TOOL_SEARCH` behavior (the KPR-329 describe at `:2745+` passes unmodified). **Ambient-pollution guard:** the describe's `beforeEach` deletes `process.env.ANTHROPIC_BASE_URL` and `process.env.ANTHROPIC_AUTH_TOKEN` (and `afterEach` restores originals) — the `...process.env` spread would otherwise leak an ambient value into this case exactly as with `ANTHROPIC_API_KEY` above

  **Negative-verify leg 2 (mandatory, recorded):** temporarily remove the `...(passthrough ? buildPassthroughEnv(passthrough) : {})` spread → the pin tests fail → restore → green.

- [ ] **Step 2.4: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts` → all existing + new tests green.
Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "KPR-346: AgentRunner Lane A env substitution — foreign model + vendor endpoint pins, ANTHROPIC_API_KEY scrub, tool search forced off"
```

---

## Task 3 (Chunk 3): Routing + adapter branch + effort clamp + notice condition — §D2/§D3/§D6/§D7 (+ the §D8 config sections they consume)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/agents/agent-manager.test.ts` (additive describes + config-mock/keychain-mock extension)

This is the flip: after this chunk, `kimi/…` agents run passthrough. All in one commit so routing, adapter branch, and effort delivery land with their pins. The `config.ts` `kimi`/`deepseek` sections land HERE, not Task 4: Step 3.3's `appConfig[route.provider].agentModel` consumes them, and the per-chunk `npm run check` gate (Step 3.7) cannot typecheck without them.

- [ ] **Step 3.1: `src/config.ts` — non-secret model overrides (§D8)**

Beside the `codex:` section (`:277-279`), same shape:

```typescript
  kimi: {
    /** KPR-346: Lane A passthrough default-model override (non-secret).
     *  The secret KIMI_API_KEY deliberately has NO boot-time entry — it
     *  resolves per spawn (env → Keychain) in resolvePassthroughSpawn. */
    agentModel: optional("KIMI_AGENT_MODEL", ""),
  },
  deepseek: {
    /** KPR-346: as kimi above; DEEPSEEK_API_KEY resolves per spawn. */
    agentModel: optional("DEEPSEEK_AGENT_MODEL", ""),
  },
```

- [ ] **Step 3.2: Imports + route union + prefix arms**

Add imports (beside the existing provider-adapters imports, `agent-manager.ts:28-37`):

```typescript
import {
  isLaneAProvider,
  resolvePassthroughSpawn,
  type PassthroughSpawnConfig,
} from "./provider-adapters/passthrough-providers.js";
```

`ProviderModelRoute` (`:166-170`) gains one arm:

```typescript
type ProviderModelRoute =
  | { provider: "claude"; model: string }
  | { provider: "openai"; model: string; reasoningEffort?: CodexReasoningEffort }
  | { provider: "gemini"; model: string }
  | { provider: "codex"; model: string; reasoningEffort?: CodexReasoningEffort }
  // KPR-346 (§D2): Lane A passthrough — Claude runtime, foreign endpoint.
  // reasoningEffort survives splitProviderModel and delivers via the Claude
  // adapter's existing effort channel (clamped in prepareSpawn, §D6).
  | { provider: "kimi" | "deepseek"; model: string; reasoningEffort?: CodexReasoningEffort };
```

`resolveProviderModel` (`:174-192`) gains two arms mirroring the codex arm, before the fallback:

```typescript
  if (provider === "kimi") {
    return { provider: "kimi", model: providerModel, reasoningEffort };
  }
  if (provider === "deepseek") {
    return { provider: "deepseek", model: providerModel, reasoningEffort };
  }

  return { provider: "claude", model: normalized };
```

(No prefix aliases — YAGNI per spec §D1. Unknown-prefix fallback unchanged, KPR-231.)

- [ ] **Step 3.3: `createProviderAdapter` Lane A branch (§D3/§D4)**

Restructure the top of `createProviderAdapter` (`:496-507`) — passthrough resolution happens BEFORE runner construction (its throw is inside the caller's recorded try; see `runOneSpawnAttempt` at `:1211` under spawnTurn's try at `:775`), and the Lane A branch returns before `assembleProviderTurn` is reachable:

```typescript
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());

    // KPR-346 (§D3/§D4): Lane A passthrough — credential + model resolved
    // per spawn, BEFORE runner construction. A missing credential throws
    // TurnAssemblyError here, inside runOneSpawnAttempt's recorded try:
    // classifyThrown short-circuits it to non-provider, so a config fault
    // never counts toward the foreign breaker's trip streak and never
    // engages the outage queue (epic §D2).
    let laneAPassthrough: PassthroughSpawnConfig | undefined;
    if (route.provider === "kimi" || route.provider === "deepseek") {
      laneAPassthrough = resolvePassthroughSpawn(route.provider, route.model, {
        configuredModel: appConfig[route.provider].agentModel,
        instanceId: appConfig.instance.id,
      });
    }

    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle, laneAPassthrough ? { laneAPassthrough } : undefined);
    if (route.provider === "claude") {
      return new ClaudeAgentAdapter(runner);
    }
    // KPR-346 (§D3): Lane A runs the FULL Claude runtime against the vendor
    // endpoint — ClaudeAgentAdapter, never the Lane B assembly path below.
    // The adapter's `readonly provider = "claude"` stays as-is per canon:
    // the adapter class is an execution-path detail; every ops surface
    // (breaker, outage gate, session tag, KPR-313 guard) keys on the ROUTE.
    if (route.provider === "kimi" || route.provider === "deepseek") {
      return new ClaudeAgentAdapter(runner);
    }
```

(After these branches TS narrows `route.provider` to `LaneBProviderId`, so `assembleProviderTurn`'s `provider` parameter — `turn-assembly.ts:135` — still typechecks; the codex/openai/gemini branches are untouched.)

- [ ] **Step 3.4: `prepareSpawn` Lane A split + effort clamp (§D6)**

Add the once-guard set beside `effortIncapableWarned` (`:411`):

```typescript
  /** KPR-346 (§D6): once-per-(agent,model) warn when a Lane A :effort suffix
   *  is outside the SDK-deliverable {low,medium,high} set. */
  private readonly laneAEffortClampWarned = new Set<string>();
```

Add the private helper (beside `prepareSpawn`):

```typescript
  /**
   * KPR-346 (§D6): Lane A :effort delivery. The runner's existing narrowing
   * (agent-runner.ts — only {low,medium,high} reach SDK Options.effort) is
   * the deliverable set; clamping HERE (with a warn) makes the drop explicit
   * at the shaping seam instead of silently swallowed by the runner.
   * Whether the foreign endpoint honors, ignores, or rejects the param is
   * validation item V4 (Task 5).
   */
  private clampLaneAEffort(
    agentId: string,
    model: string,
    effort: CodexReasoningEffort | undefined,
  ): ReasoningEffort | undefined {
    if (!effort) return undefined;
    if (effort === "low" || effort === "medium" || effort === "high") return effort;
    const key = `${agentId}:${model}`;
    if (!this.laneAEffortClampWarned.has(key)) {
      this.laneAEffortClampWarned.add(key);
      log.warn("Lane A :effort suffix outside the deliverable {low,medium,high} set — dropped", {
        agentId,
        model,
        effort,
      });
    }
    return undefined;
  }
```

Insert the Lane A return in `prepareSpawn` immediately BEFORE the router gate (`:1354-1361` — i.e. after the KPR-313 annotation prepend, so handoff notices still apply):

```typescript
    // KPR-346 (§D6): Lane A — the router stays skipped (foreign ids are
    // off-catalog, supportsEffort false, KPR-322 rule stands; zero classifier
    // cost) but the static :effort suffix delivers through the Claude
    // adapter's existing channel. resourceLimits stays undefined — the
    // runner's per-agent legacy fallback applies; Claude static-tier limits
    // are never computed for foreign models.
    if (isLaneAProvider(staticRoute.provider)) {
      return {
        prompt,
        route: staticRoute,
        resourceLimits: undefined,
        routerCostUsd: 0,
        effortOverride: this.clampLaneAEffort(
          ctx.agentId,
          agentConfig?.model ?? "",
          "reasoningEffort" in staticRoute ? staticRoute.reasoningEffort : undefined,
        ),
      };
    }
```

Update `SpawnShaping.effortOverride`'s doc comment (`:218-224`): append "KPR-346: ALSO set by prepareSpawn's Lane A branch (clamped static :effort suffix — §D6)." to the "Set only by the router merge branch" sentence.

- [ ] **Step 3.5: Handoff-notice condition (§D7 — the one real attribution change)**

Replace the variant condition (`:1347-1352`):

```typescript
    if (ctx.sessionHandoff) {
      // KPR-346 (§D7): variant keys on CLAUDE-RUNTIME LANE MEMBERSHIP, not
      // === "claude" — Lane A agents run the full runtime and have
      // conversation_search. Future ids fail toward the tool-free pilot
      // variant (safe default).
      prompt =
        (staticRoute.provider === "claude" || isLaneAProvider(staticRoute.provider)
          ? SESSION_HANDOFF_NOTICE_CLAUDE
          : SESSION_HANDOFF_NOTICE_PILOT) + prompt;
    }
```

- [ ] **Step 3.6: Manager tests**

Harness prep (top of `agent-manager.test.ts`):

  - [ ] extend the config mock (`:54-63`) with `kimi: { agentModel: "" }, deepseek: { agentModel: "" }, instance: { id: "test-instance" }` (keep existing keys)
  - [ ] add `vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: vi.fn(() => "") }))` — no real `security` subprocess ever
  - [ ] new describe `"Lane A passthrough (KPR-346)"` with `beforeEach` setting `process.env.KIMI_API_KEY = "test-kimi-key"; process.env.DEEPSEEK_API_KEY = "test-dseek-key"` and `afterEach` deleting both; register agents `agent-kimi` (`model: "kimi/kimi-k3"`) and `agent-dseek` (`model: "deepseek/deepseek-v4-pro"`) via the existing registry fixture pattern

Cases:

  - [ ] **T1 routing:** `providerFor("agent-kimi") === "kimi"`, `providerFor("agent-dseek") === "deepseek"` (extend the KPR-307 block at `:2255`); unknown-prefix agent (`model: "mystery/m"`) → `"claude"` unchanged; slashless `"kimi"` → `"claude"` (documented pre-existing behavior pin)
  - [ ] **T3 adapter selection:** kimi turn → `AgentRunner` mock's last construction call received the options bag `{ laneAPassthrough: expect.objectContaining({ provider: "kimi", model: "kimi-k3", baseUrl: "https://api.moonshot.ai/anthropic", authToken: "test-kimi-key" }) }` (11th arg); `mockRunnerSend` called; `mockCodexConstructor`/`mockOpenAIConstructor`/`mockGeminiConstructor` all uncalled; the runner mock's `buildProviderPrompt` uncalled (assembly never entered)
  - [ ] **T3 model chain:** agent `model: "kimi/"` → passthrough bag's `model === "kimi-k3"` (table default; config mock's agentModel is `""`); flip the config mock's `kimi.agentModel` to `"kimi-k2.6"` for one test → `model === "kimi-k2.6"`
  - [ ] **T3 credential fault, breaker-invisible:** delete `process.env.KIMI_API_KEY` → `await expect(manager.spawnTurn(kimiCtx)).rejects.toThrow(/Passthrough credential missing \(authentication\): KIMI_API_KEY/)`; repeat the rejection 3× → a 4th spawn with the key restored **runs** (no `ProviderCircuitOpenError`) and `mockRunnerSend` fires — the kimi breaker never tripped
  - [ ] **T6 breaker attribution:** `mockRunnerSend` resolves `makeRunResult({ error: "connect ECONNREFUSED 1.2.3.4:443" })` 3× on kimi turns → 4th kimi turn rejects `ProviderCircuitOpenError`; a claude-model agent turn on the same manager still completes (mirror the KPR-306 describe patterns at `:2066`)
  - [ ] **T7 KPR-313:** seed `(threadId, "s-old", "claude")` + kimi turn → resume stripped, prompt starts with `[System notice:` **and contains `conversation_search`** (Claude-variant — the §D7 pin); seed `(threadId, "s-1", "kimi")` + kimi turn → `sessionArg === "s-1"`, no notice; seed `(threadId, "s-1", "kimi")` + deepseek turn → handoff trips (notice present, resume stripped)
  - [ ] **T2 persist:** kimi turn returning `sessionId: "s-kimi-new"` → fake sessionStore `.set` called with `(agentId, threadId, "s-kimi-new", "kimi", …)` (real handle — client-transcript)
  - [ ] **T5 effort:** agent `model: "kimi/kimi-k3:high"` → `mockRunnerSend` 7th arg `"high"`; `routeModel` (mocked) zero calls; agent `model: "kimi/kimi-k3:xhigh"` → 7th arg `undefined` + `mockLogWarn` called once with the clamp message; a second xhigh turn → still exactly one clamp warn
  - [ ] **T5 limits:** kimi turn → `mockRunnerSend` 5th arg (`resourceLimits`) `undefined`

  **Negative-verify legs 1, 3, 4 (mandatory, recorded):** (1) delete the two `resolveProviderModel` arms → T1 + T3 fail (routes claude, runner bag absent) → restore; (3) swap `TurnAssemblyError` → `Error` in `resolvePassthroughSpawn` → the breaker-invisibility case fails (4th spawn rejects `ProviderCircuitOpenError`) → restore; (4) revert the notice condition to `=== "claude"` → the T7 `conversation_search` pin fails → restore.

- [ ] **Step 3.7: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts` → all existing + new green (every pre-existing KPR-306/307/311/312/313/353 pin passes unmodified).
Then `npm run check` (env stubs) → exit 0 (typecheck covers the Step 3.1 config sections consumed by Step 3.3).

```bash
git add src/config.ts src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-346: route kimi/deepseek prefixes through ClaudeAgentAdapter passthrough — agentModel config, effort clamp, Claude-variant handoff notice, breaker-invisible credential faults"
```

---

## Task 4 (Chunk 4): Curated credentials + CLAUDE.md — §D8

**Files:**
- Modify: `src/setup/credential-registry.ts`
- Modify: `CLAUDE.md`

(The `src/config.ts` `kimi`/`deepseek` sections moved to Task 3 Step 3.1 — they must land with their first consumer so the Chunk 3 check gate typechecks.)

- [ ] **Step 4.1: `src/setup/credential-registry.ts` — two curated rows**

Append before the closing `];` (`:139`):

```typescript
  {
    server: "kimi",
    title: "Kimi (Moonshot AI)",
    description:
      "Lane A passthrough provider (KPR-346) — agents with model: kimi/… run the Claude runtime against Moonshot's Anthropic-compatible endpoint.",
    helpUrl: "https://platform.moonshot.ai/console/api-keys",
    kind: "secret",
    fields: [{ key: "KIMI_API_KEY", label: "Moonshot (Kimi) API Key" }],
  },
  {
    server: "deepseek",
    title: "DeepSeek",
    description:
      "Lane A passthrough provider (KPR-346) — agents with model: deepseek/… run the Claude runtime against DeepSeek's Anthropic-compatible endpoint.",
    helpUrl: "https://platform.deepseek.com/api_keys",
    kind: "secret",
    fields: [{ key: "DEEPSEEK_API_KEY", label: "DeepSeek API Key" }],
  },
```

(These are provider rows, not MCP servers — precedent: the `model-router` row. `hive credentials add KIMI_API_KEY` now works through `findCredentialEntryByKey`/`allCredentialKeys` with zero CLI changes.)

- [ ] **Step 4.2: CLAUDE.md riders**

In the **Provider adapters** section, extend the prefix sentence to `— openai, gemini/google-gemini, codex/openai-codex, or the Lane A passthrough providers kimi/deepseek (KPR-346)` and append one paragraph:

> **Lane A passthrough (KPR-346):** `kimi/…` and `deepseek/…` route through the full Claude runtime (`ClaudeAgentAdapter`/`AgentRunner` — MCP tools, skills, hooks, memory, resume) with per-spawn env substitution: vendor Anthropic-compat base URL + Honeypot-resolved key (`KIMI_API_KEY`/`DEEPSEEK_API_KEY`, per-spawn env→Keychain — `hive credentials add` takes effect next spawn), foreign-model pins incl. subagents, `ENABLE_TOOL_SEARCH` forced off. Table: `src/agents/provider-adapters/passthrough-providers.ts` (defaults `kimi-k3` / `deepseek-v4-pro`, overridable via `KIMI_AGENT_MODEL`/`DEEPSEEK_AGENT_MODEL`). Missing credential ⇒ `TurnAssemblyError` (breaker-invisible). Ops surfaces key on the route: a Kimi outage trips the `kimi` breaker/outage queue only. Caveats: no Anthropic server-side tools (WebFetch/WebSearch), `costUsd` nominal (Claude pricing), sessions are `client-transcript` (resume replays against a cold vendor cache). Rollback = set the agent's `model` back + SIGUSR1.

- [ ] **Step 4.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.

```bash
git add src/setup/credential-registry.ts CLAUDE.md
git commit -m "KPR-346: curated credential-registry rows for KIMI_API_KEY/DEEPSEEK_API_KEY + CLAUDE.md Lane A rider"
```

---

## Task 5 (Chunk 5): Live-endpoint validation checklist V2–V6 — delivery-time gate, graceful degradation

**Files:**
- Modify: `docs/epics/kpr-345/kpr-346-spike-notes.md` (fill the V2–V6 section)

Per spec §Live-endpoint validation + HUMAN_DIRECTIVE precedent (vendor keys optional/deferred/non-gating): these legs need **funded** Kimi/DeepSeek keys seeded via `hive credentials add`. **If keys are absent at delivery: record each leg as `DEFERRED — no funded vendor key`, note that production reassignment stays gated on them, and ship** — the code and V1 evidence are complete without them. If keys are present, run on a dev instance and record verdicts.

- [ ] **Step 5.1: Execute or defer each leg, recording verdicts in the notes**

| Leg | Procedure (funded-key path) | Deferral posture |
|---|---|---|
| V2 full-runtime fidelity | Reassign one dev agent to `kimi/…` then `deepseek/…` (`admin_agent_update` + SIGUSR1): MCP round-trips (in-process + stdio), archetype PreToolUse hook fires, skill load, one Task subagent spawn (**no Claude model id in vendor console logs** — pin-set sufficiency check, spec open-assumption 2), streaming partials, second turn resumes (context retained; `sessions` row provider-tagged) | DEFER — gate note |
| V3 server-side tool absence | Invoke WebSearch/WebFetch on the foreign endpoint; record observed failure shape. Turn-fatal (not tool-error-shaped) ⇒ file the strip-server-side-tools follow-up unless trivially small (clean-wrap canon) | DEFER — caveat already documented |
| V4 `:effort` delivery | Turn with `:high` — vendor accepts/ignores without turn-fatal error | DEFER — clamp already tested offline |
| V5 breaker/outage live | Point the table's baseUrl at an unreachable host on the dev instance: 3 turns → `kimi` circuit opens (`circuit_breaker_stats` provider `kimi`), one honest-outage notice, queue + replay on restore; a Claude agent keeps working throughout | DEFER — offline T6 covers attribution |
| V6 KPR-313 live | Reassign a threaded agent `claude→kimi` mid-thread: annotation observed, fresh session; reverse and verify inverse | DEFER — offline T7 covers both directions |

- [ ] **Step 5.2: Commit the evidence**

```bash
git add docs/epics/kpr-345/kpr-346-spike-notes.md
git commit -m "KPR-346: V2–V6 live-validation record (executed or deferred-non-gating per directive)"
```

---

## Execution Handoff

Plan saved to `docs/epics/kpr-345/kpr-346-plan.md`. Ready to execute with `dodi-dev:implement` — Task 0 first; Tasks 1–5 are gated on its verdict.
