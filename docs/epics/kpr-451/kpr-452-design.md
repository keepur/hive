## TL;DR

KPR-452 makes the audit mirror consult `policyFor()` and send every surviving copy to one configured audit channel instead of each agent's homeBase `#agent-<id>`. Per the human ruling the ops stream is **relocated, not deleted**: `policyFor`'s `skip` class is the only class that suppresses a copy, and `silent`-class agent-to-agent traffic — 277 of 317 mirrored turns in the measured week — moves out of the per-agent channels into the audit channel. The Chief-of-Staff configures that channel at runtime through two new admin MCP tools backed by one Mongo document, taking effect on the next audit post with no restart and no SIGUSR1.

## Key Points

- **Destination changes; the stream survives.** homeBase is removed as an audit destination entirely. May's ruling ("yes, May still wants to see the ops stream. In a 'special' agent/audit channel") authorizes routing, not suppression, so `silent`-class copies are routed rather than dropped.
- **⚠ Delegated decision, deliberate divergence from the ticket text.** The ticket assumed `policyFor` → `silent` means "no copy". Applied literally that deletes 298 of 317 mirrored turns — exactly the stream May said she wants. This spec keeps `policyFor` as the classifier but defines an audit-copy action table where only `skip` suppresses. The alternative table is a one-line change (D3); the volume that justifies routing is ~45 posts/day fleet-wide into one channel.
- **Measured impact:** 317 audit copies over 7 days leave the eleven `#agent-*` channels; ~45/day land in one channel a human can mute and read. `#agent-*` keeps human Slack conversation plus the cron/callback residue below.
- **The cron/callback half is explicitly out of scope, and named as such.** Cron and callback WorkItems are built with `kind: "slack"` and `source.id = homeBase`, so their replies are *primary deliveries*, not audit copies — 295 of the 593 non-human rows never touch `postAuditLog` at all. Gate 1's boundary ("suppress audit copies only — never intended deliveries") forbids this ticket from touching them. See the blocking open question in the final section.
- **CoS configurability is concrete, not gestured at:** new admin MCP tools `audit_channel_get` / `audit_channel_set`, one document `instance_settings/_id: "audit_routing"`, precedence *runtime override → `config.slack.auditChannel` → mirror off*. Access control is the existing `coreServers` whitelist — only agents that already carry `admin` can call it. No new permission model.
- **No default recipient (KPR-456 canon).** With no configured channel the mirror is simply off and warns at boot. The engine does not fall back to homeBase, May, Mokie, or any agent channel.
- **⚠ Deploy prerequisite, material:** `dodi` currently has `slack.auditChannel: agent-jessica`. Shipping without changing it routes the whole fleet's ops stream into one agent's own channel. The channel must be set to a dedicated one before or at deploy.
- **Small, necessary correctness change:** audit copies stop inheriting `meta.slackThreadTs`/`slackTs`. A thread timestamp from another channel is meaningless in the audit channel; copies post at top level.
- **Out of scope:** severities, escalation, ownership, recipients, dashboards, a second inbox, event emission, `activity_log` schema changes, any change to scheduler or delivery routing, and any dependency on KPR-458's unwritten policy.

## Scope and authority

Ticket: **KPR-452 — Audit mirror obeys `policyFor` / routes to `auditChannel` fallback instead of homeBase**. Parent: KPR-451. Worktree baseline: `epic/kpr-451` at `5d256ad88bbc8a2224e9e9ed3da55612f69c56fa`.

KPR-452 carried `needs-human-spec`. The gate is answered by May Huang on the ticket, verbatim:

> yes, May still wants to see the ops stream. In a "special" agent/audit channel I have to image. CoS should be able to configure what that channel is

That resolves the epic body's third open decision ("Scope for child 1: flag-to-fallback vs. off entirely") in favour of flag-to-fallback, and adds a runtime-configurability requirement. It does not authorize a second inbox a human must patrol, and it does not make the CoS a human routing layer.

