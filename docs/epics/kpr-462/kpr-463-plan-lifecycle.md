# KPR-463 implementation plan — lifecycle, recovery and delivery

This is chunk 3 of the [parent plan](./kpr-463-plan.md). Its Testing Contract, authority, authorized dodi-dev workflow substitution and S0–S12 serial schedule apply in full. Draft revision for review; operational commands below are later delivery steps, not maturation actions. [Chunk 4](./kpr-463-plan-pilot.md) supplies the concrete pilot-evidence, current-readback, stale-reconciliation, compatibility and bootstrap substeps required to finish partial S7. [Chunk 5](./kpr-463-plan-pilot-boundaries.md) completes initial capture, the historical probe ABI, absolute stop freshness and non-lifecycle bootstrap/registry reconciliation.

## Task 7: Generate and operate the target service pair

**Files:** Create `src/deployment/services.ts`, `src/deployment/services.test.ts`; modify `src/paths.ts`, `src/paths.test.ts`, `src/cli/daemon.ts`, `src/cli/daemon.test.ts`, `setup/generate-plist.ts`, `service/install.sh`; create `service/install.test.sh`.

**Schedule:** S3 implements Steps 1–2 and their `paths.test.ts`/`services.test.ts` foundation cases from Step 5. `services.ts` provides the shared environment and OS adapters needed by Tasks 4–6; it must not import transaction/CLI/config code. Reuse the existing builtin-only `src/paths.ts` selector helpers and import-free `src/logging/logger.ts` within Task 2 Step 3's explicit helper closure; non-secret YAML parsing stays bundled. Service inputs carry the selected home/config explicitly, without relying on `paths.ts`'s module-level derived paths. S7 implements Steps 3–4 and CLI/shell shim tests after Task 8's transaction source exists. S9 completes Step 5 with the actual packaged config/bridge probe and full service/lifecycle assertions. Keep existing daemon wrappers callable until their S7 routing change.

- [ ] **Step 1:** Replace engine-only plist construction with this reusable pure serializer. Keep `getLabel/getPlistPath/getLaunchAgentLink` as engine-compatible wrappers; add component-aware helpers used by both labels. Validate instance ID against `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` before constructing labels/paths; config selectors remain explicit file paths, not label content.

