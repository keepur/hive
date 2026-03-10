# Code Quality Gates & Test Coverage — User Story

## Problem

Hive has 59 TypeScript files across `src/` and `plugins/`, with zero tests, no linting, no formatting, and no pre-commit hooks. The plugin architecture (DOD-209) shipped successfully, but any future change to critical path code (plugin loading, agent routing, message dispatching) can silently break production with no safety net.

## Goal

Add code quality gates so that:

1. **Formatting is consistent** — Prettier enforces a single style across all `.ts` files.
2. **Lint errors are caught early** — ESLint 9 (flat config) flags bugs and anti-patterns before they reach `main`.
3. **Pre-commit hooks prevent bad commits** — Husky + lint-staged run ESLint and Prettier on staged files at commit time.
4. **Critical path code has tests** — Vitest covers the three modules that break everything when they break: plugin-loader, agent-registry, and dispatcher.
5. **A single `npm run check` command** validates the entire project (typecheck + lint + format + test).

## Scope

### In Scope

- ESLint 9 flat config with `typescript-eslint` and `eslint-config-prettier`
- Prettier standalone (not via ESLint plugin)
- Husky + lint-staged pre-commit hooks (lint + format on staged `.ts` files)
- Vitest test framework with Node environment and v8 coverage
- Tier 1 tests for three critical modules:
  - `plugin-loader.ts` — manifest normalization, plugin loading/skipping
  - `agent-registry.ts` — name addressing, keyword matching, channel lookup, config overrides
  - `dispatcher.ts` — 6-tier agent resolution, dedup, status interception, suppression patterns
- Small refactors to make code testable: export `normalizeManifest()`, extract `applyConfigOverrides()`
- npm scripts: `lint`, `format`, `typecheck`, `test`, `check`
- `.git-blame-ignore-revs` to exclude the initial formatting commit from blame

### Out of Scope

- 100% test coverage — focus is critical path only
- Tier 2 tests (agent-runner, agent-manager) — deferred to a future pass
- CI pipeline — these gates run locally for now
- Typecheck on commit (too slow; runs via `npm run check` instead)

## Acceptance Criteria

- [ ] `npm run lint` passes with no errors (warnings acceptable for `no-explicit-any`)
- [ ] `npm run format:check` passes (all files formatted)
- [ ] `npm run typecheck` passes (both tsconfigs)
- [ ] `npm run test` passes with Tier 1 tests covering plugin-loader, agent-registry, dispatcher
- [ ] `npm run check` runs all four checks in sequence
- [ ] `npm run build` still produces correct output (test files excluded from `dist/`)
- [ ] Pre-commit hook catches a deliberate lint error and blocks the commit
- [ ] `npm run test:coverage` reports coverage for the three critical path files

## Stakeholders

- **May** — approves the plan
- **Mokie** — implements and validates
- **All agents** — benefit from a more stable platform
