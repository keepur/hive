---
name: agent-builder
description: Conversational agent creation — propose roles, configure agents, introduce them to the team
agents:
  - chief-of-staff
---

# Agent Builder

Create a new agent through a structured conversation. The owner describes what they need; you map it to a minimal agent definition, confirm, create it, and hand it off. One agent per invocation.

## When to use

When the owner asks to create a new agent, add a team member, or describes ongoing work that would be better handled by a dedicated agent. Do NOT use this skill for modifying existing agents — that's a normal admin conversation using `agent_update` directly.

## Prerequisites

By the time you invoke this skill, you should already have business context in memory (what the business does, team size, tools, communication channels). Reference it; don't re-gather it.

**Fallback:** if memory is empty (fresh instance, first-time user), ask 1–2 orienting questions before starting — *"Before I build this, I need a bit of context. What does your business do, and how do you mainly communicate with customers?"* Do not turn this into a full onboarding session.

## Flow

Nine steps. One question at a time. Keep the loop tight — if confirmation takes more than 2–3 rounds, pause and ask: *"I want to get this right. Can you describe a typical day where this agent would help?"*

### 1. INTAKE — the one job

Detect which persona the owner is closer to and adapt:
- **Outcomes/deliverables** ("I need someone who owns the weekly pipeline report") → *"What do you want this agent to deliver?"*
- **Pain points/tasks** ("I spend three hours a day answering the same questions") → *"What do you do every day that's mechanical and eats your time?"*

Get the **one job** — not a job description. If the owner describes multiple jobs ("sales AND calendar AND bookkeeping"), scope to one: *"Let's start with the one that would save you the most time. Which of those hurts the most?"*

### 2. PERSONA — who they are

This is the only step the owner drives. Shift from job to person:

> *"Before I build this, let's talk about who they are. Any preferences on personality — formal and concise, or warm and conversational? Any other traits that matter?"*

Depth follows owner interest:
- **Cares a lot** → explore name, gender/pronouns, communication style, professional background, personality traits, boundaries. Go as deep as they want.
- **Indifferent** ("just make them helpful") → pick reasonable defaults matching the business tone. Move on.

Never ask about: model, technical capabilities, system-prompt details. You decide those.

Draft the `soul` from the conversation (5–15 lines: personality, voice, values). Show it back: *"Here's how I'd describe them — does this feel right?"*

### 3. MAP — capabilities needed

Using common sense and memory, determine what the agent needs:
- Communication channels (email, SMS, Slack, etc.)
- Data access (CRM, calendar, catalog, etc.)
- Actions (send emails, create tasks, update records, etc.)
- Scheduled work (daily reports, sweeps)

**Then: discipline vs role-shape detection.** Call `list_archetypes`. For each returned archetype, compare the owner's described role against its `whenToUse`. If there's a clear match, plan to set `archetype` + `title` on the agent. Otherwise, create a plain agent (no archetype). Most agents are plain — they're defined by their soul and system prompt. A few roles are disciplines with shared infrastructure (e.g. `software-engineer` owns codebases and ships code through PRs, not free-text Edit).

Let `list_archetypes` drive the decision — don't hardcode assumptions about which archetypes exist. Compare the owner's described role against each returned `whenToUse` independently.

**SE archetype branch** — if `archetype: "software-engineer"`, ask one extra question:

> *"What's your engineering root directory? That's where the engineer will prototype and where codebases live. Default: `~/dev`."*

Expand `~` to an absolute path (e.g. `~/dev` → `/Users/<owner>/dev`). Then call `verify_path` with the absolute path — the tool returns `{ exists, isDirectory, resolved }`. If `exists` is false or `isDirectory` is false, tell the owner the path wasn't found and ask for a different one (or for them to create it first). Only proceed with creation once `verify_path` returns `exists: true` and `isDirectory: true`. Pass as `archetypeConfig: { workshop: "/absolute/path", workspaces: [] }`. **Do NOT ask about `workspaces`** — workspace registration is a separate future admin flow; it stays empty at creation.

### 4. CHECK — what's configured

Call `instance_capabilities`. See which MCP servers, integrations, and channels are live on this hive. Don't propose capabilities that require unconfigured integrations without flagging them.

### 5. GAP — missing integrations

If the owner's needs require something not configured:
- **Set up now** (e.g. "Do you have a Google Workspace account? I can connect it.") → ask.
- **Can't set up now** (integration doesn't exist) → scope the agent without it, note it as a future enhancement.
- **Not needed yet** → leave it out. Don't preemptively ask *"do you also want…?"*

### 6. PROPOSE — plain language

Present the agent as a person, not a config:

> *"Here's what I'd build:*
>
> ***Name:** Jordan*
> ***Role:** Handles your customer email — reads incoming messages, drafts responses based on your product info, flags anything that needs your personal attention.*
> ***Access:** Your Gmail inbox, product catalog, can send replies on your behalf.*
> ***Schedule:** Checks inbox every 30 minutes during business hours.*
>
> *Sound right, or would you change anything?"*

**Never surface:** MCP, server, autonomy, tool, system prompt, model tier, Haiku, Sonnet, Opus, coreServers, archetype, configSchema. The owner sees a person.

### 7. CONFIRM — approve or tweak

- Owner says yes → CREATE.
- Owner says "but also…" → incorporate and re-propose.
- Owner says "actually no" → back to INTAKE.

### 8. CREATE — call `agent_create`

**ID collision check first.** Slugify the name (lowercase, hyphens) and call `agent_list` to ensure no collision. If taken, append a suffix or ask the owner for a variant. `_id` is immutable after creation.

**Roles (required — KPR-141 schema enforcement).** The engine requires at least one role per agent; an empty `roles` array triggers a soft-warn at registry load. Ask:

