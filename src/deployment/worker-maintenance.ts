/**
 * Frozen-helper side of the private installed-worker `worker-maintenance`
 * observation (KPR-463 plan chunk 5 Task 9 Step 4b.2a Step 2b).
 *
 * The old `worker` diagnostic generated a random operation ID and so could not
 * read a gate closed by this operation. Each observation here writes a fresh,
 * sealed, operation-private request under `<operation>/probes/<jobId>/`, runs
 * the RUNNING installed release's own `pkg/runtime-probe.min.js` as an
 * unconfined direct child (a service probe of a promoted release, not an
 * artifact job), strictly decodes its one-line result, correlates it with the
 * request and re-reads the process/listener identity independently.
 *
 * The phase binding is private to the acquired operation: baseline until this
 * operation's real close acknowledgement, closed afterwards; it is never
 * inferred from a probe response. The original quiescence deadline is recorded
 * once and never extended. A final observation maps to a `NativeGateReadback`
 * for the absolute-expiry stop proof.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { freshAdmissionStatus, freshClosedAdmissionStatus, isPackagedRelease, parseBootIdentity } from "./health.js";
import { canonicalBytes, sealFile, sha256Hex, type FileSeal, type InstanceKey } from "./pilot-records.js";
import {
  classificationOf,
  decodeProbeFailure,
  decodeWorkerMaintenanceObservation,
  MAX_PROBE_OUTPUT_BYTES,
  ProbeFailure,
  sha256Canonical,
  WORKER_MAINTENANCE_ABI,
  workerObservationFault,
  type WorkerMaintenanceObservation,
  type WorkerMaintenancePhase,
  type WorkerMaintenanceRequest,
} from "./pilot-probe.js";
import { readRelease, type Release } from "./release.js";
import type { AcquiredOperation } from "./operation.js";
import type { ServiceController, ServiceDefinition } from "./services.js";
import {
  stopUnderFreshProof,
  type GateChallenge,
  type NativeGateReadback,
  type ProcessSeal,
  type StopProofClock,
  type VerifiedStopOutcome,
} from "./stop-proof.js";
import type { IdleEvidence } from "./transaction.js";

export class WorkerMaintenanceFault extends Error {
  constructor(
    readonly classification: string,
    options?: ErrorOptions,
  ) {
    super(`worker maintenance observation failed: ${classification}`, options);
  }
}

export interface ProbeRunResult {
  exitCode: number;
  stdout: string;
}

export interface WorkerMaintenanceIO {
  /** Launch the recorded Node on the installed probe with exactly this argv and environment. */
  run(node: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<ProbeRunResult>;
  readDescriptor(path: string): Promise<unknown>;
  readRelease(root: string): Release;
  seal(path: string, options: { uid: number; allowRoot?: boolean }): Promise<FileSeal>;
  rootIdentity(path: string): Promise<{ dev: number; ino: number; uid: number }>;
  writeRequest(path: string, bytes: Buffer): Promise<void>;
}

async function exclusiveWrite(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
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

export const nodeWorkerMaintenanceIO: WorkerMaintenanceIO = {
  run(node, args, env, timeoutMs) {
    return new Promise((resolvePromise) => {
      nodeExecFile(
        node,
        [...args],
        { env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: MAX_PROBE_OUTPUT_BYTES },
        (error, stdout) => {
          const code = error
            ? typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1
            : 0;
          resolvePromise({ exitCode: code, stdout: String(stdout ?? "") });
        },
      );
    });
  },
  async readDescriptor(path) {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  },
  readRelease: (root) => readRelease(root),
  async seal(path, options) {
    const { bytes: _bytes, ...seal } = await sealFile(path, { uid: options.uid, allowRoot: options.allowRoot });
    void _bytes;
    return seal;
  },
  async rootIdentity(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) {
      throw new WorkerMaintenanceFault("PILOT_PROBE_INPUT_INVALID");
    }
    return { dev: info.dev, ino: info.ino, uid: info.uid };
  },
  writeRequest: exclusiveWrite,
};

export interface InstalledWorkerOptions {
  operation: AcquiredOperation;
  instance: InstanceKey;
  /** The RUNNING installed worker definition; its runtime root is derived from it. */
  workerDefinition: ServiceDefinition;
  serviceEnvironment: Record<string, string>;
  nodePath: string;
  configPath: string;
  /** The running worker's own loader reports its health listener port. */
  onHealthPort?: (port: number) => void;
  controller: Pick<ServiceController, "inspect" | "listener">;
  clock: StopProofClock;
  randomId?: () => string;
  io?: WorkerMaintenanceIO;
}

