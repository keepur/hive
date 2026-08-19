# KPR-356 Implementation Plan — Hygiene: close PR #194 as superseded (no code)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-356-spec.md](./kpr-356-spec.md) (signed off @ d9c8ccd) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md). **This is a verify-only, no-code child**: the mechanical closure of PR [keepur/hive#194](https://github.com/keepur/hive/pull/194) already happened (closed 2026-07-20T07:09:13Z, unmerged, supersession comment posted at closure). Delivery is three read-only verifications plus landing this spec + plan under `docs/epics/kpr-345/` through the normal child-PR flow. **Zero edits to `src/` or any code path.**

**Goal:** Make the supersession of #194 durable epic canon — closed-not-merged confirmed, supersession comment confirmed equivalent to spec §Deliverable(a), docs landed — with no dangling "what happened to the sidecar branch?" thread and no code diff.

**Baseline (re-verified 2026-07-23, plan-writing session):** `gh pr view 194` returns `state: CLOSED`, `mergedAt: null`, `closedAt: 2026-07-20T07:09:13Z`; the closing comment (may-keepur, 2026-07-20T07:09:13Z) names KPR-314 as the salvage path AND KPR-309/PR #318 as the refinement/merge AND states the OpenAI-sidecar out-of-scope ruling. Spec §Open-assumptions **A1 holds** — Task 2's conditional re-post is expected to be a no-op.

**Decision-register canon honored:**
- *OpenAI sidecar out of scope* — this child records the ruling, it does not reopen it. No task below touches `src/llm/`, no sidecar-provider work is planned or filed. The epic's two-lane model + main's `src/llm/` (KPR-314/KPR-309) is the superset; nothing here re-litigates that.
- *No code* — the only repo diff from this child is `kpr-356-spec.md` + this plan under `docs/epics/kpr-345/` (Task 3 pins this with a diff-scope check).
- *No branch deletion* — `codex/multi-provider-sidecar-llm` is left in place (reconcile-tickets territory, spec §Non-goals).

---

## Testing Contract

### Required Test Groups

- Unit: **not required** — N/A by construction. There is no code diff for unit tests to cover; the entire repo change is two markdown files under `docs/epics/kpr-345/`.
- Integration: **not required** — same rationale; no module boundary changes, nothing to integrate.
- E2E: **not required** — no behavior exists to exercise end-to-end.

In place of code test groups, **the delivery verification checklist below IS the whole of delivery** (spec §Testing contract). Each item is a task with an exact command and expected output:

1. **PR state (Task 1):** `gh pr view 194 --repo keepur/hive --json state,mergedAt,closedAt` → `state: "CLOSED"`, `mergedAt: null` (closed, **not** merged).
2. **Supersession note present (Task 2):** the PR's comment thread contains a closing comment equivalent to spec §Deliverable(a) — references KPR-314 and/or KPR-309/PR #318 as the absorbing work AND records the OpenAI-sidecar out-of-scope ruling. Only if absent/deficient: post the canonical text, re-verify.
3. **No code diff (Task 3):** `git diff kpr-345...HEAD --stat` on the child branch shows changes only under `docs/epics/kpr-345/`.
4. **Docs land (Task 4):** `kpr-356-spec.md` + `kpr-356-plan.md` exist on the child branch and merge to the epic branch `kpr-345` through the normal child-PR flow.

### Regression Surface

- None in code — empty diff outside `docs/epics/kpr-345/` is itself the pinned property (Task 3).
- `npm run check` still runs unconditionally on the child PR (CI is unconditional per repo policy); it exercises the **unchanged** codebase and is expected green with zero relation to this child's content. Local pre-PR run requires the env stubs: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.

### Harness Requirements

- `gh` authenticated with read (and, for the Task 2 fallback only, comment-write) access to `keepur/hive` (dev Mac default: `may-keepur`).
- `npm ci` in the worktree if `node_modules` absent, for the local `npm run check` (Node 22/24 — dev-mode Node 26 broken per KPR-344).
- No Mongo, no live credentials, no network beyond `gh` API calls.

### Non-Required Rationale

- Unit/integration/e2e: no diff for tests to cover — a no-code hygiene child cannot regress code. The verification checklist above substitutes as the delivery gate (spec §Testing contract makes this explicit N/A).

### Verification Rules

- Missing harness (`gh` auth) is not a skip reason; fix it or report a concrete blocker.
- If Task 1 finds the PR reopened or merged, or Task 2 finds the comment deleted, that is **new external state the spec didn't anticipate beyond its fallback** — for a reopened/merged PR, STOP and report (do not re-close a PR someone deliberately reopened); for a missing comment, the spec's fallback (post canonical text) applies directly.
- Negative-verify discipline is N/A — there is no code fix whose test could be reverted against. The gh checks are live-state observations, recorded verbatim in the PR description as evidence.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/epics/kpr-345/kpr-356-spec.md` | already committed (@ d9c8ccd) | supersession rationale as durable epic canon |
| `docs/epics/kpr-345/kpr-356-plan.md` | create (this file) | verify-only delivery plan |

**NOT touched:** everything else. No `src/` file, no test file, no `CLAUDE.md` rider (the collections/pilots sections have nothing to say about a closed PR), no `keepur/hive-docs` change (spec A3), no branch deletion.

---

## Task 1 (Chunk 1): Verify PR #194 is closed, not merged

Read-only; produces no repo change and no commit.

- [ ] **Step 1.1: Query PR state**

```bash
gh pr view 194 --repo keepur/hive --json state,mergedAt,closedAt
```

Expected output (baseline-verified 2026-07-22 and 2026-07-23):

```json
{"closedAt":"2026-07-20T07:09:13Z","mergedAt":null,"state":"CLOSED"}
```

Pass condition: `state` is `CLOSED` AND `mergedAt` is `null`. (`closedAt` may only move if someone reopened and re-closed — a later timestamp with state still CLOSED/unmerged is a pass; record it.) If `state` is `OPEN` or `MERGED`: **STOP — concrete blocker**, report to the driver; do not re-close or otherwise mutate the PR.

- [ ] **Step 1.2: Record the verbatim JSON output** for the PR-description evidence block (Task 4).

---

## Task 2 (Chunk 2): Verify the supersession comment (conditional fallback: post canonical text)

Expected path is verify-only no-op (spec A1). Only the fallback step writes anything, and only to the GitHub PR thread — never to this repo.

- [ ] **Step 2.1: Fetch the closing comment**

```bash
gh pr view 194 --repo keepur/hive --json comments \
  --jq '.comments[] | select(.body | test("supersed"; "i")) | {author: .author.login, createdAt, body}'
