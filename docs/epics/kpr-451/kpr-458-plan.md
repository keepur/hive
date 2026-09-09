# KPR-458 ops-event contract implementation plan

> **For agentic workers:** Execute this plan through `dodi-dev:drive-epic` and its implementation lane, as the KPR-451 epic's other children do. This is a **policy child**, not an engineering child: no task below creates or modifies a source file.

**Goal:** Close KPR-458 by landing its sole deliverable — the ops-event publish/subscribe contract — in a state that is factually accurate against the epic head and no longer states its own central mechanism as unowned.

**Architecture:** The deliverable already exists on the epic branch as `docs/epics/kpr-451/kpr-458-design.md`, spec-reviewed clean over four rounds and human-signed-off. What remains is three things the spec itself names: (1) verify that the runtime facts the contract's evidence table and conformance criteria rest on still hold at the epic head, since a contract document's accuracy *is* its quality; (2) append a post-signoff addendum recording that both components the signed-off body describes as "chartered to no child" now have owners, plus the canon this contract contributes to the epic's Decision Register; (3) perform the PM steps the spec calls its Gate-1 conversation. The signed-off body is never edited — only appended to, under a delimited addendum heading, following the `docs/epics/kpr-415/kpr-417-spec.md` §12/§13 precedent (a "canon to lift" section and a post-merge addendum that corrects a stale body claim without rewriting it).

**Tech Stack:** Markdown, git, `sed`/`grep` for anchor verification, Linear for PM state. No TypeScript, no build, no runtime dependency, no MongoDB collection, no index, no validator, no registry row, no subscription.

