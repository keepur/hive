/**
 * Registered pilot evidence: selection, reconstruction, current inventory,
 * explicit legacy deferral, hold release and lineage (KPR-463 plan chunk 4
 * Task 9 Steps 4b–4c and Task 8 Step 5a, chunk 5 Task 9 Step 4b.1a Step 2).
 *
 * This module supplies the concrete `PilotEvidenceProvider` consumed by
 * `pilot-lifecycle.ts`. It never fabricates hold evidence: a file, JSON field
 * or boolean cannot establish a hold. For a snapshot whose admission capability
 * is `unavailable` — the described uninstrumented pilot — every hold route
 * returns the executed `MIGRATION_PENDING` result with fixed gap codes before
 * any stage, close or signal. A native hold is accepted only through an
 * independently corroborated historical runtime (`pilot-observer.ts`): the
 * capable branch closes under the owning operation through the shared
 * maintenance client and proves idle from owner-correlated historical reads;
 * without wired probe boundaries or current corroboration it defers with a
 * fixed code.
 */
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createLogger } from "../logging/logger.js";
import { canonical } from "./canonical.js";
import { pilotRecovered } from "./health.js";
import {
  decodeOperationRecord,
  OperationUnresolvedError,
  persistOperation,
  writeOperationJson,
  type AcquiredOperation,
  type OperationRecord,
  type ProcessOwner,
} from "./operation.js";
import {
  assemblePilotRecoveryEvidence,
  LEGACY_HOLD_GAP_CODES,
  PILOT_ACTIVATION_FILE,
  PILOT_GENERATION_FILE,
  PilotEvidenceUnavailableError,
  readFencedMarkers,
  type ActivationFences,
  type HoldCapability,
  type PilotEvidenceProvider,
  type PilotInstanceKey,
  type PilotLineage,
  type PilotRecoveryObservations,
  type RegisteredPilot,
} from "./pilot-lifecycle.js";
import {
  canonicalBytes,
  int,
  inventoryClasses,
  object,
  readReference,
  readRegisteredRecord,
  reconcileRegistration,
  registerRecord,
  sealFile,
  str,
  verifySeal,
  verifyTreeSeal,
  within,
  type BootstrapRecord,
  type CapturePreparation,
  type CheckSpec,
  type FileSeal,
  type HoldRecord,
  type InstanceKey,
  type InventoryClass,
  type PilotSnapshot,
  type ProcessSeal,
  type RecordRef,
  type RegisteredRecord,
  type SourceObservation,
} from "./pilot-records.js";
import { decodePriorSnapshot, type LoadedPrior } from "./prior.js";
import type { RecordedBarrier } from "./reconcile.js";
import { DeferredMaintenance, UnresolvedMaintenance } from "./transaction.js";
import {
  corroborateNativeCapability,
  establishNativeHold,
  invokePilotInventory,
  invokePilotProbe,
  PilotProbeFault,
  preparePilotProbe,
  processSealOf,
  registeredProbeSubject,
  type EstablishedNativeHold,
  type NativeHoldDeps,
  type PilotProbeLaunchIO,
  type PilotProbeSubject,
} from "./pilot-observer.js";
import type { StopProofClock } from "./stop-proof.js";
import type { PilotInventoryResult } from "./pilot-probe.js";
import type {
  CaptureTicketLease,
  CapturedServiceDefinition,
  ServiceController,
  ServiceInspection,
  ServiceSnapshot,
} from "./services.js";

const log = createLogger("deployment-pilot");

// ── durable registry work state ───────────────────────────────────────────

/** Durable registry work state (chunk 5 Task 8 Step 1a.3 Step 1). */
export interface RegistryWork {
  command: "capture-pilot" | "inventory-pilot" | "prepare-legacy-hold" | "verify-legacy-hold" | "release-legacy-hold";
  phase: "reading" | "probing" | "closing" | "registering" | "releasing" | "finished";
  selectedSnapshot: RecordRef | null;
  selectedHold: RecordRef | null;
  bootstrap: RecordRef | null;
  capture: CapturePreparation | null;
  result: FileSeal | null;
  barrier: null | {
    operationId: string;
    supervisor: ProcessSeal;
    bootId: string;
    descriptor: FileSeal | null;
    healthListenerPort: number;
    state: "close-intended" | "closed" | "release-intended" | "released" | "supervisor-exited";
    terminalEvidence: FileSeal | null;
  };
  outcome: "record-committed" | "assessment-complete" | "migration-pending" | "aborted" | null;
}

export function initialRegistryWork(command: RegistryWork["command"]): RegistryWork {
  return {
    command,
    phase: "reading",
    selectedSnapshot: null,
    selectedHold: null,
    bootstrap: null,
    capture: null,
    result: null,
    barrier: null,
    outcome: null,
  };
}

// ── gap codes ─────────────────────────────────────────────────────────────

export const NATIVE_HOLD_ADAPTER_UNAVAILABLE = "NATIVE_HOLD_ADAPTER_UNAVAILABLE";

/** Fixed per-category reasons for the uninstrumented pilot; never operator text. */
export const INVENTORY_GAP_REASONS: Readonly<Record<InventoryClass, string>> = {
  "agent-sessions": "EXTERNAL_PRODUCERS_UNFENCED",
  "scheduled-and-queued": "EXTERNAL_PRODUCERS_UNFENCED",
  "local-scripts-and-services": "EXTERNAL_PRODUCERS_UNFENCED",
  "sip-dispatch-rules": "EXTERNAL_PRODUCERS_UNFENCED",
  "room-and-token-dispatch": "EXTERNAL_PRODUCERS_UNFENCED",
  "external-credential-holders": "EXTERNAL_PRODUCERS_UNFENCED",
  "other-workers": "EXTERNAL_PRODUCERS_UNFENCED",
  "outstanding-assignments": "PENDING_ASSIGNMENTS_UNOBSERVABLE",
};

// ── capture tickets (chunk 5 Step 2) ──────────────────────────────────────

interface TicketEntry {
  operation: AcquiredOperation;
  lease: CaptureTicketLease;
  bootstrap: RecordRef;
  frozen: ProcessOwner;
}

const tickets = new WeakMap<object, TicketEntry>();

export interface CaptureTicketDeps {
  isProcessLive(owner: ProcessOwner): Promise<boolean>;
}

async function assertActiveCaptureOperation(entry: TicketEntry, deps: CaptureTicketDeps): Promise<void> {
  const { operation } = entry;
  const owner = JSON.parse(await readFile(resolve(operation.paths.lockDirectory, "owner.json"), "utf8")) as {
    id?: unknown;
    canonicalHome?: unknown;
  };
  const current = decodeOperationRecord(JSON.parse(await readFile(operation.paths.currentRecord, "utf8")));
  if (
    owner.id !== operation.record.id ||
    owner.canonicalHome !== operation.record.canonicalHome ||
    current.schemaVersion !== 2 ||
    current.id !== operation.record.id ||
    current.workKind !== "registry" ||
    current.mode !== "capture-pilot" ||
    current.frozenOwner?.pid !== entry.frozen.pid ||
    current.frozenOwner?.startTime !== entry.frozen.startTime ||
    current.phase === "unresolved" ||
    current.resolution !== undefined ||
    !(await deps.isProcessLive(entry.frozen))
  ) {
    throw new Error("PILOT_CAPTURE_BLOCKED: capture ticket is not bound to the live acquired capture operation");
  }
}

/**
 * Create the opaque, in-memory capture ticket for the acquired frozen capture
 * operation. No parser can construct one; it never serializes.
 */
export async function createCaptureTicket(
  operation: AcquiredOperation,
  input: { configPath: string; bootstrap: RecordRef },
  deps: CaptureTicketDeps,
): Promise<object> {
  if (!operation.record.frozenOwner) throw new Error("PILOT_CAPTURE_BLOCKED: capture runs only in the frozen helper");
  const entry: TicketEntry = {
    operation,
    lease: {
      operationId: operation.record.id,
      instanceId: operation.record.instanceId,
      hiveHome: operation.record.canonicalHome,
      configPath: input.configPath,
    },
    bootstrap: { ...input.bootstrap },
    frozen: { ...operation.record.frozenOwner },
  };
  await assertActiveCaptureOperation(entry, deps);
  const ticket = Object.freeze({});
  tickets.set(ticket, entry);
  return ticket;
}

/** Revoke a ticket when its capture operation finishes; later discovery with it fails closed. */
export function revokeCaptureTicket(ticket: object): void {
  tickets.delete(ticket);
}

