# KPR-353 Implementation Plan — Codex replication: tool bridge on the subscription surface, stateless-replay history, documented

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-353-spec.md](./kpr-353-spec.md) (signed off @ 7e2ab68) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D6/§D4/§D3. Baseline: KPR-347/348/349 all merged (KPR-349 @ 08bf962); **all anchors below verified against this worktree's HEAD 7e2ab68.** Per spec §R, KPR-350 is NOT load-bearing — this child sequences directly after KPR-349.

**Goal:** Make `codex/…` turns execute real hive tools (KPR-348 bridge bound to Responses function tools + a hive-owned dispatch loop) and carry honest thread continuity (new Mongo-backed `TurnHistoryStore`, client-side replay incl. encrypted reasoning), with the `TOOL_EXECUTING_PROVIDERS += codex` flip in the same commit as the `tools: []` flip.

**Architecture:** `CodexSubscriptionAdapter.runTurn()` gains the openai adapter's per-spawn `ToolBridge` construction (`openai-agents-adapter.ts:54-63`), renders `BridgedTool[]` as Responses `{type:"function", …, strict:false}` entries, and owns a bounded POST→SSE→execute→re-POST loop (§D2). A new `src/agents/turn-history-store.ts` (collection `provider_turn_history`, 7d TTL, whole-turn trim, fail-soft both directions) persists each successful turn's Responses input items; the adapter replays them next turn under `store: false`. `AgentManager` injects the store (ctor + codex adapter branch) and the KPR-313 guard's handoff branch gains one **awaited**, catch-swallowed `clear`. `types.ts:41` comment corrected; CLAUDE.md riders. Zero edits to `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts`, `session-store.ts`, `prefix-builder.ts`, the openai/gemini adapters, or any `SESSION_SEMANTICS` **value**.

**Tech stack:** TypeScript strict, vitest beside source, existing test scaffolding (mocked `fetch`, real `McpServer` over `InMemoryTransport`, fake-collection Mongo mocks) — no new dependencies.

**Decision-register canon honored (per task):**
- *Bridge bound, not redesigned* — `BridgedTool[]` consumed as-is; **zero `tool-bridge.ts` edits** (Task 3 boundary; Task 7 empty-diff check).
- *One flip, one commit* — `tools: []` → bridged tools AND `TOOL_EXECUTING_PROVIDERS` → `{openai, "codex"}` land in the same commit (Task 3), with the 347/349 pins that assert the old state inverted in that commit; gemini pins untouched.
- *Assembly provider-blind* — the only `turn-assembly.ts` edit is the set literal (+ its own doc comment); `toolsExecutable` stays a plain boolean; `prefix-builder.ts`/`toolkit-section.ts` untouched.
- *`SESSION_SEMANTICS` values untouched* — codex stays `stateless-replay`; Task 6 edits the `types.ts:41` **comment** only; Task 7 verifies comment-only diff.
- *Tool wrapper cannot throw; tool faults breaker-invisible; `llmMs` excludes tool time* — loop-local containment for unknown-name/bad-JSON (§D2), `llmMs = max(0, durationMs − toolMs)` (§D6), and the §D3 breaker-safety invariant: no Mongo error text can reach `RunResult.error` (T3 pin).
- *codex ≡ openai at classify sites* — no `tool-transport.ts` changes; existing compatibility pins stay green (Task 7 empty-diff).
- *Auth single-path* — `createCodexOpenAITokenProvider` + the pinned chatgpt.com endpoint stay exactly as-is; **no `runWithAuthFallback` analog** (§D5); `oauth-credentials.ts` untouched.

**Spec rulings reflected:** the §D4 handoff-clear is **awaited** (ordering pinned by T4, not mere invocation); usage accumulation keys on `response.completed` only (§D2, T6); trim keeps the newest turn via the `turns.length > 1` loop guard (§D3); persist is success-only; §D7 self-heal is one retry, first round, 4xx-with-replay only (breadth pinned: ALL 4xx incl. 401/403/429 heal-and-clear — transient-fault over-clear accepted, T7).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `turn-history-store.ts` (T3 store half), `codex-subscription-adapter.ts` (SSE output-item capture + completed-only usage (Task 2), tool advertisement T1, dispatch loop T2, self-heal T7, telemetry T6, abort T8 — all over mocked `fetch`).
  - Reason: the loop, the trim rule, the usage-keying rule, and the self-heal are deterministic contracts fully drivable by scripted SSE and fake collections.
  - Minimum assertions: the T1–T3, T6–T8 blocks in "Critical Flows" below, each mapped to a step.

