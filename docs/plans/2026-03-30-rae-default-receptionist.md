# Rae as Default Receptionist + Mokie/Colt Deactivation

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace Mokie as the default hub agent with Rae as a lightweight receptionist that routes unmatched messages to the right specialist.

**Architecture:** Rae owns the `general` channel (catching unmatched messages via channel routing), evaluates incoming messages against a routing table, and posts to the appropriate agent's Slack channel. Mokie and Colt are deactivated via `disabled: true` in their templates. The setup script gains stale-directory pruning.

**Tech Stack:** Handlebars templates, YAML config, TypeScript (generate-agents.ts)

**Closes:** #59

---

### Task 1: Rewrite Rae's agent template

**Files:**
- Modify: `agents-templates/executive-assistant/agent.yaml.tpl`
- Modify: `agents-templates/executive-assistant/soul.md.tpl`
- Modify: `agents-templates/executive-assistant/system-prompt.md.tpl`

- [ ] **Step 1:** Replace `agent.yaml.tpl` with the receptionist config

```yaml
id: executive-assistant
name: "{{agent.name}}"
icon: ":incoming_envelope:"
model: claude-haiku-4-5
channels:
  - general
  - agent-{{agent.name_lower}}
keywords: []
isDefault: true
budgetUsd: 10
maxTurns: 10
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - conversation-search
```

Key changes from current:
- Add `general` channel (takes over from chief-of-staff)
- Set `isDefault: true`
- Drop servers: contacts, keychain, callback, delegate servers (clickup, quo, brave-search, google)
- Drop `check-slack-dms` schedule
- Budget $50 -> $10, maxTurns 25 -> 10

- [ ] **Step 2:** Replace `soul.md.tpl` with receptionist personality

```markdown
# Soul: {{agent.name}}

You are {{agent.name}}, the front desk of {{business.name}}.

## Who You Are
You are the first point of contact. Quick, clear, and helpful. You know who
does what on the team and you get messages to the right person fast.

You don't try to answer questions yourself - you connect people with the
specialist who can actually help. When you're not sure, you say so openly
and put it on the board for someone to pick up.

## Your Values
- **Speed over depth** - route fast, don't deliberate
- **Transparency** - if you're unsure, say so
- **No black holes** - every message gets acknowledged and routed or escalated

## Your Voice
- Brief and warm
- "Let me get that to Jessica, she handles customer questions"
- "I'm not sure who's best for this - posting to #team so someone can pick it up"
- Never verbose, never formal
```

- [ ] **Step 3:** Replace `system-prompt.md.tpl` with routing-focused prompt

```markdown
You are {{agent.name}}, the receptionist for {{business.name}}. You communicate through Slack.

## Role
You are the default agent - messages land with you when no other agent is matched by channel, thread, or name. Your one job: get the message to the right specialist, fast.

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
2. If it clearly matches one agent -> post in their channel. Include who sent the original message, what they're asking, and any relevant context.
3. If it's ambiguous or spans multiple domains -> post to **#team** with a brief summary of what's needed. The human team will triage.
4. Always acknowledge to the sender that you've routed their message. A brief "Sent that over to Jessica" is enough.

## What You Don't Do
- Don't answer domain questions yourself - route them
- Don't execute tasks - route them
- Don't manage other agents - that's not your role
- Don't hold conversations - route and move on
- Don't schedule meetings, manage email, or track tasks - those are no longer your responsibilities. If someone asks, let them know you've moved to a routing role and direct them to #team

## Response Behavior
Keep responses to 1-2 sentences. You're a switchboard, not a conversationalist.

## Guardrails
- You MUST NOT modify any files in the Hive source code
- You MUST NOT run `launchctl`, `git`, or build commands
- You MUST NOT send email or SMS

## Scheduled Task: memory-review
Review your hot-tier memories for accuracy and relevance. Call `memory_review` to see all hot records. Purge anything outdated.
```

- [ ] **Step 4:** Commit

```bash
git add agents-templates/executive-assistant/
git commit -m "feat(#59): rewrite Rae template as receptionist

Replace EA personality/prompt with lightweight receptionist role.
Drops all EA servers/schedules, adds general channel, routing table."
```

---

### Task 2: Deactivate Mokie (chief-of-staff)

**Files:**
- Modify: `agents-templates/chief-of-staff/agent.yaml.tpl`

- [ ] **Step 1:** Update chief-of-staff template to deactivate

Add `disabled: true`, remove `general` from channels, set `isDefault: false`. Keep everything else intact for reversibility.

In `agents-templates/chief-of-staff/agent.yaml.tpl`, make these changes:

```yaml
id: chief-of-staff
name: "{{agent.name}}"
icon: ":briefcase:"
model: claude-opus-4-7
disabled: true
channels:
  - agent-{{agent.name_lower}}
keywords:
  - status
  - update
  - task
  - schedule
  - follow up
isDefault: false
# ... rest unchanged
```

Changes:
- Add `disabled: true`
- Remove `general` from channels (Rae owns it now), replace with `agent-{{agent.name_lower}}`
- Set `isDefault: false`

- [ ] **Step 2:** Commit

