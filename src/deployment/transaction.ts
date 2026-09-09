import { resolve } from "node:path";
import type { SupervisorRef } from "../voice-worker/admission.js";
import {
  corroborateMaintenanceBeforeStop,
  requestMaintenance,
  type CorroborateSupervisor,
  type RequestMaintenanceOptions,
} from "../voice-worker/maintenance-ipc.js";
import {
  directoryIdentity,
  disposeOwnedDirectory,
  locateDirectoryIdentity,
  moveOwnedDirectory,
  persistOperation,
  setOperationPhase,
  type AcquiredOperation,
  type DirectoryIdentity,
  type Phase,
} from "./operation.js";

export class DeferredMaintenance extends Error {}
export class UnresolvedMaintenance extends Error {}

export interface IdleEvidence {
  supervisor: SupervisorRef;
  registered: boolean;
  ownedSocket: boolean;
  sdkActiveJobs: number | null;
  telemetryActiveCalls: number | null;
}

export interface QuiescenceIO {
  now(): number;
  wait(ms: number): Promise<void>;
  inspect(deadline: number): Promise<IdleEvidence>;
  close(operationId: string, deadline: number): Promise<void>;
  status(operationId: string, deadline: number): Promise<{ unresolved: number; closed: boolean }>;
  release(operationId: string, deadline: number): Promise<void>;
  recordBarrierRequested(operationId: string, supervisor: IdleEvidence["supervisor"]): Promise<void>;
}

function sameSupervisor(left: IdleEvidence, right: IdleEvidence): boolean {
  return left.supervisor.pid === right.supervisor.pid && left.supervisor.bootId === right.supervisor.bootId;
}

/** Close admission and prove every pre-close request and active call settled. */
export async function quiesce(io: QuiescenceIO, operationId: string): Promise<IdleEvidence> {
  const deadline = io.now() + 30_000;
  const baseline = await io.inspect(deadline);
  if (
    !baseline.registered ||
    !baseline.ownedSocket ||
    baseline.sdkActiveJobs !== 0 ||
    baseline.telemetryActiveCalls !== 0
  ) {
    throw new DeferredMaintenance("active call or uncertain worker state");
  }
  await io.recordBarrierRequested(operationId, baseline.supervisor);
  try {
    await io.close(operationId, deadline);
    while (io.now() < deadline) {
      const gate = await io.status(operationId, deadline);
      const current = await io.inspect(deadline);
      if (!sameSupervisor(baseline, current) || !current.registered || !current.ownedSocket) {
        throw new DeferredMaintenance("worker identity or registration changed");
      }
      if (gate.closed && gate.unresolved === 0 && current.sdkActiveJobs === 0 && current.telemetryActiveCalls === 0) {
        return current;
      }
      await io.wait(Math.min(100, Math.max(0, deadline - io.now())));
    }
    throw new DeferredMaintenance("accepted work did not settle within 30 seconds");
  } catch (error) {
    try {
      await io.release(operationId, io.now() + 2_000);
    } catch {
      throw new UnresolvedMaintenance("maintenance release unacknowledged; services retained");
    }
    throw new DeferredMaintenance(error instanceof Error ? error.message : "maintenance deferred");
  }
}

export interface MaintenanceQuiescenceOptions {
  operation: AcquiredOperation;
  instanceHome: string;
  instanceId: string;
  inspect(deadline: number): Promise<IdleEvidence>;
  corroborateSupervisor: CorroborateSupervisor;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  request?: typeof requestMaintenance;
}

