# KPR-392 Implementation Plan — Grok promotion: first-class native adapter on the shared implementation layer

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-392-spec.md](./kpr-392-spec.md) (approved, Gate 1 signed off) — the contract. Epic: KPR-385 (Decision Register canon C1–C10 binds). Code base: KPR-391 merged @ `def333d`; **every anchor below verified against this worktree's HEAD `65a96cb`.**

**Delivery-tier input (plan author's view, reviewer classifies authoritatively): standard.** This is a fourth-consumer module + manager wiring + a hard cutover on the now-proven KPR-391 scaffold — the codex adapter is a near-complete template and every behavior-bearing test delta is enumerated below; the invariant-dense extraction risk that made KPR-391 needs-capable was retired by KPR-391 itself.

**Goal:** `grok/<model>[:<effort>]` graduates from Lane A passthrough to a native Lane B `GrokGatewayAdapter` — `LaneBTurnScaffold` + `runBoundedDispatchLoop` + a fourth `LaneBProviderModule` entry (the C6 contract's fourth in-tree consumer) — speaking the operator-hosted CLIProxyAPI gateway's OpenAI **chat-completions** surface with **stateless-replay** sessions on the existing `provider_turn_history` machinery. Auth posture byte-compatible with KPR-384: `GROK_GATEWAY_KEY` env→Honeypot per spawn, `GROK_GATEWAY_URL` validated override, no `XAI_API_KEY` anywhere. Lane A grok retires in the same PR (hard cutover, no dual-lane flag).

**Architecture:** One new adapter file (`grok-gateway-adapter.ts` + test) modeled on the codex adapter minus codex's quirks (no encrypted-reasoning replay, no §D7 4xx self-heal, scaffold-default session hooks). Type-system widening: `LaneBProviderId` gains `"grok"` (compile-forcing the three tool-transport compatibility-record sites and their test fixtures), `LaneBModuleDeps.providerConfig` gains `baseUrl?: string` (the C6-sanctioned pre-freeze ABI stress), `SESSION_SEMANTICS.grok` flips `client-transcript` → `stateless-replay`. Manager cutover: grok leaves the two Lane A branches (`agent-manager.ts:579/:595`) and the Lane A `ProviderModelRoute` member; a grok arm in `moduleDeps.providerConfig` resolves the key via the **exported** `resolveEnvKeyCredential` (spec-review advisory 1 — the "authentication"-bearing `TurnAssemblyError` message and Honeypot chain stay byte-identical) and the gateway URL via the **exported** `assertSafeBaseUrlOverride`. `passthrough-providers.ts` drops its grok row; kimi/deepseek stay byte-identical.

**Spec rulings honored (load-bearing, per task):**
- *C10 / spec §7 — enumerated test-delta treatment:* this is a behavior-bearing ticket. The shared layers (scaffold, loop, sse, bridge, assembly, classification, breaker) and the codex/gemini/openai suites pass **unedited**. The complete set of pre-existing tests that change is enumerated in the Testing Contract's "Enumerated behavior-bearing deltas" list — anything outside that list needing an edit is a defect: stop and re-derive.
- *Spec §4.1 — chat-completions surface:* `POST {gateway}/v1/chat/completions`, `stream: true`, `stream_options: {include_usage: true}`. No Responses, no `/v1/messages`.
- *Spec §4.2 — stateless-replay:* `TurnHistoryStore` reused unchanged (provider key `"grok"`, opaque chat messages, system prompt never stored, success-only whole-turn append, fail-soft `.catch`). **No in-adapter 4xx self-heal** (the loop's `onRequestError` hook stays unused — gemini precedent). No encrypted-reasoning replay. Scaffold-default fallback sessionId (`request.sessionId ?? ""`, no fabrication) and default `interruptionSessionId`.
- *Spec §4.2 + advisory 2 — success sessionId:* the loop formula `lastProviderRoundId ?? fallbackSessionId` feeds the **last round's** chat-completion `id` through on multi-round turns (each `executeRound` reports `providerRoundId: state.completionId`; the loop overwrites per round, so the final round wins). Cosmetic under stateless-replay — never persisted — and the loop formula is untouched.
- *Spec §4.5 + advisory 3 — effort mapping & warn-once location:* `low/medium/high/xhigh` deliver verbatim as `reasoning_effort`; `minimal`/`none` coerce to `low` with a warn-once whose dedup state is **module-level in `grok-gateway-adapter.ts` (process-wide — gemini precedent: adapters are per-spawn so instance state would warn every spawn), keyed `${name}:${effort}`, with a `__resetGrokCoercionWarnedForTests()` export** mirroring gemini's `__resetCoercionWarnedForTests`.
- *Spec §4.4 — C5 from birth:* every non-2xx and stream-phase error decoration carries the status when one exists (`Grok gateway request failed (<status>): <excerpt>`, mirroring codex's proven `(<status>):` shape so the `FAULT_PATTERNS` rows match) — grok must NOT inherit codex's `response.failed` message-only drop (KPR-395).
- *Spec §4.3 / C7 / C8:* the module never touches `process.env` or Keychain — the manager resolves the slice per spawn; history wiring is primary-context-only (nested grok delegate turns provably never touch `provider_turn_history`).
- *Spec §4.7 — hard cutover & rollback:* no config flag. Rollback = per-agent model change + SIGUSR1, or `hive rollback`. Upgrade cost (one-time silent fresh context per live grok thread — same provider id ⇒ no KPR-313 annotation) is documented, not special-cased.
- *Spec §4.8 — no catalog code change;* `docs/providers.md` grok column rewritten as a Lane B column (KPR-355 duty) in the same PR.
- *Green-commit sequencing note:* `SESSION_SEMANTICS.grok` flips in **Task 3** (with the manager cutover), NOT in Task 1's type widening — flipping it earlier would fail the still-Lane-A manager pin "persists the real handle under the grok tag". Task 1's widened `LaneBProviderId` is inert until the manager routes grok to the module table.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `grok-gateway-adapter.test.ts` (request-body shape, chunk application incl. fragmented `tool_calls` assembly, usage capture, C5 decoration, history policy, effort mapping + warn-once, session policy); `passthrough-providers.test.ts` additions for the newly exported `resolveEnvKeyCredential` / `assertSafeBaseUrlOverride`; `provider-modules.test.ts` grok construction parity; `classification-crosscheck.test.ts` grok rows.
  - Reason: the adapter is the ticket's new load-bearing surface; all of it is deterministic and drivable with mocked `fetch` + scripted SSE bodies (the codex suite's proven fixture pattern).
  - Harness: **existing** (replicate the codex/gemini suites' fixture patterns — minimal `ProviderTurnAssembly` literals, allow-all gate, `tmpdir()` sessionCwd, fake-collection history store; replicate, don't cross-import).
  - Minimum assertions: the per-task lists in Tasks 2–4 (each maps to a spec §7 bullet).

- Integration: **required**
  - Scope: `agent-manager.test.ts` grok describe rewritten to Lane B pins (module-table construction, missing-key `TurnAssemblyError` breaker-invisibility, URL validation, breaker attribution, stateless session persistence, KPR-313 handoff variant); the untouched remainder of the 8 KPR-391-pinned suites passing unedited over the widened union.
  - Reason: the manager seam (route → module table → adapter, breaker/outage/session integration) is where the cutover lives; the existing suites are the C10 regression pins.
  - Harness: **existing** — `agent-manager.test.ts` module-mocks each Lane B adapter; grok gains the same mock shape (see Task 3's mock note: the factory must preserve the module's constant exports via `importOriginal`).
  - Minimum assertions: Task 3's manager list; all non-enumerated existing tests green with zero expectation edits.

- E2E: **not-required**
  - Scope: n/a in CI.
  - Reason: the live gateway + `grok login` OAuth session exist only on operator machines (DOD-212 / no-vendor-keys-in-CI posture). Spec §7 designates the live smoke as **implementation-gated, operator-run** post-merge: one grok turn on a dev instance through the real gateway — tools executing, streamed text, usage present, `:xhigh` accepted — closing the spec §8 ⚠ assumptions, plus the standing V4–V6 rollout validation absorbing the Lane B switch.
  - Harness: not-applicable (operator's instance).
  - Minimum assertions: n/a in CI (operator smoke checklist recorded in the PR body).

### Critical Flows

- Grok turn: history replay → key guard → bridge connect → bounded POST/SSE/tool rounds (fragmented `tool_calls` assembled before harvest, sequential execution, `role:"tool"` results appended) → success-only history append → success sessionId = last round's completion id.
- Failure paths: gateway down (`ECONNREFUSED`/`fetch failed` → `connect-fail`, grok breaker only); gateway 401/403 status-prefixed → `auth`; xAI 429/5xx pass-through status-prefixed; stream drop without `finish_reason` → decorated stream error, never a silent empty harvest; `maxTurns: 0` → zero-fetch `error_max_turns`; deadline/abort — all scaffold/loop-owned, nothing grok-local.
- Manager: grok routes Lane B through both construction sites (primary + nested delegate, nested omits history wiring); missing `GROK_GATEWAY_KEY` → `TurnAssemblyError`, breaker closed; stateless-replay ⇒ session row persisted with empty sessionId; provider-handoff clear + KPR-313 Lane B notice variant correct by construction.

### Regression Surface

- **Zero-expectation-edit suites (C10):** `codex-subscription-adapter.test.ts`, `gemini-interactions-adapter.test.ts`, `openai-agents-adapter.test.ts`, `turn-scaffold.test.ts`, `dispatch-loop.test.ts`, `sse.test.ts`, `error-classification.test.ts`, `provider-circuit-breaker.test.ts`, `builtin-executor.test.ts`, `archetype-gate.test.ts`, `skill-index.test.ts`, and every non-grok block of `agent-manager.test.ts` (KPR-354 nested delegates, KPR-350/352 handoff arms, kimi/deepseek Lane A blocks) — no edits of any kind.
- **Enumerated behavior-bearing deltas (the complete list — spec §7):**
  1. `src/agents/provider-adapters/types.test.ts` — LaneBProviderId canon pin rewritten to four ids (Task 1); grok `persistsResumableHandle` row `true` → `false` (Task 3).
  2. `src/agents/provider-adapters/tool-transport.test.ts` — compatibility fixtures/expectations gain the compile-forced `grok` column (values mirroring codex); `providers` arrays gain `"grok"` (Task 1).
  3. `src/agents/provider-adapters/turn-assembly.test.ts` (4 fixture literals) and `tool-bridge.test.ts` (1 fixture literal) — compile-forced `grok:` key added to compatibility objects, mirroring the codex value in each literal; **no expectation changes** (Task 1).
  4. `src/agents/provider-adapters/provider-modules.test.ts` — table-keys pin gains `"grok"`; additive grok construction-parity tests (Task 1).
  5. `src/agents/provider-adapters/passthrough-providers.test.ts` — grok Lane A pins (table row, `isLaneAProvider` true row, `resolvePassthroughSpawn` grok describe, `buildPassthroughEnv` grok pin) removed/rewritten; kimi/deepseek pins byte-identical (Task 3).
  6. `src/agents/agent-manager.test.ts` — the "Lane A passthrough — Grok (KPR-371)" describe (~3443–3640) replaced by a Lane B grok describe + the grok adapter module mock (Task 3).
  7. `src/agents/provider-adapters/classification-crosscheck.test.ts` — **additive** grok rows only (Task 4).
- Untouched modules (empty diff verified in Task 7): `turn-scaffold.ts`, `dispatch-loop.ts`, `sse.ts`, `tool-bridge.ts`, `turn-assembly.ts`, `error-classification.ts`, `builtin-executor.ts`, `archetype-gate.ts`, `skill-index.ts`, `oauth-credentials.ts`, `turn-history-store.ts`, `claude-agent-adapter.ts`, `codex-subscription-adapter.ts`, `gemini-interactions-adapter.ts`, `openai-agents-adapter.ts`, `session-store.ts`, `config.ts` (the stale grok comment in `config.ts` is accepted-as-is per spec §5 "config.ts: unchanged").
- Error-string contract: `FAULT_PATTERNS` rows, `TURN_DEADLINE_SUBTYPE`, the kimi/deepseek `TurnAssemblyError` message, `isStaleServerHandleError` — none change by a character. Grok's new decorated strings are designed to land on existing rows (no `FAULT_PATTERNS` edits).

### Commands

- Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Targeted inner loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/ src/agents/agent-manager.test.ts src/agents/provider-circuit-breaker.test.ts`
- Per-file count verification (Tasks 0 and 7): `... npx vitest run <file>` and read the `Tests  N passed` line — **vitest runtime output, never grep** (`it.each` expansion).
- E2E: not-applicable (operator smoke post-merge, outside this plan).

### Harness Requirements

- Env stubs for any `npm run check` / vitest run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test` (all three; `SLACK_BOT_TOKEN` is the one that actually trips).
- No new services or accounts. The grok suite replicates the codex suite's mocked-`fetch` + hand-built SSE body pattern and the fake-collection `TurnHistoryStore`.

### Non-Required Rationale

- E2E: CI holds no gateway or vendor credentials by design; spec §7 gates the live smoke on implementation and assigns it to the operator.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test. **An expectation edit outside the enumerated-delta list is definitionally a defect — stop and re-derive.**
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/agents/provider-adapters/grok-gateway-adapter.ts` | create | `GrokGatewayAdapter`: chat-completions wire shape, SSE chunk application, effort mapping, stateless-replay history (§4.4) |
| `src/agents/provider-adapters/grok-gateway-adapter.test.ts` | create | Adapter pins (spec §7 list) |
| `src/agents/provider-adapters/types.ts` | modify | `LaneBProviderId` + `"grok"` (Task 1); `SESSION_SEMANTICS.grok` → `"stateless-replay"` + canon comments (Task 3) |
| `src/agents/provider-adapters/provider-module.ts` | modify | `LaneBModuleDeps.providerConfig` gains `baseUrl?: string` (C6 pre-freeze stress) |
| `src/agents/provider-adapters/provider-modules.ts` | modify | Fourth entry: `grokModule` |
| `src/agents/provider-adapters/tool-transport.ts` | modify | Three compatibility records gain the compile-forced `grok` column (mirrors codex) |
| `src/agents/provider-adapters/passthrough-providers.ts` | modify | Grok row deleted; `LaneAProviderId` = `"kimi" \| "deepseek"`; `assertSafeBaseUrlOverride` + `resolveEnvKeyCredential` exported |
| `src/agents/agent-manager.ts` | modify | Route member move; two Lane A branches drop grok; grok `moduleDeps.providerConfig` arm (key + URL resolution per spawn) |
| Enumerated test files (Regression Surface list) | modify | Exactly the enumerated deltas |
| `src/agents/provider-adapters/classification-crosscheck.test.ts` | modify | Additive grok rows |
| `docs/providers.md` | modify | Grok column → Lane B (§4.8); footnotes, non-goal 1, history + rollback/migration entry |
| `CLAUDE.md` | modify | Provider adapters + grok sections synced to the promotion |

---

### Task 0: Baseline pin

**Files:** none (verification only).

- [ ] **Step 1:** Confirm clean tree at the expected base.

Run: `git -C /Users/mokie/github/lane-kpr-392-mature status --porcelain && git -C /Users/mokie/github/lane-kpr-392-mature log --oneline -1`
Expected: empty status (beyond this plan file's own commit); HEAD at/above `65a96cb` on the lane branch.

- [ ] **Step 2:** Record per-file baseline counts (runtime output, not grep) for every suite named in the Regression Surface — the KPR-391-era expectations were codex **50**, gemini **41**, openai **31**, manager **223**, breaker **29**, error-classification **59**, turn-assembly **23**, tool-bridge **45**; also record actuals for the KPR-391 suites (`sse`, `turn-scaffold`, `dispatch-loop`, `provider-modules`, `classification-crosscheck`, `tool-transport`, `types`, `passthrough-providers`). If a recorded actual differs from a number this plan states, the recorded actual is the baseline — note it in the PR body; if a **zero-edit** suite's count later changes, STOP.

- [ ] **Step 3:** Note `git hash-object docs/providers.md` and `git hash-object CLAUDE.md` (both WILL change — Task 6; the hashes bound the docs diff to those two files plus this plan's directory).

No commit.

---

### Task 1: `GrokGatewayAdapter` + Lane B type-system widening

**Files:**
- Create: `src/agents/provider-adapters/grok-gateway-adapter.ts`
- Modify: `src/agents/provider-adapters/types.ts` (LaneBProviderId only — semantics flip is Task 3), `provider-module.ts`, `provider-modules.ts`, `tool-transport.ts`
- Modify (enumerated deltas 1–4): `types.test.ts`, `tool-transport.test.ts`, `turn-assembly.test.ts`, `tool-bridge.test.ts`, `provider-modules.test.ts`

After this task grok still runs Lane A end-to-end (manager untouched; `SESSION_SEMANTICS.grok` still `client-transcript`) — the widened union and the module entry are dead code until Task 3, and every existing manager/passthrough pin stays green.

- [ ] **Step 1:** `types.ts` — widen the union and update the canon comment:

```typescript
export type LaneBProviderId = "openai" | "gemini" | "codex" | "grok";
```

Update the comment block above it: Lane A (kimi/deepseek) must still NEVER gain a column; grok's membership is the KPR-392 promotion (the KPR-371 "grok is Lane A" sentence is rewritten, not contradicted silently). Do NOT touch `SESSION_SEMANTICS` in this task.

- [ ] **Step 2:** `tool-transport.ts` — the union widening compile-breaks the three compatibility-record sites (broken branch ~87, claude-builtin/subagent branch ~110–120, final return ~135–141). Add `grok:` mirroring the codex value in each:

```typescript
      compatibility: {
        claude: "direct",
        openai: "unsupported",
        gemini: "unsupported",
        codex: "unsupported",
        grok: "unsupported",
      },
```
```typescript
      compatibility: {
        claude: "direct",
        openai: nonClaude,
        gemini: nonClaude,
        codex: nonClaude,
        grok: nonClaude,
      },
```
```typescript
    compatibility: {
      claude: "direct",
      openai: nonClaudeCompatibility,
      gemini: nonClaudeCompatibility,
      codex: nonClaudeCompatibility,
      grok: nonClaudeCompatibility,
    },
```

- [ ] **Step 3:** `provider-module.ts` — extend the singular config slice (C6-sanctioned ABI stress; nothing else on the contract moves):

```typescript
  /** ... existing doc comment unchanged, plus: `baseUrl` (KPR-392) is the
   *  caller-validated provider endpoint for providers whose endpoint is
   *  deployment infrastructure (grok's operator-hosted gateway) rather than
   *  a universal vendor address — resolved and validated by the engine,
   *  consumed opaquely by the module. */
  providerConfig?: { agentModel?: string; apiKey?: string; baseUrl?: string };
```

- [ ] **Step 4:** Write `src/agents/provider-adapters/grok-gateway-adapter.ts`:

```typescript
/**
 * KPR-392: GrokGatewayAdapter — grok's Lane B native adapter, the fourth
 * consumer of the KPR-391 implementation layer (LaneBTurnScaffold +
 * runBoundedDispatchLoop + module registry).
 *
 * Wire surface (spec §4.1): the operator-hosted CLIProxyAPI gateway's
 * OpenAI chat-completions endpoint — POST {baseUrl}/v1/chat/completions,
 * stream: true, stream_options.include_usage — the thinnest translation to
 * xAI's OpenAI-format backend (the KPR-384 lesson: cross-shape translation
 * layers breed quirks). The gateway keeps the `grok login` subscription
 * OAuth; hive holds only a gateway allowlist key (GROK_GATEWAY_KEY),
 * CALLER-resolved (env→Honeypot per spawn in agent-manager's grok arm) and
 * constructor-injected — never resolved in-adapter (DOD-212 / C7).
 *
 * Session semantics (spec §4.2): stateless-replay — the codex model minus
 * codex's quirks. Hive-persisted chat messages replay via TurnHistoryStore
 * (provider "grok"; system prompt NEVER stored — it assembles fresh each
 * turn); success-only whole-turn append; NO in-adapter 4xx self-heal (the
 * loop's onRequestError hook stays unused — grok replay items are plain
 * messages hive composed, so a 4xx on them is a real request-shape bug that
 * heal-by-clear would mask); no encrypted-reasoning replay. Session hooks
 * are scaffold defaults (no fabrication); the success sessionId is the loop
 * formula lastProviderRoundId ?? fallback, fed the LAST round's
 * chat-completion id — cosmetic under stateless-replay, never persisted.
 *
 * C5 from birth (spec §4.4): every request/stream error decoration carries
 * the status when one exists — never codex's response.failed message-only
 * drop (KPR-395).
 */
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { ReasoningEffort } from "./types.js";
import { createLogger } from "../../logging/logger.js";
import type { BridgedTool } from "./tool-bridge.js";
import type { TurnHistoryStore } from "../turn-history-store.js";
import {
  LaneBTurnScaffold,
  type LaneBTurnHarness,
  type LaneBTurnOutcome,
} from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { parseSseEvent, splitSseEvents, isSseDone, type SseEvent } from "./sse.js";

/** KPR-384 posture, unchanged by the promotion: loopback default; the
 *  GROK_GATEWAY_URL override is validated at the manager
 *  (assertSafeBaseUrlOverride — https, or http to loopback only). */
export const DEFAULT_GROK_GATEWAY_URL = "http://127.0.0.1:8317";
/** KPR-371 §3.5: the subscription session exposes only grok-4.6/grok-4.5. */
export const DEFAULT_GROK_MODEL = "grok-4.6";

const log = createLogger("grok-adapter");

/** §4.5: :effort → chat-completions reasoning_effort. low/medium/high/xhigh
 *  deliver VERBATIM (xhigh becomes expressible — the Lane A clamp retires);
 *  minimal/none coerce to low (chat completions has no "off" lever, and
 *  Lane A's silent drop is exactly what this ticket retires). */
const GROK_REASONING_EFFORTS: Record<ReasoningEffort, "low" | "medium" | "high" | "xhigh"> = {
  minimal: "low",
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};
const COERCED_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(["minimal", "none"]);
/** Warn-once per (agent, effort) — module-level (process-wide) because
 *  adapters are per-spawn (gemini precedent, spec-review advisory 3). */
const coercionWarned = new Set<string>();
/** Test-only: module-level warn-once state is order-fragile across tests. */
export function __resetGrokCoercionWarnedForTests(): void {
  coercionWarned.clear();
}

export interface GrokGatewayAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  /** GROK_GATEWAY_KEY — caller-resolved per spawn; never resolved here. */
  apiKey?: string;
  /** Validated gateway base URL — caller-resolved; defaults to loopback. */
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof fetch;
  /** Stateless-replay history (primary context only — the module omits both
   *  keys for nested delegate turns, C8 analog). */
  historyStore?: TurnHistoryStore;
  agentId?: string;
}

/** One fully assembled streamed tool call (edge 3: fragments assemble before
 *  harvest; partial calls are never emitted). */
interface GrokToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface GrokStreamState {
  text: string;
  /** chat.completion.chunk `id` — the per-round provider id (advisory 2:
   *  the loop keeps the LAST round's as the success sessionId). */
  completionId?: string;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** index-keyed incremental tool_call fragments (id/name arrive once,
   *  arguments concatenate). */
  fragments: Map<number, { id?: string; name?: string; arguments: string }>;
  /** Assembled by executeRound after the stream closes; harvested by the loop. */
  assembled: GrokToolCall[];
}

export class GrokGatewayAdapter extends LaneBTurnScaffold {
  readonly provider = "grok" as const;

  constructor(private readonly options: GrokGatewayAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  // Session hooks: scaffold defaults ARE grok's policy (spec §4.2/C3) —
  // fallback `request.sessionId ?? ""` (no fabrication; codex's uuid is
  // pilot legacy, deliberately not copied), bare-fallback interruption id.

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("Grok turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // History key + replay — codex §D3 template verbatim (absent context ⇒
    // replay and persist both skip; load never throws, never leaks Mongo
    // error text; deliberately BEFORE the key guard — deterministic
    // degradation ordering, the scaffold does not sequence this).
    const threadId = request.workItemContext?.threadId || undefined;
    const historyKey =
      this.options.historyStore && this.options.agentId && threadId
        ? { store: this.options.historyStore, agentId: this.options.agentId, threadId }
        : undefined;
    const replayed = historyKey
      ? await historyKey.store
          .load(historyKey.agentId, historyKey.threadId, "grok")
          .catch((): unknown[] => [])
      : [];

    // Bare-construction guard only: the manager's grok arm resolves
    // GROK_GATEWAY_KEY (env→Honeypot) and throws TurnAssemblyError BEFORE
    // construction (breaker-invisible config fault). Phrased to hit the
    // FAULT_PATTERNS auth row if it ever surfaces from a bare construction.
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error(
        "Grok gateway API key is not available; seed GROK_GATEWAY_KEY via `hive credentials add GROK_GATEWAY_KEY`",
      );
    }

    const bridged = await bridge.connect();
    const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
    // Chat-completions function tools. Edge 2 (§6.2): NO schema
    // normalization pre-built — the `required`-array quirk is believed
    // Anthropic-validator-specific; `parameters.required ??= []` is the
    // one-line mitigation IF live validation bites, not before.
    const toolPayloads = bridged.map((bt) => ({
      type: "function" as const,
      function: { name: bt.name, description: bt.description, parameters: bt.inputSchema },
    }));

    const systemMessage = {
      role: "system",
      content: request.systemPromptOverride ?? this.options.assembly.instructions,
    };
    const userMessage = { role: "user", content: request.prompt };
    // Wire messages: system (assembled fresh each turn, NEVER stored) +
    // replayed prior turns + this turn's user message.
    const messages: unknown[] = [systemMessage, ...replayed, userMessage];
    /** §4.2 turn record: user message + every round's assistant message +
     *  hive's tool results. Persisted only on success. */
    const thisTurnItems: unknown[] = [userMessage];

    const endpoint = `${(this.options.baseUrl ?? DEFAULT_GROK_GATEWAY_URL).replace(/\/+$/, "")}/v1/chat/completions`;
    const reasoningEffort = this.resolveReasoningEffort();

    const outcome = await runBoundedDispatchLoop<GrokStreamState, GrokToolCall>({
      request,
      harness,
      executeRound: async () => {
        const response = await this.fetchImpl()(endpoint, {
          method: "POST",
          signal: harness.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: this.options.model ?? DEFAULT_GROK_MODEL,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            ...(toolPayloads.length > 0 ? { tools: toolPayloads } : {}),
          }),
        });
        // C5: status-prefixed decoration, thrown directly — no onRequestError
        // hook (no self-heal, §4.2), so the throw routes through the loop to
        // the scaffold containment frame and classifies on the status.
        if (!response.ok) throw new Error(await gatewayErrorMessage(response));

        const state = await consumeGrokSse(response.body, request.onStream, harness.isAborted);
        // Edge 3: assemble fragments BEFORE harvest — partial calls are
        // never emitted; anomalies throw (decorated) instead of silently
        // harvesting empty. Skipped when the turn aborted mid-stream (the
        // loop's post-stream checkpoint resolves the interruption).
        if (!harness.isAborted()) state.assembled = assembleToolCalls(state);
        const assistantMessage = {
          role: "assistant",
          content: state.text || null,
          ...(state.assembled.length > 0
            ? {
                tool_calls: state.assembled.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
        messages.push(assistantMessage);
        thisTurnItems.push(assistantMessage);
        return {
          state,
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
          },
          providerRoundId: state.completionId,
          text: state.text,
        };
      },
      harvest: (state) => state.assembled,
      // Dedup belt (spec §4.4): the gateway should never repeat a call id,
      // but the loop-level guard closes the double-emission case for free.
      callId: (call) => call.id,
      executeCall: async (call) => {
        const output = await executeGrokToolCall(call, bridgedByName);
        const toolMessage = { role: "tool", tool_call_id: call.id, content: output };
        messages.push(toolMessage);
        thisTurnItems.push(toolMessage);
      },
    });

    if (outcome.kind !== "success") return outcome;

    // Success-only whole-turn append (fail-soft — a Mongo blip never fails
    // the turn); interrupted/max-turns/deadline outcomes returned above
    // without persisting.
    if (historyKey) {
      await historyKey.store
        .append(historyKey.agentId, historyKey.threadId, "grok", thisTurnItems)
        .catch(() => {});
    }
    return outcome;
  }

  /** §4.5 effort mapping (advisory 3: process-wide warn-once, module-level). */
  private resolveReasoningEffort(): string | undefined {
    const effort = this.options.reasoningEffort;
    if (!effort) return undefined; // no suffix ⇒ field omitted (vendor default)
    const mapped = GROK_REASONING_EFFORTS[effort];
    if (COERCED_EFFORTS.has(effort)) {
      const key = `${this.options.name}:${effort}`;
      if (!coercionWarned.has(key)) {
        coercionWarned.add(key);
        log.warn("Grok :effort suffix coerced to low (KPR-392 §4.5)", {
          agent: this.options.name,
          effort,
          reasoningEffort: mapped,
        });
      }
    }
    return mapped;
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
  }
}

/** Bridge-level containment mirror of codex's executeFunctionCall: a
 *  hallucinated tool name or unparseable arguments become structured tool
 *  output text, never a throw. */
async function executeGrokToolCall(
  call: GrokToolCall,
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

/** Edge 3: fragment assembly — index order, id/name required. A fragment
 *  set missing either is a mid-stream drop, decorated as such ("terminated"
 *  lands on the connect-fail row — the gateway is grok route
 *  infrastructure; its death is a grok outage). */
function assembleToolCalls(state: GrokStreamState): GrokToolCall[] {
  const calls: GrokToolCall[] = [];
  for (const index of [...state.fragments.keys()].sort((a, b) => a - b)) {
    const frag = state.fragments.get(index)!;
    if (!frag.id || !frag.name) {
      throw new Error(
        `Grok gateway stream delivered an incomplete tool_call at index ${index} (missing id or name) — connection terminated mid-stream`,
      );
    }
    calls.push({ id: frag.id, name: frag.name, arguments: frag.arguments });
  }
  return calls;
}

export async function consumeGrokSse(
  body: ReadableStream<Uint8Array> | null,
  onStream: ((chunk: string) => void) | undefined,
  isAborted: () => boolean = () => false,
): Promise<GrokStreamState> {
  if (!body) throw new Error("Grok gateway response did not include a stream body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: GrokStreamState = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    fragments: new Map(),
    assembled: [],
  };
  let buffer = "";

  try {
    while (!isAborted()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeBufferedGrokEvents(buffer, state, onStream);
    }
    buffer += decoder.decode();
    consumeBufferedGrokEvents(`${buffer}\n\n`, state, onStream);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some Web Stream implementations throw if the stream is already closed.
    }
  }

  // Edge 3: a stream that ended without any finish_reason (and was not
  // aborted by hive) is a gateway drop — surface it, never a silent empty
  // harvest. "terminated" lands on the connect-fail FAULT_PATTERNS row.
  if (!isAborted() && state.finishReason === undefined) {
    throw new Error("Grok gateway stream ended without finish_reason — connection terminated mid-stream");
  }
  return state;
}

export function consumeBufferedGrokEvents(
  buffer: string,
  state: GrokStreamState,
  onStream?: (chunk: string) => void,
): string {
  const { events, remainder } = splitSseEvents(buffer);
  for (const raw of events) {
    const event = parseSseEvent(raw);
    if (!event) continue;
    applyGrokChunk(event, state, onStream);
  }
  return remainder;
}

function applyGrokChunk(event: SseEvent, state: GrokStreamState, onStream?: (chunk: string) => void): void {
  if (isSseDone(event)) return;

  const payload = parseJson(event.data);
  if (!payload) return;

  // C5: an in-stream error payload keeps its status/code — never message-only.
  const errorObj = objectField(payload, "error");
  if (errorObj) {
    const status = errorObj["status"] ?? errorObj["code"];
    const message = stringField(errorObj, "message") ?? JSON.stringify(errorObj);
    throw new Error(
      status !== undefined && status !== null
        ? `Grok gateway stream failed (${String(status)}): ${message}`
        : `Grok gateway stream failed: ${message}`,
    );
  }

  const id = stringField(payload, "id");
  if (id) state.completionId = id;

  // include_usage delivers one final usage-bearing chunk (empty choices) —
  // assignment, not accumulation: last-wins can never multi-count within a
  // round (codex's interim-usage lesson, adapted to the chat shape).
  const usage = objectField(payload, "usage");
  if (usage) {
    state.inputTokens = numberField(usage, "prompt_tokens") ?? state.inputTokens;
    state.outputTokens = numberField(usage, "completion_tokens") ?? state.outputTokens;
    const details = objectField(usage, "prompt_tokens_details");
    const cached = details ? numberField(details, "cached_tokens") : undefined;
    if (cached !== undefined) state.cacheReadTokens = cached;
  }

  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0] as Record<string, unknown>;

  const finish = stringField(choice, "finish_reason");
  if (finish) state.finishReason = finish;

  const delta = objectField(choice, "delta");
  if (!delta) return;

  const content = stringField(delta, "content");
  if (content) {
    state.text += content;
    onStream?.(content);
  }

  const toolCalls = delta["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const raw of toolCalls) {
      if (!raw || typeof raw !== "object") continue;
      const frag = raw as Record<string, unknown>;
      const index = numberField(frag, "index");
      if (index === undefined) continue;
      const entry = state.fragments.get(index) ?? { arguments: "" };
      const fragId = stringField(frag, "id");
      if (fragId) entry.id = fragId;
      const fn = objectField(frag, "function");
      const name = fn ? stringField(fn, "name") : undefined;
      if (name) entry.name = name;
      const args = fn ? stringField(fn, "arguments") : undefined;
      if (args) entry.arguments += args;
      state.fragments.set(index, entry);
    }
  }
}

/** C5 decoration — mirrors codex's responseErrorMessage shape exactly
 *  (`(<status>):` is what the FAULT_PATTERNS rows key on). */
async function gatewayErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  const payload = parseJson(text);
  const message =
    stringField(objectField(payload, "error"), "message") ??
    stringField(payload, "detail") ??
    stringField(payload, "message") ??
    text;
  return `Grok gateway request failed (${response.status}): ${message}`;
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function objectField(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field && typeof field === "object" ? (field as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" ? field : undefined;
}
```

- [ ] **Step 5:** `provider-modules.ts` — the fourth entry (spec §4.3 snippet, verbatim modulo the model-constant import):

```typescript
import {
  DEFAULT_GROK_MODEL,
  GrokGatewayAdapter,
} from "./grok-gateway-adapter.js";
```

```typescript
const grokModule: LaneBProviderModule = {
  provider: "grok",
  createAdapter: (args) =>
    new GrokGatewayAdapter({
      name: args.name,
      model: args.route.model || args.deps.providerConfig?.agentModel || DEFAULT_GROK_MODEL,
      apiKey: args.deps.providerConfig?.apiKey, // GROK_GATEWAY_KEY, caller-resolved
      baseUrl: args.deps.providerConfig?.baseUrl, // validated gateway URL, caller-resolved
      reasoningEffort: args.route.reasoningEffort,
      assembly: args.assembly,
      // C8 analog: history wiring in PRIMARY context only — nested grok
      // delegate turns provably never touch provider_turn_history.
      ...(args.context === "primary"
        ? { historyStore: args.deps.turnHistoryStore, agentId: args.deps.agentId }
        : {}),
    }),
};

export const LANE_B_PROVIDER_MODULES: Record<LaneBProviderId, LaneBProviderModule> = {
  codex: codexModule,
  openai: openaiModule,
  gemini: geminiModule,
  grok: grokModule,
};
```

- [ ] **Step 6:** Enumerated test edits (deltas 1–4):
  - `types.test.ts`: rewrite the LaneBProviderId canon pin —
    ```typescript
    it("LaneBProviderId is exactly {openai, gemini, codex, grok} — kimi/deepseek Lane A never joins (KPR-346 canon; grok promoted KPR-392)", () => {
      const laneB: Record<LaneBProviderId, true> = { openai: true, gemini: true, codex: true, grok: true };
      expect(Object.keys(laneB)).toHaveLength(4);
    });
    ```
    (The `persistsResumableHandle` grok row stays `true` in this task.)
  - `tool-transport.test.ts`: add `grok` to every compatibility fixture/expectation object (same value as the codex key in each literal) and to the `providers` arrays in the partition `it.each` blocks (additive coverage — grok partitions identically to codex).
  - `turn-assembly.test.ts` (4 literals: ~40, ~77, ~155, ~258) and `tool-bridge.test.ts` (~86): add the compile-forced `grok:` key mirroring the codex value. No expectation changes.
  - `provider-modules.test.ts`: table-keys pin → `["codex", "gemini", "grok", "openai"]`; add grok parity tests mirroring the codex block: primary construction carries `historyStore`/`agentId`, nested omits both (`"historyStore" in options === false`); model chain `route → providerConfig.agentModel → "grok-4.6"`; `apiKey`/`baseUrl` threaded from the deps slice; `reasoningEffort` passes through; `name`/`assembly` verbatim.

- [ ] **Step 7:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green. Manager + passthrough suites untouched and passing (grok still Lane A end-to-end this commit).

- [ ] **Step 8:** Commit

```bash
git add src/agents/provider-adapters/grok-gateway-adapter.ts src/agents/provider-adapters/types.ts src/agents/provider-adapters/provider-module.ts src/agents/provider-adapters/provider-modules.ts src/agents/provider-adapters/tool-transport.ts src/agents/provider-adapters/types.test.ts src/agents/provider-adapters/tool-transport.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/provider-modules.test.ts
git commit -m "feat: GrokGatewayAdapter — Lane B chat-completions adapter + module entry (KPR-392 §4.3/§4.4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Grok adapter unit suite

**Files:**
- Create: `src/agents/provider-adapters/grok-gateway-adapter.test.ts`

Fixture pattern: replicate the codex suite (mocked `fetch` returning hand-built SSE `ReadableStream` bodies; minimal `ProviderTurnAssembly` literal — empty inventory/omitted/skillIndex, allow-all gate, `{}` inProcessServers, `memory: {}`, `tmpdir()` sessionCwd; fake-collection `TurnHistoryStore` where history pins need one; `__resetGrokCoercionWarnedForTests()` in `beforeEach`). Chat-completions SSE fixtures are `data: {...}\n\n` lines ending `data: [DONE]\n\n`.

- [ ] **Step 1:** Write the suite. Minimum assertions (each maps to a spec §7 bullet):
  - **Request body:** POST to `<baseUrl>/v1/chat/completions` with `authorization: Bearer <key>`; body carries `model` (options → `grok-4.6` default), `stream: true`, `stream_options: {include_usage: true}`, `messages` = `[system(instructions), ...replayed, user(prompt)]` (seed the fake store — replayed items appear between system and user), `tools` in the chat function shape (and omitted entirely when the bridge yields none), `systemPromptOverride` replacing the assembly instructions when set.
  - **Effort mapping:** `:xhigh` → `reasoning_effort: "xhigh"` verbatim; `high`/`medium`/`low` verbatim; `minimal` and `none` → `"low"` with exactly one `log.warn` across two turns of the same adapter name (warn-once, process-wide) and a second warn for a different agent name; no suffix ⇒ no `reasoning_effort` key in the body.
  - **Chunk application:** text deltas accumulate + stream through `onStream`; `id` captured; final usage chunk sets token counts (assignment — a duplicated usage chunk does not double); absent usage ⇒ zeros (edge 4); fragmented `tool_calls` across chunks (id/name once, arguments split across 3 chunks) assemble into one call; two interleaved indices assemble in index order.
  - **Tool round-trip:** round 1 emits a tool call → `executeCall` runs the bridged tool (mocked bridge) → round-2 request body carries the assistant message **with `tool_calls`** and the `role:"tool"` result message; duplicate call id executes once (loop dedup via `callId`); hallucinated tool name / invalid-JSON arguments become structured tool output text, never a throw.
  - **Multi-round sessionId (advisory 2):** two rounds with completion ids `cmpl-1`/`cmpl-2` → success `sessionId === "cmpl-2"`.
  - **C5 decoration:** non-2xx response → error result `Grok gateway request failed (503): ...` (status present, classifiable); in-stream error payload with `code` → `Grok gateway stream failed (429): ...`; stream ending with no `finish_reason` → error containing `terminated` (edge 3), not a success with empty text.
  - **History policy:** success appends exactly `[user, assistant, (tool…)]` items under provider `"grok"` (system message never stored); error/deadline/abort turns append nothing; `load` rejection degrades to empty replay (turn still succeeds); no `historyStore`/`agentId`/`threadId` ⇒ no store calls.
  - **Session policy:** `request.sessionId` never appears in any request body (stateless transport); catch-error result `sessionId === request.sessionId ?? ""` — no fabrication (scaffold defaults).
  - **Missing key (bare construction):** no `apiKey` ⇒ error result containing `Grok gateway API key is not available` and `bridge.close` still called (scaffold finally).
  - **`maxTurns: 0`:** `error_max_turns` with zero fetch calls (loop-owned — one cheap pin that the wiring engages it).

- [ ] **Step 2:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/grok-gateway-adapter.test.ts` then the full `npm run check`.
Expected: new suite green; all baselines unchanged.

- [ ] **Step 3:** Commit

```bash
git add src/agents/provider-adapters/grok-gateway-adapter.test.ts
git commit -m "test: GrokGatewayAdapter unit pins — wire shape, SSE application, history, C5 (KPR-392 §7)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Manager cutover + Lane A retirement + semantics flip

**Files:**
- Modify: `src/agents/agent-manager.ts`, `src/agents/provider-adapters/passthrough-providers.ts`, `src/agents/provider-adapters/types.ts`
- Modify (enumerated deltas 1, 5, 6): `types.test.ts`, `passthrough-providers.test.ts`, `agent-manager.test.ts`

- [ ] **Step 1:** `passthrough-providers.ts`:
  - Delete the grok row from `PASSTHROUGH_PROVIDERS`; `export type LaneAProviderId = "kimi" | "deepseek";`; `isLaneAProvider` body → `p === "kimi" || p === "deepseek"`.
  - Export the two helpers (bodies byte-identical — advisory 1): `export function assertSafeBaseUrlOverride(...)` and `export function resolveEnvKeyCredential(...)`. The `TurnAssemblyError` messages do not change by a character.
  - Comments: the header's "grok is the one sanctioned exception" prose and the `PassthroughCredential` KPR-371/384 note are updated to record the KPR-392 promotion (grok is now Lane B; the gateway-exception canon note moves with it — point at `grok-gateway-adapter.ts`). Kimi/deepseek rows and `buildPassthroughEnv` byte-identical.
- [ ] **Step 2:** `types.ts`: `SESSION_SEMANTICS.grok` → `"stateless-replay"` with a KPR-392 comment (no provider-side handle through the stateless gateway; continuity = `provider_turn_history` replay; the write side — never persist a handle — is automatic via `persistsResumableHandle`). Update the KPR-371 grok comment lines.
- [ ] **Step 3:** `agent-manager.ts`:
  - `ProviderModelRoute` (~184): Lane A member shrinks to `"kimi" | "deepseek"`; add `| { provider: "grok"; model: string; reasoningEffort?: CodexReasoningEffort }`. `resolveProviderModel`'s grok arm is unchanged (same return shape, now a Lane B member — the full suffix set flows to the route; `clampLaneAEffort` no longer sees grok via the `isLaneAProvider` gate, and the KPR-313 notice arm takes the Lane B variant, both correct by construction with zero edits at those sites).
  - Both Lane A branches (~579, ~595): drop `|| route.provider === "grok"`.
  - Imports: add `assertSafeBaseUrlOverride`, `resolveEnvKeyCredential` from `./provider-adapters/passthrough-providers.js` and `DEFAULT_GROK_GATEWAY_URL` from `./provider-adapters/grok-gateway-adapter.js`.
  - The `moduleDeps` construction (~611) gains the grok arm — per-spawn resolution, so `hive credentials add` keeps next-spawn effect and a missing key throws `TurnAssemblyError` inside `runOneSpawnAttempt`'s recorded try (breaker-invisible by instanceof — same containment as the Lane A branch above it):

```typescript
    const moduleDeps: LaneBModuleDeps = {
      providerConfig:
        route.provider === "gemini"
          ? { agentModel: appConfig.gemini.agentModel, apiKey: appConfig.gemini.apiKey || undefined }
          : route.provider === "grok"
            ? this.resolveGrokModuleSlice()
            : { agentModel: appConfig[route.provider].agentModel },
      turnHistoryStore: this.turnHistoryStore,
      agentId: config.id,
    };
```

```typescript
  /**
   * KPR-392 (§4.3): grok's caller-resolved module slice — the engine
   * resolves, the module consumes (DOD-212; load-bearing for KPR-394).
   * GROK_GATEWAY_KEY: env→Honeypot PER SPAWN via the exported Lane A helper
   * so the "authentication"-bearing TurnAssemblyError message and chain stay
   * byte-identical to KPR-384 (spec-review advisory 1). GROK_GATEWAY_URL:
   * re-read per spawn, validated (https, or http to loopback only) —
   * verbatim KPR-384 semantics.
   */
  private resolveGrokModuleSlice(): { agentModel?: string; apiKey?: string; baseUrl?: string } {
    const override = process.env.GROK_GATEWAY_URL;
    return {
      agentModel: appConfig.grok.agentModel,
      apiKey: resolveEnvKeyCredential("GROK_GATEWAY_KEY", { instanceId: appConfig.instance.id }),
      baseUrl: override
        ? assertSafeBaseUrlOverride(override, "GROK_GATEWAY_URL")
        : DEFAULT_GROK_GATEWAY_URL,
    };
  }
```

  - Nothing else moves: the provider-handoff history clear (~979) is already provider-agnostic; the `server-resumable` self-heal arms are semantics-gated (grok qualifies for neither); breaker permit/record, outage gate, `finalizeSpawnResult` (persists `""` for grok automatically via `persistsResumableHandle`), reflection, telemetry — untouched.
- [ ] **Step 4:** Enumerated test rewrites:
  - `types.test.ts`: grok `persistsResumableHandle` row `["grok", true]` → `["grok", false]` (comment: KPR-392 stateless-replay). The seven-ids keys pin is unchanged.
  - `passthrough-providers.test.ts`: table pin drops the grok row and pins `Object.keys(PASSTHROUGH_PROVIDERS).sort()` = `["deepseek", "kimi"]`; `isLaneAProvider` `["grok", true]` → `["grok", false]` (kept as an explicit promotion pin); the `resolvePassthroughSpawn — grok gateway (KPR-384)` describe and the `buildPassthroughEnv` grok pin are **deleted**, replaced by a direct-export describe: `assertSafeBaseUrlOverride` (loopback http ok — `127.0.0.1`/`localhost`/`::1`; https off-box ok; cleartext off-box → `TurnAssemblyError` with the byte-identical message; invalid URL → `TurnAssemblyError`) and `resolveEnvKeyCredential` (resolveSecret seam honored; env-first-then-Keychain default; missing → `TurnAssemblyError` whose message contains `(authentication)` and the `hive credentials add GROK_GATEWAY_KEY` remediation, byte-pinned). Kimi/deepseek blocks untouched.
  - `agent-manager.test.ts`:
    - Add the grok adapter mock beside the other three, **preserving the constant exports** the real module ships (provider-modules.ts and agent-manager.ts import them at module load):
      ```typescript
      vi.mock("./provider-adapters/grok-gateway-adapter.js", async (importOriginal) => ({
        ...(await importOriginal<object>()),
        GrokGatewayAdapter: vi.fn().mockImplementation(function (options) {
          mockGrokConstructor(options);
          return { provider: "grok", runTurn: mockGrokRunTurn, abort: mockGrokAbort, wasAborted: false };
        }),
      }));
      ```
      with hoisted `mockGrokConstructor`/`mockGrokRunTurn`/`mockGrokAbort` mirroring codex's.
    - Replace the "Lane A passthrough — Grok (KPR-371)" describe (~3443–3640; the block from its `describe(` line through the closing brace before "spawnTurn shaping (KPR-224)") with a "Lane B grok (KPR-392)" describe. Minimum pins (mirror the codex/gemini manager blocks' assertion style):
      1. Construction: a grok turn constructs `GrokGatewayAdapter` via the module table with `apiKey: "test-grok-gateway-key"`, `baseUrl: "http://127.0.0.1:8317"`, `model: "grok-4.6"`; `AgentRunner` receives **no** `laneAPassthrough` bag.
      2. Model chain: route model wins; empty route model → `appConfig.grok.agentModel`; empty both → `grok-4.6` (constructor options).
      3. `:xhigh` flows to the constructor's `reasoningEffort` unchanged — no clamp warn recorded (the Lane A clamp retires for grok; kimi's clamp pin elsewhere is untouched).
      4. Missing `GROK_GATEWAY_KEY`: three consecutive turns fail with the credential message, breaker for `grok` stays **closed**; key restored → next turn succeeds (rewrite of the existing Lane A test onto `mockGrokRunTurn`).
      5. `GROK_GATEWAY_URL` override: loopback http accepted (constructor `baseUrl` = override); `http://evil.example` → turn fails with the cleartext message, breaker closed.
      6. Three hard faults (`mockGrokRunTurn` → `makeRunResult({ error: "Grok gateway request failed (503): boom" })`) open the **grok** breaker only; claude/kimi closed.
      7. Stateless persistence: a success turn persists the session row with an **empty** sessionId under the `"grok"` tag (`sessionStore.set(..., "", "grok", ...)`) — the KPR-313 write-side flip.
      8. KPR-313 handoff: a claude-tagged row + grok turn resets continuity with the **pilot** (Lane B) notice variant — prompt starts with `[System notice:` and does **not** contain `conversation_search`; a grok-tagged stale row on a grok turn adopts/ignores per stateless semantics (fresh context, no notice — same provider id).
      9. Provider handoff away from grok (grok-tagged row, claude turn) still clears `provider_turn_history` via the provider-agnostic clear (assert `turnHistoryStore.clear` called — reuse the existing codex-handoff test pattern).
- [ ] **Step 5:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/passthrough-providers.test.ts src/agents/provider-adapters/types.test.ts` then full `npm run check`.
Expected: green; every non-grok manager test untouched and passing at the Task 0 count minus/plus exactly the enumerated grok block delta (record the new manager count for Task 7).

- [ ] **Step 6:** Commit

```bash
git add src/agents/agent-manager.ts src/agents/provider-adapters/passthrough-providers.ts src/agents/provider-adapters/types.ts src/agents/provider-adapters/types.test.ts src/agents/provider-adapters/passthrough-providers.test.ts src/agents/agent-manager.test.ts
git commit -m "feat: cut grok over to Lane B — manager module wiring, Lane A retirement, stateless-replay semantics (KPR-392 §4.3/§4.7)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Classification crosscheck rows

**Files:**
- Modify: `src/agents/provider-adapters/classification-crosscheck.test.ts` (additive only)

- [ ] **Step 1:** Add grok rows to the existing `it.each` groups (spec §7):
  - `auth`: `"Grok gateway request failed (401): key not in allowlist"`, `"Grok gateway API key is not available; seed GROK_GATEWAY_KEY via \`hive credentials add GROK_GATEWAY_KEY\`"` (the bare-construction guard).
  - `rate-limit`: `"Grok gateway request failed (429): too many requests"`.
  - `server-error`: `"Grok gateway request failed (503): upstream unavailable"`.
  - `connect-fail`: `"Grok gateway stream ended without finish_reason — connection terminated mid-stream"` (the edge-3 drop decoration) — plus a comment that raw `fetch failed`/`ECONNREFUSED` throws are already row-pinned.
  - Deliberate-attribution comment: the loopback gateway is grok route infrastructure — its death classifies as a grok provider fault by design (KPR-306/307 key on the route).
- [ ] **Step 2:** Verify + commit

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/classification-crosscheck.test.ts` then full `npm run check`. Expected: green.

```bash
git add src/agents/provider-adapters/classification-crosscheck.test.ts
git commit -m "test: grok error-string classification crosscheck rows (KPR-392 §4.6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Negative verification (repo convention — no committed changes)

**Files:** temporary edits, fully reverted.

- [ ] **Step 1 (C5 leg):** In `grok-gateway-adapter.ts`, strip the status from `gatewayErrorMessage` (return `Grok gateway request failed: ${message}` without `(${response.status})`).

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/grok-gateway-adapter.test.ts src/agents/provider-adapters/classification-crosscheck.test.ts`
Expected: **failures** — the adapter's C5 decoration pin and the crosscheck's 429/503/401 rows (proof C5 is pinned, not incidental). Record which tests failed, then `git checkout -- src/agents/provider-adapters/grok-gateway-adapter.ts` and re-run green.

- [ ] **Step 2 (TurnAssemblyError leg — the KPR-384 negative-verify re-run on the new arm):** In `agent-manager.ts`'s `resolveGrokModuleSlice`, temporarily wrap the key resolution to rethrow as a plain `Error` (`catch (e) { throw new Error(String(e)); }`).

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
Expected: **failure** in the "missing GROK_GATEWAY_KEY … breaker stays closed" pin — the message contains "authentication", so as a plain Error it matches the auth fault row and counts toward the trip streak: proof the typed wrapper is load-bearing, not the message. Record, revert (`git checkout -- src/agents/agent-manager.ts`), re-run green. Include both failure lists in the PR body.

No commit.

---

### Task 6: Docs — parity matrix, CLAUDE.md, rollback story

**Files:**
- Modify: `docs/providers.md`, `CLAUDE.md`

- [ ] **Step 1:** `docs/providers.md` (spec §4.8 — KPR-355 duty, same PR):
  - **Prose:** Lane A paragraph → kimi/deepseek only (grok sentence removed, incl. the "rows 1–15 observed through translation" note); Lane B paragraph gains `grok/...` and a one-line gateway note. Column order: move the grok column out of the Lane A group to sit after codex; header becomes `| Capability | claude | kimi / deepseek (Lane A) | openai | gemini | codex | grok |`.
  - **Grok column, row by row (headline cells from the spec):** 1 `full` — hive-owned bounded chat-completions dispatch loop via the operator-hosted gateway; 2–9 the standard Lane B cells (fail-soft MCP; bridged in-process servers; hive builtin executor [^4]; `claude-only` server-side tools; 128-cap [^6]; index+`load_skill`; memory `full` [^8]; no-PreCompact guardrail gate [^9]); 10 `caveat(hive-persisted replay via self-hosted gateway)` [^10]; 11 `caveat(delegates only)` [^11]; 12 `caveat(reasoning_effort; xhigh expressible; minimal/none coerce to low)` [^12]; 13 `caveat(uncached, per-spawn)`; 14 `full`; 15 `caveat(costUsd 0; real token counts)` [^15] — the nominal-Claude-pricing caveat retires; 16 `caveat(self-hosted gateway)` — gateway API key via Honeypot, gateway owns the `grok login` OAuth [^16], substance unchanged; 17 `unit-tested; live validation gated on post-merge rollout (V4–V6)`.
  - **Footnotes:** [^5]/[^6] — Lane A wording back to two providers; [^10] — grok moves from the Lane A sentence into a codex-parallel sentence (stateless replay through the gateway, same 200k trim / 7d TTL / no 4xx-heal — grok has none — provider-handoff clear); [^11] — Lane A sentence back to kimi/deepseek; [^12] — Lane A clamp sentence drops the grok/xhigh note, grok gets its own sentence (verbatim `{low,medium,high,xhigh}`, `minimal/none→low` warn-once); [^15] — Lane A nominal-cost sentence drops grok; grok joins the gemini/codex zero-cost/real-counts clause; [^16] — the grok paragraph is updated in place (gateway/credential/OAuth substance is unchanged; only the "Lane A" framing and the per-spawn-resolution wording move to the Lane B context).
  - **Ruled non-goal 1:** keep the gateway-exception ruling, reworded — grok is now Lane B but the operator-owned middlebox canon and its rationale stand. Keep the grok cost-attribution revisit trigger.
  - **History:** append a dated entry: `2026-08-2X — Grok promoted to Lane B (KPR-392): native GrokGatewayAdapter on the shared KPR-391 layer, chat-completions via the operator-hosted gateway, stateless-replay sessions on provider_turn_history, :xhigh expressible. Hard cutover — Lane A grok removed. Rollback: per-agent model change + SIGUSR1, or hive rollback to the prior engine. Upgrade note: each live grok thread starts fresh context once (same provider id — no handoff annotation fires); stale Lane A grok session rows are ignored and TTL out.` — this entry is the rollback story's documented home (spec §4.7); mirror the same two sentences in the PR body's release-notes section.
- [ ] **Step 2:** `CLAUDE.md` sync:
  - **Provider adapters** section: grok moves from the Lane A passthrough sentence (`kimi/deepseek` remain) into the Lane B adapter list — add `GrokGatewayAdapter` alongside the other three with a one-line summary (chat-completions via the operator-hosted CLIProxyAPI gateway, stateless-replay on `provider_turn_history`, `:effort` verbatim incl. `xhigh` with `minimal/none→low`, `GROK_GATEWAY_KEY` env→Honeypot per spawn resolved by the manager, `costUsd 0` + real token counts).
  - **Lane A passthrough paragraph:** reduce to kimi/deepseek (table defaults line drops `grok-4.6`/`GROK_AGENT_MODEL` → move that default note to the grok Lane B sentence).
  - **"Grok routes through a self-hosted CLIProxyAPI gateway (KPR-384)" paragraph:** rewrite for KPR-392 — the gateway posture, credential, loopback validation, and no-XAI_API_KEY canon are unchanged; the adapter is now native Lane B chat-completions (not the Claude runtime pointed at `/v1/messages`); the `required`-array quirk note stays as history with the edge-2 mitigation note; sessions `stateless-replay` (replaces the `client-transcript` caveat); the `xhigh not expressible` sentence is deleted; rollback sentence updated (model change + SIGUSR1 unchanged).
  - **MongoDB collections bullet:** `provider_turn_history` description → "codex/grok stateless-replay turn history (KPR-353/KPR-392)".
- [ ] **Step 3:** Verify + commit

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (format gate covers the docs). Expected: green.

```bash
git add docs/providers.md CLAUDE.md
git commit -m "docs: grok parity-matrix column to Lane B + CLAUDE.md sync + rollback story (KPR-392 §4.8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Final gate, count verification, zero-diff audits

- [ ] **Step 1:** Full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — typecheck + lint + format + full vitest green.
- [ ] **Step 2:** Zero-edit audit: for every suite in the zero-edit list, `git diff <task0-base>..HEAD -- <file>` is empty and its runtime count matches Task 0 exactly. `git diff <task0-base>..HEAD --stat -- '**/*.test.ts'` lists **only** the seven enumerated test files plus the new `grok-gateway-adapter.test.ts`.
- [ ] **Step 3:** Untouched-module audit: `git diff <task0-base>..HEAD -- src/agents/provider-adapters/turn-scaffold.ts src/agents/provider-adapters/dispatch-loop.ts src/agents/provider-adapters/sse.ts src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/builtin-executor.ts src/agents/provider-adapters/archetype-gate.ts src/agents/provider-adapters/skill-index.ts src/agents/provider-adapters/oauth-credentials.ts src/agents/turn-history-store.ts src/agents/provider-adapters/claude-agent-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/gemini-interactions-adapter.ts src/agents/provider-adapters/openai-agents-adapter.ts src/agents/session-store.ts src/config.ts` → empty.
- [ ] **Step 4:** Confirm the ticket-range source diff shows exactly: `grok-gateway-adapter.ts`(+test), `types.ts`, `provider-module.ts`, `provider-modules.ts`, `tool-transport.ts`, `passthrough-providers.ts`, `agent-manager.ts`, the enumerated test files, `docs/providers.md`, `CLAUDE.md`, and this plan's directory. Anything else is a defect.
- [ ] **Step 5:** PR body checklist: enumerated-delta list, both negative-verification failure lists (Task 5), the release-notes migration note (one-time silent context reset per live grok thread), and the operator live-smoke checklist (tools executing, streamed text, usage present, `:xhigh` accepted — closes spec §8 ⚠ assumptions; V4–V6 absorb the Lane B switch).

No further commit (or a final `chore:` commit only if Step 1 surfaced formatting).

---

## Execution Handoff

Plan saved to `docs/epics/kpr-385/kpr-392-plan.md`. Ready to execute with `dodi-dev:implement`.
