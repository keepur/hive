# KPR-350 Implementation Plan — OpenAI durable resume: chaining ruled, stale-handle self-heal, posture pinned

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-350-spec.md](./kpr-350-spec.md) (@ 2f297f3) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D6. Baseline: KPR-347/348/349/353/354 all merged; **all anchors below verified against this worktree's HEAD (8b0aac8 + spec commits).**

**Goal:** Encode the §D1 ruling (`previous_response_id` chaining is the durable resume layer; Conversations API ruled out — comment-only encoding), close the stale-handle churn loop with a one-shot manager-level self-heal (§D3), pin the adapter's chaining posture (`store: true`, `truncation: "auto"`, §D2), and test-pin every inherited invariant (§D4/§D5) — all model-independent under the KPR-348 evidence gap (live legs L1–L3 are KPR-351's, key-conditioned, explicitly not claimed here).

**Architecture:** one new exported matcher `isStaleServerHandleError` beside `isAuthRebuildResumeError` (`agent-manager.ts:276`); one new `else if` arm in `spawnTurn`'s existing retry-without-resume block (`agent-manager.ts:949-961`), gated `sessionSemanticsFor(shaping.route.provider) === "server-resumable"`; one `modelSettings` line in the openai adapter's `Agent` construction (`openai-agents-adapter.ts:71-76`); doc-comment ruling in `types.ts:28-30`; CLAUDE.md clause. **Zero code edits** to `error-classification.ts`, `session-store.ts`, `turn-history-store.ts`, `turn-assembly.ts`, `tool-bridge.ts`, the codex/gemini/claude adapters, the KPR-313 guard, `finalizeSpawnResult`, or any `SESSION_SEMANTICS` value.

**Tech stack:** TypeScript strict, vitest beside source, existing test scaffolding only (manager suite's module-level adapter mocks + fake session store; adapter suite's mocked `@openai/agents`). No new dependencies, no network, no Mongo, no live keys.

**Decision-register canon honored (per task):**
- *Matcher/arm never throw outside existing containment* — the matcher is a pure regex test on a string (cannot throw); the arm lives inside the existing recorded `try` (`agent-manager.ts:947-967`), adds no new throw surface, and calls only the already-contained `runOneSpawnAttempt` (Task 2).
- *Stale-resume error stays `non-provider`* — **no `FAULT_PATTERNS` row may match it**; `error-classification.ts` is test-pinned untouched (Task 1 pin + Task 6 empty-diff; negative-verify leg 4).
- *Record-once breaker semantics* — only the finalized attempt is recorded; the `else if` placement inside the existing try preserves this structurally (record stays at `:968`, after the chain) (Task 2, T2 pins).
- *Churn-mint rider interplay per spec §Edge cases* — the retry passes `effectiveCtx` (original `sessionId` intact) to `finalizeSpawnResult`, so an errored retry that minted a fresh id still hits the `:1730` rider: stale handle preserved for the next turn's re-trip (Task 2, deliberate + test-pinned).
- *KPR-354 nested delegate turns get no session affordances* — zero changes to the delegate runner (`agent-manager.ts:647-653`); nested session-lessness is pinned, not built (Task 4).
- *KPR-348 evidence gap* — verification here is model-independent + 401-boundary only; live legs L1–L3 are specified in spec §D6 and executed under KPR-351 (Testing Contract: E2E not-required).
- *YAGNI / spec non-goals binding* — no adapter retry loop, no Conversations code (`conversationId` never appears in run options — pinned), no epic-spec edits (the §D6 row-5 stale label is superseded by the spec's own note, not by an edit here).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `isStaleServerHandleError` narrowness matrix (direct calls on the exported matcher — must-match and must-NOT-match tables, Task 1); classification pins for the stale strings in `error-classification.test.ts` (`classifyTurnResult` → `non-provider`, streak-neutral — source file untouched, Task 1); adapter posture pins in `openai-agents-adapter.test.ts` (`modelSettings` present, `previousResponseId` verbatim, `conversationId` absent, Task 3).
  - Reason: the matcher's narrowness IS the safety property (a false positive silently drops one turn's context), and the posture pin exists precisely because an implicit default can flip silently — both are deterministic string/shape contracts.
  - Minimum assertions: the T1/T4-labelled flows below, each mapped to a step.