/** Adapter over the one shared mailbox client; no wire matching is duplicated here. */
export function maintenanceQuiescenceIO(options: MaintenanceQuiescenceOptions): QuiescenceIO {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  const request = options.request ?? requestMaintenance;
  const command = async (
    kind: RequestMaintenanceOptions["kind"],
    operationId: string,
    deadline: number,
    expectedAdmission: RequestMaintenanceOptions["expectedAdmission"],
  ) =>
    request({
      instanceHome: options.instanceHome,
      instanceId: options.instanceId,
      operationId,
      kind,
      deadline,
      expectedAdmission,
      corroborateSupervisor: options.corroborateSupervisor,
      supervisor: options.operation.record.supervisor,
      now,
      sleep: wait,
    });
  return {
    now,
    wait,
    inspect: options.inspect,
    async recordBarrierRequested(operationId, supervisor) {
      options.operation.record.phase = "barrier-requested";
      options.operation.record.supervisor = { ...supervisor };
      options.operation.record.barrierOperationId = operationId;
      await persistOperation(options.operation);
    },
    async close(operationId, deadline) {
      await command("close", operationId, deadline, "closed");
    },
    async status(operationId, deadline) {
      const reply = await command("status", operationId, deadline, "closed");
      return { unresolved: reply.snapshot.unresolved.length, closed: true };
    },
    async release(operationId, deadline) {
      const reply = await command("release", operationId, deadline, "open");
      if (reply.operationId !== operationId || reply.snapshot.operationId !== null) {
        throw new Error("terminal maintenance release did not correlate");
      }
    },
  };
}

/** Final identity and closed-gate fence immediately before launchd bootout. */
export async function proveBarrierBeforeStop(
  options: Omit<MaintenanceQuiescenceOptions, "inspect"> & { supervisor: SupervisorRef },
): Promise<void> {
  await corroborateMaintenanceBeforeStop(options.supervisor, options.corroborateSupervisor);
  const request = options.request ?? requestMaintenance;
  const reply = await request({
    instanceHome: options.instanceHome,
    instanceId: options.instanceId,
    operationId: options.operation.record.barrierOperationId ?? options.operation.record.id,
    kind: "status",
    deadline: (options.now ?? Date.now)() + 2_000,
    expectedAdmission: "closed",
    supervisor: options.supervisor,
    corroborateSupervisor: options.corroborateSupervisor,
    now: options.now,
    sleep: options.wait,
  });
  if (reply.snapshot.persistenceFault || reply.snapshot.unresolved.length !== 0) {
    throw new UnresolvedMaintenance("maintenance gate is not safe for shutdown");
  }
}

export interface TransactionIO {
  phase(value: Phase): Promise<void>;
  preflightAndStage(): Promise<void>;
  establishQuiescence(): Promise<void>;
  releaseAdmission(): Promise<void>;
  markSignalsBegun(): Promise<void>;
  stopWorkerAndChildren(): Promise<void>;
  stopEngine(): Promise<void>;
  rotate(): Promise<void>;
  installCandidateDefinitions(): Promise<void>;
  startEngineAndVerifyBoot(): Promise<void>;
  startWorker(): Promise<void>;
  verifyCandidatePair(): Promise<void>;
  finalizeHealthy(): Promise<void>;
  recoverPriorPair(): Promise<void>;
  finishResolved(): Promise<void>;
  retainUnresolved(error: unknown): Promise<void>;
}

