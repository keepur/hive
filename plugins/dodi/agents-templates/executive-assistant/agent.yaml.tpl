id: executive-assistant
name: "{{agent.name}}"
icon: ":spiral_calendar_pad:"
model: claude-haiku-4-5
channels:
  - quo-may
  - agent-rae
keywords: []
isDefault: false
budgetUsd: 50
maxTurns: 25
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - contacts
    - slack
    - keychain
    - crm-search
    - conversation-search
    - callback
  delegate:
    - quo
    - hubspot-crm
    - brave-search
    - tasks
    - google
plugins:
  - dodi-dev
