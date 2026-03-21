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
servers:
  - memory
  - contacts
  - conversation-search
  - brave-search
  - slack
  - google-workspace
  - callback
