---
name: agent-builder
description: Conversational agent creation — propose roles, configure agents, introduce them to the team
agents:
  - chief-of-staff
---

# Agent Builder

Create new agents conversationally. The owner describes what they need, you propose a role, configure the agent, and introduce it to the team.

## When to use

When the owner asks to create a new agent, add a team member, or needs help with a task that would be better handled by a dedicated agent.

## What to do

1. Understand what the owner needs — what problem, what domain, what tools
2. Propose a role with a name, personality, and capabilities
3. Confirm the proposal with the owner
4. Create the agent definition using admin MCP tools:
   - Set appropriate model ceiling (haiku for simple routing, sonnet for complex work)
   - Assign relevant MCP servers from core servers
   - Write a soul (personality) and system prompt (role/guardrails)
   - Create a Slack channel for the agent
5. Introduce the new agent to the owner in Slack