- Integration (manager-level, mocked adapter): **required**
  - Scope: the §D3 self-heal through the real `spawnTurn` path in `agent-manager.test.ts` — retry-once semantics, gating (semantics/sessionId/error-shape), persist/no-persist outcomes, breaker record-once (T2/T3); inherited-invariant pins — claude→openai transition direction, openai write-side persist (existing pin referenced), nested session-lessness (T5/T6).
  - Reason: the arm's correctness is defined by its interplay with shaping-once, record-once, churn-mint, and the KPR-313 guard — all cross-module by definition; only the manager suite exercises that composition.
  - Harness: **existing** — `agent-manager.test.ts` module-level pilot adapter mocks (`mockOpenAIConstructor`/`mockOpenAIRunTurn`, `:122-158`), fake session store with `_sessions` map (`:315-330`), `smsCtx` helper (`:907-933`), KPR-313 `seed()` helper (`:2364-2366`), real `ProviderCircuitBreakerRegistry` reachable via `manager.circuitBreakers.stateFor("openai")` (precedent `:2144-2166`). No new harness.
  - Minimum assertions: the T2/T3/T5/T6 flows below.

- Regression: **required**
  - Scope: existing auth-rebuild arm tests (`agent-manager.test.ts:1933-1965`, `:2144-2166`, `:3428+`) pass **unmodified**; existing KPR-313 pins (`:2363-2600`) and KPR-347 persistence pins (incl. the openai write-side pin at `:2492-2500`) pass unmodified; existing KPR-354 nested-delegate group (`:3741+`) passes unmodified; `openai-agents-adapter.test.ts` — only the three exact-shape `AgentMock` assertions (`:228-232`, `:264-268`, `:425-429`) gain the `modelSettings` key (Task 3, an intended posture-pin ripple); every other adapter assertion (bridge, abort, auth-fallback, streaming) passes unmodified.
  - Reason: the arm shares a block with the auth arm and the posture pin edits a constructor three suites assert on — the blast radius is exactly these suites.

- E2E: **not required.** No Responses-capable OpenAI key exists in the fleet (KPR-348 evidence-gap canon; the codex-oauth attempt 401s pre-response). Live durable-resume legs L1–L3 (real two-turn resume, live stale-handle capture + matcher refinement, live posture acceptance) are specified in spec §D6 and executed under KPR-351, key-conditioned. Claiming them here would be dishonest verification.

### Critical Flows

- **T1 — matcher narrowness (unit, Task 1):** must-match: `"Previous response with id 'resp_abc123' not found."`, `"previous response not found"`, `"Previous response resp_x has expired"`, `"400 invalid_request_error: previous_response_id 'resp_x' not found"`, `"previous_response_id is invalid"`. Must-NOT-match: `"404 Not Found"`, `"getaddrinfo ENOTFOUND api.openai.com"`, `"model not found"`, `"tool not found"`, `"conversation not found"`, `"error_during_execution"`, `"401 Unauthorized"`, `"No response received from previous request"`, `""`. Also: every must-match string is disjoint from `isAuthRebuildResumeError` (matcher independence).
- **T2 — self-heal happy/sad paths (manager, Task 2):** openai agent, seeded openai row, first attempt errors with the stale string → exactly one retry, retry request `sessionId === undefined`, second adapter constructed; retry success (`sessionId: "resp-fresh"`) → `sessionStore.set(..., "resp-fresh", "openai", ...)`; retry failure with a different minted id → **no** `sessionStore.set` (churn-mint), error surfaces in `TurnResult.errors`; retry failure with same error → surfaces, row untouched. Breaker: after stale→retry-success, `stateFor("openai").consecutiveHardFaults === 0` and state closed; after stale→retry-failure(`"boom"`), still 0 (both finalized outcomes classify non-provider) — record-once precedent `:2144-2166` followed.
- **T3 — self-heal gating (manager, Task 2):** same stale string on a claude route (`client-transcript`) with sessionId → no retry (1 send); on a codex route (`stateless-replay`) → no retry; openai route with **no** sessionId → no retry; openai route with non-matching `"404 Not Found"` → no retry. Auth-arm independence: `else if` structure ⇒ at most one retry per turn — a first attempt matching the AUTH sentinel takes the auth arm, never both.
- **T4 — classification pin (unit, Task 1):** each must-match stale string through `classifyTurnResult({error})` → `{outcome:"fault", kind:"non-provider"}`; comment-pin that no 404/not-found row may be added to `FAULT_PATTERNS` (negative-verify leg 4 proves the pin bites).
- **T5 — KPR-313 openai transitions (manager, Task 4):** claude→openai direction (the missing pin): openai agent + claude-tagged seeded row → guard trips, annotation prepended, adapter request `sessionId === undefined`, then row persisted `("openai-session", "openai")`. openai→claude direction already pinned (`:2371-2388`) — referenced, stays green. openai write-side persist already pinned (`:2492-2500`) — referenced, stays green.
- **T6 — nested session-lessness (manager, Task 4):** nested openai delegate turn's `runTurn` request carries `sessionId: undefined` and `sessionStore.set` is not called by the nested run (call count unchanged across `call(runner)`), extending the KPR-354 group at `:3741+`.
- **T7 — posture pin (adapter, Task 3):** `AgentMock` called with `modelSettings: { store: true, truncation: "auto" }`; `previousResponseId` carries `request.sessionId` verbatim (existing pin `:233-238` green); run options contain **no** `conversationId` key (§D1 ruling as a pin); 401-boundary/auth-fallback tests (`:346+`) green with the new settings present.

