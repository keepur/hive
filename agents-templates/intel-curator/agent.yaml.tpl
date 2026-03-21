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
budgetUsd: 50
servers:
  - memory
  - brave-search
  - slack
  - callback
