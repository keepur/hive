# KPR-454 — Runtime tool-failure producer: the first `ops_events` publisher

## TL;DR

KPR-454 makes the engine state, as a durable published fact, that a tool failed — on both provider lanes, from one capture point each, in the vocabulary KPR-458 fixed. It is the **first producer** conforming to that contract: it owns the accept path (validate → resolve epoch → match → one immutable insert), the `ops_events` and `ops_subscriptions` collections and their boot-order wiring, its own reason-registry rows, and nothing else. It delivers nothing, notifies nobody, and holds no ledger — those are KPR-468's. Shipped alone it is *staged, not broken*: every tool failure is recorded with a truthfully stamped `matchedSubscriptions: 0` and the log is queryable while no notification exists. The ticket body is stale on its two central mechanisms and both are superseded here with reasons: the `agent_events` + `deliveries: []` store-only trick is the mechanism KPR-458 D10 rejects, and `PostToolUse` is the SDK's **success** hook — the failure hook is `PostToolUseFailure`, which this repo's own shipped CLI documents in one line.

## Key Points

- **Two capture points, and the ticket named the right lines for the wrong halves.** The Claude lane needs **both** SDK hooks: `PostToolUseFailure` (typed `tool_name` / `tool_input` / `error` / `is_interrupt` / `duration_ms`) is the failure signal, and `PostToolUse` — which the shipped CLI's own hook table describes as *"Run after successful tool"* — is the **recovery** signal D2 makes an obligation. Lane B needs both halves at one site: `wrap()`'s `catch` (`tool-bridge.ts:352-357`) and the success line two lines above it (`:349-351`). Every Lane B failure — MCP `isError` converted to a throw in `discover()`, a builtin throw, a transport rejection, a delegate `Task` fault — passes through that one `catch`.
- **The condition is the tool, not the work item.** `subject: { kind: "tool", id: "<canonical tool name>" }`. Keying on `workItemId` would mint a fresh condition per turn and reproduce exactly the flood this epic exists to remove; keying on the tool collapses a flapping tool into one renewing condition, which is also what D8's tool-health view already assumes (it keys on `detail.tool` / `detail.errorSig`, i.e. from `detail`, not from `subject`). `workItemId`, `threadId` and `agentId` ride `detail`; `workItemId` also rides `evidence` when present.
- **`workItemId` is optional and this producer must survive its absence.** KPR-453 canon: detached worker and scribe executions carry no `WorkItem`. Those are precisely the turns nobody is watching, so a design that drops their failures drops the most valuable rows. Because the subject is the tool, they publish normally; the absent id is simply an omitted `detail` key and a `waiting: nobody`.
- **`errorSig` is an enumerated token, never a hashed or truncated message.** D9's words are "tool name plus an enumerated error token". One exported pure classifier, one closed nine-value set, typed signals first and a small fixed token test after, defaulting **to `unclassified`** — which is what keeps C13 true by construction rather than by a scrub pass. `invocation` from the ticket body is dropped: tool arguments are named in C13's prohibited list.
- **Own-abort is not a tool failure; a foreign interrupt is.** Both lanes suppress the publish when the turn's own abort is already set (`AgentRunner.wasAborted`; `opts.signal.aborted`) — a deadline kill is not a tool fault. An interrupt the runtime did **not** cause still publishes, as `errorToken: "interrupted"`, which makes this producer the standing detector for the KPR-438 background-subagent signature.
- **A fourth collection is forced, and this is the child that must define it.** D4 requires the reason registry to be *data* so an out-of-engine producer can add rows without an engine change, and D11 column 3 gives the operator `enabled` as a lever — neither has a home in D1's three collections. KPR-454 defines `ops_reasons`, upserted at boot from the producer's code-resident rows, **never overwriting operator-set `enabled`**. That toggle is also this ticket's whole kill switch: `enabled: false` + restart stops publication, because C5 fails an unknown-or-disabled `(producer, reasonId)` closed. No new hive.yaml key ships.
- **Publishing is off the turn's await path, but not fire-and-forget.** A bounded in-process queue with a single drainer (KPR-456's `inFlight` + drain-before-shutdown precedent) keeps the turn free of the two indexed reads D2's epoch resolver needs, bounds concurrency under a failure storm, serializes the open-condition map, and gives shutdown something to drain. Overflow drops oldest and counts. A publish fault is warned and counted — **never published** (D10 invariant (a)).
- **Lane B needs one stable-identity fix, and it is small.** `ToolBridgeOptions.agentId` is documented "logging/telemetry label only" and is fed `config.name` — the **display name**, which D5 says is never an identity. `ProviderTurnAssembly` gains an optional `agentId?: string` (the `agent_definitions` slug), the KPR-432/434 additive-optional pattern for a frozen provider ABI; absent ⇒ the `agentId` detail key is omitted, never guessed.
- **No new MCP server, no agent-facing publish tool, no containment change.** The two KPR-390 standing obligations (Lane B inventory compensation, the three `suppressAutoInjectedServers` gates) are inapplicable because no server is added, and `WORKER_SERVER_DENYLIST` is untouched. Contained workers do publish — the runtime publishes *about* them, with allow-listed fields only; a worker cannot choose to, so no outbound surface opens.
- **In scope:** the two capture points, the error-token classifier, `waitingFor` co-located with `policyFor`, the accept path including match evaluation and the `matchedSubscriptionIds` stamp, the open-condition map and the recovery publish, the three collections' shapes/indexes/boot wiring, this producer's reason rows, `CLAUDE.md` entries. **Out of scope:** ledger, delivery, transport adapters, nudging, snooze, clearing *application*, acknowledgement intake (all KPR-468); the inbound acknowledgement edge and every reader (KPR-455); every row of D11's third column; widening `system:task_blocked`; any `hive doctor` section; any dashboard.

## Scope and authority