### Regression Surface

- `agent-manager.test.ts`: all existing describe blocks pass unmodified — specifically the auth-rebuild retry pair (`:1933`, `:1954`), record-once pair (`:2144`, `:2156`), KPR-313 group (`:2363`), Lane A group (`:2752`), KPR-354 group (`:3741`).
- `openai-agents-adapter.test.ts`: exactly three assertions change (the `AgentMock` exact-shape calls gaining `modelSettings`); nothing else.
- `error-classification.ts` + its test: source untouched; test file gains additive pins only.
- `types.test.ts`, `session-store.test.ts`, `turn-assembly.test.ts`, `codex-subscription-adapter.test.ts`, `gemini-adk-adapter.test.ts`, `claude-agent-adapter.test.ts`, `tool-bridge.test.ts`: zero edits, pass unmodified.
- Claude lane: no `agent-runner.ts`/`prefix-builder.ts` edits — golden suites untouched by construction.

### Commands

- Fast loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/error-classification.test.ts src/agents/provider-adapters/types.test.ts`
- Full gate (every task commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.

### Harness Requirements

- `npm ci` in the worktree if `node_modules` absent. Node 22/24 (dev-mode Node 26 broken per KPR-344).
- No live credentials, no network, no Mongo anywhere in this child's tests. The manager suite's module-level adapter mocks mean no real `OpenAIAgentsAdapter` is ever constructed there; the adapter suite's `vi.mock("@openai/agents")` means no real SDK call.

### Non-Required Rationale

- E2E: see the E2E entry above — no fleet key (KPR-348 canon); live legs are KPR-351's L1–L3.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec mismatch, demote to the spec lane — do not improvise (in particular: do not widen the matcher to make a gating test pass, and do not move the arm into the adapter).
- Negative-verify discipline (operator standard) — four mandatory legs, each run against weakened code with the failing output recorded (Task 6 collects evidence), then restored:
  1. **Arm exists (Task 2):** temporarily comment out the new `else if` arm → T2's exactly-one-retry test fails (1 send observed, 2 expected) → restore → green. (The bug-fix-shaped behavior: pre-fix code churns the thread; this is the cheap revert-the-arm leg.)
  2. **Semantics gate (Task 2):** temporarily replace the `sessionSemanticsFor(...) === "server-resumable"` conjunct with `true` → T3's claude-route gating test fails (unexpected retry) → restore.
  3. **Posture pin (Task 3):** temporarily remove `modelSettings` from the `Agent` construction → T7's posture test fails → restore.
  4. **No-404-row rule (Task 1):** temporarily add `["server-error", /\b404\b|not found/i]` to `FAULT_PATTERNS` → T4's non-provider pins fail → restore. Proves the pin guards the "stale-resume never gains breaker weight" contract.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/agents/agent-manager.ts` | modify (Tasks 1, 2) | exported `isStaleServerHandleError` beside `:276` (1); `else if` self-heal arm in the `:949-961` retry block (2) |
| `src/agents/agent-manager.test.ts` | modify (Tasks 1, 2, 4) | matcher narrowness matrix (1); `spawnTurn stale-handle self-heal (KPR-350)` describe — T2/T3 (2); claude→openai transition pin + nested session-lessness pin (4) |
| `src/agents/provider-adapters/error-classification.test.ts` | modify (Task 1, additive) | T4 non-provider pins for the stale strings (source file **untouched**) |
| `src/agents/provider-adapters/openai-agents-adapter.ts` | modify (Task 3) | `modelSettings: { store: true, truncation: "auto" }` in `Agent` construction — nothing else |
| `src/agents/provider-adapters/openai-agents-adapter.test.ts` | modify (Task 3) | T7 posture + no-`conversationId` pins; three existing `AgentMock` exact-shape assertions gain `modelSettings` |
| `src/agents/provider-adapters/types.ts` | modify (Task 4, **comment-only**) | `conversation-store` doc comment records the §D1 ruling (`:28-30`) |
| `CLAUDE.md` | modify (Task 5) | one clause in the pilot-adapters paragraph (`:248`): chaining ruling + self-heal + posture |

