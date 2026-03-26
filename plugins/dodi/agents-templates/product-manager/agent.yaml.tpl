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
  - memory
  - linear
  - slack
  - contacts
  - crm-search
  - product-search
  - conversation-search
  - hubspot-crm
  - brave-search
  - google
  - callback
plugins:
  - dodi-dev
