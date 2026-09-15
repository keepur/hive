/**
 * Strict registered pilot evidence (KPR-463 plan chunk 4 Task 9 Step 4a, chunk
 * 5 Task 9 Step 4b.1a and Task 8 Step 1a.3 Step 2).
 *
 * Every serialized record uses exact-key decoding, safe integers and bounded
 * strings/arrays. JSON is data only: no record field authorizes an action, and
 * a record's own hash never authenticates itself. Registered records live under
 * `<canonicalHome>/.hive-state/deployment/registry/<UUID>/` as a canonical
 * `payload.json`, immutable `files/` and a `registration.json` written last.
 * Only the helper's capture/bootstrap/hold-assessment paths write entries,
 * under the ordinary instance operation lock; there is no import of a
 * user-authored record. Reading re-verifies every path component, owner, mode,
 * no-follow fd identity and byte seal. Registration never substitutes for
 * current OS/runtime proof.
 *
 * Builtin-only apart from shared deployment decoders.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { decodeServiceDefinition, decodeServiceInspection } from "./prior.js";
import { parseReleaseManifest, type Release } from "./release.js";
import { reconcileServiceOverrides, type ServiceDefinition, type ServiceInspection } from "./services.js";
import type { ProcessSeal } from "./stop-proof.js";
import { decodeOperationRecord, persistOperation, type AcquiredOperation } from "./operation.js";

export type { ProcessSeal } from "./stop-proof.js";

// ── core guards (chunk 4 Step 4a.1) ───────────────────────────────────────

export type Digest = string;
export type RecordRef = { id: string; sha256: Digest };
export type InstanceKey = { canonicalHome: string; configPath: string; instanceId: string; uid: number };

export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 100 * 1024 * 1024;
export const MAX_MANIFEST_ENTRIES = 1_000_000;

export class RecordDecodeError extends Error {}
export class SealMismatchError extends Error {}
export class RegistryUnresolvedError extends Error {}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RecordDecodeError("object required");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !keys.includes(key))
  ) {
    throw new RecordDecodeError("unexpected record fields");
  }
  return row;
}

export function str(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) {
    throw new RecordDecodeError("invalid string");
  }
  return value;
}

export function int(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RecordDecodeError("invalid integer");
  }
  return value as number;
}

export function bool(value: unknown): boolean {
  if (value !== true && value !== false) throw new RecordDecodeError("invalid boolean");
  return value;
}

export function literal<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new RecordDecodeError("invalid enum");
  return value as T;
}

export function digest(value: unknown): Digest {
  const out = str(value, 64);
  if (!/^[a-f0-9]{64}$/.test(out)) throw new RecordDecodeError("invalid SHA256");
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid(value: unknown): string {
  const out = str(value, 36);
  if (!UUID_PATTERN.test(out)) throw new RecordDecodeError("invalid UUID");
  return out;
}

export function path(value: unknown): string {
  const out = str(value);
  if (!isAbsolute(out) || resolve(out) !== out) throw new RecordDecodeError("absolute normalized path required");
  return out;
}

export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function array<T>(value: unknown, decode: (item: unknown) => T, min = 0, max = 4096): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new RecordDecodeError("invalid array");
  return value.map(decode);
}

function nullable<T>(value: unknown, decode: (item: unknown) => T): T | null {
  return value === null ? null : decode(value);
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new RecordDecodeError(`duplicate ${name}`);
}

// ── serialized types ──────────────────────────────────────────────────────

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
  /** Private sorted relative file/link inventory, never executable. */
  manifest: FileSeal;
};

export type ServiceSave = {
  definition: ServiceDefinition;
  inspection: ServiceInspection;
  effectivePlist: { source: FileSeal; saved: FileSeal };
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

export type WorkerLoader =
  | { kind: "legacy-module"; file: FileSeal }
  | { kind: "packaged-probe"; file: FileSeal; runtimeRoot: string; release: Release; abi: "hive-pilot-probe/1" };

export type SnapshotAdmission =
  | { kind: "unavailable" }
  | { kind: "hive-maintenance-v1"; runtimeRoot: string; release: Release; workerBundle: FileSeal; bootId: string };

export type PilotSnapshot = {
  schemaVersion: 1;
  kind: "pilot-snapshot";
  id: string;
  instance: InstanceKey;
  capturedAt: number;
  captureOperationId: string;
  toolSha256: Digest;
  bootstrap: RecordRef;
  services: [ServiceSave, ServiceSave];
  runtime: {
    engine: ProcessSeal;
    worker: ProcessSeal;
    engineEntry: FileSeal;
    workerEntry: FileSeal;
    workerLoader: WorkerLoader;
    node: FileSeal;
    roots: TreeSeal[];
    sdkListener: { host: "127.0.0.1"; port: number; agentName: "hive-voice" };
    bridgePort: number;
  };
  configIdentity: Digest;
  configFiles: { path: string; seal: FileSeal | null }[];
  slots: [ArtifactSlot, ArtifactSlot, ArtifactSlot, ArtifactSlot];
  admission: SnapshotAdmission;
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
  locator: string;
  checks: string[];
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

export type HoldProcedure =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "hive-maintenance-v1";
      operationId: string;
      bootId: string;
      establish: "request-close";
      verify: "fresh-status-and-ledger";
      release: "terminal-release-or-confirmed-supervisor-exit";
    };

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
  procedure: HoldProcedure;
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

export type RegistrationKind = "pilot-snapshot" | "legacy-hold" | "bootstrap";

export type Registration = {
  schemaVersion: 1;
  id: string;
  kind: RegistrationKind;
  instance: InstanceKey;
  operationId: string;
  createdAt: number;
  payload: FileSeal;
};

export type PilotSubject =
  { kind: "registered"; snapshot: RecordRef } | { kind: "capture-draft"; operationId: string; draftSha256: Digest };

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
  validation: FileSeal | null;
  registration: RecordRef | null;
};

// ── decoders ──────────────────────────────────────────────────────────────

const MAX_TIME = 8_640_000_000_000_000;

