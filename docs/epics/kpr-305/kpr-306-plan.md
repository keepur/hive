# KPR-306 — Provider Circuit Breaker Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Per-provider circuit breaker at the provider-adapter execution choke point (`AgentManager.spawnTurn`): typed error classification, single-digit-second trip under live traffic, pre-router fast-fail via the exported `ProviderCircuitOpenError` (the frozen Open-Circuit Contract KPR-307 binds to), capped-exponential half-open recovery, `circuit_breaker_stats` telemetry heartbeat, and an informational `hive doctor` section.

**Architecture:** Three new files (`src/agents/provider-adapters/error-classification.ts`, `src/agents/provider-circuit-breaker.ts`, `src/agents/circuit-breaker-heartbeat.ts`) plus surgical touches to `agent-runner.ts` (one `timedOut` flag), `agent-manager.ts` (acquire/record at the spawnTurn wrap point), `config.ts` (liberal-loader `circuitBreaker` section), `index.ts` (heartbeat wiring), `cli/doctor-checks.ts` + `cli/doctor.ts` (informational section), and `CLAUDE.md`. The breaker owns no timers — all transitions are lazy on `acquire`/`record` with an injected clock as the test seam.

**Tech Stack:** TypeScript (strict), Node 22, vitest, mongodb driver — all existing; **no new dependencies**.

**Spec:** `docs/epics/kpr-305/kpr-306-spec.md` (review-clean r3, Gate 1 rulings D4/D5/D6 binding). Written against branch `mature/KPR-306` @ `e2e5b6a` (code baseline `08ca29e`).

**One gate-ordered reconciliation (binding on the code):** the spec's half-open section says concurrent acquires get "the probe's remaining deadline budget" as `retryAfterMs`, while the Open-Circuit Contract says `retryAfterMs: 0` = "probe currently in flight". **The CONTRACT is authoritative: while a half-open probe is in flight, concurrent `acquire`s throw `ProviderCircuitOpenError` with `retryAfterMs: 0`.** The breaker code in Task 2 implements exactly that, and the half-open concurrency unit test asserts `retryAfterMs === 0` so the contract semantics are regression-pinned.

---

## ⚠ MANDATORY Task 0 — Re-confirm at execution HEAD (maturity-first discipline)

This plan is written ahead of implementation against `mature/KPR-306` @ `e2e5b6a` (code = `main` @ `08ca29e`) and will be implemented **later against a moved main**. `agent-manager.ts` and `agent-runner.ts` are hot files that sibling waves may move. Before writing any code, re-verify every citation below at the execution HEAD. If an anchor has drifted materially (function moved/renamed, signature changed, control flow restructured), STOP and adjust the plan — or demote to the spec lane if the drift is architectural.

- [ ] **Step 0.1:** Re-verify each citation this plan depends on:

