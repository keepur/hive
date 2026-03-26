id: marketing-manager
name: "{{agent.name}}"
icon: ":art:"
model: claude-sonnet-4-6
channels:
  - agent-river
passiveChannels:
  - marketing
keywords: []
isDefault: false
schedule:
  - cron: "0 9 * * 1-5"
    task: marketing-pulse
  - cron: "0 6 * * 0"
    task: memory-review
budgetUsd: 50
servers:
  - memory
  - google
  - contacts
  - crm-search
  - conversation-search
  - hubspot-crm
  - linear
  - brave-search
  - slack
  - permits
  - tasks
  - callback
  - event-bus
plugins:
  - dodi-dev