function time(value: unknown, now?: number): number {
  const out = int(value, 0, MAX_TIME);
  if (now !== undefined && out > now) throw new RecordDecodeError("future timestamp");
  return out;
}

export function recordRef(value: unknown): RecordRef {
  const o = object(value, ["id", "sha256"]);
  return { id: uuid(o.id), sha256: digest(o.sha256) };
}

export function instanceKey(value: unknown): InstanceKey {
  const o = object(value, ["canonicalHome", "configPath", "instanceId", "uid"]);
  const instanceId = str(o.instanceId, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(instanceId)) throw new RecordDecodeError("invalid instance ID");
  return {
    canonicalHome: path(o.canonicalHome),
    configPath: path(o.configPath),
    instanceId,
    uid: int(o.uid, 0, 0x7fffffff),
  };
}

export function fileSeal(value: unknown): FileSeal {
  const o = object(value, ["path", "realpath", "uid", "mode", "dev", "ino", "size", "sha256"]);
  return {
    path: path(o.path),
    realpath: path(o.realpath),
    uid: int(o.uid, 0, 0x7fffffff),
    mode: int(o.mode, 0, 0o7777),
    dev: int(o.dev),
    ino: int(o.ino),
    size: int(o.size),
    sha256: digest(o.sha256),
  };
}

export function treeSeal(value: unknown): TreeSeal {
  const o = object(value, ["path", "realpath", "uid", "dev", "ino", "manifest"]);
  return {
    path: path(o.path),
    realpath: path(o.realpath),
    uid: int(o.uid, 0, 0x7fffffff),
    dev: int(o.dev),
    ino: int(o.ino),
    manifest: fileSeal(o.manifest),
  };
}

export function processSeal(value: unknown): ProcessSeal {
  const o = object(value, ["pid", "startTime", "executable", "command", "cwd"]);
  return {
    pid: int(o.pid, 1, 0x7fffffff),
    startTime: str(o.startTime, 64),
    executable: path(o.executable),
    command: str(o.command, 8192),
    cwd: path(o.cwd),
  };
}

export function release(value: unknown): Release {
  try {
    return parseReleaseManifest(value);
  } catch (error) {
    throw new RecordDecodeError("invalid release", { cause: error });
  }
}

export function serviceSave(value: unknown): ServiceSave {
  const o = object(value, ["definition", "inspection", "effectivePlist", "instancePlist", "link", "loaded", "enabled"]);
  let definition: ServiceDefinition;
  let inspection: ServiceInspection;
  try {
    definition = decodeServiceDefinition(o.definition);
    inspection = decodeServiceInspection(o.inspection);
  } catch (error) {
    throw new RecordDecodeError("invalid captured service", { cause: error });
  }
  const effective = object(o.effectivePlist, ["source", "saved"]);
  const instance = object(o.instancePlist, ["path", "existed", "saved", "mode"]);
  const link = object(o.link, ["path", "existed", "target"]);
  const save: ServiceSave = {
    definition,
    inspection,
    effectivePlist: { source: fileSeal(effective.source), saved: fileSeal(effective.saved) },
    instancePlist: {
      path: path(instance.path),
      existed: bool(instance.existed),
      saved: nullable(instance.saved, fileSeal),
      mode: nullable(instance.mode, (item) => int(item, 0, 0o7777)),
    },
    link: { path: path(link.path), existed: bool(link.existed), target: nullable(link.target, (item) => str(item)) },
    loaded: bool(o.loaded),
    enabled: bool(o.enabled),
  };
  if (save.definition.label !== save.inspection.label) throw new RecordDecodeError("service label mismatch");
  if (save.instancePlist.existed !== (save.instancePlist.saved !== null && save.instancePlist.mode !== null)) {
    throw new RecordDecodeError("instance plist existence inconsistent");
  }
  if (!save.instancePlist.existed && (save.instancePlist.saved !== null || save.instancePlist.mode !== null)) {
    throw new RecordDecodeError("absent instance plist carries a backup");
  }
  if (save.link.existed !== (save.link.target !== null)) throw new RecordDecodeError("link target inconsistent");
  if (save.effectivePlist.source.sha256 !== save.effectivePlist.saved.sha256) {
    throw new RecordDecodeError("effective plist backup does not seal the source bytes");
  }
  if (
    save.loaded &&
    (save.inspection.process === null ||
      save.inspection.args === null ||
      save.inspection.configSelection === null ||
      save.inspection.serviceEnvironment === null)
  ) {
    throw new RecordDecodeError("captured loaded pilot service lacks live process, arguments or configuration");
  }
  return save;
}

function artifactSlot(value: unknown): ArtifactSlot {
  const o = object(value, ["path", "identity", "release"]);
  return {
    path: path(o.path),
    identity: nullable(o.identity, (item) => {
      const i = object(item, ["dev", "ino", "uid"]);
      return { dev: int(i.dev), ino: int(i.ino), uid: int(i.uid, 0, 0x7fffffff) };
    }),
    release: nullable(o.release, release),
  };
}

function workerLoader(value: unknown): WorkerLoader {
  const kind = literal((value as { kind?: unknown } | null)?.kind, ["legacy-module", "packaged-probe"]);
  if (kind === "legacy-module") {
    const o = object(value, ["kind", "file"]);
    return { kind, file: fileSeal(o.file) };
  }
  const o = object(value, ["kind", "file", "runtimeRoot", "release", "abi"]);
  return {
    kind,
    file: fileSeal(o.file),
    runtimeRoot: path(o.runtimeRoot),
    release: release(o.release),
    abi: literal(o.abi, ["hive-pilot-probe/1"]),
  };
}

function snapshotAdmission(value: unknown): SnapshotAdmission {
  const kind = literal((value as { kind?: unknown } | null)?.kind, ["unavailable", "hive-maintenance-v1"]);
  if (kind === "unavailable") {
    object(value, ["kind"]);
    return { kind };
  }
  const o = object(value, ["kind", "runtimeRoot", "release", "workerBundle", "bootId"]);
  return {
    kind,
    runtimeRoot: path(o.runtimeRoot),
    release: release(o.release),
    workerBundle: fileSeal(o.workerBundle),
    bootId: uuid(o.bootId),
  };
}

