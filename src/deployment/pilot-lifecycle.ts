/**
 * Pilot migration, recovery and reapply adapters (KPR-463 plan chunk 4 Task 8
 * Step 5a.2–5a.4, with the chunk 5 absolute-expiry stop contract).
 *
 * This module owns the lifecycle side of the one-time pilot routes: route
 * assessment before any artifact mutation or signal, the pilot-profile
 * recovery evidence assembled from current observations, fenced legacy log
 * reads, and the pilot-rollback transaction adapter (candidate quiescence and
 * stop, pilot service-definition restoration without artifact rotation, and
 * candidate restoration on failure).
 *
 * It deliberately does NOT decode or register evidence records, inventory
 * dispatch sources, or run historical probes: those are the registry/hold
 * evidence module's job (plan chunk 4 Task 9 Steps 4a–4c), consumed here only
 * through `PilotEvidenceProvider`. Until that provider is supplied, every pilot
 * route returns the executed fail-closed `MIGRATION_PENDING` result before any
 * stage, close or signal. No file, flag or boolean establishes a hold: a native
 * hold stops the pilot only through `stopUnderFreshProof`, which proves the
 * closed gate from adapter readback and consumes the proof at launchd dispatch.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createLogger } from "../logging/logger.js";
import { DeferredMaintenance, type TransactionIO } from "./transaction.js";
import { pilotRecovered, type PilotRecoveryEvidence } from "./health.js";
import type { ReleaseIdentity } from "./clone-promotion.js";
import type { DirectoryIdentity, AcquiredOperation, ProcessOwner } from "./operation.js";
import type { ServiceController, ServiceInspection, ServiceSnapshot } from "./services.js";
import type { GateChallenge, NativeGateReadback, ProcessSeal, StopProofClock } from "./stop-proof.js";
import { stopUnderFreshProof, type VerifiedStopOutcome } from "./stop-proof.js";

const log = createLogger("deployment-pilot-lifecycle");

export const LEGACY_HOLD_GAP_CODES = [
  "LEGACY_ADMISSION_UNOBSERVABLE",
  "EXTERNAL_PRODUCERS_UNFENCED",
  "PENDING_ASSIGNMENTS_UNOBSERVABLE",
] as const;

/** Executed fail-closed pending result; raised before any stage, close or signal. */
export class MigrationPendingError extends DeferredMaintenance {
  readonly code = "MIGRATION_PENDING";
  constructor(
    readonly gaps: readonly string[],
    readonly holdRecordPath: string | null = null,
  ) {
    super(`MIGRATION_PENDING: ${gaps.join(",")}`);
  }
}

export class PilotEvidenceUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface PilotInstanceKey {
  canonicalHome: string;
  configPath: string;
  instanceId: string;
  uid: number;
}

/**
 * A registry-verified pilot snapshot as the lifecycle consumes it. The
 * evidence module reconstructs `services` only from sealed plist backups and
 * resolves `generation` from the snapshot or its verified recovery lineage.
 */
export interface RegisteredPilot {
  selector: string;
  sha256: string;
  bootstrap: { selector: string; sha256: string };
  instance: PilotInstanceKey;
  services: ServiceSnapshot;
  capturedPilotProfile: readonly { label: string; plistPath: string }[];
  sdkListenerPort: number;
  generation: { engine: ProcessOwner; worker: ProcessOwner };
}

export interface NativeHoldSession {
  worker: ProcessSeal;
  bootId: string;
  maintenanceDeadline: { wall: number; mono: number };
  /** Fresh decisive IPC/SDK/telemetry/OS reads under a new challenge. */
  collect(challenge: GateChallenge): Promise<NativeGateReadback>;
  /** Same-operation terminal release. */
  release(): Promise<void>;
}

export type HoldCapability =
  { kind: "unavailable"; gaps: readonly string[]; holdRecordPath: string | null } | { kind: "native-capable" };

export interface PilotLineage {
  migrationOperationId: string;
  candidateArchiveSha256: string;
  candidateRelease: ReleaseIdentity;
  candidateCurrent: DirectoryIdentity;
}

export interface ActivationFences {
  engineLog: LogFence;
  workerLog: LogFence;
  wallStartedAt: number;
  stopped: { engine: ProcessOwner | null; worker: ProcessOwner | null };
}

