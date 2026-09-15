/**
 * Secret-free wire types, strict decoders and pure projections shared by the
 * installed-worker `worker-maintenance` probe and the historical pilot probe
 * ABI (KPR-463 plan chunk 5 Task 9 Step 4b.2a Steps 1–3).
 *
 * Builtin-only: the frozen helper decodes probe output with these functions;
 * SDK/Mongo/loader imports stay lazily inside the installed `runtime-probe.ts`.
 * Nothing here accepts a telemetry value, admission expectation or operation ID
 * independently of a sealed request; decoded output is compared against the
 * request that produced it and against independent OS evidence by the caller.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";
import { canonical } from "./canonical.js";
import { parseBootIdentity } from "./health.js";
import {
  array,
  decodePilotSubject,
  digest,
  fileSeal,
  instanceKey,
  int,
  literal,
  object,
  path,
  processSeal,
  recordRef,
  release,
  str,
  uuid,
  within,
  type Digest,
  type FileSeal,
  type InstanceKey,
  type PilotSubject,
  type ProcessSeal,
  type RecordRef,
} from "./pilot-records.js";
import { parseMaintenanceReply, type MaintenanceReply } from "../voice-worker/maintenance-ipc.js";
import type { BootIdentity, Release } from "./release.js";

export const WORKER_MAINTENANCE_ABI = "hive-worker-maintenance/1";
export const HISTORICAL_PROBE_ABI = "hive-pilot-probe/1";
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
export const DECISIVE_PROBE_BUDGET_MS = 2_000;
export const TELEMETRY_MAX_AGE_MS = 60_000;
export const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

export const probeClassifications = [
  "PILOT_PROBE_ABI_UNSUPPORTED",
  "PILOT_PROBE_INPUT_INVALID",
  "PILOT_LOADER_UNAVAILABLE",
  "PILOT_CONFIGURATION_MISMATCH",
  "PILOT_BRIDGE_FAILED",
  "PILOT_DEPENDENCY_MISMATCH",
  "PILOT_INVENTORY_INCOMPLETE",
  "PILOT_PROBE_DEADLINE",
  "PILOT_ADMISSION_MISMATCH",
  "PILOT_TELEMETRY_MISSING",
  "PILOT_TELEMETRY_INVALID",
  "PILOT_TELEMETRY_STALE",
  "PILOT_TELEMETRY_WRONG_BOOT",
  "PILOT_TELEMETRY_QUERY_FAILED",
] as const;
export type ProbeClassification = (typeof probeClassifications)[number];

/** A probe failure that carries only a fixed classification, never raw data. */
export class ProbeFailure extends Error {
  constructor(
    readonly classification: ProbeClassification,
    options?: ErrorOptions,
  ) {
    super(classification, options);
  }
}

export function classificationOf(error: unknown): ProbeClassification {
  if (error instanceof ProbeFailure) return error.classification;
  const message = error instanceof Error ? error.message : "";
  return (probeClassifications as readonly string[]).includes(message)
    ? (message as ProbeClassification)
    : "PILOT_PROBE_INPUT_INVALID";
}

export type OwnedDirectory = { path: string; identity: { dev: number; ino: number; uid: number } };

export type HistoricalIdleRequest = {
  expectedAdmission: "open" | "closed";
  expectedSupervisor: BootIdentity;
  statusRequestId: string;
};

export type HistoricalTelemetry = {
  queryStartedAt: number;
  queryFinishedAt: number;
  supervisorIdentity: BootIdentity;
  supervisorUpdatedAt: number;
  activeCalls: number;
};

export type HistoricalIdle = {
  status: { requestedAt: number; finishedAt: number; reply: MaintenanceReply };
  telemetry: HistoricalTelemetry;
};

export type SdkObservation = {
  host: "127.0.0.1";
  port: number;
  rootStatus: number;
  agentName: string;
  activeJobs: number;
};

export type WorkerMaintenancePhase = "baseline" | "post-close" | "final";

export type WorkerMaintenanceRequest = {
  schemaVersion: 1;
  abi: typeof WORKER_MAINTENANCE_ABI;
  action: "observe";
  requestId: string;
  operationId: string;
  jobId: string;
  instance: InstanceKey;
  phase: WorkerMaintenancePhase;
  requestedAt: number;
  deadline: number;
  maintenanceDeadline: number;
  runtime: {
    root: OwnedDirectory;
    node: FileSeal;
    probe: FileSeal;
    config: FileSeal;
    environmentSha256: Digest;
  };
  expectedRelease: Release;
  expectedWorker: ProcessSeal;
  idle: HistoricalIdleRequest;
};

export type WorkerMaintenanceObservation = {
  schemaVersion: 1;
  abi: typeof WORKER_MAINTENANCE_ABI;
  action: "observe";
  requestId: string;
  operationId: string;
  jobId: string;
  instance: InstanceKey;
  phase: WorkerMaintenancePhase;
  requestSha256: Digest;
  startedAt: number;
  finishedAt: number;
  release: Release;
  sdk: SdkObservation;
  idle: HistoricalIdle;
};

export type ProbeFailureEnvelope = {
  schemaVersion: 1;
  abi: string;
  requestId: string;
  classification: ProbeClassification;
};

const TIME_MAX = 8_640_000_000_000_000;
const time = (value: unknown) => int(value, 0, TIME_MAX);

