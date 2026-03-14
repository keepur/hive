id: chief-of-staff
name: "{{agent.name}}"
icon: ":briefcase:"
model: claude-sonnet-4-6
channels:
  - agent-mokie
  - general
passiveChannels:
  - marketing
  - biz
  - devops
keywords:
  - status
  - update
  - task
  - schedule
  - follow up
isDefault: true
schedule:
  - cron: "0 8 * * 1-5"
    task: morning-briefing
  - cron: "0 17 * * 1-5"
    task: end-of-day-summary
budgetUsd: 50
servers:
  - memory
  - contacts
  - crm-search
  - product-search
  - ops-search
  - hubspot-crm
  - slack
  - brave-search
  - permits
  - tasks
  - recall
  - google-workspace
  - admin
  - callback
  - dodi-ops
plugins:
  - dodi-dev
