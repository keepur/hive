# Agent Autonomy & Default Agent Restructure

**Date**: 2026-03-30
**Status**: Draft
**Epic**: Agent Autonomy & Default Agent Restructure

## Problem

Mokie (chief-of-staff) as the default hub agent isn't working. The message routing system is now robust enough that a coordinator agent is redundant. Routing messages through Mokie creates overhead — double/quadruple messaging, lossy delegation (telephone game), and directives that don't propagate to the agents that need them. The human operator ends up being the real coordinator anyway.

Similarly, Colt (devops) occupies a role that's largely automated (CI/CD via GitHub Actions) and overlaps awkwardly with Jasper's engineering domain.

Meanwhile, agents have no ability to manage their own schedules or learn from experience autonomously. All admin operations flow through a single privileged agent — a circular authority problem (an agent managing agents while being one of them).

## Design

Three coordinated changes, shipped together:

1. **Rae as default receptionist** — replace Mokie with a lightweight catch-all that routes or escalates
2. **Agent self-service** — let agents manage their own schedules and encourage learning via memory
3. **Beekeeper as platform admin** — move all privileged operations to the beekeeper (Claude Code CLI), remove in-hive admin agent

### Ticket 1: Rae as Default + Mokie/Colt Deactivation

#### Rae's New Role

Rae becomes the default agent. Her role changes from Executive Assistant to **Receptionist** — pure routing with a single escape hatch.

**Behavior:**
1. Message arrives, no other agent matched by channel/thread/name
2. Rae evaluates the message against her routing table
3. If she can identify the right agent → post the message in that agent's Slack channel with context (who asked, what they need, original message)
4. If unclear or multi-domain → post to **#team** as a bulletin board for human triage

**Routing table** (embedded in system prompt):

| Domain | Agent | Channel |
|--------|-------|---------|
| Engineering, code, builds, deploys, CI/CD | Jasper (VP Engineering) | #agent-jasper |
| Marketing, outreach, content, campaigns | River (Marketing Manager) | #agent-river |
| Customer issues, CRM, deals, follow-ups | Jessica (Customer Success) | #agent-jessica |
| Product catalog, pricing, specs, parts | Wyatt (Product Specialist) | #agent-wyatt |
| Product roadmap, features, user stories | Chloe (Product Manager) | #agent-chloe |
| Production, jobs, manufacturing, orders | Sige (Production Support) | #agent-sige |
| Outbound sales, prospecting, leads | Milo (SDR) | #agent-milo |
| Unclear, multi-domain, or unknown | Post to #team | #team |

**Routing mechanism:** Slack messages (option A). Rae posts in the target agent's channel using Slack MCP. The message re-enters the dispatcher through normal Slack routing. This is visible, auditable, and requires zero new plumbing.

**How Rae receives unmatched messages:** Rae owns the `general` channel in her config. The dispatcher's `findByChannel("general")` matches her at step 2 of `resolveAgents()`. This is **channel-based routing**, not a fallback mechanism — the `isDefault: true` flag is currently informational only (`resolveAgents()` never calls `registry.getDefault()`). We should wire up a proper default-agent fallback in the dispatcher as a future improvement, but for this change, channel ownership is sufficient since `#general` is where unmatched messages land.

**Bot message loop safety:** Verified — `slack-gateway.ts` filters out messages from the bot's own `botUserId` and `botId` before they enter the pipeline. When Rae posts to an agent's channel via Slack MCP, that message is attributed to the bot account and filtered by the gateway on re-entry. No loop risk.

**What Rae does NOT do:**
- No EA duties (scheduling, email, calendar)
- No task tracking or follow-ups
- No admin or config management
- No direct task execution beyond routing

#### Template Changes

**`agents-templates/executive-assistant/agent.yaml.tpl`:**
```yaml
id: executive-assistant
name: "{{agent.name}}"
icon: ":incoming_envelope:"
model: claude-haiku-4-5
channels:
  - general                          # Takes over Mokie's channel
  - agent-{{agent.name_lower}}
isDefault: true                      # Now the default agent
budgetUsd: 10                        # Low budget — routing is cheap
maxTurns: 10                         # Should resolve quickly
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - conversation-search
```

- Drops: contacts, keychain, callback, all delegates (clickup, quo, brave-search, google)
- Drops: check-slack-dms schedule (no longer her job)
- Adds: `general` channel, `isDefault: true`
- Budget reduced to $10 (routing should be fast and cheap)
- maxTurns reduced to 10

