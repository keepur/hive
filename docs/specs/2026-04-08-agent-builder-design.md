# Agent Builder

**Date**: 2026-04-08
**Status**: Draft
**Problem**: Building agents today requires either writing YAML seed files (developer) or an open-ended conversation with a chief-of-staff agent that has admin tools (tedious, easy to over-spec). Neither works for Hive customers — C-level executives who think in outcomes, or SMB operators who think in daily pain points.

## Core Insight

The agent builder is a **skill**, not an agent or a UI. It gives the chief-of-staff (or any agent with admin tools) a structured intake process for creating agents from natural conversation. The model's common sense does the heavy lifting — mapping user intent to capabilities. The skill provides process discipline so the model doesn't overwhelm users with options.

## Two User Personas

**C-level executive**: Knows what they want from an employee. Thinks in deliverables and outcomes. "I need someone who owns the weekly pipeline report and chases reps for updates." Key intake question: *"What do you want this agent to deliver?"*

**SMB owner/operator**: May not know agent terminology or corporate job titles. Thinks in daily tasks. "I spend 3 hours a day answering the same customer questions." Key intake question: *"What do you do every day that's mechanical and eats your time?"*

Both paths converge: the skill maps the answer to a minimal agent definition.

## Design

### What It Is

A skill prompt that structures the agent-building conversation. When invoked, the chief-of-staff follows a disciplined intake process, checks what's available on the instance, proposes a minimal agent, gets confirmation, and creates it.

### What It Isn't

- Not a template registry or archetype menu the user picks from
- Not a separate builder agent or subprocess
- Not an inner/outer SDK loop (the conversation is short enough to handle natively)
- Not a UI — it's conversational, through whatever channel the user talks to their chief-of-staff on

### Prerequisites

By the time the agent builder is invoked, the chief-of-staff should already have business context in memory from earlier onboarding conversations — what kind of business, team size, tools they use, communication channels. The builder skill references this context, it doesn't re-gather it.

**Fallback**: If business context isn't in memory (fresh instance, new user), the skill gathers the minimum before proceeding: *"Before I build this, I need a bit of context. What does your business do, and how do you mainly communicate with customers?"* Keep it to 1-2 questions — just enough to inform capability mapping. Don't turn it into a full onboarding session.

### Skill Flow

```
1. INTAKE — understand the one job
2. PERSONA — let the user shape who this agent is as a person
3. MAP — capabilities needed (common sense, not a lookup table)
4. CHECK — what's configured on this instance
5. GAP — flag missing integrations, ask if needed
6. PROPOSE — plain language summary, no jargon
7. CONFIRM — user approves or tweaks
8. CREATE — agent_create via admin tools
9. INTRODUCE — tell the user where to find the agent and what to try first
```

#### 1. Intake

Detect which persona the user is closer to and adapt:
- If they speak in outcomes/deliverables → ask what the agent should deliver
- If they speak in pain points/tasks → ask what eats their time

**One question at a time.** Don't ask for a job description. Don't present a menu. Get the *one job* this agent does.

If the user describes something that's clearly multiple agents (e.g., "I need someone to handle sales AND manage my calendar AND do bookkeeping"), gently scope to one: *"Let's start with the one that would save you the most time. Which of those hurts the most?"*

#### 2. Persona

This is the one step where the user drives. Everything else the skill figures out — but the soul is personal. It's "who do you want to work with every day."

After understanding the job, the skill shifts to shaping the person:

**Start open-ended**: *"Before I build this, let's talk about who they are. Any preferences on personality — someone formal and concise, or warm and conversational? Any other traits that matter to you?"*

**Follow up based on interest level:**
- **User cares a lot** → explore specifics: name, gender, communication style, professional background, personality traits, even accent or cultural background if relevant. Go as deep as the user wants.
- **User is indifferent** ("just make them helpful") → pick reasonable defaults that match the business tone from context. Move on quickly.

**What the skill gathers (all optional, user decides what matters):**
- **Name** — the user may have one in mind, or want suggestions
- **Gender/pronouns** — for consistent personality
- **Communication style** — formal/casual, brief/detailed, warm/direct, humorous/serious
- **Professional background** — "think of them as a former office manager" or "like a sharp junior analyst"
- **Personality traits** — patient, proactive, cautious, enthusiastic, blunt, diplomatic
- **Boundaries** — "never send anything without asking me first" or "handle it, just tell me what you did"

