# KPR-103 — Slack MCP Cleanup (Seed Wording + Local-Stdio Default)

**Ticket:** [KPR-103](https://linear.app/keepur/issue/KPR-103)
**Source bug:** [KPR-97](https://linear.app/keepur/issue/KPR-97) (live-ops patched on dodi 2026-04-27)
**Branch:** `KPR-103-slack-mcp-cleanup`
**Worktree:** `~/github/hive-KPR-103`

## Problem

KPR-97 was a runtime symptom — Wyatt (and others) calling cloud Slack MCP `chat_postMessage` to "reply" to the conversation they were already handling, producing self-echo messages with the user-OAuth identity, plus a meta-narration text reply. Live patches on dodi:

1. `slack.localMcpServer: true` added to `~/services/hive/dodi/hive.yaml`.
2. Constitution `shared/constitution.md` re-rendered to include the message-delivery rule.
3. Five agent system prompts (jessica, river, sige, milo, jasper) had their universal "always prefix" instruction scoped to cross-channel-only.

Runtime healed, but **source-of-truth gaps remain**:

- Seed YAMLs in `plugins/dodi/agent-seeds/` advertise "Slack MCP — search messages, read channels, send messages" with no caveat. New instances re-inherit the bug.
- `src/config.ts` defaults `slack.localMcpServer` to `false`, so a fresh `hive init` falls back to the cloud MCP path with user-OAuth identity.

## Scope

This plan covers two source-of-truth fixes. Three is out of scope (durable systemic fix is the `hive-baseline` frame's `message-delivery` constitution anchor — KPR-86, gated on KPR-99/100).

### 1. Seed wording sweep

Audit results (`grep` for `Slack MCP` in all seed YAMLs):

| File | Line | Current | Action |
|------|------|---------|--------|
| `plugins/dodi/agent-seeds/customer-success.yaml` | 125 | `**Slack MCP** — search messages, read channels` | Rewrite |
| `plugins/dodi/agent-seeds/devops.yaml` | 149 | `**Slack MCP** — search messages, read channels` | Rewrite |
| `plugins/dodi/agent-seeds/marketing-manager.yaml` | 93 | `**Slack MCP** — search messages, read channels, send messages` | Rewrite |
| `plugins/dodi/agent-seeds/product-manager.yaml` | 140 | `**Slack MCP** — search messages, read channels, send messages` | Rewrite |
| `plugins/dodi/agent-seeds/product-specialist.yaml` | 87 | `**Slack MCP** — search messages, read channels, send messages` | Rewrite |
| `plugins/dodi/agent-seeds/production-support.yaml` | 171 | `**Slack MCP** — for escalation and communication with the team` | Rewrite |
| `plugins/dodi/agent-seeds/sdr.yaml` | 117 | `**Slack MCP** — search messages, read channels, post updates` | Rewrite |

**Untouched files** (no Slack MCP advertisement):

- `plugins/dodi/agent-seeds/executive-assistant.yaml` — references "post in their Slack channel" as routing description, but does not list `slack` in coreServers/delegateServers and doesn't advertise Slack MCP as a tool. Routing receptionist channel-posting is a separate concern (would need `slack` in core servers to function, but that's not regressing anything new). Not in this ticket's scope.
- `plugins/dodi/agent-seeds/vp-engineering.yaml` — no Slack MCP block.
- `seeds/chief-of-staff/agent.yaml` — no Slack MCP block.

**Canonical replacement.** Two-tier wording (active senders get the cross-channel guidance; passive receivers/searchers stay short):

For agents that need outbound posting (marketing-manager, product-manager, product-specialist, sdr, production-support):

```
- **Slack MCP** — `slack_search_messages`, `slack_read_channel`, plus `slack_send_message` for **outbound cross-channel posts only** (another agent's channel, scheduled digests, broadcasts). When you post cross-channel, prefix with `:emoji: **Name**:` so recipients can identify you. **Do NOT use `slack_send_message` to reply to the conversation you're currently handling** — replies go out automatically as the text you return. See the constitution's Message Delivery section.
```

For search-only agents (customer-success, devops):

```
- **Slack MCP** — `slack_search_messages`, `slack_read_channel` for searching and reading. You don't post cross-channel; replies to the conversation you're handling go out automatically as the text you return.
```

This matches the constitution-bootstrap canonical at `templates/constitution-bootstrap.md.tpl:107-121` and the dodi-DB rewrites already applied 2026-04-27.

**Note on the "always prefix" instruction:** none of the seed YAMLs contain it (verified by `grep -i "prefix"`). The 5 dodi agents that had it (jessica, river, sige, milo, jasper) had it added directly via DB writes after seed import — so the seed source is already clean on that axis. No strip pass needed.

### 2. Universal Slack-MCP default — engine flip

**Decision: option (a)** — flip `src/config.ts:105` to default `true`.

Rationale:
- Cloud MCP path stays in code (not removed — out of scope per ticket).
- Operators with a legitimate reason to keep cloud MCP (none known, but possible) can opt-out via `slack.localMcpServer: false` in their `hive.yaml`.
- Bootstrap doesn't generate a fresh `hive.yaml` slack section — `setup/setup-instance.ts` only writes the `instance` block. So changing the engine default is the only way to flip new instances without new install logic.
- The `hive.yaml.example` already mentions the flag — update its comment to reflect the new default.

**Edits:**

```diff
# src/config.ts:105
-    localMcpServer: Boolean(hive.slack?.localMcpServer ?? false),
+    localMcpServer: Boolean(hive.slack?.localMcpServer ?? true),
```

```diff
# hive.yaml.example (around the slack: block)
-#   localMcpServer: false   # set true to use local bot-token Slack MCP instead of hosted MCP
+#   localMcpServer: true    # local bot-token Slack MCP (default). Set false to fall back to cloud MCP (user-OAuth identity — not recommended).
```

No new test for the default — existing config code is untouched at the type level, default literal change. The behavior contract is captured in `docs/specs/2026-04-18-slack-self-echo-fix-design.md`.

### 3. hive-baseline frame note

Out of scope per ticket. The durable systemic fix is the `hive-baseline` frame's `message-delivery` constitution anchor (KPR-86), gated on KPR-99 + KPR-100 engine fixes. PR description should call this out so the reviewer knows where the long-term mitigation lives.

## Implementation order

Single PR, three commits:

1. **Commit 1** — `KPR-103: rewrite Slack MCP advertisements in dodi agent seeds`
   - 7 seed YAMLs touched; only the relevant `Slack MCP` line rewritten in each.
2. **Commit 2** — `KPR-103: default slack.localMcpServer to true`
   - `src/config.ts:105` flip + `hive.yaml.example` comment update.
3. (No third commit — plan doc is committed separately as part of `dodi-dev:write-plan` pickup, but in this case I'll fold it into commit 1 since this is a quick cleanup ticket.)

## Verification

1. **`npm run check`** must pass (typecheck + lint + format + test).
2. **Diff review** — confirm:
   - YAML structure preserved (no shifted keys, no broken indentation).
   - Each seed has the right tier of replacement (active-sender vs search-only).
   - `src/config.ts` change is the literal `false` → `true`.
3. **No live `setup:seeds` runs.** This is verified by inspection only — running setup:seeds against a live instance would be too disruptive. The engine default flip is verified by code review against the existing `localMcpServer` reads in `agent-runner.ts:325` and `index.ts:331`.

## Out of scope

- Removing the cloud Slack MCP code path (`agent-runner.ts:336-345`). Ticket explicitly defers this.
- Personal-instance seeds (`seeds/chief-of-staff/agent.yaml`) — no Slack MCP block exists there.
- `executive-assistant.yaml` cross-channel routing config — separate concern (agent doesn't have `slack` in coreServers; can't currently post cross-channel anyway).
- `tune-instance` audit additions for these patterns — separate enhancement on KPR-72.
- Strip "always prefix" instruction from seeds — no seed contains this instruction; dodi DB-only artifact.

## Acceptance check (ticket criteria)

- [x] Plan: All seed YAMLs in `plugins/dodi/agent-seeds/` and `seeds/` audited; corrected wording authored above.
- [x] Plan: Engine default `slack.localMcpServer: true` flipped in `src/config.ts`.
- [x] Plan: Decision recorded — option (a) (engine default flip), cloud MCP path retained.
- [x] Plan: Verification path = code review + diff inspection (no live setup:seeds run).