KPR-452 has no dependency on any sibling and must not acquire one. Relevant canon from the KPR-451 Decision Register: KPR-456's rule that **no default recipient, severity, escalation, or new policy dependency may be supplied by an engineering child** binds D2 and D5 below; KPR-453's rule that runtime identity available in a handler does not authorize a new persisted field binds D5's document shape. This artifact follows the repository epic-artifact convention (`docs/epics/kpr-451/`) and the conventions in `CLAUDE.md`. Drafting does not approve an implementation plan.

## Problem and observed code

### What runs today

`postAuditLog` (`src/channels/dispatcher.ts:2458-2508`) formats a turn as `:incoming_envelope: *Agent* handled <kind> from <sender>: > <300-char summary> ($cost · Ns)` and delivers it. Its destination is `this.auditChannelIds.get(agentConfig.homeBase) ?? this.fallbackAuditChannelId` (`:2464`) — the agent's **own** `#agent-<id>` channel, with `config.slack.auditChannel` used only when homeBase cannot be resolved. `setAuditChannel` (`:268-272`) is the wiring; the three fields are `:193-195`. `index.ts:642-668` paginates `conversations.list` once at boot to build the name→id map and resolves the fallback id.

There are **three** call sites, not the two named on the ticket, each gated identically on `item.source.kind !== this.auditAdapter.kind`:

| Site | Path |
| --- | --- |
| `dispatcher.ts:528-530` | single-agent dispatch |
| `dispatcher.ts:1300-1310` | voice turns (fire-and-forget) |
| `dispatcher.ts:1885-1887` | multi-agent fan-out / conference |

`handleTurnFailure` posts no audit copy; errored turns are already mirror-free. `policyFor()` (`src/outage/outage-notices.ts:18-26`) classifies by reserved `WorkItem.id` prefix: `sched:` → `skip`, `callback:`/`event:`/`team-`/`worker:` → `silent`, everything else → `notify`. The audit mirror never calls it.

### Measurement (trailing 7 days, `hive_dodi`, 1471 turn rows)

Collected by a prior worker, excluding `recordKind: "delivery_receipt"` rows per KPR-456 canon (0 present in the window). `activity_log.channelKind` mirrors `WorkItem.source.kind`.

| channelKind | rows | `policyFor` class | reaches `postAuditLog` today |
| --- | --- | --- | --- |
| `slack`, human sender | 859 | notify | no (same kind as audit adapter) |
| `slack`, `sender: "system"` — cron | 99 | skip | **no** |
| `slack`, `sender: "system"` — callback | 196 | silent | **no** |
| `internal` — `team-` agent→agent | 277 | silent | yes |
| `internal` — `event:` | 21 | silent | yes |
| `voice` | 14 | notify | yes |
| `team` (iOS/ws, human) | 5 | notify | yes |

Runtime never emits `"scheduler"` or `"callback"` as a channelKind. Cron items are built at `src/scheduler/scheduler.ts:230-238` with `source: { kind: "slack", id: homeChannel }`; callbacks at `:288-299` with `kind: cb.source.channelKind || "slack"`. Per-agent skew is fleet-wide (mokie 310, gpt 200, fable 190, milo 157), not one outlier.

### The two consequences that shape this design

1. **The mirror carries 317 turns, and 298 of them are `silent`-class.** Applying the ticket's literal mechanism — suppress `silent`, route `notify` — would post 19 copies a week to the audit channel and delete the rest from Slack. `activity_log` retains turn *metadata* but not reply text; text durability for team/event traffic belongs to those subsystems and is not a guarantee this ticket makes. Deleting 298/317 contradicts the human ruling.
2. **Cron and callback replies are not audit copies.** They carry `kind: "slack"` and `source.id = homeBase`, so the outer gate excludes them and their posts into `#agent-<id>` are the turn's own delivery. 295 of the 593 non-human rows are in this class. Re-routing them is a delivery-routing change, not a mirror change.

