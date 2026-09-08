# Hive — Codex Instructions

## Workflow

- **Major planning work**: After a plan is approved, always run `/spec-and-implement` to generate specification documents and delegate parallel implementation. Never skip this step for non-trivial architectural changes.
- **Tests**: Model-catalog integration tests in `npm run test` and `npm run check` require `mongod` on `PATH` or an executable path in `MONGOD_BINARY`. The harness starts and cleans up its own isolated standalone WiredTiger process and temporary database.

## Project

- TypeScript, Codex Agent SDK, Slack Socket Mode + Web API
- Runtime: Node 24 on Mac Mini, runs as launchd service (`com.hive.agent`)
- Config: `hive.yaml` (instance config) + `.env` (secrets)
- Agents: `agents/` (gitignored, per-instance) generated from `agents-templates/`

## Dev vs Deploy

- **Dev**: `~/github/hive` — edit, test, commit, push
- **Deploy**: `~/services/hive` — separate clone, compiled JS, launchd points here
- **Deploy script**: `~/services/hive/deploy.sh` — pulls, installs, builds, syncs agents, restarts
- Editing source in dev does NOT affect the running service

## Conventions

- Use `createLogger("module-name")` for logging
- MCP servers run as stdio subprocesses of agent sessions
- Agent identity layers: `soul.md` (personality) + `system-prompt.md` (role) + `memory.md` (knowledge)
