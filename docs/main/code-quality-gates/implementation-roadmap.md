# Code Quality Gates — Implementation Roadmap

## Design Summary

Add linting, formatting, pre-commit hooks, and test coverage to Hive's TypeScript codebase. The approach is pragmatic: relaxed lint rules for the existing codebase, formatting applied as a one-time commit, and tests focused exclusively on infrastructure that breaks everything when it breaks.

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| Vitest over Jest | Native ESM support. Hive uses Node16 module resolution; Jest's ESM support is experimental and requires `--experimental-vm-modules`. |
| ESLint 9 flat config | Greenfield — no legacy `.eslintrc` to migrate. Flat config is the current standard. |
| Prettier standalone | Separate concern from linting. `eslint-config-prettier` disables conflicting ESLint rules. |
| lint-staged on commit | Runs only on staged files. Fast enough for every commit. |
| No typecheck on commit | `tsc --noEmit` checks the entire project regardless of what changed. Too slow for pre-commit. Available via `npm run check`. |
| Relaxed `no-explicit-any` | Existing codebase has `any` throughout config/YAML parsing. Warn, don't block. |

## Phases

### Phase 1: Linting & Formatting Config

**Goal**: Install ESLint 9, Prettier, create configs, add npm scripts.

- Install: `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `prettier`
- Create `eslint.config.js` (flat config) with recommended + TypeScript + Prettier
- Create `.prettierrc` (2-space, double quotes, semicolons, trailing commas, 120 width)
- Create `.prettierignore` (dist, node_modules, agents, logs)
- Add scripts: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`

**No code changes** — config files and scripts only.

### Phase 2: Initial Format Pass

**Goal**: Apply formatting to all existing code in a single commit.

- Run `npm run format` and `npm run lint:fix`
- Commit with a clear message (formatting only, no logic changes)
- Record the commit SHA in `.git-blame-ignore-revs`
- Configure git: `git config blame.ignoreRevsFile .git-blame-ignore-revs`

### Phase 3: Pre-commit Hooks

**Goal**: Block bad commits automatically.

- Install: `husky`, `lint-staged`
- Run `npx husky init` to create `.husky/pre-commit`
- Configure lint-staged in `package.json`: `*.ts` files get `eslint --fix` + `prettier --write`
- Verify: introduce a deliberate error, confirm hook catches it

### Phase 4: Vitest Setup

**Goal**: Test framework ready, no tests yet.

- Install: `vitest`
- Create `vitest.config.ts` (node env, explicit imports, v8 coverage, `src/**/*.test.ts`)
- Update `tsconfig.json`: exclude `**/*.test.ts` from build output
- Update `.gitignore`: add `coverage/`
- Add scripts: `test`, `test:watch`, `test:coverage`, `check`

### Phase 5: Tier 1 Critical Path Tests

**Goal**: Test the three modules that break production when they break.

**Small refactors first:**
- `src/plugins/plugin-loader.ts` — export `normalizeManifest()` (currently internal)
- `src/agents/agent-registry.ts` — extract `applyConfigOverrides()` as a standalone exported function

**Test files:**
- `src/plugins/plugin-loader.test.ts` — manifest normalization, plugin loading, error handling
- `src/agents/agent-registry.test.ts` — name/keyword/channel matching, config overrides
- `src/channels/dispatcher.test.ts` — 6-tier resolution, dedup, status interception, suppression

## Dependencies

- Node 24 (already in use)
- ESLint 9 requires flat config (no `.eslintrc`)
- Vitest requires `vitest.config.ts` (not `.js`) for TypeScript projects
- Husky v9+ uses `npx husky init` (not `husky install`)

## Risks

| Risk | Mitigation |
|------|------------|
| Initial format commit creates massive diff | Single commit, recorded in `.git-blame-ignore-revs`. No logic changes mixed in. |
| ESLint warnings overwhelm on first run | Relaxed rules (`any` = warn, unused vars with `_` prefix ignored). Fix incrementally. |
| Test mocks drift from real implementations | Tier 1 tests focus on pure transforms and lookup logic. Integration-heavy code deferred to Tier 2. |
| Pre-commit hook slows down workflow | lint-staged only processes staged files. Typecheck excluded from hook. |

## Commit Order

1. ESLint + Prettier config + npm scripts (no code changes)
2. Run formatter + linter, record in `.git-blame-ignore-revs`
3. Husky + lint-staged
4. Vitest config + test scripts + tsconfig exclude
5. Tier 1 tests + small refactors

## Verification

1. `npm run check` passes (typecheck + lint + format + test)
2. `npm run build` still works (test files excluded from output)
3. Deliberate lint error is caught by pre-commit hook
4. `npm run test:coverage` shows coverage for the three critical path files
