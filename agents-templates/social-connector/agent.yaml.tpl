id: social-connector
name: "{{agent.name}}"
icon: ":handshake:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - outreach
  - linkedin
  - dinner
  - party
  - connect
  - networking
  - relationship
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
    - brave-search
    - google