| # | Claim | Anchor @ 08ca29e | Re-check command |
|---|---|---|---|
| C1 | `spawnTurn` ticket lambda: sessionId re-resolve, `recordSpawn`, `prepareSpawn`, auth-rebuild retry, `finalizeSpawnResult`/`recordSpawnObservability`, reflection scheduling | `src/agents/agent-manager.ts:531-591` | `grep -n "withSpawnTicket(ctx" src/agents/agent-manager.ts` then read the lambda; it must still be: effectiveCtx → recordSpawn → prepareSpawn → runOneSpawnAttempt → auth-retry branch → finalize+observability → reflection |
| C2 | `resolveProviderModel(model)` returns `{ provider: "claude"\|"openai"\|"gemini"\|"codex" }` | `agent-manager.ts:145-163` | `grep -n "function resolveProviderModel" src/agents/agent-manager.ts` |
| C3 | `isAuthRebuildResumeError` sentinel alternates = `resolve authentication\|credentials\.json\|not authenticated\|401 Unauthorized\|ANTHROPIC_API_KEY\|authToken` (the classifier auth row MUST remain a superset) | `agent-manager.ts:185-189` | `sed -n '/function isAuthRebuildResumeError/,+4p' src/agents/agent-manager.ts` — diff the alternates against the auth row in Task 1; extend the row if the sentinel grew |
| C4 | `withSpawnTicket` `finally` releases thread lock, budget slot, ticket set — a throw from `fn` needs no new cleanup | `agent-manager.ts:685-707` | read the `try { return await fn(ticket); } finally { … }` block |
| C5 | `runOneSpawnAttempt` builds adapter, `ticket.attachAbort`, awaits `adapter.runTurn` | `agent-manager.ts:963-1003` | `grep -n "adapter.runTurn" src/agents/agent-manager.ts` |
| C6 | `RunResult` interface (no `timedOut` yet), `error?: string`, `aborted?: boolean` | `src/agents/agent-runner.ts:120-141` | `grep -n "timedOut" src/agents/agent-runner.ts` (expect empty pre-change) |
| C7 | 300s deadline `setTimeout` → `this.abort()` | `agent-runner.ts:1811-1818` | `grep -n "Agent query timed out" src/agents/agent-runner.ts` |
| C8 | `finally { clearTimeout(deadline); this.activeQuery = null; }` back-to-back, synchronous | `agent-runner.ts:1961-1964` | read the block — the timedOut-guard race narrative depends on it |
| C9 | `abort()` null-guards on `this.activeQuery`, sets `_aborted = true`, nulls `activeQuery` | `agent-runner.ts:2028-2035` | read `abort()` |
| C10 | SDK non-success result subtypes land in `error` (`error_max_turns`, `error_during_execution`) | `agent-runner.ts:1930-1937` | read the `msg.type === "result"` else-branch |
| C11 | `AgentProviderId = "claude"\|"openai"\|"gemini"\|"codex"` | `src/agents/provider-adapters/types.ts:4` | `grep -n "AgentProviderId" src/agents/provider-adapters/types.ts` |
| C12 | Heartbeat structural template (INTERVAL_MS, TELEMETRY_KIND, per-key upsert, unref'd interval, writeOnce) | `src/agents/spawn-coordinator-heartbeat.ts` (whole file, 87 lines) | read file |
| C13 | index.ts wiring points: heartbeat construct/writeOnce/start at `:513-515`, `stop()` at `:810` | `src/index.ts` | `grep -n "spawnCoordinatorHeartbeat" src/index.ts` |
| C14 | Doctor precedents: `spawnCoordinatorStatsForDoctor` (`doctor-checks.ts:331-375`), `renderSpawnCoordinatorSection` (`doctor.ts:120-144`), runDoctor wiring (`doctor.ts:617-618`) + skipped-else block (`doctor.ts:622-632`) | those files | `grep -n "renderSpawnCoordinatorSection\|spawnCoordinatorStatsForDoctor" src/cli/doctor.ts src/cli/doctor-checks.ts` |
| C15 | Liberal-loader config precedent (`imessage` block) + pure-resolver precedent (`normalizeGoogleAccounts`) | `src/config.ts:209-215`, `:32-44` | read both |
| C16 | agent-manager.test.ts mocks `../config.js` (no `circuitBreaker` key) and `AgentRunner.send` via `mockRunnerSend`; fresh manager per test via beforeEach | `src/agents/agent-manager.test.ts:40-80, 284+` | read mock setup — the registry must default when `appConfig.circuitBreaker` is `undefined` |
| C17 | agent-runner.test.ts SDK mock: `mockQuery` + `mockMessages` let-override, factory evaluated lazily | `src/agents/agent-runner.test.ts:32-70` | read — Task 4 extends this factory with `mockQueryOverride` |
| C18 | doctor-checks.test.ts mongodb mock factory (`collection()` returns `{ estimatedDocumentCount, findOne, aggregate }` — **no `find`**) | `src/cli/doctor-checks.test.ts:132-147` | read — Task 6 adds `find` to the factory |
| C19 | No existing breaker code | — | `grep -ri "circuitbreaker" src/` (expect empty) |
| C20 | Sibling-wave seams: KPR-307/KPR-308 may have landed pieces that reference this ticket's exports | — | `grep -rn "ProviderCircuitOpenError\|OutageStateProvider\|circuit_breaker_stats" src/`. If KPR-308's dispatcher `OutageStateProvider` seam exists at HEAD, do **not** wire the breaker into the dispatcher here (that is KPR-307's lane) — but make sure the names/fields this plan exports match what any landed consumer imports; the Open-Circuit Contract fields are frozen, so a mismatch means the consumer drifted, not this plan |

- [ ] **Step 0.2:** Re-verify the spec's "Verified current state" bullets (spec §Problem/Context) still hold — in particular that all channels still route through `spawnTurn` (one choke point) and that adapters still resolve provider faults into `RunResult.error: string` rather than throwing.
- [ ] **Step 0.3:** Re-run the check gate on the untouched branch to establish a green baseline:

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 (typecheck + lint + format + tests all green) before any edit.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `error-classification.ts` (pattern tables, precedence, defaults), `provider-circuit-breaker.ts` (full state machine with injected clock, registry, `ProviderCircuitOpenError`, config resolver defaults), `circuit-breaker-heartbeat.ts` (upsert shape), `agent-runner.ts` `timedOut` flag (deadline vs operator abort vs late-deadline race), `agent-manager.ts` wrap point (fast-fail before adapter, ticket cleanliness, record-once, thrown path), `config.ts` resolver, doctor loader mapping + renderer.
  - Reason: every new behavior is pure in-process logic over injectable collaborators — time via `now: () => number`, failures via `TurnClassification`/`RunResult` literals, Mongo via the existing mock factories, the SDK via the existing `mockQuery` harness. **No live-provider tests** (spec testing outline) and no network anywhere.
  - Minimum assertions:
    - Classifier: one assertion per fault kind per pattern table; **each of the six `isAuthRebuildResumeError` sentinel alternates individually classifies `auth`** (`resolve authentication`, `credentials.json`, `not authenticated`, `401 Unauthorized`, `ANTHROPIC_API_KEY`, `authToken`); `timedOut+aborted` → `timeout` (precedence over `aborted`); `aborted` alone → neutral; no error → success; unknown string → `non-provider`; SDK subtypes `error_max_turns`/`error_during_execution` → `non-provider`; `classifyThrown` default; `HARD_FAULT_KINDS` excludes exactly `non-provider`.
    - State machine (injected clock): closed→open at 3 consecutive hard faults; success resets streak; non-provider fault resets streak; aborted leaves streak unchanged; p95 trip (minSamples gate, threshold breach, `reason: "p95-breach"`, `lastFaultMessage: null`); window **and stale `lastFaultKind`/`lastFaultMessage`/`lastFaultAt`** cleared on close (a later p95 trip after a prior, already-recovered fault still pins `lastFaultMessage: null`); open-state `acquire` throws with correct `provider/openedAt/retryAfterMs/reason/lastFaultMessage`; lazy half-open at `openedAt + cooldown` (that acquire is the probe, `isProbe: true`); **half-open concurrent acquire throws with `retryAfterMs === 0`** (contract reconciliation pin); probe success → closed + full reset (streak, window seeded with the probe's own sample, backoff); probe hard fault → open with doubled cooldown, capped at `openMaxMs`; probe aborted → open, exponent unchanged; probe non-provider fault → closed; per-provider isolation (claude open, gemini grants); shadow mode (acquire never throws, transitions still tracked, `fastFailCount` stays 0); stale-probe reconciliation; `record` idempotent per permit; **late permit** (acquired closed, recorded while open) never transitions state; `tripCount` counts closed→open only.
    - Runner: deadline fire → `timedOut: true` + `aborted: true`; operator abort → `aborted: true`, `timedOut` unset; **operator-abort-then-late-deadline** (abort nulls `activeQuery`, deadline fires after) → `timedOut` unset — the assertion the `if (this.activeQuery)` guard exists for.
    - Wrap point: 3 hard-fault turns trip the breaker and the 4th `spawnTurn` rejects with `ProviderCircuitOpenError` **without invoking the adapter** (`mockRunnerSend` call count unchanged) **or the router** (`routeModel` not called — rejection lands before `prepareSpawn`/router); coordinator snapshot clean after fast-fail (`activeSpawns === 0`, thread lock free — next call rejects with `ProviderCircuitOpenError`, not budget/lock errors); record-once under auth-rebuild retry (only the retry's result feeds the breaker); thrown adapter error classified via `classifyThrown` and rethrown; probe-success recovery end-to-end through `spawnTurn` with an injected-clock registry.
    - Heartbeat: per-provider upsert on `{ kind: "circuit_breaker_stats", provider }`, `$set` carries snapshot + `updatedAt: Date`, `upsert: true`; write failure swallowed with `log.warn`; empty snapshot → zero ops; interval tick + `stop()`.
    - Doctor: renderer variants (empty rows, closed, open with reason/next-probe/last-fault line, half-open, `[shadow]`, `stale-heartbeat` >120s); loader maps missing fields to defaults, filters docs without `provider`, returns `[]` on connection error; **section renders via `emit` only and returns `void`** (cannot alter exit code — D4).
    - Config: absent section → all defaults; partial section → per-key `??`; garbage types → defaults; `p95MinSamples` clamped to `p95WindowSize`.

- Integration: **not-required**
  - Scope: n/a
  - Reason: every cross-module boundary this ticket touches (manager↔breaker, manager↔runner, heartbeat↔Mongo collection, doctor↔telemetry docs) is exercised from both sides in the unit groups above using the repo's established harnesses (`mockRunnerSend` stands in for the full adapter stack exactly as the existing `spawnTurn` suite does; the heartbeat/doctor Mongo mocks are the same factories the sibling heartbeats are tested with). No new process, network, or DB boundary is introduced, and the spec bans live-provider tests.
  - Harness: not-applicable
  - Minimum assertions: n/a

- E2E: **not-required**
  - Scope: n/a
  - Reason: a true end-to-end exercise requires a real provider outage (or a fault-injecting proxy in front of the Anthropic API) — explicitly out of scope per the spec ("no live-provider tests"). The operator-facing rollout path is shadow mode (`circuitBreaker.enabled: false`) + the doctor section + `circuit_breaker_stats` telemetry, which give full burn-in observability on a live instance without behavioral risk.
  - Harness: not-applicable
  - Minimum assertions: n/a

### Critical Flows

- Outage trip: three consecutive connect-fail turns on one provider open the breaker; the next turn fast-fails with `ProviderCircuitOpenError` before `prepareSpawn` (no model-router spend) and releases lock/budget/ticket cleanly.
- Recovery: after cooldown, the next real turn is admitted as the single half-open probe; probe success closes the breaker and resets streak/window/backoff.
- Isolation: a claude-open breaker never affects gemini/codex/openai-routed agents; operator aborts and non-provider faults (tool errors) never trip.
- Observability: breaker state reaches `db.telemetry` (`kind=circuit_breaker_stats`, per provider, 30s) and renders in `hive doctor` without ever flipping the exit code.

### Regression Surface

- `spawnTurn` happy path + auth-rebuild retry semantics (the wrap-point refactor must preserve: retry fires only when sentinel matches AND `effectiveCtx.sessionId` set; finalize/observability run on whichever result becomes the turn result) — existing `spawnTurn (KPR-216)` / `spawnTurn shaping (KPR-224)` suites must stay green.
- `withSpawnTicket` lock/budget/ticket lifecycle and stop checkpoints (`AgentStoppedError` paths).
- Runner deadline behavior: timeout still aborts the query and logs; operator abort semantics unchanged; `RunResult` additive-only (dispatcher `convertTurnResult` untouched).
- Reflection scheduling (fast-failed reflection turns are swallowed by the existing catch; `scheduleReflectionIfEligible` unchanged).
- Sibling heartbeats + doctor sections (prefix-cache, spawn-coordinator, memory-lifecycle, datastore-identity) — new section slots in after spawn-coordinator without reordering; datastore identity remains the only exit-code-capable post-check section.
- Config loading: unknown hive.yaml keys still ignored (KPR-225 F3); all existing config keys unchanged.

### Commands

- Unit (targeted): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts src/agents/provider-circuit-breaker.test.ts src/agents/circuit-breaker-heartbeat.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts src/cli/doctor.test.ts src/cli/doctor-checks.test.ts src/config.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression (repo check gate): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- None new. Existing vitest harnesses cover every collaborator: `agent-manager.test.ts` mocks `AgentRunner.send` + config; `agent-runner.test.ts` mocks the SDK `query` (Task 4 adds a small `mockQueryOverride` extension to that factory); `spawn-coordinator-heartbeat.test.ts` provides the mock-collection pattern the new heartbeat test copies; `doctor-checks.test.ts` provides the mongodb module mock (Task 6 adds `find` to it).
- Env stubs `SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` on the command line (repo check-gate convention — `config.ts` `required()` calls need them at import).
- Time: injected `now: () => number` for the state machine (no fake timers needed); `vi.useFakeTimers` only for the heartbeat interval test and the runner late-deadline race test.

### Non-Required Rationale

- Integration: all boundaries are in-process seams already modeled by existing unit harnesses; no new process/network/DB boundary; spec bans live-provider tests.
- E2E: requires a real provider outage; the operator rollout path is shadow-mode burn-in with full telemetry, by design (spec ⚠ "enabled:false = shadow mode").

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/agents/provider-adapters/error-classification.ts` | **create** | Fault taxonomy, `classifyTurnResult`, `classifyThrown`, `HARD_FAULT_KINDS` — pure, dependency-free |
| `src/agents/provider-adapters/error-classification.test.ts` | **create** | Pattern-table + precedence tests incl. per-sentinel auth superset pins |
| `src/agents/provider-circuit-breaker.ts` | **create** | `ProviderCircuitBreaker` state machine, `ProviderCircuitBreakerRegistry`, `ProviderCircuitOpenError`, `CircuitBreakerSnapshot`, `CircuitBreakerConfig` + `DEFAULT_CIRCUIT_BREAKER_CONFIG` |
| `src/agents/provider-circuit-breaker.test.ts` | **create** | State-machine matrix with injected clock |
| `src/config.ts` | modify | `resolveCircuitBreakerConfig` (exported pure resolver) + `circuitBreaker` key on the config object |
| `src/config.test.ts` | modify | Resolver default/partial/garbage tests |
| `src/agents/agent-runner.ts` | modify | `RunResult.timedOut?: boolean`; guarded stamp in the deadline callback |
| `src/agents/agent-runner.test.ts` | modify | `mockQueryOverride` harness extension + three timedOut tests |
| `src/agents/agent-manager.ts` | modify | `readonly circuitBreakers` registry; acquire/record-once at the spawnTurn wrap point |
| `src/agents/agent-manager.test.ts` | modify | Wrap-point suite (fast-fail, ticket cleanliness, record-once, thrown path, probe recovery) |
| `src/agents/circuit-breaker-heartbeat.ts` | **create** | 30s per-provider telemetry heartbeat (structural copy of spawn-coordinator-heartbeat) |
| `src/agents/circuit-breaker-heartbeat.test.ts` | **create** | Upsert-shape tests (mirror sibling) |
| `src/index.ts` | modify | Heartbeat construct/writeOnce/start next to `:513`; `stop()` next to `:810` |
| `src/cli/doctor-checks.ts` | modify | `CircuitBreakerRow` + `circuitBreakerStatsForDoctor` |
| `src/cli/doctor-checks.test.ts` | modify | Add `find` to the mongodb mock; loader mapping tests |
| `src/cli/doctor.ts` | modify | `renderCircuitBreakerSection` + runDoctor wiring (informational — D4) |
| `src/cli/doctor.test.ts` | modify | Renderer variant tests |
| `CLAUDE.md` | modify | Telemetry kinds list + Common Gotchas breaker entry (D5) |

---

### Task 1: Error classifier

**Files:**
- Create: `src/agents/provider-adapters/error-classification.ts`
- Test: `src/agents/provider-adapters/error-classification.test.ts`

- [ ] **Step 1.1:** Create `src/agents/provider-adapters/error-classification.ts`:

```typescript
/**
 * KPR-306: typed error classification at the provider-adapter boundary.
 *
 * All four adapters resolve provider faults into `RunResult.error: string`
 * (they do not throw for provider faults). This module maps that string —
 * plus the `timedOut`/`aborted` flags — into a typed taxonomy the circuit
 * breaker consumes.
 *
 * Fail-safe bias: an unrecognized error string classifies `non-provider`
 * and NEVER trips the breaker. Under the breaker's reset semantics a missed
 * provider fault doesn't just delay a trip — it resets the consecutive-fault
 * streak — but a false positive (a tool failure tripping the breaker) takes
 * a healthy provider offline outright. The asymmetry dictates the default.
 *
 * Pure and dependency-free by design (no logger, no config).
 */

export type ProviderFaultKind =
  | "connect-fail" // network-level: refused/reset/DNS/fetch failed
  | "timeout" // runner deadline fired (RunResult.timedOut)
  | "rate-limit" // 429 / rate limit / too many requests
  | "auth" // 401/403/authentication/invalid key
  | "server-error" // 5xx / overloaded / service unavailable
  | "non-provider"; // everything else — NEVER trips the breaker

export interface TurnFaultInput {
  error?: string; // RunResult.error
  timedOut?: boolean; // RunResult.timedOut (KPR-306)
  aborted?: boolean; // RunResult.aborted
}

export type TurnClassification =
  | { outcome: "success" } // no error, not aborted
  | { outcome: "aborted" } // operator abort — breaker-neutral
  | { outcome: "fault"; kind: ProviderFaultKind; message: string };

/** Every kind that counts toward the trip streak — all except non-provider. */
export const HARD_FAULT_KINDS: ReadonlySet<ProviderFaultKind> = new Set([
  "connect-fail",
  "timeout",
  "rate-limit",
  "auth",
  "server-error",
]);

/**
 * SDK result subtypes flattened into RunResult.error verbatim
 * (agent-runner.ts `msg.type === "result"` non-success branch). These are
 * turn-shape conditions (budget/turn caps, in-execution tool failures), not
 * provider faults — short-circuit them before the pattern tables so e.g.
 * "error_during_execution" can never match a fault row.
 */
const SDK_NON_PROVIDER_SUBTYPES = new Set(["error_max_turns", "error_during_execution"]);

/**
 * First match wins, in row order. The auth row MUST remain a superset of
 * every `isAuthRebuildResumeError` alternate (agent-manager.ts — currently:
 * resolve authentication | credentials\.json | not authenticated |
 * 401 Unauthorized | ANTHROPIC_API_KEY | authToken). A sentinel the auth row
 * misses would classify non-provider and RESET the hard-fault streak, so a
 * persistent auth outage would never trip. Any future addition to the
 * sentinel list must extend this row in the same change (regression-pinned
 * per-alternate in error-classification.test.ts).
 */
const FAULT_PATTERNS: ReadonlyArray<
  readonly [Exclude<ProviderFaultKind, "non-provider" | "timeout">, RegExp]
> = [
  [
    "connect-fail",
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|terminated/i,
  ],
  ["rate-limit", /\b429\b|rate.?limit|too many requests/i],
  [
    "auth",
    /\b401\b|\b403\b|authentication|unauthorized|invalid.?api.?key|OAuth session is not available|not.?authenticated|credentials\.json|ANTHROPIC_API_KEY|authToken|resolve authentication/i,
  ],
  ["server-error", /\b5\d\d\b|overloaded|internal server error|service unavailable|bad gateway|upstream/i],
];

function classifyErrorString(error: string): TurnClassification {
  if (SDK_NON_PROVIDER_SUBTYPES.has(error.trim())) {
    return { outcome: "fault", kind: "non-provider", message: error };
  }
  for (const [kind, pattern] of FAULT_PATTERNS) {
    if (pattern.test(error)) return { outcome: "fault", kind, message: error };
  }
  return { outcome: "fault", kind: "non-provider", message: error };
}

/**
 * Classify a finished turn's RunResult. Order (first match wins):
 *  1. timedOut && aborted  → timeout fault (the deadline path sets both;
 *     requiring both is belt-and-suspenders on top of the runner-side
 *     activeQuery guard, which is the primary fix).
 *  2. aborted (alone)      → aborted (neutral — never reached a
 *     provider-attributable outcome).
 *  3. no error             → success.
 *  4. pattern tables       → fault kind.
 *  5. default              → non-provider (fail-safe).
 */
export function classifyTurnResult(input: TurnFaultInput): TurnClassification {
  if (input.timedOut === true && input.aborted === true) {
    return { outcome: "fault", kind: "timeout", message: input.error ?? "turn deadline exceeded" };
  }
  if (input.aborted === true) return { outcome: "aborted" };
  if (!input.error) return { outcome: "success" };
  return classifyErrorString(input.error);
}

/**
 * Classify the rare throw path out of `adapter.runTurn` (e.g. codex
 * missing-OAuth throw pre-RunResult). Same tables, same fail-safe default.
 */
export function classifyThrown(err: unknown): TurnClassification {
  return classifyErrorString(String(err));
}
```

- [ ] **Step 1.2:** Create `src/agents/provider-adapters/error-classification.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  classifyTurnResult,
  classifyThrown,
  HARD_FAULT_KINDS,
  type ProviderFaultKind,
} from "./error-classification.js";

function faultKind(error: string): ProviderFaultKind {
  const c = classifyTurnResult({ error });
  if (c.outcome !== "fault") throw new Error(`expected fault, got ${c.outcome}`);
  return c.kind;
}

describe("classifyTurnResult (KPR-306)", () => {
  it("classifies timedOut + aborted as a timeout fault (precedence over aborted)", () => {
    expect(classifyTurnResult({ timedOut: true, aborted: true })).toEqual({
      outcome: "fault",
      kind: "timeout",
      message: "turn deadline exceeded",
    });
    // Even with an error string present, timeout wins.
    expect(classifyTurnResult({ timedOut: true, aborted: true, error: "whatever" })).toMatchObject({
      kind: "timeout",
      message: "whatever",
    });
  });

  it("classifies aborted-without-timedOut as neutral aborted", () => {
    expect(classifyTurnResult({ aborted: true })).toEqual({ outcome: "aborted" });
    expect(classifyTurnResult({ aborted: true, error: "ECONNREFUSED" })).toEqual({ outcome: "aborted" });
  });

  it("classifies no-error as success", () => {
    expect(classifyTurnResult({})).toEqual({ outcome: "success" });
    expect(classifyTurnResult({ error: "" })).toEqual({ outcome: "success" });
  });

  it.each([
    "connect ECONNREFUSED 127.0.0.1:443",
    "read ECONNRESET",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "connect ETIMEDOUT",
    "write EPIPE",
    "socket hang up",
    "TypeError: fetch failed",
    "network error while streaming",
    "terminated",
  ])("connect-fail: %s", (s) => expect(faultKind(s)).toBe("connect-fail"));

  it.each([
    "429 Too Many Requests",
    "rate limit exceeded",
    "rate-limited, retry later",
    "too many requests",
  ])("rate-limit: %s", (s) => expect(faultKind(s)).toBe("rate-limit"));

  it.each([
    "401 unauthorized-ish", // \b401\b
    "403 Forbidden",
    "authentication failure",
    "Unauthorized",
    "invalid api key",
    "invalid_api_key",
    "OAuth session is not available",
  ])("auth: %s", (s) => expect(faultKind(s)).toBe("auth"));

  // The auth row MUST be a superset of every isAuthRebuildResumeError
  // alternate (agent-manager.ts) — asserted individually so a sentinel
  // addition without a matching row extension fails here, not in prod.
  it.each([
    "could not resolve authentication",
    "missing credentials.json",
    "not authenticated",
    "401 Unauthorized",
    "ANTHROPIC_API_KEY is not set",
    "invalid authToken",
  ])("auth-rebuild sentinel alternate classifies auth (superset pin): %s", (s) =>
    expect(faultKind(s)).toBe("auth"),
  );

  it.each([
    "500 Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "Overloaded",
    "upstream connect error",
  ])("server-error: %s", (s) => expect(faultKind(s)).toBe("server-error"));

  it("classifies SDK result subtypes as non-provider (short-circuit)", () => {
    expect(faultKind("error_max_turns")).toBe("non-provider");
    expect(faultKind("error_during_execution")).toBe("non-provider");
  });

  it("classifies unknown strings as non-provider (fail-safe default)", () => {
    expect(faultKind("Something exploded in a tool handler")).toBe("non-provider");
    expect(faultKind("boom")).toBe("non-provider");
  });
});

describe("classifyThrown", () => {
  it("runs String(err) through the same tables", () => {
    const c = classifyThrown(new Error("fetch failed"));
    expect(c).toMatchObject({ outcome: "fault", kind: "connect-fail" });
  });

  it("defaults to non-provider", () => {
    expect(classifyThrown(new Error("weird"))).toMatchObject({ kind: "non-provider" });
    expect(classifyThrown(undefined)).toMatchObject({ kind: "non-provider" });
  });
});

describe("HARD_FAULT_KINDS", () => {
  it("contains every kind except non-provider", () => {
    expect([...HARD_FAULT_KINDS].sort()).toEqual(
      ["auth", "connect-fail", "rate-limit", "server-error", "timeout"].sort(),
    );
    expect(HARD_FAULT_KINDS.has("non-provider")).toBe(false);
  });
});
```

- [ ] **Step 1.3:** Verify

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts`
Expected: all tests pass (0 failures).

- [ ] **Step 1.4:** Commit

```bash
git add src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/error-classification.test.ts
git commit -m "KPR-306: typed provider-fault classifier at the adapter boundary"
```

---

### Task 2: Breaker state machine + registry + Open-Circuit Contract

**Files:**
- Create: `src/agents/provider-circuit-breaker.ts`
- Test: `src/agents/provider-circuit-breaker.test.ts`

- [ ] **Step 2.1:** Create `src/agents/provider-circuit-breaker.ts`:

```typescript
/**
 * KPR-306: per-provider circuit breaker at the provider-adapter boundary.
 *
 * One ProviderCircuitBreaker per AgentProviderId, created lazily by the
 * registry on first use. The breaker owns NO timers — every transition is
 * evaluated lazily on acquire()/record() against the injected clock (the
 * test seam), so there is nothing to unref or shut down.
 *
 * State machine:
 *   closed ──(consecutive hard faults ≥ threshold)──────────────► open
 *   closed ──(p95(llmMs window) > threshold, n ≥ minSamples)────► open
 *   open ────(now ≥ openedAt + cooldown; next acquire)──────────► half-open
 *   half-open ──(probe: success OR non-provider fault)──────────► closed
 *   half-open ──(probe: hard fault)─────────────────────────────► open (backoff×2, cap)
 *   half-open ──(probe: aborted/inconclusive)───────────────────► open (backoff unchanged)
 *
 * OPEN-CIRCUIT CONTRACT (KPR-307 binds to ProviderCircuitOpenError and
 * CircuitBreakerSnapshot — frozen fields, additive evolution only).
 * Contract reconciliation (gate-ordered): while a half-open probe is in
 * flight, concurrent acquires throw with retryAfterMs === 0 — the contract's
 * "0 = probe currently in flight" is authoritative over the spec's half-open
 * prose ("the probe's remaining deadline budget").
 */
import type { AgentProviderId } from "./provider-adapters/types.js";
import {
  HARD_FAULT_KINDS,
  type ProviderFaultKind,
  type TurnClassification,
} from "./provider-adapters/error-classification.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("circuit-breaker");

export interface CircuitBreakerConfig {
  /** false = shadow mode: observe/classify/transition + telemetry, never fast-fail. */
  enabled: boolean;
  /** Hard faults in a row to trip (closed → open). */
  consecutiveFaultThreshold: number;
  /** First cooldown before a half-open probe. */
  openBaseMs: number;
  /** Cooldown cap (exponential backoff ceiling). */
  openMaxMs: number;
  /** llmMs ring-buffer size (successful turns only). */
  p95WindowSize: number;
  /** Samples required before p95 is evaluated. */
  p95MinSamples: number;
  /** p95 above this trips (reason: "p95-breach"). */
  p95ThresholdMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = Object.freeze({
  enabled: true,
  consecutiveFaultThreshold: 3,
  openBaseMs: 15_000,
  openMaxMs: 60_000,
  p95WindowSize: 50,
  p95MinSamples: 20,
  p95ThresholdMs: 240_000,
});

/** lastFaultMessage / lastSpawnError truncation bound (matches KPR-220 Phase 11). */
const FAULT_MESSAGE_MAX = 240;

/**
 * Probe-permit staleness bound: default 300s turn deadline + 60s grace. A
 * probe permit never recorded (caller lost between acquire and record —
 * structurally prevented at the wrap point, belt-and-braces here) is
 * reconciled as inconclusive on the next acquire.
 *
 * Agents with a custom `timeoutMs` > 300s can hit premature stale-probe
 * reconciliation here — bounded and safe: a late probe success still
 * records as telemetry-only, and the next post-cooldown turn re-probes.
 */
const PROBE_STALE_MS = 360_000;

/** Opaque turn-admission handle. `record(permit, …)` makes probe bookkeeping airtight. */
export interface TurnPermit {
  readonly provider: AgentProviderId;
  readonly isProbe: boolean;
}

interface InternalPermit extends TurnPermit {
  recorded: boolean;
  issuedAt: number;
}

/** OPEN-CIRCUIT CONTRACT — frozen fields; additive evolution only (KPR-307). */
export class ProviderCircuitOpenError extends Error {
  override readonly name = "ProviderCircuitOpenError";
  constructor(
    readonly provider: AgentProviderId,
    /** Epoch ms when the breaker (most recently) opened. */
    readonly openedAt: number,
    /** ms from now until the next half-open probe is eligible (0 = probe currently in flight). */
    readonly retryAfterMs: number,
    /** What tripped it: a hard fault kind, or "p95-breach". */
    readonly reason: ProviderFaultKind | "p95-breach",
    /** Last classified fault message, truncated to 240 chars; null for pure p95 trips. */
    readonly lastFaultMessage: string | null,
  ) {
    super(
      `Provider circuit open for ${provider} (reason=${reason}, retry in ~${Math.ceil(retryAfterMs / 1000)}s)`,
    );
  }
}

/** OPEN-CIRCUIT CONTRACT — frozen fields; additive evolution only (KPR-307). */
export interface CircuitBreakerSnapshot {
  provider: AgentProviderId;
  state: "closed" | "open" | "half-open";
  enabled: boolean; // false = shadow mode
  openedAt: number | null;
  reason: ProviderFaultKind | "p95-breach" | null;
  consecutiveHardFaults: number;
  tripCount: number; // lifetime (process) count of closed→open transitions
  lastTripAt: number | null;
  fastFailCount: number; // turns rejected while open (process lifetime)
  lastFaultKind: ProviderFaultKind | null;
  lastFaultMessage: string | null; // truncated 240
  lastFaultAt: number | null;
  p95Ms: number | null; // null until minSamples reached
  sampleCount: number;
  probeInFlight: boolean;
  nextProbeEligibleAt: number | null; // epoch ms; null unless open
}

export class ProviderCircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private consecutiveHardFaults = 0;
  private backoffExponent = 0;
  private openedAt: number | null = null;
  private reason: ProviderFaultKind | "p95-breach" | null = null;
  private tripCount = 0;
  private lastTripAt: number | null = null;
  private fastFailCount = 0;
  private fastFailLoggedSinceOpen = false;
  private lastFaultKind: ProviderFaultKind | null = null;
  private lastFaultMessage: string | null = null;
  private lastFaultAt: number | null = null;
  // Ring buffer of successful-turn llmMs samples. windowCursor counts total
  // insertions; index = windowCursor % p95WindowSize.
  private window: number[] = [];
  private windowCursor = 0;
  private probe: InternalPermit | null = null;
  private probeStartedAt: number | null = null;

  constructor(
    readonly provider: AgentProviderId,
    private readonly config: CircuitBreakerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private cooldownMs(): number {
    return Math.min(this.config.openBaseMs * 2 ** this.backoffExponent, this.config.openMaxMs);
  }

  /**
   * Admit or reject a turn. Throws ProviderCircuitOpenError while open (and
   * in half-open when the probe slot is taken) unless shadow mode. Lazy
   * transitions: open → half-open happens here, on the first acquire at or
   * after openedAt + cooldown — that acquire becomes the probe.
   */
  acquire(meta?: { agentId?: string; threadId?: string }): TurnPermit {
    const now = this.now();

    // Belt-and-braces: reconcile a probe permit that was never recorded.
    if (
      this.state === "half-open" &&
      this.probe !== null &&
      this.probeStartedAt !== null &&
      now - this.probeStartedAt > PROBE_STALE_MS
    ) {
      log.warn("Provider circuit probe went stale — treating as inconclusive", {
        provider: this.provider,
        ageMs: now - this.probeStartedAt,
      });
      this.probe = null;
      this.probeStartedAt = null;
      this.reopen(now, false);
    }

    if (this.state === "open" && this.openedAt !== null && now >= this.openedAt + this.cooldownMs()) {
      this.state = "half-open"; // fall through — this acquire becomes the probe
    }

    if (this.state === "closed") {
      return this.issuePermit(false, now);
    }

    if (this.state === "half-open") {
      if (this.probe === null) {
        const permit = this.issuePermit(true, now);
        this.probe = permit;
        this.probeStartedAt = now;
        log.info("Provider circuit half-open — admitting probe turn", {
          provider: this.provider,
          agentId: meta?.agentId,
          threadId: meta?.threadId,
        });
        return permit;
      }
      // Concurrent acquire while the probe is in flight.
      // CONTRACT: retryAfterMs === 0 signals "probe currently in flight".
      return this.reject(0, now);
    }

    // open, cooldown not yet elapsed
    const retryAfterMs = Math.max(0, (this.openedAt ?? now) + this.cooldownMs() - now);
    return this.reject(retryAfterMs, now);
  }

  /**
   * Record the outcome of a permitted turn. Idempotent per permit. Only the
   * designated half-open probe's outcome drives half-open transitions; late
   * permits (acquired closed, finishing after a trip) feed lastFault*
   * telemetry only and never transition state.
   */
  record(permit: TurnPermit, classification: TurnClassification, llmMs: number): void {
    const p = permit as InternalPermit;
    if (p.recorded) return;
    p.recorded = true;
    const now = this.now();

    if (classification.outcome === "fault") {
      this.lastFaultKind = classification.kind;
      this.lastFaultMessage = classification.message.slice(0, FAULT_MESSAGE_MAX);
      this.lastFaultAt = now;
    }

    if (this.probe === p) {
      this.probe = null;
      this.probeStartedAt = null;
      this.settleProbe(classification, now, llmMs);
      return;
    }

    if (this.state !== "closed") return; // late permit — telemetry only

    switch (classification.outcome) {
      case "success": {
        this.consecutiveHardFaults = 0;
        this.pushSample(llmMs);
        if (this.sampleCount() >= this.config.p95MinSamples) {
          const p95 = this.computeP95();
          if (p95 !== null && p95 > this.config.p95ThresholdMs) {
            // Pure latency trip — lastFaultMessage stays whatever it was;
            // the error surface reports null for p95 trips via `reason`.
            this.open(now, "p95-breach");
          }
        }
        return;
      }
      case "aborted":
        // Inconclusive — the turn never reached a provider-attributable
        // outcome. Streak unchanged.
        return;
      case "fault": {
        if (HARD_FAULT_KINDS.has(classification.kind)) {
          this.consecutiveHardFaults++;
          if (this.consecutiveHardFaults >= this.config.consecutiveFaultThreshold) {
            this.open(now, classification.kind);
          }
        } else {
          // non-provider: the turn traversed the provider path and got a
          // response — proves the provider is up. Resets the streak (same
          // reachability logic as the half-open close rule).
          this.consecutiveHardFaults = 0;
        }
        return;
      }
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      provider: this.provider,
      state: this.state,
      enabled: this.config.enabled,
      openedAt: this.openedAt,
      reason: this.reason,
      consecutiveHardFaults: this.consecutiveHardFaults,
      tripCount: this.tripCount,
      lastTripAt: this.lastTripAt,
      fastFailCount: this.fastFailCount,
      lastFaultKind: this.lastFaultKind,
      lastFaultMessage: this.lastFaultMessage,
      lastFaultAt: this.lastFaultAt,
      p95Ms: this.sampleCount() >= this.config.p95MinSamples ? this.computeP95() : null,
      sampleCount: this.sampleCount(),
      probeInFlight: this.probe !== null,
      nextProbeEligibleAt:
        this.state === "open" && this.openedAt !== null ? this.openedAt + this.cooldownMs() : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private issuePermit(isProbe: boolean, now: number): InternalPermit {
    return { provider: this.provider, isProbe, recorded: false, issuedAt: now };
  }

  private reject(retryAfterMs: number, now: number): TurnPermit {
    if (!this.config.enabled) {
      // Shadow mode: would have fast-failed — grant a normal (non-probe)
      // permit and keep observing. fastFailCount stays literal ("turns
      // rejected"): nothing is rejected in shadow.
      return this.issuePermit(false, now);
    }
    this.fastFailCount++;
    if (!this.fastFailLoggedSinceOpen) {
      // Sustained-condition discipline (KPR-295): first fast-fail after each
      // open transition, then silent — fastFailCount carries the volume.
      this.fastFailLoggedSinceOpen = true;
      log.warn("Provider circuit open — fast-failing turns", {
        provider: this.provider,
        reason: this.reason,
        retryAfterMs,
      });
    }
    // Invariant: reason is set on every open()/reopen() path; the fallback
    // exists only for type narrowing.
    throw new ProviderCircuitOpenError(
      this.provider,
      this.openedAt ?? now,
      retryAfterMs,
      this.reason ?? "connect-fail",
      this.lastFaultMessage,
    );
  }

  /** closed → open. The only path that increments tripCount (contract). */
  private open(now: number, reason: ProviderFaultKind | "p95-breach"): void {
    this.state = "open";
    this.openedAt = now;
    this.reason = reason;
    this.tripCount++;
    this.lastTripAt = now;
    this.fastFailLoggedSinceOpen = false;
    log.error("Provider circuit OPENED", {
      provider: this.provider,
      reason,
      consecutiveHardFaults: this.consecutiveHardFaults,
      lastFaultMessage: this.lastFaultMessage,
      cooldownMs: this.cooldownMs(),
    });
  }

  /** half-open → open (failed/inconclusive probe). Not a trip for tripCount. */
  private reopen(now: number, escalate: boolean, reason?: ProviderFaultKind): void {
    this.state = "open";
    this.openedAt = now;
    if (escalate) this.backoffExponent++;
    if (reason) this.reason = reason;
    this.fastFailLoggedSinceOpen = false;
    log.error("Provider circuit OPENED", {
      provider: this.provider,
      reason: this.reason,
      consecutiveHardFaults: this.consecutiveHardFaults,
      lastFaultMessage: this.lastFaultMessage,
      cooldownMs: this.cooldownMs(),
    });
  }

  /** half-open → closed. Resets counters, clears window, resets backoff. */
  private close(now: number): void {
    const openForMs = this.openedAt !== null ? now - this.openedAt : 0;
    this.state = "closed";
    this.openedAt = null;
    this.reason = null;
    this.consecutiveHardFaults = 0;
    this.backoffExponent = 0;
    // Clear the window so pre-outage latencies can't instantly re-trip a
    // recovered provider.
    this.window = [];
    this.windowCursor = 0;
    // Clear stale fault telemetry too — otherwise a later pure p95 trip
    // would carry a fault message from an unrelated, already-recovered
    // incident (contract: lastFaultMessage is null for pure p95 trips).
    this.lastFaultKind = null;
    this.lastFaultMessage = null;
    this.lastFaultAt = null;
    this.fastFailLoggedSinceOpen = false;
    log.info("Provider circuit CLOSED — provider recovered", {
      provider: this.provider,
      openForMs,
      tripCount: this.tripCount,
    });
  }

  private settleProbe(classification: TurnClassification, now: number, llmMs: number): void {
    if (
      classification.outcome === "success" ||
      (classification.outcome === "fault" && !HARD_FAULT_KINDS.has(classification.kind))
    ) {
      // A turn that reached the provider and failed on something else still
      // proves the provider is reachable — closes.
      this.close(now);
      if (classification.outcome === "success") {
        // Seed the fresh window with the probe's own successful latency —
        // discarding a genuine successful turn would blind the p95 window's
        // warm-up right after recovery (plan-review round-1 decision).
        this.pushSample(llmMs);
      }
      return;
    }
    if (classification.outcome === "aborted") {
      this.reopen(now, false); // inconclusive: exponent unchanged
      return;
    }
    this.reopen(now, true, classification.kind); // hard fault: cooldown doubles (capped)
  }

  private pushSample(llmMs: number): void {
    if (!Number.isFinite(llmMs) || llmMs < 0) return;
    this.window[this.windowCursor % this.config.p95WindowSize] = llmMs;
    this.windowCursor++;
  }

  private sampleCount(): number {
    return Math.min(this.windowCursor, this.config.p95WindowSize);
  }

  private computeP95(): number | null {
    const n = this.sampleCount();
    if (n === 0) return null;
    const sorted = this.window.slice(0, n).sort((a, b) => a - b);
    return sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)] ?? null;
  }
}

/**
 * Lazy per-provider breaker map. A claude-only instance gets exactly one
 * breaker and one telemetry row. Accepts a partial/absent config (test
 * mocks of appConfig may omit `circuitBreaker`) — defaults fill the gaps.
 */
export class ProviderCircuitBreakerRegistry {
  private readonly breakers = new Map<AgentProviderId, ProviderCircuitBreaker>();
  private readonly config: CircuitBreakerConfig;

  constructor(
    config?: Partial<CircuitBreakerConfig>,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  private breakerFor(provider: AgentProviderId): ProviderCircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new ProviderCircuitBreaker(provider, this.config, this.now);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /** Throws ProviderCircuitOpenError if open (and no probe permit available). */
  acquire(provider: AgentProviderId, meta?: { agentId?: string; threadId?: string }): TurnPermit {
    return this.breakerFor(provider).acquire(meta);
  }

  /** Record the outcome of a permitted turn. Idempotent per permit. */
  record(permit: TurnPermit, classification: TurnClassification, llmMs: number): void {
    this.breakers.get(permit.provider)?.record(permit, classification, llmMs);
  }

  /** null = provider never used in this process. */
  stateFor(provider: AgentProviderId): CircuitBreakerSnapshot | null {
    return this.breakers.get(provider)?.snapshot() ?? null;
  }

  getSnapshot(): Partial<Record<AgentProviderId, CircuitBreakerSnapshot>> {
    const out: Partial<Record<AgentProviderId, CircuitBreakerSnapshot>> = {};
    for (const [provider, breaker] of this.breakers) out[provider] = breaker.snapshot();
    return out;
  }
}
```

- [ ] **Step 2.2:** Create `src/agents/provider-circuit-breaker.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  ProviderCircuitBreakerRegistry,
  ProviderCircuitOpenError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
  type TurnPermit,
} from "./provider-circuit-breaker.js";
import type { TurnClassification } from "./provider-adapters/error-classification.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const hardFault = (message = "connect ECONNREFUSED"): TurnClassification => ({
  outcome: "fault",
  kind: "connect-fail",
  message,
});
const authFault = (message = "401 Unauthorized"): TurnClassification => ({
  outcome: "fault",
  kind: "auth",
  message,
});
const nonProviderFault = (): TurnClassification => ({
  outcome: "fault",
  kind: "non-provider",
  message: "tool exploded",
});
const success = (): TurnClassification => ({ outcome: "success" });
const aborted = (): TurnClassification => ({ outcome: "aborted" });

function makeRegistry(overrides: Partial<CircuitBreakerConfig> = {}) {
  let t = 0;
  const registry = new ProviderCircuitBreakerRegistry(
    { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides },
    () => t,
  );
  return {
    registry,
    advance: (ms: number) => (t += ms),
    nowValue: () => t,
    turn: (c: TurnClassification, llmMs = 100): TurnPermit => {
      const permit = registry.acquire("claude");
      registry.record(permit, c, llmMs);
      return permit;
    },
  };
}

function expectOpenThrow(fn: () => unknown): ProviderCircuitOpenError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderCircuitOpenError);
    return err as ProviderCircuitOpenError;
  }
  throw new Error("expected ProviderCircuitOpenError");
}

describe("ProviderCircuitBreaker — hard-fault trip (closed state)", () => {
  it("opens after 3 consecutive hard faults with contract-complete error fields", () => {
    const { registry, turn, nowValue } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("closed");
    turn(hardFault("connect ECONNREFUSED 127.0.0.1:443"));

    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("open");
    expect(snap.reason).toBe("connect-fail");
    expect(snap.tripCount).toBe(1);
    expect(snap.lastTripAt).toBe(nowValue());

    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.name).toBe("ProviderCircuitOpenError");
    expect(err.provider).toBe("claude");
    expect(err.openedAt).toBe(nowValue());
    expect(err.retryAfterMs).toBe(15_000);
    expect(err.reason).toBe("connect-fail");
    expect(err.lastFaultMessage).toContain("ECONNREFUSED");
  });

  it("success resets the streak", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(success());
    turn(hardFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("closed");
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(2);
  });

  it("non-provider fault resets the streak (reachability logic)", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(nonProviderFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("closed");
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(1);
  });

  it("aborted leaves the streak unchanged (inconclusive)", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(aborted());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("open");
  });

  it("auth faults trip unconditionally (delegated-assumption pin)", () => {
    const { registry, turn } = makeRegistry();
    turn(authFault());
    turn(authFault());
    turn(authFault());
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(registry.stateFor("claude")!.reason).toBe("auth");
  });

  it("record is idempotent per permit", () => {
    const { registry } = makeRegistry();
    const permit = registry.acquire("claude");
    registry.record(permit, hardFault(), 0);
    registry.record(permit, hardFault(), 0);
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(1);
  });
});

describe("ProviderCircuitBreaker — p95 trip", () => {
  it("trips on p95 breach after minSamples successful turns; lastFault untouched", () => {
    const { registry, turn } = makeRegistry({ p95WindowSize: 5, p95MinSamples: 3, p95ThresholdMs: 1_000 });
    turn(success(), 2_000);
    turn(success(), 2_000);
    expect(registry.stateFor("claude")!.state).toBe("closed"); // minSamples gate
    expect(registry.stateFor("claude")!.p95Ms).toBeNull();
    turn(success(), 2_000);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("open");
    expect(snap.reason).toBe("p95-breach");
    expect(snap.lastFaultMessage).toBeNull();
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.reason).toBe("p95-breach");
    expect(err.lastFaultMessage).toBeNull();
  });

  it("clears the window on close so stale latencies can't re-trip", () => {
    const { registry, turn, advance } = makeRegistry({
      p95WindowSize: 5,
      p95MinSamples: 3,
      p95ThresholdMs: 1_000,
    });
    turn(success(), 2_000);
    turn(success(), 2_000);
    turn(success(), 2_000); // open (p95)
    advance(15_000);
    turn(success(), 50); // probe succeeds → closed + window cleared
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.sampleCount).toBe(1); // only the probe's own sample
    expect(snap.p95Ms).toBeNull();
  });

  it("close() clears stale fault telemetry — a later p95 trip pins lastFaultMessage null", () => {
    const { registry, turn, advance } = makeRegistry({
      p95WindowSize: 5,
      p95MinSamples: 3,
      p95ThresholdMs: 1_000,
    });
    turn(hardFault());
    turn(hardFault());
    turn(hardFault()); // opens; lastFaultMessage set to the hard-fault text
    advance(15_000);
    turn(success(), 50); // probe succeeds → closed; lastFault* must be cleared
    turn(success(), 2_000);
    turn(success(), 2_000); // 3rd sample — p95 breach, pure latency trip
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("open");
    expect(snap.reason).toBe("p95-breach");
    expect(snap.lastFaultMessage).toBeNull(); // not the stale hard-fault message
  });
});

describe("ProviderCircuitBreaker — open / half-open / recovery", () => {
  function tripped(overrides: Partial<CircuitBreakerConfig> = {}) {
    const h = makeRegistry(overrides);
    h.turn(hardFault());
    h.turn(hardFault());
    h.turn(hardFault());
    return h;
  }

  it("retryAfterMs counts down; probe admitted lazily at openedAt + cooldown", () => {
    const { registry, advance } = tripped();
    advance(5_000);
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(10_000);
    advance(10_000);
    const permit = registry.acquire("claude");
    expect(permit.isProbe).toBe(true);
    expect(registry.stateFor("claude")!.state).toBe("half-open");
    expect(registry.stateFor("claude")!.probeInFlight).toBe(true);
  });

  it("CONTRACT: concurrent acquire during an in-flight probe throws with retryAfterMs === 0", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    registry.acquire("claude"); // probe out
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(0);
  });

  it("probe success closes and resets streak + backoff", () => {
    const { registry, advance, turn } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude");
    registry.record(probe, success(), 100);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveHardFaults).toBe(0);
    expect(snap.openedAt).toBeNull();
    expect(snap.reason).toBeNull();
    // Backoff reset: re-trip → first cooldown is base again.
    turn(hardFault());
    turn(hardFault());
    turn(hardFault());
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(15_000);
  });

  it("probe non-provider fault closes (reachability proves provider up)", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude");
    registry.record(probe, nonProviderFault(), 0);
    expect(registry.stateFor("claude")!.state).toBe("closed");
  });

  it("probe hard fault reopens with doubled cooldown, capped at openMaxMs", () => {
    const { registry, advance } = tripped();
    // failed probe #1 → cooldown 30s
    advance(15_000);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(30_000);
    // failed probe #2 → cooldown 60s
    advance(30_000);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(60_000);
    // failed probe #3 → still capped at 60s
    advance(60_000);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(60_000);
  });

  it("aborted probe reopens without backoff escalation", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    registry.record(registry.acquire("claude"), aborted(), 0);
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(15_000);
  });

  it("tripCount counts closed→open only (reopen is not a trip)", () => {
    const { registry, advance, turn } = tripped();
    expect(registry.stateFor("claude")!.tripCount).toBe(1);
    advance(15_000);
    registry.record(registry.acquire("claude"), hardFault(), 0); // reopen
    expect(registry.stateFor("claude")!.tripCount).toBe(1);
    advance(30_000);
    registry.record(registry.acquire("claude"), success(), 100); // close
    turn(hardFault());
    turn(hardFault());
    turn(hardFault()); // second real trip
    expect(registry.stateFor("claude")!.tripCount).toBe(2);
  });

  it("late permit (acquired closed, recorded after trip) never transitions state", () => {
    const { registry } = makeRegistry();
    const late = registry.acquire("claude"); // closed at acquire time
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0); // open
    registry.record(late, success(), 100); // must NOT close the breaker
    expect(registry.stateFor("claude")!.state).toBe("open");
  });

  it("stale probe permit is reconciled as inconclusive on next acquire", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude"); // never recorded
    expect(probe.isProbe).toBe(true);
    advance(360_001);
    // Reconciliation reopens (exponent unchanged) and this acquire hits the
    // fresh cooldown window.
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(15_000);
    expect(registry.stateFor("claude")!.probeInFlight).toBe(false);
    // After the fresh cooldown a new probe is admitted.
    advance(15_000);
    expect(registry.acquire("claude").isProbe).toBe(true);
  });

  it("fastFailCount counts rejected turns; nextProbeEligibleAt surfaces in snapshot", () => {
    const { registry, nowValue } = tripped();
    expectOpenThrow(() => registry.acquire("claude"));
    expectOpenThrow(() => registry.acquire("claude"));
    const snap = registry.stateFor("claude")!;
    expect(snap.fastFailCount).toBe(2);
    expect(snap.nextProbeEligibleAt).toBe(nowValue() + 15_000);
  });
});

describe("ProviderCircuitBreakerRegistry — isolation, shadow mode, defaults", () => {
  it("per-provider isolation: claude open, gemini still grants", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(hardFault());
    expectOpenThrow(() => registry.acquire("claude"));
    expect(registry.acquire("gemini").provider).toBe("gemini");
    expect(registry.stateFor("gemini")!.state).toBe("closed");
  });

  it("stateFor returns null for a never-used provider; getSnapshot only carries used ones", () => {
    const { registry, turn } = makeRegistry();
    turn(success());
    expect(registry.stateFor("codex")).toBeNull();
    expect(Object.keys(registry.getSnapshot())).toEqual(["claude"]);
  });

  it("shadow mode: acquire never throws, transitions still tracked, fastFailCount stays 0", () => {
    const { registry, turn, advance } = makeRegistry({ enabled: false });
    turn(hardFault());
    turn(hardFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(registry.stateFor("claude")!.enabled).toBe(false);
    const granted = registry.acquire("claude"); // would have fast-failed
    expect(granted.isProbe).toBe(false);
    expect(registry.stateFor("claude")!.fastFailCount).toBe(0);
    // Recovery still works in shadow.
    advance(15_000);
    const probe = registry.acquire("claude");
    expect(probe.isProbe).toBe(true);
    registry.record(probe, success(), 100);
    expect(registry.stateFor("claude")!.state).toBe("closed");
  });

  it("constructor defaults fill an absent/partial config (test-mock safety)", () => {
    const registry = new ProviderCircuitBreakerRegistry(undefined, () => 0);
    const permit = registry.acquire("claude");
    expect(permit.isProbe).toBe(false);
    expect(registry.stateFor("claude")!.enabled).toBe(true);
  });
});
```

- [ ] **Step 2.3:** Verify

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts`
Expected: all tests pass.

- [ ] **Step 2.4:** Commit

```bash
git add src/agents/provider-circuit-breaker.ts src/agents/provider-circuit-breaker.test.ts
git commit -m "KPR-306: provider circuit breaker state machine + Open-Circuit Contract"
```

---

### Task 3: Config surface (`circuitBreaker` hive.yaml section)

**Files:**
- Modify: `src/config.ts` (add resolver + config key)
- Test: `src/config.test.ts` (extend)

- [ ] **Step 3.1:** In `src/config.ts`, add the import at the top (after the `autonomy.js` import at line 6):

```typescript
import { DEFAULT_CIRCUIT_BREAKER_CONFIG, type CircuitBreakerConfig } from "./agents/provider-circuit-breaker.js";
```

(No import cycle: `provider-circuit-breaker.ts` imports only the logger at runtime — `AgentProviderId` and the classification types are `import type`, erased at compile.)

- [ ] **Step 3.2:** Add the exported resolver next to `normalizeGoogleAccounts` (after line 44), following that function's pure-testable precedent:

```typescript
/**
 * KPR-306: resolve the optional hive.yaml `circuitBreaker` section.
 * Liberal-loader style (KPR-225 F3): all keys optional, unknown keys
 * ignored, non-object/garbage input → all defaults. Numbers must be finite
 * and > 0 or they fall back; p95MinSamples is clamped to p95WindowSize so a
 * misconfigured gate can't make the p95 rule unreachable silently.
 * Read once at boot (registry construction) — changes need a restart, like
 * every other hive.yaml key.
 */
export function resolveCircuitBreakerConfig(raw: unknown): CircuitBreakerConfig {
  const d = DEFAULT_CIRCUIT_BREAKER_CONFIG;
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  const windowSize = num(src.p95WindowSize, d.p95WindowSize);
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : d.enabled,
    consecutiveFaultThreshold: num(src.consecutiveFaultThreshold, d.consecutiveFaultThreshold),
    openBaseMs: num(src.openBaseMs, d.openBaseMs),
    openMaxMs: num(src.openMaxMs, d.openMaxMs),
    p95WindowSize: windowSize,
    p95MinSamples: Math.min(num(src.p95MinSamples, d.p95MinSamples), windowSize),
    p95ThresholdMs: num(src.p95ThresholdMs, d.p95ThresholdMs),
  };
}
```

- [ ] **Step 3.3:** Add the config key to the `export const config = { … }` object, immediately after the `modelRouter` block:

```typescript
  // KPR-306: provider circuit breaker (hive.yaml `circuitBreaker`, all keys
  // optional; enabled:false = shadow mode — observe + telemetry, never fast-fail).
  circuitBreaker: resolveCircuitBreakerConfig(hive.circuitBreaker),
```

- [ ] **Step 3.4:** Extend `src/config.test.ts` (append after the existing describes; the file already imports from `./config.js` under the gate env):

```typescript
import { resolveCircuitBreakerConfig } from "./config.js";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./agents/provider-circuit-breaker.js";

describe("resolveCircuitBreakerConfig (KPR-306)", () => {
  it("returns all defaults for an absent or garbage section", () => {
    expect(resolveCircuitBreakerConfig(undefined)).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(resolveCircuitBreakerConfig(null)).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(resolveCircuitBreakerConfig("nope")).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(resolveCircuitBreakerConfig([])).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  });

  it("applies per-key ?? semantics for a partial section", () => {
    const resolved = resolveCircuitBreakerConfig({ enabled: false, openBaseMs: 5_000 });
    expect(resolved.enabled).toBe(false);
    expect(resolved.openBaseMs).toBe(5_000);
    expect(resolved.consecutiveFaultThreshold).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.consecutiveFaultThreshold);
    expect(resolved.p95ThresholdMs).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.p95ThresholdMs);
  });

  it("rejects garbage-typed values back to defaults and clamps p95MinSamples to the window", () => {
    const resolved = resolveCircuitBreakerConfig({
      enabled: "yes",
      consecutiveFaultThreshold: -1,
      openBaseMs: "fast",
      p95WindowSize: 10,
      p95MinSamples: 500,
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.consecutiveFaultThreshold).toBe(3);
    expect(resolved.openBaseMs).toBe(15_000);
    expect(resolved.p95WindowSize).toBe(10);
    expect(resolved.p95MinSamples).toBe(10); // clamped
  });
});
```

- [ ] **Step 3.5:** Verify

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck`
Expected: tests pass; typecheck clean.

- [ ] **Step 3.6:** Commit

```bash
git add src/config.ts src/config.test.ts
git commit -m "KPR-306: hive.yaml circuitBreaker config section (liberal loader)"
```

---

### Task 4: Runner `timedOut` flag (timeout vs operator abort)

**Files:**
- Modify: `src/agents/agent-runner.ts:120-141` (interface), `:1811-1818` (deadline), `:2011-2019` (return)
- Test: `src/agents/agent-runner.test.ts` (extend)

- [ ] **Step 4.1:** Add the field to `RunResult` (after `aborted?: boolean;` at line 140):

```typescript
  timedOut?: boolean; // KPR-306: deadline fired; distinguishes timeout-abort from operator abort
```

- [ ] **Step 4.2:** Replace the deadline block at `:1811-1818`. Before:

```typescript
    const timeoutMs = resourceLimits?.timeoutMs ?? this.agentConfig.timeoutMs ?? 300_000; // 5 min default
    const deadline = setTimeout(() => {
      log.warn("Agent query timed out, aborting", {
        agent: this.agentConfig.id,
        timeoutMs,
      });
      this.abort();
    }, timeoutMs);
```

After:

```typescript
    const timeoutMs = resourceLimits?.timeoutMs ?? this.agentConfig.timeoutMs ?? 300_000; // 5 min default
    // KPR-306: stamp timedOut ONLY when the deadline actually cancels an
    // active query — mirrors abort()'s own null guard. The gap this closes:
    // an operator abort() nulls activeQuery immediately, BEFORE the in-flight
    // try/finally has cleared this timer; an unguarded late deadline fire
    // would then mislabel the operator abort as a timeout fault. (The
    // result-tail converse is not a race: clearTimeout(deadline) and
    // activeQuery = null run back-to-back, synchronously, in send()'s
    // finally.)
    let timedOut = false;
    const deadline = setTimeout(() => {
      if (this.activeQuery) {
        timedOut = true;
        log.warn("Agent query timed out, aborting", {
          agent: this.agentConfig.id,
          timeoutMs,
        });
        this.abort();
      }
    }, timeoutMs);
```

- [ ] **Step 4.3:** Thread the flag into the returned `RunResult` (the return at `:2011-2019`). Change the last line of the returned object literal from:

```typescript
      error, aborted: this._aborted,
```

to:

```typescript
      error, aborted: this._aborted,
      ...(timedOut ? { timedOut: true } : {}),
```

(Conditional spread keeps the field absent — not `undefined` — on non-timeout turns; additive for every downstream consumer.)

- [ ] **Step 4.4:** Extend the SDK mock in `src/agents/agent-runner.test.ts`. Next to the existing `let mockMessages: any[] | null = null;` (line ~33), add:

```typescript
let mockQueryOverride: (() => any) | null = null; // KPR-306: per-test query-object override
```

and change the mock factory's `query` entry from:

```typescript
  query: (...args: any[]) => {
    mockQuery(...args);
    return {
      close: vi.fn(),
      ...
```

to:

```typescript
  query: (...args: any[]) => {
    mockQuery(...args);
    if (mockQueryOverride) return mockQueryOverride();
    return {
      close: vi.fn(),
      ...
```

(The factory closes over the `let` lazily at call time — same mechanism `mockMessages` already relies on.)

- [ ] **Step 4.5:** Append the new describe block (reset the override in its own beforeEach/afterEach so no other suite is affected):

```typescript
describe("RunResult.timedOut (KPR-306)", () => {
  beforeEach(() => {
    mockQueryOverride = null;
  });
  afterEach(() => {
    mockQueryOverride = null;
    vi.useRealTimers();
  });

  it("deadline fire sets timedOut: true and aborted: true", async () => {
    // Query hangs until close() releases it — abort() calls activeQuery.close().
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockQueryOverride = () => ({
      close: () => release(),
      [Symbol.asyncIterator]: async function* () {
        await gate;
      },
    });
    const runner = makeRunner({ timeoutMs: 25 });
    const result = await runner.send("hi");
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
  });

  it("operator abort sets aborted only — timedOut stays unset", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    mockQueryOverride = () => ({
      close: () => release(),
      [Symbol.asyncIterator]: async function* () {
        started();
        await gate;
      },
    });
    const runner = makeRunner(); // default 300s deadline — never fires here
    const resultP = runner.send("hi");
    await startedP; // activeQuery is set before iteration begins
    runner.abort();
    const result = await resultP;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeUndefined();
  });

  it("operator-abort-then-late-deadline leaves timedOut unset (the guard's reason to exist)", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    mockQueryOverride = () => ({
      close: vi.fn(), // deliberately does NOT release — keeps the finally (and clearTimeout) pending
      [Symbol.asyncIterator]: async function* () {
        started();
        await gate;
      },
    });
    const runner = makeRunner(); // 300s default deadline
    const resultP = runner.send("hi");
    await startedP;
    runner.abort(); // nulls activeQuery + sets _aborted — deadline timer still pending
    await vi.advanceTimersByTimeAsync(300_000); // late deadline fires: guard must no-op
    release(); // let the hung iterator finish so send() unwinds
    const result = await resultP;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeUndefined();
  });
});
```

- [ ] **Step 4.6:** Verify

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts`
Expected: all tests pass, including every pre-existing runner test (the mock extension is behavior-neutral when `mockQueryOverride` is null).

- [ ] **Step 4.7:** Commit

```bash
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "KPR-306: RunResult.timedOut — distinguish deadline abort from operator abort"
```

---

### Task 5: Wrap point — TurnPermit + record-once in `spawnTurn`

**Files:**
- Modify: `src/agents/agent-manager.ts` (imports, field, constructor, spawnTurn lambda)
- Test: `src/agents/agent-manager.test.ts` (extend)

- [ ] **Step 5.1:** Add imports (with the other `./`-relative imports at the top of `agent-manager.ts`):

```typescript
import { ProviderCircuitBreakerRegistry } from "./provider-circuit-breaker.js";
import { classifyThrown, classifyTurnResult } from "./provider-adapters/error-classification.js";
```

- [ ] **Step 5.2:** Add the public field to `AgentManager` (with the other private fields, before the constructor at `:334`):

```typescript
  /**
   * KPR-306: per-provider circuit breakers. Read-only surface — KPR-307's
   * dispatcher-side consumer and the CircuitBreakerHeartbeat both reach it
   * via the AgentManager instance (no new wiring surface).
   */
  readonly circuitBreakers: ProviderCircuitBreakerRegistry;
```

and initialize it in the constructor body (next to the other assignments):

```typescript
    // KPR-306: registry defaults internally when appConfig.circuitBreaker is
    // absent (test config mocks omit it).
    this.circuitBreakers = new ProviderCircuitBreakerRegistry(appConfig.circuitBreaker);
```

- [ ] **Step 5.3:** Rework the `spawnTurn` ticket lambda (`:538-591`). Replace the current lambda body with (unchanged lines carried verbatim — the KPR-220 Phase 15 comment block, the reflection re-resolve, `recordSpawn`, the KPR-224/226 shaping comment, and the reflection scheduling all stay):

```typescript
    return this.withSpawnTicket(ctx, async (ticket) => {
      // KPR-306: circuit-breaker admission — FIRST thing in the lambda, so a
      // fast-fail spends no session I/O and no model-router call. Throws
      // ProviderCircuitOpenError while the provider's circuit is open;
      // withSpawnTicket's finally releases the per-thread lock, budget slot,
      // and ticket set on the way out (no new cleanup path). The lock is
      // held for microseconds during a fast-fail — no I/O precedes the throw.
      const route = resolveProviderModel(this.registry.get(ctx.agentId)?.model ?? "");
      const permit = this.circuitBreakers.acquire(route.provider, {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
      });

      // KPR-220 Phase 15: re-resolve sessionId post-lock for reflection
      // turns. The reflection timer may have fired while a user turn was
      // in flight on the same thread; that turn could have rotated the
      // session post-compaction, so the sessionId captured at timer-fire
      // time is potentially stale. Reading sessionStore HERE (after the
      // per-thread lock is held) closes the race because no other turn
      // can be writing to it. Non-reflection callers keep their original
      // ctx.sessionId — they always resolve immediately before calling
      // spawnTurn, so the window is microseconds and tolerated.
      let effectiveCtx = ctx;
      if (ctx.kind === "reflection") {
        const freshSessionId = await this.sessionStore.get(ctx.agentId, ctx.threadId);
        if (freshSessionId !== ctx.sessionId) {
          effectiveCtx = { ...ctx, sessionId: freshSessionId };
        }
      }

      if (!effectiveCtx.sessionId) this.recordSpawn(effectiveCtx.workItem.source.id);

      // KPR-224 + KPR-226: shape prompt + resolve model router once at the
      // spawnTurn level so both the happy-path call and any auth-rebuild
      // retry use the same shaped values, and recordSpawnObservability sees
      // prompt / modelOverride in scope. Kept INSIDE the HOF lambda so any
      // throw in shaping (e.g., formatFilesForPrompt on malformed file
      // metadata) cannot leak the per-thread lock or budget slot — KPR-226
      // regression prevention.
      const shaping = await this.prepareSpawn(effectiveCtx);

      // KPR-306: exactly one breaker record per spawnTurn, on the FINALIZED
      // attempt. The auth-rebuild first attempt is locally recoverable —
      // when the retry fires, only the retry's result reaches the breaker
      // (record-once falls out of recording whichever result becomes the
      // turn result). Thrown adapter errors (rare pre-request throws, e.g.
      // codex missing OAuth) classify via classifyThrown and rethrow.
      // AgentStoppedError never originates inside this try (stop checkpoints
      // live in withSpawnTicket), and ProviderCircuitOpenError cannot reach
      // it (acquire threw before a permit existed) — the guard is
      // belt-and-braces for future refactors.
      let finalResult: RunResult;
      try {
        finalResult = await this.runOneSpawnAttempt(effectiveCtx, shaping, ticket, onStream);
        if (finalResult.error && isAuthRebuildResumeError(finalResult.error) && effectiveCtx.sessionId) {
          log.warn("spawnTurn auth-rebuild-resume — retrying without resume", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            reason: finalResult.error,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
          );
        }
      } catch (err) {
        if (!(err instanceof AgentStoppedError)) {
          this.circuitBreakers.record(permit, classifyThrown(err), 0);
        }
        throw err;
      }
      this.circuitBreakers.record(permit, classifyTurnResult(finalResult), finalResult.llmMs);

      const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult);
      this.recordSpawnObservability(effectiveCtx, shaping.prompt, shaping.modelOverride, finalResult);

      // KPR-220 Phase 6: post-quiescence reflection scheduling. Reflection
      // turns themselves don't reschedule (kind="reflection" guard).
      if (effectiveCtx.kind !== "reflection") {
        this.scheduleReflectionIfEligible(effectiveCtx, turnResult);
      }
      return turnResult;
    });
