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
servers:
  - memory
  - linear
  - brave-search
  - conversation-search
  - slack
  - keychain
  - background
  - callback
plugins:
  - dodi-dev