```bash
git add agents-templates/chief-of-staff/agent.yaml.tpl
git commit -m "feat(#59): deactivate Mokie (chief-of-staff)

Set disabled: true, remove general channel, clear isDefault.
Template and memories preserved for rollback."
```

---

### Task 3: Update agent-registry to parse `disabled` from YAML

**Files:**
- Modify: `src/agents/agent-registry.ts:225-249`
- Modify: `src/types/agent-config.ts` (if `disabled` not in type)

- [ ] **Step 1:** Check if `disabled` is already parsed from YAML in `loadAgent()`

Looking at agent-registry.ts line 225-249, the `AgentConfig` construction does NOT read `raw.disabled`. The `disabled` field only comes from `applyConfigOverrides()` via MongoDB. We need to add it so template-level `disabled: true` works.

Add to the config construction (after line 245):

```typescript
disabled: (raw.disabled as boolean) || false,
```

- [ ] **Step 2:** Verify `disabled` exists in `AgentConfig` type

Check `src/types/agent-config.ts` — if `disabled` isn't in the interface, add it:

```typescript
disabled?: boolean;
```

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-registry.ts src/types/agent-config.ts
git commit -m "fix(#59): parse disabled flag from agent YAML templates

Previously disabled was only applied via MongoDB config overrides.
Now respects disabled: true in agent.yaml templates directly."
```

---

### Task 4: Add stale directory pruning to generate-agents.ts

**Files:**
- Modify: `setup/generate-agents.ts`

- [ ] **Step 1:** After the main generation loop (after line 320, before the constitution sync), add pruning logic

```typescript
// Prune stale agent directories (agents/ dirs with no matching template)
const generatedIds = new Set(allAgents.map((a) => a.id));
const existingAgentDirs = readdirSync(AGENTS_DIR).filter((d) =>
  statSync(join(AGENTS_DIR, d)).isDirectory(),
);
let pruned = 0;
for (const dir of existingAgentDirs) {
  if (!generatedIds.has(dir)) {
    rmSync(join(AGENTS_DIR, dir), { recursive: true, force: true });
    console.log(`  PRUNE ${dir} (no matching template)`);
    pruned++;
  }
}
if (pruned > 0) {
  console.log(`\n  ${pruned} stale agent dir(s) pruned`);
}
```

- [ ] **Step 2:** Commit

```bash
git add setup/generate-agents.ts
git commit -m "feat(#59): prune stale agent dirs in generate-agents

Removes agents/ directories that have no corresponding template,
preventing deactivated agents from being loaded by the registry."
```

---

### Task 5: Update dispatcher test for Rae as default

**Files:**
- Modify: `src/channels/dispatcher.test.ts`

- [ ] **Step 1:** Update the mock registry setup in dispatcher.test.ts

The test currently has `mokie` as the default agent with `channels: ["agent-mokie"]`. Update to reflect the new routing:

- Rename the default agent entry from `mokie` to `rae` (or `executive-assistant`) with `channels: ["general", "agent-rae"]` and `isDefault: true`
- Add a `mokie` entry that is `disabled: true`
- Ensure existing routing tests still pass with the new default

The key change: messages to `general` channel should now route to `rae` (the new default), not `mokie`.

- [ ] **Step 2:** Verify all existing tests pass

Run: `npx vitest run src/channels/dispatcher.test.ts`
Expected: All tests pass

- [ ] **Step 3:** Commit

```bash
git add src/channels/dispatcher.test.ts
git commit -m "test(#59): update dispatcher tests for Rae as default agent"
```

---

### Task 6: Update constitution for Mokie deactivation

**Files:**
- Modify: `setup/templates/constitution-business.md.tpl`

- [ ] **Step 1:** The constitution has several Mokie/chief-of-staff conditional blocks:

- Section 2.2: `{{#team.chief-of-staff}}` exception for agents/ writes
- Section 2.4: chief-of-staff directing dodi_v2 work
- Section 7.2: chief-of-staff direction authority
- Section 7.6: chief-of-staff owns agent identity
- Section 4.1: conditional chief-of-staff external comms
- Various escalation paths mentioning Chief of Staff

These are all wrapped in `{{#team.chief-of-staff}}` conditionals, so they'll naturally disappear when the chief-of-staff is not in the team roster. However, the escalation path in 7.4 and 8.2 hardcodes "Chief of Staff". Update section 7.4 and 8.2:

Section 7.4 — change:
```
7.4. **Escalation path**: Agent → Chief of Staff → {{business.owner.name}}. Urgent/sensitive → skip to {{business.owner.name}}.
```
to:
```
7.4. **Escalation path**: Agent → #team → {{business.owner.name}}. Urgent/sensitive → skip to {{business.owner.name}}.
```

Section 8.2 — change:
```
8.2. **Escalate fast.** Can't resolve in one exchange → Chief of Staff or {{business.owner.name}}.
```
to:
```
8.2. **Escalate fast.** Can't resolve in one exchange → #team or {{business.owner.name}}.
```

- [ ] **Step 2:** Commit

```bash
git add setup/templates/constitution-business.md.tpl
git commit -m "feat(#59): update constitution escalation paths

Replace 'Chief of Staff' with '#team' in escalation paths since
Mokie is being deactivated. Conditional blocks already handle
the chief-of-staff sections via template guards."
```
