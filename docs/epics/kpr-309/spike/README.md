# KPR-310 throwaway spike harness — not production code, do not import.

Empirical matrix for per-turn model switching on non-streaming `query({ resume, model })`.
Protocol: `../kpr-310-spec.md`. Output verdict: `../kpr-310-verdict.md`.

## Run (from the worktree root, after `npm install`)

    npx tsx docs/epics/kpr-309/spike/run-matrix.ts

Flags:
- `--plan`                 print the matrix (cells, turns, models, prompts) — no API calls
- `--cell M2 [--run <id>]` run one cell only (writes its `.jsonl`; NEVER writes summary.json).
                           With `--run`, append under an EXISTING run id — the post-abort
                           recovery path (seed is adopted from that run for nonce comparability)
- `--seed 310`             nonce seed (default 310; fixed prompts + seeded nonces keep runs comparable)
- `--with-m9`              include optional informative cell M9 (adaptive-thinking interaction)
- `--summarize [--run <id>]` regenerate `evidence/summary.json` wholesale from existing `.jsonl`
                           files (default: latest COMPLETE run). Refuses incomplete runs.

## Evidence discipline (spec-pinned)
- Raw per-turn JSONL: `evidence/<cell>.jsonl` — gitignored, stays local. Both retry attempts recorded.
- `evidence/summary.json` — the ONLY committed artifact. Written at full-matrix completion or by
  `--summarize`; partial `--cell` runs never touch it; the builder refuses runs missing any
  required cell (vacuous-ruling hazard).
- Cache-validity gate: M1 runs first; its T2 must show nonzero per-model `cacheReadInputTokens`
  or the run aborts nonzero (enlarge `prefix.ts`, restart the full matrix).

## Post-abort recovery
1. Note the aborted run's id (printed at start, embedded in every .jsonl line).
2. Rerun each missing/failed cell: `npx tsx docs/epics/kpr-309/spike/run-matrix.ts --cell M4 --run <runId>`
3. Regenerate: `npx tsx docs/epics/kpr-309/spike/run-matrix.ts --summarize --run <runId>`

## Auth & isolation
- Subscription auth via the logged-in `claude` CLI. No `ANTHROPIC_API_KEY` is set by the harness.
  Do NOT set `CLAUDE_CONFIG_DIR` (breaks auth + sessions — KPR-201).
- Every `query()` runs with `cwd` = an isolated scratch dir under the OS tmpdir, so SDK session
  files land in a dedicated `~/.claude/projects/` slot. The harness never touches hive code or
  hive's Mongo `agent_sessions` store.

## Selftest (offline, no API)

    npx tsx docs/epics/kpr-309/spike/selftest.ts
