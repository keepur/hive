# KPR-452 audit mirror routing implementation plan

> **For agentic workers:** Execute this plan through the KPR-451 child delivery lane (dodi-dev:drive-epic and its implementation lane), per the epic's recorded workflow override.

**Goal:** Make `postAuditLog` consult `policyFor()` through one pure predicate, route every surviving copy to a single runtime-configurable audit channel instead of each agent's homeBase, and contain the whole audit path so it can never fail an already-delivered turn.

**Architecture:** A new leaf module `src/audit/audit-routing.ts` owns the pure copy decision, the `instance_settings` override document shape, a runtime `AuditRoutingControl` factory, and a module-global accessor pair. The Dispatcher stores the audit channel *name* and resolves it lazily — single-flight, rate-limited, one page — behind a try/catch that swallows every fault. `index.ts` wires the control above the spawn-capable boundary and keeps `setAuditChannel` at its Slack-dependent site. Two new admin MCP tools drive the control; the admin server imports only the accessor, never the Dispatcher.

**Tech Stack:** Existing TypeScript (strict), Node 24, MongoDB driver, `@slack/web-api`, Claude Agent SDK in-process MCP servers, Vitest. No runtime dependency addition.

**Approved input:** [KPR-452 design](kpr-452-design.md) — clean after three review rounds (20 findings applied, none declined) plus explicit human signoff. Worktree `/Users/mokie/github/hive-kpr-452-mature`, branch `claude/kpr-452-mature`, based on `epic/kpr-451` at `328c668`. Binding canon: the [KPR-451 Decision Register](https://linear.app/keepur/issue/KPR-451#comment-617e55a6) as extended by the KPR-456 and KPR-457 verdicts — in particular KPR-456's "no default recipient, severity, escalation or new policy dependency" rule (which binds D2/D5) and KPR-453's "runtime identity available in a handler does not authorize a new persisted field" rule (which binds the `instance_settings` document shape). KPR-452 has no sibling dependency and must not acquire one.

**Execution boundary:** This plan drafts artifacts only. It does not implement, push, edit PM state, deploy, create a Slack channel, or change any agent definition. Drafting makes no runtime success claim; child readiness and delivery remain dispatcher-owned.

## Review chunks and file structure

Read this main plan and all four numbered chunks as one plan. Each file is below 1,000 lines. Code fences contain complete new-file payloads or exact insertion/replacement blocks. Apply normal repository formatting; do not treat formatting changes as design changes.

| Chunk | Plan file | Tasks | Responsibility |
| --- | --- | --- | --- |
| 1 | [Routing leaf](kpr-452-plan-1-routing-leaf.md) | 1–2 | Pure decision, override document, control factory, accessor pair, unit tests |
| 2 | [Dispatcher and boot](kpr-452-plan-2-dispatcher-boot.md) | 3–4 | Dispatcher rewrite, containment, lazy resolver, `index.ts` wiring, boot-order anchors |
| 3 | [Dispatch-path tests](kpr-452-plan-3-dispatch-tests.md) | 5–6 | Single-dispatch, voice and fan-out call sites; destination, suppression, refresh, containment |
| 4 | [Tools and gate](kpr-452-plan-4-tools-and-gate.md) | 7–8 | Two admin MCP tools, CLAUDE.md, AC11 inspection, `npm run check` |

### Files to create

- `src/audit/audit-routing.ts` — `auditCopyDecision`, `AUDIT_ROUTING_DOC_ID`, `AuditRoutingDoc`, `AuditRoutingControl` + `createAuditRoutingControl`, `setAuditRoutingControl`/`getAuditRoutingControl`. Leaf: imports only the WorkItem types, `policyFor` and the Mongo `Collection` type.
- `src/audit/audit-routing.test.ts` — unit tests for all four exports.

### Files to modify

- `src/channels/dispatcher.ts` — audit fields; `setAuditChannel` loses its third parameter; new `setAuditChannelName` / `getAuditChannelName` / `peekAuditChannelId` / `auditRoutingReady` / `resolveAuditChannelIdFully`; private `resolveAuditChannelId` + single-flight `refreshAuditChannelIds`; `postAuditLog` rewritten and contained; three call-site guards reduced.
- `src/index.ts` — rename `fallbackAuditId` → `retentionReportChannelId`; wrapped `instance_settings` read + `setAuditChannelName` + `setAuditRoutingControl` above the spawn-capable boundary; two-arg `setAuditChannel` at its existing site; boot log fields.
- `src/admin/admin-mcp-server.ts` — import the accessor; add `audit_channel_get` and `audit_channel_set`.
- `src/boot-order.test.ts` — `setAuditRoutingControl(` added to all three lists (presence, order, superset-sweep bound).
- `src/channels/dispatcher.test.ts` — replace the `per-agent audit routing` describe block.
- `src/channels/dispatcher-conference.test.ts` — widen the hoisted logger mock so `warn` is observable, then add the fan-out audit describe block.
- `src/admin/admin-mcp-server.test.ts` — add the audit-channel-tools describe block.
- `CLAUDE.md` — engine-written collections list gains `instance_settings`; the admin MCP bullet gains the two tools.

### Deliberately not changed

`src/scheduler/scheduler.ts`, `src/workers/meeting-worker-pool.ts`, `src/outage/*`, `src/channels/slack-adapter.ts`, `src/channels/deadline-continuation.ts`, `src/retention/*`, `src/config.ts`, `src/agents/agent-runner.ts`. No new config key ships — rollback for the routing behavior is a code revert (spec §Rollback); only the channel *name* is configurable.

Before editing any implementation file, run `git rev-parse HEAD` in this worktree and record the full SHA in the child delivery handoff as `implementation-base`. Chunk 4 Task 8 substitutes it for `<implementation-base>`; retain it across sessions and intermediate commits, and do not recompute it from the later HEAD.

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `auditCopyDecision` (the pure D2 rules 2–3 leaf), `createAuditRoutingControl` (validation, persistence, precedence, clear, not-ready), the `setAuditRoutingControl`/`getAuditRoutingControl` accessor pair, and the `audit_channel_set` normalization/rejection ladder inside the admin tool.
  - Reason: the copy predicate is the entire behavior change and is decidable from `(item, auditAdapterKind)` alone; a callback-prefix or worker-prefix regression is invisible in an integration test that happens to use Slack-sourced fixtures. The control's reject-without-persist contract (AC9) is a negative-write assertion that needs a fake collection.
  - Minimum assertions: `team-`/`event:` internal items → `post: true, reason: "post"`; any item whose `source.kind` equals the audit adapter kind → `post: false, reason: "same-kind"`, **including** a `sched:` cron item, a Slack-sourced `callback:` item and a Slack `worker:` re-entry item; a `sched:` item on a non-Slack kind → `post: false, reason: "policy-skip"`; `callback:` and `worker:` items on `sms`/`voice`/`imessage` → `post: true`; `voice`, `team`, `app`, `sms` notify-class items → `post: true`; rule 2 keys on the adapter's kind, not the literal `"slack"`. Control: `set("ops-audit")` resolves, seeds, persists exactly `{_id, channelName, updatedAt, updatedBy}` with `updatedBy` equal to the calling agent id and **no** turn-identity field, and calls `setAuditChannelName`; an unresolvable name persists **nothing** and applies nothing; `set("")` deletes the document and reverts the effective name to `config.slack.auditChannel`, or turns the mirror OFF when that is empty; `describe()` reports `runtime override` / `hive.yaml` / `unset`, the resolve state, the override author, and the homeBase advisory; both methods report not-ready before wiring completes and issue no Slack call. Accessor: set → get round-trip, `undefined` clears. Tool: a raw Slack id and a syntactically invalid name are rejected **without calling `control.set`**; whitespace and a leading `#` normalize; an empty/blank string reaches the control as `""`; a missing control and a throwing control both become honest tool errors, never a throw.

- Integration: **required**
  - Scope: `Dispatcher.dispatch` (single-agent site), `Dispatcher.routeVoiceTurn` (voice site), the conference fan-out site, the lazy channel resolver against a fake Slack `WebClient`, and `src/boot-order.test.ts`'s text scan of `index.ts`.
  - Reason: the destination, the dropped thread metadata, the containment guarantee and the single-flight refresh are properties of the Dispatcher's real dispatch path with its real `try`/`handleTurnFailure` frame — a unit test of the predicate cannot show that a rejecting `conversations.list` leaves the turn's delivery standing.
  - Harness: **existing** — `src/channels/dispatcher.test.ts`, `src/channels/dispatcher-conference.test.ts`, `src/admin/admin-mcp-server.test.ts`, `src/boot-order.test.ts`. No new harness. Mock adapters, mock registry and mock agent manager already exist in each file.
  - Minimum assertions: an `internal` `team-` item and an `internal` `event:` item each produce exactly one audit copy addressed to the configured audit channel id at all three call sites, and never to `agent-<id>`; a `sched:` item on a non-Slack kind produces none; a Slack-sourced item (human, cron, slack-sourced callback) produces none and its own delivery is byte-identical to the pre-change output — same adapter, same `WorkItem` object identity, same text, thread metadata intact; a `callback:`-id item on `sms` produces one; `voice` and `team`(ws) items produce one each and a rejected audit post never fails the voice turn; with no configured name nothing is posted and one warn is logged **even though the handling agent's homeBase resolves in the channel map**; audit copies carry no `slackThreadTs`/`slackTs`; a runtime `setAuditChannelName` repoints the very next audit post; `conversations.list` fires at most once per 60 s, follows no cursor, is skipped when the Slack adapter is unset, and is issued exactly once under a three-way concurrent race; with `conversations.list` rejecting and, separately, with `auditAdapter.deliver` rejecting, both awaited sites complete with the turn's delivery intact, one warn, no `Something went wrong` notice and no `outage_queue` enqueue — each of the four rows arranged so the fault is genuinely reachable and the absence assertions are genuinely observable (delivery adapter ≠ audit adapter; a resolving channel name on the deliver-rejection rows); `setAuditRoutingControl(` precedes every named spawn-capable surface in `index.ts`.

- E2E: **not-required**
  - Scope: a live Slack workspace, live production MongoDB, and a running hive instance.
  - Reason: every behavior in scope is deterministic given a fake Slack client and a fake collection. A live run would add workspace state and network nondeterminism without exercising a different code path, and the two genuinely live conditions this change creates (the deploy-time channel choice and its membership) are operator facts the engine cannot check and a test cannot assert.
  - Harness: **not-applicable**.
  - Minimum assertions: none; no assertion is waived from the required integration group. The spec's post-deploy `activity_log` distribution re-run is an operator step recorded below, not a test.

### Critical Flows

- `WorkItem` → `dispatchToAgent` delivery `else` arm → `deliverAgentResult` → `postAuditLog` → `auditCopyDecision` → `resolveAuditChannelId` → `auditAdapter.deliver` into the configured channel.
- `routeVoiceTurn` → fire-and-forget `postAuditLog`, with the voice turn's own result unaffected by any audit fault.
- Conference fan-out → `postAuditLog` on `effectiveItem`, awaited inside the `try` whose `catch` is `handleTurnFailure`.
- `audit_channel_set` → tool normalization → `control.set` → full `conversations.list` pagination → seed `auditChannelIds` → persist `instance_settings/audit_routing` → `setAuditChannelName` → next audit post lands in the new channel with no restart and no SIGUSR1.
- Boot: `instance_settings` read (wrapped) → `setAuditChannelName` → `setAuditRoutingControl`, all above the spawn-capable boundary; `setAuditChannel(adapter, map)` below it, at the Slack-dependent site; a turn landing between the two sees `auditAdapter` unset and returns at D2 rule 1.
- Unresolvable or unconfigured channel → no copy, one warn, no fallback to homeBase or any other destination.

### Regression Surface

- Every intended delivery. `deliverAgentResult`, `handleTurnFailure`, `deliverOutageNotice` and the retry queue are untouched, and a Slack-sourced turn's delivered payload must be byte-identical.
- The `isNonResponse` and `killedReaction` sibling arms at `dispatcher.ts:487-501`: they deliver nothing today and must gain no audit copy — the call keeps its **position**, not merely its predicate.
- KPR-307 honest outage: `outage_queue` enqueue, replay and the post-turn fault gate must not observe audit faults.
- KPR-402 deadline continuation and KPR-416/420 `markReactionExclusion`: the audit call sits after both; their ordering pins must survive.
- `RetentionSweeper.report` must still post to the boot-resolved `config.slack.auditChannel` id (AC11).
- `src/boot-order.test.ts`'s three existing anchor lists and its KPR-456 lifecycle describe block.
- The `admin` server's existing tool set and its Lane B stdio placeholder in `buildToolTransportInventory` — two new tools on an existing server need no KPR-390 inventory compensation.
- The conference suite's KPR-416/417/420 tracker and ack blocks, which share the fan-out code path.

### Commands

Run every command from `/Users/mokie/github/hive-kpr-452-mature` on **Node 24** — the default shell Node is not the verification runtime, so `node -v` must print `v24.*`. Test commands need the repo's env stubs because `src/config.ts` throws on missing Slack env at import.

- Setup: `node -v`; `npm ci` if this worktree lacks `node_modules`.
- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/audit/audit-routing.test.ts src/admin/admin-mcp-server.test.ts`
- Integration: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts src/boot-order.test.ts`
- E2E: not applicable; no live account or service command.
- Focused adjacent regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-replay-processor.test.ts src/channels/deadline-continuation.test.ts src/sweeper/retry-queue.test.ts src/config.test.ts`
- Typecheck while iterating: `npm run typecheck`
- Code hygiene: `git diff --check <implementation-base>`; `grep -n "auditAdapter.kind" src/channels/dispatcher.ts` (must return exactly one hit)
- Broader regression and submission gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

Expected for each Vitest command: exit 0, all selected tests pass, no skipped KPR-452 cases. Expected for `npm run typecheck`: exit 0, no diagnostics. Expected for `npm run check`: typecheck, lint, format check and the full suite each exit 0; pre-existing lint warnings are not a new pass/fail policy. Record actual totals; do not invent expected test counts.

### Harness Requirements

- Node 24; dependency installation from the existing lockfile. A missing install is setup, not a skip reason.
- The three `SLACK_*=test` env stubs on every Vitest and `npm run check` invocation (`CLAUDE.md` → "npm run check env stubs").
- No Slack credentials, no MongoDB, no Qdrant, no running hive service, no provider credentials. Every Slack call is a `vi.fn()` on a fake `client.conversations.list`; every Mongo call is a fake collection defined in the test file.
- The 60-second refresh window is driven by `vi.spyOn(Date, "now")` over a mutable counter — never the real wall clock. Restore with `vi.restoreAllMocks()` in `afterEach`.
- ⚠ Every assertion about the **voice** site's audit effects must be wrapped in `await vi.waitFor(...)`. That site is fire-and-forget: `routeVoiceTurn` resolves without awaiting `postAuditLog`, which now takes at least one await (`resolveAuditChannelId`) before `deliver` and another before its `catch`, so a bare assertion on the deliver-rejection warn evaluates a microtask too early and fails deterministically. `vi.waitFor` does not depend on the `Date.now` spy above (it schedules on real timers), so the two coexist.
- Reuse the existing helpers in their owning files: `makeWorkItem`, `makeMockRegistry`, `makeMockAgentManager`, `makeMockAdapter`, `makeMockHealthReporter`, `mockLogInfo`, `mockLogWarn` (`dispatcher.test.ts`); the same set plus the conference fixtures (`dispatcher-conference.test.ts` — which hoists `mockLogInfo` only today, so Chunk 3 Task 6 Step 1 widens its logger mock to expose `warn` before the fan-out block can assert on it); `makeTools`, `getHandler`, `makeFakeDb` (`admin-mcp-server.test.ts`).
- `src/audit/audit-routing.test.ts` is a new file following the repo's `src/**/*.test.ts` beside-source convention. It needs no mocks beyond plain object literals and `vi.fn()`.
- ⚠ Any test that installs the module-global control **must** clear it with `setAuditRoutingControl(undefined)` in `afterEach` — the accessor is process-wide and leaks across test files otherwise.

### Non-Required Rationale

- E2E: no live Slack/Mongo/hive dependency exercises a distinct code path, and the two live conditions this change creates are deploy-time operator facts rather than engine behavior. All critical internal flows are covered by integration tests over real Dispatcher code.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Run the targeted command for each task as that task lands, then one full `npm run check` before submission. No completion, commit or PR claim before `dodi-dev:verify` obtains fresh evidence for the relevant command.
- AC12 must be **negative-verified**: temporarily move the `setAuditRoutingControl(` call below the boundary marker, confirm `src/boot-order.test.ts` fails, then restore and re-run. Record both outcomes.
- AC11 is verified by **inspection plus `npm run check`**, not a runtime test — `RetentionSweeper.report`'s closure is inline in `index.ts` with no seam. A change that deletes the renamed local fails here.
- No live Slack posts, no production channel creation, no agent-definition edit, and no deploy during implementation.
- A clean review of every chunk and the final dependency check are required before `ready-to-implement`.

## Task order and commits

1. Chunk 1, Task 1 — create the leaf module; typecheck.
2. Chunk 1, Task 2 — create its unit test; run the Unit command; **commit Tasks 1–2 together**.
3. Chunk 2, Tasks 3–4 — Dispatcher rewrite and `index.ts` wiring. These are one compile unit (`setAuditChannel` drops a parameter in Task 3, `index.ts:661` is fixed in Task 4) and **one commit**. Run typecheck, the boot-order test, and the AC12 negative-verify. This commit deliberately leaves `src/channels/dispatcher.test.ts` red — its `:1096`/`:1117`/`:1135` three-arg `setAuditChannel` calls are inside the block Task 5 replaces, and `tsconfig.json` excludes test files so typecheck stays clean. Do not run the Integration command as a gate here, and do not patch those three call sites in this commit.
4. Chunk 3, Task 5 — replace the dispatcher audit test block; run the Integration command; commit.
5. Chunk 3, Task 6 — fan-out coverage; run the conference file; commit.
6. Chunk 4, Task 7 — the two admin tools plus their tests; run the Unit command; commit.
7. Chunk 4, Task 8 — CLAUDE.md, AC11/AC13 inspection, diff review, `npm run check`; commit.

Do not parallelize: Tasks 3–4 change the same compile unit, and Tasks 5–6 assert against the code Tasks 3–4 produce.

## Acceptance-criteria coverage map

| AC | Where it is proved |
| --- | --- |
| 1 | `audit-routing.test.ts` (predicate) + `dispatcher.test.ts` AC1 pair and the never-to-homeBase case (single site) + `dispatcher.test.ts` AC5 voice case + `dispatcher-conference.test.ts` AC1 (fan-out) |
| 2 | `audit-routing.test.ts` policy-skip case + `dispatcher.test.ts` AC2 |
| 3 | `audit-routing.test.ts` same-kind table + `dispatcher.test.ts` AC3 (explicit, three rows, with a byte-identical delivery assertion) |
| 4 | `audit-routing.test.ts` callback/worker rows + `dispatcher.test.ts` AC4 |
| 5 | `audit-routing.test.ts` notify rows + `dispatcher.test.ts` AC5 ws case and AC5 voice case, incl. a rejected audit post that does not fail the voice turn |
| 6 | `dispatcher.test.ts` AC6 — the homeBase entry is present in the map and still unused; one warn; no refresh attempted |
| 7 | `dispatcher.test.ts` AC7 + `dispatcher-conference.test.ts` AC1 (per-copy meta assertions) |
| 8 | `audit-routing.test.ts` AC8 (persist + `updatedBy` + no turn identity + `describe` round-trip) + `dispatcher.test.ts` AC8 (next post repoints, no restart) |
| 9 | `audit-routing.test.ts` AC9 trio + `admin-mcp-server.test.ts` rejection ladder (control not called) |
| 10 | `dispatcher.test.ts` AC10 trio — one page / no cursor / 60 s floor, concurrent race → one call, unset adapter → no call |
| 11 | Chunk 4 Task 8 Step 3 inspection + `npm run check` |
| 12 | `boot-order.test.ts` three-list anchor + Chunk 2 Task 4 Step 7 negative-verify |
| 13 | `dispatcher.test.ts` AC13 pair (single-dispatch site) + `dispatcher-conference.test.ts` AC13 pair (fan-out site) — both assert the absence of the failure notice and of the `outage_queue` enqueue, not merely the absence of a throw. **Both pairs must use a fixture whose delivery adapter is NOT the audit adapter** (a ws/app item delivered by `wsAdapter` while `slackAdapter` is the audit adapter). An `internal` item resolves no adapter, so `deliverAgentResult` and `handleTurnFailure` both early-return and the "no failure notice" assertion becomes vacuous; and each pair's deliver-rejection row must use a channel name that RESOLVES, or the turn returns at "No audit channel resolved" and `deliver` is never reached |

## Deployment prerequisites (operator, at deploy — not at merge)

Neither is checkable by the engine and neither belongs to this plan's verification; both are recorded here so the deploying operator sees them.

1. `dodi` currently has `slack.auditChannel: agent-jessica`. On the new code that value becomes the fleet-wide audit destination rather than a rarely-hit fallback. Before or at deploy: create a dedicated channel, invite the bot, and set it — either in `hive.yaml` plus a restart, or through `audit_channel_set` once the engine is running. Leaving it unset is acceptable (mirror off, content still in `activity_log` metadata) but discards the stream May asked to keep.
2. The chosen channel's membership must cover the **union** of the audiences that could already read the eleven `#agent-*` channels. Prerequisite 1's failure mode (posting into an agent's own channel) and this one (posting to the wrong audience) are independent — fixing one does not settle the other.

**Post-deploy verification, one-off, not an ongoing sweep:** re-run the trailing-7d `activity_log` distribution with `TURN_ACTIVITY_FILTER` (`src/activity/types.ts:58`) applied and confirm `#agent-*` volume drops by approximately the `internal` + `voice` + `team` row count while `slack`-kind rows are unchanged.

**Rollback** is a code revert. No configuration knob ships for the routing behavior itself — the audit channel *name* is configurable; whether the mirror obeys `policyFor` is not.

## Engineering decisions and assumptions

- **⚠ Assumption (structural, spec-adjacent).** D5 says the `AuditRoutingControl` closures are "implemented in `index.ts`". AC8 demands a runtime persist-and-round-trip test, and `index.ts` has no test seam — the spec itself accepts inspection-only verification for AC11 on exactly that ground and pointedly does not for AC8. This plan therefore places the identical closures in an exported `createAuditRoutingControl(deps)` in the same leaf module, which `index.ts` calls. The import direction, the no-import-cycle property and the closure bodies are unchanged; only the definition site moves.
- **⚠ Assumption.** The Dispatcher gains four small public readers (`getAuditChannelName`, `peekAuditChannelId`, `auditRoutingReady`, `resolveAuditChannelIdFully`) so the control can be typed structurally and never import `dispatcher.js`. D4/D5 imply all four; none is a new behavior.
- **⚠ Assumption.** `refreshAuditChannelIds` is deliberately a **non-`async`** method returning a promise. That is what makes the single-flight guarantee hold under a concurrent fan-out (AC10); converting it to `async` introduces an await point before the in-flight flag is stored and silently breaks it. Its inner IIFE, symmetrically, opens with a deliberate `await Promise.resolve();` so a *synchronous* throw from `conversations.list` cannot run the IIFE's `finally` before `this.auditRefreshInFlight = inFlight` executes and permanently latch a resolved promise into the guard (unreachable through the real `@slack/web-api` client and through the tests' `mockRejectedValue`, hence closed in code rather than by a test). Both are flagged so a later simplification pass does not "clean up" either one.
- **⚠ Assumption.** The `if (this.auditAdapter)` half of each call-site guard is retained per D1's literal text. It is not a duplicated `source.kind` predicate — that half is deleted at all three sites, and the single-hit `grep -n "auditAdapter.kind"` check in Chunk 4 Task 8 is what keeps it that way.
- **⚠ Assumption.** The `CLAUDE.md` MCP-server-bullet clause is one line beyond the spec's explicit documentation obligation (the collections list). It is included because that list already enumerates tool families per server and would otherwise be stale the day this merges.
- **⚠ Observation, not acted on.** The runner's stdio admin fallback (`agent-runner.ts:1123-1133`) points at `admin/admin-mcp-server.js`, and this repo ships no stdio shim in `src/admin/admin-mcp-server.ts` — the file header claiming one is stale. That path's brokenness predates KPR-452 and is out of scope; the spec's named limit ("the tools report unreachable in a subprocess") is implemented as written and is honest either way.
- The existing `describe("per-agent audit routing")` block in `dispatcher.test.ts` is **replaced**, not extended: all three of its tests assert homeBase behavior the spec removes.
- `policyFor`'s documented client-supplied-id caveat (`outage-notices.ts:8-13`) now also affects audit routing. Worst case is one misrouted audit copy; no new mitigation is proposed, per the spec.
- D2 rule 5 (the self-post guard) is unreachable by construction, not merely dead under rule 2. It is kept as a cheap invariant guard, and no test may pretend it fires.
