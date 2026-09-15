/**
 * Installed side of the historical pilot probe ABI `hive-pilot-probe/1`
 * (KPR-463 plan chunk 5 Task 9 Step 4b.2a Steps 1–3).
 *
 * These modes run inside a sealed historical release's OWN
 * `pkg/runtime-probe.min.js` as an unconfined service probe:
 *
 * - `pilot-abi` — the handshake. Imports no configuration; resolves its own
 *   package relative to its entry and reports the exact supported ABI.
 * - `pilot-abi-v1 <input>` — one `observe` or `inventory` action. Verifies the
 *   sealed private request, the active acquired operation, its own release and
 *   probe seal and the selected service environment, then lazily imports its
 *   OWN bundled loader. Configuration projection, bridge authentication, SDK
 *   HTTP, owner-correlated status/telemetry and LiveKit inventory all happen in
 *   this process; credentials never leave it. Failures carry only a fixed
 *   classification, never partial results.
 *
 * The same operation-association and deadline helpers back the outer
 * bootstrap-probe `pilot`/`pilot-inventory` modes.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { parseBootIdentity } from "./health.js";
import { decodeOperationRecord } from "./operation.js";
import {
  canonicalBytes,
  MAX_RECORD_BYTES,
  sealFile,
  verifySeal,
  type Digest,
  type InstanceKey,
} from "./pilot-records.js";
import {
  countInventory,
  decodeHistoricalProbeRequest,
  historicalRequestPath,
  HISTORICAL_PROBE_ABI,
  HISTORICAL_SERVER_SDK,
  INVENTORY_LIMITATIONS,
  INVENTORY_MAX_ITEMS,
  allSipPages,
  inventoryDigest,
  pilotConfigIdentity,
  ProbeFailure,
  sameDependencySet,
  sortInventory,
  type BridgeObservation,
  type DependencyFile,
  type HistoricalIdle,
  type HistoricalIdleRequest,
  type HistoricalInventory,
  type HistoricalObservation,
  type HistoricalProbeRequest,
  type HistoricalTelemetry,
  type InventoryItem,
  type PilotAbiHandshake,
  type PilotConfigLoaderShape,
  type SdkObservation,
} from "./pilot-probe.js";
import type { Release } from "./release.js";
import type { ProcessIdentity } from "./services.js";
import type { MaintenanceReply, RequestMaintenanceOptions } from "../voice-worker/maintenance-ipc.js";
import type { OwnLoaderTelemetryRequest } from "./worker-maintenance-probe.js";

/** The historical loader's return shape actually consumed (credentials stay in this process). */
export interface HistoricalLoaderConfig extends PilotConfigLoaderShape {
  healthPort: number;
  bridgeToken: string;
  mongoUri: string;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}

export interface BridgeProbeOutcome {
  authenticated: boolean;
  missingDenied: boolean;
  wrongDenied: boolean;
  correctStatus: number | null;
  missingStatus: number | null;
  wrongStatus: number | null;
}

export interface WorkerHttpOutcome {
  rootStatus: number | null;
  agentName: string | null;
  activeJobs: number | null;
}

/** OS/probe boundaries shared by the historical and outer pilot probes. */
export interface PilotProbeBoundaries {
  now(): number;
  uid(): number;
  selfPath: string;
  env: NodeJS.ProcessEnv;
  /** Recomputes the canonical service environment from `env`, rejecting extras. */
  serviceEnvironment(env: NodeJS.ProcessEnv): Record<string, string>;
  readRelease(root: string): Release;
  processIdentity(pid: number, operationDirectory: string): Promise<ProcessIdentity | null>;
  listenerOwners(port: number, operationDirectory: string): Promise<number[]>;
  probeBridge(url: string, token: string): Promise<BridgeProbeOutcome>;
  probeWorkerHttp(port: number): Promise<WorkerHttpOutcome>;
  readTelemetry(
    wc: { mongoUri: string; mongoDbName: string },
    request: OwnLoaderTelemetryRequest,
  ): Promise<HistoricalTelemetry>;
  requestMaintenance(options: RequestMaintenanceOptions): Promise<MaintenanceReply>;
  /** LiveKit reads through the pinned server SDK; called only with loader-held credentials. */
  livekit(wc: HistoricalLoaderConfig): Promise<LivekitReader>;
  resolveDependencies(
    entry: string,
    roots: readonly string[],
  ): { path: string; realpath: string; version: string | null }[];
  sha256File(path: string): Promise<Digest>;
}

