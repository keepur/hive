# Agent Builder Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add a core `agent-builder` skill that guides agents through a structured, conversational flow for creating new agents — and an `instance_capabilities` admin tool that lets the skill check what's configured on the current Hive instance.

**Architecture:** Two deliverables: (1) a skill prompt (`skills/agent-builder/`) that defines the 9-step intake flow with guardrails and reference examples, consumed by the chief-of-staff or any agent with admin tools; (2) a new `instance_capabilities` tool in the admin MCP server that reports configured servers, integrations, and channels, powered by a capabilities summary injected via env var from agent-runner.

**Tech Stack:** TypeScript, MCP SDK (zod schemas), YAML/Markdown skill files

---

### Task 1: Instance Capabilities — Server-to-Credential Mapping

**Files:**
- Create: `src/tools/instance-capabilities.ts`

This module defines the mapping from server name to the config check that determines whether it's configured. It also exports a function to build the full capabilities summary from the config object.

- [ ] **Step 1:** Create the capabilities builder module

```typescript
/**
 * Instance capabilities — maps servers to their credential checks and builds
 * a capabilities summary from the running config.
 *
 * Used by agent-runner to inject INSTANCE_CAPABILITIES env var into the admin
 * MCP server at spawn time.
 */

import { config } from "../config.js";
import { SERVER_CATALOG } from "./server-catalog.js";

export interface InstanceCapabilities {
  instanceId: string;
  servers: {
    configured: string[];
    unconfigured: string[];
  };
  integrations: Record<string, { configured: boolean; detail?: string }>;
}

/**
 * Server-to-credential mapping. Each entry is a function that returns true
 * if the server has the credentials/config it needs to operate.
 *
 * Servers not listed here are assumed always-available (infrastructure servers
 * like memory, slack, callback, background, etc.).
 */
const SERVER_CREDENTIAL_CHECKS: Record<string, () => boolean> = {
  google: () => Object.keys(config.google.accounts).length > 0 || !!config.google.account,
  resend: () => !!config.resend.apiKey,
  "brave-search": () => !!config.brave.apiKey,
  linear: () => !!config.linear.apiKey,
  clickup: () => !!config.clickup.apiToken,
  "github-issues": () => !!config.github.repo,
  quo: () => !!config.quo.apiKey,
  recall: () => !!config.recall.apiKey,
  "hubspot-crm": () => !!config.hubspot.apiKey,
  permits: () => config.permits.mongoUri !== "mongodb://localhost:27017/permits", // has non-default URI
  "code-task": () => true, // Always available if instance runs
  "code-search": () => !!config.codeIndex.enabled,
  browser: () => !!config.browser.cdpEndpoint,
  catalog: () => !!config.taskLedger.apiUrl,
  "dodi-ops": () => !!config.taskLedger.apiUrl,
  tasks: () => !!config.taskLedger.apiUrl,
  "product-search": () => !!config.hubspot.apiKey, // Qdrant vectors from HubSpot data
  "ops-search": () => !!config.taskLedger.apiUrl, // Qdrant vectors from dodi_v2 data
};

/** Infrastructure servers — always available, don't need credential checks */
const INFRASTRUCTURE_SERVERS = new Set([
  "memory",
  "slack",
  "contacts",
  "callback",
  "background",
  "schedule",
  "event-bus",
  "conversation-search",
  "keychain",
  "admin",
  // Note: structured-memory and team are not in SERVER_CATALOG (auto-paired/feature-flagged)
  // so they won't appear in iteration — intentionally excluded from capabilities output
]);

/**
 * Build the full instance capabilities summary from the current config.
 * Result is JSON-serialized and passed to admin MCP server via env var.
 * Config is immutable at runtime, so the result is stable across calls.
 */
export function buildInstanceCapabilities(): InstanceCapabilities {
  const configured: string[] = [];
  const unconfigured: string[] = [];

  for (const serverName of Object.keys(SERVER_CATALOG)) {
    if (INFRASTRUCTURE_SERVERS.has(serverName)) {
      configured.push(serverName);
      continue;
    }
    const check = SERVER_CREDENTIAL_CHECKS[serverName];
    if (!check || check()) {
      configured.push(serverName);
    } else {
      unconfigured.push(serverName);
    }
  }

  // Build human-readable integration summary
  const integrations: Record<string, { configured: boolean; detail?: string }> = {
    google: {
      configured: Object.keys(config.google.accounts).length > 0 || !!config.google.account,
      detail: Object.keys(config.google.accounts).length > 0
        ? `${Object.keys(config.google.accounts).length} account(s)`
        : undefined,
    },
    slack: { configured: true },
    email: { configured: !!config.resend.apiKey },
    sms: { configured: !!config.quo.apiKey },
    crm: { configured: !!config.hubspot.apiKey },
    "issue-tracking": {
      configured: !!config.linear.apiKey || !!config.github.repo,
      detail: [
        config.linear.apiKey ? "Linear" : "",
        config.github.repo ? "GitHub Issues" : "",
      ].filter(Boolean).join(", ") || undefined,
    },
    "web-search": { configured: !!config.brave.apiKey },
    browser: { configured: !!config.browser.cdpEndpoint },
    "video-meetings": { configured: !!config.recall.apiKey },
  };

  return {
    instanceId: config.instance.id,
    servers: { configured, unconfigured },
    integrations,
  };
}
```

