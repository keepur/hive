import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildServiceEnvironment,
  buildServiceDefinitions,
  ServiceController,
  type ServiceSnapshot,
} from "./services.js";
import { extractAndValidateArtifact, installAndPreflightStage, resolveArtifact } from "./artifact.js";
import {
  parseBootIdentity,
  packagedHealthy,
  freshAdmissionStatus,
  freshOrderedEngineMarkers,
  readEngineMarkersAfter,
} from "./health.js";
import { readRelease, type BootIdentity } from "./release.js";
import {
  directoryIdentity,
  disposeOwnedDirectory,
  persistOperation,
  writeOperationJson,
  type AcquiredOperation,
} from "./operation.js";
import {
  activate,
  ArtifactRotation,
  maintenanceQuiescenceIO,
  operationPhaseAdapter,
  proveBarrierBeforeStop,
  quiesce,
  type IdleEvidence,
  type TransactionIO,
} from "./transaction.js";

const execFile = promisify(nodeExecFile);

export interface LifecycleCommand {
  mode: "update" | "check" | "rollback" | "start" | "stop" | "restart" | "pilot-rollback";
  tag?: string;
  artifact?: string;
  pilotRecovery?: string;
  legacyHold?: string;
}

interface ConfigSummary {
  instanceId: string;
  voiceEnabled: boolean;
  databaseName?: string;
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
}

