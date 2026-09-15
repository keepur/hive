# KPR-463 supported operation and recovery

This is the operator-facing contract for the packaged engine + LiveKit voice-worker pair (KPR-463). It documents the **implemented** CLI and frozen helper in this tree. It does **not** record dodi cutover, T9, or T10 closure.

**Status:** implementation verified; **migration pending**. T9 evidence has not been collected. No live call was placed. Upstream KPR-320 Phase-0, unresolved KPR-321 telephony ops, KPR-466 live-call acceptance, and model/vendor/warm-path choices are unchanged. Code delivery and internal call evidence do **not** establish that the designed SIP/P/W/T gates passed. S12 cutover commands below are inventoried for later execution; they have not been run.

Canonical spec: [kpr-463-spec.md](./kpr-463-spec.md). Plan schedule: [kpr-463-plan.md](./kpr-463-plan.md) S10.

## 1. Packaged pair (supported path)

The LiveKit media worker remains a **separate process** from the engine, under launchd label `com.hive.<instance-id>.voice-worker`. The supported runtime is the instance-owned npm release, not a built checkout.

| Component | Label | Packaged entry | Logs |
| --- | --- | --- | --- |
| engine | `com.hive.<id>.agent` | `<home>/.hive/pkg/server.min.js` (no extra args) | `<home>/logs/hive.log`, `hive.err` |
| worker | `com.hive.<id>.voice-worker` | `<home>/.hive/pkg/voice-worker.min.js` `start` | `<home>/logs/voice-worker.log`, `voice-worker.err` |

Both definitions use the same resolved absolute `HIVE_HOME` and `HIVE_CONFIG`. Node is the invoking process's validated `process.execPath` (the sole external executable). Entrypoints and production `node_modules` must lie under canonical `.hive`. There is no supported fallback to `dist/`, `src/`, `npx`, or a git checkout when package files are absent.

`hive start --daemon` installs and starts the engine and, only when `voice.livekit.enabled === true`, the worker. `hive stop` stops **both** target-instance labels, including a previously installed worker after voice has been disabled. Repeating a healthy start or a fully stopped/unlinked stop is a no-op. Voice-disabled start installs only the engine and removes a stopped stale worker LaunchAgent; missing LiveKit credentials must not block ordinary engine use.

Foreground `hive start` (no `--daemon`) is still engine-only. The packaged foreground worker command is:

```bash
node <instance>/.hive/pkg/voice-worker.min.js start
```

A built checkout's `dist/voice-worker/main.js` plus `node_modules` is the **historical pilot / developer generator** path (`setup/generate-plist.ts` without `HIVE_PRODUCTION_PLISTS=1`). It is not the supported production install. The npm tarball **includes** the worker (`pkg/voice-worker.min.js` and production LiveKit dependencies).

The engine loopback voice endpoint still authenticates the LiveKit bridge with `HIVE_VOICE_BRIDGE_TOKEN` and aborts the in-flight spawn on disconnect. STT/TTS defaults, per-agent Cartesia voices (`voice.livekit.agentVoices`), inbound routing (`voice.livekit.inboundAgents`), `voice.warmPath.enabled` (default off), and `voice.toolAck.enabled` (default on) are unchanged. `scripts/livekit-setup.ts` still consumes `telephony.twilio.*` to provision LiveKit SIP objects; KPR-321's unresolved Twilio/CNAM ops remain outside Phase-0 closure. KPR-466 consumes this ticket only after actual T9 migration/restart/rollback/final read-back.

## 2. Host and staging prerequisites

### Engine range vs operational proof

| Surface | Value |
| --- | --- |
| Declared engine (`package.json` `engines.node`, `hive init` prereq) | Node `>=22.19.0` |
| Operational native proof (plan / T10 closure gate) | macOS ARM64 **Node major 24** |
| This engineering host (S8/S9 observed T2) | Darwin ARM64, macOS **26.6.2**, Node **v26.7.0**, npm **11.19.0** |

T2 on this host used the real `/usr/bin/sandbox-exec`, the confinement self-test passed, `promotionMethod=clone`, and `ARTIFACT_INSTALL_OK` reported **denials=0**. That is a repeatable engineering check. It is **not** T10 closure.

