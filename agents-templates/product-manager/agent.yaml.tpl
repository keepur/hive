id: product-manager
name: "{{agent.name}}"
icon: ":bulb:"
model: claude-haiku-4-5
channels:
  - product
  - bugs
  - agent-{{agent.name_lower}}
keywords: []
isDefault: false
budgetUsd: 50
servers:
  - memory
  - slack
  - contacts
  - conversation-search
  - brave-search
  - google-workspace
  - github-issues
  - callback