/** Supplied by the registry/hold evidence module (plan chunk 4 Task 9 Steps 4a–4c). */
export interface PilotEvidenceProvider {
  /** `--pilot-recovery=<registered-snapshot>` selector → verified snapshot. */
  selectRegisteredSnapshot(selector: string, instance: PilotInstanceKey): Promise<RegisteredPilot>;
  /** `--legacy-hold=<registered-hold>` selector → its verified snapshot. */
  selectHoldSnapshot(selector: string, instance: PilotInstanceKey): Promise<RegisteredPilot>;
  /** Rehash recovery trees/config/seals and check the current pilot profile, before stopping anything. */
  verifyRecoveryPrerequisites(pilot: RegisteredPilot): Promise<void>;
  /** Independently corroborated native admission capability, or the concrete gaps. */
  assessHoldCapability(pilot: RegisteredPilot): Promise<HoldCapability>;
  /**
   * Close under THIS operation (never a detached or earlier record). The
   * provider must call `recordIntent` with the corroborated supervisor before
   * sending close, so a lost acknowledgement stays reconcilable.
   */
  establishHold(
    pilot: RegisteredPilot,
    operation: AcquiredOperation,
    recordIntent: (supervisor: { seal: ProcessSeal; bootId: string }) => Promise<void>,
  ): Promise<NativeHoldSession>;
  /** Durable first-migration lineage referencing this snapshot/bootstrap, or null. */
  resolveMigrationLineage(pilot: RegisteredPilot, canonicalHome: string): Promise<PilotLineage | null>;
  /** Current pilot-profile observations after activation fences. */
  observePilotRecovery(pilot: RegisteredPilot, fences: ActivationFences): Promise<PilotRecoveryObservations>;
}

function unavailable(): never {
  throw new PilotEvidenceUnavailableError("PILOT_EVIDENCE_REGISTRY_UNAVAILABLE");
}

/**
 * The provider used until the registry/hold evidence module is wired. Every
 * route fails closed; nothing here can report a usable snapshot or hold.
 */
export const unavailablePilotEvidence: PilotEvidenceProvider = {
  selectRegisteredSnapshot: async () => unavailable(),
  selectHoldSnapshot: async () => unavailable(),
  verifyRecoveryPrerequisites: async () => unavailable(),
  assessHoldCapability: async () => ({ kind: "unavailable", gaps: [...LEGACY_HOLD_GAP_CODES], holdRecordPath: null }),
  establishHold: async () => unavailable(),
  resolveMigrationLineage: async () => null,
  observePilotRecovery: async () => unavailable(),
};

function sameInstance(left: PilotInstanceKey, right: PilotInstanceKey): boolean {
  return (
    left.canonicalHome === right.canonicalHome &&
    left.configPath === right.configPath &&
    left.instanceId === right.instanceId &&
    left.uid === right.uid
  );
}

/**
 * First migration / reapply (`update --artifact --legacy-hold`): select the
 * registered snapshot through its hold selector, check exact instance
 * agreement and recovery prerequisites, then require native capability. Any
 * gap is the executed `MIGRATION_PENDING` result, raised before stage/signals.
 */
export async function assessLegacyHoldRoute(input: {
  holdSelector: string;
  instance: PilotInstanceKey;
  provider: PilotEvidenceProvider;
}): Promise<RegisteredPilot> {
  let pilot: RegisteredPilot;
  try {
    pilot = await input.provider.selectHoldSnapshot(input.holdSelector, input.instance);
  } catch (error) {
    if (error instanceof PilotEvidenceUnavailableError) {
      throw new MigrationPendingError([error.code, ...LEGACY_HOLD_GAP_CODES]);
    }
    throw error;
  }
  if (!sameInstance(pilot.instance, input.instance)) {
    throw new Error("registered pilot snapshot belongs to another instance or config");
  }
  await input.provider.verifyRecoveryPrerequisites(pilot);
  const capability = await input.provider.assessHoldCapability(pilot);
  if (capability.kind !== "native-capable") {
    log.warn("Legacy dispatch hold unavailable; migration pending", { gaps: capability.gaps.length });
    throw new MigrationPendingError(capability.gaps, capability.holdRecordPath);
  }
  return pilot;
}