/** Shared activation state machine used by update, rollback, start and restart adapters. */
export async function activate(io: TransactionIO): Promise<void> {
  let signalsBegun = false;
  let barrierEstablished = false;
  let healthyRecorded = false;
  try {
    await io.phase("preflight");
    await io.preflightAndStage();
    await io.phase("staged");
    await io.establishQuiescence();
    barrierEstablished = true;
    await io.phase("quiescent");
    await io.markSignalsBegun();
    signalsBegun = true;
    await io.phase("stopping-worker");
    await io.stopWorkerAndChildren();
    await io.phase("stopping-engine");
    await io.stopEngine();
    await io.phase("rotating");
    await io.rotate();
    await io.installCandidateDefinitions();
    await io.phase("starting-engine");
    await io.startEngineAndVerifyBoot();
    await io.phase("starting-worker");
    await io.startWorker();
    await io.phase("checking");
    await io.verifyCandidatePair();
    await io.phase("healthy");
    healthyRecorded = true;
    await io.finalizeHealthy();
    await io.finishResolved();
  } catch (primary) {
    if (healthyRecorded) {
      await io.retainUnresolved(primary);
      throw new AggregateError([primary], "candidate health passed; final cleanup requires reconciliation", {
        cause: primary,
      });
    }
    if (!signalsBegun) {
      if (barrierEstablished) {
        try {
          await io.releaseAdmission();
        } catch (releaseFailure) {
          await io.retainUnresolved(releaseFailure);
          throw new AggregateError([primary, releaseFailure], "maintenance unresolved; no services signaled", {
            cause: releaseFailure,
          });
        }
      }
      if (primary instanceof UnresolvedMaintenance) await io.retainUnresolved(primary);
      else await io.finishResolved();
      throw primary;
    }
    try {
      await io.phase("recovering");
      await io.recoverPriorPair();
      await io.finishResolved();
    } catch (recovery) {
      await io.retainUnresolved(recovery);
      throw new AggregateError(
        [primary, recovery],
        "activation and recovery failed; retained paths require attention",
        {
          cause: recovery,
        },
      );
    }
    throw new AggregateError([primary], "activation failed; prior pair restored and verified", { cause: primary });
  }
}

interface RotationSlots {
  current: string;
  previous: string;
  next: string;
  broken: string;
  priorPrevious: string;
  priorBroken: string;
  rollbackCurrent: string;
  failedPrevious: string;
}

interface CapturedRotation {
  current?: DirectoryIdentity;
  previous?: DirectoryIdentity;
  next?: DirectoryIdentity;
  broken?: DirectoryIdentity;
}

async function optionalIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    return await directoryIdentity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Exact package-slot rotation with identity-based recovery. */
export class ArtifactRotation {
  readonly slots: RotationSlots;
  readonly captured: CapturedRotation = {};

  constructor(
    private readonly operation: AcquiredOperation,
    private readonly validateBrokenOwnership: (path: string, identity: DirectoryIdentity) => Promise<boolean>,
  ) {
    const home = operation.record.canonicalHome;
    const op = operation.paths.operationDirectory;
    this.slots = {
      current: resolve(home, ".hive"),
      previous: resolve(home, ".hive.prev"),
      next: resolve(home, ".hive.next"),
      broken: resolve(home, ".hive.broken"),
      priorPrevious: resolve(op, "prior-prev"),
      priorBroken: resolve(op, "prior-broken"),
      rollbackCurrent: resolve(op, "rollback-current"),
      failedPrevious: resolve(op, "failed-prev"),
    };
  }

  async capture(): Promise<CapturedRotation> {
    this.captured.current = await optionalIdentity(this.slots.current);
    this.captured.previous = await optionalIdentity(this.slots.previous);
    this.captured.next = await optionalIdentity(this.slots.next);
    this.captured.broken = await optionalIdentity(this.slots.broken);
    if (this.captured.broken && !(await this.validateBrokenOwnership(this.slots.broken, this.captured.broken))) {
      throw new Error("existing .hive.broken is not owned recovery evidence");
    }
    return { ...this.captured };
  }

  async reserveBroken(): Promise<void> {
    if (this.captured.broken) {
      await moveOwnedDirectory(this.operation, this.slots.broken, this.slots.priorBroken);
    }
  }

  async rotateUpdate(): Promise<void> {
    if (!this.captured.current || !this.captured.next)
      throw new Error("update requires current and owned next releases");
    if (this.captured.previous) {
      await moveOwnedDirectory(this.operation, this.slots.previous, this.slots.priorPrevious);
    }
    await moveOwnedDirectory(this.operation, this.slots.current, this.slots.previous);
    await moveOwnedDirectory(this.operation, this.slots.next, this.slots.current);
  }

