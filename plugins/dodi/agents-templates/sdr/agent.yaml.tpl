id: sdr
name: "{{agent.name}}"
icon: ":rocket:"
model: claude-haiku-4-5
channels:
  - agent-milo
keywords:
  - lead
  - prospect
  - outreach
  - follow up
  - qualify
isDefault: false
schedule:
  - cron: "0 8 * * 1-5"
    task: morning-pipeline-review
  - cron: "0 14 * * 1-5"
    task: afternoon-follow-ups
  - cron: "0 17 * * 5"
    task: weekly-pipeline-summary
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 50
maxTurns: 30
servers:
  core:
    - memory
    - contacts
    - crm-search
    - conversation-search
    - slack
    - callback
    - event-bus
  delegate:
    - google
    - hubspot-crm
    - resend
    - brave-search
    - permits
    - tasks
subscribe:
  - cases
  - leads
plugins:
  - dodi-dev