/** Validator injected into `ServiceControllerOptions.captureTicketValidator`. */
export function captureTicketValidator(deps: CaptureTicketDeps): (ticket: object) => Promise<CaptureTicketLease> {
  return async (ticket) => {
    const entry = tickets.get(ticket);
    if (!entry) throw new Error("PILOT_CAPTURE_BLOCKED: unknown capture ticket");
    await assertActiveCaptureOperation(entry, deps);
    return { ...entry.lease };
  };
}

// ── registered selection and reconstruction ────────────────────────────────

export interface LoadedRegisteredPilot {
  pilot: RegisteredPilot;
  snapshot: PilotSnapshot;
  bootstrap: RegisteredRecord<BootstrapRecord>;
  /** The registration's exact payload seal (the probe subject seal). */
  payloadSeal: FileSeal;
}

export function toRecordInstance(instance: PilotInstanceKey): InstanceKey {
  return { ...instance };
}

async function savedBytes(seal: FileSeal, filesDirectory: string, uid: number): Promise<Buffer> {
  if (!within(filesDirectory, seal.realpath) || dirname(seal.path) !== filesDirectory) {
    throw new PilotEvidenceUnavailableError("PILOT_SNAPSHOT_BACKUP_OUTSIDE_REGISTRY");
  }
  return verifySeal(seal, { uid });
}

/** Rebuild the captured service pair only from sealed registry backups; never from JSON bytes. */
export async function reconstructServices(
  snapshot: PilotSnapshot,
  filesDirectory: string,
  uid: number,
): Promise<ServiceSnapshot> {
  const services: CapturedServiceDefinition[] = [];
  for (const save of snapshot.services) {
    const effective = await savedBytes(save.effectivePlist.saved, filesDirectory, uid);
    if (save.effectivePlist.saved.sha256 !== save.effectivePlist.source.sha256) {
      throw new PilotEvidenceUnavailableError("PILOT_SNAPSHOT_BACKUP_MISMATCH");
    }
    const instanceBytes =
      save.instancePlist.existed && save.instancePlist.saved
        ? await savedBytes(save.instancePlist.saved, filesDirectory, uid)
        : undefined;
    services.push({
      definition: save.definition,
      inspection: save.inspection,
      plist: {
        path: save.effectivePlist.source.path,
        existed: true,
        bytes: effective,
        mode: save.effectivePlist.source.mode,
      },
      instancePlist: {
        path: save.instancePlist.path,
        existed: save.instancePlist.existed,
        ...(instanceBytes ? { bytes: instanceBytes, mode: save.instancePlist.mode ?? 0o600 } : {}),
      },
      link: {
        path: save.link.path,
        existed: save.link.existed,
        ...(save.link.target !== null ? { target: save.link.target } : {}),
      },
      loaded: save.loaded,
      enabled: save.enabled,
    });
  }
  return { services };
}

export async function loadRegisteredPilot(
  selector: string,
  instance: PilotInstanceKey,
  options: { expected?: RecordRef; generation?: RegisteredPilot["generation"]; now?: () => number } = {},
): Promise<LoadedRegisteredPilot> {
  const recordInstance = toRecordInstance(instance);
  let read: RegisteredRecord<PilotSnapshot>;
  let bootstrap: RegisteredRecord<BootstrapRecord>;
  try {
    read = await readRegisteredRecord<PilotSnapshot>(selector, {
      instance: recordInstance,
      kind: "pilot-snapshot",
      expected: options.expected,
      now: options.now,
    });
    bootstrap = await readReference<BootstrapRecord>(read.payload.bootstrap, {
      instance: recordInstance,
      kind: "bootstrap",
      now: options.now,
    });
  } catch (error) {
    log.warn("Registered pilot snapshot selection failed", { reason: error instanceof Error ? error.name : "error" });
    throw new PilotEvidenceUnavailableError("PILOT_SNAPSHOT_UNREGISTERED");
  }
  const snapshot = read.payload;
  const services = await reconstructServices(snapshot, read.filesDirectory, instance.uid);
  const pilot: RegisteredPilot = {
    selector: read.selector,
    sha256: read.reference.sha256,
    bootstrap: { selector: bootstrap.selector, sha256: bootstrap.reference.sha256 },
    instance,
    services,
    capturedPilotProfile: snapshot.services.map((save) => ({
      label: save.definition.label,
      plistPath: save.effectivePlist.source.path,
    })),
    sdkListenerPort: snapshot.runtime.sdkListener.port,
    generation: options.generation ?? {
      engine: { pid: snapshot.runtime.engine.pid, startTime: snapshot.runtime.engine.startTime },
      worker: { pid: snapshot.runtime.worker.pid, startTime: snapshot.runtime.worker.startTime },
    },
  };
  return { pilot, snapshot, bootstrap, payloadSeal: read.registration.payload };
}

/**
 * Rehash every captured recovery input before stopping anything: Node, entry
 * points, the loader, the complete tree closure, external effective plists and
 * config files (or their explicit absence), plus the bootstrap tooling tree.
 */
