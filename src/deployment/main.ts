import { execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { sha256 } from "./release.js";
import {
  acquireOperation,
  decodeOperationRecord,
  finishOperationLock,
  OPERATION_SCHEMA_VERSION,
  OperationUnresolvedError,
  writeOperationJson,
  operationPaths,
  persistOperation,
  transferOwnershipToFrozen,
  workKindForMode,
  type AcquiredOperation,
  type LifecycleMode,
  type NonLifecycleMode,
  type OperationRecord,
} from "./operation.js";
import { isRegistrySelector } from "./pilot-records.js";
import { disposeOperationJobs } from "./clone-promotion.js";
import {
  abortBootstrap,
  BootstrapUnresolvedError,
  initialBootstrapWork,
  reconcileBootstrap,
  runBootstrap,
  runHostPreparationJanitor,
  type BootstrapDeps,
} from "./bootstrap.js";
import {
  resolveLifecycleContext,
  runNodeLifecycle,
  stagingRequired,
  validatePromotedRelease,
  verifyPackagedPair,
  type LifecycleCommand,
} from "./lifecycle.js";
import { SANDBOX_EXEC } from "./confined-job.js";
import { PilotCaptureBlockedError, runCapturePilot } from "./pilot-capture.js";
import {
  abortRegistryCommand,
  captureTicketValidator,
  initialRegistryWork,
  pilotProfileVerifier,
  reconcileRegistryWork,
  registryPilotEvidence,
  runInventoryPilot,
  runPrepareLegacyHold,
  runReleaseLegacyHold,
  runVerifyLegacyHold,
  type RegistryCommandDeps,
  type RegistryCommandResult,
  type RegistryWork,
} from "./pilot.js";
import {
  inspectOrReconcile,
  processIsLive,
  nodeReconcileHostIO,
  PREVIOUS_OPERATION_RECONCILED,
  runReconcileOperation,
  settleRecordedBarrier,
  type LifecycleReconcileDeps,
} from "./reconcile.js";
import { MigrationPendingError, PilotEvidenceUnavailableError } from "./pilot-lifecycle.js";
import { RegistryUnresolvedError } from "./pilot-records.js";
import { ServiceController } from "./services.js";
import { DeferredMaintenance } from "./transaction.js";
import { planBetaPluginCompatibility } from "./plugin-compat.js";
import { resolveHostNpmCli } from "./host-npm.js";

export interface DeploymentArguments extends Omit<LifecycleCommand, "mode"> {
  mode: LifecycleMode | NonLifecycleMode;
  dryRun: boolean;
  /** Internal runbook modes (chunk 4 Task 9 Step 4b.1); never normal rollback fallback. */
  sha256?: string;
  revision?: string;
  bootstrapRecord?: string;
  pilotSdkPort?: number;
  inventoryPilot?: string;
  prepareLegacyHold?: string;
  verifyLegacyHold?: string;
  releaseLegacyHold?: string;
  instance?: string;
  operationRecord?: string;
  /** Internal: original frozen helper reconciling an interrupted operation. */
  reconcileOperation?: string;
  reconcileClaim?: string;
}

/** Nonzero exit with a machine-readable result already printed. */
export class DeploymentExit extends Error {
  constructor(
    readonly exitCode: number,
    readonly result: Record<string, unknown>,
  ) {
    super(String(result.status ?? "deployment exit"));
  }
}

function value(arg: string, name: string): string | undefined {
  return arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined;
}

export function parseDeploymentArguments(argv: readonly string[]): DeploymentArguments {
  const mode: DeploymentArguments["mode"] = "update";
  const result: DeploymentArguments = { mode, dryRun: false };
  const explicitModes = new Set<DeploymentArguments["mode"]>();
  const seen = new Set<string>();
  for (const arg of argv) {
    const name = arg.replace(/=.*$/, "");
    if (seen.has(name)) throw new Error(`duplicate deployment argument: ${name}`);
    seen.add(name);
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--bootstrap") explicitModes.add((result.mode = "bootstrap"));
    else if (arg === "--capture-pilot") explicitModes.add((result.mode = "capture-pilot"));
    else if (value(arg, "sha256") !== undefined) result.sha256 = value(arg, "sha256");
    else if (value(arg, "revision") !== undefined) result.revision = value(arg, "revision");
    else if (value(arg, "bootstrap-record") !== undefined) result.bootstrapRecord = value(arg, "bootstrap-record");
    else if (value(arg, "pilot-sdk-port") !== undefined) {
      const port = value(arg, "pilot-sdk-port")!;
      if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error("--pilot-sdk-port must be a port");
      result.pilotSdkPort = Number(port);
    } else if (value(arg, "inventory-pilot") !== undefined) {
      result.inventoryPilot = value(arg, "inventory-pilot");
      explicitModes.add((result.mode = "inventory-pilot"));
    } else if (value(arg, "prepare-legacy-hold") !== undefined) {
      result.prepareLegacyHold = value(arg, "prepare-legacy-hold");
      explicitModes.add((result.mode = "prepare-legacy-hold"));
    } else if (value(arg, "verify-legacy-hold") !== undefined) {
      result.verifyLegacyHold = value(arg, "verify-legacy-hold");
      explicitModes.add((result.mode = "verify-legacy-hold"));
    } else if (value(arg, "release-legacy-hold") !== undefined) {
      result.releaseLegacyHold = value(arg, "release-legacy-hold");
      explicitModes.add((result.mode = "release-legacy-hold"));
    } else if (arg === "--rollback") explicitModes.add((result.mode = "rollback"));
    else if (arg === "--start") explicitModes.add((result.mode = "start"));
    else if (arg === "--stop") explicitModes.add((result.mode = "stop"));
    else if (arg === "--restart") explicitModes.add((result.mode = "restart"));
    else if (arg === "--check") explicitModes.add((result.mode = "check"));
    else if (value(arg, "tag") !== undefined) result.tag = value(arg, "tag");
    else if (value(arg, "artifact") !== undefined) result.artifact = value(arg, "artifact");
    else if (value(arg, "instance") !== undefined) result.instance = value(arg, "instance");
    else if (value(arg, "operation-record") !== undefined) result.operationRecord = value(arg, "operation-record");
    else if (value(arg, "reconcile-operation") !== undefined)
      result.reconcileOperation = value(arg, "reconcile-operation");
    else if (value(arg, "reconcile-claim") !== undefined) result.reconcileClaim = value(arg, "reconcile-claim");
    else if (value(arg, "pilot-recovery") !== undefined) {
      result.pilotRecovery = value(arg, "pilot-recovery");
      explicitModes.add((result.mode = "pilot-rollback"));
    } else if (value(arg, "legacy-hold") !== undefined) result.legacyHold = value(arg, "legacy-hold");
    else throw new Error(`unknown deployment argument: ${arg}`);
  }
  if ((result.reconcileOperation === undefined) !== (result.reconcileClaim === undefined)) {
    throw new Error("--reconcile-operation and --reconcile-claim are used together");
  }
  if (
    result.reconcileOperation !== undefined &&
    (argv.length !== 2 || !isAbsolute(result.reconcileOperation) || !/^[0-9a-f-]{36}$/i.test(result.reconcileClaim!))
  ) {
    throw new Error("reconcile mode accepts only its absolute operation record and claim");
  }
  if (result.artifact !== undefined && result.tag !== undefined) {
    throw new Error("--artifact and --tag are mutually exclusive");
  }
  if (explicitModes.size > 1) throw new Error("lifecycle mode options are mutually exclusive");
  const nonLifecycle = workKindForMode(result.mode) !== "lifecycle";
  if (result.mode === "bootstrap") {
    if (result.artifact === undefined || result.sha256 === undefined || result.revision === undefined) {
      throw new Error("--bootstrap requires --artifact, --sha256 and --revision");
    }
    if (!/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error("--sha256 must be a reviewed 64-hex digest");
    if (!/^[a-f0-9]{40}$/.test(result.revision)) throw new Error("--revision must be a reviewed 40-hex revision");
  } else if (result.sha256 !== undefined || result.revision !== undefined) {
    throw new Error("--sha256 and --revision are valid only with --bootstrap");
  }
  if ((result.mode === "capture-pilot") !== (result.bootstrapRecord !== undefined)) {
    throw new Error("--capture-pilot requires exactly one --bootstrap-record");
  }
  if (result.pilotSdkPort !== undefined && result.mode !== "capture-pilot") {
    throw new Error("--pilot-sdk-port is valid only with --capture-pilot");
  }
  if (
    nonLifecycle &&
    (result.tag !== undefined ||
      result.legacyHold !== undefined ||
      result.pilotRecovery !== undefined ||
      (result.mode !== "bootstrap" && result.artifact !== undefined))
  ) {
    throw new Error("runbook helper modes do not accept lifecycle selectors");
  }
  if (result.mode === "pilot-rollback" && (result.artifact !== undefined || result.tag !== undefined)) {
    throw new Error("pilot recovery cannot select a candidate artifact");
  }
  if (result.legacyHold !== undefined && (result.mode !== "update" || result.artifact === undefined)) {
    throw new Error("legacy hold evidence is valid only for an artifact update");
  }
  if (result.artifact !== undefined && (!isAbsolute(result.artifact) || !result.artifact.endsWith(".tgz"))) {
    throw new Error("--artifact must be an absolute .tgz path");
  }
  for (const [name, path] of [
    ["pilot recovery snapshot", result.pilotRecovery],
    ["legacy hold record", result.legacyHold],
    ["bootstrap record", result.bootstrapRecord],
    ["inventory snapshot", result.inventoryPilot],
    ["prepare snapshot", result.prepareLegacyHold],
    ["verify hold record", result.verifyLegacyHold],
    ["release hold record", result.releaseLegacyHold],
  ] as const) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`${name} must be absolute`);
  }
  return result;
}