const BASELINE_KEYS = [
  "instance",
  "captureOperationId",
  "toolSha256",
  "bootstrap",
  "services",
  "runtime",
  "configFiles",
  "slots",
  "admission",
] as const;

function runtime(value: unknown): PilotSnapshot["runtime"] {
  const o = object(value, [
    "engine",
    "worker",
    "engineEntry",
    "workerEntry",
    "workerLoader",
    "node",
    "roots",
    "sdkListener",
    "bridgePort",
  ]);
  const listener = object(o.sdkListener, ["host", "port", "agentName"]);
  return {
    engine: processSeal(o.engine),
    worker: processSeal(o.worker),
    engineEntry: fileSeal(o.engineEntry),
    workerEntry: fileSeal(o.workerEntry),
    workerLoader: workerLoader(o.workerLoader),
    node: fileSeal(o.node),
    roots: array(o.roots, treeSeal, 1, 64),
    sdkListener: {
      host: literal(listener.host, ["127.0.0.1"]),
      port: int(listener.port, 1, 65535),
      agentName: literal(listener.agentName, ["hive-voice"]),
    },
    bridgePort: int(o.bridgePort, 1, 65535),
  };
}

function baselineFields(o: Record<string, unknown>): CaptureDraft["baseline"] {
  const instance = instanceKey(o.instance);
  const services = array(o.services, serviceSave, 2, 2);
  const labels = [`com.hive.${instance.instanceId}.agent`, `com.hive.${instance.instanceId}.voice-worker`];
  if (services[0].definition.label !== labels[0] || services[1].definition.label !== labels[1]) {
    throw new RecordDecodeError("captured service labels are not derived from the instance ID");
  }
  try {
    reconcileServiceOverrides(services.map((item) => item.definition));
  } catch (error) {
    throw new RecordDecodeError("captured service overrides are inconsistent", { cause: error });
  }
  const slots = array(o.slots, artifactSlot, 4, 4);
  const slotNames = [".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) =>
    resolve(instance.canonicalHome, name),
  );
  if (slots.some((slot, index) => slot.path !== slotNames[index])) {
    throw new RecordDecodeError("artifact slot inventory is incomplete");
  }
  const configFiles = array(
    o.configFiles,
    (item) => {
      const c = object(item, ["path", "seal"]);
      return { path: path(c.path), seal: nullable(c.seal, fileSeal) };
    },
    1,
    32,
  );
  unique(
    configFiles.map((item) => item.path),
    "config file",
  );
  return {
    instance,
    captureOperationId: uuid(o.captureOperationId),
    toolSha256: digest(o.toolSha256),
    bootstrap: recordRef(o.bootstrap),
    services: [services[0], services[1]],
    runtime: runtime(o.runtime),
    configFiles,
    slots: [slots[0], slots[1], slots[2], slots[3]],
    admission: snapshotAdmission(o.admission),
  };
}

export function decodePilotSnapshot(value: unknown, now?: number): PilotSnapshot {
  const o = object(value, ["schemaVersion", "kind", "id", "capturedAt", "configIdentity", ...BASELINE_KEYS]);
  if (o.schemaVersion !== 1) throw new RecordDecodeError("unsupported schema");
  literal(o.kind, ["pilot-snapshot"]);
  return {
    schemaVersion: 1,
    kind: "pilot-snapshot",
    id: uuid(o.id),
    capturedAt: time(o.capturedAt, now),
    configIdentity: digest(o.configIdentity),
    ...baselineFields(o),
  };
}

export function decodeCaptureDraft(value: unknown, now?: number): CaptureDraft {
  const o = object(value, ["schemaVersion", "kind", "operationId", "instance", "createdAt", "snapshotId", "baseline"]);
  if (o.schemaVersion !== 1) throw new RecordDecodeError("unsupported schema");
  literal(o.kind, ["capture-draft"]);
  const baseline = baselineFields(object(o.baseline, BASELINE_KEYS));
  const draft: CaptureDraft = {
    schemaVersion: 1,
    kind: "capture-draft",
    operationId: uuid(o.operationId),
    instance: instanceKey(o.instance),
    createdAt: time(o.createdAt, now),
    snapshotId: uuid(o.snapshotId),
    baseline,
  };
  if (canonical(draft.instance) !== canonical(baseline.instance) || draft.operationId !== baseline.captureOperationId) {
    throw new RecordDecodeError("capture draft operation/instance disagree");
  }
  return draft;
}

export function decodePilotSubject(value: unknown): PilotSubject {
  const kind = literal((value as { kind?: unknown } | null)?.kind, ["registered", "capture-draft"]);
  if (kind === "registered") {
    const o = object(value, ["kind", "snapshot"]);
    return { kind, snapshot: recordRef(o.snapshot) };
  }
  const o = object(value, ["kind", "operationId", "draftSha256"]);
  return { kind, operationId: uuid(o.operationId), draftSha256: digest(o.draftSha256) };
}

