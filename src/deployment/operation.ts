import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type Phase =
  | "preflight"
  | "staged"
  | "barrier-requested"
  | "quiescent"
  | "stopping-worker"
  | "stopping-engine"
  | "rotating"
  | "starting-engine"
  | "starting-worker"
  | "checking"
  | "recovering"
  | "healthy"
  | "deferred"
  | "unresolved";

export interface DirectoryIdentity {
  device: number;
  inode: number;
}

export interface OperationRecord {
  schemaVersion: 1;
  id: string;
  ownerPid: number;
  ownerStartTime: string;
  canonicalHome: string;
  instanceId: string;
  mode: "update" | "check" | "rollback" | "start" | "stop" | "restart" | "pilot-rollback";
  phase: Phase;
  toolSha256: string;
  hostNodePath?: string;
  hostNpmPath?: string;
  startedAt: string;
  supervisor?: { pid: number; bootId: string };
  barrierOperationId?: string;
  signalsBegun: boolean;
  priorProfile: "packaged" | "pilot" | "stopped";
  priorSnapshotPath: string;
  candidateArchiveSha256?: string;
  retainedPaths: string[];
  resolution?: "healthy" | "deferred" | "recovered";
  artifactMove?: {
    from: string;
    to: string;
    directoryIdentity: DirectoryIdentity;
    state: "intended" | "observed";
  };
  artifactDisposal?: {
    path: string;
    directoryIdentity: DirectoryIdentity;
    state: "intended" | "observed";
  };
}

export interface OperationPaths {
  deploymentRoot: string;
  lockDirectory: string;
  currentRecord: string;
  operationDirectory: string;
  operationRecord: string;
  priorSnapshot: string;
}

