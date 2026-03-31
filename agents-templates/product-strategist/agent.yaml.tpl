id: product-strategist
name: "{{agent.name}}"
icon: ":dart:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
  - product
keywords:
  - product
  - positioning
  - pricing
  - packaging
  - gtm
  - buyer
  - market
  - strategy
  - launch
isDefault: false
budgetUsd: 50
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - contacts
    - conversation-search
    - slack
    - callback
  delegate:
    - clickup
    - brave-search
    - google
    - github-issues
