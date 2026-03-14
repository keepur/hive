---
name: create-tests
description: Create tests for recent code changes. Analyzes the diff, identifies what needs test coverage, and writes tests using the test-suite-developer agent.
---

# Create Tests

Write tests for recent implementation work. Uses the `test-suite-developer` agent to analyze changes and produce appropriate test coverage.

## Process

1. **Identify scope:** Run `git diff main...HEAD --stat` to see what changed. If the user specifies files or a feature, scope to that instead.

2. **Check for existing tests:** Changed files may already have test files (e.g., `src/agents/agent-runner.test.ts`). Read them first — add new test cases to existing files rather than creating duplicates.

3. **Dispatch test-suite-developer agent** with:
   - The list of changed source files (not docs, not templates, not config)
   - The existing test files for those modules (if any)
   - Instructions to write/extend tests following the project's conventions (below)

4. **Verify:** Run `npm run test` to confirm all tests pass.

5. **Commit:** Commit test files with message `test: add tests for <feature>`

## Project Test Conventions

### Framework & Config
- **Vitest** — globals disabled, explicit imports required
- Config: `vitest.config.ts` — pattern `src/**/*.test.ts`, 10s timeout, node environment
- Scripts: `npm run test` (once), `npm run test:watch` (dev), `npm run test:coverage`

### File Organization
- Tests colocated alongside source: `src/foo.ts` → `src/foo.test.ts`
- No separate `tests/` directory — everything in `src/`

### Imports
```typescript
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
```
Always explicit — never rely on globals.

### Mocking Patterns
- **Module mocks** at top of file with `vi.mock()`:
  ```typescript
  vi.mock("../logging/logger.js", () => ({
    createLogger: () => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }),
  }));
  ```
- **Factory helpers** defined inline per test file (not shared):
  ```typescript
  function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig { ... }
  ```
- **Dependency injection** — pass mocks via constructors using `as any`
- **Tracking** — `vi.fn()` with `mockResolvedValue()`, `mockRejectedValue()`, `toHaveBeenCalledTimes()`

### What to Test
- Logic, branching, edge cases, error handling
- Skip trivial getters/setters/CRUD
- Mock external deps (MongoDB, file system, SDK) — don't require running services
- Integration tests (real HTTP servers) are OK for server modules but keep them fast (<10s)

### Existing Test Files
Reference these for style when writing new tests:
- `src/agents/agent-manager.test.ts`
- `src/agents/agent-registry.test.ts`
- `src/agents/agent-runner.test.ts`
- `src/channels/dispatcher.test.ts`
- `src/plugins/plugin-loader.test.ts`
- `src/background/background-task-manager.test.ts`
- `src/recall/meeting-monitor.test.ts`
