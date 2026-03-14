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
budgetUsd: 50
servers:
  - memory
  - contacts
  - crm-search
  - hubspot-crm
  - linear
  - brave-search
  - slack
  - permits
  - tasks
  - google-workspace
  - callback
plugins:
  - dodi-dev