export async function verifyPilotRecoveryPrerequisites(loaded: LoadedRegisteredPilot): Promise<void> {
  const { snapshot, bootstrap } = loaded;
  const uid = snapshot.instance.uid;
  const closureRoots = snapshot.runtime.roots.map((root) => root.realpath);
  try {
    await verifySeal(snapshot.runtime.node, { uid, allowRoot: true });
    await verifySeal(snapshot.runtime.engineEntry, { uid });
    await verifySeal(snapshot.runtime.workerEntry, { uid });
    await verifySeal(snapshot.runtime.workerLoader.file, { uid });
    for (const root of snapshot.runtime.roots) await verifyTreeSeal(root, { uid, closureRoots });
    for (const save of snapshot.services) await verifySeal(save.effectivePlist.source, { uid, allowRoot: true });
    for (const file of snapshot.configFiles) {
      if (file.seal) await verifySeal(file.seal, { uid });
      else if (
        await lstat(file.path).then(
          () => true,
          () => false,
        )
      ) {
        throw new Error("captured absent config file now exists");
      }
    }
    const root = bootstrap.payload.packageRoot;
    await verifyTreeSeal(root, { uid, closureRoots: [root.realpath] });
  } catch (error) {
    throw new DeferredMaintenance(
      `PILOT_RECOVERY_PREREQUISITES_CHANGED: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

// ── lineage ───────────────────────────────────────────────────────────────

interface OperationSummary {
  record: OperationRecord;
  directory: string;
}

async function operationSummaries(canonicalHome: string): Promise<OperationSummary[]> {
  const root = resolve(canonicalHome, ".hive-state", "deployment", "operations");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: OperationSummary[] = [];
  for (const name of names) {
    const directory = resolve(root, name);
    try {
      const decoded = decodeOperationRecord(JSON.parse(await readFile(resolve(directory, "operation.json"), "utf8")));
      if (decoded.schemaVersion === 2 && decoded.id === name && decoded.canonicalHome === canonicalHome) {
        out.push({ record: decoded, directory });
      }
    } catch {
      // Unreadable or legacy records carry no verified lineage.
    }
  }
  return out.sort((left, right) => left.record.startedAt.localeCompare(right.record.startedAt));
}

async function priorPilotReference(summary: OperationSummary) {
  try {
    const prior = decodePriorSnapshot(
      JSON.parse(await readFile(resolve(summary.directory, "prior-snapshot.json"), "utf8")),
    );
    return prior.operationId === summary.record.id ? prior.pilot : null;
  } catch {
    return null;
  }
}

async function retainedArchiveIntact(summary: OperationSummary, sha: string, uid: number): Promise<boolean> {
  const archiveDirectory = resolve(summary.directory, "archive");
  for (const path of summary.record.retainedPaths) {
    if (dirname(path) !== archiveDirectory || !path.endsWith(".tgz")) continue;
    try {
      const seal = await sealFile(path, { uid });
      if (seal.sha256 === sha) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Healthy first migrations and reapplies (artifact updates) that reference this snapshot/bootstrap, oldest first. */
async function migrationsReferencing(pilot: RegisteredPilot, canonicalHome: string): Promise<OperationSummary[]> {
  const out: OperationSummary[] = [];
  for (const summary of await operationSummaries(canonicalHome)) {
    const { record } = summary;
    if (record.workKind !== "lifecycle" || record.mode !== "update" || record.resolution !== "healthy") continue;
    const reference = await priorPilotReference(summary);
    if (
      reference &&
      reference.snapshotPath === pilot.selector &&
      reference.snapshotSha256 === pilot.sha256 &&
      reference.bootstrapPath === pilot.bootstrap.selector &&
      reference.bootstrapSha256 === pilot.bootstrap.sha256
    ) {
      out.push(summary);
    }
  }
  return out;
}

/**
 * Lineage of the LATEST resolved migration referencing this snapshot/bootstrap.
 * If that latest record lacks its candidate identity, verified clone or intact
 * retained archive, there is no verified lineage (an older record never
 * substitutes for it).
 */
export async function resolvePilotMigrationLineage(
  pilot: RegisteredPilot,
  canonicalHome: string,
): Promise<PilotLineage | null> {
  const summary = (await migrationsReferencing(pilot, canonicalHome)).at(-1);
  if (!summary) return null;
  const { record } = summary;
  const promotion = record.staging.promotion;
  if (
    !record.candidateArchiveSha256 ||
    !record.staging.candidateRelease ||
    !promotion?.destinationIdentity ||
    !record.staging.cloneVerified
  ) {
    return null;
  }
  if (!(await retainedArchiveIntact(summary, record.candidateArchiveSha256, pilot.instance.uid))) return null;
  return {
    migrationOperationId: record.id,
    candidateArchiveSha256: record.candidateArchiveSha256,
    candidateRelease: record.staging.candidateRelease,
    candidateCurrent: { device: promotion.destinationIdentity.dev, inode: promotion.destinationIdentity.ino },
  };
}

/**
 * Reapply lineage (chunk 4 Task 8 Step 5a.4): with no resolved migration for
 * this snapshot the update is a first migration. Otherwise the staged archive
 * must be exactly the retained archive SHA recorded by the latest migration,
 * and that lineage must still verify.
 */
export async function assertPilotArtifactLineage(pilot: RegisteredPilot, archiveSha256: string): Promise<void> {
  const canonicalHome = pilot.instance.canonicalHome;
  if ((await migrationsReferencing(pilot, canonicalHome)).length === 0) return;
  const lineage = await resolvePilotMigrationLineage(pilot, canonicalHome);
  if (!lineage) throw new DeferredMaintenance("REAPPLY_LINEAGE_UNVERIFIED");
  if (lineage.candidateArchiveSha256 !== archiveSha256) {
    throw new DeferredMaintenance("REAPPLY_ARTIFACT_LINEAGE_MISMATCH");
  }
}

export { PILOT_ACTIVATION_FILE, PILOT_GENERATION_FILE };

function decodeOwner(value: unknown): ProcessOwner {
  const o = object(value, ["pid", "startTime"]);
  return { pid: int(o.pid, 1), startTime: str(o.startTime, 128) };
}

function decodeGeneration(value: unknown): RegisteredPilot["generation"] {
  const o = object(value, ["engine", "worker"]);
  return { engine: decodeOwner(o.engine), worker: decodeOwner(o.worker) };
}

/** Generation recorded by the latest healthy pilot rollback for this snapshot, else the snapshot's own. */
export async function resolvePilotGeneration(
  snapshot: PilotSnapshot,
  selector: string,
  sha256: string,
): Promise<RegisteredPilot["generation"]> {
  let generation: RegisteredPilot["generation"] = {
    engine: { pid: snapshot.runtime.engine.pid, startTime: snapshot.runtime.engine.startTime },
    worker: { pid: snapshot.runtime.worker.pid, startTime: snapshot.runtime.worker.startTime },
  };
  for (const summary of await operationSummaries(snapshot.instance.canonicalHome)) {
    const { record } = summary;
    if (record.workKind !== "lifecycle" || record.mode !== "pilot-rollback" || record.resolution !== "healthy")
      continue;
    const reference = await priorPilotReference(summary);
    if (!reference || reference.snapshotPath !== selector || reference.snapshotSha256 !== sha256) continue;
    try {
      generation = decodeGeneration(
        JSON.parse(await readFile(resolve(summary.directory, PILOT_GENERATION_FILE), "utf8")),
      );
    } catch {
      // A pilot rollback without a durable verified generation contributes nothing.
    }
  }
  return generation;
}

// ── current observations ──────────────────────────────────────────────────

export type PilotServiceReader = Pick<ServiceController, "inspect" | "listenerOwners" | "processCensus">;

export interface PilotEvidenceDeps {
  instance: PilotInstanceKey;
  /**
   * Read-only service reader permitted to inspect exactly the snapshot's
   * captured external targets. The evidence module never stops, starts or
   * restores services; only the lifecycle controller does, after route checks.
   */
  controllerFor(capturedPilotProfile: RegisteredPilot["capturedPilotProfile"]): PilotServiceReader;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Captured-loader bridge probe (chunk 4 Step 4b.2). Absent means the bridge
   * profile is explicitly unavailable, which fails the pilot profile closed.
   */
  bridgeProbe?: (loaded: LoadedRegisteredPilot) => Promise<PilotRecoveryObservations["bridge"]>;
  /** OS open-file corroboration of an exclusive legacy log writer; absent means not corroborated. */
  exclusiveWriter?: (path: string, pid: number) => Promise<boolean>;
  /**
   * Registered bootstrap probe and native hold boundaries for the acquired
   * operation. Absent means no probe runs: the bridge profile stays
   * unavailable and no native capability can be corroborated.
   */
  probes?: PilotProbeDeps;
}

export interface PilotProbeDeps {
  /** The acquired operation that owns every probe request. */
  operationId: string;
  clock: StopProofClock;
  randomId?: () => string;
  io?: PilotProbeLaunchIO;
  readDescriptor?: NativeHoldDeps["readDescriptor"];
  readRelease?: NativeHoldDeps["readRelease"];
  request?: NativeHoldDeps["request"];
  wait?: NativeHoldDeps["wait"];
}

function probeSubjectOf(loaded: LoadedRegisteredPilot): PilotProbeSubject {
  return registeredProbeSubject(loaded.snapshot, loaded.payloadSeal, loaded.bootstrap.payload);
}

function nativeDepsOf(loaded: LoadedRegisteredPilot, deps: PilotEvidenceDeps, probes: PilotProbeDeps): NativeHoldDeps {
  return {
    instance: toRecordInstance(deps.instance),
    controller: deps.controllerFor(loaded.pilot.capturedPilotProfile),
    clock: probes.clock,
    randomId: probes.randomId ?? randomUUID,
    probeIO: probes.io,
    readDescriptor: probes.readDescriptor,
    readRelease: probes.readRelease,
    request: probes.request,
    wait: probes.wait,
  };
}

/**
 * Captured-loader bridge profile through the registered bootstrap probe, with
 * the live generation as the expected processes. Any probe fault is an
 * unauthenticated profile, never a partial pass.
 */
export async function registeredBridgeProfile(
  loaded: LoadedRegisteredPilot,
  live: { engine: ServiceInspection; worker: ServiceInspection },
  probes: PilotProbeDeps,
): Promise<PilotRecoveryObservations["bridge"]> {
  try {
    const prepared = await preparePilotProbe(probeSubjectOf(loaded), probes.io);
    await invokePilotProbe(prepared, {
      operationId: probes.operationId,
      expectedEngine: processSealOf(live.engine),
      expectedWorker: processSealOf(live.worker),
      idle: null,
      clock: probes.clock,
      randomId: probes.randomId ?? randomUUID,
      io: probes.io,
    });
    return { authenticated: true, missingDenied: true, wrongDenied: true };
  } catch (error) {
    log.warn("Captured-loader pilot profile probe failed", {
      classification: error instanceof PilotProbeFault ? error.classification : "PILOT_PROFILE_PROBE_FAILED",
    });
    return { authenticated: false, missingDenied: false, wrongDenied: false };
  }
}

export interface SdkReadback {
  rootStatus: number | null;
  agentName: string | null;
  activeJobs: number | null;
}

export async function readSdkListener(port: number, fetchImpl: typeof fetch = fetch): Promise<SdkReadback> {
  try {
    const [root, worker] = await Promise.all([
      fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }),
      fetchImpl(`http://127.0.0.1:${port}/worker`, { signal: AbortSignal.timeout(2_000) }),
    ]);
    let agentName: string | null = null;
    let activeJobs: number | null = null;
    if (worker.status === 200) {
      const body = (await worker.json().catch(() => null)) as { agent_name?: unknown; active_jobs?: unknown } | null;
      agentName = typeof body?.agent_name === "string" ? body.agent_name : null;
      activeJobs =
        Number.isSafeInteger(body?.active_jobs) && (body!.active_jobs as number) >= 0
          ? (body!.active_jobs as number)
          : null;
    }
    return { rootStatus: root.status, agentName, activeJobs };
  } catch {
    return { rootStatus: null, agentName: null, activeJobs: null };
  }
}