export function sha256Canonical(value: unknown): Digest {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function bootIdentity(value: unknown): BootIdentity {
  try {
    return parseBootIdentity(value);
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
}

function ownedDirectory(value: unknown): OwnedDirectory {
  const o = object(value, ["path", "identity"]);
  const i = object(o.identity, ["dev", "ino", "uid"]);
  return { path: path(o.path), identity: { dev: int(i.dev), ino: int(i.ino), uid: int(i.uid, 0, 0x7fffffff) } };
}

export function historicalIdleRequest(value: unknown): HistoricalIdleRequest {
  const o = object(value, ["expectedAdmission", "expectedSupervisor", "statusRequestId"]);
  const supervisor = bootIdentity(o.expectedSupervisor);
  if (supervisor.component !== "voice-worker") throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  return {
    expectedAdmission: literal(o.expectedAdmission, ["open", "closed"]),
    expectedSupervisor: supervisor,
    statusRequestId: uuid(o.statusRequestId),
  };
}

export function decodeWorkerMaintenanceRequest(value: unknown): WorkerMaintenanceRequest {
  const o = object(value, [
    "schemaVersion",
    "abi",
    "action",
    "requestId",
    "operationId",
    "jobId",
    "instance",
    "phase",
    "requestedAt",
    "deadline",
    "maintenanceDeadline",
    "runtime",
    "expectedRelease",
    "expectedWorker",
    "idle",
  ]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const runtime = object(o.runtime, ["root", "node", "probe", "config", "environmentSha256"]);
  const request: WorkerMaintenanceRequest = {
    schemaVersion: 1,
    abi: literal(o.abi, [WORKER_MAINTENANCE_ABI]),
    action: literal(o.action, ["observe"]),
    requestId: uuid(o.requestId),
    operationId: uuid(o.operationId),
    jobId: uuid(o.jobId),
    instance: instanceKey(o.instance),
    phase: literal(o.phase, ["baseline", "post-close", "final"]),
    requestedAt: time(o.requestedAt),
    deadline: time(o.deadline),
    maintenanceDeadline: time(o.maintenanceDeadline),
    runtime: {
      root: ownedDirectory(runtime.root),
      node: fileSeal(runtime.node),
      probe: fileSeal(runtime.probe),
      config: fileSeal(runtime.config),
      environmentSha256: digest(runtime.environmentSha256),
    },
    expectedRelease: release(o.expectedRelease),
    expectedWorker: processSeal(o.expectedWorker),
    idle: historicalIdleRequest(o.idle),
  };
  const ids = [request.requestId, request.operationId, request.jobId, request.idle.statusRequestId];
  if (new Set(ids).size !== ids.length) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  if (
    request.deadline <= request.requestedAt ||
    request.deadline > request.requestedAt + DECISIVE_PROBE_BUDGET_MS ||
    request.deadline > request.maintenanceDeadline
  ) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  const expectedAdmission = request.phase === "baseline" ? "open" : "closed";
  if (request.idle.expectedAdmission !== expectedAdmission) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  if (request.runtime.probe.realpath !== `${request.runtime.root.path}/pkg/runtime-probe.min.js`) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  if (
    request.idle.expectedSupervisor.pid !== request.expectedWorker.pid ||
    canonical(request.idle.expectedSupervisor.release) !== canonical(request.expectedRelease)
  ) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  return request;
}

function sdkObservation(value: unknown): SdkObservation {
  const o = object(value, ["host", "port", "rootStatus", "agentName", "activeJobs"]);
  return {
    host: literal(o.host, ["127.0.0.1"]),
    port: int(o.port, 1, 65535),
    rootStatus: int(o.rootStatus, 100, 599),
    agentName: str(o.agentName, 128),
    activeJobs: int(o.activeJobs, 0, 1_000_000),
  };
}

export function historicalTelemetry(value: unknown): HistoricalTelemetry {
  const o = object(value, [
    "queryStartedAt",
    "queryFinishedAt",
    "supervisorIdentity",
    "supervisorUpdatedAt",
    "activeCalls",
  ]);
  return {
    queryStartedAt: time(o.queryStartedAt),
    queryFinishedAt: time(o.queryFinishedAt),
    supervisorIdentity: bootIdentity(o.supervisorIdentity),
    supervisorUpdatedAt: time(o.supervisorUpdatedAt),
    activeCalls: int(o.activeCalls, 0, 1_000_000),
  };
}

export function historicalIdle(value: unknown): HistoricalIdle {
  const o = object(value, ["status", "telemetry"]);
  const status = object(o.status, ["requestedAt", "finishedAt", "reply"]);
  let reply: MaintenanceReply;
  try {
    reply = parseMaintenanceReply(status.reply);
  } catch (error) {
    throw new ProbeFailure("PILOT_ADMISSION_MISMATCH", { cause: error });
  }
  return {
    status: { requestedAt: time(status.requestedAt), finishedAt: time(status.finishedAt), reply },
    telemetry: historicalTelemetry(o.telemetry),
  };
}

export function decodeWorkerMaintenanceObservation(value: unknown): WorkerMaintenanceObservation {
  const o = object(value, [
    "schemaVersion",
    "abi",
    "action",
    "requestId",
    "operationId",
    "jobId",
    "instance",
    "phase",
    "requestSha256",
    "startedAt",
    "finishedAt",
    "release",
    "sdk",
    "idle",
  ]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  if (o.idle === null) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  return {
    schemaVersion: 1,
    abi: literal(o.abi, [WORKER_MAINTENANCE_ABI]),
    action: literal(o.action, ["observe"]),
    requestId: uuid(o.requestId),
    operationId: uuid(o.operationId),
    jobId: uuid(o.jobId),
    instance: instanceKey(o.instance),
    phase: literal(o.phase, ["baseline", "post-close", "final"]),
    requestSha256: digest(o.requestSha256),
    startedAt: time(o.startedAt),
    finishedAt: time(o.finishedAt),
    release: release(o.release),
    sdk: sdkObservation(o.sdk),
    idle: historicalIdle(o.idle),
  };
}

export function decodeProbeFailure(value: unknown, abi: string): ProbeFailureEnvelope {
  const o = object(value, ["schemaVersion", "abi", "requestId", "classification"]);
  if (o.schemaVersion !== 1 || o.abi !== abi) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  return {
    schemaVersion: 1,
    abi,
    requestId: str(o.requestId, 36),
    classification: literal(o.classification, probeClassifications),
  };
}

/**
 * Correlate one decoded installed-worker observation with the exact request
 * that produced it: identities, sealed request digest, release, phase and the
 * ordered timestamps `requestedAt <= startedAt <= status/query <= finishedAt
 * <= deadline`, plus the strict telemetry boot/heartbeat rules. Returns the
 * fixed classification of the first failure or null.
 */
export function workerObservationFault(
  observation: WorkerMaintenanceObservation,
  request: WorkerMaintenanceRequest,
  requestBytesSha256: Digest,
  now: number,
): ProbeClassification | null {
  if (
    observation.requestId !== request.requestId ||
    observation.operationId !== request.operationId ||
    observation.jobId !== request.jobId ||
    observation.phase !== request.phase ||
    observation.requestSha256 !== requestBytesSha256 ||
    canonical(observation.instance) !== canonical(request.instance)
  ) {
    return "PILOT_PROBE_INPUT_INVALID";
  }
  if (canonical(observation.release) !== canonical(request.expectedRelease)) return "PILOT_DEPENDENCY_MISMATCH";
  const { status, telemetry } = observation.idle;
  const ordered = [request.requestedAt, observation.startedAt, Math.min(status.requestedAt, telemetry.queryStartedAt)];
  const ends = [status.finishedAt, telemetry.queryFinishedAt];
  if (
    ordered.some((value, index) => index > 0 && value < ordered[index - 1]) ||
    status.requestedAt > status.finishedAt ||
    telemetry.queryStartedAt > telemetry.queryFinishedAt ||
    ends.some((value) => value > observation.finishedAt) ||
    observation.finishedAt > request.deadline ||
    request.deadline > request.requestedAt + DECISIVE_PROBE_BUDGET_MS ||
    observation.finishedAt > now
  ) {
    return "PILOT_PROBE_DEADLINE";
  }
  const reply = status.reply;
  if (
    reply.requestId !== request.idle.statusRequestId ||
    reply.operationId !== request.operationId ||
    reply.writtenAt < status.requestedAt ||
    reply.writtenAt > status.finishedAt ||
    reply.supervisor.pid !== request.idle.expectedSupervisor.pid ||
    reply.supervisor.bootId !== request.idle.expectedSupervisor.bootId ||
    reply.snapshot.admission !== request.idle.expectedAdmission ||
    (request.idle.expectedAdmission === "open" && reply.snapshot.operationId !== null) ||
    (request.idle.expectedAdmission === "closed" && reply.snapshot.operationId !== request.operationId)
  ) {
    return "PILOT_ADMISSION_MISMATCH";
  }
  if (
    telemetry.supervisorIdentity.component !== "voice-worker" ||
    canonical(telemetry.supervisorIdentity) !== canonical(request.idle.expectedSupervisor) ||
    canonical(telemetry.supervisorIdentity.release) !== canonical(request.expectedRelease)
  ) {
    return "PILOT_TELEMETRY_WRONG_BOOT";
  }
  const bootStartedAt = Date.parse(telemetry.supervisorIdentity.startedAt);
  if (!Number.isFinite(bootStartedAt) || telemetry.supervisorUpdatedAt < bootStartedAt)
    return "PILOT_TELEMETRY_INVALID";
  if (
    telemetry.supervisorUpdatedAt > telemetry.queryFinishedAt ||
    telemetry.queryFinishedAt - telemetry.supervisorUpdatedAt > TELEMETRY_MAX_AGE_MS
  ) {
    return "PILOT_TELEMETRY_STALE";
  }
  return null;
}

// ── historical ABI helpers (chunk 5 Step 2/3) ─────────────────────────────

export type PilotConfigLoaderShape = {
  instanceHome: string;
  instanceId: string;
  mongoDbName: string;
  sipTrunkId: string;
  inboundAgents: Record<string, string>;
  agentVoices: Record<string, string>;
  defaultStt: string;
  defaultTts: string;
  bridgeUrl: string;
};

/** Versioned configuration identity projection; excludes credentials and credential-bearing URLs. */
export function pilotConfigProjection(wc: PilotConfigLoaderShape, instance: InstanceKey, sdkPort: number): object {
  let bridge: URL;
  try {
    bridge = new URL(wc.bridgeUrl);
  } catch {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  if (
    bridge.protocol !== "http:" ||
    bridge.hostname !== "127.0.0.1" ||
    bridge.username ||
    bridge.password ||
    bridge.search ||
    bridge.hash ||
    bridge.pathname !== "/v1/chat/completions"
  ) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  if (wc.instanceHome !== instance.canonicalHome || wc.instanceId !== instance.instanceId) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  return {
    projection: 1,
    instance,
    databaseName: wc.mongoDbName,
    ports: { bridge: Number(bridge.port || "80"), worker: sdkPort },
    routing: { sipTrunkId: wc.sipTrunkId, inboundAgents: wc.inboundAgents, agentVoices: wc.agentVoices },
    voice: { defaultStt: wc.defaultStt, defaultTts: wc.defaultTts },
  };
}

export function pilotConfigIdentity(wc: PilotConfigLoaderShape, instance: InstanceKey, sdkPort: number): Digest {
  return sha256Canonical(pilotConfigProjection(wc, instance, sdkPort));
}

/** Pinned LiveKit server SDK 2.14.1 SIP pagination: `{limit, afterId}`, bounded, non-repeating. */
export async function allSipPages<T>(
  read: (page: { limit: number; afterId: string }) => Promise<T[]>,
  idOf: (row: T) => string,
): Promise<T[]> {
  const seen = new Set<string>();
  const result: T[] = [];
  let afterId = "";
  for (let page = 0; page < 100; page++) {
    const rows = await read({ limit: 100, afterId });
    if (!Array.isArray(rows) || rows.length > 100) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
    for (const row of rows) {
      const id = idOf(row);
      if (typeof id !== "string" || !id || id.length > 4096 || /[\0\r\n]/.test(id) || seen.has(id)) {
        throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
      }
      seen.add(id);
      result.push(row);
    }
    if (rows.length < 100) return result;
    const next = idOf(rows[rows.length - 1]);
    if (next === afterId) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
    afterId = next;
  }
  throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
}

export type InventoryItem = {
  kind: "room" | "participant" | "dispatch" | "sip-rule" | "inbound-trunk";
  id: string;
  parent: string | null;
  agentName: string | null;
};

export function inventoryDigest(operationId: string, resourceKind: InventoryItem["kind"], rawId: string): Digest {
  if (typeof rawId !== "string" || !rawId || rawId.length > 4096 || /[\0\r\n]/.test(rawId)) {
    throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  }
  return createHash("sha256").update(`${operationId}\0${resourceKind}\0${rawId}`).digest("hex");
}

export function sortInventory(items: InventoryItem[]): InventoryItem[] {
  return [...items].sort((left, right) =>
    canonical([left.kind, left.id, left.parent, left.agentName]).localeCompare(
      canonical([right.kind, right.id, right.parent, right.agentName]),
    ),
  );
}

export function inventoryItem(value: unknown): InventoryItem {
  const o = object(value, ["kind", "id", "parent", "agentName"]);
  return {
    kind: literal(o.kind, ["room", "participant", "dispatch", "sip-rule", "inbound-trunk"]),
    id: digest(o.id),
    parent: o.parent === null ? null : digest(o.parent),
    agentName: o.agentName === null ? null : str(o.agentName, 128),
  };
}

export function inventoryItems(value: unknown): InventoryItem[] {
  return array(value, inventoryItem, 0, 10_000);
}

export { decodePilotSubject };
export type { PilotSubject };

// ── historical probe ABI wire types (chunk 5 Step 1) ──────────────────────

export const HISTORICAL_SERVER_SDK = "2.14.1";
export const INVENTORY_BUDGET_MS = 30_000;
export const INVENTORY_MAX_ITEMS = 10_000;
export const INVENTORY_LIMITATIONS = ["EXTERNAL_PRODUCERS_UNFENCED", "PENDING_ASSIGNMENTS_UNOBSERVABLE"] as const;

export type PilotAbiHandshake = {
  schemaVersion: 1;
  abi: typeof HISTORICAL_PROBE_ABI;
  projection: 1;
  serverSdk: typeof HISTORICAL_SERVER_SDK;
  operations: ["observe", "inventory"];
  release: Release;
};

export function decodePilotAbiHandshake(value: unknown): PilotAbiHandshake {
  const o = object(value, ["schemaVersion", "abi", "projection", "serverSdk", "operations", "release"]);
  if (
    o.schemaVersion !== 1 ||
    o.projection !== 1 ||
    !Array.isArray(o.operations) ||
    canonical(o.operations) !== canonical(["observe", "inventory"])
  ) {
    throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  }
  try {
    return {
      schemaVersion: 1,
      abi: literal(o.abi, [HISTORICAL_PROBE_ABI]),
      projection: 1,
      serverSdk: literal(o.serverSdk, [HISTORICAL_SERVER_SDK]),
      operations: ["observe", "inventory"],
      release: release(o.release),
    };
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED", { cause: error });
  }
}

export type DependencyFile = { path: string; realpath: string; sha256: Digest; version: string | null };

export function dependencyFile(value: unknown): DependencyFile {
  const o = object(value, ["path", "realpath", "sha256", "version"]);
  return {
    path: path(o.path),
    realpath: path(o.realpath),
    sha256: digest(o.sha256),
    version: o.version === null ? null : str(o.version, 128),
  };
}

export type BridgeObservation = {
  correctStatus: number;
  correctClassification: "missing-agent";
  missingStatus: number;
  wrongStatus: number;
};

function bridgeObservation(value: unknown): BridgeObservation {
  const o = object(value, ["correctStatus", "correctClassification", "missingStatus", "wrongStatus"]);
  return {
    correctStatus: int(o.correctStatus, 100, 599),
    correctClassification: literal(o.correctClassification, ["missing-agent"]),
    missingStatus: int(o.missingStatus, 100, 599),
    wrongStatus: int(o.wrongStatus, 100, 599),
  };
}

export type HistoricalProbeRequest = {
  schemaVersion: 1;
  abi: typeof HISTORICAL_PROBE_ABI;
  action: "observe" | "inventory";
  requestId: string;
  operationId: string;
  subject: PilotSubject;
  instance: InstanceKey;
  requestedAt: number;
  deadline: number;
  expectedRelease: Release;
  expectedProbe: FileSeal;
  sdkPort: number;
  dependencyFiles: FileSeal[];
  idle: HistoricalIdleRequest | null;
};

export type HistoricalObservation = {
  schemaVersion: 1;
  abi: typeof HISTORICAL_PROBE_ABI;
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
  bridge: BridgeObservation;
  sdk: SdkObservation;
  idle: HistoricalIdle | null;
  dependencyFiles: DependencyFile[];
};

export type InventoryCounts = {
  rooms: number;
  participants: number;
  dispatches: number;
  rules: number;
  inboundTrunks: number;
};

export type HistoricalInventory = {
  schemaVersion: 1;
  abi: typeof HISTORICAL_PROBE_ABI;
  action: "inventory";
  requestId: string;
  operationId: string;
  subject: PilotSubject;
  instance: InstanceKey;
  startedAt: number;
  finishedAt: number;
  release: Release;
  projection: 1;
  configIdentity: Digest;
  items: InventoryItem[];
  counts: InventoryCounts;
  limitations: ["EXTERNAL_PRODUCERS_UNFENCED", "PENDING_ASSIGNMENTS_UNOBSERVABLE"];
};

function ids(...values: string[]): void {
  if (new Set(values).size !== values.length) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
}

export function decodeHistoricalProbeRequest(value: unknown): HistoricalProbeRequest {
  const o = object(value, [
    "schemaVersion",
    "abi",
    "action",
    "requestId",
    "operationId",
    "subject",
    "instance",
    "requestedAt",
    "deadline",
    "expectedRelease",
    "expectedProbe",
    "sdkPort",
    "dependencyFiles",
    "idle",
  ]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const request: HistoricalProbeRequest = {
    schemaVersion: 1,
    abi: literal(o.abi, [HISTORICAL_PROBE_ABI]),
    action: literal(o.action, ["observe", "inventory"]),
    requestId: uuid(o.requestId),
    operationId: uuid(o.operationId),
    subject: decodePilotSubject(o.subject),
    instance: instanceKey(o.instance),
    requestedAt: time(o.requestedAt),
    deadline: time(o.deadline),
    expectedRelease: release(o.expectedRelease),
    expectedProbe: fileSeal(o.expectedProbe),
    sdkPort: int(o.sdkPort, 1, 65535),
    dependencyFiles: array(o.dependencyFiles, fileSeal, 0, 64),
    idle: o.idle === null ? null : historicalIdleRequest(o.idle),
  };
  ids(request.requestId, request.operationId, ...(request.idle ? [request.idle.statusRequestId] : []));
  const budget = request.action === "observe" ? DECISIVE_PROBE_BUDGET_MS : INVENTORY_BUDGET_MS;
  if (request.deadline <= request.requestedAt || request.deadline > request.requestedAt + budget) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  if (request.action === "inventory" && request.idle !== null) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  if (request.subject.kind === "capture-draft" && request.subject.operationId !== request.operationId) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  if (request.idle && canonical(request.idle.expectedSupervisor.release) !== canonical(request.expectedRelease)) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  return request;
}

export function decodeHistoricalObservation(value: unknown): HistoricalObservation {
  const o = object(value, [
    "schemaVersion",
    "abi",
    "action",
    "requestId",
    "operationId",
    "subject",
    "instance",
    "startedAt",
    "finishedAt",
    "release",
    "projection",
    "configIdentity",
    "bridge",
    "sdk",
    "idle",
    "dependencyFiles",
  ]);
  if (o.schemaVersion !== 1 || o.projection !== 1) throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  return {
    schemaVersion: 1,
    abi: literal(o.abi, [HISTORICAL_PROBE_ABI]),
    action: literal(o.action, ["observe"]),
    requestId: uuid(o.requestId),
    operationId: uuid(o.operationId),
    subject: decodePilotSubject(o.subject),
    instance: instanceKey(o.instance),
    startedAt: time(o.startedAt),
    finishedAt: time(o.finishedAt),
    release: release(o.release),
    projection: 1,
    configIdentity: digest(o.configIdentity),
    bridge: bridgeObservation(o.bridge),
    sdk: sdkObservation(o.sdk),
    idle: o.idle === null ? null : historicalIdle(o.idle),
    dependencyFiles: array(o.dependencyFiles, dependencyFile, 0, 64),
  };
}

function inventoryCounts(value: unknown): InventoryCounts {
  const o = object(value, ["rooms", "participants", "dispatches", "rules", "inboundTrunks"]);
  const count = (item: unknown) => int(item, 0, INVENTORY_MAX_ITEMS);
  return {
    rooms: count(o.rooms),
    participants: count(o.participants),
    dispatches: count(o.dispatches),
    rules: count(o.rules),
    inboundTrunks: count(o.inboundTrunks),
  };
}

function limitations(value: unknown): HistoricalInventory["limitations"] {
  if (canonical(value) !== canonical(INVENTORY_LIMITATIONS)) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  return [...INVENTORY_LIMITATIONS];
}

/** Counts must equal the normalized items (rules counted by distinct rule ID). */
export function countInventory(items: readonly InventoryItem[]): InventoryCounts {
  const distinct = (kind: InventoryItem["kind"]) =>
    new Set(items.filter((item) => item.kind === kind).map((item) => item.id)).size;
  return {
    rooms: distinct("room"),
    participants: distinct("participant"),
    dispatches: distinct("dispatch"),
    rules: distinct("sip-rule"),
    inboundTrunks: distinct("inbound-trunk"),
  };
}

export function decodeHistoricalInventory(value: unknown): HistoricalInventory {
  const o = object(value, [
    "schemaVersion",
    "abi",
    "action",
    "requestId",
    "operationId",
    "subject",
    "instance",
    "startedAt",
    "finishedAt",
    "release",
    "projection",
    "configIdentity",
    "items",
    "counts",
    "limitations",
  ]);
  if (o.schemaVersion !== 1 || o.projection !== 1) throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  const items = inventoryItems(o.items);
  const counts = inventoryCounts(o.counts);
  if (canonical(counts) !== canonical(countInventory(items))) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  if (canonical(sortInventory(items)) !== canonical(items)) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  return {
    schemaVersion: 1,
    abi: literal(o.abi, [HISTORICAL_PROBE_ABI]),
    action: literal(o.action, ["inventory"]),
    requestId: uuid(o.requestId),
    operationId: uuid(o.operationId),
    subject: decodePilotSubject(o.subject),
    instance: instanceKey(o.instance),
    startedAt: time(o.startedAt),
    finishedAt: time(o.finishedAt),
    release: release(o.release),
    projection: 1,
    configIdentity: digest(o.configIdentity),
    items,
    counts,
    limitations: limitations(o.limitations),
  };
}

// ── outer `pilot` / `pilot-inventory` request and results (chunk 4 Step 4b.2) ──

export type PilotProbeMode = "pilot" | "pilot-inventory";

export type PilotProbeRequest = {
  schemaVersion: 1;
  requestId: string;
  operationId: string;
  subject: PilotSubject;
  instance: InstanceKey;
  requestedAt: number;
  deadline: number;
  expectedEngine: ProcessSeal;
  expectedWorker: ProcessSeal;
  bootstrap: RecordRef;
  draftOrSnapshotSeal: FileSeal;
  idle: HistoricalIdleRequest | null;
};

export type PilotProbeResult = {
  schemaVersion: 1;
  requestId: string;
  instance: InstanceKey;
  subject: PilotSubject;
  startedAt: number;
  finishedAt: number;
  classification: "PILOT_OBSERVED";
  configIdentity: Digest;
  bridge: BridgeObservation;
  sdk: SdkObservation;
  idle: HistoricalIdle | null;
  dependencyFiles: DependencyFile[];
};

export type PilotInventoryResult = {
  schemaVersion: 1;
  requestId: string;
  instance: InstanceKey;
  subject: PilotSubject;
  startedAt: number;
  finishedAt: number;
  classification: "PILOT_INVENTORY_OBSERVED";
  configIdentity: Digest;
  items: InventoryItem[];
  counts: InventoryCounts;
  limitations: HistoricalInventory["limitations"];
  evidenceDigest: Digest;
};

export type PilotFailureEnvelope = { schemaVersion: 1; requestId: string; classification: ProbeClassification };

export function pilotProbeRequestPath(
  canonicalHome: string,
  request: { operationId: string; requestId: string },
  mode: PilotProbeMode,
): string {
  return resolve(
    canonicalHome,
    ".hive-state",
    "deployment",
    "operations",
    request.operationId,
    "probes",
    request.requestId,
    `${mode}.json`,
  );
}

export function historicalRequestPath(
  canonicalHome: string,
  request: { operationId: string; requestId: string },
): string {
  return resolve(
    canonicalHome,
    ".hive-state",
    "deployment",
    "operations",
    request.operationId,
    "probes",
    request.requestId,
    "historical.json",
  );
}

export function decodePilotProbeRequest(value: unknown, mode: PilotProbeMode): PilotProbeRequest {
  const o = object(value, [
    "schemaVersion",
    "requestId",
    "operationId",
    "subject",
    "instance",
    "requestedAt",
    "deadline",
    "expectedEngine",
    "expectedWorker",
    "bootstrap",
    "draftOrSnapshotSeal",
    "idle",
  ]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const request: PilotProbeRequest = {
    schemaVersion: 1,
    requestId: uuid(o.requestId),
    operationId: uuid(o.operationId),
    subject: decodePilotSubject(o.subject),
    instance: instanceKey(o.instance),
    requestedAt: time(o.requestedAt),
    deadline: time(o.deadline),
    expectedEngine: processSeal(o.expectedEngine),
    expectedWorker: processSeal(o.expectedWorker),
    bootstrap: recordRef(o.bootstrap),
    draftOrSnapshotSeal: fileSeal(o.draftOrSnapshotSeal),
    idle: o.idle === null ? null : historicalIdleRequest(o.idle),
  };
  ids(request.requestId, request.operationId, ...(request.idle ? [request.idle.statusRequestId] : []));
  const budget = mode === "pilot" ? DECISIVE_PROBE_BUDGET_MS : INVENTORY_BUDGET_MS;
  if (request.deadline <= request.requestedAt || request.deadline > request.requestedAt + budget) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  if (mode === "pilot-inventory" && request.idle !== null) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  if (request.subject.kind === "capture-draft") {
    if (request.subject.operationId !== request.operationId) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    if (request.draftOrSnapshotSeal.sha256 !== request.subject.draftSha256) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    }
  } else if (request.draftOrSnapshotSeal.sha256 !== request.subject.snapshot.sha256) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  if (request.idle && request.idle.expectedSupervisor.pid !== request.expectedWorker.pid) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  return request;
}

export function decodePilotProbeResult(value: unknown): PilotProbeResult {
  const o = object(value, [
    "schemaVersion",
    "requestId",
    "instance",
    "subject",
    "startedAt",
    "finishedAt",
    "classification",
    "configIdentity",
    "bridge",
    "sdk",
    "idle",
    "dependencyFiles",
  ]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  return {
    schemaVersion: 1,
    requestId: uuid(o.requestId),
    instance: instanceKey(o.instance),
    subject: decodePilotSubject(o.subject),
    startedAt: time(o.startedAt),
    finishedAt: time(o.finishedAt),
    classification: literal(o.classification, ["PILOT_OBSERVED"]),
    configIdentity: digest(o.configIdentity),
    bridge: bridgeObservation(o.bridge),
    sdk: sdkObservation(o.sdk),
    idle: o.idle === null ? null : historicalIdle(o.idle),
    dependencyFiles: array(o.dependencyFiles, dependencyFile, 0, 64),
  };
}

export function decodePilotInventoryResult(value: unknown): PilotInventoryResult {
  const o = object(value, [
    "schemaVersion",
    "requestId",
    "instance",
    "subject",
    "startedAt",
    "finishedAt",
    "classification",
    "configIdentity",
    "items",
    "counts",
    "limitations",
    "evidenceDigest",
  ]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const items = inventoryItems(o.items);
  const counts = inventoryCounts(o.counts);
  const limits = limitations(o.limitations);
  if (canonical(counts) !== canonical(countInventory(items))) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  const evidence = digest(o.evidenceDigest);
  if (evidence !== sha256Canonical({ items, counts, limitations: limits })) {
    throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  }
  return {
    schemaVersion: 1,
    requestId: uuid(o.requestId),
    instance: instanceKey(o.instance),
    subject: decodePilotSubject(o.subject),
    startedAt: time(o.startedAt),
    finishedAt: time(o.finishedAt),
    classification: literal(o.classification, ["PILOT_INVENTORY_OBSERVED"]),
    configIdentity: digest(o.configIdentity),
    items,
    counts,
    limitations: limits,
    evidenceDigest: evidence,
  };
}

export function decodePilotFailure(value: unknown): PilotFailureEnvelope {
  const o = object(value, ["schemaVersion", "requestId", "classification"]);
  if (o.schemaVersion !== 1) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  return {
    schemaVersion: 1,
    requestId: str(o.requestId, 36),
    classification: literal(o.classification, probeClassifications),
  };
}

/**
 * Correlate an owner-correlated idle read with the request that produced it:
 * status UUID/operation/supervisor/admission, `requestedAt <= start <= status
 * and query <= finish <= deadline`, and the strict telemetry boot/heartbeat
 * rules. Returns the fixed classification of the first failure or null.
 */
export function historicalIdleFault(
  idle: HistoricalIdle,
  request: { operationId: string; requestedAt: number; deadline: number; idle: HistoricalIdleRequest },
  expectedRelease: Release,
  window: { startedAt: number; finishedAt: number },
): ProbeClassification | null {
  const { status, telemetry } = idle;
  if (
    window.startedAt < request.requestedAt ||
    status.requestedAt < window.startedAt ||
    telemetry.queryStartedAt < window.startedAt ||
    status.requestedAt > status.finishedAt ||
    telemetry.queryStartedAt > telemetry.queryFinishedAt ||
    status.finishedAt > window.finishedAt ||
    telemetry.queryFinishedAt > window.finishedAt ||
    window.finishedAt > request.deadline
  ) {
    return "PILOT_PROBE_DEADLINE";
  }
  const reply = status.reply;
  if (
    reply.requestId !== request.idle.statusRequestId ||
    reply.operationId !== request.operationId ||
    reply.writtenAt < status.requestedAt ||
    reply.writtenAt > status.finishedAt ||
    reply.supervisor.pid !== request.idle.expectedSupervisor.pid ||
    reply.supervisor.bootId !== request.idle.expectedSupervisor.bootId ||
    reply.snapshot.admission !== request.idle.expectedAdmission ||
    (request.idle.expectedAdmission === "open" && reply.snapshot.operationId !== null) ||
    (request.idle.expectedAdmission === "closed" && reply.snapshot.operationId !== request.operationId)
  ) {
    return "PILOT_ADMISSION_MISMATCH";
  }
  if (
    telemetry.supervisorIdentity.component !== "voice-worker" ||
    canonical(telemetry.supervisorIdentity) !== canonical(request.idle.expectedSupervisor) ||
    canonical(telemetry.supervisorIdentity.release) !== canonical(expectedRelease)
  ) {
    return "PILOT_TELEMETRY_WRONG_BOOT";
  }
  const bootStartedAt = Date.parse(telemetry.supervisorIdentity.startedAt);
  if (!Number.isFinite(bootStartedAt) || telemetry.supervisorUpdatedAt < bootStartedAt)
    return "PILOT_TELEMETRY_INVALID";
  if (
    telemetry.supervisorUpdatedAt > telemetry.queryFinishedAt ||
    telemetry.queryFinishedAt - telemetry.supervisorUpdatedAt > TELEMETRY_MAX_AGE_MS
  ) {
    return "PILOT_TELEMETRY_STALE";
  }
  return null;
}

// ── required dependency closure (chunk 5 Step 2) ──────────────────────────

/** Worker runtime modules whose resolved entry files form the required dependency set. */
export const PILOT_REQUIRED_MODULES = ["livekit-server-sdk", "@livekit/agents", "@livekit/rtc-node"] as const;

function packageVersionOf(entryRealpath: string, name: string, roots: readonly string[]): string | null {
  let directory = dirname(entryRealpath);
  while (roots.some((root) => within(root, directory))) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === name) return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      // Keep walking within the sealed closure only.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Native runtime artifacts the worker actually loads. A JS import graph alone
 * cannot see these: the RTC addon lives in a platform-specific sibling
 * package, the ONNX runtime ships one shared library and binding per
 * platform/arch, and the Silero VAD model is a data file no `require` names.
 * Without them a stale native binary or model swap under an unchanged JS tree
 * would pass `sameDependencySet` unnoticed.
 *
 * `packages` are tried in order and the first one present in the closure wins,
 * so a vendor layout change surfaces as `PILOT_DEPENDENCY_MISMATCH` rather
 * than a silently empty capture.
 */
export interface PilotNativeArtifact {
  id: "rtc-addon" | "onnx-runtime" | "silero-model";
  packages: readonly string[];
  match: RegExp;
  /** The package partitions its payload by `<platform>/<arch>` path segments. */
  platformPartitioned: boolean;
}

export const PILOT_REQUIRED_NATIVE_ARTIFACTS: readonly PilotNativeArtifact[] = [
  {
    id: "rtc-addon",
    packages: [
      `@livekit/rtc-ffi-bindings-${process.platform}-${process.arch}`,
      "@livekit/rtc-ffi-bindings",
      "@livekit/rtc-node",
    ],
    match: /\.node$/,
    platformPartitioned: false,
  },
  {
    id: "onnx-runtime",
    packages: ["onnxruntime-node"],
    match: /\.(?:node|dylib|so(?:\.\d+)*)$/,
    platformPartitioned: true,
  },
  {
    id: "silero-model",
    packages: ["@livekit/agents-plugin-silero"],
    match: /(?:^|\/)silero_vad\.onnx$/,
    platformPartitioned: false,
  },
];

/** Every `node_modules` ancestor of `start`, innermost first. */
function moduleDirectoriesOf(start: string): string[] {
  const found: string[] = [];
  let directory = dirname(start);
  for (;;) {
    if (basename(directory) === "node_modules") found.push(directory);
    const parent = dirname(directory);
    if (parent === directory) return found;
    directory = parent;
  }
}

function listFilesWithin(directory: string, roots: readonly string[], out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    // A link inside the closure could point at bytes the capture never seals.
    if (entry.isSymbolicLink()) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    if (entry.isDirectory()) listFilesWithin(path, roots, out);
    else if (entry.isFile()) out.push(path);
  }
}

/**
 * Resolve the native addon, shared library and model files the worker loads at
 * runtime, relative to a captured entry and inside the sealed closure roots.
 */
export function resolveRequiredNativeArtifacts(
  entry: string,
  roots: readonly string[],
): { path: string; realpath: string; version: string | null }[] {
  const require = createRequire(entry);
  let anchor: string;
  try {
    anchor = realpathSync(require.resolve("@livekit/rtc-node"));
  } catch (error) {
    throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
  }
  const moduleDirectories = moduleDirectoriesOf(anchor);
  const partition = `${sep}${process.platform}${sep}${process.arch}${sep}`;
  const resolved: { path: string; realpath: string; version: string | null }[] = [];
  for (const artifact of PILOT_REQUIRED_NATIVE_ARTIFACTS) {
    let root: string | null = null;
    let name = "";
    for (const candidate of artifact.packages) {
      for (const modules of moduleDirectories) {
        const directory = resolve(modules, ...candidate.split("/"));
        try {
          const real = realpathSync(directory);
          if (!roots.some((base) => within(base, real))) continue;
          if (!statSync(real).isDirectory()) continue;
          root = real;
          name = candidate;
        } catch {
          continue;
        }
        if (root) break;
      }
      if (root) break;
    }
    if (!root) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    const files: string[] = [];
    listFilesWithin(root, roots, files);
    let matched = files.filter((file) => artifact.match.test(file));
    if (artifact.platformPartitioned) matched = matched.filter((file) => file.includes(partition));
    if (matched.length === 0) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    const version = packageVersionOf(resolve(root, "package.json"), name, roots);
    for (const file of matched.sort()) {
      const real = realpathSync(file);
      if (!roots.some((base) => within(base, real))) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
      resolved.push({ path: file, realpath: real, version });
    }
  }
  return resolved;
}

/**
 * Resolve the required dependency files relative to a captured entry (never
 * the probe package's own dependencies). Every resolved realpath must stay
 * inside the sealed closure roots; hashes are computed by the caller's sealer.
 * The set is the JS module entries plus the native artifacts those modules
 * load — a native-only swap must not look like an unchanged dependency set.
 */
export function resolveRequiredDependencies(
  entry: string,
  roots: readonly string[],
): { path: string; realpath: string; version: string | null }[] {
  const require = createRequire(entry);
  const modules = PILOT_REQUIRED_MODULES.map((name) => {
    let resolved: string;
    let real: string;
    try {
      resolved = require.resolve(name);
      real = realpathSync(resolved);
    } catch (error) {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
    }
    if (!roots.some((root) => within(root, real))) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    return { path: resolve(resolved), realpath: real, version: packageVersionOf(real, name, roots) };
  });
  return [...modules, ...resolveRequiredNativeArtifacts(entry, roots)];
}

/** Exact dependency identity set equality, order-independent. */
export function sameDependencySet(
  left: readonly { realpath: string; sha256: string }[],
  right: readonly { realpath: string; sha256: string }[],
): boolean {
  const key = (items: readonly { realpath: string; sha256: string }[]) =>
    canonical(items.map((item) => `${item.realpath}\0${item.sha256}`).sort());
  return left.length === right.length && key(left) === key(right);
}
