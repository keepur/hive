# KPR-463 implementation plan — worker runtime and evidence

This is chunk 2 of the [parent plan](./kpr-463-plan.md). Its Testing Contract, authority, workflow dependency and execution restrictions apply in full. Draft for review; do not deploy or call.

## Task 4: Reversible admission gate and instance-local IPC

**Files:** Create `src/voice-worker/admission.ts`, `src/voice-worker/maintenance-ipc.ts`, `src/voice-worker/admission.test.ts`, `src/voice-worker/maintenance-ipc.integration.test.ts`. Modify `src/voice-worker/main.ts` only after Task 1 proof passes.

- [ ] **Step 1:** Implement the synchronous authority below. The JS callback reserves the job before its first await. SDK assignment/launch completion is deliberately not inferred from the returned promise. Reject repeated job IDs within one boot; record duplicate diagnostics without modifying an earlier entry.

```typescript
export interface SupervisorRef { pid: number; bootId: string }
export interface AcceptedJob {
  jobId: string;
  acceptedAt: number;
  phase: "accepted-awaiting-entry" | "entered-awaiting-completion";
  childPid?: number;
}
export interface AdmissionSnapshot {
  supervisor: SupervisorRef;
  operationId: string | null;
  admission: "open" | "closed";
  unresolved: AcceptedJob[];
  childPids: number[];
}
export interface RequestLike {
  id: string;
  accept(): Promise<void>;
  reject(): Promise<void>;
}
export class AdmissionLedger {
  private operationId: string | null = null;
  private readonly pending = new Map<string, AcceptedJob>();
  private readonly seen = new Set<string>();
  private readonly childPids = new Set<number>();
  constructor(
    private readonly supervisor: SupervisorRef,
    private readonly changed: (snapshot: AdmissionSnapshot) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  snapshot(): AdmissionSnapshot {
    return {
      supervisor: { ...this.supervisor }, operationId: this.operationId,
      admission: this.operationId === null ? "open" : "closed",
      unresolved: [...this.pending.values()].map((job) => ({ ...job })),
      childPids: [...this.childPids],
    };
  }
  private publish(): void { this.changed(this.snapshot()); }
  async request(req: RequestLike): Promise<void> {
    if (this.operationId !== null || this.seen.has(req.id) || !req.id) {
      await req.reject();
      return;
    }
    this.seen.add(req.id);
    this.pending.set(req.id, { jobId: req.id, acceptedAt: this.now(), phase: "accepted-awaiting-entry" });
    this.publish();
    // Do not delete in a then/finally/catch: this promise does not await assignment.
    await req.accept();
  }
  close(operationId: string): AdmissionSnapshot {
    if (!operationId) throw new Error("operation ID required");
    if (this.operationId !== null && this.operationId !== operationId) throw new Error("maintenance owned by another operation");
    this.operationId = operationId;
    this.publish();
    return this.snapshot();
  }
  release(operationId: string): AdmissionSnapshot {
    if (this.operationId !== operationId) throw new Error("maintenance release ownership mismatch");
    this.operationId = null;
    this.publish();
    return this.snapshot();
  }
  entered(ref: SupervisorRef, jobId: string, childPid: number): void {
    this.assertSupervisor(ref);
    const job = this.pending.get(jobId);
    if (!job || !Number.isSafeInteger(childPid) || childPid <= 1) throw new Error("unknown job entry");
    if (job.childPid !== undefined && job.childPid !== childPid) throw new Error("job child mismatch");
    job.childPid = childPid;
    job.phase = "entered-awaiting-completion";
    this.childPids.add(childPid);
    this.publish();
  }
  completed(ref: SupervisorRef, jobId: string, childPid: number): void {
    this.assertSupervisor(ref);
    const job = this.pending.get(jobId);
    if (!job || job.childPid !== childPid || job.phase !== "entered-awaiting-completion") {
      throw new Error("completion lacks matching entry");
    }
    this.pending.delete(jobId);
    this.publish();
  }
  canStop(operationId: string, sdkActiveJobs: number | null, telemetryActiveCalls: number | null): boolean {
    return this.operationId === operationId && this.pending.size === 0 &&
      sdkActiveJobs === 0 && telemetryActiveCalls === 0;
  }
  private assertSupervisor(ref: SupervisorRef): void {
    if (ref.pid !== this.supervisor.pid || ref.bootId !== this.supervisor.bootId) throw new Error("supervisor mismatch");
  }
}
```

