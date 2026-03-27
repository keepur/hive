id: product-manager
name: "{{agent.name}}"
icon: ":bulb:"
model: claude-haiku-4-5
channels:
  - product
  - bugs
keywords: []
isDefault: false
budgetUsd: 50
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - contacts
    - crm-search
    - product-search
    - conversation-search
    - callback
  delegate:
    - linear
    - hubspot-crm
    - brave-search
    - google
plugins:
  - dodi-dev
