id: customer-success
name: "{{agent.name}}"
icon: ":handshake:"
model: claude-sonnet-4-6
channels:
  - agent-jessica
passiveChannels:
  - biz
keywords:
  - customer
  - client
  - deal
  - order
  - account
isDefault: false
budgetUsd: 50
maxTurns: 30
dodiOpsMode: full
servers:
  - memory
  - crm-search
  - product-search
  - conversation-search
  - hubspot-crm
  - contacts
  - slack
  - brave-search
  - tasks
  - resend
  - quo
  - google-workspace
  - dodi-ops
plugins:
  - dodi-dev
