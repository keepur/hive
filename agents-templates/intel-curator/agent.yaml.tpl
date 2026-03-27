id: intel-curator
name: "{{agent.name}}"
icon: ":brain:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - research
  - news
  - trends
  - briefing
  - intelligence
  - update
  - curate
isDefault: false
schedule:
  - cron: "0 7 * * 1-5"
    task: daily-intel-brief
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 50
servers:
  core:
    - memory
    - conversation-search
    - slack
    - callback
  delegate:
    - clickup
    - brave-search