T10 is a **named skip** on Node major 26 (`T10_SKIP` … `observed darwin/arm64 Node major 26`). T10 remains pending until a macOS ARM64 host whose invoking Node major version is 24 runs `node scripts/check-confinement-closure.mjs` against the selected archive. T9 remains pending until actual dodi migration evidence exists. Do not treat CI, this Node 26 run, or packaged tests as closing T9 or T10.

### Node, npm, native install

Services pin the **absolute** Node that invoked the CLI/helper (`process.execPath`), not whatever `node` happens to be first on PATH after boot. `service/install.sh` and the single-instance `service/deploy.sh` branch honor `HIVE_NODE_PATH` and otherwise call `node`.

The frozen helper resolves host npm from the explicit service `PATH` to a real `…/bin/npm-cli.js` (`src/deployment/main.ts` `hostNpmCli`). Tag updates run confined `npm pack @keepur/hive@<tag> --json --pack-destination <job-dir>` and therefore need registry network access. Local `--artifact` still runs confined `npm ci --omit=dev --no-audit --no-fund --no-progress` against the shipped shrinkwrap, so native compilation still needs network for the npm registry (reproducible locked versions, not offline install). Lifecycle scripts are **not** ignored; `--ignore-scripts` is forbidden on this path.

Voice-disabled instances still receive the larger production dependency footprint (pinned LiveKit/RTC/ONNX/Silero and related native addons). No worker starts and no voice secrets are required there.

### Staging host prerequisites (init / resume / update / first adoption)

Required **before the first artifact job**, fail-closed, no unconfined fallback:

1. `/usr/bin/sandbox-exec` present **and** passing the Seatbelt self-test (write inside a scratch job directory succeeds; write outside fails with `EPERM`). Apple deprecates `sandbox-exec` but ships it on macOS 26; **the self-test, not mere presence**, is the guard. `hive init` reports this as the required prereq "Artifact staging confinement…". Dry-run may report whether the binary is present as `sandboxExecPresent` with `selfTest: "unverified"` — presence alone is not a pass.
2. The instance volume supports `cp -c` clone **or** the full-copy fallback with sufficient free space. Preflight records `promotionMethod` (`clone` or `full-copy`) and fixes it for the whole operation. This host's T2 used `clone`.

Ordinary `hive rollback` to `.hive.prev`, and running services, need **neither** `sandbox-exec` nor clone capability.

### Health-port override and collisions

- Engine voice HTTP port: `instance.ports.voice` / env `VOICE_PORT` / default `portBase + 5` (`src/config.ts`).
- Worker health listener: `instance.ports.voiceWorker` / default `portBase + 7` (`src/deployment/ports.ts` `voiceWorkerPort`). There is no `VOICE_WORKER_PORT` env key.
- `VOICE_PORT` is a captured non-secret service override (allowlisted in `buildServiceEnvironment`). Engine and worker must not be given conflicting values for the same override key; that fails preflight **before** any signal or plist write. Malformed or unsupported overrides also fail closed.
- The worker health port must not collide with any other resolved instance listener (`assertWorkerPortAvailableInConfig`). Unexpected or multiple owners of that listener fail health; the probe never kills a port owner.

## 3. Commands (implemented)

Selectors: `--config <path>` sets `HIVE_HOME` / `HIVE_CONFIG`. `--instance <id>` must equal the selected config's `instance.id`. `--artifact` must be an **absolute regular `.tgz`**. `--artifact` and `--tag` are mutually exclusive.

### Operator CLI (`src/cli.ts`, packaged `pkg/cli.min.js`)

```bash
hive update                         # --tag=latest (npm registry pack)
hive update --tag=vX.Y.Z
hive update --artifact=/abs/path.tgz
hive update --dry-run               # also valid with --tag / --artifact
hive rollback
hive rollback --dry-run
hive start --daemon                 # paired start via helper --start
hive stop                           # paired stop via helper --stop
hive skill sync                     # explicit; not part of update
hive deployment-tooling validate-only   # this package's pkg/release.json identity only
```

`runUpdate` / `runRollback` / `startDaemon` / `stopDaemon` invoke **this CLI package's** `pkg/deploy.min.js` (`src/cli/deployment-helper.ts` `deploymentHelperFor` / `invokeDeploymentHelper`), freeze it under `.hive-state/deployment/operations/<id>/`, and never choose the target instance's `.hive/service/deploy.sh` by default.

Dry-run prints JSON `status: "DRY_RUN"` and performs no lock, freeze, fetch, install, self-test, promotion probe, vendor call, or service control (`src/deployment/main.ts` `deploymentDryRun`).

