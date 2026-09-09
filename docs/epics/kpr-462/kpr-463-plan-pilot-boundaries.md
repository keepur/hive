# KPR-463 implementation plan — capture, probe ABI and operation recovery boundaries

This is chunk 5 of the [parent plan](./kpr-463-plan.md), completing the affected contracts in [chunk 4](./kpr-463-plan-pilot.md). The approved spec, complete Testing Contract, Gate 1 delegation, absent decision-register canon and authorized dodi-dev substitution `ac95b136` still apply. These are remaining S7 source steps and required S9 actual-artifact cases. This plan authorizes no protected-pilot retrofit, service action, vendor request or live call during drafting. All existing S7 remainder and S8/S9/S12 gates remain required.

**FIX9 status: BLOCKED — `JOB_ACCOUNTING_UNAVAILABLE`.** The supported macOS/Node 24 builtin-only helper has no established complete descendant observer or containment mechanism. Step 4d.1a.3a below withdraws the census-to-settlement inference and forbids job `go` under the current constraints. This blocks completion of remaining S7 and the dependent positive S8/S9/S12 path; it is separate from the approved actual-pilot `MIGRATION_PENDING` boundary. The installed-worker observation contract below is a concrete independent correction, not a claim that the blocked job path can execute.

## File map and source constraints

| File | Work in this chunk |
| --- | --- |
| `src/deployment/pilot-records.ts`, `pilot.ts`, their tests | sealed operation draft, commit boundary, private capture ticket, final proof expiry |
| `src/deployment/services.ts`, `.test.ts` | read-only initial external-plist discovery, separate plist roles, last-moment signal fence |
| `src/deployment/pilot-probe.ts`, `.test.ts` | secret-free wire decoder/projection/inventory normalization; shared by installed probes |
| `src/deployment/runtime-probe.ts`, `.test.ts` | production `pilot-abi`, `pilot-abi-v1` and private `worker-maintenance` entrypoints; each selected runtime executes its own loader/status/Mongo reads |
| `src/deployment/health.ts`, `.test.ts` | distinct correlated closed-and-same-owner validator; existing open-health behavior stays binding |
| `src/voice-worker/maintenance-ipc.ts`, `.integration.test.ts` | export existing strict reply decoder for historical-wire reuse; no protocol or gate semantics change |
| `src/deployment/operation.ts`, `bootstrap.ts`, `reconcile.ts`, `main.ts`, their tests | discriminated durable work state, preparation/process/registration fences, mode-specific recovery |
| `src/deployment/artifact.ts`, `lifecycle.ts`, `transaction.ts`, their tests | route every package-writing subprocess through mode-checked owned jobs; bind installed-worker baseline/post-close/final observations to the acquired operation |
| `src/deployment/adoption.integration.test.ts`, `lifecycle.integration.test.ts` | actual separately built historical ABI, first capture, freshness and process-death cases |

Read-only comparison at `bc0d47aaa5ae9c39366e185715cbde407837ce2f`: `ServiceController.inspect` rejects external LaunchAgent targets unless already captured; `runtime-probe.ts` exports `runRuntimeProbe`, not `loadWorkerConfig`; its old `config` output lacks routing and credential-bearing connection data; `freshAdmissionStatus` requires open admission/null owner; `reconcileInterruptedOperation` assumes lifecycle work. These are interfaces to extend in the implementation child, not capabilities supplied by an imagined historical version. The frozen helper remains builtin-only; `pilot-probe.ts` must have only builtin runtime imports, with SDK/Mongo/loader imports lazy inside installed `runtime-probe.ts`.

## Task 9 Step 4b.1a: First capture without prior registration

- [ ] **Step 1:** Add these exact-key types. `PilotSnapshot` and `FileSeal` are chunk 4's recursively decoded types. A draft is never a `PilotSnapshot`, has no selectable registry path, and contains no credentials or execution instructions. The capture operation reserves `snapshotId` in `CapturePreparation` before constructing its draft; the same UUID is the later registration ID.

```typescript
export type PilotSubject =
  | { kind: "registered"; snapshot: RecordRef }
  | { kind: "capture-draft"; operationId: string; draftSha256: Digest };
export type CaptureDraft = {
  schemaVersion: 1;
  kind: "capture-draft";
  operationId: string;
  instance: InstanceKey;
  createdAt: number;
  snapshotId: string;
  baseline: Omit<PilotSnapshot, "schemaVersion" | "kind" | "id" | "capturedAt" | "configIdentity">;
};
export type CapturePreparation = {
  phase: "discovering" | "sealed" | "validated" | "committed" | "aborted";
  snapshotId: string;
  draft: FileSeal | null;
  validation: FileSeal | null; // immutable complete sanitized profile/OS evidence
  registration: RecordRef | null;
};
```

`baseline` has exactly the remaining declared snapshot keys, including `captureOperationId`, `bootstrap`, both `ServiceSave`s and runtime/config-file/artifact seals. The configuration identity is intentionally absent until the captured loader runs. Strictly enforce matching operation/instance/bootstrap IDs throughout. Draft file is exactly `<operation>/capture/draft.json`, mode 0600 in an owned 0700 directory; its seal and expected snapshot UUID are persisted in the active capture work record before any probe. Its copies/manifests are staged under that operation, with the same registration reader path/ownership/size protections. Do not place the draft under the registry or permit its path on `--pilot-recovery`, inventory or hold selectors.

The private operation probe input has exactly `{schemaVersion:1, requestId, operationId, subject, instance, requestedAt, deadline, expectedEngine, expectedWorker, bootstrap, draftOrSnapshotSeal}`. `deadline` is at most `requestedAt + 2000` for decisive profile reads. The registered case resolves the existing registry path via `RecordRef`; the draft case resolves only the fixed operation draft path, verifies its recorded digest, active lock/current/frozen-owner PID/start identity and mode `capture-pilot`, then decodes `CaptureDraft`. Expected processes must equal the draft or verified registered-generation lineage. There is no user-supplied alternate path or arbitrary expected-result field. Input is canonical JSON, privately sealed and passed as an absolute path; stdout is bounded canonical one-line JSON. The caller rejects a wrong subject even when its contents otherwise match.

- [ ] **Step 2:** Add operation-private read-only discovery; do not loosen the public `inspect` target check. A ticket is an in-memory opaque object in a `WeakMap` containing the active acquired capture operation, its immutable ID, selected instance, owner and bootstrap reference. `pilot.ts` creates it only after verifying lock/current/frozen ownership and mode. No parser can create one. `services.ts` obtains the same lease via an injected internal validator, not a serialized `allowExternal` option. Export only the factory-backed capture reader to the orchestration module; any service mutation rejects discovery tickets.

`discoverForCapture(ticket)` algorithm:

1. Revalidate the ticket's live operation before reading each of the two instance-derived labels. Use `launchctl print gui/<uid>/<label>` and `print-disabled` plus the existing process census adapter. Require loaded/running, exact label, UID, selected home/config, allowed argv/environment, and same PID/start before/after. Reuse existing plist XML decoding and service environment validation.
2. `lstat` the exact user LaunchAgents link derived by `getServiceLaunchAgentLink`; require same UID, a symlink with a stable recorded inode/target, no foreign-writable parent. Resolve its literal target relative to the link directory. A loaded service without this owned link is `PILOT_CAPTURE_BLOCKED` in v1. No CLI-supplied external path is accepted. A target outside the instance is allowed for **this read only**, provided its canonical ancestors/file have the chunk 4 root-or-instance ownership/non-write rules, it is a regular non-symlink leaf, and its realpath is stable. Verify the effective launchctl path (when exposed) and argv/environment agree with this plist and the live process; missing required correspondence is blocked, not guessed.
3. Read/seal the effective plist via `O_NOFOLLOW` and compare pre/post fd identity. Parse only the existing allowlisted fields. Independently capture the generated instance path derived by `getServicePlistPath`, even if the LaunchAgent points elsewhere. Save both roles under distinct operation filenames. Re-read the link/target/process after tree hashing. Any replacement invalidates capture.
4. Return readonly observations and seals to the draft builder. Do not put discovery paths in `capturedPilotProfile` on a controller that offers stop/start. The ordinary controller continues rejecting arbitrary external targets. After committed snapshot selection, chunk 4's registered captured-definition controller is the separate route for recovery/cutover.

`ServiceSave.effectivePlist.source` seals the live original bytes/path/mode; `saved` seals its private backup (0600). `instancePlist.path` is always the derived instance generated path, `existed=false` requires saved/mode null, and existence requires a separately sealed backup and original mode. Even when both roles name the same file, record both roles and require matching original bytes. When they differ, no equality is inferred. `link` retains original literal symlink target and the inspection's link identity. Restoration while unloaded verifies the external source seal without writing it, restores the instance file's distinct bytes/mode or its captured absence, restores the link target, restores enablement, then starts engine/checks fresh boot before worker. On pilot rollback, the instance file may legitimately contain the candidate’s generated bytes: verify it against this rollback operation’s current candidate prior snapshot, verify the saved pilot backup, then restore and check the pilot source hash afterward. Do not require its historical source inode/hash to match before restoring it. External originals require their historical source seal both before stopping and after restoration. For coincident roles write the instance file once; for external roles the effective original must remain byte/inode/mode identical throughout. Changed external originals block before stopping current services.

- [ ] **Step 3:** Implement the first-capture transition in this exact order:

```text
acquire/freeze capture operation -> discover using private read-only ticket
-> build and seal draft plus staged backup/manifest files
-> persist work.capture.phase=sealed and draft FileSeal
-> launch registered bootstrap probe with capture-draft subject
-> validate exact challenge/draft/loader/config/bridge/SDK/OS/log evidence
-> repeat process/link/source-seal correspondence; reject instability
-> write/fsync immutable validation.json (draft digest + result + independent OS evidence)
-> persist work.capture.phase=validated and validation FileSeal
-> construct PilotSnapshot with reserved snapshotId and result.configIdentity
-> copy/reseal staged allowed files under new registry entry; adjust only private backup references
-> register payload with registration.json last; persist committed reference and result
-> finish lock, print registered payload selector
```

`PilotProbeResult.subject` echoes the draft subject during first capture and the registered subject afterward. At first capture compare config identity only to the explicit config-files/loader identity being established; it cannot compare to an uncreated snapshot's digest. The frozen caller checks all other strict profile rules in chunk 4 and records the computed digest in the immutable baseline. Later profiles require exact digest equality. Registration validation binds source draft digest, immutable validation digest and new snapshot UUID in its operation's registration intent; no output can swap drafts during commit. Reader eligibility is the committed registration plus operation association, never an in-memory success flag.

Failure before validation registers nothing. Failure after commit never rewrites a payload to mark it failed: recover registration state as specified below. An abandoned uncommitted capture is aborted and a later invocation captures afresh; a crash does not turn stale draft health into current evidence. Reading a committed record after reconciliation grants a selector only; every lifecycle use reruns current proof.

## Task 9 Step 4b.2a: Concrete historical packaged-probe ABI

- [ ] **Step 1:** Add this production ABI in S7 to the installed probe and build it in S8. Version mapping is exact, not inferred from a package version range:

| Sealed historical executable | Supported behavior |
| --- | --- |
| Probe implementing only `config`, `bridge`, `worker`, `outbound` as at `bc0d47a` | Unsupported for packaged pilot observation/inventory: `PILOT_PROBE_ABI_UNSUPPORTED`; never combine old sanitized outputs into a fake ABI response |
| Probe with `pilot-abi` handshake exactly below and `pilot-abi-v1`, same own release/lock as captured runtime | Supports `hive-pilot-probe/1`, config projection 1, maintenance protocol 1, LiveKit server SDK 2.14.1 only |
| Unknown ABI/projection/dependency version, missing packaged helper or inconsistent release | Unsupported; register no usable packaged capture and authorize no hold |
| Captured legacy `dist/voice-worker/worker-config.js` exporting its actual `loadWorkerConfig` | Separate legacy-module adapter from chunk 4; missing admission stays unavailable regardless of successful loader/bridge profile |

