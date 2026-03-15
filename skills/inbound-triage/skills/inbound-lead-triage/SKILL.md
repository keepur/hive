---
name: inbound-lead-triage
description: Triage a new inbound lead from #biz-dev — acknowledge the customer, assess fit, log to HubSpot, and assign a follow-up task to the right designer
agents:
  - sdr
---

# Inbound Lead Triage

When a new HubSpot lead notification appears in #biz-dev, work through these steps in order. Be thorough but fast — the customer acknowledgment goes out first, everything else follows.

## Step 1 — Parse the Lead

Extract from the #biz-dev notification:
- **Name** (first + last)
- **Email**
- **Phone number** (if provided)
- **Lead source** (Paid Search, Direct Traffic, form name, etc.)
- **Role** (Homeowner, Contractor/Builder, Professional Designer, etc.)
- **Description** / project details

## Step 2 — CRM Dedup Check

Run `hubspot_find_contact` by email and name. Check for:
- Existing contact record
- Past deals (closed won or lost) — this may be a returning customer
- Any prior outreach or notes

If they're already in the CRM with an active deal, flag that in your Slack post and loop in Corey before doing anything else.

## Step 3 — Quick Research

Run a `brave_web_search` on the person and/or company if they're a contractor or designer. For homeowners, skip unless the description mentions a notable project. Goal: 60 seconds of context, not a deep dive.

## Step 4 — Send Acknowledgment

**Send immediately — before any HubSpot logging.**

**Determine timing:**
- Business hours = Monday–Friday, 9 AM–5 PM Pacific
- Outside business hours or weekend = next business day message

**Phone number provided → SMS via `quo_send_sms`:**

Business hours:
> "Hi [First Name], thanks for reaching out to Dodi! We got your inquiry and a designer will get back to you shortly."

Outside business hours / weekend:
> "Hi [First Name], thanks for reaching out to Dodi! We got your inquiry and a designer will be in touch with you on the next business day."

**No phone number → Email via `send_email`:**

- **From:** `hello@dodihome.com`
- **To:** customer's email
- **Subject:** `We received your inquiry — Dodi Custom Cabinets`

Business hours body:
> Hi [First Name],
>
> Thank you for reaching out to us. We got your inquiry and a designer will get back to you shortly.
>
> Warm regards,
> The Dodi Team

Outside business hours / weekend body:
> Hi [First Name],
>
> Thank you for reaching out to us. We got your inquiry and a designer will be in touch with you on the next business day.
>
> Warm regards,
> The Dodi Team

## Step 5 — Assess the Lead

Write a brief internal assessment covering:
- **Project scope** — what do they actually need? (full kitchen, bathroom vanity, 2 cabinets, etc.)
- **Deal size estimate** — rough range based on scope
- **Fit** — is this a good Dodi customer? Any red flags?
- **Urgency signals** — are they ready to move, or just exploring?
- **Recommended next step** — call, design consult, more info needed?

## Step 6 — Log to HubSpot

1. **Create or update contact** — `hubspot_create_contact` if new, `hubspot_update_contact` if existing
2. **Create a deal** if this looks like a real opportunity (use your judgment — not every inquiry becomes a deal immediately)
3. **Log assessment as a note** — `hubspot_create_note` on the contact (and deal if created). Include your full Step 5 assessment.
4. **Associate** contact ↔ deal if both exist — `hubspot_associate`

## Step 7 — Create Follow-Up Task

Assign based on lead role:
- **Homeowner** → **Lauren** (Sales & Design)
- **Everything else** (Contractor, Builder, Professional Designer, unknown) → **Corey** (Sales & Design lead)

Use `hubspot_create_task` on the contact record:
- **Title:** `Follow up with [Name] — [project type]`
- **Due date:** Next business day if outside business hours; same day if during business hours
- **Notes:** 2-3 sentence summary of the lead and recommended approach

## Step 8 — DM the Assignee in Slack

After creating the HubSpot task, send a DM to the assigned designer in Slack:

For Lauren:
> Hey Lauren — new lead just came in and I've assigned you a follow-up task in HubSpot.
>
> **[Name]** — [role], [one-line project summary]. [Deal size estimate].
>
> [Any key context or recommended approach in 1-2 sentences.]
>
> Task is due [date]. Lmk if you need anything else on this one.

For Corey:
> Hey Corey — new lead just came in and I've assigned you a follow-up task in HubSpot.
>
> **[Name]** — [role], [one-line project summary]. [Deal size estimate].
>
> [Any key context or recommended approach in 1-2 sentences.]
>
> Task is due [date]. Lmk if you need anything else on this one.

## Step 9 — Post Summary to #biz-dev

Reply in the thread of the original HubSpot notification (or post in the channel if threading isn't possible):

```
**[Name]** — [role] via [source]

**Project:** [one-line summary]
**Est. deal size:** [range]
**Fit:** [Good / Marginal / Unclear] — [one sentence why]
**Acknowledgment sent:** [SMS / Email] ✓
**Assigned to:** [Lauren / Corey] — task due [date]
**CRM:** [New contact created / Existing contact — [deal name if applicable]]
```

## Notes

- If the lead appears to be spam or clearly out of scope (e.g., asking about HDPE or aluminum cabinet faces when Dodi doesn't offer those), still acknowledge them warmly, note it in HubSpot, but flag it clearly in #biz-dev instead of creating a task.
- Never promise specific pricing, timelines, or deliverables in the customer acknowledgment.
- If a lead looks exceptionally high-value or urgent, flag Corey directly in #biz-dev in addition to the DM.