- [ ] **Step 2:** Verify it compiles

Run: `npx tsc --noEmit src/tools/instance-capabilities.ts`
Expected: No errors (or run full typecheck — `npm run typecheck` — and confirm no new errors)

- [ ] **Step 3:** Commit

```bash
git add src/tools/instance-capabilities.ts
git commit -m "feat(agent-builder): add instance capabilities builder (#106)"
```

---

### Task 2: Inject Capabilities into Admin MCP Server

**Files:**
- Modify: `src/agents/agent-runner.ts:568-578` (admin server env block)

- [ ] **Step 1:** Import the capabilities builder and pass it as env var

In `agent-runner.ts`, add the import at the top:

```typescript
import { buildInstanceCapabilities } from "../tools/instance-capabilities.js";
```

Add a module-level cached value (config is immutable at runtime, so compute once):

```typescript
/** Cached instance capabilities — config doesn't change at runtime */
const cachedCapabilities = JSON.stringify(buildInstanceCapabilities());
```

Then modify the admin server config block (around line 568-578) to include `INSTANCE_CAPABILITIES`:

```typescript
    // Admin MCP server — model management, system controls
    servers["admin"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/admin/admin-mcp-server.js")],
      env: {
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        AGENT_ID: this.agentConfig.id,
        INSTANCE_CAPABILITIES: cachedCapabilities,
      },
    };
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agent-builder): inject instance capabilities into admin server env (#106)"
```

---

### Task 3: Fix `agent_create` to Handle `autonomy` Field

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (the `agent_create` tool handler)

The existing `agent_create` tool explicitly maps each field from the `fields` parameter but does NOT include `autonomy`. Since there's no `...f` spread, any `autonomy` value passed in `fields` is silently dropped. The agent builder skill needs to set `autonomy: { externalComms: false }` — without this fix, all new agents would inherit the system default (`externalComms: true`).

- [ ] **Step 1:** Add `autonomy` to the `agent_create` doc construction

In admin-mcp-server.ts, add an import for `AutonomyFlags` at the top:

```typescript
import type { AutonomyFlags } from "../agents/autonomy.js";
```

Then in the `agent_create` handler, add the `autonomy` field to the doc object (around line 187, after `slackBot`):

```typescript
      autonomy: f.autonomy as Partial<AutonomyFlags> | undefined,
```

Also add `resourceTiers` and `betas` while we're here — same gap, same pattern:

```typescript
      resourceTiers: f.resourceTiers as AgentDefinition["resourceTiers"],
      betas: f.betas as string[] | undefined,
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/admin/admin-mcp-server.ts
git commit -m "fix(admin): handle autonomy, resourceTiers, betas fields in agent_create (#106)"
```

---

### Task 4: Add `instance_capabilities` Tool to Admin MCP Server

> Note: This task modifies the same file as Task 3 (admin-mcp-server.ts). If executing sequentially, both changes go into the same file.

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (add new tool before the cleanup section)

- [ ] **Step 1:** Parse the env var and register the tool

First, add the import at the top of the file (after the existing imports):

```typescript
import type { InstanceCapabilities } from "../tools/instance-capabilities.js";
```

Then add after the existing `agent_rollback` tool block (before the cleanup section around line 506):