export function checkSpec(value: unknown): CheckSpec {
  if (value === null || typeof value !== "object") throw new RecordDecodeError("invalid check");
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

export function sourceObservation(value: unknown): SourceObservation {
  const o = object(value, ["id", "category", "locator", "checks", "scope", "accounting"]);
  const checks = array(o.checks, uuid, 1, 64);
  unique(checks, "source check reference");
  return {
    id: uuid(o.id),
    category: literal(o.category, inventoryClasses),
    locator: str(o.locator, 512),
    checks,
    scope: literal(o.scope, ["target-instance", "shared-project", "unknown"]),
    accounting: literal(o.accounting, ["admission-ledger", "observations-only", "unknown"]),
  };
}

function holdProcedure(value: unknown): HoldProcedure {
  const kind = literal((value as { kind?: unknown } | null)?.kind, ["unavailable", "hive-maintenance-v1"]);
  if (kind === "unavailable") {
    const o = object(value, ["kind", "reason"]);
    return { kind, reason: str(o.reason, 256) };
  }
  const o = object(value, ["kind", "operationId", "bootId", "establish", "verify", "release"]);
  return {
    kind,
    operationId: uuid(o.operationId),
    bootId: uuid(o.bootId),
    establish: literal(o.establish, ["request-close"]),
    verify: literal(o.verify, ["fresh-status-and-ledger"]),
    release: literal(o.release, ["terminal-release-or-confirmed-supervisor-exit"]),
  };
}

export function decodeHoldRecord(value: unknown, now?: number): HoldRecord {
  const o = object(value, [
    "schemaVersion",
    "kind",
    "id",
    "instance",
    "snapshot",
    "toolSha256",
    "createdAt",
    "pilotWorker",
    "sources",
    "checks",
    "gaps",
    "procedure",
  ]);
  if (o.schemaVersion !== 1) throw new RecordDecodeError("unsupported schema");
  literal(o.kind, ["legacy-hold"]);
  const checks = array(o.checks, checkSpec, 0, 256);
  const checkIds = checks.map((check) => check.id);
  unique(checkIds, "check ID");
  const sources = array(o.sources, sourceObservation, 0, 10_000);
  unique(
    sources.map((source) => source.id),
    "source ID",
  );
  for (const source of sources) {
    if (source.checks.some((id) => !checkIds.includes(id))) {
      throw new RecordDecodeError("source references a check outside this record");
    }
  }
  const gaps = array(
    o.gaps,
    (item) => {
      const g = object(item, ["category", "reason"]);
      return { category: literal(g.category, inventoryClasses), reason: str(g.reason, 128) };
    },
    0,
    inventoryClasses.length,
  );
  unique(
    gaps.map((gap) => gap.category),
    "gap category",
  );
  for (const category of inventoryClasses) {
    if (!sources.some((source) => source.category === category) && !gaps.some((gap) => gap.category === category)) {
      throw new RecordDecodeError(`inventory category ${category} is neither observed nor a gap`);
    }
  }
  return {
    schemaVersion: 1,
    kind: "legacy-hold",
    id: uuid(o.id),
    instance: instanceKey(o.instance),
    snapshot: recordRef(o.snapshot),
    toolSha256: digest(o.toolSha256),
    createdAt: time(o.createdAt, now),
    pilotWorker: processSeal(o.pilotWorker),
    sources,
    checks,
    gaps,
    procedure: holdProcedure(o.procedure),
  };
}

export function decodeBootstrapRecord(value: unknown, now?: number): BootstrapRecord {
  const o = object(value, [
    "schemaVersion",
    "kind",
    "id",
    "instance",
    "createdAt",
    "archive",
    "packageRoot",
    "release",
    "helper",
    "probe",
    "diagnostic",
    "node",
    "npm",
  ]);
  if (o.schemaVersion !== 1) throw new RecordDecodeError("unsupported schema");
  literal(o.kind, ["bootstrap"]);
  const record: BootstrapRecord = {
    schemaVersion: 1,
    kind: "bootstrap",
    id: uuid(o.id),
    instance: instanceKey(o.instance),
    createdAt: time(o.createdAt, now),
    archive: fileSeal(o.archive),
    packageRoot: treeSeal(o.packageRoot),
    release: release(o.release),
    helper: fileSeal(o.helper),
    probe: fileSeal(o.probe),
    diagnostic: fileSeal(o.diagnostic),
    node: fileSeal(o.node),
    npm: fileSeal(o.npm),
  };
  const root = record.packageRoot.realpath;
  for (const [name, seal] of [
    ["helper", record.helper],
    ["probe", record.probe],
    ["diagnostic", record.diagnostic],
  ] as const) {
    if (!within(root, seal.realpath)) throw new RecordDecodeError(`bootstrap ${name} is outside its package root`);
  }
  if (basename(root) !== record.archive.sha256) {
    throw new RecordDecodeError("bootstrap package root is not keyed on its archive digest");
  }
  return record;
}

export function decodeRegistration(value: unknown, now?: number): Registration {
  const o = object(value, ["schemaVersion", "id", "kind", "instance", "operationId", "createdAt", "payload"]);
  if (o.schemaVersion !== 1) throw new RecordDecodeError("unsupported schema");
  return {
    schemaVersion: 1,
    id: uuid(o.id),
    kind: literal(o.kind, ["pilot-snapshot", "legacy-hold", "bootstrap"]),
    instance: instanceKey(o.instance),
    operationId: uuid(o.operationId),
    createdAt: time(o.createdAt, now),
    payload: fileSeal(o.payload),
  };
}

export type RecordPayload = PilotSnapshot | HoldRecord | BootstrapRecord;

export function decodePayload(kind: RegistrationKind, value: unknown, now?: number): RecordPayload {
  switch (kind) {
    case "pilot-snapshot":
      return decodePilotSnapshot(value, now);
    case "legacy-hold":
      return decodeHoldRecord(value, now);
    case "bootstrap":
      return decodeBootstrapRecord(value, now);
  }
}

/** Canonical bytes (one trailing newline) accepted by `parseCanonical`. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonical(value)}\n`);
}

// ── seals ─────────────────────────────────────────────────────────────────

export interface SealRules {
  /** Owners accepted besides root (0) when `allowRoot`. */
  uid: number;
  /** External runtime prerequisites (Node, system files) may be root-owned. */
  allowRoot?: boolean;
  maxBytes?: number;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function ownerAllowed(uid: number, rules: SealRules): boolean {
  return uid === rules.uid || (rules.allowRoot === true && uid === 0);
}

/** Read one regular file through a no-follow descriptor with before/after identity checks. */
async function readNoFollow(
  target: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; dev: number; ino: number; uid: number; mode: number; size: number }> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new SealMismatchError(`not a regular file: ${target}`);
  if (before.size > maxBytes) throw new SealMismatchError(`file exceeds its size cap: ${target}`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new SealMismatchError("file replaced while opened");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== opened.size ||
      after.size !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new SealMismatchError(`file changed while read: ${target}`);
    }
    return { bytes, dev: opened.dev, ino: opened.ino, uid: opened.uid, mode: opened.mode & 0o7777, size: opened.size };
  } finally {
    await handle.close();
  }
}