A failed ledger persistence before accept causes request-hook rejection and closed/uncertain diagnostics; it must never proceed to accept after an unsuccessful persistence. Do not clear this uncertain entry automatically. A failed persistence during close prevents acknowledgement; lifecycle aborts before any signal. `changed` must never swallow an I/O failure. Once a callback starts, request reservation and gate close are serialized by the same supervisor event loop.

- [ ] **Step 2:** Implement a private filesystem mailbox, avoiding Unix-socket pathname limits for long/symlinked macOS homes. It lives at `<canonical instance>/.hive-state/voice-worker/<bootId>/`, with mode 0700 directories and 0600 JSON files, never under `.hive`.

Protocol types in `maintenance-ipc.ts`:

```typescript
import type { AdmissionSnapshot, SupervisorRef } from "./admission.js";
export type MaintenanceCommand = {
  protocol: 1; requestId: string; operationId: string; supervisor: SupervisorRef;
  kind: "close" | "release" | "status";
};
export type JobEvent = {
  protocol: 1; eventId: string; supervisor: SupervisorRef;
  jobId: string; childPid: number; sequence: 1 | 2;
  kind: "entered" | "completed";
};
export interface MaintenanceReply {
  protocol: 1; requestId: string; operationId: string; supervisor: SupervisorRef;
  ok: boolean; classification?: string; snapshot: AdmissionSnapshot; writtenAt: number;
}
```

File layout and ownership:

| Path | Writer | Contents/reader rule |
| --- | --- | --- |
| `.hive-state/voice-worker/current.json` | supervisor | protocol, supervisor PID/bootId, boot time, canonical state directory, configured SDK host/port and instance ID; no credentials |
| `<bootId>/commands/<requestId>.json` | lifecycle process | one immutable command; random UUID filename; consumer validates exact body/filename and ref |
| `<bootId>/replies/<requestId>.json` | supervisor | reply after mutation and snapshot have been durably written; matching operation/request/ref required |
| `<bootId>/jobs/<eventId>.json` | job child | entered sequence 1 or completed sequence 2; no call metadata/transcripts/numbers |
| `<bootId>/snapshot.json` | supervisor | latest ledger plus supervisor identity and liveness timestamp |
| `.hive-state/deployment/operation.json` | locked lifecycle process | barrier ownership retained across interruptions, described in Task 8 |

Use this atomic write function, with caller-provided paths restricted to validated UUID filenames and the owned directory:

```typescript
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
```

Validate `.hive-state`, boot directories and mailbox entries with `lstat`/realpath before use: reject a symlinked state child, wrong owner, non-regular message file, file above 16 KiB, bad protocol/UUID, unknown kind or a ref that differs from this supervisor. Resolve an intentional symlink of the **instance home** once, then require all state descendants to remain within that real root. Bind mailbox creation and snapshot initialization before SDK workers can fork. Do not place credential values in these records.

The supervisor polls every 50 ms, draining job events in `(jobId, sequence)` order before commands; it also publishes liveness at least every second. Processing is synchronous between timer callbacks so close and request reservation cannot interleave inside a mutation. On `close`, call ledger.close then write matching reply; `release` calls ledger.release then replies with admission open and operationId null; `status` returns a fresh snapshot if the caller owns the closed gate, or if admission is currently open; an open reply must explicitly contain `operationId: null`. A different operation’s closed gate is an ownership error. This permits a fresh acknowledgement that a lost close command never took effect. Delete consumed commands/events only after their resulting snapshot/reply is written. Event application is idempotent: retain bounded event-ID receipts until the corresponding message is deleted; if replayed after a completed job, verify the receipt rather than reapply completion. This prevents a crash/retry from turning a valid completion into an unknown-job error. Invalid messages produce sanitized diagnostic classifications and cannot alter the gate.

