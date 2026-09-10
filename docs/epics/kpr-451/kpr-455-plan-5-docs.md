# KPR-455 chunk 5 — Docs, AC15 and the final gate

**Task 5 of 5.** Read [the plan index](kpr-455-plan.md) and all seven chunk files before starting.

This chunk is small on purpose: it is the documentation commit, the one criterion whose subject is a file this task writes, and the whole-repo verification with the NV1–NV9 confirmation checklist that counts all nine mutations in one list.

**Files**

- Modify: `CLAUDE.md` — three `hive ops` lines in Commands beside the `hive obligations` block (`:156-160`), one Common Gotchas bullet
- Modify: `src/cli/ops.integration.test.ts` — append the AC15 block

---

## Task 5: documentation and the gate

- [ ] **Step 1:** Add the Commands entry to `CLAUDE.md`, immediately after the `hive obligations deactivate` line (`:160` at this tree — key on the string).

````markdown
# Ops event pipeline (read-only reader + the acknowledgement edge; see docs/epics/kpr-451/kpr-455-design.md)
hive ops health --instance <id> [--stale-after <minutes>] [--limit <n>] [--json]
hive ops stalled --instance <id> [--stale-after <minutes>] [--window <minutes>] [--json]
hive ops ack <handle> --instance <id> --act <seen|dismissed|snoozed> --actor <id> [--until <iso8601>]
````

(That block sits inside the existing fenced `bash` block in the Commands section; add the four lines to it rather than opening a second fence.)

- [ ] **Step 2:** Add the Common Gotchas bullet to `CLAUDE.md`, at the end of the `## Common Gotchas` list. Three things an operator will otherwise get wrong, and nothing else — this is a gotchas entry, not a second copy of the spec.

```markdown
- **`hive ops` is a reader, not a watcher (KPR-455):** three read-only subcommands over the ops record — `health` (the `(tool, errorSig)` rollup from `ops_events`), `stalled` (open published conditions **plus** the measured `error ∨ aborted ∨ timedOut` quiet-turn view over `activity_log`, two labelled sections that are never merged into one number), and `ack` (the KPR-458 D6 inbound acknowledgement edge). Three things it is easy to get wrong. **Absence is not health:** a tool that is not listed published no fact inside the discovery window, and past the staleness horizon (`--stale-after`, defaulting to 24 h for tool health and 72 h for work status) the answer is `unknown` — never `healthy`. **`--actor` is required and has no default** — no `$USER`, no hostname; the edge attributes or refuses, and there is deliberately no `--at` flag, because for a CLI the invocation *is* the act. **This child ships no sweep**: nothing here runs on a timer, nothing pages anybody, and nothing publishes turn-outcome conditions into `ops_events` — so the quiet-turn arm is **pull only** and is visible when a human runs the command and by no other means. `ack` is the only path that writes: it hosts KPR-468's own notifier in the CLI process, so its `init()` materialises `ops_notifications` and its indexes on a cold instance, and `unavailable` there means **UNKNOWN, not "nothing was recorded"** (exit 1 = not confirmed; `seen`/`dismissed` are safe to re-run). `hive doctor` gains an informational "Ops event pipeline (KPR-455)" section that never flips the exit code.
```

- [ ] **Step 3:** Append AC15 to `src/cli/ops.integration.test.ts`.

```typescript
describe("AC15 — documentation", () => {
  const claudeMd = readFileSync("CLAUDE.md", "utf8");

  it("documents all three subcommands in Commands", () => {
    for (const line of ["hive ops health", "hive ops stalled", "hive ops ack <handle>"])
      expect(claudeMd).toContain(line);
  });

  it("carries one Common Gotchas bullet naming absence-is-not-health, the required --actor and the absent sweep", () => {
    const gotchas = claudeMd.slice(claudeMd.indexOf("## Common Gotchas"));
    expect(gotchas).toContain("Absence is not health");
    expect(gotchas).toContain("`--actor` is required and has no default");
    expect(gotchas).toContain("ships no sweep");
  });
});
```

- [ ] **Step 4:** Verify the documentation change.

