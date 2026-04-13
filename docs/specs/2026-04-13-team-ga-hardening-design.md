# Team Layer GA Hardening — Design

**Ticket:** [KPR-11](https://linear.app/keepur/issue/KPR-11)
**Date:** 2026-04-13
**Status:** Draft
**Blocked by:** KPR-10 (landed, commit `48f58e1`)
**Cross-repo:** keepur-ios (linked issue, can ship independently under this design)

## Summary

Team layer shipped today behind a `team.enabled` gate that was never turned on in a deployed config. The first real iOS tap surfaced five bugs in the same 10-minute session, all caused by the gate being dead code while the WS adapter still accepted team frames. This change removes the gate, fixes the bugs, and hardens the `/dm` path so a future client-side mistake cannot silently create junk DM rows.

A temporary `TEAM_ENABLED=true` workaround is active in `~/services/hive/.env` as of 2026-04-13 — it gets removed when this ships.

## Goals

- `team.enabled` removed from config, env, and all code paths.
- `team_channels` stays clean under adversarial client input.
- Tapping an agent in keepur-ios opens/creates a DM end-to-end.
- Unknown commands and unknown agent identifiers produce clear, actionable errors.
- Single ack per command.

## Non-Goals

- No new team features (roles, permissions, invitations, channel types).
- No error-code protocol — plain `{ type: "error", message }` strings, matching existing WS contract.
- No backfill — `team_channels` is verified empty.
- No lockstep deploy with iOS — design is explicitly resilient to iOS sending either agent id or display name.

## Design

### 1. Remove `team.enabled` gate

`team.enabled` is a dead feature flag. `src/index.ts:325` skips `teamStore` + `commandRegistry` construction when false, but `WsAdapter` still accepts team frames and falls over with `"Commands not available"`. The gate has no runtime purpose — team frames are always reachable via WS once the adapter is wired.

**Changes:**

- `src/config.ts` — drop `team.enabled` field and `TEAM_ENABLED` env var parsing.
- `src/index.ts` — always construct `TeamStore` and `CommandRegistry` when mongo is available. Remove `if (config.team.enabled)` branch.
- `src/channels/ws/ws-adapter.ts` — make `teamStore` and `commandRegistry` **non-optional** in `WsAdapterDeps`. Remove every defensive `?.` and null check around them — plan must enumerate all call sites (at minimum: `verifyChannelMembership`, `handleTeamMessage`, `handleTeamImage`, `handleTeamFile`, `handleCommand`, `handleCommandList`, `handleChannelList`, `handleHistory`). This is the real correctness win: the optionality was load-bearing for the bugs.
- Deploy cleanup: remove `TEAM_ENABLED=true` from `~/services/hive/.env` when this ships.

### 2. `/dm` command — rename from `/new` + agent validation

`/new` is never used in the wild. iOS sends `/dm`. Straight rename, no alias.

The `/dm` handler validates `args[0]` against the agent registry before calling `getOrCreateDm`. Per brainstorm: accepts **either agent id or display name** (case-insensitive). This closes the class of bugs where a client sends the wrong identifier shape — the current iOS code sends display name, and we want hive robust enough that future client bugs of the same kind cannot create junk rows.

**Resolver contract:**

```ts
type AgentResolver = (idOrName: string) => { id: string; name: string } | null;
```

- Built in `src/index.ts` as a closure over `AgentRegistry.getAll()`.
- Lookup: first try exact id match, then case-insensitive name match. First hit wins.
- Returns `null` on no match; `/dm` handler returns `"Unknown agent: <input>"`.

**Injection:** `CommandRegistry` constructor gains a second parameter, `agentResolver: AgentResolver`. The registry itself stays generic — only the `/dm` core-command closure uses it. This keeps `CommandRegistry` decoupled from `AgentRegistry` (easier tests, smaller blast radius).

**Handler behavior:**

```
/dm <idOrName>
  → if args[0] missing/empty: "Usage: /dm <agent-id-or-name>"
  → resolver lookup
  → if null: "Unknown agent: <input>"
  → else: teamStore.getOrCreateDm(senderId, resolved.id, senderName)
          return "DM ready: <channelId>"
```

Note: `getOrCreateDm` itself is **not** changed to validate — validation lives in the command handler where the agent registry is in scope. `getOrCreateDm` remains a low-level primitive. (If a future caller bypasses validation, it will be visible in code review — we accept that.)

### 3. Fix double-ack

`handleCommand` currently sends an ack at `ws-adapter.ts:627`, then on unknown-command fallthrough calls `handleTeamMessage`, which sends another ack. Remove the fallthrough entirely (see #4); the single ack at the top of `handleCommand` becomes the only one.

### 4. Unknown-command error

Current behavior: `/unknown foo` falls through to `handleTeamMessage` with `channelId` from the command frame, routes to `verifyChannelMembership`, and — because `ClientCommand` frames don't always carry a valid channel — returns the cryptic `"Channel not found"`.

New behavior: `handleCommand` checks `registry.get(name)` first. If not found, send `{ type: "error", message: "Unknown command: /<name>" }` and return. No fallthrough.

```
handleCommand:
  ack
  if (!registry.has(name)) → error "Unknown command: /<name>"; return
  execute; save result; reply
```

### 5. Tests

- `src/team/command-registry.test.ts`:
  - `/dm` with valid agent id → creates DM.
  - `/dm` with valid display name (case-insensitive) → creates DM.
  - `/dm` with unknown id → `"Unknown agent: ..."`, no DB write.
  - `/dm` with no args → `"Usage: /dm <agent-id-or-name>"`, no DB write.
  - `/new` no longer registered (negative test).
- WS adapter tests:
  - Unknown command returns `"Unknown command: /<name>"`.
  - Single ack on command execution.
  - `teamStore`/`commandRegistry` now required in `WsAdapterDeps` (type test / construction test).

## File-Level Change List

| File | Change |
|---|---|
| `src/config.ts` | Drop `team.enabled` field + `TEAM_ENABLED` parsing |
| `src/index.ts` | Unconditional `TeamStore` + `CommandRegistry` construction; build `AgentResolver` closure; pass to `CommandRegistry` |
| `src/channels/ws/ws-adapter.ts` | `teamStore`/`commandRegistry` non-optional; remove `?.` guards; `handleCommand` — unknown-command early error, remove fallthrough, single ack |
| `src/team/command-registry.ts` | Accept `AgentResolver` in ctor; rename `new` → `dm`; resolve + validate agent before `getOrCreateDm` |
| `src/team/command-registry.test.ts` | Update for new contract |
| `src/channels/ws/ws-adapter.test.ts` (if present) | Update for required deps + new error paths |
| `~/services/hive/.env` (deploy-time, not in repo) | Remove `TEAM_ENABLED=true` |

## Acceptance Criteria

- [ ] `team.enabled` gone from config, env parsing, and all code paths.
- [ ] `WsAdapterDeps.teamStore` and `.commandRegistry` are non-optional; no `?.` guards remain around them in `ws-adapter.ts`.
- [ ] `/dm <agent-id>` creates/opens a DM.
- [ ] `/dm <Display Name>` (case-insensitive) creates/opens a DM.
- [ ] `/dm not-a-real-agent` returns `"Unknown agent: not-a-real-agent"`, writes nothing to `team_channels`.
- [ ] `/unknown-command` returns `"Unknown command: /unknown-command"`, not `"Channel not found"`.
- [ ] Single ack per `ClientCommand` frame.
- [ ] `/new` is no longer registered.
- [ ] Deploy-time: `TEAM_ENABLED=true` removed from `~/services/hive/.env`.
- [ ] `npm run check` passes.

## Risks & Mitigations

- **iOS still sends display name.** Mitigated by design — name lookup is a first-class path, not a workaround. iOS fix becomes a cleanup, not a blocker.
- **Future caller bypassing `getOrCreateDm` validation.** Accepted — validation lives at the command boundary. A comment in `team-store.ts` is not needed; the one call site is the command handler.
- **Duplicate display names across agents.** First-hit-wins is deterministic over registry order. Today no two agents share a name; if they ever do, we add disambiguation then. YAGNI.

## Out of Scope (tracked elsewhere)

- keepur-ios `TeamViewModel.openAgentDM` sending `agent.id` instead of `agent.name`. Still worth doing for contract clarity, but no longer blocks hive deploy. Linked Linear issue.
