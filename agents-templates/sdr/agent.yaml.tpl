id: sdr
name: "{{agent.name}}"
icon: ":rocket:"
model: claude-sonnet-4-6
channels:
  - sales
  - leads
keywords:
  - lead
  - prospect
  - outreach
  - follow up
  - pipeline
  - deal
  - qualify
isDefault: false
schedule:
  - cron: "0 8 * * 1-5"
    task: morning-pipeline-review
  - cron: "0 14 * * 1-5"
    task: afternoon-follow-ups
  - cron: "0 17 * * 5"
    task: weekly-pipeline-summary
budgetUsd: 50
maxTurns: 30
servers:
  - memory
  - contacts
  - crm-search
  - hubspot-crm
  - resend
  - brave-search
  - slack
  - google
  - tasks
