import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  buildServiceEnvironment,
  buildServiceDefinitions,
  ServiceController,
  type ServiceDefinition,
  type ServiceSnapshot,
} from "./services.js";
import { preflightStagedConfig, stageVerifiedCandidate, type ArtifactStagingContext } from "./artifact.js";
import { ConfinedJobRunner, runConfinementSelfTest } from "./confined-job.js";
import { disposeOperationJobs, selectPromotionMethod, sweepLeftoverJobs } from "./clone-promotion.js";
import { voiceWorkerPort } from "./ports.js";
import {
  parseBootIdentity,
  packagedHealthy,
  freshAdmissionStatus,
  freshOrderedEngineMarkers,
  readEngineMarkersAfter,
} from "./health.js";
import { contained, readRelease, type BootIdentity, type Release } from "./release.js";
import {
  directoryIdentity,
  disposeOwnedDirectory,
  persistOperation,
  recordStagingJob,
  recordStagingPromotion,
  writeOperationJson,
  type AcquiredOperation,
} from "./operation.js";
import {
  activate,
  ArtifactRotation,
  DeferredMaintenance,
  maintenanceQuiescenceIO,
  operationPhaseAdapter,
  proveBarrierBeforeStop,
  quiesce,
  UnresolvedMaintenance,
  type IdleEvidence,
  type QuiescenceIO,
  type TransactionIO,
} from "./transaction.js";
import { capturePrior, restorePrior } from "./prior.js";
import {
  applyBetaPluginCompatibility,
  PluginCompatibilityPendingError,
  PluginCompatibilityUnresolvedError,
} from "./plugin-compat.js";
import {
  assessLegacyHoldRoute,
  assessPilotRecoveryRoute,
  assemblePilotRecoveryEvidence,
  captureLogFence,
  PILOT_ACTIVATION_FILE,
  PILOT_GENERATION_FILE,
  pilotRollbackTransaction,
  stopPilotWorkerUnderHold,
  unavailablePilotEvidence,
  type ActivationFences,
  type NativeHoldSession,
  type PilotEvidenceProvider,
  type PilotInstanceKey,
  type RegisteredPilot,
} from "./pilot-lifecycle.js";
import { pilotRecovered } from "./health.js";
import type { StopProofClock } from "./stop-proof.js";
import { InstalledWorkerMaintenance, processSealOf, stopInstalledWorkerUnderProof } from "./worker-maintenance.js";

export {
  capturePrior,
  loadPrior,
  restorePrior,
  verifyPrior,
  verifyStoppedPrior,
  PriorSnapshotIncompleteError,
} from "./prior.js";

const execFile = promisify(nodeExecFile);

export interface LifecycleCommand {
  mode: "update" | "check" | "rollback" | "start" | "stop" | "restart" | "pilot-rollback";
  tag?: string;
  artifact?: string;
  pilotRecovery?: string;
  legacyHold?: string;
}

export interface LifecycleOptions {
  /**
   * Registry/hold evidence module (plan chunk 4 Task 9 Steps 4a–4c). Until it
   * is supplied, pilot routes return the executed `MIGRATION_PENDING` result.
   */
  pilotEvidence?: PilotEvidenceProvider;
  clock?: StopProofClock;
  /**
   * Service-inspection boundary. Production leaves this unset and uses the
   * controller `resolveLifecycleContext` builds (which shells out to
   * `launchctl`); unit tests inject one so a route can be driven without any
   * real launchd call. It survives the mid-flight context re-resolve.
   */
  controller?: ServiceController;
}

interface ConfigSummary {
  instanceId: string;
  voiceEnabled: boolean;
  databaseName?: string;
  /** Configured worker health listener; the running supervisor's recorded port is preferred. */
  workerHealthPort: number;
}

/**
 * Only operations that stage a new artifact run confined jobs, and therefore
 * the confinement self-test and promotion-method preflight. Ordinary rollback,
 * start, stop, restart and pilot recovery never need `sandbox-exec`.
 */
export function stagingRequired(mode: LifecycleCommand["mode"]): boolean {
  return mode === "update" || mode === "check";
}

/**
 * In-process validation of an already promoted release (current `.hive`,
 * rollback `.hive.prev`): manifest/lock, packaged entries including the worker,
 * and containment of its dependency tree. Runs no packaged diagnostic and no
 * confined job, so it works without `sandbox-exec`.
 */
export function validatePromotedRelease(root: string): Release {
  const release = readRelease(root);
  const nodeModules = contained(root, resolve(root, "node_modules"));
  if (!statSync(nodeModules).isDirectory()) throw new Error("promoted release has no installed dependency tree");
  contained(root, resolve(root, release.voiceWorker.path));
  return release;
}

interface WorkerProbe {
  ok: true;
  classification: string;
  supervisor: { pid: number; bootId: string };
  status: {
    requestId: string;
    operationId: string;
    requestedAt: number;
    writtenAt: number;
    snapshot: import("../voice-worker/admission.js").AdmissionSnapshot;
  };
  sdk: { rootStatus: number | null; agentName: string | null; activeJobs: number | null };
  heartbeat: { fresh: boolean; activeCalls: number | null; identity: BootIdentity | null };
  socketOwned: boolean;
  healthPort?: number;
}

function configSummary(value: unknown): ConfigSummary {
  if (!value || typeof value !== "object") throw new Error("invalid Hive configuration");
  const config = value as {
    instance?: { id?: unknown; portBase?: unknown; ports?: { voiceWorker?: unknown } };
    voice?: { livekit?: { enabled?: unknown } };
    mongo?: { dbName?: unknown };
  };
  const instanceId = config.instance?.id ?? "hive";
  if (typeof instanceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(instanceId)) {
    throw new Error("invalid configured instance ID");
  }
  return {
    instanceId,
    voiceEnabled: config.voice?.livekit?.enabled === true,
    databaseName: typeof config.mongo?.dbName === "string" ? config.mongo.dbName : undefined,
    workerHealthPort: voiceWorkerPort(config.instance?.portBase, config.instance?.ports?.voiceWorker),
  };
}

