# KPR-391 Implementation Plan — Lane B shared machinery: turn scaffold, bounded dispatch loop, provider-module registry

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-391-spec.md](./kpr-391-spec.md) (approved through 4 review rounds) — the contract. Epic: KPR-385. Code base: `99e989e` (includes PR #407's wall-clock deadline in all three Lane B adapters); **every anchor below verified against this worktree's HEAD `d02f7c9`.** The epic has no Decision Register canon (pre-register); the spec's KPR-350–354 + #407 rulings bind.

**Goal:** Extract the ~580 cloned lines of Lane B turn machinery into `LaneBTurnScaffold` (abstract base: abort lifecycle, #407 deadline arming/cleanup/priority, ToolBridge construct/close, containment frame, turn accumulator, `buildResult`) + `runBoundedDispatchLoop` (round budget, checkpoints, totals fold, sequential tool execution, restart affordance) + a `LaneBProviderModule` registry collapsing `createProviderAdapter`'s twin construction switches — migrating codex/gemini/openai behavior-preservingly with **zero test-expectation edits**.

**Architecture:** Five new files in `src/agents/provider-adapters/`: `sse.ts` (shared SSE framing — grok-ready), `turn-scaffold.ts` (abstract base all three adapters extend; owns everything that is not provider API shape), `dispatch-loop.ts` (standalone generic loop; codex + gemini engines — openai keeps the Agents SDK loop per the spec's honest 2-of-3 split), `provider-module.ts` (self-contained contract types — the embryonic KPR-394 plugin ABI), `provider-modules.ts` (three module implementations + the static `LANE_B_PROVIDER_MODULES` table). The three adapter classes keep their names, files, exported test surfaces, and constructor-option shapes; each becomes a subclass implementing `executeTurn(harness)` plus small policy hooks (`fallbackSessionId`, `interruptionSessionId`, `warnDeadlineExpired`, `errorText`). `agent-manager.ts`'s two construction sites (top-level tail `~762–791`, nested `delegateTurnRunner` `~650–685`) become module-table lookups sharing one `deps` object; every other manager mechanism (budget atomicity, lock exemption, abort chaining, D5.7 shaping, self-heal arms, breaker, `finalizeSpawnResult`) is untouched.

**Tech stack:** TypeScript strict, vitest beside source, existing fixtures (mocked `fetch`/scripted iterables, real `McpServer` over `InMemoryTransport`, module-mocked adapters in the manager suite). No new dependencies.

**Spec rulings honored (load-bearing, per task):**
- *Behavior-preserving is the bar (§Key Points):* 50 codex + 41 gemini + 31 openai + 223 manager + 29 breaker + 59 error-classification + 23 turn-assembly + 45 tool-bridge tests (= 501; vitest runtime counts re-verified on this worktree, Task 0) pass with import-path edits at most. Existing test **expectations may not change** — a migration step that "needs" one is a behavior change: stop and re-derive.
- *#407 deadline is scaffold-owned from birth (§4.1, §5 step 1, §7.11):* arm-inside-try, `clearTimeout`-in-finally, `deadlineFired` flag, `error_turn_deadline` shape (`timedOut: true` + `aborted: false`), operator-abort-outranks-deadline resolver. Codex/gemini catch mid-tool expiry at loop checkpoints; openai keeps its quiet-resolve guard in its own `executeTurn` via the scaffold-exposed `deadlineFired()` predicate.
- *Totals one-writer (§4.1/§4.2):* provider round code reports per-round usage; only the loop (or openai's `executeTurn` body — which reports nothing, preserving its zero-token row-15 caveat) folds it into the scaffold accumulator via `harness.addUsage`. No second counter exists anywhere in this plan.
- *Contract self-containment (§4.3):* `provider-module.ts` references only public adapter-surface types; `deps` is a named-handle surface; route shape is contract-owned `{model, reasoningEffort}` (provider discriminant dropped); transitive closure (`RunResult` etc.) stays type-only — re-homing deferred to KPR-394.
- *Session machinery stays per-provider (§Key Points / §7.3 / §7-last):* the three-way non-success sessionId policy is an explicit parameterization (`fallbackSessionId` + `interruptionSessionId` hooks), never a unification target. Codex history-before-auth ordering and gemini/openai auth-before-connect stay provider-owned inside `executeTurn`.
- *No behavior changes, including improvements (§3):* the codex stream-phase status drop is NOT fixed (Task 9 files the follow-up ticket note; the code stays byte-identical).
- *`docs/providers.md` zero diff (§8)* — checked at Task 9 and in the final gate.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `sse.ts` (framing parity vs the codex parser it replaces), `turn-scaffold.ts` (containment frame, deadline machinery, result building, session-policy hooks, bridge lifecycle), `dispatch-loop.ts` (budget, checkpoints, dedup, restart, final-text), `provider-modules.ts` (construction parity primary vs nested).
  - Reason: these are the new load-bearing layers; the spec (§8) enumerates their minimum pins explicitly. All are deterministic and drivable with plain fixtures.
  - Minimum assertions: the per-file lists in Tasks 1–3 and 8 (each maps to a spec §8 bullet): scaffold — bridge closed on success/error/abort/pre-request-throw; abort containment; `llmMs` clamp + `toolSummary`; fallback-session hook per policy; deadline (arm-inside-try throw-safety, clearTimeout on every exit path, `timeoutMs` 0/undefined semantics, operator-abort-outranks-deadline, `error_turn_deadline` shape). Loop — round budget incl. 0 (no network call); `error_max_turns` with accumulated totals; abort at each of the four checkpoints; sequential execution order; dedup hook; restart affordance resets budget exactly once; final-text semantics. Registry — per-provider construction parity, codex historyStore/agentId omission when nested. Cross-check — adapter characteristic error strings still classify to the same `ProviderFaultKind` (Task 9).

- Integration: **required**
  - Scope: the migrated adapters against the real `ToolBridge`/`McpServer`/`TurnHistoryStore` fixtures, and the registry seam against the real `assembleProviderTurn`/`spawnTurn` path.
  - Reason: the existing 501 tests across 8 files ARE the integration pins — they were written as pins by KPR-350–354 + #407 and already cover every §7 checklist item end-to-end. The behavior-preservation proof is that they pass unedited over the extracted code.
  - Harness: **existing** — `codex-subscription-adapter.test.ts` (mocked fetch + real bridge + fake-collection history store), `gemini-interactions-adapter.test.ts` (scripted-iterable client seam), `openai-agents-adapter.test.ts` (mocked `@openai/agents`), `agent-manager.test.ts` (module-mocked adapters — mocks intercept by resolved module id, so they keep working when `provider-modules.ts` becomes the importer).
  - Minimum assertions: all 501 existing tests green with zero expectation edits; per-file counts match Task 0's baseline exactly.

- E2E: **not-required**
  - Scope: n/a in CI.
  - Reason: live Lane B surfaces need subscription OAuth (codex) / vendor API keys (gemini, openai) that CI does not hold; the spec (§8) designates a live smoke as **optional, operator-run** post-merge (one codex turn on keepur — the KPR-351-validated surface), not a gate.
  - Harness: not-applicable (operator's production instance).
  - Minimum assertions: n/a (optional smoke: one codex turn completes with tool use).

### Critical Flows

- Codex turn: replay → auth → bridge connect → bounded POST/SSE/tool rounds → success persist (and: 4xx-on-replay self-heal once with budget reset; deadline mid-round and mid-tool; abort at every checkpoint; `maxTurns: 0` zero-POST short-circuit).
- Gemini turn: auth → connect → bounded create/stream/tool rounds with `previous_interaction_id` chaining → final-round id returned (and: stale-handle sentinel decoration round-1-only; stream-phase status preservation; deadline; abort; no-fabrication sessionId pins).
- OpenAI turn: auth fast-fail → SDK run (stream + non-stream) → quiet-resolve deadline guard → `lastResponseId` chaining.
- Manager: top-level + nested-delegate construction through the module table (primary vs nested arg parity, G4 historyStore omission, budget/lock/abort semantics unchanged; "does not execute tools" containment is pinned at the table level by `provider-modules.test.ts`'s registry-miss assertion — no existing manager test asserts the string, the branch being type-unreachable today).

### Regression Surface

- The 8 existing suites (501 tests): codex 50 / gemini 41 / openai 31 / manager 223 / breaker 29 / error-classification 59 / turn-assembly 23 / tool-bridge 45 — **zero expectation edits** (import paths at most).
- `docs/providers.md`: zero diff.
- Error-string contract (§7.1): `FAULT_PATTERNS` rows, `isStaleServerHandleError` alternates, gemini `STALE_HANDLE_SENTINEL`, the two verbatim auth messages, `error_max_turns`, `TURN_DEADLINE_SUBTYPE` — none change by a character.
- Untouched modules (empty diff verified in Task 9): `tool-bridge.ts`, `turn-assembly.ts`, `tool-transport.ts`, `error-classification.ts`, `builtin-executor.ts`, `archetype-gate.ts`, `oauth-credentials.ts`, `turn-history-store.ts`, `passthrough-providers.ts`, `claude-agent-adapter.ts`, `types.ts`.

### Commands

- Unit / Integration / Broader regression (one gate): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Targeted (fast inner loop): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/ src/agents/agent-manager.test.ts src/agents/provider-circuit-breaker.test.ts`
- Per-file count verification (Task 0 and Task 11): `... npx vitest run <file>` and read the `Tests  N passed` line — **vitest runtime output, never grep** (`it.each` expansion).
- E2E: not-applicable (optional operator smoke post-merge, outside this plan).

### Harness Requirements

- Env stubs for any `npm run check` / vitest invocation: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test` (all three; `SLACK_BOT_TOKEN` is the one that actually trips).
- No new services, fixtures, or accounts. New unit tests reuse the adapter suites' fixture patterns (replicate, don't cross-import): minimal `ProviderTurnAssembly` literals, allow-all gates, `tmpdir()` sessionCwd, real short timers for deadline tests (the #407 pattern).

### Non-Required Rationale

- E2E: CI holds no Lane B credentials by design (DOD-212 / no-ANTHROPIC_API_KEY posture); spec §8 makes the live smoke optional and operator-run.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test. **In this ticket that rule is absolute: an existing-test expectation edit is definitionally a behavior change — stop and re-derive the extraction.**
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/agents/provider-adapters/sse.ts` | create | Generic SSE framing: event splitting, field parsing, `[DONE]` sentinel (§4.3 last ¶ — grok's gateway speaks this framing) |
| `src/agents/provider-adapters/sse.test.ts` | create | Framing parity pins |
| `src/agents/provider-adapters/turn-scaffold.ts` | create | `LaneBTurnScaffold` + `LaneBTurnHarness` + `LaneBTurnOutcome` (§4.1) |
| `src/agents/provider-adapters/turn-scaffold.test.ts` | create | Scaffold pins (spec §8 list) |
| `src/agents/provider-adapters/dispatch-loop.ts` | create | `runBoundedDispatchLoop` + driver types (§4.2) |
| `src/agents/provider-adapters/dispatch-loop.test.ts` | create | Loop pins (spec §8 list) |
| `src/agents/provider-adapters/provider-module.ts` | create | Self-contained module contract (§4.3): `LaneBProviderModule`, `LaneBAdapterConstructionArgs`, `ProviderModuleRoute`, `LaneBModuleDeps` |
| `src/agents/provider-adapters/provider-modules.ts` | create | Three module implementations + `LANE_B_PROVIDER_MODULES` |
| `src/agents/provider-adapters/provider-modules.test.ts` | create | Construction parity pins (spec §8 registry list) |
| `src/agents/provider-adapters/classification-crosscheck.test.ts` | create | §8 cross-check: adapter error strings → same `ProviderFaultKind` |
| `src/agents/provider-adapters/codex-subscription-adapter.ts` | modify | Subclass: `executeTurn` + loop driver + hooks; SSE framing delegated to `sse.ts`; all clones deleted |
| `src/agents/provider-adapters/gemini-interactions-adapter.ts` | modify | Subclass: `executeTurn` + loop driver + hooks; clones deleted |
| `src/agents/provider-adapters/openai-agents-adapter.ts` | modify | Subclass: scaffold-only `executeTurn`; clones deleted |
| `src/agents/agent-manager.ts` | modify | Both construction sites → module-table lookups sharing one `deps` object |

---

### Task 0: Baseline pin

**Files:** none (verification only).

- [ ] **Step 1:** Confirm clean tree at the expected base.

Run: `git -C /Users/mokie/github/hive-KPR-385 status --porcelain && git -C /Users/mokie/github/hive-KPR-385 log --oneline -1`
Expected: empty status; head commit on branch KPR-385.

- [ ] **Step 2:** Record per-file baseline counts (runtime output, not grep):

Run (repeat per file):
```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
  src/agents/provider-adapters/codex-subscription-adapter.test.ts
```
Expected `Tests N passed` lines: codex **50**, gemini **41**, openai **31**, `src/agents/agent-manager.test.ts` **223**, `src/agents/provider-circuit-breaker.test.ts` **29**, error-classification **59**, turn-assembly **23**, tool-bridge **45**. (Verified on this worktree 2026-08-25; if any count differs, STOP — the base moved and the plan must be re-anchored.)

- [ ] **Step 3:** Verify `docs/providers.md` exists and note its blob hash for the Task 9 zero-diff check: `git hash-object docs/providers.md`.

No commit.

---

### Task 1: Shared SSE framing util (`sse.ts`)

**Files:**
- Create: `src/agents/provider-adapters/sse.ts`
- Create: `src/agents/provider-adapters/sse.test.ts`

The framing logic is lifted **verbatim** from `codex-subscription-adapter.ts` (`parseSseEvent` at 574–591, the blank-line splitter inside `consumeBufferedSseEvents` at 562–563, the `[DONE]` check at 594). Codex-specific event *application* (`applyCodexEvent`, usage/output-item capture) stays in the codex file (Task 5).

- [ ] **Step 1:** Write `src/agents/provider-adapters/sse.ts`:

```typescript
/**
 * KPR-391 (§4.3): generic SSE FRAMING — event-boundary splitting, field
 * parsing, and the Responses-style `[DONE]` sentinel — extracted from the
 * codex adapter because KPR-392's gateway-fronted grok speaks the same
 * framing. Provider-specific event APPLICATION (what a `response.*` /
 * `interaction.*` payload means) stays in each adapter.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Split a buffered, byte-decoded SSE string on blank-line event boundaries.
 * The trailing partial event (no terminating blank line yet) is returned as
 * `remainder` for the caller to re-buffer.
 */
export function splitSseEvents(buffer: string): { events: string[]; remainder: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  return { events: parts, remainder };
}

/** Parse one raw SSE event block into {event?, data}. Comment lines (`:`) and
 *  empty lines are skipped; multiple data: lines join with `\n`. Returns null
 *  when the block carries no data lines. */
export function parseSseEvent(raw: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/** The OpenAI-format stream-terminator sentinel frame. */
export function isSseDone(event: SseEvent): boolean {
  return event.data === "[DONE]";
}
```

- [ ] **Step 2:** Write `src/agents/provider-adapters/sse.test.ts` — minimum assertions:
  - `splitSseEvents`: splits on `\n\n` and `\r\n\r\n`; trailing partial block returned as remainder; empty buffer ⇒ `{events: [], remainder: ""}`.
  - `parseSseEvent`: parses `event:` + single `data:`; joins multiple `data:` lines with `\n`; trims event name and leading data whitespace (`data: x` and `data:x` equal); skips `: comment` lines; returns `null` for a block with no data lines (pure-comment block, bare `event:` block).
  - `isSseDone`: true for `{data: "[DONE]"}`, false otherwise (including `"[done]"` — case-sensitive, matching today's check).

- [ ] **Step 3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: all green; new sse tests pass; existing counts unchanged.

- [ ] **Step 4:** Commit

```bash
git add src/agents/provider-adapters/sse.ts src/agents/provider-adapters/sse.test.ts
git commit -m "feat: shared SSE framing util for Lane B adapters (KPR-391 §4.3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `LaneBTurnScaffold` (`turn-scaffold.ts`)

**Files:**
- Create: `src/agents/provider-adapters/turn-scaffold.ts`
- Create: `src/agents/provider-adapters/turn-scaffold.test.ts`

This is the §4.1 extraction, deadline machinery included from birth (§5 step 1). Every branch below is a verbatim consolidation of the three adapters' frames (codex 106–460, gemini 132–578, openai 30–350) with the spec-mandated hooks at the divergence points.

- [ ] **Step 1:** Write `src/agents/provider-adapters/turn-scaffold.ts`:

```typescript
/**
 * KPR-391 (§4.1): LaneBTurnScaffold — the shared per-turn lifecycle every
 * Lane B native adapter sits on. Owns everything an adapter does that is NOT
 * provider API shape: abort lifecycle, the wall-clock deadline (#407 — armed
 * inside the try, cleared in the finally, operator-abort-outranks-deadline
 * resolution), ToolBridge construct/close, the try/catch/finally containment
 * frame, the scaffold-owned turn accumulator (one-writer: provider round code
 * reports usage via harness.addUsage, nothing else mutates it), and RunResult
 * building (llmMs = max(0, durationMs − toolMs) — KPR-348 §D8 breaker rule).
 *
 * Provider subclasses implement executeTurn(harness) — auth resolution,
 * bridge.connect(), dispatch — and return a LaneBTurnOutcome. Nothing they
 * throw escapes runTurn. Divergence points are explicit hooks, never
 * unification targets (§7 three-way sessionId pin):
 *   - fallbackSessionId(): default `request.sessionId ?? ""` (gemini/openai
 *     no-fabrication pins); codex fabricates `codex-pilot-${uuid}`.
 *   - interruptionSessionId(): aborted/error_max_turns policy — default bare
 *     fallback; codex overrides to `lastProviderRoundId ?? fallback`.
 *     Deadline and catch-error paths always use the bare fallback (uniform
 *     across all three adapters today).
 *   - warnDeadlineExpired(): per-adapter so log module + message stay
 *     byte-identical.
 *   - errorText(): default codex/gemini shape; openai overrides
 *     (coerceFinalOutput — preserves its thrown-null edge).
 */
import type { RunResult } from "../agent-runner.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest, LaneBProviderId } from "./types.js";
import { ToolBridge } from "./tool-bridge.js";
import { TURN_DEADLINE_SUBTYPE } from "./error-classification.js";

/** Scaffold-owned turn accumulator (§4.1). */
export interface LaneBTurnTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface LaneBUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/**
 * What executeTurn (or the dispatch loop inside it) hands back.
 * error_max_turns and friends are OUTCOME errors, not throws — accumulated
 * totals and bridge stats survive into the result (§4.1).
 */
export type LaneBTurnOutcome =
  | { kind: "success"; text: string; sessionId: string }
  | { kind: "error"; error: string; sessionId: string }
  /** Resolved by the scaffold's #407 interruption resolver:
   *  deadlineFired && !aborted ⇒ deadline result, else aborted result. */
  | { kind: "interrupted" };

/** Session-policy hook input. */
export interface LaneBSessionPolicyState {
  fallbackSessionId: string;
  lastProviderRoundId: string | undefined;
}

export interface LaneBTurnHarness {
  request: AgentProviderTurnRequest;
  bridge: ToolBridge;
  signal: AbortSignal;
  streamed: boolean;
  fallbackSessionId: string;
  /** aborted || signal.aborted — subsumes #407's deadline-aware
   *  stream-consumer callbacks. */
  isAborted(): boolean;
  deadlineFired(): boolean;
  totals: Readonly<LaneBTurnTotals>;
  /** One-writer fold point (§4.1): provider round code reports usage here. */
  addUsage(delta: LaneBUsageDelta): void;
  setLastProviderRoundId(id: string): void;
  lastProviderRoundId(): string | undefined;
  /** Interruption/max-turns session policy (per-provider hook output). */
  interruptionSessionId(): string;
}

export abstract class LaneBTurnScaffold implements AgentProviderAdapter {
  abstract readonly provider: LaneBProviderId;

  protected currentAbortController: AbortController | null = null;
  protected aborted = false;

  protected constructor(
    private readonly scaffoldInit: { name: string; assembly: ProviderTurnAssembly },
  ) {}

  abort(): void {
    this.aborted = true;
    this.currentAbortController?.abort();
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  /** Provider API surface. Runs inside the containment frame: return an
   *  outcome or throw — a throw becomes the catch-error result (or an
   *  interruption when isAbortError matches). */
  protected abstract executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome>;

  /** #407 deadline warn — per-adapter (message + logger module preserved). */
  protected abstract warnDeadlineExpired(timeoutMs: number): void;

  /** Fallback-session policy hook (§4.1). */
  protected fallbackSessionId(request: AgentProviderTurnRequest): string {
    return request.sessionId ?? "";
  }

  /** Aborted / error_max_turns session policy (§7 last bullet). */
  protected interruptionSessionId(state: LaneBSessionPolicyState): string {
    return state.fallbackSessionId;
  }

  /** Catch-error stringification. Default = the codex/gemini errorMessage
   *  shape; openai overrides. */
  protected errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }

  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    const fallbackSessionId = this.fallbackSessionId(request);

    // Wall-clock turn deadline (#407, scaffold-owned): armed inside the try
    // (throw-safety pin), cleared in the finally (no-late-warn pin).
    // undefined ⇒ no deadline (bare/test constructions — prepareSpawn always
    // supplies one on Lane B); 0 fires immediately but may still dispatch one
    // round before aborting (timer = macrotask — distinct from maxTurns 0's
    // zero-call short-circuit).
    const timeoutMs = request.resourceLimits?.timeoutMs;
    let deadlineFired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    // Per-spawn tool bridge — the pre-extraction 11-line identical block,
    // including the KPR-354 delegateRunner line. connect() is provider code
    // (inside executeTurn); close() in the finally, always, including
    // pre-request throw paths (gemini T10 pin).
    const bridge = new ToolBridge({
      inventory: this.scaffoldInit.assembly.toolInventory,
      inProcessServers: this.scaffoldInit.assembly.inProcessServers,
      gate: this.scaffoldInit.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.scaffoldInit.name,
      sessionCwd: this.scaffoldInit.assembly.sessionCwd,
      skillIndex: this.scaffoldInit.assembly.skillIndex,
      delegateRunner: this.scaffoldInit.assembly.delegateTurnRunner, // KPR-354
    });

    const totals: LaneBTurnTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let lastProviderRoundId: string | undefined;

    const policyState = (): LaneBSessionPolicyState => ({ fallbackSessionId, lastProviderRoundId });

    const finish = (fields: {
      text: string;
      sessionId: string;
      aborted: boolean;
      timedOut?: boolean;
      error?: string;
    }): RunResult =>
      this.buildResult({
        ...fields,
        durationMs: Date.now() - startedAt,
        streamed,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });

    const abortedResult = (): RunResult =>
      finish({ text: "", sessionId: this.interruptionSessionId(policyState()), aborted: true });

    /** Deadline expiry is a turn-shape ERROR, not an abort (#407): `aborted`
     *  stays false so classifyTurnResult's `timedOut && aborted` hang rule
     *  can never match, and TURN_DEADLINE_SUBTYPE classifies as the
     *  breaker-INCONCLUSIVE turn-deadline kind. sessionId mirrors each
     *  adapter's catch-error shape — bare fallback, never a mid-turn mint. */
    const deadlineResult = (): RunResult =>
      finish({
        text: "",
        sessionId: fallbackSessionId,
        aborted: false,
        timedOut: true,
        error: TURN_DEADLINE_SUBTYPE,
      });

    /** #407 interruption resolver — single resolution point for every abort
     *  checkpoint: an operator abort() outranks a deadline that also fired
     *  (breaker-neutral silence, not an error surface). */
    const interruptedResult = (): RunResult =>
      deadlineFired && !this.aborted ? deadlineResult() : abortedResult();

    const harness: LaneBTurnHarness = {
      request,
      bridge,
      signal: abortController.signal,
      streamed,
      fallbackSessionId,
      isAborted: () => this.aborted || abortController.signal.aborted,
      deadlineFired: () => deadlineFired,
      totals,
      addUsage: (delta) => {
        totals.inputTokens += delta.inputTokens ?? 0;
        totals.outputTokens += delta.outputTokens ?? 0;
        totals.cacheReadTokens += delta.cacheReadTokens ?? 0;
      },
      setLastProviderRoundId: (id) => {
        lastProviderRoundId = id;
      },
      lastProviderRoundId: () => lastProviderRoundId,
      interruptionSessionId: () => this.interruptionSessionId(policyState()),
    };

    try {
      if (timeoutMs !== undefined) {
        deadline = setTimeout(() => {
          deadlineFired = true;
          this.warnDeadlineExpired(timeoutMs);
          abortController.abort();
        }, timeoutMs);
      }

      const outcome = await this.executeTurn(harness);
      if (outcome.kind === "interrupted") return interruptedResult();
      if (outcome.kind === "error") {
        return finish({ text: "", sessionId: outcome.sessionId, aborted: false, error: outcome.error });
      }
      return finish({ text: outcome.text, sessionId: outcome.sessionId, aborted: false });
    } catch (error) {
      // A deadline abort usually surfaces here as the aborted fetch/SDK/
      // stream throw — interruptedResult resolves it to the deadline error,
      // not an operator abort.
      if (this.isAbortError(error, abortController)) return interruptedResult();
      return finish({ text: "", sessionId: fallbackSessionId, aborted: false, error: this.errorText(error) });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      await bridge.close(); // never throws/rejects (KPR-348 advisory 1)
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  private isAbortError(error: unknown, abortController: AbortController): boolean {
    if (this.aborted || abortController.signal.aborted) return true;
    if (!error || typeof error !== "object") return false;
    const maybeAbort = error as { name?: unknown; code?: unknown };
    return maybeAbort.name === "AbortError" || maybeAbort.code === "ABORT_ERR";
  }

  private buildResult({
    text,
    sessionId,
    durationMs,
    streamed,
    aborted,
    timedOut,
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
    timedOut?: boolean;
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
      // KPR-348 §D8 rule: the breaker's p95 window samples llmMs — folding
      // tool time in would let slow-but-healthy tools trip a healthy
      // provider. Clamped: degenerate/mocked timing can't go negative.
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
      ...(timedOut ? { timedOut: true } : {}),
      ...(error ? { error } : {}),
    };
  }
}
```

- [ ] **Step 2:** Write `src/agents/provider-adapters/turn-scaffold.test.ts`. Fixture: a test-local `TestScaffoldAdapter extends LaneBTurnScaffold` with `readonly provider = "codex" as const`, an injectable `executeTurn` impl, a `warnings: number[]` recorder for `warnDeadlineExpired`, plus a second subclass overriding `fallbackSessionId`/`interruptionSessionId` codex-style. `makeAssembly()` mirrors the adapter suites' minimal literal (empty `toolInventory`/`omittedTools`/`skillIndex`, allow-all `guardrailGate`, `{}` `inProcessServers`, `memory: {}`, `sessionCwd: tmpdir()`). Bridge lifecycle observed via `vi.spyOn(ToolBridge.prototype, "close")`. Minimum assertions (each is a spec §8 scaffold bullet):
  - **Bridge closed on every path:** success outcome; `error` outcome; executeTurn throws; abort mid-executeTurn; **pre-request throw** (executeTurn throws synchronously before touching the bridge) — `close` called exactly once each time.
  - **Abort containment:** `abort()` during a hanging executeTurn (impl awaits a never-resolving promise racing `harness.signal`) → `{aborted: true, error: undefined}`, `wasAborted === true`; re-entry (second `runTurn`) resets `aborted` to false.
  - **Outcome mapping:** `{kind:"error", error:"error_max_turns", sessionId:"s"}` → RunResult `{error: "error_max_turns", sessionId: "s", aborted: false}` carrying totals accumulated via `addUsage` before the outcome.
  - **`buildResult` math:** `llmMs === max(0, durationMs − toolMs)` clamp (never negative with mocked stats); `toolSummary` `"name×count"` join and `"none"` when empty; `costUsd: 0`; zero-filled Claude-only fields (`cacheCreationTokens`, `contextWindow`, `compactions`).
  - **Fallback-session hook:** default subclass → `request.sessionId ?? ""` on catch-error; codex-style subclass → fabricated non-empty fallback, and interruption result uses `lastProviderRoundId ?? fallback` after `setLastProviderRoundId("r-1")`.
  - **Deadline machinery (#407):** (a) arm-inside-try throw-safety — executeTurn throws synchronously with `timeoutMs` set → no timer leak (result returns, `vi.getTimerCount()`-style check or no late warn after waiting past timeoutMs); (b) `clearTimeout` on every exit path — success/error/abort each followed by a wait past `timeoutMs` records zero `warnings`; (c) `timeoutMs: 0` fires (macrotask) → hanging executeTurn resolves to `error_turn_deadline` with `timedOut: true`, `aborted: false`, `warnings` recorded once; (d) `timeoutMs: undefined` arms no deadline — hanging-then-resolving executeTurn completes normally; (e) operator-abort-outranks-deadline — `abort()` first, deadline also fires while hanging → `{aborted: true}`, NO `error` field; (f) `error_turn_deadline` result shape: `error === TURN_DEADLINE_SUBTYPE`, `timedOut: true`, `aborted: false`, sessionId = bare fallback even when `lastProviderRoundId` is set.
  - **One-writer totals:** two `addUsage` calls fold into the final result's token fields; `harness.totals` reflects them read-only.

- [ ] **Step 3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green; no existing-file diffs.

- [ ] **Step 4:** Commit

```bash
git add src/agents/provider-adapters/turn-scaffold.ts src/agents/provider-adapters/turn-scaffold.test.ts
git commit -m "feat: LaneBTurnScaffold — shared Lane B turn lifecycle incl. #407 deadline (KPR-391 §4.1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `runBoundedDispatchLoop` (`dispatch-loop.ts`)

**Files:**
- Create: `src/agents/provider-adapters/dispatch-loop.ts`
- Create: `src/agents/provider-adapters/dispatch-loop.test.ts`

- [ ] **Step 1:** Write `src/agents/provider-adapters/dispatch-loop.ts`:

```typescript
/**
 * KPR-391 (§4.2): runBoundedDispatchLoop — the shared bounded tool-dispatch
 * loop for raw-API Lane B adapters (codex + gemini today; grok's gateway
 * next). Owns: the round budget (`resourceLimits?.maxTurns ?? 10`, with 0
 * passing through ⇒ immediate error_max_turns and NO network call — the
 * codex/gemini-identical divergence pin; openai keeps handing 0 to its SDK),
 * the four abort checkpoints at their pre-extraction placements (pre-round /
 * post-stream-consume / pre-each-tool / post-loop — each resolving through
 * the scaffold's #407 interruption resolver via the harness, which is where a
 * deadline that expired inside a non-cancellable tool call is caught),
 * totals accumulation (the one-writer fold into the scaffold accumulator),
 * final-reply semantics (every round streams to onStream; text is the final
 * round's only), SEQUENTIAL tool execution (KPR-353 pin, carried verbatim),
 * optional call-id dedup, and the restart affordance (codex §D7
 * poisoned-replay heal — once-only guard lives in the provider hook).
 *
 * NOT in the loop: wire protocol, payload shapes, session chaining values,
 * error decoration — those live in the provider round driver.
 */
import type { AgentProviderTurnRequest } from "./types.js";
import type { LaneBTurnHarness, LaneBTurnOutcome, LaneBUsageDelta } from "./turn-scaffold.js";

/** Mirrors the openai SDK default both raw-API adapters pinned (§D2/§D1). */
export const DEFAULT_MAX_ROUNDS = 10;

export interface DispatchRoundResult<TRound> {
  state: TRound;
  usage: LaneBUsageDelta;
  providerRoundId?: string;
  /** This round's assistant text — the loop applies final-reply semantics. */
  text: string;
}

export type DispatchLoopErrorDecision =
  | { action: "restart-fresh" }
  | { action: "rethrow"; error: unknown };

export interface BoundedDispatchLoopDriver<TRound, TCall> {
  request: AgentProviderTurnRequest;
  harness: LaneBTurnHarness;
  /** One provider round: POST/create + stream consume + (provider-owned)
   *  next-input bookkeeping. Throws route through onRequestError (when
   *  present) and then out to the scaffold containment frame. */
  executeRound(round: number): Promise<DispatchRoundResult<TRound>>;
  /** Function-call harvest. Empty ⇒ the loop breaks with success. */
  harvest(state: TRound): TCall[];
  /** Optional call-id dedup (codex's seenCallIds guard; gemini's harvest
   *  dedups internally and omits this). */
  callId?(call: TCall): string;
  /** Runs after a non-empty harvest, before any execution — may throw
   *  (gemini's missing-interaction-id guard). */
  beforeExecuteCalls?(state: TRound, calls: TCall[]): void;
  /** Executes ONE call and appends the provider-shaped output to the next
   *  round's input. Sequential by design. */
  executeCall(call: TCall): Promise<void>;
  /** Runs after all calls executed — chain-state shaping (gemini's
   *  chainHead/input handoff). */
  afterCalls?(state: TRound, calls: TCall[]): void;
  /** Restart affordance (codex §D7): "restart-fresh" resets the round
   *  counter to 0 (the healed turn gets its full budget) after the hook has
   *  cleared provider state; "rethrow" substitutes a decorated error;
   *  undefined ⇒ the loop rethrows the original. */
  onRequestError?(error: unknown, round: number): Promise<DispatchLoopErrorDecision | undefined>;
}

export async function runBoundedDispatchLoop<TRound, TCall>(
  driver: BoundedDispatchLoopDriver<TRound, TCall>,
): Promise<LaneBTurnOutcome> {
  const { harness } = driver;
  // `??` passes 0 through ⇒ immediate error_max_turns without a network call.
  const maxRounds = driver.request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS;
  let finalText = "";
  let round = 0;
  for (;;) {
    round += 1;
    if (round > maxRounds) {
      // §D2: the SDK sentinel string, already pinned non-provider
      // (error-classification.ts). Accumulated totals survive (outcome error).
      return { kind: "error", error: "error_max_turns", sessionId: harness.interruptionSessionId() };
    }
    if (harness.isAborted()) return { kind: "interrupted" }; // pre-round checkpoint

    let result: DispatchRoundResult<TRound>;
    try {
      result = await driver.executeRound(round);
    } catch (error) {
      const decision = driver.onRequestError ? await driver.onRequestError(error, round) : undefined;
      if (decision?.action === "restart-fresh") {
        round = 0; // healed turn gets its full round budget
        continue;
      }
      if (decision?.action === "rethrow") throw decision.error;
      throw error;
    }

    harness.addUsage(result.usage); // one-writer fold (§4.1)
    if (result.providerRoundId) harness.setLastProviderRoundId(result.providerRoundId);
    finalText = result.text; // final-reply semantics

    if (harness.isAborted()) return { kind: "interrupted" }; // post-stream checkpoint

    let calls = driver.harvest(result.state);
    if (driver.callId) {
      const seen = new Set<string>();
      calls = calls.filter((call) => {
        const id = driver.callId!(call);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    if (calls.length === 0) break;
    driver.beforeExecuteCalls?.(result.state, calls);

    for (const call of calls) {
      if (harness.isAborted()) return { kind: "interrupted" }; // pre-tool checkpoint
      await driver.executeCall(call);
    }
    driver.afterCalls?.(result.state, calls);
  }

  if (harness.isAborted()) return { kind: "interrupted" }; // post-loop checkpoint
  return {
    kind: "success",
    text: finalText,
    // Both raw-API adapters' success formula: last provider round id, else
    // the per-provider fallback (codex fabricated / gemini "").
    sessionId: harness.lastProviderRoundId() ?? harness.fallbackSessionId,
  };
}
```

- [ ] **Step 2:** Write `src/agents/provider-adapters/dispatch-loop.test.ts`. Fixture: a hand-rolled `LaneBTurnHarness` literal (mutable `abortedFlag`, recording `addUsage` into a totals object, `lastProviderRoundId` closure, `interruptionSessionId: () => "int-sid"`, `fallbackSessionId: "fb"`), plus a scripted driver factory. Minimum assertions (each a spec §8 loop bullet):
  - **Round budget:** `maxTurns: 2` with rounds that always harvest one call → `{kind:"error", error:"error_max_turns", sessionId:"int-sid"}` after exactly 2 `executeRound` calls; `maxTurns: 0` → `error_max_turns` with **zero** `executeRound` calls (no network); `maxTurns: undefined` → default 10.
  - **Totals accumulation:** two rounds' usage folded via `addUsage` (assert the harness totals object) and still present conceptually on the `error_max_turns` path (outcome, not throw).
  - **Abort at each checkpoint:** four cases flipping `abortedFlag` (before round 1; inside `executeRound` just before returning — caught post-stream; inside `executeCall` of call 1 of 2 — caught pre-tool, second `executeCall` never runs; after the final harvest-empty round — caught post-loop) each → `{kind:"interrupted"}`.
  - **Sequential execution order:** 3 harvested calls execute in order with no interleaving (record start/end pairs; each `executeCall` awaits a microtask).
  - **Dedup hook:** duplicate `callId` values execute once; a driver without `callId` executes duplicates (gemini-style — harvest owns dedup).
  - **Restart affordance:** `executeRound` throws on round 1; `onRequestError` returns `restart-fresh` once then `undefined` → round counter reset (round-1 numbering re-observed by `executeRound`), budget refreshed (a `maxTurns: 2` turn still gets 2 post-heal rounds), and a second thrown round propagates the original error; `{action:"rethrow", error: decorated}` propagates the decorated error, not the original.
  - **Final-text semantics:** two rounds with texts "draft"/"final" → success text `"final"`; success sessionId = `lastProviderRoundId ?? fallbackSessionId` (both branches: with and without a provider round id).
  - **beforeExecuteCalls throw** propagates out (uncaught by the loop).

- [ ] **Step 3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green.

- [ ] **Step 4:** Commit

```bash
git add src/agents/provider-adapters/dispatch-loop.ts src/agents/provider-adapters/dispatch-loop.test.ts
git commit -m "feat: runBoundedDispatchLoop — shared Lane B tool-dispatch loop (KPR-391 §4.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Provider-module contract (`provider-module.ts`)

**Files:**
- Create: `src/agents/provider-adapters/provider-module.ts`

Types only (spec §5 step 1 "module types"); implementations and their tests land in Task 8. Compile-green is the gate here.

- [ ] **Step 1:** Write `src/agents/provider-adapters/provider-module.ts`:

```typescript
/**
 * KPR-391 (§4.3): the Lane B provider-module contract — the construction
 * seam between the engine (agent-manager's two adapter-construction sites)
 * and a provider's adapter. DELIBERATELY SELF-CONTAINED: this interface is
 * the embryonic provider-plugin ABI (KPR-394 makes modules loadable through
 * it, gated on this contract surviving four in-tree consumers before
 * freezing), so it references only public adapter-surface types — no
 * AgentManager, registry, or dispatcher types — and `deps` is an explicit,
 * minimal, named-handle capability surface, never an
 * import-your-way-into-the-engine. The contract's transitive type closure
 * (RunResult, WorkItemContext, StreamCallback, ResourceLimits — reachable
 * via AgentProviderAdapter / ProviderTurnAssembly) stays type-only-imported
 * for now; re-homing or re-exporting those declarations is deferred to
 * KPR-394's ABI freeze (noted in the spec so it doesn't surprise).
 */
import type { AgentProviderAdapter, LaneBProviderId, ReasoningEffort } from "./types.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { TurnHistoryStore } from "../turn-history-store.js";

/**
 * Contract-owned route shape. The provider discriminant is deliberately
 * dropped — a module already knows its own provider. agent-manager's
 * ProviderModelRoute union stays module-private there; call sites project
 * `{ model, reasoningEffort }` into this shape.
 */
export interface ProviderModuleRoute {
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** Named engine handles a module may consume. */
export interface LaneBModuleDeps {
  /** Resolved per-provider config slices (appConfig.<provider>.agentModel /
   *  .apiKey) keyed by provider id — a module reads its own key only. */
  providerConfig: Partial<Record<LaneBProviderId, { agentModel?: string; apiKey?: string }>>;
  /** KPR-353 stateless-replay history store — consumed only by modules whose
   *  session strategy persists replay history, and only in primary context:
   *  the KPR-354 G4 guarantee (nested turns provably never touch
   *  provider_turn_history) is a MODULE RULE here, not a call-site omission. */
  turnHistoryStore?: TurnHistoryStore;
  /** Agent-definition id (the history-store key). The display name travels
   *  on LaneBAdapterConstructionArgs.name. */
  agentId?: string;
}

export interface LaneBAdapterConstructionArgs {
  /** Display name (primary: config.name; nested: `${config.name}:${delegate}`). */
  name: string;
  route: ProviderModuleRoute;
  assembly: ProviderTurnAssembly;
  /** primary = top-level spawn; nested = KPR-354 delegate turn. */
  context: "primary" | "nested";
  deps: LaneBModuleDeps;
}

export interface LaneBProviderModule {
  provider: LaneBProviderId;
  createAdapter(args: LaneBAdapterConstructionArgs): AgentProviderAdapter;
}
```

- [ ] **Step 2:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green (types-only module; lint requires it be referenced — if `noUnusedLocals`-style lint flags the orphan file, this is a plain new module with exports only, which ESLint does not flag; if `npm run check` objects for any other reason, fold this file into Task 8's commit instead — do NOT weaken lint config).

- [ ] **Step 3:** Commit

```bash
git add src/agents/provider-adapters/provider-module.ts
git commit -m "feat: LaneBProviderModule contract — self-contained construction seam (KPR-391 §4.3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Migrate codex onto scaffold + loop + SSE util

> **Accepted timing-measurement delta (note for the PR body):** current codex snapshots `durationMs` *before* the post-loop history-persist await; the scaffold's `finish()` computes it after `executeTurn` returns, so a codex success turn's `durationMs`/`llmMs` now folds in history-persist time. Not observable by any existing test (mocked stores resolve synchronously), ~ms-scale in production p95 sampling — acknowledged rather than special-cased.

**Files:**
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.ts` (currently 741 lines)
- Test: `src/agents/provider-adapters/codex-subscription-adapter.test.ts` — **read-only** (import paths at most; expectations untouched)

Richest surface first (spec §5 step 2): history, heal, SSE. Exported test surfaces keep names and home: `CodexSubscriptionAdapter`, `consumeCodexSse`, `consumeBufferedSseEvents`, `CodexSubscriptionAdapterOptions`, `CodexReasoningEffort`.

- [ ] **Step 1:** Rework imports and module scope. Remove the now-scaffold-owned imports/decls and add the new layers:
  - Add: `import { LaneBTurnScaffold, type LaneBTurnHarness, type LaneBTurnOutcome, type LaneBSessionPolicyState } from "./turn-scaffold.js";`, `import { runBoundedDispatchLoop } from "./dispatch-loop.js";`, `import { parseSseEvent, splitSseEvents, isSseDone, type SseEvent } from "./sse.js";`
  - Remove: `import { ToolBridge, ... }` → keep only `type BridgedTool` (`import type { BridgedTool } from "./tool-bridge.js";`); remove `TURN_DEADLINE_SUBTYPE` import (scaffold owns it); keep `randomUUID`, `createCodexOpenAITokenProvider`, logger, `TurnHistoryStore` type.
  - Delete the local `interface SseEvent` (101–104) and the local `parseSseEvent` (574–591). Delete `const DEFAULT_MAX_ROUNDS = 10;` (loop owns it). Delete the module-level `errorMessage` helper (733–741) — the scaffold default is its verbatim twin and nothing else in this file uses it after migration. Keep `parseJson`/`objectField`/`stringField`/`responseErrorMessage`/`itemId`/`pushOutputItem`/`applyInterimResponsePayload`/`applyCompletedResponsePayload`/`applyCodexEvent`/`executeFunctionCall`/`isFunctionCallItem` verbatim.
  - Add a module-private HTTP-error carrier for the loop's error hook:

```typescript
/** Carries a non-ok Response from executeRound to the loop's onRequestError
 *  hook (the §D7 heal decision needs the status; the decorated message is
 *  built lazily — responseErrorMessage awaits the body). */
class CodexResponseHttpError extends Error {
  constructor(readonly response: Response) {
    super(`Codex subscription request failed (${response.status})`);
  }
}
```

- [ ] **Step 2:** Rewrite the class as a scaffold subclass. Delete: `currentAbortController`/`aborted` fields, the entire `runTurn` body (114–440), `abort()`, `wasAborted`, `isAbortError`, `buildResult` (all scaffold-owned). The new class body, complete:

```typescript
export class CodexSubscriptionAdapter extends LaneBTurnScaffold {
  readonly provider = "codex" as const;

  constructor(private readonly options: CodexSubscriptionAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  /** Pilot-era fabricated fallback (persisted-id behavior pin — the
   *  stateless-replay surface never persists it as a handle). */
  protected override fallbackSessionId(request: AgentProviderTurnRequest): string {
    return request.sessionId ?? `codex-pilot-${randomUUID()}`;
  }

  /** Codex aborted / error_max_turns results carry the last response id when
   *  one exists (§7 three-way pin); deadline/catch-error stay bare fallback
   *  via the scaffold. */
  protected override interruptionSessionId(state: LaneBSessionPolicyState): string {
    return state.lastProviderRoundId ?? state.fallbackSessionId;
  }

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("Codex turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // §D3 thread key: absent context ⇒ replay and persist both skip.
    const threadId = request.workItemContext?.threadId || undefined;
    const historyKey =
      this.options.historyStore && this.options.agentId && threadId
        ? { store: this.options.historyStore, agentId: this.options.agentId, threadId }
        : undefined;

    // §D3: load NEVER throws and NEVER returns Mongo error text (breaker
    // safety). Deliberately BEFORE the auth check: degradation ordering is
    // deterministic (T4-pinned) — the scaffold does not sequence this.
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
    // §D1: BridgedTool[] → Responses function tools. Name/cap edges are
    // bridge-owned (KPR-348/349).
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
    let replayedNonEmpty = replayed.length > 0;
    let selfHealed = false;

    const outcome = await runBoundedDispatchLoop<CodexStreamState, FunctionCallItem>({
      request,
      harness,
      executeRound: async () => {
        const response = await this.fetchImpl()(this.options.endpoint ?? DEFAULT_CODEX_RESPONSES_URL, {
          method: "POST",
          signal: harness.signal,
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
            // §D2/§D3: encrypted reasoning must round-trip for replay quality.
            include: ["reasoning.encrypted_content"],
            tools: toolPayloads,
          }),
        });
        if (!response.ok) throw new CodexResponseHttpError(response);

        // Deadline-aware consume: harness.isAborted subsumes the #407
        // signal-abort leg.
        const state = await consumeCodexSse(response.body, request.onStream, harness.isAborted);
        inputItems.push(...state.outputItems);
        thisTurnItems.push(...state.outputItems);
        return {
          state,
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
          },
          providerRoundId: state.responseId,
          text: state.text,
        };
      },
      harvest: (state) => state.outputItems.filter(isFunctionCallItem),
      // Dedupe by call_id: closes the degenerate double-`response.completed`
      // case that would otherwise double-execute the tool.
      callId: (call) => call.call_id,
      executeCall: async (call) => {
        const output = await executeFunctionCall(call, bridgedByName);
        const outputItem = { type: "function_call_output", call_id: call.call_id, output };
        inputItems.push(outputItem);
        thisTurnItems.push(outputItem);
      },
      onRequestError: async (error, round) => {
        if (!(error instanceof CodexResponseHttpError)) return undefined;
        const { response } = error;
        // §D7 poisoned-replay self-heal: first-round 4xx on a request that
        // replayed non-empty history ⇒ ONE retry with history dropped +
        // clear the doc. Breadth PINNED: ALL 4xx incl. 401/403/429 (T7).
        // 5xx/network keep full breaker weight — no retry, no clear.
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
          await historyKey.store.clear(historyKey.agentId, historyKey.threadId).catch(() => {});
          inputItems.length = 0;
          inputItems.push(userItem);
          replayedNonEmpty = false;
          selfHealed = true;
          return { action: "restart-fresh" };
        }
        return { action: "rethrow", error: new Error(await responseErrorMessage(response)) };
      },
    });

    if (outcome.kind !== "success") return outcome;

    // §D3 persist policy: success only — interrupted/max-turns/deadline
    // outcomes return above without persisting (deadline resolves to
    // "interrupted" at a loop checkpoint or in the scaffold catch).
    if (historyKey) {
      await historyKey.store
        .append(historyKey.agentId, historyKey.threadId, "codex", thisTurnItems)
        .catch(() => {});
    }
    return outcome;
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
  }
}
```

(Add `import type { AgentProviderTurnRequest } from "./types.js";` if not already imported; drop the no-longer-referenced `AgentProviderAdapter` type import.)

- [ ] **Step 3:** Re-point the SSE plumbing at the shared util. `consumeCodexSse` stays exported and byte-identical except no local helpers change; `consumeBufferedSseEvents` (exported, test-imported) becomes:

```typescript
export function consumeBufferedSseEvents(
  buffer: string,
  state: CodexStreamState,
  onStream?: (chunk: string) => void,
): string {
  const { events, remainder } = splitSseEvents(buffer);
  for (const raw of events) {
    const event = parseSseEvent(raw);
    if (!event) continue;
    applyCodexEvent(event, state, onStream);
  }
  return remainder;
}
```

and `applyCodexEvent`'s first line becomes `if (isSseDone(event)) return;` (semantics identical to `event.data === "[DONE]"`). Everything else in `applyCodexEvent` and its helpers is untouched.

- [ ] **Step 4:** Verify — codex suite unedited, then the full gate.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/codex-subscription-adapter.test.ts`
Expected: **Tests  50 passed (50)** — with `git diff --stat src/agents/provider-adapters/codex-subscription-adapter.test.ts` showing **no diff** (this suite needs no import edits: everything it imports keeps its name and home).

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green (manager suite still mocks the module by path — unaffected).

- [ ] **Step 5:** Commit

```bash
git add src/agents/provider-adapters/codex-subscription-adapter.ts
git commit -m "refactor: migrate codex adapter onto LaneBTurnScaffold + shared dispatch loop + sse util (KPR-391 §5.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Migrate gemini onto scaffold + loop

> **Copy discipline for `/* byte-identical */` blocks:** copy from `git show d02f7c9:<path>` (the pre-migration blob), never from the working tree or memory — the file is already partially rewritten when these methods are placed.

**Files:**
- Modify: `src/agents/provider-adapters/gemini-interactions-adapter.ts` (currently 770 lines)
- Test: `src/agents/provider-adapters/gemini-interactions-adapter.test.ts` — **read-only**

Exported surfaces preserved: `GeminiInteractionsAdapter`, `GeminiInteractionsClient`, `__resetCoercionWarnedForTests`, `DEFAULT_GEMINI_MODEL`, `GeminiFunctionCall`, `GeminiRoundState`, `consumeInteractionStream`, `applyInteractionEvent`, `harvestFunctionCalls`. Module-level `coercionWarned` keeps module lifetime (§7.10).

- [ ] **Step 1:** Rework imports: add scaffold + loop imports (as in Task 5, no sse import); reduce `ToolBridge` to `import type { BridgedTool }`; drop `TURN_DEADLINE_SUBTYPE`. Keep `ApiError`/`GoogleGenAI`, `envValue`, logger. Delete the local `DEFAULT_MAX_ROUNDS`. **Keep** the module-level `errorMessage` (762–770) — `describeCreateError`/`describeStreamError` still use it. Keep `extractStatus`, `objectField`/`stringField`/`numberField`, `executeFunctionCall`, all stale-handle constants, `consumeInteractionStream`/`applyInteractionEvent`/`harvestFunctionCalls` verbatim.

- [ ] **Step 2:** Rewrite the class. Delete: abort fields, `runTurn` (140–437), `abort()`, `wasAborted`, `isAbortError`, `buildResult`. Keep `describeCreateError`, `describeStreamError`, `resolveThinkingLevel` as private methods, byte-identical. New class skeleton (complete):

```typescript
export class GeminiInteractionsAdapter extends LaneBTurnScaffold {
  readonly provider = "gemini" as const;

  constructor(private readonly options: GeminiInteractionsAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  // §D1 no-fabrication pin: the scaffold default (request.sessionId ?? "")
  // IS gemini's policy on every non-success path — no overrides here.

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("Gemini turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // §D7: API-key single path. Pre-request throw → scaffold catch →
    // classify "auth" (row alternate pinned); the scaffold finally still
    // closes the bridge on this path (T10).
    const env = this.options.env ?? process.env;
    const apiKey =
      this.options.apiKey ||
      envValue("GOOGLE_GENAI_API_KEY", env) ||
      envValue("GEMINI_API_KEY", env) ||
      envValue("GOOGLE_API_KEY", env);
    if (!apiKey) {
      throw new Error(
        "Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY, and restart the service",
      );
    }
    const client = this.options.client ?? buildDefaultClient(apiKey);

    const bridged = await bridge.connect();
    const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
    const toolPayloads = bridged.map((bt) => ({
      type: "function" as const,
      name: bt.name,
      description: bt.description,
      parameters: bt.inputSchema,
    }));

    const thinkingLevel = this.resolveThinkingLevel();

    /** §D1: previous_interaction_id double duty — round 1 resumes the
     *  persisted handle (undefined ⇒ fresh thread); rounds N+1 chain the
     *  prior round's just-minted id with ONLY the function_result items. */
    let chainHead: string | undefined = request.sessionId || undefined;
    let input: unknown = request.prompt;
    let roundResultItems: unknown[] = [];

    return runBoundedDispatchLoop<GeminiRoundState, GeminiFunctionCall>({
      request,
      harness,
      executeRound: async (round) => {
        let stream: AsyncIterable<Record<string, unknown>>;
        try {
          stream = await client.create(
            {
              model: this.options.model || DEFAULT_GEMINI_MODEL,
              // Documented: system_instruction does NOT persist across
              // chained interactions — re-sent every round (§D2).
              system_instruction: request.systemPromptOverride ?? this.options.assembly.instructions,
              input,
              stream: true,
              // §D2 posture pin: chaining prerequisite — pinned, not defaulted.
              store: true,
              ...(chainHead ? { previous_interaction_id: chainHead } : {}),
              ...(thinkingLevel ? { generation_config: { thinking_level: thinkingLevel } } : {}),
              tools: toolPayloads,
            },
            // maxRetries 0: single-attempt by design — retry policy belongs
            // to the breaker/outage layer.
            { fetchOptions: { signal: harness.signal }, maxRetries: 0 },
          );
        } catch (error) {
          throw this.describeCreateError(error, round, request.sessionId || undefined);
        }
        let state: GeminiRoundState;
        try {
          state = await consumeInteractionStream(stream, request.onStream, harness.isAborted);
        } catch (error) {
          // A deadline/operator abort passes through untouched (no HTTP
          // status ⇒ describeStreamError returns the original error), so the
          // scaffold catch's isAbortError/interruptedResult still resolve it.
          throw this.describeStreamError(error);
        }
        return {
          state,
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
          },
          providerRoundId: state.interactionId,
          text: state.text,
        };
      },
      // Harvest dedups internally (dual-source contract) — no callId hook.
      harvest: (state) => harvestFunctionCalls(state),
      beforeExecuteCalls: (state) => {
        if (!state.interactionId) {
          // Can't chain the function_result round without the parent id.
          throw new Error("Gemini interaction stream ended without an interaction id");
        }
        roundResultItems = [];
      },
      executeCall: async (call) => {
        const output = await executeFunctionCall(call, bridgedByName);
        // T0 spike leg (b2): function_result input shape accepted verbatim.
        roundResultItems.push({
          type: "function_result",
          name: call.name,
          call_id: call.id,
          result: [{ type: "text", text: output }],
        });
      },
      afterCalls: (state) => {
        chainHead = state.interactionId;
        input = roundResultItems;
      },
    });
  }

  private describeCreateError(/* byte-identical to pre-migration 462–478 */): Error { /* … */ }
  private describeStreamError(/* byte-identical to pre-migration 489–495 */): Error { /* … */ }
  private resolveThinkingLevel(/* byte-identical to pre-migration 499–515 */): string | undefined { /* … */ }
}
```

(The three private methods are moved verbatim — the implementer copies bodies from the pre-migration file unchanged.)

- [ ] **Step 3:** Verify — gemini suite unedited (imports already resolve; no edits expected), then the full gate.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/gemini-interactions-adapter.test.ts`
Expected: **Tests  41 passed (41)**; `git diff --stat` shows no test-file diff.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green. Key pins now exercising shared code: "mid-stream abort → sessionId = request.sessionId ?? ''" (scaffold default policy), "no key → §D7 error + bridge.close still called" (scaffold finally), all four #407 deadline pins (scaffold arming + loop checkpoints), success "final round's interaction id" (loop success formula).

- [ ] **Step 4:** Commit

```bash
git add src/agents/provider-adapters/gemini-interactions-adapter.ts
git commit -m "refactor: migrate gemini adapter onto LaneBTurnScaffold + shared dispatch loop (KPR-391 §5.3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Migrate openai onto scaffold only

> **Copy discipline for `/* byte-identical */` blocks:** copy from `git show d02f7c9:<path>` (the pre-migration blob), never from the working tree or memory — the file is already partially rewritten when these methods are placed.

**Files:**
- Modify: `src/agents/provider-adapters/openai-agents-adapter.ts` (currently 385 lines)
- Test: `src/agents/provider-adapters/openai-agents-adapter.test.ts` — **read-only**

Boundary decision (spec §Key Points): openai keeps the Agents SDK loop as its engine — scaffold only. Exported surfaces preserved: `OpenAIAgentsAdapter`, `OpenAIAgentsAdapterOptions`, `coerceFinalOutput`.

- [ ] **Step 1:** Rework imports (scaffold; drop `TURN_DEADLINE_SUBTYPE`; reduce `ToolBridge` to `import type { BridgedTool }`). Delete the module-level `errorMessage` (382–385) — replaced by the `errorText` override. Keep `bindTool` and `coerceFinalOutput` verbatim.

- [ ] **Step 2:** Rewrite the class. Delete: abort fields, `runTurn` (38–211), `abort()`, `wasAborted`, `isAbortError`, `buildResult`. Keep `runWithClient` (overloads verbatim), `buildClient` (verbatim, including the pinned "OpenAI API key is not available…" message), `consumeTextStream`, `extractSessionId`. New class skeleton (complete except the four kept-verbatim private methods):

```typescript
export class OpenAIAgentsAdapter extends LaneBTurnScaffold {
  readonly provider = "openai" as const;

  constructor(private readonly options: OpenAIAgentsAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  // Scaffold defaults ARE openai's policies: fallback `request.sessionId ??
  // ""`, bare-fallback interruption sessionId — no session hooks here.

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("OpenAI turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  /** Preserves openai's pre-migration stringification (coerceFinalOutput —
   *  thrown-null → "" edge), vs the codex/gemini default. */
  protected override errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return coerceFinalOutput(error);
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // KPR-351 (R1): API-key single path — resolve the client BEFORE
    // connecting tool servers, so persistent misconfig fails in microseconds
    // (auth-before-connect ordering is provider-owned; the scaffold does not
    // sequence it).
    const client = this.buildClient();

    // KPR-348: connect() is fail-soft per server and never throws (§D7).
    const bridged = await bridge.connect();
    const tools = bridged.map((bt) => bindTool(bt));
    const agent = new Agent({
      name: this.options.name,
      instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
      model: this.options.model,
      // KPR-350 (§D2): chaining posture pinned, not defaulted. store:true is
      // the previous_response_id prerequisite; truncation:"auto" is the
      // Lane B compaction analog. Nested KPR-354 delegate constructions
      // share this path deliberately.
      modelSettings: { store: true, truncation: "auto" },
      ...(tools.length > 0 ? { tools } : {}),
    });

    const runOptions = {
      // openai hands maxTurns (0 included) to the SDK — deliberate
      // divergence from the raw-API loop's zero-call short-circuit.
      maxTurns: request.resourceLimits?.maxTurns,
      signal: harness.signal,
      previousResponseId: request.sessionId,
    };

    if (harness.streamed) {
      const result = await this.runWithClient(client, agent, request.prompt, {
        ...runOptions,
        stream: true,
      });
      const text = await this.consumeTextStream(result, request.onStream);
      // #407 quiet-resolve guard: the SDK can resolve an aborted stream
      // quietly instead of throwing — a deadline that landed mid-stream must
      // not surface partial text as a clean success. Resolved through the
      // scaffold (deadlineFired && !aborted ⇒ deadline result).
      if (harness.deadlineFired() && !this.wasAborted) return { kind: "interrupted" };
      return { kind: "success", text, sessionId: this.extractSessionId(result, harness.fallbackSessionId) };
    }

    const result = await this.runWithClient(client, agent, request.prompt, {
      ...runOptions,
      stream: false,
    });
    if (harness.deadlineFired() && !this.wasAborted) return { kind: "interrupted" };
    return {
      kind: "success",
      text: coerceFinalOutput(result.finalOutput),
      sessionId: this.extractSessionId(result, harness.fallbackSessionId),
    };
  }

  private runWithClient(/* byte-identical, incl. overloads */): /* … */ { /* … */ }
  private buildClient(/* byte-identical */): OpenAI { /* … */ }
  private consumeTextStream(/* byte-identical */): Promise<string> { /* … */ }
  private extractSessionId(/* byte-identical */): string { /* … */ }
}
```

- [ ] **Step 3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/openai-agents-adapter.test.ts`
Expected: **Tests  31 passed (31)**; no test-file diff. Key pins now exercising shared code: the four #407 deadline pins (incl. the quiet-resolve guard reading `harness.deadlineFired()`), bridge-close-on-auth-throw, abort-error result shape.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green.

- [ ] **Step 4:** Commit

```bash
git add src/agents/provider-adapters/openai-agents-adapter.ts
git commit -m "refactor: migrate openai adapter onto LaneBTurnScaffold (scaffold-only — SDK loop kept) (KPR-391 §5.4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Provider-module registry + rewire both `agent-manager.ts` construction sites

**Files:**
- Create: `src/agents/provider-adapters/provider-modules.ts`
- Create: `src/agents/provider-adapters/provider-modules.test.ts`
- Modify: `src/agents/agent-manager.ts` (imports ~29–36; nested construction ~650–685; top-level tail ~761–791)
- Test: `src/agents/agent-manager.test.ts` — **read-only**

- [ ] **Step 1:** Write `src/agents/provider-adapters/provider-modules.ts`:

```typescript
/**
 * KPR-391 (§4.3): the static in-engine provider-module table. One
 * construction entry per Lane B provider, consumed by BOTH agent-manager
 * construction sites (top-level createProviderAdapter tail + the nested
 * KPR-354 delegateTurnRunner) so the two can never drift. KPR-394 makes
 * entries loadable via `hive plugin add`; until then this Record is the
 * whole registry. Model default chains moved here verbatim from the
 * pre-KPR-391 call sites.
 */
import { CodexSubscriptionAdapter } from "./codex-subscription-adapter.js";
import { GeminiInteractionsAdapter } from "./gemini-interactions-adapter.js";
import { OpenAIAgentsAdapter } from "./openai-agents-adapter.js";
import type { LaneBProviderId } from "./types.js";
import type { LaneBProviderModule } from "./provider-module.js";

const codexModule: LaneBProviderModule = {
  provider: "codex",
  createAdapter: (args) =>
    new CodexSubscriptionAdapter({
      name: args.name,
      model: args.route.model || args.deps.providerConfig.codex?.agentModel,
      reasoningEffort: args.route.reasoningEffort,
      assembly: args.assembly,
      // KPR-353 §D3 wiring in PRIMARY context only. The KPR-354 G4
      // guarantee — nested turns provably never touch provider_turn_history —
      // is a module rule: nested constructions omit both keys entirely.
      ...(args.context === "primary"
        ? { historyStore: args.deps.turnHistoryStore, agentId: args.deps.agentId }
        : {}),
    }),
};

const openaiModule: LaneBProviderModule = {
  provider: "openai",
  createAdapter: (args) =>
    new OpenAIAgentsAdapter({
      name: args.name,
      model: args.route.model || args.deps.providerConfig.openai?.agentModel || "gpt-5.4-mini",
      assembly: args.assembly,
      // reasoningEffort deliberately not passed: parsed-but-not-delivered
      // (docs/providers.md row — the options type has no such field).
    }),
};

const geminiModule: LaneBProviderModule = {
  provider: "gemini",
  createAdapter: (args) =>
    new GeminiInteractionsAdapter({
      name: args.name,
      // KPR-352 plan-time pin: Interactions-supported default.
      model: args.route.model || args.deps.providerConfig.gemini?.agentModel || "gemini-3.6-flash",
      apiKey: args.deps.providerConfig.gemini?.apiKey,
      reasoningEffort: args.route.reasoningEffort,
      assembly: args.assembly,
    }),
};

export const LANE_B_PROVIDER_MODULES: Record<LaneBProviderId, LaneBProviderModule> = {
  codex: codexModule,
  openai: openaiModule,
  gemini: geminiModule,
};
```

- [ ] **Step 2:** Write `src/agents/provider-adapters/provider-modules.test.ts`. Fixture: minimal assembly literal + a `makeDeps()` builder (`providerConfig: { codex: {agentModel: "cfg-codex"}, openai: {agentModel: "cfg-openai"}, gemini: {agentModel: "cfg-gemini", apiKey: "k"} }`, fake `turnHistoryStore` object, `agentId: "a1"`). Options inspected via `(adapter as unknown as { options: … }).options`. Minimum assertions (spec §8 registry list):
  - Table completeness: `Object.keys(LANE_B_PROVIDER_MODULES).sort()` equals `["codex","gemini","openai"]`; each `module.provider` matches its key; each `createAdapter` returns an instance of the right class with the right `.provider`.
  - **Codex context gate (G4):** primary → options carry `historyStore` (the fake) and `agentId: "a1"`; nested → `"historyStore" in options === false` and `"agentId" in options === false`.
  - **Model default chains:** route model wins; empty route model falls to `providerConfig` slice; empty both → openai `"gpt-5.4-mini"`, gemini `"gemini-3.6-flash"`, codex `undefined`-tolerant (`"" || undefined` semantics — assert `options.model === undefined` when both are absent, mirroring the pre-migration call-site expression).
  - **Gemini apiKey threading** from the deps slice; **openai options never carry `reasoningEffort`** (`"reasoningEffort" in options === false`) while codex/gemini pass the route's value through.
  - `name`/`assembly` pass through verbatim in both contexts.
  - **Registry-miss containment (spec §8 bullet):** a non-Lane-B key indexes the table to `undefined` — `(LANE_B_PROVIDER_MODULES as Record<string, unknown>)["claude"] === undefined` (and likewise an arbitrary string) — documenting that the manager's `"provider … does not execute tools"` branch is the containment path on a miss. (No existing manager test asserts that string — the branch is type-unreachable today, mentioned only in comments at `agent-manager.test.ts:4802/4833` — so this table-level assertion is the cheap pin the spec's registry list calls for.)

- [ ] **Step 3:** Rewire `agent-manager.ts`.
  - Imports: replace the three adapter-class imports with
    `import type { CodexReasoningEffort } from "./provider-adapters/codex-subscription-adapter.js";`
    `import { LANE_B_PROVIDER_MODULES } from "./provider-adapters/provider-modules.js";`
    `import type { LaneBModuleDeps, LaneBProviderModule } from "./provider-adapters/provider-module.js";`
    (keep `ClaudeAgentAdapter` and everything else; add `LaneBProviderId` to the existing `types.js` type import).
  - In `createProviderAdapter`, immediately after the Lane A returns (post line ~597) and **before** the `delegateTurnRunner` closure, build the shared deps once:

```typescript
    // KPR-391 (§4.3): named-handle deps for the provider modules — built
    // once, shared by the top-level tail and the nested delegate runner so
    // the two construction sites cannot drift.
    const moduleDeps: LaneBModuleDeps = {
      providerConfig: {
        codex: { agentModel: appConfig.codex.agentModel },
        openai: { agentModel: appConfig.openai.agentModel },
        gemini: { agentModel: appConfig.gemini.agentModel, apiKey: appConfig.gemini.apiKey || undefined },
      },
      turnHistoryStore: this.turnHistoryStore,
      agentId: config.id,
    };
```

  - Nested `delegateTurnRunner`: replace ONLY the `let nested; if/else if/else` construction chain (lines ~650–685) with:

```typescript
        const module = (LANE_B_PROVIDER_MODULES as Partial<Record<string, LaneBProviderModule>>)[
          route.provider
        ];
        if (!module) {
          // Unreachable while LaneBProviderId = {openai, codex, gemini} —
          // kept as containment for a future provider that ships tool-less
          // (KPR-354 belt-and-braces; §D6). Registry-miss path.
          return `Delegate turn failed (${call.delegate}): provider ${String((route as { provider: string }).provider)} does not execute tools`;
        }
        const nested: AgentProviderAdapter = module.createAdapter({
          name: `${config.name}:${call.delegate}`,
          route: { model: route.model, reasoningEffort: route.reasoningEffort },
          assembly: nestedAssembly,
          // G4: the codex module omits historyStore/agentId in nested context —
          // provider_turn_history is provably untouched by nested turns.
          context: "nested",
          deps: moduleDeps,
        });
```

    Everything else in the closure — stop/budget atomicity, slot finally, abort listener, `runTurn` call with `resourceLimits: { maxTurns, timeoutMs: 600_000, budgetUsd: 0 }`, D5.7/D5.8 shaping incl. the deadline-sentinel prose mapping — stays **byte-identical**.
  - Top-level tail: replace the three `if (route.provider === …) return new …` blocks (lines ~761–791) with:

```typescript
    return LANE_B_PROVIDER_MODULES[route.provider].createAdapter({
      name: config.name,
      route: { model: route.model, reasoningEffort: route.reasoningEffort },
      assembly,
      context: "primary",
      deps: moduleDeps,
    });
```

- [ ] **Step 4:** Verify — the 223 manager tests unedited are the seam proof (they pin nested G4/D5 behavior, exact constructor args incl. `historyStore: undefined` + `agentId` on primary codex, gemini apiKey/effort threading, and the assembly seam; the module mocks intercept by resolved module id, so `provider-modules.ts` importing the classes keeps them working).

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
Expected: **Tests  223 passed (223)**; no test-file diff.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green.

- [ ] **Step 5:** Commit

```bash
git add src/agents/provider-adapters/provider-modules.ts src/agents/provider-adapters/provider-modules.test.ts src/agents/agent-manager.ts
git commit -m "refactor: LaneBProviderModule registry — both agent-manager construction sites via one table (KPR-391 §4.3/§5.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Sweep, cross-check test, docs zero-diff, follow-up note

**Files:**
- Create: `src/agents/provider-adapters/classification-crosscheck.test.ts`
- Verify-only: `docs/providers.md`, the §6 untouched-module list

- [ ] **Step 1:** Dead-clone sweep. Confirm no orphaned duplicates survive in the three adapters (Tasks 5–7 should have removed them; this step is the audit):

Run: `grep -n "currentAbortController\|deadlineFired\|isAbortError\|private buildResult\|DEFAULT_MAX_ROUNDS" src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/gemini-interactions-adapter.ts src/agents/provider-adapters/openai-agents-adapter.ts`
Expected: no matches (all scaffold/loop-owned now). Also `grep -n "errorMessage" src/agents/provider-adapters/openai-agents-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.ts` → no module-level definition remains (gemini keeps its copy for `describe*`).

- [ ] **Step 2:** Write `src/agents/provider-adapters/classification-crosscheck.test.ts` — the §8 cross-check guarding §7.1 at the classification boundary (not just string equality). Using `classifyTurnResult` (feed a minimal error-carrying result literal) and `isStaleServerHandleError` — `classifyTurnResult` from `./error-classification.js` (same directory), `isStaleServerHandleError` from `../agent-manager.js` —:
  - `"Codex OAuth session is not available; run \`codex login\` first"` → fault kind `auth`.
  - `"OpenAI API key is not available; set OPENAI_API_KEY in the instance .env and restart — hive credentials add does not carry this key yet"` → `auth`.
  - `"Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY, and restart the service"` → `auth`.
  - `"Codex subscription request failed (429): slow down"` and `"Gemini interaction stream failed (429): Resource has been exhausted (e.g. check quota)."` → `rate-limit`.
  - `"error_max_turns"` → non-provider; `TURN_DEADLINE_SUBTYPE` (on a `timedOut: true, aborted: false` result) → the dedicated `turn-deadline` kind.
  - `"gemini interaction resume rejected (status 400): Request contains an invalid argument."` → `isStaleServerHandleError(...) === true`; the undecorated `"Gemini interaction request failed (400): …"` → `false`.
  (Match assertion shapes to `error-classification.test.ts`'s existing result-literal helpers — replicate, don't cross-import.)

- [ ] **Step 3:** Docs zero-diff + untouched-module audit:

Run: `git diff --stat <base>..HEAD -- docs/ && git hash-object docs/providers.md`
Expected: **no docs changes on this ticket's commits**; hash matches Task 0's. (`<base>` throughout Tasks 9/11 = the head recorded in Task 0 before the first implementation commit — the epic branch itself carries this ticket's spec/plan under `docs/epics/kpr-385/`, so a `main...HEAD` range would false-alarm on those. The ticket-range diff must show only `src/agents/agent-manager.ts`, the three adapters, and new files.)

Run: `git diff --stat <base>..HEAD -- src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/tool-transport.ts src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/builtin-executor.ts src/agents/provider-adapters/archetype-gate.ts src/agents/provider-adapters/oauth-credentials.ts src/agents/turn-history-store.ts src/agents/provider-adapters/passthrough-providers.ts src/agents/provider-adapters/claude-agent-adapter.ts src/agents/provider-adapters/types.ts`
Expected: empty (spec §3/§6).

- [ ] **Step 4:** Record the codex stream-phase status-drop follow-up (spec §1/§3 — NOT fixed here): note in the PR body / ticket comment that `codex-subscription-adapter.ts`'s `response.failed` handling (inside `applyCodexEvent`) still throws message-only with no status prefix — one-line follow-up ticket, trivial post-extraction. Do not change the code.

- [ ] **Step 5:** Verify + commit

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: green.

```bash
git add src/agents/provider-adapters/classification-crosscheck.test.ts
git commit -m "test: cross-provider error-string classification pins (KPR-391 §8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Negative verification (repo convention — evidence the old pins exercise the new shared code)

**Files:** temporary edits to `dispatch-loop.ts` and `turn-scaffold.ts`, both fully reverted. No committed changes.

- [ ] **Step 1 (loop-side):** Reintroduce a divergence — delete the **post-stream checkpoint** line (`if (harness.isAborted()) return { kind: "interrupted" };` after `finalText = result.text;`) in `dispatch-loop.ts`.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/codex-subscription-adapter.test.ts src/agents/provider-adapters/gemini-interactions-adapter.test.ts src/agents/provider-adapters/dispatch-loop.test.ts`
Expected: **failures** in the migrated suites' abort/deadline pins (e.g. codex "between-round abort: onStream aborts during round-1 SSE → no second fetch" and the gemini mid-stream-abort pin) plus the new loop checkpoint test. Record which tests failed.

- [ ] **Step 2:** Revert (`git checkout -- src/agents/provider-adapters/dispatch-loop.ts`), re-run the same command, expect all green.

- [ ] **Step 3 (scaffold-side):** Reintroduce a divergence — delete `await bridge.close();` from the scaffold's `finally`.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/codex-subscription-adapter.test.ts src/agents/provider-adapters/gemini-interactions-adapter.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/turn-scaffold.test.ts`
Expected: **failures** — gemini T10 ("no key → bridge.close still called"), codex "bridge.close() called exactly once on success, error, and abort paths", and the scaffold's own close pins. Record which tests failed.

- [ ] **Step 4:** Revert (`git checkout -- src/agents/provider-adapters/turn-scaffold.ts`), re-run, all green. Include both failure lists as evidence in the PR body / verification notes.

No commit (working tree returns to clean).

---

### Task 11: Final gate + count verification

- [ ] **Step 1:** Full gate:

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: typecheck + lint + format + full vitest all green.

- [ ] **Step 2:** Re-verify the eight baseline counts per file (same commands as Task 0). Expected: **identical to Task 0** — codex 50, gemini 41, openai 31, manager 223, breaker 29, error-classification 59, turn-assembly 23, tool-bridge 45 — and `git diff <base>..HEAD --stat -- '**/*.test.ts'` shows **only the new test files** (zero diff on the eight existing suites; if any existing suite needed even an import edit, list it explicitly in the PR body — expectations must show zero diff regardless).

- [ ] **Step 3:** Confirm `docs/providers.md` zero diff one last time (`git diff <base>..HEAD -- docs/providers.md` → empty).

No further commit (or a final `chore:` commit only if Step 1 surfaced formatting).

---

## Execution Handoff

Plan saved to `docs/epics/kpr-385/kpr-391-plan.md`. Ready to execute with `dodi-dev:implement`.
