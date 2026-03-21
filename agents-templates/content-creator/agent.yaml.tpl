id: content-creator
name: "{{agent.name}}"
icon: ":pencil2:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - content
  - post
  - article
  - draft
  - write
  - linkedin
  - thought leadership
  - blog
isDefault: false
budgetUsd: 50
servers:
  - memory
  - brave-search
  - slack
  - google-workspace
  - callback
