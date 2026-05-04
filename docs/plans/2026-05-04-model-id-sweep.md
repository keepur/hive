# LLM Model ID Sweep Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Sweep every pinned LLM model ID across the Hive engine and Beekeeper to the current ceiling for its tier (Opus 4.7 / Sonnet 4.6 / Haiku 4.5), and add a CI guard that fails on a re-introduced deprecated literal.

**Architecture:** Multi-repo mechanical bump. Primary repo is `/Users/mokie/github/hive` (engine: runtime configs, model-router tier map, memory lifecycle, code-task, MCP description strings, setup fallbacks, test fixtures); secondary repo is `/Users/mokie/github/beekeeper` (gateway: `src/config.ts` default, `generate-plist.ts` minimal-config writer, `beekeeper.yaml.example`, `docs/configuration.md`, three test fixtures). MongoDB `agent_definitions` are live data and get a one-shot operator-driven sweep at implementation time, not engine code.

**Tech Stack:** TypeScript (strict), vitest, eslint, prettier (hive only). CI: `npm run check` in each repo.

## Testing Contract

### Required Test Groups
- **Unit:** required — Scope: model-router tier map, beekeeper config default, the new deprecated-literal guard test. Reason: each is a pure-function or static-tree assertion. Min assertions: 1 per bumped runtime constant + 1 multi-pattern assertion in the guard test.
- **Integration:** not-required — pure constant bumps; no cross-module wiring changed.
- **E2E:** not-required — no behavioral surface changes.

### Critical Flows / Regression Surface
- `npm run check` in `/Users/mokie/github/hive` — typecheck + lint + format + vitest.
- `npm run check` in `/Users/mokie/github/beekeeper` — typecheck + vitest.
- The new deprecated-literal guard test (vitest spec scanning tracked source) replaces a more complex eslint custom rule. It runs under `npm run check` automatically because vitest picks up `*.test.ts` recursively. Pattern matches the AC grep regex.
- Existing `src/admin/admin-mcp-server.test.ts` fixtures continue to pass (they use unstamped `claude-haiku-4-5` / `claude-sonnet-4-6` — already on tier ceiling, no edit needed there).
- Existing `src/agents/agent-runner.test.ts` fixture at line 1634 references `claude-sonnet-4-5` (stale by one minor; bump to `claude-sonnet-4-6` per canonical-form rule — fixture, not runtime, unstamped form).
- Existing `src/channels/ws/ws-adapter.test.ts` references `claude-haiku-3-5` (3-series, will be flagged by AC grep; bump to `claude-haiku-4-5`).

### Commands
```bash
# Hive
cd /Users/mokie/github/hive && npm run check
# Beekeeper
cd /Users/mokie/github/beekeeper && npm run check
# AC grep — must return zero hits in tracked non-historical files
grep -rn 'claude-opus-4-[0-6]\|claude-sonnet-4-[0-5]\|claude-haiku-4-[0-4]\|claude-haiku-3-' \
  /Users/mokie/github/hive/src/ /Users/mokie/github/hive/setup/ /Users/mokie/github/hive/seeds/ \
  /Users/mokie/github/hive/install/ /Users/mokie/github/hive/service/ /Users/mokie/github/hive/templates/ \
  /Users/mokie/github/hive/docs/ \
  /Users/mokie/github/beekeeper/src/ /Users/mokie/github/beekeeper/skills/ \
  /Users/mokie/github/beekeeper/beekeeper.yaml.example \
  /Users/mokie/github/beekeeper/docs/configuration.md \
  | grep -v 'docs/plans/' | grep -v 'docs/specs/' | grep -v 'plugins/claude-code/' | grep -v node_modules
```

### Harness Requirements
- vitest already wired in both repos. No new harness.

### Non-Required Rationale
- Integration & E2E: this is a constant-rotation ticket. There's no flow to re-prove — only that runtime points at the right string and the new test guards future regressions. Tier-routing logic is unchanged.

### Verification Rules (verbatim from skill)
- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

## Spec Ambiguities