async function sealsStillMatch(check: () => Promise<void>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch {
    return false;
  }
}

export async function observeRegisteredPilotRecovery(
  loaded: LoadedRegisteredPilot,
  fences: ActivationFences,
  deps: PilotEvidenceDeps,
): Promise<PilotRecoveryObservations> {
  const { snapshot } = loaded;
  const uid = snapshot.instance.uid;
  const closureRoots = snapshot.runtime.roots.map((root) => root.realpath);
  const executableHashesMatch = await sealsStillMatch(async () => {
    await verifySeal(snapshot.runtime.node, { uid, allowRoot: true });
    await verifySeal(snapshot.runtime.engineEntry, { uid });
    await verifySeal(snapshot.runtime.workerEntry, { uid });
    await verifySeal(snapshot.runtime.workerLoader.file, { uid });
  });
  const dependencyPathsAndVersionsMatch = await sealsStillMatch(async () => {
    for (const root of snapshot.runtime.roots) await verifyTreeSeal(root, { uid, closureRoots });
  });
  const controller = deps.controllerFor(loaded.pilot.capturedPilotProfile);
  const [engine, worker] = await Promise.all(
    snapshot.services.map((save) => controller.inspect(save.definition.label)),
  );
  const port = snapshot.runtime.sdkListener.port;
  const sdk = await readSdkListener(port, deps.fetchImpl);
  const owners = await controller.listenerOwners(port);
  const bridge = deps.bridgeProbe
    ? await deps.bridgeProbe(loaded)
    : deps.probes
      ? await registeredBridgeProfile(loaded, { engine, worker }, deps.probes)
      : { authenticated: false, missingDenied: false, wrongDenied: false };
  const engineLog = readFencedMarkers(fences.engineLog);
  const workerLog = readFencedMarkers(fences.workerLog);
  const exclusive = async (path: string, inspection: ServiceInspection) =>
    deps.exclusiveWriter && inspection.process ? deps.exclusiveWriter(path, inspection.process.pid) : false;
  // Final identity re-read after the slower checks.
  const [engineAfter, workerAfter] = await Promise.all(
    snapshot.services.map((save) => controller.inspect(save.definition.label)),
  );
  const stable = (a: ServiceInspection, b: ServiceInspection) =>
    a.process?.pid === b.process?.pid && a.process?.startTime === b.process?.startTime;
  return {
    captured: { engine: snapshot.services[0].inspection, worker: snapshot.services[1].inspection },
    live: { engine, worker },
    stopped: fences.stopped,
    activationStartedAt: fences.wallStartedAt,
    now: (deps.now ?? Date.now)(),
    executableHashesMatch: executableHashesMatch && stable(engine, engineAfter) && stable(worker, workerAfter),
    dependencyPathsAndVersionsMatch,
    engineLog,
    workerLog,
    engineExclusiveWriter: await exclusive(fences.engineLog.path, engine),
    workerExclusiveWriter: await exclusive(fences.workerLog.path, worker),
    bridge,
    sdk: { rootStatus: sdk.rootStatus, agentName: sdk.agentName },
    sdkSocketOwner: owners.length === 1 ? owners[0] : null,
  };
}

// ── hold assessment ───────────────────────────────────────────────────────

export interface HoldAssessment {
  capability: HoldCapability;
  pilotWorker: ProcessSeal;
  pilotEngine: ProcessSeal;
  sources: SourceObservation[];
  checks: CheckSpec[];
  gaps: { category: InventoryClass; reason: string }[];
  /** Private allowlisted readback retained by the operation, never trusted as a hold. */
  readback: Record<string, unknown>;
}

function sameGeneration(seal: ProcessSeal, owner: ProcessOwner): boolean {
  return seal.pid === owner.pid && seal.startTime === owner.startTime;
}

/**
 * Record-only capability view: never native-capable. A record claiming native
 * admission still needs fresh runtime corroboration (`currentHoldCapability`).
 */
export function holdCapabilityFor(snapshot: PilotSnapshot): HoldCapability {
  return snapshot.admission.kind === "unavailable"
    ? { kind: "unavailable", gaps: [...LEGACY_HOLD_GAP_CODES], holdRecordPath: null }
    : { kind: "unavailable", gaps: [NATIVE_HOLD_ADAPTER_UNAVAILABLE, ...LEGACY_HOLD_GAP_CODES], holdRecordPath: null };
}

/**
 * Current hold capability (chunk 4 Step 4b.1): the uninstrumented layout keeps
 * its fixed gaps; a snapshot recording native admission is native-capable only
 * when the probe boundaries are wired AND the historical runtime corroborates
 * right now. Gap codes are fixed, never operator text.
 */
export async function currentHoldCapability(
  loaded: LoadedRegisteredPilot,
  deps: PilotEvidenceDeps,
): Promise<HoldCapability> {
  const recorded = holdCapabilityFor(loaded.snapshot);
  if (loaded.snapshot.admission.kind === "unavailable" || !deps.probes) return recorded;
  try {
    await corroborateNativeCapability(
      { snapshot: loaded.snapshot, generation: loaded.pilot.generation },
      nativeDepsOf(loaded, deps, deps.probes),
    );
    return { kind: "native-capable" };
  } catch (error) {
    if (error instanceof PilotEvidenceUnavailableError) {
      return { kind: "unavailable", gaps: [error.code, ...LEGACY_HOLD_GAP_CODES], holdRecordPath: null };
    }
    throw error;
  }
}

/**
 * Establish a native hold for a capable registered pilot under THIS operation.
 * Failures before close are verified deferrals (no close was sent); faults
 * after close are released by the same owner inside the shared quiescence
 * contract; an unacknowledged release stays unresolved.
 */
export async function establishRegisteredHold(
  loaded: LoadedRegisteredPilot,
  operation: AcquiredOperation,
  recordIntent: (supervisor: { seal: ProcessSeal; bootId: string }) => Promise<void>,
  deps: PilotEvidenceDeps,
): Promise<EstablishedNativeHold> {
  if (loaded.snapshot.admission.kind === "unavailable") {
    throw new PilotEvidenceUnavailableError("LEGACY_ADMISSION_UNOBSERVABLE");
  }
  if (!deps.probes) throw new PilotEvidenceUnavailableError(NATIVE_HOLD_ADAPTER_UNAVAILABLE);
  if (deps.probes.operationId !== operation.record.id) {
    throw new PilotEvidenceUnavailableError("NATIVE_HOLD_OPERATION_MISMATCH");
  }
  try {
    return await establishNativeHold({
      subject: { snapshot: loaded.snapshot, generation: loaded.pilot.generation },
      probe: probeSubjectOf(loaded),
      operation,
      recordIntent,
      deps: nativeDepsOf(loaded, deps, deps.probes),
    });
  } catch (error) {
    if (error instanceof DeferredMaintenance || error instanceof UnresolvedMaintenance) throw error;
    const code =
      error instanceof PilotEvidenceUnavailableError
        ? error.code
        : error instanceof PilotProbeFault
          ? error.classification
          : "NATIVE_HOLD_NOT_ESTABLISHED";
    throw new DeferredMaintenance(`NATIVE_HOLD_DEFERRED: ${code}`, { cause: error });
  }
}

/**
 * Current inventory from actual readers (chunk 4 Task 9 Steps 4b.3/4c.1).
 * Every class is represented; for the old runtime these observations never
 * complete accounting, so explicit gaps remain. Zero descendants, zero SDK
 * jobs or an owned listener are observations, not negative proof. No reader
 * stops, kills, disables or mutates anything.
 */
function probeClassification(error: unknown): string {
  return error instanceof PilotProbeFault ? error.classification : "PILOT_INVENTORY_INCOMPLETE";
}

/**
 * Map sanitized LiveKit inventory to observations-only sources (chunk 5 Step
 * 3): room/participant/dispatch items to room-and-token dispatch, SIP rules and
 * trunks to SIP dispatch rules, scope unknown, one fresh source UUID per item;
 * empty results still yield an observations-only category row.
 */