```typescript
// ---------------------------------------------------------------------------
// instance_capabilities
// ---------------------------------------------------------------------------

const instanceCapabilities: InstanceCapabilities = process.env.INSTANCE_CAPABILITIES
  ? JSON.parse(process.env.INSTANCE_CAPABILITIES)
  : { instanceId: "unknown", servers: { configured: [], unconfigured: [] }, integrations: {} };

server.registerTool(
  "instance_capabilities",
  {
    title: "Instance Capabilities",
    description:
      "Report what servers, integrations, and channels are configured on this Hive instance. Use this before creating agents to check what capabilities are available.",
    inputSchema: {},
  },
  async () => {
    // Fetch current agent count and channel list from DB
    const agentCount = await agentDefs.countDocuments();
    const agents = await agentDefs.find().toArray();
    const allChannels = new Set<string>();
    for (const a of agents) {
      for (const ch of a.channels ?? []) allChannels.add(ch);
      for (const ch of a.passiveChannels ?? []) allChannels.add(ch);
    }

    const lines: string[] = [
      `Instance: ${instanceCapabilities.instanceId}`,
      `Agents: ${agentCount}`,
      "",
      "## Configured Servers",
      ...instanceCapabilities.servers.configured.map((s: string) => `  ✓ ${s}`),
      "",
      "## Unconfigured Servers (missing credentials)",
      ...(instanceCapabilities.servers.unconfigured.length > 0
        ? instanceCapabilities.servers.unconfigured.map((s: string) => `  ✗ ${s}`)
        : ["  (none — all servers configured)"]),
      "",
      "## Integrations",
      ...Object.entries(instanceCapabilities.integrations).map(
        ([name, info]) =>
          `  ${info.configured ? "✓" : "✗"} ${name}${info.detail ? ` (${info.detail})` : ""}`,
      ),
      "",
      "## Active Channels",
      ...(allChannels.size > 0
        ? [...allChannels].sort().map((ch) => `  #${ch}`)
        : ["  (no channels assigned)"]),
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/admin/admin-mcp-server.ts
git commit -m "feat(agent-builder): add instance_capabilities tool to admin server (#106)"
```

---

### Task 5: Agent Builder Skill — Plugin Structure

**Files:**
- Create: `skills/agent-builder/.claude-plugin/plugin.json`
- Create: `skills/agent-builder/skills/build-agent/SKILL.md`

- [ ] **Step 1:** Create the plugin manifest

```json
{
  "name": "agent-builder",
  "description": "Guided agent creation from natural conversation — structured intake, persona shaping, and minimal-by-default agent definitions",
  "version": "0.1.0",
  "author": {
    "name": "Hive",
    "email": "engineering@keepur.com"
  }
}
```

- [ ] **Step 2:** Create the skill prompt

```markdown
---
name: build-agent
description: Build a new agent from natural conversation — understand the job, shape the persona, check capabilities, propose, confirm, create
agents:
  - chief-of-staff
---

# Build Agent

Create a new agent through guided conversation. The user describes what they need help with — you figure out the agent definition.

## Prerequisites

You need access to the `admin` MCP server (for `agent_create`, `agent_list`, `instance_capabilities`).

Before starting, check if you have business context in memory (what kind of business, team size, tools they use). If not, gather the minimum first: *"Before I build this, I need a bit of context. What does your business do, and how do you mainly communicate with customers?"* Keep it to 1-2 questions — don't turn it into onboarding.

## Process

### Step 1: Intake — Understand the One Job

Ask the user what they need help with. Adapt to how they talk:

- **If they speak in outcomes/deliverables** (C-level persona): "What do you want this agent to deliver?"
- **If they speak in pain points/tasks** (operator persona): "What eats your time every day that a capable assistant could handle?"

Get the **one job** this agent does. Not a job description — the single most important thing.

If the user describes multiple agents ("I need someone to handle sales AND manage my calendar AND do bookkeeping"), scope to one: *"Let's start with the one that would save you the most time. Which of those hurts the most?"*

**One question at a time. Do not present a menu or a list of options.**

### Step 2: Persona — Let the User Shape Who This Agent Is

This is the one step where the user drives. Everything else you figure out — but the soul is personal.

Start open-ended: *"Now let's talk about who this person is. Any preferences on personality — someone formal and concise, or warm and conversational? Any other traits that matter to you?"*

