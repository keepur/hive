id: executive-assistant
name: "{{agent.name}}"
icon: ":incoming_envelope:"
model: claude-haiku-4-5
channels:
  - general
  - agent-{{agent.name_lower}}
keywords: []
isDefault: true
budgetUsd: 10
maxTurns: 10
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - conversation-search