The supervisor should not auto-open a barrier merely because a timer expires or the client disappears: expiration might overlap launchd shutdown. The next lifecycle invocation reconciles the recorded operation with the current PID/boot as specified in Task 8. Requests remain rejectable until release is positively acknowledged.

Job children inherit **only local identity additions** before `cli.runApp`: `HIVE_VOICE_SUPERVISOR_PID`, `HIVE_VOICE_SUPERVISOR_BOOT_ID`, `HIVE_VOICE_STATE_DIR`. Existing LiveKit auth environment inheritance remains unchanged. These variables do not select a different instance or secret store. Child event writer validates its local environment, job ID, own PID and state containment and writes entered/completed atomically. Missing/invalid tracking state in a packaged worker fails before starting call work; developer/source runs can explicitly use a local in-memory reporter, but no packaged acceptance mode may disable tracking.

- [ ] **Step 3:** Add `requestMaintenance` client with exact matching and a hard supplied deadline. Send commands using a new UUID, record request timestamp, poll its one reply at 50 ms. Require same protocol, operation/request ID, PID/boot, reply timestamp at or after request, and expected admission/ownership. Verify live launchd PID/process identity independently before trusting current.json, before close, and immediately before stop. A fresh file from an old boot cannot pass.

Close/status polling shares the **same** 30-second maintenance deadline. Abort release has a separate bounded 2-second acknowledgement budget so a timeout can be reported safely. Do not reset the 30 seconds per request. If release acknowledgement is missing or mismatched, retain operation/barrier ownership and report `maintenance-unresolved`; leave services/artifacts intact.

- [ ] **Step 4:** Expose diagnostics for unresolved entries in CLI/probe output: job ID, supervisor PID/boot, accepted timestamp/age, phase and observed child PID if available. In particular, `accepted-awaiting-entry` after assignment/prewarm/import failure and `entered-awaiting-completion` after lost acknowledgement remain unresolved until the genuine completion path settles them. SDK job-count zero, assignment timeout, dead child, stale heartbeat or elapsed time **never** clear these records. A planned lifecycle operation defers; this ticket introduces no `--force`, ledger-clear or call-termination flag. An operator can investigate retained state; a separate incident recovery decision is not disguised as a normal update.

- [ ] **Step 5:** Verify and checkpoint this slice.

```bash
npx vitest run src/voice-worker/admission.test.ts src/voice-worker/maintenance-ipc.integration.test.ts
```

Minimum cases: close/release/status happy path; request-after-close rejection; reserve-before-accept; duplicate job ID; completion from wrong boot/job/PID; sequence 2 before sequence 1 file order; idempotent event replay; ledger-write/command/reply failure; stale current/reply; request-owner conflict; second instance; special-path/symlink home; missing entry/completion; timed-out release; retained unresolved diagnostics. No test calls drain or signals a real worker.

## Task 5: Wire tracking and immutable boot evidence without altering conversation logic

**Files:** Create `src/voice-worker/job-lifecycle.ts`; modify `main.ts`, `telemetry.ts`, `worker-config.ts`, `src/index.ts`, and related tests.

- [ ] **Step 1:** Use this complete entry/cleanup envelope in `job-lifecycle.ts`. It registers shutdown tracking before configuration, metadata parsing, Mongo connection or session work. SDK callback concurrency is handled by an explicit cleanup promise; entry return does not imply job completion.

```typescript
import type { JobContext } from "@livekit/agents";
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
export interface JobReporter { entered(): void; completed(): void }
export async function withJobLifecycle(
  ctx: Pick<JobContext, "addShutdownCallback">,
  reporter: JobReporter,
  work: (hooks: {
    delegateCleanup(): () => void;
    setEarlyCleanup(cleanup: () => Promise<void>): void;
  }) => Promise<void>,
): Promise<void> {
  const entrySettled = latch();
  const cleanupDone = latch();
  let delegated = false;
  let earlyCleanup = async (): Promise<void> => {};
  ctx.addShutdownCallback(async () => {
    await entrySettled.promise;
    if (delegated) await cleanupDone.promise;
    else await earlyCleanup();
    reporter.completed();
  });
  try {
    reporter.entered();
    await work({
      delegateCleanup() {
        delegated = true;
        return cleanupDone.resolve;
      },
      setEarlyCleanup(cleanup) { earlyCleanup = cleanup; },
    });
  } finally {
    entrySettled.resolve();
  }
}
```

