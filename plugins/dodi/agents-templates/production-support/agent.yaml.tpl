id: production-support
name: "{{agent.name}}"
icon: ":hammer_and_wrench:"
model: claude-sonnet-4-6
channels:
  - agent-sige
keywords:
  - production
  - fabrication
  - cutlist
  - assembly
  - shop floor
  - material
isDefault: false
budgetUsd: 50
maxTurns: 25
dodiOpsMode: readonly
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - contacts
    - ops-search
    - conversation-search
    - callback
    - event-bus
  delegate:
    - dodi-ops
    - hubspot-crm
    - tasks
subscribe:
  - deals
  - cases
plugins:
  - dodi-dev