export interface InstalledWorkerRead {
  observation: WorkerMaintenanceObservation;
  worker: ProcessSeal;
  listenerPid: number | null;
  statusFresh: boolean;
  idle: IdleEvidence;
  wall: { start: number; end: number };
  mono: { start: number; end: number };
}

export function processSealOf(inspection: Awaited<ReturnType<ServiceController["inspect"]>>): ProcessSeal {
  if (!inspection.process || inspection.livePID === null || inspection.livePID !== inspection.process.pid) {
    throw new WorkerMaintenanceFault("PILOT_ADMISSION_MISMATCH");
  }
  const { pid, startTime, executable, command, cwd } = inspection.process;
  return { pid, startTime, executable, command, cwd };
}

/**
 * Operation-bound observer for the running installed worker. One instance per
 * acquired lifecycle operation.
 */
export class InstalledWorkerMaintenance {
  readonly #options: InstalledWorkerOptions;
  readonly #io: WorkerMaintenanceIO;
  readonly #randomId: () => string;
  #phase: "baseline" | "closed" = "baseline";
  #deadline: { wall: number; mono: number } | null = null;
  readonly #usedIds = new Set<string>();
  /** Slow runtime seals are taken once, before any decisive read window. */
  #seals: {
    root: { dev: number; ino: number; uid: number };
    node: FileSeal;
    probe: FileSeal;
    config: FileSeal;
  } | null = null;

  /** Seal node/probe/config and the runtime root before the decisive windows. */
  async prepare(): Promise<void> {
    if (this.#seals) return;
    const o = this.#options;
    const root = this.runtimeRoot;
    this.#seals = {
      root: await this.#io.rootIdentity(root),
      node: await this.#io.seal(o.nodePath, { uid: o.instance.uid, allowRoot: true }),
      probe: await this.#io.seal(resolve(root, "pkg", "runtime-probe.min.js"), { uid: o.instance.uid }),
      config: await this.#io.seal(o.configPath, { uid: o.instance.uid }),
    };
  }

  constructor(options: InstalledWorkerOptions) {
    this.#options = options;
    this.#io = options.io ?? nodeWorkerMaintenanceIO;
    this.#randomId = options.randomId ?? randomUUID;
  }

  get runtimeRoot(): string {
    return dirname(dirname(this.#options.workerDefinition.entrypoint));
  }

  get maintenanceDeadline(): { wall: number; mono: number } | null {
    return this.#deadline ? { ...this.#deadline } : null;
  }

  /** Called only after this operation's real close acknowledgement. */
  markClosed(): void {
    this.#phase = "closed";
  }

  /** Called only after verified terminal release or verified supervisor exit. */
  clear(): void {
    this.#phase = "baseline";
  }

  get closed(): boolean {
    return this.#phase === "closed";
  }

  #freshId(): string {
    const id = this.#randomId();
    if (this.#usedIds.has(id)) throw new WorkerMaintenanceFault("PILOT_PROBE_INPUT_INVALID");
    this.#usedIds.add(id);
    return id;
  }

  /** Record the original quiescence deadline once; later calls never extend it. */
  bindDeadline(wallDeadline: number): void {
    if (this.#deadline) return;
    const now = this.#options.clock.now();
    this.#deadline = { wall: wallDeadline, mono: this.#options.clock.mono() + (wallDeadline - now) };
  }

  /**
   * One fresh observation. `phaseOverride` is only `final` (a new read after
   * the quiescence loop); the admission expectation still comes from the
   * private binding.
   */
  async observe(options: { final?: boolean; challenge?: GateChallenge } = {}): Promise<InstalledWorkerRead> {
    const o = this.#options;
    const { clock } = o;
    const wallStart = clock.now();
    const monoStart = clock.mono();
    if (!this.#deadline) throw new WorkerMaintenanceFault("PILOT_PROBE_DEADLINE");
    if (wallStart >= this.#deadline.wall || monoStart >= this.#deadline.mono) {
      throw new WorkerMaintenanceFault("PILOT_PROBE_DEADLINE");
    }
    const phase: WorkerMaintenancePhase =
      this.#phase === "baseline" ? "baseline" : options.final ? "final" : "post-close";
    if (options.final && this.#phase !== "closed") throw new WorkerMaintenanceFault("PILOT_ADMISSION_MISMATCH");
    const before = processSealOf(await o.controller.inspect(o.workerDefinition.label));
    const descriptor = parseBootIdentity(
      await this.#io.readDescriptor(resolve(o.instance.canonicalHome, ".hive-state", "runtime", "voice-worker.json")),
    );
    const root = this.runtimeRoot;
    if (root !== resolve(o.instance.canonicalHome, ".hive"))
      throw new WorkerMaintenanceFault("PILOT_PROBE_INPUT_INVALID");
    const installed = this.#io.readRelease(root);
    if (
      descriptor.component !== "voice-worker" ||
      descriptor.pid !== before.pid ||
      !isPackagedRelease(descriptor.release) ||
      canonical(descriptor.release) !== canonical(installed)
    ) {
      throw new WorkerMaintenanceFault("PILOT_TELEMETRY_WRONG_BOOT");
    }
    await this.prepare();
    const seals = this.#seals!;
    const requestedAt = options.challenge?.requestedAt ?? wallStart;
    if (options.challenge && options.challenge.operationId !== o.operation.record.id) {
      throw new WorkerMaintenanceFault("PILOT_PROBE_INPUT_INVALID");
    }
    const jobId = this.#freshId();
    const request: WorkerMaintenanceRequest = {
      schemaVersion: 1,
      abi: WORKER_MAINTENANCE_ABI,
      action: "observe",
      requestId: options.challenge?.requestId ?? this.#freshId(),
      operationId: o.operation.record.id,
      jobId,
      instance: o.instance,
      phase,
      requestedAt,
      deadline: Math.min(requestedAt + 2_000, this.#deadline.wall),
      maintenanceDeadline: this.#deadline.wall,
      runtime: {
        root: { path: root, identity: seals.root },
        node: seals.node,
        probe: seals.probe,
        config: seals.config,
        environmentSha256: sha256Canonical(o.serviceEnvironment),
      },
      expectedRelease: installed,
      expectedWorker: before,
      idle: {
        expectedAdmission: phase === "baseline" ? "open" : "closed",
        expectedSupervisor: descriptor,
        statusRequestId: this.#freshId(),
      },
    };
    const requestBytes = canonicalBytes(request);
    const requestPath = resolve(o.operation.paths.operationDirectory, "probes", jobId, "worker-maintenance.json");
    await this.#io.writeRequest(requestPath, requestBytes);
    const remaining = request.deadline - clock.now();
    if (remaining <= 0) throw new WorkerMaintenanceFault("PILOT_PROBE_DEADLINE");
    const result = await this.#io.run(
      o.nodePath,
      [request.runtime.probe.path, "worker-maintenance", requestPath],
      o.serviceEnvironment,
      remaining,
    );
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    if (lines.length !== 1 || result.stdout.length > MAX_PROBE_OUTPUT_BYTES) {
      throw new WorkerMaintenanceFault("PILOT_PROBE_INPUT_INVALID");
    }
    let parsed: unknown;
    try {
      parsed = parseCanonical(Buffer.from(`${lines[0]}\n`));
    } catch (error) {
      throw new WorkerMaintenanceFault("PILOT_PROBE_INPUT_INVALID", { cause: error });
    }
    if (result.exitCode !== 0) {
      let failure: string;
      try {
        failure = decodeProbeFailure(parsed, WORKER_MAINTENANCE_ABI).classification;
      } catch {
        failure = "PILOT_PROBE_INPUT_INVALID";
      }
      throw new WorkerMaintenanceFault(failure);
    }
    let observation: WorkerMaintenanceObservation;
    try {
      observation = decodeWorkerMaintenanceObservation(parsed);
    } catch (error) {
      throw new WorkerMaintenanceFault(classificationOf(error), { cause: error });
    }
    const wallEnd = clock.now();
    const fault = workerObservationFault(observation, request, sha256Hex(requestBytes), wallEnd);
    if (fault) throw new WorkerMaintenanceFault(fault);
    // Independent OS correspondence after the reads.
    const after = processSealOf(await o.controller.inspect(o.workerDefinition.label));
    if (canonical(after) !== canonical(before)) throw new WorkerMaintenanceFault("PILOT_ADMISSION_MISMATCH");
    o.onHealthPort?.(observation.sdk.port);
    const listener = await o.controller.listener(observation.sdk.port, before.pid);
    const monoEnd = clock.mono();
    const completed = clock.now();
    if (completed < wallEnd || monoEnd < monoStart) throw new WorkerMaintenanceFault("PILOT_PROBE_DEADLINE");
    const reply = observation.idle.status.reply;
    const supervisor = { pid: descriptor.pid, bootId: descriptor.bootId };
    const context = {
      reply,
      requestId: request.idle.statusRequestId,
      operationId: request.operationId,
      requestedAt: observation.idle.status.requestedAt,
      expectedSupervisor: supervisor,
      processCorroborated: listener.pid === before.pid,
      now: completed,
    };
    const statusFresh = phase === "baseline" ? freshAdmissionStatus(context) : freshClosedAdmissionStatus(context);
    return {
      observation,
      worker: before,
      listenerPid: listener.pid,
      statusFresh,
      idle: {
        supervisor,
        registered: statusFresh && observation.sdk.rootStatus === 200 && observation.sdk.agentName === "hive-voice",
        ownedSocket: listener.pid === before.pid,
        sdkActiveJobs: observation.sdk.activeJobs,
        telemetryActiveCalls: observation.idle.telemetry.activeCalls,
      },
      wall: { start: wallStart, end: completed },
      mono: { start: monoStart, end: monoEnd },
    };
  }
}

/**
 * Map a strictly validated final observation to the stop-proof readback. The
 * oldest decisive read is the challenge time (every IPC/SDK/Mongo/OS read
 * starts after it); completion is the local end of the independent reads.
 * Socket ownership comes from independent listener readback only.
 */
export function toNativeGateReadback(read: InstalledWorkerRead, challenge: GateChallenge): NativeGateReadback {
  if (!read.statusFresh) throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
  const { observation } = read;
  const reply = observation.idle.status.reply;
  return {
    operationId: challenge.operationId,
    requestId: challenge.requestId,
    requestedAt: challenge.requestedAt,
    observedAt: challenge.requestedAt,
    completedAt: read.wall.end,
    observedMono: read.mono.start,
    completedMono: read.mono.end,
    worker: read.worker,
    bootId: observation.idle.telemetry.supervisorIdentity.bootId,
    closedOperationId: reply.snapshot.operationId,
    admission: reply.snapshot.admission,
    unresolvedAccepted: reply.snapshot.unresolved.length,
    sdkActiveJobs: observation.sdk.activeJobs,
    telemetryActiveCalls: observation.idle.telemetry.activeCalls,
    telemetryUpdatedAt: observation.idle.telemetry.supervisorUpdatedAt,
    persistenceFault: reply.snapshot.persistenceFault,
    sdkRootStatus: observation.sdk.rootStatus,
    sdkAgentName: observation.sdk.agentName,
    socketOwner: read.listenerPid === read.worker.pid ? read.worker : { ...read.worker, pid: read.listenerPid ?? 0 },
  };
}

export interface InstalledStopInput {
  observer: InstalledWorkerMaintenance;
  operationId: string;
  worker: ProcessSeal;
  bootId: string;
  clock: StopProofClock;
  randomId?: () => string;
  /** Supplementary correlated closed-gate IPC check; never refreshes expiry. */
  supplementary?: () => Promise<void>;
  persistSignalsBegun(): Promise<void>;
  controller: Pick<ServiceController, "bootout">;
  workerDefinition: ServiceDefinition;
  healthListenerPort: () => number;
  /** Same-owner terminal release (clears the observer binding on success). */
  release(): Promise<void>;
}

/**
 * Normal restart/update/rollback and the candidate leg of pilot rollback: a new
 * `final` installed observation after quiescence, proved and consumed at the
 * actual launchd dispatch under the original wall/monotonic/heartbeat expiry.
 */
export async function stopInstalledWorkerUnderProof(input: InstalledStopInput): Promise<VerifiedStopOutcome> {
  const deadline = input.observer.maintenanceDeadline;
  if (!deadline) throw new WorkerMaintenanceFault("PILOT_PROBE_DEADLINE");
  return stopUnderFreshProof({
    operationId: input.operationId,
    worker: input.worker,
    bootId: input.bootId,
    clock: input.clock,
    maintenanceDeadline: deadline,
    randomId: input.randomId ?? randomUUID,
    async collect(challenge) {
      await input.supplementary?.();
      const read = await input.observer.observe({ final: true, challenge });
      return toNativeGateReadback(read, challenge);
    },
    persistSignalsBegun: input.persistSignalsBegun,
    bootout: (beforeExec) =>
      input.controller.bootout(input.workerDefinition, {
        markIrreversible: async () => {},
        healthListenerPort: input.healthListenerPort(),
        beforeExec,
      }),
    release: input.release,
  });
}

export { classificationOf };
