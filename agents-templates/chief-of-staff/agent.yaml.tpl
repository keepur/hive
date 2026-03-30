id: chief-of-staff
name: "{{agent.name}}"
icon: ":briefcase:"
model: claude-opus-4-6
disabled: true
channels:
  - agent-{{agent.name_lower}}
keywords:
  - status
  - update
  - task
  - schedule
  - follow up
isDefault: false
schedule:
  - cron: "0 8 * * 1-5"
    task: morning-briefing
  - cron: "0 17 * * 1-5"
    task: end-of-day-summary
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 50
servers:
  core:
    - memory
    - conversation-search
    - slack
    - callback
    - browser
    - keychain
    - event-bus
  delegate:
    - clickup
    - brave-search
subscribe:
  - system
