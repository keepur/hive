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
- Autonomy boundaries ("never send anything without asking me first" vs "handle it, just tell me what you did")

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