/**
 * `--pilot-recovery` is legal only with a resolved first-migration lineage for
 * this same snapshot/bootstrap whose candidate still occupies `.hive`.
 */
export async function assessPilotRecoveryRoute(input: {
  snapshotSelector: string;
  instance: PilotInstanceKey;
  provider: PilotEvidenceProvider;
  currentCandidate: { identity: DirectoryIdentity | null; release: ReleaseIdentity | null };
}): Promise<{ pilot: RegisteredPilot; lineage: PilotLineage }> {
  let pilot: RegisteredPilot;
  try {
    pilot = await input.provider.selectRegisteredSnapshot(input.snapshotSelector, input.instance);
  } catch (error) {
    if (error instanceof PilotEvidenceUnavailableError) {
      throw new MigrationPendingError([error.code]);
    }
    throw error;
  }
  if (!sameInstance(pilot.instance, input.instance)) {
    throw new Error("registered pilot snapshot belongs to another instance or config");
  }
  const lineage = await input.provider.resolveMigrationLineage(pilot, input.instance.canonicalHome);
  if (!lineage) throw new DeferredMaintenance("PILOT_RECOVERY_LINEAGE_MISSING");
  const current = input.currentCandidate;
  if (
    !current.identity ||
    !current.release ||
    current.identity.device !== lineage.candidateCurrent.device ||
    current.identity.inode !== lineage.candidateCurrent.inode ||
    current.release.packageVersion !== lineage.candidateRelease.packageVersion ||
    current.release.sourceRevision !== lineage.candidateRelease.sourceRevision ||
    current.release.dependencyLockSha256 !== lineage.candidateRelease.dependencyLockSha256
  ) {
    throw new DeferredMaintenance("PILOT_RECOVERY_CANDIDATE_MISMATCH");
  }
  await input.provider.verifyRecoveryPrerequisites(pilot);
  return { pilot, lineage };
}

// ── fenced log reads ──────────────────────────────────────────────────────

export interface LogFence {
  path: string;
  dev: number;
  ino: number;
  offset: number;
}

export function captureLogFence(path: string): LogFence {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    return { path, dev: info.dev, ino: info.ino, offset: info.size };
  } finally {
    closeSync(fd);
  }
}

export interface FencedMarker {
  message: string;
  timestamp: number;
  pid: number | null;
}

export interface FencedMarkerRead {
  records: FencedMarker[];
  /** Rotated, replaced, truncated or malformed: always uncertainty. */
  uncertain: boolean;
}

/** Read only bytes appended to the SAME file (device/inode) after its fence offset. */
export function readFencedMarkers(fence: LogFence): FencedMarkerRead {
  let fd: number;
  try {
    fd = openSync(fence.path, "r");
  } catch {
    return { records: [], uncertain: true };
  }
  try {
    const info = fstatSync(fd);
    if (info.dev !== fence.dev || info.ino !== fence.ino || info.size < fence.offset) {
      return { records: [], uncertain: true };
    }
    const bytes = Buffer.alloc(info.size - fence.offset);
    let consumed = 0;
    while (consumed < bytes.length) {
      const count = readSync(fd, bytes, consumed, bytes.length - consumed, fence.offset + consumed);
      if (count === 0) break;
      consumed += count;
    }
    const text = bytes.subarray(0, consumed).toString("utf8");
    let uncertain = !(text.length === 0 || text.endsWith("\n"));
    const records: FencedMarker[] = [];
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const value = JSON.parse(line) as { msg?: unknown; ts?: unknown; pid?: unknown };
        const timestamp = typeof value.ts === "string" ? Date.parse(value.ts) : Number.NaN;
        if (typeof value.msg !== "string" || !Number.isFinite(timestamp)) {
          uncertain = true;
          continue;
        }
        records.push({
          message: value.msg,
          timestamp,
          pid: Number.isSafeInteger(value.pid) ? (value.pid as number) : null,
        });
      } catch {
        // Non-JSON legacy lines are ignored only when no marker could be hidden in them.
        if (/Hive starting up|Hive is running|registered worker/.test(line)) uncertain = true;
      }
    }
    return { records, uncertain };
  } finally {
    closeSync(fd);
  }
}

