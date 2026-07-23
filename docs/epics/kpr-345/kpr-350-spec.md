# KPR-350 — OpenAI durable resume: `previous_response_id` chaining ruled, hardened, and pinned

**Child 5 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D6 (this child's charter). **Shape:** decision + hardening — the resume *mechanism* already runs; this child rules the durable-layer question the epic left open, closes the one unbounded failure mode (stale-handle churn), and pins the posture in code and tests.
**Depends on:** KPR-347 (merged — descriptor + persistence wiring shipped there). **Informs:** KPR-351 (live validation legs, key-conditioned), KPR-352 (gemini replicates the transition-guard verification shape), KPR-355 (matrix row facts §D7).
**Decision-register canon honored:** `SESSION_SEMANTICS` exhaustive Record with openai = `server-resumable` — **value unchanged by this ruling**; session asymmetry lives in session-semantics, not compatibility; KPR-348 evidence-gap canon (no Responses-capable key in fleet — verification is model-independent + 401-boundary, live legs deferred to KPR-351); breaker canon (no new breaker-visible fault class that isn't a real provider fault); KPR-349 (prompt assembly untouched — confirmed, §Non-goals); KPR-354 (nested delegate turns stay session-less — confirmed, §D5); KPR-353 §R3 comment handback inherited (this child builds nothing codex-shaped).
**Provider-surface evidence (researched 2026-07-23):** Responses API `previous_response_id` and `conversation` are **mutually exclusive per request** (error on both); response objects retain 30 days under `store: true`, then the id 404s; Conversations API items carry **no** 30-day TTL; the installed `@openai/agents` 0.11.4 exposes both `previousResponseId` and `conversationId` as first-class run options, and `ModelSettings` carries `store?: boolean` and `truncation?: 'auto' | 'disabled'` ([conversation state](https://developers.openai.com/api/docs/guides/conversation-state), SDK types verified in `node_modules/@openai/agents-core/dist/run.d.ts:159-160`, `model.d.ts:212,221`).

## TL;DR

**Ruling: `previous_response_id` chaining is the durable resume layer for `openai/…`; the Conversations API is ruled out for this epic.** The deciding arithmetic: hive's continuity horizon is the `sessions` 7-day idle TTL, and a chained handle is rewritten every turn — so a resumed handle is never older than 7 days, comfortably inside the 30-day server retention; Conversations' indefinite retention buys nothing hive can reach while adding a create-call lifecycle, a cross-auth-attempt org-affinity hazard, and an indefinite vendor-side data-residue liability. The mechanism (adapter chaining + KPR-347 persistence + KPR-313 guard) already works end-to-end on this baseline; the net-new work is small and surgical: a stale-handle self-heal (retry once without resume when the server reports the previous response gone — the KPR-353 §D7 philosophy applied to the server-resumable surface), an explicit `store: true` + `truncation: "auto"` posture pin on the adapter, and test pins for every inherited invariant.

## Key Points

- **The headline decision (epic §D6's open question): chaining wins, Conversations is ruled out.** Four grounds (§D1): (1) durability beyond 7 days is unreachable — hive forgets the ref first; (2) zero new lifecycle vs. a first-turn create round-trip whose conversation object is org-bound across `runWithAuthFallback`'s two credential attempts; (3) privacy posture — orphaned Conversations persist vendor-side indefinitely with no hive delete hook, worse than 30-day self-expiry; (4) evidence honesty — chaining is the already-shipped, smallest live-verifiable surface for KPR-351, a mechanism swap would ship net-new unverified machinery under the no-key gap.
- **`SESSION_SEMANTICS.openai` stays `server-resumable` — no descriptor value change, no union change, no session-store change.** The `conversation-store` category remains unoccupied; its doc comment gets the ruling recorded (one line). KPR-347's projection ("openai → conversation-store if Conversations wins") resolves to the other branch.
- **Most of the ticket's filed scope shipped in KPR-347 and is verified here, not rebuilt:** descriptor wiring into `AgentManager` persistence (`finalizeSpawnResult` → `persistsResumableHandle`, `agent-manager.ts:1721`), read-side normalization (`session-store.ts:107-123`), and the provider-generic KPR-313 transition guard (`agent-manager.ts:888-923`) all already cover openai. This child's guard extension is **test-pinning the openai transitions**, not new guard code.
- **The one real gap is the stale-handle churn loop (§D3):** a dead `resp_` handle (30-day expiry on a >23-day-dormant-but-alive edge, server-side deletion, org change) makes every subsequent turn error until the row TTLs out — up to 7 days of a broken thread. Fix: a second matcher beside `isAuthRebuildResumeError` in the existing retry-without-resume block (`agent-manager.ts:949-961`), gated on `sessionSemanticsFor(route.provider) === "server-resumable"`; retry once fresh; success overwrites the stale handle naturally.
- **Posture pin (§D2):** the adapter's `Agent` construction gains `modelSettings: { store: true, truncation: "auto" }` — `store: true` is the chaining prerequisite currently riding an implicit API default (code-enforce canon: pin it), `truncation: "auto"` is the Lane B analog of Claude-lane compaction (server-reconstructed context on a long thread must degrade by truncation, not 400).
- **Breaker safety:** the stale-resume error classifies `non-provider` today (no `FAULT_PATTERNS` row matches "not found") and must stay that way — contract-pinned; the self-heal's first attempt never reaches the breaker (record-once already guarantees only the finalized attempt is recorded).
- **KPR-354 nested delegate turns stay session-less by construction** — nested `runTurn` receives no `sessionId`, nested result ids are discarded (`agent-manager.ts:669-671`); confirmed, pinned, unchanged.
- ⚠ Delegated assumptions (§Open assumptions — all non-blocking): the exact stale-handle error string is docs/community-sourced ("previous response … not found", 404-shaped) pending KPR-351 live capture; chain-root expiry behavior on >30-day continuously-active threads is undocumented (self-heal is the containment either way); ZDR orgs (store forced off) are a documented matrix caveat, not fleet-relevant.
- **Out of scope:** Conversations API anything; the openai adapter's doomed codex-oauth attempt (KPR-351's live-validation call); gemini/codex; SDK `Session` objects; prompt assembly; session-store code.

## Problem

The epic left §D6's OpenAI branch explicitly undecided: "Conversations API as the durable layer (or `previous_response_id` chaining if the Conversations × Agents-SDK interplay disqualifies it) — decided in the child spec; the two mechanisms are mutually exclusive per run." Meanwhile the baseline quietly converged on chaining-by-default: the adapter passes `previousResponseId: request.sessionId` and returns `lastResponseId` (`openai-agents-adapter.ts:81,230-232`), KPR-347 tagged openai `server-resumable` and wired persistence on both sides, and KPR-313's guard covers openai transitions generically. What's missing is (a) the ruling itself, made with current provider-surface facts, (b) the stale-handle failure mode nobody owns — a dead handle churns the thread for up to 7 days, the exact unbounded-failure shape KPR-313 exists to kill, and (c) explicit code posture for the chaining prerequisites (`store`) and long-thread viability (`truncation`), both currently riding implicit defaults.

## Goals

- G1: Rule Conversations vs `previous_response_id` with recorded rationale; encode the ruling in the `types.ts` descriptor comments (values untouched).
- G2: Stale-handle self-heal: one fresh retry when a resume attempt fails with the previous-response-gone error, on server-resumable routes only; bounded, breaker-invisible.
- G3: Explicit adapter posture: `store: true`, `truncation: "auto"` pinned in `Agent` construction.
- G4: Verified (not rebuilt) inheritance: descriptor persistence, read-side normalization, KPR-313 openai transitions, KPR-354 nested session-lessness — each test-pinned where a pin doesn't already exist.
- G5: Honest verification under the KPR-348 evidence gap: model-independent unit legs here; live durable-resume legs specified for KPR-351, key-conditioned.
- G6: Matrix row facts recorded for KPR-355 (§D7).

## Non-goals

- **Conversations API integration in any form** — no create/delete lifecycle, no `conversationId` run option, no `conversation-store` occupancy. Revisit only if a future child needs >7-day continuity (which would be a `sessions` TTL change first, a mechanism change second).
- SDK `Session` / `OpenAIConversationsSession` objects (epic ⚠: not combinable with `previousResponseId` in one run; hive's session store is the system of record).
- The openai adapter's codex-oauth auth attempt (`openai-agents-adapter.ts:191-216`) — spike-proven to 401 (KPR-348), flagged by KPR-353 §D5 to "KPR-350/351". **Disposition: KPR-351.** Removing or keeping it is a live-validation call, not a persistence concern; this child's only interest is the org-affinity note in §Edge cases.
- `SESSION_SEMANTICS` values, `AgentProviderId`, `LaneBProviderId`, `persistsResumableHandle`, session-store normalization/scrub code — all untouched (comments excepted).
- Gemini (KPR-352 — Interactions API is its own exit from `stateless-replay`), codex (KPR-353 shipped; nothing codex-shaped here per §R3 handback — confirmed inherited: `types.ts:41-47` already credits replay to KPR-353).
- Prompt assembly, tool bridge, guardrail gate, builtin executor (KPR-348/349 surface; resume has no prompt implications — confirmed: continuity is server-side state, no instruction text changes).
- Cross-provider history migration (epic ruling stands: fresh session + KPR-313 §3.4 annotation).
- Encrypted-reasoning includes on the openai lane (`store: true` server state carries reasoning; `include: ["reasoning.encrypted_content"]` is the store-false/ZDR pattern — codex's, not this lane's).

## Design

### D1 — The ruling: `previous_response_id` chaining over Conversations API

Both mechanisms are individually viable on the installed SDK (0.11.4 exposes both run options; they are mutually exclusive per request — pick one, which the epic already required). Decided on four grounds:

1. **The durability delta is unreachable.** Hive's continuity horizon is the `sessions` 7-day idle TTL (`session-store.ts:56`); after that the row — and any conversation ref in it — is gone regardless of vendor-side retention. Under chaining, the persisted handle is rewritten to the newest `lastResponseId` every successful turn, so a resumed handle's age is bounded by thread idle time ≤ 7d < 30d server retention: **a handle read from a live row is never expired, by arithmetic.** Conversations' no-TTL storage only pays off past day 7, where hive has already forgotten the ref.
2. **Zero new lifecycle vs. real new lifecycle.** Chaining needs no extra API call and no object management. Conversations needs a first-turn `conversations.create` round-trip per thread — and that call must run under the same credential/org as every later turn: `runWithAuthFallback` (`openai-agents-adapter.ts:153-189`) tries two credential attempts, so a conversation created under attempt 1 is invalid if a later turn lands on attempt 2. Solvable, but it's a whole class of state-affinity bugs chaining structurally lacks. (Chaining has a milder form of the same hazard — a `resp_` handle is org-bound too — but its blast radius is one self-healed turn (§D3), not a poisoned thread object.)
3. **Privacy/data-residue posture.** Hive rows TTL out with no vendor-side delete hook in either design. Under chaining the vendor-side residue self-expires in 30 days; under Conversations, orphaned conversation objects holding business content persist **indefinitely**. Under the fleet's security posture (agents-as-employees, minimal standing residue), self-expiry wins.
4. **Evidence honesty (KPR-348 canon).** No Responses-capable key exists in the fleet; every openai-lane mechanism is verified to the 401 boundary until KPR-351. Chaining is already the shipped, smallest surface — blessing it keeps KPR-351's live burden to "verify what runs." A Conversations swap would ship a strictly larger unverified mechanism into the same gap.

**Encoding:** `SESSION_SEMANTICS.openai` stays `"server-resumable"`. The `"conversation-store"` doc comment (`types.ts:28-30`) is updated from "KPR-350's OpenAI Conversations candidate; unoccupied today" to record the ruling: *unoccupied by ruling (KPR-350 §D1) — chaining chosen; category retained for a hypothetical future provider whose only durable layer is a conversation object.* The category itself is kept: it costs nothing (exhaustive Record, no occupant required) and deleting a union member is churn with no payoff.

### D2 — Adapter posture pin: `store` + `truncation`

`Agent` construction (`openai-agents-adapter.ts:71-76`) gains:

```ts
modelSettings: { store: true, truncation: "auto" },
```

- `store: true` — the chaining prerequisite. Today it rides the Responses API default; an SDK or API default flip (the codex surface *hard-enforces* the opposite on its endpoint — the precedent is live) would silently kill resume with no test failing. Code-enforce canon: pin it. (`ModelSettings.store`, `model.d.ts:221`.)
- `truncation: "auto"` — long-thread viability. Chaining reconstructs the full accumulated context server-side each turn; a months-active thread eventually exceeds the model window, and the default (`disabled`) 400s the turn. Claude lane degrades by compaction; `truncation: "auto"` is the Lane B analog (drop oldest context, keep serving). Without resume this was unreachable; with resume it's this child's to own.

Both apply to the parent-adapter construction path. The nested KPR-354 delegate constructor shares the adapter class, so nested agents inherit the same settings — harmless (`store: true` on a chain nobody ever references; 30-day self-expiry) and simpler than plumbing a variant. No other adapter option changes.

### D3 — Stale-handle self-heal (the net-new mechanism)

**Failure mode:** the store holds a `resp_` handle the server no longer honors — 30-day expiry (reachable despite §D1's arithmetic only via the edge in §Edge cases, but reachable), dashboard deletion, org/key rotation. The resume attempt fails with a 404-shaped "previous response not found" error; today that lands in `RunResult.error`, classifies `non-provider` (correct — it's hive-side stale state, not provider unhealth), the churn-mint rider blocks the errored turn's fresh id from overwriting the row (`agent-manager.ts:1730` — correct in isolation), and **the thread errors identically every turn until the row TTLs out.** Up to 7 days of broken thread; the exact "unbounded failure mode" shape KPR-313's scrub philosophy and KPR-353's §D7 self-heal exist to kill.

**Fix — extend the existing manager-level retry, don't build an adapter loop:** `spawnTurn` already owns a retry-without-resume block for Claude auth-rebuild errors (`agent-manager.ts:949-961`): on a matching error with a `sessionId` present, re-run the attempt with `sessionId: undefined`; record-once means only the finalized attempt reaches the breaker. Add a second arm:

```ts
const staleResume =
  finalResult.error &&
  isStaleServerHandleError(finalResult.error) &&
  effectiveCtx.sessionId &&
  sessionSemanticsFor(shaping.route.provider) === "server-resumable";
```

- `isStaleServerHandleError` (new, beside `isAuthRebuildResumeError`, `agent-manager.ts:276`): matches the Responses previous-response-gone surface — `/previous response.*(not found|expired)/i` plus the SDK's 404-on-response-retrieval shape. Kept deliberately narrow: a false positive silently drops one turn's context (retry runs fresh), so the matcher must not over-match generic 404s. ⚠ The exact production string is captured live in KPR-351; the matcher ships docs-sourced and is refined there if needed.
- **Semantics gate, not provider gate:** `server-resumable` (via `sessionSemanticsFor`) rather than `=== "openai"` — this is the "consumes sessionSemanticsFor in persistence logic" seam KPR-347's downstream table projected, and it keeps the arm dead for claude/kimi/deepseek (`client-transcript` — their resume errors mean different things) and codex/gemini (`stateless-replay` — no handle exists to be stale).
- **One retry, then surface.** If the fresh retry also errors, the turn result stands as-is (classified normally; churn-mint keeps the row untouched). The stale handle then persists to the next turn — which re-trips the arm, bounding waste to one extra attempt per turn rather than a dead thread. First successful turn overwrites the row with its fresh `lastResponseId` via the normal `finalizeSpawnResult` path — **no explicit scrub call needed**; the write path self-corrects (deliberate contrast with KPR-353's `clear()`, whose store has no equivalent overwrite-on-success).
- Log at warn with agentId/threadId + reason (no handle value — log-redaction posture).

**Breaker interplay (canon-pinned):** the stale-resume error string must classify `non-provider` — it matches no `FAULT_PATTERNS` row today (no 404 row exists; verified against `error-classification.ts:71-95`) and a test pins that it never gains breaker weight. The first (stale) attempt never reaches the breaker: existing record-once structure, unchanged.

### D4 — Inherited surfaces: verify, don't rebuild

Confirmed working on this baseline, each gaining a pin only where none exists:

- **Write side:** `finalizeSpawnResult` persists `lastResponseId` for openai routes (`persistsResumableHandle("server-resumable") === true`, `agent-manager.ts:1721,1739`); churn-mint rider blocks errored-turn mints. Existing KPR-313/347 tests cover; add one openai-tagged happy-path pin if absent.
- **Read side:** tagged openai rows normalize to a real handle (`session-store.ts:109-123`); untagged legacy `resp_` rows scrub (`:42` — provenance rule, untouched).
- **KPR-313 guard:** provider-generic over the union; openai→claude and claude→openai transitions handoff with the §3.4 annotation; the guard's `turnHistoryStore.clear` (`agent-manager.ts:918-920`) is a codex-history concern that is a provider-agnostic no-op for openai threads (no doc exists) — nothing to add. Pin the two openai transition directions at manager level (the KPR-352 replication child inherits this test shape).
- **Reflection turns:** post-lock session re-resolve (`agent-manager.ts:860-868`) is provider-blind; carries the openai handle correctly. No change.

### D5 — KPR-354 nested-turn interplay: session-less, confirmed

Nested delegate turns must never write or consume durable resume state (canon). Confirmed by construction on this baseline: the delegate runner calls `nested.runTurn({ prompt, workItemContext, resourceLimits })` — **no `sessionId`** — so `runOptions.previousResponseId` is `undefined` on every nested run; the nested result's `sessionId` is explicitly discarded and `sessionStore` untouched (`agent-manager.ts:647-671`, G4 comment). §D2's `modelSettings` inheritance creates unreferenced 30-day-self-expiring server residue only. One pin: a nested openai delegate turn issues its run with `previousResponseId: undefined` and triggers no session persist (extends the KPR-354 G4 test group if not already covered).

### D6 — Verification posture under the evidence gap (KPR-348 canon)

No Responses-capable OpenAI key exists in the fleet; the openai adapter is 401-boundary-verified. Honest split:

- **Here (model-independent):** everything in §Testing — mocked SDK/run, mocked store; zero live calls.
- **KPR-351 (key-conditioned live legs, specified now, executed there):** (L1) two real turns on one thread, turn 2 resumes turn 1's handle, context recall asserted; (L2) fabricated/expired `resp_` handle → capture the exact error payload, confirm the §D3 matcher hits (refine in place if not), confirm one fresh retry and thread recovery; (L3) confirm `store: true` + `truncation: "auto"` are accepted and the response id chain advances across a tool-loop turn. The openai flagship live turn remains non-gating per the HUMAN_DIRECTIVE (no key purchase now).

### D7 — Matrix row facts (KPR-355)

openai resume = **`server-resumable`**: `previous_response_id` chaining, handle persisted in `sessions` (7d idle TTL) and rewritten each turn; server retention 30d under pinned `store: true`; long threads degrade via `truncation: "auto"` (no compaction analog); stale handles self-heal (one fresh retry, one exchange of context lost); **caveats:** requires a non-ZDR org (ZDR forces storage off — chaining unavailable; the ZDR pattern is codex-style encrypted-reasoning replay, not built for this lane), chain input tokens re-billed each turn server-side (offset by prompt caching), Conversations API deliberately unused (KPR-350 §D1 ruling), continuity horizon 7 days (hive TTL, not vendor).

## Integration points

| Seam | This ticket | Must NOT touch |
|---|---|---|
| `openai-agents-adapter.ts` | `modelSettings: { store: true, truncation: "auto" }` in `Agent` construction (:71-76) (§D2) | `previousResponseId` wiring (:81), `extractSessionId` (:230), auth attempts (:153-216 — KPR-351's), bridge/loop, abort |
| `agent-manager.ts` | `isStaleServerHandleError` beside `:276`; second retry arm in the `:949-961` block, semantics-gated (§D3) | KPR-313 guard logic/ordering (R7 window), `finalizeSpawnResult` rules incl. churn-mint, breaker acquire/record, `resolveProviderModel`, delegate runner |
| `types.ts` | doc comments only: `conversation-store` ruling note (:28-30) (§D1) | `SESSION_SEMANTICS` values, unions, `persistsResumableHandle` |
| `error-classification.ts` | **no code** — test pin only (stale-resume string stays `non-provider`) (§D3) | `FAULT_PATTERNS` (no 404 row may be added) |
| `session-store.ts`, `turn-history-store.ts`, `turn-assembly.ts`, `tool-bridge.ts`, `codex-subscription-adapter.ts`, `gemini-adk-adapter.ts` | none | everything |
| CLAUDE.md | provider-adapters paragraph: one clause noting openai durable resume = chaining + self-heal (ruling recorded) | — |

## Edge cases

- **Handoff to openai (claude→openai):** guard trips, fresh session + §3.4 annotation, first turn persists the first `lastResponseId`. Pinned (§D4).
- **Handoff from openai (openai→claude):** guard trips, annotation fires, openai server chain simply ages out at 30d — no clear call exists or is needed. Pinned.
- **Adopt branch** (queued predecessor already switched): inherits predecessor's fresh handle; no annotation; existing behavior.
- **Mid-outage (KPR-307):** breaker-open turns fast-fail pre-adapter and queue; replay re-resolves the session pre-lock — handle age still bounded by row TTL. Stale-resume errors themselves classify `non-provider` and never open the circuit, so a fleet of stale handles cannot masquerade as an outage.
- **TTL/retention mismatch:** hive 7d idle < vendor 30d ⇒ live-row handles never expired by age (§D1.1). Residual reachable case: engine down/agent stopped >23d with Mongo alive (row `updatedAt` frozen, TTL reaper needs the row idle 7d — a 25-day outage leaves a 25-day-old handle in a soon-to-die row) → first turn back self-heals (§D3). ⚠ Chain-root expiry on a >30-day *continuously active* thread is vendor-undocumented (does the newest response embed full context, or is the chain walked?) — if it breaks, it surfaces as exactly the §D3 error and self-heals with one context reset; flagged for KPR-351 observation, not designed around.
- **Abort mid-turn:** `!result.aborted` gate blocks persist (`agent-manager.ts:1715`) — the row keeps the pre-abort handle; next turn resumes pre-abort state; server-side orphan responses self-expire. Matches Claude-lane semantics. Existing pin.
- **Errored turn with fresh mint:** churn-mint rider blocks the overwrite (existing, `:1730`); interplay with §D3: the self-heal retry runs with `ctx.sessionId` intact in `effectiveCtx` passed to finalize, so an errored *retry* that minted an id still hits the rider — stale handle preserved for the next turn's re-trip. Deliberate; test-pinned.
- **Nested KPR-354 turns:** no resume in, no persist out (§D5). Pinned.
- **Streamed turns:** `lastResponseId` read post-`completed` — existing path, unchanged.
- **Auth-fallback org affinity:** a handle minted under attempt-1 credentials is unresumable under attempt-2. Today unreachable (the codex-oauth attempt always 401s pre-response — KPR-348 spike), and if it ever became reachable the failure lands in the §D3 self-heal. Noted for KPR-351's auth-attempt disposition; no code here.
- **ZDR org (hypothetical customer):** storage forced off ⇒ every resume 404s ⇒ self-heal fires every turn (thread works, stateless, one wasted attempt per turn). Documented matrix caveat (§D7); not engineered around.

## Testing contract sketch

Vitest beside source; `npm run check` green; negative-verify discipline where a pin inverts current behavior.

- **T1 — posture pin (adapter):** `Agent` constructed with `modelSettings.store === true` and `truncation === "auto"`; `previousResponseId` carries `request.sessionId` verbatim; `conversationId` never present in run options (the §D1 ruling as a pin — negative-verify would catch a future Conversations drive-by).
- **T2 — self-heal (manager):** mocked adapter, first attempt errors with the stale string + `effectiveCtx.sessionId` set → exactly one retry with `sessionId: undefined`; retry success → `sessionStore.set` with the retry's fresh id; retry failure → no persist (churn-mint), error surfaces; breaker `record` called once, with the finalized attempt only.
- **T3 — self-heal gating:** same error string on a `client-transcript` route (claude) and a `stateless-replay` route (codex) → arm dead, no retry; no `sessionId` in ctx → arm dead; non-matching 404 text → arm dead. The existing auth-rebuild arm's tests stay green (matcher independence).
- **T4 — classification pin:** the stale-resume string(s) → `classifyTurnResult` = `non-provider`; regression-guards the "no 404 row" rule in `error-classification.ts`.
- **T5 — KPR-313 openai transitions (manager):** claude→openai and openai→claude both handoff (fresh session, `sessionHandoff` set, annotation prepended); adopt branch adopts; openai rows written `provider: "openai"` with the real handle (existing 347 pins referenced, extended only where missing).
- **T6 — nested session-lessness:** nested openai delegate run issues `previousResponseId: undefined`, discards result id, never touches `sessionStore` (extends KPR-354 G4 group if uncovered).
- **T7 — 401-boundary (existing posture):** unchanged KPR-348-era boundary tests keep passing with the new modelSettings present.
- **Live legs L1–L3:** specified in §D6, executed under KPR-351, key-conditioned — explicitly *not* claimed by this child.

## Open assumptions

**Blocking:** none.

**Non-blocking (⚠ delegated):**
- ⚠ Exact stale-handle error string/status is docs+community-sourced (404, "previous response … not found"); matcher ships narrow and is refined against KPR-351's live capture (L2). Worst case pre-refinement: matcher misses → today's status quo (thread churns to TTL) — no regression, just unfixed until refined.
- ⚠ Chain-root expiry semantics on >30-day continuously-active threads are vendor-undocumented; contained by §D3 either way; observed in KPR-351/production rather than pre-engineered.
- ⚠ `truncation: "auto"` server-side truncation quality (what gets dropped) is vendor-controlled; accepted as the no-compaction-analog tradeoff, matrix-noted.
- ⚠ Nested delegates inheriting `store: true` leaves unreferenced 30-day vendor residue per delegate turn; accepted for simplicity over plumbing a per-construction variant (revisit only if a privacy posture change demands `store: false` + encrypted-reasoning on nested turns).
- ⚠ Ruling reversal trigger, recorded for the register: if hive ever extends `sessions` TTL past 30 days or ships >30-day thread continuity as a product requirement, the §D1 arithmetic inverts and Conversations must be re-evaluated — that is a new ticket against the then-current SDK, not a reopening of this one.