export const sha256Hex = (bytes: Buffer | string): Digest => createHash("sha256").update(bytes).digest("hex");

/** Seal a file: root-or-instance owner, no group/world write, stable no-follow read. */
export async function sealFile(target: string, rules: SealRules): Promise<FileSeal & { bytes: Buffer }> {
  if (!isAbsolute(target)) throw new SealMismatchError("seal path must be absolute");
  const real = await realpath(target);
  const read = await readNoFollow(real, rules.maxBytes ?? MAX_MANIFEST_BYTES);
  if (!ownerAllowed(read.uid, rules)) throw new SealMismatchError(`foreign owner: ${target}`);
  if ((read.mode & 0o022) !== 0) throw new SealMismatchError(`group/world-writable: ${target}`);
  return {
    path: resolve(target),
    realpath: real,
    uid: read.uid,
    mode: read.mode,
    dev: read.dev,
    ino: read.ino,
    size: read.size,
    sha256: sha256Hex(read.bytes),
    bytes: read.bytes,
  };
}

/** Re-seal and require the exact same path/realpath/owner/mode/inode/size/hash. */
export async function verifySeal(seal: FileSeal, rules: SealRules): Promise<Buffer> {
  let current: FileSeal & { bytes: Buffer };
  try {
    current = await sealFile(seal.path, { ...rules, maxBytes: Math.max(seal.size, 1) });
  } catch (error) {
    throw new SealMismatchError(`sealed file unavailable: ${seal.path}`, { cause: error });
  }
  const { bytes, ...observed } = current;
  if (canonical(observed) !== canonical(seal)) throw new SealMismatchError(`seal mismatch: ${seal.path}`);
  return bytes;
}

// ── tree manifests ────────────────────────────────────────────────────────

export interface TreeManifestOptions {
  uid: number;
  /** Symlink targets must stay within these sealed closure roots. */
  closureRoots: readonly string[];
  maxEntries?: number;
  maxBytes?: number;
}

/**
 * Walk a closure root in sorted relative-path order recording directory
 * modes, regular file size/hash/mode and relative symlink edges with canonical
 * targets. `.git` is the only exclusion. Sockets, devices and unreadable
 * entries fail. Output is newline-delimited canonical JSON, capped, never
 * silently truncated.
 */
export async function buildTreeManifest(root: string, options: TreeManifestOptions): Promise<Buffer> {
  const maxEntries = options.maxEntries ?? MAX_MANIFEST_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
  const lines: Buffer[] = [];
  let bytes = 0;
  let entries = 0;
  const push = (value: unknown) => {
    entries += 1;
    const line = canonicalBytes(value);
    bytes += line.length;
    if (entries > maxEntries || bytes > maxBytes) throw new SealMismatchError("tree manifest exceeds its cap");
    lines.push(line);
  };
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SealMismatchError("tree root is not a directory");
  const visit = async (directory: string, rel: string): Promise<void> => {
    const info = await lstat(directory);
    if (info.uid !== options.uid) throw new SealMismatchError(`tree entry has a foreign owner: ${rel || "."}`);
    if ((info.mode & 0o022) !== 0) throw new SealMismatchError(`tree entry is group/world-writable: ${rel || "."}`);
    push({ path: rel || ".", type: "d", mode: info.mode & 0o7777 });
    const names = (await readdir(directory)).filter((name) => name !== ".git").sort();
    for (const name of names) {
      const child = resolve(directory, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) {
        const target = await readlink(child);
        let real: string;
        try {
          real = await realpath(child);
        } catch (error) {
          throw new SealMismatchError(`dangling tree link: ${childRel}`, { cause: error });
        }
        if (!options.closureRoots.some((closure) => within(closure, real))) {
          throw new SealMismatchError(`tree link escapes the sealed closure: ${childRel}`);
        }
        push({ path: childRel, type: "l", target, realpath: real });
      } else if (childInfo.isDirectory()) {
        await visit(child, childRel);
      } else if (childInfo.isFile()) {
        if (childInfo.uid !== options.uid) throw new SealMismatchError(`tree file has a foreign owner: ${childRel}`);
        if ((childInfo.mode & 0o022) !== 0) throw new SealMismatchError(`tree file is writable by others: ${childRel}`);
        const content = await readFile(child);
        push({
          path: childRel,
          type: "f",
          mode: childInfo.mode & 0o7777,
          size: content.length,
          sha256: sha256Hex(content),
        });
      } else {
        throw new SealMismatchError(`unsupported tree node: ${childRel}`);
      }
    }
  };
  await visit(root, "");
  return Buffer.concat(lines);
}

/** Rewalk a sealed tree and compare its identity and recomputed manifest to the seal. */
export async function verifyTreeSeal(seal: TreeSeal, options: TreeManifestOptions): Promise<void> {
  const info = await lstat(seal.path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(seal.path)) !== seal.realpath ||
    info.dev !== seal.dev ||
    info.ino !== seal.ino ||
    info.uid !== seal.uid
  ) {
    throw new SealMismatchError(`tree root identity changed: ${seal.path}`);
  }
  const stored = await verifySeal(seal.manifest, { uid: options.uid });
  const recomputed = await buildTreeManifest(seal.path, options);
  if (!recomputed.equals(stored)) throw new SealMismatchError(`tree contents changed: ${seal.path}`);
}

// ── registry ──────────────────────────────────────────────────────────────

export function registryRoot(canonicalHome: string): string {
  return resolve(canonicalHome, ".hive-state", "deployment", "registry");
}

export function registrySelector(canonicalHome: string, id: string): string {
  return resolve(registryRoot(canonicalHome), uuid(id), "payload.json");
}

