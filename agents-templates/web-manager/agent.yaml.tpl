id: web-manager
name: "{{agent.name}}"
icon: ":globe_with_meridians:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - website
  - web
  - site
  - page
  - update
  - publish
  - seo
  - design
isDefault: false
budgetUsd: 50
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  core:
    - memory
    - conversation-search
    - slack
    - browser
    - callback
  delegate:
    - clickup
    - brave-search
    - google
