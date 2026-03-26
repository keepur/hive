id: executive-assistant
name: "{{agent.name}}"
icon: ":spiral_calendar_pad:"
model: claude-haiku-4-5
channels:
  - agent-{{agent.name_lower}}
keywords: []
isDefault: false
budgetUsd: 50
maxTurns: 25
schedule:
  - cron: "*/30 * * * *"
    task: check-slack-dms
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  - memory
  - contacts
  - slack
  - keychain
  - quo
  - conversation-search
  - brave-search
  - google-workspace
  - callback
