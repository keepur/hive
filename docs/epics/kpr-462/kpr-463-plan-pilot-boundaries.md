# KPR-463 implementation plan — capture, probe ABI and operation recovery boundaries

This is chunk 5 of the [parent plan](./kpr-463-plan.md), completing the affected contracts in [chunk 4](./kpr-463-plan-pilot.md). The approved spec, complete Testing Contract, Gate 1 delegation, absent decision-register canon and authorized dodi-dev substitution `ac95b136` still apply. These are remaining S7 source steps and required S9 actual-artifact cases. This plan authorizes no protected-pilot retrofit, service action, vendor request or live call during drafting. All existing S7 remainder and S8/S9/S12 gates remain required.

## File map and source constraints

| File | Work in this chunk |
| --- | --- |
| `src/deployment/pilot-records.ts`, `pilot.ts`, their tests | sealed operation draft, commit boundary, private capture ticket, final proof expiry |
| `src/deployment/services.ts`, `.test.ts` | read-only initial external-plist discovery, separate plist roles, last-moment signal fence |
| `src/deployment/pilot-probe.ts`, `.test.ts` | secret-free wire decoder/projection/inventory normalization; shared by installed probes |
| `src/deployment/runtime-probe.ts`, `.test.ts` | production `pilot-abi` and `pilot-abi-v1` process entrypoints; historical loader executes its own reads |
| `src/deployment/health.ts`, `.test.ts` | distinct correlated closed-and-same-owner validator; existing open-health behavior stays binding |
| `src/deployment/operation.ts`, `bootstrap.ts`, `reconcile.ts`, `main.ts`, their tests | discriminated durable work state, preparation/process/registration fences, mode-specific recovery |
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
  dependencyFiles: PilotProbeResult["dependencyFiles"];
};
export type InventoryItem = {
  kind: "room" | "participant" | "dispatch" | "sip-rule" | "inbound-trunk";
  id: string; // salted per-operation digest of resource ID; never participant identity/phone number
  parent: string | null;
  agentName: string | null;
};
export type HistoricalInventory = Omit<HistoricalObservation,
  "action" | "bridge" | "sdk" | "dependencyFiles"> & {
  action: "inventory";
  items: InventoryItem[];
  counts: { rooms: number; participants: number; dispatches: number; rules: number; inboundTrunks: number };
  limitations: ["EXTERNAL_PRODUCERS_UNFENCED", "PENDING_ASSIGNMENTS_UNOBSERVABLE"];
};
```

Failure for either historical mode is exactly `{schemaVersion:1, abi:"hive-pilot-probe/1", requestId, classification}` and exit 1; classification is one of `PILOT_PROBE_ABI_UNSUPPORTED`, `PILOT_PROBE_INPUT_INVALID`, `PILOT_LOADER_UNAVAILABLE`, `PILOT_CONFIGURATION_MISMATCH`, `PILOT_BRIDGE_FAILED`, `PILOT_DEPENDENCY_MISMATCH`, `PILOT_INVENTORY_INCOMPLETE`, `PILOT_PROBE_DEADLINE`. Input parse failures use the all-zero UUID if the request UUID cannot be safely decoded. Suppress stdout/stderr from config imports as the existing main does; emit only canonical sanitized output. Reject unknown fields, mismatched header/subject/release, oversized output, extra lines and nonzero exit even with a plausible response.

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

Observation execution inside the historical process: check seals/environment/request -> record `startedAt` before any decisive reads -> lazy own loader -> compute projection -> `probeBridge(wc.bridgeUrl,wc.bridgeToken)` -> `probeWorkerHttp(request.sdkPort)` -> resolve/hash required dependency files relative to the historical entrypoint and compare exact request set -> finish before deadline. Perform slow complete tree checks in the frozen caller before this window. Resolve external SDK via `createRequire(historicalEntry).resolve`, and native/model paths via the installed package walkers from the runtime diagnostic. Paths outside expected sealed roots or OS-unconfirmed required loaded files fail. Return bridge fields only if existing `authenticated/missingDenied/wrongDenied` all pass; map `correctClassification` to `missing-agent` only then. Return the actual SDK status/name/count (non-null, correctly typed), never constants substituted for observations.

Mapping to `PilotProbeResult` is mechanical: validate ABI/projection/release/operation first, copy `requestId, subject, instance, startedAt, finishedAt, configIdentity, bridge, sdk, dependencyFiles`, set `classification="PILOT_OBSERVED"`; include no credential fields. The outer caller validates the result against its request and independent evidence. This wrapper mapping cannot manufacture missing historical fields.

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

The hold adapter also requires an empty strict ledger, zero SDK active jobs and zero current telemetry calls. An open health status may never pass this validator and a closed-owner status may never pass activation health. `proveBarrierBeforeStop` remains a supplementary correlated IPC check; it cannot refresh the other observations.

- [ ] **Step 2:** Assemble `NativeGateReadback.observedAt` as the minimum **request start** of IPC, SDK root/worker, current telemetry query and independent process/socket reads. `completedAt` is their maximum completion. Record equivalent monotonic starts/completions with `performance.now()` in the owning frozen process; subprocess wall timestamps must fit its measured interval, but cannot extend it. Retain the original wall and monotonic expiries in the private WeakMap; chunk 4’s core code includes both. Also track the last local wall/monotonic clock sample during collection, persistence and dispatch; either clock decreasing fails the attempt, even if still later than the oldest observation. No durable or subprocess output can reconstruct a proof.

All tree/inventory work precedes this interval. At the final actual bootout `beforeExec` callback (after the existing controller's awaited inspection and `markIrreversible`), compare both clocks to their original expiry, consume once, then invoke OS `execFile` synchronously. If the OS adapter uses a queue, perform the check at dispatch out of that queue. Do not consume at entry to an async bootout method. An expiration before signal causes complete fresh observation or verified release/defer within the original maintenance deadline. An elapsed/future/clock-reversal error is fail-closed; persistence of `signalsBegun` is conservative crash metadata, not permission to ignore expiry. Extend `BootoutOptions` with synchronous `beforeExec():void`, called after `markIrreversible` and immediately before OS dispatch. Within the current live invocation, retain `signalIssued=false` until that dispatch; catch the specific expiry-before-dispatch result in `withVerifiedPilotStop`, before the generic transaction recovery catch. It runs the complete fresh-read retry or terminal-release/deferred cleanup path and returns a typed deferred outcome, never a successful stop. The durable signals fence stays conservative until that verified deferred outcome is recorded. On process death this in-memory distinction is lost and existing checked recovery remains required; never deserialize `signalIssued=false` to bypass it.

Required composed tests: observe at 1000, construct at 2999, attempt signal at 4998 -> reject; observe at 1000, construct at 1001, begin persisting signals at 1002, persistence returns at 3001 -> reject; observe at 1000, construct at 1500, finish persistence at 1900, IPC check at 2999, signal at 3001 -> reject; at exactly 3000 with both clocks within the same original budget -> allow once. Delay a service inspection after callback entry to prove the actual `beforeExec` placement catches it. Wall reversal paired with monotonic progress rejects. Verify no signal count increment and correct terminal release on deferral; test the complete helper sequence, not only `proveNativeHold` and `consumeHold` separately.

## Task 8 Step 1a.3 / Task 9 Step 4d.1a: Non-lifecycle durable state and reconciliation

- [ ] **Step 1:** Make operation work a strict discriminated union. New operations use schema version 2; preserve a read-only schema-1 decoder for old lifecycle records only when all reconstruction fields actually exist. Old incomplete schema-1 operations stay unresolved with named missing fields. No bootstrap/registry work is converted into a fictional stopped lifecycle prior.

Keep the existing common operation fields (`id`, canonical instance/config/UID, startedAt, tool path/hash, recorded Node/npm, original parent/frozen-child identities, phase, retainedPaths) and add the strict `jobs` array below, and move lifecycle-only prior/profile/artifact/barrier fields into `work.kind="lifecycle"`. Require `signalsBegun=false` for both non-lifecycle branches; they cannot stop/start services. Exact work fields:

```typescript
export type TrackedJob = {
  id: string;
  kind: "bootstrap-install" | "offline-diagnostic" | "pilot-probe";
  state: "launch-intended" | "ready" | "running" | "exited";
  input: FileSeal;
  readyReceipt: FileSeal | null;
  terminalReceipt: FileSeal | null;
  guardian: { pid: number; startTime: string; processGroup: number } | null;
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

Bootstrap path order: journal/create digest root -> journal/copy/fsync archive -> journal/create package extraction directory -> verify archive/extract strict members -> persist extracting complete -> install fence -> diagnostic/release/tree verification -> `RegistrationFence`. Persist phase before and after each effect; capture frozen helper before any possible disposal of its source. Never overwrite an existing digest directory. A selected complete prior bootstrap requires its registered archive/release/tree seals and fresh offline diagnostic; an incomplete existing directory routes to its recorded operation or stays unresolved.

Registration order: persist `reserved` plus UUID/directory creation fence; create payload/files exclusively; validate/seal immutable payload and operation validation; persist `payload-written`; persist `commit-intended` with exact expected canonical `Registration` fields and payload digest; write `registration.json` exclusively and fsync its directory; seal it; persist `committed` plus ref; persist mode result before printing. Add expected registration bytes/digest to the intent's sealed validation file so a crash before recording the commit seal can compare actual bytes to already durable intended bytes. No manifest points at an incomplete payload. Payload/registration mismatch never resolves by rewriting. All registered selectors still require commit and strict associations.

`reconcileRegistration` returns exactly one of: `absent` (no directory, intended only), `incomplete` (owned directory without commit; retain diagnostic evidence and mark aborted), `committed` (strict commit/payload/files match durable intent; seal existing commit and attach ref idempotently), `unresolved` (unexpected identities/contents/ambiguous creation). It never creates a missing commit during crash recovery. A commit-intended write present with valid bytes but unknown fsync outcome is revalidated and fsynced before recording committed; absent commit is incomplete. A valid committed capture remains a historical baseline; no fresh health is claimed during offline registration completion.

- [ ] **Step 3:** Track bootstrap install descendants across parent death. Add internal frozen-helper `--operation-job=<operation-path>/jobs/<job-uuid>/input.json` entry, legal only for a job in the recorded operation’s strict `jobs` array, no user lifecycle flags. Its exact-key input is `{schemaVersion:1, operationId, jobId, kind, selectedInput:<FileSeal|null>}`; paths/Node/npm/probe and arguments come only from the associated work/registered snapshot, not an argv field. Kind restricts the handler to install, offline diagnostic or pilot probe. The install handler requires bootstrap work; registry jobs can only be pilot probes. Lifecycle offline/probe jobs reuse this mechanism with their existing validated stage paths. It runs builtin code until parent handoff. The parent first records a unique job UUID and launch-intended fence; it spawns the same hash-verified frozen helper in a new process group as a guardian. Guardian writes an exclusive, fsynced ready receipt with job UUID, own PID/start/group, original tool hash and operation ID, then waits for its exact private `go` message. If the parent dies before ready, a reconciler checks the fixed job receipt and exact job-path process census; a live unready guardian is busy, ambiguous identity is unresolved, and no go means no subprocess effects. Parent reads/OS-corroborates ready, persists guardian identity and running intent, and only then sends go. No npm executes before that durable identity exists. A ready guardian seeing the recorded parent exit without go records aborted and exits without install. Conflicting/missing job records remain unresolved.

Guardian invokes the recorded Node with `[recordedNpmCli,"ci","--omit=dev","--no-audit","--no-fund","--no-progress"]` in the recorded package path/sanitized environment; its own PID remains alive and reaps npm and known descendants. Guardian returns only sanitized exit/marker evidence in a sealed terminal receipt, remains a liveness participant until its process group/known descendants have exited, then exits. Reconciler rechecks both invoking parent and frozen child **and** install guardian/group. Any live one returns busy without cleanup; unknown descendant/group identity is unresolved. Do not terminate an installer as a reconciliation shortcut. If the guardian is killed and npm survives, identify the retained process group via OS PGID/PID/start census and stay busy; if ownership cannot be proved, retain unresolved. A future invocation can clean an interrupted tree only after verified process absence. Protect against PID/PGID reuse by ready and process-generation lineage; group number alone is not proof.

Crash recovery never resumes a partially executed npm install in place. With no committed registration and all owned processes gone, abort bootstrap and delete only observed owned package/archive/digest directories (or retain incomplete registry diagnostics), using disposal fences. A later fresh invocation reruns extraction and `npm ci` from the retained reviewed input; `node_modules` presence never means installed. With a committed registration, revalidate release/tree/archive/helper seals and rerun the offline native diagnostic with tracked operation-owned child liveness before recording validated. Failure remains unresolved with paths preserved; it cannot demote a published immutable registration by overwriting it.

The same child launch/ready/identity discipline applies to offline diagnostic and installed probe subprocesses: command kind/argv are fixed by their adapter, owned identity is persisted before allowing execution, and a live/unknown child prevents registry/bootstrap cleanup. This does not add a general command executor. No service/config/vendor adapter is constructed for bootstrap reconciliation, including when HOME has no running services.

- [ ] **Step 4:** Dispatch reconciliation by work kind **before** reading `priorSnapshotPath`, services, artifact slots or a maintenance descriptor. Common strict lock/owner/original-helper/serialized takeover checks from chunk 4 apply to every kind. The concrete terminal matrix is:

| Work/current durable state | Required recovery and final outcome |
| --- | --- |
| Bootstrap before commit, all owned processes absent | Reconcile creation/disposal fences, abort owned incomplete install, retain diagnostic registry drafts and reviewed input, persist bootstrap `aborted`; no service calls |
| Bootstrap commit present, result write absent | Reconcile registration from intended bytes, offline revalidate matching installed package/native markers, attach existing ref, persist `validated`; never install over it |
| Capture/inventory/verify before commit and no admission mutation | Reconcile private writes only, keep incomplete diagnostics nonselectable, mark `aborted`; never reuse abandoned probe output as current health or restart services |
| Capture committed, operation reference/result absent | Validate original sealed capture validation and registration intent/payload; attach ref, persist `record-committed`; no live health claim and no service inspection needed |
| Inventory/verify sealed result but unfinished operation | Validate result seal/subject/challenge as historical assessment only, persist `assessment-complete` or `migration-pending` from its fixed code; no hold proof retained |
| Prepare/any registry command with close-intended/closed/release-intended | First settle its recorded barrier as below, even if close ack or hold registration was lost; then reconcile registration/results, persist `assessment-complete` or `aborted` |
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

- [ ] **Step 1 (S7):** Implement unit cases for the strict new schemas, provisional subject refusal, discovery ticket non-serialization/expiry, two plist seals, ABI/projection mapping, pagination failure, closed-owner validator, monotonic/wall expiry, work-kind dispatch, creation/commit/adoption/job-ready fences and outcome matrix. Inject only OS/file/clock/process/vendor boundaries; never inject a `held=true` constructor. Run:

```bash
npm run build
npx vitest run src/deployment/pilot-records.test.ts src/deployment/pilot.test.ts src/deployment/pilot-probe.test.ts src/deployment/runtime-probe.test.ts src/deployment/health.test.ts src/deployment/services.test.ts src/deployment/operation.test.ts src/deployment/reconcile.test.ts src/deployment/bootstrap.test.ts
```

Expected: exit 0, no skipped required cases. Also run all original chunk 4 S7 transaction/CLI/plugin/shell commands; these additional commands do not replace them.

- [ ] **Step 2 (S9):** Build **two actual packages** with the production ABI: H is a clean separately recorded source commit containing this ABI and maintenance protocol, C is the clean candidate commit. In isolated build directories, independently bundle/pack each with its own release/revision/archive/lock records, then independently extract and `npm ci --omit=dev` outside any repository without dependency symlinks. H may be an earlier implementation checkpoint deliberately built by this harness; it is not represented as an already existing production release. Record that provenance explicitly. An extra test fixture API or generated success entrypoint is forbidden. Both H and C use actual production `runtime-probe.min.js`; H lives at a historical path outside `.hive`. Build an additional unsupported fixture from preserved pre-ABI source to prove its old public dispatcher fails compatibility. Do not patch a protected pilot or rewrite H at runtime.

The process-level S9 harness must route SDK and bridge requests to disposable test-owned local HTTP servers using fixture config with dummy credentials. The **real pinned** `RoomServiceClient`, `AgentDispatchClient`, `SipClient`, historical loader and probe executable must execute and issue their actual list RPCs. Fixtures return protocol-correct vendor-boundary arrays/pages, not `HistoricalObservation`/`PilotProbeResult`/hold JSON. The actual shared maintenance supervisor/ledger handles close/status/release in a test-owned runtime; process/launchctl/socket readback shims corroborate that runtime. No real service registration or vendor connection occurs. Use production captured service `HOME/PATH/HIVE_HOME/HIVE_CONFIG` and fake `security` executable; no production trust-fixture switch or raw API credentials from the operator.

Give H and C deliberately different fixture configuration projection behavior by using two real source commits (for example H's source has a deterministic different default voice selection while explicitly selected common fields still match the baseline). Seal each build and capture H's baseline using H's loader. Assert observation/inventory digest follows H, fails if C's result is substituted, and raw dummy secrets/URI/phone metadata never appear in stdout, stderr, operation records or logs. H's actual `pilot-abi` handshake reports H's release, and all real list RPCs must be observed from its process; replacing it with the old dispatcher must fail with no signals. Exercise full pagination including second-page rule/trunk, repeated cursor and permission failure. Never use a fake response for a historical ABI absent from the executable.

- [ ] **Step 3 (S9):** Every row below runs through the **actual S8 frozen deployment helper**, using persistent disposable filesystem/process boundary state; start without a snapshot registry and derive selectors only from real command output.

| Scenario | Minimum required result |
| --- | --- |
| First legacy capture with external LaunchAgent target and pre-existing distinct instance plist | Actual read-only discovery succeeds, draft subject is observed, registry commit occurs only after profile passes; no prior registry seeding; external original and unrelated instance sentinels untouched |
| Draft selector on inventory/cutover/recovery; copied/wrong-op draft; process/link change during initial capture | Reject before stop/stage; no usable snapshot registration |
| H first capture, inventory, prepare, migration, pilot rollback and fresh reapply | Actual H ABI/loader/SDK reads and ledger protocol complete; candidate packaged health after reapply; two plist role sentinels restore exactly and protected external bytes/inode/mode never change |
| Uninstrumented legacy plus old packaged-helper compatibility | Legacy available profile can register but native hold is unavailable -> `MIGRATION_PENDING`; unsupported packaged ABI explicitly fails its profile; neither branch can be made positive by a hand-authored response |
| Composed stop freshness cases in Step 4c.2a | No bootout after original wall/monotonic expiry, including time spent in signals persistence; repeat all decisive reads or verified release; single-use proof at actual exec dispatch |
| Kill frozen helper during bootstrap before/after each directory and extraction fence, during `npm ci`, after install exit, before/after diagnostic, payload, commit and result writes | Mode-specific recovery or exact ambiguous-identity unresolved; live guardian/npm/group busy; dead owned incomplete tree cleaned with fences; committed tooling validated offline and retained; zero service/config/vendor adapters invoked |
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
