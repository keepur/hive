# KPR-313 — Implementation Plan: Session-identity guards + turn-boundary switching (W3.4)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** `docs/epics/kpr-309/kpr-313-spec.md` (approved after 2 review rounds — authoritative; ⚠A1–⚠A10 delegated assumptions are settled, do not re-litigate).
**Epic:** KPR-309 (pre-register epic — R3/R4/R7 citations bind from W2's register, KPR-305 @ `af74cf7`). The provider clamp-lift stays parked in KPR-311's spec §5 (pickup W3.5/KPR-314); this ticket's guard is designed to *survive* the lift, not enable it.

> **DELIVERY-CONTEXT NOTE (read first):** this plan executes after **three gates**: (1) the W2 epic (`kpr-305`, tip `2ad4194` at spec time) has merged; (2) **KPR-311's child PR has merged** (SpawnShaping, `createProviderAdapter(agentId, route)`, rewritten `prepareSpawn`); (3) **KPR-312's child PR has merged** (`SpawnShaping.effortOverride`, `effort: shaping.effortOverride` in the `runTurn` call, extended types import). Every shared-file edit below anchors on **311/312's plan-introduced strings** where those tickets rewrote the line (e.g. the merge return with `effortOverride`, the `// Router gate (KPR-311)` comment) and on kpr-305 strings where they did not (the lambda's re-resolve block, `finalizeSpawnResult`, `runWorkItemTurn`, voice). Edits anchor on unique code strings, never line numbers. **Task 0 re-confirms all three gates and every anchored surface (mandatory spec cite refresh, Gate 1 D2) before any edit** and defines the demote-to-spec escape hatch. **Task 1 is the spec's ⚠8 live-repro gate — it must complete before any guard code lands.**

## Goal