- Integration: **required**
  - Scope: (a) adapter↔bridge round-trip over a **real** in-process `McpServer` via the real `ToolBridge` (tool executes, `function_call_output` appended, stats metered); (b) **T3 breaker-safety** — the real `TurnHistoryStore` over a fake collection whose ops reject with `ECONNREFUSED`-shaped errors, wired into the adapter: turn completes, `classifyTurnResult` sees success, no Mongo text in `RunResult.error`; (c) **T4** manager-level KPR-313 interplay (awaited-clear ORDERING, catch-swallow, adopt-branch negative, codex-branch options pass-through); (d) **T5** assembly flip through `assembleProviderTurn` (set pin updated, codex `toolsExecutable: true` pin inverted, gemini pin green).
  - Reason: the flip and the handoff-clear are cross-module by definition; the breaker-safety invariant only means something with the real store's fail-soft wrapping under the adapter's catch.
  - Harness: **existing** — `codex-subscription-adapter.test.ts` has `makeAdapter`/`makeAssembly`/`sse()` over mocked fetch; `openai-agents-adapter.test.ts:105-152` has the `makeInProcessServer`/`makeInProcEntry`/`makeBuiltinEntry` fixture patterns to replicate (replicate, don't cross-import); `agent-manager.test.ts:87-162` mocks the runner + all three pilot adapter modules (`mockCodexConstructor`/`mockCodexRunTurn`); `session-store.test.ts:11-24` has the fake-collection `makeMockDb` pattern.
  - Minimum assertions: (a)–(d) above, incl. the T4 deferred-clear ordering pin and the rejected-clear no-throw pin.

- E2E: **required** (manual, evidence-recorded — not in `npm run check`)
  - Scope: **T0, the plan's Step-0 live spike** (pre-implementation gate — see Task 0) and a post-implementation live turn through the real adapter (Task 7) using the fleet's working codex subscription credential (`~/.codex/auth.json` PRESENT on the dev Mac).
  - Reason: the spec's one ⚠ blocking assumption (chatgpt.com backend accepts function tools / emits `function_call` items / honors `include: ["reasoning.encrypted_content"]` / accepts replayed item lists) is spike-resolved, not docs-guaranteed; the closing live turn proves the delivered loop end-to-end on the same surface KPR-351 will validate.
  - Harness: **setup-required** — dev Mac with `~/.codex/auth.json` present and network to `chatgpt.com`. Scratch tsx drivers in the session scratchpad (348-spike precedent), never committed; secret **values** never printed (presence + result shape only; `encrypted_content` logged as length only). If the credential or network is unreachable, that is a **concrete blocker to report**, not a skip.
  - Minimum assertions: Task 0 legs (a)–(d) recorded in `docs/epics/kpr-345/kpr-353-spike-notes.md`; Task 7 live turn with ≥1 real tool call and a coherent second-turn replay.

### Critical Flows

- **T0 — live spike (gate):** one turn advertising a trivial function tool → `function_call` item arrives in `response.completed` output; `include: ["reasoning.encrypted_content"]` accepted, reasoning items present; a follow-up request replaying round-1 items + `function_call_output` accepted and coherent; a third request adding a new user item on top of the full replayed turn accepted (the §D3 next-turn shape). **If any leg fails: STOP — record and demote to the spec lane (Task 0 gate); do not improvise.**
- **T1 — tool advertisement:** mocked fetch — body carries Responses-shaped function tools (`{type:"function", name, description, parameters, strict:false}`) from bridged builtin/in-process fixtures; the 347 `tools: []` pin (`codex-subscription-adapter.test.ts:274-293`) inverted (negative-verify: fails pre-flip); empty-inventory turn still posts `tools: []`.
- **T2 — dispatch loop:** scripted SSE sequences — single round (no calls, text delivered); two rounds (round-2 POST's `input` = user item + round-1 output items **incl. a reasoning item with `encrypted_content`** + the `function_call_output`; `RunResult.text` is the FINAL round's text only); gate-deny → denial text as output, loop continues; unknown tool name and bad-JSON arguments → structured error outputs, no throw; `maxTurns` exhaustion → `error: "error_max_turns"` + `classifyTurnResult` non-provider + no persist.
- **T3 — history store + breaker-safety:** load/append/clear round-trip; whole-turn trim at `HISTORY_CHAR_BUDGET` (oldest dropped, `turns.length > 1` guard keeps a single over-budget turn whole); success-only persist (error/aborted turns leave the doc untouched); **breaker-safety pin:** real store whose collection ops reject with `ECONNREFUSED`-shaped errors yields `[]`/void, the adapter turn completes, `classifyTurnResult` sees success — no Mongo text anywhere in `RunResult.error`.
- **T4 — KPR-313 interplay (ORDERING, not invocation):** manager-level — a deferred (manually-resolved) `clear` promise must resolve before the codex adapter is constructed/`runTurn` invoked (`load()` lives inside `runTurn`, so runTurn-not-reached ⇒ load-not-reached; the adapter-level companion pin asserts `load()` precedes the first fetch); rejected `clear` doesn't throw in the guard window (catch-swallow, turn proceeds); adopt branch doesn't call `clear`; sessions row still written `sessionId: ""` provider `codex` (existing pins pass unmodified); codex branch passes `historyStore` + `agentId: config.id` (constructor-options pin).
- **T5 — assembly flip:** `TOOL_EXECUTING_PROVIDERS` equals `new Set(["openai", "codex"])` (pin at `turn-assembly.test.ts:107-109` updated); codex `assembleProviderTurn` now passes `toolsExecutable: true` (pin at `:119-125` inverted; negative-verify pre-flip); gemini pin (`:111-117`) untouched and green.
- **T6 — telemetry:** nonzero `bridge.stats.toolMs` ⇒ `llmMs = max(0, durationMs − toolMs)`; `toolCalls`/`toolSummary` from `bridge.stats`; **usage keyed on `response.completed` only** — a round whose SSE carries usage on `response.in_progress` AND `response.completed` counts the completed value once (no multi-count); usage summed across two loop rounds.
- **T7 — self-heal (§D7):** 4xx on a first POST that replayed non-empty history → exactly one fresh retry (`input` = user item only) + `clear` called; **accepted-breadth pin: 429-with-replay-history → heals + clears** (all 4xx incl. 401/403/429 per §D7 — transient-fault over-clear accepted, one bounded reset); 4xx with empty history → no retry; 5xx with history → no retry, no clear, error classifies `server-error` (breaker weight preserved); second 4xx after the heal → error result (no loop).
- **T8 — abort:** mid-round and mid-tool-execution abort → `aborted: true`, `bridge.close()` (prototype spy) called on every path, no persist, no second POST, no unhandled rejections.

### Regression Surface

- **Other adapters:** `openai-agents-adapter.ts`, `gemini-adk-adapter.ts`, `claude-agent-adapter.ts` + their test files — zero edits, suites pass unmodified (incl. gemini's `tools: []`-equivalent pins).
- **Bridge/executor/transport:** `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts` — zero edits (Task 7 empty-diff); codex ≡ openai compatibility columns already pinned in `tool-transport.test.ts` stay green.
- **Session plumbing:** `session-store.ts`, `SESSION_SEMANTICS` values, write-side persist rules (`agent-manager.ts:1462-1498`) untouched; every existing KPR-313 pin in `agent-manager.test.ts:2350+` and `session-store.test.ts` passes **unmodified**.
- **Existing codex adapter tests:** only the `tools: []` pin (`:274-293`) is inverted, plus one **type-only** touch: the bare state literal at `:331` gains `outputItems: []` when `CodexStreamState` grows the required field (Task 2 — named in its edit boundary, zero assertion changes); every other existing assertion (SSE parsing incl. `:143`'s empty-inventory `tools: []` body, abort, missing-OAuth error, instructions-verbatim, usage mapping) passes unmodified — the Task 2 usage split is output-equivalent for well-formed single-round streams.
- **Breaker:** `error-classification.ts` untouched; `TurnAssemblyError` boundary untouched; history I/O runs inside `runTurn` and is store-contained (T3).
- **Claude lane:** nothing on the Claude path is touched (no `prefix-builder.ts`/`agent-runner.ts` edits at all in this child) — KPR-349's golden suite passes untouched by construction.

### Commands

- Fast loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/turn-history-store.test.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/agent-manager.test.ts`
- Full gate (every chunk commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.
- E2E: scratch tsx drivers on the dev Mac (Tasks 0 and 7), evidence in `kpr-353-spike-notes.md` + the PR description.

### Harness Requirements

- `npm ci` in the worktree if `node_modules` absent. Node 22/24 (dev-mode Node 26 broken per KPR-344).
- Unit/integration tests run with **no** live credentials, no network, no Mongo. **Guardrail: never construct `CodexSubscriptionAdapter` in a test without BOTH a `fetch` mock and a tmp `codexAuthPath`** (the dev Mac has a live `~/.codex/auth.json` — a missed mock would hit the real backend). The existing `makeAdapter` helper already does both; keep using it.
- Manager tests keep the existing module-level adapter mocks (`agent-manager.test.ts:126-137`) — no real adapter, no fetch surface.
- Live legs (Tasks 0, 7): dev Mac, `~/.codex/auth.json` present, network to `chatgpt.com`. Model: `config.codex.agentModel` default `gpt-5.4-mini` (`config.ts:277-279`).

### Non-Required Rationale

- (none — all three groups required.)

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch — **and specifically if any Task 0 spike leg fails** — demote the ticket to the spec lane. Do not improvise an alternative wire protocol.
- Negative-verify discipline (operator standard) — four mandatory legs, each run against weakened code with the failing output recorded before restoring:
  1. **Flip pin (Task 3):** temporarily restore `tools: []` in the adapter's request body → T1 advertisement test fails → restore → green.
  2. **Assembly flip (Task 3):** temporarily revert `TOOL_EXECUTING_PROVIDERS` to `new Set(["openai"])` → the updated set pin + inverted codex pin fail → restore.
  3. **Usage keying (Task 2):** temporarily accumulate usage in the interim (`response.in_progress`) branch too → T6 completed-only test fails (multi-count) → restore.
  4. **Handoff-clear ordering (Task 5):** temporarily drop the `await` on the guard's `clear` call → T4 ordering test fails (runTurn reached while clear pending) → restore.
  (Task 1's store fail-soft gets its own inline leg: remove `load`'s try/catch → the never-rejects unit test fails → restore.)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/epics/kpr-345/kpr-353-spike-notes.md` | create (Task 0) | T0 live-spike evidence + spike-outcome dependency table (KPR-348 precedent) |
| `src/agents/turn-history-store.ts` | create (Task 1) | `TurnHistoryStore` — §D3: `provider_turn_history`, TTL, trim, fail-soft |
| `src/agents/turn-history-store.test.ts` | create (Task 1) | T3 store half (fake-collection harness) |
| `src/agents/provider-adapters/codex-subscription-adapter.ts` | modify (Tasks 2, 3, 4) | SSE output-item capture + completed-only usage (2); bridge + tools + dispatch loop + replay/persist + telemetry (3); §D7 self-heal (4) |
| `src/agents/provider-adapters/codex-subscription-adapter.test.ts` | modify (Tasks 2, 3, 4) | Task-2 consumer pins; T1/T2/T6/T8 + T3 breaker-safety integration + pin inversion (3); T7 (4) |
| `src/agents/provider-adapters/turn-assembly.ts` | modify (Task 3 ONLY, flip commit) | `TOOL_EXECUTING_PROVIDERS` += `"codex"` + its doc comment — nothing else |
| `src/agents/provider-adapters/turn-assembly.test.ts` | modify (Task 3) | T5 pins (set updated, codex inverted, gemini untouched) |
| `src/agents/agent-manager.ts` | modify (Task 5) | ctor param `turnHistoryStore?`; codex-branch `historyStore`/`agentId` options; awaited handoff-branch `clear` |
| `src/agents/agent-manager.test.ts` | modify (Task 5, additive) | T4 |
| `src/index.ts` | modify (Task 5) | construct + `init()` the store beside `SessionStore`; pass to `AgentManager` |
| `src/agents/provider-adapters/types.ts` | modify (Task 6, **comment-only**) | §R correction at `:41-45` — replay is KPR-353, value untouched |
| `CLAUDE.md` | modify (Task 6) | §D8 riders — collections list (`:263`) + pilots paragraph (`:248`) |

**NOT touched (spec Integration table):** `tool-bridge.ts`, `builtin-executor.ts`, `tool-transport.ts`, `archetype-gate.ts`, `skill-index.ts`, `prefix-builder.ts`, `toolkit-section.ts`, `agent-runner.ts`, `session-store.ts`, `openai-agents-adapter.ts` (+test), `gemini-adk-adapter.ts` (+test), `claude-agent-adapter.ts`, `oauth-credentials.ts`, `error-classification.ts`, `SESSION_SEMANTICS` values/unions/`persistsResumableHandle`, the codex adapter's endpoint/headers/`store:false` posture/OAuth path/existing SSE event contract/abort-controller shape, `agent-manager.ts` guard logic-ordering (R7 window), `finalizeSpawnResult` persistence rules, breaker acquire/record, `resolveProviderModel`.

---

## Task 0 (Chunk 0): Live spike — the §Open-assumptions gate (⚠ blocks Tasks 1–7)

**Files:**
- Create: `docs/epics/kpr-345/kpr-353-spike-notes.md`

The spec's one blocking assumption, resolved by spike, not by a human. The fleet credential (`~/.codex/auth.json`) makes this cheap. **Nothing after this task may start until all four legs are green.** Secret values are never printed — presence + result shape only; `encrypted_content` values logged as `length=N` only.

- [ ] **Step 0.1: Write and run the spike driver (session scratchpad, never committed)**

`<scratchpad>/kpr353-spike.ts`, run with `npx tsx` from the worktree (symlink `node_modules` per the 348 precedent). Complete driver:

```typescript
/** KPR-353 T0 spike — chatgpt.com/backend-api/codex/responses capability probe.
 *  Legs: (a) function tools accepted; (b) function_call items in completed output;
 *  (c) include: ["reasoning.encrypted_content"] accepted + items present;
 *  (d) replayed input-item lists accepted (same-turn continuation AND next-turn shape).
 *  NEVER COMMIT. No secret values printed. */
// ADJUST to the executing worktree: the driver lives in the session scratchpad,
// so this must be the absolute path to <your-worktree>/src/agents/provider-adapters/oauth-credentials.js.
import { createCodexOpenAITokenProvider } from "<worktree>/src/agents/provider-adapters/oauth-credentials.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.4-mini"; // config.ts:278 default
const tokenProvider = createCodexOpenAITokenProvider();
if (!tokenProvider) throw new Error("no codex OAuth session — run `codex login` first");

const TOOL = {
  type: "function",
  name: "get_current_time",
  description: "Return the current time in ISO-8601 format.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: false,
};

function redact(item: unknown): unknown {
  if (item && typeof item === "object") {
    const it = { ...(item as Record<string, unknown>) };
    if (typeof it.encrypted_content === "string") it.encrypted_content = `<len=${it.encrypted_content.length}>`;
    if (Array.isArray(it.content)) it.content = it.content.map(redact);
    if (typeof it.summary !== "undefined") it.summary = "<redacted>";
    return it;
  }
  return item;
}

async function post(label: string, input: unknown[]): Promise<unknown[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await tokenProvider()}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=v1", // codex-subscription-adapter.ts:81 — same headers, no additions unless the spike proves one necessary
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: "You are a capability probe. When the user asks for the time, call the get_current_time tool.",
      input,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [TOOL],
    }),
  });
  console.log(`\n=== ${label}: HTTP ${res.status}`);
  if (!res.ok) {
    console.log("error body (first 2000):", (await res.text()).slice(0, 2000));
    throw new Error(`${label} FAILED with ${res.status}`);
  }
  // Minimal SSE scan: find the response.completed payload, print event types seen.
  const raw = await res.text();
  const types = new Set<string>();
  let output: unknown[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const p = JSON.parse(data);
      if (p?.type) types.add(p.type);
      if (p?.type === "response.completed" && Array.isArray(p.response?.output)) output = p.response.output;
    } catch { /* non-JSON data line */ }
  }
  console.log("event types:", [...types].sort().join(", "));
  console.log("completed output items:", JSON.stringify(output.map(redact), null, 1));
  return output;
}

const user1 = { role: "user", content: [{ type: "input_text", text: "What time is it right now? Use your tool." }] };

// Legs (a)+(b)+(c): tools accepted, function_call emitted, encrypted reasoning present.
const out1 = await post("LEG a/b/c — tool-forcing turn", [user1]);
const call = out1.find((i) => (i as { type?: string }).type === "function_call") as
  | { call_id: string; name: string; arguments?: string }
  | undefined;
if (!call) throw new Error("LEG b FAILED: no function_call item in completed output");
console.log("function_call shape:", { call_id: typeof call.call_id, name: call.name, arguments: typeof call.arguments });
const hasEnc = out1.some((i) => typeof (i as { encrypted_content?: unknown }).encrypted_content === "string");
console.log("reasoning item with encrypted_content present:", hasEnc);
// Leg (c) must GATE like (a)/(b)/(d) — a backend that silently ignores the
// include (HTTP 200, no encrypted reasoning) would otherwise false-pass, and
// leg (c) feeds Task 3's request body + the §D3 turn-record shape.
if (!hasEnc) throw new Error("LEG c FAILED: no reasoning item with encrypted_content in completed output");

// Leg (d) half 1 — same-turn continuation: replay round-1 output + function_call_output.
const fco = { type: "function_call_output", call_id: call.call_id, output: new Date().toISOString() };
const out2 = await post("LEG d1 — continuation with function_call_output", [user1, ...out1, fco]);

// Leg (d) half 2 — NEXT-TURN replay (§D3 shape): full prior turn + a new user item.
const user2 = { role: "user", content: [{ type: "input_text", text: "Which tool did you just use? One word." }] };
await post("LEG d2 — next-turn replay incl. encrypted reasoning", [user1, ...out1, fco, ...out2, user2]);

console.log("\nALL LEGS GREEN");
```

- [ ] **Step 0.2: Record the outcome in `docs/epics/kpr-345/kpr-353-spike-notes.md`**

Structure per the 348 precedent (`kpr-348-spike-notes.md`): environment header (worktree/HEAD/node/date), per-leg verdict table, observed `response.completed` output-item **type inventory** (message / reasoning / function_call and their field names), the `function_call` field shapes (`call_id`, `name`, `arguments` is-a-JSON-string), whether reasoning items carry `encrypted_content`, redacted transcripts, and a **spike-outcome dependency table** binding each leg to the task that consumes it:

| Spike leg | Consumed by | Verdict | Notes |
|---|---|---|---|
| (a) function tools accepted | Task 3 (§D1 binding) | … | request shape deltas, if any, verbatim |
| (b) `function_call` in completed output | Task 3 (§D2 loop) + Task 2 (capture) | … | item field names as observed |
| (c) encrypted reasoning include | Task 3 body + §D3 turn records | … | |
| (d) replayed item lists accepted | Task 1 store shape + Task 3 replay | … | |

**Contingency rules (write them into the notes):** small request-shape deltas the spike surfaces (an additional required header, a `tool_choice` field, an item-field rename) are recorded here and folded into Task 3's body **verbatim** — they are in-scope adjustments, not redesigns. **If the backend rejects any leg wholesale** (function tools not accepted; no `function_call` items; `include` rejected with no workaround; replayed lists rejected), **STOP: mark the leg FAILED, do not improvise an alternative protocol, and demote the ticket to the spec lane** — the driver gates the demotion. Tasks 1–7 do not start.

- [ ] **Step 0.3: Commit the spike notes**

```bash
git add docs/epics/kpr-345/kpr-353-spike-notes.md
git commit -m "KPR-353: T0 live spike — codex backend function-tool/encrypted-reasoning/replay capability record"
```

---

## Task 1 (Chunk 1): `TurnHistoryStore` — §D3, fail-soft both directions

**Files:**
- Create: `src/agents/turn-history-store.ts`
- Create: `src/agents/turn-history-store.test.ts`

Standalone: nothing consumes the store until Task 3 (adapter) and Task 5 (wiring), so this chunk is check-green by construction.

- [ ] **Step 1.1: Create `src/agents/turn-history-store.ts`**

```typescript
import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { AgentProviderId } from "./provider-adapters/types.js";

const log = createLogger("turn-history-store");

/**
 * KPR-353 (spec §D3): serialized-char budget for one thread's replay history.
 * Constant, not config (simplicity canon). ~50k tokens replayed worst-case;
 * re-billed against subscription quota each turn (documented matrix caveat,
 * offset by the backend's prompt caching).
 */
export const HISTORY_CHAR_BUDGET = 200_000;

/** 7 days — deliberately identical to `sessions` (session-store.ts:56) so a
 *  thread's continuity artifacts age out together. */
const TTL_SECONDS = 7 * 24 * 60 * 60;

interface TurnRecord {
  at: Date;
  /** Opaque Responses input items, stored VERBATIM: the user message item,
   *  every output item from every round (assistant messages, reasoning items
   *  with encrypted_content — provider-opaque ciphertext by design), and the
   *  function_call_output items hive appended. Hive never introspects them;
   *  replay is an exact re-post (§D3). */
  items: unknown[];
}

interface TurnHistoryDoc {
  _id: string; // "{agentId}:{threadId}:{provider}"
  agentId: string;
  threadId: string;
  provider: AgentProviderId;
  turns: TurnRecord[];
  updatedAt: Date;
}

/**
 * KPR-353 (spec §D3): hive-persisted turn history for stateless-replay
 * providers. The codex surface hard-enforces store:false — there is no server
 * handle to persist — so continuity is client-side replay of these records.
 *
 * BREAKER-SAFETY INVARIANT (§D3 — the fail-soft's real reason): every public
 * method is called inside adapter/manager turn paths OUTSIDE the
 * TurnAssemblyError boundary. A raw Mongo throw reaching the adapter's catch
 * would put "connect ECONNREFUSED" into RunResult.error, pattern-match
 * connect-fail (error-classification.ts:74), and count toward the CODEX
 * breaker's trip streak. Therefore: methods NEVER throw and NEVER return
 * Mongo error text — degradation is logged (warn) and invisible to
 * classification (contract-pinned, spec T3).
 *
 * Concurrency: same-thread turns are serialized by AgentManager's per-thread
 * lock, so the read-modify-write in append() is race-free per key.
 */
export class TurnHistoryStore {
  private collection!: Collection<TurnHistoryDoc>;

  constructor(private db: Db) {}

  async init(): Promise<void> {
    this.collection = this.db.collection<TurnHistoryDoc>("provider_turn_history");
    await this.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    await this.collection.createIndex({ agentId: 1, threadId: 1 });
  }

  /** Fail-soft wrapper — the session-store withRetry idiom (session-store.ts:71-81). */
  private async withFallback<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await op();
    } catch (err) {
      log.warn("Turn-history operation failed — degrading soft (KPR-353 §D3)", {
        label,
        error: String((err as { message?: unknown })?.message ?? err),
      });
      return fallback;
    }
  }

  private key(agentId: string, threadId: string, provider: AgentProviderId): string {
    return `${agentId}:${threadId}:${provider}`;
  }

  /**
   * Flattened turn items, oldest-first. [] on miss OR on any Mongo failure —
   * the turn then runs fresh with a warn (continuity degrades for one turn,
   * delivery doesn't).
   */
  async load(agentId: string, threadId: string, provider: AgentProviderId): Promise<unknown[]> {
    return this.withFallback(async () => {
      const doc = await this.collection.findOne({ _id: this.key(agentId, threadId, provider) });
      if (!doc) return [];
      return doc.turns.flatMap((t) => t.items);
    }, [], `load(${agentId}:${threadId}:${provider})`);
  }

  /**
   * Push one turn record + trim; fail-soft void. Trim = WHOLE turns, oldest
   * first, under HISTORY_CHAR_BUDGET — the `turns.length > 1` guard means the
   * newest turn is never trimmed away, so a single over-budget turn is kept
   * whole (spec §D3: a split function_call/function_call_output pair is a
   * malformed replay — whole-turn granularity is the rule).
   */
  async append(agentId: string, threadId: string, provider: AgentProviderId, items: unknown[]): Promise<void> {
    if (items.length === 0) return;
    await this.withFallback(async () => {
      const _id = this.key(agentId, threadId, provider);
      const now = new Date();
      const doc = await this.collection.findOne({ _id });
      const turns: TurnRecord[] = [...(doc?.turns ?? []), { at: now, items }];
      while (turns.length > 1 && JSON.stringify(turns).length > HISTORY_CHAR_BUDGET) {
        turns.shift();
      }
      await this.collection.updateOne(
        { _id },
        { $set: { agentId, threadId, provider, turns, updatedAt: now } },
        { upsert: true },
      );
    }, undefined, `append(${agentId}:${threadId}:${provider})`);
  }

  /**
   * All providers for the thread — provider-agnostic so the KPR-313 handoff
   * hook stays generic (§D4). AWAITED and catch-swallowed at the manager call
   * site; never throws here either (belt and braces). A failed clear is the
   * spec's accepted residual: the stale doc survives until TTL, warn-logged.
   */
  async clear(agentId: string, threadId: string): Promise<void> {
    await this.withFallback(async () => {
      await this.collection.deleteMany({ agentId, threadId });
    }, undefined, `clear(${agentId}:${threadId})`);
  }
}
```

- [ ] **Step 1.2: Create `src/agents/turn-history-store.test.ts` (T3 store half)**

Harness: the `session-store.test.ts:11-24` fake-collection pattern (hoisted warn spy + `makeMockDb` returning `findOne`/`updateOne`/`deleteMany`/`createIndex` mocks). Required cases (each a named `it`):

  - [ ] `init()` creates the TTL index (`{updatedAt: 1}`, `expireAfterSeconds: 604800`) and the `{agentId: 1, threadId: 1}` index on collection `provider_turn_history`
  - [ ] `load` miss → `[]`
  - [ ] `load` hit with two turns → flattened items, oldest-first (turn-1 items before turn-2 items)
  - [ ] `append` first turn → `updateOne` upsert with `_id: "a:t:codex"`, one turn record carrying the items verbatim, `$set.provider: "codex"`
  - [ ] `append` with existing doc → new record appended after existing turns
  - [ ] `append` with empty `items` → no collection call at all
  - [ ] **trim:** seed a doc whose serialized turns exceed `HISTORY_CHAR_BUDGET` when a new turn is added → oldest turn(s) dropped from the written `turns`, newest turn present and intact (items array unsplit)
  - [ ] **single over-budget turn kept whole (`turns.length > 1` guard):** empty doc + one turn whose own serialization exceeds the budget → written `turns` has exactly that one turn, unsplit
  - [ ] **never-rejects pins (breaker-safety, §D3):** `findOne` rejecting `new Error("connect ECONNREFUSED 127.0.0.1:27017")` → `load` resolves `[]` (no rejection); `updateOne` rejecting likewise → `append` resolves void; `deleteMany` rejecting → `clear` resolves void; in each case the warn spy was called and **the resolved value contains no error text**
  - [ ] `clear` calls `deleteMany({agentId, threadId})` (no provider in the filter — provider-agnostic per §D4)

  **Inline negative-verify (record output):** temporarily remove the `try/catch` inside `withFallback` (rethrow) → the three never-rejects pins fail → restore → green.

- [ ] **Step 1.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/turn-history-store.test.ts` → green.
Then: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.

```bash
git add src/agents/turn-history-store.ts src/agents/turn-history-store.test.ts
git commit -m "KPR-353: TurnHistoryStore — provider_turn_history collection, whole-turn trim, fail-soft both directions (breaker-safety invariant)"
```

---

## Task 2 (Chunk 2): SSE consumer groundwork — output-item capture + completed-only usage

**Files:**
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.ts` (consumer functions only — `runTurn` untouched in this chunk)
- Modify (additive): `src/agents/provider-adapters/codex-subscription-adapter.test.ts`

Behavior-neutral for today's single-round zero-tool turns (usage `=` vs `+=` is equivalent when exactly one `response.completed` arrives and interim events carry no usage; `outputItems` is captured but unconsumed until Task 3) — so this chunk is independently green and keeps the Task 3 flip commit focused.

- [ ] **Step 2.1: Extend `CodexStreamState` and split `applyResponsePayload`**

In `codex-subscription-adapter.ts`, change the `CodexStreamState` interface (`:35-41`):

```typescript
interface CodexStreamState {
  text: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** KPR-353 (§D2): the full response.output item array captured from the
   *  response.completed payload — messages, reasoning (with
   *  encrypted_content when include requests it), function_call items.
   *  Feeds the dispatch loop's next-round input and the §D3 turn record. */
  outputItems: unknown[];
}
```

Initialize `outputItems: []` in `consumeCodexSse`'s state literal (`:232-237`).

**Known one-token test touch (edit boundary, not a regression):** the existing "returns incomplete buffered SSE frames" test (`codex-subscription-adapter.test.ts:331`) constructs a bare state literal passed to `consumeBufferedSseEvents`; once `CodexStreamState` gains required `outputItems`, that literal needs `outputItems: []` added to typecheck. That single field addition is the ONLY permitted edit to a pre-existing test in this chunk — every existing assertion still passes unmodified.

Replace the event-routing block in `applyCodexEvent` (`:321-324`):

```typescript
  if (type === "response.created" || type === "response.in_progress") {
    applyInterimResponsePayload(objectField(payload, "response"), state);
    return;
  }

  if (type === "response.completed") {
    applyCompletedResponsePayload(objectField(payload, "response"), state);
    return;
  }
```

Replace `applyResponsePayload` (`:333-342`) with the two split functions:

```typescript
/**
 * Interim events (response.created / response.in_progress): id overwrite
 * ONLY. KPR-353 (§D2): usage is deliberately NOT read here — interim payloads
 * can carry (partial) usage, and accumulating it would multi-count within a
 * round. Usage keys on response.completed exclusively (pinned, T6).
 */
function applyInterimResponsePayload(
  response: Record<string, unknown> | undefined,
  state: CodexStreamState,
): void {
  if (!response) return;
  const payload = response as CodexResponsePayload;
  if (payload.id) state.responseId = payload.id;
}

/**
 * response.completed: id + usage accumulation + output-item capture.
 * Accumulation (+=) is per completed response — the KPR-353 dispatch loop
 * sums per-round states into turn totals, one completed event per round.
 */
function applyCompletedResponsePayload(
  response: Record<string, unknown> | undefined,
  state: CodexStreamState,
): void {
  if (!response) return;
  const payload = response as CodexResponsePayload;
  if (payload.id) state.responseId = payload.id;
  if (payload.usage?.input_tokens) state.inputTokens += payload.usage.input_tokens;
  if (payload.usage?.output_tokens) state.outputTokens += payload.usage.output_tokens;
  if (payload.usage?.input_tokens_details?.cached_tokens) {
    state.cacheReadTokens += payload.usage.input_tokens_details.cached_tokens;
  }
  const output = response["output"];
  if (Array.isArray(output)) state.outputItems.push(...output);
}
```

(If the Task 0 spike recorded different item/field names for the completed payload's output array, fold the observed names in here verbatim — the spike notes are the authority.)

- [ ] **Step 2.2: Consumer unit tests (additive describe in the adapter test file)**

Drive via the exported `consumeCodexSse` with the existing `sse()` helper:

  - [ ] completed payload with `response.output: [reasoning-with-encrypted_content, message]` → `state.outputItems` equals that array verbatim
  - [ ] `response.created` carrying an id then `response.completed` carrying a different id → `responseId` is the completed one (overwrite preserved)
  - [ ] **T6 consumer half:** `response.in_progress` payload carrying `usage: {input_tokens: 7, output_tokens: 2}` followed by `response.completed` with `usage: {input_tokens: 10, output_tokens: 3}` → `state.inputTokens === 10`, `state.outputTokens === 3` (completed-only; no 17)
  - [ ] no completed event (stream cut) → `outputItems` stays `[]`, no throw

  **Negative-verify leg 3 (mandatory, recorded):** temporarily add the usage lines to `applyInterimResponsePayload` → the completed-only test fails with 17 → restore → green.

- [ ] **Step 2.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/codex-subscription-adapter.test.ts` → all existing + new tests green (existing usage-mapping tests pass unmodified).
Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts
git commit -m "KPR-353: SSE groundwork — response.output capture + completed-only usage accumulation (multi-count guard)"
```

---

## Task 3 (Chunk 3): THE FLIP — bridge + dispatch loop + replay/persist + telemetry + `TOOL_EXECUTING_PROVIDERS += codex`, one commit

**Files:**
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.ts`
- Modify: `src/agents/provider-adapters/turn-assembly.ts` (set literal + its doc comment ONLY)
- Modify: `src/agents/provider-adapters/turn-assembly.test.ts` (T5 pins)
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.test.ts` (T1/T2/T6/T8, T3 integration, pin inversion)

Canon: the `tools: []` flip, the set growth, and the pins that assert the old state are **one commit, one review surface**. The dispatch loop lands here because advertising tools without an executor loop invites calls nothing handles (the exact 347 comment being deleted).

- [ ] **Step 3.1: Rewrite `runTurn` + options + helpers in `codex-subscription-adapter.ts`**

New imports at top:

```typescript
import { createLogger } from "../../logging/logger.js";
import { ToolBridge, type BridgedTool } from "./tool-bridge.js";
import type { TurnHistoryStore } from "../turn-history-store.js";
```

Add below the existing constants:

```typescript
const log = createLogger("codex-adapter");
/** §D2: mirrors the openai adapter's SDK default when resourceLimits is absent. */
const DEFAULT_MAX_ROUNDS = 10;
```

Extend the options interface:

```typescript
export interface CodexSubscriptionAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  endpoint?: string;
  codexAuthPath?: string;
  codexRefreshCommand?: string;
  fetch?: typeof fetch;
  /** KPR-353 (§D3): hive-persisted stateless-replay history. Absent ⇒ every
   *  turn is stateless (the pre-353 floor — bare test constructions,
   *  hypothetical direct spawns). */
  historyStore?: TurnHistoryStore;
  /** KPR-353: agent id (config.id) keying history docs. The existing `name`
   *  is the display name and stays logging-only. */
  agentId?: string;
}
```

Add the function-call item guard + executor helper (module-level, beside the other helpers):

```typescript
interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments?: string;
}

function isFunctionCallItem(item: unknown): item is FunctionCallItem {
  if (!item || typeof item !== "object") return false;
  const it = item as Record<string, unknown>;
  return it.type === "function_call" && typeof it.call_id === "string" && typeof it.name === "string";
}

/**
 * §D2 loop-local containment additions on top of the bridge's own (KPR-348
 * §D3 — BridgedTool.execute NEVER throws): a hallucinated tool name or
 * unparseable arguments become structured function_call_output text, never a
 * throw. Nothing in the dispatch loop can escape runTurn as a throw.
 */
async function executeFunctionCall(
  call: FunctionCallItem,
  bridgedByName: Map<string, BridgedTool>,
): Promise<string> {
  const bt = bridgedByName.get(call.name);
  if (!bt) return `Tool execution failed (${call.name}): unknown tool`;
  let args: unknown;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return `Tool execution failed (${call.name}): arguments were not valid JSON`;
  }
  return bt.execute(args);
}
```

Replace the whole `runTurn` body (`:56-158`) with:

```typescript
  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    const sessionId = request.sessionId ?? `codex-pilot-${randomUUID()}`;

    // KPR-353 (§D1): per-spawn tool bridge — the openai adapter's exact
    // construction (openai-agents-adapter.ts:54-63). connect() inside the
    // try (fail-soft per server; an all-failed bridge yields [] and the turn
    // runs tool-less); close() in the finally.
    const bridge = new ToolBridge({
      inventory: this.options.assembly.toolInventory,
      inProcessServers: this.options.assembly.inProcessServers,
      gate: this.options.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.options.name,
      sessionCwd: this.options.assembly.sessionCwd,
      skillIndex: this.options.assembly.skillIndex,
    });

    // §D3 thread key: absent context ⇒ replay and persist both skip.
    const threadId = request.workItemContext?.threadId || undefined;
    const historyKey =
      this.options.historyStore && this.options.agentId && threadId
        ? { store: this.options.historyStore, agentId: this.options.agentId, threadId }
        : undefined;

    // Turn accumulators (visible to the abort helper below).
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let lastResponseId: string | undefined;

    const abortedResult = (): RunResult =>
      this.buildResult({
        text: "",
        sessionId: lastResponseId ?? sessionId,
        durationMs: Date.now() - startedAt,
        streamed,
        aborted: true,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });

    try {
      // §D3: load NEVER throws and NEVER returns Mongo error text (breaker
      // safety — store-owned contract; the .catch is belt-and-braces against
      // a future non-conforming store impl leaking Mongo text into
      // RunResult.error). Deliberately BEFORE the auth check: degradation
      // ordering is deterministic and manager-level ordering tests (T4)
      // observe load via runTurn without a credential.
      const replayed = historyKey
        ? await historyKey.store
            .load(historyKey.agentId, historyKey.threadId, "codex")
            .catch((): unknown[] => [])
        : [];

      const tokenProvider = createCodexOpenAITokenProvider({
        authPath: this.options.codexAuthPath,
        refreshCommand: this.options.codexRefreshCommand,
      });
      if (!tokenProvider) {
        throw new Error("Codex OAuth session is not available; run `codex login` first");
      }

      const bridged = await bridge.connect();
      const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
      // §D1: BridgedTool[] → Responses function tools. Name/cap edges
      // (sanitization, 128-cap with the KPR-349 pinned tier) are bridge-owned.
      const toolPayloads = bridged.map((bt) => ({
        type: "function" as const,
        name: bt.name,
        description: bt.description,
        parameters: bt.inputSchema,
        strict: false as const,
      }));

      const userItem = { role: "user", content: [{ type: "input_text", text: request.prompt }] };
      const inputItems: unknown[] = [...replayed, userItem];
      /** §D3 turn record: user item + every round's output items + hive's
       *  function_call_output items. Persisted only on success. */
      const thisTurnItems: unknown[] = [userItem];
      let finalText = "";
      let replayedNonEmpty = replayed.length > 0;
      let selfHealed = false;

      // Note `maxTurns: 0` ⇒ maxRounds 0 (`??` passes 0 through) ⇒ immediate
      // error_max_turns without a POST. Deliberate divergence from the openai
      // lane, which hands 0 to the SDK — a zero budget honestly means "no
      // model rounds" here; not normalized.
      const maxRounds = request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS;
      let round = 0;
      for (;;) {
        round += 1;
        if (round > maxRounds) {
          // §D2: the SDK sentinel string, already pinned non-provider
          // (error-classification.ts:57). No history persist.
          return this.buildResult({
            text: "",
            sessionId: lastResponseId ?? sessionId,
            durationMs: Date.now() - startedAt,
            streamed,
            aborted: false,
            error: "error_max_turns",
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            toolStats: bridge.stats,
          });
        }
        if (this.aborted || abortController.signal.aborted) return abortedResult();

        const response = await this.fetchImpl()(this.options.endpoint ?? DEFAULT_CODEX_RESPONSES_URL, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            authorization: `Bearer ${await tokenProvider()}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            "openai-beta": "responses=v1",
          },
          body: JSON.stringify({
            model: this.options.model ?? DEFAULT_CODEX_MODEL,
            instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
            reasoning: this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : undefined,
            input: inputItems,
            stream: true,
            store: false,
            // §D2/§D3: encrypted reasoning must round-trip for replay quality
            // on this store:false surface (spike leg (c)).
            include: ["reasoning.encrypted_content"],
            tools: toolPayloads,
          }),
        });

        if (!response.ok) {
          // §D7 poisoned-replay self-heal: first-round 4xx on a request that
          // replayed non-empty history ⇒ ONE retry with history dropped +
          // clear the doc. 5xx/network keep full breaker weight — no retry,
          // no clear. A non-replay 4xx never retries.
          // Breadth PINNED (deliberate): ALL 4xx incl. 401/403/429 heal-and-
          // clear per §D7 — a transient-fault over-clear (expired token, rate
          // limit) costs one bounded reset + one retry; accepted as the §D7
          // backstop rather than status-sniffing. T7 pins the 429 case.
          if (
            round === 1 &&
            !selfHealed &&
            replayedNonEmpty &&
            response.status >= 400 &&
            response.status < 500 &&
            historyKey
          ) {
            log.warn("Codex replay rejected (4xx) — one fresh retry + history clear (KPR-353 §D7)", {
              agentId: historyKey.agentId,
              status: response.status,
            });
            // never throws (§D3); .catch = belt-and-braces store-impl guard
            await historyKey.store.clear(historyKey.agentId, historyKey.threadId).catch(() => {});
            inputItems.length = 0;
            inputItems.push(userItem);
            replayedNonEmpty = false;
            selfHealed = true;
            round = 0; // healed turn gets its full round budget
            continue;
          }
          throw new Error(await responseErrorMessage(response));
        }

        // Fresh per-round state; text deltas stream to onStream across ALL
        // rounds (intermediate think-aloud), but RunResult.text is the FINAL
        // round's assistant text only (§D2 final-reply semantics).
        const state = await consumeCodexSse(response.body, request.onStream, () => this.aborted);
        totals.inputTokens += state.inputTokens;
        totals.outputTokens += state.outputTokens;
        totals.cacheReadTokens += state.cacheReadTokens;
        if (state.responseId) lastResponseId = state.responseId;
        finalText = state.text;

        inputItems.push(...state.outputItems);
        thisTurnItems.push(...state.outputItems);

        if (this.aborted || abortController.signal.aborted) return abortedResult();

        // Dedupe by call_id: closes the degenerate double-`response.completed`
        // case (both payloads captured into outputItems) that would otherwise
        // double-execute the tool and double-append its output item.
        const seenCallIds = new Set<string>();
        const calls = state.outputItems.filter(
          (item): item is FunctionCallItem =>
            isFunctionCallItem(item) && !seenCallIds.has(item.call_id) && !!seenCallIds.add(item.call_id),
        );
        if (calls.length === 0) break;

        // Sequential by design (spec ⚠: hive's in-process handlers are not
        // concurrency-audited under one turn; parallelizing is a follow-up
        // lever, deliberately not pre-built).
        for (const call of calls) {
          if (this.aborted || abortController.signal.aborted) return abortedResult();
          const output = await executeFunctionCall(call, bridgedByName);
          const outputItem = { type: "function_call_output", call_id: call.call_id, output };
          inputItems.push(outputItem);
          thisTurnItems.push(outputItem);
        }
      }

      const durationMs = Date.now() - startedAt;
      if (this.aborted || abortController.signal.aborted) return abortedResult();

      // §D3 persist policy: success only — error/aborted turns never persist
      // (an errored turn's item may be re-delivered by the retry/outage path;
      // persisting would duplicate the user message on replay). Fail-soft
      // void; .catch = belt-and-braces store-impl guard.
      if (historyKey) {
        await historyKey.store
          .append(historyKey.agentId, historyKey.threadId, "codex", thisTurnItems)
          .catch(() => {});
      }

      return this.buildResult({
        text: finalText,
        sessionId: lastResponseId ?? sessionId,
        durationMs,
        streamed,
        aborted: false,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (this.isAbortError(error, abortController)) {
        return this.buildResult({
          text: "",
          sessionId: lastResponseId ?? sessionId,
          durationMs,
          streamed,
          aborted: true,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          toolStats: bridge.stats,
        });
      }

      return this.buildResult({
        text: "",
        sessionId,
        durationMs,
        streamed,
        aborted: false,
        error: errorMessage(error),
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });
    } finally {
      await bridge.close(); // never throws/rejects (KPR-348 advisory 1)
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }
```

(The KPR-347 flip-comment block + `tools: []` at `:90-93` is gone with this rewrite — that IS the flip. The endpoint, headers, `store: false`, OAuth path, `sessionId` fabrication/`responseId` preference, and abort-controller shape are all preserved verbatim.)

- [ ] **Step 3.2: `buildResult` — telemetry from `bridge.stats` (§D6)**

Replace `buildResult` (`:180-220`) — parameter object gains `toolStats?`; rendering is the openai adapter's exact pattern (`openai-agents-adapter.ts:256-275`):

```typescript
  private buildResult({
    text,
    sessionId,
    durationMs,
    streamed,
    aborted,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    error,
    toolStats,
  }: {
    text: string;
    sessionId: string;
    durationMs: number;
    streamed: boolean;
    aborted: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    error?: string;
    toolStats?: Readonly<{ toolCalls: number; toolMs: number; perTool: Map<string, number> }>;
  }): RunResult {
    const toolMs = toolStats?.toolMs ?? 0;
    const toolCalls = toolStats?.toolCalls ?? 0;
    const toolSummary =
      toolStats && toolStats.perTool.size > 0
        ? [...toolStats.perTool.entries()].map(([n, c]) => `${n}×${c}`).join(", ")
        : "none";
    return {
      text,
      sessionId,
      costUsd: 0,
      durationMs,
      // §D6 (KPR-348 §D8 rule): the breaker's p95 window samples llmMs —
      // folding tool time in would let slow-but-healthy tools trip a healthy
      // codex endpoint. Clamped: degenerate/mocked timing can't go negative.
      llmMs: Math.max(0, durationMs - toolMs),
      toolMs,
      toolCalls,
      toolSummary,
      streamed,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted,
      ...(error ? { error } : {}),
    };
  }
```

- [ ] **Step 3.3: `turn-assembly.ts` — the same-commit set flip (the ONLY edit to this file)**

At `:94`, change the literal and refresh the comment's growth sentence:

```typescript
/**
 * KPR-349 (§D3): tool-honesty gate. Only providers whose adapters actually
 * execute bridged tools get tool-dependent prompt sections (toolkit,
 * file-tier guidance, skills) and the memory block's tool-instruction
 * lines. KPR-353 added codex in the same commit as its adapter's zero-tools
 * flip; KPR-352 adds gemini the same way — the set and the flip are one
 * review surface (same one-line-per-provider growth pattern as
 * SESSION_SEMANTICS). Delete-candidate once all three Lane B providers
 * execute tools.
 */
export const TOOL_EXECUTING_PROVIDERS: ReadonlySet<LaneBProviderId> = new Set(["openai", "codex"]);
```

- [ ] **Step 3.4: T5 — `turn-assembly.test.ts` pin updates**

1. The set pin (`:107-109`) becomes:

```typescript
  it("KPR-353 §D1: TOOL_EXECUTING_PROVIDERS is exactly {openai, codex} (352 grows it with the gemini flip)", () => {
    expect(TOOL_EXECUTING_PROVIDERS).toEqual(new Set(["openai", "codex"]));
  });
```

2. Invert the codex pin (`:119-125`):

```typescript
  it("KPR-353 §D1: toolsExecutable TRUE for codex (flip commit — same commit as the adapter's tools flip)", async () => {
    const runner = makeRunner([makeEntry()]);
    await assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "codex" });
    expect(runner.buildProviderPrompt as unknown as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ toolsExecutable: true }),
    );
  });