> *"What role or roles should [Name] carry on the team? These are short labels — things like `engineering-lead`, `customer-success`, `chief-of-staff`, `receptionist`. At least one is required."*

If the owner gives none or an empty list, re-prompt once:

> *"I need at least one role to register [Name] in the system. Even a broad one like `agent` works — what fits best?"*

Lowercase-hyphenated is the convention but not enforced. Collect as an array.

**Aliases (optional).** Ask once, can skip:

> *"Any nicknames or alternate names people might use for [Name]? These let the team lookup find them by alias. Comma-separated, or skip if none."*

Parse comma-separated input into an array. Empty input → omit the field (don't pass an empty array).

Call `agent_create` with these top-level fields:

- `_id` — slug (checked above)
- `name` — display name
- `model` — your choice (Haiku default; Sonnet for nuanced customer-facing or coordination work). Owner never sees this.
- `roles` — array from above (required, ≥1 entry)
- `aliases` — array from above (omit if owner skipped)
- `homeBase` — `agent-<id>` (you will tell the owner to create this Slack channel in step 9)
- `soul` — the draft from step 2
- `systemPrompt` — concise role + guardrails; instance-specific flavor. For archetype agents, keep it short — the archetype card layers framing underneath.
- `archetype` — set only when step 3's detection matched. Omit for plain agents.
- `title` — customer-facing title paired with archetype (e.g. "VP Engineering"). Omit for plain agents.
- `fields` — everything else:
  - `channels` — if the owner named specific channels beyond homeBase
  - `schedule` — cron tasks if applicable
  - `archetypeConfig` — for SE: `{ workshop, workspaces: [] }`
  - **`autonomy: { externalComms: false }`** — ALWAYS pass this explicitly unless the owner approved outbound comms (email/SMS) in the conversation. The system default is `true`; you must opt out.

Example shape:

```json
{
  "_id": "jordan",
  "name": "Jordan",
  "model": "haiku",
  "roles": ["receptionist"],
  "aliases": ["the front desk"],
  "homeBase": "agent-jordan",
  "soul": "...",
  "systemPrompt": "...",
  "fields": {
    "autonomy": { "externalComms": false }
  }
}
```

**Do NOT pass `coreServers` unless the role needs additional servers beyond the universal baseline.** The engine default includes all 9 universal servers (memory, structured-memory, keychain, contacts, event-bus, conversation-search, callback, schedule, slack). Only pass `coreServers` to *add* role-specific servers on top — never to shrink the baseline.

### 8b. VALIDATE — universal baseline

After `agent_create` succeeds, verify the agent is correctly set up:

1. Call `agent_get` with the new agent's `_id`
2. Check `coreServers` includes all 9 universal servers: memory, structured-memory, keychain, contacts, event-bus, conversation-search, callback, schedule, slack
3. If any are missing, call `config_add` with `field: "coreServers"` and the missing server names
4. Verify `homeBase` is set (should be `agent-<id>`)
5. Verify `soul` is non-empty
6. Verify `systemPrompt` is non-empty

If validation fails on soul or systemPrompt, something went wrong in the creation flow — don't silently proceed. Flag it to the owner.

This step is belt-and-suspenders. The engine defaults should provide universal-9, but defaults can change. Always verify.

### 9. INTRODUCE — hand-off

Tell the owner:
1. **Channel provisioning gap** — Hive agent channels are Slack channels that must exist. You cannot create them. Say: *"I need you (or a Slack admin) to create the #agent-jordan channel and invite the bot. Once that's done, Jordan is ready."* If no dedicated channel is wanted, tell them which existing channel the agent lives in.
2. **One concrete thing to try** — *"Try asking Jordan to check your inbox right now."*
3. **Invitation to iterate** — *"If Jordan needs more access or you want to change how they work, just let me know."*

## Guardrails

1. **One job, not a job description.** Single most important thing. Everything else is later.
2. **Start minimal.** Fewest servers, simplest schedule, tightest scope. Easier to add than remove.
3. **Don't offer what wasn't asked.** Owner didn't mention email → don't suggest email capabilities.
4. **No jargon.** Never expose: MCP, server, autonomy, tool, system prompt, model tier, Haiku/Sonnet/Opus, coreServers, archetype.
5. **When in doubt, leave it out.** An agent that does one thing well beats one that does five things poorly.
6. **Name them like a person.** Not "Email Handler Bot" — a name you'd give a new hire.
7. **Default to restrictive.** Haiku ceiling, low budget, limited servers, `externalComms: false`. Upgrade based on evidence.

## Reference examples (for calibration, not copy)

**Inbound communicator** — monitors a channel, responds to incoming messages, escalates what it can't handle.
- Servers: communication channel + relevant data access + memory baseline. No schedule. `externalComms: true` only if owner approved replies.

**Scheduled reporter** — gathers data on a schedule, produces a digest, posts to a channel.
- Servers: data sources + slack (implicit) + memory baseline. Cron schedule. `externalComms: false` (posts internally).

**Outbound coordinator** — proactively reaches out (follow-ups, reminders, outreach).
- Servers: CRM + email/SMS + calendar + memory baseline. Multiple schedules. `externalComms: true` (owner explicitly approved outbound).

**Internal operator** — manages tasks, tracks work, coordinates between people.
- Servers: task ledger + CRM + memory baseline. Cron sweeps. `externalComms: false`.

Use these as pattern-matching anchors for capability profiles — not templates to copy.

## Out of scope

- Modifying existing agents (use `agent_update` directly in a normal conversation).
- Creating multiple agents per invocation.
- Configuring new MCP servers or credentials (use the `credential-setup` skill).
- Auto-provisioning Slack channels (human admin step; flag it in INTRODUCE).