```

Expected: exactly one match — author `may-keepur`, createdAt `2026-07-20T07:09:13Z`, body beginning "Closing as superseded. Main's `src/llm/` provider seam was salvaged from this PR under KPR-314 and refined/merged via KPR-309 (PR #318)…".

- [ ] **Step 2.2: Check equivalence against spec §Deliverable(a)** — both criteria must hold in one comment:
  - references KPR-314 **and/or** KPR-309/PR #318 as the absorbing work (baseline comment names all three), AND
  - records the OpenAI-sidecar out-of-scope ruling (baseline comment: "The one unported piece (OpenAI/OpenAI-compatible sidecar providers) is explicitly out of scope for epic KPR-345…").

  Baseline-verified: **both criteria hold** → this task is complete; skip Step 2.3.

- [ ] **Step 2.3 (CONDITIONAL — only if Step 2.2 fails): post the canonical text and re-verify**

  Post the spec §Deliverable(a) blockquote **verbatim** (single paragraph, starting "Closing as superseded (KPR-356, epic KPR-345)…"):

```bash
gh pr comment 194 --repo keepur/hive --body "$(cat <<'EOF'
Closing as superseded (KPR-356, epic KPR-345). Main's `src/llm/` provider seam was salvaged from this branch under KPR-314 and refined/merged via KPR-309 (PR #318) — it now covers everything here (registry, anthropic + gemini providers, cost tracking, jsonSchema structured outputs, no-key precheck) with fixes this branch lacked. The one unported piece — OpenAI/OpenAI-compatible sidecar providers (non-agentic one-shot calls) — is explicitly out of scope for epic KPR-345 per its decision register; file separately against current `src/llm/` if wanted. Agentic provider routing (this PR's "Phase 2" ambition) is delivered by the epic's Lane B adapters instead (KPR-347–349, KPR-353).
EOF
)"
```

  Then re-run Steps 2.1–2.2 → **≥1 matching comment passing both criteria** is the re-verify pass condition (after a fallback post, Step 2.1 legitimately matches two comments — the pre-existing deficient one plus the new canonical one; that is a pass, not a failure). Do **not** delete or edit the pre-existing comment (if any) — additive only.

- [ ] **Step 2.4: Record the comment evidence** (author + createdAt + whether 2.3 fired) for Task 4.

---

## Task 3 (Chunk 3): Diff-scope check — docs-only, `docs/epics/kpr-345/` only

Run on the delivery child branch (off `kpr-345`), after spec + plan are present on it.

- [ ] **Step 3.1: Scope the diff against the epic base**

```bash
git diff kpr-345...HEAD --stat
```

Expected: **every** listed path starts with `docs/epics/kpr-345/` (the set is `kpr-356-spec.md` and/or `kpr-356-plan.md`; an **empty diff is also a pass** — it means both docs already merged to the epic branch via the maturation flow, and the docs-land check moves to Step 3.2's epic-branch observation). Any path outside `docs/epics/kpr-345/`: **STOP — the no-code contract is violated**; remove the stray change before proceeding.

- [ ] **Step 3.2: Confirm both docs exist on the branch**

```bash
ls docs/epics/kpr-345/kpr-356-spec.md docs/epics/kpr-345/kpr-356-plan.md
```

Expected: both paths print; exit 0.

- [ ] **Step 3.3: Local check gate (pre-PR, per repo policy)**

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: exit 0 — green against the unchanged codebase (typecheck + lint + format + vitest; markdown is outside every gate's input set, so any failure here is pre-existing epic-branch state, not this child — report it, don't fix it here).

---

## Task 4 (Chunk 4): Land the docs — child PR into `kpr-345`

Normal child-PR flow (dodi-dev:submit-ticket-pr). **Base is the epic branch `kpr-345`, not `main`** (feedback_pr_base_on_epic_branches).

- [ ] **Step 4.1: Open the child PR** with `--base kpr-345`. PR description carries the evidence block: Task 1 verbatim JSON, Task 2 comment author/timestamp + equivalence verdict (+ whether the fallback fired), Task 3 diff-stat output, and a one-line statement of the out-of-scope ruling recorded (spec §Deliverable(c)).

  **Contingency (empty diff):** if Step 3.1 found an empty diff (docs already on `kpr-345`), a child PR cannot be opened — report to the driver that testing-contract item 4 is already satisfied on the epic branch (cite the epic-branch commit carrying each doc) and deliver the evidence block via the completion report instead. Do not manufacture a filler diff to force a PR.

- [ ] **Step 4.2: CI + merge** — `npm run check` runs unconditionally on the PR; expected green (unrelated to content, per Testing Contract). Merge into `kpr-345` via the normal orchestrator-side flow. Verification item 4 closes when both docs are reachable on the epic branch.