```

Semantics preserved from the old branch structure: the retry fires under the identical condition; `finalizeSpawnResult` + `recordSpawnObservability` receive whichever result was final (previously `retry` in one arm, `result` in the other — now the single `finalResult`).

- [ ] **Step 5.4:** Extend `src/agents/agent-manager.test.ts` with a new describe nested *inside* the existing `spawnTurn (KPR-216)` describe (it closes at line ~1950 — insert this new describe as the last child, just before that closing `});`). Nesting is required, not stylistic: `smsCtx` is a `function` declared inside `spawnTurn (KPR-216)` (test file line 792), not hoisted to module scope — a sibling describe placed after the block would not have it in scope. `makeRunResult`/`mockRunnerSend` are already module-level and available either way. Also add to the imports:

```typescript
import { ProviderCircuitBreakerRegistry, ProviderCircuitOpenError } from "./provider-circuit-breaker.js";
```

```typescript
    // Nested inside `spawnTurn (KPR-216)` (not a sibling) so `smsCtx` stays in
    // scope — it's a local `function` declared at the top of that describe,
    // not module-level. `routeModel` is already imported/mocked module-wide
    // (see the existing `import { routeModel } from "./model-router.js"`).
    describe("provider circuit breaker at the wrap point (KPR-306)", () => {
      // agent-a's model is a bare id in these fixtures → provider "claude".
      const CONNECT_FAIL = "TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:443";

      async function tripBreaker(threadPrefix = "trip") {
        for (let i = 0; i < 3; i++) {
          mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: CONNECT_FAIL }));
          await manager.spawnTurn(smsCtx({ threadId: `sms:line-1:${threadPrefix}-${i}` }));
        }
      }

      it("three consecutive hard faults open the breaker; the next spawnTurn fast-fails before the adapter", async () => {
        await tripBreaker();
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("open");

        const callsBefore = mockRunnerSend.mock.calls.length;
        await expect(manager.spawnTurn(smsCtx({ threadId: "sms:line-1:fast-fail" }))).rejects.toBeInstanceOf(
          ProviderCircuitOpenError,
        );
        // Adapter never invoked for the fast-failed turn (pre-prepareSpawn throw).
        expect(mockRunnerSend.mock.calls.length).toBe(callsBefore);
        // Rejection lands before the router too (pre-prepareSpawn/router property, pinned directly).
        expect(routeModel).not.toHaveBeenCalled();
      });

      it("fast-fail releases the ticket cleanly: no active spawns, no lock leak, repeatable", async () => {
        await tripBreaker();
        const threadId = "sms:line-1:cleanliness";
        await expect(manager.spawnTurn(smsCtx({ threadId }))).rejects.toBeInstanceOf(ProviderCircuitOpenError);

        const perAgent = manager.getSnapshot().perAgent["agent-a"];
        expect(perAgent?.activeSpawns ?? 0).toBe(0);
        expect(perAgent?.activeThreadKeys ?? []).toEqual([]);

        // Same thread again: rejects with the breaker error — NOT a budget or
        // lock error — proving the finally released everything.
        await expect(manager.spawnTurn(smsCtx({ threadId }))).rejects.toBeInstanceOf(ProviderCircuitOpenError);
      });

      it("record-once under auth-rebuild retry: only the retry's outcome feeds the breaker", async () => {
        // First attempt: auth sentinel (with a resumable session) → retried.
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        // Retry: success.
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "recovered", sessionId: "s2" }));
        await manager.spawnTurn(smsCtx({ sessionId: "s1", threadId: "sms:line-1:auth-retry" }));

        const snap = manager.circuitBreakers.stateFor("claude")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0); // retry success recorded, first attempt never counted
      });

      it("auth-rebuild retry that also fails records exactly one auth fault", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        await manager.spawnTurn(smsCtx({ sessionId: "s1", threadId: "sms:line-1:auth-fail" }));
        expect(manager.circuitBreakers.stateFor("claude")!.consecutiveHardFaults).toBe(1);
      });

      it("a thrown adapter error is classified and rethrown", async () => {
        mockRunnerSend.mockRejectedValueOnce(new Error("fetch failed"));
        await expect(manager.spawnTurn(smsCtx({ threadId: "sms:line-1:thrown" }))).rejects.toThrow("fetch failed");
        expect(manager.circuitBreakers.stateFor("claude")!.consecutiveHardFaults).toBe(1);
      });

      it("non-provider errors (tool failures) never trip", async () => {
        for (let i = 0; i < 5; i++) {
          mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "tool handler exploded: boom" }));
          await manager.spawnTurn(smsCtx({ threadId: `sms:line-1:np-${i}` }));
        }
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("closed");
      });

      it("probe recovery end-to-end: post-cooldown turn is admitted and closes the breaker", async () => {
        // Swap in a registry with an injected clock (readonly is compile-time only).
        let t = 0;
        (manager as unknown as { circuitBreakers: ProviderCircuitBreakerRegistry }).circuitBreakers =
          new ProviderCircuitBreakerRegistry(undefined, () => t);
        await tripBreaker("probe");
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("open");

        t += 15_000; // past cooldown — next real turn becomes the probe
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "back", sessionId: "s-probe" }));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:probe-turn" }));
        expect(result.finalMessage).toBe("back");
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("closed");
      });
    });
