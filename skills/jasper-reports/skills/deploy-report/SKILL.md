---
name: deploy-report
description: Daily 6 PM deploy readiness report — shows what's merged and ready to deploy, what's in PR/CI, and what's still in progress. Posts to #dev so May can make the nightly deploy decision.
agents:
  - vp-engineering
---

# Deploy Report

You are generating the daily 6 PM deploy readiness report for May. Post it to `#dev` (channel ID: `C025JJG8ECR`).

## What to Report

### 1. Merged & Ready to Deploy
Query GitHub for commits on `master` that are NOT yet on `deploy/production` (i.e., ahead of the `deployment` tag or the tip of `deploy/production`).

For each:
- Linear issue number + title (link to Linear)
- PR number + link
- Who merged it and when
- One-line summary of what it does

If nothing is ready: say so clearly.

### 2. PRs Open / CI In Progress
Query GitHub for open PRs targeting `master`.

For each:
- Linear issue number + title
- PR number + link
- CI status (pending / running / failed)
- How long it's been open
- Any blockers or review notes

### 3. In Progress — No PR Yet
Query Linear for issues in `In Progress` state with no associated merged PR.

For each:
- Issue number + title + priority
- Brief status (what's been done, what's left)
- Estimated time to PR (if known)

## Format

Post a clean, scannable message to `#dev`. Use Slack formatting (bold, bullets). Keep it tight — May needs to make a deploy decision in under 5 minutes.

Example structure:
```
:rocket: *Deploy Report — [date]*

*Ready to Deploy (merged to master):*
• DOD-XXX — [title] (PR #YYY, merged [time ago])
• ...

*In PR / Waiting on CI:*
• DOD-XXX — [title] (PR #YYY, CI: running, open 2h)
• ...

*In Progress — No PR Yet:*
• DOD-XXX — [title] (P1) — [brief status]
• ...
```

If a section is empty, include it with "None" so May has the full picture at a glance.

## How to Get the Data

- **GitHub PRs**: Use bash + `gh` CLI (`gh pr list`, `gh pr view`, `gh api`)
- **Merged commits not yet deployed**: `git log deploy/production..master --oneline` in `~/dev/dodi_v2`
- **Linear issues**: Use the Linear MCP to query In Progress issues for the engineering team
- **CI status**: `gh run list` or check PR status via `gh pr view --json statusCheckRollup`

Always work from `~/dev/dodi_v2`. Pull latest before querying git log.
