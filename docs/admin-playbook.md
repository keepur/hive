# Hive Admin Playbook

Admin operations for the beekeeper (Claude Code CLI) and human operators. The beekeeper is the sole platform admin for Hive — no in-hive agent has admin privileges.

## Quick Reference

| Operation | Method | Reload Required |
|-----------|--------|-----------------|
| Change model ceiling | Template edit | `setup:agents` + SIGUSR1 |
| Temporary model override | MongoDB | SIGUSR1 |
| Disable/enable agent | Template or MongoDB | SIGUSR1 |
| Change MCP server access | Template edit | `setup:agents` + SIGUSR1 |
| Update constitution | Template edit | `setup:agents` (syncs to MongoDB) |
| Override agent prompt | MongoDB | SIGUSR1 |
| Change budget/maxTurns | Template or MongoDB | SIGUSR1 |

---

## Reload & Restart

### Hot Reload (SIGUSR1)

Reloads agent configs, model overrides, config overrides, and prompt overrides from disk and MongoDB. No downtime.

```bash
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Full Restart

Kills and restarts the Hive service. Use when hot reload isn't sufficient (e.g., new MCP server code).

```bash
launchctl kickstart -k "gui/$(id -u)/com.hive.agent"
```

### Check Service Status

```bash
launchctl print "gui/$(id -u)/com.hive.agent" 2>&1 | head -5
```

### View Logs

```bash
# Real-time
tail -f ~/services/hive/hive.log

# Recent errors
grep '"level":"error"' ~/services/hive/hive.log | tail -20
```

---

## Model Management

### Change Model Ceiling (permanent)

Edit the agent's template, regenerate, and reload.

```bash
# Edit the model field in the template
# agents-templates/<agent-id>/agent.yaml.tpl → model: claude-sonnet-4-6

npm run setup:agents
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Temporary Model Override (survives restart, easy to revert)

```bash
mongosh hive --eval 'db.model_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: { model: "claude-sonnet-4-6", updatedAt: new Date(), updatedBy: "beekeeper" } },
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Reset Model to Default

```bash
mongosh hive --eval 'db.model_overrides.deleteOne({ agentId: "<agent-id>" })'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### List Active Model Overrides

```bash
mongosh hive --eval 'db.model_overrides.find().toArray()'
```

---

## Agent Lifecycle

### Disable an Agent (MongoDB — quick, reversible)

```bash
mongosh hive --eval 'db.agent_config_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: { disabled: true, updatedAt: new Date(), updatedBy: "beekeeper" } },
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Disable an Agent (template — permanent, in source control)

```bash
# Add `disabled: true` to agents-templates/<agent-id>/agent.yaml.tpl
npm run setup:agents
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Enable an Agent

```bash
# If disabled via MongoDB:
mongosh hive --eval 'db.agent_config_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $unset: { disabled: "" }, $set: { updatedAt: new Date() } }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")

# If disabled via template: remove `disabled: true` from agent.yaml.tpl, then:
npm run setup:agents
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Regenerate Agents from Templates

```bash
npm run setup:agents
# Note: this also prunes stale agent directories and syncs constitution to MongoDB
```

---

## Schedule Management

### View All Schedule Overrides

```bash
mongosh hive --eval 'db.schedule_overrides.find().toArray()'
```

### Disable an Agent's Schedule

```bash
mongosh hive --eval 'db.schedule_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: { schedule: null, updatedAt: new Date(), updatedBy: "beekeeper" } },
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Override an Agent's Schedule

```bash
mongosh hive --eval 'db.schedule_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: {
    schedule: [
      { cron: "0 9 * * 1-5", task: "morning-check" },
      { cron: "0 17 * * 1-5", task: "eod-summary" }
    ],
    updatedAt: new Date(),
    updatedBy: "beekeeper"
  }},
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Reset to YAML Defaults

```bash
mongosh hive --eval 'db.schedule_overrides.deleteOne({ agentId: "<agent-id>" })'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

---

## MCP Server Access

### Grant Server Access (template)

```bash
# Add server name to agents-templates/<agent-id>/agent.yaml.tpl
# Under servers.core: or servers.delegate:

npm run setup:agents
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Revoke Server Access (template)

```bash
# Remove server name from agent.yaml.tpl
npm run setup:agents
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Temporary Server Override (MongoDB)