interface SelectedInstance {
  home: string;
  configPath: string;
  instanceId: string;
  voiceEnabled: boolean;
}

async function selectInstance(args: DeploymentArguments, env: NodeJS.ProcessEnv): Promise<SelectedInstance> {
  const selectedHome = env.HIVE_HOME ?? env.HIVE_SINGLE_ROOT;
  if (!selectedHome || !isAbsolute(selectedHome)) throw new Error("explicit absolute HIVE_HOME is required");
  const home = await realpath(selectedHome);
  const selector = env.HIVE_CONFIG ?? env.HIVE_SINGLE_CONFIG ?? "hive.yaml";
  const configPath = resolve(home, selector);
  const document = parseYaml(await readFile(configPath, "utf8")) as {
    instance?: { id?: unknown };
    voice?: { livekit?: { enabled?: unknown } };
  };
  const instanceId = document?.instance?.id ?? "hive";
  if (typeof instanceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(instanceId)) {
    throw new Error("invalid configured instance ID");
  }
  for (const explicit of [args.instance, env.HIVE_SINGLE_ID]) {
    if (explicit !== undefined && explicit !== instanceId)
      throw new Error("explicit instance does not match selected config");
  }
  return { home, configPath, instanceId, voiceEnabled: document?.voice?.livekit?.enabled === true };
}