export function livekitSources(
  result: PilotInventoryResult,
  checkId: string,
  randomId: () => string,
): SourceObservation[] {
  const categoryOf = (kind: PilotInventoryResult["items"][number]["kind"]): InventoryClass =>
    kind === "sip-rule" || kind === "inbound-trunk" ? "sip-dispatch-rules" : "room-and-token-dispatch";
  const out: SourceObservation[] = result.items.map((item) => ({
    id: randomId(),
    category: categoryOf(item.kind),
    locator: `${item.kind}:${item.id}${item.agentName === null ? "" : `:${item.agentName}`}`,
    checks: [checkId],
    scope: "unknown",
    accounting: "observations-only",
  }));
  for (const category of ["room-and-token-dispatch", "sip-dispatch-rules"] as const) {
    if (!out.some((source) => source.category === category)) {
      out.push({
        id: randomId(),
        category,
        locator: `livekit:${category}:observed-empty`,
        checks: [checkId],
        scope: "unknown",
        accounting: "observations-only",
      });
    }
  }
  return out;
}

export async function assessHold(
  loaded: LoadedRegisteredPilot,
  deps: PilotEvidenceDeps,
  randomId: () => string = randomUUID,
  options: { livekit?: boolean } = {},
): Promise<HoldAssessment> {
  const { snapshot, pilot } = loaded;
  const now = deps.now ?? Date.now;
  const controller = deps.controllerFor(pilot.capturedPilotProfile);
  const inspectPair = () =>
    Promise.all(snapshot.services.map((save) => controller.inspect(save.definition.label))) as Promise<
      [ServiceInspection, ServiceInspection]
    >;
  const observedAt = now();
  const [engine, worker] = await inspectPair();
  const workerSeal = processSealOf(worker);
  const engineSeal = processSealOf(engine);
  if (!sameGeneration(engineSeal, pilot.generation.engine) || !sameGeneration(workerSeal, pilot.generation.worker)) {
    throw new PilotEvidenceUnavailableError("PILOT_GENERATION_UNVERIFIED");
  }
  const engineCheck: CheckSpec = { id: randomId(), kind: "service", label: snapshot.services[0].definition.label };
  const workerCheck: CheckSpec = { id: randomId(), kind: "service", label: snapshot.services[1].definition.label };
  const censusCheck: CheckSpec = { id: randomId(), kind: "process-census" };
  const sdkCheck: CheckSpec = { id: randomId(), kind: "sdk-local" };
  const port = snapshot.runtime.sdkListener.port;
  const census = await controller.processCensus(engineSeal.pid);
  const sdk = await readSdkListener(port, deps.fetchImpl);
  const owners = await controller.listenerOwners(port);
  const sdkOwned = owners.length === 1 && owners[0] === workerSeal.pid;
  // Identity re-read after the slower reads; a changed generation invalidates the attempt.
  const [engineAfter, workerAfter] = await inspectPair();
  if (
    !engineAfter.process ||
    !workerAfter.process ||
    !sameGeneration(processSealOf(engineAfter), engineSeal) ||
    !sameGeneration(processSealOf(workerAfter), workerSeal)
  ) {
    throw new PilotEvidenceUnavailableError("PILOT_GENERATION_UNSTABLE");
  }
  const sources: SourceObservation[] = [
    {
      id: randomId(),
      category: "agent-sessions",
      locator: `engine-descendants:${census.length}`,
      checks: [engineCheck.id, censusCheck.id],
      scope: "target-instance",
      accounting: "observations-only",
    },
    {
      id: randomId(),
      category: "other-workers",
      locator: `sdk-listener-owners:${owners.length}:${sdkOwned ? "pilot-worker" : "unattributed"}`,
      checks: [workerCheck.id, sdkCheck.id],
      scope: "unknown",
      accounting: "observations-only",
    },
    {
      id: randomId(),
      category: "outstanding-assignments",
      locator: `sdk-active-jobs:${sdk.activeJobs === null ? "unavailable" : sdk.activeJobs}`,
      checks: [workerCheck.id, sdkCheck.id],
      scope: "target-instance",
      accounting: "observations-only",
    },
  ];
  // Zero rooms/jobs never completes assignment accounting; every class keeps a gap.
  const gaps = inventoryClasses.map((category) => ({ category, reason: INVENTORY_GAP_REASONS[category] }));
  const checks: CheckSpec[] = [engineCheck, workerCheck, censusCheck, sdkCheck];
  let livekit: Record<string, unknown> = { status: "not-requested" };
  if (options.livekit && deps.probes) {
    const livekitCheck: CheckSpec = { id: randomId(), kind: "livekit-inventory" };
    checks.push(livekitCheck);
    try {
      const prepared = await preparePilotProbe(probeSubjectOf(loaded), deps.probes.io);
      const inventory = await invokePilotInventory(prepared, {
        operationId: deps.probes.operationId,
        expectedEngine: engineSeal,
        expectedWorker: workerSeal,
        idle: null,
        clock: deps.probes.clock,
        randomId,
        io: deps.probes.io,
      });
      sources.push(...livekitSources(inventory.result, livekitCheck.id, randomId));
      livekit = {
        status: "observed",
        evidenceDigest: inventory.result.evidenceDigest,
        counts: inventory.result.counts,
        items: inventory.result.items,
        limitations: inventory.result.limitations,
      };
    } catch (error) {
      // Denied/partial/failed inventory is never a completeness claim; the gaps stay.
      livekit = { status: "PILOT_INVENTORY_INCOMPLETE", classification: probeClassification(error) };
    }
  }
  return {
    capability: await currentHoldCapability(loaded, deps),
    pilotWorker: workerSeal,
    pilotEngine: engineSeal,
    sources,
    checks,
    gaps,
    readback: {
      livekit,
      observedAt,
      completedAt: now(),
      engine: { pid: engineSeal.pid, startTime: engineSeal.startTime },
      worker: { pid: workerSeal.pid, startTime: workerSeal.startTime },
      engineDescendants: census.length,
      sdk,
      sdkListenerOwners: owners.length,
      sdkListenerOwnedByWorker: sdkOwned,
    },
  };
}

// ── concrete provider ─────────────────────────────────────────────────────

/**
 * The registry-backed provider plugged into `LifecycleOptions.pilotEvidence`.
 * Hold capability never comes from a record field: the uninstrumented
 * `unavailable` pilot, and any recorded-capable snapshot that fails fresh
 * corroboration or lacks wired probes, returns the executed MIGRATION_PENDING
 * gaps before any stage/close/signal. Only a corroborated historical runtime
 * reaches `establishHold`, which closes under the calling operation.
 */
export function registryPilotEvidence(deps: PilotEvidenceDeps): PilotEvidenceProvider {
  const cache = new Map<string, LoadedRegisteredPilot>();
  const load = async (selector: string, instance: PilotInstanceKey, expected?: RecordRef) => {
    if (canonical(instance) !== canonical(deps.instance)) {
      throw new PilotEvidenceUnavailableError("PILOT_SNAPSHOT_INSTANCE_MISMATCH");
    }
    const first = await loadRegisteredPilot(selector, instance, { expected, now: deps.now });
    const generation = await resolvePilotGeneration(first.snapshot, first.pilot.selector, first.pilot.sha256);
    const loaded = { ...first, pilot: { ...first.pilot, generation } };
    cache.set(loaded.pilot.selector, loaded);
    return loaded;
  };
  const loadedFor = (pilot: RegisteredPilot) => {
    const loaded = cache.get(pilot.selector);
    if (!loaded || loaded.pilot.sha256 !== pilot.sha256) throw new PilotEvidenceUnavailableError("PILOT_NOT_SELECTED");
    return loaded;
  };
  return {
    async selectRegisteredSnapshot(selector, instance) {
      return (await load(selector, instance)).pilot;
    },
    async selectHoldSnapshot(selector, instance) {
      const hold = await readHoldSelector(selector, instance, deps.now);
      return (await load(holdSnapshotSelector(selector, hold.payload), instance, hold.payload.snapshot)).pilot;
    },
    async verifyRecoveryPrerequisites(pilot) {
      await verifyPilotRecoveryPrerequisites(loadedFor(pilot));
    },
    async assessHoldCapability(pilot) {
      const loaded = loadedFor(pilot);
      try {
        return (await assessHold(loaded, deps)).capability;
      } catch (error) {
        if (error instanceof PilotEvidenceUnavailableError) {
          return { kind: "unavailable", gaps: [error.code, ...LEGACY_HOLD_GAP_CODES], holdRecordPath: null };
        }
        throw error;
      }
    },
    async establishHold(pilot, operation, recordIntent) {
      return (await establishRegisteredHold(loadedFor(pilot), operation, recordIntent, deps)).session;
    },
    resolveMigrationLineage: (pilot, canonicalHome) => resolvePilotMigrationLineage(pilot, canonicalHome),
    assertArtifactLineage: (pilot, archiveSha256) => assertPilotArtifactLineage(pilot, archiveSha256),
    async observePilotRecovery(pilot, fences) {
      return observeRegisteredPilotRecovery(loadedFor(pilot), fences, deps);
    },
  };
}

