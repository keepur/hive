/**
 * Frozen-helper side of the pilot probe ABI and the native historical hold
 * adapter (KPR-463 plan chunk 4 Task 9 Steps 4b.2/4c.2, chunk 5 Task 9 Step
 * 4b.2a Steps 1–2a and Step 4c.2a).
 *
 * `invokePilotProbe` writes a fresh sealed request under this acquired
 * operation, runs the REGISTERED bootstrap probe with the captured Node and the
 * captured worker service environment (an unconfined service probe, never an
 * artifact job), strictly decodes its single line and correlates it with the
 * request, the captured baseline and an independently computed dependency set.
 * A probe cannot supply trusted process ownership: OS readback is repeated
 * here.
 *
 * The native hold adapter is offered ONLY for a historical layout whose
 * admission capability is freshly corroborated: a packaged `hive-pilot-probe/1`
 * runtime whose own strict release, worker bundle seal, current supervisor
 * descriptor, live process and SDK socket owner all agree. It closes admission
 * under the owning operation through the shared maintenance client, reads the
 * owner-correlated historical idle state (SDK, ledger status and telemetry in
 * the historical loader process) on every inspect, and yields decisive
 * readback only to the absolute-expiry stop proof. The uninstrumented legacy
 * layout never reaches this adapter; nothing here accepts a file or boolean as
 * hold evidence.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { freshAdmissionStatus, freshClosedAdmissionStatus, isPackagedRelease, parseBootIdentity } from "./health.js";
import type { AcquiredOperation } from "./operation.js";
import { PilotEvidenceUnavailableError, type NativeHoldSession } from "./pilot-lifecycle.js";
import {
  classificationOf,
  decodePilotFailure,
  decodePilotInventoryResult,
  decodePilotProbeResult,
  historicalIdleFault,
  MAX_PROBE_OUTPUT_BYTES,
  pilotProbeRequestPath,
  resolveRequiredDependencies,
  sameDependencySet,
  type HistoricalIdleRequest,
  type PilotInventoryResult,
  type PilotProbeMode,
  type PilotProbeRequest,
  type PilotProbeResult,
} from "./pilot-probe.js";
import {
  canonicalBytes,
  sealFile,
  snapshotBaseline,
  verifySeal,
  type BootstrapRecord,
  type CaptureDraft,
  type FileSeal,
  type InstanceKey,
  type PilotSnapshot,
  type PilotSubject,
  type ProcessSeal,
} from "./pilot-records.js";
import { readRelease, type BootIdentity, type Release } from "./release.js";
import { buildServiceEnvironment, type ServiceController, type ServiceInspection } from "./services.js";
import type { GateChallenge, NativeGateReadback, StopProofClock } from "./stop-proof.js";
import { quiesce, type IdleEvidence, type QuiescenceIO } from "./transaction.js";
import { requestMaintenance, type RequestMaintenanceOptions } from "../voice-worker/maintenance-ipc.js";

export type Baseline = CaptureDraft["baseline"];

export class PilotProbeFault extends Error {
  constructor(
    readonly classification: string,
    options?: ErrorOptions,
  ) {
    super(`pilot probe failed: ${classification}`, options);
  }
}

export interface ProbeRunResult {
  exitCode: number;
  stdout: string;
}

export interface PilotProbeLaunchIO {
  run(node: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<ProbeRunResult>;
  writeRequest(path: string, bytes: Buffer): Promise<void>;
  seal(path: string, rules: { uid: number; allowRoot?: boolean }): Promise<FileSeal>;
  verify(seal: FileSeal, rules: { uid: number; allowRoot?: boolean }): Promise<void>;
  resolveDependencies(entry: string, roots: readonly string[]): { path: string }[];
}

export const nodePilotProbeLaunchIO: PilotProbeLaunchIO = {
  run(node, args, env, timeoutMs) {
    return new Promise((done) => {
      nodeExecFile(
        node,
        [...args],
        {
          env,
          timeout: Math.max(1, timeoutMs),
          killSignal: "SIGKILL",
          encoding: "utf8",
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        },
        (error, stdout) => {
          const code = error
            ? typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1
            : 0;
          done({ exitCode: code, stdout: String(stdout ?? "") });
        },
      );
    });
  },
  async writeRequest(path, bytes) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async seal(path, rules) {
    const { bytes: _bytes, ...seal } = await sealFile(path, rules);
    void _bytes;
    return seal;
  },
  async verify(seal, rules) {
    await verifySeal(seal, rules);
  },
  resolveDependencies: (entry, roots) => resolveRequiredDependencies(entry, roots),
};

/** A pilot probe subject: the active capture draft or a registered snapshot. */
export interface PilotProbeSubject {
  instance: InstanceKey;
  subject: PilotSubject;
  subjectSeal: FileSeal;
  baseline: Baseline;
  bootstrap: BootstrapRecord;
  /** Registered snapshot identity; null while a capture establishes it. */
  expectedConfigIdentity: string | null;
}