**NOT touched (spec Integration table):** `error-classification.ts` (no code — no 404 row, ever), `session-store.ts`, `turn-history-store.ts`, `turn-assembly.ts`, `tool-bridge.ts`, `builtin-executor.ts`, `codex-subscription-adapter.ts`, `gemini-adk-adapter.ts`, `claude-agent-adapter.ts`, `oauth-credentials.ts` (the doomed codex-oauth attempt is KPR-351's disposition), the KPR-313 guard logic/ordering (`agent-manager.ts:888-923`), `finalizeSpawnResult` rules incl. churn-mint (`:1713-1749`), breaker acquire/record (`:845`, `:964`, `:968`), `resolveProviderModel`, the delegate runner (`:600-683`), `SESSION_SEMANTICS` values/unions/`persistsResumableHandle`, `kpr-345-spec.md` (stale §D6 row-5 label superseded by spec note, not edited).

---

## Task 1 (Chunk 1): `isStaleServerHandleError` matcher + narrowness pins + classification pins

**Files:**
- Modify: `src/agents/agent-manager.ts` (beside `:276`)
- Modify: `src/agents/agent-manager.test.ts` (new describe, additive)
- Modify: `src/agents/provider-adapters/error-classification.test.ts` (additive)

The matcher ships docs/community-sourced (spec ⚠ non-blocking: exact production string captured live in KPR-351 L2 and refined there if needed). Deliberately narrow — a false positive silently drops one turn's context — hence the bounded `[\s\S]{0,80}?` gap and the anchored `previous response` / `previous_response_id` prefixes (a bare `not found` or `404` never matches).

- [ ] **Step 1.1: Add the matcher to `agent-manager.ts`**

Insert directly below `isAuthRebuildResumeError` (after line 280), exported for the table-driven unit pins (precedent: `AgentStoppedError` and the KPR-306 contract exports live in this module for exactly this reason):

```ts
/**
 * KPR-350 (§D3): stale server-handle sentinel for server-resumable routes.
 * Matches the Responses previous-response-gone surface ("Previous response
 * with id 'resp_…' not found", 404/400-shaped, incl. the previous_response_id
 * param variant). Deliberately NARROW — bounded gaps, anchored on the
 * "previous response(_id)" prefix — because a false positive silently drops
 * one turn's context (the self-heal retries fresh). Docs/community-sourced;
 * refined against KPR-351's live capture (L2) if the production string
 * differs. Exported for the narrowness-matrix unit pins.
 */
export function isStaleServerHandleError(reason: string): boolean {
  return (
    /previous response[\s\S]{0,80}?(not found|expired|no longer (?:exists|available))/i.test(reason) ||
    /previous_response_id[\s\S]{0,80}?(not found|invalid|expired)/i.test(reason)
  );
}
```

No other source change in this step. The function is pure (regex test on a string) — it cannot throw, satisfying the breaker-safety canon structurally.

- [ ] **Step 1.2: Narrowness matrix in `agent-manager.test.ts`**

New top-level describe (beside the existing helper-level tests, outside the `AgentManager` describe so no manager harness is needed). Import `isStaleServerHandleError` from `./agent-manager.js`:

```ts
describe("isStaleServerHandleError (KPR-350 §D3) — narrowness matrix", () => {
  const MUST_MATCH = [
    "Previous response with id 'resp_abc123' not found.",
    "previous response not found",
    "Previous response resp_9 has expired",
    "400 invalid_request_error: previous_response_id 'resp_x' not found",
    "previous_response_id is invalid",
    "Previous response with id 'resp_x' no longer exists",
  ];
  const MUST_NOT_MATCH = [
    "404 Not Found",
    "getaddrinfo ENOTFOUND api.openai.com",
    "model not found",
    "tool not found",
    "conversation not found",
    "error_during_execution",
    "401 Unauthorized",
    "No response received from previous request",
    "",
  ];
  it.each(MUST_MATCH)("matches: %s", (s) => expect(isStaleServerHandleError(s)).toBe(true));
  it.each(MUST_NOT_MATCH)("does NOT match: %s", (s) => expect(isStaleServerHandleError(s)).toBe(false));
  it("is disjoint from the auth-rebuild sentinel on every stale string (arm independence)", () => {
    // isAuthRebuildResumeError is module-private; assert via its published
    // alternates: none of the stale strings contain an auth sentinel.
    const AUTH = /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i;
    for (const s of MUST_MATCH) expect(AUTH.test(s)).toBe(false);
  });
});
```

- [ ] **Step 1.3: Classification pins in `error-classification.test.ts`** (additive — source untouched)

```ts
describe("KPR-350 §D3 — stale-resume strings stay non-provider (no 404 row, ever)", () => {
  it.each([
    "Previous response with id 'resp_abc123' not found.",
    "400 invalid_request_error: previous_response_id 'resp_x' not found",
    "Previous response resp_9 has expired",
  ])("classifies non-provider: %s", (error) => {
    expect(classifyTurnResult({ error })).toEqual({
      outcome: "fault",
      kind: "non-provider",
      message: error,
    });
  });
});
```

Note: the first string contains no `\b404\b`, no 5xx, no auth token — verified against every `FAULT_PATTERNS` row (`error-classification.ts:69-90`; `ENOTFOUND` requires the contiguous literal, which `"not found"` is not). The 400-variant string deliberately probes the nearest miss: `\b400\b` matches no row.

- [ ] **Step 1.4: Negative-verify leg 4** — temporarily add `["server-error", /\b404\b|not found/i]` as a `FAULT_PATTERNS` row → Step-1.3 pins fail (kind flips to `server-error`) → record output → restore → green.

- [ ] **Step 1.5: Verify + commit**

```
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/error-classification.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Commit: `KPR-350: isStaleServerHandleError matcher + narrowness/classification pins`

---

## Task 2 (Chunk 2): the self-heal arm — §D3, semantics-gated, record-once-preserving

**Files:**
- Modify: `src/agents/agent-manager.ts` (`:949-961` block only)
- Modify: `src/agents/agent-manager.test.ts` (new describe inside `spawnTurn (KPR-216)`)

- [ ] **Step 2.1: Add the `else if` arm**

In `spawnTurn`, convert the auth-rebuild retry `if` into an `if / else if` chain. The existing block (`:949-961`) becomes:

```ts
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
        } else if (
          // KPR-350 (§D3): stale server-handle self-heal. The store held a
          // handle the server no longer honors (30d expiry edge, deletion,
          // org rotation) — without this arm the thread errors identically
          // every turn until the row TTLs out (up to 7 days). One fresh
          // retry; a successful retry overwrites the row via the normal
          // finalizeSpawnResult path (no explicit scrub — the write path
          // self-corrects); a failed retry surfaces normally and the
          // churn-mint rider keeps the stale handle for the next turn's
          // re-trip (bounded waste: one extra attempt per turn, never a dead
          // thread). SEMANTICS gate, not provider gate — the KPR-347 seam:
          // dead for client-transcript (their resume errors mean other
          // things) and stateless-replay (no handle exists to be stale).
          // `else if` ⇒ at most one retry per turn, and record-once is
          // untouched: only the finalized attempt reaches the breaker.
          finalResult.error &&
          isStaleServerHandleError(finalResult.error) &&
          effectiveCtx.sessionId &&
          sessionSemanticsFor(shaping.route.provider) === "server-resumable"
        ) {
          // Deliberately NOT logging the error string: the provider's stale-
          // handle message embeds the resp_ handle value (log-redaction
          // posture — spec §D3 "no handle value").
          log.warn("spawnTurn stale-server-handle — retrying without resume (KPR-350)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            provider: shaping.route.provider,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
          );
        }
