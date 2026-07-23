# KPR-351 spike notes — production validation on keepur (Luna, codex surface, epic build)

Evidence contract: spec §D6. Per leg: intent → action → observed → verdict GREEN/AMBER/RED → deltas (tagged with the spec section they refine).

## Global
- Pinned SHA + `check:bundle` gate output: TBD (Task 6)
- Rebase-onto-main taken? (spec ⚠, driver's call): TBD
- P0 state snapshot (paths + timestamps): TBD
- G0 sign-off (May, window): TBD · G1: TBD · G2a/b/c: TBD · G3 (May, two decision points): TBD
- R4 decision record — keep-epic-build? park-Luna-on-sonnet?: TBD (explicit May calls, defaults are rollback + restore)

## Plan-time facts (2026-07-23, read-only)
- ADMIN_API_TOKEN absent on keepur → P0 seeds a throwaway token into Keychain `hive/keepur/ADMIN_API_TOKEN` (removed at P5; admin API down again = status quo ante). Fallback if admin API misbehaves: direct Mongo update + SIGUSR1 (node one-liner — no mongosh on this Mac).
- BRAVE_API_KEY absent → brave-search inert on keepur; C6 delegate = `google` (Hermi-proven on this instance); fallback `conversation-search` (also a Luna coreServer — record any name-collision behavior).
- OPENAI_API_KEY absent → L0–L3 expected skipped; R5/T4 no-op unless May supplies a key in-window.
- GEMINI_API_KEY present (KPR-352 dev key) → N1/N2 key-satisfied, still optional.
- C4 projection check: legacy skill already projected flat (`.skill-projections/memory-hygiene-review-*/skills/memory-hygiene-review` symlink) — Lane B index expected to see it by construction.

## Mutation ledger (every def/config mutation, inverse recorded BEFORE applying)
| # | When | Mutation | Inverse | Applied | Reverted |
|---|---|---|---|---|---|
| M1 | P0 | Keychain add hive/keepur/ADMIN_API_TOKEN | security delete-generic-password -s hive/keepur/ADMIN_API_TOKEN + kickstart | TBD | TBD |
| M2 | P1 | engine .hive → epic build (deploy.sh) | `hive rollback` (.hive.prev = 0.10.1) | TBD | TBD |
| M3 | P2 | Luna model → claude-sonnet-4-6 | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M4 | P2 | Luna model → codex/gpt-5.5:medium | (flagship state — reverted by M8/M9 chain) | TBD | TBD |
| M5 | C6 | Luna delegateServers → ["google"] | PATCH delegateServers [] | TBD | TBD |
| M6 | C7 | Luna model → codex/gpt-5.4-mini:medium | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M7 | P4 | Luna model → claude-sonnet-4-6 | PATCH model codex/gpt-5.5:medium | TBD | TBD |
| M8 | P5 | engine rollback → 0.10.1 | (May G3 call could skip) | TBD | — |
| M9 | P5 | Luna → observed P0 def (model + delegateServers, field-scoped) | — (this IS the restore) | TBD | — |

## Legs
### C0 — Hermi Claude-lane smoke (G1 gate) …
### P2 — staged claude baseline + claude→codex handoff (G2a) …
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
