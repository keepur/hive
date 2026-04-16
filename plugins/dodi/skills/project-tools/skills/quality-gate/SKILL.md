---
name: quality-gate
description: Run before creating a PR — chains test creation, compliance checks, and build verification in sequence, stopping on failure
agents:
  - vp-engineering
---

# Quality Gate

Single command that runs all pre-PR quality checks in sequence. Stops on first failure.

## Process

```
/quality-gate
  │
  ├── Step 1: Create Tests ──→ generates missing tests for branch changes
  │
  ├── Step 2: Compliance Checks ──→ FAIL? Stop, fix, re-run
  │
  └── Step 3: Build Verification ──→ FAIL? Stop, fix, re-run
```

### Step 1: Create Tests

Invoke the `create-tests` skill scoped to the current branch changes.

This analyzes changed files, triages what's worth testing, and generates unit/integration tests as needed. It may generate no tests if the changes don't warrant them (e.g., docs-only, config changes, simple CRUD).

**On completion:** Commit any generated tests, then proceed to step 2.

### Step 2: Compliance Checks

Run `npm run check` (typecheck + lint + format + test).

**On failure:** Stop. Report violations. Fix issues before proceeding. After fixes, re-run `/quality-gate` from the top.

**On pass:** Proceed to step 3.

### Step 3: Build Verification

Run `npm run build` (compile core + plugins).

**On failure:** Stop. Report errors with details.

**On pass:** Report success.

## Final Report

```
## Quality Gate Results

**Branch:** <branch-name>

### 1. Test Creation
✅ Created N unit tests, N integration tests
   (or: ✅ No new tests needed for these changes)

### 2. Compliance Checks
✅ PASS — typecheck, lint, format, test all clean

### 3. Build
✅ PASS — core + plugins compiled

**Ready for PR:** ✅ Yes — proceed with `dodi-dev:review` then `dodi-dev:submit`
```

## Notes

- Each step invokes an existing skill or command — this is a sequencer, not a reimplementation
- If the branch has no code changes (docs only), skip all steps and report "no code changes to gate"
- Re-running is safe — test creation skips existing tests, checks and build are stateless