export async function deploymentDryRun(
  args: DeploymentArguments,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const selected = await selectInstance(args, env);
  // Dry-run deliberately does not validate secrets, fetch, freeze, lock, probe,
  // create directories, or touch services.
  return {
    status: "DRY_RUN",
    target: selected.instanceId,
    mode: args.mode,
    workKind: workKindForMode(args.mode),
    selectors: { hiveHome: selected.home, configPath: selected.configPath },
    voiceEnabled: selected.voiceEnabled,
    releaseSelector: args.artifact ? { artifact: args.artifact } : { tag: args.tag ?? "latest" },
    phases: ["preflight", "staged", "quiescent", "stop-worker", "stop-engine", "rotate", "start", "health"],
    recoveryProfile: args.pilotRecovery ? "registered-pilot" : "to-be-validated-under-lock",
    unknownEvidence: ["runtime process identity", "maintenance ledger", "candidate native imports", "paired health"],
    // Read-only plan; no directory is created, journaled or moved.
    pluginCompatibility: isLifecycleStaging(args.mode)
      ? await planBetaPluginCompatibility(selected.home).then(
          (plan) => ({
            relocate: plan.relocate.map((item) => item.name),
            destinationExists: plan.destinationExists,
          }),
          (error: unknown) => ({ status: "PLUGIN_COMPATIBILITY_PENDING", reason: String(error) }),
        )
      : "not-required",
    // Presence only: dry-run runs no self-test, promotion probe or artifact job.
    stagingPrerequisites:
      isLifecycleStaging(args.mode) || args.mode === "bootstrap"
        ? { sandboxExecPresent: existsSync(SANDBOX_EXEC), selfTest: "unverified", promotionMethod: "unverified" }
        : "not-required",
  };
}