There is **no** `hive restart` verb. Paired restart is the helper `--restart` below, or `hive stop` then `hive start --daemon`. `launchctl kickstart -k` of a single label is not the supported pair restart (it can leave engine and worker on different generations).

`hive update` does **not** run `hive skill sync`. Sync operator skills separately when that is intended.

### Frozen helper (`src/deployment/main.ts`, packaged `pkg/deploy.min.js`)

```bash
# From an already-selected instance (explicit HIVE_HOME + HIVE_CONFIG):
node <pkg>/deploy.min.js --tag=latest
node <pkg>/deploy.min.js --artifact=/abs/path.tgz
node <pkg>/deploy.min.js --dry-run
node <pkg>/deploy.min.js --start
node <pkg>/deploy.min.js --stop
node <pkg>/deploy.min.js --restart
node <pkg>/deploy.min.js --rollback
node <pkg>/deploy.min.js --check --tag=latest
```

`HIVE_SINGLE_INSTANCE=1` makes `service/deploy.sh` `exec` the sibling `pkg/deploy.min.js` **before** reading `BUILD_DIR` / `instances.conf` or sourcing `$DEPLOY_DIR/.env`. `service/deploy-check.sh` similarly `exec`s the helper with `--check`. Later shell in those scripts is developer multi-instance mode and is not the supported single-instance path.

`service/install.sh` is a production wrapper:

```bash
# HIVE_HOME / HIVE_CONFIG optional; defaults to the package's parent instance
# and hive.yaml. Rejects a missing packaged CLI (no tsx/src fallback).
HIVE_NODE_PATH=/abs/node HIVE_HOME=/abs/instance HIVE_CONFIG=/abs/instance/hive.yaml \
  <instance>/.hive/service/install.sh
# → exec node <instance>/.hive/pkg/cli.min.js start --daemon --config <selector>
```

### Admission deferral and unresolved release

Before any bootout, the helper closes the worker's admission gate and waits up to 30 seconds. Exact helper/stderr messages (`src/deployment/transaction.ts`):

| Situation | Message |
| --- | --- |
| Active call, unregistered worker, unowned socket, or non-zero SDK/telemetry jobs | `active call or uncertain worker state` |
| Supervisor identity changed during the wait | `worker identity or registration changed` |
| Accepted work still unresolved at 30s | `accepted work did not settle within 30 seconds` |
| Release acknowledgement lost after a deferral | `maintenance release unacknowledged; services retained` |
| Barrier established, release failed | `maintenance unresolved; no services signaled` |
| Post-signal failure, prior pair restored | `activation failed; prior pair restored and verified` |
| Activation **and** recovery failed | `activation and recovery failed; retained paths require attention` |
| Healthy candidate, cleanup failed | `candidate health passed; final cleanup requires reconciliation` |

Deferred operations leave the live pair running, reopen admission when they can, and return nonzero. There is **no** force-call-termination flag and no option that sends SIGTERM/drain as an abortable idle check.

`hive doctor`'s Voice worker section lists retained ledger rows as `unresolved admissions:` with job id, phase, age, and child PID. Those lines are diagnostics, not a work queue: **only the genuine completion path clears them**. Job-count zero, assignment timeout, a dead child, a stale heartbeat, elapsed time, and no operator flag clear unknown accepted work (`src/cli/doctor.ts`).

First-adoption without a verified hold prints JSON `status: "MIGRATION_PENDING"` (exit 1) and does not stage or signal. A previous interrupted operation that was reconciled in this invocation prints `PREVIOUS_OPERATION_RECONCILED` and does **not** start the newly requested action in the same process.

### Staging and recovery paths

| Path | Role |
| --- | --- |
| `<home>/.hive-state/jobs/<operation-id>/<job-id>/` | Single-use confined job directories. Never promoted. Disposal is deferred until the operation has a result; leftovers are swept on the next invocation. Sweep failures are reported (`Job directory disposal incomplete (non-fatal): …`) and are **not** fatal. |
| `<home>/.hive.next` | Verified clone of a successful install job only. Unverified `.hive.next` is discarded on re-entry; a job directory is never adopted. |
| `<home>/.hive`, `.hive.prev`, `.hive.broken` | Current, previous packaged generation, and one diagnostic generation. |
| `<home>/.hive-state/tooling/<archive-sha>/` | Durable first-adoption tooling. The final digest name is the only verification marker; reuse after re-checking `pkg/release.json`, do not reinstall. |
| `<home>/.hive-state/tooling/.staging/<archive-sha>.<operation-id>/` | Partial clone before the atomic rename. Re-entry **discards** staging siblings; never invoke or rename them by hand into the final name. |
| `<home>/.hive-state/deployment/operations/<id>/` | Frozen `deploy.min.js`, operation marker, private snapshots. Unresolved operations retain this tree. |

