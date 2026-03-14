---
name: quality-gate
description: Pre-submit quality gate — runs all checks and build verification before a branch can be submitted
---

# Quality Gate

Run before submitting a branch. Fails fast on first error.

## Steps

1. Run `npm run check` (typecheck + lint + format + test)
2. Run `npm run build` (compile core + plugins)

Both must pass. If either fails, report the error and stop.
