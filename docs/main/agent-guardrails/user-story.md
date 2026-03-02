# User Story: Per-Agent Guardrails

## Story

As the **CEO of Dodi**, I want each agent to only have access to the MCP tools it actually needs for its role, so that agents cannot accidentally or intentionally perform actions outside their domain (e.g., Mokie sending email, River reading secrets, Rae modifying code).

## Acceptance Criteria

1. **Hard guardrails (MCP server filtering)**:
   - Each agent's `agent.yaml` declares which MCP servers it needs via a `servers` field
   - `buildMcpServers()` in `agent-runner.ts` filters output to only include declared servers
   - Agents without a `servers` field get all servers (backward compatibility)
   - Server assignment matches this matrix:

   | Server | Mokie | Rae | River | Jasper |
   |--------|:-----:|:---:|:-----:|:------:|
   | memory | Y | Y | Y | Y |
   | slack | Y | Y | Y | Y |
   | brave-search | Y | Y | Y | Y |
   | tasks | Y | Y | Y | Y |
   | contacts | Y | Y | Y | Y |
   | google | - | Y | - | - |
   | quo | - | Y | - | - |
   | keychain | - | Y | - | Y |
   | linear | - | - | Y | Y |

2. **Soft guardrails (system prompt boundaries)**:
   - Each agent's `system-prompt.md.tpl` has a `## Guardrails` section
   - Guardrails cover: bash/filesystem restrictions, escalation requirements, tool boundary explanations
   - Mokie: cannot modify code repos, delegates email/SMS/Linear
   - Rae: customer email requires May's approval, cannot modify code repos
   - River: cannot send email/SMS, Linear scoped to marketing team
   - Jasper: full code access (only agent), no email/SMS, announce before restarts

3. **System compiles and Hive restarts cleanly** after all changes

## Out of Scope

- Audit logging of tool calls (separate future task)
- Hard gating bash/filesystem (requires SDK permission callback — significant scope)
- Per-agent Linear team scoping (Linear MCP would need env var filtering)
- Per-agent Quo phone line scoping (moot since only Rae gets Quo)
