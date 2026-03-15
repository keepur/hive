---
name: cs-standup-prep
description: Compile customer success status — open cases, issues, and tasks for the morning standup
agents:
  - customer-success
---

# CS Standup Prep

Pull fresh data from dodi-ops and the task ledger to compile a customer success summary for Mokie's morning briefing. Always fetch live data — do NOT rely on memory. Update your memory with the fresh data as you go.

## Steps

1. **Fetch open cases** — Use `dodi_cases_list` to pull all open/active cases.

2. **For each case, gather:**
   - **Open issues** — Use `dodi_case_issues_list` for the case. List any issues that aren't resolved.
   - **Open tasks** — Use `task_list` filtered by `caseId` to find tasks that aren't done.

3. **Tasks due today** — From all tasks fetched, identify any due today.

4. **Tasks due this week** — From all tasks fetched, identify any due within the current Monday–Sunday window.

5. **Update memory** — Write a summary of today's case state to memory for historical reference.

## Output Format

```
**Customer Success — [today's date]**

---

**OPEN CASES**

**[Case name] — [customer name]**
Status: [case status]
Open Issues:
- [issue title] — [status]
- (or "None")
Open Tasks:
- [task name] — due [date] — [status]
- (or "None")

**[Next case...]**

(repeat for each open case)

---

**TASKS DUE TODAY**

| Case | Task | Assigned To |
|---|---|---|
| ... | ... | ... |

(or "None")

---

**TASKS DUE THIS WEEK**

| Case | Task | Due | Assigned To |
|---|---|---|---|
| ... | ... | ... | ... |

(or "None")
```

Keep it concise — data only, no commentary or recommendations. If a tool call fails, note what data is unavailable rather than omitting the section.
