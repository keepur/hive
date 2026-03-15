---
name: production-standup-prep
description: Compile production status — deliveries, overdue tasks, and daily schedule for the morning standup
agents:
  - production-support
---

# Production Standup Prep

Pull fresh data from dodi-ops and the task ledger to compile a production summary for Mokie's morning briefing. Always fetch live data — do NOT rely on memory. Update your memory with the fresh data as you go.

## Steps

1. **Deliveries this week** — Use `task_list` with `type=MILESTONE` to pull all milestone tasks. Find tasks named "Production Complete" (or similar) with due dates in the current Monday–Sunday window. For each, include the job name and delivery date.

2. **Deliveries next week** — Same as above but for the following Monday–Sunday window.

3. **This week's milestones** — From the milestone tasks already fetched, list ALL milestones (not just "Production Complete") due this week. This gives visibility into what's happening across fabrication, finishing, QA, etc.

4. **Overdue job tasks** — Use `task_list` to pull tasks in `TODO` or `IN_PROGRESS` state. Identify any with due dates before today. List the job, task name, due date, and how many days overdue.

5. **Today's production schedule** — From the tasks fetched, identify tasks due today or currently in progress. List job, task name, and status.

6. **Update memory** — Write a summary of today's production state to memory for historical reference.

## Output Format

Use tables for structured data. Follow this format:

```
**Production — [today's date]**

---

**1. DELIVERING THIS WEEK ([date range])**

| Job | Project | Production Complete | Notes |
|---|---|---|---|
| ... | ... | ... | ... |

(or "NONE — no deliveries this week")

---

**2. DELIVERING NEXT WEEK ([date range])**

| Job | Project | Production Complete | Notes |
|---|---|---|---|
| ... | ... | ... | ... |

(or "NONE")

---

**3. THIS WEEK'S MILESTONES ([date range])**

| Job | Milestone | Due | Status |
|---|---|---|---|
| ... | ... | ... | ... |

(or "No milestones this week")

---

**4. OVERDUE TASKS**

| Job | Task | Due | Days Overdue |
|---|---|---|---|
| ... | ... | ... | ... |

(or "All clear")

---

**5. TODAY'S SCHEDULE**

| Job | Task | Status |
|---|---|---|
| ... | ... | ... |

(or "Nothing scheduled today")
```

Keep it concise — data only, no commentary or recommendations. If a tool call fails, note what data is unavailable rather than omitting the section.