Invoke `execFile(capturedNode, [historicalProbePath, "pilot-abi"])` with the exact captured worker service environment and an execution deadline. Before invocation verify historical node/probe/package/tree seals and its own `readRelease`. Store its strict release/root/ABI in the snapshot’s packaged `workerLoader` variant only after the handshake matches; `expectedRelease` for future requests comes from that captured loader descriptor, even when admission is unavailable. Handshake imports no config, resolves its package relative to `import.meta.url`, and returns exactly `{schemaVersion:1, abi:"hive-pilot-probe/1", projection:1, serverSdk:"2.14.1", operations:["observe","inventory"], release:<strict Release>}`. Compare release to the captured release, not candidate release. Wrong/old/failed handshake gives the fixed unsupported code. No handshake alone proves running admission capability; chunk 4's independent worker/boot/OS corroboration is also required.

For a successful handshake, the registered bootstrap probe launches `execFile(capturedNode, [historicalProbePath, "pilot-abi-v1", inputPath])`. It supplies a private canonical request, not config/credentials. The historical subprocess reads/seals that exact request, validates its selected service environment and expected own release/loader path/hash, and imports **its own bundled** `loadWorkerConfig` and config lazily. It must not import candidate config or export its loader/credentials to the bootstrap. The bootstrap accepts only the exact response ABI and subject; the frozen caller independently checks the same envelope and OS ownership. Deadline expiry kills only this operation-owned probe child and fails without returning partial results.

```typescript
import type { BootIdentity } from "./release.js";
import type { MaintenanceReply } from "../voice-worker/maintenance-ipc.js";

export type HistoricalIdleRequest = {
  expectedAdmission: "open" | "closed";
  expectedSupervisor: BootIdentity; // current verified generation, not the snapshot's old boot after recovery
  statusRequestId: string; // fresh UUID distinct from the outer observe requestId
};
export type HistoricalTelemetry = {
  queryStartedAt: number;
  queryFinishedAt: number;
  supervisorIdentity: BootIdentity;
  supervisorUpdatedAt: number; // epoch milliseconds; raw Mongo Date never leaves the loader process
  activeCalls: number; // safe nonnegative integer, including measured nonzero values
};
export type HistoricalIdle = {
  status: { requestedAt: number; finishedAt: number; reply: MaintenanceReply };
  telemetry: HistoricalTelemetry;
};
export type HistoricalProbeRequest = {
  schemaVersion: 1;
  abi: "hive-pilot-probe/1";
  action: "observe" | "inventory";
  requestId: string;
  operationId: string;
  subject: PilotSubject;
  instance: InstanceKey;
  requestedAt: number;
  deadline: number;
  expectedRelease: Release;
  expectedProbe: FileSeal;
  sdkPort: number; // captured and independently OS-corroborated, not a candidate default
  dependencyFiles: FileSeal[]; // exact required set within verified historical closure
  idle: HistoricalIdleRequest | null; // observe only; inventory requires null
};
export type HistoricalObservation = {
  schemaVersion: 1;
  abi: "hive-pilot-probe/1";
  action: "observe";
  requestId: string;
  operationId: string;
  subject: PilotSubject;
  instance: InstanceKey;
  startedAt: number;
  finishedAt: number;
  release: Release;
  projection: 1;
  configIdentity: Digest;
  bridge: PilotProbeResult["bridge"];
  sdk: PilotProbeResult["sdk"];
  idle: HistoricalIdle | null;
  dependencyFiles: PilotProbeResult["dependencyFiles"];
};
export type InventoryItem = {
  kind: "room" | "participant" | "dispatch" | "sip-rule" | "inbound-trunk";
  id: string; // salted per-operation digest of resource ID; never participant identity/phone number
  parent: string | null;
  agentName: string | null;
};
export type HistoricalInventory = Omit<HistoricalObservation,
  "action" | "bridge" | "sdk" | "idle" | "dependencyFiles"> & {
  action: "inventory";
  items: InventoryItem[];
  counts: { rooms: number; participants: number; dispatches: number; rules: number; inboundTrunks: number };
  limitations: ["EXTERNAL_PRODUCERS_UNFENCED", "PENDING_ASSIGNMENTS_UNOBSERVABLE"];
};
```

Failure for either historical mode is exactly `{schemaVersion:1, abi:"hive-pilot-probe/1", requestId, classification}` and exit 1; classification is one of `PILOT_PROBE_ABI_UNSUPPORTED`, `PILOT_PROBE_INPUT_INVALID`, `PILOT_LOADER_UNAVAILABLE`, `PILOT_CONFIGURATION_MISMATCH`, `PILOT_BRIDGE_FAILED`, `PILOT_DEPENDENCY_MISMATCH`, `PILOT_INVENTORY_INCOMPLETE`, `PILOT_PROBE_DEADLINE`, `PILOT_ADMISSION_MISMATCH`, `PILOT_TELEMETRY_MISSING`, `PILOT_TELEMETRY_INVALID`, `PILOT_TELEMETRY_STALE`, `PILOT_TELEMETRY_WRONG_BOOT`, `PILOT_TELEMETRY_QUERY_FAILED`. Input parse failures use the all-zero UUID if the request UUID cannot be safely decoded. Suppress stdout/stderr from config imports as the existing main does; emit only canonical sanitized output. Reject unknown fields, mismatched header/subject/release, oversized output, extra lines and nonzero exit even with a plausible response.

- [ ] **Step 2:** Implement a versioned pure projection shared by legacy and historical adapters. It consumes the **captured loader's** return shape, not sanitized old `configMode` output. All required keys are strictly validated; no missing field is defaulted from the candidate. Capture listener provides the legacy health port if that old loader lacks `healthPort`; the historical ABI requires its own `healthPort` and exact port equality. Require `instanceHome` canonical equality, exact instance ID and explicit selected `HIVE_CONFIG`; require bridge URL to be loopback HTTP, correct captured port/path and without userinfo/query/fragment. Config-files seals already retain voice flags and selectors. The configuration identity projection is exactly:

```typescript
export function pilotConfigProjection(
  wc: {
    instanceHome: string; instanceId: string; mongoDbName: string;
    sipTrunkId: string; inboundAgents: Record<string, string>; agentVoices: Record<string, string>;
    defaultStt: string; defaultTts: string; bridgeUrl: string;
  },
  instance: InstanceKey,
  sdkPort: number,
): object {
  const bridge = new URL(wc.bridgeUrl);
  if (bridge.protocol !== "http:" || bridge.hostname !== "127.0.0.1" ||
      bridge.username || bridge.password || bridge.search || bridge.hash ||
      bridge.pathname !== "/v1/chat/completions") throw new Error("PILOT_CONFIGURATION_MISMATCH");
  return {
    projection: 1, instance,
    databaseName: wc.mongoDbName,
    ports: { bridge: Number(bridge.port || "80"), worker: sdkPort },
    routing: { sipTrunkId: wc.sipTrunkId, inboundAgents: wc.inboundAgents, agentVoices: wc.agentVoices },
    voice: { defaultStt: wc.defaultStt, defaultTts: wc.defaultTts },
  };
}
```

`sha256(canonical(projection))` is returned, never the routing maps themselves. Exclude credentials, Mongo URI and LiveKit URL. Hashing config/dotenv source files is separate and never copies their contents to evidence. No candidate projection of the candidate's own loaded config can authenticate this result.

Observation execution inside the historical process: check seals/environment/request -> record `startedAt` before any decisive reads -> lazy own loader -> compute projection -> `probeBridge(wc.bridgeUrl,wc.bridgeToken)` -> `probeWorkerHttp(request.sdkPort)` and, when `request.idle !== null`, the owner-correlated status/Mongo read in Step 2a -> resolve/hash required dependency files relative to the historical entrypoint and compare exact request set -> finish before deadline. Perform slow complete tree checks in the frozen caller before this window. Resolve external SDK via `createRequire(historicalEntry).resolve`, and native/model paths via the installed package walkers from the runtime diagnostic. Paths outside expected sealed roots or OS-unconfirmed required loaded files fail. Return bridge fields only if existing `authenticated/missingDenied/wrongDenied` all pass; map `correctClassification` to `missing-agent` only then. Return the actual SDK status/name/count (non-null, correctly typed), never constants substituted for observations.

Mapping to `PilotProbeResult` is mechanical: validate ABI/projection/release/operation first, copy `requestId, subject, instance, startedAt, finishedAt, configIdentity, bridge, sdk, idle, dependencyFiles`, set `classification="PILOT_OBSERVED"`; include no credential fields. The outer caller validates the result against its request and independent evidence. This wrapper mapping cannot manufacture missing historical fields.

- [ ] **Step 2a:** Implement the native idle read in `runtime-probe.ts` inside that **same historical loader process**. No `worker`-mode subprocess or candidate Mongo config participates. The frozen caller sets `idle` only after independently verifying native capability/current release/descriptor/process lineage; native capture/baseline uses `expectedAdmission="open"`, and all post-close/final reads use `"closed"` with the **owning operation ID**. Inventory requires `idle=null`; a legacy-module profile without native capability also returns `idle=null`. A native request returning null or an unsolicited non-null result fails decoding. Missing native telemetry cannot be downgraded to legacy availability. The internal outer pilot request gains this same exact `idle` field, sealed with its subject, operation and expected processes. Validate `expectedSupervisor` with `parseBootIdentity`, exact worker component/current captured release/PID/boot/startedAt and independent current process/start evidence. Reject reused status UUIDs and unknown keys. No CLI can supply telemetry or an admission expectation independently of the acquired operation.

Status uses the existing shared client, with `randomId: () => request.idle.statusRequestId`, `operationId: request.operationId`, `kind:"status"`, `supervisor` set to the expected PID/boot, and `expectedAdmission` from this strict request. Its `corroborateSupervisor` reads the selected instance's current descriptor/boot identity and actual PID/start via the existing OS adapter before returning that PID/boot; it must not return the request's expected values without observing them. Capture `status.requestedAt` immediately before calling the client and `finishedAt` on return. Run it alongside the Mongo read and SDK HTTP reads within the **same** observation's absolute deadline; reject any failed branch, never return partial idle evidence. The status request cannot close or release the gate. Export the existing `parseReply` as `parseMaintenanceReply` from the shared maintenance module and reuse it in the frozen caller’s recursive wire decoder (do not duplicate protocol parsing). The frozen caller rechecks request/operation/boot correlation and OS correspondence, including `status.requestedAt <= reply.writtenAt <= status.finishedAt`; baseline uses `freshAdmissionStatus`, post-close/final use `freshClosedAdmissionStatus`. The old `workerMode` random-operation path remains unsuitable for this interface.

Add the following complete Mongo read and normalization in `runtime-probe.ts`, shared by the historical and installed-worker entrypoints after their distinct strict request/own-loader validation. `parseBootIdentity`, `canonical` and the types are the declared shared strict helpers; Mongo is imported lazily only here. The historical caller has already passed subject validation; Step 2b's installed caller has no pilot subject. The query filters **only kind**, not expected PID/boot, so wrong-boot rows and duplicate stats documents cannot be hidden by filtering. Select only these fields, never read raw call/phone/credential data into the response.