```bash
npx vitest run src/cli/ops.integration.test.ts -t "AC15"
npx prettier --check CLAUDE.md || echo "CLAUDE.md may be in .prettierignore — check before treating this as a failure"
grep -n "hive ops" CLAUDE.md
```

**Expected:** the AC15 block passes. The grep prints the three Commands lines plus the gotchas bullet's own mentions. If `.prettierignore` covers `*.md`, prettier reports the file as ignored and that is not a failure — confirm with `cat .prettierignore` rather than assuming either way.

- [ ] **Step 5:** The whole-repo gate.

```bash
node --version   # expect v22.x or v24.x
npx tsc --noEmit
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
git diff --check
git status --short
```

**Expected:** `npm run check` (typecheck + lint + format + test) exits 0 with no failures and no new skips. `git diff --check` prints nothing. `git status --short` is clean after the commit in Step 7. **Record the actual test totals** from `npm run check`; do not invent expected counts.

Two regressions to read explicitly in that output rather than trusting the aggregate:

- `src/boot-order.test.ts` passes and is **unmodified** (`git log --oneline -5 -- src/boot-order.test.ts` shows nothing from this ticket). That is AC2's standing evidence.
- `src/ops/**` passes entire. Both siblings' suites run against the doubles this child also uses; a red there means this child perturbed a shared harness, which it must not.

- [ ] **Step 6:** The NV1–NV9 confirmation checklist. **All nine mutations must have been run and restored**, and each report must name the tests that actually went red against the prediction. Do not report success with any of them unrun — an earlier epic child shipped a "six points" list over seven mutations and an implementer following it reported success with two genuinely unrun.

| id | mutation | run in | confirmed? |
| --- | --- | --- | --- |
| NV1 | recovery keyed on `(tool, errorSig)` instead of `tool` | chunk 4 Step 4 | ☐ |
| NV2 | `clearingIsLegal` ⇒ `class !== "informational"` | chunk 4 Step 9 (rehearsed chunk 1b Step 6) | ☐ |
| NV3 | the same-producer clause deleted | chunk 4 Step 9 | ☐ |
| NV4 | the stale ⇒ `unknown` branch deleted | chunk 4 Step 3 | ☐ |
| NV5 | `TURN_ACTIVITY_FILTER` spread deleted | chunk 4 Step 6 | ☐ |
| NV6 | the union narrowed to `error` alone | chunk 4 Step 5 | ☐ |
| NV7 | `at` re-minted inside the retry loop | chunk 4 Step 8 | ☐ |
| NV8 | `setLogLevel("error")` deleted | chunk 2b Step 7 | ☐ |
| NV9 | the doctor's `backlog` exclusion deleted | chunk 3 Step 7 | ☐ |

For each: **which tests went red, and did that match the prediction?** A mutation whose actual failure set differs from the predicted one is a finding to report — it usually means either the test is asserting something other than what its name claims, or the harness is doing the work the implementation was supposed to. **Do not adjust the prediction to match the run.**

- [ ] **Step 7:** Commit.

```bash
git add CLAUDE.md src/cli/ops.integration.test.ts
git commit -m "$(cat <<'EOF'
docs(KPR-455): hive ops commands and the absence-is-not-health gotcha

Three subcommands in Commands beside the hive obligations block, and one
Common Gotchas bullet naming the three things an operator will otherwise get
wrong: absence is not health, --actor is required with no default, and this
child ships no sweep — so the quiet-turn arm is pull only.

AC15 asserts both, appended to the acceptance suite here rather than in Task 4
because its subject is a file this commit writes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8:** Report. The implementation report owes, at minimum:

- The actual test totals from `npm run check`, and the per-file counts for the four new test files.
- The NV1–NV9 table above with each row's **actual** red set beside its prediction, and any mismatch called out rather than smoothed over.
- Confirmation that `src/index.ts` and `src/boot-order.test.ts` are untouched, and that no file under `src/ops/` was created or modified.
- Any place the merged siblings diverged from the interfaces chunk 1 Step 1 re-verifies — those are plan-revision triggers, not things to work around in an implementation file.