```typescript
const servicePortKeys = [
  "BG_TASK_PORT", "MEETING_MONITOR_PORT", "CODE_TASK_PORT", "WS_PORT",
  "ADMIN_API_PORT", "VOICE_PORT", "SLACK_INTERNAL_PORT", "BEEKEEPER_PORT",
] as const;
export type ServiceOverrides = Partial<Record<typeof servicePortKeys[number], string>>;
export interface ServiceDefinition {
  label: string;
  nodePath: string;
  entrypoint: string;
  args: string[];
  hiveHome: string;
  configPath: string;
  home: string;
  pathEnv: string;
  overrides: ServiceOverrides;
  stdout: string;
  stderr: string;
}
export function buildServiceEnvironment(s: Pick<ServiceDefinition,
  "hiveHome" | "configPath" | "home" | "pathEnv" | "overrides"
>): Record<string, string> {
  const env: Record<string, string> = {
    HIVE_HOME: s.hiveHome, HIVE_CONFIG: s.configPath, HOME: s.home, PATH: s.pathEnv,
  };
  for (const [key, value] of Object.entries(s.overrides)) {
    if (!servicePortKeys.some((allowed) => allowed === key)) throw new Error("unsupported service override");
    if (typeof value !== "string" || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      throw new Error(`invalid service port override: ${key}`);
    }
    env[key] = value;
  }
  return env;
}
const xml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[char]!);
export function buildServicePlist(s: ServiceDefinition): string {
  const string = (v: string) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(s.label)}
<key>ProgramArguments</key><array>${[s.nodePath, s.entrypoint, ...s.args].map(string).join("")}</array>
<key>WorkingDirectory</key>${string(s.hiveHome)}
<key>EnvironmentVariables</key><dict>
${Object.entries(buildServiceEnvironment(s)).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join("")}
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key>${string(s.stdout)}
<key>StandardErrorPath</key>${string(s.stderr)}
</dict></plist>\n`;
}
```

Definition inputs:

| Component | Label | Entrypoint and args | Logs |
| --- | --- | --- | --- |
| engine | `com.hive.<id>.agent` | `<home>/.hive/pkg/server.min.js`, `[]` | `<home>/logs/hive.log`, `hive.err` |
| worker | `com.hive.<id>.voice-worker` | `<home>/.hive/pkg/voice-worker.min.js`, `["start"]` | `<home>/logs/voice-worker.log`, `voice-worker.err` |

Node is the validated absolute `process.execPath`, recorded as a host prerequisite. HOME is the same user home used by launchd/Keychain; PATH is the explicit operational PATH. Both definitions use the exact same resolved absolute HIVE_HOME and HIVE_CONFIG, including alternate config selection. Resolve canonical root for containment, while preserving the selected usable instance symlink spelling in explicit selectors if intended. Entrypoints/dependency realpaths must lie under canonical `.hive`; Node is the sole external executable prerequisite. Never fall back to `dist`, `src`, npx or a checkout when package files are absent.

In shared `src/paths.ts`, add `basename` to the `node:path` import and replace only `resolveDotenvPath` with the following. Determine the suffix from the selector's basename, while keeping the dotenv file under HIVE_HOME; do not move dotenv lookup to the selected config's directory. All engine/worker/config-probe imports use this shared resolver, preserving the existing dotenv then env-first/Honeypot behavior.

```typescript
export function resolveDotenvPath(hiveHome: string): string {
  const configFile = basename(process.env.HIVE_CONFIG || "hive.yaml");
  const suffix = configFile.match(/^hive-(.+)\.yaml$/)?.[1];
  return resolve(hiveHome, suffix ? `.env-${suffix}` : ".env");
}
```

Capture supported overrides from the inventoried effective service definitions, validate them before any write or shutdown, and use `buildServiceEnvironment` for both generated plists and every corresponding Task 6 config/health probe subprocess. Never obtain this map by spreading the invoking shell's environment. Preserve the captured values exactly, including `VOICE_PORT`; absent overrides continue through the shared dotenv/Honeypot loader. Reconcile engine/worker values before staging: conflicting settings that select different shared listeners fail preflight. Any other required legacy service environment override must either be explicitly classified, validated and added to this shared non-secret allowlist in implementation, or cause a named preflight rejection before shutdown; silently dropping it is forbidden. Credentials remain in the shared secret loader and are never allowlisted into generated plists. The sanitized probe subprocess env must deep-equal the generated service env before config import; private prior definitions remain available for exact recovery.

- [ ] **Step 2:** Implement the following concrete adapters in `services.ts`; commands use `execFile` argument arrays and captured output, never shell evaluation. Inject one `ServiceIO` interface for fixture use.

| Adapter | Exact operation | Success and failure rules |
| --- | --- | --- |
| `inspect(label)` | `launchctl print gui/<uid>/<label>` captured privately; `launchctl print-disabled gui/<uid>`; plist selected fields via `plutil`; OS process query below | returns loaded/enabled state, live PID/start time, arguments/cwd/config selection, plist/link identity. Only recognized not-found means unloaded; command/parse errors are unknown and fail preflight |
| `process(pid)` | `ps -ww -p <pid> -o pid=,ppid=,lstart=,command=` under `LC_ALL=C`; cwd via `lsof -a -p <pid> -d cwd -Fn` | compare PID/start time, canonical executable/script, working directory; never output arbitrary environment or secret argv |
| `children(pid)` | `ps -axo pid=,ppid=,lstart=,command=` captured privately | compute transitive descendants and exact identities, including SDK job and inference children. Retain census identities before parent stop to detect reparented survivors |
| `listener(port)` | `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpn` | require expected supervisor PID for worker health; unexpected/multiple owner or parser uncertainty fails. Probe never kills a port owner |
| `bootstrap(def)` | `launchctl enable gui/<uid>/<label>` only for desired previously-disabled service; `launchctl bootstrap gui/<uid> <instance-service-plist>` | verify loaded PID/identity after start. If already healthy with same effective definition, no-op; do not restart it for idempotency |
| `bootout(def)` | `launchctl bootout gui/<uid>/<label>` | only after quiescence for planned operations; mark shutdown irreversible before invocation; verify supervisor plus captured descendants disappear |
| `write(def)` | atomic temp write in instance `service/`, mode 0600; `plutil -lint` before rename; atomically replace corresponding LaunchAgent link | validate every enabled entrypoint/config/port before first mutation; keep previous exact definitions/link state for restoration |
| `removeWorkerLink()` | after proven worker stop, unlink target worker LaunchAgent symlink; remove/disable target installed registration if it remains | stale worker cannot return at login. Never remove another instance or a link with unexpected ownership/target |
| `restore(snapshot)` | restore exact previous plist bytes/link target and enabled/loaded states; bootstrap only previously loaded desired services | preserve previously disabled/unloaded state on failed start/stop; required running-pair update recovery uses captured prior loaded pair |

Capture raw original definitions privately under the operation directory (0600, never repository/log output), retaining exact usable restoration while displaying only allowed non-secret path selectors. A prior pilot may have external paths; only the explicitly captured pilot recovery profile permits those paths. New generated definitions never contain credentials. A malformed or foreign service owner fails instead of being overwritten.

After worker bootout, wait at most 30 seconds for its PID and every captured descendant to exit, including children discovered while the supervisor is still alive. Maintain captured PID/start-time tuples to detect reparented children; a PID reused by another executable is not an owned process and must not be signaled. Only after the worker tree is gone may engine bootout occur, with the same 30-second exit budget. A bounded stop failure enters recovery; do not escalate to broad `kill -9` or port killing. Automatic recovery can stop positively identified failed-candidate processes, but cannot claim rollback success while an old/candidate child remains unexpectedly live.

- [ ] **Step 3:** Route `startDaemon` and `stopDaemon` to the same locked lifecycle implementation from Task 8. Repeating healthy start is a no-op; repeating fully stopped/unlinked stop is a no-op. If start changes effective service definitions or restarts an existing pair, use reversible maintenance first. Stop handles both labels even if current YAML disables LiveKit; inspect an existing worker's actual supervisor record/config/port to quiesce it. Fresh disabled start installs only engine and removes any stopped stale worker link. Missing worker credentials on disabled config cannot block ordinary engine use.

No foreground engine behavior changes. Document the separate packaged foreground worker command as `node <instance>/.hive/pkg/voice-worker.min.js start`; operator call/restart policies still apply.

- [ ] **Step 4:** Make `service/install.sh` a production wrapper invoking its matching package's `pkg/cli.min.js start --daemon` with explicit selected HIVE_HOME/HIVE_CONFIG. Reject absent packaged CLI; no source/tsx fallback. It no longer creates or starts a deploy-check schedule as part of ordinary engine installation. Preserve existing log-rotation services unless explicitly requested; this ticket adds no scheduled updater.

Make `setup/generate-plist.ts` share `buildServicePlist` for production definitions and explicit instance selectors. Keep developer-only log/deploy generation behind an explicit existing developer mode or move its old body to a clearly developer-only invocation; no documented production path emits `dist/voice-worker/main.js`. Test the production wrapper's args against a node/CLI shim; never invoke real launchd from the shell test.

- [ ] **Step 5:** Complete this full verification in S9. The S3 foundation subset and S7 CLI/shell subset use their parent-schedule commands; they do not execute the packaged loader fixture below before S8 has built it. Add that fixture in S9, with no skipped placeholder cases.

```bash
npx vitest run src/paths.test.ts src/deployment/services.test.ts src/cli/daemon.test.ts src/voice-worker/worker-config.test.ts src/deployment/health.test.ts
bash service/install.test.sh
```

Require XML special characters, absolute paths, alternate config, symlink containment, enabled/disabled/previously installed transitions, all start/stop orders, owner mismatch, child survival, missing entrypoint before write, repeated no-op behavior and second-instance exclusion.

Add `resolveDotenvPath` cases for absent/default, relative `hive-personal.yaml`, the generated absolute `<home>/hive-personal.yaml`, absolute selectors whose parent directory also contains `hive-`, and selected symlink-home spelling. Assert every personal selector resolves `<home>/.env-personal`, default resolves `<home>/.env`, and an out-of-home absolute config still derives its dotenv path under the selected home. The disposable loader integration fixture has distinct dummy bridge-token/port values in `.env` and `.env-personal`, no default hive.yaml, and the generated engine/worker environments with absolute personal selectors. Dynamically import the actual engine config, worker loader and packaged config/bridge probe in separate sanitized processes with the fake Keychain shim; require all three to select the personal dotenv and resolve the same bridge listener/token classification without printing values. Preserve env-first precedence with a captured valid `VOICE_PORT` override in both plist dictionaries and every probe env; assert malformed/unsupported overrides and conflicting service overrides fail before any signal/plist write, and generated plists omit dummy secret values.

## Task 8: Serialize, stage and recover the paired transaction

**Files:** Create `src/deployment/operation.ts`, `artifact.ts`, `transaction.ts`, `main.ts`, `transaction.test.ts`, `lifecycle.integration.test.ts`, `adoption.integration.test.ts`; modify `service/deploy.sh`, `service/deploy-check.sh`, `service/deploy.test.sh`.

**Schedule:** S7 implements Steps 1–5 and Step 6's injected transaction unit matrix, then finishes Task 7 daemon/install and Task 9 CLI/wrapper/bootstrap routing in that same source checkpoint. All release/ports/services/health/diagnostic imports already exist. S9 adds and runs the complete `lifecycle.integration.test.ts` and Task 9 `adoption.integration.test.ts`, including actual frozen-helper execution, packed preflight and Task 6 closed-gate propagation. S7 unit tests inject the existing filesystem/process/probe boundaries; they cannot certify the future S8 bundle. Keep each deferred integration assertion pending until S9.

- [ ] **Step 1:** Define the minimal durable operation record and exclusive lock. Canonicalize the instance first; a symlink alias and real path must obtain the same lock. Acquire with atomic `mkdir(<home>/.hive-state/deployment/lock)` and write owner record atomically before doing work. Directory permissions 0700, records 0600.

The original lifecycle-only record shape below is the preserved schema-1 starting point. Remaining S7 migrates producers/consumers to chunk 5’s strict schema-2 work union; its prior/profile/artifact fields belong only to lifecycle work. Bootstrap/registry reconciliation dispatches before reading them. Incomplete historical schema-1 records remain unresolved.

```typescript
export type Phase = "preflight" | "staged" | "barrier-requested" | "quiescent" |
  "stopping-worker" | "stopping-engine" | "rotating" | "starting-engine" |
  "starting-worker" | "checking" | "recovering" | "healthy" | "deferred" | "unresolved";