Ticket: **KPR-454 — Runtime-emitted tool failures — PostToolUse hook (Claude lane) + Lane B wrap() event**. Parent: KPR-451. Worktree baseline: `epic/kpr-451` at `10ba066318b4c206a78e8260fc5a43d6d566a05a`; every runtime fact below was read at that tree.

**Binding inputs.** `docs/epics/kpr-451/kpr-458-design.md` (476 lines, spec-reviewed over four rounds, human-signed-off) is the contract this child conforms to, and its D2/D3/D4/D5/D9/D10/D11/D12 and C1–C19 bind directly. `docs/epics/kpr-451/kpr-458-plan.md` carries the **fresher-than-spec scoping resolution**: the D12 matcher–deliverer went to a new child **KPR-468**, and the D6 inbound acknowledgement edge went to **KPR-455** (recorded at KPR-455#comment-1b79ee1a). The addendum recording that is planned but **not yet appended** to the design file at `10ba066` — the design body still reads "chartered to no child", and this spec is written against the plan's resolution, not that stale body text.

**Dependencies, both satisfied.** KPR-453 (`workItemId` threading) merged at `681ec6751be86542fde9fc5487511ad9371a620e`, canon ALIGNED — its rules on live references, absence, and identity-proves-nothing bind D2 and D7 below. KPR-458 closed `ready-to-implement` this session with its plan at `10ba066`. Neither blocks.

**Signoff model.** The epic carries `epic-signed-off` (Gate 1 delegation, KPR-451#comment-95cc0708) and KPR-454 carries no `needs-human-spec`, so this draft proceeds under delegation. Delegated calls are ⚠-flagged in the final section.

**Epic Decision Register canon consulted** (read live from KPR-451 at draft time). The binding entries here are KPR-453's four (identity plumbing, live references refreshed including absence, retained identity across hooks/ToolBridge/guardrails/delegates, and "identity proves neither unique attempt nor task continuity"), and KPR-456's rule that an engineering child supplies **no default recipient, severity, escalation, production registration, prompt rollout, or new policy dependency**. This child supplies none of those. No canon entry is contradicted; none is amended by this spec.

## Two supersessions of the ticket body

The ticket body predates the contract and is stale on both of its central mechanisms. Neither is a judgement call.

**1. `agent_events` with `deliveries: []` is the rejected mechanism, not a variant of it.** The body proposes `system:tool_failed {…}` "written with `deliveries: []` (store-only; `hasPending: false` so the scheduler never dispatches it)". That is the same collection whose publish-time fan-out spawns turns, configured not to fan out. KPR-458 D10 declines it in terms: the fan-out "*dispatches agent turns*", and an operational-failure feed sharing a collection with a turn-spawning bus "is one field away from a spend loop". Verified at this tree: `Scheduler.checkEvents` (`src/scheduler/scheduler.ts:322-413`) iterates `{ hasPending: true }`, atomically flips each pending delivery to `fired`, and calls `agentManager.runWorkItemTurn(delivery.agentId, workItem)` at `:402`. `EVENT_SCHEMAS` (`src/events/event-types.ts:15-134`) is a closed **13-type** zod map over five domains whose `system:task_blocked` payload is `{taskId, description, blockedBy}` — it cannot carry D2's envelope. KPR-454 therefore writes `ops_events`, and the coordination bus is untouched, including the `subscribe: string[]` agent-definition field, which stays the event-bus domain list and is never overloaded to mean an ops subscription.

**2. `PostToolUse` is the success hook.** The shipped CLI binary at this tree (`@anthropic-ai/claude-agent-sdk@0.3.258`, platform dep `claude-agent-sdk-darwin-arm64`) carries its own hook-event table, verbatim: `| PostToolUse | Tool name | Run after successful tool |` and `| PostToolUseFailure | Tool name | Run after tool fails |`. `PostToolUseFailureHookInput` (`sdk.d.ts:2446-2457`) is `BaseHookInput & { hook_event_name, tool_name, tool_input, tool_use_id, error: string, is_interrupt?, duration_ms? }`; `PostToolUseHookInput` (`:2464-2475`) carries `tool_response` and no `error`. A PostToolUse-only implementation would attach to the success path and publish nothing. Both events are in `HOOK_EVENTS` and in the `HookEvent` union, so both are wireable through the existing `Partial<Record<HookEvent, HookCallbackMatcher[]>>` shape with no type work. The body's two insertion points are otherwise correct and are used, re-assigned: `PostToolUseFailure` carries the failure, `PostToolUse` carries the recovery D2 requires.

**What carries forward unchanged from the body:** the two lanes' insertion points, and "redaction is a zod field allow-list on the event schema at write time — not scrub-after". That rule is now KPR-458 C13/D9 rather than a fresh idea, and D4's `detailKeys` is its mechanism.

## Verified runtime facts

Read at `10ba066`. Anything the contract cites that has moved is recorded here with its new span; nothing cited has changed in substance.

| Fact | Anchor at `10ba066` | Note |
| --- | --- | --- |
| `buildHooks` registers `PreCompact` only, plus a conditional archetype `PreToolUse`; no Post\* hook exists | `src/agents/agent-runner.ts:1936-1974`, consumed at `:2184` | Ticket cited `1904-1941` — moved, unchanged in shape. Rebuilt on every `send()`, so the hook closure is per-turn. |
| The assistant-block loop parses `text` and `tool_use` only; there is no `tool_result` branch anywhere in the file | `src/agents/agent-runner.ts:2363-2381` | Ticket cited `2336-2347` — moved. Confirms the Claude lane is failure-blind today. |
| `AgentRunner` exposes `wasAborted` over a private `_aborted` | `:2576-2586` | The own-abort suppressor for the Claude lane. |
| `WorkItemContext` / `WorkItemContextRef`; the runner's ref is set per send | `:149-164`, field `:397`, assignment `:1472` | KPR-453. `workItemId` is optional by contract. |
| `wrap()` — the single Lane B dispatch wrapper: gate → abort pre-check → execute → contain → meter | `src/agents/provider-adapters/tool-bridge.ts:318-359`; failure return `:355`; success `:350-351` | Ticket cited `290-345` — moved. `discover()` (`:290-308`) converts MCP `isError` into a throw *specifically* so this one catch handles it; `buildTaskTool` (`:397-444`) routes the delegate `Task` through it too. |
| `record()` counts calls + ms + per-tool, never failures | `:526-530` | Ticket cited `527-529`. |
| `ToolBridgeOptions.agentId` is a display label, fed `config.name` | `:53-58` (`workItemContext?`), `:56-57`; scaffold `turn-scaffold.ts:192`; manager `agent-manager.ts:1031` (`name: config.name`), nested `:939` (`${config.name}:${delegate}`) | The stable-identity gap D5 forbids relying on. |
| `ToolBridge` is constructed once per turn by the scaffold | `turn-scaffold.ts:186-196` | So a per-turn capture is the turn's own context, on both lanes. |
| `ProviderTurnAssembly` is frozen provider ABI; two optional fields were already added post-freeze under that rationale | `turn-assembly.ts:96-158`, re-exported by `provider-adapters/provider-abi.ts:113-118` (`LANE_B_PROVIDER_ABI_VERSION = 1`, `:37`) | `datetimeInTurnInput?` (KPR-432) and `memoryInTurnInput?` (KPR-434) are the precedent for the `agentId?` addition in D6. |
| `policyFor` classifies by reserved `WorkItem.id` prefix | `src/outage/outage-notices.ts:18-26` | Unmoved. `sched:`→`skip`; `callback:`/`event:`/`team-`/`worker:`→`silent`; else `notify`. **The stale "team DM" fallthrough comment D3 warns about is still present at `:25`** — D3's warning stands as written. |
| The spawn-capable boundary marker and the above-boundary wiring block | `src/index.ts:474`; wiring `:404-473`; `boot-order.test.ts` three lists at `:40`, `:64`, `:84` | Four order-pinned anchors today plus one presence-only. |
| The KPR-456 runtime precedent for a boot-initialized, drained subsystem | `index.ts:328-329` (`new ObligationRuntime(db, config.activity.retentionDays, …)` + `await obligations.init()`), `:396`, `:639`, `:943`; `obligations/store.ts:58-84` | The init/start/stop and `createIndex` shape D9/D10 below reuse. |

Two contract citations drifted and neither invalidates a criterion: `Scheduler.checkEvents` spans `322-413` (KPR-458 cites `322-405`; the turn spawn is at `:402`), and the tool-failure sites in the ticket body moved as tabled above. `turn-scaffold.ts:353`'s literal `costUsd: 0` and `policyFor`'s prefix table — the two facts C12 and C6 actually rest on — are unchanged.

## Goals and non-goals

**Goals.** State a tool failure as a published fact on both lanes, from one capture point per lane, in the D2 envelope. Publish the recovery that makes D2's epoch rule work. Make the fact honest with no subscriber, no ledger and no transport in existence. Never fail, delay, or alter a turn. Store no message text, no arguments, no raw error.

**Non-goals.** Any ledger row, delivery, adapter, nudge, snooze, clearing application or acknowledgement intake (KPR-468). Any reader, view, dashboard, `hive doctor` section or inbound acknowledgement edge (KPR-455). Any subscription row, transport binding, cadence value, nudge floor, staleness horizon or retention *value* (D11 column 3, operator). Any agent-facing publish tool. Any change to `agent_events`, the scheduler, `activity_log`, delivery routing, or KPR-456's obligation path. Any new hive.yaml key. Turn-deadline, provider-outage or obligation events — other producers, other tickets.

## Design

### D1. Producer identity, and the three collections this child owns

`producer: "hive-runtime"` — the engine itself, reporting what it observed. It is a bounded lowercase-hyphen token per D2, not an enum member, and adding a second producer later is rows.

KPR-454 creates, indexes, documents and wires:

- **`ops_events`** — D1's append-only log. Nothing in it is ever mutated. One document per publish.
- **`ops_subscriptions`** — D5's subscription documents. This child **creates the collection, its index, and the in-memory loaded set**, and registers **zero rows** (D11 column 3). It reads them; the operator writes them.
- **`ops_reasons`** — the D4 reason registry, defined here because D1 named three collections and D4 needs a fourth. See D5.

`ops_notifications` is **not** created here; it is KPR-468's, per D12's boot-order split.

All four get `CLAUDE.md` MongoDB-collections entries in this ticket's diff except `ops_notifications` — the KPR-452 precedent that a collection documented only in a spec is invisible to the next reader.

### D2. The Claude lane: two hooks, one job each

`buildHooks(context)` (`agent-runner.ts:1936`) gains two matchers beside `PreCompact`. Both are unmatched (all tools), both are `async`, both **return an empty object** — they never rewrite output, never set `additionalContext`, never block. The SDK's `PostToolUseHookSpecificOutput` offers `classifierContext` and an output rewrite; neither is used, and a test pins that the returned object is empty, because a hook that alters tool output would breach C15's "cannot alter a turn's outcome" on the one path where altering is trivially available.

```
PostToolUseFailure  →  observeToolFailure({ tool: input.tool_name, error: input.error,
                                            isInterrupt: input.is_interrupt,
                                            durationMs: input.duration_ms, lane: "claude" })
PostToolUse         →  observeToolSuccess({ tool: input.tool_name, lane: "claude" })
```

Three rules bind the wiring:

1. **Own-abort suppresses.** Both callbacks read `this.wasAborted` at fire time and return immediately when set. A turn killed by its wall-clock deadline (KPR-402) or by an operator abort produces tool errors that are consequences of the kill, not faults of the tool. `is_interrupt` alone does **not** suppress: an interrupt the runtime did not cause is a real fault, and it is the KPR-438 background-subagent signature (`"The tool call was interrupted before a result was received"`, in-process MCP only) that this producer should be the standing detector for.
2. **Identity is read at fire time, never captured at build time.** The callbacks read `this.workItemContextRef.current` (KPR-453's live reference) and `this.agentConfig.id` (the stable slug). `buildHooks` is rebuilt per `send()` and `AgentRunner` is per-spawn, so capture-at-build would be equivalent today — reading `.current` is required anyway, because KPR-453 canon fixes the pattern rather than the coincidence, and a future runner reuse must not silently mis-attribute. Absence is honest: a missing `workItemId` omits the detail key.
3. **The archetype `PreToolUse` fail-closed arm is untouched.** Its `catch` installs a deny-all matcher; these two matchers are added outside that `try` so a broken archetype cannot disarm failure observation, and a broken observer cannot disarm archetype policy.

Subagent-originated failures are included: `BaseHookInput.agent_id` is present only inside a subagent, and no filtering is applied — a delegate's tool failure is a runtime tool failure. `agent_id` is **not** stored; the publishing agent is the parent's stable slug, matching Lane B, where a nested delegate turn's bridge carries the parent's assembly.

### D3. Lane B: one site, two lines

In `wrap()` (`tool-bridge.ts:318-359`), unchanged in structure:

- **Success** — beside the existing `this.record(name, Date.now() - t0)` at `:350`, add `observeToolSuccess({ tool: name, lane: "laneB", … })`.
- **Failure** — beside `this.record(...)` at `:353`, before the containment return at `:355`, add `observeToolFailure({ tool: name, error: errorText(err), … })`.

Four things are deliberately **not** published from this method:

| Site | Text | Why not |
| --- | --- | --- |
| `:341-342` | `Tool call denied by policy: …` | A guardrail deny is policy working, not a fault. Publishing it would make correct enforcement look like breakage. |
| `:344-345` | `Tool execution aborted (…)` | Pre-execution abort check; the turn is already dying. |
| catch, when `this.opts.signal.aborted` | — | Abort **during** execution surfaces as a rejection and would otherwise be indistinguishable from a fault. Reading the signal in the catch is Lane B's exact analogue of the Claude lane's `wasAborted`, and the two lanes must suppress the same class or the tool-health view is lane-skewed. |
| `discover()`'s `isError` conversion | — | Not a separate site: it throws precisely so this one catch handles it (`:290-308`). Nothing is added there. |

The name published is `name` — the argument `wrap()` closed over, i.e. the canonical `mcp__<server>__<tool>` or builtin name **before** `applyNameAndCapEdges` sanitizes/truncates/de-collides for provider constraints (`:446-…`). That method builds a new object and never rewrites the closure, so the canonical name is what reaches the publisher, and Lane A/Lane B/Claude rows for one tool share a `subject.id`. A test pins this against a name long enough to trigger truncation.

### D4. Subject, dedupe key, and the identity of the condition

```
subject = { kind: "tool", id: <canonical tool name> }
dedupeKey = "hive-runtime:tool:<toolName>:tool-failed:<generation>"      (D2's formula, unchanged)
```

**Why not `subject.kind: "workItem"`.** KPR-453 canon says an item id "proves neither unique attempt nor task continuity", and D2 spells out that a workItem subject collapses one turn's retries into one condition. That is the right granularity for a *turn* fact; it is the wrong one for a *tool* fact. A tool broken for a day fails across hundreds of work items, minting hundreds of conditions and — once KPR-468 exists — hundreds of ledger rows and hundreds of first deliveries. That is the flood the epic exists to remove. Keying on the tool makes it one condition that renews (D7 rule 4: `latestEventId`, `lastEventAt`, `eventCount` advance and nothing new is sent), and it matches D8's tool-health view, which keys on `detail.tool` / `detail.errorSig` and therefore already assumes the signature lives in `detail` rather than in `subject`.

**The accepted cost, stated rather than buried.** All error tokens for one tool share one condition, and all agents share it. A tool that times out for agent A and rejects agent B's input is one row, whose `detail` shows the *latest* event's token. Remediation is per tool, so this is usually right; when it is not, the recorded evidence is still complete in the log, which is where D8's view reads. ⚠ Non-blocking, listed in Assumptions: the alternative (`subject.id = "<tool>#<token>"`) is a one-line change bounded by the nine-token set.

### D5. The reason registry: rows this producer ships, and where they live

**Two rows, both `producer: "hive-runtime"`, both shipped with this code and enabled at its deploy** (D11 column 2):

| `reasonId` | `class` | `retry` | `clearsReasonIds` | `detailKeys` | `remediationTemplate` |
| --- | --- | --- | --- | --- | --- |
| `tool-failed` | `resource` | `transient` | — | `tool`, `errorToken`, `agentId?`, `lane`, `threadId?`, `workItemId?`, `durationMs?` | `"retry {tool}; if it repeats, inspect {errorToken} — last seen for agent {agentId} on lane {lane}"` |
| `tool-recovered` | `informational` | `transient` | `["tool-failed"]` | `tool`, `agentId?`, `lane` | `"none; recorded so {tool} reopens as a new epoch if it returns"` |

This is the shape D2 and D4 require and mirrors KPR-458's own example table: an operational fault is `resource`, its clearing fact carries its **own** registered reason so it never notifies the condition's subscribers, and `informational` means no subscription selects it unless someone deliberately asks for recoveries. `retry: transient` is the honest default for a mixed population — a tool that failed once may succeed on the same input — and D3's stated lever for a genuinely deterministic class is a *second reasonId*, not a per-event assertion. ⚠ Delegated, non-blocking.

**`ops_reasons`, and why a fourth collection is forced.** D4 says "Adding a reason is a row… Neither is an engine change — which is what lets Florist come online later with producers that do not exist today", and D11 column 3 gives the operator `enabled` on an individual reason. Neither is expressible if the registry is a code constant, and D1 named no collection for it. KPR-454, as the first producer, defines:

```
ops_reasons: { _id: "<producer>:<reasonId>", producer, reasonId, class, retry,
               remediationTemplate, detailKeys[], clearsReasonIds?, enabled }
```

with a unique index on `(producer, reasonId)`. At boot the producer **upserts its own rows** from the code-resident table, writing every field **except `enabled`**, which is `$setOnInsert: true` — so an operator who disabled a reason keeps it disabled across upgrades, and a code change to a template or an allow-list still lands. D4's enable gate is enforced at that upsert: a `class: resource` row may not be left enabled unless some registered row lists its `reasonId` in `clearsReasonIds`. Both rows ship together, so the gate passes; it is still implemented, and it fails the boot upsert loudly rather than silently publishing an unclearable condition.

**`enabled: false` is this ticket's entire kill switch.** C5 fails an unknown *or disabled* `(producer, reasonId)` closed, so flipping `tool-failed` to `enabled: false` and restarting stops publication with no code change and no config key — which is why no hive.yaml lever ships (the standing "no preemptive levers" preference, and KPR-458's own posture of shipping no policy).

### D6. The `detail` allow-list, the error-token taxonomy, and the stable-id fix

**Redaction is the schema.** `detail` is validated by a zod object built **from the registry row's `detailKeys`** — not a hand-written second schema, or the two drift. Unknown key, wrong scalar type, over-length value or non-scalar ⇒ the publish is **rejected and counted** (C5). Nothing else is stored: no `tool_input`, no `tool_response`, no raw `Error`, no stack, no URL, no path, no prose. The ticket body's `invocation` field is therefore dropped — tool arguments are named verbatim in C13's prohibited list, and a diagnostics surface is exactly where a token gets written.

**The error token — one closed set, one exported pure classifier**, `classifyToolError(...)` in a single module used by **both** lanes (the C6 / KPR-452-D1 one-predicate discipline; a second classifier drifts):

`timeout` · `interrupted` · `transport-unavailable` · `not-found` · `invalid-input` · `permission-denied` · `rate-limited` · `upstream-error` · `unclassified`

Classification reads **typed signals first** — an MCP error class, an HTTP status where one is carried, the SDK's `is_interrupt`, the bridge's own `TOOL_CALL_TIMEOUT_MS` path — and only then a small fixed set of case-insensitive substring tests over the error text, which is used **for classification and then discarded**. Anything unrecognised is `unclassified`. Two properties are load-bearing and both get tests: the classifier is total (every input returns a token) and its output is drawn only from the closed set, so no message fragment can ever reach a stored field. A test feeds it a credential-shaped and a path-shaped error and asserts the token, and asserts that no substring of the input appears in the published document.

**The stable-identity fix.** `ProviderTurnAssembly` gains `agentId?: string` — the `agent_definitions` slug — set by `assembleProviderTurn`, carried into `ToolBridgeOptions` by the scaffold (`turn-scaffold.ts:186-196`) as a new non-ABI field. Optional because the type is frozen provider ABI at `LANE_B_PROVIDER_ABI_VERSION = 1`; this is exactly the `datetimeInTurnInput?` / `memoryInTurnInput?` precedent and needs no version bump. Absent ⇒ the `agentId` detail key is omitted (it is optional in `detailKeys`), never substituted with the display name, never guessed. `ToolBridgeOptions.agentId` keeps its documented meaning and its existing log call sites; nothing renames it. Nested delegate assemblies carry the parent's slug, matching the Claude lane's treatment of subagents in D2.

### D7. `waiting`, derived once, from the one prefix table

C6 requires `waiting` to come from a function co-located with `policyFor` sharing its prefix table, with no second prefix predicate in the repository. `policyFor` takes a `WorkItem`; the capture points hold a `WorkItemContext`. So `src/outage/outage-notices.ts` gains, beside `policyFor`:

```
policyForId(id: string): OutageSourcePolicy      // the prefix table, extracted verbatim
policyFor(item)  =>  policyForId(item.id)        // unchanged behaviour, one caller-visible shape
waitingFor(id: string | undefined): Waiting      // "human-now" | "agent" | "nobody"
```

`waitingFor` maps exactly D3's table: `team-` ⇒ `agent`; `callback:` / `event:` / `worker:` / `sched:` ⇒ `nobody`; fallthrough ⇒ `human-now`. **Read the prefix table, not the comment** — the stale *"team DM"* fallthrough comment is still at `:25`, and an implementer who trusts it maps agent-to-agent traffic to `human-now`, the misrouting this epic exists to remove. That comment is corrected in this diff, since this ticket is the first consumer that would be misled by it.

**Absent `workItemId` ⇒ `nobody`**, fail-closed to the quietest value. That is not a fudge: a detached worker or scribe execution has no `WorkItem` because nobody is directly waiting on it (KPR-453 canon), so `nobody` is the true value, and the failure is still published in full. `waiting: obligation` is never derived here — D3 reserves it for KPR-456's sweep, the only component that knows a deadline exists. `policyFor`'s documented ws/app client-supplied-id caveat carries over unchanged; the blast radius is one event's `waiting`, hence one mis-selected subscription.

### D8. Recovery, the open-condition map, and `generation`

D2 makes publishing recovery an **obligation**: without it a dismissed condition is permanently silent, because `generation` is an epoch over recovery and can never advance.

**The map.** One process-global, capped `Map<family, { firstFailureAt }>` where `family = "hive-runtime:tool:<toolName>:tool-failed"`, entered when a failure publish is accepted, removed when the recovery publish is accepted, evicted oldest-first at the cap. It lives on the publisher singleton (D9), not on a runner, because runners are per-turn and the condition is not.

**On success** (`PostToolUse`; Lane B's `:350`): a map lookup and nothing else. If the family is absent — the overwhelmingly common case — the observation returns immediately. **No database read on the success path**, per D2's explicit rejection of one against C15. If the family is present, one `tool-recovered` event is enqueued carrying `clears: <the open condition's dedupeKey>` and the entry is removed.

**On failure**: the epoch resolver runs **two bounded indexed reads** over the family — the latest event under `reasonId: "tool-failed"`, and the latest event whose `clearsFamily` equals the family. If the clearing fact is the more recent, `generation` is the latest condition event's plus one; otherwise it is that event's unchanged, or `0` when there is none. **If either read faults the publish still proceeds**, contained, at the publisher's last in-process value for that family, defaulting to `0` — D2's named residual: a bounded mis-attachment of a notification, never a lost fact, because the log append is unconditional.

**Restart residual, carried from D2 unchanged.** The map empties on restart, so a condition raised before a restart gets no clearing fact when it next succeeds and its epoch does not advance at that boundary; the following failure→recovery cycle re-arms it. One lost epoch boundary per restart per open condition, never a lost fact.

`generation` never advances because the condition recurred, because time passed, because a nudge went unanswered, or because a turn retried (C18). A test asserts a repeated identical failure leaves `generation` unchanged, and that failure → success → failure advances it by exactly one.

### D9. The accept path, and how it stays off the turn

**Order inside one publish**, all of it inside the publisher, none of it on the turn's await path:

1. Resolve the registry row for `(producer, reasonId)`; unknown or `enabled: false` ⇒ reject + count (C5).
2. Validate `detail` against the row's `detailKeys` zod schema; validate `evidence` as `{kind, id}` references only ⇒ reject + count on any breach (C5, C13).
3. Stamp `class` and `retry` **from the row**; a submission asserting either is rejected (C4). The `observe*` call sites cannot supply them — the internal API has no such parameters.
4. Derive `dedupeKey`, and `clearsFamily` when `clears` is present. A `clears` whose reason declares no `clearsReasonIds`, or names a reason outside that list, is rejected (C19).
5. Resolve `generation` (D8).
6. **Evaluate the match** — a pure, I/O-free conjunction of set-membership tests over the D5 grammar against the **loaded** subscription set. No operators, no negation, no wildcards, no nesting.
7. **One immutable insert** into `ops_events` carrying `matchedSubscriptionIds` and its length as `matchedSubscriptions`. Zero is a stored, queryable fact and never a failure (C2, C3). Nothing re-evaluates the match afterwards; KPR-468's sweep reads the stamped list.

**The loaded subscription set.** Loaded at boot, refreshed on a bounded periodic reload and on `SIGUSR1` (the existing operator escape hatch). D12 already rules that a reload lag means a just-registered subscription may miss an event by seconds and that this is not a new failure mode, because D5 forbids retrospective enrolment either way. A reload fault leaves the previous set in place and counts; it never empties the set, because an empty set silently makes every event a zero-match.

**Off the turn, and not fire-and-forget.** `observeToolFailure` / `observeToolSuccess` are **synchronous, non-throwing, and return void**. They do the map lookup (success) or enqueue one job (failure/recovery) onto a bounded in-process queue drained by a single worker. This is chosen over an unawaited promise for four reasons, all real: the failure path performs two indexed reads and a write, which under a storm would otherwise open unbounded concurrent Mongo work from inside a turn; the drainer serializes per-family epoch resolution against the map; a bounded queue has a drop policy and a counter, where an unawaited promise has neither; and shutdown has something to drain (the KPR-456 `inFlight`-set precedent). Overflow drops the **oldest** and increments a counter — a full queue means a storm, and the newest failures are the ones a responder needs.

**Containment (C15).** Every observe call is wrapped so that no throw escapes to the tool path; the drainer catches per job, counts, and continues; a Mongo fault degrades to warn-and-count. This is the discipline KPR-452 D4 imposed on the audit path, for the same reason and with more at stake: the Lane B site sits inside the one method whose header promise is "structurally cannot throw", and the Claude-lane sites sit in hook callbacks the SDK awaits mid-turn. Two tests are negative-verify: a publisher that throws on every call leaves a turn's `RunResult` byte-identical, and a publisher whose Mongo is down does the same.

**D10 invariant (a), which earns its keep here.** A publish fault, a validation rejection, a match failure or a queue overflow is **logged and counted, never published**. Counters live in memory behind a `getSnapshot()` for a later reader; no telemetry document, no doctor section, no event about the ops path ships in this ticket. Invariant (b) is trivially satisfied — this child delivers nothing and spawns nothing.

### D10. Boot order, indexes, and shutdown

**Above the boundary.** Publishing is read per spawn — the first turn after boot can fail a tool — so the publisher's construction, `init()` (collections + indexes) and singleton registration all sit in `index.ts`'s above-boundary wiring block (`:404-473`), beside the KPR-394/414/417 wiring, and **above** the `// ── Spawn-capable boundary ──` marker at `:474`. Its anchors go in **all three** lists of `src/boot-order.test.ts` — presence (a), order (b), and the superset-sweep bound (c) — per the engine-wide rule; adding to (a) alone is the failure mode that guard exists to catch.

The publisher is reached from the capture points through a **module-global singleton** with `setOpsPublisher()` / `opsPublisher()` and a test reset, the `provider-registry.ts` precedent (a module-global registry set once at boot, because the consumer is module-scope). Unset ⇒ every observe call is a no-op, which is what keeps the pre-wiring boot window and every bare test construction correct by construction rather than by ordering luck.

**Indexes** created in `init()`, the `obligations/store.ts:78-84` shape:

| Collection | Index | Purpose |
| --- | --- | --- |
| `ops_events` | `{ producer: 1, "subject.kind": 1, "subject.id": 1, reasonId: 1, publishedAt: -1 }` | D8's condition-side epoch read |
| `ops_events` | `{ clearsFamily: 1, publishedAt: -1 }` (sparse) | D8's clearing-side epoch read |
| `ops_events` | `{ dedupeKey: 1, publishedAt: -1 }` — **not unique** | D2: the log appends every publish |
| `ops_events` | `{ publishedAt: 1, _id: 1 }` | D12's cursor order, created by the publisher because D12 assigns `ops_events` and its indexes here |
| `ops_events` | `{ publishedAt: 1 }`, `expireAfterSeconds` from `config.activity.retentionDays` | D9's "aligned with existing activity-history retention" |
| `ops_subscriptions` | `{ enabled: 1 }` | the loaded-set read |
| `ops_reasons` | `{ producer: 1, reasonId: 1 }` unique | C5's fail-closed lookup |

**Shutdown** drains the queue before Mongo closes, the KPR-456 ordering (`index.ts:943`). Draining is bounded; on timeout the remainder is dropped and counted, because a shutdown that blocks on an ops queue is worse than a lost diagnostic row.

**No `boot-order.test.ts` anchor is added for anything KPR-468 owns** — `ops_notifications` and the sweep bring their own, and the sweep starts *after* transport adapters, which do not exist yet.

### D11. Boundaries — what this child deliberately does not touch

- **`agent_events` is unchanged**, including `EVENT_SCHEMAS`, `Scheduler.checkEvents`, and the `subscribe: string[]` agent-definition field. **The ticket's `system:task_blocked` widening is out of scope and superseded**: it was scaffolding for the rejected store-only mechanism, its `owner` field collides head-on with D2's explicitly-absent list and with the operator's "no owner on the event" ruling, and the coordination block it was meant to enrich is `hive-agent` / `coordination-block` in D4's example table — a *future* producer with an agent-facing publish tool that D10 gates behind `delegateServers` and worker containment and that this ticket does not build. ⚠ Non-blocking; if richer coordination-bus payloads are still wanted they are a separate ticket against a bus this epic is not changing.
- **No MCP server is added**, so both KPR-390 standing obligations are inapplicable and are named here so a reader does not go looking: there is no `buildToolTransportInventory` descriptor to push (nothing to bridge), and no `suppressAutoInjectedServers` gate to extend (nothing is auto-injected). `WORKER_SERVER_DENYLIST` and the `delegateServers` in-process constraint are untouched.
- **Contained workers publish, and that is not a containment hole.** A worker's tool failures are among the least visible in the engine, so excluding them would forfeit the ticket's best rows. The worker cannot *choose* to publish, sees no tool for it, and controls no field: the runtime publishes about it, through an allow-list, to a collection with no delivery attached. No outbound surface opens.
- **KPR-456 and KPR-457 keep their contracts.** Neither becomes an adapter or a subscriber here; KPR-456's sweep is a plausible *future* producer (`waiting: obligation`), which is a later publish and not a redirection.
- **No `hive doctor` section, no CLI, no reader, no view.** Anything that reads `ops_events` is KPR-455.

### D12. Three columns, restated for this producer

| Defined by KPR-458 (contract) | Ships with KPR-454 (code-adjacent data) | Registered by the operator |
| --- | --- | --- |
| Envelope, vocabularies, `dedupeKey` formula, `generation` rule, filter grammar, redaction mechanism, C1–C19 | Both capture points, the classifier, `waitingFor`, the accept path, the open-condition map, the collections/indexes/boot wiring | — |
| Reason-registry entry **shape** | The two `hive-runtime` rows above, and this producer's declared advance rule (D8) | `enabled` on either row, after the fact |
| Subscription document shape | The `ops_subscriptions` collection and the loaded set — **zero rows** | Every subscription row, subscriber and transport binding |
| Retention posture | The event TTL **bound to** `config.activity.retentionDays` | The retention **value**, via that existing setting |

The intended post-deploy steady state, stated exactly so nobody reads a merged ticket as a live surface: **every tool failure and recovery is recorded, none is delivered, no ledger row exists, and `matchedSubscriptions: 0` measures how much nobody has claimed yet.**

## Conformance and acceptance criteria

Each maps to a KPR-458 criterion; each is testable at this child's boundary.

1. **AC1 (C1, C4)** — A published event carries no `owner`, `severity`, `destination`, `recipient` or rendered string, and `class`/`retry` equal the registry row's. The internal observe API has no parameter that could supply them; a test asserts the stored document's key set against the envelope.
2. **AC2 (C2, C3)** — With `ops_subscriptions` empty, a tool failure stores exactly one `ops_events` document with `matchedSubscriptions: 0` and `matchedSubscriptionIds: []`. The document is byte-identical in shape to a matched one. Nothing writes a ledger row, and no catch-all subscription is created by any code path.
3. **AC3 (C5)** — A disabled or unknown `(producer, reasonId)`, an undeclared `detail` key, an over-bound value and a non-scalar value each reject the publish and increment the rejection counter. No coercion to a generic reason.
4. **AC4 (C6)** — `waiting` is produced by `waitingFor` in `src/outage/outage-notices.ts` over the single prefix table; a repository-wide test asserts no second prefix predicate exists. The four mappings are pinned, `team-` ⇒ `agent` explicitly.
5. **AC5 (C7)** — Match evaluation implements exactly the D5 grammar; a test enumerates it and fails any operator, negation, wildcard or nesting.
6. **AC6 (C13)** — No stored field contains message text, tool arguments, a raw error, a URL, a path, a credential or prose. Negative test: a failure whose error text embeds a token-shaped string and an absolute path publishes a document in which neither substring appears anywhere.
7. **AC7 (C14)** — A publish fault, rejection or overflow produces a log line and a counter increment and **no** `ops_events` document. No code path in this diff spawns a turn.
8. **AC8 (C15)** — Negative-verify: with a publisher that throws on every call, and again with one whose Mongo write always rejects, a Claude-lane turn and a Lane B turn produce byte-identical `RunResult`s to a run with no publisher wired, and the turn's own error/abort classification is unchanged.
9. **AC9 (C18)** — A repeated identical failure leaves `generation` unchanged and appends a second event; failure → success → failure advances `generation` by exactly one and publishes exactly one `tool-recovered` in between. A success with no open condition performs no database access at all.
10. **AC10 (C19)** — `tool-recovered` carries `clears` and `clearsFamily`; a `clears` published under `tool-failed` is rejected. Boot upsert refuses to leave `tool-failed` enabled if no registered row lists it in `clearsReasonIds`.
11. **AC11 (lane parity)** — The same underlying tool failing on the Claude lane and on Lane B produces the same `subject.id`, including for a tool whose name exceeds the Lane B sanitization threshold.
12. **AC12 (abort discipline)** — An own-abort (deadline or operator) mid-tool publishes nothing on either lane. A foreign interrupt publishes `errorToken: "interrupted"`. A guardrail deny publishes nothing.
13. **AC13 (boot order)** — `src/boot-order.test.ts` carries the publisher's anchors in all three lists and fails if the wiring moves below the marker. With the publisher unset, both capture points are no-ops and no turn is affected.
14. **AC14 (documentation)** — `CLAUDE.md`'s engine-written collections list gains `ops_events`, `ops_subscriptions` and `ops_reasons`, each with its key, index and TTL posture.

## Assumptions and remaining decisions

- **⚠ Delegated (non-blocking) — `subject.kind: "tool"`, not `"workItem"`.** D2 discusses a workItem subject as its worked example; this producer keys on the tool because the condition is "this tool is failing" and D8's own view keys on `detail.tool`/`detail.errorSig`. Cost: one condition per tool across all agents and all error tokens. The alternative (`<tool>#<token>`) is a one-line change bounded by a nine-value set. D4.
- **⚠ Delegated (non-blocking) — `ops_reasons` as a fourth collection.** D1 named three; D4's "adding a reason is a row" and D11's operator `enabled` lever have no home without one. Boot upsert never overwrites `enabled`. The simpler alternative — a code constant — would make C5 implementable but would forfeit the operator lever and Florist's ability to add rows without an engine change, which D4 names as the registry's whole point. D5.
- **⚠ Delegated (non-blocking) — `tool-failed` is `retry: transient`.** The population is mixed; `transient` is the honest default, and D3's stated lever for a deterministic class is a second `reasonId`. D5.
- **⚠ Delegated (non-blocking) — `ProviderTurnAssembly.agentId?: string`.** An additive optional field on a frozen provider ABI, the KPR-432/434 precedent, no version bump. Needed because `ToolBridgeOptions.agentId` is the display name, which D5 forbids as identity. Absent ⇒ the detail key is omitted. D6.
- **⚠ Delegated (non-blocking) — bounded queue rather than an unawaited publish.** Justified in D9 on four counts. Overflow drops oldest and counts; shutdown drains with a bound.
- **⚠ Delegated (non-blocking) — the `system:task_blocked` widening is dropped.** Reasons in D11. Recoverable as a separate ticket if the operator still wants it.
- **⚠ Verify at implementation (non-blocking) — which Claude-lane failure classes actually fire `PostToolUseFailure`.** The shipped CLI's hook table and the failure-path invocation site (which carries an MCP-specific error branch alongside the hook dispatch) both indicate MCP tool errors reach it, and `PostToolUseFailureHookInput` exists in the `0.3.258` `.d.ts` and 24 times in the shipped binary. A live probe should enumerate: a throwing in-process MCP tool, an MCP `isError` result, a stdio-server fault, a builtin throw, and a KPR-438-style interrupt. **If a class does not fire it, that class is simply uncaptured on the Claude lane in this ticket** — it is not papered over by inferring failure from a `PostToolUse` `tool_response`, which would breach C12's "outcome must be published, never inferred". Note the fleet floats `^0.3.258` and deployed instances resolve higher than the lockfile; the probe must run against the SDK's bundled binary, never PATH `claude`.
- **Non-blocking, corrects the ticket body — `PostToolUse` is the success hook.** Evidence in "Two supersessions", from the shipped binary's own documentation table.
- **Non-blocking, supersedes the ticket body — `agent_events` + `deliveries: []`.** Declined per KPR-458 D10, with the current line numbers re-verified at `10ba066` (`checkEvents` spans `322-413`, spawning at `:402`; 13 closed types).
- **Non-blocking — the KPR-458 addendum is not yet on disk.** The design body at `10ba066` still reads "chartered to no child" for D12 and D6; `kpr-458-plan.md` carries the operator's resolution (matcher–deliverer ⇒ KPR-468, inbound edge ⇒ KPR-455). This spec is written against the resolution. A reader who opens `kpr-458-design.md` alone will find the stale text until that plan's Task 2 runs.
- **Non-blocking — stale comment corrected in passing.** `outage-notices.ts:25`'s fallthrough comment still claims "team DM"; a `team-` id returns `silent` two lines above and can never reach it. Corrected in this diff because this ticket is the first consumer the comment would mislead.
- **Deployment gate, not a spec gap.** With both reason rows enabled and zero subscription rows, the intended state holds: every publish recorded, none delivered, no ledger row, `matchedSubscriptions: 0` measuring the unclaimed. Making anything visible needs D11's third column plus KPR-468 and KPR-455, and D12's sequencing constraint stands — KPR-468 must not ship without KPR-455's inbound edge.
