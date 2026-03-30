# Beekeeper as Platform Admin

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Document the beekeeper (Claude Code CLI) as the sole platform admin for Hive, with a comprehensive admin playbook of copy-paste commands.

**Architecture:** No new code. The beekeeper already has full system access via its native tools. This ticket produces documentation only.

**Tech Stack:** Markdown

**Closes:** #61

---

### Task 1: Write admin playbook

**Files:**
- Create: `docs/admin-playbook.md`

- [ ] **Step 1:** Create `docs/admin-playbook.md` with the full admin operations reference

The playbook should cover:

1. **Model Management**
   - Change model ceiling (template edit + regenerate)
   - Temporary model override (MongoDB, survives until removed)
   - Reset model to default
   - List active overrides

2. **Agent Lifecycle**
   - Disable an agent (template or MongoDB)
   - Enable an agent
   - Create a new agent from template
   - Full deactivation (template + cleanup)

3. **Schedule Management**
   - View all schedule overrides
   - Disable agent's schedule
   - Override schedule
   - Reset to YAML defaults

4. **MCP Server Access**
   - Grant server access (template edit)
   - Revoke server access
   - Temporary override via MongoDB

5. **Constitution & Prompts**
   - Update constitution (template + MongoDB sync)
   - Override agent soul/system prompt (MongoDB)
   - Reset prompt overrides

6. **Operational**
   - Hot reload (SIGUSR1)
   - Full restart (launchctl)
   - Regenerate agents from templates
   - Check service status
   - View logs

Each section should have:
- What it does
- Copy-paste commands (mongosh, kill, launchctl, npm)
- Which approach to use when (template vs MongoDB override)

Use the instance ID variable pattern: commands should reference `hive` as the default but note the instance ID convention.

- [ ] **Step 2:** Commit

```bash
git add docs/admin-playbook.md
git commit -m "docs(#61): add beekeeper admin playbook

Comprehensive admin operations reference for the beekeeper (Claude Code
CLI) as sole platform admin. Covers model management, agent lifecycle,
schedules, MCP access, constitution, and operational commands."
```
