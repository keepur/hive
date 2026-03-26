id: vp-engineering
name: "{{agent.name}}"
icon: ":wrench:"
model: claude-haiku-4-5
channels:
  - dev
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
  - linear
  - brave-search
  - conversation-search
  - slack
  - keychain
  - background
  - callback
  - code-task
plugins:
  - dodi-dev