export type RegistrationFence = {
  id: string;
  kind: RegistrationKind;
  directory: {
    path: string;
    parent: { path: string; identity: { dev: number; ino: number; uid: number } };
    state: "intended" | "observed" | "remove-intended" | "removed";
    identity: { dev: number; ino: number; uid: number } | null;
  };
  state: "reserved" | "payload-written" | "commit-intended" | "committed" | "aborted";
  payload: FileSeal | null;
  /** Operation-private sealed intent holding the expected registration bytes digest. */
  validation: FileSeal | null;
  commit: FileSeal | null;
  reference: RecordRef | null;
};

async function fsyncDirectory(target: string): Promise<void> {
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exclusiveWrite(target: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(target: string, uid: number): Promise<{ dev: number; ino: number; uid: number }> {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new RegistryUnresolvedError(`registry directory is not private and owned: ${target}`);
  }
  return { dev: info.dev, ino: info.ino, uid: info.uid };
}

/** The operation must own the instance lock (never a detached or foreign writer). */
export async function assertOperationLock(operation: AcquiredOperation): Promise<void> {
  let owner: { id?: unknown; canonicalHome?: unknown };
  try {
    owner = JSON.parse(await readFile(resolve(operation.paths.lockDirectory, "owner.json"), "utf8")) as typeof owner;
  } catch (error) {
    throw new RegistryUnresolvedError("registration requires the instance operation lock", { cause: error });
  }
  if (owner.id !== operation.record.id || owner.canonicalHome !== operation.record.canonicalHome) {
    throw new RegistryUnresolvedError("registration requires this operation's own lock");
  }
}

const KIND_WORK: Record<RegistrationKind, string> = {
  "pilot-snapshot": "registry",
  "legacy-hold": "registry",
  bootstrap: "bootstrap",
};

export interface RegisterRecordInput {
  operation: AcquiredOperation;
  instance: InstanceKey;
  kind: RegistrationKind;
  /** Reserved UUID (a capture reserves its snapshot ID before the draft). */
  id?: string;
  /** Permitted private originals copied into `files/` (safe basenames). */
  files?: readonly { name: string; bytes: Buffer }[];
  /** Build the payload from the sealed copied files; decoded strictly before writing. */
  buildPayload(context: { id: string; files: Readonly<Record<string, FileSeal>> }): RecordPayload;
  now?: () => number;
}

export interface RegisteredRecordResult {
  reference: RecordRef;
  selector: string;
  registration: Registration;
}

function operationFences(operation: AcquiredOperation): RegistrationFence[] {
  const record = operation.record as { registrations?: RegistrationFence[] };
  record.registrations ??= [];
  return record.registrations;
}

async function persistFence(operation: AcquiredOperation, fence: RegistrationFence): Promise<void> {
  const fences = operationFences(operation);
  const index = fences.findIndex((item) => item.id === fence.id);
  const copy = JSON.parse(JSON.stringify(fence)) as RegistrationFence;
  if (index === -1) fences.push(copy);
  else fences[index] = copy;
  if (!operation.record.retainedPaths.includes(fence.directory.path)) {
    operation.record.retainedPaths.push(fence.directory.path);
  }
  await persistOperation(operation);
}

function stripBytes(seal: FileSeal & { bytes?: Buffer }): FileSeal {
  return {
    path: seal.path,
    realpath: seal.realpath,
    uid: seal.uid,
    mode: seal.mode,
    dev: seal.dev,
    ino: seal.ino,
    size: seal.size,
    sha256: seal.sha256,
  };
}

/**
 * Register one immutable record. Journals intent, creates an exclusive 0700
 * UUID directory, copies files exclusively, writes and seals the canonical
 * payload, persists the expected registration bytes, writes
 * `registration.json` last and persists the committed reference before any
 * caller prints a selector. Never overwrites another registration.
 */
export async function registerRecord(input: RegisterRecordInput): Promise<RegisteredRecordResult> {
  const { operation, instance } = input;
  await assertOperationLock(operation);
  if ((operation.record.workKind as string) !== KIND_WORK[input.kind]) {
    throw new RegistryUnresolvedError(`${input.kind} records are registered only by ${KIND_WORK[input.kind]} work`);
  }
  if (
    operation.record.canonicalHome !== instance.canonicalHome ||
    operation.record.instanceId !== instance.instanceId ||
    (await realpath(instance.canonicalHome)) !== instance.canonicalHome
  ) {
    throw new RegistryUnresolvedError("registration instance does not match the acquired operation");
  }
  const now = input.now ?? Date.now;
  const id = input.id ?? randomUUID();
  uuid(id);
  const root = registryRoot(instance.canonicalHome);
  const directory = resolve(root, id);
  await ensurePrivateDirectory(resolve(instance.canonicalHome, ".hive-state"), instance.uid);
  await ensurePrivateDirectory(resolve(instance.canonicalHome, ".hive-state", "deployment"), instance.uid);
  const parentIdentity = await ensurePrivateDirectory(root, instance.uid);
  try {
    await lstat(directory);
    throw new RegistryUnresolvedError("registration directory already exists");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const fence: RegistrationFence = {
    id,
    kind: input.kind,
    directory: { path: directory, parent: { path: root, identity: parentIdentity }, state: "intended", identity: null },
    state: "reserved",
    payload: null,
    validation: null,
    commit: null,
    reference: null,
  };
  await persistFence(operation, fence);
  await mkdir(directory, { mode: 0o700 });
  await fsyncDirectory(root);
  const created = await lstat(directory);
  fence.directory.identity = { dev: created.dev, ino: created.ino, uid: created.uid };
  fence.directory.state = "observed";
  await persistFence(operation, fence);

  const filesDirectory = resolve(directory, "files");
  await mkdir(filesDirectory, { mode: 0o700 });
  const sealed: Record<string, FileSeal> = {};
  for (const file of input.files ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name) || Object.hasOwn(sealed, file.name)) {
      throw new RegistryUnresolvedError("unsafe or duplicate registered file name");
    }
    const target = resolve(filesDirectory, file.name);
    await exclusiveWrite(target, file.bytes);
    sealed[file.name] = stripBytes(await sealFile(target, { uid: instance.uid }));
  }
  await fsyncDirectory(filesDirectory);

  const payloadValue = input.buildPayload({ id, files: sealed });
  const payloadBytes = canonicalBytes(payloadValue);
  if (payloadBytes.length > MAX_RECORD_BYTES) throw new RegistryUnresolvedError("record too large");
  const decoded = decodePayload(input.kind, parseCanonical(payloadBytes), now());
  if (decoded.id !== id || canonical(decoded.instance) !== canonical(instance)) {
    throw new RegistryUnresolvedError("record payload ID or instance disagrees with its registration");
  }
  const payloadPath = resolve(directory, "payload.json");
  await exclusiveWrite(payloadPath, payloadBytes);
  const payloadSeal = stripBytes(await sealFile(payloadPath, { uid: instance.uid, maxBytes: MAX_RECORD_BYTES }));
  fence.payload = payloadSeal;
  fence.state = "payload-written";
  await persistFence(operation, fence);

  const registration: Registration = {
    schemaVersion: 1,
    id,
    kind: input.kind,
    instance,
    operationId: operation.record.id,
    createdAt: now(),
    payload: payloadSeal,
  };
  const registrationBytes = canonicalBytes(registration);
  const intentDirectory = resolve(operation.paths.operationDirectory, "registrations");
  await mkdir(intentDirectory, { recursive: true, mode: 0o700 });
  const intentPath = resolve(intentDirectory, `${id}.intent.json`);
  await exclusiveWrite(
    intentPath,
    canonicalBytes({
      id,
      registrationSha256: sha256Hex(registrationBytes),
      registrationBytes: registrationBytes.toString("utf8"),
    }),
  );
  fence.validation = stripBytes(await sealFile(intentPath, { uid: instance.uid, maxBytes: MAX_RECORD_BYTES }));
  fence.state = "commit-intended";
  await persistFence(operation, fence);

  const registrationPath = resolve(directory, "registration.json");
  await exclusiveWrite(registrationPath, registrationBytes);
  await fsyncDirectory(directory);
  fence.commit = stripBytes(await sealFile(registrationPath, { uid: instance.uid, maxBytes: MAX_RECORD_BYTES }));
  const reference: RecordRef = { id, sha256: payloadSeal.sha256 };
  fence.reference = reference;
  fence.state = "committed";
  await persistFence(operation, fence);
  return { reference, selector: payloadPath, registration };
}