```

`sessionSemanticsFor` is already imported (used at `:1721`). No import change. Nothing outside this block changes: `this.circuitBreakers.record(permit, classifyTurnResult(finalResult), ...)` at `:968` and `finalizeSpawnResult(effectiveCtx, ...)` at `:970` are untouched — record-once and the churn-mint interplay fall out structurally.

- [ ] **Step 2.2: T2/T3 manager tests**

New describe inside `spawnTurn (KPR-216)` (after the KPR-313 group; uses `smsCtx`, `registry._agents`, `mockOpenAIRunTurn`, `mockRunnerSend`, `mockCodexRunTurn`, `sessionStore` — all existing harness). Register the openai agent per test via the `:2494` precedent. `const STALE = "Previous response with id 'resp_stale' not found."`.

```ts
describe("stale-handle self-heal (KPR-350 §D3)", () => {
  const STALE = "Previous response with id 'resp_stale' not found.";
  function openaiAgent(id = "openai-pilot") {
    registry._agents.set(
      id,
      makeAgentConfig({ id, name: "OpenAI Pilot", model: "openai/gpt-5.4-mini", coreServers: [] }),
    );
    return id;
  }
  const octx = (threadId: string, sessionId = "resp_stale") =>
    smsCtx({ agentId: openaiAgent(), threadId, sessionId, sessionProvider: "openai" });

  it("retries exactly once with sessionId stripped; success persists the fresh handle", async () => {
    mockOpenAIRunTurn
      .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
      .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-fresh" }));
    const ctx = octx("sms:line-1:kpr350-heal");
    const result = await manager.spawnTurn(ctx);
    expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
    expect(mockOpenAIRunTurn.mock.calls[0]![0].sessionId).toBe("resp_stale");
    expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBeUndefined(); // fresh retry
    expect(result.finalMessage).toBe("healed");
    expect(result.newSessionId).toBe("resp-fresh");
    expect(sessionStore.set).toHaveBeenCalledWith(
      "openai-pilot", ctx.threadId, "resp-fresh", "openai", expect.anything(),
    ); // write path self-corrects — no explicit scrub
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("stale-server-handle"),
      expect.not.objectContaining({ reason: expect.anything() }), // no handle value logged
    );
  });

  it("failed retry: churn-mint blocks the minted id, error surfaces, stale handle survives for next-turn re-trip", async () => {
    mockOpenAIRunTurn
      .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
      .mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "resp-minted" }));
    const result = await manager.spawnTurn(octx("sms:line-1:kpr350-heal-fail"));
    expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual(["boom"]);
    expect(sessionStore.set).not.toHaveBeenCalled(); // ⚠A4 rider: error + different id than resumed
  });

  it("breaker record-once: stale→success records success; stale→failure records non-provider — streak 0 both ways", async () => {
    mockOpenAIRunTurn
      .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
      .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "resp-f2" }));
    await manager.spawnTurn(octx("sms:line-1:kpr350-brk-1"));
    mockOpenAIRunTurn
      .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
      .mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "resp_stale" }));
    await manager.spawnTurn(octx("sms:line-1:kpr350-brk-2"));
    const snap = manager.circuitBreakers.stateFor("openai");
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveHardFaults).toBe(0); // stale string AND "boom" are non-provider; first attempts never recorded
  });

  it("gating: dead on client-transcript (claude), stateless-replay (codex), missing sessionId, non-matching 404", async () => {
    // claude route, same string, sessionId present → no retry
    mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "s1" }));
    await manager.spawnTurn(smsCtx({ sessionId: "s1", sessionProvider: "claude", threadId: "sms:line-1:kpr350-g1" }));
    expect(mockRunnerSend).toHaveBeenCalledTimes(1);
    // codex route → no retry (stateless-replay; no handle to be stale)
    registry._agents.set("codex-pilot", makeAgentConfig({ id: "codex-pilot", name: "CP", model: "codex/gpt-5.5:medium", coreServers: [] }));
    mockCodexRunTurn.mockResolvedValueOnce(makeRunResult({ error: STALE }));
    await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr350-g2", sessionProvider: "codex" }));
    expect(mockCodexRunTurn).toHaveBeenCalledTimes(1);
    // openai route, NO sessionId → no retry
    mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: STALE }));
    await manager.spawnTurn(smsCtx({ agentId: openaiAgent(), threadId: "sms:line-1:kpr350-g3", sessionId: undefined }));
    expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(1);
    // openai route, generic 404 → no retry (matcher narrowness at the arm)
    mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: "404 Not Found", sessionId: "resp_x" }));
    await manager.spawnTurn(octx("sms:line-1:kpr350-g4", "resp_x"));
    expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2); // 1 (g3) + 1 (g4), no retries
  });
});
```

(Adjust helper/mock names to the file's actual local bindings at implementation time — `makeRunResult`, `mockLogWarn`, `makeAgentConfig` all exist in this suite. Exact call-count arithmetic in the gating test must account for per-test mock state; reset or scope counts as the harness dictates — the assertions of substance are "no second call on the same route".)

- [ ] **Step 2.3: Negative-verify legs 1 + 2** — (leg 1) comment out the entire `else if` arm → the retry-once test fails (`toHaveBeenCalledTimes(2)` observes 1) — this is the revert-the-arm proof that the new tests fail on pre-fix code; (leg 2) replace the semantics-gate conjunct with `true` → the claude-route gating leg fails (2 sends observed). Record both outputs, restore, re-run green.

- [ ] **Step 2.4: Regression check** — existing auth-rebuild tests (`:1933`, `:1954`, `:2144`, `:2156`, `:3428`) and the full KPR-313 group pass unmodified.

- [ ] **Step 2.5: Verify + commit**

```
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Commit: `KPR-350: stale-handle self-heal arm — one fresh retry on server-resumable routes`