export class OperationBusyError extends Error {}
export class OperationUnresolvedError extends Error {}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Atomic, durable, owner-only state write used for every transaction fence. */
export async function writeOperationJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
    await fsyncDirectory(dirname(path));
  } finally {
    await handle.close().catch(() => {});
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

export function operationPaths(canonicalHome: string, operationId: string): OperationPaths {
  if (!isAbsolute(canonicalHome)) throw new Error("canonical instance home must be absolute");
  const deploymentRoot = resolve(canonicalHome, ".hive-state", "deployment");
  const operationDirectory = resolve(deploymentRoot, "operations", operationId);
  return {
    deploymentRoot,
    lockDirectory: resolve(deploymentRoot, "lock"),
    currentRecord: resolve(deploymentRoot, "operation.json"),
    operationDirectory,
    operationRecord: resolve(operationDirectory, "operation.json"),
    priorSnapshot: resolve(operationDirectory, "prior-snapshot.json"),
  };
}

export interface AcquireOperationInput {
  instanceHome: string;
  instanceId: string;
  mode: OperationRecord["mode"];
  toolSha256: string;
  ownerStartTime: string;
  priorProfile?: OperationRecord["priorProfile"];
  operationId?: string;
  ownerPid?: number;
  startedAt?: string;
}

export interface AcquiredOperation {
  paths: OperationPaths;
  record: OperationRecord;
}

/**
 * Acquires the one instance-wide lifecycle lock. Existing locks always fail
 * closed: stale-owner reconciliation needs process, barrier, service and
 * artifact evidence and is deliberately performed by the lifecycle adapter.
 */
export async function acquireOperation(input: AcquireOperationInput): Promise<AcquiredOperation> {
  const canonicalHome = await realpath(input.instanceHome);
  const homeStat = await lstat(canonicalHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("invalid canonical instance home");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.instanceId)) throw new Error("invalid Hive instance ID");
  if (!/^[a-f0-9]{64}$/.test(input.toolSha256)) throw new Error("invalid deployment helper digest");
  const id = input.operationId ?? randomUUID();
  const paths = operationPaths(canonicalHome, id);
  let previousRecord: unknown;
  try {
    previousRecord = JSON.parse(await readFile(paths.currentRecord, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw new OperationUnresolvedError("existing operation record is unreadable");
  }
  if (previousRecord && typeof previousRecord === "object") {
    const previous = previousRecord as Partial<OperationRecord>;
    if (
      previous.schemaVersion !== 1 ||
      previous.canonicalHome !== canonicalHome ||
      previous.instanceId !== input.instanceId ||
      previous.phase === "unresolved" ||
      (previous.signalsBegun === true && previous.resolution === undefined)
    ) {
      throw new OperationUnresolvedError("previous lifecycle operation requires reconciliation");
    }
  }
  await mkdir(resolve(canonicalHome, ".hive-state"), { recursive: true, mode: 0o700 });
  await chmod(resolve(canonicalHome, ".hive-state"), 0o700);
  await mkdir(paths.deploymentRoot, { recursive: true, mode: 0o700 });
  await chmod(paths.deploymentRoot, 0o700);
  await mkdir(resolve(paths.deploymentRoot, "operations"), { recursive: true, mode: 0o700 });
  await chmod(resolve(paths.deploymentRoot, "operations"), 0o700);
  try {
    await mkdir(paths.lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    let detail: string;
    try {
      const current = JSON.parse(await readFile(resolve(paths.lockDirectory, "owner.json"), "utf8")) as {
        id?: unknown;
        ownerPid?: unknown;
        ownerStartTime?: unknown;
      };
      detail = `operation=${String(current.id)} pid=${String(current.ownerPid)} start=${String(current.ownerStartTime)}`;
    } catch {
      throw new OperationUnresolvedError("deployment lock exists without trustworthy owner metadata");
    }
    throw new OperationBusyError(`another lifecycle operation owns this instance (${detail})`);
  }
  const record: OperationRecord = {
    schemaVersion: 1,
    id,
    ownerPid: input.ownerPid ?? process.pid,
    ownerStartTime: input.ownerStartTime,
    canonicalHome,
    instanceId: input.instanceId,
    mode: input.mode,
    phase: "preflight",
    toolSha256: input.toolSha256,
    startedAt: input.startedAt ?? new Date().toISOString(),
    signalsBegun: false,
    priorProfile: input.priorProfile ?? "stopped",
    priorSnapshotPath: paths.priorSnapshot,
    retainedPaths: [],
  };
  try {
    await writeOperationJson(resolve(paths.lockDirectory, "owner.json"), {
      schemaVersion: 1,
      id,
      ownerPid: record.ownerPid,
      ownerStartTime: record.ownerStartTime,
      canonicalHome,
    });
    await mkdir(paths.operationDirectory, { recursive: false, mode: 0o700 });
    if (previousRecord !== undefined) {
      await writeOperationJson(resolve(paths.operationDirectory, "previous-operation.json"), previousRecord);
    }
    await writeOperationJson(paths.operationRecord, record);
    await writeOperationJson(paths.currentRecord, record);
  } catch (error) {
    // A failure after lock mkdir is intentionally left for reconciliation.
    throw new OperationUnresolvedError("operation ownership could not be durably recorded", { cause: error });
  }
  return { paths, record };
}

export async function persistOperation(operation: AcquiredOperation): Promise<void> {
  await writeOperationJson(operation.paths.operationRecord, operation.record);
  await writeOperationJson(operation.paths.currentRecord, operation.record);
}

export async function setOperationPhase(operation: AcquiredOperation, phase: Phase): Promise<void> {
  operation.record.phase = phase;
  await persistOperation(operation);
}

export async function finishOperationLock(operation: AcquiredOperation): Promise<void> {
  const ownerPath = resolve(operation.paths.lockDirectory, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { id?: unknown };
  if (owner.id !== operation.record.id) throw new OperationUnresolvedError("deployment lock ownership changed");
  await unlink(ownerPath);
  await rmdir(operation.paths.lockDirectory);
  await fsyncDirectory(operation.paths.deploymentRoot);
}

export async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink())
    throw new Error(`artifact path is not an owned directory: ${path}`);
  return { device: value.dev, inode: value.ino };
}

export async function sameDirectoryIdentity(path: string, identity: DirectoryIdentity): Promise<boolean> {
  try {
    const current = await directoryIdentity(path);
    return current.device === identity.device && current.inode === identity.inode;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertArtifactPath(operation: AcquiredOperation, path: string): Promise<void> {
  const parent = await realpath(dirname(path));
  if (!inside(operation.record.canonicalHome, parent)) throw new Error("artifact path escapes instance home");
}

async function mustBeAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`artifact destination is occupied: ${path}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Rename one proven directory into an absent slot, fenced on both sides. */
export async function moveOwnedDirectory(
  operation: AcquiredOperation,
  from: string,
  to: string,
): Promise<DirectoryIdentity> {
  await assertArtifactPath(operation, from);
  await assertArtifactPath(operation, to);
  const identity = await directoryIdentity(from);
  await mustBeAbsent(to);
  operation.record.artifactMove = { from, to, directoryIdentity: identity, state: "intended" };
  operation.record.retainedPaths = [...new Set([...operation.record.retainedPaths, from])];
  await persistOperation(operation);
  if (!(await sameDirectoryIdentity(from, identity))) throw new Error("artifact source identity changed before rename");
  await mustBeAbsent(to);
  await rename(from, to);
  if (!(await sameDirectoryIdentity(to, identity))) {
    throw new OperationUnresolvedError("artifact rename outcome could not be identified");
  }
  operation.record.artifactMove = { from, to, directoryIdentity: identity, state: "observed" };
  operation.record.retainedPaths = operation.record.retainedPaths.filter((path) => path !== from);
  operation.record.retainedPaths.push(to);
  await persistOperation(operation);
  return identity;
}

export async function locateDirectoryIdentity(
  identity: DirectoryIdentity,
  candidates: readonly string[],
): Promise<string> {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await sameDirectoryIdentity(candidate, identity)) found.push(candidate);
  }
  if (found.length !== 1) throw new OperationUnresolvedError("artifact identity has an ambiguous or missing location");
  return found[0];
}

/** Remove only a proven diagnostic directory after a durable resolution. */
export async function disposeOwnedDirectory(
  operation: AcquiredOperation,
  path: string,
  identity: DirectoryIdentity,
): Promise<void> {
  if (!operation.record.resolution) throw new Error("artifact disposal requires durable verified resolution");
  await assertArtifactPath(operation, path);
  if (!(await sameDirectoryIdentity(path, identity))) throw new Error("diagnostic artifact identity changed");
  operation.record.artifactDisposal = { path, directoryIdentity: identity, state: "intended" };
  await persistOperation(operation);
  await rm(path, { recursive: true, force: false });
  try {
    await stat(path);
    throw new OperationUnresolvedError("diagnostic artifact survived disposal");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  operation.record.artifactDisposal = { path, directoryIdentity: identity, state: "observed" };
  operation.record.retainedPaths = operation.record.retainedPaths.filter((candidate) => candidate !== path);
  await persistOperation(operation);
}

/** Determine whether an interrupted last rename happened without trusting slot names. */
export async function reconcileArtifactMove(record: OperationRecord): Promise<"before" | "after"> {
  const move = record.artifactMove;
  if (!move) throw new Error("operation has no artifact move to reconcile");
  const [atSource, atDestination] = await Promise.all([
    sameDirectoryIdentity(move.from, move.directoryIdentity),
    sameDirectoryIdentity(move.to, move.directoryIdentity),
  ]);
  if (atSource === atDestination) throw new OperationUnresolvedError("artifact move cannot be reconciled");
  return atDestination ? "after" : "before";
}

export interface InterruptedOperationIO {
  ownerIsLive(owner: { pid: number; startTime: string }): Promise<boolean>;
  releaseBarrier(record: OperationRecord): Promise<void>;
  reconcileFilesystem(record: OperationRecord, lastMove: "before" | "after" | null): Promise<void>;
  recoverAfterSignals(record: OperationRecord, lastMove: "before" | "after" | null): Promise<void>;
}

/**
 * Reconcile a stale lock under its original durable record. Callers must use
 * the recorded frozen helper/process/service adapters; this function supplies
 * the ownership and phase gates and never guesses from a slot name or PID.
 */
export async function reconcileInterruptedOperation(instanceHome: string, io: InterruptedOperationIO): Promise<void> {
  const canonicalHome = await realpath(instanceHome);
  const deploymentRoot = resolve(canonicalHome, ".hive-state", "deployment");
  const currentPath = resolve(deploymentRoot, "operation.json");
  const record = JSON.parse(await readFile(currentPath, "utf8")) as OperationRecord;
  if (record.schemaVersion !== 1 || record.canonicalHome !== canonicalHome || !record.id) {
    throw new OperationUnresolvedError("stale operation record identity is invalid");
  }
  const paths = operationPaths(canonicalHome, record.id);
  const owner = JSON.parse(await readFile(resolve(paths.lockDirectory, "owner.json"), "utf8")) as {
    id?: unknown;
    ownerPid?: unknown;
    ownerStartTime?: unknown;
  };
  if (owner.id !== record.id || owner.ownerPid !== record.ownerPid || owner.ownerStartTime !== record.ownerStartTime) {
    throw new OperationUnresolvedError("stale lock and operation owner do not match");
  }
  if (await io.ownerIsLive({ pid: record.ownerPid, startTime: record.ownerStartTime })) {
    throw new OperationBusyError("recorded lifecycle owner is still live");
  }
  const lastMove = record.artifactMove ? await reconcileArtifactMove(record) : null;
  if (record.barrierOperationId && !record.signalsBegun) {
    // A status observation is insufficient. The adapter must obtain the fresh,
    // same-boot terminal release acknowledgement before returning.
    await io.releaseBarrier(record);
  }
  if (record.signalsBegun) {
    await io.recoverAfterSignals(record, lastMove);
    record.resolution = "recovered";
  } else {
    await io.reconcileFilesystem(record, lastMove);
    record.resolution = record.resolution ?? "deferred";
  }
  record.phase = record.resolution === "recovered" ? "recovering" : "deferred";
  const acquired: AcquiredOperation = { paths, record };
  await persistOperation(acquired);
  await finishOperationLock(acquired);
}