None — spec body is explicit on canonical-form rule, out-of-scope items, and the AC grep. The only design decision left to the implementer is "vitest spec vs eslint custom rule" for the CI guard; this plan picks vitest spec (lower-friction, one new file, runs under existing `npm run check`).

---

### Task 1: Hive — bump runtime model literals (model-router, memory-lifecycle, knowledge-extractor, config defaults)

**Repo:** `/Users/mokie/github/hive`
**Files:** Modify
- `src/agents/model-router.ts`
- `src/memory/memory-lifecycle.ts`
- `src/code-task/knowledge-extractor.ts`
- `src/config.ts`

- [ ] **Step 1:** Audit current state.
  ```bash
  cd /Users/mokie/github/hive
  grep -n 'claude-' src/agents/model-router.ts src/memory/memory-lifecycle.ts src/code-task/knowledge-extractor.ts src/config.ts
  ```
  Expected output (verifies starting state):
  ```
  src/agents/model-router.ts:47:  haiku: "claude-haiku-4-5-20251001",
  src/agents/model-router.ts:48:  sonnet: "claude-sonnet-4-6",
  src/agents/model-router.ts:49:  opus: "claude-opus-4-7",
  src/memory/memory-lifecycle.ts:329:          model: "claude-haiku-4-5-20251001",
  src/memory/memory-lifecycle.ts:440:              model: "claude-haiku-4-5-20251001",
  src/memory/memory-lifecycle.ts:523:          model: "claude-haiku-4-5-20251001",
  src/memory/memory-lifecycle.ts:599:          model: "claude-haiku-4-5-20251001",
  src/code-task/knowledge-extractor.ts:39:      model: "claude-haiku-4-5-20251001",
  src/config.ts:209:    defaultModel: optional("CODE_TASK_MODEL", "claude-sonnet-4-6"),
  src/config.ts:247:    model: optional("MODEL_ROUTER_MODEL", "claude-haiku-4-5-20251001"),
  ```
  All seven runtime sites are already on tier ceilings as of `main` HEAD. **No edits needed in this task.** Proceed to Step 2 only to record the no-op state in the audit log; commit nothing for Task 1.

- [ ] **Step 2:** Verify (no-op acknowledgment).
  ```bash
  cd /Users/mokie/github/hive && grep -E 'claude-opus-4-[0-6]|claude-sonnet-4-[0-5]|claude-haiku-4-[0-4]|claude-haiku-3-' \
    src/agents/model-router.ts src/memory/memory-lifecycle.ts src/code-task/knowledge-extractor.ts src/config.ts
  ```
  Expected: zero matches.

- [ ] **Step 3:** Commit. **Skip** — no edits made; runtime hits already on ceiling. Record in ticket comment: "Task 1 no-op: all hive runtime literals already on tier ceiling per audit on `main`."

---

### Task 2: Hive — bump MCP description strings + setup fallbacks

**Repo:** `/Users/mokie/github/hive`
**Files:** Modify
- `src/admin/admin-mcp-server.ts`
- `src/code-task/code-task-mcp-server.ts`
- `setup/migrate-agents.ts`
- `setup/setup-seeds.ts`

- [ ] **Step 1:** Verify `src/admin/admin-mcp-server.ts:162` already reads `'claude-sonnet-4-6', 'claude-haiku-4-5'` — both on tier ceiling per canonical-form rule (description-string examples take unstamped form). No edit.
  ```bash
  cd /Users/mokie/github/hive && sed -n '162p' src/admin/admin-mcp-server.ts
  ```
  Expected: `      model: z.string().describe("Model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),`

- [ ] **Step 2:** Verify `src/code-task/code-task-mcp-server.ts:87` already reads `'claude-sonnet-4-6'`. No edit.
  ```bash
  cd /Users/mokie/github/hive && sed -n '87p' src/code-task/code-task-mcp-server.ts
  ```
  Expected: `      model: z.string().optional().describe("Model override (e.g. 'claude-sonnet-4-6')"),`