Explicit leftover-job cleanup is the next helper invocation's sweep (or a later operation after a reported non-fatal failure). Do not promote, rename, or reuse a job directory. Do not delete `.hive-state/tooling/<digest>/` while it is the only bootstrap of a pending first adoption.

### First-adoption bootstrap and pilot recovery (not executed here)

These helper modes exist (`parseDeploymentArguments`). They are S12/runbook surfaces. **S12 has not been run.**

```bash
# Bootstrap candidate tooling (requires reviewed archive digest + 40-hex revision):
node <pkg>/deploy.min.js --bootstrap --artifact=/abs/candidate.tgz \
  --sha256=<64-hex> --revision=<40-hex>

# Capture / inventory / hold (registered payload paths only):
node <pkg>/deploy.min.js --capture-pilot --bootstrap-record=/abs/registered-bootstrap
node <pkg>/deploy.min.js --inventory-pilot=/abs/registered-snapshot
node <pkg>/deploy.min.js --prepare-legacy-hold=/abs/registered-snapshot
node <pkg>/deploy.min.js --verify-legacy-hold=/abs/registered-hold
node <pkg>/deploy.min.js --release-legacy-hold=/abs/registered-hold

# First migration / reapply (registered hold, never an arbitrary file):
node <pkg>/deploy.min.js --artifact=/abs/candidate.tgz --legacy-hold=/abs/registered-hold

# Historical pilot recovery (registered snapshot; not ordinary hive rollback):
node <pkg>/deploy.min.js --pilot-recovery=/abs/registered-snapshot
```

`--pilot-recovery` and `--legacy-hold` accept only exact registered payload paths of the selected instance. Ordinary `hive rollback` still rejects an incompatible `.hive.prev` and does not read the pilot.

## 4. Preservation, dodi inventory, migration-pending

Operator-owned state that update/rollback/retry must preserve: `hive.yaml`, dotenv (including alternate `.env-personal`), agents, plugins, skills, logs, unrelated `.hive-state` files, and a second instance's services. The supported transaction is a **code-only** release swap of `.hive` plus the two launchd definitions. Beta plugin relocation remains a named locked preflight action (not dry-run); it must not overwrite and must not touch normal operator plugins/skills.

`hive skill sync` is the operator command that mutates customer-space skills from `operatorSkillsRepo`. It is separate from update on purpose.

Dodi-specific updater inventory (repoint only dodi checker entries/pins onto the supported helper route; preserve Keepur rows byte-for-byte with a before/after comparison) is a **S12** action. It has not been performed. Do not create a new scheduled updater. Default helper behavior does not send notifications.

Legacy hold evidence for first adoption must be an already-present, independently verified capable runtime hold over all dodi dispatch sources and outstanding assignment work, registered as a payload path. Observation-only JSON or idle polling cannot substitute. Missing hold or recovery evidence is `MIGRATION_PENDING` before any signal.

Candidate tooling under `.hive-state/tooling/<digest>/` is retained for rollback/reapply of that archive. Pilot worktrees and their dependencies are **not** retired by this ticket; they remain a historical recovery route until a known-good packaged `.hive.prev` exists. After acceptance the new package is the supported runtime; until T9 passes, recovery mode is still **pilot-only** for dodi.

KPR-466 may consume KPR-463 as passed only after actual dodi migration, paired restart, pilot rollback, reapply, and final read-back. Until then the honest report is **implementation verified; migration pending**.

## 5. Workflow authorization

The user explicitly authorized dodi-dev to replace the unavailable `/spec-and-implement` entrypoint (authorization record `ac95b136`). Plan review and delivery gates remain the existing dodi-dev gates and the parent S0–S12 schedule. No workflow restoration is pending.

That substitution does **not** establish operational prerequisites, authorize live calls, close T9/T10, or mark S12 done.
