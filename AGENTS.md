# Hive — Codex Instructions

## Workflow

- **Major planning work**: After a plan is approved, always run `/spec-and-implement` to generate specification documents and delegate parallel implementation. Never skip this step for non-trivial architectural changes.

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
- Engine-internal Mongo-backed MCP servers run in process; vendor/tool servers such as `voice-livekit` run as stdio subprocesses of agent sessions
- Agent identity layers: `soul.md` (personality) + `system-prompt.md` (role) + `memory.md` (knowledge)

## Voice (KPR-320)

- The LiveKit media worker (`src/voice-worker/`) runs separately as `com.hive.<instance-id>.voice-worker` from a built checkout's `dist/voice-worker/main.js` plus `node_modules`; the npm tarball does not include the worker. The engine's loopback voice endpoint authenticates the bridge with `HIVE_VOICE_BRIDGE_TOKEN` and aborts the current turn on disconnect.
- `voice-livekit` is the outbound-call MCP server; `voice` remains the separate Vapi server. Per-agent Cartesia voice IDs belong in instance config at `voice.livekit.agentVoices`.
- `voice.warmPath.enabled` defaults off and enables Claude-only per-call leases that hold one thread lock and budget slot; barge-in interrupts the turn while retaining the lease. `voice.toolAck.enabled` defaults on and injects spoken hold phrases through the existing text stream. Detailed contracts live in [CLAUDE.md](./CLAUDE.md#spawn-coordinator-kpr-220).
- The epic closes at Phase 0. KPR-321's unresolved telephony ops are outside that closure; the vendor pilot remains deferred Phase 1, and KPR-462 owns live-call reliability follow-up. Implementation and internal call evidence do not establish that the designed SIP/P/W/T gates passed.
