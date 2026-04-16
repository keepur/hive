---
name: dev-standup-prep
description: Compile engineering status — open PRs, CI health, and backlog updates for the morning standup
agents:
  - vp-engineering
---

# Dev Standup Prep

Pull fresh live data from GitHub and Linear to compile an engineering summary for Mokie's morning briefing. Always fetch live data — do NOT rely on memory for CI status, PR state, or deploy history. Memory is for structural facts only (e.g. repo names, workflow patterns).

## Steps

1. **CI/CD health** — Run the following via Bash and summarize the results:
   ```
   gh run list --repo dodi-hq/dodi_v2 --limit 10 --json status,conclusion,name,workflowName,createdAt,headBranch
   ```
   - Identify any failures or in-progress runs
   - Note the most recent completed run and its outcome
   - Flag anything that failed in the last 24 hours

2. **Open PRs** — Run:
   ```
   gh pr list --repo dodi-hq/dodi_v2 --json number,title,author,createdAt,statusCheckRollup,headRefName,isDraft
   ```
   - List all open PRs, their CI status, and whether they're draft or ready
   - Flag any PRs that are blocked on CI or have been open more than 2 days

3. **Active Linear issues** — Use `linear_list_issues` with `statusType: "started"` to get what's currently in progress.
   - List issue ID, title, and assignee
   - Note anything that looks stalled (no recent activity)

4. **Recent deploys** — From the GHA run list, identify any runs on `deploy/production` branch or named "Deploy" in the last 48 hours. Note success/failure.

5. **Update memory** — Save a one-line structural note if you learn something new about the CI/CD setup. Do NOT save ephemeral state (last run status, timestamps, etc.).

## Output Format

```
**Engineering — [today's date]**

---

**CI/CD STATUS**
- Last run: [workflow name] on [branch] — [conclusion] ([timestamp])
- Failures in last 24h: [list or "None"]
- In-progress runs: [list or "None"]

---

**OPEN PRs**

| PR | Title | Branch | CI | Age |
|---|---|---|---|---|
| #N | [title] | [branch] | ✅/❌/⏳ | [Xd] |

(or "None")

---

**IN PROGRESS (Linear)**

| Issue | Title | Assignee |
|---|---|---|
| DOD-XXX | [title] | [name or unassigned] |

(or "None")

---

**RECENT DEPLOYS**
- [date]: [branch/workflow] — [success/failure]
- (or "None in last 48h")

---

**FLAGS**
- [anything blocked, failing, or needs attention — or "None"]
```

Keep it data-only, no commentary or recommendations. If a tool call fails, note what data is unavailable rather than omitting the section. If everything is green, say so clearly.
