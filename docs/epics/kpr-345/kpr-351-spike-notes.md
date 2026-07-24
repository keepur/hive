# KPR-351 spike notes — production validation on keepur (Luna, codex surface, epic build)

Evidence contract: spec §D6. Per leg: intent → action → observed → verdict GREEN/AMBER/RED → deltas (tagged with the spec section they refine).

## Global
- Pinned SHA + `check:bundle` gate output: **PINNED_SHA `e16bc2a794d5216d66a52d1ebccae396b748e1b6`** (2026-07-23); `npm run check:bundle` exit 0 — bundle + all four gates green (strings, pack, runtime "server.min.js loaded / exited on missing config — expected", qdrant-stub present in 2 bundles).
- Rebase-onto-main taken? (spec ⚠, driver's call): **NO** — 3-commit delta (#324, v0.10.1 bump, #325) accepted for the window per spec Key Points; avoids re-review churn mid-lane.
- P0 state snapshot (paths + timestamps): `~/kpr351-evidence/p0/` 2026-07-23T13:34-0700 — full `mongodump` (hive_keepur, incl. memory_versions 68,293 docs); `luna-def.json` (R4 restore reference — confirms `model: codex/gpt-5.5:medium`, `delegateServers: []`, `maxConcurrent: 3`, no `spawnBudget`, no `archetype`); `sessions-all.json` (4 rows, 1 luna row; field names: `_id, agentId, cacheCreationTokens, cacheReadTokens, compactions, contextWindow, createdAt, inputTokens, outputTokens, provider, sessionId, threadId, updatedAt`); `provider_turn_history` **0 rows** (expected — 0.10.1 predates KPR-353).
- Pre-flight (Task 6 Step 4): codex OAuth `~/.codex/auth.json` present; no deploy automation targeting keepur (crontab hive entries are dodi-side embed/index jobs; LaunchAgents = keepur.agent + rotate-logs only); service running pid 76679; engine 0.10.1 confirmed. M1 token seeded (Keychain only, inverse in ledger).
- G0 sign-off (May, window): **GO — 2026-07-23 ~13:45 PT, interactively in the driver session** · G1: **PASS 2026-07-23 ~22:01 PT** (deploy healthy + rollback verified + C0 GREEN) · G2a: **PASS ~22:27 PT** · G2b/c: TBD · G3 (May, decided at G0): **pre-ruled**, see R4 line
- R4 decision record (May, pre-ruled at G0 2026-07-23): **(1) keep the epic build — no engine rollback (M8 SKIPPED)**; (2) "that's fine" on the Luna end-state question — driver interpretation recorded: with the build staying, the park-on-sonnet premise (tool-free codex) is void, so **M9 default holds: Luna restored to her P0 def (`codex/gpt-5.5:medium`), now tool-capable on the epic build**. May can flip to sonnet with one line.

## Plan-time facts (2026-07-23, read-only)
- ADMIN_API_TOKEN absent on keepur → P0 seeds a throwaway token into Keychain `hive/keepur/ADMIN_API_TOKEN` (removed at P5; admin API down again = status quo ante). Fallback if admin API misbehaves: direct Mongo update + SIGUSR1 (node one-liner — no mongosh on this Mac).
- BRAVE_API_KEY absent → brave-search inert on keepur; C6 delegate = `google` (Hermi-proven on this instance); fallback `conversation-search` (also a Luna coreServer — record any name-collision behavior).
- OPENAI_API_KEY absent → L0–L3 expected skipped; R5/T4 no-op unless May supplies a key in-window.
- GEMINI_API_KEY present (KPR-352 dev key) → N1/N2 key-satisfied, still optional.
- C4 projection check: legacy skill already projected flat (`.skill-projections/memory-hygiene-review-*/skills/memory-hygiene-review` symlink) — Lane B index expected to see it by construction.

## Mutation ledger (every def/config mutation, inverse recorded BEFORE applying)
| # | When | Mutation | Inverse | Applied | Reverted |
|---|---|---|---|---|---|
| M1 | P0 | Keychain add hive/keepur/ADMIN_API_TOKEN | security delete-generic-password -s hive/keepur/ADMIN_API_TOKEN + kickstart | 2026-07-23 | TBD |
| M2 | P1 | engine .hive → epic build (deploy.sh) | `hive rollback` (.hive.prev = 0.10.1) | 2026-07-23 | SKIPPED per May G3 ruling (keep build) |
| M3 | P2 | Luna model → claude-sonnet-4-6 | PATCH model codex/gpt-5.5:medium | 2026-07-23 | 2026-07-23 (M4) |
| M4 | P2 | Luna model → codex/gpt-5.5:medium | (flagship state — reverted by M8/M9 chain) | 2026-07-23 | — |
| M5 | C6 | Luna delegateServers → ["google"] | PATCH delegateServers [] | TBD | TBD |
| M6 | C7 | Luna model → codex/gpt-5.4-mini:medium | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M7 | P4 | Luna model → claude-sonnet-4-6 | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M8 | P5 | engine rollback → 0.10.1 | (May G3 call could skip) | TBD | — |
| M9 | P5 | Luna → observed P0 def (model + delegateServers, field-scoped) | — (this IS the restore) | TBD | — |

## Legs
### C0 — Hermi Claude-lane smoke (G1 gate) — **GREEN**
- Intent: prove the Claude lane healthy on the epic build before touching Luna. Action: May posted in #agent-hermi: "Hermi, quick smoke test: look up Alexandria in contacts and tell me her role."
- Observed: slack-gateway received (channel agent-hermi, 2026-07-24T05:00:10Z); `mcp__contacts__contacts_search` tool call (1x/3.3s); response complete `hasError:false`, durationMs 11743, llmMs 8481, toolMs 3262, cost $0.354; dispatcher dispatched; telemetry row createdAt 05:00:26.863Z matches. Reply correct and *better than the prompt deserved*: no contact record → correctly identified Alexandria as an agent via team roster, offered team_lookup_agent.
- hive.err: only chronic socket-mode pong warnings (pre-existing under 0.10.1, ambient). One pre-existing warn: per-turn effort hints disabled for hermi (`model: "opus"` alias is off-catalog — predates the epic build; not a regression; candidate hygiene note).
- Deploy record (M2 applied 2026-07-23 ~14:19 PT): fetch fell back to rsync from the worktree as designed; health check PASS; BUILD_INFO stamped `kpr-345 epic 7ec2d9f... 2026-07-23`; .hive.prev=0.10.1 verified; doctor Datastore identity all ✓.
### P2 — staged claude baseline + claude→codex handoff (G2a) — **GREEN**
- M3 applied (PATCH → claude-sonnet-4-6, admin API confirmed, SIGUSR1). Baseline thread `slack:C0AUSTRKH16:1784870604.744329`.
- **Unplanned guardrail bonus:** the original plant used "passphrase" wording — Luna REFUSED per constitution §1.4/§1.8 (won't store/echo secrets, passphrases confer no authority), asked for context. Constitution steering live behavior on the claude lane, unprompted. Re-planted as a plain fact (mascot: cobalt heron, badge 42) with honest context — confirmed, with her own boundary restated ("logs as factual detail only, no authorization attaches"). Recorded as C5-adjacent evidence.
- Before-state: sessions row `provider: "claude"`, sessionId `f2d954f5-f656-437e-8141-c8ab27ef5aad` (real); claude turns clean (0.07/0.05 USD, hasError:false).
- M4 applied (PATCH → codex/gpt-5.5:medium, SIGUSR1). Handoff turn ("what's the mascot?"):
  - (a) guard warn exact: `Session provider mismatch — fresh session with memory handoff (KPR-313)` stored:"claude" turn:"codex" hadSessionId:true (05:27:10Z) ✓
  - (b) coherent codex reply — and she **recalled the mascot via an unprompted `mcp__conversation-search__conversation_search` tool call** (toolCalls:1, toolMs:170) — memory/search bridge as the carrier, exactly the designed shape ✓ (bonus: recall achieved, not just coherence)
  - (c) sessions row → `provider: "codex", sessionId: ""` (05:27:23Z) ✓
  - (d) history: clear was a no-op (no prior codex history); the turn then CREATED the `provider_turn_history` doc — 1 turn, items = reasoning(1, **with encrypted_content** — effort-gated replay live), function_call, function_call_output, message ✓
  - Bonuses: Lane B inventory partition logged (bridgeable:19; omitted WebFetch/WebSearch/NotebookEdit/Task/TodoWrite claude-only); post-quiescence **reflection completed on codex** with `memory_save×1`; costUsd 0 (nominal) with honest llmMs/toolMs split.
- **G2a: PASS** (2026-07-23 ~22:27 PT).
### C1 — tool turn … ### C2 — stateless-replay continuity … ### C3 — memory …
### C4 — skills + legacy layout … ### C5 — guardrail posture (structural) …
### C6 — delegate Task turn (KPR-354 enum confirmation) … ### C7 — poisoned-replay (deliberate) …
### C8 — telemetry honesty … ### P4 — inverse transition (KPR-313 proof, G2c) …
### P5 — restore + diff-empty gate (G3) …
### L0–L3 (key-conditioned) — NOT RUN unless OPENAI_API_KEY appears: …
### N1–N2 (optional gemini) …

## KPR-355 row-fact deltas
- codex rows → live-validated (cite leg evidence): TBD
- openai rows: unchanged unless P6 ran: TBD
- Lane A (kimi/deepseek): explicitly restated live-unvalidated (KPR-346 canon).
