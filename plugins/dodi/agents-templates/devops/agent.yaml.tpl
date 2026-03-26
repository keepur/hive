id: devops
name: "{{agent.name}}"
icon: ":shield:"
model: claude-sonnet-4-6
channels:
  - devops
keywords:
  - deploy
  - restart
  - logs
  - status
isDefault: false
budgetUsd: 25
maxTurns: 15
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  - memory
  - linear
  - slack
  - contacts
  - crm-search
  - conversation-search
  - brave-search
  - google-workspace
  - keychain
  - background
  - callback
plugins:
  - dodi-dev