```typescript
type OwnLoaderTelemetryRequest = Pick<HistoricalProbeRequest,
  "action" | "requestedAt" | "deadline" | "expectedRelease" | "idle">;
export async function readOwnLoaderTelemetry(
  wc: { mongoUri: string; mongoDbName: string },
  request: OwnLoaderTelemetryRequest,
): Promise<HistoricalTelemetry> {
  if (request.action !== "observe" || request.idle === null)
    throw new Error("PILOT_PROBE_INPUT_INVALID");
  const queryStartedAt = Date.now();
  const budget = request.deadline - queryStartedAt;
  if (budget <= 0 || queryStartedAt < request.requestedAt)
    throw new Error("PILOT_PROBE_DEADLINE");
  const { MongoClient } = await import("mongodb");
  const mongo = new MongoClient(wc.mongoUri, {
    serverSelectionTimeoutMS: budget, connectTimeoutMS: budget,
    socketTimeoutMS: budget, readPreference: "primary",
  });
  let rows: Record<string, unknown>[];
  try {
    await mongo.connect();
    const remaining = request.deadline - Date.now();
    if (remaining <= 0) throw new Error("PILOT_PROBE_DEADLINE");
    rows = await mongo.db(wc.mongoDbName).collection("telemetry")
      .find({ kind: "voice_worker_stats" }, {
        projection: { _id: 0, kind: 1, supervisorIdentity: 1, supervisorUpdatedAt: 1, activeCalls: 1 },
        maxTimeMS: remaining,
      }).limit(2).toArray();
  } catch {
    throw new Error(Date.now() >= request.deadline
      ? "PILOT_PROBE_DEADLINE" : "PILOT_TELEMETRY_QUERY_FAILED");
  } finally {
    await mongo.close().catch(() => {});
  }
  const queryFinishedAt = Date.now();
  if (queryFinishedAt < queryStartedAt || queryFinishedAt > request.deadline)
    throw new Error("PILOT_PROBE_DEADLINE");
  if (rows.length === 0) throw new Error("PILOT_TELEMETRY_MISSING");
  if (rows.length !== 1) throw new Error("PILOT_TELEMETRY_INVALID");
  const row = rows[0];
  if (row.kind !== "voice_worker_stats" || !Number.isSafeInteger(row.activeCalls) ||
      (row.activeCalls as number) < 0) throw new Error("PILOT_TELEMETRY_INVALID");
  let identity: BootIdentity;
  try { identity = parseBootIdentity(row.supervisorIdentity); }
  catch { throw new Error("PILOT_TELEMETRY_INVALID"); }
  if (identity.component !== "voice-worker" ||
      canonical(identity) !== canonical(request.idle.expectedSupervisor) ||
      canonical(identity.release) !== canonical(request.expectedRelease))
    throw new Error("PILOT_TELEMETRY_WRONG_BOOT");
  const updatedAt = row.supervisorUpdatedAt instanceof Date ? row.supervisorUpdatedAt.getTime()
    : typeof row.supervisorUpdatedAt === "string" ? Date.parse(row.supervisorUpdatedAt) : NaN;
  const bootStartedAt = Date.parse(identity.startedAt);
  if (!Number.isSafeInteger(updatedAt) || !Number.isFinite(bootStartedAt) || updatedAt < bootStartedAt)
    throw new Error("PILOT_TELEMETRY_INVALID");
  if (updatedAt > queryFinishedAt || queryFinishedAt - updatedAt > 60_000)
    throw new Error("PILOT_TELEMETRY_STALE");
  return { queryStartedAt, queryFinishedAt, supervisorIdentity: identity,
    supervisorUpdatedAt: updatedAt, activeCalls: row.activeCalls as number };
}
```

`BootIdentity.startedAt` is the existing ISO timestamp. Keep the existing 60,000 ms supervisor-heartbeat age bound; this native hold path accepts no future-heartbeat skew. Do not substitute job-owned `updatedAt` for `supervisorUpdatedAt`, infer freshness from a non-null document, coerce counts/booleans/strings, or use `classifyWorkerHeartbeatDocument`'s relaxed future-skew result as strict hold evidence. A valid nonzero count is returned unchanged; the adapter classifies `PILOT_TELEMETRY_ACTIVE` and cannot prove idle. The driver/parser bounds query/status timestamps within `request.requestedAt <= startedAt <= queryStartedAt <= queryFinishedAt <= finishedAt <= deadline <= requestedAt + 2000`, with the corresponding status interval, and checks every nested identity/count/date again. The request deadline is also capped by the original maintenance deadline. Connection/server-selection/query/cleanup delays cannot renew either deadline; the owned probe guardian enforces wall and local monotonic elapsed timeout for the entire descendant process, including hung driver cleanup, and never emits partial success. Neither a query error nor stale/missing/wrong-boot data can be mapped to zero.

Populate baseline/post-close/final `NativeGateReadback` from this exact returned result: `operationId/requestId/requestedAt` come from the matching outer challenge; `worker/socketOwner` from independent current OS evidence; `bootId` from the validated telemetry identity agreeing with the current descriptor and status; `admission` from `idle.status.reply.snapshot.admission`, `closedOperationId` from its `operationId`, `unresolvedAccepted` from its strictly decoded `unresolved.length`, and `persistenceFault` from its `persistenceFault`; `sdkRootStatus/sdkAgentName/sdkActiveJobs` from the current SDK response; `telemetryActiveCalls` and `telemetryUpdatedAt` from `idle.telemetry`. Include all query/status/SDK/OS intervals in the original oldest-read/monotonic bounds below. Retain this complete sanitized readback privately, never a synthesized healthy profile. Map to quiesce's `IdleEvidence` only after these checks: registered requires root 200/exact agent name plus the phase-appropriate fresh admission status and heartbeat, socket ownership requires independent OS agreement, and both counts are the actual measured values. Baseline open/null-owner is health only and cannot construct a closed proof.

Bind the historical `maintenanceQuiescenceIO.inspect` closure to the acquired operation and current generation. Start in open-baseline phase; after its close acknowledgement, set closed phase and use a new observe challenge/status UUID/query on **each** `inspect`, including final stop proof and reapply after rollback. Never reuse the pre-close query or let a new `status` call refresh it. If a baseline read fails or is nonzero, defer before close/signals. If any post-close/final read fails, terminal-release the same operation and defer without signals (or remain unresolved if release cannot be verified). A racing measured nonzero count may be polled only within the original 30-second quiescence budget; if still nonzero it must release/defer. The direct supplementary pre-stop IPC check does not replace this historical telemetry read. Activation/recovery health continues to require open/null-owner status separately.

- [ ] **Step 2b:** Add the **installed-worker** maintenance observation to remaining S7. At preserved `lifecycle.ts:220–234`, `inspectIdle` calls the old `worker` mode without operation context; that mode generates a random operation ID and the shared supervisor correctly refuses it after another operation closes admission. Replace that invocation with the fixed private `worker-maintenance` mode below. Do not weaken the supervisor's wrong-owner refusal, pass an arbitrary CLI `--operation-id`, or invent a pilot registration for an ordinary installed package.

Declare these exact-key wire types in builtin-only `pilot-probe.ts` alongside the reusable telemetry/result decoders (the name of that module does not require a pilot subject). Reuse the strict `FileSeal`, `OwnedDirectory`, `ProcessSeal`, `InstanceKey`, `Release`, `HistoricalIdle` and `HistoricalIdleRequest` definitions; no runtime loader import enters the frozen graph.

```typescript
export type WorkerMaintenanceRequest = {
  schemaVersion: 1;
  abi: "hive-worker-maintenance/1";
  action: "observe";
  requestId: string;
  operationId: string;
  jobId: string;
  instance: InstanceKey;
  phase: "baseline" | "post-close" | "final";
  requestedAt: number;
  deadline: number;
  maintenanceDeadline: number;
  runtime: {
    root: OwnedDirectory;
    node: FileSeal;
    probe: FileSeal;
    config: FileSeal;
    environmentSha256: Digest; // canonical selected service environment; no secret values
  };
  expectedRelease: Release;
  expectedWorker: ProcessSeal;
  idle: HistoricalIdleRequest;
};
export type WorkerMaintenanceObservation = {
  schemaVersion: 1;
  abi: "hive-worker-maintenance/1";
  action: "observe";
  requestId: string;
  operationId: string;
  jobId: string;
  instance: InstanceKey;
  phase: WorkerMaintenanceRequest["phase"];
  requestSha256: Digest;
  startedAt: number;
  finishedAt: number;
  release: Release;
  sdk: PilotProbeResult["sdk"];
  idle: HistoricalIdle;
};
```

The private request is exclusively written/fsynced at `<operation>/jobs/<jobId>/worker-maintenance.json` with mode 0600, selected by that `runtime-probe` job's sealed `selectedInput`. The guardian derives `runtime.root` from the lifecycle's **running installed** worker definition and selected prior release (normally canonical `<home>/.hive`), never the candidate stage, helper's own root, or a supplied arbitrary path. It validates the acquired lock/current/original-frozen-owner and job identity, legal lifecycle phase, current operation snapshot, root identity, Node/probe/config seals, service environment digest and exact probe path `<root>/pkg/runtime-probe.min.js` before launching the recorded Node with `[probe,"worker-maintenance",inputPath]`. The source path and selected input are fixed job data; no environment variable substitutes for the request. Close/status/release are still owned by the lifecycle operation, not the guardian's PID or job UUID. Historical H continues its distinct `pilot-abi-v1` request under a pilot job.

Extend `runRuntimeProbe(mode, inputPath?)` and `main`'s parser explicitly: `worker-maintenance` requires exactly one absolute private input path and no extra argv; ordinary `config/bridge/worker/outbound` forbid an input path, and historical ABI modes retain their own parser. Private-mode errors exit 1 with exactly `{schemaVersion:1,abi:"hive-worker-maintenance/1",requestId,classification}`; reuse the Step 1 observation error vocabulary including admission/telemetry/deadline failures, with `PILOT_PROBE_INPUT_INVALID` for invalid installed input and zero UUID only when the ID cannot be safely decoded. Never parse an exit-1 response as success. Unknown keys/ABI/phase, null idle, missing or repeated IDs, extra output, or response/request seal mismatch fail closed. Success stdout is one bounded canonical JSON line of the type above; imports remain output-suppressed and raw credentials never leave the process.

Before any read the actual installed process verifies its request file seal/ownership and containing job association against the active acquired operation, exact own Node/probe/root/`readRelease` and explicit service selectors. Then its own lazy `loadWorkerConfig` resolves instance/config/health port/Mongo credentials. Independently read the current runtime descriptor/BootIdentity, `ServiceController.inspect` process PID/start/argv/cwd/UID, and listener ownership, comparing all with `expectedWorker`, `idle.expectedSupervisor`, the selected running definition and `expectedRelease`. Repeat process/descriptor/listener correspondence after the reads. A caller-provided operation ID, package manifest or BootIdentity alone never corroborates a running worker. For post-close/final require the durable barrier owner to be this lifecycle operation and its supervisor to match; baseline requires no earlier close in this attempt. Reject selected-stage configuration, swapped root/probe/config, wrong boot/PID generation or changed ownership before constructing evidence.

Inside that actual process run `probeWorkerHttp(wc.healthPort)`, Step 2a's `readOwnLoaderTelemetry(wc, request)`, and shared `requestMaintenance` within the same bounded observation. Status uses `operationId=request.operationId`, `randomId:()=>request.idle.statusRequestId`, the independently corroborated supervisor and phase-derived admission. `baseline` requires `idle.expectedAdmission="open"` and fresh open/null-owner result; `post-close` and `final` require `"closed"` and fresh closed/same-owner result. Never use `expectedAdmission="any"` for these requests. The status UUID is fresh and distinct from outer request, job, close, release and every prior status UUID; the strict installed response uses `parseMaintenanceReply`. The query/status timing, exact boot/release/count/freshness rules and measured nonzero behavior are identical to Step 2a. Keep the public `worker` diagnostic/activation route separate: it accepts no private operation input and continues to require fresh **open/null-owner** health; it cannot report a closed gate as activation success.

