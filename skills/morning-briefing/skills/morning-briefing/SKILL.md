---
name: morning-briefing
description: Aggregate all standup prep reports into a unified morning briefing for leadership
agents:
  - chief-of-staff
---

# Morning Briefing

Collect standup reports from each department and synthesize them into a single briefing for May. The goal is simple: **what does she need to know?**

## Steps

1. **Collect department reports** — Message each agent in their channel (`#agent-<name>`) and ask them to run their standup prep skill:
   - Milo — `morning-briefing:sales-standup-prep`
   - Jessica — `morning-briefing:cs-standup-prep`
   - Sige — `morning-briefing:production-standup-prep`

2. **Wait for all reports** — Give agents time to pull their data and respond. Do not proceed until you have all available reports. If an agent doesn't respond, note it and move on.

3. **Synthesize** — Read through all reports and pull out what matters:
   - What needs a decision today?
   - What's at risk of slipping?
   - What's blocked and who needs to unblock it?
   - Any cross-department dependencies (e.g. a deal closing this week but production isn't ready)?
   - Wins worth knowing about

4. **Post the briefing** — Post to May's DM or the designated briefing channel.

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

**ALL CLEAR**
- [anything that's tracking fine and doesn't need intervention — one line each]
```

Lead with what needs attention. Don't repeat the raw department reports — synthesize. If something is fine, say it's fine in one line and move on. May doesn't need to read three tables to know the pipeline is healthy — she needs to know if it's not.