- [ ] **Step 3:** Verify `setup/migrate-agents.ts:107` and `setup/setup-seeds.ts:57` already have `claude-sonnet-4-6` fallback. No edit.
  ```bash
  cd /Users/mokie/github/hive && grep -n 'claude-' setup/migrate-agents.ts setup/setup-seeds.ts
  ```
  Expected:
  ```
  setup/migrate-agents.ts:107:      model: (modelMap.get(agentId) ?? (raw.model as string)) || "claude-sonnet-4-6",
  setup/setup-seeds.ts:57:        model: raw.model ?? "claude-sonnet-4-6",
  ```

- [ ] **Step 4:** Verify the `seeds/chief-of-staff/` tree carries no `claude-*` literal (spec calls this out as a surface to flag if a literal is ever introduced; today the seed uses tier alias `opus` and is out-of-bump-scope per spec).
  ```bash
  cd /Users/mokie/github/hive && grep -rn 'claude-opus\|claude-sonnet\|claude-haiku' seeds/
  ```
  Expected: zero matches. (The seed `agent.yaml` has `model: opus`, an alias, not a literal.)

- [ ] **Step 5:** Verify non-historical hive `docs/` carries no `claude-*` literal.
  ```bash
  cd /Users/mokie/github/hive && grep -rn 'claude-opus\|claude-sonnet\|claude-haiku' docs/ \
    | grep -v 'docs/plans/' | grep -v 'docs/specs/'
  ```
  Expected: zero matches. (Confirms `docs/architecture.md`, `managing-your-hive.md`, `migrating-to-0.2.md`, `release-notes-0.2.0.md`, `troubleshooting.md` are clean — they don't pin model IDs today, so no edit; the Task 6 guard codifies the check going forward.)

- [ ] **Step 6:** Commit. **Skip** — all surfaces already on tier ceiling or alias-based per audit on `main`. Record in ticket comment: "Task 2 no-op (MCP descriptions, setup fallbacks, seeds, non-historical docs all clean)."

---

### Task 3: Hive — bump stale test fixtures (3-series haiku + 4-5 sonnet)

**Repo:** `/Users/mokie/github/hive`
**Files:** Modify
- `src/channels/ws/ws-adapter.test.ts`
- `src/agents/agent-runner.test.ts`

These are the only two hive test files holding stale literals (the `claude-haiku-3-5` references and one `claude-sonnet-4-5`). All other `.test.ts` files use `claude-haiku-4-5` / `claude-sonnet-4-6` — already on ceiling per canonical-form rule.

- [ ] **Step 1:** Patch `src/channels/ws/ws-adapter.test.ts` — three sites bump `claude-haiku-3-5` → `claude-haiku-4-5` (unstamped fixture form, consistent with the rest of the file's canonical convention which is unstamped haiku):

  Site 1 — line 24, inside `makeAgent()`:
  ```diff
  -    model: "claude-haiku-3-5",
  +    model: "claude-haiku-4-5",
  ```

  Site 2 — line 87, inside `makeAgent({ ... })` call in test "maps agent config fields correctly":
  ```diff
  -      model: "claude-haiku-3-5",
  +      model: "claude-haiku-4-5",
  ```

  Site 3 — line 102, the assertion:
  ```diff
  -    expect(result[0].model).toBe("claude-haiku-3-5");
  +    expect(result[0].model).toBe("claude-haiku-4-5");
  ```

- [ ] **Step 2:** Patch `src/agents/agent-runner.test.ts` line 1634 — bump stale sonnet:

  Context: inside the `modelUsage` mock for the "picks largest contextWindow when multiple models used" test (the test only asserts the larger contextWindow wins, so the literal value is incidental; bump to keep the file consistent):
  ```diff
       modelUsage: {
         "claude-haiku-4-5": { contextWindow: 200000 },
  -      "claude-sonnet-4-5": { contextWindow: 1000000 },
  +      "claude-sonnet-4-6": { contextWindow: 1000000 },
       },
  ```

- [ ] **Step 3:** Verify with focused vitest runs.
  ```bash
  cd /Users/mokie/github/hive && npx vitest run src/channels/ws/ws-adapter.test.ts src/agents/agent-runner.test.ts
  ```
  Expected: green for both files.

- [ ] **Step 4:** Verify the AC grep is now clean for hive sources (the new guard test from Task 6 will codify this as a permanent check).
  ```bash
  cd /Users/mokie/github/hive && grep -rn 'claude-opus-4-[0-6]\|claude-sonnet-4-[0-5]\|claude-haiku-4-[0-4]\|claude-haiku-3-' \
    src/ setup/ seeds/ install/ service/ templates/ docs/ \
    | grep -v 'docs/plans/' | grep -v 'plugins/claude-code/' | grep -v node_modules
  ```
  Expected: zero matches.

- [ ] **Step 5:** Commit (hive repo).
  ```bash
  cd /Users/mokie/github/hive
  git add src/channels/ws/ws-adapter.test.ts src/agents/agent-runner.test.ts
  git commit -m "$(cat <<'EOF'
  KPR-119 hive: bump stale test fixture model IDs

  Brings two test fixtures up to current tier ceilings per the
  KPR-119 canonical-form rule (fixture sites use unstamped form):
  - ws-adapter.test.ts: claude-haiku-3-5 → claude-haiku-4-5 (3 sites)
  - agent-runner.test.ts: claude-sonnet-4-5 → claude-sonnet-4-6 (1 site,
    contextWindow incidental — assertion is on size, not literal)

  All hive runtime model pins were already on ceiling on main HEAD;
  this commit only catches the lagging fixtures.
  EOF
  )"
  ```

---

### Task 4: Beekeeper — bump runtime + example + docs default model

**Repo:** `/Users/mokie/github/beekeeper`
**Files:** Modify
- `src/config.ts`
- `src/service/generate-plist.ts`
- `beekeeper.yaml.example`
- `docs/configuration.md`

- [ ] **Step 1:** Patch `src/config.ts` line 252 — top-level `model` default fallback:
  ```diff
  -    model: (raw.model as string) ?? "claude-opus-4-6",
  +    model: (raw.model as string) ?? "claude-opus-4-7",
  ```

- [ ] **Step 2:** Patch `src/service/generate-plist.ts` line 75 — minimal-config writer (used when no `beekeeper.yaml.example` is present, so the freshly generated `beekeeper.yaml` ships the current ceiling):
  ```diff
  -  writeFileSync(target, "port: 8420\nmodel: claude-opus-4-6\n");
  +  writeFileSync(target, "port: 8420\nmodel: claude-opus-4-7\n");
  ```

- [ ] **Step 3:** Patch `beekeeper.yaml.example` line 5:
  ```diff
   port: 8420
  -model: claude-opus-4-6
  +model: claude-opus-4-7
   default_workspace: my-project
  ```

  The `pipeline.orchestrator.pipelineModel` block at lines 56–58 is **already** on tier ceilings (`drafting: claude-opus-4-7`, `review: claude-opus-4-7`, `implementer: claude-sonnet-4-6`). No edit there.

- [ ] **Step 4:** Patch `docs/configuration.md` line 14:
  ```diff
   # Claude model used for sessions inside `channel=beekeeper`.
  -model: claude-opus-4-6
  +model: claude-opus-4-7
  ```

- [ ] **Step 5:** Verify.
  ```bash
  cd /Users/mokie/github/beekeeper && grep -n 'claude-' src/config.ts src/service/generate-plist.ts beekeeper.yaml.example docs/configuration.md
  ```
  Expected: every match shows `4-7` for opus, `4-6` for sonnet, `4-5` for haiku — no `4-[0-5]` opus, no `4-[0-5]` sonnet older, no `4-[0-4]` haiku.

---

### Task 5: Beekeeper — bump test fixtures (config.test, session-manager.test, orchestrator/index.test)

**Repo:** `/Users/mokie/github/beekeeper`
**Files:** Modify
- `src/config.test.ts`
- `src/session-manager.test.ts`
- `src/pipeline/orchestrator/index.test.ts`

- [ ] **Step 1:** Patch `src/config.test.ts` — three sites:

  Site 1 — line 49, in the "loads a valid YAML config" test fixture:
  ```diff
       mockParseYaml.mockReturnValue({
         port: 4000,
  -      model: "claude-sonnet-4-5",
  +      model: "claude-sonnet-4-6",
         confirm_operations: ["rm -rf", "git push --force"],
       });
  ```

  Site 2 — line 57, in the same test's `expect().toMatchObject({...})`:
  ```diff
       expect(config).toMatchObject({
         port: 4000,
  -      model: "claude-sonnet-4-5",
  +      model: "claude-sonnet-4-6",
         confirmOperations: ["rm -rf", "git push --force"],
  ```

  Site 3 — line 140, in "falls back to default model when model is missing":
  ```diff
       const config = loadConfig();
  -    expect(config.model).toBe("claude-opus-4-6");
  +    expect(config.model).toBe("claude-opus-4-7");
  ```

  Lines 193–195 (`VALID_ORCHESTRATOR.pipelineModel`) are already on tier ceilings — no edit.

- [ ] **Step 2:** Patch `src/session-manager.test.ts` line 31:
  ```diff
  -    model: "claude-sonnet-4-5",
  +    model: "claude-sonnet-4-6",
  ```

- [ ] **Step 3:** Verify orchestrator test fixture is already on ceiling:
  ```bash
  cd /Users/mokie/github/beekeeper && grep -n 'claude-' src/pipeline/orchestrator/index.test.ts
  ```
  Expected lines 23–25:
  ```
  src/pipeline/orchestrator/index.test.ts:23:    drafting: "claude-opus-4-7",
  src/pipeline/orchestrator/index.test.ts:24:    review: "claude-opus-4-7",
  src/pipeline/orchestrator/index.test.ts:25:    implementer: "claude-sonnet-4-6",
  ```
  No edit needed.

- [ ] **Step 4:** Verify with focused vitest.
  ```bash
  cd /Users/mokie/github/beekeeper && npx vitest run src/config.test.ts src/session-manager.test.ts src/pipeline/orchestrator/index.test.ts
  ```
  Expected: green.

- [ ] **Step 5:** Verify full beekeeper check.
  ```bash
  cd /Users/mokie/github/beekeeper && npm run check
  ```
  Expected: typecheck + vitest both green.

- [ ] **Step 6:** Verify AC grep is clean for beekeeper:
  ```bash
  cd /Users/mokie/github/beekeeper && grep -rn 'claude-opus-4-[0-6]\|claude-sonnet-4-[0-5]\|claude-haiku-4-[0-4]\|claude-haiku-3-' \
    src/ skills/ beekeeper.yaml.example docs/configuration.md \
    | grep -v 'docs/plans/' | grep -v 'docs/specs/' | grep -v node_modules
  ```
  Expected: zero matches.

- [ ] **Step 7:** Commit (beekeeper repo, single commit covers Task 4 + Task 5 since they share the repo and are one logical sweep — per "one task = one commit per repo" applied to the beekeeper subset).
  ```bash
  cd /Users/mokie/github/beekeeper
  git add src/config.ts src/service/generate-plist.ts beekeeper.yaml.example docs/configuration.md \
          src/config.test.ts src/session-manager.test.ts
  git commit -m "$(cat <<'EOF'
  KPR-119 beekeeper: bump pinned model IDs to current tier ceilings

  Top-level default model bumped Opus 4.6 → 4.7:
  - src/config.ts default fallback
  - src/service/generate-plist.ts minimal-config writer
  - beekeeper.yaml.example
  - docs/configuration.md

  Stale test fixtures bumped to ceilings:
  - src/config.test.ts (sonnet 4-5 → 4-6, opus 4-6 → 4-7)
  - src/session-manager.test.ts (sonnet 4-5 → 4-6)

  pipeline.orchestrator.pipelineModel + orchestrator test fixture
  were already on ceilings; no change there.

  Closes the KPR-78-era smoking gun (KPR-119).
  EOF
  )"
  ```

---

### Task 6: Hive — add CI guard test that fails on a re-introduced deprecated model literal

**Repo:** `/Users/mokie/github/hive`
**Files:** Create
- `src/no-deprecated-models.test.ts` (top of `src/`, picked up by vitest's default `src/**/*.test.ts` pattern, runs under `npm run check`)

**Why a vitest spec, not an eslint custom rule:** spec body says "vitest spec scanning the tree, or an eslint custom rule. Plan-time decision." Vitest spec is one file, no plugin packaging, and naturally exempts node_modules / docs/plans / docs/specs / vendored plugin tree via path filters. Eslint custom rule requires a separate plugin package + config wiring + ignores. Lower-friction path wins.

**Why hive-only and not also beekeeper:** hive's `npm run check` is the gate that catches every PR through the engine — the canonical surface. The beekeeper guard adds bookkeeping for marginal benefit; if a deprecated literal ever lands in beekeeper, the next sweep ticket will catch it, and the much smaller beekeeper tree is easier to spot-check. (If reviewer disagrees, mirror the same file under `/Users/mokie/github/beekeeper/src/no-deprecated-models.test.ts` — same regex, same path filters minus the hive-only paths. Trivial follow-up.)

- [ ] **Step 1:** Create `src/no-deprecated-models.test.ts`:
  ```typescript
  // src/no-deprecated-models.test.ts
  /**
   * KPR-119 — guards against re-introducing a deprecated Claude model
   * literal in tracked source. The acceptance regex is the same one
   * captured in the KPR-119 spec body.
   *
   * Canonical-form rule: this scans BOTH the runtime stamped form
   * (claude-haiku-4-5-20251001) and the unstamped fixture form
   * (claude-haiku-4-5). The deprecated regex below intentionally only
   * matches IDs strictly older than the current tier ceilings.
   *
   * If a future bump is needed (e.g. opus 4-7 → 4-8), update the regex
   * here in the same PR that bumps the runtime sites.
   */
  import { describe, it, expect } from "vitest";
  import { readdirSync, readFileSync, statSync } from "node:fs";
  import { join, relative } from "node:path";

  // Tier ceilings as of 2026-05-04 — Opus 4.7, Sonnet 4.6, Haiku 4.5.
  // Match deprecated IDs strictly older than each ceiling.
  const DEPRECATED = /claude-opus-4-[0-6]\b|claude-sonnet-4-[0-5]\b|claude-haiku-4-[0-4]\b|claude-haiku-3-/;

  // Roots to scan, relative to repo root. Mirrors the KPR-119 AC grep
  // (which includes `docs/`; non-historical docs only — historical
  // plans/specs filtered via IGNORE_FRAGMENTS below).
  const ROOTS = ["src", "setup", "seeds", "install", "service", "templates", "docs"];

  // Path fragments to ignore. Historical artifacts and vendored content
  // are explicitly out of scope per the KPR-119 spec.
  const IGNORE_FRAGMENTS = [
    "node_modules",
    "/dist/",
    "/pkg/",
    "docs/plans/",
    "docs/specs/",
    "plugins/claude-code/",
    ".claude/worktrees/",
    // Self-exclusion: this file documents the regex literally.
    "src/no-deprecated-models.test.ts",
  ];

  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (IGNORE_FRAGMENTS.some((frag) => full.includes(frag))) continue;
      if (st.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  }

  describe("KPR-119: no deprecated Claude model literals in tracked source", () => {
    it("every tracked file is on the current tier ceiling", () => {
      const repoRoot = process.cwd();
      const offenders: string[] = [];
      for (const root of ROOTS) {
        const files = walk(join(repoRoot, root));
        for (const f of files) {
          // Only scan text-ish files; skip binaries by extension.
          if (!/\.(ts|tsx|js|mjs|cjs|json|yaml|yml|md|sh|tpl)$/.test(f)) continue;
          let content: string;
          try {
            content = readFileSync(f, "utf8");
          } catch {
            continue;
          }
          if (DEPRECATED.test(content)) {
            offenders.push(relative(repoRoot, f));
          }
        }
      }
      expect(offenders, `Found deprecated model literal(s) in:\n  ${offenders.join("\n  ")}`).toEqual([]);
    });
  });
  ```

- [ ] **Step 2:** Verify the test runs and passes.
  ```bash
  cd /Users/mokie/github/hive && npx vitest run src/no-deprecated-models.test.ts
  ```
  Expected: `1 passed`.

- [ ] **Step 3:** Verify the test catches a regression. Temporarily inject a deprecated literal into a throwaway file and confirm the test fails:
  ```bash
  cd /Users/mokie/github/hive
  echo '// const m = "claude-opus-4-6";' >> src/agents/model-router.ts
  npx vitest run src/no-deprecated-models.test.ts || echo "EXPECTED FAIL"
  # Revert
  git checkout src/agents/model-router.ts
  ```
  Expected: vitest reports `1 failed` with the offender path. After revert, re-running passes.

- [ ] **Step 4:** Run full `npm run check` to confirm nothing else regressed.
  ```bash
  cd /Users/mokie/github/hive && npm run check
  ```
  Expected: typecheck + lint + format + test all green.

- [ ] **Step 5:** Commit (hive repo).
  ```bash
  cd /Users/mokie/github/hive
  git add src/no-deprecated-models.test.ts
  git commit -m "$(cat <<'EOF'
  KPR-119 hive: add CI guard test for deprecated model literals

  Vitest spec walks src/, setup/, seeds/, install/, service/,
  templates/ and fails if a tracked file contains a Claude model
  literal strictly older than the current tier ceilings (Opus 4.7,
  Sonnet 4.6, Haiku 4.5). Ignores node_modules, dist/, pkg/,
  docs/plans/, docs/specs/, vendored plugins/claude-code/, and
  worktree caches.

  Runs under `npm run check`. When tier ceilings move next, update
  the DEPRECATED regex in this file in the same PR as the runtime
  bump.

  Closes the AC: "CI check exists that fails on a re-introduced
  deprecated model literal — runs under npm run check."
  EOF
  )"
  ```

---

### Task 7: Live MongoDB sweep on dodi + keepur instances (operator-driven, captured as implementation note)

**Repo:** none (out-of-tree live data; no engine code or commit).

Per spec: "Live data; this ticket's spec body does not require runtime mongo writes. The implementer drives a one-shot sweep against the deployed instances (dodi + keepur) at implementation time, querying the live collection read-only first, then bumping via admin MCP / beekeeper CLI."

- [ ] **Step 1:** For each of `dodi` and `keepur` instances, query the live `agent_definitions` collection read-only and produce a tier-ceiling diff.
  ```bash
  for INSTANCE in dodi keepur; do
    echo "=== $INSTANCE ==="
    mongosh "mongodb://localhost:27017/hive_${INSTANCE}" --quiet --eval '
      db.agent_definitions.find({}, { _id: 1, model: 1 }).forEach(d => print(d._id + "\t" + d.model));
    '
  done
  ```

- [ ] **Step 2:** For each agent, classify its current `model` to a tier (`opus` / `sonnet` / `haiku`) and compare against tier ceilings:
  - Opus → `claude-opus-4-7`
  - Sonnet → `claude-sonnet-4-6`
  - Haiku → `claude-haiku-4-5-20251001` (runtime canonical, stamped form)

  The implementer MUST NOT cross tiers (e.g. promote a Sonnet agent to Opus) — out of scope per spec.

- [ ] **Step 3:** For each stale agent, bump via the admin MCP `agent_update` tool (preferred — versions the change in `agent_definition_versions`) or, as a fallback, via beekeeper CLI. Bash-direct mongosh writes are last resort and bypass version history.
  ```text
  Example admin MCP call (per stale agent):
    agent_update({ _id: "<agent-id>", model: "<tier-ceiling>" })
  ```

- [ ] **Step 4:** SIGUSR1 each instance to reload (no engine restart needed for definition-only changes):
  ```bash
  for INSTANCE in dodi keepur; do
    kill -USR1 $(pgrep -f "hive.*${INSTANCE}") || echo "${INSTANCE}: no process found, skip"
  done
  ```

- [ ] **Step 5:** Verify post-sweep state by re-running the read-only mongosh query from Step 1; confirm every row matches its tier ceiling.

- [ ] **Step 6:** Capture the sweep output (before/after table) as a comment on Linear ticket KPR-119. **No commit, no engine change.**

---

### Task 8: Submit + verify

- [ ] **Step 1:** Hive PR — push the branch and open a PR against `main` containing Task 3 + Task 6 commits.
  ```bash
  cd /Users/mokie/github/hive
  git push -u origin HEAD
  gh pr create --title "KPR-119: sweep deprecated model literals + add CI guard" --base main \
    --body "$(cat <<'EOF'
  ## Summary
  - Bump stale hive test fixtures to current tier ceilings (`ws-adapter.test.ts`, `agent-runner.test.ts`).
  - Add vitest guard `src/no-deprecated-models.test.ts` that fails on a re-introduced deprecated Claude model literal.

  Hive runtime pins (`model-router.ts`, `memory-lifecycle.ts`, `knowledge-extractor.ts`, `config.ts`, MCP description strings, setup fallbacks) were already on ceiling on `main` HEAD — no edits.

  Beekeeper bumps and live MongoDB sweep tracked separately under the same ticket.

  Closes KPR-119 (hive surface).

  ## Test plan
  - [x] `npm run check` green
  - [x] Guard test catches a synthetic regression and passes under normal tree
  - [x] AC grep returns zero hits in tracked non-historical files
  EOF
  )"
  ```

- [ ] **Step 2:** Beekeeper PR — push and open against `main`.
  ```bash
  cd /Users/mokie/github/beekeeper
  git push -u origin HEAD
  gh pr create --title "KPR-119: bump pinned model IDs to current tier ceilings" --base main \
    --body "$(cat <<'EOF'
  ## Summary
  - Top-level default model: Opus 4.6 → 4.7 (`src/config.ts`, `generate-plist.ts`, `beekeeper.yaml.example`, `docs/configuration.md`).
  - Test fixtures: stale 4-5/4-6 literals bumped (`config.test.ts`, `session-manager.test.ts`).
  - `pipeline.orchestrator.pipelineModel` and orchestrator test fixture were already on ceilings.

  Closes the KPR-78-era smoking gun.

  ## Test plan
  - [x] `npm run check` green
  - [x] AC grep returns zero hits
  EOF
  )"
  ```

- [ ] **Step 3:** After both PRs merge, follow the live-data sweep playbook (Task 7) and post the before/after table to KPR-119 as a comment, then move the ticket to Done.

- [ ] **Step 4:** Operator follow-up note (NOT blocking this ticket, per spec DoD): existing `beekeeper.yaml` files on disk that pinned `model: claude-opus-4-6` keep their stale value because YAML overrides default. File a `tune-instance` follow-up so each operator's `beekeeper.yaml` gets a one-line bump. Track in a comment on KPR-119 or in a fresh tune-instance ticket.

---

## Acceptance Criteria Coverage

| AC | Where covered |
|---|---|
| AC grep returns zero hits in non-historical files (incl. `docs/`) | Task 3 Step 4, Task 5 Step 6, Task 6 (codified — `docs` in ROOTS, historical filtered) |
| Hive runtime sites on tier ceiling | Task 1 (no-op audit) + Task 2 (no-op audit, MCP/setup/seeds/docs) |
| Seeds (`seeds/chief-of-staff/`) carry no `claude-*` literal | Task 2 Step 4 |
| Non-historical hive `docs/` carry no `claude-*` literal | Task 2 Step 5 |
| Beekeeper top-level default = `claude-opus-4-7` in 4 sites | Task 4 |
| Beekeeper `pipelineTick.models.*` defaults each on tier ceiling | Verified in Task 4 Step 3 (already on ceiling, no edit needed) |
| Test fixtures bumped (canonical-form rule) | Task 3 (hive), Task 5 (beekeeper) |
| CI check exists, runs under `npm run check` | Task 6 |
| dodi + keepur `agent_definitions` swept | Task 7 |