export interface HistoricalProbeDeps extends PilotProbeBoundaries {
  loadWorkerConfig(): Promise<HistoricalLoaderConfig>;
  /** Pinned `livekit-server-sdk` version resolved from this release's own entry. */
  serverSdkVersion(): string | null;
}

// ── shared helpers ────────────────────────────────────────────────────────

export async function withProbeDeadline<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T> {
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

export function operationDirectoryOf(canonicalHome: string, operationId: string): string {
  return resolve(canonicalHome, ".hive-state", "deployment", "operations", operationId);
}

/**
 * The active acquired operation owns the lock and has not resolved. For an
 * idle read the barrier state must match the phase: open requires no close by
 * this operation; closed requires this operation's recorded close of the same
 * supervisor boot. Works for lifecycle and registry work alike.
 */
export async function assertActiveProbeOperation(
  home: string,
  operationId: string,
  idle: HistoricalIdleRequest | null,
): Promise<ReturnType<typeof decodeOperationRecord>> {
  let record: ReturnType<typeof decodeOperationRecord>;
  try {
    const owner = JSON.parse(
      await readFile(resolve(home, ".hive-state", "deployment", "lock", "owner.json"), "utf8"),
    ) as { id?: unknown; canonicalHome?: unknown };
    record = decodeOperationRecord(
      JSON.parse(await readFile(resolve(operationDirectoryOf(home, operationId), "operation.json"), "utf8")),
    );
    if (
      owner.id !== operationId ||
      owner.canonicalHome !== home ||
      record.schemaVersion !== 2 ||
      record.id !== operationId ||
      record.canonicalHome !== home ||
      record.resolution !== undefined ||
      record.phase === "unresolved" ||
      // Idle (admission) reads never follow a signal; profile reads after activation may.
      (idle !== null && record.signalsBegun !== false)
    ) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
  if (idle === null || record.schemaVersion !== 2) return record;
  const supervisor = idle.expectedSupervisor;
  const registryBarrier = record.registry?.barrier ?? null;
  const closedByThis =
    record.workKind === "registry"
      ? registryBarrier !== null &&
        registryBarrier.operationId === operationId &&
        registryBarrier.bootId === supervisor.bootId &&
        registryBarrier.supervisor.pid === supervisor.pid &&
        (registryBarrier.state === "close-intended" || registryBarrier.state === "closed")
      : record.barrierOperationId === operationId &&
        record.supervisor?.pid === supervisor.pid &&
        record.supervisor?.bootId === supervisor.bootId;
  const anyClose = record.workKind === "registry" ? registryBarrier !== null : record.barrierOperationId !== undefined;
  if (idle.expectedAdmission === "open" ? anyClose : !closedByThis) {
    throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
  }
  return record;
}

/** Read and seal a private request exactly at its fixed operation path (0600, no symlink). */
export async function readSealedRequest(inputPath: string, uid: number): Promise<Buffer> {
  if (!isAbsolute(inputPath) || resolve(inputPath) !== inputPath) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  try {
    const sealed = await sealFile(inputPath, { uid, maxBytes: MAX_RECORD_BYTES });
    if (sealed.mode !== 0o600 || sealed.realpath !== inputPath) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    return sealed.bytes;
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
}

/** Map a successful bridge probe; any denial/authentication failure is a fixed failure. */
export function bridgeObservationOf(outcome: BridgeProbeOutcome): BridgeObservation {
  if (
    !outcome.authenticated ||
    !outcome.missingDenied ||
    !outcome.wrongDenied ||
    outcome.correctStatus === null ||
    outcome.missingStatus === null ||
    outcome.wrongStatus === null
  ) {
    throw new ProbeFailure("PILOT_BRIDGE_FAILED");
  }
  return {
    correctStatus: outcome.correctStatus,
    correctClassification: "missing-agent",
    missingStatus: outcome.missingStatus,
    wrongStatus: outcome.wrongStatus,
  };
}

export function sdkObservationOf(port: number, http: WorkerHttpOutcome): SdkObservation {
  if (http.rootStatus === null || http.agentName === null || http.activeJobs === null || http.activeJobs < 0) {
    throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
  }
  return {
    host: "127.0.0.1",
    port,
    rootStatus: http.rootStatus,
    agentName: http.agentName,
    activeJobs: http.activeJobs,
  };
}

/** Resolve and hash the required dependency files relative to an entry, inside the sealed roots. */
export async function observedDependencyFiles(
  deps: Pick<PilotProbeBoundaries, "resolveDependencies" | "sha256File">,
  entry: string,
  roots: readonly string[],
): Promise<DependencyFile[]> {
  const out: DependencyFile[] = [];
  for (const item of deps.resolveDependencies(entry, roots)) {
    out.push({ ...item, sha256: await deps.sha256File(item.realpath) });
  }
  return out;
}

/**
 * Owner-correlated status + telemetry within one deadline (chunk 5 Step 2a).
 * The supervisor is corroborated from the instance descriptor, the live
 * process and the SDK listener owner before and after; nothing is taken from
 * the request without observation.
 */
export async function ownerCorrelatedIdle(input: {
  deps: PilotProbeBoundaries;
  home: string;
  instanceId: string;
  operationId: string;
  requestedAt: number;
  deadline: number;
  idle: HistoricalIdleRequest;
  sdkPort: number;
  expectedRelease: Release;
  wc: { mongoUri: string; mongoDbName: string };
}): Promise<HistoricalIdle> {
  const { deps, idle } = input;
  const operationDirectory = operationDirectoryOf(input.home, input.operationId);
  const descriptorPath = resolve(input.home, ".hive-state", "runtime", "voice-worker.json");
  const corroborate = async () => {
    let descriptor;
    try {
      descriptor = parseBootIdentity(JSON.parse(await readFile(descriptorPath, "utf8")));
    } catch (error) {
      throw new ProbeFailure("PILOT_TELEMETRY_WRONG_BOOT", { cause: error });
    }
    if (canonical(descriptor) !== canonical(idle.expectedSupervisor))
      throw new ProbeFailure("PILOT_TELEMETRY_WRONG_BOOT");
    if (!(await deps.processIdentity(descriptor.pid, operationDirectory)))
      throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    const owners = await deps.listenerOwners(input.sdkPort, operationDirectory);
    if (owners.length !== 1 || owners[0] !== descriptor.pid) throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    return { pid: descriptor.pid, bootId: descriptor.bootId };
  };
  await withProbeDeadline(corroborate(), input.deadline, deps.now);
  let statusRequestedAt = 0;
  let statusFinishedAt = 0;
  const status = async () => {
    statusRequestedAt = deps.now();
    const reply = await deps.requestMaintenance({
      instanceHome: input.home,
      instanceId: input.instanceId,
      operationId: input.operationId,
      kind: "status",
      deadline: input.deadline,
      expectedAdmission: idle.expectedAdmission,
      supervisor: { pid: idle.expectedSupervisor.pid, bootId: idle.expectedSupervisor.bootId },
      randomId: () => idle.statusRequestId,
      corroborateSupervisor: corroborate,
      now: deps.now,
    });
    statusFinishedAt = deps.now();
    return reply;
  };
  let reply: MaintenanceReply;
  let telemetry: HistoricalTelemetry;
  try {
    [reply, telemetry] = await withProbeDeadline(
      Promise.all([
        status(),
        deps.readTelemetry(input.wc, {
          action: "observe",
          requestedAt: input.requestedAt,
          deadline: input.deadline,
          expectedRelease: input.expectedRelease,
          idle,
        }),
      ]),
      input.deadline,
      deps.now,
    );
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure(deps.now() >= input.deadline ? "PILOT_PROBE_DEADLINE" : "PILOT_ADMISSION_MISMATCH", {
      cause: error,
    });
  }
  await withProbeDeadline(corroborate(), input.deadline, deps.now);
  return { status: { requestedAt: statusRequestedAt, finishedAt: statusFinishedAt, reply }, telemetry };
}

// ── LiveKit inventory (chunk 5 Step 3) ────────────────────────────────────

interface RoomRow {
  sid?: unknown;
  name?: unknown;
}
interface ParticipantRow {
  sid?: unknown;
}
interface DispatchRow {
  id?: unknown;
  agentName?: unknown;
}
interface RuleRow {
  sipDispatchRuleId?: unknown;
  roomConfig?: { agents?: { agentName?: unknown }[] } | null;
}
interface TrunkRow {
  sipTrunkId?: unknown;
}

/** The pinned 2.14.1 read surface; nothing here mutates vendor state. */
export interface LivekitReader {
  listRooms(): Promise<RoomRow[]>;
  listParticipants(room: string): Promise<ParticipantRow[]>;
  listDispatch(room: string): Promise<DispatchRow[]>;
  listSipDispatchRule(page: { limit: number; afterId: string }): Promise<RuleRow[]>;
  listSipInboundTrunk(page: { limit: number; afterId: string }): Promise<TrunkRow[]>;
}

function rawId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  }
  return value;
}

function agentName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || /[\0\r\n]/.test(value)) {
    throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  }
  return value;
}

