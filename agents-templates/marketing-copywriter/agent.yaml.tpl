id: marketing-copywriter
name: "{{agent.name}}"
icon: ":fountain_pen:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - copy
  - content
  - social
  - linkedin
  - post
  - headline
  - brand
  - voice
  - campaign
isDefault: false
budgetUsd: 50
schedule:
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