Wire `maintenanceQuiescenceIO` with a private phase binding to its acquired `operation`. Its `inspect(deadline)` callback builds a fresh sealed request from the independently observed installed runtime for each call. Start at baseline; change to post-close only after the same operation's real close acknowledgement passes the shared client. Never infer phase from a worker JSON response. Preserve the original `quiesce` 30-second absolute deadline in this binding; each request has `deadline = min(requestedAt + 2000, maintenanceDeadline)`, with parent-local monotonic budget measured before spawning. Record the first deadline once; retries, IPC, JSON persistence and process checks cannot reset it. Map the strictly validated observation to `IdleEvidence` with actual telemetry/SDK counts and same-supervisor/owned-socket evidence, keeping its complete sanitized readback privately for freshness checks. Clear the phase only after verified terminal release or verified supervisor exit; release failures retain unresolved ownership.

For a normal restart/update/rollback and the candidate C leg of pilot rollback, run a **new** `final` installed observation after the quiescence loop and before signaling. Apply the exact Step 4c.2a original wall/monotonic/heartbeat expiry and single-use `beforeExec` stop fence to its SDK/status/Mongo/OS intervals in `lifecycle.ts`; share the pure validation/fence logic without selecting a pilot snapshot. The supplementary direct `proveBarrierBeforeStop` does not replace this read or refresh its expiry. Baseline failure defers before close. Post-close/final failure (including nonzero persisting through the original wait budget) terminal-releases this same owner and defers without bootout; failed release stays unresolved. Fresh new boot activation uses the public open-health path. This defines both the candidate rollback seam and ordinary packaged maintenance; neither depends on H's registry.

- [ ] **Step 3:** Implement inventory in that **same historical loader process**, retaining all credentials only in its local variables:

```typescript
const { RoomServiceClient, AgentDispatchClient, SipClient } = await import("livekit-server-sdk");
const rooms = new RoomServiceClient(wc.livekitUrl, wc.livekitApiKey, wc.livekitApiSecret);
const dispatch = new AgentDispatchClient(wc.livekitUrl, wc.livekitApiKey, wc.livekitApiSecret);
const sip = new SipClient(wc.livekitUrl, wc.livekitApiKey, wc.livekitApiSecret);
const roomRows = await rooms.listRooms();
for (const room of roomRows) {
  const participants = await rooms.listParticipants(room.name);
  const dispatches = await dispatch.listDispatch(room.name);
  // Immediately normalize the IDs/agent names below; do not persist raw rows.
  collectRoom(room, participants, dispatches);
}
const rules = await allSipPages(page => sip.listSipDispatchRule({ page }), r => r.sipDispatchRuleId);
const trunks = await allSipPages(page => sip.listSipInboundTrunk({ page }), r => r.sipTrunkId);
```

Implement the bounded traversal directly (the outer process deadline also cancels a stalled RPC):

```typescript
export async function allSipPages<T>(
  read: (page: { limit: number; afterId: string }) => Promise<T[]>,
  idOf: (row: T) => string,
): Promise<T[]> {
  const seen = new Set<string>();
  const result: T[] = [];
  let afterId = "";
  for (let page = 0; page < 100; page++) {
    const rows = await read({ limit: 100, afterId });
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("PILOT_INVENTORY_INCOMPLETE");
    for (const row of rows) {
      const id = idOf(row);
      if (typeof id !== "string" || !id || id.length > 4096 || /[\0\r\n]/.test(id) || seen.has(id))
        throw new Error("PILOT_INVENTORY_INCOMPLETE");
      seen.add(id); result.push(row);
    }
    if (rows.length < 100) return result;
    const next = idOf(rows[rows.length - 1]);
    if (next === afterId) throw new Error("PILOT_INVENTORY_INCOMPLETE");
    afterId = next;
  }
  throw new Error("PILOT_INVENTORY_INCOMPLETE");
}
```

For SDK 2.14.1, `Pagination` has `{limit, afterId}`. `allSipPages` starts `{limit:100, afterId:""}`, appends each returned page, rejects invalid/duplicate IDs and any non-progressing cursor, then uses the last ID as `afterId`; a page shorter than 100 ends traversal. Cap at 100 pages/10,000 items and fail if reached without a terminal page. Do not issue ID/trunk/number filters. `listRooms`, `listParticipants` and `listDispatch` return complete arrays in this pinned interface; cap normalized aggregate at 10,000 and fail on overflow. Set an overall 30-second inventory deadline; race pending network calls against it and exit the owned subprocess on expiry. Denied/partial/page-limit/error responses fail with `PILOT_INVENTORY_INCOMPLETE`. Config projection is computed from this loader again and must match the selected snapshot. No returned credential-bearing metadata is inspected as executable policy.

`collectRoom` and SIP normalization are exact: row identifiers use `sha256(operationId + "\\0" + resourceKind + "\\0" + rawId)`; room raw ID is `room.sid`, participant `sid`, dispatch `id`, rule `sipDispatchRuleId`, trunk `sipTrunkId`. Validate IDs are nonempty bounded strings. `parent` for participants/dispatches is the room's digest; others null. Only dispatch `agentName` and SIP `roomConfig.agents[].agentName` are extracted after bounded-string validation; multi-agent SIP rules emit one item per distinct agent with same rule ID plus a null agent item when no agent exists; count rules by distinct rule ID. Participant identity/name/metadata, SIP numbers, tokens and raw URLs never leave memory. Room/participant/trunk agentName is null. Deterministically sort items by kind/id/parent/agentName before hashing.

The outer `pilot-inventory` maps room/participant/dispatch items to `room-and-token-dispatch`, SIP rule/trunk items to `sip-dispatch-rules`, all `scope="unknown"` unless already corroborated by captured target configuration, `accounting="observations-only"`, `checks=[livekit-inventory check UUID]`, locator containing only kind/digested ID and safe agent name. Assign a fresh source UUID per item; exact IDs/digest/counts remain in the sealed private operation result. Retain both mandatory limitations and chunk 4's other inventory gaps. Empty API results still yield an observations-only category row. Inventory never proves accepted-but-unassigned absence or a fence on external credential holders. Native positive proof uses the independently verified gate/ledger, never upgrades these observations into global completeness.

## Task 9 Step 4c.2a: Closed-owner validation and absolute freshness

- [ ] **Step 1:** Keep `freshAdmissionStatus` as the open/null-owner health check. Add a separately named validator to `health.ts`; the closed adapter sends a fresh `status` request with the maintenance operation ID and `expectedAdmission:"closed"`, using `requestMaintenance` correlation/supervisor validation. This must not be a fresh status with a new unrelated operation ID.

```typescript
export function freshClosedAdmissionStatus(c: AdmissionReplyContext): boolean {
  const r = c.reply;
  const now = c.now ?? Date.now();
  return r !== null && r.protocol === 1 && r.ok &&
    r.requestId === c.requestId && r.operationId === c.operationId &&
    r.writtenAt >= c.requestedAt && r.writtenAt <= now && now - c.requestedAt <= 2000 &&
    r.supervisor.pid === c.expectedSupervisor.pid && r.supervisor.bootId === c.expectedSupervisor.bootId &&
    r.snapshot.supervisor.pid === c.expectedSupervisor.pid &&
    r.snapshot.supervisor.bootId === c.expectedSupervisor.bootId && c.processCorroborated &&
    r.snapshot.admission === "closed" && r.snapshot.operationId === c.operationId &&
    r.snapshot.persistenceFault === false;
}
```

The hold adapter also requires an empty strict ledger, zero SDK active jobs and zero current telemetry calls from Step 4b.2a’s own-loader `idle` response, with fresh matching supervisor heartbeat at consumption. An open health status may never pass this validator and a closed-owner status may never pass activation health. `proveBarrierBeforeStop` remains a supplementary correlated IPC check; it cannot refresh the other observations.

- [ ] **Step 2:** Assemble `NativeGateReadback.observedAt` as the minimum **request start** of IPC, SDK root/worker, current telemetry query and independent process/socket reads. `completedAt` is their maximum completion. Record equivalent monotonic starts/completions with `performance.now()` in the owning frozen process; subprocess wall timestamps must fit its measured interval, but cannot extend it. Retain the original wall and monotonic expiries in the private WeakMap; chunk 4’s core code includes both. The wall expiry is also bounded by `telemetryUpdatedAt + 60_000`, and the paired proof-time clock sample caps the monotonic expiry by that heartbeat’s remaining lifetime; heartbeat freshness cannot expire between proof construction and dispatch. Also track the last local wall/monotonic clock sample during collection, persistence and dispatch; either clock decreasing fails the attempt, even if still later than the oldest observation. No durable or subprocess output can reconstruct a proof.