If ordered session teardown rejects before its final hook, cleanup remains unresolved and the reporter cannot claim completion; the SDK may eventually terminate the job, but maintenance still defers. `completed()` writing unsuccessfully also leaves the supervisor ledger unresolved. These conservative outcomes are intentional and must be diagnostic, never swallowed as proof of safety.

- [ ] **Step 2:** In `main.ts`, keep the existing exported symlink-safe `isEntrypoint` guard. Make config/session/telemetry imports lazy inside supervisor boot/agent entry so the SDK can import/prewarm the packaged default export without loading secrets. Do not move the SDK's dynamic process modules into the bundle. Replace only the default entry implementation with this block, adding the indicated pure tracking imports at module scope:

```typescript
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const reporter = createJobReporter(ctx.job.id);
    await withJobLifecycle(ctx, reporter, async (hooks) => {
      const { loadWorkerConfig } = await import("./worker-config.js");
      const { runCallSession } = await import("./session.js");
      const { VoiceWorkerHeartbeat } = await import("./telemetry.js");
      const wc = loadWorkerConfig();
      const meta = parseDispatchMetadata(ctx.job.metadata);
      const cell = resolveCell(meta, wc);
      const mongo = new MongoClient(wc.mongoUri);
      hooks.setEarlyCleanup(() => mongo.close());
      await mongo.connect();
      const heartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
        defaultStt: wc.defaultStt, defaultTts: wc.defaultTts,
      });
      const cleanupFinished = hooks.delegateCleanup();
      await runCallSession(ctx, wc, meta, cell, heartbeat, async () => {
        await mongo.close();
        cleanupFinished();
      });
    });
  },
});
```

`createJobReporter` comes from `maintenance-ipc.ts`; `withJobLifecycle` from `job-lifecycle.ts`. The existing `session.ts` callback remains `releaseCall → flush → closeMongo`; no new sibling callback can race Mongo close. Do not alter STT/TTS, warm execution, speech handling, logging metrics or per-agent routing. The new wrapper adds one lifecycle callback but does not call `ctx.connect`, `ctx.shutdown`, or change a successful call's entry-return semantics.

- [ ] **Step 3:** Supervisor boot derives the release/boot identity from its actual module before writing heartbeat. After config load and before SDK creation: create the mailbox and ledger; export supervisor tracking refs for children; log the release/boot identity; write and start the heartbeat; call SDK CLI with:

```typescript
cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: "hive-voice",
  host: "127.0.0.1",
  port: wc.healthPort,
  requestFunc: (request) => ledger.request(request),
  ...livekitServerAuth(wc),
}));
```

Preserve `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` export into worker-process env for SDK children. Reuse current shared secret resolution. Leave production CLI signal behavior intact; maintenance never calls it until quiescence is established. On supervisor boot failure, log only the existing named failure class and exit nonzero. Register timer/resource cleanup on exit without reopening a closed gate. The SDK's `/` and `/worker` are the existing public listener; mailbox adds no network listener.

- [ ] **Step 4:** Extend `VoiceWorkerHeartbeat` constructor with an **optional** fourth `supervisorIdentity?: BootIdentity` argument after existing `intervalMs`. Supervisor `writeBoot` and `writeOnce` add `supervisorIdentity` and `supervisorUpdatedAt: new Date()` only when this argument is present. Job instances do not supply it. Do not overwrite these fields from noteCallStarted/noteCallEnded/noteError, even though those methods currently update the separate legacy `updatedAt` field. Keep counter `$inc`, boot ghost-call reset, error preservation and existing default-cell behavior unchanged.

Use `supervisorUpdatedAt`, not `updatedAt`, for new readiness freshness. Keep `updatedAt` for legacy display only. Tests must prove that fresh job writes cannot refresh a dead supervisor and that an old supervisor identity is not replaced by a child.

