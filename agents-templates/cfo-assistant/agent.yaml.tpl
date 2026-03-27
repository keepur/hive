id: cfo-assistant
name: "{{agent.name}}"
icon: ":chart_with_upwards_trend:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords: []
isDefault: false
budgetUsd: 25
maxTurns: 25
schedule: []
servers:
  core:
    - memory
    - slack
    - callback
  delegate:
    - clickup
    - google
    - brave-search
