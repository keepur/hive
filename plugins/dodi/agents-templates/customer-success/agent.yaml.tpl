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
  core:
    - memory
    - slack
    - callback
    - event-bus
    - conversation-search
    - crm-search
    - product-search
    - contacts
  delegate:
    - hubspot-crm
    - dodi-ops
    - google
    - resend
    - quo
    - brave-search
    - tasks
subscribe:
  - deals
  - jobs
plugins:
  - dodi-dev
