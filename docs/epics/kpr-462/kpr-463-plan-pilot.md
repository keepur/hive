# KPR-463 implementation plan — registered pilot evidence and S7 completion

This is chunk 4 of the [parent plan](./kpr-463-plan.md). Its approved spec, Testing Contract, S0–S12 schedule and authorization record `ac95b136` apply. This revision addresses `caught-by: implementation/2/capable`; it does not authorize pilot modifications, service actions or calls during drafting. Task/Step suffixes below extend existing IDs. They do not replace the original steps or waive T1–T9.

## Feasibility boundary established from source

Read-only sources: preserved implementation `bc0d47aaa5ae9c39366e185715cbde407837ce2f`, especially `src/deployment/{operation,artifact,transaction,lifecycle,services,health,runtime-probe,main}.ts`; legacy source `src/voice/livekit-voice-mcp-server.ts`, `src/agents/agent-runner.ts`, `src/voice-worker/{main,telemetry,session,livekit-setup-plan}.ts`, `scripts/livekit-setup.ts`; installed SDK `livekit-server-sdk/src/{AgentDispatchClient,RoomServiceClient,SipClient}.ts` and Agents `dist/worker.js`.

The MCP server calls `AgentDispatchClient.createDispatch` directly. Existing agent sessions can retain its stdio subprocess and credentials. SIP rules can independently dispatch `hive-voice`; scripts, credential holders and another worker on the same LiveKit project are additional inventory surfaces. Disabling future tool registration or checking the visible scheduler does not fence existing sessions. The old worker uses SDK default admission, has no durable accepted-request ledger, and writes telemetry independently of pending assignment. `listRooms`, `listDispatch(room)`, `listParticipants`, `/worker.active_jobs` and heartbeat counters do not expose a complete accepted-but-unassigned set.

**No external legacy hold implementation is established by these sources.** Version 1 accepts a hold only through the already implemented Hive admission protocol, with a verified capable runtime as described below. Its protocol check is usable for a historically located compatible release; it must never be grafted onto either protected pilot worktree. For the described uninstrumented dodi pilot, inventory/hold handlers produce a concrete `MIGRATION_PENDING` result identifying the missing dispatch fence and assignment-completion authority. That is an executed fail-closed assessment, not an unimplemented option or a fixture success. No external JSON, executable script, timer, operator assertion, absence of rooms, or checked checkbox can change that result.

If later actual inventory identifies an **existing** authoritative external fence plus complete outstanding-work accounting, return its exact interface/evidence to the plan lane for a narrowly reviewed adapter before enabling that route. Do not add a generic command runner or invent a remote control API. This is the spec §5.2 conditional deferral, not permission to omit eventual migration: S12/T9 and KPR-466 consumption remain pending until the actual hold/recovery/reapply requirements pass. A product decision to relax those requirements belongs to the spec lane.

## File map and dependencies

| File                                                                                        | Responsibility                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/deployment/pilot-records.ts`, `.test.ts`                                               | strict schemas, private record registration, path/hash/ownership validation; builtin-only                                                          |
| `src/deployment/pilot.ts`, `.test.ts`                                                       | current pilot capture/reconstruction, inventory/hold assessment and operation-local proof; consumes existing service/maintenance/health interfaces |
| `src/deployment/reconcile.ts`, `.test.ts`                                                   | concrete interrupted-operation adapters and serialized takeover; consumes `operation.ts` and reusable lifecycle recovery                           |
| `src/deployment/bootstrap.ts`, `.test.ts`                                                   | stable candidate-tooling preparation, retained archive registration; consumes `artifact.ts`                                                        |
| `src/deployment/plugin-compat.ts`, `.test.ts`                                               | locked narrow beta relocation and interrupted rename reconciliation                                                                                |
| `src/deployment/main.ts`, `operation.ts`, `lifecycle.ts`, `services.ts`, `runtime-probe.ts` | wire these contracts; persist sufficient reconstructable snapshots and ordered recovery                                                            |
| `src/deployment/adoption.integration.test.ts`, `lifecycle.integration.test.ts`              | S9 actual S8 frozen helper/artifact tests with disposable OS/vendor boundary shims                                                                 |

[Chunk 5](./kpr-463-plan-pilot-boundaries.md) completes the first-capture, historical probe ABI and non-lifecycle recovery contracts below. Its steps are part of the same remaining S7 and actual-helper S9 gates; it introduces no operational authorization.

Do not duplicate the partial implementation's artifact extraction, `ArtifactRotation`, `ServiceController`, `writeOperationJson`, `requestMaintenance`, `pilotRecovered` or packaged probes. New helper imports remain builtin-only after bundling. Keep LiveKit/Mongo/pilot config imports in the separate installed `runtime-probe.min.js` subprocess. S8 must include these real sources in the existing deploy bundle graph and verify external imports; no new global runtime or production test hook.

## Task 9 Step 4a: Define and register private evidence

- [ ] **Step 4a.1:** Add these serialized types in `pilot-records.ts`. Every object uses exact-key decoding, safe integer bounds and bounded strings/arrays. JSON is data only. `RecordRef` always refers to an immutable record created by the helper under this instance's private registry; a record's own hash field never authenticates itself.

```typescript
import type { ServiceDefinition, ServiceInspection } from "./services.js";
import type { Release } from "./release.js";

export type Digest = string; // exactly 64 lowercase hex digits
export type RecordRef = { id: string; sha256: Digest }; // UUID, raw byte digest
export type InstanceKey = { canonicalHome: string; configPath: string; instanceId: string; uid: number };
export type FileSeal = {
  path: string;
  realpath: string;
  uid: number;
  mode: number;
  dev: number;
  ino: number;
  size: number;
  sha256: Digest;
};
export type TreeSeal = {
  path: string;
  realpath: string;
  uid: number;
  dev: number;
  ino: number;
  manifest: FileSeal; // private sorted relative file/link inventory, not executable
};
export type ProcessSeal = { pid: number; startTime: string; executable: string; command: string; cwd: string };
export type ServiceSave = {
  definition: ServiceDefinition;
  inspection: ServiceInspection;
  effectivePlist: { source: FileSeal; saved: FileSeal }; // actual loaded target; never rewrite an external source
  instancePlist: { path: string; existed: boolean; saved: FileSeal | null; mode: number | null };
  link: { path: string; existed: boolean; target: string | null };
  loaded: boolean;
  enabled: boolean;
};
export type ArtifactSlot = {
  path: string;
  identity: { dev: number; ino: number; uid: number } | null;
  release: Release | null;
};
export type PilotSnapshot = {
  schemaVersion: 1;
  kind: "pilot-snapshot";
  id: string;
  instance: InstanceKey;
  capturedAt: number;
  captureOperationId: string;
  toolSha256: Digest;
  bootstrap: RecordRef;
  services: [ServiceSave, ServiceSave]; // engine, then worker; labels derived from instanceId
  runtime: {
    engine: ProcessSeal;
    worker: ProcessSeal;
    engineEntry: FileSeal;
    workerEntry: FileSeal;
    workerLoader:
      | { kind: "legacy-module"; file: FileSeal }
      | { kind: "packaged-probe"; file: FileSeal; runtimeRoot: string; release: Release; abi: "hive-pilot-probe/1" };
    node: FileSeal;
    roots: TreeSeal[]; // complete executable/module/dependency closure
    sdkListener: { host: "127.0.0.1"; port: number; agentName: "hive-voice" };
    bridgePort: number;
  };
  configIdentity: Digest; // captured allowlisted configuration identity
  configFiles: { path: string; seal: FileSeal | null }[]; // explicit dotenv absence; no copied secrets
  slots: [ArtifactSlot, ArtifactSlot, ArtifactSlot, ArtifactSlot]; // .hive/prev/next/broken
  admission:
    | { kind: "unavailable" }
    | {
        kind: "hive-maintenance-v1";
        runtimeRoot: string;
        release: Release;
        workerBundle: FileSeal;
        bootId: string;
      };
};
export const inventoryClasses = [
  "agent-sessions",
  "scheduled-and-queued",
  "local-scripts-and-services",
  "sip-dispatch-rules",
  "room-and-token-dispatch",
  "external-credential-holders",
  "other-workers",
  "outstanding-assignments",
] as const;
export type InventoryClass = (typeof inventoryClasses)[number];
export type SourceObservation = {
  id: string;
  category: InventoryClass;
  locator: string; // sanitized path/resource ID, never credentials
  checks: string[]; // nonempty IDs from this record's CheckSpec array
  scope: "target-instance" | "shared-project" | "unknown";
  accounting: "admission-ledger" | "observations-only" | "unknown";
};
export type CheckSpec =
  | { id: string; kind: "file-seal"; seal: FileSeal }
  | { id: string; kind: "service"; label: string }
  | { id: string; kind: "process-census" }
  | { id: string; kind: "sdk-local" }
  | { id: string; kind: "livekit-inventory" }
  | { id: string; kind: "admission-status" };