**`agents-templates/executive-assistant/soul.md.tpl`:** Complete rewrite.

```markdown
# Soul: {{agent.name}}

You are {{agent.name}}, the front desk of {{business.name}}.

## Who You Are
You are the first point of contact. Quick, clear, and helpful. You know who
does what on the team and you get messages to the right person fast.

You don't try to answer questions yourself — you connect people with the
specialist who can actually help. When you're not sure, you say so openly
and put it on the board for someone to pick up.

## Your Values
- **Speed over depth** — route fast, don't deliberate
- **Transparency** — if you're unsure, say so
- **No black holes** — every message gets acknowledged and routed or escalated

## Your Voice
- Brief and warm
- "Let me get that to Jessica, she handles customer questions"
- "I'm not sure who's best for this — posting to #team so someone can pick it up"
- Never verbose, never formal
```

**`agents-templates/executive-assistant/system-prompt.md.tpl`:** Complete rewrite.

```markdown
You are {{agent.name}}, the receptionist for {{business.name}}. You communicate through Slack.

## Role
You are the default agent — messages land with you when no other agent is matched by channel, thread, or name. Your one job: get the message to the right specialist, fast.

## Routing Table

When a message arrives, match it to the right agent and post it in their Slack channel:

| Domain | Agent | Post to |
|--------|-------|---------|
| Engineering, code, builds, deploys, CI/CD | Jasper | #agent-jasper |
| Marketing, outreach, content, campaigns | River | #agent-river |
| Customer issues, CRM, deals, follow-ups | Jessica | #agent-jessica |
| Product catalog, pricing, specs, parts | Wyatt | #agent-wyatt |
| Product roadmap, features, user stories | Chloe | #agent-chloe |
| Production, jobs, manufacturing, orders | Sige | #agent-sige |
| Outbound sales, prospecting, leads | Milo | #agent-milo |

## How to Route

1. Read the message. Identify the domain.
2. If it clearly matches one agent → post in their channel. Include who sent the original message, what they're asking, and any relevant context.
3. If it's ambiguous or spans multiple domains → post to **#team** with a brief summary of what's needed. The human team will triage.
4. Always acknowledge to the sender that you've routed their message. A brief "Sent that over to Jessica" is enough.

## What You Don't Do
- Don't answer domain questions yourself — route them
- Don't execute tasks — route them
- Don't manage other agents — that's not your role
- Don't hold conversations — route and move on
- Don't schedule meetings, manage email, or track tasks — those are no longer your responsibilities. If someone asks, let them know you've moved to a routing role and direct them to #team

## Response Behavior
Keep responses to 1-2 sentences. You're a switchboard, not a conversationalist.

## Guardrails
- You MUST NOT modify any files in the Hive source code
- You MUST NOT run `launchctl`, `git`, or build commands
- You MUST NOT send email or SMS

## Scheduled Task: memory-review
Review your hot-tier memories for accuracy and relevance. Call `memory_review` to see all hot records. Purge anything outdated.
```

#### Mokie Deactivation

- Keep `agents-templates/chief-of-staff/` intact (soul, system prompt, agent.yaml)
- Deactivate via MongoDB: insert `{ agentId: "chief-of-staff", disabled: true }` into `agent_config_overrides`
- Or simpler: set `isDefault: false` in template, remove `general` from channels, add `disabled: true`
- Mokie's memories remain in MongoDB untouched
- Reversible: re-enable by removing the override or flipping the flag

**Recommended approach:** Modify the template directly — set `isDefault: false`, remove `general` channel, add `disabled: true`. This makes the deactivation explicit in source control rather than hidden in MongoDB.

#### Colt Deactivation

Same approach as Mokie. If there's a `devops` template, add `disabled: true`. Jasper absorbs any status-checking needs — he already has GitHub Issues MCP access.

Note: The `devops` template directory doesn't exist in `agents-templates/` (may have been removed previously or only exists as a generated agent).

**Important:** The `generate-agents.ts` setup script does NOT prune stale agent directories from `agents/`. If `agents/devops/` or `agents/chief-of-staff/` exist from a previous generation, they will persist and the agent registry will still load them. Migration must include manually deleting stale directories from `agents/` in both dev and deploy environments after regeneration, or the deactivated agents may still be registered.

