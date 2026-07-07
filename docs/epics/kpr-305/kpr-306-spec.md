# KPR-306 — Circuit breaker at the provider-adapter boundary (W2.1)

**Epic:** KPR-305 (W2) — `epic-signed-off` (Gate 1 delegated; ⚠ marks delegated design choices).
**Consumers of this spec:** the KPR-306 implementation plan, and **KPR-307**, which consumes the **Open-Circuit Contract** section below as a public interface (honest "provider is down" responses + replay queueing bind to `ProviderCircuitOpenError` and the breaker snapshot API).
**Baseline:** all file/line evidence pinned to `main` @ `08ca29e` (branch `mature/KPR-306` off epic branch `kpr-305`). This spec is written ahead of implementation (maturity-first sweep); **the implementer MUST re-confirm every line-number anchor and the adapter/error-flow claims at HEAD before coding** — `agent-manager.ts` and `agent-runner.ts` are hot files that sibling waves may move.

## TL;DR

A per-provider circuit breaker wraps the single provider-adapter execution choke point (`AgentManager.spawnTurn` → `runOneSpawnAttempt` → `adapter.runTurn`). Every finished turn is classified by a new typed error classifier (connect-fail / timeout / rate-limit / auth / server-error vs. non-provider faults like tool errors, which never trip). Three consecutive hard provider faults — or a p95 breach over the breaker's own in-memory latency window — flip the breaker to open; because connect-fails return in milliseconds, the trip lands in single-digit seconds under live traffic. While open, turns fast-fail before any model-router spend with an exported `ProviderCircuitOpenError`, releasing the spawn ticket cleanly. After a short cooldown (15s base, 60s cap, exponential), the next real user turn is admitted as a half-open probe; success closes the breaker. State is heartbeated to `db.telemetry` (`kind=circuit_breaker_stats`, 30s, per provider) and rendered as an **informational** `hive doctor` section (D4 — never flips the exit code).

## Key Points

