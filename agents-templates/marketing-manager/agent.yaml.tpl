id: marketing-manager
name: "{{agent.name}}"
icon: ":art:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
  - marketing
keywords: []
isDefault: false
schedule:
  - cron: "0 9 * * 1-5"
    task: marketing-pulse
budgetUsd: 50
servers:
  - memory
  - google
  - contacts
  - conversation-search
  - brave-search
  - slack
  - google-workspace
  - callback
