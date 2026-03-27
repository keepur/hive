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
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - contacts
    - conversation-search
    - callback
  delegate:
    - clickup
    - brave-search
    - google
    - github-issues
