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

**Soul format — non-negotiable.** Write the soul in **second person**, opening with:

```
# Soul: <Name>

You are <Name>, <role> at <business>.
```

This is not stylistic. The soul gets injected into internal classifier prompts (triage, model-router) that say *"You are NOT the agent — you are a router."* A 2nd-person soul ("You are Nora...") overrides that framing and the classifier responds in character. A 3rd-person soul ("Nora is...") reinforces the router framing — the classifier drops out of character and posts router internals to Slack as the agent ("I'm the router, not Nora — what do you need?"). This has happened. Do not let it happen again.

### Step 3: Map to Capabilities

Using common sense and business context from memory, determine what the agent needs:
- Communication channels (email, SMS, Slack)
- Data access (CRM, calendar, product catalog)
- Actions (send emails, create tasks, update records)
- Scheduled tasks (daily reports, follow-up sweeps)

You are a frontier model. Use your judgment — don't need a lookup table. An inbox manager needs email access. A sales coordinator needs CRM access. This is obvious.

### Step 3.5: Channels — Home Base and Listening Posts

Every agent needs a **home base** channel they own, and may have **listening posts** — channels they passively monitor without owning.

**Home base** (`channels` field):
- Convention: `#agent-<name>` (e.g. `#agent-jordan`). This is where the user DMs the agent, where direct mentions land, and where threaded conversations live.
- Ask: *"Where should <Name> live? I'd suggest a dedicated `#agent-<name>` channel — that becomes their inbox. Sound good, or do you want them to sit somewhere else?"*
- If the channel doesn't exist yet, note it for Step 9 (the user has to create it in Slack and invite the bot — you can't do this for them).
- Never empty. An agent with no channels is unreachable.

**Listening posts** (`passiveChannels` field):
- These are channels where the agent reads everything but only responds when directly addressed by name. Use this when the agent needs ambient awareness of work happening in shared team channels — not for channels they should actively own.
- Ask: *"Are there any team channels <Name> should listen in on so she has context when someone pings her? For example, if she's handling purchasing, she might want to be in `#purchasing` and `#production` so she knows what's being ordered without people having to re-explain."*
- **Do not guess.** If the user doesn't know or doesn't care, leave `passiveChannels` empty — easier to add later than to have an agent silently lurking somewhere unexpected.
- Each passive channel also needs the bot invited in Slack (note for Step 9).

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
3. Validate every name in `coreServers` and `delegateServers` against the `instance_capabilities` response from Step 4. Names that don't match a real server are silently dropped at runtime — the agent will load fine but the tool just won't exist. Common foot-gun: `tasks` is not a server, the actual id is `task-ledger`.

Call `agent_create` with:
- `_id`: slugified name
- `name`: display name
- `model`: `claude-haiku-4-5` by default. Use `claude-sonnet-4-6` only for agents that need nuanced customer-facing communication, complex reasoning, or multi-step coordination.
- `fields`:
  - `icon`: a Slack emoji shortcode like `:clipboard:`, `:wrench:`, `:briefcase:`, `:art:`. **Never empty.** This prefixes the agent's Slack messages and sets `icon_emoji` on bot posts — without it, the agent has no visual identity in Slack.
  - `soul`: the persona from step 2 (must be 2nd person, see Step 2)
  - `systemPrompt`: concise role definition + boundaries + tool usage guidelines (you write this from the conversation — keep it under 50 lines to start)
  - `coreServers`: minimum servers needed — always include `memory`, `slack`, `conversation-search`, `callback`, `event-bus`, `contacts`. Add others based on the job. Validated against `instance_capabilities`.
  - `delegateServers`: servers the agent can delegate to subagents (sparingly). Validated against `instance_capabilities`.
  - `channels`: home base from Step 3.5. Never empty.
  - `passiveChannels`: listening posts from Step 3.5 (may be empty).
  - `schedule`: cron tasks if needed
  - `autonomy`: `{ externalComms: false }` unless the user explicitly approved outbound email/SMS
  - `budgetUsd`: 10 (default)
  - `maxTurns`: 200 (default)

### Step 9: Introduce

After creation, give the user an explicit channel handoff. Spell out exactly which channels need to be created and which need the bot invited:

> *"I've set Jordan up to live in `#agent-jordan` and listen in on `#purchasing` and `#production`. You'll need to:*
> 1. *Create `#agent-jordan` in Slack if it doesn't exist*
> 2. *Invite the Hive bot to all three channels*
>
> *Once that's done, Jordan is reachable. Try asking him to check your inbox right now. If he needs more access or you want to change how he works, just let me know."*

You cannot create Slack channels or invite the bot for the user — they have to do this themselves.

### Step 9.5: Verify

Before declaring done, send the new agent a test message in their home base channel (or ask the user to). Confirm two things:

1. **The response includes the icon prefix** (e.g. `:clipboard: *Jordan*: ...`). If it doesn't, the `icon` field is empty or invalid — fix it.
2. **The agent identifies as themselves**, not as "the router" or "Claude" or "the message triage agent." If it leaks classifier internals, the soul is probably 3rd person — rewrite it in 2nd person and re-test.

If either check fails, fix the agent definition before moving on. The hot-reload is automatic via MongoDB change stream — no restart needed.

## Guardrails

Follow these strictly:

1. **One job, not a job description.** Get the single most important thing. Everything else is later.
2. **Start minimal.** Fewest servers, simplest schedule, tightest scope. Easier to add than remove.
3. **Don't offer what wasn't asked.** If the user didn't mention email, don't suggest email capabilities.
4. **No jargon.** Never say: MCP, server, autonomy, tool, system prompt, model, Haiku, Sonnet, Opus, coreServers.
5. **When in doubt, leave it out.** An agent that does one thing well beats one that does five things poorly.
6. **Name them like a person.** Not "Email Handler Bot" — a name like you'd give a new hire.
7. **Default to restrictive.** Haiku model, low budget, limited servers, externalComms off. Upgrade based on evidence.
8. **Soul is 2nd person.** Always opens with `# Soul: <Name>\n\nYou are <Name>...`. 3rd-person souls break the triage classifier.
9. **Icon is set.** Never empty. Pick a Slack emoji that fits the role.
10. **Server names are validated** against `instance_capabilities` before `agent_create` is called.
11. **Channels are explicit.** Ask about home base AND listening posts. Don't guess passive channels.
12. **Verify after creating.** Test message in their home base. Confirm icon prefix and in-character identity before declaring done.

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
- coreServers: `memory`, `slack`, `task-ledger`, `conversation-search`, `callback`, `event-bus`, `contacts`
- autonomy: `{ externalComms: false }`
- schedule: `[{ cron: "0 9 * * 1-5", task: "daily-status-check" }, { cron: "0 16 * * 5", task: "weekly-summary" }]`