export type HoldRecord = {
  schemaVersion: 1;
  kind: "legacy-hold";
  id: string;
  instance: InstanceKey;
  snapshot: RecordRef;
  toolSha256: Digest;
  createdAt: number;
  pilotWorker: ProcessSeal;
  sources: SourceObservation[];
  checks: CheckSpec[];
  gaps: { category: InventoryClass; reason: string }[];
  procedure:
    | { kind: "unavailable"; reason: string }
    | {
        kind: "hive-maintenance-v1";
        operationId: string;
        bootId: string;
        establish: "request-close";
        verify: "fresh-status-and-ledger";
        release: "terminal-release-or-confirmed-supervisor-exit";
      };
};
export type BootstrapRecord = {
  schemaVersion: 1;
  kind: "bootstrap";
  id: string;
  instance: InstanceKey;
  createdAt: number;
  archive: FileSeal;
  packageRoot: TreeSeal;
  release: Release;
  helper: FileSeal;
  probe: FileSeal;
  diagnostic: FileSeal;
  node: FileSeal;
  npm: FileSeal;
};
export type Registration = {
  schemaVersion: 1;
  id: string;
  kind: "pilot-snapshot" | "legacy-hold" | "bootstrap";
  instance: InstanceKey;
  operationId: string;
  createdAt: number;
  payload: FileSeal;
};
```

`ServiceDefinition`, `ServiceInspection` and `Release` decode against their actual S7 definitions (not a TypeScript cast): validate every field, reject unknown fields, validate service override keys with `buildServiceEnvironment` and cross-service consistency with `reconcileServiceOverrides`; validate release with the existing strict release decoder. Reject null live process/args/config for captured loaded pilot services. Reconstruct `Buffer` only from a sealed saved plist file; do not serialize `Buffer.toJSON()` and trust it on input. `ServiceSave.inspection` holds only the existing controller's allowlisted non-secret environment. Capture rejects unsupported env/secret argv rather than copying them to evidence.

These core reusable guards are the implementation, not shorthand for permissive coercion:

```typescript
import { isAbsolute, relative, sep } from "node:path";
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(row, k)) ||
    Object.keys(row).some((k) => !keys.includes(k))
  )
    throw new Error("unexpected record fields");
  return row;
}
export function str(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0\r\n]/.test(value))
    throw new Error("invalid string");
  return value;
}
export function int(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error("invalid integer");
  return value as number;
}
export function literal<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("invalid enum");
  return value as T;
}
export function digest(value: unknown): string {
  const out = str(value, 64);
  if (!/^[a-f0-9]{64}$/.test(out)) throw new Error("invalid SHA256");
  return out;
}
export function uuid(value: unknown): string {
  const out = str(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(out))
    throw new Error("invalid UUID");
  return out;
}
export function path(value: unknown): string {
  const out = str(value);
  if (!isAbsolute(out)) throw new Error("absolute path required");
  return out;
}
export function within(root: string, target: string): boolean {
  const r = relative(root, target);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
export function array<T>(value: unknown, decode: (v: unknown) => T, min = 0, max = 4096): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error("invalid array");
  return value.map(decode);
}
export function fileSeal(value: unknown): FileSeal {
  const o = object(value, ["path", "realpath", "uid", "mode", "dev", "ino", "size", "sha256"]);
  return {
    path: path(o.path),
    realpath: path(o.realpath),
    uid: int(o.uid),
    mode: int(o.mode, 0, 0o777),
    dev: int(o.dev),
    ino: int(o.ino),
    size: int(o.size),
    sha256: digest(o.sha256),
  };
}
export function checkSpec(value: unknown): CheckSpec {
  if (value === null || typeof value !== "object") throw new Error("invalid check");
  const kind = literal((value as { kind?: unknown }).kind, [
    "file-seal",
    "service",
    "process-census",
    "sdk-local",
    "livekit-inventory",
    "admission-status",
  ]);
  const o = object(
    value,
    kind === "file-seal" ? ["id", "kind", "seal"] : kind === "service" ? ["id", "kind", "label"] : ["id", "kind"],
  );
  const id = uuid(o.id);
  if (kind === "file-seal") return { id, kind, seal: fileSeal(o.seal) };
  if (kind === "service") return { id, kind, label: str(o.label, 128) };
  return { id, kind };
}
```

For each remaining record, recursively call these guards for every field in its exact key set; enforce tuple lengths, schemaVersion exactly `1`, booleans exactly `true`/`false`, nullable fields only where declared, unique record/source/check IDs, no duplicate categories in gaps, and all check references resolving to this record. Enforce every inventory category represented by at least one source or a gap. Reject `passed`, `verified`, `authorized`, `command`, `argv`, `shell`, `url`, `env`, `expectedResult` and any other undeclared key at any level. Cap input JSON at 1 MiB; parsing an oversized file fails before reading it all. Tree manifests may be larger, streamed with a 100 MiB/1 million-entry cap and fail closed when exceeded. Do not silently truncate. Duplicate JSON object keys must fail: accept only bytes equal to the canonical encoding below, so duplicates, alternate number spellings and whitespace do not get silently normalized on load.

```typescript
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(row[k])}`)
      .join(",")}}`;
  }
  throw new Error("record contains non-JSON value");
}
export function parseCanonical(bytes: Buffer): unknown {
  if (bytes.length > 1024 * 1024) throw new Error("record too large");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(`${canonical(parsed)}\n`))) throw new Error("noncanonical record");
  return parsed;
}
```

- [ ] **Step 4a.2:** Implement `registerRecord`, `readRegisteredRecord` and `verifySeal`. Registry root is `<canonicalHome>/.hive-state/deployment/registry`; entry directories are `<UUID>/payload.json`, `registration.json`, `files/`. Registration requires the ordinary instance operation lock; only helper capture/bootstrap/hold assessment paths write entries. No `--register-file` or import of a user-authored snapshot is supported. The returned absolute path is exactly `.../<UUID>/payload.json`, and is what existing `--pilot-recovery`/`--legacy-hold` selectors accept.

Registration algorithm: validate selected instance; journal registration intent; create a new 0700 UUID directory with exclusive `mkdir`; copy permitted originals into `files` with exclusive `open` 0600 and fsync; create canonical payload using the strict decoder; fsync it; seal those exact bytes with SHA256, UID, mode, dev/ino, size and realpath; create canonical `registration.json` last, exclusively and durably. Include registry paths in operation `retainedPaths`. No registration may overwrite another. Incomplete directories without a registration commit are retained diagnostic data, never selectable. Register the record hash/reference in the operation record; persist before printing a path. Chunk 5 specifies committed-but-not-yet-linked registration reconciliation. Capture uses its sealed operation draft until validation finishes; no provisional payload is exposed as a registered snapshot.

Read algorithm: canonicalize instance home once, check its UID; require literal normalized selector matching the UUID payload path under that exact root; inspect every path component with `lstat`, rejecting symlinked registry ancestors or files and group/world-writable components. Allow intentional symlink spelling only for the top-level selected home by resolving it first. Registry dirs/files must be same UID and mode 0700/0600 respectively. Open files with `O_NOFOLLOW`, compare `fstat` identity to `lstat`, enforce size cap, read/hash, then compare `fstat` again. Check registration instance/config/UID/kind/ID/operation association and exact payload seal, parse canonical payload, decode recursively, check nested instance and ID agreement. Resolve references only through this same reader and their expected digests. Arbitrary files elsewhere under `.hive-state` are rejected. A same-user adversary rewriting the registry is outside this deployment integrity threat model; registration still never substitutes for current OS/runtime proof.

External runtime seals: do not require Node/system files to be owned by the instance UID if owned by root; require root-or-instance UID and no group/world-write, and require same owner/mode/hash on subsequent reads. Pilot checkouts/dependency roots must be instance UID, not writable by another user. Known symlinks in pilot dependency graphs are allowed only when captured as `{relativePath,target,realpath}` entries and their targets stay within the explicitly sealed closure roots. Do not follow arbitrary new links. Protect `.hive` artifact/registry paths with the stricter no-symlink rules. Record canonical home and explicit selected config spelling; canonical equality identifies the instance, while service selector dictionaries must remain exact.

Tree manifest algorithm: walk every captured executable/module/dependency closure root in sorted relative-path order; record all directories' modes, regular files' size/hash/mode and relative symlink edges plus canonical targets. Do not hash only package.json/lock and infer dependencies unchanged. Capture package lock/version metadata as well as the actual bytes of compiled code, SDK job helpers, RTC native library and Silero/ONNX assets. Exclude `.git` only; reject sockets/devices/unreadable entries. Do not include operator data roots. Rewalk/re-hash before recovery, not just compare the saved manifest to itself. Node/runtime binaries remain explicit external prerequisites. Changes fail recovery preflight before current services stop.

## Task 9 Step 4b: Capture the pilot and gather current observations

- [ ] **Step 4b.1:** Add mutually exclusive internal helper modes `--capture-pilot`, `--inventory-pilot=<registered-snapshot>`, `--prepare-legacy-hold=<registered-snapshot>`, `--verify-legacy-hold=<registered-hold>`, `--release-legacy-hold=<registered-hold>`, `--bootstrap --artifact=<archive> --sha256=<digest> --revision=<40-hex>`. Extend `OperationRecord.mode`/argument parser with exact names, prohibit artifact/tag/normal lifecycle flags outside their applicable modes, and keep existing dry-run before all writes/probes. `--capture-pilot` requires `--bootstrap-record=<registered-bootstrap>`. All non-dry-run commands share the instance lock and frozen helper. These are explicit runbook commands, not normal `hive rollback` fallback. Inventory/verify are read-only against runtime/vendor state; they may write private evidence after locking. `prepare` and `release` are explicitly named admission mutations, never implicit recorded shell execution.

Capture reads the effective live engine/worker definitions through `ServiceController.discoverForCapture` using the operation-owned read-only capability in chunk 5; this discovers an external effective plist without a prior snapshot and grants no stop/start authority. Labels must equal `com.hive.<selected-id>.{agent,voice-worker}`, both loaded and running, exact same selected home/config and allowed environment. Match launchd PIDs to process census PID/start time, executable, cwd and arguments, and require process UID equal the selected instance UID (extend the existing OS adapter's `ps` identity read with `uid=`). Capture original plist bytes/link targets/modes, canonical Node/executables/worker-loader/dependency closures, actual loopback SDK listener and socket owner, current config/dotenv hashes (explicit absence where Keychain-backed loading needs no dotenv), and all four artifact slots including explicit absence. Repeat process and plist readback after hashing; if either PID/start time/definition changed, discard eligibility and report capture unstable. Do not infer SDK port from candidate `portBase + 7`. Enumerate worker-owned loopback listeners via existing process/socket adapter, then GET `/` and `/worker` with 2-second deadlines and require exactly one listener with expected shape/agent name and supervisor ownership. Multiple matches require an inventoried exact port supplied as `--pilot-sdk-port=<integer>` and corroborated the same way.

Capture requires a working current pilot profile first, including bridge authentication through its captured loader, using the sealed `capture-draft` subject defined in chunk 5. Only the active capture operation accepts this subject; lifecycle selectors still require a committed registered snapshot. At initial capture, scope boot/registration logs to the already observed process start time; do not demand a new boot since the capture command or restart the pilot to obtain one. The later recovery profile instead requires new PIDs/start times after its activation fence. It records a baseline, not a maintenance hold or proof of future recovery. New release/boot/heartbeat fields are `legacy/unavailable` in the pilot health result where absent. Keep pilot executable/dependency trees untouched. If complete recovery closure, fresh log scoping, allowed environment, loader or listener cannot be captured, fail with a specific `PILOT_CAPTURE_BLOCKED` code; do not register a usable snapshot.

Detect optional native admission capability only by **all** of: strict `readRelease(runtimeRoot)` with worker capability and lock agreement; worker entrypoint equals that root's declared worker; seal actual bundle bytes; current worker `BootIdentity.release` equals that release; supervisor PID/start time/socket owner corroborates OS identity; current maintenance descriptor's home/instance/boot/PID matches. Store the resulting `hive-maintenance-v1` descriptor. Files with an alleged protocol version or an uncorroborated mailbox do not establish capability. Absent capability means `admission.kind="unavailable"`; this is expected for the described pilot and does not invalidate a recovery snapshot.

- [ ] **Step 4b.2:** Add `pilot` and `pilot-inventory` modes to `runtime-probe.ts`. Invoke only the registered bootstrap probe and captured Node after rechecking their seals, with `buildServiceEnvironment(capturedWorker.definition)` exactly. `pilot` receives a strict `PilotSubject` (registered snapshot or the active capture operation’s sealed draft), expected current worker/engine PID/start time and operation challenge via a private operation input file, not command-line credentials. Chunk 5 defines both selectors, verification and the transition to a committed snapshot. The frozen caller validates the returned envelope and independently obtains OS identities; the probe cannot supply trusted process ownership booleans.

For `workerLoader.kind="legacy-module"`, the probe imports **only** the hash-verified captured sibling `worker-config.js` in a fresh subprocess and invokes its existing `loadWorkerConfig`; verify the dependency closure before importing. For a historical package, `kind="packaged-probe"` selects its **own** captured/sealed `pkg/runtime-probe.min.js` through the exact `hive-pilot-probe/1` ABI specified in chunk 5, verified against that same captured release. The old config/bridge/worker modes at `bc0d47a` do **not** implement that ABI and return `PILOT_PROBE_ABI_UNSUPPORTED`; they expose neither a credential loader nor inventory. The new ABI performs configuration projection, bridge, owner-correlated current telemetry and inventory reads inside the historical loader process and returns only the sealed-subject sanitized result. Credentials never cross that process boundary. This is support for a release built with this production ABI, not a claim that an existing uninstrumented pilot supports it. In the legacy-module branch only, loaded credentials stay in the isolated importing probe for the same reads. Never change protected code to export another API. Missing loader/API compatibility is a failed profile. Imports of candidate config do not prove legacy selectors. Resolve the actual SDK/native module paths using a resolver rooted at the captured entry/loader; verify them against captured roots/versions and OS loaded-file evidence, not probe package dependencies. If a loaded file cannot be independently corroborated where required, report the gap.

`pilot-inventory` uses only existing SDK reads: `RoomServiceClient.listRooms()`, `listParticipants(room.name)` and `AgentDispatchClient.listDispatch(room.name)` for every listed room; `SipClient.listSipDispatchRule()` and `listSipInboundTrunk()` using the pinned 2.14.1 pagination algorithm in chunk 5; unknown client/API compatibility fails explicitly. Record counts, sanitized stable IDs, agent names, timestamps and any unknown ownership/metadata classification. Do not log phone numbers, room/dispatch metadata, participant tokens or raw API responses. Fail closed on pagination/permission/error ambiguity. No room listing can declare `outstanding-assignments` complete: preserve an explicit gap for SDK pending assignment and for project credential-holder inventory, which this API does not expose. Zero results are observations, not a negative proof about unlisted work.

The exact successful `pilot` subprocess result is below; decode it strictly, bound arrays and timestamps, and reject any unknown key. Failure output is `{schemaVersion:1, requestId, classification:<fixed-error-code>}` with exit 1, never raw exception/config/HTTP data. `configIdentity` is a digest of allowlisted instance/database-name/routing/port/voice configuration, excluding secrets and credential-bearing URLs. `dependencyFiles` must cover the manifest's required module/native/model paths. Subject references and all expected paths are supplied by the frozen caller; subprocess output cannot enlarge the allowed closure. `pilot-inventory` uses the same challenge/instance/subject/times envelope with `observations: SourceObservation[]` and explicit `gaps`, plus a private `evidenceDigest`; it never returns a hold boolean.

```typescript
import type { HistoricalIdle } from "./pilot-probe.js";