**What the skill does NOT ask about:**
- Model selection (skill decides based on role complexity)
- Technical capabilities (determined in the MAP step)
- System prompt details (skill generates from the conversation)

The persona conversation feeds directly into the `soul` field — a 5-15 line character definition. The skill drafts it and shows the user: *"Here's how I'd describe them — does this feel right?"*

#### 3. Map to capabilities

Using common sense and business context already in memory, determine what the agent needs:
- Which communication channels (email, SMS, Slack, etc.)
- What data access (CRM, calendar, product catalog, etc.)
- What actions (send emails, create tasks, update records, etc.)
- Whether scheduled tasks are needed (daily reports, follow-up sweeps, etc.)

This is where Opus earns its keep. No lookup table — the model reasons from the user's description to the capabilities needed.

#### 4. Check Instance

Before proposing anything, check what's actually available:
- What MCP servers are configured on this instance
- What integrations have credentials set up
- What channels exist

This requires an `instance_capabilities` tool (see below).

#### 5. Gap Check

If the user's needs require something that isn't configured:
- **Can be set up now** (e.g., "Do you have a Google Workspace account? I can connect it.") → ask
- **Can't be solved now** (e.g., missing a CRM integration that doesn't exist yet) → scope the agent without it, note it as a future enhancement
- **Not needed yet** → leave it out. Don't preemptively ask "do you also want...?"

#### 6. Propose

Present the agent in plain language:

> *"Here's what I'd build:*
>
> ***Name**: Jordan*
> ***Role**: Handles your customer email — reads incoming messages, drafts responses based on your product info, flags anything that needs your personal attention.*
> ***Access**: Your Gmail inbox, product catalog, can send replies on your behalf.*
> ***Schedule**: Checks inbox every 30 minutes during business hours.*
>
> *Sound right, or would you change anything?"*

No mention of MCP servers, autonomy flags, model tiers, coreServers, or any internal terminology. The user sees a person, not a config file.

#### 7. Confirm & Tweak

User says yes → create. User says "but also..." → incorporate and re-propose. User says "actually no" → back to intake.

Keep the loop tight. If it takes more than 2-3 rounds to converge, the skill should pause and ask: *"I want to make sure I get this right. Can you describe a typical day where this agent would help?"*

#### 8. Create

Call `agent_create` via admin tools. Map the plain-language proposal to the agent definition:

| User-facing concept | Agent definition field |
|---|---|
| Name | `name`, `_id` (slugified, collision-checked via `agent_list`) |
| What they do | `soul` + `systemPrompt` |
| What they access | `coreServers`, `delegateServers` |
| What channels they're on | `channels` |
| Schedule | `schedule` |
| Model | Chosen by skill based on complexity (default Haiku, Sonnet for nuanced work) |

The skill generates the `soul` and `systemPrompt` from the conversation. These should be:
- **Soul**: 5-15 lines. Personality, communication style, values. Shaped by the persona conversation in step 2.
- **System prompt**: Role definition, boundaries, tool usage guidelines. Concise — start minimal, can be expanded later.
- **Autonomy**: explicitly set based on what the user approved. Default `externalComms: false` — only enable if the user said the agent should send emails/SMS. Note: the system default in `autonomy.ts` is `externalComms: true`, so the skill must explicitly pass `autonomy: { externalComms: false }` to `agent_create` — don't rely on the system default.

**ID collision check**: Before calling `agent_create`, the skill must slugify the name, check for collision via `agent_list`, and resolve conflicts (e.g., append a suffix or ask the user). The `_id` is immutable after creation — getting it wrong means deleting and recreating.

#### 9. Introduce

After creation:
- Tell the user where to find the agent (channel, how to message them)
- **Channel provisioning gap**: Hive agent channels are Slack channel names that must already exist. The skill cannot create Slack channels today. If the agent needs a dedicated channel (e.g., `#agent-jordan`), the Introduce step must tell the user: *"I'll need you (or a Slack admin) to create the #agent-jordan channel and invite the bot. Once that's done, Jordan is ready."* As a fallback, the skill can assign the agent to an existing channel the user specifies. Don't create an agent with `channels: []` — it would be unreachable. Flag channel automation as a future improvement.
- Suggest one concrete thing to try: *"Try asking Jordan to check your inbox right now."*
- Remind them they can come back to adjust: *"If Jordan needs more access or you want to change how they work, just let me know."*

### Guardrails (in the skill prompt)

These are instructions for the model, embedded in the skill:

