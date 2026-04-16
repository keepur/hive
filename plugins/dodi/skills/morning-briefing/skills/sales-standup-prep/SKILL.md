---
name: sales-standup-prep
description: Compile pipeline metrics, new leads, and outreach activity for the morning standup
agents:
  - sdr
---

# Sales Standup Prep

Pull fresh data from HubSpot and compile a sales summary for Mokie's morning briefing. Do NOT rely on memory for pipeline data — always fetch live from HubSpot. Update your memory with the fresh data as you go.

## Steps

1. **Fetch all open deals** — Use `hubspot_list_deals` to pull every open deal from the Sales Pipeline. This is your source of truth for everything below.

2. **Closing this week** — Deals with a close date within the current Monday–Sunday window. If none, say so explicitly.

3. **Closing this month** — All deals closing in the current calendar month, including any closing this week.

4. **Task status** — Use `hubspot_list_tasks` to pull all tasks. Categorize as overdue, due today, or due tomorrow.

5. **Deals without upcoming tasks** — Use `hubspot_deals_without_tasks` to find open deals with no future task scheduled.

6. **Blockers and flags** — From the data gathered, flag: deals stuck in the same stage 7+ days, close dates in the past, deals closing soon still in early stages, deals with no contact associated, any deal status that seems contradictory.

7. **Pipeline snapshot** — Summarize all open deals grouped by stage.

8. **Update memory** — Write a summary of today's pipeline state to memory for historical reference.

## Output Format

Use tables for structured data. Follow this format:

```
**Sales Pipeline — [today's date]**

---

**1. CLOSING THIS WEEK ([date range])**

| Deal | Amount | Close | Stage | Notes |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

(or "NONE — no deals closing this week")

---

**2. CLOSING THIS MONTH ([month date range])**

| Deal | Amount | Close | Stage | Notes |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

Month Total: $X

---

**3. OVERDUE & DUE TODAY/TOMORROW**

| Deal | Task | Due | Status | Assigned To |
|---|---|---|---|---|
| ... | ... | ... | X OVERDUE / DUE TODAY / DUE TOMORROW | ... |

(or "All clear")

---

**4. DEALS WITHOUT UPCOMING TASKS — ACTION NEEDED**

| Deal | Amount | Stage | Last Activity | Days Since | Owner |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

Total at risk: $X

(or "All covered")

---

**5. BLOCKERS & FLAGS**

- [deal] — [issue]
- (or "None")

---

**6. PIPELINE SNAPSHOT**

By Stage:
- [stage]: [count] deals ($[value])
- ...
Total Active Pipeline: $X
```

Keep it concise — data only, no commentary or recommendations. Resolve HubSpot owner IDs to names when possible. If a HubSpot call fails, note what data is unavailable rather than omitting the section.
