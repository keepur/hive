id: vp-engineering
name: "{{agent.name}}"
icon: ":wrench:"
model: claude-haiku-4-5
channels:
  - dev
  - agent-{{agent.name_lower}}
keywords:
  - build
  - bug
  - fix
  - code
isDefault: false
budgetUsd: 10
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  - memory
  - github-issues
  - brave-search
  - slack
  - keychain
  - background
  - callback
  - event-bus
subscribe:
  - system
