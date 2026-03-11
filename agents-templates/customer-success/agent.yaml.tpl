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
servers:
  - memory
  - crm-search
  - product-search
  - hubspot-crm
  - contacts
  - slack
  - brave-search
  - tasks
  - resend
  - quo
  - google-workspace