/**
 * Fresh ordered markers attributed to the new generation. A legacy record
 * without a PID is attributable only when the caller corroborated an exclusive
 * single writer through OS open-file readback; offset zero is never used.
 */
export function freshFencedSequence(
  read: FencedMarkerRead,
  expected: { pid: number; notBefore: number; now: number; exclusiveWriter: boolean },
  sequence: readonly string[],
): boolean {
  if (read.uncertain || sequence.length === 0) return false;
  const attributable = read.records.filter(
    (record) =>
      record.timestamp >= expected.notBefore &&
      record.timestamp <= expected.now &&
      (record.pid === expected.pid || (record.pid === null && expected.exclusiveWriter)),
  );
  if (
    read.records.some(
      (record) => record.pid !== null && record.pid !== expected.pid && record.timestamp >= expected.notBefore,
    )
  ) {
    return false;
  }
  let index = 0;
  for (const record of attributable) {
    if (record.message === sequence[index]) index += 1;
    if (index === sequence.length) return true;
  }
  return false;
}

// ── pilot recovery evidence ───────────────────────────────────────────────

export interface PilotRecoveryObservations {
  captured: { engine: ServiceInspection; worker: ServiceInspection };
  live: { engine: ServiceInspection; worker: ServiceInspection };
  stopped: { engine: ProcessOwner | null; worker: ProcessOwner | null };
  activationStartedAt: number;
  now: number;
  /** Recovery closure rehashed immediately before bootstrap and again at final health. */
  executableHashesMatch: boolean;
  dependencyPathsAndVersionsMatch: boolean;
  engineLog: FencedMarkerRead;
  workerLog: FencedMarkerRead;
  engineExclusiveWriter: boolean;
  workerExclusiveWriter: boolean;
  /** Bridge probe through the captured loader/environment, exact no-turn request. */
  bridge: { authenticated: boolean; missingDenied: boolean; wrongDenied: boolean };
  sdk: { rootStatus: number | null; agentName: string | null };
  /** OS listener owner of the captured SDK port. */
  sdkSocketOwner: number | null;
}

function processStartMs(inspection: ServiceInspection): number {
  return inspection.process ? Date.parse(inspection.process.startTime) : Number.NaN;
}

function definitionMatches(live: ServiceInspection, captured: ServiceInspection): boolean {
  return (
    live.loaded &&
    live.process !== null &&
    captured.process !== null &&
    live.process.executable === captured.process.executable &&
    live.process.command === captured.process.command &&
    JSON.stringify(live.args) === JSON.stringify(captured.args)
  );
}

function newGeneration(live: ServiceInspection, stopped: ProcessOwner | null, activationStartedAt: number): boolean {
  if (!live.process || live.livePID === null) return false;
  if (stopped && live.process.pid === stopped.pid && live.process.startTime === stopped.startTime) return false;
  const started = processStartMs(live);
  // `ps lstart` has one-second resolution; allow that truncation only. An
  // unparseable start time is not evidence of a new generation.
  return Number.isFinite(started) && started >= activationStartedAt - 1_000;
}

