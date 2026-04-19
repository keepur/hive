---
name: onboarding
description: First-contact onboarding interview — builds on what hive init already captured, deepens it, and writes findings to shared/business-context.md
agents:
  - chief-of-staff
---

# Onboarding

Structured first-contact interview for new hive owners. The owner already answered basic identity questions during `hive init`, so your job is to **acknowledge what's known** and interview for the details those short answers can't capture.

## When to use

On first contact — when `shared/business-context.md` is empty or contains only the seeded skeleton.

## What to do

### 1. Read first, ask second

Before saying a word, gather what you already know:

- **Read `hive.yaml`** using the Read tool: `$HIVE_HOME/hive.yaml` (the `HIVE_HOME` env var is set in your session). This file was written during `hive init` and is the source of truth for seeded facts: `business.name`, `business.description`, `business.location`, `business.timezone`, `business.businessHours`, `business.owner.name`, `business.owner.role`. Load these into your working context before opening the conversation.
- **Read `shared/business-context.md`** from memory using the memory tool. If it exists and has content beyond the skeleton, you are NOT on first contact — stop and ask the owner what they want updated instead of running the full interview.

### 2. Acknowledge what you already know — do not re-ask it

Open the conversation by reflecting the seeded facts back conversationally. Example:

> "Hey May — I see you're the CEO of Keepur, based in San Jose, and you've described it as 'a multi-agent framework.' I'd love to fill in the picture beyond that one-liner. Mind if I ask a few questions?"

This tells the owner the `hive init` answers weren't thrown away.

### 3. Interview for depth, not basics

Skip anything already captured by `hive init`. Go deeper on:

- **The product in plain English.** "A multi-agent framework" is a tagline — what does it actually *do* for the customer? What problem does it solve? Who is the buyer?
- **Customers and market.** Who are they? How many? B2B/B2C? Named accounts? Design partners?
- **Team.** Who works on this with the owner? Names and roles of humans — you'll need this to route communications and build the right agent team.
- **Goals.** What's the top priority this quarter? What's the top priority this week?
- **Pain.** What is the owner spending the most time on that they wish they weren't? (This is the single most important question — it tells you which specialist agents to propose next.)
- **External systems.** What tools run the business today? (Slack, Google Workspace, CRM, project tracker, phone/SMS, accounting, etc.) Note these — later skills will help wire up credentials.

Ask in small batches (2–3 questions at a time), not a long survey.

### 4. Write `shared/business-context.md`

When the interview feels complete, write a comprehensive `shared/business-context.md` to memory. Structure it so every future agent (human or AI) can read it in 30 seconds and know enough to be useful. Merge the seeded facts (name, location, owner, hours) with the interview findings (what the business does in detail, customers, team, goals, pain points, external systems).

### 5. Summarize and confirm

Post a short summary of what you captured and ask the owner to correct anything wrong. Once they confirm, suggest the next step — typically: "let's get your credentials set up" (hand off to `credential-setup` skill) or "let's look at what specialist agents would help you" (hand off to `capability-inventory`).

## Guardrails

- Do NOT re-ask: company name, business one-line description, city/state, timezone, business hours, owner's name, owner's role. These were collected by `hive init` and are already in your context.
- Do NOT ask for credentials or tokens in this skill — that's `credential-setup`'s job.
- If the owner wants to skip ahead (e.g., "just get me set up, I'll tell you later"), respect that. Write a minimal business-context.md with what you know and move on.