export type PilotProbeResult = {
  schemaVersion: 1;
  requestId: string;
  instance: InstanceKey;
  subject: PilotSubject; // chunk 5: registered record or operation-owned sealed capture draft
  startedAt: number;
  finishedAt: number;
  classification: "PILOT_OBSERVED";
  configIdentity: Digest;
  bridge: { correctStatus: number; correctClassification: "missing-agent"; missingStatus: number; wrongStatus: number };
  sdk: { host: "127.0.0.1"; port: number; rootStatus: number; agentName: string; activeJobs: number };
  idle: HistoricalIdle | null; // chunk 5: required own-loader status/telemetry for native reads; null only when not requested
  dependencyFiles: { path: string; realpath: string; sha256: Digest; version: string | null }[];
};
```

Resolve the expected live generation before current-result validation: for initial migration it is the snapshot's captured PID/start pair; after pilot recovery it is the latest durably verified `pilot` final inventory referencing that same snapshot/bootstrap in this instance's operation lineage. Revalidate its process identity and unchanged runtime/config seals. A different PID/boot without that checked lineage invalidates the record and requires a fresh capture; no `allow-pid-change` flag. The immutable snapshot retains original historical PIDs/boot; a new hold record records the newly observed recovered PID/start/boot. Native capability must be freshly corroborated against the current descriptor/release, never reuse the snapshot's old bootId as current.

Current-result validation: require matching challenge/instance/subject, `startedAt >= requestStarted`, `startedAt <= finishedAt <= now`, age at most 2 seconds for decisive health reads; correct bridge 400/missing-agent and both denials in `{401,403}`; captured loopback port, root 200, exact agent name; nonnegative integer activeJobs; exact dependency identity set and digest/config equality. The helper independently verifies OS process/socket ownership, PID-fenced fresh logs and file seals before constructing `PilotRecoveryEvidence`. A dependency list, status field, or boolean from an unverified probe file never satisfies the profile. Slow tree checks are completed first and a fresh final probe/OS read then establishes this envelope.

- [ ] **Step 4b.3:** Implement this closed check dispatcher in `pilot.ts`; each case calls a built-in adapter with parameters derived from the registered snapshot and target, not a user-supplied executable or endpoint. `admission-status` is a fresh IPC status request, with no close/release. Define response envelope:

```typescript
export type CheckObservation = {
  schemaVersion: 1;
  requestId: string;
  checkId: string;
  kind: CheckSpec["kind"];
  instance: InstanceKey;
  snapshot: RecordRef;
  toolSha256: Digest;
  startedAt: number;
  finishedAt: number;
  worker: ProcessSeal;
  status: "observed" | "unavailable" | "mismatch";
  evidenceDigest: Digest; // hash of private allowlisted normalized readback retained by this operation
  detail: string; // predefined classification only
};
export function freshObservation(
  o: CheckObservation,
  c: {
    requestId: string;
    checkId: string;
    instance: InstanceKey;
    snapshot: RecordRef;
    toolSha256: Digest;
    worker: ProcessSeal;
    requestedAt: number;
    now: number;
  },
): boolean {
  return (
    o.schemaVersion === 1 &&
    o.requestId === c.requestId &&
    o.checkId === c.checkId &&
    canonical(o.instance) === canonical(c.instance) &&
    canonical(o.snapshot) === canonical(c.snapshot) &&
    o.toolSha256 === c.toolSha256 &&
    canonical(o.worker) === canonical(c.worker) &&
    o.startedAt >= c.requestedAt &&
    o.finishedAt >= o.startedAt &&
    o.finishedAt <= c.now &&
    c.now - o.finishedAt <= 2000 &&
    o.status === "observed"
  );
}
```

| Check kind          | Execution/readback and failure                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-seal`         | `verifySeal` on the registered file, using fd identity/hash and root rules above; report match or mismatch; never read a JSON `held` field                                                                                                                     |
| `service`           | only the snapshot's two labels; `ServiceController.inspect`, compare live PID/start/args/cwd/config/environment/plist/link; target mismatch fails                                                                                                              |
| `process-census`    | `ServiceController.processCensus`, worker descendants, process starts and open executable/cwd/socket paths via existing OS adapter; also inventory engine descendants/MCP command paths privately; unknown ownership is a gap, never a kill target             |
| `sdk-local`         | captured `127.0.0.1` listener, GET `/` and `/worker`, exact status/agent name/nonnegative integer job count; OS socket owner before/after must match same live worker                                                                                          |
| `livekit-inventory` | sealed `pilot-inventory` subprocess above; no arbitrary URL/method accepted; all IDs classified or reported unknown                                                                                                                                            |
| `admission-status`  | `requestMaintenance` status to the verified capable runtime, random fresh request UUID, record's operation/boot; validate envelope and SDK/Mongo idle evidence through chunk 5’s exact own-loader observe/idle ABI and strict parsers; open health uses `freshAdmissionStatus`, closed same-owner proof uses chunk 5’s `freshClosedAdmissionStatus`; absent capability returns unavailable |