/** Populate every pilot-profile field from current observations; legacy fields stay unavailable. */
export function assemblePilotRecoveryEvidence(o: PilotRecoveryObservations): PilotRecoveryEvidence {
  const enginePid = o.live.engine.process?.pid ?? -1;
  const workerPid = o.live.worker.process?.pid ?? -1;
  const notBefore = o.activationStartedAt;
  return {
    engineLiveIdentityMatches:
      newGeneration(o.live.engine, o.stopped.engine, o.activationStartedAt) &&
      definitionMatches(o.live.engine, o.captured.engine),
    workerLiveIdentityMatches:
      newGeneration(o.live.worker, o.stopped.worker, o.activationStartedAt) &&
      definitionMatches(o.live.worker, o.captured.worker),
    effectiveArgumentsMatch:
      JSON.stringify(o.live.engine.args) === JSON.stringify(o.captured.engine.args) &&
      JSON.stringify(o.live.worker.args) === JSON.stringify(o.captured.worker.args),
    workingDirectoryMatches:
      o.live.engine.cwd === o.captured.engine.cwd &&
      o.live.worker.cwd === o.captured.worker.cwd &&
      o.live.engine.process?.cwd === o.captured.engine.process?.cwd &&
      o.live.worker.process?.cwd === o.captured.worker.process?.cwd,
    configSelectorsMatch:
      o.live.engine.configSelection === o.captured.engine.configSelection &&
      o.live.worker.configSelection === o.captured.worker.configSelection &&
      JSON.stringify(o.live.engine.serviceEnvironment) === JSON.stringify(o.captured.engine.serviceEnvironment) &&
      JSON.stringify(o.live.worker.serviceEnvironment) === JSON.stringify(o.captured.worker.serviceEnvironment),
    executableHashesMatch: o.executableHashesMatch,
    dependencyPathsAndVersionsMatch: o.dependencyPathsAndVersionsMatch,
    freshOrderedEngineMarkers: freshFencedSequence(
      o.engineLog,
      { pid: enginePid, notBefore, now: o.now, exclusiveWriter: o.engineExclusiveWriter },
      ["Hive starting up", "Hive is running"],
    ),
    bridgeAuthenticated: o.bridge.authenticated,
    bridgeMissingDenied: o.bridge.missingDenied,
    bridgeWrongDenied: o.bridge.wrongDenied,
    sdkRootStatus: o.sdk.rootStatus,
    sdkAgentName: o.sdk.agentName,
    sdkSocketOwned: o.sdkSocketOwner !== null && o.sdkSocketOwner === workerPid,
    // A heartbeat alone never replaces a fresh SDK registration log line.
    registrationFresh: freshFencedSequence(
      o.workerLog,
      { pid: workerPid, notBefore, now: o.now, exclusiveWriter: o.workerExclusiveWriter },
      ["registered worker"],
    ),
    manifestIdentity: "legacy/unavailable",
    releaseBootIdentity: "legacy/unavailable",
    supervisorIdentity: "legacy/unavailable",
  };
}

// ── pilot rollback transaction ────────────────────────────────────────────

export interface PilotRollbackIO {
  controller: Pick<ServiceController, "bootout" | "inspect" | "restoreFilesAndState" | "restoreService">;
  provider: PilotEvidenceProvider;
  pilot: RegisteredPilot;
  /** Captured packaged candidate pair (this operation's prior snapshot). */
  candidate: ServiceSnapshot;
  candidateDefinitions: {
    engine: ServiceSnapshot["services"][number]["definition"];
    worker: ServiceSnapshot["services"][number]["definition"];
  };
  candidateWorkerHealthPort: number;
  phase: TransactionIO["phase"];
  /** Operation-owned installed-worker quiescence of the candidate (C). */
  quiesceCandidate(): Promise<boolean>;
  releaseCandidate(): Promise<void>;
  markSignalsBegun(): Promise<void>;
  /**
   * Stop the candidate worker under the final fresh proof fence. A `deferred`
   * outcome means no signal was issued and the same owner released admission.
   */
  stopCandidateWorker(): Promise<VerifiedStopOutcome | void>;
  /** After a verified deferred stop: the candidate pair is still the captured generation. */
  verifyCandidateUnsignaled?(): Promise<void>;
  verifyCandidatePacked(): Promise<void>;
  captureFences(): ActivationFences;
  finishResolved(resolution: "healthy" | "recovered" | "deferred"): Promise<void>;
  retainUnresolved(error: unknown): Promise<void>;
}

/**
 * Pilot rollback changes service definitions only: the candidate stays in its
 * operation-owned `.hive` slot, `.prev`/`.broken` are untouched, and the pilot
 * runs from its captured external paths. Engine restarts and proves a fresh
 * boot before the worker starts. On failure the candidate definitions and
 * full packaged profile are restored without artifact rotation.
 */
