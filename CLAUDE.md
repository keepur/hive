# Hive — Claude Code Instructions

## Workflow

- **Major planning work**: After a plan is approved, always run `/spec-and-implement` to generate specification documents and delegate parallel implementation. Never skip this step for non-trivial architectural changes.

## Project

- TypeScript, Claude Agent SDK, Slack Socket Mode + Web API
- Runtime: Node 24 on Mac Mini, runs as launchd service
- Config: `hive.yaml` (instance config) + `.env` (secrets)
- Agents: `agents/` (gitignored, per-instance) generated from `agents-templates/`

## Conventions

- Use `createLogger("module-name")` for logging
- MCP servers run as stdio subprocesses of agent sessions
- Agent identity layers: `soul.md` (personality) + `system-prompt.md` (role) + `memory.md` (knowledge)
