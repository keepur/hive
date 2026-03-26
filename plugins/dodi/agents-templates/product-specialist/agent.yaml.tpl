id: product-specialist
name: "{{agent.name}}"
icon: ":wrench:"
model: claude-sonnet-4-6
channels:
  - agent-wyatt
keywords:
  - catalog
  - part
  - sku
  - door
  - insert
  - pullout
  - hinge
  - panel
  - hardware
  - price
  - pricing
  - lead time
isDefault: false
budgetUsd: 20
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  - memory
  - catalog
  - product-search
  - conversation-search
  - slack
  - callback
plugins:
  - dodi-dev