export function pilotRollbackTransaction(io: PilotRollbackIO): TransactionIO {
  let barrierEstablished = false;
  let stopDeferred = false;
  let fences: ActivationFences | null = null;
  let resolution: "healthy" | "recovered" | "deferred" = "deferred";
  const labels = {
    engine: io.candidateDefinitions.engine.label,
    worker: io.candidateDefinitions.worker.label,
  };
  return {
    phase: io.phase,
    async preflightAndStage() {
      // Recovery closure, seals and config were verified by route assessment.
    },
    async establishQuiescence() {
      barrierEstablished = await io.quiesceCandidate();
    },
    async releaseAdmission() {
      if (barrierEstablished) await io.releaseCandidate();
    },
    markSignalsBegun: () => io.markSignalsBegun(),
    async stopWorkerAndChildren() {
      const outcome = await io.stopCandidateWorker();
      if (outcome && outcome.kind === "deferred") {
        // Verified: no signal was issued and admission was released by the proof path.
        stopDeferred = true;
        barrierEstablished = false;
        throw new DeferredMaintenance(`candidate stop deferred: ${outcome.reason}`);
      }
    },
    async stopEngine() {
      await io.controller.bootout(io.candidateDefinitions.engine, { markIrreversible: async () => {} });
    },
    async rotate() {
      // Service definitions only: no artifact rotation.
    },
    async installCandidateDefinitions() {
      await io.provider.verifyRecoveryPrerequisites(io.pilot);
      await io.controller.restoreFilesAndState(io.pilot.services);
    },
    async startEngineAndVerifyBoot() {
      fences = io.captureFences();
      await io.controller.restoreService(io.pilot.services, labels.engine, { requireNewGeneration: true });
    },
    async startWorker() {
      await io.controller.restoreService(io.pilot.services, labels.worker, { requireNewGeneration: true });
    },
    async verifyCandidatePair() {
      if (!fences) throw new Error("pilot activation fences were not captured");
      const observations = await io.provider.observePilotRecovery(io.pilot, fences);
      if (!pilotRecovered(assemblePilotRecoveryEvidence(observations))) {
        throw new Error("pilot recovery profile verification failed");
      }
    },
    async finalizeHealthy() {
      resolution = "healthy";
    },
    async recoverPriorPair() {
      if (stopDeferred) {
        if (!io.verifyCandidateUnsignaled) throw new Error("deferred candidate stop cannot be verified");
        await io.verifyCandidateUnsignaled();
        resolution = "deferred";
        return;
      }
      const worker = await io.controller.inspect(labels.worker);
      if (worker.loaded) {
        const pilotWorker = io.pilot.services.services.find((item) => item.definition.label === labels.worker);
        const runningPilot =
          pilotWorker !== undefined && JSON.stringify(worker.args) === JSON.stringify(pilotWorker.inspection.args);
        await io.controller.bootout(io.candidateDefinitions.worker, {
          markIrreversible: async () => {},
          healthListenerPort: runningPilot ? io.pilot.sdkListenerPort : io.candidateWorkerHealthPort,
        });
      }
      const engine = await io.controller.inspect(labels.engine);
      if (engine.loaded)
        await io.controller.bootout(io.candidateDefinitions.engine, { markIrreversible: async () => {} });
      await io.controller.restoreFilesAndState(io.candidate);
      await io.controller.restoreService(io.candidate, labels.engine);
      await io.controller.restoreService(io.candidate, labels.worker);
      await io.verifyCandidatePacked();
      resolution = "recovered";
    },
    async finishResolved() {
      await io.finishResolved(resolution);
    },
    retainUnresolved: (error) => io.retainUnresolved(error),
  };
}

export interface PilotStopUnderHoldInput {
  session: NativeHoldSession;
  operationId: string;
  clock: StopProofClock;
  randomId(): string;
  persistSignalsBegun(): Promise<void>;
  controller: Pick<ServiceController, "bootout">;
  workerDefinition: ServiceSnapshot["services"][number]["definition"];
  healthListenerPort: number;
}

/**
 * Fixed pilot worker bootout under a single-use native hold proof consumed at
 * the actual launchd dispatch. A deferred outcome means no signal was issued.
 */
export async function stopPilotWorkerUnderHold(input: PilotStopUnderHoldInput): Promise<VerifiedStopOutcome> {
  return stopUnderFreshProof({
    operationId: input.operationId,
    worker: input.session.worker,
    bootId: input.session.bootId,
    clock: input.clock,
    maintenanceDeadline: input.session.maintenanceDeadline,
    randomId: input.randomId,
    collect: (challenge) => input.session.collect(challenge),
    persistSignalsBegun: input.persistSignalsBegun,
    bootout: (beforeExec) =>
      input.controller.bootout(input.workerDefinition, {
        markIrreversible: async () => {},
        healthListenerPort: input.healthListenerPort,
        beforeExec,
      }),
    release: () => input.session.release(),
  });
}
