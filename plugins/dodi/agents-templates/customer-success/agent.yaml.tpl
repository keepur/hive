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
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  - memory
  - google
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
  - dodi-ops
  - callback
  - event-bus
subscribe:
  - deals
  - jobs
plugins:
  - dodi-dev
