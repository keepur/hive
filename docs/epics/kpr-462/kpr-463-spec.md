# KPR-463 — Deploy the engine and voice worker from the instance package

## TL;DR

Extend Hive's existing npm package and per-instance `.hive` lifecycle so an enabled LiveKit voice worker ships, installs, starts, updates, and rolls back with the engine. Dodi's deployment must ultimately use instance-owned artifacts and dependencies, with verified service paths, release identity, bridge authentication, LiveKit registration, restart, rollback, and preservation of operator state; writing or implementing this spec alone does not complete that migration. This specification authorizes no deployment or live call during maturation.

## Key Points

- Ship `pkg/voice-worker.min.js` in `@keepur/hive`, keep the LiveKit/native packages external to the bundle, and install their pinned production dependency tree inside `.hive/node_modules`.
- Reuse `.hive.next`, `.hive`, `.hive.prev`, and `.hive.broken`; engine and enabled worker form one release unit. Extend existing daemon/update/rollback paths rather than introduce another deployment system.
- Keep `hive.yaml`, `.env`, Honeypot credentials, agent data, plugins, skills, logs, and `.hive-state` outside the replaceable package. Preserve Twilio → LiveKit → Deepgram/Cartesia and Mokie's `voice-livekit` routing.
- An engine boot marker or worker heartbeat alone is insufficient: require both running service identities, authenticated bridge admission without a model turn, and current LiveKit registration health.
- Validate a real packed artifact with a fresh production install and native audio loading. A test that symlinks the development `node_modules` cannot satisfy this ticket.
- Scope operational migration to dodi. Preserve both pilot worktrees until verified migration and a usable rollback path exist; their retirement is a later cleanup action.
- KPR-466 consumes the deployment evidence described below and owns caller-perceived end-to-end acceptance. No latency target, warm-path default, vendor rollout, or telephony provisioning is selected here.
- ⚠ Delegated choices: one npm package, publishable dependency lock, macOS/Apple Silicon on Node 24 as the deployment acceptance host, and a per-instance loopback worker health port. These choices need review through the child workflow, but no human question blocks drafting.

## 1. Authority, scope, and inputs

