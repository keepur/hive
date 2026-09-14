/**
 * Clone-on-promote and clone-only verification for artifact jobs (KPR-463
 * spec §5.1, plan chunk 5 Task 8 Step 1a.3).
 *
 * After a confined job's direct child exits 0, the orchestrator copies the
 * job's output tree to an absent destination (`.hive.next`, the next job
 * directory, or a tooling staging sibling) with the promotion method fixed at
 * preflight. The copy has its own inodes, so a straggler's late write through
 * a descriptor opened earlier lands in the never-promoted job directory. The
 * clone is then verified by reading the clone only. A job directory is never
 * renamed into place.
 *
 * Builtin-only: imports `node:*`, `release.ts`, `confined-job.ts` and the logger.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createLogger } from "../logging/logger.js";
import { readRelease, sha256, type Release } from "./release.js";
import {
  assertConfinedJobRunner,
  jobsRoot,
  nodeConfinedJobIO,
  requireJobSuccess,
  type ConfinedJobResult,
  type ConfinedJobRunner,
  type ConfinedProcessResult,
  type FileStat,
  type SpawnOptions,
} from "./confined-job.js";

const log = createLogger("deployment-clone-promotion");

export const CP = "/bin/cp";
const DF = "/bin/df";
const MOUNT = "/sbin/mount";
const PS = "/bin/ps";

export type PromotionMethod = "clone" | "full-copy";

export interface PromotionMethodSelection {
  method: PromotionMethod;
  reason: "apfs-clone" | "cross-volume" | "non-apfs-volume";
  filesystemType: string;
}

export interface DirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Filesystem/process boundary for promotion; injected in unit tests. */
export interface PromotionIO {
  spawn(command: string, args: readonly string[], options: SpawnOptions): Promise<ConfinedProcessResult>;
  lstat(path: string): Promise<FileStat & { size: number }>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<DirectoryEntry[]>;
  readFile(path: string): Promise<Buffer>;
  readlink(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  freeBytes(path: string): Promise<number>;
  /** Filesystem type name (`apfs`, `msdos`, ...) of the volume holding `path`. */
  filesystemType(path: string): Promise<string>;
  processStartTime(pid: number): Promise<string | null>;
  getuid(): number;
  randomId(): string;
}

const commandEnv = { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

async function runHostCommand(command: string, args: readonly string[]): Promise<string> {
  const result = await nodeConfinedJobIO.spawn(command, args, {
    cwd: "/",
    env: commandEnv,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(`${basename(command)} failed`);
  return result.stdout.toString("utf8");
}

/** Mount point of `path` from `df -P`, then its type from `mount`. */
export function parseFilesystemType(dfOutput: string, mountOutput: string): string {
  const line = dfOutput.trim().split("\n").at(-1) ?? "";
  const mountPoint = line.match(/^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/)?.[1];
  if (!mountPoint) throw new Error("could not determine the destination mount point");
  for (const entry of mountOutput.split("\n")) {
    const match = entry.match(/^.+ on (.+) \(([^,)]+)[,)]/);
    if (match && match[1] === mountPoint) return match[2].trim();
  }
  throw new Error("could not determine the destination filesystem type");
}

export const nodePromotionIO: PromotionIO = {
  spawn: (command, args, options) => nodeConfinedJobIO.spawn(command, args, options),
  lstat,
  realpath,
  async readdir(path) {
    return readdir(path, { withFileTypes: true });
  },
  readFile: (path) => readFile(path),
  readlink,
  async writeFile(path, data) {
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  },
  async mkdir(path) {
    await mkdir(path, { mode: 0o700 });
  },
  async rm(path) {
    await rm(path, { recursive: true, force: false });
  },
  async freeBytes(path) {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  },
  async filesystemType(path) {
    return parseFilesystemType(await runHostCommand(DF, ["-P", path]), await runHostCommand(MOUNT, []));
  },
  async processStartTime(pid) {
    try {
      const value = (await runHostCommand(PS, ["-p", String(pid), "-o", "lstart="])).trim();
      return value || null;
    } catch {
      return null;
    }
  },
  getuid() {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("promotion requires a POSIX user ID");
    return uid;
  },
  randomId: randomUUID,
};

export class PromotionPreflightError extends Error {}
export class PromotionFailedError extends Error {}
export class InsufficientSpaceError extends Error {}
export class CloneVerificationError extends Error {
  constructor(
    readonly check: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`clone verification failed (${check}): ${message}`, options);
  }
}
export class PromotionCopyBusyError extends Error {}
export class StagingUnresolvedError extends Error {}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exists(io: PromotionIO, path: string): Promise<boolean> {
  try {
    await io.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function ownedRealDirectory(io: PromotionIO, path: string): Promise<FileStat> {
  const info = await io.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a real directory: ${path}`);
  if (info.uid !== io.getuid()) throw new Error(`directory has a foreign owner: ${path}`);
  return info;
}

export interface PromotionMethodOptions {
  /** A same-UID directory on the job area's volume (the operation's job root). */
  sourceParent: string;
  /** The destination's parent (instance root for `.hive.next`, tooling area for staging). */
  destinationParent: string;
  io?: PromotionIO;
}

/**
 * Fixed once per operation at preflight. macOS `cp -c` silently falls back to
 * an ordinary copy when `clonefile(2)` is unsupported (observed on an MS-DOS
 * volume: exit 0), so a successful `cp -c` alone cannot establish cloning.
 * Clone support is therefore classified from the volumes: cross-volume or a
 * non-APFS destination fixes `full-copy`; on a same-volume APFS destination a
 * real `cp -c` probe must succeed, and any other failure fails preflight.
 */
export async function selectPromotionMethod(options: PromotionMethodOptions): Promise<PromotionMethodSelection> {
  const io = options.io ?? nodePromotionIO;
  const source = await ownedRealDirectory(io, options.sourceParent);
  const destination = await ownedRealDirectory(io, options.destinationParent);
  let filesystemType: string;
  try {
    filesystemType = (await io.filesystemType(options.destinationParent)).toLowerCase();
  } catch (error) {
    throw new PromotionPreflightError("could not classify the destination volume for promotion", { cause: error });
  }
  if (source.dev !== destination.dev) return { method: "full-copy", reason: "cross-volume", filesystemType };
  if (filesystemType !== "apfs") return { method: "full-copy", reason: "non-apfs-volume", filesystemType };
  const id = io.randomId();
  const probeSource = resolve(options.sourceParent, `.promotion-probe-${id}`);
  const probeDestination = resolve(options.destinationParent, `.hive-promotion-probe-${id}`);
  try {
    await io.writeFile(probeSource, "promotion-probe\n");
    let result: ConfinedProcessResult;
    try {
      result = await io.spawn(CP, ["-c", probeSource, probeDestination], {
        cwd: options.sourceParent,
        env: commandEnv,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      });
    } catch (error) {
      throw new PromotionPreflightError("APFS clone probe could not run", { cause: error });
    }
    if (result.exitCode !== 0) throw new PromotionPreflightError("APFS clone probe failed on the destination volume");
    return { method: "clone", reason: "apfs-clone", filesystemType };
  } finally {
    for (const path of [probeSource, probeDestination]) {
      if (await exists(io, path).catch(() => false)) await io.rm(path).catch(() => {});
    }
  }
}

/** Sum of regular-file and link sizes; directories are walked without following links. */
export async function measureTree(path: string, io: PromotionIO = nodePromotionIO): Promise<number> {
  const info = await io.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  let total = 0;
  for (const entry of await io.readdir(path)) total += await measureTree(resolve(path, entry.name), io);
  return total;
}

export interface PromotionRecord {
  method: PromotionMethod;
  source: string;
  destination: string;
  state: "intended" | "copying" | "observed" | "failed";
  copyPid: number | null;
  copyStartTime: string | null;
  exitCode: number | null;
  destinationIdentity: { dev: number; ino: number } | null;
  discarded: boolean;
}

export interface PromoteOptions {
  source: string;
  destination: string;
  method: PromotionMethod;
  /** Persist the promotion fence in the operation marker. */
  journal?: (record: PromotionRecord) => Promise<void>;
  timeoutMs?: number;
  io?: PromotionIO;
}

function copyArguments(method: PromotionMethod, source: string, destination: string): string[] {
  // -R recursive, -P preserve symbolic links as links, -p preserve modes/times.
  return method === "clone" ? ["-c", "-R", "-P", "-p", source, destination] : ["-R", "-P", "-p", source, destination];
}

/** Remove a promotion destination without following links. */
export async function discardPromotedTree(
  path: string,
  identity: PromotionRecord["destinationIdentity"],
  io: PromotionIO = nodePromotionIO,
): Promise<boolean> {
  let info: FileStat;
  try {
    info = await io.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new StagingUnresolvedError(`promotion destination became a symbolic link: ${path}`);
  if (info.uid !== io.getuid()) throw new StagingUnresolvedError(`promotion destination has a foreign owner: ${path}`);
  if (identity && (info.dev !== identity.dev || info.ino !== identity.ino)) {
    throw new StagingUnresolvedError(`promotion destination identity changed: ${path}`);
  }
  await io.rm(path);
  return true;
}

/**
 * Copy one settled job output tree into an absent destination with the
 * preflight-fixed method. Any non-zero promotion exit discards the partial
 * destination and fails; the method is never switched mid-operation.
 */
export async function promoteTree(options: PromoteOptions): Promise<PromotionRecord> {
  const io = options.io ?? nodePromotionIO;
  for (const path of [options.source, options.destination]) {
    if (!isAbsolute(path)) throw new Error("promotion paths must be absolute");
  }
  await ownedRealDirectory(io, options.source);
  const parent = dirname(options.destination);
  if ((await io.realpath(parent)) !== parent) throw new Error("promotion destination parent must be canonical");
  if (await exists(io, options.destination)) {
    throw new PromotionFailedError(`promotion destination is occupied: ${options.destination}`);
  }
  if (options.method === "full-copy") {
    const required = await measureTree(options.source, io);
    const margin = Math.max(64 * 1024 * 1024, Math.ceil(required / 10));
    if ((await io.freeBytes(parent)) < required + margin) {
      throw new InsufficientSpaceError("insufficient free space for a full-copy promotion");
    }
  }
  const record: PromotionRecord = {
    method: options.method,
    source: options.source,
    destination: options.destination,
    state: "intended",
    copyPid: null,
    copyStartTime: null,
    exitCode: null,
    destinationIdentity: null,
    discarded: false,
  };
  await options.journal?.({ ...record });
  let copyFence: Promise<void> | null = null;
  let result: ConfinedProcessResult;
  try {
    result = await io.spawn(CP, copyArguments(options.method, options.source, options.destination), {
      cwd: parent,
      env: commandEnv,
      timeoutMs: options.timeoutMs ?? 1_800_000,
      maxOutputBytes: 1024 * 1024,
      onSpawn: (pid) => {
        // Journal the orchestrator's own copy child so re-entry can report busy.
        copyFence = (async () => {
          record.copyPid = pid;
          record.copyStartTime = await io.processStartTime(pid);
          record.state = "copying";
          await options.journal?.({ ...record });
        })();
      },
    });
    if (copyFence) await copyFence;
  } catch (error) {
    if (copyFence) await Promise.resolve(copyFence).catch(() => {});
    log.warn("Promotion copy could not be launched or journaled", { method: options.method });
    record.state = "failed";
    record.discarded = await discardPromotedTree(options.destination, null, io);
    await options.journal?.({ ...record });
    throw new PromotionFailedError("promotion copy could not be launched or journaled", { cause: error });
  }
  record.exitCode = result.exitCode;
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) {
    record.state = "failed";
    record.discarded = await discardPromotedTree(options.destination, null, io);
    await options.journal?.({ ...record });
    log.warn("Promotion copy failed; partial destination discarded", {
      method: options.method,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    throw new PromotionFailedError(`${options.method} promotion exited unsuccessfully; partial destination discarded`);
  }
  const info = await ownedRealDirectory(io, options.destination);
  record.state = "observed";
  record.destinationIdentity = { dev: info.dev, ino: info.ino };
  await options.journal?.({ ...record });
  return record;
}

export const CANDIDATE_REQUIRED_ENTRIES = [
  "pkg/server.min.js",
  "pkg/voice-worker.min.js",
  "pkg/cli.min.js",
  "pkg/mcp",
  "pkg/release.json",
  "npm-shrinkwrap.json",
  "package.json",
] as const;

export interface ReleaseIdentity {
  packageVersion: string;
  sourceRevision: string;
  dependencyLockSha256: string;
}

export function releaseIdentity(release: Release): ReleaseIdentity {
  return {
    packageVersion: release.packageVersion,
    sourceRevision: release.sourceRevision,
    dependencyLockSha256: release.dependencyLockSha256,
  };
}

/** A confined runtime-loading probe mode of the clone's packaged diagnostic. */
export interface RuntimeLoadingProbe {
  mode: string;
  successPrefix: string;
}

/**
 * The offline worker diagnostic (Task 3 Step 2) and the engine validate-only
 * mode (Task 3 Step 2a, S6/S8-owned). Both must print `<prefix> <json>` whose
 * `manifest` names the release identity; exit 0 alone is never a pass.
 */
export const CANDIDATE_RUNTIME_LOADING_PROBES: readonly RuntimeLoadingProbe[] = [
  { mode: "offline", successPrefix: "ARTIFACT_RUNTIME_OK" },
  { mode: "engine-validate", successPrefix: "ENGINE_VALIDATE_OK" },
];

export interface CloneVerificationOptions {
  clone: string;
  /** Archive digest recorded in the marker (tarball path); null for init/resume. */
  archiveSha256: string | null;
  /** Identity decoded from that archive's extraction. */
  expectedRelease: ReleaseIdentity;
  requireClean: boolean;
  requiredEntries?: readonly string[];
  /** `pkg/...` member digests read from the archive (tarball path only). */
  archiveMembers?: ReadonlyMap<string, string>;
  runner: ConfinedJobRunner;
  nodePath: string;
  npmCliPath: string;
  pathEnv: string;
  dependencyTree: boolean;
  runtimeLoading: readonly RuntimeLoadingProbe[];
  io?: PromotionIO;
}

export interface CloneVerification {
  verified: true;
  release: ReleaseIdentity;
  archiveSha256: string | null;
  checks: string[];
  jobs: ConfinedJobResult[];
}

async function listFiles(root: string, directory: string, io: PromotionIO, out: string[]): Promise<void> {
  for (const entry of await io.readdir(directory)) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await listFiles(root, path, io, out);
    else out.push(relative(root, path));
  }
}

async function assertLinksContained(root: string, directory: string, io: PromotionIO): Promise<void> {
  for (const entry of await io.readdir(directory)) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(path), await io.readlink(path));
      if (!inside(root, target))
        throw new CloneVerificationError("containment", `symbolic link escapes clone: ${relative(root, path)}`);
      try {
        const actual = await io.realpath(path);
        if (!inside(root, actual)) {
          throw new CloneVerificationError(
            "containment",
            `symbolic link resolves outside clone: ${relative(root, path)}`,
          );
        }
      } catch (error) {
        if (error instanceof CloneVerificationError) throw error;
        if (errorCode(error) !== "ENOENT") throw error;
      }
    } else if (entry.isDirectory()) {
      await assertLinksContained(root, path, io);
    }
  }
}

function sameIdentity(left: ReleaseIdentity, right: ReleaseIdentity): boolean {
  return (
    left.packageVersion === right.packageVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.dependencyLockSha256 === right.dependencyLockSha256
  );
}

export function parseRuntimeLoadingRecord(stdout: string, successPrefix: string): ReleaseIdentity {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${successPrefix} `));
  if (!line) throw new Error("success record missing");
  const parsed: unknown = JSON.parse(line.slice(successPrefix.length + 1));
  const manifest = (parsed as { manifest?: Partial<ReleaseIdentity> } | null)?.manifest;
  if (
    !manifest ||
    typeof manifest.packageVersion !== "string" ||
    typeof manifest.sourceRevision !== "string" ||
    typeof manifest.dependencyLockSha256 !== "string"
  ) {
    throw new Error("success record has no release identity");
  }
  return {
    packageVersion: manifest.packageVersion,
    sourceRevision: manifest.sourceRevision,
    dependencyLockSha256: manifest.dependencyLockSha256,
  };
}

/** Verify a promoted clone by reading the clone only; any failure throws. */
export async function verifyClone(options: CloneVerificationOptions): Promise<CloneVerification> {
  assertConfinedJobRunner(options.runner);
  const io = options.io ?? nodePromotionIO;
  const clone = options.clone;
  const checks: string[] = [];
  const jobs: ConfinedJobResult[] = [];
  await ownedRealDirectory(io, clone);
  if ((await io.realpath(clone)) !== clone)
    throw new CloneVerificationError("containment", "clone path is not canonical");

  for (const entry of options.requiredEntries ?? CANDIDATE_REQUIRED_ENTRIES) {
    try {
      const info = await io.lstat(resolve(clone, entry));
      if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) throw new Error("not a regular entry");
    } catch (error) {
      throw new CloneVerificationError("required-entries", `missing required entry ${entry}`, { cause: error });
    }
  }
  checks.push("required-entries");

  let release: Release;
  try {
    release = readRelease(clone, options.requireClean);
  } catch (error) {
    throw new CloneVerificationError("manifest-lock", "release manifest or dependency lock is inconsistent", {
      cause: error,
    });
  }
  const identity = releaseIdentity(release);
  if (!sameIdentity(identity, options.expectedRelease)) {
    throw new CloneVerificationError("manifest-lock", "clone release identity differs from the staged archive");
  }
  checks.push("manifest-lock");

  await assertLinksContained(clone, clone, io);
  checks.push("containment");

  if (options.archiveMembers) {
    if (options.archiveSha256 === null || !/^[a-f0-9]{64}$/.test(options.archiveSha256)) {
      throw new CloneVerificationError(
        "archive-members",
        "archive member hashing requires the recorded archive digest",
      );
    }
    const clonePkg: string[] = [];
    await listFiles(clone, resolve(clone, "pkg"), io, clonePkg);
    const expected = [...options.archiveMembers.keys()].filter((path) => path.startsWith("pkg/")).sort();
    if (JSON.stringify(clonePkg.sort()) !== JSON.stringify(expected)) {
      throw new CloneVerificationError("archive-members", "clone pkg/ entries differ from archive members");
    }
    for (const path of expected) {
      if (sha256(await io.readFile(resolve(clone, path))) !== options.archiveMembers.get(path)) {
        throw new CloneVerificationError("archive-members", `clone entry differs from archive member ${path}`);
      }
    }
    checks.push("archive-members");
  }

  if (options.dependencyTree) {
    const job = await options.runner.run("dependency-tree", {
      command: options.nodePath,
      args: [options.npmCliPath, "ls", "--omit=dev", "--all", "--parseable"],
      cwd: clone,
      home: "job",
      pathEnv: options.pathEnv,
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    jobs.push(job);
    try {
      requireJobSuccess(job);
    } catch (error) {
      throw new CloneVerificationError("dependency-tree", "installed dependency tree is inconsistent with the lock", {
        cause: error,
      });
    }
    checks.push("dependency-tree");
  }

  for (const probe of options.runtimeLoading) {
    const job = await options.runner.prepare("runtime-loading");
    // Dummy selectors inside the job directory: no operator secrets, `.env`,
    // Keychain namespace or real instance home is ever named.
    const dummyHome = resolve(job.path, "hive-home");
    const dummyConfig = resolve(dummyHome, "hive.yaml");
    await io.mkdir(dummyHome);
    await io.writeFile(dummyConfig, "instance:\n  id: runtime-validate\n");
    const result = await options.runner.launch(job, {
      command: options.nodePath,
      args: [resolve(clone, "pkg", "voice-worker-diagnostic.min.js"), probe.mode],
      cwd: job.path,
      home: "job",
      pathEnv: options.pathEnv,
      extraEnv: { HIVE_HOME: dummyHome, HIVE_CONFIG: dummyConfig },
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    jobs.push(result);
    try {
      requireJobSuccess(result);
      const reported = parseRuntimeLoadingRecord(result.stdout.toString("utf8"), probe.successPrefix);
      if (!sameIdentity(reported, identity)) throw new Error("reported release identity mismatch");
    } catch (error) {
      throw new CloneVerificationError(`runtime-loading:${probe.mode}`, "runtime loading check did not pass", {
        cause: error,
      });
    }
    checks.push(`runtime-loading:${probe.mode}`);
  }

  return { verified: true, release: identity, archiveSha256: options.archiveSha256, checks, jobs };
}

/**
 * Settlement (spec §5.1): every required job's direct child exited 0 and the
 * clone verified. No census, guardian, receipt or idle-descendant proof.
 */
export function settled(
  jobs: readonly Pick<ConfinedJobResult, "exitCode" | "signal" | "timedOut" | "outputTruncated">[],
  verification: CloneVerification | null,
): boolean {
  return (
    verification?.verified === true &&
    jobs.every((job) => job.exitCode === 0 && job.signal === null && !job.timedOut && !job.outputTruncated)
  );
}

export interface PromoteAndVerifyOptions extends Omit<PromoteOptions, "io"> {
  verification: Omit<CloneVerificationOptions, "clone" | "io">;
  io?: PromotionIO;
}

/** Promote, then verify; a verification failure discards the clone before any signal. */
export async function promoteAndVerify(
  options: PromoteAndVerifyOptions,
): Promise<{ promotion: PromotionRecord; verification: CloneVerification }> {
  assertConfinedJobRunner(options.verification.runner);
  const io = options.io ?? nodePromotionIO;
  const promotion = await promoteTree({ ...options, io });
  try {
    const verification = await verifyClone({ ...options.verification, clone: options.destination, io });
    return { promotion, verification };
  } catch (error) {
    promotion.discarded = await discardPromotedTree(options.destination, promotion.destinationIdentity, io);
    await options.journal?.({ ...promotion });
    throw error;
  }
}

export interface SweepFailure {
  path: string;
  message: string;
}

export interface SweepReport {
  removed: string[];
  failures: SweepFailure[];
}

async function removeEntry(io: PromotionIO, path: string, report: SweepReport): Promise<void> {
  try {
    const info = await io.lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      report.failures.push({ path, message: "not a real directory; left in place" });
      return;
    }
    if (info.uid !== io.getuid()) {
      report.failures.push({ path, message: "foreign owner; left in place" });
      return;
    }
    await io.rm(path);
    report.removed.push(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    report.failures.push({ path, message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Deferred disposal of every leftover `.hive-state/jobs/<operation-id>/` tree
 * except the named live operations. A straggler may still be writing; a failed
 * removal is reported and never fatal.
 */
export async function sweepLeftoverJobs(options: {
  canonicalInstanceHome: string;
  keepOperationIds?: readonly string[];
  io?: PromotionIO;
}): Promise<SweepReport> {
  const io = options.io ?? nodePromotionIO;
  const root = jobsRoot(options.canonicalInstanceHome);
  const report: SweepReport = { removed: [], failures: [] };
  let entries: DirectoryEntry[];
  try {
    const info = await io.lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { removed: [], failures: [{ path: root, message: "job area is not a real directory" }] };
    }
    entries = await io.readdir(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return report;
    return { removed: [], failures: [{ path: root, message: error instanceof Error ? error.message : String(error) }] };
  }
  const keep = new Set(options.keepOperationIds ?? []);
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    await removeEntry(io, resolve(root, entry.name), report);
  }
  if (report.failures.length > 0)
    log.warn("Leftover job directories could not all be removed", { failures: report.failures.length });
  return report;
}

/** Dispose one operation's job directories after it reports its result. */
export async function disposeOperationJobs(options: {
  canonicalInstanceHome: string;
  operationId: string;
  io?: PromotionIO;
}): Promise<SweepReport> {
  const io = options.io ?? nodePromotionIO;
  const report: SweepReport = { removed: [], failures: [] };
  await removeEntry(io, resolve(jobsRoot(options.canonicalInstanceHome), options.operationId), report);
  return report;
}

export function toolingStagingRoot(canonicalInstanceHome: string): string {
  return resolve(canonicalInstanceHome, ".hive-state", "tooling", ".staging");
}

/**
 * Discard every tooling staging sibling. Final-name `tooling/<sha>/` entries
 * live outside `.staging/` and are never touched here.
 */
export async function discardToolingStaging(options: {
  canonicalInstanceHome: string;
  io?: PromotionIO;
}): Promise<SweepReport> {
  const io = options.io ?? nodePromotionIO;
  const root = toolingStagingRoot(options.canonicalInstanceHome);
  const report: SweepReport = { removed: [], failures: [] };
  let entries: DirectoryEntry[];
  try {
    entries = await io.readdir(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return report;
    return { removed: [], failures: [{ path: root, message: error instanceof Error ? error.message : String(error) }] };
  }
  for (const entry of entries) await removeEntry(io, resolve(root, entry.name), report);
  return report;
}

/** The marker's staging facts consumed by reconciliation. */
export interface StagingFacts {
  promotion: PromotionRecord | null;
  cloneVerified: boolean;
}

export interface StagingReconciliation {
  discarded: string[];
  retainedVerifiedClone: string | null;
  jobSweep: SweepReport;
  toolingSweep: SweepReport | null;
}

/**
 * Re-entry after interruption: a live recorded promotion copy returns busy
 * (the orchestrator's own direct child, not descendant accounting); an
 * unverified recorded promotion destination is discarded; leftover job
 * directories are swept non-fatally and never adopted; tooling staging
 * siblings are discarded when requested.
 */
export async function reconcileStaging(options: {
  canonicalInstanceHome: string;
  staging: StagingFacts | null;
  currentOperationId?: string;
  isProcessLive(owner: { pid: number; startTime: string }): Promise<boolean>;
  includeToolingStaging?: boolean;
  io?: PromotionIO;
}): Promise<StagingReconciliation> {
  const io = options.io ?? nodePromotionIO;
  const discarded: string[] = [];
  let retainedVerifiedClone: string | null = null;
  const promotion = options.staging?.promotion ?? null;
  if (promotion) {
    if (!inside(options.canonicalInstanceHome, promotion.destination)) {
      throw new StagingUnresolvedError("recorded promotion destination escapes the instance home");
    }
    if ((promotion.state === "intended" || promotion.state === "copying") && promotion.copyPid !== null) {
      if (promotion.copyStartTime === null) {
        throw new StagingUnresolvedError("recorded promotion copy has no start time to corroborate");
      }
      if (await options.isProcessLive({ pid: promotion.copyPid, startTime: promotion.copyStartTime })) {
        throw new PromotionCopyBusyError("recorded promotion copy is still running");
      }
    }
    if (options.staging?.cloneVerified && promotion.state === "observed") {
      retainedVerifiedClone = (await exists(io, promotion.destination)) ? promotion.destination : null;
    } else if (!promotion.discarded) {
      if (await discardPromotedTree(promotion.destination, promotion.destinationIdentity, io)) {
        discarded.push(promotion.destination);
      }
    }
  }
  const jobSweep = await sweepLeftoverJobs({
    canonicalInstanceHome: options.canonicalInstanceHome,
    keepOperationIds: options.currentOperationId ? [options.currentOperationId] : [],
    io,
  });
  const toolingSweep = options.includeToolingStaging
    ? await discardToolingStaging({ canonicalInstanceHome: options.canonicalInstanceHome, io })
    : null;
  return { discarded, retainedVerifiedClone, jobSweep, toolingSweep };
}
