id: personal-coach
name: "{{agent.name}}"
icon: ":seedling:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - coach
  - coaching
  - training
  - health
  - reflection
  - goal
  - accountability
  - personal
  - growth
isDefault: false
budgetUsd: 50
schedule:
  - cron: "0 8 * * 1"
    task: weekly-check-in
  - cron: "0 16 * * 5"
    task: friday-reflection
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - conversation-search
    - slack
    - callback
  delegate:
    - clickup
    - brave-search
    - google