```

3. The gemini pin (`:111-117`) stays byte-identical. Every other assertion in the file: unmodified.

(The instruction-content half of T5 — toolkit/skills markers and memory tool-claim lines for `toolsExecutable: true` — is already pinned provider-blind in `prefix-builder.provider.test.ts` (KPR-349 T2); the seam pin here is the boolean, which is the whole point of the provider-blind design.)

- [ ] **Step 3.5: Adapter tests — pin inversion + T1/T2/T6/T8 + T3 integration**

In `codex-subscription-adapter.test.ts`. Add the logger mock at top (the adapter now logs):

```typescript
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
```

Add fixture helpers replicated from `openai-agents-adapter.test.ts:105-152` (**replicate, don't cross-import**): `makeInProcessServer(register)` (real `McpServer` wrapped as `{type:"sdk", name, instance}`), `makeInProcEntry(name)`, `makeBuiltinEntry(toolName)` (uses `BUILTIN_TOOL_DEFINITIONS` from `./builtin-executor.js`). Add an SSE-script helper that returns one mocked `Response` per round from an array of event lists (each round built with the existing `sse()`), plus an items helper:

```typescript
const reasoningItem = { type: "reasoning", id: "rs_1", encrypted_content: "ENC-OPAQUE-1", summary: [] };
const callItem = (name: string, args = "{}") => ({
  type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: args, status: "completed",
});
const completed = (output: unknown[], usage?: Record<string, unknown>) => ({
  event: "response.completed",
  data: { type: "response.completed", response: { id: "resp_x", output, ...(usage ? { usage } : {}) } },
});
```

**Pin inversion (the 347 `tools: []` pin, `:274-293`) — rewrite as T1:**

```typescript
  it("KPR-353 T1: bridged inventory is advertised as Responses function tools (inverts the 347 tools:[] pin)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(sse([completed([{ type: "message", role: "assistant", content: [] }])])),
    );
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly({ toolInventory: [makeBuiltinEntry("Read"), makeBuiltinEntry("Bash")] }) },
      fetchMock,
    );
    try {
      await expect(adapter.runTurn({ prompt: "hello" })).resolves.toMatchObject({ aborted: false });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.tools).toEqual([
        expect.objectContaining({ type: "function", name: "Read", strict: false }),
        expect.objectContaining({ type: "function", name: "Bash", strict: false }),
      ]);
      expect(body.tools[0].parameters).toMatchObject({ type: "object" });
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
    } finally {
      cleanup();
    }
  });