  async recoverUpdate(): Promise<void> {
    if (!this.captured.current || !this.captured.next) throw new Error("update recovery inventory incomplete");
    const candidate = await locateDirectoryIdentity(this.captured.next, [this.slots.current, this.slots.next]);
    if (candidate !== this.slots.broken) await moveOwnedDirectory(this.operation, candidate, this.slots.broken);
    const prior = await locateDirectoryIdentity(this.captured.current, [this.slots.current, this.slots.previous]);
    if (prior !== this.slots.current) await moveOwnedDirectory(this.operation, prior, this.slots.current);
    if (this.captured.previous) {
      const older = await locateDirectoryIdentity(this.captured.previous, [
        this.slots.priorPrevious,
        this.slots.previous,
      ]);
      if (older !== this.slots.previous) await moveOwnedDirectory(this.operation, older, this.slots.previous);
    }
  }

  async rotateRollback(): Promise<void> {
    if (!this.captured.current || !this.captured.previous)
      throw new Error("rollback requires current and previous releases");
    await moveOwnedDirectory(this.operation, this.slots.current, this.slots.rollbackCurrent);
    await moveOwnedDirectory(this.operation, this.slots.previous, this.slots.current);
  }

  async recoverRollback(): Promise<void> {
    if (!this.captured.current || !this.captured.previous) throw new Error("rollback recovery inventory incomplete");
    const selected = await locateDirectoryIdentity(this.captured.previous, [this.slots.current, this.slots.previous]);
    if (selected === this.slots.current) {
      await moveOwnedDirectory(this.operation, selected, this.slots.failedPrevious);
    }
    const original = await locateDirectoryIdentity(this.captured.current, [
      this.slots.rollbackCurrent,
      this.slots.current,
    ]);
    if (original !== this.slots.current) await moveOwnedDirectory(this.operation, original, this.slots.current);
    const failed = await locateDirectoryIdentity(this.captured.previous, [
      this.slots.failedPrevious,
      this.slots.previous,
    ]);
    if (failed !== this.slots.previous) await moveOwnedDirectory(this.operation, failed, this.slots.previous);
    await this.restorePriorBroken();
  }

  async finalizeRollbackSuccess(): Promise<void> {
    if (!this.captured.current) throw new Error("rollback current identity missing");
    const replaced = await locateDirectoryIdentity(this.captured.current, [this.slots.rollbackCurrent]);
    await moveOwnedDirectory(this.operation, replaced, this.slots.broken);
  }

  async finalizeUpdateSuccess(): Promise<void> {
    await this.restorePriorBroken();
    if (this.captured.previous) {
      const older = await locateDirectoryIdentity(this.captured.previous, [this.slots.priorPrevious]);
      await disposeOwnedDirectory(this.operation, older, this.captured.previous);
    }
  }

  async abortBeforeSignals(): Promise<void> {
    if (!this.operation.record.resolution) throw new Error("abort cleanup requires durable resolution");
    if (this.captured.next) {
      const candidate = await locateDirectoryIdentity(this.captured.next, [this.slots.next]);
      await disposeOwnedDirectory(this.operation, candidate, this.captured.next);
    }
    await this.restorePriorBroken();
  }

  async restorePriorBroken(): Promise<void> {
    if (!this.captured.broken) return;
    const prior = await locateDirectoryIdentity(this.captured.broken, [this.slots.priorBroken, this.slots.broken]);
    if (prior !== this.slots.broken) await moveOwnedDirectory(this.operation, prior, this.slots.broken);
  }

  async disposeSupersededBroken(): Promise<void> {
    if (!this.captured.broken) return;
    const prior = await locateDirectoryIdentity(this.captured.broken, [this.slots.priorBroken]);
    await disposeOwnedDirectory(this.operation, prior, this.captured.broken);
  }
}

export function operationPhaseAdapter(operation: AcquiredOperation): (phase: Phase) => Promise<void> {
  return (phase) => setOperationPhase(operation, phase);
}