Session-store rows gain a `provider` tag (store **field**, not id rewriting); `SessionStore.get()` returns a `StoredSessionRef` and owns all normalization at the single choke point — including the lazy scrub of legacy fabricated ids (`codex-pilot-*`, `gemini-pilot-*`, untagged `resp_*`) with a `.catch`-swallowed `deleteOne`. `finalizeSpawnResult(ctx, result, route)` persists a resumable id **only** for `RESUMABLE_SESSION_PROVIDERS` (`claude`, `openai`); codex/gemini rows persist with `sessionId: ""` so `findAgentByThread` thread-continuity survives while the fake handle dies. The ⚠A4 churn-mint rider stops errored turns from persisting a *different* id than they resumed. A zero-I/O guard in the `spawnTurn` lambda (post-reflection-re-resolve, pre-`recordSpawn`, R7 untouched) refuses cross-provider resumes — with one authoritative post-lock store re-read **only on trip** (⚠A9, closes the queued-turn stale-tag race by adopting the predecessor's switched session) — and marks the turn for a fresh-context+memory handoff with a one-line prompt annotation (`conversation_search` clause Claude-targets only). Voice applies the same eligibility compare at its own read so a mismatch re-sends the full in-call transcript (its native handoff) instead of a silent latest-message-only turn. The reflection re-resolve compare becomes field-wise. No clamp lift, no registry, no transcript reconstruction, no classifier work.

## Architecture

- **`session-store.ts` is the normalization choke point** (spec §3.1): `get()` returns `StoredSessionRef | undefined`; tagged rows normalize (`""` ⇒ no handle; non-resumable tag ⇒ no handle, belt-and-braces), untagged fabricated-prefix rows scrub (warn once per key + lazy fire-and-forget delete, TTL backstop), untagged plain rows grandfather as `claude`. `set()` gains a positional 4th `provider` param. No migration script — legacy rows age out ≤7 days via the existing TTL index.
- **`RESUMABLE_SESSION_PROVIDERS` lives in `provider-adapters/types.ts`** — the per-adapter resumability contract is a static const + JSDoc citing each adapter's behavior. **The four adapter files themselves are untouched** (spec §3.2/§7: no `RunResult`/interface changes; they keep returning whatever they return).
- **The guard is a pure compare inside the kpr-305 lambda**, inserted between the reflection re-resolve and `if (!effectiveCtx.sessionId) this.recordSpawn(…)`. Hot path: zero I/O. On trip only: one post-lock `sessionStore.get` — adopt if a queued predecessor already switched, else strip + `sessionHandoff: true`. Keyed on the acquire-time static `route` (⚠A6 — provably ≡ effective provider under 311's clamp; the lift re-keys `acquire()` and this guard together, parked W3.5). Nothing moves across the R7 boundary: `acquire()` first statement, one `record()` per finalized attempt, retry `shaping` reuse — all untouched.
- **Handoff = fresh + memory + annotation** (⚠A5): fresh context via the stripped id; memory carryover is the existing system-prompt assembly (nothing to build); the annotation is a `prepareSpawn` prepend gated on `ctx.sessionHandoff`, with a Claude variant (has the `conversation_search` clause) and a pilot variant (omits it — pilots run tool-free). Voice carve-out returns before the prepend (annotation-free by construction).
- **Voice eligibility at the read (⚠A10 — DECIDED):** voice compares the stored ref's provider against **`agentManager.providerFor(agentId)`** — the existing public KPR-307 surface built precisely as the out-of-manager read of the static route provider (one-liner over the same `resolveProviderModel` the breaker wrap uses). **Neither export nor relocation of `resolveProviderModel`:** it stays private beside its route types in `agent-manager.ts`, voice couples to one purpose-built method, and voice/dispatcher/breaker all key off a single resolution by construction. `providerFor` returning `null` (SIGUSR1 vanish) is treated as mismatch ⇒ no resume ⇒ full transcript (fail-soft).

## Tech Stack

- TypeScript strict (no `any` without justification), Node 22+, ESM
- Vitest, tests beside source (`src/**/*.test.ts`); harnesses: `agent-manager.test.ts` (mocked runner/pilot spies, mock session store, hoisted `mockLogWarn` from 311 T3), `voice-adapter.test.ts` / `voice-adapter.integration.test.ts` (AgentManager stub), mock-Db pattern from `turn-telemetry.test.ts` for the new `session-store.test.ts`
- Logging via `createLogger`; log-redaction convention (no message text, no session-id *previews* beyond keys already logged)
- No new dependencies, no config keys, no hive.yaml surface, no doctor/telemetry surface (spec §7)

**Out of scope (do not touch):** `error-classification.ts` (R3 frozen — no `bad-session` kind), the auth-rebuild retry regex/semantics, `provider-circuit-breaker.ts`, `providerFor()` body, all four adapter `runTurn` implementations and `AgentProviderTurnRequest`/`RunResult` shapes, 311's clamp/pilot-gate/merge and 312's effort channel, `model-router.ts`, `conversation-index.ts`, `forkSession`/`resumeSessionAt` (M7a/M7b — no time-travel), `TurnResult.newSessionId` derivation.

---

## Testing Contract

### Required Test Groups

**Unit — `required`** — spec §8 groups 1–8 realized as:

1. **Store-level (`src/agents/session-store.test.ts` — NEW file, Task 3):** tag round-trip on `set`/`get` (provider reaches `$set`); `sessionId: ""` row → `{sessionId: undefined, provider}`; belt-and-braces (non-resumable tag + non-empty id → `sessionId: undefined`, **no scrub of tagged rows**); openai-tagged `resp_` row IS resumable; legacy untagged uuid → grandfathered `provider: "claude"`, no delete; each fabricated prefix (`codex-pilot-`, `gemini-pilot-`, `resp_`) → `{undefined, undefined}` + `deleteOne` with the id-guarded filter + warn; warn fires once per key across repeated reads; legacy-slack fallback path returns the same normalized shape (and scrubs); absent row → `undefined`; findOne failure fail-softs to `undefined`.
2. **Guard (`src/agents/agent-manager.test.ts`, Task 5):** stored tag ≠ turn provider (post-lock re-read still mismatched) → `runner.send` gets `sessionId: undefined` AND the prompt carries the annotation AND `recordSpawn` counted a new session AND **exactly one** `sessionStore.get` call (the trip-path re-read); tag match → resume passed through, no annotation, **zero** `sessionStore.get` calls (hot-path zero-I/O pin — this doubles as the untagged-legacy/fleet-upgrade regression pin since grandfathered rows arrive as `provider: "claude"`); codex-tagged `""` row + claude turn → no resume AND annotation still fires (round-trip case); annotation variants — claude-target contains `conversation_search`, pilot-target omits it.
3. **Contention race (⚠A9, Task 5):** two same-thread `runWorkItemTurn`s queued across a provider transition — A trips (fresh + handoff, persists the claude row), queued B's stale tag trips the compare, the post-lock re-read returns A's same-provider row, B **adopts** (resumes `s-A`, no second annotation). **Negative-verify (mutation): remove the trip-path re-read → the test MUST fail (B double-drops).**
4. **Persist rule (Task 5):** claude success → `set(…, id, "claude", …)`; codex/gemini success → `set(…, "", "codex"|"gemini", …)` AND `findAgentByThread` still resolves the agent; openai success → `set(…, "openai-session", "openai", …)`; **churn-mint rider** — error + resumed + different id → `set` NOT called + warn (**negative-verify: revert the rider, test must fail**); error + same id → `set` called; first-turn error with fresh id → `set` called.
5. **Inverse-direction lens (Task 5):** one end-to-end claude→codex→claude round trip through `runWorkItemTurn` (guard + persist + next-turn read), asserting **both** directions' guard trips, both annotation variants, and the row state after each turn.
6. **Voice (`src/channels/voice/voice-adapter.test.ts`, Task 6):** provider mismatch at the read ⇒ `ctx.sessionId`/`ctx.sessionProvider` unset AND `ctx.workItem.text` is the full `renderConversationPrompt` transcript, not latest-message-only, AND contains no handoff annotation (carve-out). **Negative-verify (mutation): bypass the eligibility compare (pass the stored id straight through) → the test MUST fail on the latest-message-only prompt** — this pins the exact silent-context-loss regression §3.5 exists to prevent. Provider match ⇒ latest-message prompt + resume + tag, as today.
7. **Reflection (Task 5):** field-wise compare pin — same stored id/provider ⇒ `runner.send` receives the **string** id (a ref-vs-string regression would pass an object or rebuild wrongly) with exactly one `get` (re-resolve only, no trip read); reflection after a provider edit runs fresh without throwing (re-resolve picks up the tag, guard trips, handoff fires).
8. **Scrub throw-safety (Task 3):** `get()` with a rejecting `deleteOne` → normalized ref still returned, rejection swallowed into a `log.warn` (pins the `.catch`-swallow — the R7-window no-new-throw-surface rule).
9. **Live repro (manual, gated — Tasks 1 & 7):** pre-fix poisoned-row repro (or CLI-bundle re-verification at the then-installed SDK version) pinning §1's observed failure shape **before the guard code lands** (⚠A8); post-fix confirmation (scrub log, fresh turn, annotation, row healed with tag) at the end.

**Integration — judged: not required beyond the above.** Groups 2–5/7 run the full `spawnTurn` pipeline (ticket HOF, breaker wrap, 311/312 shaping, adapter construction, retry, finalize) in the existing mock harness — the highest fidelity available without a live SDK. The SDK-side unknown-resume behavior is pinned empirically by Task 1 (live gate), not by an automated test that would need a live CLI.

**E2E — `not-required`** beyond the manual Task 1/7 gate. Channels/dispatcher shapes are unchanged (`runWorkItemTurn` is internal plumbing); the voice behavior change is unit-pinned at the adapter surface.

### Critical Flows
1. Poisoned legacy row → `get()` scrubs (warn + lazy delete) → turn runs fresh, **no** annotation (no provider signal survives — spec §5 row 1) → success persists id + tag → thread healed.
2. Operator flips `agent.model` claude↔pilot (SIGUSR1) → next turn trips the guard → fresh + memory + correct annotation variant → persist rule writes id-or-`""` + tag.
3. Round trip claude→codex→claude → both boundary turns trip; codex row keeps `findAgentByThread` working with `sessionId: ""`.
4. Errored resume minting a fresh id (`error_during_execution`) → rider skips the persist → row keeps the prior (still-valid, M7b-stable) handle → no churn loop.
5. Voice mid-call provider mismatch → full-transcript prompt (native handoff), no resume attempted, outer retry untouched and mismatch-free.
6. Same-thread contention across a transition → queued turn adopts the predecessor's switched session (no double-drop).

### Regression Surface (must stay green)
- `src/agents/agent-manager.test.ts` — **all existing describes**: spawnTurn happy path/session-save/rotation (KPR-211/216), per-agent budget, KPR-306 breaker-wrap describe, KPR-307 propagation describe, KPR-311 seam + invariants describes, KPR-312 effort-channel describe, KPR-224 shaping pins, voice carve-out, reflection Phase 6/15 tests. The auth-rebuild retry test (`retries once with sessionId stripped…`) must pass **unchanged in behavior** (spec §8 header). Mock-shape ripple (Task 2) is mechanical: `StoredSessionRef` returns, `set` 4-arg → 5-arg.
- `src/channels/voice/voice-adapter.test.ts` + `voice-adapter.integration.test.ts` — outer-retry tests (`stale-sid`, `persistent-stale-sid`), circuit-open (KPR-307), prompt-shape tests — mechanical ref-shape updates only; assertions unmodified.
- `src/channels/dispatcher.test.ts`, `dispatcher-conference.test.ts` — `findAgentByThread`/`findAgentsByThread` consumers; those store methods are **unchanged**, any failure means the store edit leaked.
- `src/agents/provider-circuit-breaker.test.ts`, `provider-adapters/error-classification.test.ts`, `circuit-breaker-heartbeat.test.ts`, `agent-runner.test.ts` — read-only surfaces (R3/R7/R4); any failure means this change leaked across the boundary.
- `codex-subscription-adapter.test.ts`, `openai-agents-adapter.test.ts`, `gemini-adk-adapter.test.ts`, `claude-agent-adapter.test.ts` — untouched files, untouched tests.

### Commands
```bash
# Targeted (after each task)
npx vitest run src/agents/session-store.test.ts
npx vitest run src/agents/agent-manager.test.ts
npx vitest run src/channels/voice/
npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts

# Full gate (Task 0 baseline + Task 7; env stubs required by config load in tests)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: all suites pass; `check` = typecheck + lint + format + test, zero failures. (Worktree/CI asymmetry reminder: confirm the check output actually lists all four gates running — do not trust a pass that self-disabled on a `.claude/worktrees/` ignore fragment.)

### Harness Requirements
- **`agent-manager.test.ts`:** `makeMockSessionStore` upgraded to store `{sessionId, provider}` records, expose `_sessions`, normalize `""` → `undefined` on `get` (mirrors the real store), and implement `findAgentByThread` over the map (existing `.mockResolvedValue` overrides in the `findAgentForThread` describe still win). `smsCtx` overrides gain `sessionProvider`. `mockLogWarn` (311 T3 hoisted spy) reused for guard/rider warns. No other mock changes.
- **`voice-adapter.test.ts` / integration:** `AgentManagerStub` gains `providerFor` (`vi.fn().mockReturnValue("claude")`); `sessionStoreGet` fixtures become `StoredSessionRef` shapes.
- **`session-store.test.ts`:** mock Db per the `turn-telemetry.test.ts` precedent (`findOne`/`updateOne`/`deleteOne`/`createIndex`/`countDocuments` spies); hoisted logger-warn spy. No real Mongo anywhere.

### Non-Required Rationale
- No adapter-file tests: adapters are byte-untouched; resumability is a const in `types.ts` whose consumers (store, finalize) are tested directly.
- No doctor/telemetry tests: spec §7 builds no such surface.
- No automated live-SDK resume test: Task 1's manual gate pins the CLI behavior at the installed version; automating it would burn quota re-testing the SDK's own contract on every CI run.

### Verification Rules
1. A missing harness is not a skip reason — if a listed test doesn't exist at a task's Verify step, write it; do not mark the task done without running the listed commands and seeing the expected output.
2. When a test fails, fix the implementation, not the test — unless the test contradicts the spec's pinned semantics (never-persist rule, rider scope, guard placement/zero-I/O, adopt-on-trip, voice eligibility-at-read, annotation variants), in which case the spec wins.
3. Spec/plan mismatch demotes to the spec lane: if executing this plan surfaces a conflict with `kpr-313-spec.md`, Task 0 finds anchored-surface drift, or Task 1 trips its STOP rule — stop and route the ticket back through dodi-dev:mature-ticket with a drift/evidence note. Do not improvise in the delivery lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/agents/provider-adapters/types.ts` | modified (additive) | `RESUMABLE_SESSION_PROVIDERS` const — the per-adapter resumability contract (JSDoc cites all four adapters) |
| `src/agents/session-store.ts` | modified | `SessionDoc.provider`; `StoredSessionRef`; `get()` normalization + scrub (+ `.catch`-swallowed lazy delete, warn-once set); `set()` provider param. `findAgentByThread`/`findAgentsByThread`/`delete`/`clearAgent` **unchanged** |
| `src/agents/agent-manager.ts` | modified | `TurnContext.sessionProvider`/`sessionHandoff`; handoff notice constants; `runWorkItemTurn` + both reflection reads consume the ref (field-wise compare); the guard in the `spawnTurn` lambda; `finalizeSpawnResult(ctx, result, route)` + never-persist + ⚠A4 rider; annotation prepend in `prepareSpawn`; `RESUMABLE_SESSION_PROVIDERS` import |
| `src/channels/voice/voice-adapter.ts` | modified | Eligibility compare at the `sessionStore.get` read via `agentManager.providerFor`; `sessionProvider` on the voice ctx |
| `src/agents/session-store.test.ts` | **new** | Test groups 1 & 8 |
| `src/agents/agent-manager.test.ts` | modified | Mechanical mock/assertion ripple + new `session-identity guard + persist rule (KPR-313)` describe (groups 2–5, 7) |
| `src/channels/voice/voice-adapter.test.ts` | modified | Mechanical ref-shape ripple + group 6 tests |
| `src/channels/voice/voice-adapter.integration.test.ts` | modified | Mechanical: ref-shaped `sessionStoreGet`, `providerFor` stub |

No other files. One commit per task; every task leaves the tree green (`npm run typecheck` + scoped tests).

---

## Task 0 — Re-confirm anchored surfaces at delivery HEAD (mandatory, Gate 1 D2)

**Goal:** prove the delivery worktree carries the post-W2 lambda shape AND 311's AND 312's landed shapes, and refresh every spec cite, before touching anything.

- [ ] **Gate A — W2 in history:** `git log --oneline | grep -iE "kpr-30[5678]" | head` shows W2 commits or the W2 epic merge. `ls src/agents/provider-adapters/error-classification.ts` succeeds. If not: **STOP — delivery gate not met.**
- [ ] **Gate B — 311 landed:** `git log --oneline | grep -i "kpr-311" | head` non-empty. If not: **STOP.**
- [ ] **Gate C — 312 landed:** `git log --oneline | grep -i "kpr-312" | head` non-empty. If not: **STOP.**
- [ ] Re-confirm each anchored surface by content (line numbers have drifted; strings must match with the stated counts). Note: `grep` exits non-zero on zero matches — judge the expect-0 lines by printed output, not exit code.

```bash
# 1. session-store.ts — pre-313 shape (313's primary file, untouched by W2/311/312):
grep -n 'async get(agentId: string, threadId: string): Promise<string | undefined> {' src/agents/session-store.ts   # 1 hit
grep -n 'async set(agentId: string, threadId: string, sessionId: string, tokenData?: {' src/agents/session-store.ts  # 1 hit
grep -n 'expireAfterSeconds: 7 \* 24 \* 60 \* 60' src/agents/session-store.ts                                        # 1 hit (TTL)
grep -n 'if (threadId.startsWith("slack:"))' src/agents/session-store.ts                                             # 1 hit (legacy fallback)
grep -n 'async findAgentByThread' src/agents/session-store.ts                                                        # 1 hit
grep -cn 'provider' src/agents/session-store.ts                                                                      # expect 0

# 2. types.ts — 311/312 post-state, no 313 const yet:
grep -n 'export type AgentProviderId' src/agents/provider-adapters/types.ts        # 1 hit
grep -n 'export type ReasoningEffort' src/agents/provider-adapters/types.ts        # 1 hit (311)
grep -n 'effort?: ReasoningEffort;' src/agents/provider-adapters/types.ts          # 1 hit (312)
grep -rn 'RESUMABLE_SESSION_PROVIDERS' src/ | wc -l                                # expect 0

# 3. agent-manager.ts — kpr-305 strings 311/312 did NOT touch (313's anchors):
grep -n 'const sessionId = await this.sessionStore.get(agentId, threadId);' src/agents/agent-manager.ts   # 2 hits (runWorkItemTurn + reflection best-effort)
grep -n 'const freshSessionId = await this.sessionStore.get(ctx.agentId, ctx.threadId);' src/agents/agent-manager.ts  # 1 hit (reflection re-resolve)
grep -n 'if (!effectiveCtx.sessionId) this.recordSpawn(effectiveCtx.workItem.source.id);' src/agents/agent-manager.ts # 1 hit (guard insertion point)
grep -n 'const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult);' src/agents/agent-manager.ts          # 1 hit
grep -n 'this.sessionStore.set(ctx.agentId, ctx.threadId, result.sessionId, {' src/agents/agent-manager.ts            # 1 hit
grep -n 'sessionId: string | undefined;' src/agents/agent-manager.ts                                                  # ≥1 hit (TurnContext)
grep -n 'function isAuthRebuildResumeError' src/agents/agent-manager.ts                                               # 1 hit
grep -n 'const permit = this.circuitBreakers.acquire(route.provider' src/agents/agent-manager.ts                      # 1 hit (R7 acquire — read-only)

# 4. agent-manager.ts — 311/312 plan-introduced strings (shared-line anchors):
grep -n 'interface SpawnShaping' src/agents/agent-manager.ts                                              # 1 hit (311)
grep -n 'const adapter = this.createProviderAdapter(ctx.agentId, shaping.route);' src/agents/agent-manager.ts  # 1 hit (311)
grep -n 'effortOverride: ReasoningEffort | undefined;' src/agents/agent-manager.ts                        # 1 hit (312)
grep -n 'effort: shaping.effortOverride,' src/agents/agent-manager.ts                                     # 1 hit (312 — runTurn call tail)
grep -n '// Router gate (KPR-311)' src/agents/agent-manager.ts                                            # 1 hit (annotation insertion anchor)
grep -n 'import type { AgentProviderAdapter, AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";' src/agents/agent-manager.ts  # 1 hit (312)
grep -cn 'sessionProvider\|sessionHandoff\|SESSION_HANDOFF' src/agents/agent-manager.ts                   # expect 0

# 5. voice-adapter.ts — kpr-305 shape (KPR-307 additions elsewhere):
grep -n 'const storedSessionId = await sessionStore.get(agentId, threadId);' src/channels/voice/voice-adapter.ts       # 1 hit
grep -n 'const effectiveResume = storedSessionId && turnPrompt ? storedSessionId : undefined;' src/channels/voice/voice-adapter.ts  # 1 hit
grep -n 'if (!outcome.ok && !outcome.circuitOpen && effectiveResume && !outcome.bytesSent) {' src/channels/voice/voice-adapter.ts   # 1 hit (outer retry — read-only)
grep -n 'providerFor(agentId: string): AgentProviderId | null {' src/agents/agent-manager.ts                            # 1 hit (KPR-307 surface voice will consume)

# 6. Test-file anchors:
grep -n 'function makeMockSessionStore' src/agents/agent-manager.test.ts                       # 1 hit
grep -n 'describe("spawnTurn (KPR-216)"' src/agents/agent-manager.test.ts                      # 1 hit
grep -n 'mockLogWarn' src/agents/agent-manager.test.ts                                         # ≥1 hit (311 T3 hoisted spy)
grep -n 'am.sessionStoreGet.mockResolvedValueOnce("resume-sid-xyz")' src/channels/voice/voice-adapter.test.ts   # 1 hit
grep -n 'const sessionStoreGet = vi.fn().mockResolvedValue(opts.storedSessionId);' src/channels/voice/voice-adapter.integration.test.ts  # 1 hit
ls src/agents/session-store.test.ts 2>/dev/null                                                # expect: does not exist
```

- [ ] **Mandatory spec cite refresh:** open `finalizeSpawnResult`, the lambda's acquire/re-resolve/record region, `runWorkItemTurn`, and voice `:247`-region at delivery HEAD and visually confirm they match the shapes the spec §2 table describes (breaker wrap, R4 `timedOut`/`aborted` passthrough, per-adapter fabricated-id lines `codex-subscription-adapter.ts` `codex-pilot-${randomUUID()}` / `state.responseId ?? sessionId` / `store: false`, `gemini-adk-adapter.ts` `gemini-pilot-`, `openai-agents-adapter.ts` `previousResponseId`/`lastResponseId`). Note the refreshed line numbers in the working notes for the review lane.
- [ ] Baseline gate:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: fully green before any edit.

**Escape hatch (drift found):** if any grep misses or hits a different count, or a spec-cited surface no longer matches its §2 description — **make no edits**. Demote to the spec lane (dodi-dev:mature-ticket) with a drift note listing exactly which anchors failed and what is there instead.

**Commit:** none (read-only task).

---

## Task 1 — ⚠8 live-repro gate: pin the poisoned-resume failure shape (BEFORE any guard code)

**Goal:** the ticket's framing was reconciled against the pinned SDK bundle (0.2.104); re-verify the unknown-resume behavior empirically at the **then-installed** SDK version so the rider/guard land against observed reality, not a stale trace. This is spec §8.9's pre-fix half + ⚠A8.

- [ ] Record the installed SDK version:

```bash
npm ls @anthropic-ai/claude-agent-sdk --depth=0   # exports map blocks the package.json subpath require on Node 22+
```

- [ ] **Option A (preferred — dev instance available):** on a dev/test hive instance (NOT a production thread), insert a poisoned row and drive one turn pre-fix:

```bash
# 1. Insert (adjust db/agent to the dev instance; collection is "sessions" — session-store.ts:collection name):
mongosh <dev-db> --eval 'db.sessions.insertOne({_id: "<agent>:sms:test:kpr313", agentId: "<agent>", threadId: "sms:test:kpr313", sessionId: "codex-pilot-00000000-0000-4000-8000-000000000000", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, compactions: 0, createdAt: new Date(), updatedAt: new Date()})'
# 2. Drive one turn on that thread (SMS/WS test channel) against the CURRENT engine (no 313 code).
# 3. Capture: the turn's error string, whether the auth-rebuild retry fired (log line
#    "spawnTurn auth-rebuild-resume"), and the row's post-turn sessionId:
mongosh <dev-db> --eval 'db.sessions.findOne({_id: "<agent>:sms:test:kpr313"})'
```

- [ ] **Option B (fallback — no dev instance in the lane):** scripted resume against the installed CLI bundle:

```bash
node --input-type=module -e '
import { query } from "@anthropic-ai/claude-agent-sdk";
const q = query({ prompt: "say hi", options: { resume: "codex-pilot-00000000-0000-4000-8000-000000000000", maxTurns: 1 } });
try {
  for await (const m of q) {
    if (m.type === "result") console.log(JSON.stringify({ subtype: m.subtype, is_error: m.is_error, session_id: m.session_id, errors: m.errors ?? m.result }));
  }
} catch (e) { console.error("THROWN:", String(e)); }
'
```

Expected shape (per spec §1.2 at 0.2.104): in-band result `subtype: "error_during_execution"`, `is_error: true`, a **freshly minted** `session_id` ≠ the poisoned id, error text containing `No conversation found with session ID`, then exit-code-1 shutdown (`Claude Code process exited with code 1` if the iterator drains).

- [ ] Record the evidence verbatim (error strings, session ids, retry-fired yes/no) in the working notes; it goes into the PR description at submit time.
- [ ] **STOP rule:** demote to the spec lane (dodi-dev:mature-ticket) with the evidence if EITHER: (a) the observed error string **matches** `isAuthRebuildResumeError`'s regex (`resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken`) — the churn/wedge framing would be wrong and the rider's interaction with the retry needs spec-level re-reconciliation; or (b) the unknown-id resume **silently succeeds with empty history and no error** — the rider's error-keyed scope would miss the live vector. Any other drift (different wording, thrown-instead-of-in-band, no fresh mint) — record and **continue**: the guard preempts all vectors by design (spec ⚠A8), only note whether the ⚠A4 rider's "different id on error" trigger still corresponds to a real mint.

**Commit:** none (evidence-only task).

---

## Task 2 — Store contract + every consumer (compile-green in one edit)

**Goal:** `StoredSessionRef` + scrub + `set(provider)` in the store; `RESUMABLE_SESSION_PROVIDERS` in types; all four read sites and the single write site converted; the ⚠A4 rider; voice eligibility-at-read. The return/signature changes force these to land together. The guard itself and the annotation land in Task 4.

- [ ] **`src/agents/provider-adapters/types.ts`** — add directly after the `export type AgentProviderId` line:

```ts
/**
 * KPR-313: providers whose adapters return a GENUINELY resumable session
 * handle. This is the per-adapter session contract — the write-side
 * never-persist rule (finalizeSpawnResult) and the read-side belt-and-braces
 * (SessionStore.get) both key on it. Resumability is a static per-provider
 * fact, not a per-result flag (spec §3.2 / §7):
 *  - claude: SDK resume via query({ resume }) — KPR-310-verified; ids are
 *    stable on 0.2.104 and an older persisted id resumes the LATEST state (M7b).
 *  - openai: previousResponseId chaining (openai-agents-adapter.ts returns
 *    lastResponseId; server retention 30d > store TTL 7d).
 *  - codex: posts store:false and sends no previous_response_id — stateless by
 *    construction; its codex-pilot-* / resp_* returns are not handles.
 *  - gemini: runEphemeral — stateless; gemini-pilot-* returns are not handles.
 * If a pilot ever implements real chaining, adding it here is that ticket's
 * one-line concern.
 */
export const RESUMABLE_SESSION_PROVIDERS: ReadonlySet<AgentProviderId> = new Set(["claude", "openai"]);
```

(The four adapter files are **not** edited — spec §3.2.)

- [ ] **`src/agents/session-store.ts`** — five edits:

1. Imports — old:

```ts
import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
```

New:

```ts
import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { RESUMABLE_SESSION_PROVIDERS, type AgentProviderId } from "./provider-adapters/types.js";
```

2. `SessionDoc` — old field `sessionId: string;` gets a sibling; replace:

```ts
  sessionId: string;
```

with:

```ts
  sessionId: string; // "" ⇒ row exists for thread-mapping only; nothing resumable (KPR-313)
  provider?: AgentProviderId; // KPR-313: producer tag; absent ⇒ legacy (pre-313) row
```

3. Add after the `SessionDoc` interface:

```ts
/**
 * KPR-313: normalized session reference returned by get(). sessionId is
 * present ONLY when the stored handle is genuinely resumable by the tagged
 * provider; provider is undefined only for scrubbed legacy rows (no
 * provenance survives).
 */
export interface StoredSessionRef {
  sessionId: string | undefined; // undefined ⇒ nothing to resume
  provider: AgentProviderId | undefined;
}

/** KPR-313: legacy fabricated pilot ids (and unprovenanced resp_ chain ids) — scrub on read. */
const FABRICATED_SESSION_ID = /^(codex-pilot-|gemini-pilot-|resp_)/;
```

4. `get()` — full replacement of the existing method (old shape anchored in Task 0 #1), plus the private helper and the warn-once set. Add the field near `private collection!`:

```ts
  /** KPR-313: scrub warnings fire once per key per process (bounded by poisoned-row count; rows TTL out ≤7d). */
  private scrubWarned = new Set<string>();
```

New `get()` + helper:

```ts
  /**
   * KPR-313: the single normalization choke point for stored session
   * identity. undefined ⇒ no row at all. Tagged rows normalize ("" ⇒ no
   * handle; non-resumable provider ⇒ no handle, belt-and-braces — post-313
   * writes never store one anyway). Legacy untagged rows: fabricated pilot
   * ids scrub (warn + lazy delete; the 7-day TTL is the backstop — no
   * migration script), anything else grandfathers as claude so the fleet's
   * pre-313 Claude rows keep resuming on upgrade day (spec ⚠A3).
   */
  async get(agentId: string, threadId: string): Promise<StoredSessionRef | undefined> {
    return this.withRetry(async () => {
      let doc = await this.collection.findOne({ _id: `${agentId}:${threadId}` });

      // Fallback: try legacy key format for old "slack:{channel}:{ts}" threadIds
      if (!doc && threadId.startsWith("slack:")) {
        const legacyTs = threadId.split(":").pop()!;
        doc = await this.collection.findOne({ _id: `${agentId}:${legacyTs}` });
      }

      if (!doc) return undefined;
      return this.normalizeRef(doc);
    }, undefined, `get(${agentId}:${threadId})`);
  }

  private normalizeRef(doc: SessionDoc): StoredSessionRef {
    // Tagged row (post-KPR-313 write).
    if (doc.provider) {
      return {
        sessionId: RESUMABLE_SESSION_PROVIDERS.has(doc.provider) ? doc.sessionId || undefined : undefined,
        provider: doc.provider,
      };
    }

    // Legacy untagged row carrying a fabricated pilot id or an unprovenanced
    // resp_ chain id: scrub. The resp_ case is a deliberate tradeoff (spec
    // §3.1): an untagged row has no provenance, and a wrongly-grandfathered
    // resp_ id handed to a Claude resume reproduces exactly the churn loop
    // this ticket kills. One bounded reset beats an unbounded failure mode.
    if (FABRICATED_SESSION_ID.test(doc.sessionId)) {
      if (!this.scrubWarned.has(doc._id)) {
        this.scrubWarned.add(doc._id);
        log.warn("Scrubbed legacy fabricated session id — treating thread as fresh (KPR-313)", {
          key: doc._id,
        });
      }
      // Lazy cleanup, fire-and-forget. MUST stay .catch-swallowed: get() runs
      // inside the R7 breaker window on the reflection re-resolve path — a
      // rejected floating promise from a Mongo blip must not become an
      // unhandled rejection or a new throw surface there (spec §3.1). The
      // sessionId filter guards against deleting a row a concurrent turn
      // already rewrote.
      this.collection.deleteOne({ _id: doc._id, sessionId: doc.sessionId }).catch((err) => {
        log.warn("Lazy scrub delete failed — TTL will reap the row", {
          key: doc._id,
          error: String(err),
        });
      });
      return { sessionId: undefined, provider: undefined };
    }

    // Legacy untagged plain id: grandfathered as claude (pre-313 fleet rows).
    return { sessionId: doc.sessionId || undefined, provider: "claude" };
  }
```

5. `set()` — signature gains the positional 4th param (single production caller, updated below). Old:

```ts
  async set(agentId: string, threadId: string, sessionId: string, tokenData?: {
```

New:

```ts
  async set(agentId: string, threadId: string, sessionId: string, provider: AgentProviderId, tokenData?: {
```

and in the body, old:

```ts
        $set: {
          agentId, threadId, sessionId, updatedAt: now,
        },
```

new:

```ts
        $set: {
          agentId, threadId, sessionId, provider, updatedAt: now,
        },
```

(The store persists what it is given — the resumability *rule* lives in the manager. `delete`/`clearAgent`/`findAgentByThread`/`findAgentsByThread`/TTL index: untouched.)

- [ ] **`src/agents/agent-manager.ts`** — six edits:

1. Import — directly below 312's types import line (`import type { AgentProviderAdapter, AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";`), add:

```ts
import { RESUMABLE_SESSION_PROVIDERS } from "./provider-adapters/types.js";
```

2. `TurnContext` — after the anchored pair:

```ts
  /** undefined on first turn; SDK may rotate post-compaction (KPR-211). */
  sessionId: string | undefined;
```

insert:

```ts
  /**
   * KPR-313: provider tag of the stored session — set wherever sessionId is
   * resolved from the session store (runWorkItemTurn, reflection reads,
   * voice's eligibility-filtered read). Consumed by spawnTurn's
   * session-identity guard. undefined ⇒ nothing known about the row's
   * producer (first turn, or a caller that resolved no session).
   */
  sessionProvider?: AgentProviderId;
  /**
   * KPR-313: set ONLY by spawnTurn's session-identity guard when this turn
   * starts fresh due to a provider change; prepareSpawn prepends the handoff
   * annotation. Never set by callers.
   */
  sessionHandoff?: boolean;
```

3. `runWorkItemTurn` — old:

```ts
    const threadId = item.threadId ?? item.id;
    const sessionId = await this.sessionStore.get(agentId, threadId);

    const ctx: TurnContext = {
      agentId,
      sessionId,
```

New:

```ts
    const threadId = item.threadId ?? item.id;
    const stored = await this.sessionStore.get(agentId, threadId);

    const ctx: TurnContext = {
      agentId,
      sessionId: stored?.sessionId,
      sessionProvider: stored?.provider,
```

4. Reflection re-resolve in the lambda — old (kpr-305 shape, untouched by 311/312):

```ts
      let effectiveCtx = ctx;
      if (ctx.kind === "reflection") {
        const freshSessionId = await this.sessionStore.get(ctx.agentId, ctx.threadId);
        if (freshSessionId !== ctx.sessionId) {
          effectiveCtx = { ...ctx, sessionId: freshSessionId };
        }
      }
```

New:

```ts
      let effectiveCtx = ctx;
      if (ctx.kind === "reflection") {
        const fresh = await this.sessionStore.get(ctx.agentId, ctx.threadId);
        // KPR-313: FIELD-wise staleness compare. get() now returns a ref — a
        // naive `fresh !== ctx.sessionId` would compare ref-vs-string, always
        // mismatch, and (worse) assign a ref where a string id belongs.
        if (fresh?.sessionId !== ctx.sessionId || fresh?.provider !== ctx.sessionProvider) {
          effectiveCtx = { ...ctx, sessionId: fresh?.sessionId, sessionProvider: fresh?.provider };
        }
      }
```

5. Reflection best-effort pre-read in `runReflectionTurn` — old:

```ts
    const sessionId = await this.sessionStore.get(agentId, threadId);
```

(the one inside `runReflectionTurn`, directly above the synthetic `workItem` — NOT the `runWorkItemTurn` one already edited) — new:

```ts
    const stored = await this.sessionStore.get(agentId, threadId);
```

and in the `ctx` literal below it, old:

```ts
      agentId,
      sessionId,
```

new:

```ts
      agentId,
      sessionId: stored?.sessionId,
      sessionProvider: stored?.provider,
```

6. `finalizeSpawnResult` — signature + persist block. Call site first — old:

```ts
      const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult);
```

New:

```ts
      const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult, shaping.route);
```

Then the function head — old:

```ts
  private finalizeSpawnResult(ctx: TurnContext, result: RunResult): TurnResult {
    const newSessionId = result.sessionId || ctx.sessionId || "";
    if (result.sessionId && !result.aborted) {
      // Persist post-spawn — captures session-id rotation post-compaction
      // (KPR-211 verified this fires on resume).
      this.sessionStore.set(ctx.agentId, ctx.threadId, result.sessionId, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        contextWindow: result.contextWindow,
        compactions: result.compactions,
        preCompactTokens: result.preCompactTokens,
      });
    }
```

New:

```ts
  private finalizeSpawnResult(ctx: TurnContext, result: RunResult, route: ProviderModelRoute): TurnResult {
    const newSessionId = result.sessionId || ctx.sessionId || "";
    if (result.sessionId && !result.aborted) {
      // KPR-313 §3.2: persist a resumable handle ONLY for providers whose
      // adapters actually resume. Stateless pilots keep the ROW (the session
      // store doubles as the dispatcher's thread→agent map via
      // findAgentByThread) with an empty sessionId — the row persists, the
      // fake handle never does.
      const resumable = RESUMABLE_SESSION_PROVIDERS.has(route.provider);
      // ⚠A4 churn-mint rider: an ERROR turn that attempted a resume and came
      // back with a DIFFERENT id is a failed-resume mint (the CLI's
      // error_during_execution result carries a freshly minted session_id) —
      // never let it overwrite the row. Error turns may only re-persist the
      // SAME id they resumed (TTL refresh; harmless per M7b — ids are stable
      // and the prior value stays the right handle if the session exists at
      // all). Success-path compaction rotation (KPR-211) is unaffected: no
      // error ⇒ rider never fires.
      const churnMint = !!result.error && !!ctx.sessionId && result.sessionId !== ctx.sessionId;
      if (churnMint) {
        log.warn("Skipping session persist — errored turn returned a different id than it resumed (KPR-313)", {
          agentId: ctx.agentId,
          threadId: ctx.threadId,
        });
      } else {
        // Persist post-spawn — captures session-id rotation post-compaction
        // (KPR-211 verified this fires on resume).
        this.sessionStore.set(ctx.agentId, ctx.threadId, resumable ? result.sessionId : "", route.provider, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          contextWindow: result.contextWindow,
          compactions: result.compactions,
          preCompactTokens: result.preCompactTokens,
        });
      }
    }
```

Everything below (state bookkeeping, the returned `TurnResult` incl. R4 `timedOut`/`aborted`) is **unchanged**. `TurnResult.newSessionId` derivation is deliberately untouched — consumers see what ran, not what persisted (spec §3.2).

- [ ] **`src/channels/voice/voice-adapter.ts`** — two edits in `spawnTurnViaAgentManager`:

1. The read + eligibility (⚠A10) — old:

```ts
    const sessionStore = agentManager.getSessionStore();
    const storedSessionId = await sessionStore.get(agentId, threadId);

    // Choose prompt based on resume-presence (mirrors current voice behavior).
    const turnPrompt = storedSessionId
      ? extractLatestUserMessage(request.messages)
      : renderConversationPrompt(request.messages);
    const safePrompt = storedSessionId && !turnPrompt ? renderConversationPrompt(request.messages) : turnPrompt;
    const effectiveResume = storedSessionId && turnPrompt ? storedSessionId : undefined;
```

New:

```ts
    const sessionStore = agentManager.getSessionStore();
    const storedRef = await sessionStore.get(agentId, threadId);

    // KPR-313 §3.5: provider eligibility applied at voice's OWN read — not
    // left to the spawnTurn guard. Voice chooses its prompt SHAPE from
    // resume-presence; if a mismatched-provider id flowed through and the
    // guard stripped it downstream, the turn would succeed fresh with only
    // the latest user message — a silent mid-call context loss the pre-313
    // hard failure never caused. On mismatch we treat the thread as
    // no-resume, so renderConversationPrompt fires and the full in-call
    // transcript IS voice's handoff. providerFor is the KPR-307 static-route
    // read (same resolveProviderModel as the breaker wrap); null (agent
    // vanished mid-call, SIGUSR1) degrades to no-resume — fail-soft.
    const staticProvider = agentManager.providerFor(agentId);
    const resumableId =
      storedRef && staticProvider && storedRef.provider === staticProvider
        ? storedRef.sessionId
        : undefined;

    // Choose prompt based on resume-presence (mirrors current voice behavior).
    const turnPrompt = resumableId
      ? extractLatestUserMessage(request.messages)
      : renderConversationPrompt(request.messages);
    const safePrompt = resumableId && !turnPrompt ? renderConversationPrompt(request.messages) : turnPrompt;
    const effectiveResume = resumableId && turnPrompt ? resumableId : undefined;
```

2. The ctx literal — old:

```ts
      sessionId: effectiveResume,
```

New:

```ts
      sessionId: effectiveResume,
      // KPR-313: tag travels only when a resume is actually attempted; on a
      // provider mismatch BOTH stay unset — the full transcript above is
      // voice's handoff, and the spawnTurn guard then has nothing to trip on
      // (the voice carve-out stays annotation-free).
      sessionProvider: effectiveResume ? (staticProvider ?? undefined) : undefined,
```

(The outer retry block, `runOnce`, telemetry lines using `effectiveResume`: **untouched**.)

- [ ] **Mechanical test-harness ripple** (keeps the suite green — behavior assertions unmodified):

`src/agents/agent-manager.test.ts` — replace `makeMockSessionStore`:

```ts
function makeMockSessionStore() {
  // KPR-313: records mirror the real store's rows; get() applies the same
  // ""-⇒-undefined normalization the real choke point does.
  const sessions = new Map<string, { sessionId: string; provider: string }>();
  return {
    get: vi.fn().mockImplementation(async (agentId: string, threadId: string) => {
      const rec = sessions.get(`${agentId}:${threadId}`);
      if (!rec) return undefined;
      return { sessionId: rec.sessionId || undefined, provider: rec.provider };
    }),
    set: vi.fn().mockImplementation(
      async (agentId: string, threadId: string, sessionId: string, provider: string, _tokenData?: any) => {
        sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      },
    ),
    delete: vi.fn(),
    clearAgent: vi.fn(),
    findAgentByThread: vi.fn().mockImplementation(async (threadId: string) => {
      for (const key of sessions.keys()) {
        if (key.endsWith(`:${threadId}`)) return key.slice(0, key.length - threadId.length - 1);
      }
      return undefined;
    }),
    _sessions: sessions,
  };
}
```

Then the mechanical assertion updates (each is a find-and-adjust; behavior identical):
  - Happy-path persist pin (`Session-store updated under (agentId, threadId)`): insert `"claude",` as the 4th expected arg before the `expect.objectContaining({ inputTokens: 100, … })`.
  - KPR-306 wrap test's direct seed `sessionStore.set("agent-a", "sms:line-1:wrap", "stored-session", undefined as any)` → `sessionStore.set("agent-a", "sms:line-1:wrap", "stored-session", "claude", undefined as any)`.
  - Rotation test (`persists rotated sessionId across a 3-turn conversation`): every `await sessionStore.get(…)` comparison gains `?.sessionId` (e.g. `expect((await sessionStore.get("agent-a", threadId))?.sessionId).toBe("session-A")`), and each `sessionId: sessN` ctx override becomes `sessionId: sessN?.sessionId` (add `sessionProvider: sessN?.provider` where the variable is threaded, keeping the test's read-what-you-wrote semantics).
  - `smsCtx` — extend the overrides `Partial<{…}>` with `sessionProvider: AgentProviderId | undefined;` and thread it: `sessionProvider: overrides.sessionProvider,` in the returned ctx. Add `import type { AgentProviderId } from "./provider-adapters/types.js";` to the test file's imports.
  - Any other `sessionStore.get`/`set`-value assertions found by `npx vitest run src/agents/agent-manager.test.ts` failures: convert to `?.sessionId` field access — mechanical only; if an assertion's *meaning* would have to change, stop (rule 2/3).

`src/channels/voice/voice-adapter.test.ts` — `AgentManagerStub` gains `providerFor: ReturnType<typeof vi.fn>;`; in `makeAgentManager` add `const providerFor = vi.fn().mockReturnValue("claude");` and return it; in `makeVoiceAdapter`'s `agentManager` object add `providerFor: am.providerFor,`. Update fixtures: `"resume-sid-xyz"` → `{ sessionId: "resume-sid-xyz", provider: "claude" }`; `"stale-sid"` → `{ sessionId: "stale-sid", provider: "claude" }`; `"persistent-stale-sid"` → `{ sessionId: "persistent-stale-sid", provider: "claude" }`; `"session-abc"` → `{ sessionId: "session-abc", provider: "claude" }`. Assertions unchanged (the outer-retry and circuit-open behavior pins must pass as-is).

`src/channels/voice/voice-adapter.integration.test.ts` — old:

```ts
  const sessionStoreGet = vi.fn().mockResolvedValue(opts.storedSessionId);
```

new:

```ts
  const sessionStoreGet = vi.fn().mockResolvedValue(
    opts.storedSessionId ? { sessionId: opts.storedSessionId, provider: "claude" } : undefined,
  );
```

and add `providerFor: vi.fn().mockReturnValue("claude"),` to its `agentManager` object.

- [ ] Verify:

```bash
npm run typecheck
npx vitest run src/agents/agent-manager.test.ts src/channels/voice/ src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts
```
Expected: green. Notably: the auth-rebuild retry test, both voice outer-retry tests, and the KPR-306/307/311/312 describes pass with **zero assertion-meaning changes**. If the pilot `it.each` routing tests assert a persisted pilot session id, update them to the `""` + tag shape (that IS the spec'd behavior change — cite spec §3.2 in the diff).

- [ ] **Commit:** `KPR-313: W3.4 T2 — StoredSessionRef store contract, scrub, never-persist rule + churn-mint rider, voice eligibility-at-read`

---

## Task 3 — Store-level unit tests (`session-store.test.ts`, NEW — groups 1 & 8)

- [ ] Create `src/agents/session-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted warn spy — scrub warnings and the .catch-swallow are assertable.
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockLogWarn, error: vi.fn(), debug: vi.fn() }),
}));

import { SessionStore } from "./session-store.js";

function makeMockDb() {
  const findOne = vi.fn().mockResolvedValue(null);
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
  const createIndex = vi.fn().mockResolvedValue("ix");
  const countDocuments = vi.fn().mockResolvedValue(0);
  const find = vi.fn();
  const collection = vi.fn().mockReturnValue({
    findOne, updateOne, deleteOne, deleteMany, createIndex, countDocuments, find,
  });
  return { db: { collection } as any, mocks: { findOne, updateOne, deleteOne } };
}

const KEY = "agent-a:sms:line-1:t1";
function doc(sessionId: string, provider?: string) {
  return {
    _id: KEY,
    agentId: "agent-a",
    threadId: "sms:line-1:t1",
    sessionId,
    ...(provider ? { provider } : {}),
  };
}

describe("SessionStore — StoredSessionRef normalization + scrub (KPR-313)", () => {
  let store: SessionStore;
  let mocks: ReturnType<typeof makeMockDb>["mocks"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const m = makeMockDb();
    store = new SessionStore(m.db);
    mocks = m.mocks;
    await store.init();
  });

  it("set() writes the provider tag into $set", async () => {
    await store.set("agent-a", "sms:line-1:t1", "s-1", "claude", undefined);
    const [filter, update] = mocks.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ _id: KEY });
    expect(update.$set).toMatchObject({ sessionId: "s-1", provider: "claude" });
  });

  it("tagged resumable row round-trips; tagged rows are never scrubbed", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("s-1", "claude"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "s-1",
      provider: "claude",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it('sessionId:"" pilot row ⇒ { sessionId: undefined, provider } — thread-mapping row, nothing resumable', async () => {
    mocks.findOne.mockResolvedValueOnce(doc("", "codex"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: undefined,
      provider: "codex",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it("belt-and-braces: non-resumable tag with a non-empty id yields NO handle (and no scrub)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("resp_abc", "gemini"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: undefined,
      provider: "gemini",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it("openai-tagged resp_ row IS resumable (previousResponseId chaining)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("resp_abc", "openai"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "resp_abc",
      provider: "openai",
    });
  });

  it("legacy untagged plain uuid grandfathers as claude (fleet-upgrade no-op)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("3f2a77aa-1111-4222-8333-444455556666"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
      sessionId: "3f2a77aa-1111-4222-8333-444455556666",
      provider: "claude",
    });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it.each(["codex-pilot-9d0e", "gemini-pilot-9d0e", "resp_9d0e"])(
    "scrubs legacy untagged fabricated id %s: absent ref, warn, id-guarded lazy delete",
    async (sessionId) => {
      mocks.findOne.mockResolvedValue(doc(sessionId));
      await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
        sessionId: undefined,
        provider: undefined,
      });
      expect(mocks.deleteOne).toHaveBeenCalledWith({ _id: KEY, sessionId });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("fabricated session id"),
        expect.objectContaining({ key: KEY }),
      );
    },
  );

  it("scrub warns once per key across repeated reads (lazy delete may repeat, warn must not)", async () => {
    mocks.findOne.mockResolvedValue(doc("codex-pilot-abc"));
    await store.get("agent-a", "sms:line-1:t1");
    await store.get("agent-a", "sms:line-1:t1");
    const scrubWarns = mockLogWarn.mock.calls.filter(([msg]) =>
      String(msg).includes("fabricated session id"),
    );
    expect(scrubWarns).toHaveLength(1);
  });

  it("legacy-slack fallback path returns the same normalized shape (and scrubs the legacy row)", async () => {
    mocks.findOne
      .mockResolvedValueOnce(null) // canonical key miss
      .mockResolvedValueOnce({
        _id: "agent-a:1712.34",
        agentId: "agent-a",
        threadId: "1712.34",
        sessionId: "codex-pilot-zzz",
      });
    await expect(store.get("agent-a", "slack:C123:1712.34")).resolves.toEqual({
      sessionId: undefined,
      provider: undefined,
    });
    expect(mocks.findOne).toHaveBeenNthCalledWith(2, { _id: "agent-a:1712.34" });
    expect(mocks.deleteOne).toHaveBeenCalledWith({ _id: "agent-a:1712.34", sessionId: "codex-pilot-zzz" });
  });

  it("no row anywhere ⇒ undefined (not a ref)", async () => {
    mocks.findOne.mockResolvedValue(null);
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toBeUndefined();
  });

  it("§8.8 scrub throw-safety: a rejecting deleteOne is .catch-swallowed — ref still returned, warn logged, no unhandled rejection", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("gemini-pilot-boom"));
    mocks.deleteOne.mockRejectedValueOnce(new Error("mongo blip"));
    const ref = await store.get("agent-a", "sms:line-1:t1");
    expect(ref).toEqual({ sessionId: undefined, provider: undefined });
    // Let the floating deleteOne rejection settle; the .catch must have eaten it.
    await new Promise((r) => setImmediate(r));
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Lazy scrub delete failed"),
      expect.objectContaining({ error: expect.stringContaining("mongo blip") }),
    );
  });

  it("findOne failure fail-softs to undefined (unchanged degraded mode — fresh turn, guard no-op)", async () => {
    mocks.findOne.mockRejectedValueOnce(new Error("down"));
    await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toBeUndefined();
  });
});
```

- [ ] Verify:

```bash
npx vitest run src/agents/session-store.test.ts
```
Expected: all green.

- [ ] **Commit:** `KPR-313: W3.4 T3 — session-store unit tests: tag round-trip, scrub, throw-safety, legacy-slack fallback`

---

## Task 4 — The guard + the handoff annotation (source)

**Goal:** spec §3.3 + §3.4. A pure compare on the hot path; one post-lock re-read only on trip; annotation prepend in `prepareSpawn`. R7 order (`acquire` → re-resolve → **guard** → `recordSpawn` → `prepareSpawn` → attempt(s) → one `record()`) — nothing crosses the boundary.

All edits in `src/agents/agent-manager.ts`.

- [ ] **Handoff constants** — insert directly above `function isAuthRebuildResumeError`:

```ts
/**
 * KPR-313 §3.4: hive-owned handoff annotation, prepended by prepareSpawn
 * when spawnTurn's session-identity guard reset thread continuity. Binding
 * content requirements (spec): the engine changed, prior turns in this
 * thread are not in context, agent memory is intact. The conversation_search
 * recall clause is Claude-target only — pilot adapters run tool-free
 * (assertToolFreePilot in codex/gemini; openai gets the no-tool variant regardless), so the pilot variant must not suggest a tool the
 * agent cannot reach. Voice never sees either (carve-out returns first;
 * voice's handoff is its full-transcript re-send).
 */
const SESSION_HANDOFF_NOTICE_CLAUDE =
  "[System notice: this thread's session continuity was reset because your underlying engine changed. Earlier turns in this thread are not in your context, but your agent memory is intact — use conversation_search if you need prior context from this thread.]\n";
const SESSION_HANDOFF_NOTICE_PILOT =
  "[System notice: this thread's session continuity was reset because your underlying engine changed. Earlier turns in this thread are not in your context, but your agent memory is intact.]\n";
```

- [ ] **The guard** — insert between the (Task 2-edited) reflection re-resolve block's closing `}` and the anchored line `if (!effectiveCtx.sessionId) this.recordSpawn(effectiveCtx.workItem.source.id);`:

```ts
      // KPR-313: session-identity guard. Resume only a same-provider handle;
      // on any provider transition with prior thread state, hand off (fresh +
      // memory + annotation). Hot path is a pure compare — zero I/O; R7 order
      // (acquire → re-resolve → guard → recordSpawn → prepareSpawn → record)
      // intact. On trip ONLY: one authoritative post-lock store re-read —
      // non-reflection turns capture sessionId+tag PRE-lock (runWorkItemTurn),
      // so under same-thread contention across a provider transition the
      // captured tag is stale by a full turn; the re-read adopts the queue-
      // predecessor's already-switched session instead of dropping its
      // exchange (⚠A9). The trip condition keys on sessionProvider alone, not
      // sessionId: a codex-tagged row with sessionId:"" read by a claude turn
      // has nothing to resume but DOES have invisible prior thread turns —
      // the annotation must still fire. `route` is the acquire-time static
      // route; under the W3 clamp it is provably ≡ shaping.route.provider
      // (KPR-311 §5). Lifting the clamp re-keys acquire AND this guard
      // together (parked: kpr-311-spec §5 → W3.5/KPR-314). The re-read is
      // withRetry fail-soft (never throws) and dereferences no registry —
      // no new throw surface inside the R7 window.
      if (effectiveCtx.sessionProvider && effectiveCtx.sessionProvider !== route.provider) {
        const fresh = await this.sessionStore.get(ctx.agentId, ctx.threadId); // post-lock ⇒ authoritative
        if (fresh?.provider === route.provider) {
          // A queued predecessor already performed the switch — adopt its
          // state, no handoff. fresh.sessionId may itself be undefined
          // (predecessor was a stateless pilot turn): the turn then runs
          // fresh WITHOUT an annotation, which is exactly the same-provider
          // stateless case where no transition annotation is owed.
          effectiveCtx = { ...effectiveCtx, sessionId: fresh.sessionId, sessionProvider: fresh.provider };
        } else {
          log.warn("Session provider mismatch — fresh session with memory handoff (KPR-313)", {
            agentId: ctx.agentId,
            threadId: ctx.threadId,
            stored: effectiveCtx.sessionProvider,
            turn: route.provider,
            hadSessionId: !!effectiveCtx.sessionId,
          });
          effectiveCtx = { ...effectiveCtx, sessionId: undefined, sessionHandoff: true };
        }
      }
```

- [ ] **Annotation prepend in `prepareSpawn`** — anchored inside 311's rewritten body (as amended by 312): between the files block and the router-gate comment. Old:

```ts
    if (item.files?.length) {
      prompt += formatFilesForPrompt(item.files);
    }

    // Router gate (KPR-311): skip when disabled, for system senders
```

New:

```ts
    if (item.files?.length) {
      prompt += formatFilesForPrompt(item.files);
    }

    // KPR-313 §3.4: hive-owned handoff annotation — sessionHandoff is set
    // ONLY by spawnTurn's session-identity guard. Prepended ahead of the
    // sender prefix; memory carryover needs nothing here (every fresh spawn
    // already assembles the full system prompt incl. agent memory). Variant
    // keyed on the static provider (≡ effective under the W3 clamp): pilots
    // are tool-free, so only Claude targets get the conversation_search clause.
    if (ctx.sessionHandoff) {
      prompt =
        (staticRoute.provider === "claude"
          ? SESSION_HANDOFF_NOTICE_CLAUDE
          : SESSION_HANDOFF_NOTICE_PILOT) + prompt;
    }

    // Router gate (KPR-311): skip when disabled, for system senders
```

(The voice carve-out branch returns before this point — annotation-free by construction. Touch nothing else in `prepareSpawn`: 311's gate/clamp/merge and 312's `effortOverride` lines stay byte-identical.)

- [ ] Verify (existing suites must pass unmodified — the guard is inert until a caller sets `sessionProvider` to a mismatched value, which only the new Task 5/6 tests and real store reads do):

```bash
npm run typecheck
npx vitest run src/agents/agent-manager.test.ts src/channels/voice/
```
Expected: green.

- [ ] **Commit:** `KPR-313: W3.4 T4 — session-identity guard (re-resolve-on-trip) + fresh-context+memory handoff annotation`

---

## Task 5 — Manager-level tests: guard, race, persist rule, round trip, reflection (groups 2–5, 7)

All edits in `src/agents/agent-manager.test.ts`. New describe nested inside `describe("spawnTurn (KPR-216)")`, placed after the KPR-307 describe (uses `smsCtx`, `makeWorkItem`, `makeAgentConfig`, `makeRunResult`, `mockLogWarn`, the upgraded mock store).

- [ ] Add:

```ts
    describe("session-identity guard + persist rule (KPR-313)", () => {
      function seed(threadId: string, sessionId: string, provider: string, agentId = "agent-a") {
        sessionStore._sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      }

      it("trips on stored tag ≠ turn provider: fresh session, claude annotation, new-session metric, exactly ONE trip-path store read", async () => {
        const recordSpawnSpy = vi.spyOn(manager as any, "recordSpawn");
        const threadId = "sms:line-1:kpr313-trip";
        seed(threadId, "resp_stale", "openai");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "fresh", sessionId: "s-new" }));

        await manager.spawnTurn(smsCtx({ threadId, sessionId: "resp_stale", sessionProvider: "openai" }));

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined(); // resume stripped
        expect(prompt.startsWith("[System notice:")).toBe(true); // annotation prepended before sender prefix
        expect(prompt).toContain("session continuity was reset");
        expect(prompt).toContain("conversation_search"); // claude-target variant
        expect(prompt).toContain("hello over sms"); // original text intact
        expect(recordSpawnSpy).toHaveBeenCalledTimes(1); // counted as a new session
        expect(sessionStore.get).toHaveBeenCalledTimes(1); // the authoritative re-read — trip path only
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("provider mismatch"),
          expect.objectContaining({ stored: "openai", turn: "claude", hadSessionId: true }),
        );
      });

      it("same-provider tag resumes with ZERO store reads on the hot path (also the untagged-legacy fleet-upgrade pin — grandfathered rows arrive as claude)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-1" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr313-match", sessionId: "s-1", sessionProvider: "claude" }),
        );
        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBe("s-1");
        expect(prompt).not.toContain("session continuity was reset");
        expect(sessionStore.get).not.toHaveBeenCalled(); // zero-I/O hot path
      });

      it("codex-tagged empty row + claude turn: nothing to resume AND the annotation still fires (round-trip return leg)", async () => {
        const threadId = "sms:line-1:kpr313-return";
        seed(threadId, "", "codex"); // re-read stays codex ⇒ handoff, not adopt
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "back", sessionId: "s-back" }));

        await manager.spawnTurn(smsCtx({ threadId, sessionId: undefined, sessionProvider: "codex" }));

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined();
        expect(prompt).toContain("session continuity was reset"); // keyed on the TAG, not the id
      });

      it("claude→pilot handoff uses the pilot annotation variant (no conversation_search — pilots are tool-free)", async () => {
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        const threadId = "sms:line-1:kpr313-topilot";
        seed(threadId, "claude-uuid-1", "claude", "codex-pilot");

        await manager.spawnTurn(
          smsCtx({ agentId: "codex-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
        );

        const req = mockCodexRunTurn.mock.calls[0]![0];
        expect(req.sessionId).toBeUndefined();
        expect(req.prompt).toContain("session continuity was reset");
        expect(req.prompt).not.toContain("conversation_search");
      });

      it("⚠A9 re-resolve-on-trip: queued same-thread turn ADOPTS the predecessor's switched session instead of double-dropping", async () => {
        const threadId = "sms:line-1:kpr313-race";
        seed(threadId, "resp_stale", "openai");
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ text: "A", sessionId: "s-A" }))
          .mockResolvedValueOnce(makeRunResult({ text: "B", sessionId: "s-A" }));

        // Both turns read the store PRE-lock (runWorkItemTurn) and capture the
        // stale openai tag; the per-thread lock then serializes the spawns.
        // Determinism note: both pre-lock reads resolve before A persists only
        // under the all-mocked microtask scheduling — if the harness gains real
        // async, add an explicit ordering assertion (A's set before B's send).
        const mk = (text: string) =>
          makeWorkItem({ text, threadId, source: { kind: "sms" as const, id: "line-1", label: "May" }, sender: "+1" });
        const p1 = manager.runWorkItemTurn("agent-a", mk("turn A"));
        const p2 = manager.runWorkItemTurn("agent-a", mk("turn B"));
        await Promise.all([p1, p2]);

        // Turn A tripped: fresh + handoff, persisted (s-A, claude).
        const [promptA, resumeA] = mockRunnerSend.mock.calls[0]!;
        expect(resumeA).toBeUndefined();
        expect(promptA).toContain("session continuity was reset");
        // Turn B's captured tag was a full turn stale — the post-lock re-read
        // returned A's claude row and B adopted it: resumed s-A, NO second
        // handoff, A's exchange preserved.
        const [promptB, resumeB] = mockRunnerSend.mock.calls[1]!;
        expect(resumeB).toBe("s-A");
        expect(promptB).not.toContain("session continuity was reset");
      });

      it("persist rule: claude id+tag; codex ''+tag with findAgentByThread intact; gemini ''+tag", async () => {
        // Claude
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-c" }));
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr313-p-claude" }));
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-a", "sms:line-1:kpr313-p-claude", "s-c", "claude", expect.anything(),
        );

        // Codex — adapter returns a fabricated id ("codex-session" fixture); store must get "".
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr313-p-codex" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "codex-pilot", "sms:line-1:kpr313-p-codex", "", "codex", expect.anything(),
        );
        // The ROW survives — thread→agent mapping intact (the ticket's rule, literally).
        await expect(sessionStore.findAgentByThread("sms:line-1:kpr313-p-codex")).resolves.toBe("codex-pilot");

        // Gemini
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "Gemini Pilot", model: "gemini/gemini-3-pro", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "gemini-pilot", threadId: "sms:line-1:kpr313-p-gem" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "gemini-pilot", "sms:line-1:kpr313-p-gem", "", "gemini", expect.anything(),
        );
      });

      it("persist rule: openai persists its resp id with the openai tag (genuinely resumable)", async () => {
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OpenAI Pilot", model: "openai/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "openai-pilot", threadId: "sms:line-1:kpr313-p-oai" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "openai-pilot", "sms:line-1:kpr313-p-oai", "openai-session", "openai", expect.anything(),
        );
      });

      it("⚠A4 churn-mint rider: errored turn that resumed and returned a DIFFERENT id never overwrites the row", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ error: "No conversation found with session ID: s-old", sessionId: "s-minted" }),
        );
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr313-mint", sessionId: "s-old", sessionProvider: "claude" }),
        );
        expect(sessionStore.set).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("different id"),
          expect.objectContaining({ agentId: "agent-a" }),
        );
      });

      it("errored turn that returned the SAME id it resumed re-persists (TTL refresh — M7b fault non-poisoning)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "tool blew up", sessionId: "s-same" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr313-same", sessionId: "s-same", sessionProvider: "claude" }),
        );
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-a", "sms:line-1:kpr313-same", "s-same", "claude", expect.anything(),
        );
      });

      it("first-turn error with a fresh id persists (rider scoped to attempted resumes)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "tool blew up", sessionId: "s-first" }));
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr313-first" }));
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-a", "sms:line-1:kpr313-first", "s-first", "claude", expect.anything(),
        );
      });

      it("end-to-end claude→codex→claude round trip via runWorkItemTurn: both directions trip, both variants, row state correct after each turn", async () => {
        registry._agents.set("flip", makeAgentConfig({ id: "flip", name: "Flip", model: "claude-sonnet-4-6" }));
        const threadId = "sms:line-1:kpr313-flip";
        const mk = (text: string) =>
          makeWorkItem({ text, threadId, source: { kind: "sms" as const, id: "line-1", label: "May" }, sender: "+1" });

        // Turn 1 — claude: persists (s-1, claude).
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-1" }));
        await manager.runWorkItemTurn("flip", mk("t1"));
        expect(sessionStore._sessions.get(`flip:${threadId}`)).toEqual({ sessionId: "s-1", provider: "claude" });

        // Operator flips to codex (SIGUSR1 analog) — claude→pilot direction.
        registry._agents.set(
          "flip",
          makeAgentConfig({ id: "flip", name: "Flip", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.runWorkItemTurn("flip", mk("t2"));
        const codexReq = mockCodexRunTurn.mock.calls.at(-1)![0];
        expect(codexReq.sessionId).toBeUndefined();
        expect(codexReq.prompt).toContain("session continuity was reset");
        expect(codexReq.prompt).not.toContain("conversation_search"); // pilot variant
        expect(sessionStore._sessions.get(`flip:${threadId}`)).toEqual({ sessionId: "", provider: "codex" });

        // Flip back — pilot→claude direction.
        registry._agents.set("flip", makeAgentConfig({ id: "flip", name: "Flip", model: "claude-sonnet-4-6" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-3" }));
        await manager.runWorkItemTurn("flip", mk("t3"));
        const [prompt3, resume3] = mockRunnerSend.mock.calls.at(-1)!;
        expect(resume3).toBeUndefined(); // codex row had nothing to resume
        expect(prompt3).toContain("conversation_search"); // claude variant fired off the TAG alone
        expect(sessionStore._sessions.get(`flip:${threadId}`)).toEqual({ sessionId: "s-3", provider: "claude" });
      });

      it("reflection re-resolve is FIELD-wise: same stored id/provider still hands runner.send the STRING id (ref-vs-string regression pin), one get only", async () => {
        const threadId = "sms:line-1:kpr313-reflect";
        seed(threadId, "s-r", "claude");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-r" }));

        await manager.spawnTurn({
          ...smsCtx({ threadId, sessionId: "s-r", sessionProvider: "claude" }),
          kind: "reflection" as const,
        });

        const [, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBe("s-r"); // a string — a ref-vs-string compare would have rebuilt ctx with a ref here
        expect(sessionStore.get).toHaveBeenCalledTimes(1); // re-resolve only; guard added no trip read
      });

      it("reflection after a provider edit runs fresh without throwing (re-resolve surfaces the tag, guard handles it)", async () => {
        const threadId = "sms:line-1:kpr313-reflect-flip";
        seed(threadId, "resp_x", "openai"); // stale reflection capture: agent now claude-static
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "reflected fresh", sessionId: "s-fresh" }));

        const result = await manager.spawnTurn({
          ...smsCtx({ threadId, sessionId: undefined, sessionProvider: undefined }),
          kind: "reflection" as const,
        });

        expect(result.errors).toEqual([]);
        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined();
        expect(prompt).toContain("session continuity was reset"); // no special-casing for reflection (⚠A7)
        expect(sessionStore.get).toHaveBeenCalledTimes(2); // re-resolve + trip re-read (redundant-but-idempotent)
      });
    });
```

- [ ] Verify:

```bash
npx vitest run src/agents/agent-manager.test.ts
```
Expected: all green, including every pre-existing describe.

- [ ] **Negative-verify #1 (⚠A9 — contention re-read; repo convention):** temporarily replace the guard's trip branch with an unconditional handoff (delete the `const fresh = …` re-read and the adopt branch, keep only the `log.warn` + strip). Run the suite — **the race test MUST fail** (turn B resumes `undefined` and carries a second annotation: the double-drop). Revert. Do not commit the mutation.
- [ ] **Negative-verify #2 (⚠A4 — rider):** temporarily delete the `churnMint` check in `finalizeSpawnResult` (always persist). Run — **the churn-mint test MUST fail** (`set` called with `s-minted`). Revert.
- [ ] **Commit:** `KPR-313: W3.4 T5 — guard/race/persist/round-trip/reflection tests + negative-verifies`

---

## Task 6 — Voice tests (group 6) + negative-verify

All edits in `src/channels/voice/voice-adapter.test.ts` (harness already ref-shaped from Task 2). Add inside `describe("VoiceAdapter — spawnTurnViaAgentManager")`:

- [ ] Add:

```ts
  it("KPR-313: provider mismatch at the read ⇒ no resume, no tag, FULL-transcript prompt (voice's native handoff), no annotation", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValueOnce({ sessionId: "resp_openai_123", provider: "openai" });
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "first user line" },
        { role: "assistant", content: "first agent line" },
        { role: "user", content: "latest user line" },
      ],
    });

    await callHandle(adapter, req, res);

    const ctx = am.calls[0]!.ctx;
    expect(ctx.sessionId).toBeUndefined(); // mismatched handle never attempted
    expect(ctx.sessionProvider).toBeUndefined(); // spawnTurn guard has nothing to trip on
    // FULL transcript, not latest-message-only — pre-313 the doomed resume
    // failed HARD and the outer retry re-sent the transcript; a naive
    // guard-strip downstream would have silently sent only the last line.
    expect(ctx.workItem.text).toContain("Caller: first user line");
    expect(ctx.workItem.text).toContain("You: first agent line");
    expect(ctx.workItem.text).toContain("Caller: latest user line");
    // Voice carve-out: annotation-free (the transcript IS the handoff).
    expect(ctx.workItem.text).not.toContain("session continuity was reset");
  });

  it("KPR-313: codex-tagged mapping-only row (no handle) ⇒ full transcript, no resume", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValueOnce({ sessionId: undefined, provider: "codex" });
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "still here" },
      ],
    });

    await callHandle(adapter, req, res);

    const ctx = am.calls[0]!.ctx;
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.workItem.text).toContain("Caller: hi");
    expect(ctx.workItem.text).toContain("Caller: still here");
  });

  it("KPR-313: matching provider keeps today's behavior — latest-message prompt, resume, tag set", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValueOnce({ sessionId: "resume-sid-match", provider: "claude" });
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "earlier line" },
        { role: "user", content: "latest user line" },
      ],
    });

    await callHandle(adapter, req, res);

    const ctx = am.calls[0]!.ctx;
    expect(ctx.sessionId).toBe("resume-sid-match");
    expect(ctx.sessionProvider).toBe("claude");
    expect(ctx.workItem.text).toBe("latest user line");
    expect(am.providerFor).toHaveBeenCalledWith("mokie");
  });
```

- [ ] Verify:

```bash
npx vitest run src/channels/voice/
```
Expected: green — new tests plus every pre-existing outer-retry / circuit-open / prompt-shape pin.

- [ ] **Negative-verify (§8.6, MANDATORY):** temporarily bypass the eligibility compare in `voice-adapter.ts` — change the `resumableId` derivation to `const resumableId = storedRef?.sessionId;` (i.e., leave eligibility to the spawnTurn guard). Run `npx vitest run src/channels/voice/voice-adapter.test.ts` — **the mismatch test MUST fail** with `ctx.workItem.text` equal to `"latest user line"` (the silent latest-message-only regression this rule exists to prevent). Revert. Do not commit the mutation.
- [ ] **Commit:** `KPR-313: W3.4 T6 — voice eligibility-at-read tests (full-transcript handoff pin + negative-verify)`

---

## Task 7 — Post-fix live confirmation + full gate

- [ ] **Post-fix half of the §8.9 repro (only if Task 1 ran Option A):** on the same dev instance, now running the 313 build: drive one turn on the poisoned thread. Confirm: (a) the scrub warn (`Scrubbed legacy fabricated session id`) appears in the logs; (b) the turn succeeds fresh with **no** annotation (scrub leaves no provider signal — spec §5 row 1); (c) the row is healed with a real id + `provider: "claude"` (`mongosh … db.sessions.findOne(...)`). Then delete the test row. If Task 1 used Option B, this step is covered by the unit surface (store scrub tests + guard e2e) — note that in the evidence.
- [ ] Full gate from the worktree root:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck, ESLint, Prettier, full Vitest — all pass, with the output actually listing all four gates (worktree/CI asymmetry check).

- [ ] If Prettier reformats any touched file, apply (`npm run format`) and fold into a final commit.
- [ ] **Commit** (only if format/lint produced changes): `KPR-313: W3.4 T7 — format/lint pass`

Done — hand off to dodi-dev:review with the Task 1 (and Task 7, if Option A) evidence attached for the PR description. No Linear writes, no PR from this plan (the lane's submit skill owns that).

---

## Assumptions

1. **Post-W2+311+312 execution:** the delivery worktree branches from the epic branch after all three land; Task 0 verifies by content (311/312 anchors are their plans' own introduced strings) and hard-stops on drift. Spec ⚠A1–⚠A9 are settled — implemented without re-litigation.
2. **⚠A10 decided — voice consumes `agentManager.providerFor(agentId)`:** neither export nor relocation of `resolveProviderModel`; the KPR-307 public surface is the purpose-built out-of-manager read of the static route provider, so voice/dispatcher/breaker key off one resolution and `resolveProviderModel` stays private beside its route types. `null` ⇒ treated as mismatch ⇒ fail-soft full-transcript turn.
3. **The four adapter files receive zero edits:** the "per-adapter session contract" is declared once as `RESUMABLE_SESSION_PROVIDERS` + its JSDoc in `provider-adapters/types.ts` (spec §3.2 "adapters are untouched"; §7 "no RunResult/adapter interface changes").
4. **Annotation wording is plan-level** (spec §3.4 made content requirements binding, wording ours): both constants state engine-change, missing thread context, intact memory; only the Claude variant carries the `conversation_search` clause. Tests pin substrings (`session continuity was reset`, `conversation_search`), not full strings, so review-lane wording polish doesn't churn tests.
5. **Scrub warn-once is per-process** (a `Set` on the store, bounded by poisoned-key count, self-extinguishing with the ≤7-day TTL); the lazy `deleteOne` filter includes `sessionId` so a concurrently-rewritten row is never deleted.
6. **Mock session store mirrors real normalization only as far as the manager exercises it** (`""` ⇒ `undefined` on get); full normalization (scrub, belt-and-braces, grandfathering) is pinned at the real store in `session-store.test.ts`.
7. **Task 1 Option B (CLI-bundle scripted resume) is an acceptable substitute** for the dev-instance repro per the ticket's delivery framing ("or CLI-bundle re-verification at the then-installed SDK version"); the post-fix live confirmation then falls to the unit surface, noted in the evidence.
8. **`npm run check` needs the three Slack env stubs** in a fresh worktree — environment quirk, not a product change.
9. **No hive.yaml/config compat work exists for this ticket** — the spec introduces no config keys; the store schema change is additive with lazy legacy handling (no migration).