function isLifecycleStaging(mode: DeploymentArguments["mode"]): boolean {
  return workKindForMode(mode) === "lifecycle" && stagingRequired(mode as LifecycleMode);
}

/** Registered selectors must literally be registry payload paths of the selected instance. */
function requireRegistrySelector(path: string | undefined, selected: SelectedInstance): void {
  if (path === undefined) return;
  if (!isRegistrySelector(selected.home, path)) {
    throw new Error("runbook evidence selector must be a registered payload path of the selected instance");
  }
}

async function bootstrapDeps(env: NodeJS.ProcessEnv): Promise<BootstrapDeps> {
  if (!env.HOME || !isAbsolute(env.HOME) || !env.PATH) throw new Error("explicit HOME and PATH are required");
  return {
    nodePath: await realpath(process.execPath),
    npmCliPath: await resolveHostNpmCli(env.PATH),
    pathEnv: env.PATH,
    invokingHome: env.HOME,
    isProcessLive: (owner) => processIsLive(nodeReconcileHostIO, owner),
  };
}

async function runFrozenBootstrap(operation: AcquiredOperation, env: NodeJS.ProcessEnv): Promise<void> {
  const configPath = env.HIVE_CONFIG;
  if (!configPath || !isAbsolute(configPath)) throw new Error("explicit absolute HIVE_CONFIG is required");
  let retainLock = false;
  try {
    const result = await runBootstrap(operation, { configPath }, await bootstrapDeps(env));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof OperationUnresolvedError || error instanceof BootstrapUnresolvedError) {
      retainLock = true;
      operation.record.phase = "unresolved";
      await persistOperation(operation).catch(() => {});
      throw error;
    }
    await abortBootstrap(operation);
    throw new DeploymentExit(1, {
      status: "BOOTSTRAP_ABORTED",
      operationId: operation.record.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const disposal = await disposeOperationJobs({
      canonicalInstanceHome: operation.record.canonicalHome,
      operationId: operation.record.id,
    }).catch(() => null);
    if (disposal && disposal.failures.length > 0) {
      operation.record.staging.sweepFailures.push(...disposal.failures);
      await persistOperation(operation).catch(() => {});
    }
    // Only after the terminal bootstrap record is durable; failures are reported, never fatal.
    if (!retainLock && operation.record.bootstrap?.outcome) {
      await runHostPreparationJanitor(operation).catch(() => []);
    }
    if (!retainLock && operation.record.resolution) await finishOperationLock(operation);
  }
}

type LifecycleContext = Awaited<ReturnType<typeof resolveLifecycleContext>>;

/**
 * Evidence dependencies for the selected instance. The service reader is a
 * read-only controller scoped to the snapshot's captured external targets;
 * no captured-loader bridge probe or exclusive-writer corroboration is wired,
 * so the pilot recovery profile fails closed rather than being guessed.
 */
function pilotEvidenceDeps(context: LifecycleContext, operationDirectory: string): RegistryCommandDeps {
  const observer = new ServiceController({
    instanceId: context.summary.instanceId,
    hiveHome: context.home,
    home: context.userHome,
    operationDir: operationDirectory,
  });
  return {
    instance: context.pilotInstance,
    controllerFor: (capturedPilotProfile) =>
      new ServiceController({
        instanceId: context.summary.instanceId,
        hiveHome: context.home,
        home: context.userHome,
        operationDir: operationDirectory,
        capturedPilotProfile,
      }),
    // Registered bootstrap probe and native hold boundaries owned by this operation.
    probes: { operationId: basename(operationDirectory), clock: { now: Date.now, mono: () => performance.now() } },
    exclusiveWriter: async (path, pid) => {
      const writers = await observer.fileWriters(path);
      return writers.length === 1 && writers[0] === pid;
    },
    settleBarrier: (barrier) =>
      settleRecordedBarrier(barrier, {
        host: nodeReconcileHostIO,
        controller: new ServiceController({
          instanceId: context.summary.instanceId,
          hiveHome: context.home,
          home: context.userHome,
          operationDir: operationDirectory,
        }),
      }),
  };
}

function registryFailureCode(error: unknown): string {
  if (error instanceof PilotCaptureBlockedError) return `${error.code}:${error.reason}`;
  if (error instanceof PilotEvidenceUnavailableError) return error.code;
  if (error instanceof DeferredMaintenance) return error.message.split(":")[0] || "REGISTRY_COMMAND_DEFERRED";
  return "REGISTRY_COMMAND_FAILED";
}

async function runFrozenRegistry(
  operation: AcquiredOperation,
  args: DeploymentArguments,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (workKindForMode(args.mode) !== "registry" || operation.record.mode !== args.mode) {
    throw new Error("frozen invocation mode does not match registry work");
  }
  let retainLock = false;
  let outcome: RegistryCommandResult;
  try {
    const context = await resolveLifecycleContext(operation, env);
    const deps = pilotEvidenceDeps(context, operation.paths.operationDirectory);
    switch (args.mode) {
      case "inventory-pilot":
        outcome = await runInventoryPilot(operation, args.inventoryPilot!, deps);
        break;
      case "prepare-legacy-hold":
        outcome = await runPrepareLegacyHold(operation, args.prepareLegacyHold!, deps);
        break;
      case "verify-legacy-hold":
        outcome = await runVerifyLegacyHold(operation, args.verifyLegacyHold!, deps);
        break;
      case "release-legacy-hold":
        outcome = await runReleaseLegacyHold(operation, args.releaseLegacyHold!, deps);
        break;
      case "capture-pilot": {
        // Read-only discovery through the opaque capture ticket; this
        // controller has no captured pilot profile and is never used to
        // stop, start or restore a service.
        const isProcessLive = (owner: { pid: number; startTime: string }) => processIsLive(nodeReconcileHostIO, owner);
        outcome = await runCapturePilot(operation, args.bootstrapRecord!, {
          instance: context.pilotInstance,
          isProcessLive,
          discovery: new ServiceController({
            instanceId: context.summary.instanceId,
            hiveHome: context.home,
            home: context.userHome,
            operationDir: operation.paths.operationDirectory,
            captureTicketValidator: captureTicketValidator({ isProcessLive }),
          }),
          probes: deps.probes!,
          pilotSdkPort: args.pilotSdkPort,
        });
        break;
      }
      default:
        throw new Error("unknown registry command");
    }
  } catch (error) {
    if (error instanceof OperationUnresolvedError || error instanceof RegistryUnresolvedError) {
      retainLock = true;
      operation.record.phase = "unresolved";
      await persistOperation(operation).catch(() => {});
      throw error;
    }
    try {
      outcome = await abortRegistryCommand(operation, registryFailureCode(error));
    } catch (abortError) {
      retainLock = true;
      operation.record.phase = "unresolved";
      await persistOperation(operation).catch(() => {});
      throw abortError;
    }
  } finally {
    if (!retainLock && operation.record.resolution) await finishOperationLock(operation);
  }
  if (outcome.exitCode !== 0) throw new DeploymentExit(outcome.exitCode, outcome.result);
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
}

async function ownerStartTime(): Promise<string> {
  return execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  }).trim();
}