export interface ReadRegisteredOptions {
  instance: InstanceKey;
  kind: RegistrationKind;
  /** When resolving a reference, the expected payload digest. */
  expected?: RecordRef;
  now?: () => number;
}

export interface RegisteredRecord<T extends RecordPayload = RecordPayload> {
  selector: string;
  reference: RecordRef;
  registration: Registration;
  payload: T;
  filesDirectory: string;
}

async function assertComponent(target: string, uid: number, kind: "directory" | "file"): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new RecordDecodeError(`registry path component is a symbolic link: ${target}`);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new RecordDecodeError(`registry path component has the wrong type: ${target}`);
  }
  if (info.uid !== uid) throw new RecordDecodeError(`registry path component has a foreign owner: ${target}`);
  const expected = kind === "directory" ? 0o700 : 0o600;
  if ((info.mode & 0o777) !== expected) {
    throw new RecordDecodeError(`registry path component mode is not ${expected.toString(8)}: ${target}`);
  }
}

/**
 * Read one registered record strictly. The selector must literally be
 * `<registry>/<UUID>/payload.json` under the selected canonical home; every
 * component is lstat-checked, both files are read through no-follow fds, the
 * registration's instance/kind/ID/operation association and exact payload seal
 * are verified, and the canonical payload is decoded recursively.
 */
export async function readRegisteredRecord<T extends RecordPayload = RecordPayload>(
  selector: string,
  options: ReadRegisteredOptions,
): Promise<RegisteredRecord<T>> {
  const instance = instanceKey(options.instance);
  const now = (options.now ?? Date.now)();
  const home = instance.canonicalHome;
  if ((await realpath(home)) !== home) throw new RecordDecodeError("instance home is not canonical");
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.uid !== instance.uid) throw new RecordDecodeError("instance home owner");
  if (typeof selector !== "string" || !isAbsolute(selector) || resolve(selector) !== selector) {
    throw new RecordDecodeError("registered selector must be an absolute normalized path");
  }
  const root = registryRoot(home);
  const directory = dirname(selector);
  const id = basename(directory);
  if (basename(selector) !== "payload.json" || dirname(directory) !== root || !UUID_PATTERN.test(id)) {
    throw new RecordDecodeError("selector is not a registered payload path under this instance");
  }
  await assertComponent(resolve(home, ".hive-state"), instance.uid, "directory");
  await assertComponent(resolve(home, ".hive-state", "deployment"), instance.uid, "directory");
  await assertComponent(root, instance.uid, "directory");
  await assertComponent(directory, instance.uid, "directory");
  await assertComponent(selector, instance.uid, "file");
  const registrationPath = resolve(directory, "registration.json");
  try {
    await assertComponent(registrationPath, instance.uid, "file");
  } catch (error) {
    throw new RecordDecodeError("incomplete registration is never selectable", { cause: error });
  }
  const registrationRead = await readNoFollow(registrationPath, MAX_RECORD_BYTES);
  const registration = decodeRegistration(parseCanonical(registrationRead.bytes), now);
  if (
    registration.id !== id ||
    registration.kind !== options.kind ||
    canonical(registration.instance) !== canonical(instance) ||
    registration.payload.path !== selector
  ) {
    throw new RecordDecodeError("registration does not match the selected instance, kind or ID");
  }
  const payloadRead = await readNoFollow(selector, MAX_RECORD_BYTES);
  const payloadSeal: FileSeal = {
    path: selector,
    realpath: await realpath(selector),
    uid: payloadRead.uid,
    mode: payloadRead.mode,
    dev: payloadRead.dev,
    ino: payloadRead.ino,
    size: payloadRead.size,
    sha256: sha256Hex(payloadRead.bytes),
  };
  if (canonical(payloadSeal) !== canonical(registration.payload)) {
    throw new RecordDecodeError("registered payload seal mismatch");
  }
  if (options.expected && (options.expected.id !== id || options.expected.sha256 !== payloadSeal.sha256)) {
    throw new RecordDecodeError("registered reference digest mismatch");
  }
  await assertOperationAssociation(home, registration, payloadSeal.sha256);
  const payload = decodePayload(options.kind, parseCanonical(payloadRead.bytes), now) as T;
  if (payload.id !== id || canonical(payload.instance) !== canonical(instance)) {
    throw new RecordDecodeError("registered payload ID or instance disagrees");
  }
  return {
    selector,
    reference: { id, sha256: payloadSeal.sha256 },
    registration,
    payload,
    filesDirectory: resolve(directory, "files"),
  };
}

