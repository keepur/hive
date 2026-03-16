---
name: quality-gate
description: Pre-submit quality gate — runs all checks and build verification before a branch can be submitted
agents:
  - vp-engineering
---

# Quality Gate

Run before submitting a branch. Fails fast on first error.

## Steps

1. Run `npm run test` — tests must pass before anything else
2. Run `npm run check` (typecheck + lint + format + test)
3. Run `npm run build` (compile core + plugins)

All steps must pass. Fail fast on first error — report and stop.