Array override syntax: `{ replace: [...] }` for full replacement, `{ add: [...] }` to append, `{ remove: [...] }` to drop. These are processed by `applyConfigOverrides()` in agent-registry.

```bash
# Add a server to an agent's core servers
mongosh hive --eval 'db.agent_config_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: {
    coreServers: { add: ["browser"] },
    updatedAt: new Date(),
    updatedBy: "beekeeper"
  }},
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

Valid array fields: `channels`, `passiveChannels`, `keywords`, `coreServers`, `delegateServers`, `plugins`, `subscribe`.

---

## Constitution & Prompts

### Update Constitution

Edit the template, regenerate (which syncs to MongoDB automatically).

```bash
# Edit setup/templates/constitution-business.md.tpl
npm run setup:agents
# The setup script syncs constitution to MongoDB's memory collection
```

### Override Agent Soul/System Prompt (MongoDB)

```bash
mongosh hive --eval 'db.prompt_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: {
    soul: "New soul content here...",
    updatedAt: new Date(),
    updatedBy: "beekeeper"
  }},
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Reset Prompt Overrides

```bash
mongosh hive --eval 'db.prompt_overrides.deleteOne({ agentId: "<agent-id>" })'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

---

## Config Overrides

### View All Active Overrides

```bash
mongosh hive --eval 'db.agent_config_overrides.find().toArray()'
```

### Override Budget or Max Turns

```bash
mongosh hive --eval 'db.agent_config_overrides.updateOne(
  { agentId: "<agent-id>" },
  { $set: { budgetUsd: 25, maxTurns: 50, updatedAt: new Date(), updatedBy: "beekeeper" } },
  { upsert: true }
)'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

### Reset All Overrides for an Agent

```bash
mongosh hive --eval 'db.agent_config_overrides.deleteOne({ agentId: "<agent-id>" })'
kill -SIGUSR1 $(pgrep -f "node.*dist/index.js")
```

---

## Choosing Template vs MongoDB Override

| Use **template edits** when | Use **MongoDB overrides** when |
|------------------------------|-------------------------------|
| Change should be permanent | Change is temporary/experimental |
| Change should be in source control | Quick toggle (disable/enable) |
| Affects soul or system prompt identity | Runtime tuning (model, budget) |
| Part of a larger restructure | Emergency response |

Template changes require `npm run setup:agents` + SIGUSR1. MongoDB changes require only SIGUSR1.

---

## MongoDB Collections Reference

| Collection | Purpose |
|------------|---------|
| `model_overrides` | Per-agent model overrides |
| `agent_config_overrides` | Per-agent config overrides (channels, budget, disabled, etc.) |
| `prompt_overrides` | Per-agent soul/system prompt overrides |
| `schedule_overrides` | Per-agent schedule overrides |
| `memory` | Agent memory records (includes shared/constitution.md) |
| `memory_versions` | Memory version history |
| `agent_sessions` | Active agent session state |

---

## Deploy Upgrades with Migration Steps

Some releases require a one-shot migration or env-var change before restart. Run these from `~/services/hive` (the deploy clone) **before** `launchctl kickstart`.

### Issue #135 — core decontamination (2026-04-15)

Two manual steps required before restart:

1. **Set `RESEND_DEFAULT_BCC` in `.env`.** The old `HUBSPOT_BCC_OUTGOING` env var is no longer read (removing it was necessary because the name itself contaminated the customer bundle). Copy the existing value:
   ```bash
   grep HUBSPOT_BCC_OUTGOING .env  # note the current value
   echo "RESEND_DEFAULT_BCC=<value>" >> .env
   ```
   Without this, all outbound agent email silently stops being BCC'd.

2. **Migrate legacy `dodiOpsMode` on existing agent documents.** The field moved from a typed top-level field into `metadata.dodiOpsMode`. Existing Mongo docs still have the old shape; without migration, `sige` silently loses its readonly mode on dodi-ops.
   ```bash
   node scripts/migrate-agent-metadata.mjs
   ```
   Idempotent. Safe to re-run. Reports what it touched.

Then restart the service as usual (`launchctl kickstart -k "gui/$(id -u)/com.hive.agent"`).
