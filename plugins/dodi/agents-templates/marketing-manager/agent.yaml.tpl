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
  core:
    - memory
    - contacts
    - crm-search
    - conversation-search
    - slack
    - callback
    - event-bus
  delegate:
    - google
    - hubspot-crm
    - linear
    - brave-search
    - permits
    - tasks
plugins:
  - dodi-dev