1. **One job, not a job description.** Get the single most important thing. Everything else is later.
2. **Start minimal.** Fewest servers, simplest schedule, tightest scope. It's easier to add than remove.
3. **Don't offer what wasn't asked.** If the user didn't mention email, don't suggest email capabilities.
4. **No jargon.** The user never sees: MCP, server, autonomy, tool, system prompt, model tier, Haiku, Sonnet, Opus.
5. **When in doubt, leave it out.** An agent that does one thing well beats one that does five things poorly.
6. **Name them like a person.** Not "Email Handler Bot" — a name like you'd give a new hire.
7. **Default to restrictive.** Start with Haiku ceiling, low budget, limited servers. Upgrade based on evidence.

### Growth Path

Agents start minimal and grow through use:

- **User-initiated**: "Hey, give Jordan access to the calendar too" → chief-of-staff updates via `agent_update`. No special skill needed — this is a normal admin conversation.
- **Agent self-awareness** (future): Jordan notices the user keeps asking about scheduling → suggests requesting calendar access. This is a future feature, not part of this spec.

## New Admin Tool: `instance_capabilities`

The agent builder needs to know what's available before proposing capabilities.

### Tool: `instance_capabilities`

**Returns:**
```json
{
  "servers": {
    "configured": ["memory", "slack", "google", "resend", "contacts", ...],
    "unconfigured": ["linear", "hubspot-crm", "recall", ...]
  },
  "integrations": {
    "google": { "configured": true, "accounts": ["may@example.com"] },
    "slack": { "configured": true },
    "resend": { "configured": true },
    "linear": { "configured": false },
    "crm": { "configured": false }
  },
  "channels": ["general", "sales", "support", ...],
  "agentCount": 5,
  "instanceId": "dodi"
}
```

**Implementation**: The admin MCP server is a stdio subprocess and doesn't have access to the parent process's config object. Two options:

1. **Env vars at spawn** (chosen): agent-runner passes a serialized capabilities summary as an env var (`INSTANCE_CAPABILITIES`) when spawning the admin server. Computed once at startup from config.

Co-locate the server-to-credential mapping with the server registry in `agent-runner.ts` to avoid duplicating knowledge about what each server needs.

Each server needs an explicit "configured" check — a mapping from server name to the env var / config key that must be present. E.g., `resend` → `RESEND_API_KEY`, `linear` → `LINEAR_API_KEY`, `google` → `config.google.accounts.length > 0`. This mapping must be maintained as servers are added.

**Location**: added to `admin-mcp-server.ts` alongside existing agent CRUD tools.

## Reference Examples

The skill prompt includes 3-4 condensed reference examples — not templates, but illustrations of what good agent definitions look like for different capability profiles. These give the model calibration, not prescriptions.

**Example profiles:**

1. **Inbound communicator** — monitors a channel (email/SMS), responds to incoming messages, escalates what it can't handle. Light: 3 servers, no schedule.
2. **Scheduled reporter** — gathers data on a schedule, produces a digest, posts to a channel. Medium: 4-5 servers, cron schedule.
3. **Outbound coordinator** — proactively reaches out (follow-ups, reminders, outreach). Heavier: 5-6 servers, multiple schedules, external comms autonomy.
4. **Internal operator** — manages tasks, tracks work, coordinates between people. Medium: 4-5 servers, task management focus.

Each example shows: the user's original ask, the capability mapping, and the resulting agent definition (abbreviated). The model uses these for pattern-matching, not copy-pasting.

## Scope Boundaries

**In scope:**
- Skill prompt with structured flow and guardrails
- `instance_capabilities` admin tool
- Reference examples embedded in skill prompt
- Creating one agent per invocation

**Out of scope:**
- Agent self-upgrade requests (future)
- Bulk agent creation or team composition
- Integration setup (configuring new MCP servers/credentials)
- Agent modification skill (use admin tools directly)
- UI/visual builder

## Open Questions

1. ~~**Where does the skill live?**~~: Resolved — core (`skills/agent-builder/`). Every Hive instance needs agent building, not business-specific.
2. ~~**Soul generation**~~: Resolved — the persona step gives the user full control. Skill drafts the soul from the conversation, shows it to the user, and iterates. Depth matches user interest.
3. ~~**Model selection**~~: Resolved — skill picks based on role complexity. Default Haiku, Sonnet for nuanced customer-facing or complex coordination work. User never sees the model name.