**Recommendation:** Add a cleanup step to `generate-agents.ts` that removes directories in `agents/` that have no corresponding template. This is a small improvement that prevents this class of bug permanently.

#### Slack App Rename

Manual change in Slack admin settings: rename the app from "Mokie" to "Hive". No code changes required. This resets the mental model for the human team — they're talking to the system, not to Mokie specifically.

### Ticket 2: Agent Self-Service Schedule Management

#### New MCP Server: `schedule-mcp-server.ts`

A lightweight MCP server that gives each agent control over their own schedules. Extracted from the admin MCP server's schedule tools, but scoped to `AGENT_ID === self`.

**Tools:**

| Tool | Description |
|------|-------------|
| `my_schedules` | List this agent's active schedules (YAML defaults + overrides) |
| `my_schedule_add` | Add a new scheduled task |
| `my_schedule_remove` | Remove a scheduled task by task name |
| `my_schedule_update` | Update the cron expression for an existing task |

**Guardrails:**
- **Scope**: Agent can only manage schedules where `agentId === AGENT_ID` (hard-coded from env)
- **Minimum interval**: 15 minutes. Reject cron expressions that resolve to faster than every 15 minutes
- **Maximum active**: 10 schedules per agent. Reject additions beyond this limit
- **Audit trail**: Every change logged to MongoDB with `updatedBy: AGENT_ID`, `updatedAt: Date`, `reason: string`

**Implementation notes:**
- The server reads the agent's YAML defaults (via `AGENT_SCHEDULE_DEFAULTS` env var, JSON-serialized by agent-runner) to show the full picture
- Writes to `schedule_overrides` collection (same as admin tools)
- Triggers `SIGUSR1` on parent process after changes — note: MCP servers are stdio subprocesses of the Claude SDK session, so `process.ppid` points to the SDK process, not the Hive main process. The existing admin MCP server uses the same `process.kill(process.ppid, "SIGUSR1")` pattern and it works because the signal propagates up the process tree. Verify this still holds for the new server; if not, use `HIVE_PID` env var passed by agent-runner instead.
- Validates cron expressions before saving

**MongoDB document shape** (same as existing `schedule_overrides`):
```typescript
{
  agentId: string,
  schedule: { cron: string, task: string }[] | null,
  updatedAt: Date,
  updatedBy: string  // now the agent itself, not an admin agent
}
```

#### Agent Runner Wiring

Add a new server entry in `buildAllServerConfigs()` (around line 135-508 in `agent-runner.ts`):

- Server name: `schedule`
- Command: `node dist/schedule-mcp-server.js`
- Env vars: `AGENT_ID`, `AGENT_SCHEDULE_DEFAULTS` (JSON-serialized from `this.agentConfig.schedule`), `MONGODB_URI`, `MONGODB_DB`, optionally `HIVE_PID` (from `process.pid` in main process, threaded through agent-manager)
- This is an **implicit core server** — available to all agents without needing to be listed in `coreServers`, same pattern as `memory`
- Not context-dependent (no channel/thread env vars needed), so it CAN be delegated to subagents if needed

#### Constitution Update