async function loadAcquired(recordPath: string): Promise<AcquiredOperation> {
  if (!isAbsolute(recordPath)) throw new Error("operation record path must be absolute");
  const decoded = decodeOperationRecord(JSON.parse(await readFile(recordPath, "utf8")));
  if (decoded.schemaVersion !== OPERATION_SCHEMA_VERSION) throw new Error("invalid frozen operation record");
  const record: OperationRecord = decoded;
  if (!record.id || recordPath !== operationPaths(record.canonicalHome, record.id).operationRecord) {
    throw new Error("invalid frozen operation record");
  }
  const paths = operationPaths(record.canonicalHome, record.id);
  const current = decodeOperationRecord(JSON.parse(await readFile(paths.currentRecord, "utf8")));
  if (
    current.schemaVersion !== OPERATION_SCHEMA_VERSION ||
    current.id !== record.id ||
    current.toolSha256 !== record.toolSha256
  ) {
    throw new Error("operation record ownership changed");
  }
  return { paths, record: current };
}

async function processStartTime(pid: number): Promise<string> {
  const start = await nodeReconcileHostIO.processStartTime(pid);
  if (!start) throw new Error(`process ${pid} identity is unavailable`);
  return start;
}

async function runFrozen(args: DeploymentArguments, env: NodeJS.ProcessEnv): Promise<void> {
  const operation = await loadAcquired(args.operationRecord!);
  const self = await realpath(process.argv[1]);
  const expectedSelf = resolve(operation.paths.operationDirectory, "deploy.min.js");
  if (self !== expectedSelf || sha256(await readFile(self)) !== operation.record.toolSha256) {
    throw new Error("frozen deployment helper identity mismatch");
  }
  // Durable ownership transfer to this frozen child before any effect.
  await transferOwnershipToFrozen(
    operation,
    { pid: process.pid, startTime: await processStartTime(process.pid) },
    { pid: process.ppid, startTime: await processStartTime(process.ppid) },
  );
  if (operation.record.workKind === "bootstrap") {
    if (args.mode !== "bootstrap") throw new Error("frozen invocation mode does not match bootstrap work");
    await runFrozenBootstrap(operation, env);
    return;
  }
  if (operation.record.workKind === "registry") {
    await runFrozenRegistry(operation, args, env);
    return;
  }
  if (operation.record.workKind !== "lifecycle" || workKindForMode(args.mode) !== "lifecycle") {
    throw new Error("frozen invocation mode does not match lifecycle work");
  }
  let resolved = false;
  try {
    const context = await resolveLifecycleContext(operation, env);
    await runNodeLifecycle(operation, args as LifecycleCommand, env, {
      pilotEvidence: registryPilotEvidence(pilotEvidenceDeps(context, operation.paths.operationDirectory)),
    });
    resolved = Boolean(operation.record.resolution);
  } catch (error) {
    resolved = Boolean(operation.record.resolution) && operation.record.phase !== "unresolved";
    if (error instanceof MigrationPendingError) {
      throw new DeploymentExit(1, {
        status: "MIGRATION_PENDING",
        gaps: [...error.gaps],
        holdRecord: error.holdRecordPath,
        operationId: operation.record.id,
      });
    }
    throw error;
  } finally {
    if (resolved) await finishOperationLock(operation);
  }
}