export interface OperationRecord {
  schemaVersion: 1;
  id: string;
  ownerPid: number;
  ownerStartTime: string;
  canonicalHome: string;
  instanceId: string;
  mode: "update" | "rollback" | "start" | "stop" | "restart" | "pilot-rollback";
  phase: Phase;
  toolSha256: string;
  startedAt: string;
  supervisor?: { pid: number; bootId: string };
  barrierOperationId?: string;
  signalsBegun: boolean;
  priorProfile: "packaged" | "pilot" | "stopped";
  priorSnapshotPath: string;
  candidateArchiveSha256?: string;
  retainedPaths: string[];
  resolution?: "healthy" | "deferred" | "recovered";
  artifactMove?: {
    from: string;
    to: string;
    directoryIdentity: { device: number; inode: number };
    state: "intended" | "observed";
  };
  artifactDisposal?: {
    path: string;
    directoryIdentity: { device: number; inode: number };
    state: "intended" | "observed";
  };
}
```

The lock covers start/stop/update/rollback, restart and supported deploy-check through final verification/recovery. An existing live owner returns busy before writes. A stale owner PID alone is not permission to remove a lock: compare PID/start time and inspect operation phase/service identities/artifact locations. When `barrierOperationId` was recorded before signals, the next invocation must obtain a fresh same-boot terminal release acknowledgement for that operation, including when its close might never have arrived, before removing only its owned incomplete stage, archiving the resolved record and beginning anew. A pre-barrier failure requires only its owned filesystem reconciliation. An open status snapshot alone cannot finalize a recorded barrier operation or rule out a delayed close. After signals or uncertain rotation, refuse a new destructive rotation until the recovery adapter has reconciled the recorded prior/candidate identities and exact path inventory. A crash after mkdir but before owner metadata is an uncertain lock, not automatically stale. **Task 8 Step 1a in chunk 4** specifies the concrete next-invocation adapters, takeover serialization, frozen-child liveness and durable-resolution handling; an unconditional existing-lock refusal does not finish S7.

Atomic marker writes bracket every irreversible step: write intended phase before action, then record observed result. The prior snapshot includes presence/identity of `.hive`, `.hive.prev`, `.hive.next`, **`.hive.broken`**, effective service definitions, link/loaded/enabled state, prior health profile and exact tool hash. Every occupied artifact slot records canonical path, `lstat` device/inode, release/lock identity and owning operation/snapshot; capture absence explicitly for reserved operation slots `prior-prev`, `prior-broken`, `rollback-current` and `failed-prev`. Require same-user ownership, real directories within the canonical instance and no symlinked ancestors. Existing `.hive.broken` must match a retained resolved operation's target-instance inventory, or the explicitly registered first-adoption snapshot; package contents alone are not proof of ownership. Unowned, changed, symlinked or recovery-essential broken paths fail preflight before signals or rotation. This is one operation marker/snapshot, not a general journal.

Before every rename, atomically write `artifactMove` with `state: "intended"`, source identity and absent destination; revalidate both paths, perform the rename, then record its observed location and `state: "observed"`. Recovery locates identities against the original snapshot and this last move even if the post-rename marker write failed; never infer ownership from a slot name alone. Before any owned diagnostic directory is removed, write `artifactDisposal` with its exact identity/path and `state: "intended"`, then `state: "observed"` after verified absence. Interrupted removal may resume only against that recorded directory identity and the already-durable verified resolution. `retainedPaths` names all surviving operation and instance slots. `finishResolved` persists the verified `resolution` and final inventory before diagnostic cleanup or lock removal. On ordinary resolved failure remove its lock/staging; retain the newest `.hive.broken`, prior recovery files and final diagnostic record according to Step 5. On unresolved failure release process ownership only after persisting `unresolved`; subsequent invocations still refuse rotation until reconciliation. Do not erase another `.hive-state` consumer's files.

- [ ] **Step 2:** Implement in S7 the freeze/invoke path for the dependency-free `pkg/deploy.min.js` into `<home>/.hive-state/deployment/operations/<id>/deploy.min.js` before running the transaction. Compute/record its SHA-256, invoke the frozen file with `process.execPath`, and pass the explicit operation record path and command arguments. The original CLI/shell wrapper performs no deferred code reads from its replaced package. Task 2/S8's esbuild external check proves the helper's runtime graph needs only builtins; S9 exercises the real frozen bundle. Diagnostic subprocess paths are chosen explicitly for the candidate/current/recovery release and validated before each use.

Dry-run branches **before** lock/directory creation, freeze, npm lookup or config-secret import. It reads only config paths/manifests/current marker as needed and prints target, phase list, resolved selectors, voice enablement, known recovery profile and unknown evidence still needed. It performs no fetch/install/writes/vendor probes/service control/notifications. Test filesystem snapshots and all injected side-effect spies remain identical/zero.

- [ ] **Step 3:** Implement `artifact.ts` operations with these exact boundaries:

| Operation | Inputs and code path | Required checks |
| --- | --- | --- |
| resolve tag | one tag/version normalized by removing a leading `v`; `npm pack @keepur/hive@<selected> --json --pack-destination <op-downloads>` | array/object JSON parse; exactly one produced local regular archive; registry failure surfaces; never access BUILD_DIR |
| resolve local | absolute regular `.tgz` from `--artifact`; mutually exclusive with tag | canonical path and archive SHA; no reinterpretation as directory/source checkout |
| extract | archive list first, then `tar -xzf <archive> --strip-components=1 -C <owned-next>` | all members rooted `package/`; reject absolute/.. names, hardlinks/symlinks escaping root and unexpected archived operator-state paths; validate canonical extracted files; no shell command construction |
| validate stage | `readRelease(next, migrationRequiresClean)`; manifest/root dependency maps/lock hash; expected service entries | reject unknown contract and missing worker before touching services |
| install | `npm ci --omit=dev --no-audit --no-fund --no-progress`, staged cwd, same recorded npm as validation | do not ignore scripts; bounded process with explicit failure classification; never borrow dev/global node_modules |
| runtime/config preflight | staged `voice-worker-diagnostic offline`; staged `runtime-probe config` under intended service environment | native imports/assets contained; configured instance/database identity, selectors, voice flags/ports compatible; required secret names resolvable; no call/vendor mutation |
| prior validation | captured effective running profile, compatible prior artifact/worker/deps OR registered pilot snapshot | fail before stopping if recovery unavailable; mere `.hive.prev` existence is insufficient |

Stage while existing pair remains up. If `.hive.next` exists without this operation's ownership record, fail/reconcile rather than delete it. Do not extract over a symlink or nonempty unowned directory. Native install has its own bounded staging budget (10 minutes); no service signal occurs during it. This budget is distinct from maintenance/health budgets.

Before moving an old `.hive.prev`, ensure the captured current release/recovery route remains intact. Keep the old previous directory under this operation's private `prior-prev` until candidate health succeeds; do not delete the only usable prior generation during staging.

After complete artifact/config/prior-profile validation and before requesting maintenance or sending any signal, reserve an empty `.hive.broken` slot by moving an existing validated diagnostic to this operation's absent `prior-broken` slot with the Step 1 markers. Do not delete it here. Prove it is not referenced by any current/prior/pilot recovery profile or retained bootstrap tooling. If there is no existing broken directory, record that absence without a move. This preparation applies to update and ordinary rollback; pilot operations apply it only if their captured artifact moves use the broken slot. Any pre-signal failure restores the original broken directory from `prior-broken` after identity validation, so a deferred operation leaves the original diagnostic layout intact. An unexpected destination or unreconciled move retains `unresolved` and blocks a new rotation.

- [ ] **Step 4:** Implement reversible quiescence using these complete orchestration types/function. The adapter resolves current running configuration/port from corroborated supervisor identity, never blindly from the candidate's changed YAML.

```typescript
export class DeferredMaintenance extends Error {}
export class UnresolvedMaintenance extends Error {}
export interface IdleEvidence {
  supervisor: { pid: number; bootId: string };
  registered: boolean;
  ownedSocket: boolean;
  sdkActiveJobs: number | null;
  telemetryActiveCalls: number | null;
}
export interface QuiescenceIO {
  now(): number;
  wait(ms: number): Promise<void>;
  inspect(deadline: number): Promise<IdleEvidence>;
  close(operationId: string, deadline: number): Promise<void>;
  status(operationId: string, deadline: number): Promise<{ unresolved: number; closed: boolean }>;
  release(operationId: string, deadline: number): Promise<void>;
  recordBarrierRequested(operationId: string, supervisor: IdleEvidence["supervisor"]): Promise<void>;
}
function sameSupervisor(a: IdleEvidence, b: IdleEvidence): boolean {
  return a.supervisor.pid === b.supervisor.pid && a.supervisor.bootId === b.supervisor.bootId;
}
export async function quiesce(io: QuiescenceIO, operationId: string): Promise<IdleEvidence> {
  const deadline = io.now() + 30_000;
  const baseline = await io.inspect(deadline);
  if (!baseline.registered || !baseline.ownedSocket || baseline.sdkActiveJobs !== 0 || baseline.telemetryActiveCalls !== 0) {
    throw new DeferredMaintenance("active call or uncertain worker state");
  }
  await io.recordBarrierRequested(operationId, baseline.supervisor);
  try {
    // Ownership is recorded before the close request so a lost reply is reconcilable.
    await io.close(operationId, deadline);
    while (io.now() < deadline) {
      const gate = await io.status(operationId, deadline);
      const current = await io.inspect(deadline);
      if (!sameSupervisor(baseline, current) || !current.registered || !current.ownedSocket) {
        throw new DeferredMaintenance("worker identity or registration changed");
      }
      if (gate.closed && gate.unresolved === 0 && current.sdkActiveJobs === 0 && current.telemetryActiveCalls === 0) {
        return current;
      }
      await io.wait(Math.min(100, Math.max(0, deadline - io.now())));
    }
    throw new DeferredMaintenance("accepted work did not settle within 30 seconds");
  } catch (error) {
    try {
      await io.release(operationId, io.now() + 2_000);
    } catch {
      throw new UnresolvedMaintenance("maintenance release unacknowledged; services retained");
    }
    throw new DeferredMaintenance(error instanceof Error ? error.message : "maintenance deferred");
  }
}
```

The adapter imports the single `requestMaintenance` from `../voice-worker/maintenance-ipc.js` for Task 4's exact `close`/`status`/`release` protocol and injects the existing S3 read-only process-identity checks. Task 2 Step 3 bundles this module and its allowed pure dependencies; do not reproduce client matching, wire decoding or mailbox writes in `deployment/`. Validate the reply envelope's `operationId` as request correlation, separately from `snapshot.operationId`, which identifies the current gate owner. Close/status proof requires the expected owning operation, closed admission, no `snapshot.persistenceFault`, and matching protocol/request/PID/boot. For abort or stale-owner reconciliation, require a fresh matching terminal **release** acknowledgement: its envelope retains the supplied operationId, its snapshot is open with `operationId: null`, and the supervisor has durably finalized that operation against delayed/replayed close. This release is required even if the close never arrived and fresh status reports open; status is observation only. Release cannot open another operation's gate, and any persistence fault or unacknowledged release yields `UnresolvedMaintenance` with ownership/evidence retained. At the last instruction before bootout, recheck same PID/start time and confirmed closed gate/no unresolved ledger/no persistence fault; no new request can enter after the barrier.

All paths after `recordBarrierRequested` but before a signal must use the release/reconcile cleanup, including filesystem errors while writing `quiescent`. Treat no-running-worker as separate evidence, not `activeJobs=0`. A previously existing worker that exited or became unregistered during preflight is uncertain/deferred, not an idle result. An already-active call never receives a shutdown signal.

- [ ] **Step 5:** Implement the shared paired transaction with this core function. Its adapters below encode rollback mode differences and exact file rotation; no adapter may swallow a command failure.

```typescript
export interface TransactionIO {
  phase(value: Phase): Promise<void>;
  preflightAndStage(): Promise<void>;
  establishQuiescence(): Promise<void>;
  releaseAdmission(): Promise<void>;
  markSignalsBegun(): Promise<void>;
  stopWorkerAndChildren(): Promise<void>;
  stopEngine(): Promise<void>;
  rotate(): Promise<void>;
  installCandidateDefinitions(): Promise<void>;
  startEngineAndVerifyBoot(): Promise<void>;
  startWorker(): Promise<void>;
  verifyCandidatePair(): Promise<void>;
  finalizeHealthy(): Promise<void>;
  recoverPriorPair(): Promise<void>;
  finishResolved(): Promise<void>;
  retainUnresolved(error: unknown): Promise<void>;
}
export async function activate(io: TransactionIO): Promise<void> {
  let signalsBegun = false;
  let barrierEstablished = false;
  let healthyRecorded = false;
  try {
    await io.phase("preflight");
    await io.preflightAndStage();
    await io.phase("staged");
    await io.establishQuiescence();
    barrierEstablished = true;
    await io.phase("quiescent");
    await io.markSignalsBegun();
    signalsBegun = true;
    await io.phase("stopping-worker");
    await io.stopWorkerAndChildren();
    await io.phase("stopping-engine");
    await io.stopEngine();
    await io.phase("rotating");
    await io.rotate();
    await io.installCandidateDefinitions();
    await io.phase("starting-engine");
    await io.startEngineAndVerifyBoot();
    await io.phase("starting-worker");
    await io.startWorker();
    await io.phase("checking");
    await io.verifyCandidatePair();
    await io.phase("healthy");
    healthyRecorded = true;
    await io.finalizeHealthy();
    await io.finishResolved();
  } catch (primary) {
    if (healthyRecorded) {
      await io.retainUnresolved(primary);
      throw new AggregateError([primary], "candidate health passed; final cleanup requires reconciliation");
    }
    if (!signalsBegun) {
      if (barrierEstablished) {
        try { await io.releaseAdmission(); }
        catch (releaseFailure) {
          await io.retainUnresolved(releaseFailure);
          throw new AggregateError([primary, releaseFailure], "maintenance unresolved; no services signaled");
        }
      }
      if (primary instanceof UnresolvedMaintenance) await io.retainUnresolved(primary);
      else await io.finishResolved();
      throw primary;
    }
    try {
      await io.phase("recovering");
      await io.recoverPriorPair();
      await io.finishResolved();
    } catch (recovery) {
      await io.retainUnresolved(recovery);
      throw new AggregateError([primary, recovery], "activation and recovery failed; retained paths require attention");
    }
    throw new AggregateError([primary], "activation failed; prior pair restored and verified");
  }
}
```

Use a top-level `try/finally` in `main.ts` to persist/close lock ownership on normal exceptions and return nonzero for every thrown activation failure. If final evidence persistence fails after the candidate is healthy but before old-prior cleanup, recover or retain unresolved rather than print success. `phase("healthy")` atomically persists the checked result before `healthyRecorded` is set. `finalizeHealthy` must not delete the captured prior current release; it can delete the saved older `.prev` only after this durable result. Treat cleanup failure after durable healthy as a separately reported retained-artifact cleanup issue without rerunning rotation; do not erase a good activation record.

For no-op healthy start, stop-only, restart and voice-disabled modes, assemble this same sequence from purpose-specific adapters: stop has no rotate/start and requires barrier/exit success; restart has no artifact moves but the same quiescence/recovery path; disabled mode skips new worker bootstrap/probes but still stops/removes a loaded stale worker; fresh start has `priorProfile: stopped` and restores the exact stopped state on failure. All modes acquire the same operation lock. **Task 8 Step 5a in chunk 4** specifies reconstructable service snapshots, ordered restoration, pilot lineage/artifact preservation and fresh pilot-profile readback; complete those adapters before claiming the pilot paths implemented.

Rotation/recovery table (write marker before/after each rename):

| Mode | After old services exit | On candidate success | On any partial failure |
| --- | --- | --- | --- |
| update | `.hive.broken` already reserved absent; move previous `.hive.prev` to op `prior-prev`; move old `.hive` to `.hive.prev`; move owned `.hive.next` to `.hive` | retain prior current `.hive.prev`; return any `prior-broken` to the still-absent `.hive.broken`; remove saved older previous generation only after durable health | identify actual paths from operation marker, device/inode and manifests; move this operation's failed candidate from its observed `.hive`/`.hive.next` position into the reserved `.hive.broken`; restore original `.hive` and older `.hive.prev` positions |
| ordinary rollback | validate `.hive.prev` before stop; `.hive.broken` already reserved absent; move current `.hive` to op `rollback-current`; move `.hive.prev` to `.hive` | after durable health, move `rollback-current` into the reserved `.hive.broken`; preserve existing one-generation semantics (previous consumed) | move failed selected previous, if activated, from `.hive` to absent op `failed-prev`; restore `rollback-current` to `.hive`; restore selected previous from `failed-prev` to `.hive.prev`; return `prior-broken` to absent `.hive.broken`; if a move never happened, retain that original identity in its existing slot |
| first migration update | capture effective pilot definitions/paths; stage package as update while preserving unrelated old `.hive` inventory | `.hive` is candidate; pilot snapshot/worktrees/tooling remain available; `.prev` may still be incompatible | restore captured artifact directory positions and exact pilot definitions; check pilot profile |
| pilot rollback/reapply | restore captured pilot definitions without modifying pilot checkout/deps; candidate remains in its recorded operation-owned `.hive` slot while the pilot runs; use verified dispatch hold before stopping pilot on reapply (chunk 4 Task 8 Step 5a) | rollback proves pilot recovery; final reapply restores selected candidate and full packaged profile | restore last usable captured pair; never delete pilot or claim candidate acceptance from pilot health |

The broken-slot lifecycle retains one diagnostic generation. A recovered failed update leaves its candidate in `.hive.broken`; a successful ordinary rollback leaves the replaced current release there. Only after checking the resulting candidate/prior pair and persisting the matching healthy/recovered resolution may `finishResolved` dispose of the superseded owned `prior-broken` directory. Validate its original identity, canonical containment and absence from every remaining recovery reference again immediately before removal, and bracket disposal with the Step 1 markers. Never delete it merely to make a rename succeed. Successful updates and aborted/failed rollbacks return the captured older diagnostic to `.hive.broken` instead of discarding it. If disposal or restoration fails, retain exact locations and report unresolved cleanup; a healthy result never triggers another artifact rotation. This temporary holding slot is part of one operation's recovery, not an additional retained-release system.

`recoverPriorPair` first stops only positively identified candidate services/children (worker before engine) and verifies their exit. It then restores original artifact positions and exact definitions/link state, starts engine, requires fresh boot, starts the prior worker, then checks the captured packaged or pilot profile. A bootstrap/plist/link/rename/health exception all enter this path; shell `set -e` cannot bypass it because the supported transaction runs inside this bundled helper. If a process cannot be stopped or a file move cannot be reconciled, do not start a conflicting prior pair on occupied ports; retain and report both failures.

- [ ] **Step 6:** Add the failure-injection matrix to transaction unit tests in S7 and complete lifecycle integration tests in S9. Source unit tests use injected boundary results; S9 verifies those boundaries against the actual S8 helper/artifact. Use real disposable filesystem renames, fixture PIDs/process trees, fake clock and fake launchctl that models KeepAlive respawn while loaded. Record every adapter call in order. Assertions:

| Injection | Required result |
| --- | --- |
| registry/archive/root/lock/native/config/prior compatibility | no signal/bootout/plist rotation; same prior PIDs/definitions/config |
| close lost/wrong boot, accepted-but-unassigned job, running race, timeout | no signal/swap; require same-supervisor terminal release acknowledgement with matching envelope operationId and null snapshot.operationId; preserve call |
| close delayed until after terminal release, replayed close/release, fresh open status without release, snapshot persistence fault | no signal/swap; delayed/replayed close cannot reclose finalized operation; open status alone never permits cleanup; failed persistence retains ownership/unresolved evidence |
| release ack lost | no signal/swap; unresolved marker and diagnostic; no restored-availability claim |
| failure after quiescence marker but before bootout | admission released with acknowledgement |
| worker stop timeout, reparented child, engine stop timeout | checked recovery or unresolved; never claim reversible cancellation after signal |
| old-prev/current/next rename at each point | reconcile actual paths, restore exact prior pair, retain candidate artifact |
| existing owned broken; before/after-marker failure around broken-to-prior-broken, candidate-to-broken, prior-broken restore/disposal | no destination overwrite; reconcile recorded identities after each crash point; retain prior recovery/diagnostic routes until verified resolution; unknown/symlinked/changed/recovery-essential broken fails before signals |
| two consecutive failed update activations in the same instance, then ordinary rollback with existing broken | each failed update returns nonzero with the original running pair/previous positions restored; second failure retains the second candidate at `.hive.broken` and disposes the first diagnostic only after durable recovered outcome; from that fixture test both rollback branches: success leaves selected previous running and replaced current at `.hive.broken`; injected failure restores original current/previous/broken identities and verifies prior pair |
| plist write, link write, enable/bootstrap, engine markers, worker registration | checked prior recovery; failure exit even on healthy recovery |
| wrong current release/PID/start time, stale logs/heartbeat, foreign socket | candidate never accepted |
| recovery bootstrap/auth/registration failure | both primary/recovery failures plus retained paths; nonzero |
| concurrent second CLI/deploy-check, interrupted lock/marker | cannot interleave/re-enter rotation; same-home symlink shares lock |
| disabled worker, old `.prev` lacks worker | fresh disabled path no voice secrets; enabled rollback rejected before stop |

Also create sentinels with content hash and mode in `hive.yaml`, alternate dotenv, agents, plugins, skills, logs, unrelated `.hive-state` files and a second instance. Update/recovery/rollback/retry must preserve them. Only append expected logs/evidence; compare existing log prefix and mode rather than require byte-identical logs after a live service run.

## Task 9: Route CLI, deploy wrappers and first adoption through the same release implementation

**Files:** `src/cli.ts`, `src/cli/update.ts`, `src/cli/rollback.ts`, `src/cli/single-instance-env.ts`, relevant tests, `service/deploy.sh`, `service/deploy-check.sh`, `service/deploy.test.sh`, `src/deployment/main.ts`, `src/deployment/adoption.integration.test.ts`.

**Schedule:** S7 implements Steps 1–4, including all final helper option handlers and CLI/shell shim tests, after Task 8 source implementation. Do not run the bootstrap commands against the repository or a live instance at this source checkpoint. S8 builds these real entries, and S9 creates/runs Step 5's artifact-backed bootstrap/adoption tests. The bootstrap runbook procedure remains a later Task 12 operational action.

- [ ] **Step 1:** Add string option `artifact` and boolean option `dry-run` to the CLI parser/helper types. Extend UpdateOptions to `{ tag?: string; artifact?: string; instance?: string; dryRun?: boolean }`, RollbackOptions with `dryRun?: boolean`. Reject `--artifact` plus `--tag`, nonabsolute/nonregular/non-tgz artifact, and explicit instance ID unequal to selected config before writes. Help describes update/rollback as the engine and enabled worker release unit.

Also fix `ensureHiveInstallOrExit` to check `resolve(home, process.env.HIVE_CONFIG ?? "hive.yaml")`, so an instance with only an explicitly selected alternate config can start; test it with no default hive.yaml and with both relative and generated absolute `hive-personal.yaml` selectors. This validation shares Task 7's basename-based `resolveDotenvPath` fix; checking config existence alone is insufficient. The CLI-to-helper-to-service/probe handoff must preserve the same absolute selector and select `.env-personal` throughout.

`runUpdate`/`runRollback` resolve their **own running CLI package's** `pkg/deploy.min.js` from `import.meta.url`, validate it, freeze/invoke it through Task 8. Never choose the installed target's `.hive/service/deploy.sh` by default; this is essential when candidate CLI runs from bootstrap tooling. For development source invocation, use the built helper in the same source package only when explicitly present; no live target fallback. `deriveSingleInstanceEnv` becomes a non-secret identity/config handoff, not a port kill set. Any derived ports are ownership/preflight hints only.

Remove automatic post-upgrade skill sync from the supported transaction path: it would modify operator skills during a code-only update and violates the preservation comparison. Retain the existing explicit `hive skill sync` command and document it separately. Preserve beta plugin relocation behavior only as a named preflight compatibility action, after acquiring the instance lock and before stage, with its exact paths captured and no overwrite; dry-run does not perform it. Its scoped compatibility migration must not touch normal operator plugins/skills. If an actual instance requires broader plugin relocation conflicting with baseline preservation, stop and report that separate migration dependency. **Task 9 Step 1b in chunk 4** is the exact path/ownership/rename-fence and crash-reconciliation contract; do not call the former unlocked CLI preflight.

- [ ] **Step 2:** Add a **top-of-script** supported single-instance branch in `service/deploy.sh`, before BUILD_DIR/instances.conf reading and before sourcing `$DEPLOY_DIR/.env`. It invokes the matching sibling package deploy helper and exits with that helper's status. The helper freezes itself before rotation. All later existing code remains explicitly developer multi-instance mode; it cannot run for a supported single-instance request.

```bash
if [[ "${HIVE_SINGLE_INSTANCE:-}" == "1" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  DEPLOY_HELPER="$SCRIPT_DIR/../pkg/deploy.min.js"
  if [[ ! -f "$DEPLOY_HELPER" ]]; then
    echo "ERROR: packaged deployment helper missing" >&2
    exit 1
  fi
  exec "${HIVE_NODE_PATH:-node}" "$DEPLOY_HELPER" "$@"
fi
```

The helper derives its instance from explicit HIVE_HOME/HIVE_CONFIG or the existing HIVE_SINGLE_* env surface and verifies agreement; it never reads global registry/build paths. The top-level helper freezes itself when not already executing the validated operation-local path, then the frozen process owns the transaction. Registry failure cannot fall through to the developer rsync path. No credential dictionary is sourced by the single-instance branch.

Keep existing developer helpers/tests scoped to developer mode, including any historical build fallback. Extend `service/deploy.test.sh` with full supported-branch invocations using a helper shim plus transaction fixtures: no BUILD_DIR/instances.conf reads, no old installed updater calls, accurate nonzero propagation, dry-run zero writes, worker lifecycle covered by real helper fixture tests. Do not mistake old shell helper smoke success for pair-lifecycle success.

- [ ] **Step 3:** Give supported `service/deploy-check.sh` an early single-instance route that uses the same helper/lock. It checks a selected registry pin while holding the operation lock (or performs an advisory lookup then reacquires/revalidates under that lock before any mutation). Its compare/update cannot bypass recovery compatibility or native staging. Existing developer mode remains available. Do not create a new schedule. Migration inventories **existing dodi-specific** checker entries/pins and repoints only those to this supported route; any shared registry change must preserve Keepur rows byte-for-byte and retain a before/after comparison. Default helper behavior does not send notifications. Existing developer notification behavior remains outside supported test/migration commands unless separately authorized.

- [ ] **Step 4:** Implement/document first-adoption bootstrap under `<instance>/.hive-state/bootstrap/<archive-sha>/package` using [chunk 4 Task 9 Steps 4a–4d](./kpr-463-plan-pilot.md). These substeps replace the earlier draft-only bootstrap heredoc and unspecified inventory-file contracts. They define strict serialized pilot/hold/bootstrap records and registration, allowed read-only check representations, ownership/hash/same-instance/path/process checks, complete dispatch-source and outstanding-work accounting, current verification/freshness/release procedures, stable bootstrap flags and pilot reconstruction/recovery/reapply. Preserve independently reviewed candidate SHA/revision and the complete validated tooling/dependency tree/archive through rollback/reapply; live service definitions point only at `.hive/pkg`.

The retained helper's `--pilot-recovery=<absolute-snapshot>` and `--legacy-hold=<absolute-evidence-record>` accept only exact registered payload paths with matching operation lineage, never arbitrary files or authorization booleans. Normal rollback still rejects an incompatible `.prev`. The described pilot lacks accepted-assignment accounting and the new handshake. Chunk 4 specifies an executable current assessment that reports `MIGRATION_PENDING` before stage/signals when no verifiable hold exists; no source edit retrofits the protected pilot. Only an already present, independently verified capable runtime can use the implemented native hold route. An actual external legacy hold requires its inventoried authoritative interface and reviewed concrete adapter; observation-only JSON/idle polling cannot provide that proof. This preserves the required actual S12 acceptance gate.

- [ ] **Step 5:** In S9, add the adoption test with a deliberate old-updater sentinel script in target `.hive/service/deploy.sh` that writes `OLD_UPDATER_CALLED` and exits 97. Run the actual S8 candidate CLI from the bootstrap fixture. Require the sentinel never runs; candidate helper hash equals bootstrap package helper, both new plists point to target `.hive/pkg`, pilot snapshot survives, failure restores the pilot profile, and reapply needs a freshly verified legacy hold. Apply chunk 4 Task 9 Step 5a's explicit capable versus uninstrumented fixture distinction; the latter must defer without a fabricated capability. After successful migration, ordinary future updates/rollbacks must work with independent packaged prior releases without reading pilot paths.

```bash
npx vitest run src/cli/update.test.ts src/deployment/adoption.integration.test.ts src/deployment/transaction.test.ts src/deployment/lifecycle.integration.test.ts
bash service/deploy.test.sh
```

Expected: all tests pass with target-only fixture activity and nonzero status for every failed operation, including successfully recovered ones.

## Task 10: Document supported operation and recovery boundaries

**Files:** `CLAUDE.md`, `AGENTS.md`, `docs/epics/kpr-462/kpr-463-operations.md`; relevant installation docs located with `rg -n 'dist/voice-worker|voice-worker|service/install|deploy.sh' README.md docs install`.

- [ ] **Step 1:** Update current pilot-only worker descriptions to the implemented packaged path and separate process convention. Preserve upstream epic Phase-0 boundary, KPR-321 unresolved telephony ops, KPR-466 live-call acceptance and model/vendor/warm-path choices. Do not imply upstream SIP/P/W/T gates passed.
- [ ] **Step 2:** Document Node installed host path, supported engine range, operational Node24/macOS ARM64 proof, recorded npm version, command-line/build/native install prerequisites determined by the real T2 install, network registry requirement, no ignored native scripts, larger voice-disabled dependency footprint, instance health-port override and collision behavior.
- [ ] **Step 3:** Document exact update/artifact/dry-run/start/stop/rollback commands, admission deferral/release-unresolved messages, retained ledger diagnostics, staging/recovery paths, first-adoption bootstrap and separate pilot recovery profile. Explain no automatic clearing of unknown accepted work and no force-call-termination option.
- [ ] **Step 4:** Include operator-owned preservation baseline, dodi-only updater inventory, Keepur comparison, legacy hold evidence requirements, candidate tooling retention, no pilot worktree retirement, and migration-pending status until actual T9 passes. The new package is the supported runtime after acceptance; retained pilot artifacts remain a historical recovery route until a known-good packaged previous generation exists.
- [ ] **Step 5:** Record the user's explicit authorization (`ac95b136`) to use dodi-dev in place of the unavailable `/spec-and-implement` entrypoint. Follow the existing dodi-dev plan-review and delivery gates and the parent schedule; no workflow restoration is pending. This substitution does not establish operational prerequisites or authorize live calls.

## Task 11: Integrated verification and release gate

**Files:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `package.json`, all touched tests/guards.

- [ ] **Step 1:** Retain existing Node22 checks and declared engine support. Add a macOS ARM64 Node24 packed-artifact check using the same check:artifact script; make the existing release validation path run it rather than relying on symlink runtime smoke. Existing CI host is self-hosted macOS ARM64; explicitly select Node24 for this job and retain a Node22 build/test/bundle job. Each fresh job builds before SDK-child tests and builds the complete bundle before artifact checks. Increase job timeout only enough for fresh production native installs (30 minutes); do not skip the guard because it is slower. Publishing must depend on successful check:bundle/artifact validation and a clean manifest, while its existing publication authorization remains unchanged.
- [ ] **Step 2:** Run the full contract once integrated:

```bash
npm run bundle
npm run check
bash service/deploy.test.sh
bash service/install.test.sh
npm run check:bundle
```

Expected: all exit 0; no skipped T1–T8 cases; actual fresh install/native and SDK-import markers. Inspect the tarball listing and release/lock identity from the built artifact. Confirm no source/dev/global dependency links in reported runtime paths. Run Node22 and Node24 matrices as specified; an unavailable required Node24 ARM64 runner is a concrete T2 blocker.
- [ ] **Step 3:** Run repository verification and fresh-context child review through the dispatcher, fix findings, and re-run only affected checks unless new changes warrant broader regression. Commit/push/open child PR only through the existing lane skills. Do not mark KPR-463 operationally complete after tests or merge.
- [ ] **Step 4:** Build the migration candidate from the exact final reviewed clean revision after commits; regenerate shrinkwrap/manifest, pack once, record archive hash and retain that exact archive. Any further implementation change requires a new candidate identity and revalidation. A dirty fixture artifact can satisfy automated behavior tests but cannot be selected for actual dodi migration.

## Task 12: Dodi operational acceptance and KPR-466 evidence handoff

This task is S12 and runs only after reviewed, verified delivery through the authorized dodi-dev workflow and establishment of its real operational prerequisites. Maturation runs none of these commands. It requires no live call; do not dispatch one. Existing Gate1 delegation covers routine sequencing choices, not a claim that the candidate, pilot recovery inventory or verified legacy hold already exists.

**Files:** Create `docs/epics/kpr-462/kpr-463-deployment-evidence.md` during actual delivery. Keep precise service snapshots/secret-bearing originals under dodi `.hive-state`; commit only sanitized evidence.

- [ ] **Step 1:** Inventory live dodi root rather than assuming the supplied `~/services/hive/dodi`. Capture exact engine/worker labels, current launchd PIDs/args/cwd, explicit config selection, executable hashes, dependency realpaths and lock versions, actual pilot SDK listener/owner, Node/npm versions, allowed non-secret env settings, routing/voices/flags and Mongo identity. Record Keepur PID/start time/plist paths/config hashes and relevant updater entries as a before baseline. Do not print complete launchctl environment, dotenv/Keychain contents, secret argv or credential-bearing API responses.
- [ ] **Step 2:** Hash/config-mode baseline and read-only data identity/routing baseline. Verify the named pilot worktrees and dependencies exist and remain untouched. Gather the recovery snapshot inputs and assess the legacy dispatch hold across all dodi sources and outstanding assignment work using chunk 4 Task 9 Steps 4a–4c. Final snapshot/hold registration uses the validated tooling prepared at the start of Step 3 and must finish before its cutover command. Record exact establishment/check/release results after inventory; no generic placeholder is treated as verification. The described pilot has no established external dispatch fence/assignment authority: if actual readback cannot supply a reviewed complete route, record `MIGRATION_PENDING` and do not execute cutover/reapply. Missing recovery evidence also defers before any signal.
- [ ] **Step 3:** Use chunk 4 Task 9 Step 4d's final bootstrap/registration/capture procedure with the reviewed candidate tarball, then complete Step 2's snapshot/hold registration and current proof. Execute the cutover command below only if its required current hold route exists; a pending inventory result is not a bypass. Parameter values below are populated from inventory; each variable is task-specific and none overrides shell HOME/CODEX_HOME.

```bash
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/voice-worker-diagnostic.min.js" offline
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/cli.min.js" update --artifact="$KPR463_ARCHIVE" --dry-run
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/deploy.min.js" --artifact="$KPR463_ARCHIVE" --legacy-hold="$KPR463_HOLD"
```

The helper's first migration path reads the registered pilot snapshot and current verified hold record under this instance (an explicit `--legacy-hold` selects a registered record, never an arbitrary bypass); require explicit selected instance agreement and clean archive identity. No implicit old updater or BUILD_DIR fallback. Expected: candidate `.hive`, engine fresh boot then worker registration, all packaged checks pass, no message/call emitted. If any operation fails, retain primary/recovery evidence and leave acceptance pending.

- [ ] **Step 4:** Run explicit read-only acceptance from the live packaged worker environment. Populate the runbook's `KPR463_WORKER_ENV` shell array with literal `KEY=value` entries produced by Task 7's `buildServiceEnvironment` from the captured, validated live worker definition, including its HOME/PATH/selectors and supported overrides such as `VOICE_PORT`. Verify this map deep-equals the generated worker service environment and matches the selected instance/config before probing. Do not populate it from the ambient shell or use `eval`; `env -i` below prevents inherited shell values from changing config or secret selection.

```bash
env -i "${KPR463_WORKER_ENV[@]}" "$KPR463_NODE" "$KPR463_INSTANCE/.hive/pkg/runtime-probe.min.js" bridge
env -i "${KPR463_WORKER_ENV[@]}" "$KPR463_NODE" "$KPR463_INSTANCE/.hive/pkg/runtime-probe.min.js" worker
env -i "${KPR463_WORKER_ENV[@]}" "$KPR463_NODE" "$KPR463_INSTANCE/.hive/pkg/runtime-probe.min.js" outbound
```

Expected: correct token's exact missing-agent rejection and both bad-token denials; SDK registration/current owner/identity/heartbeat pass; configured trunk/read-only auth/routing relationship verified. Report only sanitized classifications. Independent OS read-back must corroborate both process identities and installed paths; helper output alone is not enough.

- [ ] **Step 5:** Exercise paired restart via retained helper `--restart`, requiring its barrier, stop/start order and full health. Exercise `--pilot-recovery="$KPR463_PILOT_SNAPSHOT"`, require the complete pilot recovery profile at its actual listener, and retain unavailable new identity fields honestly. Re-establish/reverify the legacy hold with a **new current** evidence record, then reapply the exact selected archive through the retained helper `--artifact=... --legacy-hold=...`. Require full packaged profile again and release the external hold using its inventoried procedure only after final health allows it.
- [ ] **Step 6:** Repeat live launchd/process/dependency/config/routing read-back and all preservation/Keepur comparisons. Check dodi-specific updater paths/pins cannot reinstall the pilot or an engine-only artifact. Retain both pilot worktrees and bootstrap candidate tooling; do not delete or rename them. State whether rollback is still pilot-only or now independently supported by a known-good previous package.
- [ ] **Step 7:** Fill evidence with actual results:

| Field | Required record |
| --- | --- |
| execution | date/operator, real host OS/arch, Node/npm versions |
| artifact | source revision, package version, dirty=false, archive/lock digests, retained archive/tooling path |
| services | labels, observed live PIDs/start times/boot IDs, arguments/cwd/selectors, canonical package/dependency paths |
| health | every packaged-profile result; bridge three-request outcomes; SDK root/worker/socket-owner/registration and heartbeat; read-only trunk/routing checks |
| lifecycle | paired restart, pilot rollback and profile result, re-established hold, candidate reapply and final health |
| preservation | config/dotenv hashes/modes, data/agent routing comparison, Keepur baseline comparison, dodi-only updater changes |
| recovery | current mode, exact locally retained artifacts/snapshots, unresolved entries/errors if any |
| final state | exact final running artifact/boot identities and verification time |
| pending | unexecuted/failed check, precise reason and impact; no blank interpreted as pass |

KPR-466 consumes this ticket as passed only after actual migration/restart/rollback/final read-back pass. Otherwise report **implementation verified; migration pending** with the specific operational gap. KPR-466 rechecks no-call preflight against its eventual integrated release before May-authorized calls; this ticket provides no audio/latency/conversation result.

## Draft assumptions and review handoff

- The approved six pinned dependencies and Node engine contract remain unchanged.
- Task 1's initial SDK proof is preserved on child commit `438115f2788e19c01dc8d7e08a43be17ef3a30bb` with the recorded build/20-test evidence in the parent schedule; subsequent runtime changes retain the prescribed affected SDK checks.
- Filesystem IPC is the delegated local-IPC implementation choice; it avoids a public control server and macOS socket-path length constraints.
- A dependency-free bundled transaction helper is the concrete solution to self-replacement and first adoption; SDK/native/config probes remain separate installed helpers.
- No merged sibling canon was supplied. Shared main/config/telemetry changes must be integrated serially with later KPR-464/KPR-465 work.
- Actual pilot identity/port/hold mechanisms are filled from delivery inventory; absence of verifiable hold/recovery evidence defers migration without a force bypass.
- The user authorized dodi-dev to replace unavailable `/spec-and-implement` (`ac95b136`). Resume requires clean plan review and integration of these epic documents into the preserved child; deployment prerequisites and actual T9 evidence remain separate pending gates.