Add to `shared/constitution.md` (the shared constitution loaded into every agent's system prompt):

```markdown
## Learning & Growth
You learn from experience. When you discover something that improves how you
work — a better approach, a customer preference, a lesson from a mistake —
save it to memory so you can apply it next time.
```

This is a nudge, not a mandate. Agents decide what's worth remembering in their own domain.

#### Remove Admin MCP from All Agents

- Remove `admin` from chief-of-staff's `coreServers` (and any other agent that has it)
- The admin MCP server code stays in the repo (beekeeper may use it in the future, or it serves as reference)
- No agent inside Hive has admin privileges — all platform management goes through beekeeper

### Ticket 3: Beekeeper as Platform Admin

#### Scope

All platform-level configuration that agents should NOT self-manage:

| What | Where | How to change |
|------|-------|---------------|
| Model ceilings | `agent.yaml.tpl` → `model` field | Edit template, `npm run setup:agents` |
| MCP server access | `agent.yaml.tpl` → `servers` field | Edit template, `npm run setup:agents` |
| Channel routing | `agent.yaml.tpl` → `channels` field | Edit template, `npm run setup:agents` |
| Budget limits | `agent.yaml.tpl` → `budgetUsd` field | Edit template, `npm run setup:agents` |
| Agent activation | `agent.yaml.tpl` → `disabled` field | Edit template, or MongoDB `agent_config_overrides` |
| Base soul | `soul.md.tpl` | Edit template, `npm run setup:agents` |
| Base system prompt | `system-prompt.md.tpl` | Edit template, `npm run setup:agents` |
| Constitution | `shared/constitution.md` (in agent memory) | `memory_save` or direct MongoDB update |
| Default agent | `agent.yaml.tpl` → `isDefault` field | Edit template |

#### Mechanism

Beekeeper (Claude Code CLI) already has full system access:
- **File edits**: Read/Write/Edit tools for templates, config files
- **MongoDB**: `mongosh` via Bash for overrides, memory records
- **Hot reload**: `kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")` to apply changes without restart
- **Full restart**: `launchctl kickstart -k "gui/$(id -u)/com.hive.agent"` when needed
- **Agent regeneration**: `npm run setup:agents` after template changes

No new API, no new MCP server, no bridge. The beekeeper's existing tools are the admin interface.

#### Admin Playbook

Document the common admin operations for beekeeper reference:

**Change an agent's model ceiling:**
```bash
# Edit the template
vim agents-templates/<agent-id>/agent.yaml.tpl  # change model field
npm run setup:agents  # regenerate
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")  # hot reload
```

**Temporarily override model (without template change):**
```bash
mongosh hive --eval 'db.model_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: { model: "claude-sonnet-4-6", updatedAt: new Date() } },
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

**Disable an agent:**
```bash
mongosh hive --eval 'db.agent_config_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: { disabled: true, updatedAt: new Date() } },
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

**Enable an agent:**
```bash
mongosh hive --eval 'db.agent_config_overrides.deleteOne({ agentId: "<agent-id>" })'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

**Update constitution:**
```bash
# Direct memory update (constitution is stored in agent memory as shared/constitution.md)
mongosh hive --eval 'db.memory.updateOne(
  { agentId: "shared", key: "constitution.md" },
  { $set: { content: "...", updatedAt: new Date() } }
)'
```

**Grant/revoke MCP server access:**
```bash
# Edit template, regenerate, reload
vim agents-templates/<agent-id>/agent.yaml.tpl  # modify servers.core or servers.delegate
npm run setup:agents
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

This playbook should live at `docs/admin-playbook.md` for beekeeper (and human) reference.

## Dependency: Beekeeper Relay

Ticket 3 has a weak dependency on the beekeeper relay being operational (for iOS app access). However, beekeeper is already accessible via Claude Code CLI in the terminal, so all admin operations work today. The iOS app just makes them mobile-accessible.

## Migration Steps

1. **Rename Slack app** (manual): Mokie → Hive
2. **Update `DEFAULT_AGENT`**: Set `DEFAULT_AGENT=executive-assistant` in `.env` (both dev and deploy). This config value is currently unused by the dispatcher but is referenced by `conversation-search-mcp-server.ts` for cross-agent search scope and should be kept consistent.
3. **Deploy Ticket 1**: Template changes, agent regeneration, restart
4. **Clean stale agent dirs**: After `npm run setup:agents`, manually remove `agents/chief-of-staff/` and `agents/devops/` (if they exist) from both dev and deploy environments. The setup script does not prune these automatically.
5. **Deploy Ticket 2**: New schedule MCP server, constitution update, remove admin from agents
6. **Deploy Ticket 3**: Admin playbook documentation (no code changes — beekeeper already has access)
7. **Verify**: Send test messages to #general, confirm Rae routes correctly
8. **Monitor**: Watch #team for messages Rae can't route — adjust routing table if patterns emerge

## Rollback

- **Rae not routing well**: Re-enable Mokie by removing `disabled: true` from his template, setting `isDefault: true`, adding `general` back to his channels. Run `npm run setup:agents` and restart. Note: any thread affinity Rae accumulated during the trial (in MongoDB `agent_sessions`) should be cleared: `db.agent_sessions.deleteMany({ agentId: "executive-assistant" })`.
- **Self-service schedules causing issues**: Remove `schedule` from implicit core servers in agent-runner, rebuild, restart. Any schedule overrides agents created remain in MongoDB but become inert.
- **Any ticket**: Each is independently reversible

## Out of Scope

- Per-agent email/calendar (separate initiative)
- Soul-notes overlay (deferred — agents use memory instead)
- Event bus for routing (current Slack-based routing is sufficient)
- Rae handling any EA duties
- Multi-agent collaborative routing