Fresh timestamps come from adapter execution, not supplied record values. A historical observation file is never consumed as current. Registering a 5-minute-old hold record is allowed for diagnosis, but no time-based TTL makes it usable: rerun required checks in this invocation and final barrier readback within 2 seconds before the stop fence. Clock reversal, future times, stale response, PID reuse, boot change, changed descriptor, changed source files or failed hashes invalidate the attempt. Slow inventory/hash work occurs before the final 2-second window; recheck seals/identities and decisive gate+idle readback at the end. If freshness cannot be maintained, defer.

## Task 9 Step 4c: Inventory completeness, hold proof and release

- [ ] **Step 4c.1:** Produce `SourceObservation` from the actual capture/probe/OS readers. Each inventory class is mandatory, including unknown/absent evidence represented explicitly. Never offer an operator-entered `allSourcesEnumerated=true`. `locator` text can describe an inventoried surface but cannot carry executable instructions. Inventory and sanitized operational notes must cover:

| Category                    | Required scope; what fails the external legacy proof                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent sessions              | all target engine child/grandchild sessions, their active stdio MCP servers and reusable session/tool registrations; future registration disabled does not stop existing servers                                        |
| scheduled and queued        | target scheduler/cron/background/meeting/code task/automation producers capable of initiating an agent session with `voice-livekit`; enumerate actual store/service/file from inventory; unknown pending state is a gap |
| local scripts/services      | local CLI/SDK/manual scripts, launchd jobs, checker/automation entries and open terminals with project credentials; a process census cannot prove absence of later manual invocation                                    |
| SIP rules                   | all same-project inbound trunk/rule matches, room agent configuration and rules dispatching `hive-voice`, including shared resources; no mutation to shared/Keepur rules                                                |
| room/token dispatch         | current room dispatches/participants and token/room configuration auto-dispatch producers; listing current rooms is not completeness of future dispatch                                                                 |
| external credential holders | remote dashboards/services/manual users/API keys capable of dispatch to the project; no claim that local config or LiveKit room-list access inventories these                                                           |
| other workers               | other `hive-voice` registrations/local supervisors and shared-project routing; unknown worker identity/routing cannot be assigned to dodi                                                                               |
| outstanding assignments     | request accepted before hold, RPC/dispatch creation in flight, accepted/unassigned, assigned/launching, live job, child cleanup/terminal completion; activeJobs/activeCalls zero omit the first states                  |

For the old runtime these readers usually generate concrete gaps. They must not establish a hold by stopping the engine, killing MCP children, disabling shared trunks, deleting dispatches or changing pilot files. A proposed external procedure is recorded in operational notes for review; it is not executed by the check dispatcher. Native admission, when independently proved present, fences the **single worker acceptance ingress**, so it can cover all listed upstream categories even where producers cannot be enumerated globally. Persist those categories as unknown upstream inventory with explicit `admission-ledger` accounting, never mislabel them fully inventoried. This distinction is carried into T9 evidence.

- [ ] **Step 4c.2:** `prepareLegacyHold(snapshot)` runs under the same lifecycle operation that owns any close. First revalidate registration, current pilot process/paths/config/health and inventory. If native capability is unavailable, register a `HoldRecord` with `procedure.kind="unavailable"`, explicit observation-only accounting/gaps and return `MIGRATION_PENDING`, exit 1, no service signals/close/artifact stage. This is the production response for the described pilot unless an independently reviewed external adapter is later supplied.

For a capable historical runtime, use existing `maintenanceQuiescenceIO` + `quiesce` with chunk 5’s operation-bound historical `inspect` (open baseline, owning closed post-close/final Mongo/SDK/IPC reads; never the old random-operation worker mode): same-boot close, at most 30 seconds, complete accepted ledger, SDK-active jobs and telemetry-active calls zero, no persistence fault; require local control of **every** accepted request on that supervisor. Persist `barrierOperationId` and PID/boot before sending close. The operation remains live and owns the lock while closed; do not create a detached hold whose helper dies and auto-reopens its gate. Thus `--prepare-legacy-hold` by itself is a diagnostic **prepare/verify/release** exercise: register the readback then release/verify and exit; its record is reusable as a selector but never as an already-held claim. An update with `--legacy-hold` selects its captured inventory/snapshot, acquires its own new close under the update operation and registers a fresh attempt record. Reapply always does the same. A detached or old record cannot retain a barrier or authorize a stop.

Keep the positive proof private to `pilot.ts`, never exported as a JSON parser or boolean constructor:

```typescript
// NativeGateReadback is populated only by the concrete IPC/OS/probe adapters.
interface NativeGateReadback {
  operationId: string;
  requestId: string;
  requestedAt: number;
  observedAt: number; // oldest start of required IPC, SDK, telemetry and OS reads; never envelope completion
  completedAt: number;
  observedMono: number; // oldest local monotonic start, never supplied by the subprocess
  completedMono: number;
  worker: ProcessSeal;
  bootId: string;
  closedOperationId: string | null;
  admission: "open" | "closed";
  unresolvedAccepted: number;
  sdkActiveJobs: number;
  telemetryActiveCalls: number;
  telemetryUpdatedAt: number; // validated same-boot supervisor heartbeat from the historical Mongo query
  persistenceFault: boolean;
  sdkRootStatus: number;
  sdkAgentName: string;
  socketOwner: ProcessSeal;
}
const proofs = new WeakMap<object, { operationId: string; worker: ProcessSeal; bootId: string; observedAt: number; expiresAt: number; observedMono: number; expiresMono: number }>();
function proveNativeHold(
  r: NativeGateReadback,
  e: {
    operationId: string;
    requestId: string;
    requestedAt: number;
    worker: ProcessSeal;
    bootId: string;
    now: number;
    nowMono: number;
  },
): object {
  const match = canonical(r.worker) === canonical(e.worker) && canonical(r.socketOwner) === canonical(e.worker);
  if (
    !match ||
    r.operationId !== e.operationId ||
    r.requestId !== e.requestId ||
    r.requestedAt !== e.requestedAt ||
    r.observedAt < e.requestedAt ||
    r.observedAt > r.completedAt ||
    r.completedAt > e.now ||
    e.now - r.observedAt > 2000 ||
    !Number.isFinite(r.observedMono) || !Number.isFinite(r.completedMono) || !Number.isFinite(e.nowMono) ||
    r.observedMono > r.completedMono || r.completedMono > e.nowMono ||
    e.nowMono - r.observedMono > 2000 ||
    r.bootId !== e.bootId ||
    r.closedOperationId !== e.operationId ||
    r.admission !== "closed" ||
    r.unresolvedAccepted !== 0 ||
    r.sdkActiveJobs !== 0 ||
    r.telemetryActiveCalls !== 0 ||
    !Number.isSafeInteger(r.telemetryUpdatedAt) || r.telemetryUpdatedAt > e.now ||
    e.now - r.telemetryUpdatedAt > 60_000 ||
    r.persistenceFault ||
    r.sdkRootStatus !== 200 ||
    r.sdkAgentName !== "hive-voice"
  )
    throw new Error("legacy hold not proved");
  const proof = Object.freeze({});
  proofs.set(proof, { operationId: e.operationId, worker: e.worker, bootId: e.bootId, observedAt: r.observedAt, expiresAt: Math.min(r.observedAt + 2000, r.telemetryUpdatedAt + 60_000), observedMono: r.observedMono, expiresMono: Math.min(r.observedMono + 2000, e.nowMono + r.telemetryUpdatedAt + 60_000 - e.now) });
  return proof;
}
function consumeHold(proof: object, operationId: string, worker: ProcessSeal, bootId: string, now: number, nowMono: number): void {
  const p = proofs.get(proof);
  proofs.delete(proof);
  if (
    !p ||
    !Number.isSafeInteger(now) ||
    p.operationId !== operationId ||
    canonical(p.worker) !== canonical(worker) ||
    p.bootId !== bootId ||
    now < p.observedAt ||
    now > p.expiresAt ||
    !Number.isFinite(nowMono) || nowMono < p.observedMono || nowMono > p.expiresMono
  )
    throw new Error("fresh operation hold required");
}
```