**Ticket:** [KPR-463](https://linear.app/keepur/issue/KPR-463). **Epic:** [KPR-462](https://linear.app/keepur/issue/KPR-462). **Upstream:** KPR-320 merged through PR #471 at `349d6d44bdb1d2fa410fce1ca19060fa314de005`; this worktree is based on that commit. **Downstream:** KPR-463 blocks KPR-466. KPR-464 owns startup/speech telemetry and is independently scoped; KPR-465 follows KPR-464.

Gate 1 approval and routine spec/plan delegation are recorded in [epic comment d762e351](https://linear.app/keepur/issue/KPR-462#comment-d762e351-4364-48c6-836d-1349564c8e7e). Live calls still require May's execution go; the epic PR merge remains human-owned. KPR-450 may proceed in its isolated worktrees; this ticket must not operate on those worktrees or services.

The supplied epic description has **no `Decision Register — Canon` summary**. There are no merged sibling decisions to import from a canon section. The signed-off scope and comments remain binding. Ticket/epic facts were read from the driver's 2026-09-08 snapshot; runtime pilot paths below are supplied operational facts, not a new live inspection or migration claim.

### Problem

Dodi's engine runs `pkg/server.min.js` from `/Users/mokie/github/kpr-320-live-call`, and `com.hive.dodi.voice-worker` runs that checkout's `dist/voice-worker/main.js`. Its `node_modules` links to `/Users/mokie/github/kpr-320-work/node_modules`. Removing either development worktree can break the instance. A normal npm install/update cannot replace this arrangement today.

### Goals

1. A fresh supported install and an update supply both executable services and all runtime dependencies without a development checkout.
2. Both services demonstrably run the intended artifact/revision and the same unchanged instance identity/configuration.
3. Start, stop, update, restart, failed-update recovery, and rollback handle the enabled worker with the engine.
4. Dodi migrates to the supported layout with checked evidence and an exercised recovery path, while Keepur remains unaffected.

### Non-goals

No container/orchestrator adoption, separate worker product, multi-host rollout manager, general deployment journal, fleet migration, new automatic update policy, zero-downtime deployment, active-call migration, DB/schema migration, credential rotation, vendor changes, inbound rollout, SIP object creation, caller-ID/CNAM work, ambience, voice cloning, vendor A/B, or changes to warm execution and speech timing. KPR-321 retains its telephony operations; upstream designed SIP/P/W/T gates are not retrospectively passed by this work.

## 2. Repository findings that constrain the design

| Surface | Current behavior | Consequence |
| --- | --- | --- |
| `package.json`, `build/bundle.ts` | `pkg/` ships; `dist/` and source do not. Engine/CLI/MCP bundles exist, including `voice-livekit`; the worker has no entrypoint. Six LiveKit worker dependencies are `devDependencies`. | Add a publishable worker and production dependencies without publishing the whole `dist` tree. |
| `src/setup/populate-engine.ts` | `hive init` copies package entries into instance `.hive` and uses `npm install --omit=dev`; resume considers any existing `node_modules` sufficient. | The same artifact/dependency validation must cover init, resume, and update; a partial directory is not a completed install. |
| `src/cli/daemon.ts` | `hive start --daemon`/`stop` manage the engine only. Plists are stored in instance `service/` and linked from user LaunchAgents. | Extend the packaged service path; worker support solely in the source setup script would not solve deployment. |
| `setup/generate-plist.ts`, `service/install.sh` | Source setup generates a worker plist using `dist`; the installer loads only engine/log/deploy services. | Remove conflicting production guidance and share/delegate production service generation to the packaged path. |
| `src/cli/update.ts`, `rollback.ts`, `single-instance-env.ts`, `service/deploy.sh` | Per-instance `.hive` swap/rollback exists. The script stops and checks only the engine, uses floating dependency installation, and can fall back to a build directory after npm failure. | Extend this lifecycle to the pair, stage before stopping, and fail closed on unresolved supported artifacts. |
| `src/voice-worker/main.ts`, `worker-config.ts` | Worker uses shared config/env/Honeypot resolution; forks load its agent module; entrypoint guard is symlink-safe. Heartbeat starts before `cli.runApp`. | Preserve job loading and the guard; heartbeat is liveness, not proof of registration. |
| `src/channels/voice/voice-adapter.ts` | A bridge-authenticated `POST /v1/chat/completions` without an agent returns a known 400 before spawning. Existing `GET /health` follows the Vapi secret path. | Use the safe malformed bridge request for deployment auth verification; do not assume bridge credentials authorize the existing health route. |
| `scripts/check-bundle-runtime.mjs` | Relocation smoke tests link repository `node_modules`; a config failure can count as a successful load. | Add a real artifact acceptance check with explicit success conditions. |

`CLAUDE.md` describes the current `.hive` instance layout and supersedes the older clone-based description in the short `AGENTS.md` for choosing the supported installer. Preserve `createLogger(...)`, secret resolution, and the separate worker-process conventions in both files.

## 3. Artifact and dependency contract

### 3.1 One release unit

The existing `@keepur/hive` tarball gains `pkg/voice-worker.min.js`. The engine remains `pkg/server.min.js`, CLI remains `pkg/cli.min.js`, and `pkg/mcp/voice-livekit.min.js` remains the outbound MCP server. The production worker invocation is:

```text
<absolute node path> <instance>/.hive/pkg/voice-worker.min.js start
```

Bundle Hive-owned worker code using existing esbuild conventions. Externalize `@livekit/agents`, all currently imported LiveKit plugins, and `@livekit/rtc-node`, retaining their installed SDK process helpers, native libraries, and model assets. Do not bundle the SDK's dynamically located job/inference modules or copy platform binaries out of their packages. The existing `defineAgent` default export and symlink-safe main guard must work both when directly launched and when imported by a forked SDK process; importing the agent module must not launch a second supervisor.

Promote the six existing pinned LiveKit entries to production dependencies, preserving their current versions. ElevenLabs remains installed because `session.ts` imports it, without enabling or changing that vendor. Dependency pruning or lazy vendor loading is outside this ticket. The tradeoff is a larger production dependency installation even on voice-disabled instances; no worker starts or credential validation runs there.

### 3.2 Reproducible installation

Publish `npm-shrinkwrap.json` generated deterministically from the reviewed repository lockfile during packaging. Keep `package-lock.json` as the development source of truth and guard generated shrinkwrap equality; do not maintain two hand-edited dependency trees. Copy the shrinkwrap in every package-population path and install staged production dependencies with `npm ci --omit=dev` using the recorded deployment npm version and required native install scripts. Reject a missing/inconsistent lock in artifacts that declare this new deployment contract. npm documents publishable shrinkwrap for deployed CLI/daemon applications, and `npm ci` fails a manifest/lock mismatch rather than rewriting the lock. [npm shrinkwrap](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

Reproducible means the same Hive artifact and locked dependency versions on the same supported OS/architecture/Node/npm environment. It does not promise bit-identical native compilation across machines or offline dependency installation. Record native/install prerequisites and fail before switching services when they are absent. Resume must rerun/verify a complete install after interruption; existence of `node_modules` alone is insufficient.

Accept a resolved npm release or an explicitly supplied local packed `.tgz` through `hive update --artifact=<absolute-path>` (mutually exclusive with `--tag`). The artifact option uses the same extraction, validation, dependency installation, staging, and health path; it permits testing and migrating a reviewed candidate without an npm publication or an implicit checkout fallback. Record its digest and source revision. Registry/tag failure must never silently substitute code from `BUILD_DIR`. The legacy multi-instance developer build mode may remain, but invoking a supported single-instance update must not read a build checkout or global instance registry.

First adoption must work when the installed CLI/deploy script does not understand this contract. Document a bootstrap from the validated candidate tarball into temporary tooling under the instance's `.hive-state`: install its locked dependencies and invoke its packaged CLI with explicit `HIVE_HOME`/`HIVE_CONFIG`. That CLI must execute its own matching deployment implementation, not fall back to the old installed `.hive/service/deploy.sh`. The resulting live plists still point only to `.hive/pkg`. The same verified tooling must remain available through migration rollback/reapply, and tests must exercise this old-updater-to-new-artifact path.

### 3.3 Release identity

Ship `pkg/release.json` containing a small versioned manifest: package version, full source revision, dependency-lock digest, and worker artifact capability/path. Produce it from the build input, not the operator's working directory. A release/candidate with unknown or dirty provenance is ineligible for dodi migration. Record the tarball SHA-256 separately in deployment evidence; do not embed a self-referential archive digest.

At boot, both services log the same release identity plus component, PID, and boot identifier using `createLogger`. The worker supervisor also exposes this identity on its existing heartbeat; job counter updates must not overwrite supervisor identity or liveness. CLI/doctor output must distinguish installed artifact identity from the identity reported by the running processes. Preserve the existing engine startup markers used by deploy checks.

An offline worker diagnostic must verify version/manifest consistency, real imports of the production SDK/plugins/native RTC, and Silero model loading, then exit explicitly successful. It must not load operator secrets, connect Mongo/LiveKit, dispatch a room, start a model turn, or place a call. The implementation plan may choose a dedicated packaged helper rather than overload SDK CLI parsing. No `.ts`, `tsx`, global LiveKit installation, repository root, or development dependency can be necessary on the runtime path.

## 4. Instance and service contract

Use the existing instance home discovered by `resolveHiveHome`; dodi's intended root is `~/services/hive/dodi`, subject to read-back during the migration inventory. Both plists have that `WorkingDirectory`, explicit `HIVE_HOME`, and the same explicit `HIVE_CONFIG` selection when supplied. Preserve `HOME` for the current user's Keychain and the required operational `PATH`. Engine and worker resolve the same instance ID, Mongo database identity, bridge port/token, vendor configuration, and per-agent voices through the shared loader.

Store generated plists at `<instance>/service/com.hive.<id>.{agent,voice-worker}.plist`, linked from that user's LaunchAgents directory. Executable paths are absolute and point inside `.hive/pkg`; no generated production plist contains `src`, `dist`, a pilot checkout, `npx`, or a borrowed `node_modules`. Escape XML values and support spaces, ampersands, and symlinked instance homes. Verify canonical paths for containment without rejecting an intentional instance-home symlink whose target is outside development worktrees.

Preserve stable labels and per-instance logs. `hive start --daemon` installs/starts engine and, only when `voice.livekit.enabled === true`, worker. `hive stop` stops both target-instance labels, including a previously installed worker after voice has been disabled. Repeating start/stop is idempotent. With voice disabled, leave no enabled stale worker LaunchAgent that could return at login; ordinary engine use requires no voice keys or LiveKit connectivity. Foreground `hive start` keeps its existing engine behavior, with the separate worker command documented.

Use the SDK's existing health listener bound to `127.0.0.1`, with a deterministic per-instance port: `instance.ports.voiceWorker` override, otherwise `instance.portBase + 7`. Validate the port and collisions with the instance's other resolved listeners before service changes. This avoids the SDK-wide default port colliding across instances. The resolved port must be used consistently by worker options and lifecycle probes; a collision with another process fails without killing that process.

The pinned SDK supplies registration-aware `GET /` health and a `GET /worker` response with agent name and active job count. Use those facilities; no new public control server is needed. An HTTP 200 from `/worker` alone is not a readiness result. [LiveKit 1.6.4 worker](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/worker.ts), [HTTP server](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/http_server.ts).

Generated plists contain no credential values. Preserve `.env`/alternate dotenv files, Keychain namespaces, per-agent voice maps, Mokie's server inventory, agent model selection, and voice flags. Missing credentials are reported by key name, never value. Retain the env-first/Keychain-second shared loader behavior; do not add another secrets store or treat an interactive shell's exported keys as proof that launchd can resolve them.

## 5. Lifecycle and recovery

### 5.1 Update transaction

The single-instance lifecycle has these required phases, implemented by extending the existing helpers:

1. **Preflight and stage while current services stay up.** Resolve exactly one instance and acquire a per-instance operation lock. Validate destination paths, target identity, complete artifacts/dependencies, candidate runtime loading, configuration compatibility, and a usable prior-release recovery route. Capture existing target service definitions and enabled/loaded state outside `.hive`. Prevent concurrent start/stop/update/rollback or deploy-check operations from interleaving for this instance.
2. **Establish an idle maintenance window.** Before planned update/restart/rollback, check the running worker's registration-aware health and active jobs, and the existing call telemetry. An active call or uncertain worker state defers the planned operation without changing artifacts. Treat the SDK active-job count as stronger evidence than a possibly stale/reset heartbeat counter. Do not introduce a force-call-termination flag. Automatic recovery from a failed candidate is allowed to stop the failed pair.
3. **Stop worker, then engine.** Use `launchctl bootout` so `KeepAlive` cannot respawn processes during rotation. Verify the target supervisor, engine, and worker job children have exited before moving their files. Handle a call arriving between the idle observation and shutdown with the SDK's graceful drain while the engine remains available; if the bounded stop cannot complete, abort the switch and restore service availability. Never kill arbitrary port owners or other-instance PIDs. Record and reject unexpected owners.
4. **Rotate and start.** Reuse `.hive.next → .hive`, with prior `.hive → .hive.prev`. Install the corresponding service definitions, start engine, verify its fresh boot, then start worker. A matching release identity and all enabled-service health checks in §6 are required before reporting success. Use bounded checks, retaining the existing engine retry budget (three 30-second windows with 10-second waits); apply an explicit bounded worker check budget of the same maximum. These are deployment timeouts, not call latency targets.
5. **Recover on any failure after stopping.** Fetch/install/preflight failure leaves the prior pair running. Swap, plist/link write, bootstrap, or health failure after shutdown enters recovery, even under shell `set -e`. Stop any candidate processes, restore the prior artifact and exact usable service definitions, start engine then prior worker, and check restoration. Report the failed deployment as failed even when recovery succeeds. If restoration fails, report both failure stages and retained recovery paths without claiming a healthy rollback.

The command executing the switch must survive replacement of its own `.hive/service` scripts: freeze the required orchestration code in the operation's instance-local temporary area before rotation or otherwise ensure no later code read uses a moved/deleted path. Clean up lock/staging state on ordinary failure. An interrupted operation must be detectable on the next invocation and refuse destructive rotation until its `.hive`/`.prev`/`.next` and service state are reconciled; a minimal operation marker is sufficient, not a general journal.

Do not delete the only usable prior release before the candidate is healthy. Retain `.hive.broken` for inspection on failed activation, as today. Preserve the existing one-generation rollback semantics after a successful operation; no new release retention system is required. Dry-run describes the target, phases, and recovery capability without fetching, installing, writing files, contacting vendors, controlling services, or sending notifications.

### 5.2 Rollback and compatibility

`hive rollback` restores the previous engine **and** its compatible worker/dependencies together, using the same stop/start order and health checks. No config, Keychain, Mongo data, installed plugins, skills, or agent-authored files are rolled back. This ticket adds no data migration, so reverting code must not require reversing a schema change. If the retained artifact lacks a worker while current config enables LiveKit, reject ordinary rollback before stopping services; do not report an engine-only restoration as voice rollback.

The first migration is exceptional: existing `.hive.prev` may not represent the pilot that launchd actually runs. Preserve a one-time snapshot of the pilot's effective plist/link targets and required non-secret environment settings, plus its exact executable and dependency paths. Until a previous supported package exists, recovery uses those original definitions and the untouched pilot worktrees. Exercise this route during migration, then return to the selected packaged candidate and verify again. Subsequent ordinary rollbacks use `.hive.prev` and require no pilot checkout.

After migration, retain the pilot fallback until a known-good previous supported package supplies independent rollback. The operational record must state which recovery mode is available. Removing a live runtime dependency does not silently discard the only historical recovery route; worktree retirement is outside this ticket and must observe that distinction.

`service/deploy-check.sh` may still serve its existing developer mode, but no existing dodi automation may silently put the pilot or an engine-only release back in service. Inventory and adjust only dodi-specific update entries/pins as part of migration; preserve any shared or Keepur entries. Do not create a new scheduled updater. Existing notification behavior is not an acceptance prerequisite; test/migration commands must honor the execution context's authorization for external notifications.

## 6. No-call health and identity evidence

For enabled voice, the deployment health result must independently establish:

| Check | Required evidence | Does not establish |
| --- | --- | --- |
| Artifact and process identity | Manifest/lock/archive identity; launchd live PIDs, effective arguments, working directory and config selection; engine/worker boot identity matching that activation | Package presence alone does not identify a running process. |
| Engine boot | Fresh `Hive starting up` followed by `Hive is running`, scoped to the current boot and current PID; still alive at the final check | A stale line from a prior boot is insufficient. |
| Bridge authentication | From the packaged worker environment, valid bridge token + `POST /v1/chat/completions` body `{}` yields the existing missing-agent 400; wrong/missing token is denied (401 or the existing 403 when Vapi is unset). No model spawn occurs. | This does not validate conversation, provider auth, or audio. Do not put real messages/agent IDs into this probe. |
| Worker registration | Current supervisor PID, fresh identity heartbeat, current SDK `/` health 200, `/worker` reporting `hive-voice`, and registration evidence from this activation; health socket belongs to that supervisor | Heartbeat is written before registration and can survive job errors; `/worker` alone is informational. |
| Dependencies | Realpaths for loaded Hive, LiveKit job helpers, RTC/native libraries, and Silero model asset remain inside the selected instance release; Node itself is a documented installed host prerequisite | A directory name or success using a parent/global dependency tree is insufficient. |
| Outbound setup | Read-only LiveKit API authentication and lookup of the configured outbound trunk ID; configuration relationship to the existing Twilio trunk/number; Mokie's existing `voice-livekit` capability/routing and Cartesia voice selection are preserved | No SIP participant or agent dispatch is created. Trunk existence does not prove PSTN delivery, CNAM, or audible speech. |

The engine bridge probe must resolve its token in-process and log only a status/classification. A packaged diagnostic/helper may share validation code with `hive doctor`; the voice section should report running identity and worker health accurately. Do not make every normal doctor invocation perform vendor API calls: outbound network inspection is explicit for deployment acceptance. For older telemetry/artifacts, report identity as unavailable/legacy rather than substituting the installed version as observed running identity.

The offline native check loads Silero's actual installed model: the pinned plugin resolves `silero_vad.onnx` relative to its module. Packaging must preserve that asset and the real ONNX runtime dependency. [Silero 1.6.4 model loader](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/plugins/silero/src/onnx_model.ts).

## 7. Dodi migration and KPR-466 handoff

This is required operational acceptance after reviewed implementation, not an action performed while drafting. Migrate dodi only, preserving the existing instance home and operator-owned data; do not rerun the init wizard or reseed agent definitions to perform migration.

1. Inventory current live engine/worker arguments, working directory, config selection, relevant environment **names and non-secret path settings**, LaunchAgent link targets, dependency realpaths, Node/npm versions, instance/database identity, voice flags, routing, and dodi-specific updater configuration. Record a Keepur baseline sufficient to prove it was not restarted or repointed. Do not dump plist environment dictionaries, `.env`, API responses with credentials, or Keychain contents.
2. Record hashes/permissions for operator configuration files and an appropriate read-only baseline for instance data/agent routing. Prepare the known-good pilot recovery definitions and verify their backing files still exist. Leave both pilot worktrees and their dependencies untouched.
3. Install the identified candidate using the same supported packed-artifact pipeline proven in isolated testing, perform idle cutover, and check every §6 condition. A development bundle copied by hand does not qualify.
4. Exercise a paired service restart. Exercise migration rollback to the preserved prior pilot service definitions, verify it, then reactivate the selected candidate and verify it again. The final accepted state is both services on the intended packaged candidate.
5. Read back live launchd arguments and canonical executable/dependency paths after the final activation. Compare configuration, data identity, routing, permissions, and Keepur baseline. Verify no dodi runtime or updater path still requires either pilot worktree. Native job loading is proved in the offline artifact harness; actual call-job behavior remains for KPR-466.

Save a sanitized acceptance record at `docs/epics/kpr-462/kpr-463-deployment-evidence.md` during delivery. Required fields: execution date/operator, host/runtime versions, source revision/package version/archive and lock digests, service labels and path checks, each health result, restart/rollback results, preservation comparisons, Keepur comparison, recovery route/retained artifacts, exact final running identity, and any unexecuted checks with reasons. Machine-specific secret snapshots remain local outside source control. Evidence may contain public-safe path patterns in place of account-specific absolute paths; retain exact local read-back in the operator record.

KPR-466 may consume KPR-463 as passed only when the **actual dodi migration, restart, rollback, and final read-back** have passed. A merged implementation or successful sandbox install alone is `implementation verified; migration pending`. KPR-466 uses the recorded release identity and reruns no-call preflight on its eventual integrated release before May-authorized calls; any intervening update invalidates an assumption that the earlier running identity is still current. KPR-466 owns opening audibility, conversation/tool behavior, interruptions, hangup, and measured caller-perceived latency.

Successful migration allows a later cleanup decision; this ticket's tooling must not delete or rename either pilot worktree as a proof technique. If any runtime path still points there, retain them and mark acceptance incomplete.

## 8. Testing Contract and acceptance matrix

All automated tests use disposable instance roots, dummy secrets, and injected/mocked service/vendor boundaries. They must not read dodi/Keepur configuration, use operator Keychain entries, load real LaunchAgents, send Slack messages, dispatch rooms, or place calls. Fresh dependency installation may access package registries; runtime smoke/probe tests use a sanitized environment and no vendor calls.

| ID | Boundary | Required verification |
| --- | --- | --- |
| T1 | Packed artifact | Build/pack the actual package; required worker, manifest, shrinkwrap and MCP entries are present; source, `dist`, secrets, local config and `node_modules` remain excluded; existing pack/string/size guards stay valid. |
| T2 | Fresh production installation | Extract under a disposable non-repository instance with no parent/global `node_modules`, unset `NODE_PATH`, and install with `npm ci --omit=dev`. Verify both service entrypoints, native RTC/ONNX/Silero loading, and the SDK's forked agent-module import from that installed artifact. No repo dependency links are permitted. |
| T3 | Path/entrypoint behavior | Relocate the installed instance; exercise spaces/special XML characters and a symlinked home. Direct worker startup reaches the supervisor path; SDK import does not; required child-process paths resolve under `.hive`. Production service generation fails before mutation if an entrypoint is missing. |
| T4 | Config and secrets | Engine and worker get identical explicit home/config selectors. Test dotenv and mocked Keychain resolution, env precedence, missing-key reporting, and token mismatch rejection without logging values. A missing-agent authenticated probe cannot invoke a turn. |
| T5 | Service lifecycle | Mock launchctl and process ownership; assert worker-before-engine stop and engine-before-worker start, idempotency, enabled/disabled transitions, stale worker cleanup, and exclusion of other-instance labels/PIDs. Validate the resolved health port/collision behavior. |
| T6 | Transaction failures | Exercise first adoption with an old installed updater through the candidate's packaged tooling. Inject fetch, lock mismatch, native install/runtime validation, quiescence, swap, plist write, engine bootstrap, worker bootstrap/registration, identity mismatch, and health timeout failures. Assert no false success, preservation of the prior pair, and checked recovery. Missing/incompatible rollback fails before stopping. |
| T7 | Races and stale evidence | Concurrent operations cannot interleave; KeepAlive cannot respawn during rotation; worker job children are gone before swap; a call arriving before drain does not lose its engine; interrupted operation markers prevent destructive re-entry. Prior boot logs, foreign health listeners, fresh-but-unregistered heartbeat, and wrong-release PIDs do not pass. |
| T8 | State preservation | Put sentinels in config/env/plugins/skills/agents/logs/`.hive-state` and a second instance. Exercise update, failed activation, rollback and retry. Only intended replaceable artifacts/service definitions change; operator files and other-instance service state remain intact. |
| T9 | Dodi operational acceptance | Perform §7 after delivery readiness: no-call setup/auth/registration checks, restart, rollback/reapply, final release/path verification, and configuration/data/Keepur comparisons. Record actual evidence, not mocked results. |

Run `npm run check`, `npm run check:bundle`, and the relevant shell lifecycle tests (including `service/deploy.test.sh`) after implementation. Add the isolated packed-artifact/native smoke check to the repository's explicit bundle/release validation path so it is repeatable and cannot be replaced by the existing symlink smoke test. Use Node 24 on macOS ARM64 for the native deployment proof and retain the declared Node `>=22.19.0` engine contract and existing Node 22 checks; do not silently narrow package support or claim native validation on untested platforms.

Ticket acceptance requires T1–T9, a reviewed implementation, and the final packaged dodi state. If a required operational condition cannot be verified, leave the acceptance item pending with its precise reason. No live-call result is required for KPR-463; no passing test here stands in for KPR-466.

## 9. Integration surfaces and delegated assumptions

Expected surfaces are `package.json`/lockfile and bundle/pack guards; `src/setup/populate-engine.ts`; `src/cli/daemon.ts`, `update.ts`, `rollback.ts`, `single-instance-env.ts` and doctor helpers; `service/deploy.sh`; production setup/install documentation and source wrappers; shared config's worker health port; worker entry/heartbeat identity; engine boot identity; and focused tests. Avoid changing `session.ts` conversation logic or KPR-464/KPR-465 metrics beyond any import factoring strictly necessary for the offline runtime check. Coordinate shared worker/config files through the epic's serialized delivery workflow.

- **Non-blocking, delegated:** one package with production LiveKit dependencies is the smallest supported extension; its larger installed footprint is accepted for this ticket's design.
- **Non-blocking, delegated:** publish a generated shrinkwrap and use locked production installation; this intentionally stops runtime dependency versions floating independently of a Hive artifact. Future dependency upgrades go through normal package/lock review.
- **Non-blocking, delegated:** an explicit local `.tgz` option shares the supported update path, enabling exact candidate verification without publishing during epic implementation.
- **Non-blocking, delegated:** macOS ARM64/Node 24 is the operational proof target; existing package engine compatibility remains intact.
- **Non-blocking, delegated:** an idle maintenance window and bounded drain are sufficient; no zero-downtime or active-call continuity across release changes is promised.
- **Non-blocking, delegated:** use the existing SDK health server on an instance-derived loopback port, and existing bridge rejection semantics for no-turn authentication verification.
- **Execution-dependent, not a spec blocker:** final candidate revision, live service/config read-back, maintenance timing, and prior pilot recovery details are filled during delivery. Both named pilot worktrees remain protected until then and through verified recovery.
- **Blocking for live-call execution only:** May's explicit live-call go; KPR-463 does not need or initiate a call.

There are no blocking human design questions in this draft. This is `DRAFT_READY`, not spec signoff, a plan, implementation, or migration evidence.
