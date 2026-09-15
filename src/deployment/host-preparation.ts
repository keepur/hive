/**
 * Adoption of the builtin host preparation receipt and its operation-owned
 * janitor (KPR-463 plan chunk 5 Task 8 Step 1a.3 / Task 9 Step 4d.1a Step 5).
 *
 * The host recipe (`scripts/kpr463-prepare-bootstrap.mjs`) writes
 * `<home>/.hive-state/bootstrap/.prepare-<uuid>.json` beside the preparation
 * directory that holds the single helper it placed. Bootstrap derives that
 * receipt path SOLELY from its own source helper path, validates the receipt
 * against the reviewed inputs, the frozen helper digest and the on-disk
 * identities, requires the preparer to have exited, and retains an immutable
 * copy under the operation before rewriting the sidecar as `adopted` — all
 * journaled before any install. Reconciliation accepts only the exact prior
 * validated bytes or the predicted adopted bytes for this operation.
 *
 * After the bootstrap's terminal record is durable, the janitor disposes only
 * the adopted preparation directory by its recorded identity and, separately
 * fenced, the adopted receipt. An orphan or unvalidated receipt is never
 * purged or overwritten; failures are reported, never fatal.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { OperationUnresolvedError, persistOperation, type AcquiredOperation } from "./operation.js";
import {
  canonicalBytes,
  fileSeal,
  instanceKey,
  int,
  literal,
  MAX_RECORD_BYTES,
  object,
  path,
  sealFile,
  sha256Hex,
  str,
  uuid,
  verifySeal,
  type Digest,
  type FileSeal,
  type InstanceKey,
} from "./pilot-records.js";

export const PREPARATION_ORPHAN_RETAINED = "PREPARATION_ORPHAN_RETAINED";
export const PREPARATION_BUSY = "PREPARATION_BUSY";
export const HOST_PREPARATION_FILE = "host-preparation.json";
export const HOST_PREPARATION_ADOPTED_FILE = "host-preparation-adopted.json";

export type OwnedIdentity = { dev: number; ino: number; uid: number };
export type OwnedDirectoryRef = { path: string; identity: OwnedIdentity };

export type HostPreparation = {
  schemaVersion: 1;
  id: string;
  instance: InstanceKey;
  owner: { pid: number; startTime: string };
  archive: FileSeal;
  reviewedRevision: string;
  preparedPath: string;
  parent: OwnedDirectoryRef;
  phase: "intended" | "created" | "extracted" | "validated" | "adopted" | "removed";
  directory: OwnedDirectoryRef | null;
  helper: FileSeal | null;
  adoptedOperationId: string | null;
};

export interface HostAdoption {
  state: "intended" | "observed";
  receipt: { path: string; validatedSha256: Digest };
  adoptedSha256: Digest;
  directory: OwnedDirectoryRef;
  retainedAdopted: FileSeal | null;
  disposal: {
    directory: "retained" | "remove-intended" | "removed";
    receipt: "retained" | "remove-intended" | "removed";
  };
}

export class PreparationAdoptionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function ownedDirectory(value: unknown): OwnedDirectoryRef {
  const o = object(value, ["path", "identity"]);
  const i = object(o.identity, ["dev", "ino", "uid"]);
  return { path: path(o.path), identity: { dev: int(i.dev), ino: int(i.ino), uid: int(i.uid, 0, 0x7fffffff) } };
}

export function decodeHostPreparation(value: unknown): HostPreparation {
  const o = object(value, [
    "schemaVersion",
    "id",
    "instance",
    "owner",
    "archive",
    "reviewedRevision",
    "preparedPath",
    "parent",
    "phase",
    "directory",
    "helper",
    "adoptedOperationId",
  ]);
  if (o.schemaVersion !== 1) throw new PreparationAdoptionError("PREPARATION_RECEIPT_INVALID");
  const owner = object(o.owner, ["pid", "startTime"]);
  const revision = str(o.reviewedRevision, 40);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new PreparationAdoptionError("PREPARATION_RECEIPT_INVALID");
  return {
    schemaVersion: 1,
    id: uuid(o.id),
    instance: instanceKey(o.instance),
    owner: { pid: int(owner.pid, 1, 0x7fffffff), startTime: str(owner.startTime, 128) },
    archive: fileSeal(o.archive),
    reviewedRevision: revision,
    preparedPath: path(o.preparedPath),
    parent: ownedDirectory(o.parent),
    phase: literal(o.phase, ["intended", "created", "extracted", "validated", "adopted", "removed"]),
    directory: o.directory === null ? null : ownedDirectory(o.directory),
    helper: o.helper === null ? null : fileSeal(o.helper),
    adoptedOperationId: o.adoptedOperationId === null ? null : uuid(o.adoptedOperationId),
  };
}

/**
 * The receipt and directory a source helper was prepared into, derived only
 * from the helper path shape `<home>/.hive-state/bootstrap/.prepare-<uuid>/
 * package/pkg/deploy.min.js`; null for any other helper location.
 */