---

## Task 3 (Chunk 3): adapter posture pin — `store: true`, `truncation: "auto"`

**Files:**
- Modify: `src/agents/provider-adapters/openai-agents-adapter.ts` (`:71-76` only)
- Modify: `src/agents/provider-adapters/openai-agents-adapter.test.ts`

- [ ] **Step 3.1: Pin the posture**

`Agent` construction becomes:

```ts
      const agent = new Agent({
        name: this.options.name,
        instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
        model: this.options.model,
        // KPR-350 (§D2): chaining posture pinned, not defaulted. store:true is
        // the previous_response_id prerequisite (the codex surface hard-
        // enforces the opposite — the default-flip precedent is live);
        // truncation:"auto" is the Lane B compaction analog (server-side
        // context reconstruction on a long thread degrades by truncation
        // instead of 400). Nested KPR-354 delegate constructions share this
        // path deliberately (unreferenced 30d-self-expiring residue only).
        modelSettings: { store: true, truncation: "auto" },
        ...(tools.length > 0 ? { tools } : {}),
      });
```

(`ModelSettings.store` / `.truncation` verified in `@openai/agents-core/dist/model.d.ts:212,221` per spec provider-surface evidence.) No other adapter change — `previousResponseId` wiring (`:81`), `extractSessionId` (`:230`), auth attempts (`:153-216`) untouched.