export function registeredProbeSubject(
  snapshot: PilotSnapshot,
  payloadSeal: FileSeal,
  bootstrap: BootstrapRecord,
): PilotProbeSubject {
  const baseline = snapshotBaseline(snapshot);
  const { id, configIdentity } = snapshot;
  return {
    instance: snapshot.instance,
    subject: { kind: "registered", snapshot: { id, sha256: payloadSeal.sha256 } },
    subjectSeal: payloadSeal,
    baseline,
    bootstrap,
    expectedConfigIdentity: configIdentity,
  };
}

/** Slow seals taken once, before any decisive window. */
export interface PreparedPilotProbe {
  subject: PilotProbeSubject;
  node: string;
  probe: string;
  environment: Record<string, string>;
  dependencies: FileSeal[];
}

function dependencyEntry(baseline: Baseline): { entry: string; roots: string[] } {
  const loader = baseline.runtime.workerLoader;
  return loader.kind === "packaged-probe"
    ? { entry: loader.file.realpath, roots: [loader.runtimeRoot] }
    : { entry: loader.file.realpath, roots: baseline.runtime.roots.map((root) => root.realpath) };
}

export async function preparePilotProbe(
  subject: PilotProbeSubject,
  io: PilotProbeLaunchIO = nodePilotProbeLaunchIO,
): Promise<PreparedPilotProbe> {
  const uid = subject.instance.uid;
  try {
    await io.verify(subject.baseline.runtime.node, { uid, allowRoot: true });
    await io.verify(subject.bootstrap.probe, { uid });
    await io.verify(subject.baseline.runtime.workerLoader.file, { uid });
    const { entry, roots } = dependencyEntry(subject.baseline);
    const dependencies: FileSeal[] = [];
    for (const item of io.resolveDependencies(entry, roots)) dependencies.push(await io.seal(item.path, { uid }));
    return {
      subject,
      node: subject.baseline.runtime.node.path,
      probe: subject.bootstrap.probe.path,
      environment: buildServiceEnvironment(subject.baseline.services[1].definition),
      dependencies,
    };
  } catch (error) {
    throw new PilotProbeFault(error instanceof PilotProbeFault ? error.classification : "PILOT_DEPENDENCY_MISMATCH", {
      cause: error,
    });
  }
}

export interface PilotProbeInvocation {
  operationId: string;
  expectedEngine: ProcessSeal;
  expectedWorker: ProcessSeal;
  idle: HistoricalIdleRequest | null;
  clock: StopProofClock;
  randomId(): string;
  /** A stop-proof challenge supplies the request ID and time. */
  challenge?: GateChallenge;
  /** Original maintenance deadline; a request deadline never exceeds it. */
  maintenanceDeadline?: number;
  io?: PilotProbeLaunchIO;
}

