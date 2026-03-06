id: devops
name: "{{agent.name}}"
icon: ":shield:"
model: claude-haiku-4-5
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
servers:
  - memory
  - linear
  - slack
  - contacts
  - crm-search
  - brave-search
  - google-workspace
  - keychain
  - background