## Goals and non-goals

**Goals.** Remove homeBase as an audit destination. Consult `policyFor()` as the single source classifier for audit copies. Route every surviving copy to one configured channel. Give the CoS a concrete runtime mechanism to choose that channel, with validation and honest failure. Preserve every intended delivery byte-for-byte.

**Non-goals.** Changing scheduler or callback source construction, delivery routing, or any WorkItem producer. Severity, ownership, escalation, or recipient policy (KPR-458 is unwritten and must not be pre-empted). New event types, tool-failure emission, readers, dashboards, `hive doctor` sections, or a web surface. `activity_log` schema changes. Per-agent or per-cron audit levers. Suppressing agent narration at its source. Slack scope additions (`channels:join` is not requested; the bot must be invited by a human). Any production channel creation or agent-definition edit.

## Design

### D1. One decision point

Move the entire mirror decision inside `postAuditLog`. The three call sites reduce to `if (this.auditAdapter) { … postAuditLog(workResult) … }`, preserving their existing await/fire-and-forget shapes. Do not leave a copy of the `source.kind` predicate at any call site: a second, drifting predicate is the failure mode KPR-416/KPR-420 were spent fixing, and the same discipline applies here.

The classification itself is a pure exported function in a new leaf module `src/audit/audit-routing.ts`, so it is testable without a Dispatcher:

```
auditCopyDecision(item: WorkItem, auditAdapterKind: ChannelKind):
  { post: boolean; reason: "same-kind" | "policy-skip" | "post" }
```

### D2. The audit-copy action table

Evaluated in order inside `postAuditLog`:

1. No `auditAdapter` → return. (Unchanged; also covers the boot window before `setAuditChannel` runs.)
2. `item.source.kind === auditAdapter.kind` → return, reason `same-kind`. The turn's own delivery already landed in Slack where a human can read it. This is the rule that keeps cron and callback out of scope.
3. `policyFor(item)`:
   - `"skip"` → return, reason `policy-skip`. Cron re-fires; a mirror would duplicate a re-firing job. Unreachable today because rule 2 catches cron first — retained for correctness if a future cron ever targets a non-Slack home.
   - `"silent"` → post. **This is the ops stream May asked to keep.**
   - `"notify"` → post. The human already has the answer in their own channel (SMS, voice, iOS); the copy exists so the ops stream shows non-Slack turns.