export function preparationForHelper(
  canonicalHome: string,
  sourceHelper: string,
): { id: string; directory: string; receipt: string } | null {
  const bootstrapRoot = resolve(canonicalHome, ".hive-state", "bootstrap");
  const directory = resolve(sourceHelper, "..", "..", "..");
  const name = basename(directory);
  const match = /^\.prepare-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(name);
  if (
    !match ||
    dirname(directory) !== bootstrapRoot ||
    resolve(directory, "package", "pkg", "deploy.min.js") !== sourceHelper
  ) {
    return null;
  }
  return { id: match[1], directory, receipt: `${directory}.json` };
}

async function fsyncDirectory(target: string): Promise<void> {
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exclusiveWrite(target: string, bytes: Buffer): Promise<void> {
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

/** Exclusive temp 0600, file fsync, atomic rename, parent fsync. */
async function durableReplace(target: string, bytes: Buffer, randomId: () => string): Promise<void> {
  const temporary = `${target}.${randomId()}.tmp`;
  await exclusiveWrite(temporary, bytes);
  await rename(temporary, target);
  await fsyncDirectory(dirname(target));
}

async function identityOf(target: string): Promise<(OwnedIdentity & { directory: boolean; symlink: boolean }) | null> {
  try {
    const info = await lstat(target);
    return {
      dev: info.dev,
      ino: info.ino,
      uid: info.uid,
      directory: info.isDirectory(),
      symlink: info.isSymbolicLink(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left: OwnedIdentity | null, right: OwnedIdentity): boolean {
  return left !== null && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function readReceipt(receiptPath: string, uid: number): Promise<{ bytes: Buffer; seal: FileSeal }> {
  const { bytes, ...seal } = await sealFile(receiptPath, { uid, maxBytes: MAX_RECORD_BYTES });
  return { bytes, seal };
}

export interface AdoptionWork {
  archiveInput: string;
  reviewedSha256: string;
  reviewedRevision: string;
  sourceHelper: string;
  hostPreparation: FileSeal | null;
  adoption: HostAdoption | null;
}

export interface AdoptionDeps {
  configPath: string;
  isProcessLive(owner: { pid: number; startTime: string }): Promise<boolean>;
  randomId?: () => string;
}

function uidOf(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("host preparation adoption requires a POSIX user ID");
  return uid;
}

/**
 * Adopt the validated host preparation receipt for this bootstrap operation,
 * before any install. Idempotent once observed. A helper not placed by the host
 * recipe has nothing to adopt.
 */
export async function adoptHostPreparation(
  operation: AcquiredOperation,
  work: AdoptionWork,
  deps: AdoptionDeps,
): Promise<HostAdoption | null> {
  if (work.adoption?.state === "observed") return work.adoption;
  const home = operation.record.canonicalHome;
  const prepared = preparationForHelper(home, work.sourceHelper);
  if (!prepared) return null;
  const uid = uidOf();
  let current: { bytes: Buffer; seal: FileSeal };
  try {
    current = await readReceipt(prepared.receipt, uid);
  } catch {
    throw new PreparationAdoptionError(PREPARATION_ORPHAN_RETAINED);
  }
  if (work.adoption?.state === "intended") {
    // Crash between journal and observation: only the exact prior validated or predicted adopted bytes.
    await completeAdoption(operation, work, prepared.receipt, current, deps);
    return work.adoption;
  }
  let receipt: HostPreparation;
  try {
    receipt = decodeHostPreparation(parseCanonical(current.bytes));
  } catch {
    throw new PreparationAdoptionError(PREPARATION_ORPHAN_RETAINED);
  }
  if (receipt.phase !== "validated" || receipt.adoptedOperationId !== null || !receipt.directory || !receipt.helper) {
    throw new PreparationAdoptionError(PREPARATION_ORPHAN_RETAINED);
  }
  const bootstrapRoot = resolve(home, ".hive-state", "bootstrap");
  const expectedInstance: InstanceKey = {
    canonicalHome: home,
    configPath: deps.configPath,
    instanceId: operation.record.instanceId,
    uid,
  };
  if (
    receipt.id !== prepared.id ||
    canonical(receipt.instance) !== canonical(expectedInstance) ||
    receipt.archive.path !== work.archiveInput ||
    receipt.archive.sha256 !== work.reviewedSha256 ||
    receipt.reviewedRevision !== work.reviewedRevision ||
    receipt.preparedPath !== work.sourceHelper ||
    receipt.parent.path !== bootstrapRoot ||
    receipt.directory.path !== prepared.directory ||
    receipt.helper.path !== work.sourceHelper ||
    receipt.helper.sha256 !== operation.record.toolSha256
  ) {
    throw new PreparationAdoptionError("PREPARATION_RECEIPT_MISMATCH");
  }
  if (
    !sameIdentity(await identityOf(bootstrapRoot), receipt.parent.identity) ||
    !sameIdentity(await identityOf(prepared.directory), receipt.directory.identity)
  ) {
    throw new PreparationAdoptionError("PREPARATION_IDENTITY_CHANGED");
  }
  try {
    await verifySeal(receipt.helper, { uid });
  } catch {
    throw new PreparationAdoptionError("PREPARATION_HELPER_CHANGED");
  }
  if (await deps.isProcessLive(receipt.owner)) throw new PreparationAdoptionError(PREPARATION_BUSY);

  // Immutable retained copy of the exact validated receipt, referenced by the work state.
  const retainedPath = resolve(operation.paths.operationDirectory, HOST_PREPARATION_FILE);
  await exclusiveWrite(retainedPath, current.bytes);
  const { bytes: _retainedBytes, ...retained } = await sealFile(retainedPath, { uid, maxBytes: MAX_RECORD_BYTES });
  void _retainedBytes;
  work.hostPreparation = retained;
  const adopted: HostPreparation = { ...receipt, phase: "adopted", adoptedOperationId: operation.record.id };
  work.adoption = {
    state: "intended",
    receipt: { path: prepared.receipt, validatedSha256: current.seal.sha256 },
    adoptedSha256: sha256Hex(canonicalBytes(adopted)),
    directory: receipt.directory,
    retainedAdopted: null,
    disposal: { directory: "retained", receipt: "retained" },
  };
  if (!operation.record.retainedPaths.includes(retainedPath)) operation.record.retainedPaths.push(retainedPath);
  await persistOperation(operation);
  await completeAdoption(operation, work, prepared.receipt, current, deps, adopted);
  return work.adoption;
}

async function completeAdoption(
  operation: AcquiredOperation,
  work: AdoptionWork,
  receiptPath: string,
  current: { bytes: Buffer; seal: FileSeal },
  deps: AdoptionDeps,
  adopted?: HostPreparation,
): Promise<void> {
  const adoption = work.adoption!;
  const uid = uidOf();
  if (current.seal.sha256 === adoption.receipt.validatedSha256) {
    const next =
      adopted ??
      ({
        ...decodeHostPreparation(parseCanonical(current.bytes)),
        phase: "adopted",
        adoptedOperationId: operation.record.id,
      } satisfies HostPreparation);
    const bytes = canonicalBytes(next);
    if (sha256Hex(bytes) !== adoption.adoptedSha256) throw new OperationUnresolvedError("PREPARATION_RECEIPT_CHANGED");
    await durableReplace(receiptPath, bytes, deps.randomId ?? randomUUID);
  } else if (current.seal.sha256 !== adoption.adoptedSha256) {
    throw new OperationUnresolvedError("PREPARATION_RECEIPT_CHANGED");
  }
  const reread = await readReceipt(receiptPath, uid);
  if (reread.seal.sha256 !== adoption.adoptedSha256) throw new OperationUnresolvedError("PREPARATION_RECEIPT_CHANGED");
  const adoptedPath = resolve(operation.paths.operationDirectory, HOST_PREPARATION_ADOPTED_FILE);
  if (!(await identityOf(adoptedPath))) await exclusiveWrite(adoptedPath, reread.bytes);
  const { bytes: kept, ...retainedAdopted } = await sealFile(adoptedPath, { uid, maxBytes: MAX_RECORD_BYTES });
  if (sha256Hex(kept) !== adoption.adoptedSha256) throw new OperationUnresolvedError("PREPARATION_RECEIPT_CHANGED");
  adoption.retainedAdopted = retainedAdopted;
  adoption.state = "observed";
  if (!operation.record.retainedPaths.includes(adoptedPath)) operation.record.retainedPaths.push(adoptedPath);
  await persistOperation(operation);
}

/**
 * Operation-owned janitor, run only after the bootstrap's terminal record is
 * durable: dispose the adopted preparation directory by its recorded identity
 * (never following links, never a changed or foreign target), then — separately
 * fenced — the adopted receipt when its bytes are exactly the adopted bytes.
 * Returns fixed failure codes; nothing here is fatal and nothing unknown is
 * removed.
 */
export async function disposeHostPreparation(
  operation: AcquiredOperation,
  work: AdoptionWork & { outcome: "validated" | "aborted" | null },
): Promise<string[]> {
  const adoption = work.adoption;
  if (!adoption || adoption.state !== "observed" || work.outcome === null) return [];
  const failures: string[] = [];
  const directory = adoption.directory;
  if (adoption.disposal.directory !== "removed") {
    const current = await identityOf(directory.path);
    if (current === null) {
      if (adoption.disposal.directory === "remove-intended") adoption.disposal.directory = "removed";
      else failures.push("PREPARATION_DIRECTORY_MISSING");
    } else if (!current.directory || current.symlink || !sameIdentity(current, directory.identity)) {
      failures.push("PREPARATION_DIRECTORY_IDENTITY_CHANGED");
    } else {
      adoption.disposal.directory = "remove-intended";
      await persistOperation(operation);
      try {
        await rm(directory.path, { recursive: true, force: false });
        await fsyncDirectory(dirname(directory.path));
        if ((await identityOf(directory.path)) === null) adoption.disposal.directory = "removed";
        else failures.push("PREPARATION_DIRECTORY_SURVIVED_DISPOSAL");
      } catch {
        failures.push("PREPARATION_DIRECTORY_DISPOSAL_FAILED");
      }
    }
    await persistOperation(operation);
  }
  if (adoption.disposal.directory === "removed" && adoption.disposal.receipt !== "removed") {
    const receiptPath = adoption.receipt.path;
    const present = await identityOf(receiptPath);
    if (present === null) {
      if (adoption.disposal.receipt === "remove-intended") adoption.disposal.receipt = "removed";
      else failures.push("PREPARATION_RECEIPT_MISSING");
    } else {
      let matches: boolean;
      try {
        matches = (await readReceipt(receiptPath, uidOf())).seal.sha256 === adoption.adoptedSha256;
      } catch {
        matches = false;
      }
      if (!matches) {
        failures.push("PREPARATION_RECEIPT_CHANGED");
      } else {
        adoption.disposal.receipt = "remove-intended";
        await persistOperation(operation);
        await unlink(receiptPath);
        await fsyncDirectory(dirname(receiptPath));
        adoption.disposal.receipt = "removed";
      }
    }
    await persistOperation(operation);
  }
  return failures;
}