export interface InvokedPilotProbe<T> {
  request: PilotProbeRequest;
  result: T;
  wall: { start: number; end: number };
  mono: { start: number; end: number };
}

function decodeLine(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || stdout.length > MAX_PROBE_OUTPUT_BYTES)
    throw new PilotProbeFault("PILOT_PROBE_INPUT_INVALID");
  try {
    return parseCanonical(Buffer.from(`${lines[0]}\n`));
  } catch (error) {
    throw new PilotProbeFault("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
}

async function launch(
  prepared: PreparedPilotProbe,
  mode: PilotProbeMode,
  input: PilotProbeInvocation,
): Promise<{
  request: PilotProbeRequest;
  parsed: unknown;
  wall: { start: number; end: number };
  mono: { start: number; end: number };
}> {
  const io = input.io ?? nodePilotProbeLaunchIO;
  const { clock } = input;
  const wallStart = clock.now();
  const monoStart = clock.mono();
  const subject = prepared.subject;
  if (input.challenge && input.challenge.operationId !== input.operationId) {
    throw new PilotProbeFault("PILOT_PROBE_INPUT_INVALID");
  }
  const requestedAt = input.challenge?.requestedAt ?? wallStart;
  const budget = mode === "pilot" ? 2_000 : 30_000;
  const deadline = Math.min(requestedAt + budget, input.maintenanceDeadline ?? Number.MAX_SAFE_INTEGER);
  const request: PilotProbeRequest = {
    schemaVersion: 1,
    requestId: input.challenge?.requestId ?? input.randomId(),
    operationId: input.operationId,
    subject: subject.subject,
    instance: subject.instance,
    requestedAt,
    deadline,
    expectedEngine: input.expectedEngine,
    expectedWorker: input.expectedWorker,
    bootstrap: subject.baseline.bootstrap,
    draftOrSnapshotSeal: subject.subjectSeal,
    idle: input.idle,
  };
  const path = pilotProbeRequestPath(subject.instance.canonicalHome, request, mode);
  await io.writeRequest(path, canonicalBytes(request));
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw new PilotProbeFault("PILOT_PROBE_DEADLINE");
  const run = await io.run(prepared.node, [prepared.probe, mode, path], prepared.environment, remaining);
  const parsed = decodeLine(run.stdout);
  if (run.exitCode !== 0) {
    let classification = "PILOT_PROBE_INPUT_INVALID";
    try {
      const failure = decodePilotFailure(parsed);
      if (failure.requestId === request.requestId || failure.requestId === "00000000-0000-0000-0000-000000000000") {
        classification = failure.classification;
      }
    } catch {
      // Unknown failure shape stays invalid; never parsed as success.
    }
    throw new PilotProbeFault(classification);
  }
  const monoEnd = clock.mono();
  const wallEnd = clock.now();
  if (wallEnd < wallStart || monoEnd < monoStart) throw new PilotProbeFault("PILOT_PROBE_DEADLINE");
  return { request, parsed, wall: { start: wallStart, end: wallEnd }, mono: { start: monoStart, end: monoEnd } };
}

function envelopeFault(
  result: { requestId: string; instance: InstanceKey; subject: PilotSubject; startedAt: number; finishedAt: number },
  request: PilotProbeRequest,
  now: number,
): string | null {
  if (
    result.requestId !== request.requestId ||
    canonical(result.instance) !== canonical(request.instance) ||
    canonical(result.subject) !== canonical(request.subject)
  ) {
    return "PILOT_PROBE_INPUT_INVALID";
  }
  if (
    result.startedAt < request.requestedAt ||
    result.startedAt > result.finishedAt ||
    result.finishedAt > request.deadline ||
    result.finishedAt > now
  ) {
    return "PILOT_PROBE_DEADLINE";
  }
  return null;
}

/**
 * Strict current-result validation (chunk 4 Step 4b.2): matching challenge,
 * subject and times, correct bridge 400/missing-agent with both denials in
 * {401,403}, captured loopback port, root 200, exact agent name, nonnegative
 * job count, exact dependency identity set and configuration identity, plus the
 * owner-correlated idle rules when requested.
 */
export function pilotResultFault(
  result: PilotProbeResult,
  request: PilotProbeRequest,
  prepared: PreparedPilotProbe,
  now: number,
): string | null {
  const envelope = envelopeFault(result, request, now);
  if (envelope) return envelope;
  const denied = (status: number) => status === 401 || status === 403;
  if (
    result.bridge.correctStatus !== 400 ||
    !denied(result.bridge.missingStatus) ||
    !denied(result.bridge.wrongStatus)
  ) {
    return "PILOT_BRIDGE_FAILED";
  }
  const listener = prepared.subject.baseline.runtime.sdkListener;
  if (
    result.sdk.host !== listener.host ||
    result.sdk.port !== listener.port ||
    result.sdk.rootStatus !== 200 ||
    result.sdk.agentName !== listener.agentName
  ) {
    return "PILOT_ADMISSION_MISMATCH";
  }
  if (!sameDependencySet(result.dependencyFiles, prepared.dependencies)) return "PILOT_DEPENDENCY_MISMATCH";
  if (
    prepared.subject.expectedConfigIdentity !== null &&
    result.configIdentity !== prepared.subject.expectedConfigIdentity
  ) {
    return "PILOT_CONFIGURATION_MISMATCH";
  }
  if ((request.idle === null) !== (result.idle === null)) return "PILOT_PROBE_INPUT_INVALID";
  if (request.idle && result.idle) {
    const loader = prepared.subject.baseline.runtime.workerLoader;
    if (loader.kind !== "packaged-probe") return "PILOT_PROBE_ABI_UNSUPPORTED";
    return historicalIdleFault(result.idle, { ...request, idle: request.idle }, loader.release, result);
  }
  return null;
}

export async function invokePilotProbe(
  prepared: PreparedPilotProbe,
  input: PilotProbeInvocation,
): Promise<InvokedPilotProbe<PilotProbeResult>> {
  const launched = await launch(prepared, "pilot", input);
  let result: PilotProbeResult;
  try {
    result = decodePilotProbeResult(launched.parsed);
  } catch (error) {
    throw new PilotProbeFault(classificationOf(error), { cause: error });
  }
  const fault = pilotResultFault(result, launched.request, prepared, launched.wall.end);
  if (fault) throw new PilotProbeFault(fault);
  return { request: launched.request, result, wall: launched.wall, mono: launched.mono };
}

export async function invokePilotInventory(
  prepared: PreparedPilotProbe,
  input: PilotProbeInvocation,
): Promise<InvokedPilotProbe<PilotInventoryResult>> {
  if (input.idle !== null) throw new PilotProbeFault("PILOT_PROBE_INPUT_INVALID");
  const launched = await launch(prepared, "pilot-inventory", input);
  let result: PilotInventoryResult;
  try {
    result = decodePilotInventoryResult(launched.parsed);
  } catch (error) {
    throw new PilotProbeFault(classificationOf(error), { cause: error });
  }
  const fault = envelopeFault(result, launched.request, launched.wall.end);
  if (fault) throw new PilotProbeFault(fault);
  if (
    prepared.subject.expectedConfigIdentity !== null &&
    result.configIdentity !== prepared.subject.expectedConfigIdentity
  ) {
    throw new PilotProbeFault("PILOT_CONFIGURATION_MISMATCH");
  }
  return { request: launched.request, result, wall: launched.wall, mono: launched.mono };
}

// ── native capability and hold ────────────────────────────────────────────

export const NATIVE_CAPABILITY_UNCORROBORATED = "NATIVE_CAPABILITY_UNCORROBORATED";

export function processSealOf(inspection: ServiceInspection): ProcessSeal {
  if (!inspection.process || inspection.livePID === null || inspection.livePID !== inspection.process.pid) {
    throw new PilotEvidenceUnavailableError("PILOT_NOT_RUNNING");
  }
  const { pid, startTime, executable, command, cwd } = inspection.process;
  return { pid, startTime, executable, command, cwd };
}

export interface NativeHoldDeps {
  instance: InstanceKey;
  controller: Pick<ServiceController, "inspect" | "listenerOwners">;
  clock: StopProofClock;
  randomId(): string;
  probeIO?: PilotProbeLaunchIO;
  readDescriptor?(path: string): Promise<unknown>;
  readRelease?(root: string): Release;
  request?(options: RequestMaintenanceOptions): ReturnType<typeof requestMaintenance>;
  wait?(ms: number): Promise<void>;
}

export interface NativeCapability {
  worker: ProcessSeal;
  engine: ProcessSeal;
  descriptor: BootIdentity;
  release: Release;
}

export interface CapabilitySubject {
  snapshot: PilotSnapshot;
  generation: { engine: { pid: number; startTime: string }; worker: { pid: number; startTime: string } };
}

function descriptorPath(instance: InstanceKey): string {
  return resolve(instance.canonicalHome, ".hive-state", "runtime", "voice-worker.json");
}

async function readDescriptor(deps: NativeHoldDeps): Promise<BootIdentity> {
  const read = deps.readDescriptor ?? (async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown);
  return parseBootIdentity(await read(descriptorPath(deps.instance)));
}

/**
 * Independently corroborate native admission capability NOW (chunk 4 Step
 * 4b.1): a packaged historical layout whose strict release, declared worker
 * entry, worker bundle seal, current supervisor descriptor, live process and
 * SDK socket owner all agree. A snapshot field alone never establishes it.
 */
export async function corroborateNativeCapability(
  subject: CapabilitySubject,
  deps: NativeHoldDeps,
): Promise<NativeCapability> {
  const { snapshot } = subject;
  const uncorroborated = () => new PilotEvidenceUnavailableError(NATIVE_CAPABILITY_UNCORROBORATED);
  const admission = snapshot.admission;
  const loader = snapshot.runtime.workerLoader;
  if (admission.kind !== "hive-maintenance-v1" || loader.kind !== "packaged-probe") throw uncorroborated();
  try {
    const root = loader.runtimeRoot;
    if (admission.runtimeRoot !== root) throw uncorroborated();
    const current = (deps.readRelease ?? readRelease)(root);
    if (
      canonical(current) !== canonical(loader.release) ||
      canonical(current) !== canonical(admission.release) ||
      current.voiceWorker.admissionProtocol !== 1
    ) {
      throw uncorroborated();
    }
    const workerDefinition = snapshot.services[1].definition;
    const bundle = resolve(root, current.voiceWorker.path);
    if (workerDefinition.entrypoint !== bundle || admission.workerBundle.path !== bundle) throw uncorroborated();
    await (deps.probeIO ?? nodePilotProbeLaunchIO).verify(admission.workerBundle, { uid: deps.instance.uid });
    const [engine, worker] = await Promise.all(
      snapshot.services.map((save) => deps.controller.inspect(save.definition.label)),
    );
    const engineSeal = processSealOf(engine);
    const workerSeal = processSealOf(worker);
    if (
      engineSeal.pid !== subject.generation.engine.pid ||
      engineSeal.startTime !== subject.generation.engine.startTime ||
      workerSeal.pid !== subject.generation.worker.pid ||
      workerSeal.startTime !== subject.generation.worker.startTime
    ) {
      throw uncorroborated();
    }
    const descriptor = await readDescriptor(deps);
    if (
      descriptor.component !== "voice-worker" ||
      descriptor.pid !== workerSeal.pid ||
      !isPackagedRelease(descriptor.release) ||
      canonical(descriptor.release) !== canonical(current)
    ) {
      throw uncorroborated();
    }
    const owners = await deps.controller.listenerOwners(snapshot.runtime.sdkListener.port);
    if (owners.length !== 1 || owners[0] !== workerSeal.pid) throw uncorroborated();
    return { worker: workerSeal, engine: engineSeal, descriptor, release: current };
  } catch (error) {
    if (error instanceof PilotEvidenceUnavailableError) throw error;
    throw new PilotEvidenceUnavailableError(NATIVE_CAPABILITY_UNCORROBORATED);
  }
}

export interface HistoricalHoldRead {
  result: PilotProbeResult;
  worker: ProcessSeal;
  listenerOwner: number | null;
  statusFresh: boolean;
  idle: IdleEvidence;
  wall: { start: number; end: number };
  mono: { start: number; end: number };
  challenge: GateChallenge;
}

/**
 * Operation-bound historical idle observer. Baseline until this operation's
 * own close acknowledgement, closed afterwards (never inferred from a
 * response). Every inspect is a new challenge with a fresh status UUID; the
 * original quiescence deadline is recorded once and never extended.
 */
export class HistoricalHoldObserver {
  readonly #operation: AcquiredOperation;
  readonly #prepared: PreparedPilotProbe;
  readonly #capability: NativeCapability;
  readonly #deps: NativeHoldDeps;
  readonly #workerLabel: string;
  readonly #used = new Set<string>();
  #phase: "baseline" | "closed" = "baseline";
  #deadline: { wall: number; mono: number } | null = null;

  constructor(
    operation: AcquiredOperation,
    prepared: PreparedPilotProbe,
    capability: NativeCapability,
    deps: NativeHoldDeps,
  ) {
    this.#operation = operation;
    this.#prepared = prepared;
    this.#capability = capability;
    this.#deps = deps;
    this.#workerLabel = prepared.subject.baseline.services[1].definition.label;
  }

  get maintenanceDeadline(): { wall: number; mono: number } | null {
    return this.#deadline ? { ...this.#deadline } : null;
  }

  get closed(): boolean {
    return this.#phase === "closed";
  }

  bindDeadline(wall: number): void {
    if (this.#deadline) return;
    const now = this.#deps.clock.now();
    this.#deadline = { wall, mono: this.#deps.clock.mono() + (wall - now) };
  }

  markClosed(): void {
    this.#phase = "closed";
  }

  clear(): void {
    this.#phase = "baseline";
  }

  #fresh(): string {
    const id = this.#deps.randomId();
    if (this.#used.has(id)) throw new PilotProbeFault("PILOT_PROBE_INPUT_INVALID");
    this.#used.add(id);
    return id;
  }

  async observe(options: { final?: boolean; challenge?: GateChallenge } = {}): Promise<HistoricalHoldRead> {
    const { clock, controller } = this.#deps;
    if (!this.#deadline) throw new PilotProbeFault("PILOT_PROBE_DEADLINE");
    const wallStart = clock.now();
    const monoStart = clock.mono();
    if (wallStart >= this.#deadline.wall || monoStart >= this.#deadline.mono) {
      throw new PilotProbeFault("PILOT_PROBE_DEADLINE");
    }
    if (options.final && this.#phase !== "closed") throw new PilotProbeFault("PILOT_ADMISSION_MISMATCH");
    const before = processSealOf(await controller.inspect(this.#workerLabel));
    const descriptor = await readDescriptor(this.#deps);
    if (
      canonical(before) !== canonical(this.#capability.worker) ||
      canonical(descriptor) !== canonical(this.#capability.descriptor)
    ) {
      throw new PilotProbeFault("PILOT_TELEMETRY_WRONG_BOOT");
    }
    const challenge: GateChallenge = options.challenge ?? {
      operationId: this.#operation.record.id,
      requestId: this.#fresh(),
      requestedAt: wallStart,
    };
    const expectedAdmission = this.#phase === "baseline" ? "open" : "closed";
    const invoked = await invokePilotProbe(this.#prepared, {
      operationId: this.#operation.record.id,
      expectedEngine: this.#capability.engine,
      expectedWorker: before,
      idle: { expectedAdmission, expectedSupervisor: descriptor, statusRequestId: this.#fresh() },
      clock,
      randomId: () => this.#fresh(),
      challenge,
      maintenanceDeadline: this.#deadline.wall,
      io: this.#deps.probeIO,
    });
    // Independent OS correspondence after the reads.
    const after = processSealOf(await controller.inspect(this.#workerLabel));
    if (canonical(after) !== canonical(before)) throw new PilotProbeFault("PILOT_ADMISSION_MISMATCH");
    const owners = await controller.listenerOwners(invoked.result.sdk.port);
    const listenerOwner = owners.length === 1 ? owners[0] : null;
    const monoEnd = clock.mono();
    const wallEnd = clock.now();
    if (wallEnd < invoked.wall.end || monoEnd < monoStart) throw new PilotProbeFault("PILOT_PROBE_DEADLINE");
    const idle = invoked.result.idle!;
    const supervisor = { pid: descriptor.pid, bootId: descriptor.bootId };
    const context = {
      reply: idle.status.reply,
      requestId: invoked.request.idle!.statusRequestId,
      operationId: this.#operation.record.id,
      requestedAt: idle.status.requestedAt,
      expectedSupervisor: supervisor,
      processCorroborated: listenerOwner === before.pid,
      now: wallEnd,
    };
    const statusFresh =
      expectedAdmission === "open" ? freshAdmissionStatus(context) : freshClosedAdmissionStatus(context);
    return {
      result: invoked.result,
      worker: before,
      listenerOwner,
      statusFresh,
      idle: {
        supervisor,
        registered:
          statusFresh && invoked.result.sdk.rootStatus === 200 && invoked.result.sdk.agentName === "hive-voice",
        ownedSocket: listenerOwner === before.pid,
        sdkActiveJobs: invoked.result.sdk.activeJobs,
        telemetryActiveCalls: idle.telemetry.activeCalls,
      },
      wall: { start: wallStart, end: wallEnd },
      mono: { start: monoStart, end: monoEnd },
      challenge,
    };
  }
}

/** Map a validated final historical read to the stop-proof readback; never a synthesized profile. */
export function historicalGateReadback(read: HistoricalHoldRead): NativeGateReadback {
  if (!read.statusFresh || !read.result.idle) throw new PilotProbeFault("PILOT_ADMISSION_MISMATCH");
  const reply = read.result.idle.status.reply;
  return {
    operationId: read.challenge.operationId,
    requestId: read.challenge.requestId,
    requestedAt: read.challenge.requestedAt,
    observedAt: read.challenge.requestedAt,
    completedAt: read.wall.end,
    observedMono: read.mono.start,
    completedMono: read.mono.end,
    worker: read.worker,
    bootId: read.result.idle.telemetry.supervisorIdentity.bootId,
    closedOperationId: reply.snapshot.operationId,
    admission: reply.snapshot.admission,
    unresolvedAccepted: reply.snapshot.unresolved.length,
    sdkActiveJobs: read.result.sdk.activeJobs,
    telemetryActiveCalls: read.result.idle.telemetry.activeCalls,
    telemetryUpdatedAt: read.result.idle.telemetry.supervisorUpdatedAt,
    persistenceFault: reply.snapshot.persistenceFault,
    sdkRootStatus: read.result.sdk.rootStatus,
    sdkAgentName: read.result.sdk.agentName,
    socketOwner:
      read.listenerOwner === read.worker.pid ? read.worker : { ...read.worker, pid: read.listenerOwner ?? 0 },
  };
}

export interface EstablishedNativeHold {
  session: NativeHoldSession;
  capability: NativeCapability;
  observer: HistoricalHoldObserver;
  /** The quiesced post-close read that established the hold. */
  settled: IdleEvidence;
}

/**
 * Establish a native hold under THIS operation: fresh capability
 * corroboration, owner-correlated open baseline, durable close intent (via
 * `recordIntent`), shared-client close, then bounded post-close quiescence on
 * fresh historical reads. Any failure before close defers without closing;
 * after close the same owner terminal-releases (unacknowledged release stays
 * unresolved) — all inside the shared `quiesce` contract.
 */
export async function establishNativeHold(input: {
  subject: CapabilitySubject;
  probe: PilotProbeSubject;
  operation: AcquiredOperation;
  recordIntent(supervisor: { seal: ProcessSeal; bootId: string }): Promise<void>;
  deps: NativeHoldDeps;
}): Promise<EstablishedNativeHold> {
  const { operation, deps } = input;
  const capability = await corroborateNativeCapability(input.subject, deps);
  const prepared = await preparePilotProbe(input.probe, deps.probeIO);
  const observer = new HistoricalHoldObserver(operation, prepared, capability, deps);
  const supervisor = { pid: capability.descriptor.pid, bootId: capability.descriptor.bootId };
  const workerLabel = input.probe.baseline.services[1].definition.label;
  const request = deps.request ?? requestMaintenance;
  const corroborateSupervisor = async () => {
    const descriptor = await readDescriptor(deps);
    const live = processSealOf(await deps.controller.inspect(workerLabel));
    if (
      canonical(descriptor) !== canonical(capability.descriptor) ||
      canonical(live) !== canonical(capability.worker)
    ) {
      throw new Error("historical supervisor changed");
    }
    return supervisor;
  };
  const command = (kind: RequestMaintenanceOptions["kind"], deadline: number, expectedAdmission: "open" | "closed") =>
    request({
      instanceHome: input.probe.instance.canonicalHome,
      instanceId: input.probe.instance.instanceId,
      operationId: operation.record.id,
      kind,
      deadline,
      expectedAdmission,
      supervisor,
      corroborateSupervisor,
      now: deps.clock.now,
    });
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const io: QuiescenceIO = {
    now: deps.clock.now,
    wait,
    async inspect(deadline) {
      observer.bindDeadline(deadline);
      return (await observer.observe()).idle;
    },
    async recordBarrierRequested(operationId) {
      if (operationId !== operation.record.id) throw new Error("hold close must belong to this operation");
      await input.recordIntent({ seal: capability.worker, bootId: capability.descriptor.bootId });
    },
    async close(_operationId, deadline) {
      await command("close", deadline, "closed");
      observer.markClosed();
    },
    async status(_operationId, deadline) {
      const reply = await command("status", deadline, "closed");
      return {
        unresolved: reply.snapshot.unresolved.length,
        closed: reply.snapshot.admission === "closed" && reply.snapshot.operationId === operation.record.id,
      };
    },
    async release(_operationId, deadline) {
      const reply = await command("release", deadline, "open");
      if (reply.operationId !== operation.record.id || reply.snapshot.operationId !== null) {
        throw new Error("terminal maintenance release did not correlate");
      }
      observer.clear();
    },
  };
  const settled = await quiesce(io, operation.record.id);
  const deadline = observer.maintenanceDeadline;
  if (!deadline) throw new PilotProbeFault("PILOT_PROBE_DEADLINE");
  const session: NativeHoldSession = {
    worker: capability.worker,
    bootId: capability.descriptor.bootId,
    maintenanceDeadline: deadline,
    async collect(challenge) {
      return historicalGateReadback(await observer.observe({ final: true, challenge }));
    },
    release: () => io.release(operation.record.id, deps.clock.now() + 2_000),
  };
  return { session, capability, observer, settled };
}

// ── recovery-profile adapters ─────────────────────────────────────────────

/** Operation ID owning a probe directory: `<home>/.hive-state/deployment/operations/<id>`. */
export function operationIdOf(operationDirectory: string): string {
  return basename(operationDirectory);
}