**Approved input:** [KPR-458 design](kpr-458-design.md), signed off at [KPR-458#comment-3f6e8a4a](https://linear.app/keepur/issue/KPR-458#comment-3f6e8a4a), committed at `3aa6d06` ("docs(KPR-458): close spec review loop — four rounds clean"). Baseline for this plan: `epic/kpr-451` at `3aa6d06`. The spec's own scope statement governs everything below: *"Its deliverable is this contract document and nothing else: no code, no collection, no index, no validator, no registry row, no subscription… A plan writer reading this artifact should plan for a document, a Gate-1 conversation, and the two scoping decisions named below — not for an implementation."* (design §"Scope and authority").

**Fresher-than-spec input:** the two scoping decisions the body leaves open were resolved by the operator after spec review closed — the D12 matcher–deliverer went to a new child **KPR-468** ("Notifier — deliver, nudge, clear and accept acknowledgements over the ops-event ledger", blocked by KPR-454 and KPR-458), and the D6 inbound acknowledgement edge went to **KPR-455** (the reader). Recorded at [KPR-455#comment-1b79ee1a](https://linear.app/keepur/issue/KPR-455#comment-1b79ee1a). Task 2 records this in the artifact; no task re-litigates it.

**Execution boundary:** This plan changes exactly one file, `docs/epics/kpr-451/kpr-458-design.md`, by appending to it. It does not implement, deploy, register a reason row, register a subscription, bind a transport, create a collection, or modify production prompts. Task 3's PM actions are the driver's/operator's, not the implementer's, and one of them is a question to the operator rather than an action.

## File structure

There is no source-file map, because no source file is touched. The complete surface of this ticket:

| File | Action | Responsibility |
| --- | --- | --- |
| `docs/epics/kpr-451/kpr-458-design.md` | Modify (append only, after line 476) | The deliverable. Gains one delimited post-signoff addendum with five subsections: scoping resolution, supersession map, anchor-verification record, contributed canon, and a not-shipped checklist. |

**Explicitly not created by this ticket, with reasons** — an implementer who adds any of these has exceeded the plan:

- `docs/ops-events.md` or any operator-facing engine doc. Nothing implements this contract yet; an operator doc describing unbuilt behavior is misleading, and the spec's deliverable is one document.
- A `CLAUDE.md` Conventions bullet. That section describes engine behavior a contributor must not violate; there is none yet. The bullet arrives with the first implementing child.
- `CLAUDE.md` MongoDB-collections entries for `ops_events` / `ops_subscriptions` / `ops_notifications`. Design D1 assigns each to "the child that creates them" — KPR-454 for the first two, KPR-468 for the third.
- Any edit to the signed-off body above line 476.
- Any change to `kpr-452-*`, `kpr-453-*`, `kpr-456-*` artifacts.

## Testing Contract

### Required Test Groups

- Unit: `not-required`
  - Scope: none.
  - Reason: see Non-Required Rationale.
  - Minimum assertions: n/a.

- Integration: `not-required`
  - Scope: none.
  - Reason: see Non-Required Rationale.
  - Harness: `not-applicable`
  - Minimum assertions: n/a.

- E2E: `not-required`
  - Scope: none.
  - Reason: see Non-Required Rationale.
  - Harness: `not-applicable`
  - Minimum assertions: n/a.

- Document verification: `required` *(fourth group, added because it is the only group with anything to bind to on this ticket)*
  - Scope: the seven runtime anchors the contract's "Problem and observed evidence" table, D3, D10 and C6/C12 cite by file and line; the append-only invariant on the signed-off body; the single-file diff scope.
  - Reason: the deliverable is a document whose authority rests on cited runtime facts. A cited line that has moved or changed since drafting turns a conformance criterion into a false claim that KPR-454/455/468 would then implement against. This is the ticket's real failure mode and it is mechanically checkable.
  - Harness: `existing` — `sed`, `grep`, `git diff`, all present.
  - Minimum assertions: each of the seven anchors in Task 1 produces its stated exact output at the epic head; `git diff` reports exactly one changed file; `git diff` on the design file reports insertions only, zero deletions, and no hunk touching a line at or before 476.

### Critical Flows

- An engineer picking up **KPR-468** reads D12 and reaches a named owner (itself) rather than "chartered to nobody", and learns its two hard constraints: it must not ship without KPR-455's inbound edge, and it is blocked by KPR-454.
- An engineer picking up **KPR-455** reads D6 and learns the inbound acknowledgement edge is theirs, with the four obligations D6 fixes (translate-only, no ledger access, attribute-or-refuse, idempotency belongs to intake).
- An engineer picking up **KPR-454** reads D12's synchronous/swept split and learns that match evaluation, the `matchedSubscriptionIds` stamp, the `ops_events`/`ops_subscriptions` initialization and the loaded subscription set are the *producer's*, not the notifier's.
- The epic driver reads one section and lifts the canon lines KPR-458 contributes into the KPR-451 Decision Register without re-deriving them from a 476-line contract.
- A reader of C6 is still routed to co-locating `waitingFor` with `policyFor`, and a reader of D3 is still warned that `policyFor`'s fallthrough comment is stale on `team-`.

### Regression Surface

- The signed-off body of `kpr-458-design.md` (lines 1–476) — must be byte-identical after every task. The addendum corrects by supersession, never by editing, which is what keeps the signoff at [KPR-458#comment-3f6e8a4a](https://linear.app/keepur/issue/KPR-458#comment-3f6e8a4a) attached to a document that still exists.
- Sibling epic artifacts `kpr-452-*.md`, `kpr-453-*.md`, `kpr-456-*.md` — untouched.
- All of `src/` — untouched. In particular `src/outage/outage-notices.ts`, `src/events/event-types.ts`, `src/scheduler/scheduler.ts`, `src/obligations/` and `src/boot-order.test.ts` are *read* by Task 1 and never modified; D10 and canon (KPR-456, KPR-457) preserve those contracts unchanged.
- The KPR-451 Decision Register — the canon drafted in Task 2 must contradict no merged entry from KPR-453, KPR-456 or KPR-457. Task 2 step 5 checks this explicitly.

### Commands

- Unit: `n/a — no executable behavior in this ticket's deliverable`
- Integration: `n/a — no executable behavior in this ticket's deliverable`
- E2E: `n/a — no executable behavior in this ticket's deliverable`
- Document verification: the seven anchor commands in Task 1, plus `git diff --stat` and `git diff -U0 docs/epics/kpr-451/kpr-458-design.md` in Task 2 step 6.
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — run once at the end of Task 2 as the repo's own gate. Expected: unchanged pass, since no file it inspects was modified. A failure here is a pre-existing tree problem, not this ticket's; report it rather than "fixing" it inside this ticket.

### Harness Requirements

- A worktree on `epic/kpr-451` at `3aa6d06` or later. No service, fixture, seed data, browser, env var, mock, or account is required for Tasks 1–2.
- Task 3 requires Linear write access (`~/.linear.env`, per `reference_linear_api_direct.md`) **or** the driver/operator performing it interactively. Task 3 is explicitly not blocking for Tasks 1–2 and does not gate the epic-branch push.

### Non-Required Rationale

- Unit: `not-required` — the deliverable creates and modifies **zero functions, modules, or components**; there is no callable surface a unit test could bind to. This is not a missing-harness skip: Vitest is present, configured, and used by every sibling child in this epic; there is simply no code in this ticket. The behaviors the contract describes are tested by the children that implement them, each under its own Testing Contract, and the contract's own conformance criteria C1–C19 are written as the assertions those children must satisfy (e.g. C7 "a test enumerates the grammar", C18 "a test asserts that a repeated identical condition leaves `generation` unchanged"). Writing those tests here would test nothing that exists.
- Integration: `not-required` — same reason. The module boundaries this contract names (`ops_events` accept path, ledger sweep, transport adapter, inbound edge) are created by KPR-454, KPR-468 and KPR-455 respectively; there is no boundary to integrate against at this commit. Note also design D12/D10: the boot-order anchors and sweep-drain ordering this contract prescribes must go in all three lists of `src/boot-order.test.ts` — **by the children that add those subsystems**, not here, because adding an anchor for a subsystem that does not exist would fail the guard.
- E2E: `not-required` — same reason, and the contract has no user-facing or business-critical flow of its own. Its first end-to-end flow (publish → match → ledger → transport → acknowledgement) spans three unbuilt children and cannot exist until KPR-468 lands; D12's closing paragraph fixes the sequencing (the notifier must not ship without the inbound edge), which is where that E2E obligation lands.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker. *(Not invoked here — the three not-required rationales above are "no executable behavior in this ticket's own deliverable", which is a different and legitimate reason.)*
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane. **Concretely for this ticket:** if a Task 1 anchor has drifted in a way that *invalidates* a conformance criterion or an evidence-table claim — e.g. `policyFor`'s prefix table changed so D3's `waiting` mapping is wrong, or `turn-scaffold.ts` no longer returns a literal `costUsd: 0` so C12's negative test is unreproducible — do **not** patch the body and do not paper over it in the addendum. Stop and demote to the spec lane, because the signed-off contract would then rest on a false premise. A drift that merely *moves* a line (same fact, new line number) is recorded in the addendum's anchor table and is not a demotion.

---

### Task 1: Verify the contract's runtime anchors at the epic head

**Files:**
- Read only: `src/outage/outage-notices.ts`, `src/agents/provider-adapters/turn-scaffold.ts`, `src/agents/agent-manager.ts`, `src/types/agent-definition.ts`, `src/scheduler/scheduler.ts`, `src/events/event-types.ts`
- Create: none
- Modify: none
- Test: none (this task *is* the Document-verification group)

- [ ] **Step 1:** Confirm the worktree baseline.

Run:
```bash
git -C "$PWD" rev-parse --abbrev-ref HEAD && git -C "$PWD" log --oneline -1
```
Expected: a branch off `epic/kpr-451`, at `3aa6d06 docs(KPR-458): close spec review loop — four rounds clean` or a later epic-branch commit.

- [ ] **Step 2:** Anchor A1 — `policyFor` and its stale comment (design D3, C6).

Run:
```bash
sed -n '18,26p' src/outage/outage-notices.ts
```
Expected, exactly:
```
export function policyFor(item: WorkItem): OutageSourcePolicy {
  const id = item.id;
  if (id.startsWith("sched:")) return "skip"; // cron re-fires at the next match — queueing would double-run
  if (id.startsWith("callback:")) return "silent"; // one-shot, marked fired pre-dispatch — queue preserves it
  if (id.startsWith("event:")) return "silent";
  if (id.startsWith("team-")) return "silent";
  if (id.startsWith("worker:")) return "silent"; // KPR-390: one-shot boss re-entry, claim already terminal — queue preserves it
  return "notify"; // human channels: slack, sms, imessage, app/ws, team DM
}
```
This confirms three separate claims at once: the `18-26` citation, D3's `policyFor` → `waiting` mapping table (`sched:`→`nobody`, `callback:`/`event:`/`worker:`→`nobody`, `team-`→`agent`, fallthrough→`human-now`), and D3's warning that the fallthrough comment still says "team DM" although a `team-` id returns `silent` two lines above and can never reach it. If the "team DM" text is gone, the *fact* D3 warns about is fixed upstream — record that in the addendum's anchor table; it is a drift, not a demotion, because D3's mapping is unchanged either way.

- [ ] **Step 3:** Anchor A2 — the literal zero cost (evidence table, C12).

Run:
```bash
sed -n '353p' src/agents/provider-adapters/turn-scaffold.ts
```
Expected: `      costUsd: 0,`

- [ ] **Step 4:** Anchor A3 — the sparse abort flags (evidence table).

Run:
```bash
sed -n '2611,2612p' src/agents/agent-manager.ts
```
Expected:
```
      ...(result.aborted ? { aborted: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
```

- [ ] **Step 5:** Anchors A4–A6 — the event-bus facts (evidence table, D10).

Run:
```bash
sed -n '65p' src/types/agent-definition.ts
sed -n '322p' src/scheduler/scheduler.ts
grep -cE '^  "[a-z_]+:[a-z_]+": \{' src/events/event-types.ts
sed -n '119,126p' src/events/event-types.ts
```
Expected:
```
  subscribe?: string[];
  private async checkEvents(): Promise<void> {
13
  "system:task_blocked": {
    description: "A task is blocked and needs attention",
    payload: z.object({
      taskId: z.string(),
      description: z.string(),
      blockedBy: z.string(),
    }),
  },
```
These confirm, in order: D10's `subscribe: string[]` citation (the event-bus *domain* list, which must not be overloaded to mean ops subscriptions); the `checkEvents` turn-spawning fan-out D10 declines to reuse; the "closed 13-type schema"; and `system:task_blocked` carrying `{taskId, description, blockedBy}` and no run, thread, tool or context.

- [ ] **Step 6:** Anchor A7 — the boot-order surfaces D10 and D12 bind the consuming children to.

Run:
```bash
grep -n 'Spawn-capable boundary' src/index.ts
grep -n '(c) no unallowlisted spawn-capable start precedes the wiring' src/boot-order.test.ts
```
Expected: one hit each — the marker in `src/index.ts` (around line 474) and the superset-sweep test in `src/boot-order.test.ts` (around line 84). Line numbers may move; presence is the assertion.

- [ ] **Step 7:** Record the results. Write down, for each of A1–A7, `verified` or `drifted: <what moved or changed>`. This list is the input to Task 2's anchor table. Do not commit anything in this task — Task 1 produces a finding, not a file change.

If any anchor is `drifted`, apply the Verification Rules bullet above before continuing: a moved line is recorded; a changed *fact* that invalidates a conformance criterion or an evidence-table claim is a demotion to the spec lane, reported as a concrete blocker.

---

### Task 2: Append the post-signoff addendum to the contract

**Files:**
- Modify: `docs/epics/kpr-451/kpr-458-design.md` (append after line 476; nothing at or before 476 changes)
- Create: none
- Test: none

- [ ] **Step 1:** Capture the pre-edit state of the signed-off body, so step 6 can prove it unchanged.

Run:
```bash
git -C "$PWD" status --porcelain
wc -l docs/epics/kpr-451/kpr-458-design.md
shasum -a 256 <(sed -n '1,476p' docs/epics/kpr-451/kpr-458-design.md)
```
Expected: clean tree (no output from `status --porcelain`), `476 docs/epics/kpr-451/kpr-458-design.md`, and a sha256 you write down for step 6.

- [ ] **Step 2:** Append the addendum. Use a quoted heredoc (`<<'ADDENDUM_EOF'`) so nothing in the payload is expanded, which is the repo's known-good append mechanism under the Write hook's exec-pattern flagging.

Replace the four `<...>` placeholders in subsection A.3 with Task 1's recorded results before running. Everything else is literal.

```bash
cat >> docs/epics/kpr-451/kpr-458-design.md <<'ADDENDUM_EOF'

---

## Post-signoff addendum (2026-09-08)

*Everything above this line is the artifact signed off at [KPR-458#comment-3f6e8a4a](https://linear.app/keepur/issue/KPR-458#comment-3f6e8a4a), committed at `3aa6d06`. Nothing above is edited. This addendum corrects by supersession, following the `docs/epics/kpr-415/kpr-417-spec.md` §12/§13 precedent: a body claim that later becomes false is superseded here and left standing there, so the signoff stays attached to a document that still exists.*

### A.1 Scoping resolved: both unowned components now have owners

The body states, in six places, that two components this contract requires are chartered to no child, and closes by naming that as an open epic-level scoping item "blocking for implementation, not for this contract". **That item is closed.** The operator resolved it in the epic driver session immediately after spec review closed, recorded at [KPR-455#comment-1b79ee1a](https://linear.app/keepur/issue/KPR-455#comment-1b79ee1a):

| Component | Body reference | Owner |
| --- | --- | --- |
| The matcher–deliverer: ledger upsert and renewal, calling the adapter, the nudge sweep, snooze expiry, clearing application, and acknowledgement intake | D12 | **KPR-468** — *Notifier — deliver, nudge, clear and accept acknowledgements over the ops-event ledger*, a new child filed for exactly this scope. Blocked by KPR-454 and KPR-458. |
| The inbound acknowledgement edge: capturing an attributed act and handing it to intake as `(handle, act, actorId, at, snoozedUntil?)` | D6 | **KPR-455** — the reader, widened to carry it. |

Three things the body says about these that the resolution does **not** change, and that both owners inherit unaltered:

1. **Match evaluation is not KPR-468's.** It is pure, performs no I/O, and is stamped into the immutable publish insert as `matchedSubscriptionIds` on the accept path (D2, D12, C2). It ships with publishing — by the epic's list, **KPR-454** — together with the `ops_events` / `ops_subscriptions` initialization, their indexes, the loaded subscription set, and the above-the-boundary wiring D10 requires for all of it. A plan writer parcelling D12 to KPR-468 must not carry the matcher across with it.
2. **The sequencing constraint stands.** D12's closing paragraph: the matcher–deliverer must not ship without the inbound edge, because notifications would go out and no acknowledgement could ever come back. With the split above, that reads: **KPR-468 must not ship without KPR-455's inbound edge.** The blocking edge KPR-468 already carries on KPR-454 does not express this one; it is stated here and belongs in KPR-468's own body.
3. **A producer shipped alone is still staged, not broken.** KPR-454 alone accumulates durable events with a truthfully stamped `matchedSubscriptions: 0` and a queryable log while no notification exists. That remains the honest interim, and it remains D11's third column — subscription rows, transport bindings, cadence values, the nudge floor, staleness horizons, retention values — that gates anything becoming visible. This ticket ships zero rows of it.

### A.2 Supersession map

Each location below reads, at `3aa6d06`, as though ownership is open. Each is superseded by A.1 and is otherwise unchanged; the surrounding obligations, which are the load-bearing content, all stand.

| Line(s) at `3aa6d06` | Body text superseded | Now reads as |
| --- | --- | --- |
| 5 | TL;DR: "Two components this contract requires are chartered to **no child**… neither is assigned" | Both assigned; see A.1. |
| 10 | Key Points: "⚠ Unowned, blocking for implementation: the matcher–deliverer (D12)" | Owned by KPR-468. The ⚠ marker no longer applies; the exhaustive obligation list in that bullet does. |
| 11 | Key Points: "⚠ Unowned: the inbound acknowledgement edge (D6)" | Owned by KPR-455. |
| 33 | Scope and authority: "plan for a document, a Gate-1 conversation, and the two scoping decisions named below" | The two scoping decisions are made; the document and the Gate-1 conversation remain this ticket's work. |
| 35 | Scope and authority: "this document assigns neither… that is a scoping decision for the epic driver with the operator" | The driver made it with the operator. The paragraph's statement of *what* is unowned remains an accurate statement of the two obligation sets. |
| 260, 267 | D6: "owned by nobody"; "No child in the epic's list is chartered for this" | KPR-455. D6's four obligations on the edge — translate-only, no ledger or subscription access, attribute-or-refuse, idempotency/legality belong to intake — are unchanged and bind KPR-455. |
| 377 | D11 table row: "Each carrying surface's own inbound edge — **⚠ chartered to no child**" | Chartered to KPR-455 for the surfaces it carries; the row's third column (which surfaces expose one) stays operator-registered data. |
| 386, 412 | D12 heading "ownership open"; "Ownership is open, and this document does not close it — for two items, not one" | Closed, for both items, per A.1. D12's exhaustive "what it owns" list is unchanged and is KPR-468's scope statement. |
| 475 | Assumptions: "Open, epic-level scoping (blocking for implementation, not for this contract) — two items, not one" | Resolved. Reclassify as closed. |

Nothing else in the body is superseded. In particular the four operator rulings (D1), the three vocabularies (D3), the filter grammar (D5), the transport interface and its two closed reason sets (D6), the ledger transition table (D7), the retention posture (D9), the boundaries against `agent_events` / KPR-456 / KPR-457 (D10), the three-column split (D11), and C1–C19 stand exactly as signed off.

### A.3 Runtime-anchor verification record

The contract's evidence table, D3, D10 and C6/C12 cite live source by file and line. Re-verified against `epic/kpr-451` at the commit that lands this addendum:

| # | Anchor | Claim it supports | Result |
| --- | --- | --- | --- |
| A1 | `src/outage/outage-notices.ts:18-26` | D3's `policyFor` → `waiting` mapping; the stale "team DM" fallthrough comment; C6 | <A1> |
| A2 | `src/agents/provider-adapters/turn-scaffold.ts:353` | literal `costUsd: 0` in the shared Lane B result builder; C12 | <A2> |
| A3 | `src/agents/agent-manager.ts:2611-2612` | sparse `aborted` / `timedOut` flags (KPR-401) | <A3> |
| A4 | `src/types/agent-definition.ts:65` | `subscribe?: string[]` is the event-bus domain list, not an ops subscription | <A4> |
| A5 | `src/scheduler/scheduler.ts:322` | `checkEvents` turns a pending delivery into a turn-spawning `WorkItem` | <A5> |
| A6 | `src/events/event-types.ts` | closed 13-type schema; `system:task_blocked` carries `{taskId, description, blockedBy}` | <A6> |
| A7 | `src/index.ts` spawn-capable boundary marker; `src/boot-order.test.ts` superset sweep | D10's and D12's boot-order obligations on the consuming children | <A7> |

The counts in "Problem and observed evidence" are deliberately **not** re-run: that table states its own window rule — *"The window slides, so absolute counts move between runs while the ratios hold… Cite the ratio and the date, never the bare count."* The 2026-09-08 measurement stands as recorded.

### A.4 Canon — entries KPR-458 contributes to the KPR-451 Decision Register

Drafted here so the driver can lift them verbatim at merge, in the register's existing one-line declarative style, following `docs/epics/kpr-415/kpr-417-spec.md` §12's precedent. They contradict no merged entry from KPR-453, KPR-456 or KPR-457.

* KPR-458: Operational facts publish without recipient, destination, transport, owner, or severity; no severity axis exists and none may be added.
* KPR-458: Interest lives only in subscriber-owned subscription rows; no default subscription, fallback recipient, or catch-all adapter, and `matchedSubscriptions: 0` stays reachable as the measured gap.
* KPR-458: `class` and `retry` are registry-declared per `(producer, reasonId)` and stamped at accept; only `waiting` is per-publish, derived for the runtime from one prefix table shared with `policyFor`.
* KPR-458: An unknown `(producer, reasonId)`, an undeclared `detail` key, an over-bound value, or a non-scalar rejects the publish and is counted; redaction is the write-time schema, never a scrub-after pass.
* KPR-458: Notification identity is `(subscriptionId, dedupeKey)`; `generation` advances only on recurrence after a published class-legal clearing fact, never on repetition, retry, elapsed time, or an unanswered nudge.
* KPR-458: Match evaluation is pure, rides the immutable publish insert as `matchedSubscriptionIds`, and is never re-evaluated downstream; everything after the insert runs on a bounded non-overlapping sweep off the turn path.
* KPR-458: Transitions to `seen`/`dismissed`/`snoozed` require an attributed act through idempotent intake; every other transition records the reserved system principal, `integrity` refuses dismissal, and no bulk path exists.
* KPR-458: Nudging has no terminal state; snooze is the only pause, and intake clamps it to the operator-set maximum rather than refusing the act.
* KPR-458: Transport is an adapter returning accepted/rejected/unknown; only allow-listed `rejected` retries, the ops path never publishes about itself, and no delivery may synchronously spawn an agent turn.
* KPR-458: Derived views return `unknown` past a required staleness horizon; failure is never inferred from `activity_log.error`, `costUsd`, or duration. `agent_events`, KPR-456's obligation path and KPR-457's watchdog keep their own contracts and become no part of this interface.

### A.5 What this ticket did not ship

Restating D11's third column and D1's collection rule as a checklist, because the next reader's most likely error is assuming a merged contract means a live surface. KPR-458 ships **no** code, collection, index, validator, reason-registry row, subscription row, transport binding, cadence value, nudge floor, staleness horizon, or retention value. `ops_events` and `ops_subscriptions` are created and documented in `CLAUDE.md` by KPR-454; `ops_notifications` by KPR-468. Until D11's third column is registered by the operator, a conforming deployment records every publish, delivers none, holds no ledger row, and measures how much nobody has claimed.
ADDENDUM_EOF
```

- [ ] **Step 3:** Fill the anchor table. Replace `<A1>` … `<A7>` with Task 1's recorded results — `verified`, or `drifted: <what moved>`. Do this with an editor or targeted `sed`; do not re-run the heredoc.

- [ ] **Step 4:** Read the appended section back in full and check it against the body it supersedes. Specifically confirm: every line number in A.2 still points at the text it quotes; A.1's statement that match evaluation stays with KPR-454 matches D12's own split; A.4 contains no cadence value, recipient, severity, or registry row.

Run:
```bash
sed -n '477,$p' docs/epics/kpr-451/kpr-458-design.md
sed -n '5p;10p;11p;33p;35p;260p;267p;377p;386p;412p;475p' docs/epics/kpr-451/kpr-458-design.md | cut -c1-110
```
Expected: the addendum renders as written, and each of the eleven sampled lines begins with the text A.2's table quotes.

- [ ] **Step 5:** Check the canon lines against the merged register. Read the KPR-451 Decision Register (epic body, `## Decision Register — Canon`) and confirm no KPR-458 line contradicts a KPR-453, KPR-456 or KPR-457 entry. The three known adjacencies and why each is compatible: KPR-453's "identity proves neither unique attempt nor task continuity" is what D2's dedupe rule is built on, not against; KPR-456's obligation contract is preserved verbatim by D10 and its sweep becomes a future *producer*, not a redirect; KPR-457's watchdog independence is preserved by D10, which forbids making it an adapter. If a genuine contradiction appears, that is a spec-lane demotion, not an edit.

- [ ] **Step 6:** Verify the append-only invariant and the diff scope.

Run:
```bash
git -C "$PWD" diff --stat
shasum -a 256 <(sed -n '1,476p' docs/epics/kpr-451/kpr-458-design.md)
git -C "$PWD" diff --numstat -- docs/epics/kpr-451/kpr-458-design.md
```
Expected: exactly one file in `--stat`, `docs/epics/kpr-451/kpr-458-design.md`; the sha256 identical to step 1's; `--numstat` showing `<N>	0	docs/epics/kpr-451/kpr-458-design.md` — insertions only, **zero deletions**. A nonzero deletion count means the body was edited and must be reverted.

- [ ] **Step 7:** Run the repo gate once.

Run:
```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: pass, unchanged. This touches no file this ticket modified; a failure is a pre-existing tree problem to report, not to fix here.

- [ ] **Step 8:** Commit.

```bash
git add docs/epics/kpr-451/kpr-458-design.md
git commit -m "docs(KPR-458): record scoping resolution, anchor verification and canon

Append-only post-signoff addendum. The signed-off body (lines 1-476) is
byte-identical; the two components it describes as chartered to no child
now have owners — the matcher-deliverer to KPR-468, the inbound
acknowledgement edge to KPR-455 — and the sequencing constraint that
KPR-468 must not ship without KPR-455's edge is stated in ticket terms.
Adds the runtime-anchor verification record and the canon lines the
driver lifts into the KPR-451 Decision Register.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The Gate-1 conversation and sibling pointers

**Files:** none. This task changes PM state only, and is performed by the epic driver or the operator, not by an implementation subagent. It does not gate the epic-branch push of Tasks 1–2.

- [ ] **Step 1:** Put the `needs-human-spec` question to the operator, in these terms and no broader. The spec is explicit that a draft does not close that gate and that it does not claim to; it is equally explicit about what the gate covers: *"What the four rulings settle is the **structure**… What remains human policy is **content**: which reasons exist, who subscribes to what, and at what cadence."* The question is therefore:

> KPR-458's contract is signed off and its structure is settled by your four rulings. The content half — reason rows, subscription rows, cadence values, the nudge floor, staleness horizons, retention values — is D11's third column, which this ticket ships none of and which is registered per-deployment rather than per-ticket. Does the signoff at KPR-458#comment-3f6e8a4a close `needs-human-spec` for this ticket, with the content half tracked as a deployment gate on KPR-454/KPR-468 instead? Four assumptions in the spec are marked ⚠ Delegated and non-blocking and would ride along with a yes: `(subscriptionId, dedupeKey)` notification identity, registry-declared `class`/`retry`, the D9 retention posture (a privacy call, not an engineering one), and retaining the reason registry rather than simplifying it away.

Remove the label only on an explicit yes. A no returns the ticket to the spec lane with the operator's scope for the remaining conversation; it does not reopen the four-round-clean review.

- [ ] **Step 2:** Post a pointer comment on **KPR-454** naming the contract path and the obligations it inherits:

> KPR-458's contract is at `docs/epics/kpr-451/kpr-458-design.md` on `epic/kpr-451`. As the producer you own the whole accept path, which is more than the publish call: match evaluation (pure, no I/O), the `matchedSubscriptionIds` + `matchedSubscriptions` stamp into the one immutable insert, the `ops_events` and `ops_subscriptions` collections, their indexes and `CLAUDE.md` entries, the loaded subscription set, and `hive-runtime`'s own reason-registry rows including its clearing reason. Engine obligations in D10: wire above `index.ts`'s spawn-capable boundary with anchors in all three lists of `src/boot-order.test.ts`; contain every publish fault so it can never fail, delay or alter a turn (C15); co-locate `waitingFor` with `policyFor` sharing one prefix table (C6) — and read that prefix table, not its stale "team DM" comment. Your conformance criteria are C1–C6, C12–C16, C18, C19.

- [ ] **Step 3:** Post a pointer comment on **KPR-455**:

> KPR-458's contract is at `docs/epics/kpr-451/kpr-458-design.md` on `epic/kpr-451`. Beyond the reader, you now own D6's inbound acknowledgement edge (assigned at KPR-455#comment-1b79ee1a). Its obligations are fixed: convert one vendor-specific act into one intake call `(handle, act, actorId, at, snoozedUntil?)` and nothing else; never read or write the ledger or `ops_subscriptions`; hold no state; attribute or refuse — a read receipt, a channel visit, a reaction or elapsed time is not an act, and an act you cannot tie to a stable actor id is refused rather than attributed to a service principal. Idempotency, class legality and state legality are intake's job (KPR-468), not yours. As a reader: `unknown` transport outcomes surface as uncertainty, never as notified (C8); derived views return `unknown` past their staleness horizon (C11); never infer failure from `activity_log.error`, `costUsd` or duration (C12) — the negative test is in the evidence table.

- [ ] **Step 4:** Post a pointer comment on **KPR-468**:

> KPR-458's contract is at `docs/epics/kpr-451/kpr-458-design.md` on `epic/kpr-451`; D12 is your scope statement and its "what it owns" list is exhaustive — ledger creation and D7-rule-4 renewal driven by the event's stamped `matchedSubscriptionIds`, calling `deliver` and recording the outcome, the nudge sweep and snooze expiry, clearing application after its D8 provenance test, acknowledgement intake, and counting your own faults. **Match evaluation is not yours** — it rides the publish insert with KPR-454. Two hard constraints: you are blocked by KPR-454, and per D12's closing paragraph you must not ship without KPR-455's inbound edge, or notifications go out with no acknowledgement able to come back. Boot order: `ops_notifications` and the sweep get their own anchors in all three lists of `src/boot-order.test.ts`; the sweep starts *after* transport adapters are registered (the `workerPool.start()` precedent) and drains *before* Slack and Mongo on shutdown (the KPR-456 ordering). Your conformance criteria are C8–C10, C14, C17.

- [ ] **Step 5:** Confirm KPR-468's blocking edges in the tracker: blocked by KPR-454 **and** KPR-458, plus the A.1 sequencing constraint against KPR-455 recorded in its body (a "must not ship without" note, whether or not the tracker models it as a second blocker).

---

## Execution Handoff

**"Plan saved to `docs/epics/kpr-451/kpr-458-plan.md`. Ready to execute?"**

Tasks 1 and 2 are one implementation lane and produce one commit on the epic branch. Task 3 is driver/operator PM work and can run in parallel or after; Step 1 of it is the only step in this plan that requires a human answer, and the ticket does not close without it.
