id: game-designer
name: "{{agent.name}}"
icon: ":joystick:"
model: claude-sonnet-4-6
channels:
  - agent-{{agent.name_lower}}
keywords:
  - game
  - design
  - mechanic
  - level
  - gdd
  - concept
  - vision pro
  - ios
  - gameplay
isDefault: false
budgetUsd: 50
schedule:
  - cron: "0 6 * * 0"
    task: memory-review
servers:
  - memory
  - brave-search
  - slack
  - google
  - callback
