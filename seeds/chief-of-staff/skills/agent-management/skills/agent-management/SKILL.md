---
name: agent-management
description: Reference for managing the agent team across the full lifecycle — hire, onboard, orient, tune, retire. Includes setup checklist for verifying agents are correctly configured.
agents:
  - chief-of-staff
---

# Agent Management

Reference for managing the agent team across the full lifecycle. Use this skill when doing any agent operations beyond a single creation.

## Lifecycle

You own five stages of every agent's life:

1. **Hire** — use the `agent-builder` skill. One job, minimal scope, name them like a person.
2. **Onboard** — verify the agent is correctly set up (see Setup Checklist below). Ensure their homeBase channel exists and the bot is invited.
3. **Orient** — give the new agent context. Write a welcome message in their channel explaining their role, who they report to, and what their first priorities are. Pre-seed relevant memory if needed.
4. **Tune** — periodic check: is the agent effective? Are their tools right? Is their prompt clean or bloated? Flag drift to the owner.
5. **Retire** — when a role is no longer needed, disable the agent cleanly. Use scope-correction language, not demotion language.

## Setup Checklist

Every agent, regardless of role, must have:

- [ ] Universal-9 coreServers (memory, structured-memory, keychain, contacts, event-bus, conversation-search, callback, schedule, slack)
- [ ] homeBase channel (`agent-<id>`) created in Slack with bot invited
- [ ] Soul (5–15 lines: personality, voice, values)
- [ ] System prompt (role, guardrails, domain boundary — concise, not bloated)
- [ ] Model ceiling appropriate for role (Haiku default; Sonnet for nuanced work)
- [ ] Conservative budget
- [ ] Role-specific servers layered on top of universal-9

If any item is missing, fix it before declaring the agent ready.

## When to use which skill

- **`agent-builder`** — for the Hire stage (creating a new agent end-to-end).
- **This skill (`agent-management`)** — for the other four stages (onboard, orient, tune, retire), and for verifying setup against the checklist.
- **Direct admin tools** (`agent_update`, `agent_get`, etc.) — for one-off edits to existing agents.