- **Single wrap point, keyed by provider.** The check lives at the top of the `spawnTurn` ticket lambda (`src/agents/agent-manager.ts:538`), keyed by `resolveProviderModel(config.model).provider` (`:145-163`) — values are exactly `AgentProviderId` (`"claude"|"openai"|"gemini"|"codex"`, `src/agents/provider-adapters/types.ts:4`). A claude-open breaker never touches a gemini-routed agent.
- **Typed classification is new — nothing exists today.** All four adapters resolve provider faults into `RunResult.error: string` (Claude: catch-all at `agent-runner.ts:1940-1960`; codex: `codex-subscription-adapter.ts:126-151`; openai/gemini analogous — re-confirm at HEAD). The classifier (`error-classification.ts`, new) works over that string plus two flags, with **default = `non-provider` (fail-safe: unknown errors never trip)**.
- **Timeout needs one runner change:** the 300s deadline (`agent-runner.ts:1811-1818`) calls `abort()`, which is indistinguishable from an operator abort in `RunResult` today. Add `timedOut?: boolean` to `RunResult`, set by the deadline callback. Operator aborts stay breaker-neutral.
- **Trip rules:** hard trip = N consecutive hard faults (default 3, config); soft trip = p95 of the breaker's own in-memory `llmMs` ring buffer (50 samples, min 20) above threshold (default 240s ⚠). Latency is **not** persisted anywhere real-time (`agent_turn_telemetry` = tokens only; `activity_log` = batched+TTL) — the window must live in-process at the wrap point.
- **Half-open probe = the next real user turn** — no synthetic probes (they cost money and need a fabricated prompt). One probe in flight; concurrent turns keep fast-failing. Probe success or *any provider response* (even a non-provider fault) closes; a hard fault re-opens with doubled cooldown, capped at 60s so a 30-minute outage gets a recovery probe at least every minute.
- **Open-Circuit Contract for KPR-307:** exported `ProviderCircuitOpenError` (provider, openedAt, retryAfterMs, reason, lastFaultMessage) + `agentManager.circuitBreakers.getSnapshot()` / `.stateFor(provider)`. Frozen fields listed below.
- **Fast-fail is clean by construction:** the error throws inside `withSpawnTicket`'s `fn`, so the existing `finally` (`agent-manager.ts:687-706`) releases the per-thread lock, budget slot, and ticket — verified, no new cleanup path. Fast-fail happens **before** `prepareSpawn`, so no model-router Haiku spend on a doomed turn.
- **Telemetry + doctor copy existing shapes exactly:** `CircuitBreakerHeartbeat` mirrors `spawn-coordinator-heartbeat.ts` (30s, per-key upsert, unref'd timer, `writeOnce()` at boot, wired in `src/index.ts` next to `:513`); doctor section mirrors `renderSpawnCoordinatorSection` (`src/cli/doctor.ts:120-144`) — informational tier per **D4**, >120s staleness ⚠, never exit-1.
- ⚠ Delegated assumptions (own section below): default thresholds, `enabled:false` = shadow mode, auth faults trip, per-provider (not per-model) keying, `llmMs` as the latency metric.
- **Epic KPR-305 has no Decision Register canon yet (pre-register epic).** Noted per process; the Open-Circuit Contract section is the de-facto registered decision for the KPR-307 dependency. Gate 1 rulings D4/D5/D6 (recorded on KPR-305) bind this spec.

## Problem / Context

The 30-minute-outage profile: when a provider (Anthropic API, ChatGPT backend, Gemini) goes down or degrades, every inbound Slack/SMS/scheduler turn today burns the full failure path — model-router classification (a paid Haiku call), adapter construction, a connect attempt or a 300-second timeout — then surfaces `"Something went wrong: …"` per turn (`src/channels/dispatcher.ts:258-275`). There is no shared state that says "this provider is down"; each turn rediscovers the outage independently, holding a budget slot for up to 300s each. SaaS-default breaker tunings (minutes-long trip windows) are useless at this profile — by the time a minutes-window trips, the outage is half over.

Verified current state (all paths relative to repo root, pinned at `08ca29e`):

- **One execution choke point.** Every channel (Slack, SMS, WS, voice, scheduler, reflection) routes through `AgentManager.spawnTurn` (`src/agents/agent-manager.ts:531`) → `withSpawnTicket` (`:609`) → `runOneSpawnAttempt` (`:963-1003`), which builds a fresh adapter via `createProviderAdapter` (`:396-434`) and awaits `adapter.runTurn(...)` (`:990`).
- **Provider routing:** `resolveProviderModel(config.model)` (`:145-163`) returns `route.provider ∈ {"claude","openai","gemini","codex"}`; each adapter also self-reports via `readonly provider` (`types.ts:17`).
- **Errors are untyped strings, and adapters do not throw for provider faults.** `AgentRunner.send()` catches everything and flattens to `String(err)` into `RunResult.error` (`agent-runner.ts:1940-1960`); SDK non-success result subtypes also land in `error` (`:1930-1937`). `CodexSubscriptionAdapter` catches fetch/auth failures into `RunResult.error` (`codex-subscription-adapter.ts:126-151`). Thrown exceptions from `runTurn` are rare pre-request conditions (e.g. codex `assertToolFreePilot`, missing OAuth) but do exist and propagate to the dispatcher.
- **Timeout:** single deadline `resourceLimits?.timeoutMs ?? agentConfig.timeoutMs ?? 300_000` (`agent-runner.ts:1811-1818`) that calls `this.abort()` → `RunResult.aborted: true` (`:2018`). A timeout is currently indistinguishable from an operator abort in the result.
- **Latency:** `durationMs`/`llmMs` computed per turn (`agent-runner.ts:1986-1995`) but not persisted real-time — `agent_turn_telemetry` records tokens only (`agent-manager.ts:1092-1109`); `activity_log` is batched with TTL. A p95 window must be in-memory at the wrap point (Gate 1 **D5** confirms this is in-ticket scope).
- **Existing per-error observability:** `finalizeSpawnResult` already tracks `lastSpawnError` per agent (`agent-manager.ts:1174-1179`) — per-agent, not per-provider; no state machine, no fast-fail.
- **Auth-rebuild retry:** `spawnTurn` retries once, resume-stripped, when `isAuthRebuildResumeError(result.error)` matches (`:570-578`; patterns at `:185-189`). This is a locally-recoverable condition and must not double-count in the breaker.
- **Heartbeat + doctor precedents:** `src/agents/spawn-coordinator-heartbeat.ts` (30s, `TELEMETRY_KIND` constant, per-key upsert, unref'd `setInterval`, `writeOnce()` for boot + tests), wired at `src/index.ts:513-515`, stopped at `:810`; doctor reader `spawnCoordinatorStatsForDoctor` (`src/cli/doctor-checks.ts:331`), renderer `renderSpawnCoordinatorSection` (`src/cli/doctor.ts:120-144`) — informational, >120s ⚠.
- **No existing breaker code:** `grep -ri circuitbreaker src/` is empty.
- Gate 1 **D6**: the original audit artifact is unrecoverable; ticket text + this fresh code trace are the spec inputs.

## Goals

1. Classify provider-adapter turn outcomes into a typed fault taxonomy at the adapter boundary (currently untyped strings).
2. Trip a per-provider breaker in single-digit seconds on hard failures (connect-fail, timeout, server-error, rate-limit, auth) under live traffic, and on sustained p95 latency breach.
3. Fast-fail turns while open — before model-router spend — with a stable, exported error surface KPR-307 can bind to; release the spawn ticket cleanly.
4. Recover via half-open probes with capped-exponential cooldown (≤60s between probes) so provider recovery is detected within ~1 minute.
5. Surface breaker state in `db.telemetry` (`circuit_breaker_stats`, 30s per-provider heartbeat) and an informational `hive doctor` section (D4).
6. Update CLAUDE.md (telemetry kinds list + gotchas) per D5.

## Non-Goals

- **Retry/replay of failed or fast-failed turns, and honest channel-facing responses** — KPR-307's scope; it consumes the Open-Circuit Contract below. Until then, open-circuit fast-fails surface through the existing dispatcher catch (`"Something went wrong: ProviderCircuitOpenError: …"`).
- **Fail-capable doctor section.** D4 pins informational tier; escalation would need a separate explicit ruling.
- **Per-model or per-agent breakers.** Keyed by provider only (⚠ below). A single Anthropic outage takes all Claude models down together in practice; per-model keying is future work if evidence demands.
- **Timeouts for pilot adapters.** Codex/OpenAI/Gemini pilot adapters have no request deadline today (e.g. a hung codex fetch waits indefinitely); adding one is out of scope. The breaker still trips on their connect-fail/5xx strings.
- **Synthetic health probes.** Half-open probes are real user turns (design rationale below).
- **Breaker state persistence across restarts.** In-memory only; a restart resets to closed. A fresh process re-trips within seconds if the outage persists — acceptable.
- **Wrapping non-turn provider calls** (model-router Haiku classification, memory reflection LLM calls made outside `spawnTurn`, embedding calls). Reflection turns route through `spawnTurn` and *are* covered; the router call itself is not (it precedes the wrap point and has its own 10s-class timeout).

## Design

Three new files plus surgical touches, following the KPR-294/295 file-granularity precedent:

- `src/agents/provider-adapters/error-classification.ts` — fault taxonomy + classifier (new; D5 "typed error classification at the adapter boundary").
- `src/agents/provider-circuit-breaker.ts` — `ProviderCircuitBreaker` (per-provider state machine) + `ProviderCircuitBreakerRegistry` (lazy per-provider map) + `ProviderCircuitOpenError`.
- `src/agents/circuit-breaker-heartbeat.ts` — `CircuitBreakerHeartbeat`, structural copy of `spawn-coordinator-heartbeat.ts`.
- Touched: `agent-runner.ts` (one flag), `agent-manager.ts` (wrap point), `config.ts` (config section), `index.ts` (heartbeat wiring), `cli/doctor-checks.ts` + `cli/doctor.ts` (section), `CLAUDE.md`.

Logger: `createLogger("circuit-breaker")`.

### Error classification (`error-classification.ts`)

```ts
export type ProviderFaultKind =
  | "connect-fail"   // network-level: refused/reset/DNS/fetch failed
  | "timeout"        // runner deadline fired (RunResult.timedOut)
  | "rate-limit"     // 429 / rate limit / too many requests
  | "auth"           // 401/403/authentication/invalid key (post-retry only)
  | "server-error"   // 5xx / overloaded / service unavailable
  | "non-provider";  // everything else — NEVER trips the breaker

export interface TurnFaultInput {
  error?: string;        // RunResult.error
  timedOut?: boolean;    // RunResult.timedOut (new)
  aborted?: boolean;     // RunResult.aborted
}

export type TurnClassification =
  | { outcome: "success" }                       // no error, not aborted
  | { outcome: "aborted" }                       // operator abort — breaker-neutral
  | { outcome: "fault"; kind: ProviderFaultKind; message: string };

export function classifyTurnResult(input: TurnFaultInput): TurnClassification;
export function classifyThrown(err: unknown): TurnClassification;  // for adapter throws
export const HARD_FAULT_KINDS: ReadonlySet<ProviderFaultKind>;      // all kinds except "non-provider"
```

Classification order (first match wins):

1. `timedOut === true` → `fault: timeout` (even though `aborted` is also true — the deadline path sets both).
2. `aborted === true` (without `timedOut`) → `aborted` (neutral: not success, not fault; probes treat it as inconclusive).
3. No `error` → `success`.
4. `error` matched against a pattern table (case-insensitive regex, exact patterns are an implementation detail but must cover at least):
   - `connect-fail`: `ECONNREFUSED | ECONNRESET | ENOTFOUND | EAI_AGAIN | ETIMEDOUT | EPIPE | socket hang up | fetch failed | network error | terminated`
   - `rate-limit`: `\b429\b | rate.?limit | too many requests`
   - `auth`: `\b401\b | \b403\b | authentication | unauthorized | invalid.?api.?key | OAuth session is not available`
   - `server-error`: `\b5\d\d\b | overloaded | internal server error | service unavailable | bad gateway | upstream`
   - Explicit `non-provider` short-circuits (checked before the tables above where ambiguous): SDK result subtypes `error_max_turns`, `error_during_execution` (set at `agent-runner.ts:1930-1937`), and the auth-rebuild-resume sentinel patterns (`agent-manager.ts:185-189`) — the latter never reach the breaker anyway (see recording rules) but the classifier stays consistent standalone.
5. Default → `fault: non-provider`. **Fail-safe bias: an unrecognized error string must never trip the breaker.** False negatives (missed provider fault) delay a trip by one turn; false positives (tool failure tripping the breaker) take a healthy provider offline — the asymmetry dictates the default.

`classifyThrown` runs `String(err)` through the same table (default `non-provider`) — it covers the rare throw path out of `adapter.runTurn` (e.g. codex missing-OAuth throw pre-`RunResult`).

### Runner change: distinguish timeout from operator abort

In `AgentRunner.send()`: a local `let timedOut = false;` set inside the existing deadline callback (`agent-runner.ts:1812-1818`) before `this.abort()`, and a new optional field on the returned object / `RunResult` interface (`agent-runner.ts:120-141`):

```ts
export interface RunResult {
  // ... existing fields unchanged ...
  timedOut?: boolean; // KPR-306: deadline fired; distinguishes timeout-abort from operator abort
}
```

Additive and optional: `convertTurnResult` in the dispatcher and `TurnResult` need no changes (the breaker records inside `AgentManager` before finalization). Pilot adapters never set it (they have no deadline — Non-Goal).

### Breaker state machine (`provider-circuit-breaker.ts`)

One `ProviderCircuitBreaker` per provider, created lazily by `ProviderCircuitBreakerRegistry` on first use (a claude-only instance gets exactly one breaker and one telemetry row). Constructor takes `(provider, config, now: () => number = Date.now)` — the injected clock is the test seam; no timers are owned by the breaker (all transitions are evaluated lazily on `acquire`/`record`, so nothing to unref or shut down).

**States and transitions:**

```
closed ──(consecutive hard faults ≥ threshold)──────────────► open
closed ──(p95(llmMs window) > threshold, n ≥ minSamples)────► open
open ────(now ≥ openedAt + cooldown; next acquire)──────────► half-open (that acquire becomes the probe)
half-open ──(probe: success OR non-provider fault)──────────► closed  (reset counters, clear window, reset backoff)
half-open ──(probe: hard fault)─────────────────────────────► open    (backoffExponent++, cooldown doubles, cap openMaxMs)
half-open ──(probe: aborted/inconclusive)───────────────────► open    (backoffExponent unchanged)
```

**Public API (per breaker, mediated by the registry):**

```ts
interface ProviderCircuitBreakerRegistry {
  /** Throws ProviderCircuitOpenError if open (and no probe permit available). Returns a permit token. */
  acquire(provider: AgentProviderId): TurnPermit;
  /** Record the outcome of a permitted turn. Idempotent per permit. */
  record(permit: TurnPermit, classification: TurnClassification, llmMs: number): void;
  stateFor(provider: AgentProviderId): CircuitBreakerSnapshot | null;  // null = never used
  getSnapshot(): Partial<Record<AgentProviderId, CircuitBreakerSnapshot>>;
}
```

`TurnPermit` is an opaque handle carrying `{ provider, isProbe }`. Requiring `record(permit, …)` (not `record(provider, …)`) makes probe bookkeeping airtight: the half-open breaker hands out exactly one probe permit; a permit that is never recorded (caller crashed between acquire and record — impossible given the `try/finally` shape below, but belt-and-braces) is reconciled by a staleness check on the next `acquire` (probe permit older than the effective turn deadline + 60s is considered inconclusive).

**Trip rules (closed state):**

- *Hard:* `consecutiveHardFaults >= consecutiveFaultThreshold` (default **3**) → open. Counted per `HARD_FAULT_KINDS`; `success` resets the counter; `non-provider` faults and `aborted` leave it unchanged (they neither confirm nor deny provider health). Under an outage with live traffic, connect-fails complete in milliseconds → three inbound turns trip the breaker in **single-digit seconds** (the ticket's bar). A quiet instance trips slower — acceptable, since fast-fail only matters when traffic exists.
- *Soft (p95):* ring buffer of the last `p95WindowSize` (default **50**) `llmMs` samples from **successful turns only** (failed turns contribute via the fault path; `llmMs` rather than `durationMs` so tool-heavy turns don't false-trip — pilot adapters report `llmMs == durationMs`, consistent). Evaluated after each insertion; requires `sampleCount >= p95MinSamples` (default **20**); p95 computed by sorting a copy of the window (50 elements — cost is noise). `p95 > p95ThresholdMs` (default **240_000**, i.e. 80% of the 300s default turn deadline ⚠) → open with `reason: "p95-breach"`. The window is cleared on every close transition so pre-outage latencies can't instantly re-trip a recovered provider.

**Open state:** `cooldownMs = min(openBaseMs * 2^backoffExponent, openMaxMs)` (defaults **15_000** base, **60_000** cap). `acquire` during cooldown throws `ProviderCircuitOpenError`. First `acquire` at/after `openedAt + cooldownMs` transitions to half-open and returns a probe permit — lazy transition, no timer.

**Half-open:** exactly one probe in flight; concurrent `acquire`s throw `ProviderCircuitOpenError` (with `retryAfterMs` reflecting the probe's remaining deadline budget). Probe outcome mapping is in the transition table above; the "non-provider fault closes" rule is deliberate — a turn that reached the provider and failed on a tool proves the provider is reachable.

**Why real-turn probes, not synthetic:** a synthetic probe needs a fabricated prompt, spends real money per probe, and exercises a different code path than production turns (no MCP assembly, no session resume) — it can pass while real turns still fail. A real turn as probe risks one user-visible slow failure per ≤60s during an outage, which KPR-307 will convert into an honest "provider still down" response. YAGNI resolves to real turns.

**Enabled flag (⚠):** `circuitBreaker.enabled: false` puts the registry in **shadow mode** — `acquire` always grants (never throws), `record` still classifies, counts, and feeds telemetry, state transitions still occur and are logged. This gives operators a burn-in period with full observability before fast-fail goes live. Default `enabled: true`.

### Wrap point (`agent-manager.ts`)

`AgentManager` constructs the registry in its constructor from `appConfig.circuitBreaker` and exposes it read-only:

```ts
readonly circuitBreakers: ProviderCircuitBreakerRegistry;
```

(KPR-307's dispatcher-side consumer and the heartbeat both reach it via the `AgentManager` instance — no new wiring surface.)

Inside the `spawnTurn` ticket lambda (`agent-manager.ts:538`), **before** `prepareSpawn` (so a fast-fail spends no model-router call):

```ts
const route = resolveProviderModel(this.registry.get(ctx.agentId)!.model);
const permit = this.circuitBreakers.acquire(route.provider); // throws ProviderCircuitOpenError when open
```

and the turn body wraps so exactly one `record` happens per spawnTurn, on the **finalized** attempt:

- Happy path / non-auth-retry: classify the `RunResult` chosen at `:579-581` and `record(permit, classification, result.llmMs)`.
- Auth-rebuild retry path (`:570-578`): the first attempt's auth-rebuild sentinel is a locally-recoverable condition — **only the retry's result is recorded**. (Recording once per spawnTurn, on whichever result becomes `turnResult`, implements this for free.)
- Thrown path: a `catch` around the attempt classifies via `classifyThrown(err)`, records, and rethrows — except `AgentStoppedError` and `ProviderCircuitOpenError` themselves, which are recorded as nothing (the former is coordinator state, the latter never acquired… `acquire` throws before a permit exists, so there is nothing to record by construction).

Ticket-lifecycle safety: `ProviderCircuitOpenError` propagates out of `fn` and `withSpawnTicket`'s existing `finally` (`:687-706`) releases the thread lock, budget slot, and ticket set — verified at baseline; no new cleanup code. The per-thread lock is *held briefly* during a fast-fail (microseconds — no I/O happens before the throw), which is correct: it keeps probe serialization and stop-checkpoint semantics unchanged.

Reflection turns route through `spawnTurn` and are therefore breaker-covered; a fast-failed reflection is swallowed non-critically by the existing catch (`:917-919`). Voice's direct `spawnTurn` call is covered identically.

Interaction with abort machinery: `ticket.attachAbort(() => adapter.abort())` (`:978`) is untouched. An operator abort mid-probe yields `aborted` → inconclusive → back to open without backoff escalation.

### Open-Circuit Contract (stable interface — KPR-307 depends on this)

Exported from `src/agents/provider-circuit-breaker.ts`. **Frozen fields** — KPR-307 binds to these; additive evolution only:

```ts
export class ProviderCircuitOpenError extends Error {
  readonly name: "ProviderCircuitOpenError";
  readonly provider: AgentProviderId;
  /** Epoch ms when the breaker (most recently) opened. */
  readonly openedAt: number;
  /** ms from now until the next half-open probe is eligible (0 = probe currently in flight). */
  readonly retryAfterMs: number;
  /** What tripped it: a hard fault kind, or "p95-breach". */
  readonly reason: ProviderFaultKind | "p95-breach";
  /** Last classified fault message, truncated to 240 chars; null for pure p95 trips. */
  readonly lastFaultMessage: string | null;
}

export interface CircuitBreakerSnapshot {
  provider: AgentProviderId;
  state: "closed" | "open" | "half-open";
  enabled: boolean;              // false = shadow mode
  openedAt: number | null;
  reason: ProviderFaultKind | "p95-breach" | null;
  consecutiveHardFaults: number;
  tripCount: number;             // lifetime (process) count of closed→open transitions
  lastTripAt: number | null;
  fastFailCount: number;         // turns rejected while open (process lifetime)
  lastFaultKind: ProviderFaultKind | null;
  lastFaultMessage: string | null;  // truncated 240
  lastFaultAt: number | null;
  p95Ms: number | null;          // null until minSamples reached
  sampleCount: number;
  probeInFlight: boolean;
  nextProbeEligibleAt: number | null;  // epoch ms; null unless open
}
```

Detection guidance for KPR-307: match `err instanceof ProviderCircuitOpenError` (same-process, in-repo — instanceof is safe; no serialization boundary). For proactive checks (e.g. "should I queue instead of dispatch"), use `agentManager.circuitBreakers.stateFor(provider)`.

### Config surface (`config.ts` + hive.yaml)

New optional hive.yaml section, liberal-loader style (all keys optional, `??` defaults, follows the `imessage` block pattern at `config.ts:209-215`; KPR-225 F3 — unknown keys ignored, absent section = all defaults):

```yaml
circuitBreaker:
  enabled: true                  # false = shadow mode (observe, never fast-fail)
  consecutiveFaultThreshold: 3   # hard faults in a row to trip
  openBaseMs: 15000              # first cooldown before a half-open probe
  openMaxMs: 60000               # cooldown cap (exponential backoff ceiling)
  p95WindowSize: 50              # llmMs ring-buffer size
  p95MinSamples: 20              # samples required before p95 is evaluated
  p95ThresholdMs: 240000         # p95 above this trips (reason: p95-breach)
```

Typed as `CircuitBreakerConfig` on `appConfig.circuitBreaker`. No env vars, no secrets — pure hive.yaml. Values are read once at boot (registry construction); changing them requires an engine restart (same as every other hive.yaml key — no hot-reload claim).

### Telemetry (`circuit_breaker_stats`)

`CircuitBreakerHeartbeat` (`src/agents/circuit-breaker-heartbeat.ts`) — structural copy of `SpawnCoordinatorHeartbeat`: `INTERVAL_MS = 30_000`, `TELEMETRY_KIND = "circuit_breaker_stats"`, per-key upsert on `{ kind, provider }`, `$set: { ...snapshot, updatedAt }`, unref'd `setInterval`, `writeOnce()` exposed for boot + tests, write failures `log.warn` and swallowed. Document body = `CircuitBreakerSnapshot` verbatim + `updatedAt: Date`. Only providers that have been used get rows (lazy registry) — a claude-only instance heartbeats one row, not four.

Wiring in `src/index.ts` `main()`, adjacent to the spawn-coordinator heartbeat (`:513-515` at baseline): construct with `(agentManager, telemetryCollection)`, `await writeOnce()`, `start()`; `stop()` in the shutdown path next to `spawnCoordinatorHeartbeat.stop()` (`:810`). Uses the same raw telemetry collection the sibling heartbeats use.

### Doctor section (informational — D4)

- `src/cli/doctor-checks.ts`: `CircuitBreakerRow` (snapshot fields + `staleSeconds: number | null`) and `circuitBreakerStatsForDoctor(uri, dbName)` — mirror `spawnCoordinatorStatsForDoctor` (`:331`): short-lived `MongoClient`, `serverSelectionTimeoutMS: 2000`, defaults for missing fields, empty array on error, sorted by provider.
- `src/cli/doctor.ts`: `renderCircuitBreakerSection(rows, emit)` — exported for unit tests, same as siblings. Rendering:

```
Provider circuit breakers (live engine, per provider)
  claude: state=closed trips=2 consec-faults=0 p95=41s (n=37) fast-fails=118 (heartbeat 12s ago)
  gemini: state=open reason=connect-fail opened 45s ago, next probe in 14s [OPEN] (heartbeat 8s ago)
    last fault: fetch failed: connect ECONNREFUSED ...
```

Flags: `[OPEN]` / `[HALF-OPEN]` / `[shadow]` (when `enabled=false`) / `stale-heartbeat` when `staleSeconds > 120` (⚠ line, same threshold as siblings). Empty rows → `"○ no heartbeat yet — start the engine and re-check"`. **This section never affects the exit code** — a trip is an incident signal, not a doctor failure (D4; a fail-tier escalation needs a separate explicit ruling). Wire into `runDoctor` after the spawn-coordinator section.

### Log lines (sustained-condition discipline, mirrors KPR-295)

- `log.error("Provider circuit OPENED", { provider, reason, consecutiveHardFaults, lastFaultMessage, cooldownMs })` — once per closed→open or half-open→open transition.
- `log.info("Provider circuit half-open — admitting probe turn", { provider, agentId, threadId })` — per probe.
- `log.info("Provider circuit CLOSED — provider recovered", { provider, openForMs, tripCount })` — per recovery.
- Fast-fails: `log.warn` on the **first** fast-fail after each open transition, then silent (`fastFailCount` in snapshot/telemetry carries the volume). No per-turn spam during a 30-minute outage.
- No message text, prompts, or previews in any log line (log-redaction convention); `lastFaultMessage` is an error string, not user content.

## Failure Modes & Edge Cases

- **Unknown error strings** → `non-provider` → never trip (fail-safe bias, rationale in classifier section).
- **Operator abort / agent stop mid-turn** → `aborted` → breaker-neutral; mid-probe → inconclusive → re-open without backoff escalation.
- **Timeout vs abort ambiguity** → resolved by the new `timedOut` flag; without the flag a stop-agent sweep during load could have tripped the breaker falsely.
- **Auth-rebuild-resume** → first attempt never recorded (record-once-per-spawnTurn); a *persistent* auth failure surfaces on the retry result as `auth` and trips — correct, since a dead OAuth session is a provider-path outage for that provider.
- **Low traffic** → slow trip (needs 3 turns) and slow probe (needs 1 turn). Acceptable: fast-fail protects nothing when nothing is arriving.
- **Mixed workloads on one provider** → one agent's broken MCP tool produces `non-provider` faults only; cannot starve other agents (the false-positive asymmetry the taxonomy exists to prevent).
- **Probe permit leak** (acquire without record) → structurally prevented by try/catch/finally at the wrap point; reconciled by staleness fallback in the breaker regardless.
- **Shadow mode** (`enabled: false`) → full observability, zero behavioral change; doctor row flagged `[shadow]`.
- **Engine restart mid-outage** → breaker resets to closed; re-trips within seconds under traffic. Telemetry rows persist (stale) until the new process's `writeOnce()` overwrites them — `updatedAt` staleness in doctor covers the gap.
- **Registry hot-reload (SIGUSR1) / agent model changes** → breakers key on provider, not agent; an agent switching `claude` → `gemini/...` simply starts acquiring from a different breaker on its next turn.

## Integration Points (exact files/functions, re-confirm at HEAD)

| File | Change |
|---|---|
| `src/agents/provider-adapters/error-classification.ts` | **new** — taxonomy + `classifyTurnResult` + `classifyThrown` + `HARD_FAULT_KINDS` |
| `src/agents/provider-circuit-breaker.ts` | **new** — breaker, registry, `ProviderCircuitOpenError`, `CircuitBreakerSnapshot` |
| `src/agents/circuit-breaker-heartbeat.ts` | **new** — copy of spawn-coordinator-heartbeat shape |
| `src/agents/agent-runner.ts` | `RunResult.timedOut?: boolean` (`:120-141`); set flag in deadline callback (`:1811-1818`) |
| `src/agents/agent-manager.ts` | construct + expose `circuitBreakers`; `acquire` at top of spawnTurn lambda (`:538`, before `prepareSpawn` `:565`); record-once on finalized result (`:569-582`); catch-classify-rethrow for adapter throws |
| `src/config.ts` | `circuitBreaker` section (liberal, all-optional, `??` defaults) |
| `src/index.ts` | heartbeat construct/writeOnce/start next to `:513`; `stop()` next to `:810` |
| `src/cli/doctor-checks.ts` | `CircuitBreakerRow` + `circuitBreakerStatsForDoctor` (mirror `:311-375`) |
| `src/cli/doctor.ts` | `renderCircuitBreakerSection` + wiring after spawn-coordinator section |
| `CLAUDE.md` | telemetry kinds list (`circuit_breaker_stats` KPR-306, per provider); Common Gotchas note on breaker + `circuitBreaker` hive.yaml section (D5) |

## Testing outline (unit-heavy; no live-provider tests)

Vitest, colocated `*.test.ts` (repo convention — precedents exist at every touch point). Time is faked via the injected `now: () => number` (no `vi.useFakeTimers` needed for the state machine); failures are faked as `TurnClassification` inputs / `RunResult` literals — no network anywhere.

- `error-classification.test.ts` — pattern table: each fault kind, timeout-flag precedence over aborted, aborted-neutral, unknown-string → non-provider, SDK subtypes → non-provider, auth-rebuild patterns → non-provider, `classifyThrown` default.
- `provider-circuit-breaker.test.ts` — the state machine with injected clock:
  - closed→open on 3 consecutive hard faults; success resets counter; non-provider/aborted don't touch it.
  - p95 trip: window fill, minSamples gate, threshold breach, window cleared on close.
  - open: `acquire` throws with correct `provider/openedAt/retryAfterMs/reason`; lazy half-open transition at `openedAt + cooldown`.
  - half-open: single probe permit, concurrent acquire rejected; probe success → closed + resets; hard-fault probe → open with doubled cooldown, capped at `openMaxMs`; aborted probe → open, exponent unchanged; non-provider probe outcome → closed.
  - per-provider isolation: claude open, gemini acquire still grants.
  - shadow mode: acquire never throws, transitions still tracked in snapshot.
  - stale-probe reconciliation.
- `circuit-breaker-heartbeat.test.ts` — mirror `spawn-coordinator-heartbeat.test.ts`: per-provider upsert keys, `updatedAt`, write-failure swallow, `writeOnce`.
- `agent-manager.test.ts` (extend) — wrap-point integration with a stubbed adapter: open breaker → spawnTurn rejects with `ProviderCircuitOpenError` **before** `prepareSpawn`/router runs; ticket fully released after fast-fail (activeSpawnCount/processing/activeTickets clean — the existing snapshot surface makes this assertable); record-once under the auth-rebuild retry; thrown-adapter-error classified and rethrown.
- `agent-runner.test.ts` (extend) — deadline fire sets `timedOut: true` + `aborted: true`; operator abort sets `aborted` only.
- `doctor.test.ts` / `doctor-checks.test.ts` (extend) — renderer snapshot rows (closed/open/shadow/stale variants), empty-rows message, loader field defaults; assert section presence does not alter exit code.
- `config.test.ts` (extend) — absent section → defaults; partial section → per-key `??`.

Gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.

## Delegated Assumptions (⚠)

- ⚠ **Defaults**: threshold 3, openBase 15s, openMax 60s, window 50, minSamples 20, p95 threshold 240s (80% of the 300s default deadline). All operator-tunable via hive.yaml; chosen for the 30-minute-outage profile (trip ≤ seconds under traffic, probe ≥ every 60s).
- ⚠ **`enabled: false` = shadow mode** (observe + telemetry, never fast-fail) rather than fully-off; default `enabled: true` (fast-fail live from first deploy).
- ⚠ **Auth faults trip the breaker** — an expired/broken credential path is treated as a provider-path outage (stops per-turn hammering); revisit if operators find auth trips more confusing than helpful.
- ⚠ **Keying by provider, not model** — one Anthropic outage takes all Claude tiers together; no evidence yet of per-model partial outages worth the state fan-out.
- ⚠ **`llmMs` (not `durationMs`) as the p95 sample** — excludes tool time so tool-heavy agents don't false-trip; pilot adapters report `llmMs == durationMs`.
- ⚠ **Successful-turns-only latency window** — failed/aborted turns excluded from p95 (they're handled by the fault path; including a 300s timeout sample would double-count the same signal).
- ⚠ **Half-open probe = real user turn** (no synthetic probes) — rationale in Design; KPR-307 turns the probe-failure UX honest.
- ⚠ **New files under `src/agents/`** (`provider-circuit-breaker.ts`, `circuit-breaker-heartbeat.ts`) beside their consumers, classifier under `src/agents/provider-adapters/` beside the adapters — matches spawn-coordinator-heartbeat placement; no new directory.
- ⚠ **Breaker state not persisted across restarts** — in-memory; re-trip cost is ~3 fast turns.

## Decision Register note

Epic KPR-305 has **no Decision Register canon yet** (pre-register epic) — noted per process; not a blocker. Gate 1 rulings recorded on KPR-305 bind this spec: **D4** (doctor section informational tier, spawn-coordinator shape, NOT fail-capable), **D5** (scope = typed classification + in-memory p95 window + `circuit_breaker_stats` heartbeat + doctor section + CLAUDE.md updates; no new tickets), **D6** (original audit artifact unrecoverable; ticket text + this code trace are the inputs). The **Open-Circuit Contract** section above is the de-facto registered decision for the KPR-307 dependency.