- [ ] **Step 5:** In `src/index.ts`, locate the existing `Hive starting up` and `Hive is running` log calls and attach the same boot identity object created once at process startup. Emit a separate structured release boot line if needed, but preserve both marker strings and their order. Scope each marker with `pid`, `bootId`, source revision/version/lock digest and component. Write a local identity record under `.hive-state/runtime/engine.json` with PID/boot/start time for observed identity lookup; health must still corroborate live launchd/OS evidence and fresh ordered log markers.

Packaged entrypoints require their manifest. Source/developer entrypoints remain startable: explicitly classify their identity as `source/unavailable` with actual PID/boot, never apply an unrelated existing `pkg/release.json` to a `src`/`dist` process. The release helper identifies the actual canonical entrypoint, not cwd. A missing manifest from a `.hive/pkg` service is a startup failure.

- [ ] **Step 6:** Verify the wrapper and telemetry boundary before committing.

```bash
npx vitest run src/voice-worker/job-lifecycle.test.ts src/voice-worker/main.test.ts src/voice-worker/telemetry.test.ts src/voice-worker/session.test.ts src/voice-worker/sdk-lifecycle.integration.test.ts
npm run typecheck
```

Minimum assertions: pre-config/metadata/Mongo failure; early cleanup completes only during shutdown; entry normal return stays unresolved; session cleanup ordered before completion; thrown cleanup prevents completion; SDK concurrent callbacks cannot close Mongo early; production import does not start supervisor/load config; same boot identity persists under child counters. Existing symlink and conversation/session tests remain passing.

## Task 6: Configuration, no-call health and doctor evidence

**Files:** Create `src/deployment/ports.ts`, `src/deployment/ports.test.ts`, `src/deployment/runtime-probe.ts`, `src/deployment/health.ts`, `src/deployment/health.test.ts`. Modify `src/config.ts`, `src/voice-worker/worker-config.ts`, `src/cli/doctor.ts`, `src/cli/doctor-checks.ts` and tests.

- [ ] **Step 1:** Resolve the new listener without changing existing ports. Pure helper:

```typescript
export function voiceWorkerPort(base: unknown, override: unknown): number {
  const portBase = base === undefined ? 3100 : base;
  if (!Number.isSafeInteger(portBase) || typeof portBase !== "number") throw new Error("invalid instance.portBase");
  const port = override === undefined ? portBase + 7 : override;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid instance.ports.voiceWorker");
  }
  return port;
}
export function assertWorkerPortAvailableInConfig(workerPort: number, listeners: Record<string, number>): void {
  for (const [name, port] of Object.entries(listeners)) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ${name} port`);
    if (port === workerPort) throw new Error(`voiceWorker port collides with ${name}`);
  }
}
```

Add `voice.workerPort: voiceWorkerPort(hive.instance?.portBase, ports.voiceWorker)` in `config.ts`; add `healthPort: config.voice.workerPort` in `WorkerConfig`. When LiveKit is enabled, validate against **actual resolved** existing config ports, including legacy environment/Keychain overrides: background task, meeting/recall, code task, WebSocket, admin API, voice bridge and Slack internal. Use `{ background: config.background.port, recall: config.recall.monitorPort, codeTask: config.codeTask.port, ws: config.ws.port, adminApi: config.adminApi.port, voice: config.voice.port, slackInternal: config.slackInternal.port, beekeeper: config.beekeeper.port }` after config construction. Include any additional actual resolved listener found during source integration. Do not invent `portBase+5` as bridge truth if `VOICE_PORT` overrides it. Validate candidate config and existing service-owned sockets before any plist mutation. A foreign owner fails preflight; no kill command is permitted.

The secret-free YAML reader used for CLI identity should report configured worker port as a planning hint only. A candidate `runtime-probe config` under the intended service environment supplies authoritative resolved listeners/config compatibility. Voice-disabled flow never calls loadWorkerConfig or a vendor probe; it still identifies and quiesces an already-running stale worker using that supervisor's recorded port/config selection before removal.

- [ ] **Step 2:** Implement a packaged `runtime-probe.min.js` with explicit `config`, `bridge`, `worker`, `outbound` modes and JSON output. It uses dynamic config imports only inside selected modes, and must run with exactly the intended service's explicit HOME/PATH/HIVE_HOME/HIVE_CONFIG and captured allowed non-secret environment settings. Never spread an interactive shell's secret environment into a launchd-compatibility test. Normal service secrets come from matching dotenv/Honeypot. Request/response output is whitelist-only.

| Mode | Required behavior | Forbidden behavior |
| --- | --- | --- |
| config | resolve shared config/secret names, instance ID, database identity, actual listener ports, voice flags; report missing key **names** and sanitized compatibility | echo credentials, full Mongo URI, env dictionary, model turn, vendor request |
| bridge | use resolved bridge token internally for three POST `{}` requests; correct token must return known missing-agent 400; absent/wrong token denied with 401 or existing 403; report booleans/status/classification | print token/headers, call GET /health with bridge credentials, send messages or agent IDs |
| worker | local SDK GET `/` and `/worker`, supervisor identity/heartbeat age, ledger snapshot, current socket-owner confirmation supplied by trusted OS adapter | treat `/worker` 200 or heartbeat alone as registered/readiness |
| outbound | explicitly requested read-only LiveKit authentication and outbound trunk lookup, routing/config relationship checks, sanitized ID/existence result | createDispatch, createRoom, createSipParticipant, trunk mutation or real call |

Bridge implementation uses `fetch` with `AbortSignal.timeout(2000)`, the loopback URL already produced by `loadWorkerConfig`, `Content-Type: application/json`, `Authorization: Bearer <in-process token>`, `body: "{}"`. For wrong-token probe use a newly generated random value, not a modified real token. Require JSON `{ error: "call.metadata.hive_agent_id required" }` from the correct-token probe, matching `voice-adapter.ts:184`; an arbitrary 400 is failure. Tests inject a spawn spy at the adapter boundary and assert zero calls in all three requests. Do not log error response bodies that could contain provider data.

Outbound lookup uses `livekit-server-sdk`'s installed `SipClient` and `listSipOutboundTrunk()` as already used by `scripts/livekit-setup.ts:58`; select the configured `sipTrunkId` and compare existing configured number/trunk-domain relationships without creating or altering SIP objects. An unknown/missing trunk or auth failure fails explicit deployment acceptance. Ordinary doctor does not run this network mode. If the exact SDK cannot expose a required relationship, record a concrete read-only evidence gap; do not fabricate a match.

- [ ] **Step 3:** Implement health classification as a conjunction of independently gathered evidence. Main exported type/function:

```typescript
import type { BootIdentity, Release } from "./release.js";
export interface PackagedEvidence {
  installed: Release;
  engine: BootIdentity;
  worker: BootIdentity | null;
  voiceEnabled: boolean;
  processPathsMatch: boolean;
  configSelectorsMatch: boolean;
  freshOrderedEngineMarkers: boolean;
  engineAlive: boolean;
  workerAlive: boolean;
  heartbeatFresh: boolean;
  heartbeatMatchesSupervisor: boolean;
  sdkRootStatus: number | null;
  sdkAgentName: string | null;
  sdkSocketOwned: boolean;
  bridgeAuthenticated: boolean;
  bridgeMissingDenied: boolean;
  bridgeWrongDenied: boolean;
  dependenciesContained: boolean;
}
function sameRelease(a: Release, b: Release): boolean {
  return a.packageVersion === b.packageVersion && a.sourceRevision === b.sourceRevision &&
    a.dependencyLockSha256 === b.dependencyLockSha256 && a.sourceDirty === b.sourceDirty;
}
export function packagedHealthy(e: PackagedEvidence): boolean {
  if (!sameRelease(e.installed, e.engine.release) || !e.engineAlive || !e.processPathsMatch ||
      !e.configSelectorsMatch || !e.freshOrderedEngineMarkers || !e.dependenciesContained) return false;
  if (!e.voiceEnabled) return true;
  return e.worker !== null && sameRelease(e.installed, e.worker.release) && e.workerAlive &&
    e.heartbeatFresh && e.heartbeatMatchesSupervisor && e.sdkRootStatus === 200 &&
    e.sdkAgentName === "hive-voice" && e.sdkSocketOwned && e.bridgeAuthenticated &&
    e.bridgeMissingDenied && e.bridgeWrongDenied;
}
```

Evidence constructors additionally verify protocol/schema, boot ID equality to the expected activation, process PID/start-time match, finite timestamps no more than five seconds in the future, current supervisor heartbeat no older than 60 seconds, and record created after the captured activation boundary. A fabricated structurally valid BootIdentity is not sufficient. Engine marker scanner reads only post-bootstrap bytes, handles truncation as uncertainty/failure, requires starting-before-running for the current PID/boot, and verifies that same PID remains live at the final check. Plain heartbeat timestamp `updatedAt` cannot satisfy a packaged heartbeat.

Engine and worker receive independent bounded retries: 3 × 30-second windows, with 10 seconds between windows (maximum 110 seconds each). Start engine, await its fresh boot, start worker, await registration and paired evidence. Per-request/probe timeouts must fit within each absolute window; nested retries cannot extend the contract. A worker whose heartbeat is fresh but whose SDK root is 503 never passes.

- [ ] **Step 4:** Implement `pilotRecovered` separately with no calls to `packagedHealthy` and no new-manifest requirement. Required true booleans: captured engine/worker live identities and effective arguments match, working directory/config selectors match, executable hashes match, dependency canonical paths and locked versions match, fresh engine marker pair scoped to recovered PID, bridge correct/absent/wrong probes pass from the recovered environment, SDK root 200 and agent `hive-voice` at the captured **legacy** listener, verified socket owner, current registration after recovered startup. Return `legacy/unavailable` for manifest/release boot ID/supervisor identity fields absent in the pilot. If fresh log scoping cannot be established for the captured runtime, fail recovery verification; never accept stale lines.

The legacy probe runs from retained candidate tooling **with the captured pilot loader/config environment**, and resolves dependency/executable evidence against the captured pilot paths. For the inventoried `dist/voice-worker/main.js` pilot, dynamically import the captured, hash-verified sibling `dist/voice-worker/worker-config.js` in an isolated subprocess and use its `loadWorkerConfig()` result for the no-turn bridge probe; this preserves the actual pilot loader and dependency resolution. Capture/validate this module path before cutover. If the pilot lacks a usable captured loader, leave recovery verification blocked rather than silently substitute candidate config semantics. Do not pretend the helper's own candidate imports prove the pilot's imports. OS open-file/process evidence and preserved pilot package/lock hashes provide that comparison. Valid legacy recovery establishes usable recovery only; final acceptance always requires packagedHealthy after reapply.

- [ ] **Step 5:** Extend doctor voice output to display installed package identity separately from observed engine/worker identity. Add optional supervisor fields to `VoiceWorkerStatsRow` and preserve unavailable legacy state. Print registration/health and unresolved-maintenance classification without changing the existing doctor policy that only datastore identity failures affect the exit code. Use local probes by default; outbound is explicit via deployment acceptance. Secret values must never appear in fixture snapshots/output.

- [ ] **Step 6:** Verify:

```bash
npx vitest run src/deployment/ports.test.ts src/deployment/health.test.ts src/voice-worker/worker-config.test.ts src/voice-worker/telemetry.test.ts src/cli/doctor-checks.test.ts src/cli/doctor.test.ts src/channels/voice/voice-adapter.test.ts src/channels/voice/voice-adapter.integration.test.ts
```

Expected: all pass. Require negative cases for stale prior logs, wrong PID/start time/boot/revision, foreign listener, missing/malformed heartbeat, future timestamp, `/worker` 200 with `/` 503, unknown active-call telemetry, valid token denied, arbitrary 400, disabled voice missing keys, explicit health-port collision, legacy-only fields missing, legacy recovery falsely labeled packaged. Commit the worker/evidence slice after review and passing tests; proceed to lifecycle chunk.