4. Resolve the destination (D4). If none resolves → no copy, warn.
5. If `item.source.id === channelId` → return. (Generalizes today's `:2472-2474` self-post guard, which was slack-kind-specific and is dead under rule 2.)

`policyFor` therefore governs *whether*, but in practice only excludes `skip`. That is the honest consequence of the human ruling, and it is stated here rather than dressed up. Calling `policyFor` rather than open-coding a prefix check is deliberate: it is the engine's one existing, tested source classifier, and a second one would drift. Note its documented caveat (`outage-notices.ts:8-13`): `team`-kind ids from the ws/iOS client are client-supplied, so a client id colliding with a reserved prefix misclassifies. Accepted unchanged — the blast radius here is one misrouted audit copy.

**⚠ The one-line alternative.** If a human later rules that `silent` should suppress instead of route, rule 3's `"silent"` branch becomes `return`. Nothing else in this design changes. State that in the implementation comment.

### D3. Destination and thread handling

The destination is always the resolved audit channel id. `agentConfig.homeBase` is no longer read by `postAuditLog`; the `homeBase ? … :` lookup at `:2464` is deleted.

The synthetic audit `WorkItem` currently forwards `meta.slackThreadTs` / `meta.slackTs` from the original item (`:2493-2496`), and `SlackAdapter.deliver` (`slack-adapter.ts:135-137`) uses those to thread. Under a fixed destination a timestamp from a different channel is meaningless. **Drop both meta keys**; audit copies post at top level in the audit channel. Everything else about the rendered copy — icon selection by source kind, 300-char truncation, cost/duration trailer, `agentId: "system"` (no signature, no identity override) — is unchanged.

### D4. Channel resolution

The dispatcher stores the audit channel **name** and resolves it to an id lazily.

- `setAuditChannelName(name: string | undefined)` — the effective name, `override ?? config.slack.auditChannel`, empty string treated as unset.
- `setAuditChannel(adapter, channelIdByName)` — the existing wiring site, minus its third parameter. `index.ts` no longer computes `fallbackAuditId`.
- Private `resolveAuditChannelId(): Promise<string | undefined>` — map lookup; on a miss, one `conversations.list` refresh through the already-wired `this.slackAdapter.client` (`setSlackAdapter`, `index.ts:633`; the getter is documented for exactly this use at `slack-adapter.ts:193-195`), rate-limited to at most once per 60 s, results merged into `auditChannelIds`. The refresh exists so a channel created after boot is usable without a restart; without it the CoS-configurability requirement is half-built.

Failure is quiet and honest: unresolved name → no copy, existing `log.warn` retained (its `homeBase` field replaced by the configured name), plus one boot-time warn when no name is configured at all. The mirror being off is never repaired by falling back to a channel nobody chose.

### D5. Runtime configuration by the CoS

**Storage.** New collection `instance_settings`, one document:

```
{ _id: "audit_routing", channelName: string, updatedAt: Date, updatedBy: string }
```

`updatedBy` is `AdminToolDeps.agentId`. No `workItemId` and no turn identity is persisted — KPR-453 canon: identity available inside a handler does not authorize a new write. No TTL, no index beyond `_id`. This ticket writes exactly this one document id.

**Precedence.** runtime override document → `config.slack.auditChannel` (`config.ts:317`, from `SLACK_AUDIT_CHANNEL` or `hive.slack.auditChannel`) → unset ⇒ mirror off.

**Reload semantics, stated plainly.** `config.slack.auditChannel` is read once into `config` at process start; changing it requires a `hive.yaml`/`.env` edit plus a restart, and this ticket does not change that. The override document is read once at boot and mutated in-process by the tool, and the dispatcher is the single in-memory holder — so a CoS change takes effect on the **next audit post**, with no restart. **SIGUSR1 does not reload it** (it reloads agent definitions); do not document or assume otherwise. A restart re-reads the document, so the override survives restarts and engine upgrades.

**Reachability.** `src/audit/audit-routing.ts` also exports a module-global accessor pair, following the `listPluginProviderIds` precedent already imported by `AgentRunner` (`agent-runner.ts:84`, consumed at `:1580`):

```
setAuditRoutingControl(c: AuditRoutingControl | undefined)
getAuditRoutingControl(): AuditRoutingControl | undefined
```

`AuditRoutingControl` is `{ ready(): boolean; describe(): Promise<string>; set(name, actor): Promise<{ ok, message }> }`, implemented in `index.ts` as closures over the dispatcher. The admin server imports only the accessor, never the Dispatcher, so no import cycle is created.

**Two admin MCP tools** in `src/admin/admin-mcp-server.ts`:

- `audit_channel_get` (no arguments) — reports the effective channel name, its source (`runtime override` / `hive.yaml` / `unset`), whether it currently resolves to a channel id, `updatedAt` / `updatedBy` when an override exists, and an advisory line when the effective name equals some agent's `homeBase`. The advisory never blocks anything; it exists because `dodi` is in that state today.
- `audit_channel_set` (`channel_name: string`) — normalizes (trim, strip one leading `#`, lowercase); rejects a raw Slack id (`^[CGD][A-Z0-9]{7,}$`) with a message asking for the channel name; rejects a name failing `^[a-z0-9_.-]{1,80}$`; resolves through D4's resolver and **rejects an unresolvable name without persisting it**, naming the two causes (the channel does not exist, or the bot cannot see it — invite the bot); on success writes the document and applies immediately. `channel_name: ""` clears the override and reverts to `config.slack.auditChannel`; the tool description must say so explicitly. When routing is not yet ready (a turn in the boot window), the tool says so and asks for a retry rather than reporting a spurious "channel not found".

Posting also requires the bot to be a member of the channel; `chat.postMessage` to a public channel the bot has not joined fails. This spec does not add `channels:join` — a human invites the bot, and a failure surfaces through the existing delivery warn path.

**Access control** is the existing per-agent `coreServers` whitelist: only agents that already carry `admin` can call these tools. On `dodi` that is the CoS. No new permission surface, no new autonomy flag.

**Lane B:** the inventory in `buildToolTransportInventory` (`agent-runner.ts:1337-1368`) is server-level and `admin` already has a stdio placeholder in the filtered map, so two new tools on an existing server require no KPR-390 inventory compensation and no new gate.

### D6. Boot order

The admin tools read the routing control **per spawn**, so the KPR-414 rule applies: `setAuditRoutingControl(...)`, the Mongo override load, and `dispatcher.setAuditChannelName(...)` must be wired **above** the `// ── Spawn-capable boundary ──` marker at `index.ts:474`. Add one anchor — `setAuditRoutingControl(` — to **all three** lists in `src/boot-order.test.ts` (presence at ~`:47`, order at ~`:65-69`, superset-sweep bound at ~`:91-95`).

`setAuditChannel(adapter, channelIdByName)` stays at its current site (`index.ts:661`), below the boundary, because it needs the Slack client. This is the same disjoint-valid-range shape as `workerPool.start()`: wiring above, Slack-dependent activation below. A turn landing in the window between them sees `auditAdapter` unset — `postAuditLog` returns at rule 1, exactly as today — and `audit_channel_get`/`set` report not-ready rather than a wrong answer.

## Acceptance criteria and verification contract

1. A `team-`-id `internal` item and an `event:`-id `internal` item each produce exactly one audit copy, addressed to the configured audit channel id and never to any `#agent-<id>`, for all three call sites.
2. A `sched:`-id item produces no audit copy even when its `source.kind` is not the audit adapter's kind.
3. A `slack`-sourced item — including a cron item (`kind: "slack"`, `sender: "system"`) and a callback item — produces no audit copy and its own delivery is byte-identical to the pre-change output. This is the Gate 1 boundary assertion and must be an explicit test, not an implied one.
4. `voice` and `team`(ws) items produce one copy each in the audit channel; the voice site remains fire-and-forget and a rejected audit post never fails the voice turn.
5. With no override and `config.slack.auditChannel` empty, no copy is posted, one warn is logged, and no homeBase channel is read. Assert the absence of a homeBase lookup, not merely the absence of a post.
6. Audit copies carry no `slackThreadTs`/`slackTs` in `meta`, and `SlackAdapter.deliver` therefore posts them untreaded.
7. `audit_channel_set` persists to `instance_settings/_id: "audit_routing"` with `updatedBy` equal to the calling agent id and no turn-identity field; the next audit post uses the new destination with no restart and no SIGUSR1. Round-trip through `audit_channel_get`.
8. `audit_channel_set` rejects — without persisting — a raw channel id, a syntactically invalid name, and a well-formed name that does not resolve; `""` clears the override and the effective name reverts to config.
9. The lazy `conversations.list` refresh fires at most once per 60 s and is not attempted when the Slack adapter is unset.
10. `src/boot-order.test.ts` fails if `setAuditRoutingControl(` moves below the boundary or below any spawn-capable surface.

Extend the existing Vitest seams: `src/channels/dispatcher.test.ts`, `src/channels/dispatcher-conference.test.ts` (fan-out site), `src/admin/admin-mcp-server.test.ts`, `src/boot-order.test.ts`, plus a new `src/audit/audit-routing.test.ts` for the pure decision function. Prefer behavioral assertions on destination and suppression over structural assertions on the refactor. Implementation must run targeted tests while changing the mirror, then `npm run check` before submission (`SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test`). Drafting makes no runtime success claim.

**Post-deploy verification (one-off, not an ongoing sweep):** re-run the trailing-7d `activity_log` distribution with `TURN_ACTIVITY_FILTER` (`src/activity/types.ts:58`) applied, and confirm `#agent-*` channel volume drops by approximately the `internal` + `voice` + `team` row count while `slack`-kind rows are unchanged.

## Deployment prerequisite and rollback

**Prerequisite (blocking at deploy, not at merge).** `dodi` has `slack.auditChannel: agent-jessica`. On the new code that value becomes the fleet-wide audit destination rather than a rarely-hit fallback, so every mirrored turn would land in one agent's own channel. Before or at deploy: create a dedicated channel, invite the bot, and set it — either in `hive.yaml` plus restart, or through `audit_channel_set` once the engine is running. Leaving it unset is also acceptable (mirror off, content still in `activity_log` metadata) but discards the stream May asked to keep.

**Rollback** is a code revert. No configuration knob is shipped for the routing behavior itself — consistent with KPR-416's precedent and with the operator preference against preemptive levers. The audit channel *name* is configurable; whether the mirror obeys `policyFor` is not.

## Assumptions and remaining decisions

- **BLOCKING (product, for the epic's stated outcome — not for implementing this spec): the cron/callback half.** 295 of 593 non-human rows per week post into `#agent-<id>` as the turn's *own* delivery (cron 99, callback 196). Gate 1's boundary forbids this ticket from touching them. Options, with tradeoffs: **(A) leave them** — zero regression risk, preserves every intended delivery, leaves ~42 posts/day fleet-wide (~4/day/agent) in the per-agent channels; **(B) retarget cron source to the audit channel** (`scheduler.ts:231`) — closes the gap, but silently relocates any cron whose deliverable *is* its reply text, and the engine cannot distinguish those from ops noise because no cron declares a destination today; **(C) suppress non-substantive replies** — requires a semantic judgment this epic has not authorized and KPR-458 has not written; reject. This spec assumes **(A)** and recommends the successor be sequenced after KPR-456 obligation adoption, since a registered obligation's explicit destination is precisely the missing fact that makes (B) safe. A human must confirm (A) is an acceptable partial win, or redirect.
- **⚠ Delegated, material:** `policyFor` → `silent` routes rather than suppresses, on the reading that May's "still wants to see the ops stream" refers to exactly the agent-to-agent traffic she described in `#conf-tahoe`. Non-blocking because it is a direct reading of the verbatim ruling, and reversible by one line (D2 rule 3).
- **⚠ Delegated:** runtime configuration lands in the admin MCP server behind the existing `coreServers` whitelist rather than a new tool surface, autonomy flag, or CLI command. Access is therefore exactly "agents that already administer agent definitions".
- **⚠ Delegated:** a new single-document `instance_settings` collection, rather than overloading `telemetry` or an agent definition. Instance-wide routing is not per-agent state.
- **⚠ Delegated:** dropping `slackThreadTs`/`slackTs` from audit copies. A cross-channel thread timestamp has no defined meaning at the new destination; the alternative (threading against a foreign ts) is undefined Slack behavior.
- **Non-blocking, observed:** `policyFor`'s documented client-supplied-id caveat now also affects audit routing. One misrouted copy is the worst case; no new mitigation is proposed.
- **Non-blocking, observed:** audit copies of `team-` traffic move from an agent's own channel into a shared one. Operators should pick an audit channel whose membership matches the audience that could already read the per-agent channels.
- **No default recipient, severity, or escalation is supplied**, per KPR-456 canon. An unconfigured instance runs with the mirror off.
