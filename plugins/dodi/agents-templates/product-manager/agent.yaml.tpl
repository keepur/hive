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
  - google-workspace
  - callback
plugins:
  - dodi-dev
