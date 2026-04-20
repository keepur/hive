# Agent Creation UX — Phase 2 Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace the 170-word stub `agent-builder` SKILL.md with the materialized 9-step conversational flow (INTAKE → PERSONA → MAP → CHECK → GAP → PROPOSE → CONFIRM → CREATE → INTRODUCE), wired to the Phase 1 admin surface (`list_archetypes`, `instance_capabilities`, promoted `agent_create` schema).

**Architecture:** Single-file change. SKILL.md is read from disk at session start by the chief-of-staff — no code changes, no DB migration, no `setup:seeds` re-run. The Phase 1 surface is already live (commit a228ce0), so the skill can reference `list_archetypes`, the `coreServers` baseline, and the top-level `agent_create` fields verbatim.

**Tech Stack:** Markdown (skill prompt). No tests — per spec §"Phase 2 validation", correctness is validated manually by Hermi creating a test agent and verifying the resulting document.

**Spec:** [2026-04-20-agent-creation-ux-design.md](../specs/2026-04-20-agent-creation-ux-design.md) §Phase 2 (lines 186–246). Authoritative design: [2026-04-08-agent-builder-design.md](../specs/2026-04-08-agent-builder-design.md).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md` | Rewrite | Full 9-step flow, discipline detection via `list_archetypes`, SE archetype branch (workshop only), guardrails, explicit defaults, 4 reference profiles. |

---

### Task 1: Rewrite the agent-builder SKILL.md

**Files:**
- Modify: `seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md` (full rewrite; replace everything below the frontmatter)

**Preserve:** frontmatter exactly as-is (`name`, `description`, `agents` — other sibling skills under `seeds/chief-of-staff/skills/*/skills/*/SKILL.md` all follow the same shape, confirmed by reading the current file and `capability-inventory`/`credential-setup`/`onboarding` peers).

**Replace the body with:**

- [ ] **Step 1:** Overwrite the file with the following content.

```markdown
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

For MVP this collapses to: *"Is the agent primarily a software engineer?"* New archetypes expand the space automatically via `list_archetypes`.

**SE archetype branch** — if `archetype: "software-engineer"`, ask one extra question:

> *"What's your engineering root directory? That's where the engineer will prototype and where codebases live. Default: `~/dev`."*

Expand `~` to absolute path. Verify the directory exists before proceeding (prefer an admin helper if available; otherwise flag to the owner and proceed only after they confirm). Pass as `archetypeConfig: { workshop: "/absolute/path", workspaces: [] }`. **Do NOT ask about `workspaces`** — workspace registration is a separate future admin flow; it stays empty at creation.

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

Call `agent_create` with the Phase 1 top-level schema:

- `_id` — slug (checked above)
- `name` — display name
- `model` — your choice (Haiku default; Sonnet for nuanced customer-facing or coordination work). Owner never sees this.
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

**Do NOT pass `coreServers`.** Phase 1's default (`memory`, `structured-memory`, `keychain`, `event-bus`, `contacts`) applies automatically. Override only if the owner's specifically approved tooling changes the baseline.

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
```

- [ ] **Step 2:** Verify the frontmatter is intact and the file is well-formed.

Run: `head -10 seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md`

Expected: the four-line YAML frontmatter (`name: agent-builder`, `description: …`, `agents:`, `  - chief-of-staff`) followed by `---` and `# Agent Builder`.

- [ ] **Step 3:** Sanity check that no code references the old skill content.

Run: `Grep pattern="Understand what the owner needs" path="."`

Expected: no matches (confirms the stub is fully replaced).

- [ ] **Step 4:** Run the repo check (markdown is not linted, but prettier/format may touch the file; catches anything unexpected).

Run: `cd ~/github/hive && npm run check`

Expected: all green. If prettier reformats the markdown, accept its output — the content is what matters, not the exact wrapping.

- [ ] **Step 5:** Commit.

```bash
git add seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md
git commit -m "feat(agent-builder): materialize Phase 2 skill — 9-step flow, archetype detection, guardrails (KPR-42)"
```

---

## Notes for the implementer

- This is a single-file prose change. No typecheck/test risk beyond what `npm run check` catches.
- The frontmatter (`name`, `description`, `agents`) stays exactly as it is today — sibling skills in `seeds/chief-of-staff/skills/*/skills/*/SKILL.md` all share this shape, and the chief-of-staff loader expects it.
- Skill content must reference Phase 1 tool names exactly as shipped: `list_archetypes`, `instance_capabilities`, `agent_create`, `agent_update`, `agent_list`. Top-level `agent_create` params are `_id`, `name`, `model`, `homeBase`, `soul`, `systemPrompt`, `archetype`, `title`, `fields`.
- The `autonomy.externalComms: false` instruction is load-bearing — the system default is `true`, and Phase 2 must opt agents out unless the owner explicitly approves outbound comms. Call this out in the CREATE step and in the guardrails.
- Do NOT add `coreServers` to the skill's default payload — Phase 1's baseline (`memory`, `structured-memory`, `keychain`, `event-bus`, `contacts`) applies on its own. Mentioning it in the skill would couple the skill to a list that may drift.
- Deployment: no `setup:seeds` re-run; skill markdown is read from disk at session start. After merge + deploy, Hermi picks up the new skill on her next message.
- Validation is manual (per spec): have Hermi create a test agent; confirm archetype (if applicable), coreServers populated, soul/systemPrompt shaped from conversation, `autonomy.externalComms: false` unless explicitly approved.