export function lifecycleReconcileDepsFactory(
  env: NodeJS.ProcessEnv,
): (record: OperationRecord) => Promise<LifecycleReconcileDeps> {
  return async (record) => {
    const acquired: AcquiredOperation = { paths: operationPaths(record.canonicalHome, record.id), record };
    const context = await resolveLifecycleContext(acquired, env);
    return {
      controller: context.controller,
      host: nodeReconcileHostIO,
      verifyPilot: pilotProfileVerifier(pilotEvidenceDeps(context, acquired.paths.operationDirectory)),
      verifyPackaged: async ({ minimumStartedAt }) => {
        validatePromotedRelease(resolve(record.canonicalHome, ".hive"));
        await verifyPackagedPair(context, { minimumStartedAt, engineLogOffset: 0, dependenciesContained: true });
      },
    };
  };
}

async function runReconcileMode(args: DeploymentArguments, env: NodeJS.ProcessEnv): Promise<void> {
  const self = await realpath(process.argv[1]);
  const result = await runReconcileOperation({
    operationRecordPath: args.reconcileOperation!,
    claimId: args.reconcileClaim!,
    selfPath: self,
    selfSha256: sha256(await readFile(self)),
    lifecycle: lifecycleReconcileDepsFactory(env),
    nonLifecycle: {
      bootstrap: async (record, claimId) => {
        const acquired: AcquiredOperation = { paths: operationPaths(record.canonicalHome, record.id), record };
        const configPath = env.HIVE_CONFIG;
        if (!configPath || !isAbsolute(configPath)) throw new Error("explicit absolute HIVE_CONFIG is required");
        const outcome = await reconcileBootstrap(acquired, {
          ...(await bootstrapDeps(env)),
          configPath,
          isProcessLive: (owner) => processIsLive(nodeReconcileHostIO, owner),
        });
        await writeOperationJson(resolve(acquired.paths.operationDirectory, "reconciliation.json"), outcome);
        await runHostPreparationJanitor(acquired).catch(() => []);
        await finishOperationLock(acquired, { reconcileClaimId: claimId });
        return outcome;
      },
      registry: async (record, claimId) => {
        const acquired: AcquiredOperation = { paths: operationPaths(record.canonicalHome, record.id), record };
        const context = await resolveLifecycleContext(acquired, env);
        const outcome = await reconcileRegistryWork(
          acquired,
          pilotEvidenceDeps(context, acquired.paths.operationDirectory),
        );
        await writeOperationJson(resolve(acquired.paths.operationDirectory, "reconciliation.json"), outcome);
        await finishOperationLock(acquired, { reconcileClaimId: claimId });
        return outcome;
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function freezeAndInvoke(
  args: DeploymentArguments,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const selected = await selectInstance(args, env);
  // Stale-lock reconciliation precedes any new acquisition and never runs the
  // newly requested action in the same invocation.
  const stale = await inspectOrReconcile({
    instanceHome: selected.home,
    env: { ...env, HIVE_CONFIG: selected.configPath },
  });
  if (stale.status === "reconciled") {
    throw new DeploymentExit(1, {
      status: PREVIOUS_OPERATION_RECONCILED,
      operationId: stale.operationId,
      workKind: stale.workKind,
      outcome: stale.outcome,
    });
  }
  for (const selector of [
    args.pilotRecovery,
    args.legacyHold,
    args.bootstrapRecord,
    args.inventoryPilot,
    args.prepareLegacyHold,
    args.verifyLegacyHold,
    args.releaseLegacyHold,
  ]) {
    requireRegistrySelector(selector, selected);
  }
  const source = await realpath(process.argv[1]);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("deployment helper must be a regular file");
  const toolSha256 = sha256(await readFile(source));
  const workKind = workKindForMode(args.mode);
  const operation = await acquireOperation({
    instanceHome: selected.home,
    instanceId: selected.instanceId,
    mode: args.mode,
    workKind,
    ...(workKind === "bootstrap"
      ? {
          bootstrap: initialBootstrapWork({
            artifact: args.artifact!,
            sha256: args.sha256!,
            revision: args.revision!,
            sourceHelper: source,
          }),
        }
      : {}),
    ...(workKind === "registry" ? { registry: initialRegistryWork(args.mode as RegistryWork["command"]) } : {}),
    toolSha256,
    ownerStartTime: await ownerStartTime(),
    priorProfile: args.pilotRecovery ? "pilot" : "stopped",
  });
  const frozen = resolve(operation.paths.operationDirectory, "deploy.min.js");
  try {
    await copyFile(source, frozen, constants.COPYFILE_EXCL);
    await chmod(frozen, 0o700);
    if (sha256(await readFile(frozen)) !== toolSha256) throw new Error("frozen helper copy digest mismatch");
    operation.record.retainedPaths.push(frozen);
    await persistOperation(operation);
  } catch (error) {
    operation.record.phase = "unresolved";
    await persistOperation(operation).catch(() => {});
    throw new Error("deployment helper could not be frozen; operation retained", { cause: error });
  }
  execFileSync(process.execPath, [frozen, ...argv, `--operation-record=${operation.paths.operationRecord}`], {
    stdio: "inherit",
    env: { ...env, HIVE_HOME: selected.home, HIVE_CONFIG: selected.configPath },
  });
}

export async function runDeploymentMain(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = parseDeploymentArguments(argv);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(await deploymentDryRun(args, env))}\n`);
    return;
  }
  if (args.reconcileOperation) await runReconcileMode(args, env);
  else if (args.operationRecord) await runFrozen(args, env);
  else await freezeAndInvoke(args, argv, env);
}

async function main(): Promise<void> {
  try {
    await runDeploymentMain();
  } catch (error) {
    if (error instanceof DeploymentExit) {
      process.stdout.write(`${JSON.stringify(error.result)}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => "") : "";
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() => "");
if (invoked === modulePath) await main();
