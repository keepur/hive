id: book-club
name: "{{agent.name}}"
icon: ":books:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - book
  - reading
  - kindle
  - audible
  - library
  - recommend
isDefault: false
schedule:
  - cron: "0 9 * * 1"
    task: biweekly-reading-picks
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 25
servers:
  core:
    - memory
    - conversation-search
    - slack
    - callback
  delegate:
    - clickup
    - brave-search