function serviceOverrides(environment: NodeJS.ProcessEnv) {
  const keys = [
    "BG_TASK_PORT",
    "MEETING_MONITOR_PORT",
    "CODE_TASK_PORT",
    "WS_PORT",
    "ADMIN_API_PORT",
    "VOICE_PORT",
    "SLACK_INTERNAL_PORT",
    "BEEKEEPER_PORT",
  ] as const;
  return Object.fromEntries(keys.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])));
}

async function probeJson(
  path: string,
  mode: "config" | "bridge" | "worker",
  environment: Record<string, string>,
  timeout = 30_000,
): Promise<Record<string, unknown>> {
  const result = await execFile(process.execPath, [path, mode], {
    env: environment,
    timeout,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(result.stdout.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${mode} probe returned invalid JSON`);
  return parsed as Record<string, unknown>;
}

function parseWorkerProbe(value: Record<string, unknown>): WorkerProbe {
  const candidate = value as unknown as Partial<WorkerProbe>;
  if (
    candidate.ok !== true ||
    !candidate.supervisor ||
    !Number.isSafeInteger(candidate.supervisor.pid) ||
    typeof candidate.supervisor.bootId !== "string" ||
    !candidate.status?.snapshot ||
    !candidate.sdk ||
    !candidate.heartbeat
  ) {
    throw new Error("worker probe evidence is incomplete");
  }
  return candidate as WorkerProbe;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Selected configuration, packaged service definitions and controller for one instance. */
export interface LifecycleContext {
  home: string;
  configReal: string;
  summary: ConfigSummary;
  userHome: string;
  pathEnv: string;
  definitions: { engine: ServiceDefinition; worker: ServiceDefinition };
  controller: ServiceController;
  probeEnvironment: Record<string, string>;
  currentProbePath: string;
  pilotInstance: PilotInstanceKey;
}

export async function resolveLifecycleContext(
  operation: AcquiredOperation,
  environment: NodeJS.ProcessEnv,
  options: { capturedPilotProfile?: readonly { label: string; plistPath: string }[] } = {},
): Promise<LifecycleContext> {
  const home = operation.record.canonicalHome;
  const selectedConfig = environment.HIVE_CONFIG ?? "hive.yaml";
  const configReal = await realpath(resolve(home, selectedConfig));
  const summary = configSummary(parseYaml(await readFile(configReal, "utf8")));
  if (summary.instanceId !== operation.record.instanceId) throw new Error("selected config instance changed");
  const userHome = environment.HOME;
  const pathEnv = environment.PATH;
  if (!userHome || !resolve(userHome).startsWith("/") || !pathEnv)
    throw new Error("explicit HOME and PATH are required");
  const overrides = serviceOverrides(environment);
  const definitions = buildServiceDefinitions({
    instanceId: summary.instanceId,
    nodePath: process.execPath,
    hiveHome: home,
    configPath: configReal,
    home: resolve(userHome),
    pathEnv,
    engineOverrides: overrides,
    workerOverrides: overrides,
  });
  const controller = new ServiceController({
    instanceId: summary.instanceId,
    hiveHome: home,
    home: resolve(userHome),
    operationDir: operation.paths.operationDirectory,
    capturedPilotProfile: options.capturedPilotProfile,
  });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("lifecycle requires a POSIX user ID");
  return {
    home,
    configReal,
    summary,
    userHome: resolve(userHome),
    pathEnv,
    definitions,
    controller,
    probeEnvironment: buildServiceEnvironment(definitions.worker),
    currentProbePath: resolve(home, ".hive", "pkg", "runtime-probe.min.js"),
    pilotInstance: { canonicalHome: home, configPath: configReal, instanceId: summary.instanceId, uid },
  };
}

/** Observe the running packaged worker identity through launchd plus its boot record. */
export async function observeWorkerIdentity(context: LifecycleContext): Promise<{ pid: number; bootId: string }> {
  const inspection = await context.controller.inspect(context.definitions.worker.label);
  if (!inspection.process || inspection.livePID === null) throw new Error("voice worker is not running");
  const identity = parseBootIdentity(
    JSON.parse(await readFile(resolve(context.home, ".hive-state", "runtime", "voice-worker.json"), "utf8")),
  );
  if (identity.pid !== inspection.livePID || identity.component !== "voice-worker") {
    throw new Error("voice worker identity does not match launchd");
  }
  return { pid: identity.pid, bootId: identity.bootId };
}

/** Full packaged-release profile of the current `.hive` pair (spec §6). */
export async function verifyPackagedPair(
  context: LifecycleContext,
  options: { minimumStartedAt: number; engineLogOffset: number; dependenciesContained: boolean },
): Promise<void> {
  const { home, summary, definitions, controller } = context;
  const installed = readRelease(resolve(home, ".hive"));
  const engine = parseBootIdentity(
    JSON.parse(await readFile(resolve(home, ".hive-state", "runtime", "engine.json"), "utf8")),
  );
  const engineInspection = await controller.inspect(definitions.engine.label);
  const markerRead = readEngineMarkersAfter(definitions.engine.stdout, options.engineLogOffset);
  let worker: BootIdentity | null = null;
  let workerResult: WorkerProbe | null = null;
  let bridge: Record<string, unknown> = {};
  if (summary.voiceEnabled) {
    workerResult = parseWorkerProbe(await probeJson(context.currentProbePath, "worker", context.probeEnvironment));
    worker = workerResult.heartbeat.identity;
    bridge = await probeJson(context.currentProbePath, "bridge", context.probeEnvironment);
  }
  const evidence = {
    installed,
    engine,
    worker,
    voiceEnabled: summary.voiceEnabled,
    processPathsMatch:
      engineInspection.process?.command === [definitions.engine.nodePath, definitions.engine.entrypoint].join(" "),
    configSelectorsMatch: engineInspection.configSelection === context.configReal,
    freshOrderedEngineMarkers: freshOrderedEngineMarkers(
      markerRead.records,
      engine,
      options.minimumStartedAt,
      Date.now(),
      markerRead.truncatedOrMalformed,
    ),
    engineAlive: engineInspection.livePID === engine.pid,
    workerAlive: workerResult?.supervisor.pid === worker?.pid,
    heartbeatFresh: workerResult?.heartbeat.fresh === true,
    heartbeatMatchesSupervisor:
      workerResult !== null &&
      worker !== null &&
      workerResult.supervisor.pid === worker.pid &&
      workerResult.supervisor.bootId === worker.bootId,
    admissionSnapshot: workerResult?.status.snapshot ?? null,
    admissionFresh:
      workerResult !== null &&
      freshAdmissionStatus({
        reply: {
          protocol: 1,
          requestId: workerResult.status.requestId,
          operationId: workerResult.status.operationId,
          supervisor: workerResult.supervisor,
          ok: true,
          snapshot: workerResult.status.snapshot,
          writtenAt: workerResult.status.writtenAt,
        },
        requestId: workerResult.status.requestId,
        operationId: workerResult.status.operationId,
        requestedAt: workerResult.status.requestedAt,
        expectedSupervisor: workerResult.supervisor,
        processCorroborated: true,
      }),
    sdkRootStatus: workerResult?.sdk.rootStatus ?? null,
    sdkAgentName: workerResult?.sdk.agentName ?? null,
    sdkSocketOwned: workerResult?.socketOwned === true,
    bridgeAuthenticated: bridge.authenticated === true,
    bridgeMissingDenied: bridge.missingDenied === true,
    bridgeWrongDenied: bridge.wrongDenied === true,
    dependenciesContained: options.dependenciesContained,
  };
  if (!packagedHealthy(evidence)) throw new Error("paired release health verification failed");
}

const defaultClock: StopProofClock = { now: Date.now, mono: () => performance.now() };

/**
 * Concrete source lifecycle. The S9 integration harness exercises this through
 * the frozen S8 bundle; every boundary here is independently injectable in S7
 * transaction tests.
 */
export async function runNodeLifecycle(
  operation: AcquiredOperation,
  command: LifecycleCommand,
  environment: NodeJS.ProcessEnv = process.env,
  options: LifecycleOptions = {},
): Promise<void> {
  const pilotEvidence = options.pilotEvidence ?? unavailablePilotEvidence;
  const clock = options.clock ?? defaultClock;
  let context = await resolveLifecycleContext(operation, environment);
  const home = context.home;
  const npmLookup = await execFile("which", ["npm"], {
    env: { PATH: context.pathEnv },
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  const npmPath = await realpath(npmLookup.stdout.trim());
  const npmInfo = await lstat(npmPath);
  if (!npmInfo.isFile() || npmInfo.isSymbolicLink()) throw new Error("host npm prerequisite is not a regular file");
  operation.record.hostNodePath = await realpath(process.execPath);
  operation.record.hostNpmPath = npmPath;
  await persistOperation(operation);

  const { summary, definitions } = context;
  const desired = summary.voiceEnabled ? [definitions.engine, definitions.worker] : [definitions.engine];
  const probeEnvironment = context.probeEnvironment;
  let serviceSnapshot: ServiceSnapshot | undefined;
  let rotation: ArtifactRotation | undefined;
  let workerWasRunning = false;
  let engineWasRunning = false;
  let barrierEstablished = false;
  let engineLogOffset = 0;
  let candidateRuntimeValidated = false;
  let noOpHealthyStart = false;
  let noOpReleaseCheck = false;
  let runningWorkerEnvironment: Record<string, string> | undefined;
  let recordedWorkerHealthPort: number | undefined;
  // Legacy-hold (first migration / reapply) route state.
  let legacyPilot: RegisteredPilot | null = null;
  let holdSession: NativeHoldSession | null = null;
  let pilotStopDeferred = false;
  let pilotFences: ActivationFences | null = null;
  const activationStartedAt = Date.now();

  const controller = () => options.controller ?? context.controller;
  const observeWorker = () => observeWorkerIdentity(context);
  // Private installed-worker `worker-maintenance` observer bound to THIS
  // acquired operation (chunk 5 Step 2b). Baseline until this operation's own
  // close acknowledgement; closed afterwards. Never inferred from a response.
  let workerObserver: InstalledWorkerMaintenance | null = null;
  let workerSeal: ReturnType<typeof processSealOf> | null = null;
  let installedStopDeferred = false;
  const installedObserver = (): InstalledWorkerMaintenance => {
    workerObserver ??= new InstalledWorkerMaintenance({
      operation,
      instance: context.pilotInstance,
      workerDefinition: definitions.worker,
      serviceEnvironment: runningWorkerEnvironment ?? probeEnvironment,
      nodePath: operation.record.hostNodePath ?? process.execPath,
      configPath: context.configReal,
      onHealthPort: (port) => {
        recordedWorkerHealthPort = port;
      },
      controller: controller(),
      clock,
    });
    return workerObserver;
  };
  const inspectIdle = async (deadline: number): Promise<IdleEvidence> => {
    const observer = installedObserver();
    // The original 30-second quiescence deadline is recorded once and never extended.
    observer.bindDeadline(deadline);
    return (await observer.observe()).idle;
  };
  const baseMaintenance = maintenanceQuiescenceIO({
    operation,
    instanceHome: home,
    instanceId: summary.instanceId,
    inspect: inspectIdle,
    corroborateSupervisor: async () => observeWorker(),
  });
  const maintenance: QuiescenceIO = {
    ...baseMaintenance,
    async close(operationId, deadline) {
      await baseMaintenance.close(operationId, deadline);
      installedObserver().markClosed();
    },
    async release(operationId, deadline) {
      await baseMaintenance.release(operationId, deadline);
      workerObserver?.clear();
    },
  };
  /** Fresh final installed observation, proof consumed at the actual worker bootout dispatch. */
  const stopInstalledWorker = async () => {
    if (!workerSeal || !operation.record.supervisor) throw new Error("installed worker identity was not captured");
    return stopInstalledWorkerUnderProof({
      observer: installedObserver(),
      operationId: operation.record.id,
      worker: workerSeal,
      bootId: operation.record.supervisor.bootId,
      clock,
      supplementary: () =>
        proveBarrierBeforeStop({
          operation,
          instanceHome: home,
          instanceId: summary.instanceId,
          supervisor: operation.record.supervisor!,
          corroborateSupervisor: async () => observeWorker(),
        }),
      persistSignalsBegun: async () => {
        operation.record.signalsBegun = true;
        await persistOperation(operation);
      },
      controller: controller(),
      workerDefinition: definitions.worker,
      healthListenerPort: () => recordedWorkerHealthPort ?? summary.workerHealthPort,
      release: () => maintenance.release(operation.record.id, Date.now() + 2_000),
    });
  };
  const recordVerifiedDeferredStop = async (reason: string): Promise<never> => {
    // Verified: no signal issued and the same owner released admission.
    installedStopDeferred = true;
    barrierEstablished = false;
    operation.record.signalsBegun = false;
    await persistOperation(operation);
    throw new DeferredMaintenance(`installed worker stop deferred: ${reason}`);
  };

  const verifyCurrentPair = (minimumStartedAt = activationStartedAt) =>
    verifyPackagedPair(context, {
      minimumStartedAt,
      engineLogOffset,
      dependenciesContained: candidateRuntimeValidated,
    });

  const ownedBrokenValidator = async (path: string): Promise<boolean> => {
    // Ownership is established by a retained resolved operation record, never
    // by package contents alone.
    try {
      const prior = JSON.parse(
        await readFile(resolve(operation.paths.operationDirectory, "previous-operation.json"), "utf8"),
      ) as { resolution?: unknown; retainedPaths?: unknown };
      return (
        typeof prior.resolution === "string" && Array.isArray(prior.retainedPaths) && prior.retainedPaths.includes(path)
      );
    } catch {
      return false;
    }
  };

  /** Record supervisor PID/start time and listener before any close, for exit proof on re-entry. */
  const recordSupervisorProcess = async (pid: number, startTime: string, port: number | undefined) => {
    operation.record.supervisorProcess = { pid, startTime };
    if (port !== undefined) operation.record.workerHealthPort = port;
    await persistOperation(operation);
  };

  const pilotActivationFences = (stopped: ActivationFences["stopped"]): ActivationFences => ({
    engineLog: captureLogFence(legacyPilot!.services.services[0].definition.stdout),
    workerLog: captureLogFence(legacyPilot!.services.services[1].definition.stdout),
    wallStartedAt: Date.now(),
    stopped,
  });

  /** Durable before the pilot engine starts, so interrupted recovery can verify the same fences. */
  const recordPilotActivationFences = async (fences: ActivationFences): Promise<ActivationFences> => {
    await writeOperationJson(resolve(operation.paths.operationDirectory, PILOT_ACTIVATION_FILE), fences);
    return fences;
  };

  if (command.mode === "pilot-rollback") {
    await runPilotRollback();
    return;
  }

  const io: TransactionIO = {
    phase: operationPhaseAdapter(operation),
    async preflightAndStage() {
      if (command.legacyHold !== undefined) {
        // Route assessment performs no mutation; any gap is MIGRATION_PENDING
        // before capture, staging, close or signal.
        legacyPilot = await assessLegacyHoldRoute({
          holdSelector: command.legacyHold,
          instance: context.pilotInstance,
          provider: pilotEvidence,
        });
        context = await resolveLifecycleContext(operation, environment, {
          capturedPilotProfile: legacyPilot.capturedPilotProfile,
        });
      }
      if (legacyPilot) {
        const [engine, worker] = await Promise.all(
          legacyPilot.services.services.map((item) => controller().inspect(item.definition.label)),
        );
        if (
          engine.process?.pid !== legacyPilot.generation.engine.pid ||
          engine.process?.startTime !== legacyPilot.generation.engine.startTime ||
          worker.process?.pid !== legacyPilot.generation.worker.pid ||
          worker.process?.startTime !== legacyPilot.generation.worker.startTime
        ) {
          throw new DeferredMaintenance("live pilot generation differs from the registered snapshot lineage");
        }
        engineWasRunning = true;
        workerWasRunning = true;
        serviceSnapshot = legacyPilot.services;
        recordedWorkerHealthPort = legacyPilot.sdkListenerPort;
        operation.record.priorProfile = "pilot";
      } else {
        const [engine, worker] = await Promise.all([
          controller().inspect(definitions.engine.label),
          controller().inspect(definitions.worker.label),
        ]);
        engineWasRunning = engine.livePID !== null;
        workerWasRunning = worker.livePID !== null;
        if (workerWasRunning) {
          if (!worker.serviceEnvironment) throw new Error("running worker service environment is unavailable");
          runningWorkerEnvironment = { ...worker.serviceEnvironment };
        }
        serviceSnapshot = await controller().capture(
          workerWasRunning || summary.voiceEnabled ? [definitions.engine, definitions.worker] : desired,
        );
        operation.record.priorProfile = engineWasRunning ? "packaged" : "stopped";
      }
      await persistOperation(operation);
      await capturePrior({
        operation,
        services: serviceSnapshot,
        configPath: context.configReal,
        workerHealthPort: recordedWorkerHealthPort ?? (workerWasRunning ? summary.workerHealthPort : null),
        pilot: legacyPilot
          ? {
              snapshotPath: legacyPilot.selector,
              snapshotSha256: legacyPilot.sha256,
              bootstrapPath: legacyPilot.bootstrap.selector,
              bootstrapSha256: legacyPilot.bootstrap.sha256,
            }
          : null,
      });
      // Deferred disposal of earlier operations' job trees; a failed removal
      // (for example a straggler still writing) is reported, never fatal.
      const sweep = await sweepLeftoverJobs({ canonicalInstanceHome: home, keepOperationIds: [operation.record.id] });
      operation.record.staging.sweepFailures.push(...sweep.failures);
      await persistOperation(operation);
      const currentPresent = await lstat(resolve(home, ".hive")).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      // A first migration may have no packaged `.hive`; the pilot runs elsewhere.
      if (
        (command.mode === "update" || command.mode === "check" || command.mode === "rollback") &&
        (currentPresent || !legacyPilot)
      ) {
        validatePromotedRelease(resolve(home, ".hive"));
      }
      if (stagingRequired(command.mode)) {
        const currentRelease = currentPresent ? readRelease(resolve(home, ".hive")) : null;
        const nextPath = resolve(home, ".hive.next");
        try {
          await lstat(nextPath);
          throw new Error("existing .hive.next is not owned by this operation");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // Locked beta-plugin compatibility (Task 9 Step 1b): after lock and
        // migration eligibility, before any candidate stage.
        try {
          await applyBetaPluginCompatibility({ operation });
        } catch (error) {
          if (error instanceof PluginCompatibilityUnresolvedError) {
            throw new UnresolvedMaintenance(error.message, { cause: error });
          }
          if (error instanceof PluginCompatibilityPendingError) {
            throw new DeferredMaintenance(error.message, { cause: error });
          }
          throw error;
        }
        // Fail closed before any artifact job: no unconfined fallback exists.
        const selfTest = await runConfinementSelfTest({
          canonicalInstanceHome: home,
          operationId: operation.record.id,
          nodePath: operation.record.hostNodePath!,
        });
        operation.record.staging.selfTest = selfTest;
        await persistOperation(operation);
        const promotionMethod = await selectPromotionMethod({
          sourceParent: resolve(home, ".hive-state", "jobs", operation.record.id),
          destinationParent: home,
        });
        operation.record.staging.promotionMethod = promotionMethod;
        operation.record.retainedPaths.push(nextPath);
        await persistOperation(operation);
        const staging: ArtifactStagingContext = {
          runner: new ConfinedJobRunner({
            canonicalInstanceHome: home,
            operationId: operation.record.id,
            selfTest,
            journal: (record) => recordStagingJob(operation, record),
          }),
          nodePath: operation.record.hostNodePath!,
          npmCliPath: npmPath,
          invokingHome: context.userHome,
          pathEnv: context.pathEnv,
          archiveDirectory: resolve(operation.paths.operationDirectory, "archive"),
          promotionMethod: promotionMethod.method,
        };
        const candidate = await stageVerifiedCandidate({
          selector: { tag: command.tag, artifact: command.artifact },
          context: staging,
          destination: nextPath,
          requireClean: Boolean(command.legacyHold),
          journalPromotion: (record) => recordStagingPromotion(operation, record),
          onResolved: async (artifact, extracted) => {
            // Reapply must stage exactly the retained archive of its migration lineage.
            if (legacyPilot) await pilotEvidence.assertArtifactLineage(legacyPilot, artifact.archiveSha256);
            operation.record.candidateArchiveSha256 = artifact.archiveSha256;
            operation.record.staging.candidateRelease = {
              packageVersion: extracted.release.packageVersion,
              sourceRevision: extracted.release.sourceRevision,
              dependencyLockSha256: extracted.release.dependencyLockSha256,
            };
            operation.record.retainedPaths.push(artifact.archivePath);
            await persistOperation(operation);
          },
        });
        operation.record.staging.cloneVerified = true;
        await persistOperation(operation);
        rotation = new ArtifactRotation(operation, ownedBrokenValidator);
        await rotation.capture();
        await preflightStagedConfig({
          clone: nextPath,
          context: staging,
          serviceEnvironment: probeEnvironment,
          expectedInstanceId: summary.instanceId,
          expectedDatabaseName: summary.databaseName,
          expectedVoiceEnabled: summary.voiceEnabled,
        });
        candidateRuntimeValidated = true;
        noOpReleaseCheck =
          command.mode === "check" &&
          currentRelease !== null &&
          candidate.verification.release.packageVersion === currentRelease.packageVersion &&
          candidate.verification.release.sourceRevision === currentRelease.sourceRevision &&
          candidate.verification.release.dependencyLockSha256 === currentRelease.dependencyLockSha256;
      } else if (command.mode === "rollback") {
        validatePromotedRelease(resolve(home, ".hive.prev"));
        await probeJson(resolve(home, ".hive.prev", "pkg", "runtime-probe.min.js"), "config", probeEnvironment);
        candidateRuntimeValidated = true;
      } else {
        validatePromotedRelease(resolve(home, ".hive"));
        await probeJson(context.currentProbePath, "config", probeEnvironment);
        candidateRuntimeValidated = true;
        if (command.mode === "start" && engineWasRunning && (!summary.voiceEnabled || workerWasRunning)) {
          engineLogOffset = 0;
          await verifyCurrentPair(0);
          noOpHealthyStart = true;
        }
      }
      if (command.mode === "rollback") {
        rotation = new ArtifactRotation(operation, ownedBrokenValidator);
        await rotation.capture();
        if (rotation.captured.next) {
          rotation = undefined;
          throw new Error("ordinary rollback refuses an existing .hive.next");
        }
      }
      if (command.mode === "update" || command.mode === "check" || command.mode === "rollback") {
        await rotation!.reserveBroken();
      }
    },
    async establishQuiescence() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (!workerWasRunning) return;
      if (legacyPilot) {
        // A NEW close under this operation; an earlier record never holds.
        holdSession = await pilotEvidence.establishHold(legacyPilot, operation, async ({ seal, bootId }) => {
          operation.record.phase = "barrier-requested";
          operation.record.supervisor = { pid: seal.pid, bootId };
          operation.record.barrierOperationId = operation.record.id;
          await recordSupervisorProcess(seal.pid, seal.startTime, legacyPilot!.sdkListenerPort);
        });
        barrierEstablished = true;
        return;
      }
      const worker = await controller().inspect(definitions.worker.label);
      if (worker.process) {
        workerSeal = processSealOf(worker);
        await recordSupervisorProcess(
          worker.process.pid,
          worker.process.startTime,
          recordedWorkerHealthPort ?? summary.workerHealthPort,
        );
      }
      await installedObserver().prepare();
      await quiesce(maintenance, operation.record.id);
      barrierEstablished = true;
    },
    async releaseAdmission() {
      if (!barrierEstablished) return;
      if (holdSession) await holdSession.release();
      else await maintenance.release(operation.record.id, Date.now() + 2_000);
    },
    async markSignalsBegun() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (holdSession) return; // Persisted by the proof-fenced stop itself, immediately before dispatch.
      // A barrier stop persists signalsBegun inside the proof fence, after the final fresh read.
      if (barrierEstablished && operation.record.supervisor && workerWasRunning) return;
      operation.record.signalsBegun = true;
      await persistOperation(operation);
    },
    async stopWorkerAndChildren() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (legacyPilot && holdSession) {
        const workerDefinition = legacyPilot.services.services[1].definition;
        const outcome = await stopPilotWorkerUnderHold({
          session: holdSession,
          operationId: operation.record.id,
          clock,
          randomId: randomUUID,
          persistSignalsBegun: async () => {
            operation.record.signalsBegun = true;
            await persistOperation(operation);
          },
          controller: controller(),
          workerDefinition,
          healthListenerPort: legacyPilot.sdkListenerPort,
        });
        if (outcome.kind === "deferred") {
          // Verified: no signal issued and the same owner released admission.
          pilotStopDeferred = true;
          barrierEstablished = false;
          operation.record.signalsBegun = false;
          await persistOperation(operation);
          throw new DeferredMaintenance(`legacy hold stop deferred: ${outcome.reason}`);
        }
        return;
      }
      if (barrierEstablished && operation.record.supervisor && workerWasRunning) {
        const outcome = await stopInstalledWorker();
        if (outcome.kind === "deferred") await recordVerifiedDeferredStop(outcome.reason);
        return;
      }
      if (workerWasRunning) {
        await controller().bootout(definitions.worker, {
          markIrreversible: async () => {},
          healthListenerPort: recordedWorkerHealthPort ?? summary.workerHealthPort,
        });
      }
    },
    async stopEngine() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (legacyPilot) {
        await controller().bootout(legacyPilot.services.services[0].definition, { markIrreversible: async () => {} });
        return;
      }
      if (engineWasRunning) await controller().bootout(definitions.engine, { markIrreversible: async () => {} });
    },
    async rotate() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode === "update" || command.mode === "check") {
        if (rotation!.captured.current) await rotation!.rotateUpdate();
        else if (legacyPilot) await rotation!.rotateFirstMigration();
        else throw new Error("update requires a current release");
      }
      if (command.mode === "rollback") await rotation!.rotateRollback();
    },
    async installCandidateDefinitions() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode === "stop") {
        await controller().removeServiceLink(definitions.worker);
        await controller().removeServiceLink(definitions.engine);
        return;
      }
      await controller().write(desired);
      if (!summary.voiceEnabled) await controller().removeWorkerLink(definitions.worker);
    },
    async startEngineAndVerifyBoot() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode === "stop") return;
      engineLogOffset = await fileSize(definitions.engine.stdout);
      await controller().bootstrap(definitions.engine);
    },
    async startWorker() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode !== "stop" && summary.voiceEnabled) await controller().bootstrap(definitions.worker);
    },
    async verifyCandidatePair() {
      if (noOpHealthyStart || noOpReleaseCheck) {
        await verifyCurrentPair(0);
        return;
      }
      if (command.mode === "stop") {
        const [engine, worker] = await Promise.all([
          controller().inspect(definitions.engine.label),
          controller().inspect(definitions.worker.label),
        ]);
        if (engine.loaded || worker.loaded) throw new Error("service pair did not stop completely");
        return;
      }
      await verifyCurrentPair();
    },
    async finalizeHealthy() {
      operation.record.resolution = "healthy";
      await persistOperation(operation);
      if (command.mode === "rollback") {
        await rotation!.finalizeRollbackSuccess();
        await rotation!.disposeSupersededBroken();
      }
      if (command.mode === "update" || command.mode === "check") {
        if (noOpReleaseCheck) {
          await rotation!.abortBeforeSignals();
          rotation = undefined;
        } else await rotation!.finalizeUpdateSuccess();
      }
    },
    async recoverPriorPair() {
      if (pilotStopDeferred && legacyPilot) {
        // No signal was issued: verify the pilot pair is the same live generation.
        for (const item of legacyPilot.services.services) {
          const live = await controller().inspect(item.definition.label);
          if (
            live.process?.pid !== item.inspection.process?.pid ||
            live.process?.startTime !== item.inspection.process?.startTime
          ) {
            throw new Error("pilot generation changed although no stop signal was issued");
          }
        }
        operation.record.resolution = "deferred";
        await persistOperation(operation);
        await finishDeferredPrePromotion();
        return;
      }
      if (installedStopDeferred) {
        await verifyUnsignaledPair();
        operation.record.resolution = "deferred";
        await persistOperation(operation);
        await finishDeferredPrePromotion();
        return;
      }
      const worker = await controller().inspect(definitions.worker.label);
      if (worker.loaded) {
        await controller().bootout(definitions.worker, {
          markIrreversible: async () => {},
          healthListenerPort:
            legacyPilot &&
            JSON.stringify(worker.args) === JSON.stringify(legacyPilot.services.services[1].inspection.args)
              ? legacyPilot.sdkListenerPort
              : (recordedWorkerHealthPort ?? summary.workerHealthPort),
        });
      }
      const engine = await controller().inspect(definitions.engine.label);
      if (engine.loaded) await controller().bootout(definitions.engine, { markIrreversible: async () => {} });
      if (command.mode === "update" || command.mode === "check") {
        if (rotation!.captured.current) await rotation!.recoverUpdate();
        else if (legacyPilot) await rotation!.recoverFirstMigration();
      }
      if (command.mode === "rollback") await rotation!.recoverRollback();
      if (!serviceSnapshot) throw new Error("prior service snapshot missing");
      if (legacyPilot) {
        await pilotEvidence.verifyRecoveryPrerequisites(legacyPilot);
        pilotFences = await recordPilotActivationFences(
          pilotActivationFences({
            engine: legacyPilot.generation.engine,
            worker: legacyPilot.generation.worker,
          }),
        );
        await controller().restoreFilesAndState(serviceSnapshot);
        await controller().restoreService(serviceSnapshot, legacyPilot.services.services[0].definition.label, {
          requireNewGeneration: true,
        });
        await controller().restoreService(serviceSnapshot, legacyPilot.services.services[1].definition.label, {
          requireNewGeneration: true,
        });
        const observations = await pilotEvidence.observePilotRecovery(legacyPilot, pilotFences);
        if (!pilotRecovered(assemblePilotRecoveryEvidence(observations))) {
          throw new Error("pilot recovery profile verification failed");
        }
        operation.record.resolution = "recovered";
        await persistOperation(operation);
      } else {
        engineLogOffset = await fileSize(definitions.engine.stdout);
        await restorePrior(
          controller(),
          { services: serviceSnapshot },
          {
            verifyEngine: async (restoredEngine) => {
              if (engineWasRunning && (!restoredEngine || restoredEngine.livePID === null)) {
                throw new Error("prior engine did not restart before the worker");
              }
            },
          },
        );
        operation.record.resolution = "recovered";
        await persistOperation(operation);
        if (engineWasRunning) {
          await verifyCurrentPair();
        }
      }
      if (command.mode === "update" || command.mode === "check") await rotation!.disposeSupersededBroken();
    },
    async finishResolved() {
      if (!operation.record.resolution) operation.record.resolution = "deferred";
      if (!operation.record.phase || operation.record.phase === "unresolved") return;
      await persistOperation(operation);
      if (!operation.record.signalsBegun) await finishDeferredPrePromotion();
    },
    retainUnresolved,
  };

  /** After a verified deferred stop no signal was issued: the captured generation must still run. */
  async function verifyUnsignaledPair(): Promise<void> {
    if (!serviceSnapshot) throw new Error("prior service snapshot missing");
    for (const item of serviceSnapshot.services) {
      if (!item.inspection.process) continue;
      const live = await controller().inspect(item.definition.label);
      if (
        live.process?.pid !== item.inspection.process.pid ||
        live.process?.startTime !== item.inspection.process.startTime
      ) {
        throw new Error("service generation changed although no stop signal was issued");
      }
    }
  }

  async function finishDeferredPrePromotion(): Promise<void> {
    if (rotation) {
      await rotation.abortBeforeSignals();
      rotation = undefined;
    } else if (command.mode === "update" || command.mode === "check") {
      const next = resolve(home, ".hive.next");
      if (operation.record.retainedPaths.includes(next)) {
        try {
          await disposeOwnedDirectory(operation, next, await directoryIdentity(next));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }

  async function retainUnresolved(error: unknown): Promise<void> {
    operation.record.phase = "unresolved";
    operation.record.retainedPaths = [
      ...new Set([
        ...operation.record.retainedPaths,
        operation.paths.operationDirectory,
        ...[".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) => resolve(home, name)),
      ]),
    ];
    await persistOperation(operation).catch(() => {});
    await writeOperationJson(resolve(operation.paths.operationDirectory, "failure.json"), {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DeferredMaintenance && "code" in error ? { code: (error as { code: string }).code } : {}),
    }).catch(() => {});
  }

  async function runPilotRollback(): Promise<void> {
    let pilotIO: TransactionIO | null = null;
    const phase = operationPhaseAdapter(operation);
    const finish = async (resolution: "healthy" | "recovered" | "deferred") => {
      if (!operation.record.resolution) operation.record.resolution = resolution;
      if (operation.record.phase === "unresolved") return;
      await persistOperation(operation);
    };
    const delegate: TransactionIO = {
      phase,
      async preflightAndStage() {
        const currentPath = resolve(home, ".hive");
        let identity: { device: number; inode: number } | null = null;
        let release: Release | null = null;
        try {
          identity = await directoryIdentity(currentPath);
          release = validatePromotedRelease(currentPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const { pilot } = await assessPilotRecoveryRoute({
          snapshotSelector: command.pilotRecovery!,
          instance: context.pilotInstance,
          provider: pilotEvidence,
          currentCandidate: { identity, release },
        });
        legacyPilot = pilot;
        context = await resolveLifecycleContext(operation, environment, {
          capturedPilotProfile: pilot.capturedPilotProfile,
        });
        const [engine, worker] = await Promise.all([
          controller().inspect(definitions.engine.label),
          controller().inspect(definitions.worker.label),
        ]);
        if (engine.livePID === null || worker.livePID === null) {
          throw new DeferredMaintenance("pilot recovery requires the running packaged candidate pair");
        }
        runningWorkerEnvironment = worker.serviceEnvironment ? { ...worker.serviceEnvironment } : undefined;
        serviceSnapshot = await controller().capture([definitions.engine, definitions.worker]);
        operation.record.priorProfile = "packaged";
        await persistOperation(operation);
        await capturePrior({
          operation,
          services: serviceSnapshot,
          configPath: context.configReal,
          workerHealthPort: summary.workerHealthPort,
          pilot: {
            snapshotPath: pilot.selector,
            snapshotSha256: pilot.sha256,
            bootstrapPath: pilot.bootstrap.selector,
            bootstrapSha256: pilot.bootstrap.sha256,
          },
        });
        candidateRuntimeValidated = true;
        const candidateServices = serviceSnapshot;
        pilotIO = pilotRollbackTransaction({
          controller: controller(),
          provider: pilotEvidence,
          pilot,
          candidate: candidateServices,
          candidateDefinitions: definitions,
          candidateWorkerHealthPort: recordedWorkerHealthPort ?? summary.workerHealthPort,
          phase,
          async quiesceCandidate() {
            if (worker.process) {
              workerSeal = processSealOf(worker);
              await recordSupervisorProcess(worker.process.pid, worker.process.startTime, summary.workerHealthPort);
            }
            await installedObserver().prepare();
            await quiesce(maintenance, operation.record.id);
            barrierEstablished = true;
            return true;
          },
          releaseCandidate: () => maintenance.release(operation.record.id, Date.now() + 2_000),
          async markSignalsBegun() {
            // The candidate stop persists signalsBegun inside its proof fence.
            if (operation.record.supervisor) return;
            operation.record.signalsBegun = true;
            await persistOperation(operation);
          },
          async stopCandidateWorker() {
            const outcome = await stopInstalledWorker();
            if (outcome.kind === "deferred") {
              barrierEstablished = false;
              operation.record.signalsBegun = false;
              await persistOperation(operation);
            }
            return outcome;
          },
          verifyCandidateUnsignaled: () => verifyUnsignaledPair(),
          async verifyCandidatePacked() {
            engineLogOffset = 0;
            await verifyCurrentPair();
          },
          captureFences: () =>
            recordPilotActivationFences(
              pilotActivationFences({
                engine: engine.process ? { pid: engine.process.pid, startTime: engine.process.startTime } : null,
                worker: worker.process ? { pid: worker.process.pid, startTime: worker.process.startTime } : null,
              }),
            ),
          recordPilotGeneration: (generation) =>
            writeOperationJson(resolve(operation.paths.operationDirectory, PILOT_GENERATION_FILE), generation),
          finishResolved: finish,
          retainUnresolved,
        });
      },
      establishQuiescence: () => pilotIO!.establishQuiescence(),
      releaseAdmission: async () => pilotIO?.releaseAdmission(),
      markSignalsBegun: () => pilotIO!.markSignalsBegun(),
      stopWorkerAndChildren: () => pilotIO!.stopWorkerAndChildren(),
      stopEngine: () => pilotIO!.stopEngine(),
      rotate: () => pilotIO!.rotate(),
      installCandidateDefinitions: () => pilotIO!.installCandidateDefinitions(),
      startEngineAndVerifyBoot: () => pilotIO!.startEngineAndVerifyBoot(),
      startWorker: () => pilotIO!.startWorker(),
      verifyCandidatePair: () => pilotIO!.verifyCandidatePair(),
      finalizeHealthy: async () => {
        await pilotIO!.finalizeHealthy();
        operation.record.resolution = "healthy";
        await persistOperation(operation);
      },
      recoverPriorPair: async () => {
        await pilotIO!.recoverPriorPair();
        operation.record.resolution = operation.record.signalsBegun ? "recovered" : "deferred";
        await persistOperation(operation);
      },
      finishResolved: async () => (pilotIO ? pilotIO.finishResolved() : finish("deferred")),
      retainUnresolved,
    };
    await activate(delegate);
  }

  try {
    await activate(io);
  } finally {
    // Deferred disposal after the operation has its result; stragglers may keep
    // writing into these trees, which are never promoted. Failures are reported.
    const disposal = await disposeOperationJobs({ canonicalInstanceHome: home, operationId: operation.record.id });
    if (disposal.failures.length > 0) {
      operation.record.staging.sweepFailures.push(...disposal.failures);
      await persistOperation(operation).catch(() => {});
      process.stderr.write(
        `Job directory disposal incomplete (non-fatal): ${disposal.failures.map((failure) => failure.path).join(", ")}\n`,
      );
    }
  }
}
