/**
 * Installed side of the private `worker-maintenance` probe and the shared
 * own-loader telemetry read (KPR-463 plan chunk 5 Task 9 Step 4b.2a Steps
 * 2a–2b). Runs inside the RUNNING installed release's `runtime-probe.min.js`
 * as an unconfined service probe: it must be able to write its maintenance
 * status command into the worker mailbox.
 *
 * Before any read it verifies its private request file, its association with
 * the active acquired operation, its own Node/probe/root/release and the exact
 * service selectors. Its own lazy loader resolves configuration and Mongo
 * credentials, which never leave this process. Status, SDK HTTP and the
 * kind-only Mongo read run within one absolute deadline; any failure yields a
 * fixed classification and no partial result.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { parseBootIdentity } from "./health.js";
import { decodeOperationRecord } from "./operation.js";
import { MAX_RECORD_BYTES, sealFile, sha256Hex, verifySeal } from "./pilot-records.js";
import {
  classificationOf,
  decodeWorkerMaintenanceRequest,
  ProbeFailure,
  sha256Canonical,
  WORKER_MAINTENANCE_ABI,
  ZERO_UUID,
  type HistoricalTelemetry,
  type WorkerMaintenanceObservation,
  type WorkerMaintenanceRequest,
} from "./pilot-probe.js";
import type { MaintenanceReply, RequestMaintenanceOptions } from "../voice-worker/maintenance-ipc.js";
import type { Release } from "./release.js";
import type { ProcessIdentity } from "./services.js";

export interface OwnLoaderTelemetryRequest {
  action: "observe";
  requestedAt: number;
  deadline: number;
  expectedRelease: Release;
  idle: WorkerMaintenanceRequest["idle"] | null;
}

export interface TelemetryRow {
  kind?: unknown;
  supervisorIdentity?: unknown;
  supervisorUpdatedAt?: unknown;
  activeCalls?: unknown;
}

/** The kind-only telemetry query, injected only in unit tests. */
export type TelemetryQuery = (
  wc: { mongoUri: string; mongoDbName: string },
  budgetMs: number,
  remaining: () => number,
) => Promise<TelemetryRow[]>;

export const mongoTelemetryQuery: TelemetryQuery = async (wc, budgetMs, remaining) => {
  const { MongoClient } = await import("mongodb");
  const mongo = new MongoClient(wc.mongoUri, {
    serverSelectionTimeoutMS: budgetMs,
    connectTimeoutMS: budgetMs,
    socketTimeoutMS: budgetMs,
    readPreference: "primary",
  });
  try {
    await mongo.connect();
    const left = remaining();
    if (left <= 0) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
    return (await mongo
      .db(wc.mongoDbName)
      .collection("telemetry")
      .find(
        { kind: "voice_worker_stats" },
        {
          projection: { _id: 0, kind: 1, supervisorIdentity: 1, supervisorUpdatedAt: 1, activeCalls: 1 },
          maxTimeMS: left,
        },
      )
      .limit(2)
      .toArray()) as TelemetryRow[];
  } finally {
    await mongo.close().catch(() => {});
  }
};

/**
 * Strict own-loader telemetry (chunk 5 Step 2a). Filters only on kind so
 * wrong-boot or duplicate rows cannot be hidden; never maps an error or
 * stale/missing/wrong-boot data to zero, and never uses job `updatedAt`.
 */
