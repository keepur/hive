# KPR-310 Verdict — per-turn model switching on non-streaming resume

**Ruling: SAFE-WITH-CONSTRAINTS**
**SDK version pinned:** @anthropic-ai/claude-agent-sdk@0.2.104 (package.json range ^0.2.63 — if .2 delivery's lockfile resolves a different minor, re-run the harness: `npx tsx docs/epics/kpr-309/spike/run-matrix.ts`)
**Run environment:** mokiemon.local (Apple Silicon arm64, macOS 26.3.1), run `run-2026-07-10T05-59-45-819Z` (2026-07-10 05:59 UTC), subscription auth via logged-in `claude` CLI (`apiKeySource: "none"` on every turn), harness commit `28376d0`, seed 310, M9 included.

The ruling is copied verbatim from `spike/evidence/summary.json` (`deriveRuling`, mechanical — no deviation, no re-judging). All 10 cells completed on attempt 1 (zero retries, 33 turn attempts, $0.9168 API-equivalent, ~2 min wall-clock). M1's cache-validity gate passed (T2 cacheReadInputTokens=16330).

## Results matrix

| Cell | Chain | Continuity | Session-id behavior | Cache (T2 read/creation vs M1) | Cache (T3 switch-back) | Subtype/errors | Grade |
|------|-------|------------|---------------------|--------------------------------|------------------------|----------------|-------|
| M1 | sonnet→sonnet→sonnet | all nonces recalled | same id all 3 turns (`7611228a`) | 16330 / 0 (baseline) | N/A (no switch) | success ×3 | PASS |
| M2 | sonnet→haiku→sonnet | all nonces recalled | same id all 3 turns | **0 / 27153** (cold haiku) | 16298 read / 140 creation — model A cache retained | success ×3 | DEGRADED |
| M3 | haiku→sonnet→haiku | all nonces recalled | same id all 3 turns | 14907 / 1481 (sonnet cache warm from M1/M2) | 27116 read / 124 creation | success ×3 | PASS |
| M4 | sonnet→opus→sonnet | all nonces recalled | same id all 3 turns | **0 / 23758** (cold opus) | 16296 read / 68 creation | success ×3 | DEGRADED |
| M5 | opus→haiku→opus | all nonces recalled | same id all 3 turns | 25645 / 1506 (haiku cache warm from M2/M3) | 23707 read / 197 creation | success ×3 | PASS |
| M6 (tool) | sonnet→haiku→sonnet | tool word + both nonces recalled across the switch; haiku turn replayed sonnet's `tool_use`/`tool_result` history cleanly | same id all 3 turns | **0 / 27493** (cold haiku w/ tool defs) | 16645 read / 159 creation | success ×3 | DEGRADED |
| M7a (fork) | sonnet ×4 | forked T2 recalls pre-fork nonce; T3a recalls both; T3b (original id) recalls n1, does **not** see post-fork n2 — clean fork isolation | fork minted new id (`86c6f76e`→`5c1983fb`); both branches independently resumable | N/A | N/A | success ×4 | PASS |
| M7b (stale-id) | sonnet ×3 | T3 on T1's "superseded" id recalls n1; **n2 VISIBLE** — the stable id accumulates all turns, so an older persisted id resumes the *latest* state, not a snapshot | same id all 3 turns; "stale id" is not actually stale | N/A | N/A | success ×3 | PASS |
| M8 (fault) | sonnet→bogus→sonnet +probe | fault clean; T3 on original session recalls n1; fresh probe chain clean | id unchanged through the fault | bogus turn: modelUsage empty, cost $0 | N/A | T2: SDK throw (see KPR-312 below); all others success | PASS |
| M9 (informative) | opus+adaptive-thinking→haiku→opus | all nonces recalled | same id all 3 turns | 25645 / 1506 (warm) | 23707 read / 200 creation | success ×3 | PASS (excluded from ruling) |

Key cross-cell observations:

- **Observed-model attribution held in every cell**: `modelUsage` keys matched the requested model on every successful turn. No silent fallback to the CLI default was ever observed (the every-cell PASS-gate).
- **Session id is stable across resumes**: every non-fork resume returned the *same* session id it was given (init `session_id` == `resume` value), across all cells including every model switch. No new-id-per-resume chaining was observed anywhere.
- **The prompt cache is per-model but shared across sessions with a byte-identical prefix**: M3-T2 (sonnet) and M5-T2 (haiku) read warm cache created by *earlier cells'* sessions. The T2 misses in M2/M4/M6 are "first use of that target model with this prefix inside the TTL window," not "every switch."

## Enumerated constraints (binding on KPR-311/312/313)

Constraints array from `summary.json`, verbatim, with the downstream rule each implies:

- **C1.** `M2 T2: prompt-cache miss on switch - cacheRead=0 vs M1 baseline 16330, creation=27153` — Observed: a router downshift to a cache-cold model pays full prefix re-creation (turn cost $0.0343 vs $0.0050 control, ~7×). Rule: KPR-311's router policy must treat the *first* switch to a model (per prefix, per 5-min TTL window) as paying one full cache-creation; downshift-for-cost decisions should compare model-cost saving against this re-creation cost, which repeated switching amortizes (see M3/M5 warm-cache evidence).
- **C2.** `M4 T2: prompt-cache miss on switch - cacheRead=0 vs M1 baseline 16330, creation=23758` — Observed: the same cliff at opus pricing is severe: $0.4464 for the cold opus turn, ~89× the control turn. Rule: upshifts to opus on large-prefix agents are the expensive corner; ceiling-capped agents that oscillate sonnet↔opus per turn pay this only when opus has gone cold (>5 min since last opus turn with that prefix).
- **C3.** `M6 T2: prompt-cache miss on switch - cacheRead=0 vs M1 baseline 16330, creation=27493` — Observed: the presence of MCP tool definitions and `tool_use`/`tool_result` history does not change the cache-miss shape (and tool-state carryover itself is clean). Rule: same as C1; tool-bearing agents get no exemption and no extra penalty beyond the larger prefix.

All three constraints are the same mechanism (per-model prompt cache) at three price points. No continuity, session-id, tool-state, or fault-shape constraint emerged.

## Consumer statements

### KPR-311 (router→adapter seam)

**Explicit answer: yes — the seam can pass the router's per-turn model into the adapter on resume.** `query({ resume: <id>, model: <different model> })` is empirically well-behaved on SDK 0.2.104: continuity intact in all 6 switching cells (including max-distance opus↔haiku and tool-history replay), observed model always matches requested model, session id unchanged. Nothing observed requires moving where the model decision binds: the R7 wrap-point order (breaker `acquire()` → sessionId re-resolve → `prepareSpawn`/router → adapter, exactly one `record()` per spawnTurn on the finalized attempt) is compatible — the model choice can continue to bind inside `prepareSpawn`, after sessionId re-resolve, because the resumed session accepts any model at turn boundary. The one router-policy input is C1–C3: a per-turn model decision is also a per-turn cache decision, and the router is the right place to weigh model-cost saving against prefix re-creation cost (hive prefixes are much larger than this harness's ~7.7k tokens, so the cliff scales up).

