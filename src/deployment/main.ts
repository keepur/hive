import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { sha256 } from "./release.js";
import {
  acquireOperation,
  finishOperationLock,
  operationPaths,
  persistOperation,
  type AcquiredOperation,
  type OperationRecord,
} from "./operation.js";
import { runNodeLifecycle, type LifecycleCommand } from "./lifecycle.js";

export interface DeploymentArguments extends LifecycleCommand {
  dryRun: boolean;
  instance?: string;
  operationRecord?: string;
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
    else if (value(arg, "pilot-recovery") !== undefined) {
      result.pilotRecovery = value(arg, "pilot-recovery");
      explicitModes.add((result.mode = "pilot-rollback"));
    } else if (value(arg, "legacy-hold") !== undefined) result.legacyHold = value(arg, "legacy-hold");
    else throw new Error(`unknown deployment argument: ${arg}`);
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
  const record = JSON.parse(await readFile(recordPath, "utf8")) as OperationRecord;
  if (
    record.schemaVersion !== 1 ||
    !record.id ||
    recordPath !== operationPaths(record.canonicalHome, record.id).operationRecord
  ) {
    throw new Error("invalid frozen operation record");
  }
  const paths = operationPaths(record.canonicalHome, record.id);
  const current = JSON.parse(await readFile(paths.currentRecord, "utf8")) as OperationRecord;
  if (current.id !== record.id || current.toolSha256 !== record.toolSha256) {
    throw new Error("operation record ownership changed");
  }
  return { paths, record: current };
}

async function runFrozen(args: DeploymentArguments, env: NodeJS.ProcessEnv): Promise<void> {
  const operation = await loadAcquired(args.operationRecord!);
  const self = await realpath(process.argv[1]);
  const expectedSelf = resolve(operation.paths.operationDirectory, "deploy.min.js");
  if (self !== expectedSelf || sha256(await readFile(self)) !== operation.record.toolSha256) {
    throw new Error("frozen deployment helper identity mismatch");
  }
  let resolved = false;
  try {
    await runNodeLifecycle(operation, args, env);
    resolved = Boolean(operation.record.resolution);
  } catch (error) {
    resolved = Boolean(operation.record.resolution) && operation.record.phase !== "unresolved";
    throw error;
  } finally {
    if (resolved) await finishOperationLock(operation);
  }
}

async function freezeAndInvoke(
  args: DeploymentArguments,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const selected = await selectInstance(args, env);
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
  if (args.operationRecord) await runFrozen(args, env);
  else await freezeAndInvoke(args, argv, env);
}

async function main(): Promise<void> {
  try {
    await runDeploymentMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => "") : "";
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() => "");
if (invoked === modulePath) await main();