- [ ] **Step 3.2: Update the three exact-shape pins + add T7 pins**

- Existing `AgentMock` exact assertions at `:228-232`, `:264-268`, `:425-429` each gain `modelSettings: { store: true, truncation: "auto" }`.
- New pins:

```ts
it("KPR-350 §D2: chaining posture pinned — store:true + truncation:auto on every construction", async () => {
  runMock.mockResolvedValueOnce(makeSdkResult() as never);
  await makeAdapter().runTurn({ prompt: "hi" });
  const opts = AgentMock.mock.calls[0]![0] as Record<string, unknown>;
  expect(opts.modelSettings).toEqual({ store: true, truncation: "auto" });
});

it("KPR-350 §D1 ruling pin: run options never carry conversationId (Conversations API ruled out)", async () => {
  runMock.mockResolvedValueOnce(makeSdkResult() as never);
  await makeAdapter().runTurn({ prompt: "hi", sessionId: "resp-prev" });
  const runOpts = runMock.mock.calls[0]![2] as Record<string, unknown>;
  expect(runOpts.previousResponseId).toBe("resp-prev");
  expect("conversationId" in runOpts).toBe(false);
});
```

- [ ] **Step 3.3: Negative-verify leg 3** — remove `modelSettings` from the construction → the posture pin fails → record → restore → green.

- [ ] **Step 3.4: Verify + commit** — full adapter suite green (bridge/abort/auth-fallback/streaming untouched); `npm run check` green.

Commit: `KPR-350: pin openai chaining posture — store:true + truncation:auto`

---

## Task 4 (Chunk 4): `types.ts` ruling comment + inherited-invariant pins (§D4/§D5)

**Files:**
- Modify: `src/agents/provider-adapters/types.ts` (**comment-only**, `:28-30`)
- Modify: `src/agents/agent-manager.test.ts` (additive)

- [ ] **Step 4.1: Record the ruling in the descriptor comment**

Replace the `conversation-store` bullet (`types.ts:28-30`) with:

```ts
 *  - "conversation-store": provider-side durable conversation object; the
 *                          persisted ref would be a conversation id.
 *                          UNOCCUPIED BY RULING (KPR-350 §D1): chaining won
 *                          for openai — hive's 7d sessions TTL makes >30d
 *                          durability unreachable, and Conversations adds a
 *                          create-lifecycle + org-affinity hazard + indefinite
 *                          vendor-side residue. Category retained for a
 *                          hypothetical future provider whose only durable
 *                          layer is a conversation object.
```

Also update the `server-resumable` bullet's parenthetical (`:26-27`) to cite the ruling: `(openai previous_response_id chaining — KPR-350 §D1 ruling; server retention 30d > store TTL 7d; stale handles self-heal, §D3)`. Values, unions, `persistsResumableHandle` untouched; `types.test.ts` passes unmodified (comment-only diff — verified in Task 6).

- [ ] **Step 4.2: claude→openai transition pin (T5 — the missing direction)**

In the KPR-313 describe (`agent-manager.test.ts:2363+`), following the `:2413` claude→pilot precedent but asserting the persist too:

```ts
it("KPR-350 §D4: claude→openai handoff — fresh session, annotation, first turn persists the openai handle", async () => {
  registry._agents.set(
    "openai-pilot",
    makeAgentConfig({ id: "openai-pilot", name: "OpenAI Pilot", model: "openai/gpt-5.4-mini", coreServers: [] }),
  );
  const threadId = "sms:line-1:kpr350-c2o";
  seed(threadId, "claude-uuid-1", "claude", "openai-pilot");
  await manager.spawnTurn(
    smsCtx({ agentId: "openai-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
  );
  const req = mockOpenAIRunTurn.mock.calls[0]![0];
  expect(req.sessionId).toBeUndefined(); // guard stripped the claude id
  expect(req.prompt).toContain("session continuity was reset"); // §3.4 annotation
  expect(sessionStore.set).toHaveBeenCalledWith(
    "openai-pilot", threadId, "openai-session", "openai", expect.anything(),
  ); // first openai turn persists the first lastResponseId
});
```

openai→claude direction (`:2371-2388`) and the openai write-side persist pin (`:2492-2500`) already exist — referenced in the test comment, not duplicated.

- [ ] **Step 4.3: nested session-lessness pin (T6 — extends the KPR-354 group at `:3741+`)**

```ts
it("KPR-350 §D5: nested delegate turn is session-less — no sessionId in, no persist out", async () => {
  const runner = await setupOpenAIParent();
  const setsBefore = (sessionStore.set as Mock).mock.calls.length;
  mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ text: "out", sessionId: "resp-nested-discard" }));
  await call(runner);
  const nestedReq = mockOpenAIRunTurn.mock.calls.at(-1)![0];
  expect(nestedReq.sessionId).toBeUndefined(); // ⇒ previousResponseId undefined on the nested run
  expect((sessionStore.set as Mock).mock.calls.length).toBe(setsBefore); // result id discarded, store untouched
});
```