function configSummary(value: unknown): ConfigSummary {
  if (!value || typeof value !== "object") throw new Error("invalid Hive configuration");
  const config = value as {
    instance?: { id?: unknown };
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

/**
 * Concrete source lifecycle. The S9 integration harness exercises this through
 * the frozen S8 bundle; every boundary here is independently injectable in S7
 * transaction tests.
 */
export async function runNodeLifecycle(
  operation: AcquiredOperation,
  command: LifecycleCommand,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const home = operation.record.canonicalHome;
  const selectedConfig = environment.HIVE_CONFIG ?? "hive.yaml";
  const configPath = resolve(home, selectedConfig);
  const configReal = await realpath(configPath);
  const summary = configSummary(parseYaml(await readFile(configReal, "utf8")));
  if (summary.instanceId !== operation.record.instanceId) throw new Error("selected config instance changed");
  const userHome = environment.HOME;
  const pathEnv = environment.PATH;
  if (!userHome || !resolve(userHome).startsWith("/") || !pathEnv)
    throw new Error("explicit HOME and PATH are required");
  const npmLookup = await execFile("which", ["npm"], {
    env: { PATH: pathEnv },
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  const npmPath = await realpath(npmLookup.stdout.trim());
  const npmInfo = await lstat(npmPath);
  if (!npmInfo.isFile() || npmInfo.isSymbolicLink()) throw new Error("host npm prerequisite is not a regular file");
  operation.record.hostNodePath = await realpath(process.execPath);
  operation.record.hostNpmPath = npmPath;
  await persistOperation(operation);
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
  });
  const desired = summary.voiceEnabled ? [definitions.engine, definitions.worker] : [definitions.engine];
  const probeEnvironment = buildServiceEnvironment(definitions.worker);
  const currentProbePath = resolve(home, ".hive", "pkg", "runtime-probe.min.js");
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
  const activationStartedAt = Date.now();

  const observeWorker = async (): Promise<{ pid: number; bootId: string }> => {
    const inspection = await controller.inspect(definitions.worker.label);
    if (!inspection.process || inspection.livePID === null) throw new Error("voice worker is not running");
    const identity = parseBootIdentity(
      JSON.parse(await readFile(resolve(home, ".hive-state", "runtime", "voice-worker.json"), "utf8")),
    );
    if (identity.pid !== inspection.livePID || identity.component !== "voice-worker") {
      throw new Error("voice worker identity does not match launchd");
    }
    return { pid: identity.pid, bootId: identity.bootId };
  };
  const inspectIdle = async (_deadline: number): Promise<IdleEvidence> => {
    const result = parseWorkerProbe(
      await probeJson(currentProbePath, "worker", runningWorkerEnvironment ?? probeEnvironment),
    );
    const observed = await observeWorker();
    if (observed.pid !== result.supervisor.pid || observed.bootId !== result.supervisor.bootId) {
      throw new Error("worker probe and process identity disagree");
    }
    return {
      supervisor: result.supervisor,
      registered: result.classification === "worker-registered" && result.sdk.rootStatus === 200,
      ownedSocket: result.socketOwned,
      sdkActiveJobs: result.sdk.activeJobs,
      telemetryActiveCalls: result.heartbeat.activeCalls,
    };
  };
  const maintenance = maintenanceQuiescenceIO({
    operation,
    instanceHome: home,
    instanceId: summary.instanceId,
    inspect: inspectIdle,
    corroborateSupervisor: async () => observeWorker(),
  });

  async function validateOfflineRuntime(root: string): Promise<void> {
    await execFile(process.execPath, [resolve(root, "pkg", "voice-worker-diagnostic.min.js"), "offline"], {
      cwd: root,
      env: { HOME: resolve(userHome!), PATH: pathEnv! },
      timeout: 120_000,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  }

  async function artifactSlot(path: string): Promise<Record<string, unknown>> {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`artifact slot is not a real directory: ${path}`);
      if (process.getuid?.() !== info.uid) throw new Error(`artifact slot has a foreign owner: ${path}`);
      return {
        present: true,
        path,
        canonicalPath: await realpath(path),
        device: info.dev,
        inode: info.ino,
        mode: info.mode & 0o777,
        uid: info.uid,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, path };
      throw error;
    }
  }

  async function verifyCurrentPair(minimumStartedAt = activationStartedAt): Promise<void> {
    const installed = readRelease(resolve(home, ".hive"));
    const engine = parseBootIdentity(
      JSON.parse(await readFile(resolve(home, ".hive-state", "runtime", "engine.json"), "utf8")),
    );
    const engineInspection = await controller.inspect(definitions.engine.label);
    const markerRead = readEngineMarkersAfter(definitions.engine.stdout, engineLogOffset);
    let worker: BootIdentity | null = null;
    let workerResult: WorkerProbe | null = null;
    let bridge: Record<string, unknown> = {};
    if (summary.voiceEnabled) {
      workerResult = parseWorkerProbe(await probeJson(currentProbePath, "worker", probeEnvironment));
      worker = workerResult.heartbeat.identity;
      bridge = await probeJson(currentProbePath, "bridge", probeEnvironment);
    }
    const evidence = {
      installed,
      engine,
      worker,
      voiceEnabled: summary.voiceEnabled,
      processPathsMatch:
        engineInspection.process?.command === [definitions.engine.nodePath, definitions.engine.entrypoint].join(" "),
      configSelectorsMatch: engineInspection.configSelection === configReal,
      freshOrderedEngineMarkers: freshOrderedEngineMarkers(
        markerRead.records,
        engine,
        minimumStartedAt,
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
      dependenciesContained: candidateRuntimeValidated,
    };
    if (!packagedHealthy(evidence)) throw new Error("paired release health verification failed");
  }

  const io: TransactionIO = {
    phase: operationPhaseAdapter(operation),
    async preflightAndStage() {
      // The approved plan intentionally leaves the inventory-specific pilot
      // snapshot and dispatch-hold record shapes to the later adoption work.
      // Until those records have a concrete parser and current read-back
      // adapter, accepting their mere presence would turn evidence into an
      // authorization bypass. Keep both one-time routes deferred before any
      // service inspection, admission change, or artifact mutation.
      if (command.mode === "pilot-rollback") {
        throw new Error("pilot recovery evidence has no validated inventory adapter; lifecycle deferred");
      }
      if (command.legacyHold !== undefined) {
        throw new Error("legacy dispatch hold has no validated read-back adapter; lifecycle deferred");
      }
      const [engine, worker] = await Promise.all([
        controller.inspect(definitions.engine.label),
        controller.inspect(definitions.worker.label),
      ]);
      engineWasRunning = engine.livePID !== null;
      workerWasRunning = worker.livePID !== null;
      if (workerWasRunning) {
        if (!worker.serviceEnvironment) throw new Error("running worker service environment is unavailable");
        runningWorkerEnvironment = { ...worker.serviceEnvironment };
      }
      serviceSnapshot = await controller.capture(
        workerWasRunning || summary.voiceEnabled ? [definitions.engine, definitions.worker] : desired,
      );
      await writeOperationJson(operation.paths.priorSnapshot, {
        schemaVersion: 1,
        toolSha256: operation.record.toolSha256,
        artifactSlots: await Promise.all(
          [".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) => artifactSlot(resolve(home, name))),
        ),
        reservedSlots: await Promise.all(
          ["prior-prev", "prior-broken", "rollback-current", "failed-prev"].map((name) =>
            artifactSlot(resolve(operation.paths.operationDirectory, name)),
          ),
        ),
        services: serviceSnapshot.services.map((item) => ({
          label: item.definition.label,
          loaded: item.loaded,
          enabled: item.enabled,
          livePID: item.inspection.livePID,
          startTime: item.inspection.startTime,
          arguments: item.inspection.args,
          workingDirectory: item.inspection.cwd,
          configSelection: item.inspection.configSelection,
          serviceEnvironment: item.inspection.serviceEnvironment,
          plistIdentity: item.inspection.plist,
          linkIdentity: item.inspection.link,
          originalPlistRecord: item.plist.existed
            ? resolve(operation.paths.operationDirectory, `${item.definition.label}.plist.original`)
            : null,
        })),
      });
      operation.record.priorProfile = engineWasRunning ? "packaged" : "stopped";
      await persistOperation(operation);
      if (command.mode === "update" || command.mode === "check" || command.mode === "rollback") {
        readRelease(resolve(home, ".hive"));
        await validateOfflineRuntime(resolve(home, ".hive"));
      }
      if (command.mode === "update" || command.mode === "check") {
        const currentRelease = readRelease(resolve(home, ".hive"));
        const downloads = resolve(operation.paths.operationDirectory, "downloads");
        const artifact = await resolveArtifact({ tag: command.tag, artifact: command.artifact }, downloads);
        operation.record.candidateArchiveSha256 = artifact.archiveSha256;
        operation.record.retainedPaths.push(artifact.archivePath);
        await persistOperation(operation);
        const nextPath = resolve(home, ".hive.next");
        try {
          await lstat(nextPath);
          throw new Error("existing .hive.next is not owned by this operation");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        operation.record.retainedPaths.push(nextPath);
        await persistOperation(operation);
        const candidate = await extractAndValidateArtifact(artifact, nextPath, Boolean(command.legacyHold));
        rotation = new ArtifactRotation(operation, async (path) => {
          try {
            const prior = JSON.parse(
              await readFile(resolve(operation.paths.operationDirectory, "previous-operation.json"), "utf8"),
            ) as { resolution?: unknown; retainedPaths?: unknown };
            return (
              typeof prior.resolution === "string" &&
              Array.isArray(prior.retainedPaths) &&
              prior.retainedPaths.includes(path)
            );
          } catch {
            return false;
          }
        });
        await rotation.capture();
        await installAndPreflightStage({
          packageRoot: resolve(home, ".hive.next"),
          npmPath,
          serviceEnvironment: probeEnvironment,
          expectedInstanceId: summary.instanceId,
          expectedDatabaseName: summary.databaseName,
          expectedVoiceEnabled: summary.voiceEnabled,
        });
        candidateRuntimeValidated = true;
        noOpReleaseCheck =
          command.mode === "check" &&
          candidate.release.packageVersion === currentRelease.packageVersion &&
          candidate.release.sourceRevision === currentRelease.sourceRevision &&
          candidate.release.dependencyLockSha256 === currentRelease.dependencyLockSha256;
      } else if (command.mode === "rollback") {
        readRelease(resolve(home, ".hive.prev"));
        await validateOfflineRuntime(resolve(home, ".hive.prev"));
        await probeJson(resolve(home, ".hive.prev", "pkg", "runtime-probe.min.js"), "config", probeEnvironment);
        candidateRuntimeValidated = true;
      } else {
        readRelease(resolve(home, ".hive"));
        await validateOfflineRuntime(resolve(home, ".hive"));
        await probeJson(currentProbePath, "config", probeEnvironment);
        candidateRuntimeValidated = true;
        if (command.mode === "start" && engineWasRunning && (!summary.voiceEnabled || workerWasRunning)) {
          engineLogOffset = 0;
          await verifyCurrentPair(0);
          noOpHealthyStart = true;
        }
      }
      if (command.mode === "rollback") {
        rotation = new ArtifactRotation(operation, async (path) => {
          // Ownership is established by a retained resolved operation record,
          // never by package contents alone.
          try {
            const prior = JSON.parse(
              await readFile(resolve(operation.paths.operationDirectory, "previous-operation.json"), "utf8"),
            ) as {
              resolution?: unknown;
              retainedPaths?: unknown;
            };
            return (
              typeof prior.resolution === "string" &&
              Array.isArray(prior.retainedPaths) &&
              prior.retainedPaths.includes(path)
            );
          } catch {
            return false;
          }
        });
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
      await quiesce(maintenance, operation.record.id);
      barrierEstablished = true;
    },
    async releaseAdmission() {
      if (barrierEstablished) await maintenance.release(operation.record.id, Date.now() + 2_000);
    },
    async markSignalsBegun() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (barrierEstablished && operation.record.supervisor) {
        await proveBarrierBeforeStop({
          operation,
          instanceHome: home,
          instanceId: summary.instanceId,
          supervisor: operation.record.supervisor,
          corroborateSupervisor: async () => observeWorker(),
        });
      }
      operation.record.signalsBegun = true;
      await persistOperation(operation);
    },
    async stopWorkerAndChildren() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (workerWasRunning) await controller.bootout(definitions.worker, { markIrreversible: async () => {} });
    },
    async stopEngine() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (engineWasRunning) await controller.bootout(definitions.engine, { markIrreversible: async () => {} });
    },
    async rotate() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode === "update" || command.mode === "check") await rotation!.rotateUpdate();
      if (command.mode === "rollback") await rotation!.rotateRollback();
    },
    async installCandidateDefinitions() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode === "stop") {
        await controller.removeServiceLink(definitions.worker);
        await controller.removeServiceLink(definitions.engine);
        return;
      }
      await controller.write(desired);
      if (!summary.voiceEnabled) await controller.removeWorkerLink(definitions.worker);
    },
    async startEngineAndVerifyBoot() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode === "stop") return;
      engineLogOffset = await fileSize(definitions.engine.stdout);
      await controller.bootstrap(definitions.engine);
    },
    async startWorker() {
      if (noOpHealthyStart || noOpReleaseCheck) return;
      if (command.mode !== "stop" && summary.voiceEnabled) await controller.bootstrap(definitions.worker);
    },
    async verifyCandidatePair() {
      if (noOpHealthyStart || noOpReleaseCheck) {
        await verifyCurrentPair(0);
        return;
      }
      if (command.mode === "stop") {
        const [engine, worker] = await Promise.all([
          controller.inspect(definitions.engine.label),
          controller.inspect(definitions.worker.label),
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
      const worker = await controller.inspect(definitions.worker.label);
      if (worker.loaded) await controller.bootout(definitions.worker, { markIrreversible: async () => {} });
      const engine = await controller.inspect(definitions.engine.label);
      if (engine.loaded) await controller.bootout(definitions.engine, { markIrreversible: async () => {} });
      if (command.mode === "update" || command.mode === "check") await rotation!.recoverUpdate();
      if (command.mode === "rollback") await rotation!.recoverRollback();
      if (!serviceSnapshot) throw new Error("prior service snapshot missing");
      await controller.restore(serviceSnapshot);
      operation.record.resolution = "recovered";
      await persistOperation(operation);
      if (engineWasRunning) {
        engineLogOffset = 0;
        await verifyCurrentPair();
      }
      if (command.mode === "update" || command.mode === "check") await rotation!.disposeSupersededBroken();
    },
    async finishResolved() {
      if (!operation.record.resolution) operation.record.resolution = "deferred";
      if (!operation.record.phase || operation.record.phase === "unresolved") return;
      await persistOperation(operation);
      if (!operation.record.signalsBegun && rotation) await rotation.abortBeforeSignals();
      else if (!operation.record.signalsBegun && (command.mode === "update" || command.mode === "check")) {
        const next = resolve(home, ".hive.next");
        if (operation.record.retainedPaths.includes(next)) {
          try {
            await disposeOwnedDirectory(operation, next, await directoryIdentity(next));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    },
    async retainUnresolved(error) {
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
      }).catch(() => {});
    },
  };

  await activate(io);
}