```

Plus: empty-inventory turn still posts `tools: []` (keeps the `:143` body shape honest for tool-less agents).

**T2 — dispatch loop (new describe):** use an in-process fixture server with an `echo` tool (registered via `server.tool("echo", …, async ({text}) => ({content: [{type:"text", text: `echo:${text}`}]}))` — mirror the openai test file's registration shape) so execution runs through the **real** `ToolBridge` over `InMemoryTransport`:

  - [ ] single round, no calls → text delivered, one fetch, `toolCalls: 0`, `toolSummary: "none"`
  - [ ] **two rounds:** round-1 SSE = `completed([reasoningItem, callItem("mcp__fixture__echo", '{"text":"hi"}')])`; round-2 SSE = text deltas + `completed([message])` → assertions: fetch called twice; round-2 body `input` = `[userItem, reasoningItem, callItem, {type:"function_call_output", call_id:"call_1", output:"echo:hi"}]` **with the reasoning item present verbatim**; `result.text` is round-2's text ONLY; `result.toolCalls === 1`; `toolSummary` contains `mcp__fixture__echo×1`
  - [ ] gate-deny (assembly `guardrailGate: async () => ({behavior:"deny", reason:"nope"})`) → the `function_call_output`'s `output` contains the bridge's denial text, loop continues to round 2, turn succeeds
  - [ ] unknown tool name (`callItem("not_a_tool")`) → output `"Tool execution failed (not_a_tool): unknown tool"`, no throw, round 2 proceeds
  - [ ] bad-JSON arguments (`callItem("mcp__fixture__echo", "{nope")`) → output contains `arguments were not valid JSON`, no throw
  - [ ] `resourceLimits: {maxTurns: 1}` with round-1 emitting a call → `result.error === "error_max_turns"`, exactly one fetch, `classifyTurnResult(result)` → `{outcome:"fault", kind:"non-provider"}` (import from `./error-classification.js`), and a fake `historyStore`'s `append` NOT called — **fixture note:** this case (unlike the rest of the loop describe) must construct the adapter WITH the fake store + `agentId` + a `workItemContext` carrying `threadId` (the Task-3 history-fixture trio below), otherwise "append not called" is vacuous — no `historyKey` ⇒ append unreachable regardless

**History replay/persist (adapter half of T3/§D3), with a fake store (`{load: vi.fn(async () => […]), append: vi.fn(async () => {}), clear: vi.fn(async () => {})}` cast as `TurnHistoryStore`) + `agentId: "agent-x"` + `workItemContext` carrying `threadId: "sms:t1"`:**

  - [ ] replay: `load` resolving `[prevItemA, prevItemB]` → first POST `input` = `[prevItemA, prevItemB, userItem]`; `load` called with `("agent-x", "sms:t1", "codex")`
  - [ ] persist on success: `append` called once with `("agent-x", "sms:t1", "codex", [userItem, …round output items…, function_call_output])` — the exact `thisTurnItems` shape
  - [ ] no persist on error result (scripted `response.failed` or non-ok fetch) and none on abort
  - [ ] no `historyStore`/`agentId`/`workItemContext` → `load`/`append` never called; `input` = `[userItem]` (pre-353 floor)
  - [ ] **ordering companion pin (T4's adapter half): `load` is invoked before the first `fetch` call** (compare `mock.invocationCallOrder`)
  - [ ] **T3 breaker-safety integration pin:** a **real** `TurnHistoryStore` constructed over a fake db whose `findOne`/`updateOne` reject with `new Error("connect ECONNREFUSED 127.0.0.1:27017")` (reuse the Task 1 fake-collection pattern), wired into the adapter → the turn completes with text, `result.error` is `undefined`, `classifyTurnResult(result)` → `{outcome:"success"}` — no Mongo text anywhere in the result

**T6 — telemetry:**

  - [ ] two-round turn with the echo tool → `result.toolMs` > 0 ⇒ `result.llmMs === result.durationMs - result.toolMs` (and `>= 0`)
  - [ ] usage summed across rounds: round-1 completed usage `{input_tokens: 10, output_tokens: 2}`, round-2 `{input_tokens: 30, output_tokens: 5, input_tokens_details: {cached_tokens: 8}}` → `inputTokens: 40`, `outputTokens: 7`, `cacheReadTokens: 8`; a `response.in_progress` payload carrying usage inside round 2 does not change the totals (loop half of the Task-2 pin)

**T8 — abort (extend the existing abort describe):**

  - [ ] mid-tool abort: echo tool's handler calls `adapter.abort()` before resolving → `aborted: true`, exactly one fetch (no round 2), fake store's `append` not called
  - [ ] between-round abort: `onStream` callback aborts during round-1 SSE → `aborted: true`, no second fetch
  - [ ] `const closeSpy = vi.spyOn(ToolBridge.prototype, "close")` → called exactly once on success, error, and abort paths (three cases); no unhandled rejections (vitest surfaces them as failures)
  - [ ] existing abort/missing-OAuth/instructions-verbatim tests: pass unmodified

**Negative-verify legs 1 + 2 (mandatory, recorded):** (1) temporarily change the request body back to `tools: []` → T1 fails → restore. (2) temporarily revert the set literal to `new Set(["openai"])` → the two updated turn-assembly pins fail → restore. Record both failing outputs for the PR description.

- [ ] **Step 3.6: Verify + commit (one commit — the canon surface)**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0. Boundary checks (run BEFORE `git add`, and use `HEAD` so staged-vs-worktree splits can't hide a stray file): `git diff HEAD --stat` shows exactly the four files of this task; `git diff HEAD -- src/agents/provider-adapters/turn-assembly.ts` shows the set literal + comment hunk only.

```bash
git add src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/turn-assembly.test.ts
git commit -m "KPR-353: codex tool flip — bridge-bound Responses function tools + hive-owned dispatch loop + replay/persist; TOOL_EXECUTING_PROVIDERS += codex (same-commit canon, pins inverted)"
```

---

## Task 4 (Chunk 4): §D7 poisoned-replay self-heal — T7

**Files:**
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.ts` (only if Step 3.1's §D7 block needs spike-driven adjustment — the block ships in Task 3; this task is its TEST coverage and any refinement)
- Modify (additive): `src/agents/provider-adapters/codex-subscription-adapter.test.ts`

The §D7 branch is part of Step 3.1's loop (a 4xx before any SSE consumption); this chunk pins it exhaustively as its own review surface.

- [ ] **Step 4.1: T7 tests (new describe, fake store + threadId context as in Task 3)**

  - [ ] **heal:** `load` → `[staleItem]`; fetchMock call 1 → `new Response("{\"error\":{\"message\":\"invalid encrypted content\"}}", {status: 400})`, call 2 → good SSE → assertions: fetch called twice; second body `input` = `[userItem]` only (history dropped); `store.clear` called exactly once with `("agent-x", "sms:t1")`; result is a SUCCESS (`error` undefined); warn logged
  - [ ] **healed turn persists:** after the heal, `append` called with the fresh turn's items (the §D3 record of the healed turn)
  - [ ] **accepted-breadth pin (429-with-replay-history → heals + clears):** `load` → `[staleItem]`; call 1 → 429 response, call 2 → good SSE → heal fires exactly as for 400 (`clear` called once, retry `input` = `[userItem]`, success). This pins the DELIBERATE §D7 breadth: all 4xx incl. 401/403/429 heal-and-clear; a transient-fault over-clear (expired token / rate limit) is accepted — one bounded reset, §D7 backstop
  - [ ] **non-replay 4xx never retries:** `load` → `[]`; 400 response → one fetch, error result containing `Codex subscription request failed (400)`, `clear` NOT called
  - [ ] **5xx keeps breaker weight:** `load` → `[staleItem]`; 500 response → one fetch, no retry, no clear; `classifyTurnResult(result)` → `{outcome:"fault", kind:"server-error"}`
  - [ ] **second 4xx after heal:** both fetches 400 → two fetches total, error result (no third attempt — `selfHealed` guard)
  - [ ] **mid-turn (round ≥ 2) 4xx never self-heals:** round-1 good SSE with a call, round-2 fetch → 400 → error result, `clear` not called, two fetches total

- [ ] **Step 4.2: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/codex-subscription-adapter.test.ts` → green; then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts
git commit -m "KPR-353: §D7 poisoned-replay self-heal pins — one fresh 4xx retry + clear; 5xx keeps breaker weight"
```

---

## Task 5 (Chunk 5): Wiring — store injection, codex-branch options, awaited KPR-313 handoff-clear (T4)

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/index.ts`
- Modify (additive): `src/agents/agent-manager.test.ts`

- [ ] **Step 5.1: `agent-manager.ts` — ctor param + field**

Add the import beside the `SessionStore` import:

```typescript
import type { TurnHistoryStore } from "./turn-history-store.js";
```

Add the field beside `private sessionStore: SessionStore;` (`:364`):

```typescript
  /** KPR-353 (§D3/§D4): stateless-replay turn history. Optional so bare test
   *  constructions stay valid; production wiring (index.ts) always passes it.
   *  Absent ⇒ codex turns run stateless (pre-353 floor) and the handoff hook
   *  no-ops. */
  private turnHistoryStore?: TurnHistoryStore;
```

Extend the constructor signature (`:413-425`) with a trailing 12th parameter and assign it with the others (`:428` block):

```typescript
    memoryLifecycle?: MemoryLifecycle,
    turnHistoryStore?: TurnHistoryStore,
  ) {
    …
    this.turnHistoryStore = turnHistoryStore;
```

- [ ] **Step 5.2: codex adapter branch — pass `historyStore` + `agentId` (`:514-521`)**

```typescript
    if (route.provider === "codex") {
      return new CodexSubscriptionAdapter({
        name: config.name,
        model: route.model || appConfig.codex.agentModel,
        reasoningEffort: route.reasoningEffort,
        assembly,
        // KPR-353 (§D3): hive-persisted stateless-replay history. agentId is
        // config.id (the store key); `name` above stays the display label.
        historyStore: this.turnHistoryStore,
        agentId: config.id,
      });
    }
```

(openai/gemini branches untouched.)

- [ ] **Step 5.3: the §D4 handoff-clear — one addition inside the guard's handoff branch (`:713-722`)**

Insert between the `log.warn` (`:714-720`) and the `effectiveCtx` assignment (`:721`):

```typescript
          // KPR-353 (§D4): a provider handoff invalidates the thread's replay
          // history (validity is contiguous-same-provider by construction).
          // AWAITED — load-bearing: this very turn proceeds through
          // prepareSpawn to the adapter's load(), so only a clear that
          // resolves before the spawn continues orders the Mongo delete ahead
          // of the read; fire-and-forget would let the post-handoff turn
          // replay the stale doc. An awaited fail-soft Mongo op inside the R7
          // window is established posture (the sessionStore.get above), and
          // clear() never throws (§D3) — the catch is belt-and-braces for
          // foreign store impls/mocks. Accepted residual (spec §D4): if the
          // swallowed clear FAILS, the stale doc survives until TTL
          // (same-provider turns never re-trip the guard) — warn-logged in
          // the store, tolerated; a resulting 4xx lands in the §D7 self-heal.
          if (this.turnHistoryStore) {
            await this.turnHistoryStore.clear(ctx.agentId, ctx.threadId).catch(() => {});
          }
```

The adopt branch (`:706-712`) gets **no** hook (the predecessor's own guard trip already cleared). No other line in the guard changes — R7 order intact.

- [ ] **Step 5.4: `index.ts` — construct + init beside `SessionStore` (`:318-319`), pass as 12th arg (`:376-388`)**

```typescript
  const sessionStore = new SessionStore(db);
  await sessionStore.init();

  // KPR-353 (§D3): stateless-replay turn history (codex) — provider_turn_history.
  const turnHistoryStore = new TurnHistoryStore(db);
  await turnHistoryStore.init();
```

Add `import { TurnHistoryStore } from "./agents/turn-history-store.js";` beside the `SessionStore` import (`:35`), and extend the `AgentManager` construction:

```typescript
  agentManager = new AgentManager(
    registry,
    memoryManager,
    sessionStore,
    db,
    turnTelemetryStore,
    activityLogger,
    prefetcher,
    teamRoster,
    prefixCache,
    undefined,
    memoryLifecycle,
    turnHistoryStore,
  );
```

- [ ] **Step 5.5: T4 tests (additive describe inside the existing KPR-313 describe, `agent-manager.test.ts:2350+`)**

Harness: a fake store `makeFakeTurnHistoryStore()` returning `{load: vi.fn(async () => []), append: vi.fn(async () => {}), clear: vi.fn(async () => {})}`; construct a local manager passing it as the 12th ctor arg (positions 6–11 `undefined`, mirroring the existing 5-arg construction at `:365-371`). Reuse the existing `seed`/`smsCtx` helpers and the `"codex-pilot"` agent registration pattern (`:2401-2404`, model `"codex/gpt-5.5:medium"`). Cases:

  - [ ] **codex-branch options pin:** spawn a codex turn → `mockCodexConstructor` called with `expect.objectContaining({ historyStore: fakeStore, agentId: "codex-pilot" })` (and `name` still the display name `"Codex Pilot"`)
  - [ ] **handoff clears (claude→codex):** seed `(threadId, "claude-uuid-1", "claude")`, spawn codex with `sessionProvider: "claude"` → `fakeStore.clear` called exactly once with `("codex-pilot", threadId)`
  - [ ] **ORDERING pin (the T4 headline — negative-verify leg 4 runs against this):** make `clear` return a manually-deferred promise. Start the spawn WITHOUT awaiting; settle via `await vi.waitFor(() => fakeStore.clear.mock.calls.length > 0)` **then a generous microtask flush (`await Promise.resolve()` ×10)** — NOT merely "clear was called", which both the fixed and fire-and-forget variants satisfy immediately (vacuous-pass risk under the mutant) → assert `mockCodexConstructor` and `mockCodexRunTurn` have NOT been called while `clear` is pending (the adapter — and therefore its `load()`, per the Task-3 adapter-half pin that `load` precedes the first fetch inside `runTurn` — is unreachable until the clear resolves); resolve the deferred; `await` the spawn → turn completes, `mockCodexRunTurn` called
  - [ ] **rejected clear swallowed:** `clear` rejecting → spawn resolves normally (no throw), `mockCodexRunTurn` called
  - [ ] **adopt branch doesn't clear:** seed so the post-lock re-read returns the TURN's provider (the `:2418+` ⚠A9 adopt pattern) → `clear` not called
  - [ ] **no store ⇒ no-op:** manager constructed without the 12th arg → handoff spawn completes exactly as before (existing suite behavior), nothing throws
  - [ ] **existing pins unmodified:** the whole pre-existing KPR-313 describe (incl. "sessions row written with `sessionId: ''` provider codex") passes with zero edits

  **Negative-verify leg 4 (mandatory, recorded):** temporarily change the Step-5.3 line to fire-and-forget (`void this.turnHistoryStore.clear(…)`) → the ORDERING pin fails (runTurn reached while clear pending); in this mutant run, settle on the STRONG signal — `await vi.waitFor(() => mockCodexRunTurn.mock.calls.length > 0)` succeeds while `clear` is still pending — proving the settle window is long enough for the mutant to be caught (non-vacuous) → restore → green. Record the failing output.

- [ ] **Step 5.6: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0. Boundary check: `git diff -- src/agents/agent-manager.ts` shows exactly three hunks (import+field/ctor, codex branch, guard clear) — `finalizeSpawnResult`, breaker acquire/record, `prepareSpawn`, adopt branch untouched.

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts src/index.ts
git commit -m "KPR-353: wire TurnHistoryStore — manager injection, codex adapter options, awaited KPR-313 handoff-clear (ordering-pinned)"
```

---

## Task 6 (Chunk 6): Documentation riders (§D8, §R)

**Files:**
- Modify: `src/agents/provider-adapters/types.ts` (**comment-only**)
- Modify: `CLAUDE.md`

- [ ] **Step 6.1: `types.ts` — the §R correction (`:35-45`, `stateless-replay` bullet)**

Reword the final sentence of the bullet — the stale "codex gains replay in KPR-350" projection — to:

```
 *  - "stateless-replay":   NO provider-side resumable handle exists;
 *                          continuity, if any, is hive-persisted history
 *                          replayed client-side. Codex posts store:false and
 *                          sends no previous_response_id; gemini runs
 *                          runEphemeral — their pilot-fabricated ids are not
 *                          handles. Replay implementation status is
 *                          per-provider (codex replay shipped in KPR-353 —
 *                          TurnHistoryStore / provider_turn_history, replayed
 *                          client-side by the adapter; gemini leaves this
 *                          category when Interactions lands) — the
 *                          persistence behavior (never persist a handle) is
 *                          identical either way, which is what this
 *                          descriptor keys.
```

**No value, union, or function in this file changes** — `SESSION_SEMANTICS.codex` stays `"stateless-replay"` (canon: it is the truthful permanent label for this surface).

- [ ] **Step 6.2: CLAUDE.md riders**

1. Collections list (`:263`): after the `sessions` entry, insert:

```
`provider_turn_history` (codex stateless-replay turn history KPR-353 — per-(agent, thread, provider) Responses input items incl. encrypted reasoning, whole-turn-trimmed under a char budget, 7d TTL, cleared on KPR-313 provider handoff),
```

2. Pilots paragraph (`:248`): replace the sentence "The pilots still **advertise zero tools** to their providers — tool execution arrives with the KPR-348 bridge — and assembly faults classify…" with:

```
The openai and codex adapters **execute real hive tools** through the KPR-348 `ToolBridge` (openai via the Agents SDK loop; codex via its own bounded Responses dispatch loop, KPR-353, with hive-persisted stateless-replay history in `provider_turn_history` — client-side replay incl. encrypted reasoning, `store: false` always); gemini still advertises zero tools until KPR-352. Assembly faults classify `non-provider` (`TurnAssemblyError`), never tripping a provider breaker.
```

(Keep the rest of the paragraph — models default / credentials sentence — verbatim.)

- [ ] **Step 6.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0 (comment/docs-only). `git diff -- src/agents/provider-adapters/types.ts` — every changed line is inside a block comment.

```bash
git add src/agents/provider-adapters/types.ts CLAUDE.md
git commit -m "KPR-353: §D8/§R doc riders — types.ts replay comment corrected (value untouched), CLAUDE.md collections + pilots paragraph"
```

---

## Task 7 (Chunk 7): Final verification — full gate, neutrality diffs, live e2e evidence

- [ ] **Step 7.1: Full gate**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck + lint + format + full vitest suite green (incl. KPR-349's golden suite and all KPR-313 pins, untouched).

- [ ] **Step 7.2: Neutrality by diff** (base: `$(git merge-base kpr-345 HEAD)`; use `origin/kpr-345` if the local branch is absent)

  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/builtin-executor.ts src/agents/provider-adapters/tool-transport.ts src/agents/provider-adapters/archetype-gate.ts src/agents/provider-adapters/skill-index.ts src/agents/provider-adapters/oauth-credentials.ts src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/openai-agents-adapter.ts src/agents/provider-adapters/gemini-adk-adapter.ts src/agents/provider-adapters/claude-agent-adapter.ts src/agents/session-store.ts src/agents/prefix-builder.ts src/agents/toolkit-section.ts src/agents/agent-runner.ts` → **empty** (bind-don't-redesign; codex ≡ openai classify sites; Claude lane untouched)
  - [ ] `git diff … -- src/agents/provider-adapters/types.ts` → **comment-only**: `git diff … -- src/agents/provider-adapters/types.ts | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-]\s*\*'` → **zero lines** (every changed line is a ` * ` block-comment line), and `grep -n 'codex: "stateless-replay"' src/agents/provider-adapters/types.ts` still matches exactly one line (the value pin — crisper than grepping the bare string, which also hits the union + gemini lines)
  - [ ] `git diff … -- src/agents/provider-adapters/turn-assembly.ts` → the set literal + its doc comment, nothing else
  - [ ] `git diff … -- src/agents/agent-manager.ts` → exactly the three Task-5 hunks; the guard's compare/adopt logic and `finalizeSpawnResult` show zero changed lines
  - [ ] `git diff … -- src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/gemini-adk-adapter.test.ts` → **empty** (gemini pins live and green)

- [ ] **Step 7.3: Live e2e turn (dev Mac, evidence-recorded — the T0 surface, post-implementation)**

Scratch tsx driver (session scratchpad, never committed): construct the **real** `CodexSubscriptionAdapter` with a hand-built assembly carrying `toolInventory: [makeBuiltinEntry("Bash") shape]` + allow-all gate + `sessionCwd: <scratch dir>`, an in-memory `TurnHistoryStore` stand-in (Map-backed object implementing `load`/`append`/`clear`), `agentId: "kpr353-live"`, and a `workItemContext` with `threadId: "kpr353-live-thread"`. Run:

1. Turn 1: prompt `"Run \`echo hive-353-live\` with the Bash tool and tell me its output."` → assert `result.text` contains `hive-353-live`, `result.toolCalls >= 1`, `result.toolMs > 0`, `result.llmMs === result.durationMs - result.toolMs`; the stand-in store received one `append` whose items include a reasoning item with `encrypted_content` and a `function_call`/`function_call_output` pair.
2. Turn 2 (same thread): prompt `"What was the exact string you echoed a moment ago?"` → assert `result.text` contains `hive-353-live` (replay continuity live) and the request was accepted (no §D7 heal fired).

Record the redacted transcript (encrypted content as lengths, no secrets) as a closing section appended to `docs/epics/kpr-345/kpr-353-spike-notes.md` + summarized in the PR description. If the credential/network is unavailable, report the concrete blocker — do not skip silently.

- [ ] **Step 7.4: Evidence into the PR description + spike-notes commit**

The four negative-verify records (Steps 2.2, 3.5×2, 5.5 — plus Task 1's inline store leg), the T0 spike verdict table, the live-turn transcript, the §R note (KPR-350 non-dependency, `types.ts` comment handed back truthful), and an explicit **§D7 accepted-breadth callout** (all 4xx incl. 401/403/429 heal-and-clear the thread history — deliberate, T7-pinned) so KPR-351's live validation doesn't discover 429-clears-history as a surprise in production.

```bash
git add docs/epics/kpr-345/kpr-353-spike-notes.md
git commit -m "KPR-353: post-implementation live evidence — real tool call + replay continuity on the subscription surface"
```

---

## Notes for the reviewer (plan-level decisions and their rationale)

1. **`TurnHistoryStore` is an optional trailing 12th `AgentManager` ctor param.** The existing suite constructs the manager with 5 positional args (`agent-manager.test.ts:365-371`); a required param would churn every construction. Production wiring (index.ts) always passes it; T4 pins the pass-through into the codex branch, so a silently-missing prod wire is test-caught at the seam. Absent-store behavior is the pre-353 floor by design (spec §D3 "bare test constructions … skip").
2. **The adapter loads history BEFORE the OAuth check.** Cost is one fail-soft Mongo read on credential-less turns (trivial); benefit is deterministic degradation ordering plus T4 testability — the manager-level ordering pin observes "adapter unreachable while clear pending" and composes with the adapter-level "load precedes first fetch" pin to cover the spec's `clear`-before-`load()` guarantee without a live-Mongo harness.
3. **`applyResponsePayload` split into interim/completed functions** rather than a boolean parameter — the §D2 rule ("usage keys on `response.completed` only; id/interim fields keep overwrite behavior") becomes structural instead of conditional, and the multi-count negative-verify (leg 3) perturbs exactly one function.
4. **`maxRounds` counts model POSTs (SDK `maxTurns` parity).** Exhaustion fires when a further POST would be needed — after round-N tools executed but before round N+1 — returning the `error_max_turns` sentinel (already pinned non-provider at `error-classification.ts:57`), `text: ""`, no persist. The §D7 heal resets the round counter so a healed turn gets its full budget; the `selfHealed` flag makes it single-shot.
5. **T4's ordering pin is asserted at the `runTurn` boundary, not inside Mongo.** `load()` lives inside `runTurn`; the manager test proves `runTurn` (and adapter construction) is not reached while `clear` is pending, and the adapter test proves `load` precedes the first fetch inside `runTurn`. Together they pin the spec's ordering guarantee with the existing all-mocked manager harness.
6. **`tools` is always present in the request body** (`[]` when the bridge yields nothing) — keeps the wire shape stable, keeps the `:143` existing body assertion green for tool-less agents, and makes the T1 inversion a clean pin.
7. **The `agentId` adapter option is added rather than reusing `name`** — `name` is the display label (`config.name`, e.g. "Codex Pilot") and feeds bridge logging (openai parity); history keys must be `config.id`. The options doc comments carry the distinction.
8. **Task 2 lands the SSE groundwork as its own behavior-neutral commit** so the Task-3 flip commit review surface is exactly what the canon names: the tools flip, the loop that justifies it, the set literal, and the inverted pins.
9. **Store fail-soft mirrors `session-store.ts:71-81`'s `withRetry` idiom** (private `withFallback`) — same logging shape, same "fallback on persistent failure" semantics; the breaker-safety invariant lives in the store (never-throw contract) with belt-and-braces `.catch` mirrors at every consumer call site — the manager's clear (spec T4) and the adapter's three sites (`load`/`append`/heal-`clear`, Step 3.1) — so a future non-conforming store impl can't leak Mongo text into `RunResult.error` either.
10. **Spike contingency is bounded (Task 0):** observed field-name/header deltas fold into Tasks 2/3 verbatim from the spike notes; wholesale rejection of any leg is a demote-to-spec STOP — the plan never improvises a protocol the spike didn't witness.