### KPR-312 (classifier v2)

One classifier-visible fault mode observed (M8, bogus model `claude-nonexistent-9` on resume). Fault shape, verbatim:

- The SDK `query()` iteration **threw**: `Error: Claude Code returned an error result: There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.`
- The result message that preceded the throw is anomalous: `subtype: "success"` with `is_error: true`, the error text in `result`, `num_turns: 1`, `total_cost_usd: 0`, empty `modelUsage`. A classifier keyed on result subtype alone would mis-read this as success; `is_error` is the discriminating field.

Mapping onto the frozen R3 taxonomy (`kpr-305` @ `af74cf7`, read-only): the error string matches none of the `FAULT_PATTERNS` rows — not connect-fail, not rate-limit, not auth (no `401/403/authentication/unauthorized/...` token; "may not have access" does not match the auth row), not server-error — so both `classifyThrown` and `classifyTurnResult` bucket it **`non-provider`** under the fail-safe default, as the spec predicted. Is that the *right* classification? For the breaker: yes — a misconfigured/rejected model id is a config fault, not provider unhealth, and must not trip the breaker (trip streak protection is exactly what `non-provider` provides). For observability: partially — a *persistent* bad-model condition (e.g. a router emitting a retired model id fleet-wide) would sit invisibly in the `non-provider` bucket forever. KPR-312 should consider a distinguishable `bad-model`/config-fault kind (or at least a named pattern row) so rejected switches are countable without becoming breaker-eligible. Incidental faults: none — no 429s, no 5xx, no timeouts in 33 turn attempts.

### KPR-313 (session-identity guards)

Observed invariants, stated testably:

1. **Same-id resume invariant:** for non-fork resumes, the returned `session_id` equals the `resume` value — every resumed turn, every cell, including across model switches and across the M8 fault. Guard: `init.session_id === resume || forkSession` is assertable.
2. **Fork invariant (M7a):** `forkSession: true` mints a new id; the forked session inherits full pre-fork history (T2 recalled n1); the original id remains independently resumable; post-fork content does not leak into the original branch (T3b did not see n2).
3. **Stale-id resume invariant (M7b):** because ids are stable, an "older persisted id" is the *same* id — resuming it after intervening turns yields the **latest** session state (T3 saw both n1 and the supposedly-newer n2), not a snapshot and not an error. Hive's crash-recovery replay of an older persisted id is therefore safe on this SDK version, with the caveat that it resumes current state (no time-travel semantics).
4. **Last-returned-id discipline validity:** hive's persist-last-returned-id (`sessionStore.set`) is trivially valid — the last returned id is always the id it started with (non-fork). Chain-following capability remains dormant-but-harmless.
5. **Fault non-poisoning (M8):** a rejected-model turn leaves the session resumable at the same id with recall intact, and does not affect unrelated fresh sessions.

## Untested / out of scope

- **thinking-config interaction:** optional M9 **ran** (informative only, excluded from the ruling): opus with `thinking: { type: "adaptive" }` on T1/T3 across a haiku T2 behaved identically to M5 — PASS, no fault, no id or cache difference. Informative evidence only; hive sets no `thinking` config today.
- `fallbackModel` (unused in hive) — untested.
- Alias model names (e.g. `"sonnet"`) — untested; hive always passes full ids from `TIER_MODELS`.
- Non-Claude providers (D3) — out of scope; their adapters are constructor-static.
- Streaming-input `setModel()` path (`sdk.d.ts:1723`) — untested; not needed since the ruling is not UNSAFE.

## Raw evidence

`spike/evidence/summary.json` committed beside the harness (run `run-2026-07-10T05-59-45-819Z`, sdk 0.2.104, seed 310, 33 turn attempts, $0.9168, ruling SAFE-WITH-CONSTRAINTS); full per-turn JSONL transcripts local to the run machine (mokiemon.local) under `docs/epics/kpr-309/spike/evidence/*.jsonl`, gitignored by design. Harness: `docs/epics/kpr-309/spike/` (throwaway, D1 — no `src/**` imports; grading and ruling derivation unit-tested by `spike/selftest.ts`, 13/13).
