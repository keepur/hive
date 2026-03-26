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
  - memory
  - contacts
  - slack
  - keychain
  - quo
  - crm-search
  - conversation-search
  - hubspot-crm
  - brave-search
  - tasks
  - google
  - callback
plugins:
  - dodi-dev
