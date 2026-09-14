import { execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { sha256 } from "./release.js";
import {
  acquireOperation,
  decodeOperationRecord,
  finishOperationLock,
  OPERATION_SCHEMA_VERSION,
  operationPaths,
  persistOperation,
  transferOwnershipToFrozen,
  type AcquiredOperation,
  type OperationRecord,
} from "./operation.js";
import {
  resolveLifecycleContext,
  runNodeLifecycle,
  stagingRequired,
  validatePromotedRelease,
  verifyPackagedPair,
  type LifecycleCommand,
} from "./lifecycle.js";
import { SANDBOX_EXEC } from "./confined-job.js";
import {
  inspectOrReconcile,
  nodeReconcileHostIO,
  PREVIOUS_OPERATION_RECONCILED,
  runReconcileOperation,
  type LifecycleReconcileDeps,
} from "./reconcile.js";
import { MigrationPendingError } from "./pilot-lifecycle.js";

export interface DeploymentArguments extends LifecycleCommand {
  dryRun: boolean;
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
  const mode: LifecycleCommand["mode"] = "update";
  const result: DeploymentArguments = { mode, dryRun: false };
  const explicitModes = new Set<LifecycleCommand["mode"]>();
  for (const arg of argv) {
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--rollback") explicitModes.add((result.mode = "rollback"));
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

async function requireRegisteredRunbookPath(path: string | undefined, selected: SelectedInstance): Promise<void> {
  if (path === undefined) return;
  const canonical = await realpath(path);
  const state = await realpath(resolve(selected.home, ".hive-state"));
  const rel = relative(state, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("runbook evidence must be registered beneath instance state");
  }
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("runbook evidence must be a regular file");
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
    selectors: { hiveHome: selected.home, configPath: selected.configPath },
    voiceEnabled: selected.voiceEnabled,
    releaseSelector: args.artifact ? { artifact: args.artifact } : { tag: args.tag ?? "latest" },
    phases: ["preflight", "staged", "quiescent", "stop-worker", "stop-engine", "rotate", "start", "health"],
    recoveryProfile: args.pilotRecovery ? "registered-pilot" : "to-be-validated-under-lock",
    unknownEvidence: ["runtime process identity", "maintenance ledger", "candidate native imports", "paired health"],
    // Presence only: dry-run runs no self-test, promotion probe or artifact job.
    stagingPrerequisites: stagingRequired(args.mode)
      ? { sandboxExecPresent: existsSync(SANDBOX_EXEC), selfTest: "unverified", promotionMethod: "unverified" }
      : "not-required",
  };
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
  let resolved = false;
  try {
    await runNodeLifecycle(operation, args, env);
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
  await requireRegisteredRunbookPath(args.pilotRecovery, selected);
  await requireRegisteredRunbookPath(args.legacyHold, selected);
  const source = await realpath(process.argv[1]);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("deployment helper must be a regular file");
  const toolSha256 = sha256(await readFile(source));
  const operation = await acquireOperation({
    instanceHome: selected.home,
    instanceId: selected.instanceId,
    mode: args.mode,
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