The public adapter offers `withVerifiedPilotStop(operation, selectedRecord)` with a fixed worker-bootout adapter; do not accept an arbitrary callback that could signal after a delay. Revalidate capable runtime provenance/inventory, collect final IPC/SDK/telemetry/OS evidence, obtain the private proof, perform the last OS check and `proveBarrierBeforeStop`, then persist `signalsBegun`. Pass the same proof into the controller’s final `beforeExec` fence: `consumeHold` runs **after** every awaited persistence/process check, synchronously immediately before invoking `execFile("launchctl", ["bootout", target])`, with no await, queue or write between the check and invocation. This is the actual signal-entry fence, not entry to a higher-level async bootout method. The proof expires at the earlier of oldest decisive read plus 2000 ms and validated supervisor heartbeat plus 60,000 ms; proof construction, later IPC and signals persistence never renew it. A proof is single-use and cannot be deserialized. If expired before any signal, gather an entirely new set of all decisive observations and a new proof within the original 30-second maintenance deadline, or terminal-release/defer; never refresh only IPC. A conservative persisted signals fence can cause checked recovery after a crash without an actual signal. Clock reversal/future readings fail; track monotonic elapsed time alongside wall time and reject when either original deadline is exceeded.

- [ ] **Step 4c.3:** Release uses the existing terminal release acknowledgement: operation ID on envelope, same supervisor/boot, null snapshot operationId, gate open, persistence durable. A fresh open status alone is insufficient. On pre-signal timeout/error, release even if the close could have arrived late; do not forget the recorded barrier because local `barrierEstablished` is false. No detach/TTL/replayed JSON can settle the operation. Missing ack persists `unresolved`, retains lock/evidence, exit 1. A successful release records `released` in a separate immutable result record; it never edits the old hold payload.

After confirmed worker/descendant exit, a native local hold terminates with that supervisor; record `supervisor-exited` rather than pretending to receive a release from a dead process. Verify the next pair's admission is open before final success. External hold release is unavailable in v1; a manual command note is not an executable release adapter. `--release-legacy-hold` invokes concrete reconciliation for a still-owned recorded operation or freshly verifies it already terminated/released; foreign/current-operation ownership returns busy. It never clears another operation's gate. Final S12 evidence includes establishment, both checks, release/exit outcome and timestamps, or explicit unavailable reasons.

## Task 8 Step 5a: Pilot migration, recovery and reapply adapters

- [ ] **Step 5a.1:** Extend the durable prior snapshot with `schemaVersion`, selected instance, complete `ServiceSave[]`, artifact inventory, operation kind, recorded host Node/npm, bootstrap/snapshot/hold references and hashes, prior process identities, config/environment, activation/log fences and final resolution inventory. This is the source for both normal and interrupted recovery. Export `capturePrior`, `loadPrior`, `restorePrior` and profile-specific `verifyPrior` from the lifecycle boundary; `main.ts` and `reconcile.ts` must use these same functions. Older incomplete records at `bc0d47a` cannot be reconstructed by guessing omitted definition bytes; if encountered, report the exact missing snapshot field and retain unresolved.

- [ ] **Step 5a.2:** In `lifecycle.ts`, replace the unconditional pilot deferral with registration/current assessment, not a permissive flag. First migration (`update --artifact --legacy-hold`) must have an immutable registered snapshot+bootstrap selected by that hold, exact instance agreement and clean candidate revision/archive digest. Validate recovery trees, config baselines and current pilot profile before artifact mutations. Missing/incompatible hold returns the executed pending result before stage/signals. If native-capable hold exists, stage with existing `resolveArtifact`, `extractAndValidateArtifact(..., true)`, `installAndPreflightStage`, while both services remain running, then establish/finally prove the **new operation's** hold. Failure releases correctly.

Select and validate the registered pilot reference before constructing the lifecycle controller: pass its exact `capturedPilotProfile` paths, reconstruct the observed legacy `ServiceDefinition`s, and use those definitions for pilot inspection/bootout. Candidate generated definitions are used only after pilot exit; never compare a pilot PID against the candidate `.hive` entrypoint. Extend the controller's captured-definition validation to require the registered external executable/loader seals, exact label/home/config and process match before permitting captured pilot stop/start. Do not call `readRelease(<home>/.hive)` to identify a pilot running elsewhere or demand its unused installed old `.hive` be a capable package. Preserve that directory exactly by device/inode, manifest if available, and sealed ownership snapshot. Use `ArtifactRotation` for instance-owned directories only, retaining captured original `.prev`/`.broken` rules. First migration with `.hive` absent uses the same intended/observed identity fences: reserve `.broken` as usual, retain any `.prev` at its existing position, then move owned `.next` to absent `.hive`; on failed activation move that candidate to owned `.broken` and restore captured absence at `.hive`, preserving the original `.prev`. Do not fabricate an empty current package to satisfy a normal update helper. All pilot roots are read-only references, never rename targets. On success `.hive` is the candidate and `.prev` may be legacy/incompatible; public ordinary rollback still rejects it. Retain bootstrap package/dependencies/archive and pilot registration/trees through the exercise; package presence does not make pilot recovery independent.

- [ ] **Step 5a.3:** `--pilot-recovery=<registered-snapshot>` is legal only when a resolved first-migration operation under this instance references that same snapshot/bootstrap and selected candidate. Verify that durable lineage and current candidate identity, complete retained artifacts, current configs, seals and usable pilot profile prerequisites before stopping anything. Snapshot registration alone does not authorize switching an arbitrary installed instance to some old tree.

Capture the current packaged pair as this rollback operation's `priorProfile="packaged"`; its recovery route is the current candidate. Quiesce it through normal maintenance. Stop worker/descendants then engine. **Pilot rollback changes service definitions only:** retain the complete candidate at its already operation-owned `.hive` slot, with exact device/inode/release/archive lineage recorded in this operation's snapshot and `retainedPaths`. Do not rename or dispose it, and do not restore an unrelated installed old `.hive` merely because the pilot ran elsewhere. `.prev`/`.broken` positions remain exactly as captured immediately before this rollback. The pilot runs from its captured external paths; an installed candidate manifest is never reported as that pilot's running identity. On rollback failure restore candidate definitions and full packaged health from that retained `.hive`, without artifact rotation.

Deserialize `ServiceSave` only after verifying plist backup seals; provide `capturedPilotProfile` paths to `ServiceController` as the exact allowed historical targets. Restore service **files/links/enabled state first with services unloaded**, then engine bootstrap and fresh boot verification, then worker bootstrap and pilot profile. Refactor `ServiceController.restore` into `restoreFilesAndState`, `restoreEngine`, `restoreWorker` (or an ordered phase callback) rather than let its current loop bootstrap worker before the caller checks engine. Existing packaged recovery must use this ordering too. Compare effective live definitions to captures, not just written plist bytes. If an original plist lives outside the instance (including a protected pilot checkout), verify its captured seal and leave that file untouched; restore only the target instance LaunchAgent link to that exact existing target. Missing/changed external originals block preflight rather than being rewritten from backup. Instance-owned generated plist paths may be restored from their sealed backups. Capture both effective external target and instance-owned file/link state in the distinct `effectivePlist` and `instancePlist` fields defined above; chunk 5 specifies their separate seals and restoration ordering, including distinct sentinel bytes.