```

Note: existing suites already resolve `mockRunnerSend` with error strings like `"boom"` or auth sentinels 1–2 times per test — all either non-provider (streak reset) or below the threshold of 3, and every test gets a fresh manager from `beforeEach`, so no existing test can trip the breaker. If a HEAD-drifted test does, fix the test's fixture (distinct manager or non-provider error string), not the breaker.

- [ ] **Step 5.5:** Verify

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
Expected: all tests pass — the full pre-existing spawnTurn/shaping/snapshot suites plus the new describe.

- [ ] **Step 5.6:** Commit

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-306: circuit-breaker acquire/record-once at the spawnTurn wrap point"
```

---

### Task 6: Telemetry heartbeat + doctor section

**Files:**
- Create: `src/agents/circuit-breaker-heartbeat.ts`
- Create: `src/agents/circuit-breaker-heartbeat.test.ts`
- Modify: `src/index.ts` (wiring), `src/cli/doctor-checks.ts`, `src/cli/doctor.ts`
- Test: `src/cli/doctor-checks.test.ts`, `src/cli/doctor.test.ts` (extend)

- [ ] **Step 6.1:** Create `src/agents/circuit-breaker-heartbeat.ts` (structural copy of `spawn-coordinator-heartbeat.ts`):

```typescript
import type { Collection } from "mongodb";
import type { AgentManager } from "./agent-manager.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("circuit-breaker-heartbeat");

/**
 * KPR-306: periodic heartbeat that snapshots the per-provider circuit
 * breakers into `db.telemetry` (kind = `circuit_breaker_stats`). Structural
 * copy of SpawnCoordinatorHeartbeat: 30s cadence, per-key upsert (one doc
 * per provider, keyed by `{ kind, provider }`), unref'd interval, writeOnce
 * for boot + tests, write failures warned and swallowed.
 *
 * Only providers that have been used get rows (the registry is lazy) — a
 * claude-only instance heartbeats one row, not four. Snapshot timestamps are
 * epoch ms; `updatedAt` (Date) is the doctor's staleness signal.
 */
export class CircuitBreakerHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "circuit_breaker_stats";

  private timer: NodeJS.Timeout | null = null;
  private readonly agentManager: AgentManager;
  private readonly telemetryCollection: Collection;
  private readonly intervalMs: number;

  constructor(
    agentManager: AgentManager,
    telemetryCollection: Collection,
    options?: { intervalMs?: number },
  ) {
    this.agentManager = agentManager;
    this.telemetryCollection = telemetryCollection;
    this.intervalMs = options?.intervalMs ?? CircuitBreakerHeartbeat.INTERVAL_MS;
  }

  /** Writes one full snapshot batch. Exposed for tests + initial boot write. */
  async writeOnce(): Promise<void> {
    const snapshot = this.agentManager.circuitBreakers.getSnapshot();
    const updatedAt = new Date();
    const ops: Array<Promise<unknown>> = [];
    for (const [provider, perProvider] of Object.entries(snapshot)) {
      ops.push(
        this.telemetryCollection
          .updateOne(
            { kind: CircuitBreakerHeartbeat.TELEMETRY_KIND, provider },
            { $set: { ...perProvider, updatedAt } },
            { upsert: true },
          )
          .catch((err) =>
            log.warn("circuit-breaker heartbeat write failed", {
              provider,
              error: String(err),
            }),
          ),
      );
    }
    await Promise.all(ops);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.writeOnce().catch((err) =>
        log.warn("circuit-breaker heartbeat tick failed", { error: String(err) }),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 6.2:** Create `src/agents/circuit-breaker-heartbeat.test.ts` (mirror `spawn-coordinator-heartbeat.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreakerHeartbeat } from "./circuit-breaker-heartbeat.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeMockAgentManager(snapshot: Record<string, unknown>) {
  return { circuitBreakers: { getSnapshot: vi.fn().mockReturnValue(snapshot) } };
}

