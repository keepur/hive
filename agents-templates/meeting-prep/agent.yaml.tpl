id: meeting-prep
name: "{{agent.name}}"
icon: ":mag:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - meeting
  - prep
  - brief
  - agenda
  - background
  - preparing
isDefault: false
schedule:
  - cron: "0 6 * * 1-5"
    task: daily-meeting-prep
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 50
servers:
  core:
    - memory
    - contacts
    - conversation-search
    - slack
    - callback
  delegate:
    - clickup
    - brave-search
    - google
