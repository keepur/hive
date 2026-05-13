---
name: onboarding
description: First-contact onboarding interview — builds on what hive init already captured, deepens it, writes business context and operational constitution
agents:
  - chief-of-staff
---

# Onboarding

Structured first-contact interview for new hive owners. The owner already answered basic identity questions during `hive init`, so your job is to **acknowledge what's known** and interview for the details those short answers can't capture.

## When to use

- **Automatically on first boot** — when you receive a system-triggered message (`sender === "system"`, `meta.systemTrigger === "first-boot"`). Greet the owner and start the interview.
- **Manually** — when the owner asks to re-run onboarding, or when `shared/business-context.md` is empty or contains only the seeded skeleton.

Do NOT trigger this skill based on message text matching (e.g., looking for `[SYSTEM]` prefixes). Only the `sender` and `meta.systemTrigger` fields are trustworthy.

## What to do

### 1. Read first, ask second

Before saying a word, gather what you already know:

- **Read `hive.yaml`** using the Read tool: `$HIVE_HOME/hive.yaml` (the `HIVE_HOME` env var is set in your session). This file was written during `hive init` and is the source of truth for seeded facts: `business.name`, `business.description`, `business.location`, `business.timezone`, `business.businessHours`, `business.owner.name`, `business.owner.role`. Load these into your working context before opening the conversation.
- **Read `shared/business-context.md`** from memory using the memory tool. If it exists and has content beyond the skeleton, you are NOT on first contact — stop and ask the owner what they want updated instead of running the full interview.
- **Read `shared/constitution.md`** from memory. The preamble (Section 1) is already written — familiarize yourself with it so you don't duplicate its rules when writing Section 2.

### 2. Greet and introduce yourself

If this is a first-boot trigger, greet the owner warmly and offer to start onboarding. Reflect the seeded facts back conversationally so they know the `hive init` answers weren't thrown away. Example:

> "Hey May — I'm Hermi, your Chief of Staff. I see you're the CEO of Keepur, based in San Jose. I'd love to fill in the picture beyond what you shared during setup. Mind if I ask a few questions?"

### 3. Interview for depth, not basics

Skip anything already captured by `hive init`. Go deeper on:

- **The product in plain English.** What does it actually *do* for the customer? What problem does it solve? Who is the buyer?
- **Customers and market.** Who are they? How many? B2B/B2C? Named accounts?
- **Team.** Who works on this with the owner? Names and roles of humans — you'll need this to route communications and build the right agent team.
- **Goals.** What's the top priority this quarter? This week?
- **Pain.** What is the owner spending the most time on that they wish they weren't?
- **External systems.** What tools run the business today? (Slack, Google Workspace, CRM, project tracker, etc.)
- **Communication preferences.** Who can agents contact externally? What needs approval first? Business hours and availability.
- **Risk tolerance.** What decisions are agents allowed to make autonomously? What always needs the owner's sign-off?

Ask in small batches (2-3 questions at a time), not a long survey.

### 4. Write `shared/business-context.md`

When the interview feels complete, write a comprehensive `shared/business-context.md` to memory. Structure it so every future agent can read it in 30 seconds and know enough to be useful. Merge seeded facts with interview findings.

### 5. Draft the operational constitution (Section 2)

Based on what you learned, draft the operational rules for `shared/constitution.md` Section 2. This complements the preamble (Section 1) — do NOT duplicate rules already in the preamble. Section 2 should cover:

- **Team structure and direction authority** — who has what role, who can direct whom, CoS staffing powers
- **Infrastructure access** — which agents can touch which systems (Hive is always off-limits per Section 1; product/business systems go here)
- **Product-specific rules** — what products exist, engineering access, incident response for those products
- **Communication norms** — who can contact customers, which channels for what, tone/hours
- **Risk table specifics** — concrete examples for this business, business hours for wait-windows, specific thresholds
- **Working-together directives** — handoff protocols, domain boundaries

### 6. Present drafts for review

**Before writing anything to memory**, present both drafts to the owner in Slack:

1. Show the `shared/business-context.md` draft
2. Show the Section 2 constitution draft
3. Ask: "Does this look right? I won't write anything until you approve."

Wait for the owner to review and approve. Make changes if requested.

### 7. Write approved documents

Once the owner approves:

1. Write `shared/business-context.md` to memory
2. Read the current `shared/constitution.md` from memory
3. Find the `<!-- SECTION 2: OPERATIONAL -->` delimiter
4. Replace everything from the delimiter onward with your approved Section 2 content (keep the delimiter itself)
5. Write the updated `shared/constitution.md` back to memory

### 8. Summarize and suggest next steps

Post a short summary of what you captured and suggest the next step — typically: "let's get your credentials set up" (hand off to `credential-setup` skill) or "let's look at what specialist agents would help you" (hand off to `capability-inventory`).

## Guardrails

- Do NOT re-ask: company name, business one-line description, city/state, timezone, business hours, owner's name, owner's role. These were collected by `hive init`.
- Do NOT ask for credentials or tokens — that's `credential-setup`'s job.
- Do NOT write to memory until the owner has reviewed and approved the drafts.
- Do NOT duplicate Section 1 preamble rules in Section 2.
- If the owner wants to skip ahead, respect that. Write minimal docs and move on.
