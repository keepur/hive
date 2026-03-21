id: meeting-prep
name: "{{agent.name}}"
icon: ":mag:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - meeting
  - prep
  - brief
  - agenda
  - background
  - preparing
isDefault: false
schedule:
  - cron: "0 6 * * 1-5"
    task: daily-meeting-prep
budgetUsd: 50
servers:
  - memory
  - contacts
  - conversation-search
  - brave-search
  - slack
  - google
  - google-workspace
  - callback