async function readHoldSelector(
  selector: string,
  instance: PilotInstanceKey,
  now?: () => number,
): Promise<RegisteredRecord<HoldRecord>> {
  try {
    return await readRegisteredRecord<HoldRecord>(selector, {
      instance: toRecordInstance(instance),
      kind: "legacy-hold",
      now,
    });
  } catch (error) {
    log.warn("Registered legacy hold selection failed", { reason: error instanceof Error ? error.name : "error" });
    throw new PilotEvidenceUnavailableError("LEGACY_HOLD_UNREGISTERED");
  }
}

/** The hold's snapshot is resolved only inside the same registry root, by its recorded reference. */
function holdSnapshotSelector(holdSelector: string, hold: HoldRecord): string {
  return resolve(dirname(dirname(holdSelector)), hold.snapshot.id, "payload.json");
}

function decodeActivationFences(value: unknown): ActivationFences {
  const fence = (item: unknown) => {
    const o = object(item, ["path", "dev", "ino", "offset"]);
    return { path: str(o.path), dev: int(o.dev), ino: int(o.ino), offset: int(o.offset) };
  };
  const nullableOwner = (item: unknown) => (item === null ? null : decodeOwner(item));
  const o = object(value, ["engineLog", "workerLog", "wallStartedAt", "stopped"]);
  const stopped = object(o.stopped, ["engine", "worker"]);
  return {
    engineLog: fence(o.engineLog),
    workerLog: fence(o.workerLog),
    wallStartedAt: int(o.wallStartedAt),
    stopped: { engine: nullableOwner(stopped.engine), worker: nullableOwner(stopped.worker) },
  };
}

/**
 * `LifecycleReconcileDeps.verifyPilot`: verify a reconstructed pilot prior
 * against its registered snapshot, current seals and the activation fences
 * this operation durably recorded. Missing fences are unresolved, never offset
 * zero.
 */
export function pilotProfileVerifier(deps: PilotEvidenceDeps): (loaded: LoadedPrior) => Promise<void> {
  return async (prior) => {
    const reference = prior.prior.pilot;
    if (!reference) throw new OperationUnresolvedError("PILOT_REFERENCE_MISSING");
    let loaded: LoadedRegisteredPilot;
    try {
      loaded = await loadRegisteredPilot(reference.snapshotPath, deps.instance, {
        expected: { id: basename(dirname(reference.snapshotPath)), sha256: reference.snapshotSha256 },
        now: deps.now,
      });
    } catch (error) {
      throw new OperationUnresolvedError("PILOT_SNAPSHOT_UNVERIFIED", { cause: error });
    }
    if (
      loaded.pilot.bootstrap.selector !== reference.bootstrapPath ||
      loaded.pilot.bootstrap.sha256 !== reference.bootstrapSha256
    ) {
      throw new OperationUnresolvedError("PILOT_BOOTSTRAP_REFERENCE_MISMATCH");
    }
    const operationDirectory = resolve(
      prior.prior.canonicalHome,
      ".hive-state",
      "deployment",
      "operations",
      prior.prior.operationId,
    );
    let fences: ActivationFences;
    try {
      fences = decodeActivationFences(
        JSON.parse(await readFile(resolve(operationDirectory, PILOT_ACTIVATION_FILE), "utf8")),
      );
    } catch (error) {
      throw new OperationUnresolvedError("PILOT_ACTIVATION_FENCE_MISSING", { cause: error });
    }
    try {
      await verifyPilotRecoveryPrerequisites(loaded);
    } catch (error) {
      throw new OperationUnresolvedError("PILOT_RECOVERY_PREREQUISITES_CHANGED", { cause: error });
    }
    const observations = await observeRegisteredPilotRecovery(loaded, fences, deps);
    if (!pilotRecovered(assemblePilotRecoveryEvidence(observations))) {
      throw new OperationUnresolvedError("PILOT_PROFILE_UNVERIFIED");
    }
  };
}

// ── registry helper commands ──────────────────────────────────────────────

export interface RegistryCommandDeps extends PilotEvidenceDeps {
  /** Terminal settlement of a recorded barrier (shared with lifecycle reconciliation). */
  settleBarrier(barrier: RecordedBarrier): Promise<"released" | "supervisor-exited">;
  randomId?: () => string;
}

export interface RegistryCommandResult {
  exitCode: 0 | 1;
  result: Record<string, unknown>;
}

export function registry(operation: AcquiredOperation): RegistryWork {
  const state = operation.record.registry;
  if (operation.record.workKind !== "registry" || !state) throw new Error("registry command requires registry work");
  return state;
}

export const REGISTRY_RESULT_FILE = "registry-result.json";

/**
 * Human-readable rendering of one recorded registry-command outcome. The
 * frozen helper's stdout stays machine-readable JSON; this is the operator's
 * reading of the same bytes, so the hold family's four statuses are legible
 * without parsing them by hand.
 *
 * It reports what a command recorded, never a live held state — a registered
 * record is a selector only, and `--verify-legacy-hold` re-derives its verdict
 * from a fresh assessment every time.
 */
export function describeRegistryResult(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["unreadable registry result"];
  const record = value as Record<string, unknown>;
  const text = (key: string): string | null => (typeof record[key] === "string" ? (record[key] as string) : null);
  const status = text("status") ?? "UNKNOWN";
  const detail: string[] = [];
  const add = (label: string, key: string) => {
    const found = text(key);
    if (found) detail.push(`${label}=${found}`);
  };
  add("snapshot", "snapshot");
  add("hold", "holdRecord");
  add("loader", "loader");
  add("admission", "admission");
  add("establishment", "establishment");
  add("command", "command");
  add("reason", "reason");
  add("operation", "operationId");
  const gaps = Array.isArray(record.gaps) ? record.gaps.filter((gap) => typeof gap === "string") : [];
  const meaning: Record<string, string> = {
    PILOT_SNAPSHOT_REGISTERED: "a pilot snapshot was captured and registered",
    NATIVE_HOLD_AVAILABLE:
      "this assessment found the recorded hold natively establishable; a lifecycle update or reapply must still acquire its own close",
    LEGACY_HOLD_EXERCISED_AND_RELEASED: "a native legacy hold was exercised and then released",
    PILOT_CAPTURE_BLOCKED: "capture refused before observing anything",
    MIGRATION_PENDING: "the assessment found gaps; migration cannot proceed yet",
    REGISTRY_COMMAND_ABORTED: "the command was recorded as aborted",
  };
  const lines = [`  ${status}${detail.length > 0 ? ` (${detail.join(" ")})` : ""}`];
  if (meaning[status]) lines.push(`    · ${meaning[status]}`);
  for (const gap of gaps) lines.push(`    gap: ${gap}`);
  return lines;
}

async function writeResult(operation: AcquiredOperation, value: Record<string, unknown>): Promise<FileSeal> {
  const path = resolve(operation.paths.operationDirectory, REGISTRY_RESULT_FILE);
  await writeOperationJson(path, JSON.parse(canonicalBytes(value).toString("utf8")) as unknown);
  const { bytes: _bytes, ...seal } = await sealFile(path, { uid: uidOf(operation) });
  void _bytes;
  return seal;
}

function uidOf(operation: AcquiredOperation): number {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new OperationUnresolvedError(`registry work ${operation.record.id} requires a POSIX uid`);
  return uid;
}

export async function complete(
  operation: AcquiredOperation,
  outcome: NonNullable<RegistryWork["outcome"]>,
  result: Record<string, unknown>,
  exitCode: 0 | 1,
): Promise<RegistryCommandResult> {
  const state = registry(operation);
  state.result = await writeResult(operation, { outcome, ...result });
  state.outcome = outcome;
  state.phase = "finished";
  operation.record.resolution = "deferred";
  await persistOperation(operation);
  return { exitCode, result: { ...result, operationId: operation.record.id } };
}

/**
 * Record a failed registry command as aborted with a fixed reason. Nothing
 * here settles a barrier: a command whose barrier is recorded must reconcile.
 */
export async function abortRegistryCommand(
  operation: AcquiredOperation,
  reason: string,
): Promise<RegistryCommandResult> {
  const state = registry(operation);
  if (state.barrier && state.barrier.state !== "released" && state.barrier.state !== "supervisor-exited") {
    throw new OperationUnresolvedError("REGISTRY_BARRIER_UNSETTLED");
  }
  if (state.capture) state.capture.phase = "aborted";
  return complete(operation, "aborted", { status: "REGISTRY_COMMAND_ABORTED", command: state.command, reason }, 1);
}