function makeMockTelemetryCollection() {
  return { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
}

const claudeSnap = {
  provider: "claude",
  state: "open",
  enabled: true,
  openedAt: 1_000,
  reason: "connect-fail",
  consecutiveHardFaults: 3,
  tripCount: 1,
  lastTripAt: 1_000,
  fastFailCount: 7,
  lastFaultKind: "connect-fail",
  lastFaultMessage: "fetch failed",
  lastFaultAt: 999,
  p95Ms: null,
  sampleCount: 0,
  probeInFlight: false,
  nextProbeEligibleAt: 16_000,
};

describe("CircuitBreakerHeartbeat (KPR-306)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writeOnce upserts one document per provider under {kind, provider}", async () => {
    const am = makeMockAgentManager({ claude: claudeSnap, gemini: { ...claudeSnap, provider: "gemini", state: "closed" } });
    const coll = makeMockTelemetryCollection();
    const hb = new CircuitBreakerHeartbeat(am as any, coll as any);
    await hb.writeOnce();

    expect(coll.updateOne).toHaveBeenCalledTimes(2);
    const call = coll.updateOne.mock.calls.find((c: any[]) => c[0].provider === "claude")!;
    expect(call[0]).toEqual({ kind: "circuit_breaker_stats", provider: "claude" });
    expect(call[1].$set.state).toBe("open");
    expect(call[1].$set.fastFailCount).toBe(7);
    expect(call[1].$set.updatedAt).toBeInstanceOf(Date);
    expect(call[2]).toEqual({ upsert: true });
  });

  it("writeOnce is a no-op for an empty snapshot (no providers used yet)", async () => {
    const coll = makeMockTelemetryCollection();
    const hb = new CircuitBreakerHeartbeat(makeMockAgentManager({}) as any, coll as any);
    await hb.writeOnce();
    expect(coll.updateOne).not.toHaveBeenCalled();
  });

  it("swallows per-provider write failures (never throws)", async () => {
    const coll = makeMockTelemetryCollection();
    coll.updateOne.mockRejectedValueOnce(new Error("mongo down"));
    const hb = new CircuitBreakerHeartbeat(makeMockAgentManager({ claude: claudeSnap }) as any, coll as any);
    await expect(hb.writeOnce()).resolves.toBeUndefined();
  });

  it("start() ticks on the interval; stop() cancels", async () => {
    const coll = makeMockTelemetryCollection();
    const hb = new CircuitBreakerHeartbeat(makeMockAgentManager({ claude: claudeSnap }) as any, coll as any, {
      intervalMs: 1_000,
    });
    hb.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(coll.updateOne).toHaveBeenCalledTimes(3);
    hb.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(coll.updateOne).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 6.3:** Wire into `src/index.ts`. Import next to the spawn-coordinator import (line ~25):

```typescript
import { CircuitBreakerHeartbeat } from "./agents/circuit-breaker-heartbeat.js";
```

Construct directly after `spawnCoordinatorHeartbeat.start();` (line ~515):

```typescript
  // KPR-306: provider circuit-breaker stats heartbeat — same cadence and
  // shape as the spawn-coordinator heartbeat; one telemetry row per provider
  // that has actually been used (lazy registry — boot writeOnce is a no-op
  // until the first turn).
  const circuitBreakerHeartbeat = new CircuitBreakerHeartbeat(agentManager, telemetryCollection);
  await circuitBreakerHeartbeat.writeOnce();
  circuitBreakerHeartbeat.start();
```

Stop next to `spawnCoordinatorHeartbeat.stop();` in the shutdown path (line ~810):

```typescript
    circuitBreakerHeartbeat.stop();
```

- [ ] **Step 6.4:** Add the doctor reader to `src/cli/doctor-checks.ts` (after `spawnCoordinatorStatsForDoctor`, line ~375):

```typescript
/**
 * KPR-306: per-provider circuit-breaker snapshot row from `telemetry`
 * (kind=circuit_breaker_stats heartbeat). Informational only — D4.
 */
export interface CircuitBreakerRow {
  provider: string;
  state: "closed" | "open" | "half-open";
  enabled: boolean;
  reason: string | null;
  consecutiveHardFaults: number;
  tripCount: number;
  lastTripAt: number | null;
  fastFailCount: number;
  lastFaultMessage: string | null;
  p95Ms: number | null;
  sampleCount: number;
  probeInFlight: boolean;
  openedAt: number | null;
  nextProbeEligibleAt: number | null;
  /** Seconds since the engine last wrote this doc; null if no doc found yet. */
  staleSeconds: number | null;
}

/**
 * Read-only doctor adapter for `kind="circuit_breaker_stats"` heartbeat docs.
 * Mirrors `spawnCoordinatorStatsForDoctor` — short-lived MongoClient,
 * defaults for missing fields, empty array on error, sorted by provider.
 */
export async function circuitBreakerStatsForDoctor(uri: string, dbName: string): Promise<CircuitBreakerRow[]> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const docs = await client
      .db(dbName)
      .collection("telemetry")
      .find<{
        provider?: string;
        state?: "closed" | "open" | "half-open";
        enabled?: boolean;
        reason?: string | null;
        consecutiveHardFaults?: number;
        tripCount?: number;
        lastTripAt?: number | null;
        fastFailCount?: number;
        lastFaultMessage?: string | null;
        p95Ms?: number | null;
        sampleCount?: number;
        probeInFlight?: boolean;
        openedAt?: number | null;
        nextProbeEligibleAt?: number | null;
        updatedAt?: Date;
      }>({ kind: "circuit_breaker_stats" })
      .toArray();
    return docs
      .filter((d) => typeof d.provider === "string")
      .map((d) => {
        const updatedAt = d.updatedAt instanceof Date ? d.updatedAt : null;
        return {
          provider: d.provider as string,
          state: d.state ?? "closed",
          enabled: d.enabled ?? true,
          reason: d.reason ?? null,
          consecutiveHardFaults: d.consecutiveHardFaults ?? 0,
          tripCount: d.tripCount ?? 0,
          lastTripAt: d.lastTripAt ?? null,
          fastFailCount: d.fastFailCount ?? 0,
          lastFaultMessage: d.lastFaultMessage ?? null,
          p95Ms: d.p95Ms ?? null,
          sampleCount: d.sampleCount ?? 0,
          probeInFlight: d.probeInFlight ?? false,
          openedAt: d.openedAt ?? null,
          nextProbeEligibleAt: d.nextProbeEligibleAt ?? null,
          staleSeconds: updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 1000) : null,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  } catch {
    return [];
  } finally {
    await client.close().catch(() => {});
  }
}
```

- [ ] **Step 6.5:** Add the renderer to `src/cli/doctor.ts` (after `renderSpawnCoordinatorSection`, line ~144; add `CircuitBreakerRow` + `circuitBreakerStatsForDoctor` to the existing `doctor-checks.js` import):

```typescript
/**
 * KPR-306: render the per-provider circuit-breaker section. INFORMATIONAL
 * tier (Gate 1 D4) — a trip is an incident signal, not a doctor failure;
 * this section never affects the exit code. Same >120s staleness threshold
 * as the sibling sections.
 */
export function renderCircuitBreakerSection(
  rows: CircuitBreakerRow[],
  emit: (line: string) => void = console.log,
): void {
  emit("\nProvider circuit breakers (live engine, per provider)");
  if (rows.length === 0) {
    emit("  ○ no heartbeat yet — start the engine and re-check");
    return;
  }
  for (const r of rows) {
    const stale = r.staleSeconds === null ? "?" : `${r.staleSeconds}s ago`;
    const flags: string[] = [];
    if (r.state === "open") flags.push("OPEN");
    if (r.state === "half-open") flags.push("HALF-OPEN");
    if (!r.enabled) flags.push("shadow");
    if (r.staleSeconds !== null && r.staleSeconds > 120) flags.push("stale-heartbeat");
    const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
    let body: string;
    if (r.state === "closed") {
      const p95 = r.p95Ms === null ? "n/a" : `${Math.round(r.p95Ms / 1000)}s`;
      body = `state=closed trips=${r.tripCount} consec-faults=${r.consecutiveHardFaults} p95=${p95} (n=${r.sampleCount}) fast-fails=${r.fastFailCount}`;
    } else if (r.state === "open") {
      const opened = r.openedAt === null ? "?" : `${Math.round((Date.now() - r.openedAt) / 1000)}s ago`;
      const nextProbe =
        r.nextProbeEligibleAt === null
          ? "?"
          : `${Math.max(0, Math.round((r.nextProbeEligibleAt - Date.now()) / 1000))}s`;
      body = `state=open reason=${r.reason ?? "?"} opened ${opened}, next probe in ${nextProbe} fast-fails=${r.fastFailCount}`;
    } else {
      body = `state=half-open reason=${r.reason ?? "?"} probe-in-flight=${r.probeInFlight} fast-fails=${r.fastFailCount}`;
    }
    emit(`  ${r.provider}: ${body}${flagStr} (heartbeat ${stale})`);
    if (r.staleSeconds !== null && r.staleSeconds > 120) {
      emit("  ⚠ heartbeat is stale — engine may not be running, or stats writer is failing");
    }
    if (r.state !== "closed" && r.lastFaultMessage) {
      emit(`    last fault: ${r.lastFaultMessage}`);
    }
  }
}
```

Wire into `runDoctor` immediately after the spawn-coordinator lines (`:617-618`):

```typescript
    // KPR-306: provider circuit-breaker per-provider stats. Informational —
    // NEVER contributes to allPassed (D4).
    const breakerRows = await circuitBreakerStatsForDoctor(config.mongo.uri, config.mongo.dbName);
    renderCircuitBreakerSection(breakerRows);
```

And in the `else` (config-not-loaded) block, after the spawn-coordinator skip lines (`:629-630`):

```typescript
    console.log("\nProvider circuit breakers (live engine, per provider)");
    console.log("  ○ skipped: config not loaded");
```

- [ ] **Step 6.6:** Extend `src/cli/doctor.test.ts` with a renderer describe (same emit-collector pattern as `renderSpawnCoordinatorSection` tests at `:235-339`):

```typescript
describe("renderCircuitBreakerSection (KPR-306)", () => {
  function collect() {
    const lines: string[] = [];
    return { lines, emit: (l: string) => lines.push(l) };
  }
  const baseRow = {
    provider: "claude",
    state: "closed" as const,
    enabled: true,
    reason: null,
    consecutiveHardFaults: 0,
    tripCount: 0,
    lastTripAt: null,
    fastFailCount: 0,
    lastFaultMessage: null,
    p95Ms: null,
    sampleCount: 0,
    probeInFlight: false,
    openedAt: null,
    nextProbeEligibleAt: null,
    staleSeconds: 5,
  };

  it("renders 'no heartbeat yet' when no rows are available", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection([], emit);
    expect(lines[1]).toContain("no heartbeat yet");
  });

  it("renders a closed row with trips, streak, p95 and fast-fails", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection([{ ...baseRow, tripCount: 2, p95Ms: 41_000, sampleCount: 37, fastFailCount: 118 }], emit);
    expect(lines[1]).toContain("claude: state=closed trips=2 consec-faults=0 p95=41s (n=37) fast-fails=118");
    expect(lines[1]).not.toContain("[");
  });

  it("renders an open row with reason, next-probe countdown, [OPEN] flag and last-fault line", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection(
      [
        {
          ...baseRow,
          provider: "gemini",
          state: "open",
          reason: "connect-fail",
          openedAt: Date.now() - 45_000,
          nextProbeEligibleAt: Date.now() + 14_000,
          lastFaultMessage: "fetch failed: connect ECONNREFUSED",
          fastFailCount: 9,
        },
      ],
      emit,
    );
    expect(lines[1]).toContain("state=open reason=connect-fail");
    expect(lines[1]).toContain("[OPEN]");
    expect(lines[2]).toContain("last fault: fetch failed: connect ECONNREFUSED");
  });

  it("flags shadow mode and half-open state", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection(
      [{ ...baseRow, state: "half-open", reason: "auth", probeInFlight: true, enabled: false }],
      emit,
    );
    expect(lines[1]).toContain("state=half-open");
    expect(lines[1]).toContain("probe-in-flight=true");
    expect(lines[1]).toContain("[HALF-OPEN,shadow]");
  });

  it("warns on stale heartbeat (>120s) without any failure semantics", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection([{ ...baseRow, staleSeconds: 300 }], emit);
    expect(lines[1]).toContain("stale-heartbeat");
    expect(lines[2]).toContain("⚠ heartbeat is stale");
    // Renderer returns void — structurally incapable of flipping the exit
    // code (D4): only renderDatastoreIdentitySection returns a verdict.
    expect(renderCircuitBreakerSection([], () => {})).toBeUndefined();
  });
});
```

Add `renderCircuitBreakerSection` to the doctor.test.ts import from `./doctor.js`.

- [ ] **Step 6.7:** Extend `src/cli/doctor-checks.test.ts`: add `find` to the mongodb mock factory (line ~132) —

```typescript
  const find = vi.fn();
  const collection = vi.fn(() => ({ estimatedDocumentCount, findOne, aggregate, find }));
  ...
  return { MongoClient, __mocks: { connect, close, ping, estimatedDocumentCount, findOne, aggregate, find } };
```

— then append loader tests:

```typescript
import { circuitBreakerStatsForDoctor } from "./doctor-checks.js";

describe("circuitBreakerStatsForDoctor (KPR-306)", () => {
  beforeEach(() => {
    mongoMocks.connect.mockReset().mockResolvedValue(undefined);
    mongoMocks.close.mockReset().mockResolvedValue(undefined);
    mongoMocks.find.mockReset();
  });

  it("maps docs with defaults for missing fields and filters provider-less docs", async () => {
    const updatedAt = new Date(Date.now() - 10_000);
    mongoMocks.find.mockReturnValue({
      toArray: async () => [
        { provider: "claude", state: "open", reason: "connect-fail", tripCount: 1, updatedAt },
        { kind: "circuit_breaker_stats" }, // no provider → filtered
      ],
    });
    const rows = await circuitBreakerStatsForDoctor("mongodb://x", "hive_test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude",
      state: "open",
      reason: "connect-fail",
      tripCount: 1,
      enabled: true, // default
      fastFailCount: 0, // default
      probeInFlight: false, // default
    });
    expect(rows[0].staleSeconds).toBeGreaterThanOrEqual(9);
  });

  it("returns [] when the connection throws", async () => {
    mongoMocks.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(circuitBreakerStatsForDoctor("mongodb://x", "hive_test")).resolves.toEqual([]);
  });
});
```

- [ ] **Step 6.8:** Verify

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/circuit-breaker-heartbeat.test.ts src/cli/doctor.test.ts src/cli/doctor-checks.test.ts && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck`
Expected: all tests pass; typecheck clean (index.ts wiring compiles).

- [ ] **Step 6.9:** Commit

```bash
git add src/agents/circuit-breaker-heartbeat.ts src/agents/circuit-breaker-heartbeat.test.ts src/index.ts src/cli/doctor-checks.ts src/cli/doctor-checks.test.ts src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "KPR-306: circuit_breaker_stats heartbeat + informational doctor section"
```

---

### Task 7: CLAUDE.md updates (D5)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 7.1:** In the "MongoDB collections (engine-written)" gotcha bullet (line ~260), extend the `telemetry (…)` parenthetical — after `memory-lifecycle stats heartbeat \`memory_lifecycle_stats\` KPR-241 (per agent);` insert:

```
circuit-breaker stats heartbeat `circuit_breaker_stats` KPR-306 (per provider);
```

- [ ] **Step 7.2:** Add a new bullet to Common Gotchas (after the "Spawn budget default" bullet):

```markdown
- **Provider circuit breaker (KPR-306):** `spawnTurn` acquires a per-provider breaker permit before any model-router spend. Three consecutive hard provider faults (connect-fail/timeout/rate-limit/auth/5xx — typed classifier at `src/agents/provider-adapters/error-classification.ts`) or a p95 `llmMs` breach open the circuit; open turns fast-fail with the exported `ProviderCircuitOpenError` (Open-Circuit Contract — KPR-307 binds to it; frozen fields in `src/agents/provider-circuit-breaker.ts`). Half-open probes are real user turns (15s base cooldown, ×2 backoff, 60s cap). Tool/agent errors classify `non-provider` and never trip. Config: hive.yaml `circuitBreaker` (all keys optional; `enabled: false` = shadow mode — observe + telemetry, never fast-fail). State is in-memory (restart resets to closed); heartbeated to `db.telemetry` (`kind=circuit_breaker_stats`, per provider, 30s) and rendered as an informational `hive doctor` section (never flips the exit code).
```

- [ ] **Step 7.3:** In the Key Files list, after the `spawn-coordinator-heartbeat.ts` line (line ~69), add:

```markdown
- `src/agents/provider-circuit-breaker.ts` — per-provider circuit breaker + Open-Circuit Contract (`ProviderCircuitOpenError`, snapshot API); heartbeated by `src/agents/circuit-breaker-heartbeat.ts` (`kind=circuit_breaker_stats`)
```

- [ ] **Step 7.4:** Commit

```bash
git add CLAUDE.md
git commit -m "KPR-306: document circuit breaker in CLAUDE.md (telemetry kinds + gotchas)"
```

---

### Task 8: Full gate + final verification

- [ ] **Step 8.1:** Run the full check gate:

Run: `cd /Users/mayandmikemacmini/github/hive-mature-KPR-306 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck, lint, format, and the full vitest suite green. If `npm run format` rewrites any new file, re-stage and amend the relevant commit.

- [ ] **Step 8.2:** Grep-audit the frozen contract surface (KPR-307's binding):

Run: `grep -n "readonly provider\|readonly openedAt\|readonly retryAfterMs\|readonly reason\|readonly lastFaultMessage" src/agents/provider-circuit-breaker.ts`
Expected: all five `ProviderCircuitOpenError` fields present, names exactly as the spec's Open-Circuit Contract; `CircuitBreakerSnapshot` fields match the contract list 1:1 (compare against spec §Open-Circuit Contract).

- [ ] **Step 8.3:** Sanity-run the doctor renderer path without an engine (exercises the "no heartbeat yet" branch):

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/cli/doctor.test.ts -t "circuit"`
Expected: renderer tests pass, including the void-return (exit-code-incapable) assertion.

- [ ] **Step 8.4:** Verify commit history is clean and report the final SHA:

```bash
git log --oneline main..HEAD
```

Expected: the spec commits plus the six implementation commits from Tasks 1–7.

---

## Design Notes (binding clarifications carried from the spec)

1. **`retryAfterMs` reconciliation (gate-ordered):** the Open-Circuit Contract is authoritative — `retryAfterMs: 0` means "probe currently in flight". Concurrent half-open acquires throw with `0`, not the probe's remaining budget. Implemented in `ProviderCircuitBreaker.acquire`, pinned by the "CONTRACT:" unit test.
2. **Record-once:** exactly one `record` per `spawnTurn`, on the finalized attempt. The auth-rebuild first attempt never reaches the breaker when a retry fires; a fresh-thread first attempt (no `sessionId`) records directly. Persistent auth outages therefore classify `auth` on every recorded attempt and trip — by design (⚠ delegated assumption).
3. **Fail-safe default:** unknown error strings → `non-provider` → reset the streak, never trip. The asymmetry (stuck-open false trip vs. slower true trip) dictates the bias.
4. **No timers in the breaker:** all transitions lazy on `acquire`/`record`; injected `now` is the only clock. The heartbeat owns the single unref'd interval.
5. **`tripCount` counts closed→open only** (contract field comment); half-open→open reopens do not increment it.
6. **Shadow-mode `fastFailCount` stays literal** ("turns rejected"): nothing is rejected in shadow, so it stays 0; shadow burn-in observability comes from state/tripCount/log lines.
7. **Doctor section is structurally informational:** the renderer returns `void`; only `renderDatastoreIdentitySection` returns a verdict that `runDoctor` folds into `allPassed` (KPR-296 precedent preserved — D4).
8. **KPR-307/308 boundary:** this ticket exports the contract and the `agentManager.circuitBreakers` surface; it does NOT touch the dispatcher, WS adapter, or any outage-mode delivery logic.
