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
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - slack
    - callback
  delegate:
    - brave-search
    - google