- [ ] **Step 4.4: Verify + commit** — fast loop + `npm run check` green.

Commit: `KPR-350: ruling recorded in SESSION_SEMANTICS comments + transition/nested invariant pins`

---

## Task 5 (Chunk 5): CLAUDE.md clause

**Files:**
- Modify: `CLAUDE.md` (`:248`, pilot-adapters paragraph)

- [ ] **Step 5.1:** In the `CodexSubscriptionAdapter / OpenAIAgentsAdapter / GeminiAdkAdapter` paragraph, after "…gemini still advertises zero tools until KPR-352.", insert one clause:

> OpenAI durable resume is `previous_response_id` chaining (KPR-350 ruling — Conversations API deliberately unused): the handle lives in `sessions` (7d idle TTL < 30d server retention) and is rewritten every turn, the adapter pins `store: true` + `truncation: "auto"` (Lane B's compaction analog), and a stale/expired handle self-heals via one manager-level fresh retry (`isStaleServerHandleError`, semantics-gated `server-resumable`, breaker-invisible, one exchange of context lost; ZDR orgs unsupported for chaining — parity-matrix caveat).

- [ ] **Step 5.2:** Confirm no other doc surface is owed: the §D7 matrix row facts (incl. the ZDR + re-billed-input caveats) are recorded **in the spec itself** for KPR-355's matrix pass — no matrix file exists yet, and the epic spec's stale row-5 label is superseded by spec note, not edited (register canon). No `docs/` change beyond this plan and the spec.

- [ ] **Step 5.3:** `npm run check` green (format gate covers CLAUDE.md).

Commit: `KPR-350: CLAUDE.md — openai durable-resume ruling clause`

---

## Task 6 (Chunk 6): Final verification — full gate, boundary diffs, negative-verify evidence

**Files:** none (verification only; fixes fold into the owning task's file set).

- [ ] **Step 6.1: Boundary empty-diffs** — assert untouched files are untouched:

```
git diff --stat main...HEAD -- src/agents/provider-adapters/error-classification.ts \
  src/agents/session-store.ts src/agents/turn-history-store.ts \
  src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/tool-bridge.ts \
  src/agents/provider-adapters/codex-subscription-adapter.ts \
  src/agents/provider-adapters/gemini-adk-adapter.ts \
  src/agents/provider-adapters/claude-agent-adapter.ts \
  src/agents/provider-adapters/oauth-credentials.ts
```

Expected: empty. Then confirm `types.ts` is comment-only: `git diff main...HEAD -- src/agents/provider-adapters/types.ts` shows no non-comment line changes; and `agent-manager.ts`'s diff touches only the matcher region and the retry block (guard `:888-923` and `finalizeSpawnResult` `:1713-1749` absent from the hunks).

- [ ] **Step 6.2: Negative-verify evidence** — confirm all four legs (Tasks 1–3) were run and their failing outputs recorded in the implementation session log / PR description.

- [ ] **Step 6.3: Full gate**

```
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: exit 0, all suites green.

- [ ] **Step 6.4: KPR-351 handoff note** — the PR description lists the three live legs L1–L3 (spec §D6) as KPR-351's, key-conditioned, with L2 named as the matcher-refinement leg. No code claim beyond the 401 boundary.

Commit: (none unless fixes were needed).

---

## Notes for the reviewer (plan-level decisions and their rationale)

1. **Matcher exported.** `isAuthRebuildResumeError` is module-private and tested behaviorally; the new matcher is exported because its safety property is a ~15-case narrowness matrix — driving each case through a full `spawnTurn` would be noise without adding fidelity. The arm-level gating tests (T3) still cover the behavioral composition.
2. **`else if`, not a second `if`.** Guarantees at-most-one-retry per turn structurally (an auth-arm retry that itself returned a stale-shaped error must not chain a third attempt) and keeps record-once untouched without new bookkeeping.
3. **Warn log carries no error string.** The spec's §D3 log line says "reason (no handle value)" — but the provider's stale message embeds the `resp_` handle (`"Previous response with id 'resp_…' not found"`), so logging the string would leak the handle. The static message + provider field is the reason; redaction posture wins. (Divergence from the auth arm, which logs `reason:` — its sentinel strings carry no handle.)
4. **No new harness anywhere.** Every test lands in an existing describe ecosystem with existing mocks; the openai persist pin and openai→claude transition pin already exist and are referenced, not duplicated — §D4's "verify, don't rebuild" applied to tests too.
5. **Reflection path needs no arm-specific handling.** The post-lock re-resolve (`:860-868`) runs before the retry block; a reflection turn holding a stale handle takes the same arm. Not separately pinned — provider-blind by construction (spec §D4).