All tree/inventory work precedes this interval. At the final actual bootout `beforeExec` callback (after the existing controller's awaited inspection and `markIrreversible`), compare both clocks to their original expiry, consume once, then invoke OS `execFile` synchronously. If the OS adapter uses a queue, perform the check at dispatch out of that queue. Do not consume at entry to an async bootout method. An expiration before signal causes complete fresh observation or verified release/defer within the original maintenance deadline. An elapsed/future/clock-reversal error is fail-closed; persistence of `signalsBegun` is conservative crash metadata, not permission to ignore expiry. Extend `BootoutOptions` with synchronous `beforeExec():void`, called after `markIrreversible` and immediately before OS dispatch. Within the current live invocation, retain `signalIssued=false` until that dispatch; catch the specific expiry-before-dispatch result in `withVerifiedPilotStop`, before the generic transaction recovery catch. It runs the complete fresh-read retry or terminal-release/deferred cleanup path and returns a typed deferred outcome, never a successful stop. The durable signals fence stays conservative until that verified deferred outcome is recorded. On process death this in-memory distinction is lost and existing checked recovery remains required; never deserialize `signalIssued=false` to bypass it.

Required composed tests: observe at 1000, construct at 2999, attempt signal at 4998 -> reject; observe at 1000, construct at 1001, begin persisting signals at 1002, persistence returns at 3001 -> reject; observe at 1000, construct at 1500, finish persistence at 1900, IPC check at 2999, signal at 3001 -> reject; at exactly 3000 with both clocks within the same original budget -> allow once. Delay a service inspection after callback entry to prove the actual `beforeExec` placement catches it. Wall reversal paired with monotonic progress rejects. Verify no signal count increment and correct terminal release on deferral; test the complete helper sequence, not only `proveNativeHold` and `consumeHold` separately.

## Task 8 Step 1a.3 / Task 9 Step 4d.1a: Non-lifecycle durable state and reconciliation

- [ ] **Step 1:** Make operation work a strict discriminated union. New operations use schema version 2; preserve a read-only schema-1 decoder for old lifecycle records only when all reconstruction fields actually exist. Old incomplete schema-1 operations stay unresolved with named missing fields. No bootstrap/registry work is converted into a fictional stopped lifecycle prior.

Keep the existing common operation fields (`id`, canonical instance/config/UID, startedAt, tool path/hash, recorded Node/npm, original parent/frozen-child identities, phase, retainedPaths) and add the strict `jobs` array below, and move lifecycle-only prior/profile/artifact/barrier fields into `work.kind="lifecycle"`. Require `signalsBegun=false` for both non-lifecycle branches; they cannot stop/start services. Exact work fields:

```typescript
export type ArtifactJobKind =
  | "bootstrap-extract" | "bootstrap-install"
  | "lifecycle-fetch" | "lifecycle-extract" | "lifecycle-install";
export type TrackedJob = {
  id: string;
  kind: ArtifactJobKind | "offline-diagnostic" | "runtime-probe" | "pilot-probe";
  state: "launch-intended" | "ready" | "running" | "exited";
  input: FileSeal;
  readyReceipt: FileSeal | null;
  terminalReceipt: FileSeal | null;
  guardian: { pid: number; startTime: string; processGroup: number } | null;
  launch: FileSeal; // fixed-mode resolved input, target identity, tools and sanitized environment
  lineage: FileSeal | null; // immutable observations only; never proof of complete descendants
};
export type OwnedDirectory = { path: string; identity: { dev: number; ino: number; uid: number } };
export type CreationFence = {
  path: string;
  parent: OwnedDirectory;
  state: "intended" | "observed" | "remove-intended" | "removed";
  identity: OwnedDirectory["identity"] | null;
};
export type RegistrationFence = {
  id: string;
  kind: Registration["kind"];
  directory: CreationFence;
  state: "reserved" | "payload-written" | "commit-intended" | "committed" | "aborted";
  payload: FileSeal | null;
  validation: FileSeal | null;
  commit: FileSeal | null;
  reference: RecordRef | null;
};
export type BootstrapWork = {
  kind: "bootstrap";
  signalsBegun: false;
  phase: "prepared" | "creating" | "extracting" | "installing" | "validating" | "registering" | "finished";
  hostPreparation: FileSeal;
  adoption: null | {
    state: "intended" | "observed" | "remove-intended" | "removed";
    originalSidecar: FileSeal;
    sourceDirectory: OwnedDirectory;
    expectedAdoptedDigest: Digest;
    adoptedCopy: FileSeal | null;
  };
  archiveInput: FileSeal;
  reviewedSha256: Digest;
  reviewedRevision: string;
  creations: CreationFence[];
  copiedArchive: FileSeal | null;
  packageTree: TreeSeal | null;
  extractionJobId: string | null;
  install: {
    state: "not-started" | "launch-intended" | "ready" | "running" | "exited";
    jobId: string | null;
    readyReceipt: FileSeal | null;
    terminalReceipt: FileSeal | null;
    guardian: { pid: number; startTime: string; processGroup: number } | null;
    exitCode: number | null;
  };
  registration: RegistrationFence | null;
  outcome: "validated" | "aborted" | null;
};
export type RegistryWork = {
  kind: "registry";
  signalsBegun: false;
  command: "capture-pilot" | "inventory-pilot" | "prepare-legacy-hold" | "verify-legacy-hold" | "release-legacy-hold";
  phase: "reading" | "probing" | "closing" | "registering" | "releasing" | "finished";
  selectedSnapshot: RecordRef | null;
  selectedHold: RecordRef | null;
  bootstrap: RecordRef;
  capture: CapturePreparation | null;
  creations: CreationFence[];
  registrations: RegistrationFence[];
  result: FileSeal | null;
  barrier: null | {
    operationId: string;
    supervisor: ProcessSeal;
    bootId: string;
    descriptor: FileSeal;
    state: "close-intended" | "closed" | "release-intended" | "released" | "supervisor-exited";
    terminalEvidence: FileSeal | null;
  };
  outcome: "record-committed" | "assessment-complete" | "migration-pending" | "aborted" | null;
};
```

Every nullable value is present and initially null; decode exact fields and legal phase transitions. Common resolution is a separate discriminated union: lifecycle `healthy/deferred/recovered`, bootstrap `validated/aborted`, registry the outcomes above; null means unfinished, `unresolved` is a retained error state rather than a successful resolution. Work kind/mode mismatch, non-lifecycle artifact moves or `signalsBegun=true` are invalid. `phase` on the common record mirrors only lock ownership (`active/reconciling/resolved/unresolved`); lifecycle phase remains inside its branch. In chunk 4’s older field notation, `record.mode` stays common, while `priorProfile`, `priorSnapshotPath`, `signalsBegun`, barrier and artifact fields refer to `record.work` after narrowing lifecycle; non-lifecycle branches encode `signalsBegun:false` as a required literal. Chunk 4’s lifecycle resolution labels likewise refer only to that branch. Update **all** producers/consumers including CLI, `AcquiredOperation`, transaction and reconciler together in remaining S7. A registry result is sealed operation data, not an extra imported record kind or proof authority.

- [ ] **Step 2:** Apply creation and commit fences to bootstrap, capture and registry writes. Before exclusive `mkdir`, persist intended path, same-parent identity and observed absence. Fsync parent after creation, then persist observed directory identity. If killed after mkdir but before identity persistence, it is ambiguous: retain the object and lock as `DIRECTORY_CREATION_UNRESOLVED`; do not infer ownership from its UUID/name. A crash before mkdir with absent path can abort cleanly. Observed own directories can be disposed by identity only, rejecting changed/symlinked/foreign targets. Journal disposal with `CreationFence.state="remove-intended"` and its already observed identity before removal, then `removed` only after verified absence/parent fsync. Reuse existing `disposeOwnedDirectory` identity and no-follow algorithm through a work-specific persistence callback; do not overwrite a lifecycle artifact fence. Interrupted remove-intended may finish only against that same identity or verified absence.

Bootstrap path order: journal/create digest root -> journal/copy/fsync archive -> journal/create package extraction directory -> `bootstrap-extract` launch/ready/go fence -> verify archive/extract strict members -> persist extraction terminal/complete -> `bootstrap-install` fence -> diagnostic/release/tree verification -> `RegistrationFence`. Persist phase before and after each effect; capture frozen helper before any possible disposal of its source. Never overwrite an existing digest directory. A selected complete prior bootstrap requires its registered archive/release/tree seals and fresh offline diagnostic; an incomplete existing directory routes to its recorded operation or stays unresolved.

Registration order: persist `reserved` plus UUID/directory creation fence; create payload/files exclusively; validate/seal immutable payload and operation validation; persist `payload-written`; persist `commit-intended` with exact expected canonical `Registration` fields and payload digest; write `registration.json` exclusively and fsync its directory; seal it; persist `committed` plus ref; persist mode result before printing. Add expected registration bytes/digest to the intent's sealed validation file so a crash before recording the commit seal can compare actual bytes to already durable intended bytes. No manifest points at an incomplete payload. Payload/registration mismatch never resolves by rewriting. All registered selectors still require commit and strict associations.

`reconcileRegistration` returns exactly one of: `absent` (no directory, intended only), `incomplete` (owned directory without commit; retain diagnostic evidence and mark aborted), `committed` (strict commit/payload/files match durable intent; seal existing commit and attach ref idempotently), `unresolved` (unexpected identities/contents/ambiguous creation). It never creates a missing commit during crash recovery. A commit-intended write present with valid bytes but unknown fsync outcome is revalidated and fsynced before recording committed; absent commit is incomplete. A valid committed capture remains a historical baseline; no fresh health is claimed during offline registration completion.

- [ ] **Step 3:** Track **every artifact-writing subprocess**, including extraction, fetch and lifecycle/reapply installation, through the owned-job fence. Add internal frozen-helper `--operation-job=<operation-path>/jobs/<job-uuid>/input.json` entry, legal only for a job in the recorded operation's strict `jobs` array, no user lifecycle flags. Its exact-key input is `{schemaVersion:1, operationId, jobId, kind, selectedInput:<FileSeal|null>}`. It matches `TrackedJob.kind/input/launch` and the narrowed work's active phase; no command/argv/path override is accepted. Decode the sealed launch record below and compare it to the derived active work before execution. The guardian is the same hash-verified builtin-only frozen helper; it never needs the candidate's dependencies to enforce liveness.

```typescript
export type ArtifactJobLaunch = {
  schemaVersion: 1;
  operationId: string;
  jobId: string;
  kind: ArtifactJobKind;
  target: OwnedDirectory;
  archive: FileSeal | null;
  selector: string | null;
  requireClean: boolean;
  node: FileSeal;
  npmCli: FileSeal;
  tar: FileSeal;
  environment: { HOME: string; PATH: string; TMPDIR: string; npm_config_cache: string };
};
export type JobProcess = {
  pid: number; startTime: string; uid: number; parentPid: number;
  processGroup: number; executable: string;
};
export type JobLineage = {
  schemaVersion: 1; operationId: string; jobId: string;
  guardian: JobProcess;
  sequence: number;
  previous: FileSeal | null;
  observedAt: number;
  members: JobProcess[]; // live observed descendants, retaining identity after reparenting
  exited: { pid: number; startTime: string }[]; // previously observed generations now independently absent
  accounting: "observational" | "unresolved";
};
```

All artifact launch keys are mandatory, nullable values only where declared. Capture absolute recorded Node/npm CLI and `/usr/bin/tar` seals before launching; never resolve a different PATH command on recovery. Environment has only the declared host selectors and operation-owned temp/cache paths; no operator config/keys, NODE_OPTIONS or NODE_PATH. Journal temp/cache/downloads directories before use, include them in the job's write targets and retain them while any writer is live/unknown. `selector` is only the existing normalized package tag/version (null except fetch); `archive` is the already reviewed/resolved retained archive (null only for fetch); `requireClean` is derived from the active mode and cannot be supplied by a job selector. Diagnostic/probe jobs retain their fixed separately sealed inputs/environment; they do not decode this artifact-only launch schema. Guardian alone writes immutable, exclusive, fsynced `jobs/<jobId>/lineage/<zero-padded-sequence>.json` receipts, starting sequence 0/previous null after ready and before go, then incrementing by one with the preceding file seal. Parent anchors the first receipt in `TrackedJob.lineage` before go. Reconciler reads only this fixed owned directory, verifies the contiguous seal chain/operation/job/guardian identity and rejects gaps, replacement or forks; it can validate later receipts even when the parent died before recording their seals. Cap the chain at 100,000 receipts; exhaustion is unresolved, never truncated. Live and exited sets account for every **observed** generation without reassignment on PID reuse; even a complete, unbroken receipt chain says nothing about an unobserved birth. It cannot support a settled terminal receipt.

- [ ] **Step 3a — feasibility blocker before any go:** `ServiceController.children` at preserved `services.ts:572–589` reads a point-in-time `ps`/PPID census. A descendant can create a new session/group with ignored stdio and its intermediate parent can exit between two successful observations. The guardian can remain healthy throughout and never learn that generation. Receipt hashing, more frequent polling, a clean exit code, inherited pipes, or the direct parent's `detached:false` cannot close this gap. Node 24 documents both detached session creation and children surviving their parents. [Node 24 child processes](https://nodejs.org/docs/latest-v24.x/api/child_process.html#optionsdetached).

The complete-accounting prerequisite is **not established on the supported host under this plan's frozen-helper/Node-24-builtin-only constraints**. There is no selected process-birth/exit provider in S3 or the fixed host prerequisites. Node's documented child events concern the directly spawned process; they do not supply a recursively inherited process birth stream. macOS's documented `kqueue` process filters are native APIs, with event aggregation; their existence does not establish recursive, loss-detectable process accounting accessible to this JS helper. [Apple kqueue manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html). Endpoint Security is a different native integration requiring an Apple-granted entitlement and explicit dropped-event handling; neither is part of this artifact/host contract. [Apple entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.endpoint-security.client), [Apple sequence loss detection](https://developer.apple.com/documentation/endpointsecurity/es_message_t/seq_num). These facts support a plan feasibility blocker, not a claim that all possible macOS designs are impossible. Do not claim FreeBSD `NOTE_TRACK` semantics for macOS, silently add a native addon/daemon, compiler/FFI/interpreter prerequisite, entitlement, elevated permissions or container, or assume a launchd process group prevents session escape. Disabling required npm native install scripts also changes the approved artifact contract.

Under the current constraints the production pre-go check is an explicit refusal, with no success branch or test-supplied `complete=true`:

```typescript
export function requireCompleteJobAccounting(): never {
  throw new Error("JOB_ACCOUNTING_UNAVAILABLE");
}
```

Call this in the parent before recording `running`/sending go, and in the guardian immediately before invoking any fixed handler as defense against a stale/malformed go. Apply it to every job in the table; no route has an independently established transitive spawn restriction. An unstarted job may use only the existing verified no-execution abort path after the original parents/guardian are absent; it cannot create a success/settled receipt. A fresh refusal may journal and dispose already observed owned empty preparations only under that no-execution proof and existing fences. Any job that may already have received go, including a prior-format census-only `settled` receipt, remains busy while a known writer lives and `JOB_ACCOUNTING_UNAVAILABLE`/unresolved after recorded processes disappear. Preserve its stage/downloads/cache, relevant prior slots and lock; neither receipt-chain validity nor later empty census permits cleanup, rotation, successful finalization or a new requested operation. A guardian can record sanitized failure/observations and exit, but never certify the unseen descendants absent.

This refusal is a safety correction, **not delivery of the required installer/recovery behavior**. All positive tar/npm/probe execution and settlement procedures below remain required acceptance contracts but are blocked here. Before the plan can return `DRAFT_READY`, the driver must obtain a reviewed concrete feasible mechanism within the constraints, or route an explicit helper/host-contract change through the spec lane. That mechanism must establish coverage atomically before go, include every descendant across exec/group/session changes and reparenting, bind generations and observer lifetime to this job, and reject registration races, observer death, event loss/overflow or sequence ambiguity without later census repair. It must survive original orchestrator death and prove both handler completion and zero remaining writers before settlement. Its production integration, receipt schema, privilege/artifact/bootstrap prerequisites and actual-helper tests must be specified and reviewed; this revision does not supply or authorize them. S7 completion and S8/S9 positive gates cannot be claimed by retaining the refusal forever. The approved actual uninstrumented pilot's independent `MIGRATION_PENDING` branch remains unchanged.

| Job kind | Only legal work/mode/phase and target | Exact handler after go |
| --- | --- | --- |
| `bootstrap-extract` | bootstrap `extracting`, observed empty `package` directory under this digest root; `extractionJobId` matches | verify archive seal; `/usr/bin/tar -tzf` and `-tvzf`, strict existing member validation, then `/usr/bin/tar -xzf <archive> --strip-components=1 -C <target>`; recheck directory/archive and `readRelease(target,true)` |
| `bootstrap-install` | bootstrap `installing`, same extracted target, successful extraction job/verified release; `install.jobId` matches | recorded Node `[recordedNpmCli,"ci","--omit=dev","--no-audit","--no-fund","--no-progress"]` at target cwd |
| `lifecycle-fetch` | lifecycle `update`/`check`, staging with registry selector and absent owned downloads contents | recorded Node `[recordedNpmCli,"pack","@keepur/hive@" + selector,"--json","--pack-destination",target.path]`, target cwd; existing one-file JSON/containment/archive validation; no BUILD_DIR fallback |
| `lifecycle-extract` | lifecycle `update`/`check`, staging, observed owned empty `.hive.next`; includes pilot migration and reapply, which remain update operations | same fixed tar list/validate/extract sequence; `readRelease` uses the mode-derived clean-provenance requirement |
| `lifecycle-install` | lifecycle `update`/`check`, staging, same `.hive.next`, successful extraction/verified release | same fixed Node/npm `ci` invocation, stage cwd; works identically for ordinary update, first migration and reapply |
| `offline-diagnostic` | bootstrap `validating`/committed offline revalidation or lifecycle validated selected stage/prior/current root | recorded Node `[derivedDiagnostic,"offline"]`, fixed offline environment |
| `runtime-probe` | lifecycle preflight/health or baseline/post-close/final maintenance observation with its recorded selected runtime | recorded Node and derived probe; fixed `config`, `bridge`, `worker`, `outbound`, or the installed observation Step 2b's private `worker-maintenance` plus its sealed input; only maintenance uses the running installed root and acquired owner, with no pilot subject |
| `pilot-probe` | registry capture/inventory/prepare/verify/release or lifecycle verified pilot profile/hold phase | recorded bootstrap probe and sealed subject request; historical probe/legacy loader children stay in this same tracked job and retain the same operation owner |

No registry job can fetch/extract/install. Bootstrap cannot use lifecycle variants. Restart/start/stop/rollback cannot invoke a staging writer; rollback's offline/profile reads use their own allowed jobs. Require `signalsBegun=false` for every artifact-writing launch. Add exact lifecycle staging state `{fetchJobId:string|null, extractionJobId:string|null, installJobId:string|null}` alongside existing lifecycle artifact fields; each ID resolves uniquely to its legal typed job, while bootstrap keeps its own extraction/install references. The `jobs` array is authoritative for all descendant cleanup; work-local states must agree with it and cannot override missing job evidence. Wire the code routes explicitly:

1. `artifact.ts` public `resolveArtifact`, `extractAndValidateArtifact`, and `installAndPreflightStage` require an acquired-operation-backed job runner for production effects. Their callers in `lifecycle.ts` (including reapply), `bootstrap.ts` and reconciliation supply it after narrowing work. Local archive hashing/copying stays an in-process journaled action. The shared `resolveArtifact` registry branch uses `lifecycle-fetch`; all tar listing/extraction and npm installation calls execute **inside** their table handler. Split private `extractInJob`, `installInJob`, `fetchInJob` primitives from the public orchestration functions so the handler does not recursively launch another job. Their existing validation and exact commands remain binding. There is no optional production fallback to `nodeArtifactIO.execFile` for a writer.
2. `installAndPreflightStage` awaits `lifecycle-install` (or the bootstrap install handler's fixed caller) and verified terminal/descendant absence, then separately tracked offline/config jobs. Lifecycle never calls the bootstrap-only handler. Route `lifecycle.ts` direct diagnostic/runtime-probe invocations through their jobs as well; an inherited guardian group does not contain nested SDK/model processes, so these jobs share Step 3a's unresolved prerequisite. A caller performing setup population under its existing separate installer contract cannot use these operation APIs without acquiring their required work/ownership; keep source-only filesystem validation primitives available separately, without exposing an untracked artifact command escape hatch.
3. Before spawn, the parent creates/fsyncs sealed input/launch under the owned job directory, persists its UUID and `launch-intended` in `jobs` **and** the work's reference, then spawns the frozen guardian in a new process group. Guardian reads/corroborates its fixed operation/input/tool, writes an exclusive fsynced ready receipt with operation/job UUID, own PID/start/group and frozen hash, and waits for the exact private `go`. Parent OS-corroborates ready and persists guardian identity/`ready`, then calls Step 3a’s `requireCompleteJobAccounting()` **before** `running` intent or go; the current implementation must refuse there. Only a future reviewed resolution can permit the remaining running/go transition. No tar/npm/diagnostic/probe executes before that identity is durable. A live unready guardian is busy; conflicting/missing receipt or ambiguous census is unresolved. A ready guardian whose parent dies before go records aborted and exits without invoking any handler. If the durable job never reached `running`, no go could have been sent: reconciliation may record a no-execution abort without a handler terminal receipt only after original parents and every recorded/fixed-job-path guardian are independently absent. An ambiguous job-path census stays unresolved. If `running` was durable, a settled guardian receipt is required even if the parent may have died before actually sending go.
4. No go is legal until Step 3a is resolved in a reviewed revision. For a job that may already have executed, preserve generation-census observations before/after direct-child transitions as diagnostics, reap only owned direct children, and report busy while a known writer lives. The observed group and observed-descendant set can both become empty while an unseen detached writer survives; **even a still-live guardian** must therefore remain unable to settle from census alone. Lost observation, inaccessible identity or ambiguous spawn/exit remains unresolved and cannot be repaired by timeout. A future complete observer must prove its own coverage separately from this observational chain.
5. A terminal success/settlement receipt cannot be produced with the current schema-1 observational lineage. The prerequisite is complete accounting from before go through handler completion and independent absence of all covered writers, guardian and original parents; Step 3a deliberately leaves that mechanism blocked instead of inventing receipt fields that claim it exists. Tar/pack budgets remain 120 seconds; npm ci's budget remains 600 seconds. Timeout or group termination cannot account for escaped descendants and cannot permit cleanup. Reconciliation never kills a writer to enable cleanup. All later references to settled jobs/receipts require the future reviewed complete mechanism; they cannot accept the removed census-only `settled` value.

These are disposal prerequisites for **every mode**, checked before artifact rotation, directory disposal or lock finalization. Neither `node_modules`, extracted files, a dead parent, directory identity nor npm's direct exit grants permission while a guardian/descendant can still write. Recovery returns busy for a known live member and unresolved for missing/incomplete/ambiguous accounting; no new requested operation starts. Only once Step 3a's future reviewed complete settlement and absence proof exists may reconciliation abort staging using the mode's existing creation/rotation fences. Bootstrap abort then deletes only its observed owned incomplete package/archive/digest/temp/cache trees. Lifecycle abort then removes only its owned `.hive.next`/downloads/temp/cache through lifecycle fences and leaves the prior live pair/slots intact; it never enters bootstrap cleanup or signals services because staging failed. A failed extraction/install is never resumed in place; later fresh work reruns it from the retained reviewed input. Terminal job success is not a committed bootstrap or healthy lifecycle result.

With a committed bootstrap registration, revalidate release/tree/archive/helper seals and rerun its offline native diagnostic through a fresh tracked job before recording validated; never install over committed tooling. Failure remains unresolved with paths preserved and does not overwrite the immutable registration. No service/config/vendor adapter is constructed for bootstrap reconciliation, including when HOME has no running services. Pre-operation host extraction remains the separate builtin host guard in Step 5: incomplete/orphan preparation is never automatically adopted/disposed. Its normal synchronous tar must have returned successfully before `validated` is durable; any interrupted host run retains its receipt/tree even after a reparented tar exits. This permanent pre-operation retention rule grants no cleanup authority from host-parent death and does not substitute for tracking the later **operation-owned** bootstrap extraction.

- [ ] **Step 4:** Dispatch reconciliation by work kind **before** reading `priorSnapshotPath`, services, artifact slots or a maintenance descriptor. Common strict lock/owner/original-helper/serialized takeover and complete job-liveness checks from chunk 4 and Step 3 apply to every kind, including lifecycle before any rollback/disposal. The concrete terminal matrix is:

| Work/current durable state | Required recovery and final outcome |
| --- | --- |
| Bootstrap before commit, all jobs settled and owned process generations absent | Reconcile creation/disposal fences, abort owned incomplete install, retain diagnostic registry drafts and reviewed input, persist bootstrap `aborted`; no service calls |
| Bootstrap commit present, result write absent | Reconcile registration from intended bytes, offline revalidate matching installed package/native markers, attach existing ref, persist `validated`; never install over it |
| Capture/inventory/verify before commit and no admission mutation | Reconcile private writes only, keep incomplete diagnostics nonselectable, mark `aborted`; never reuse abandoned probe output as current health or restart services |
| Capture committed, operation reference/result absent | Validate original sealed capture validation and registration intent/payload; attach ref, persist `record-committed`; no live health claim and no service inspection needed |
| Inventory/verify sealed result but unfinished operation | Validate result seal/subject/challenge as historical assessment only, persist `assessment-complete` or `migration-pending` from its fixed code; no hold proof retained |
| Prepare/any registry command with close-intended/closed/release-intended | After common job-liveness fencing, first settle its recorded barrier as below, even if close ack or hold registration was lost; then reconcile registration/results, persist `assessment-complete` or `aborted` |
| Release command interrupted | Retry recorded same-operation terminal release/verify prior terminal evidence; never select a new owner, then persist assessment result |
| Already durable mode outcome | Revalidate that mode’s final immutable inventory and any required release evidence, complete exact pending own cleanup and lock archival; do not execute a newly requested operation |
| Lifecycle | Existing chunk 4 prior-profile/slot/ordered recovery table; never sent through bootstrap/registry cleanup |

Barrier acquisition is recorded as `close-intended` **before** sending close. Terminal release intent is recorded before sending release; late close cannot evade finalization. Use the recorded exact worker/boot/descriptor and `requestMaintenance` with that barrier operationId; persist the terminal ack before `released`. A fresh open status alone is insufficient. If the recorded supervisor/tree exited, record exit only after current OS absence and corroborating same-runtime current boot's open/no-owner status when a replacement exists; absent/new ambiguous supervisor or foreign owner stays unresolved. Registry release may inspect the one recorded worker/protocol boundary for this purpose, but does not require a full engine/worker prior lifecycle profile and never stops or restores either service. Verify/inventory commands cannot introduce a barrier; unexpected barrier fields in those modes fail decoding. Release of another still-live operation returns busy via the shared lock. Stale owning operations are reconciled first, then the requested release invocation exits nonzero as specified below.

Only after mode final inventory and owned-child absence are durably checked may `finishOperationLock` archive/clear that lock. Successful next-invocation reconciliation prints `PREVIOUS_OPERATION_RECONCILED` with the exact mode outcome and exits 1 without starting the newly requested action. For bootstrap it may also print the existing registered selector as historical validated tooling, but it is not a successful new bootstrap command. A subsequent explicit invocation reuses/revalidates it normally. Unresolved errors keep original lock/claims/evidence and no cleanup of unknown paths. No age timeout grants ownership.

- [ ] **Step 5:** Close the pre-operation host-extraction boundary. The chunk 4 host guard is builtin host code authenticated by the reviewed command; it cannot execute candidate code before archive SHA/helper checks. Extend that exact heredoc to write a private preparation receipt before creating `.prepare-<uuid>`:

```typescript
// Receipt lives beside, never inside, the not-yet-created preparation directory.
export type HostPreparation = {
  schemaVersion: 1;
  id: string;
  instance: InstanceKey;
  owner: { pid: number; startTime: string };
  archive: FileSeal;
  reviewedRevision: string;
  preparedPath: string;
  parent: OwnedDirectory;
  phase: "intended" | "created" | "extracted" | "validated" | "adopted" | "removed";
  directory: OwnedDirectory | null;
  helper: FileSeal | null;
  adoptedOperationId: string | null;
};
```

Use a local host `durableWrite` with exclusive temp 0600, file fsync, atomic rename and parent fsync; verify temp/parent ownership and preserve errors. Receipt path is `<bootstrap>/.prepare-<uuid>.json`. Host obtains its own start time through `/bin/ps -p <pid> -o lstart=` as a literal execFile call, validates it, and records archive `FileSeal`/selected config/UID. Receipt intended -> mkdir/fsync -> record created identity -> extraction -> record extracted -> compare helper bytes with reviewed archive member -> record validated. Print helper path only after validated is durable. No token/config content is read or printed by this host guard.

Bootstrap derives receipt path solely from its source helper's `.prepare-<uuid>/package/pkg/deploy.min.js` path, validates receipt/archive/helper/identity and host-owner status, and copies/seals the validated receipt into immutable `<operation>/host-preparation.json` referenced by `work.hostPreparation`. This retained copy survives cleanup of the original host sidecar. Require host preparer exited before adoption; overlapping preparer is busy. Under the ordinary lock, journal adoption with that original receipt seal, write adoptedOperationId, and retain/seal the exact adopted receipt in a separate immutable operation file **before** any install. The strict `work.adoption` field contains both expected byte digests, with separate intended/observed states, and the original sidecar/source-directory identities for disposal; it never changes `work.hostPreparation` to point at a deletable sidecar. Reconciliation accepts only the exact prior validated receipt or its predicted adopted bytes for this operation; no later receipt edits may redirect cleanup. A host crash before operation acquisition has no lifecycle lock to settle: a later host preparation uses a fresh UUID and preserves those orphan receipts/directories. V1 performs no automatic pre-operation orphan reclamation; record `PREPARATION_ORPHAN_RETAINED` when an existing receipt is selected for adoption but its validation never completed. Intended receipt with a directory but no identity stays explicitly unresolved/retained. A fresh UUID preparation can be created independently; never overwrite or silently purge an orphan.

After helper completion, an operation-owned janitor invoked from the frozen path disposes only its adopted preparation identity after all children exit and its terminal record is durable; receipt removal is separately fenced. The frozen executable and committed bootstrap/archive/registry stay retained for later stale reconciliation. Missing bootstrap registry is therefore not required to identify an interrupted install or its original helper.

## Task 8 Step 6a.1a / Task 9 Step 5a.1a: Required verification

The parent Testing Contract applies without waivers. Add the new source file to S7 build/test ownership and S8 probe bundle closure; no build/artifact run occurs in this documentation revision.

- [ ] **Step 1 (S7):** Implement unit cases for the strict new schemas, provisional subject refusal, discovery ticket non-serialization/expiry, two plist seals, ABI/projection/idle mapping, owner-correlated historical and installed status, private `worker-maintenance` parser/job/phase binding, strict own-loader Mongo row/count/boot/heartbeat/timestamp decoding, pagination failure, closed-owner validator, monotonic/wall/heartbeat expiry, work-kind dispatch, fixed job-kind/mode/phase/target refusal, creation/commit/adoption/job-ready/go/lineage fences and outcome matrix. Assert all three shared artifact entrypoints refuse a missing job runner before any writer spawn; enumerate every artifact `execFile` call and prove it is reached only inside its matching guardian handler. Verify lifecycle-install routing for ordinary update and reapply while bootstrap-only/registry/wrong-phase variants fail. Assert `JOB_ACCOUNTING_UNAVAILABLE` prevents running/go/handler invocation for every job kind; an old census-only `settled` chain must not authorize rotation/disposal/lock completion. These negative assertions cannot pass the still-blocked positive installation gates. Assert unsettled/unknown/live descendants prohibit disposal in both work modes even after the direct tar/npm process exits. Inject only OS/file/clock/process/vendor boundaries; never inject a `held=true` or complete-accounting constructor. Run:

```bash
npm run build
npx vitest run src/deployment/pilot-records.test.ts src/deployment/pilot.test.ts src/deployment/pilot-probe.test.ts src/deployment/runtime-probe.test.ts src/deployment/health.test.ts src/deployment/services.test.ts src/deployment/operation.test.ts src/deployment/reconcile.test.ts src/deployment/bootstrap.test.ts src/deployment/artifact.test.ts src/voice-worker/maintenance-ipc.integration.test.ts
```

Expected: exit 0, no skipped required cases. Also run all original chunk 4 S7 transaction/CLI/plugin/shell commands; these additional commands do not replace them.

- [ ] **Step 2 (S9):** Build **two actual packages** with the production ABI: H is a clean separately recorded source commit containing this ABI and maintenance protocol, C is the clean candidate commit. In isolated build directories, independently bundle/pack each with its own release/revision/archive/lock records, then independently extract and `npm ci --omit=dev` outside any repository without dependency symlinks. H may be an earlier implementation checkpoint deliberately built by this harness; it is not represented as an already existing production release. Record that provenance explicitly. An extra test fixture API or generated success entrypoint is forbidden. Both H and C use actual production `runtime-probe.min.js`; H lives at a historical path outside `.hive`. Build an additional unsupported fixture from preserved pre-ABI source to prove its old public dispatcher fails compatibility. Do not patch a protected pilot or rewrite H at runtime.

The process-level S9 harness must route SDK and bridge requests to disposable test-owned local HTTP servers using fixture config with dummy credentials. The **real pinned** `RoomServiceClient`, `AgentDispatchClient`, `SipClient`, historical loader and probe executable must execute and issue their actual list RPCs. Fixtures return protocol-correct vendor-boundary arrays/pages, not `HistoricalObservation`/`PilotProbeResult`/hold JSON. The actual shared maintenance supervisor/ledger handles close/status/release in a test-owned runtime; process/launchctl/socket readback shims corroborate that runtime. No real service registration or vendor connection occurs. Use production captured service `HOME/PATH/HIVE_HOME/HIVE_CONFIG` and fake `security` executable; no production trust-fixture switch or raw API credentials from the operator.

Give H and C deliberately different fixture configuration projection behavior by using two real source commits (for example H's source has a deterministic different default voice selection while explicitly selected common fields still match the baseline). Seal each build and capture H's baseline using H's loader. Assert observation/inventory digest follows H, fails if C's result is substituted, and raw dummy secrets/URI/phone metadata never appear in stdout, stderr, operation records or logs. H's actual `pilot-abi` handshake reports H's release, and all real list RPCs must be observed from its process; replacing it with the old dispatcher must fail with no signals. Exercise full pagination including second-page rule/trunk, repeated cursor and permission failure. Never use a fake response for a historical ABI absent from the executable.

For historical telemetry, start disposable **real Mongo** instances on loopback with fresh harness-owned dbpaths and ports (spawn the selected `mongodPath` with `["--bind_ip","127.0.0.1","--port",String(mongoPort),"--dbpath",mongoDbPath,"--logpath",mongoLogPath]`, all derived from this harness’s fresh fixture); await readiness and always reap them. Their binaries are an explicit S9 harness prerequisite; absence requires setup or a concrete blocker, never a skip or a mock that returns `HistoricalIdle`. Seed only the selected `telemetry` collection with fixture `voice_worker_stats` rows and current test-supervisor `BootIdentity`; `supervisorUpdatedAt` is a Mongo Date. Execute H's production lazy `MongoClient` import, own loader, actual find command and strict output decoder. Use loopback Mongo command profiling within these disposable databases to assert the projected kind-only query, primary read, and actual before/after-close read order. No query interception or injected telemetry/profile JSON is permitted. Keep raw profiler records test-local; shared evidence retains sanitized query counts/times/boot/operation UUIDs only.

Give H and C distinct resolved Mongo endpoints using the same legitimate loader-default difference technique already required for their independently built source commits; keep the selected fixture config/environment sealed, and record the exact source difference. In the positive test H's endpoint has valid current zero telemetry, while C's endpoint has nonzero/wrong-boot telemetry; assert H queries only its own endpoint. Keep C poisoned through the H hold proof; once C actually starts, its test-owned production supervisor boot/heartbeat writes must establish C’s new valid row before separate packaged activation health can succeed. Reverse the rows for a negative case: C zero cannot rescue H's failure. These are isolated harness source builds, not a new production fixture API, an operator config edit, or a change to H after sealing. Query trace and real shared IPC receipts must show the owning operation on baseline, post-close and final status requests, with fresh distinct status UUIDs. Query after capture again for prepare, migration and reapply; the capture-time result is never sufficient. After rollback seed the newly observed test supervisor boot and require a fresh H read; an old-boot row must fail even when its PID or count matches.

Run the following complete historical native-idle cases through the real CLI/frozen helper and H executable. Mutate **Mongo boundary rows**, never decoded results. A post-close mutation is latched after the real ledger's close acknowledgement but before H's query; record both query and status receipts so the test cannot pass by deferring before reaching Mongo.

| Mongo/status boundary case | Required helper result |
| --- | --- |
| H current boot, recent heartbeat and `activeCalls:0`, C poisoned | baseline open/null-owner read, post-close closed/same-owner read and separate final read all query H; migration/rollback/fresh reapply succeeds with original required profiles |
| Missing row; duplicate kind rows; missing/negative/fractional/string/boolean count; malformed identity/date | no idle proof; fixed missing/invalid classification; baseline defers before close, post-close/final terminal-releases same owner and defers without any bootout |
| Heartbeat older than 60,000 ms; future heartbeat; job `updatedAt` fresh while `supervisorUpdatedAt` stale | fixed stale classification; no bootout; correct terminal release if close began |
| Wrong PID/boot/release or identity from before recovered generation with zero count | fixed wrong-boot classification; retained snapshot unchanged; same-operation release/defer without signals |
| Nonzero count at baseline; count becomes nonzero after close and persists beyond 30 seconds | baseline never closes; racing post-close case keeps call/pair alive for its bounded wait then terminal-releases/defer, no signals |
| Mongo unavailable/denied/query stalls; response/close completes outside request deadline | fixed query/deadline classification, no partial result, original deadline unchanged; release/defer or explicit unresolved release failure |
| Valid telemetry followed by wrong-owner closed status; open status supplied in closed phase | actual shared IPC/strict validator rejects; no fabricated ownership or fallback random operation; no signals |
| Heartbeat crosses its 60-second expiry during persistence/inspection while 2-second read budget still holds | final dispatch rejects and releases/defers, proving heartbeat expiry is also retained in the private proof |

Extend that same **actual C executable/shared-ledger/disposable-Mongo** harness through the candidate leg of `--pilot-recovery` and a separate ordinary packaged `restart` with an empty pilot registry. After C's real new supervisor boot has established its own row, C's `worker-maintenance` requests must reach C's own Mongo endpoint on baseline, post-close and final, using the acquired rollback/restart operation on every real status receipt. Observe the fixed argv/private-input seal and distinct outer/status UUIDs; assert the profiler read occurs after each corresponding test-owned ledger phase latch, the exact current C supervisor/release matches, and no H/candidate-stage endpoint is used. Only after the final C read/fence may worker then engine stop; pilot rollback must then restore H's actual generation and complete fresh-held reapply to C. Restart must independently complete its new C boot and public open/null-owner activation without any pilot snapshot selection. A test that exits before the C query, injects a completed `WorkerProbe`, or seeds ready-made status/telemetry JSON cannot satisfy either positive case.

Repeat C's baseline/post-close/final with wrong-owner status, stale/future heartbeat, old/wrong boot/PID generation, nonzero actual Mongo count, missing/duplicate/malformed rows, Mongo denial/stall and expired original deadline. Place wrong-owner replies at the actual shared IPC boundary (run the legitimate other-owner ledger state; never handcraft a reply); for post-close/final failure ensure C's real query is also observed by latching both parallel boundaries before returning failure. Baseline faults defer without close; after this operation has closed admission, stale/wrong-boot/nonzero/query/deadline faults require the same owner's real terminal release and zero signals. For a genuinely foreign-owned gate, assert no release can open that foreign gate: it remains deferred/unresolved as appropriate, with lock retained if this operation's prior close cannot be finalized. Separately feed a stale/foreign status request **to the actual supervisor owned by the current operation**, observe its rejection, then verify the original owner's terminal release succeeds with no signals. No wrong-owner fixture may require illegally releasing another owner's admission. Finally assert public `worker` health refuses C while its maintenance gate is closed and accepts only the fresh open new-boot activation.

For orphan writers, retain the production frozen helper/parser/job handler/reconciler unchanged and use only the existing test preloader's OS boundaries. The bootstrap extractor case spawns actual `/usr/bin/tar` on a sufficiently large valid archive and observes its PID/start/group and partial extraction before the harness sends that **owned** tar PID `SIGSTOP`. Kill the invoking CLI and frozen orchestrator, leaving its distinct guardian and tar alive. Invoke the CLI again: production reconciliation must report busy, preserve lock and every package/archive/digest/temp/cache inode, and neither clean nor stage/start the new action. Resume tar with `SIGCONT`; allow guardian to record its real terminal receipt and exit; next invocation can perform fenced bootstrap abort (pre-commit), exits 1 with `PREVIOUS_OPERATION_RECONCILED`, and never installs over the partial tree. Repeat loss of guardian too: while a recorded writer lives it stays busy; after it exits, missing settled lineage must remain unresolved with files retained. Do not convert a killed guardian into clean accounting merely because a later `ps` listing is empty.

The ordinary update and pilot reapply installer cases use actual recorded Node/npm `ci` and real install-script descendants. Build a separate clean, provenance-recorded **test artifact** with the same production helper/code/full runtime entries and an additional harness-local npm fixture dependency in its generated lock/shrinkwrap; serve that fixture from a disposable loopback registry. Its normal lifecycle script spawns a non-detached Node child that periodically appends to a fixture sentinel inside the owned stage and exits only when the harness-owned latch is released. This fixture is install-boundary data, not a substitute helper/probe or a mutation of the accepted S8 artifact. Observe at least two real writes and guardian/census identity, then kill CLI/frozen orchestrator while the installer or its child remains alive. Exercise both npm-still-running and npm-exited/child-reparented cases for **ordinary update and reapply**. Reconciliation must stay busy, retain `.hive.next`, its npm temp/cache/downloads and prior pair/slot sentinels, and record continued child writes after parent death. Release the latch, wait for actual child exit plus settled guardian receipt/exit, then run reconciliation again: only owned staging trees are disposed through lifecycle fences, the live prior pair remains unchanged and the requested new operation does not start. Lost guardian/identity/reused PID scenarios remain unresolved after the writer exits unless the original settled receipt already existed. Also hold an actual registry `npm pack` writer under `lifecycle-fetch` across parent death and assert identical downloads/cache retention. Tear down any surviving test processes by their harness-owned PID/start identities only after assertions; test cleanup never counts as production reconciliation proof.

Add the distinct **detached unseen writer** variant for both ordinary update and pilot reapply. Its real npm lifecycle script starts an intermediate Node process that spawns the writer with `{detached:true,stdio:"ignore"}`, calls `unref()`, and exits. The harness's test-only OS preloader pauses the guardian's next **census** before that fork, allows the intermediate and npm to exit, then resumes census while the detached writer still appends repeatedly to the owned stage. Keep the guardian alive. Independently record the writer's PID/start/new session/group in the test harness (never inject that information into production lineage); show that the resumed PPID/group census cannot reach it. Kill only the CLI/frozen orchestrator and invoke real reconciliation. Require preserved stage/cache/downloads/slot sentinels and lock, no false settled receipt, no rotation, no new action, and continued actual writes. If a future reviewed complete observer supplies the missing generation, the job is busy while it lives; absent/lost coverage is unresolved, never repaired by the resumed census. After harness-controlled writer exit, only valid complete coverage through its exit could permit settlement; a census-only receipt remains unresolved. Retain the non-detached and guardian-loss cases above.

**These positive/executed-writer S9 cases remain blocked by Step 3a.** The present production gate refuses before npm or any other table handler runs. Require an actual-helper negative case proving that refusal and absence of go/writes, but do not mark the paused-census/detached-writer case passed by observing that early refusal. Do not bypass the gate in a test preloader or forge a ready/complete receipt to obtain a green full exercise. Before readiness, a reviewed feasible production mechanism must make the actual-helper scenario reachable and satisfy its safety assertions. An isolated Node demonstration of escape explains the blocker only; it cannot substitute for the required S9 test. The H/C installed/historical positives above, S8 native artifact and later actual S12 operations remain separately required.

- [ ] **Step 3 (S9):** Every row below runs through the **actual S8 frozen deployment helper**, using persistent disposable filesystem/process boundary state; start without a snapshot registry and derive selectors only from real command output.

| Scenario | Minimum required result |
| --- | --- |
| First legacy capture with external LaunchAgent target and pre-existing distinct instance plist | Actual read-only discovery succeeds, draft subject is observed, registry commit occurs only after profile passes; no prior registry seeding; external original and unrelated instance sentinels untouched |
| Draft selector on inventory/cutover/recovery; copied/wrong-op draft; process/link change during initial capture | Reject before stop/stage; no usable snapshot registration |
| H first capture, inventory, prepare, migration, pilot rollback and fresh reapply | Actual H ABI/loader/SDK/Mongo reads and owner-correlated ledger protocol complete; candidate packaged health after reapply; two plist role sentinels restore exactly and protected external bytes/inode/mode never change |
| Uninstrumented legacy plus old packaged-helper compatibility | Legacy available profile can register but native hold is unavailable -> `MIGRATION_PENDING`; unsupported packaged ABI explicitly fails its profile; neither branch can be made positive by a hand-authored response |
| Composed stop freshness cases in Step 4c.2a | No bootout after original wall/monotonic expiry, including time spent in signals persistence; repeat all decisive reads or verified release; single-use proof at actual exec dispatch |
| Kill frozen helper during bootstrap before/after each directory and extraction fence, during actual still-live tar/`npm ci`, after install exit, before/after diagnostic, payload, commit and result writes | Mode-specific recovery or exact ambiguous-identity unresolved; live guardian/tar/npm/descendant busy; dead owned incomplete tree cleaned with fences; committed tooling validated offline and retained; zero service/config/vendor adapters invoked |
| Ordinary update/reapply npm and install-script descendants, plus registry fetch, outlive CLI/frozen parent | Actual helper stays busy while writer lives; after settled guardian/descendant exit perform only lifecycle staging cleanup; lost observer/lineage unresolved; prior live pair/slots preserved |
| Detached npm writer escapes while next census is paused; guardian lives through orchestrator death, ordinary update and reapply | Actual continued writes, retained stage/cache/lock/slots, no false settled receipt or new action; census-only accounting remains unresolved; reachable execution requires Step 3a resolution, early refusal is a separate negative test |
| Kill host guard before/after preparation receipt, mkdir, identity, extraction, validation and adoption | No execution of unvalidated helper, stable receipt lineage; pre-operation or ambiguous orphan retained, adopted owned preparation cleanup fenced; no overwrite or lifecycle pair requirement |
| Kill capture/inventory/verify before/after draft, payload, registration and sealed result writes | Uncommitted aborted/nonselectable; committed record attached without rewriting/reprobing it into fresh authority; next lifecycle still requires current evidence |
| Kill prepare/release before close ack, after hold registration and before/after terminal release ack | Original recorded operation releases even when close may arrive late; no alternate owner/TTL accepted; unresolved retains lock; new requested command not executed |
| Crash after durable bootstrap/registry outcome before cleanup; stale takeover races; OS child identity unavailable | Idempotent correct-mode cleanup or busy/unresolved; no lifecycle slot rotation, no full prior-service health requirement, no success for the new requested action |

For actual-helper process tests, launch Node with an explicit harness-only `--import <absolute-test-preloader>` that wraps builtin filesystem/child-process/clock boundaries and calls `syncBuiltinESMExports` before importing the unchanged sealed helper. Allowlist only disposable fixture roots and process IDs; abort on any operator path. This mechanism is confined to S9 lifecycle tests; S8 native/artifact acceptance remains uninjected with NODE_OPTIONS/NODE_PATH absent. The preloader can delay/fail an OS call or provide test-owned launchctl/process readback, but cannot intercept production pilot/registry/reconcile module functions or provide profile JSON. Use test-owned blocking filesystem/service adapters and boundary latches to pause at the specified points and kill the actual owned frozen process from the harness; no production fault-injection CLI flags. The installed helper remains the executable under test; injected boundary interception must not replace its parser, orchestration, registration, proof or reconciler. Keep the complete original S9 migration/failure/adoption cases and second-instance preservation checks.

Run after implementing and rebuilding affected production artifacts:

```bash
npm run bundle
npx vitest run src/deployment/adoption.integration.test.ts src/deployment/lifecycle.integration.test.ts src/deployment/transaction.test.ts
npm run check:artifact
```

Expected: real S8 artifact/native markers, all original and additional S9 cases exit 0; no skipped positive H interface tests or legacy negative tests. Retain host/package/probe hashes with fixture provenance. Automated H support establishes only the production ABI branch. The actual uninstrumented dodi pilot remains migration-pending without a separately reviewed real external authority; actual migration/restart/pilot recovery/reapply/final readback and all S12/T9 evidence remain incomplete until executed.

- [ ] **Step 4:** Commit the implemented S7 slice only after its original and additional required checks; checkpoint S8 and S9 separately when their real artifacts/tests pass. This document itself is a docs-only revision, not implementation completion or plan approval.
