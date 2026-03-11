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
servers:
  - memory
  - dodi-ops
  - slack
  - contacts
  - ops-search
  - hubspot-crm
  - tasks
  - callback