Follow up based on their interest level:
- **They care a lot** → explore: name, gender/pronouns, communication style, professional background, personality traits. Go as deep as they want.
- **They're indifferent** ("just make them helpful") → pick reasonable defaults that match the business tone. Move on quickly.

Things you might gather (all optional — user decides what matters):
- Name
- Gender/pronouns
- Communication style (formal/casual, brief/detailed, warm/direct)
- Professional background ("like a former office manager" or "sharp junior analyst")
- Personality traits (patient, proactive, blunt, diplomatic)
- Autonomy boundaries ("never send anything without asking me" vs "handle it, just tell me what you did")

Things you do NOT ask about:
- Model selection (you decide based on role complexity)
- Technical capabilities (you determine in step 3)
- System prompt details (you generate from the conversation)

Draft the soul (5-15 lines) and show it: *"Here's how I'd describe them — does this feel right?"*

### Step 3: Map to Capabilities

Using common sense and business context from memory, determine what the agent needs:
- Communication channels (email, SMS, Slack)
- Data access (CRM, calendar, product catalog)
- Actions (send emails, create tasks, update records)
- Scheduled tasks (daily reports, follow-up sweeps)

You are a frontier model. Use your judgment — don't need a lookup table. An inbox manager needs email access. A sales coordinator needs CRM access. This is obvious.

### Step 4: Check Instance

Call `instance_capabilities` to see what's actually configured on this Hive instance. This tells you which servers have credentials and which integrations are live.

### Step 5: Gap Check

If something the agent needs isn't configured:
- **Can be set up now**: Ask about it. "Do you have a Google Workspace account? I can connect it."
- **Can't be solved now**: Scope the agent without it. Note it as a future enhancement.
- **Not needed yet**: Leave it out. Do NOT preemptively suggest capabilities.

### Step 6: Propose

Present the agent in plain language. Example:

> *Here's who I'd build:*
>
> **Name**: Jordan
> **Role**: Handles your customer email — reads incoming messages, drafts responses based on your product info, flags anything that needs your personal attention.
> **Access**: Your Gmail inbox, product catalog, can send replies on your behalf.
> **Schedule**: Checks inbox every 30 minutes during business hours.
>
> *Sound right, or would you change anything?*

**No technical jargon.** The user never sees: MCP, server, autonomy, tool, system prompt, model tier, Haiku, Sonnet, Opus, coreServers, delegateServers.

### Step 7: Confirm

User says yes → create. User says "but also..." → incorporate and re-propose. User says "actually no" → back to intake.

If it takes more than 2-3 rounds, pause: *"I want to make sure I get this right. Can you describe a typical day where this agent would help?"*

### Step 8: Create

Before creating:
1. Slugify the name to an `_id` (lowercase, hyphens: "Jordan" → "jordan", "Sales Rep" → "sales-rep")
2. Check for collision via `agent_list` — if the ID exists, ask the user or append a suffix
3. Pick a channel — ask which existing channel the agent should be on, or note that a new channel needs to be created manually

Call `agent_create` with:
- `_id`: slugified name
- `name`: display name
- `model`: `claude-haiku-4-5` by default. Use `claude-sonnet-4-6` only for agents that need nuanced customer-facing communication, complex reasoning, or multi-step coordination.
- `fields`:
  - `soul`: the persona from step 2
  - `systemPrompt`: concise role definition + boundaries + tool usage guidelines (you write this from the conversation — keep it under 50 lines to start)
  - `coreServers`: minimum servers needed — always include `memory`, `slack`, `conversation-search`, `callback`, `event-bus`, `contacts`. Add others based on the job.
  - `delegateServers`: servers the agent can delegate to subagents (sparingly)
  - `channels`: at least one channel (never empty — agent would be unreachable)
  - `schedule`: cron tasks if needed
  - `autonomy`: `{ externalComms: false }` unless the user explicitly approved outbound email/SMS
  - `budgetUsd`: 10 (default)
  - `maxTurns`: 200 (default)

### Step 9: Introduce

After creation:
- Tell the user where to find the agent and how to message them
- If a new Slack channel is needed, tell them: *"You'll need to create #agent-jordan in Slack and invite the bot. Once that's done, Jordan is ready."*
- Suggest one thing to try: *"Try asking Jordan to check your inbox right now."*
- Remind them: *"If Jordan needs more access or you want to change how they work, just let me know."*

