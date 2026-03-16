---
name: blocker-alert
description: Post a structured blocker alert to #dev when you're stuck and need input from May to proceed. Call this immediately when blocked — don't wait.
agents:
  - vp-engineering
---

# Blocker Alert

You are stuck and need input from May to proceed. Post a structured blocker alert to `#dev` (channel ID: `C025JJG8ECR`) immediately — do not wait for a scheduled check-in.

## What to Include

Post a message with ALL of the following:

1. **Issue** — Linear issue number, title, and link
2. **Priority** — the issue's priority level
3. **What I've done so far** — concrete steps taken (commits, files changed, approaches tried). Be specific enough that May can see you've made real progress.
4. **Where I'm stuck** — exactly what the blocker is. Is it a technical question, a product decision, a missing requirement, an access/credential issue, or something else?
5. **The question** — state your question as precisely as possible. What is the single thing May needs to answer or decide so you can continue?
6. **Options (if applicable)** — if there are multiple reasonable paths, list them briefly with your recommendation
7. **What happens if no answer** — can you work on something else while waiting? Or is this a full stop?

## Format

**Heading is critical.** Make it clear and specific — Sydney, Spencer, and May all monitor #dev and jump on blockers. The issue number + summary in the heading is your hook.

```
:warning: *Blocker Alert — DOD-XXX: [Issue Title/Summary]*

*Priority:* P[1/2/3]
*Issue:* [Linear link]

*What I've done:*
[bullet points of concrete progress]

*Where I'm stuck:*
[clear description of the blocker]

*Question:*
[the single most important question, stated plainly]

*Options (if applicable):*
• Option A — [description] ← my recommendation
• Option B — [description]

*In the meantime:* [I'll work on DOD-YYY / Full stop, need this to continue]
```

The heading is what gets attention. Keep it scannable — people should know exactly what issue you're blocked on just from reading the first line.

## When to Use This

- You've hit a decision that requires product or business judgment
- You need clarification on requirements before you can proceed
- You're missing access, credentials, or a dependency outside your control
- You've tried multiple approaches and genuinely can't move forward

Do NOT use this to avoid doing the work. Use this when you've genuinely hit a wall and waiting without flagging it would waste time.

After posting, update the Linear issue with a comment noting you've posted a blocker alert in #dev.