async function loadForCommand(operation: AcquiredOperation, selector: string, deps: RegistryCommandDeps) {
  const loaded = await loadRegisteredPilot(selector, deps.instance, { now: deps.now });
  const generation = await resolvePilotGeneration(loaded.snapshot, loaded.pilot.selector, loaded.pilot.sha256);
  const state = registry(operation);
  state.selectedSnapshot = { id: loaded.snapshot.id, sha256: loaded.pilot.sha256 };
  state.bootstrap = loaded.snapshot.bootstrap;
  await persistOperation(operation);
  return { ...loaded, pilot: { ...loaded.pilot, generation } };
}

function pending(
  snapshotSelector: string,
  holdSelector: string | null,
  gaps: readonly string[],
): Record<string, unknown> {
  return { status: "MIGRATION_PENDING", snapshot: snapshotSelector, holdRecord: holdSelector, gaps: [...gaps] };
}

/** `--inventory-pilot`: read-only current inventory, private evidence only, never a hold boolean. */
export async function runInventoryPilot(
  operation: AcquiredOperation,
  selector: string,
  deps: RegistryCommandDeps,
): Promise<RegistryCommandResult> {
  const loaded = await loadForCommand(operation, selector, deps);
  await verifyPilotRecoveryPrerequisites(loaded);
  registry(operation).phase = "probing";
  await persistOperation(operation);
  const assessment = await assessHold(loaded, deps, deps.randomId, { livekit: true });
  await writeOperationJson(resolve(operation.paths.operationDirectory, "inventory-readback.json"), assessment.readback);
  return complete(
    operation,
    "assessment-complete",
    {
      status: "INVENTORY_RECORDED",
      snapshot: loaded.pilot.selector,
      observedClasses: [...new Set(assessment.sources.map((source) => source.category))],
      gaps: assessment.gaps,
    },
    0,
  );
}

/**
 * `--prepare-legacy-hold`: revalidate, inventory, then the explicit legacy
 * deferral. An unavailable capability registers a hold record with
 * `procedure.kind = "unavailable"` and returns MIGRATION_PENDING (exit 1): no
 * service signal, close or artifact stage.
 */
export async function runPrepareLegacyHold(
  operation: AcquiredOperation,
  selector: string,
  deps: RegistryCommandDeps,
): Promise<RegistryCommandResult> {
  const loaded = await loadForCommand(operation, selector, deps);
  await verifyPilotRecoveryPrerequisites(loaded);
  const state = registry(operation);
  state.phase = "probing";
  await persistOperation(operation);
  const assessment = await assessHold(loaded, deps, deps.randomId, { livekit: true });
  const capability = assessment.capability;
  if (capability.kind === "native-capable") return exerciseNativeHold(operation, loaded, assessment, deps);
  const gapCodes = [...capability.gaps];
  const reason = gapCodes[0] ?? "LEGACY_ADMISSION_UNOBSERVABLE";
  state.phase = "registering";
  await persistOperation(operation);
  const instance = toRecordInstance(deps.instance);
  const now = deps.now ?? Date.now;
  const registered = await registerRecord({
    operation,
    instance,
    kind: "legacy-hold",
    now,
    files: [{ name: "inventory-readback.json", bytes: canonicalBytes(assessment.readback) }],
    buildPayload: ({ id }) =>
      ({
        schemaVersion: 1,
        kind: "legacy-hold",
        id,
        instance,
        snapshot: { id: loaded.snapshot.id, sha256: loaded.pilot.sha256 },
        toolSha256: operation.record.toolSha256,
        createdAt: now(),
        pilotWorker: assessment.pilotWorker,
        sources: assessment.sources,
        checks: assessment.checks,
        gaps: assessment.gaps,
        procedure: { kind: "unavailable", reason },
      }) satisfies HoldRecord,
  });
  state.selectedHold = registered.reference;
  await persistOperation(operation);
  log.warn("Legacy dispatch hold unavailable; migration pending", { gaps: gapCodes.length });
  return complete(operation, "migration-pending", pending(loaded.pilot.selector, registered.selector, gapCodes), 1);
}

/** Every inventory class fenced through the one verified worker acceptance ingress. */
function admissionLedgerSources(checkId: string, randomId: () => string): SourceObservation[] {
  return inventoryClasses.map((category) => ({
    id: randomId(),
    category,
    locator: "admission-ledger:worker-acceptance-ingress",
    checks: [checkId],
    scope: "unknown",
    accounting: "admission-ledger",
  }));
}

/**
 * `--prepare-legacy-hold` for a freshly corroborated capable historical runtime
 * (chunk 4 Step 4c.2): a diagnostic prepare/verify/release exercise under THIS
 * operation. The close intent is durable before close; the closed readback is
 * registered; the same owner then terminal-releases (durable intent first) and
 * the command exits. The registered record is a selector only — never an
 * already-held claim; a lifecycle update acquires its own new close.
 */
async function exerciseNativeHold(
  operation: AcquiredOperation,
  loaded: LoadedRegisteredPilot,
  assessment: HoldAssessment,
  deps: RegistryCommandDeps,
): Promise<RegistryCommandResult> {
  const state = registry(operation);
  const randomId = deps.randomId ?? randomUUID;
  const port = loaded.snapshot.runtime.sdkListener.port;
  state.phase = "closing";
  await persistOperation(operation);
  const hold = await establishRegisteredHold(
    loaded,
    operation,
    async ({ seal, bootId }) => {
      state.barrier = {
        operationId: operation.record.id,
        supervisor: seal,
        bootId,
        descriptor: null,
        healthListenerPort: port,
        state: "close-intended",
        terminalEvidence: null,
      };
      await persistOperation(operation);
    },
    deps,
  );
  state.barrier!.state = "closed";
  await persistOperation(operation);
  let registered: Awaited<ReturnType<typeof registerRecord>>;
  try {
    const clock = deps.probes!.clock;
    const readback = await hold.session.collect({
      operationId: operation.record.id,
      requestId: randomId(),
      requestedAt: clock.now(),
    });
    if (
      readback.admission !== "closed" ||
      readback.closedOperationId !== operation.record.id ||
      readback.unresolvedAccepted !== 0 ||
      readback.sdkActiveJobs !== 0 ||
      readback.telemetryActiveCalls !== 0 ||
      readback.persistenceFault
    ) {
      throw new DeferredMaintenance("NATIVE_HOLD_READBACK_NOT_IDLE");
    }
    state.phase = "registering";
    await persistOperation(operation);
    const instance = toRecordInstance(deps.instance);
    const now = deps.now ?? Date.now;
    const admissionCheck: CheckSpec = { id: randomId(), kind: "admission-status" };
    registered = await registerRecord({
      operation,
      instance,
      kind: "legacy-hold",
      now,
      files: [
        { name: "inventory-readback.json", bytes: canonicalBytes(assessment.readback) },
        {
          name: "hold-readback.json",
          // Evidence only (never a proof): monotonic samples are local floats, recorded as whole milliseconds.
          bytes: canonicalBytes({
            ...readback,
            observedMono: Math.floor(readback.observedMono),
            completedMono: Math.ceil(readback.completedMono),
          }),
        },
      ],
      buildPayload: ({ id }) =>
        ({
          schemaVersion: 1,
          kind: "legacy-hold",
          id,
          instance,
          snapshot: { id: loaded.snapshot.id, sha256: loaded.pilot.sha256 },
          toolSha256: operation.record.toolSha256,
          createdAt: now(),
          pilotWorker: hold.capability.worker,
          sources: [...assessment.sources, ...admissionLedgerSources(admissionCheck.id, randomId)],
          checks: [...assessment.checks, admissionCheck],
          gaps: [],
          procedure: {
            kind: "hive-maintenance-v1",
            operationId: operation.record.id,
            bootId: hold.capability.descriptor.bootId,
            establish: "request-close",
            verify: "fresh-status-and-ledger",
            release: "terminal-release-or-confirmed-supervisor-exit",
          },
        }) satisfies HoldRecord,
    });
    state.selectedHold = registered.reference;
    await persistOperation(operation);
  } finally {
    // Release intent is durable before the request; a failed release keeps the barrier unresolved.
    state.phase = "releasing";
    state.barrier!.state = "release-intended";
    await persistOperation(operation);
    await hold.session.release();
    await writeOperationJson(resolve(operation.paths.operationDirectory, "barrier-release.json"), {
      outcome: "released",
      operationId: operation.record.id,
      supervisor: { pid: hold.capability.worker.pid, bootId: hold.capability.descriptor.bootId },
    });
    const { bytes: _bytes, ...evidence } = await sealFile(
      resolve(operation.paths.operationDirectory, "barrier-release.json"),
      { uid: uidOf(operation) },
    );
    void _bytes;
    state.barrier!.terminalEvidence = evidence;
    state.barrier!.state = "released";
    await persistOperation(operation);
  }
  log.info("Native legacy hold exercised and released", { operationId: operation.record.id });
  return complete(
    operation,
    "assessment-complete",
    { status: "LEGACY_HOLD_EXERCISED_AND_RELEASED", snapshot: loaded.pilot.selector, holdRecord: registered.selector },
    0,
  );
}

