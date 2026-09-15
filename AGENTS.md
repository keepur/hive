# Hive — Codex Instructions

## Workflow

- **Major planning work**: After a plan is approved, generate specification documents and delegate parallel implementation through the dodi-dev plan-review and delivery gates (the user authorized dodi-dev in place of the unavailable `/spec-and-implement` entrypoint — record `ac95b136`). Never skip that step for non-trivial architectural changes. The substitution does not establish operational prerequisites or authorize live calls.

## Project

- TypeScript, Codex Agent SDK, Slack Socket Mode + Web API
- Runtime: Node `>=22.19.0` (declared); operational native proof is macOS ARM64 Node 24. Services run as launchd `com.hive.<instance-id>.agent` plus, when LiveKit is enabled, `com.hive.<instance-id>.voice-worker`
- Config: `hive.yaml` (instance config) + `.env` (secrets)
- Agents: `agents/` (gitignored, per-instance) generated from `agents-templates/`

## Dev vs Deploy

- **Dev**: `~/github/hive` — edit, test, commit, push
- **Deploy**: `~/services/hive/<instance>/` — instance dir; replaceable package is `<instance>/.hive/` (`pkg/server.min.js`, `pkg/voice-worker.min.js`, locked `node_modules`)
- **Deploy helper**: `hive update` / `hive rollback` / `hive start --daemon` / `hive stop` freeze and invoke this package's `pkg/deploy.min.js`. `HIVE_SINGLE_INSTANCE=1` makes `service/deploy.sh` exec that helper. See [docs/epics/kpr-462/kpr-463-operations.md](docs/epics/kpr-462/kpr-463-operations.md)
- Editing source in dev does NOT affect the running service

## Conventions

- Use `createLogger("module-name")` for logging
- Engine-internal Mongo-backed MCP servers run in process; vendor/tool servers such as `voice-livekit` run as stdio subprocesses of agent sessions
- Agent identity layers: `soul.md` (personality) + `system-prompt.md` (role) + `memory.md` (knowledge)

## Voice (KPR-320 / KPR-463)

- The LiveKit media worker (`src/voice-worker/`) runs separately as `com.hive.<instance-id>.voice-worker` from the packaged entry `<instance>/.hive/pkg/voice-worker.min.js start`. The npm tarball includes the worker. A built checkout's `dist/voice-worker/main.js` is not the supported production path. The engine's loopback voice endpoint authenticates the bridge with `HIVE_VOICE_BRIDGE_TOKEN` and aborts the current turn on disconnect.
- `voice-livekit` is the outbound-call MCP server; `voice` remains the separate Vapi server. Per-agent Cartesia voice IDs belong in instance config at `voice.livekit.agentVoices`.
- `voice.warmPath.enabled` defaults off and enables Claude-only per-call leases that hold one thread lock and budget slot; barge-in interrupts the turn while retaining the lease. `voice.toolAck.enabled` defaults on and injects spoken hold phrases through the existing text stream. Detailed contracts live in [CLAUDE.md](./CLAUDE.md#spawn-coordinator-kpr-220).
- The epic closes at Phase 0. KPR-321's unresolved telephony ops are outside that closure; the vendor pilot remains deferred Phase 1; KPR-462 owns live-call reliability follow-up; KPR-466 owns live-call acceptance after T9. Implementation and internal call evidence do not establish that the designed SIP/P/W/T gates passed. Dodi packaged migration (T9) and Node-24 T10 closure remain pending.
