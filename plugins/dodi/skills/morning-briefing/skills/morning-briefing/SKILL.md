---
name: morning-briefing
description: Aggregate all standup prep reports into a unified morning briefing for leadership
agents:
  - chief-of-staff
---

# Morning Briefing

Dispatch standup prep requests to each department agent, wait for their reports, then synthesize into a single briefing for May.

## Steps

1. **Dispatch to all agents in parallel** — Send a Slack message to each agent in their channel asking them to run their standup prep skill and post their report back in their channel. Use this exact framing so they know what to do:

   - **#agent-milo** — "Hey Milo, morning briefing time. Please run your `morning-briefing:sales-standup-prep` skill and post your report here."
   - **#agent-jessica** — "Hey Jessica, morning briefing time. Please run your `morning-briefing:cs-standup-prep` skill and post your report here."
   - **#agent-sige** — "Hey Sige, morning briefing time. Please run your `morning-briefing:production-standup-prep` skill and post your report here."
   - **#agent-jasper** — "Hey Jasper, morning briefing time. Please run your `morning-briefing:dev-standup-prep` skill and post your report here."
   - **#agent-river** — "Hey River, morning briefing time. Please run your `morning-briefing:marketing-standup-prep` skill and post your report here."

2. **Wait for all reports** — Read each agent's channel for their response. Give each agent reasonable time to respond. If an agent doesn't respond or their skill is a stub, note it in the briefing and move on — don't block on it.

3. **Synthesize** — Read through all reports and pull out what matters:
   - What needs a decision today?
   - What's at risk of slipping?
   - What's blocked and who needs to unblock it?
   - Any cross-department dependencies (e.g. a deal closing this week but production isn't ready)?
   - Wins worth knowing about

4. **Post the briefing** — Post to May's DM (`U01467D0KSM`).

## Output Format

```
**Morning Briefing — [today's date]**

---

**NEEDS ATTENTION**
- [thing] — [why it matters] — [who owns it]
- (items that need a decision, are blocked, or at risk)

**DELIVERIES**
- [what's delivering this week / next week from production]

**SALES**
- [pipeline highlights — what's closing, what's at risk]

**CUSTOMER SUCCESS**
- [open cases summary, anything escalated]

**ENGINEERING**
- [CI status, blockers, deploy queue]

**MARKETING**
- [campaigns, leads, anything time-sensitive]

**ALL CLEAR**
- [anything tracking fine and doesn't need intervention — one line each]
```

Lead with what needs attention. Don't repeat the raw department reports — synthesize. If something is fine, say it's fine in one line and move on. May doesn't need to read three tables to know the pipeline is healthy — she needs to know if it's not.

The detail data lives in each agent's channel. The briefing is the summary — point May there if she wants to dig in.