Pilot health: use existing `pilotRecovered`, populating every boolean from current adapters. New process PID/start time must be observed after that activation fence and differ from the stopped generation; definitions and runtime hashes still match the captured baseline. Before bootstrap record engine log device/inode+byte offset and start fence; read only append bytes from that same file, parse fresh ordered `Hive starting up` then `Hive is running` records. Require timestamps after fence and current process creation, service stdout ownership, and exact supported logger PID association if present. If legacy logs omit PID, corroborate exclusive single writer via OS open-file readback and fresh PID before/after the bounded log interval; concurrent/rotated/truncated/unattributable logs fail. Never use log offset zero or candidate engine identity files to claim pilot freshness.

For worker registration, root `/` must return 200 and `/worker` agent `hive-voice` on captured port, socket owner equal new pilot supervisor, and fresh SDK `registered worker` log read from that activation's worker log offset tied to that PID using the same attribution rule. A current heartbeat alone does not replace registration. Bridge uses captured loader/env and exact no-turn request. Rehash recovery runtime closure immediately before bootstrap, compare native/module paths/lock versions, and confirm process/socket identities again at final health. Missing legacy fields remain explicitly unavailable; do not call `packagedHealthy` on the pilot.

- [ ] **Step 5a.4:** Failed first migration restores exact original artifact positions and pilot definitions, then requires the complete pilot profile; return nonzero even if recovery passes. Failed pilot rollback restores captured candidate directory/service positions and verifies the packaged profile. Do not release/declare availability using the wrong profile. Any restoration failure retains primary+recovery errors and owned paths with `unresolved`; do not start a conflicting pair on occupied ports. Existing one-generation `.broken` cleanup rules still apply and never delete the candidate retained in `.hive` while the pilot is live, registered recovery files, bootstrap tools or a referenced pilot tree.

Reapply selects the exact retained archive SHA from migration lineage, verifies immutable tooling/archive, current pilot instance/profile and newly gathered inventory. Obtain a **fresh** hold under the reapply operation; a pre-rollback record cannot prove the new pilot boot. Stage through the ordinary candidate install path; restore full packaged profile. Even when installed `.hive` has the same candidate identity, live pilot definitions mean this is not a healthy compare/no-op: hold and stop the live pilot, rotate/install/start the candidate using the recorded definitions. Normal reapply rotation retains the earlier known-good candidate at `.prev`, so independent packaged rollback can now be verified. Retain it until reapply succeeds, applying ordinary one-generation cleanup only to superseded owned slots after durable health, never to the sole candidate or historical pilot route. Future ordinary updates/rollbacks of packaged generations do not read pilot records.

## Task 8 Step 1a: Concrete next-invocation reconciliation

- [ ] **Step 1a.1:** Implement `reconcile.ts`, replacing `main.ts`'s unconditional existing-lock refusal with `inspectOrReconcile` **before new acquisition**, but after dry-run. Reuse `reconcileInterruptedOperation` phase/ownership gates. Validate strict current/operation/owner records and canonical target/config/UID/path/hash matches first. Both original invoking parent and frozen child identities must be recorded as `{pid,startTime}`; ownership transfers durably to the frozen child before effects, while the parent remains a liveness participant. If either exact process is live return busy. A PID reused with another start time is not the original owner. This prevents a dead parent from allowing recovery against a live frozen helper.

Serialize recovery contenders with exclusive `<existing-lock>/reconcile` directory and owner record, never by unlinking the original lock. After acquiring it, re-read every original record and liveness fence. The recovery executor is the **original** hash-verified frozen helper at its recorded path, started with internal `--reconcile-operation=<exact-operation-path>`; validate this mode's target/hash and no user lifecycle flags. Record recovery executor PID/start time before it mutates state. A live reconciler returns busy; an abandoned recovery claim can be taken over only after the same owner/current/file/service validation, preserving an immutable attempt record. Metadata missing after mkdir is ambiguous and stays unresolved; no age-based lock removal. Recovery uses the original helper/schema semantics, not the newly downloaded candidate's assumptions.

- [ ] **Step 1a.2:** Dispatch by the durable operation work kind before constructing lifecycle adapters. Chunk 5 defines bootstrap and registry reconciliation, which never require a prior service pair or lifecycle slot inventory. The following `InterruptedOperationIO` adapters apply **only to lifecycle work**:

| Adapter/phase                                | Exact action                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownerIsLive`                                | existing OS census/process identity via `ServiceController`; compare PID and startTime; unavailable OS readback is unresolved, not dead                                                                                                                                                                                                                             |
| `releaseBarrier`, no signals                 | load captured same worker PID/boot and local descriptor; issue fresh terminal `release` for recorded barrierOperationId via shared maintenance client; validate ack and process identity. If worker exited, do not fake ack: prove its exit/descendant absence and current pair/open admission through profile before resolving; unknown new owner stays unresolved |
| `reconcileFilesystem`, no signals            | validate prior snapshot/current live pair unchanged; reconcile last intended/observed rename/disposal by exact identities; reverse only this operation's pre-signal reserved broken/previous moves; remove only the owned incomplete `.next` from recorded identity; reconcile beta migration per Step 1b; no generic `rm -rf` or inference from slot names         |
| `recoverAfterSignals`, no durable resolution | reconstruct prior pair from durable `ServiceSave`/slot/last-move data; stop only identified candidate pair and descendants, worker before engine; restore actual identities/definitions in order; verify captured packaged/pilot/stopped profile. Unknown or duplicated identity fails; never overwrite occupied targets                                            |
| durable `healthy`/`recovered` resolution     | first verify the recorded final pair/profile and current retained inventory; complete only its exact pending disposal/restore fence and lock archival. Do **not** call `recoverAfterSignals` and rotate back a healthy accepted release just because signalsBegun is true                                                                                           |
| durable `deferred` resolution                | verify release/unchanged prior pair and owned cleanup complete before removing lock                                                                                                                                                                                                                                                                                 |

Modify `reconcileInterruptedOperation`'s current unconditional `signalsBegun → recoverAfterSignals` branch to distinguish durable verified resolution from unfinished activation. Do not let the adapter return healthy then have the generic function overwrite resolution with `recovered`. `finishOperationLock` only runs after re-read final inventories and durable state; retain exact error codes otherwise. Archive reconciliation result. After successful stale reconciliation, print `PREVIOUS_OPERATION_RECONCILED` and exit nonzero for the originally interrupted failure, **without executing the user's newly requested rotation in that invocation**; a later invocation can start a fresh operation. A recovered interrupted deployment never looks like a successful requested update.

## Task 9 Step 1b: Locked beta-plugin compatibility preflight

- [ ] **Step 1b.1:** Port the existing `src/cli/update-preflight.ts` behavior into `plugin-compat.ts` with explicit instance/operation inputs. Only source `<home>/.hive/plugins/node_modules/<entry>` and destination `<home>/plugins/node_modules/<entry>` are eligible. Enumerate one level as existing code does, treating an npm scope directory as one entry; reject traversal, symlinks/special nodes, foreign owners and writable foreign ancestors. No source means no action. Existing destination means preserve both and record `destination-exists`; never overwrite or merge it. Do not relocate ordinary `<home>/plugins` entries, run npm, sync skills or follow configuration to other directories.

Execute after instance lock/current ownership and migration eligibility checks, before candidate stage; dry-run is read-only. Record source/destination identity, modes, absent destinations and before hashes in `<operation>/plugin-compat.json` before moves. Each rename uses intended/observed durable fence; this compatibility list is separate from artifactMove so it cannot erase artifact recovery intent. Revalidate both paths immediately before rename. Create only missing target directories under selected home with captured modes. After partial failure, restore each completed rename in reverse order only when its exact identity is still at destination and original source absent; occupied/changed source leaves unresolved, no overwrite. Interrupted reconciliation uses the same list/algorithm.

After all renames succeed, persist `compatibility-committed` and exact after hashes before staging; committed relocation is a separate idempotent compatibility action and remains across a later update failure. Operational baseline must explicitly include the authorized beta exception's before/after paths; if it would alter a normal operator plugin baseline or cannot be isolated, defer with `PLUGIN_COMPATIBILITY_PENDING` before stage. Existing no-overwrite behavior remains; a partially completed uncommitted list is not silently accepted. Tests retain the existing update-preflight test coverage and add locked/ownership/crash-boundary cases.

## Task 9 Step 4d: Final stable bootstrap handler

- [ ] **Step 4d.1:** Replace the old runbook-only heredoc as the authoritative interface with `bootstrap.ts`. Entry is the candidate helper from the reviewed tarball, initially extracted into a new private preparation directory under `.hive-state/bootstrap/.prepare-<uuid>` by the host-only archive guard; its digest must be independently compared with the helper member in the reviewed archive before executing. The host extraction command remains documented, but it performs only safe member/type checks, archive SHA check and exclusive extraction; it does not execute unvalidated package code or install dependencies. It uses recorded absolute Node/npm paths, `tar` through `execFile` with literal argument arrays, and no shell evaluation. Candidate SHA/revision values remain review inputs, not inferred from the unpacked package itself.

`--bootstrap --artifact=<absolute-tgz> --sha256=<reviewed-sha> --revision=<reviewed-revision>` validates source helper identity against that archive before freezing, then follows this algorithm under the ordinary lock and chunk 5’s durable bootstrap preparation/install/registration fences: verify digest; use existing `validateArchiveMembers`/`extractAndValidateArtifact` with dirty=false; create `<home>/.hive-state/bootstrap/<sha>/package` exclusively; retain a copied archive at `<sha>/candidate.tgz`; run existing locked install/native diagnostic with recorded absolute npm/Node, sanitized environment and exact success markers; verify `readRelease` revision/lock/version; tree-seal dependencies and helpers; register `BootstrapRecord` last. Resolve/seal npm's real `npm-cli.js` path from the supplied operational PATH and invoke it as `execFile(recordedNode, [recordedNpmCli, "ci", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"])`; do not let an npm shebang choose a different Node. Factor this host invocation through `artifact.ts` for stage/bootstrap/recovery consistency. No service/control/vendor operation or pilot-code mutation. Config preflight is a separate selected-instance probe during capture/update, not proof supplied by offline install.

An existing digest directory is never overwritten or blindly deleted. If it has a complete registration, rerun identity/tree/offline validation and return its existing registered reference; if incomplete, report its exact path/phase and use chunk 5’s mode-aware bootstrap reconciliation. A dead install without committed registration is cleaned only by recorded identity and finishes aborted; a later invocation installs afresh. A committed registration is revalidated offline and retained. Neither route inspects a live service pair. Registry registration is the success commit, not directory existence. The host guard durably records its preparation receipt as specified in chunk 5; ambiguous pre-operation crash leftovers are retained, never inferred from a directory name. Keep the initial preparation directory until its frozen helper finishes; clean only its recorded owned identity after a resolved result. Output whitelist `{status:"BOOTSTRAP_VALIDATED",packageRoot,recordPath,archiveSha256,sourceRevision}`; missing diagnostic success markers fails even on exit 0.

- [ ] **Step 4d.2:** Document these final runbook invocations, populating values from actual S12 inventory. These are **not** drafting commands. Initial host extraction establishes `KPR463_PREPARED_HELPER`; successful bootstrap establishes `KPR463_BOOTSTRAP` and registry paths. Capture and hold preparation do not establish migration acceptance.

The complete host-only initial extraction command is below. Its independently reviewed archive SHA authenticates candidate bytes before the first candidate execution. It prints one prepared path; the operator assigns that exact value to `KPR463_PREPARED_HELPER` without `eval`. Runtime helper/bootstrap validation still performs full manifest/shrinkwrap checks. Required variables are exported explicitly; no secret environment is printed.

```bash
export KPR463_INSTANCE KPR463_INSTANCE_ID KPR463_CONFIG KPR463_ARCHIVE KPR463_SHA KPR463_REVISION
"$KPR463_NODE" --input-type=module <<'JS'
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, mkdirSync, realpathSync, openSync, closeSync, fstatSync,
  writeFileSync, fsyncSync, renameSync, constants } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
const uid = process.getuid();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const input = name => {
  const value = process.env[name];
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`invalid ${name}`);
  return value;
};
const instance = input("KPR463_INSTANCE"), archivePath = input("KPR463_ARCHIVE");
if (!isAbsolute(instance) || !isAbsolute(archivePath)) throw new Error("absolute instance/archive required");
const home = realpathSync(instance), archive = realpathSync(archivePath);
const instanceId = input("KPR463_INSTANCE_ID"), configPath = resolve(home, input("KPR463_CONFIG"));
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(instanceId)) throw new Error("invalid instance ID");
const expected = input("KPR463_SHA"), revision = input("KPR463_REVISION");
if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("reviewed identity required");
const archiveStat = lstatSync(archivePath);
if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || !archive.endsWith(".tgz")) throw new Error("regular archive required");
if (hash(readFileSync(archive)) !== expected) throw new Error("archive digest mismatch");
const options = { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, maxBuffer: 20 * 1024 * 1024 };
const members = execFileSync("/usr/bin/tar", ["-tzf", archive], options).split("\n").filter(Boolean);
const details = execFileSync("/usr/bin/tar", ["-tvzf", archive], options).split("\n").filter(Boolean);
const forbidden = /^(?:hive(?:-[^/]*)?\.yaml|\.env(?:-[^/]*)?|agents|plugins|skills|logs|\.hive-state)(?:\/|$)/;
if (!members.length || details.length !== members.length || details.some(s => !["-", "d"].includes(s[0])))
  throw new Error("archive links/special members rejected");
for (const member of members) {
  if (!member.startsWith("package/") || member.includes("\\") || member.split("/").includes("..") ||
      forbidden.test(member.slice(8))) throw new Error("unsafe archive member");
}
function directory(p) {
  const s = lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o022) !== 0)
    throw new Error("unsafe preparation ancestor");
}
directory(home);
for (const p of [resolve(home, ".hive-state"), resolve(home, ".hive-state/bootstrap")]) {
  directory(dirname(p));
  try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  directory(p);
}
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
function syncDirectory(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function identity(p) {
  directory(p);
  const st = lstatSync(p);
  return { path: p, identity: { dev: st.dev, ino: st.ino, uid: st.uid } };
}
function seal(p) {
  const before = lstatSync(p);
  if (!before.isFile() || before.isSymbolicLink() || ![uid, 0].includes(before.uid) || (before.mode & 0o022))
    throw new Error("unsafe preparation file");
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd);
    if (st.dev !== before.dev || st.ino !== before.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs)
      throw new Error("preparation file changed");
    return { path: p, realpath: realpathSync(p), uid: st.uid, mode: st.mode & 0o777,
      dev: st.dev, ino: st.ino, size: st.size, sha256: hash(bytes) };
  } finally { closeSync(fd); }
}
const prepId = randomUUID(), parentPath = resolve(home, ".hive-state/bootstrap");
syncDirectory(home); syncDirectory(resolve(home, ".hive-state")); syncDirectory(parentPath);
const prepared = resolve(parentPath, `.prepare-${prepId}`);
const receiptPath = resolve(parentPath, `.prepare-${prepId}.json`);
const startTime = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], options).trim();
if (!startTime || /[\r\n]/.test(startTime)) throw new Error("preparer identity unavailable");
const archiveSeal = seal(archive);
if (archiveSeal.sha256 !== expected) throw new Error("archive changed");
const receipt = { schemaVersion: 1, id: prepId,
  instance: { canonicalHome: home, configPath, instanceId, uid },
  owner: { pid: process.pid, startTime }, archive: archiveSeal, reviewedRevision: revision,
  preparedPath: prepared, parent: identity(parentPath), phase: "intended",
  directory: null, helper: null, adoptedOperationId: null };
let receiptIdentity = null;
function persistReceipt() {
  if (receiptIdentity) {
    const s = lstatSync(receiptPath);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid || s.dev !== receiptIdentity.dev || s.ino !== receiptIdentity.ino)
      throw new Error("preparation receipt changed");
  } else {
    try { lstatSync(receiptPath); throw new Error("preparation receipt exists"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const tmp = `${receiptPath}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${canonical(receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, receiptPath);
  syncDirectory(parentPath);
  receiptIdentity = lstatSync(receiptPath);
}
persistReceipt();
mkdirSync(prepared, { mode: 0o700 });
syncDirectory(parentPath);
receipt.directory = identity(prepared); receipt.phase = "created"; persistReceipt();
execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", prepared], options);
receipt.phase = "extracted"; persistReceipt();
const helper = resolve(prepared, "package/pkg/deploy.min.js");
const info = lstatSync(helper);
if (!info.isFile() || info.isSymbolicLink()) throw new Error("candidate helper missing");
const memberBytes = execFileSync("/usr/bin/tar", ["-xOzf", archive, "package/pkg/deploy.min.js"],
  { env: options.env, maxBuffer: options.maxBuffer });
if (hash(readFileSync(helper)) !== hash(memberBytes)) throw new Error("helper digest mismatch");
if (canonical(seal(archive)) !== canonical(archiveSeal)) throw new Error("archive changed during extraction");
receipt.helper = seal(helper); receipt.phase = "validated"; persistReceipt();
console.log(helper);
JS
```

```bash
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_PREPARED_HELPER" --bootstrap --artifact="$KPR463_ARCHIVE" --sha256="$KPR463_SHA" --revision="$KPR463_REVISION"
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/deploy.min.js" --capture-pilot --bootstrap-record="$KPR463_BOOTSTRAP_RECORD"
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/deploy.min.js" --inventory-pilot="$KPR463_PILOT_SNAPSHOT"
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/deploy.min.js" --prepare-legacy-hold="$KPR463_PILOT_SNAPSHOT"
HIVE_HOME="$KPR463_INSTANCE" HIVE_CONFIG="$KPR463_CONFIG" "$KPR463_NODE" "$KPR463_BOOTSTRAP/pkg/deploy.min.js" --verify-legacy-hold="$KPR463_HOLD"
```

An unavailable hold returns exit 1 with `MIGRATION_PENDING`, snapshot/record paths and fixed gap codes (for example `LEGACY_ADMISSION_UNOBSERVABLE`, `EXTERNAL_PRODUCERS_UNFENCED`, `PENDING_ASSIGNMENTS_UNOBSERVABLE`). Do not proceed to Task 12 cutover commands. Release a prepare exercise in its own operation as above; a successful diagnostic release means that historical record is currently open, never still held. Update/reapply runs a new close/check/release-or-exit cycle. Operational S12 can record inventory and bootstrap completion while cutover remains pending; no implementation or fixture result changes that status.

## Task 8 Step 6a / Task 9 Step 5a: Verification and resume gates

- [ ] **Step 6a.1 (S7):** Add source unit tests in new `.test.ts` files and extend existing transaction/CLI tests. Use injected OS/files/probe clocks; no operator configs/Keychain/launchd/vendor calls. Required cases:

| Group                  | Minimum assertions                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema/registration    | unknown/duplicate keys, booleans masquerading as proof, stringified numbers, future timestamps, wrong UID/config/instance/UUID/kind, arbitrary same-state file, altered payload/registration/ref, symlink ancestor/file, chmod/hash/inode change, incomplete registration, oversized inputs all fail before service/artifact actions                      |
| current readback       | stale/replayed challenge, changed PID with same number, different boot/socket owner, copied SDK response, nonzero active/accepted/pending state, heartbeat fresh but unregistered, no record-authorized URL/command/env, service env mismatch and changed dependency files fail                                                                           |
| inventory/hold         | every category retained including unknown external/queued/assignment scope; zero rooms/jobs does not complete assignment accounting; uninstrumented pilot returns real pending report with no close/signal/stage; capable runtime requires actual provenance+gate; old/detached hold cannot authorize; release uses terminal ack even after delayed close |
| pilot capture/recovery | malformed/unrestorable plist, unavailable loader, changed external tree, listener ambiguity, occupied slots and unrelated `.hive` cannot be guessed; reconstruction preserves bytes/modes/links and ordered boot; stale/unattributable logs fail; missing new identity fields remain unavailable                                                          |
| stale recovery         | live parent or child/reconciler busy; abandoned owner with matching records invokes original frozen helper; every rename/disposal fence before/after crash; missing metadata unresolved; same-home aliases serialize; healthy durable result cleanup never rolls back; failures return nonzero and do not start new requested operation                   |
| beta compatibility     | absent source no-op; existing destination untouched; scoped directory and file modes retained; lock required; partial rename crash reverses safely; changed destination unresolved; committed relocation survives later deployment failure; dry-run no write                                                                                              |
| bootstrap/routes       | exact flags/mutual exclusions/absolute selectors; reviewed digest/revision required; retained tooling registration; existing valid tree revalidated; incomplete tree retained; native marker absence fails; no old updater, service mutation, pilot mutation or notification                                                                              |

Commands (run only after implementing these files in the child):

```bash
npm run build
npx vitest run src/deployment/pilot-records.test.ts src/deployment/pilot.test.ts src/deployment/reconcile.test.ts src/deployment/bootstrap.test.ts src/deployment/plugin-compat.test.ts src/deployment/transaction.test.ts src/cli/daemon.test.ts src/cli/update.test.ts
bash service/install.test.sh
bash service/deploy.test.sh
```

Expected: all exit 0, no skipped cases, source-only checkpoint. Keep S7 incomplete until stale reconciliation, locked compatibility preflight, final bootstrap and all evidence/pilot handlers are implemented; a parser that simply throws the old "adapter missing" message is not completion. A thoroughly assessed actual uninstrumented pilot still yields the specified pending result.

- [ ] **Step 5a.1 (S9):** Preserve the original actual S8 packed artifact/frozen-helper lifecycle and adoption tests. Build the candidate first. Add real registered bootstrap/snapshot fixtures, process/launchctl/socket/probe boundary shims and persistent fixture state. Invoke the actual installed candidate CLI/helper from outside the repository; old updater sentinel must never run, self replacement must use its frozen hash, and every proof read goes through the production parser/current adapter. No success JSON fixture may replace the deployment executable.

All first snapshots must be produced by real `--capture-pilot` from an empty snapshot registry, including external effective plists and distinct pre-existing instance plist sentinel files. Execute every additional composed freshness, ABI and crash case in chunk 5 through the actual frozen helper. Test **both** historical-layout variants explicitly: (a) a genuinely legacy fixture with no admission protocol, whose actual helper execution captures available evidence then defers migration/reapply before signals; (b) a compatible historical layout backed by an actual independently built release implementing `hive-pilot-probe/1` outside `.hive` (chunk 5 specifies its separate build, compatibility negative and real process/SDK-read harness), with the real shared admission protocol exercised by the test-owned supervisor/OS boundary, enabling full first-migration, pilot-profile rollback, fresh-held reapply and final packaged profile. The latter proves the implemented protocol-capable branch, not external-hold feasibility for the real uninstrumented pilot. Keep missing-manifest pilot-profile tests independently proving loader/hash/fresh-log/registration reconstruction; do not give them a fabricated admission capability to make cutover pass. Positive externally held uninstrumented-pilot acceptance remains actual S12 work requiring its reviewed real authority adapter.

Inject stop/rename/plist/link/start/bridge/registration/native failures at every stage, confirm exact prior profile and nonzero results; crash the actual frozen process before/after fences and invoke the helper again to exercise production reconciliation. Test existing locks with a live frozen child after parent death. Compare second-instance PIDs/definitions and all operator sentinels. Test rollback/reapply with retained bootstrap and original pilot directories intact, fresh hold record/operation/boot required. No real launchd/LiveKit calls; boundary shims are test-owned and cannot be activated via a production `--trust-fixture` flag.

```bash
npm run bundle
npx vitest run src/deployment/adoption.integration.test.ts src/deployment/lifecycle.integration.test.ts src/deployment/transaction.test.ts
npm run check:artifact
```

Expected: actual S8 artifact/native markers and all automated cases pass, including required negative legacy deferral. This does not pass T9 or remove the later actual hold gate. All original S8 packaging and S9 integration assertions remain required, with fixture profile/capability clearly stated; never claim an uninstrumented pilot migrated from a capable fixture.

- [ ] **Step 6a.2:** Checkpoint S7 completion through the implementation lane after these bounded tests and diff checks. Commit only implemented source/tests for this slice; do not claim packaging before S8, actual frozen execution before S9, or operational migration before S12. No code change is made by this plan revision.

## Revision assumptions and findings

- Applied `implementation/2/capable`: explicit registered schema, allowed check union, provenance/current-result/freshness contract, full dispatch-source and unresolved-work inventory, verified release, captured pilot reconstruction/recovery/reapply, stable bootstrap, concrete stale reconciliation and locked beta compatibility are now scheduled and specified.
- Applied `plan-review/6/frontier`, pilot issue 1 and integration issue 1: operation-sealed first-capture draft, private external-plist discovery and post-validation immutable registration; actual-helper empty-registry capture cases.
- Applied `plan-review/6/frontier`, pilot issue 2: exact production historical probe ABI/projection/SDK read mapping and explicit old-helper incompatibility, independently built matching H fixture.
- Applied `plan-review/6/frontier`, pilot issue 3: original wall/monotonic evidence expiry survives proof construction and signals persistence through actual OS dispatch, with composed boundary tests.
- Applied `plan-review/6/frontier`, integration issue 2: discriminated bootstrap/registry durable phases, install/probe child ownership, commit reconciliation and per-mode terminal results without a fictional lifecycle prior.
- Applied `plan-review/6/frontier`, pilot advisories 1 and 2: separate closed-owner validator and separately sealed effective/instance plist roles with distinct sentinel restoration tests.
- Applied `plan-review/7/frontier`, pilot issue 1: production historical owner-correlated observe/idle ABI now queries its own Mongo configuration, validates current count/supervisor/heartbeat/deadlines, and supplies baseline/post-close/final proof; actual independently built H/C Mongo-boundary cases are required.
- Applied `plan-review/7/frontier`, integration issue 1: fixed bootstrap/lifecycle extraction, lifecycle fetch/install and nested diagnostic/probe jobs now share durable guardian/go/lineage fences; actual tar/npm/install-descendant orphan tests cover before/after writer exit in bootstrap, ordinary update and reapply.
- No finding declined. The approved spec is unchanged.
- The described pilot is uninstrumented; no live readback or external fence was performed/established during drafting. Its operational migration remains pending by the approved conditional contract. A newly discovered external authority requires a reviewed concrete adapter; no assumption makes it pass.
- Native protocol support is accepted only from an independently verified capable runtime already present. No protected-pilot retrofit is authorized or planned.
- S0–S6 and partial S7 at `bc0d47a` are preserved. Source interfaces may be factored for reconstruction, but completed unrelated plan sections and S8/S9/S12 gates remain intact.