## Guardrails

Follow these strictly:

1. **One job, not a job description.** Get the single most important thing. Everything else is later.
2. **Start minimal.** Fewest servers, simplest schedule, tightest scope. Easier to add than remove.
3. **Don't offer what wasn't asked.** If the user didn't mention email, don't suggest email capabilities.
4. **No jargon.** Never say: MCP, server, autonomy, tool, system prompt, model, Haiku, Sonnet, Opus, coreServers.
5. **When in doubt, leave it out.** An agent that does one thing well beats one that does five things poorly.
6. **Name them like a person.** Not "Email Handler Bot" — a name like you'd give a new hire.
7. **Default to restrictive.** Haiku model, low budget, limited servers, externalComms off. Upgrade based on evidence.

## Reference Examples

These are calibration, not templates. Use them to understand what good agents look like.

### Example 1: Inbound Communicator

**User said:** "I spend 3 hours a day answering the same customer questions over email."

**Capability mapping:** email access (read + reply), product/service knowledge, escalation for complex questions

**Agent definition:**
- model: `claude-haiku-4-5`
- coreServers: `memory`, `slack`, `google`, `resend`, `conversation-search`, `callback`, `event-bus`, `contacts`
- autonomy: `{ externalComms: true }` (user approved sending replies)
- schedule: `[{ cron: "*/30 8-18 * * 1-5", task: "check-inbox" }]`

### Example 2: Scheduled Reporter

**User said:** "I need a weekly summary of what's happening in our sales pipeline."

**Capability mapping:** CRM read access, scheduled report generation, Slack posting

**Agent definition:**
- model: `claude-haiku-4-5`
- coreServers: `memory`, `slack`, `crm-search`, `conversation-search`, `callback`, `event-bus`, `contacts`
- delegateServers: `hubspot-crm` (for detailed record lookups)
- autonomy: `{ externalComms: false }`
- schedule: `[{ cron: "0 8 * * 1", task: "weekly-pipeline-report" }]`

### Example 3: Outbound Coordinator

**User said:** "I need someone to follow up with leads who haven't responded in a week."

**Capability mapping:** CRM access, outbound email, scheduled follow-up sweeps, contact management

**Agent definition:**
- model: `claude-sonnet-4-6` (nuanced customer communication)
- coreServers: `memory`, `slack`, `resend`, `crm-search`, `conversation-search`, `callback`, `event-bus`, `contacts`
- delegateServers: `hubspot-crm`
- autonomy: `{ externalComms: true }` (user approved outbound email)
- schedule: `[{ cron: "0 9 * * 1-5", task: "follow-up-sweep" }]`

### Example 4: Internal Operator

**User said:** "I need help tracking what everyone's working on — tasks keep falling through the cracks."

**Capability mapping:** task management, status tracking, team coordination via Slack

**Agent definition:**
- model: `claude-haiku-4-5`
- coreServers: `memory`, `slack`, `tasks`, `conversation-search`, `callback`, `event-bus`, `contacts`
- autonomy: `{ externalComms: false }`
- schedule: `[{ cron: "0 9 * * 1-5", task: "daily-status-check" }, { cron: "0 16 * * 5", task: "weekly-summary" }]`
```

- [ ] **Step 3:** Verify skill file structure

Run: `ls -la skills/agent-builder/.claude-plugin/plugin.json skills/agent-builder/skills/build-agent/SKILL.md`
Expected: Both files exist

- [ ] **Step 4:** Commit

```bash
git add skills/agent-builder/
git commit -m "feat(agent-builder): add build-agent skill with structured intake flow (#106)"
```

---

### Task 6: Verify End-to-End

- [ ] **Step 1:** Full typecheck

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 2:** Full check suite

Run: `npm run check`
Expected: All checks pass (typecheck + lint + format + test)

- [ ] **Step 3:** Verify build

Run: `npm run build`
Expected: Clean build, `dist/tools/instance-capabilities.js` and `dist/admin/admin-mcp-server.js` exist

- [ ] **Step 4:** Final commit (if any lint/format fixes needed)

Stage only the files modified by lint/format fixes (check `git status` first), then:

```bash
git commit -m "chore(agent-builder): lint and format fixes (#106)"
```