/**
 * Complete bounded traversal with immediate normalization to salted digests.
 * Participant identities/names/metadata, SIP numbers, tokens and raw rows never
 * leave this function. Any partial/denied/overflow response fails closed.
 */
export async function collectLivekitInventory(reader: LivekitReader, operationId: string): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  const push = (item: InventoryItem) => {
    items.push(item);
    if (items.length > INVENTORY_MAX_ITEMS) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
  };
  const list = async <T>(call: () => Promise<T[]>): Promise<T[]> => {
    let rows: T[];
    try {
      rows = await call();
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE", { cause: error });
    }
    if (!Array.isArray(rows) || rows.length > INVENTORY_MAX_ITEMS) throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE");
    return rows;
  };
  for (const room of await list(() => reader.listRooms())) {
    const roomId = inventoryDigest(operationId, "room", rawId(room.sid));
    const name = rawId(room.name);
    push({ kind: "room", id: roomId, parent: null, agentName: null });
    for (const participant of await list(() => reader.listParticipants(name))) {
      push({
        kind: "participant",
        id: inventoryDigest(operationId, "participant", rawId(participant.sid)),
        parent: roomId,
        agentName: null,
      });
    }
    for (const dispatch of await list(() => reader.listDispatch(name))) {
      push({
        kind: "dispatch",
        id: inventoryDigest(operationId, "dispatch", rawId(dispatch.id)),
        parent: roomId,
        agentName: dispatch.agentName === undefined || dispatch.agentName === "" ? null : agentName(dispatch.agentName),
      });
    }
  }
  let rules: RuleRow[];
  let trunks: TrunkRow[];
  try {
    rules = await allSipPages(
      (page) => reader.listSipDispatchRule(page),
      (row) => rawId(row.sipDispatchRuleId),
    );
    trunks = await allSipPages(
      (page) => reader.listSipInboundTrunk(page),
      (row) => rawId(row.sipTrunkId),
    );
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_INVENTORY_INCOMPLETE", { cause: error });
  }
  for (const rule of rules) {
    const id = inventoryDigest(operationId, "sip-rule", rawId(rule.sipDispatchRuleId));
    const agents = [...new Set((rule.roomConfig?.agents ?? []).map((agent) => agentName(agent.agentName)))];
    if (agents.length === 0) push({ kind: "sip-rule", id, parent: null, agentName: null });
    for (const name of agents) push({ kind: "sip-rule", id, parent: null, agentName: name });
  }
  for (const trunk of trunks) {
    push({
      kind: "inbound-trunk",
      id: inventoryDigest(operationId, "inbound-trunk", rawId(trunk.sipTrunkId)),
      parent: null,
      agentName: null,
    });
  }
  return sortInventory(items);
}

