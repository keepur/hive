id: client-experience
name: "{{agent.name}}"
icon: ":handshake:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - onboarding
  - deployment
  - service
  - setup
  - client
  - install
  - concierge
  - support
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
    - callback
  delegate:
    - clickup
    - brave-search
    - google