/** Resolve a nested reference only through the same strict reader. */
export function readReference<T extends RecordPayload>(
  reference: RecordRef,
  options: Omit<ReadRegisteredOptions, "expected">,
): Promise<RegisteredRecord<T>> {
  return readRegisteredRecord<T>(registrySelector(options.instance.canonicalHome, reference.id), {
    ...options,
    expected: reference,
  });
}

async function assertOperationAssociation(
  home: string,
  registration: Registration,
  payloadSha256: string,
): Promise<void> {
  const operationRecord = resolve(
    home,
    ".hive-state",
    "deployment",
    "operations",
    registration.operationId,
    "operation.json",
  );
  let decoded: ReturnType<typeof decodeOperationRecord>;
  try {
    decoded = decodeOperationRecord(JSON.parse(await readFile(operationRecord, "utf8")));
  } catch (error) {
    throw new RecordDecodeError("registration has no owning operation record", { cause: error });
  }
  if (decoded.schemaVersion !== 2 || decoded.id !== registration.operationId || decoded.canonicalHome !== home) {
    throw new RecordDecodeError("registration operation association mismatch");
  }
  if ((decoded.workKind as string) !== KIND_WORK[registration.kind]) {
    throw new RecordDecodeError("registration was not written by the permitted work kind");
  }
  const fences = (decoded as { registrations?: unknown }).registrations;
  const match = Array.isArray(fences)
    ? (fences as RegistrationFence[]).find((fence) => fence && fence.id === registration.id)
    : undefined;
  if (
    !match ||
    (match.state !== "committed" && match.state !== "commit-intended") ||
    match.payload?.sha256 !== payloadSha256
  ) {
    throw new RecordDecodeError("registration is not a committed record of its operation");
  }
}

export type RegistrationReconciliation =
  | { outcome: "absent" }
  | { outcome: "incomplete" }
  | { outcome: "committed"; reference: RecordRef }
  | { outcome: "unresolved"; reason: string };

/**
 * Crash reconciliation of one registration fence. Never creates a missing
 * commit: an intended commit present with its exact intended bytes is fsynced
 * and attached; an absent commit is incomplete (retained diagnostic data).
 */
export async function reconcileRegistration(
  fence: RegistrationFence,
  instance: InstanceKey,
): Promise<RegistrationReconciliation> {
  const directory = fence.directory.path;
  if (dirname(directory) !== registryRoot(instance.canonicalHome) || basename(directory) !== fence.id) {
    return { outcome: "unresolved", reason: "registration directory is outside the registry" };
  }
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return fence.directory.state === "intended" ? { outcome: "absent" } : { outcome: "unresolved", reason: "missing" };
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== instance.uid) {
    return { outcome: "unresolved", reason: "registration directory is not an owned directory" };
  }
  if (fence.directory.identity === null) {
    // Created but identity never persisted: ownership cannot be inferred from the name.
    return { outcome: "unresolved", reason: "DIRECTORY_CREATION_UNRESOLVED" };
  }
  if (info.dev !== fence.directory.identity.dev || info.ino !== fence.directory.identity.ino) {
    return { outcome: "unresolved", reason: "registration directory identity changed" };
  }
  const registrationPath = resolve(directory, "registration.json");
  let present = true;
  try {
    await lstat(registrationPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    present = false;
  }
  if (!present) return { outcome: "incomplete" };
  if (fence.state !== "commit-intended" && fence.state !== "committed") {
    return { outcome: "unresolved", reason: "commit exists without a durable commit intent" };
  }
  if (!fence.validation || !fence.payload) return { outcome: "unresolved", reason: "commit intent is incomplete" };
  try {
    const intentBytes = await verifySeal(fence.validation, { uid: instance.uid });
    const intent = object(parseCanonical(intentBytes), ["id", "registrationSha256", "registrationBytes"]);
    const actual = await readNoFollow(registrationPath, MAX_RECORD_BYTES);
    if (
      intent.id !== fence.id ||
      sha256Hex(actual.bytes) !== intent.registrationSha256 ||
      actual.bytes.toString("utf8") !== intent.registrationBytes
    ) {
      return { outcome: "unresolved", reason: "registration bytes differ from the durable intent" };
    }
    await verifySeal(fence.payload, { uid: instance.uid });
    const handle = await open(registrationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(directory);
  } catch (error) {
    return { outcome: "unresolved", reason: error instanceof Error ? error.message : "registration unverifiable" };
  }
  return { outcome: "committed", reference: { id: fence.id, sha256: fence.payload.sha256 } };
}

/** Selector-shaped paths only; arbitrary files elsewhere under `.hive-state` are rejected. */
export function isRegistrySelector(canonicalHome: string, selector: string): boolean {
  const directory = dirname(selector);
  return (
    isAbsolute(selector) &&
    resolve(selector) === selector &&
    basename(selector) === "payload.json" &&
    dirname(directory) === registryRoot(canonicalHome) &&
    UUID_PATTERN.test(basename(directory))
  );
}

/** The draft-shaped baseline fields of a registered snapshot (no identity/config digest). */
export function snapshotBaseline(snapshot: PilotSnapshot): CaptureDraft["baseline"] {
  const { instance, captureOperationId, toolSha256, bootstrap, services, runtime, configFiles, slots, admission } =
    snapshot;
  return { instance, captureOperationId, toolSha256, bootstrap, services, runtime, configFiles, slots, admission };
}