// ── historical modes ──────────────────────────────────────────────────────

function ownRoot(selfRealpath: string): string {
  if (basename(dirname(selfRealpath)) !== "pkg") throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  return dirname(dirname(selfRealpath));
}

/** `pilot-abi`: handshake only. Imports no configuration and reads no credentials. */
export async function runPilotAbiHandshake(deps: HistoricalProbeDeps): Promise<PilotAbiHandshake> {
  deps.serviceEnvironment(deps.env);
  let root: string;
  let own: Release;
  try {
    root = ownRoot(await realpath(deps.selfPath));
    own = deps.readRelease(root);
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED", { cause: error });
  }
  if (deps.serverSdkVersion() !== HISTORICAL_SERVER_SDK) throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  return {
    schemaVersion: 1,
    abi: HISTORICAL_PROBE_ABI,
    projection: 1,
    serverSdk: HISTORICAL_SERVER_SDK,
    operations: ["observe", "inventory"],
    release: own,
  };
}

/** `pilot-abi-v1 <input>`: one sealed observe/inventory action inside this historical loader process. */
export async function runHistoricalProbe(
  inputPath: string,
  deps: HistoricalProbeDeps,
): Promise<HistoricalObservation | HistoricalInventory> {
  const bytes = await readSealedRequest(inputPath, deps.uid());
  let request: HistoricalProbeRequest;
  try {
    request = decodeHistoricalProbeRequest(parseCanonical(bytes));
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
  const home = request.instance.canonicalHome;
  if (inputPath !== historicalRequestPath(home, request)) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const startedAt = deps.now();
  if (startedAt < request.requestedAt || startedAt >= request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  await assertActiveProbeOperation(home, request.operationId, request.idle);

  // Own release, probe seal and selected service environment.
  let root: string;
  try {
    const self = await realpath(deps.selfPath);
    if (self !== request.expectedProbe.realpath) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    await verifySeal(request.expectedProbe, { uid: deps.uid() });
    root = ownRoot(self);
    if (canonical(deps.readRelease(root)) !== canonical(request.expectedRelease)) {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
  }
  const environment = assertEnvironment(deps, request.instance);

  let wc: HistoricalLoaderConfig;
  try {
    wc = await withProbeDeadline(deps.loadWorkerConfig(), request.deadline, deps.now);
  } catch (error) {
    if (error instanceof ProbeFailure && error.classification === "PILOT_PROBE_DEADLINE") throw error;
    throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE", { cause: error });
  }
  if ((await realpath(wc.instanceHome).catch(() => "")) !== home || environment.HIVE_HOME !== home) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  if (!Number.isSafeInteger(wc.healthPort) || wc.healthPort !== request.sdkPort) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  const configIdentity = pilotConfigIdentity({ ...wc, instanceHome: home }, request.instance, request.sdkPort);

  if (request.action === "inventory") {
    const reader = await deps.livekit(wc);
    const items = await withProbeDeadline(
      collectLivekitInventory(reader, request.operationId),
      request.deadline,
      deps.now,
    );
    const finishedAt = deps.now();
    if (finishedAt > request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
    return {
      schemaVersion: 1,
      abi: HISTORICAL_PROBE_ABI,
      action: "inventory",
      requestId: request.requestId,
      operationId: request.operationId,
      subject: request.subject,
      instance: request.instance,
      startedAt,
      finishedAt,
      release: request.expectedRelease,
      projection: 1,
      configIdentity,
      items,
      counts: countInventory(items),
      limitations: [...INVENTORY_LIMITATIONS],
    };
  }

  const [bridge, http, idle] = await withProbeDeadline(
    Promise.all([
      deps.probeBridge(wc.bridgeUrl, wc.bridgeToken),
      deps.probeWorkerHttp(request.sdkPort),
      request.idle === null
        ? Promise.resolve(null)
        : ownerCorrelatedIdle({
            deps,
            home,
            instanceId: request.instance.instanceId,
            operationId: request.operationId,
            requestedAt: request.requestedAt,
            deadline: request.deadline,
            idle: request.idle,
            sdkPort: request.sdkPort,
            expectedRelease: request.expectedRelease,
            wc,
          }),
    ]),
    request.deadline,
    deps.now,
  );
  const dependencyFiles = await observedDependencyFiles(deps, await realpath(deps.selfPath), [root]);
  if (!sameDependencySet(dependencyFiles, request.dependencyFiles)) throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
  const finishedAt = deps.now();
  if (finishedAt > request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  return {
    schemaVersion: 1,
    abi: HISTORICAL_PROBE_ABI,
    action: "observe",
    requestId: request.requestId,
    operationId: request.operationId,
    subject: request.subject,
    instance: request.instance,
    startedAt,
    finishedAt,
    release: request.expectedRelease,
    projection: 1,
    configIdentity,
    bridge: bridgeObservationOf(bridge),
    sdk: sdkObservationOf(request.sdkPort, http),
    idle,
    dependencyFiles,
  };
}

function assertEnvironment(deps: PilotProbeBoundaries, instance: InstanceKey): Record<string, string> {
  let environment: Record<string, string>;
  try {
    environment = deps.serviceEnvironment(deps.env);
  } catch (error) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH", { cause: error });
  }
  if (environment.HIVE_CONFIG !== instance.configPath) throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  return environment;
}

export { assertEnvironment as assertProbeEnvironment };

/** Sanitized failure envelope; the request ID only when it can be safely decoded. */
export async function probeFailureEnvelope(
  inputPath: string | undefined,
  classification: string,
  abi: string | null,
): Promise<Record<string, unknown>> {
  let requestId = "00000000-0000-0000-0000-000000000000";
  try {
    if (inputPath && isAbsolute(inputPath)) {
      const decoded = JSON.parse(await readFile(inputPath, "utf8")) as { requestId?: unknown };
      if (typeof decoded.requestId === "string" && /^[0-9a-f-]{36}$/i.test(decoded.requestId)) {
        requestId = decoded.requestId;
      }
    }
  } catch {
    // zero UUID
  }
  return abi === null
    ? { schemaVersion: 1, requestId, classification }
    : { schemaVersion: 1, abi, requestId, classification };
}

export function sha256Bytes(bytes: Buffer): Digest {
  return createHash("sha256").update(bytes).digest("hex");
}

export { canonicalBytes };