export async function readOwnLoaderTelemetry(
  wc: { mongoUri: string; mongoDbName: string },
  request: OwnLoaderTelemetryRequest,
  options: { now?: () => number; query?: TelemetryQuery } = {},
): Promise<HistoricalTelemetry> {
  const now = options.now ?? Date.now;
  const query = options.query ?? mongoTelemetryQuery;
  if (request.action !== "observe" || request.idle === null) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const queryStartedAt = now();
  const budget = request.deadline - queryStartedAt;
  if (budget <= 0 || queryStartedAt < request.requestedAt) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  let rows: TelemetryRow[];
  try {
    rows = await query(wc, budget, () => request.deadline - now());
  } catch {
    throw new ProbeFailure(now() >= request.deadline ? "PILOT_PROBE_DEADLINE" : "PILOT_TELEMETRY_QUERY_FAILED");
  }
  const queryFinishedAt = now();
  if (queryFinishedAt < queryStartedAt || queryFinishedAt > request.deadline) {
    throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new ProbeFailure("PILOT_TELEMETRY_MISSING");
  if (rows.length !== 1) throw new ProbeFailure("PILOT_TELEMETRY_INVALID");
  const row = rows[0];
  if (row.kind !== "voice_worker_stats" || !Number.isSafeInteger(row.activeCalls) || (row.activeCalls as number) < 0) {
    throw new ProbeFailure("PILOT_TELEMETRY_INVALID");
  }
  let identity;
  try {
    identity = parseBootIdentity(row.supervisorIdentity);
  } catch {
    throw new ProbeFailure("PILOT_TELEMETRY_INVALID");
  }
  if (
    identity.component !== "voice-worker" ||
    canonical(identity) !== canonical(request.idle.expectedSupervisor) ||
    canonical(identity.release) !== canonical(request.expectedRelease)
  ) {
    throw new ProbeFailure("PILOT_TELEMETRY_WRONG_BOOT");
  }
  const updatedAt =
    row.supervisorUpdatedAt instanceof Date
      ? row.supervisorUpdatedAt.getTime()
      : typeof row.supervisorUpdatedAt === "string"
        ? Date.parse(row.supervisorUpdatedAt)
        : Number.NaN;
  const bootStartedAt = Date.parse(identity.startedAt);
  if (!Number.isSafeInteger(updatedAt) || !Number.isFinite(bootStartedAt) || updatedAt < bootStartedAt) {
    throw new ProbeFailure("PILOT_TELEMETRY_INVALID");
  }
  if (updatedAt > queryFinishedAt || queryFinishedAt - updatedAt > 60_000)
    throw new ProbeFailure("PILOT_TELEMETRY_STALE");
  return {
    queryStartedAt,
    queryFinishedAt,
    supervisorIdentity: identity,
    supervisorUpdatedAt: updatedAt,
    activeCalls: row.activeCalls as number,
  };
}

export interface WorkerMaintenanceProbeDeps {
  now(): number;
  uid(): number;
  selfPath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** Recomputes the canonical service environment from `env`, rejecting extras. */
  serviceEnvironment(env: NodeJS.ProcessEnv): Record<string, string>;
  readRelease(root: string): Release;
  loadWorkerConfig(): Promise<{
    instanceHome: string;
    instanceId: string;
    healthPort: number;
    mongoUri: string;
    mongoDbName: string;
  }>;
  inspectWorker(label: string, operationDirectory: string): Promise<ProcessIdentity | null>;
  processStartTime(pid: number, operationDirectory: string): Promise<string | null>;
  listenerPid(port: number, supervisorPid: number, operationDirectory: string): Promise<number | null>;
  probeWorkerHttp(
    port: number,
  ): Promise<{ rootStatus: number | null; agentName: string | null; activeJobs: number | null }>;
  readTelemetry(
    wc: { mongoUri: string; mongoDbName: string },
    request: OwnLoaderTelemetryRequest,
  ): Promise<HistoricalTelemetry>;
  requestMaintenance(options: RequestMaintenanceOptions): Promise<MaintenanceReply>;
}

function sameProcess(identity: ProcessIdentity | null, request: WorkerMaintenanceRequest): boolean {
  const w = request.expectedWorker;
  return (
    identity !== null &&
    identity.pid === w.pid &&
    identity.startTime === w.startTime &&
    identity.executable === w.executable &&
    identity.command === w.command &&
    identity.cwd === w.cwd
  );
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure("PILOT_PROBE_DEADLINE")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Execute one private `worker-maintenance` observation. Throws `ProbeFailure`
 * with a fixed classification; the caller prints only the sanitized envelope.
 */
export async function runWorkerMaintenanceProbe(
  inputPath: string,
  deps: WorkerMaintenanceProbeDeps,
): Promise<WorkerMaintenanceObservation> {
  if (!isAbsolute(inputPath) || resolve(inputPath) !== inputPath || basename(inputPath) !== "worker-maintenance.json") {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  let requestBytes: Buffer;
  let request: WorkerMaintenanceRequest;
  try {
    const sealed = await sealFile(inputPath, { uid: deps.uid(), maxBytes: MAX_RECORD_BYTES });
    if (sealed.mode !== 0o600 || sealed.realpath !== inputPath) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    requestBytes = sealed.bytes;
    request = decodeWorkerMaintenanceRequest(parseCanonical(requestBytes));
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
  const home = request.instance.canonicalHome;
  const operationDirectory = resolve(home, ".hive-state", "deployment", "operations", request.operationId);
  if (inputPath !== resolve(operationDirectory, "probes", request.jobId, "worker-maintenance.json")) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  const startedAt = deps.now();
  if (startedAt < request.requestedAt || startedAt >= request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");

  // Association with the active acquired operation and its legal phase.
  try {
    const owner = JSON.parse(
      await readFile(resolve(home, ".hive-state", "deployment", "lock", "owner.json"), "utf8"),
    ) as {
      id?: unknown;
      canonicalHome?: unknown;
    };
    const record = decodeOperationRecord(
      JSON.parse(await readFile(resolve(operationDirectory, "operation.json"), "utf8")),
    );
    if (
      owner.id !== request.operationId ||
      owner.canonicalHome !== home ||
      record.schemaVersion !== 2 ||
      record.id !== request.operationId ||
      record.workKind !== "lifecycle" ||
      record.canonicalHome !== home ||
      record.instanceId !== request.instance.instanceId ||
      record.signalsBegun
    ) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    }
    const supervisor = request.idle.expectedSupervisor;
    if (request.phase === "baseline") {
      if (record.barrierOperationId !== undefined) throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    } else if (
      record.barrierOperationId !== request.operationId ||
      record.supervisor?.pid !== supervisor.pid ||
      record.supervisor?.bootId !== supervisor.bootId
    ) {
      throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }

  // Exact own runtime: root, Node, probe, release, config and service selectors.
  try {
    const root = request.runtime.root;
    const rootInfo = await lstat(root.path);
    if (
      root.path !== resolve(home, ".hive") ||
      rootInfo.isSymbolicLink() ||
      rootInfo.dev !== root.identity.dev ||
      rootInfo.ino !== root.identity.ino ||
      rootInfo.uid !== root.identity.uid
    ) {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    }
    if ((await realpath(deps.selfPath)) !== request.runtime.probe.realpath)
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    await verifySeal(request.runtime.probe, { uid: deps.uid() });
    // The frozen caller hashed Node's bytes; here identity/owner/size/mode must still match.
    const node = request.runtime.node;
    const nodeInfo = await lstat(node.realpath);
    if (
      (await realpath(deps.execPath)) !== node.realpath ||
      nodeInfo.dev !== node.dev ||
      nodeInfo.ino !== node.ino ||
      nodeInfo.size !== node.size ||
      (nodeInfo.mode & 0o7777) !== node.mode ||
      nodeInfo.uid !== node.uid
    ) {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    }
    if (canonical(deps.readRelease(root.path)) !== canonical(request.expectedRelease)) {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    }
    await verifySeal(request.runtime.config, { uid: deps.uid() });
    const environment = deps.serviceEnvironment(deps.env);
    if (
      sha256Canonical(environment) !== request.runtime.environmentSha256 ||
      environment.HIVE_HOME !== home ||
      (await realpath(environment.HIVE_CONFIG)) !== request.runtime.config.realpath
    ) {
      throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
  }

  let wc: Awaited<ReturnType<WorkerMaintenanceProbeDeps["loadWorkerConfig"]>>;
  try {
    wc = await deps.loadWorkerConfig();
  } catch (error) {
    throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE", { cause: error });
  }
  if ((await realpath(wc.instanceHome).catch(() => "")) !== home || wc.instanceId !== request.instance.instanceId) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }

  const label = `com.hive.${request.instance.instanceId}.voice-worker`;
  const descriptorPath = resolve(home, ".hive-state", "runtime", "voice-worker.json");
  const corroborate = async () => {
    const descriptor = parseBootIdentity(JSON.parse(await readFile(descriptorPath, "utf8")));
    if (canonical(descriptor) !== canonical(request.idle.expectedSupervisor))
      throw new ProbeFailure("PILOT_TELEMETRY_WRONG_BOOT");
    const live = await deps.inspectWorker(label, operationDirectory);
    if (!sameProcess(live, request)) throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    if ((await deps.processStartTime(descriptor.pid, operationDirectory)) !== request.expectedWorker.startTime) {
      throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    }
    if ((await deps.listenerPid(wc.healthPort, descriptor.pid, operationDirectory)) !== descriptor.pid) {
      throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    }
    return { pid: descriptor.pid, bootId: descriptor.bootId };
  };
  await withDeadline(corroborate(), request.deadline, deps.now);

  let statusRequestedAt = 0;
  let statusFinishedAt = 0;
  const status = async () => {
    statusRequestedAt = deps.now();
    const reply = await deps.requestMaintenance({
      instanceHome: home,
      instanceId: request.instance.instanceId,
      operationId: request.operationId,
      kind: "status",
      deadline: request.deadline,
      expectedAdmission: request.idle.expectedAdmission,
      supervisor: { pid: request.idle.expectedSupervisor.pid, bootId: request.idle.expectedSupervisor.bootId },
      randomId: () => request.idle.statusRequestId,
      corroborateSupervisor: corroborate,
      now: deps.now,
    });
    statusFinishedAt = deps.now();
    return reply;
  };
  let reply: MaintenanceReply;
  let http: Awaited<ReturnType<WorkerMaintenanceProbeDeps["probeWorkerHttp"]>>;
  let telemetry: HistoricalTelemetry;
  try {
    [reply, http, telemetry] = await withDeadline(
      Promise.all([status(), deps.probeWorkerHttp(wc.healthPort), deps.readTelemetry(wc, request)]),
      request.deadline,
      deps.now,
    );
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure(deps.now() >= request.deadline ? "PILOT_PROBE_DEADLINE" : "PILOT_ADMISSION_MISMATCH", {
      cause: error,
    });
  }
  if (http.rootStatus === null || http.agentName === null || http.activeJobs === null) {
    throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
  }
  // Repeat process/descriptor/listener correspondence after the reads.
  await withDeadline(corroborate(), request.deadline, deps.now);
  const finishedAt = deps.now();
  if (finishedAt > request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  return {
    schemaVersion: 1,
    abi: WORKER_MAINTENANCE_ABI,
    action: "observe",
    requestId: request.requestId,
    operationId: request.operationId,
    jobId: request.jobId,
    instance: request.instance,
    phase: request.phase,
    requestSha256: sha256Hex(requestBytes),
    startedAt,
    finishedAt,
    release: request.expectedRelease,
    sdk: {
      host: "127.0.0.1",
      port: wc.healthPort,
      rootStatus: http.rootStatus,
      agentName: http.agentName,
      activeJobs: http.activeJobs,
    },
    idle: { status: { requestedAt: statusRequestedAt, finishedAt: statusFinishedAt, reply }, telemetry },
  };
}

/** Sanitized failure envelope; the request ID only when it can be safely decoded. */
export async function workerMaintenanceFailure(inputPath: string | undefined, error: unknown) {
  let requestId = ZERO_UUID;
  try {
    if (inputPath && isAbsolute(inputPath) && dirname(inputPath)) {
      const decoded = JSON.parse(await readFile(inputPath, "utf8")) as { requestId?: unknown };
      if (typeof decoded.requestId === "string" && /^[0-9a-f-]{36}$/i.test(decoded.requestId)) {
        requestId = decoded.requestId;
      }
    }
  } catch {
    requestId = ZERO_UUID;
  }
  return { schemaVersion: 1, abi: WORKER_MAINTENANCE_ABI, requestId, classification: classificationOf(error) };
}
