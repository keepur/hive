id: chief-of-staff
name: "{{agent.name}}"
icon: ":briefcase:"
model: claude-opus-4-6
channels:
  - general
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
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 50
servers:
  - memory
  - conversation-search
  - slack
  - brave-search
  - admin
  - callback
  - browser
  - keychain