/** `--verify-legacy-hold`: rerun current checks for a registered record; never reports a held state from JSON. */
export async function runVerifyLegacyHold(
  operation: AcquiredOperation,
  selector: string,
  deps: RegistryCommandDeps,
): Promise<RegistryCommandResult> {
  const hold = await readHoldSelector(selector, deps.instance, deps.now);
  const state = registry(operation);
  state.selectedHold = hold.reference;
  await persistOperation(operation);
  const loaded = await loadForCommand(operation, holdSnapshotSelector(selector, hold.payload), deps);
  if (loaded.pilot.sha256 !== hold.payload.snapshot.sha256) {
    throw new PilotEvidenceUnavailableError("LEGACY_HOLD_SNAPSHOT_MISMATCH");
  }
  await verifyPilotRecoveryPrerequisites(loaded);
  state.phase = "probing";
  await persistOperation(operation);
  const assessment = await assessHold(loaded, deps, deps.randomId, { livekit: true });
  await writeOperationJson(resolve(operation.paths.operationDirectory, "verify-readback.json"), assessment.readback);
  // A registered record is a selector only: the verdict comes from this
  // invocation's capability assessment, never from the record's procedure.
  const capability = assessment.capability;
  if (capability.kind === "native-capable") {
    // Read-only: capability is freshly corroborated, but no close is issued here.
    // A lifecycle update or reapply must acquire its own new close.
    return complete(
      operation,
      "assessment-complete",
      {
        status: "NATIVE_HOLD_AVAILABLE",
        snapshot: loaded.pilot.selector,
        holdRecord: selector,
        establishment: "requires-new-operation-close",
      },
      0,
    );
  }
  return complete(operation, "migration-pending", pending(loaded.pilot.selector, selector, [...capability.gaps]), 1);
}

/**
 * `--release-legacy-hold`: a record whose procedure was unavailable never held
 * anything, so there is nothing to release. A native procedure's recorded
 * operation is settled by the shared terminal release (never another owner's
 * gate) or by verified supervisor exit plus listener release. Release intent is
 * durable before the request so an interrupted release reconciles.
 */
export async function runReleaseLegacyHold(
  operation: AcquiredOperation,
  selector: string,
  deps: RegistryCommandDeps,
): Promise<RegistryCommandResult> {
  const hold = await readHoldSelector(selector, deps.instance, deps.now);
  const state = registry(operation);
  state.selectedHold = hold.reference;
  state.phase = "releasing";
  await persistOperation(operation);
  const procedure = hold.payload.procedure;
  if (procedure.kind === "unavailable") {
    return complete(
      operation,
      "assessment-complete",
      { status: "HOLD_NEVER_ESTABLISHED", holdRecord: selector, reason: procedure.reason },
      0,
    );
  }
  const loaded = await loadForCommand(operation, holdSnapshotSelector(selector, hold.payload), deps);
  if (loaded.pilot.sha256 !== hold.payload.snapshot.sha256) {
    throw new PilotEvidenceUnavailableError("LEGACY_HOLD_SNAPSHOT_MISMATCH");
  }
  state.barrier = {
    operationId: procedure.operationId,
    supervisor: hold.payload.pilotWorker,
    bootId: procedure.bootId,
    descriptor: null,
    healthListenerPort: loaded.snapshot.runtime.sdkListener.port,
    state: "release-intended",
    terminalEvidence: null,
  };
  await persistOperation(operation);
  const outcome = await settleRegistryBarrier(operation, deps);
  return complete(
    operation,
    "assessment-complete",
    { status: outcome === "released" ? "HOLD_RELEASED_VERIFIED" : "SUPERVISOR_EXITED", holdRecord: selector },
    0,
  );
}

async function settleRegistryBarrier(
  operation: AcquiredOperation,
  deps: Pick<RegistryCommandDeps, "settleBarrier">,
): Promise<"released" | "supervisor-exited"> {
  const state = registry(operation);
  const barrier = state.barrier;
  if (!barrier) throw new OperationUnresolvedError("registry barrier missing");
  if (barrier.state === "released" || barrier.state === "supervisor-exited") return barrier.state;
  barrier.state = "release-intended";
  await persistOperation(operation);
  const outcome = await deps.settleBarrier({
    canonicalHome: operation.record.canonicalHome,
    instanceId: operation.record.instanceId,
    operationDirectory: operation.paths.operationDirectory,
    barrierOperationId: barrier.operationId,
    supervisor: { pid: barrier.supervisor.pid, bootId: barrier.bootId },
    supervisorProcess: { pid: barrier.supervisor.pid, startTime: barrier.supervisor.startTime },
    healthListenerPort: barrier.healthListenerPort,
  });
  const { bytes: _bytes, ...evidence } = await sealFile(
    resolve(operation.paths.operationDirectory, "barrier-release.json"),
    { uid: uidOf(operation) },
  );
  void _bytes;
  barrier.terminalEvidence = evidence;
  barrier.state = outcome;
  await persistOperation(operation);
  return outcome;
}

/**
 * Registry-work crash recovery (chunk 5 Task 8 Step 1a.3 Step 4 registry rows).
 * First settles any recorded barrier with the shared terminal release, then
 * reconciles registration fences without creating commits, keeps incomplete
 * diagnostics nonselectable, attaches committed references and adopts a
 * sealed result as historical assessment only. Never introduces a barrier,
 * inspects or restarts services, or reuses probe output as current health.
 */
export async function reconcileRegistryWork(
  operation: AcquiredOperation,
  deps: Pick<RegistryCommandDeps, "instance" | "settleBarrier">,
): Promise<Record<string, unknown>> {
  const state = registry(operation);
  if (operation.record.signalsBegun !== false) throw new OperationUnresolvedError("registry work cannot signal");
  if ((state.command === "inventory-pilot" || state.command === "verify-legacy-hold") && state.barrier !== null) {
    throw new OperationUnresolvedError("inventory/verify work carries a barrier");
  }
  let barrierOutcome: "released" | "supervisor-exited" | null = null;
  if (state.barrier) barrierOutcome = await settleRegistryBarrier(operation, deps);
  const instance = toRecordInstance(deps.instance);
  let committed: RecordRef | null = null;
  for (const fence of operation.record.registrations ?? []) {
    const outcome = await reconcileRegistration(fence, instance);
    if (outcome.outcome === "unresolved") throw new OperationUnresolvedError(`registration: ${outcome.reason}`);
    if (outcome.outcome === "committed") {
      fence.state = "committed";
      fence.reference = outcome.reference;
      committed = outcome.reference;
    } else {
      fence.state = "aborted";
    }
  }
  let outcome: NonNullable<RegistryWork["outcome"]>;
  if (state.outcome !== null) {
    if (!state.result) throw new OperationUnresolvedError("durable registry outcome without its sealed result");
    await verifySeal(state.result, { uid: instance.uid });
    outcome = state.outcome;
  } else if (state.command === "capture-pilot") {
    outcome = committed ? "record-committed" : "aborted";
    if (state.capture) {
      state.capture.phase = committed ? "committed" : "aborted";
      state.capture.registration = committed;
    }
  } else if (state.command === "prepare-legacy-hold" && committed) {
    // An unavailable deferral stays pending; a native exercise completes only
    // after its recorded barrier has been settled above.
    state.selectedHold = committed;
    outcome = barrierOutcome !== null ? "assessment-complete" : "migration-pending";
  } else if (state.command === "release-legacy-hold" && barrierOutcome !== null) {
    outcome = "assessment-complete";
  } else {
    outcome = "aborted";
  }
  state.outcome = outcome;
  state.phase = "finished";
  operation.record.resolution = "deferred";
  await persistOperation(operation);
  return { outcome, registration: committed, barrier: barrierOutcome };
}
