/**
 * First-adoption bootstrap into durable tooling (KPR-463 spec §3.2, plan chunk
 * 4 Task 9 Step 4d.1 and chunk 5 Task 8 Step 1a.3 / Task 9 Step 4d.1a).
 *
 * Under the ordinary instance lock and the frozen helper:
 *   self-test + promotion method → discard every `.hive-state/tooling/.staging/`
 *   sibling → verify the reviewed archive digest → journaled archive retention
 *   → reuse an existing final-name `tooling/<sha>/` after re-checking it, or:
 *   confined extraction → clone into a fresh install job → confined locked
 *   install → clone into `tooling/.staging/<sha>.<operation-id>/` → tooling
 *   verification subset against that sibling → atomic rename to the absent
 *   final name → tree seal → `BootstrapRecord` registered last.
 *
 * The final name is the only verification marker. Anything under a staging
 * name is partial and is only ever discarded. A final-name entry is never
 * reinstalled, overwritten or renamed away; a failed re-check is unresolved
 * with the entry retained. No service, control, vendor or pilot operation.
 */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { createLogger } from "../logging/logger.js";
import {
  extractAndValidateArtifact,
  installStagedArtifact,
  type ArtifactStagingContext,
  type ResolvedArtifact,
} from "./artifact.js";
import {
  discardPromotedTree,
  discardToolingStaging,
  parseRuntimeLoadingRecord,
  promoteTree,
  releaseIdentity,
  selectPromotionMethod,
  toolingStagingRoot,
  verifyClone,
  type ReleaseIdentity,
} from "./clone-promotion.js";
import {
  ConfinedJobRunner,
  requireJobSuccess,
  runConfinementSelfTest,
  type ConfinedJobRunnerOptions,
  type SelfTestOptions,
} from "./confined-job.js";
import {
  OperationUnresolvedError,
  persistOperation,
  recordStagingJob,
  recordStagingPromotion,
  type AcquiredOperation,
} from "./operation.js";
import {
  buildTreeManifest,
  readRegisteredRecord,
  reconcileRegistration,
  registerRecord,
  registryRoot,
  sealFile,
  sha256Hex,
  verifyTreeSeal,
  type BootstrapRecord,
  type FileSeal,
  type InstanceKey,
  type RecordRef,
  type TreeSeal,
} from "./pilot-records.js";
import { readRelease, type Release } from "./release.js";

const log = createLogger("deployment-bootstrap");

export const BOOTSTRAP_VALIDATED = "BOOTSTRAP_VALIDATED";
/** Fixed tooling validate-only spelling, pinned by tests. */
export const TOOLING_VALIDATE_ARGS = ["deployment-tooling", "validate-only"] as const;
export const TOOLING_VALIDATE_PREFIX = "TOOLING_VALIDATE_OK";
export const TOOLING_REQUIRED_ENTRIES = [
  "pkg/cli.min.js",
  "pkg/release.json",
  "npm-shrinkwrap.json",
  "package.json",
  "node_modules",
] as const;

export class BootstrapUnresolvedError extends OperationUnresolvedError {}
export class BootstrapAbortedError extends Error {}

/** Durable bootstrap work state (chunk 4 Step 4d.1, chunk 5 Task 8 Step 1a.3 Steps 1–2). */
export interface BootstrapWork {
  phase:
    | "preflight"
    | "swept"
    | "archive-retained"
    | "extracted"
    | "installed"
    | "staged"
    | "verified"
    | "renamed"
    | "registering"
    | "finished";
  archiveInput: string;
  reviewedSha256: string;
  reviewedRevision: string;
  sourceHelper: string;
  archiveRoot: { path: string; state: "intended" | "observed"; identity: { dev: number; ino: number } | null } | null;
  archiveCopy: FileSeal | null;
  stagingSibling: string | null;
  verification: { release: ReleaseIdentity; checks: string[] } | null;
  rename: {
    from: string;
    to: string;
    identity: { dev: number; ino: number };
    state: "intended" | "observed";
  } | null;
  finalEntry: TreeSeal | null;
  reused: boolean;
  registration: RecordRef | null;
  outcome: "validated" | "aborted" | null;
}

export function initialBootstrapWork(input: {
  artifact: string;
  sha256: string;
  revision: string;
  sourceHelper: string;
}): BootstrapWork {
  if (!isAbsolute(input.artifact) || !input.artifact.endsWith(".tgz"))
    throw new Error("--artifact must be an absolute .tgz");
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("--sha256 must be the reviewed 64-hex archive digest");
  if (!/^[a-f0-9]{40}$/.test(input.revision)) throw new Error("--revision must be the reviewed 40-hex revision");
  if (!isAbsolute(input.sourceHelper)) throw new Error("source helper path must be absolute");
  return {
    phase: "preflight",
    archiveInput: input.artifact,
    reviewedSha256: input.sha256,
    reviewedRevision: input.revision,
    sourceHelper: input.sourceHelper,
    archiveRoot: null,
    archiveCopy: null,
    stagingSibling: null,
    verification: null,
    rename: null,
    finalEntry: null,
    reused: false,
    registration: null,
    outcome: null,
  };
}

export interface BootstrapPaths {
  toolingRoot: string;
  stagingRoot: string;
  finalEntry: string;
  stagingSibling: string;
  bootstrapRoot: string;
  archiveRoot: string;
  archiveCopy: string;
}

export function bootstrapPaths(canonicalHome: string, sha: string, operationId: string): BootstrapPaths {
  const toolingRoot = resolve(canonicalHome, ".hive-state", "tooling");
  const bootstrapRoot = resolve(canonicalHome, ".hive-state", "bootstrap");
  return {
    toolingRoot,
    stagingRoot: toolingStagingRoot(canonicalHome),
    finalEntry: resolve(toolingRoot, sha),
    stagingSibling: resolve(toolingStagingRoot(canonicalHome), `${sha}.${operationId}`),
    bootstrapRoot,
    archiveRoot: resolve(bootstrapRoot, sha),
    archiveCopy: resolve(bootstrapRoot, sha, "candidate.tgz"),
  };
}

export interface BootstrapResult {
  status: typeof BOOTSTRAP_VALIDATED;
  packageRoot: string;
  recordPath: string;
  archiveSha256: string;
  sourceRevision: string;
}

/** Operating-system boundaries; production uses the real confined launcher. */
export interface BootstrapDeps {
  nodePath: string;
  npmCliPath: string;
  pathEnv: string;
  invokingHome: string;
  now?: () => number;
  selfTest?: (options: SelfTestOptions) => ReturnType<typeof runConfinementSelfTest>;
  runnerOptions?: Pick<ConfinedJobRunnerOptions, "io">;
  promotionIO?: ArtifactStagingContext["promotionIO"];
  selectMethod?: typeof selectPromotionMethod;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(path: string, uid: number): Promise<{ dev: number; ino: number }> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new BootstrapUnresolvedError(`bootstrap state directory is not an owned private directory: ${path}`);
  }
  return { dev: info.dev, ino: info.ino };
}

function strip(seal: FileSeal & { bytes?: Buffer }): FileSeal {
  const { path, realpath: real, uid, mode, dev, ino, size, sha256 } = seal;
  return { path, realpath: real, uid, mode, dev, ino, size, sha256 };
}

function instanceOf(operation: AcquiredOperation, configPath: string): InstanceKey {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("bootstrap requires a POSIX user ID");
  return {
    canonicalHome: operation.record.canonicalHome,
    configPath,
    instanceId: operation.record.instanceId,
    uid,
  };
}

function work(operation: AcquiredOperation): BootstrapWork {
  const state = operation.record.bootstrap;
  if (operation.record.workKind !== "bootstrap" || !state) throw new Error("bootstrap requires bootstrap work");
  return state;
}

async function setPhase(operation: AcquiredOperation, phase: BootstrapWork["phase"]): Promise<void> {
  work(operation).phase = phase;
  await persistOperation(operation);
}

async function stagingContext(
  operation: AcquiredOperation,
  deps: BootstrapDeps,
): Promise<{ context: ArtifactStagingContext; runner: ConfinedJobRunner }> {
  const home = operation.record.canonicalHome;
  const selfTest =
    operation.record.staging.selfTest ??
    (await (deps.selfTest ?? runConfinementSelfTest)({
      canonicalInstanceHome: home,
      operationId: operation.record.id,
      nodePath: deps.nodePath,
      io: deps.runnerOptions?.io,
    }));
  operation.record.staging.selfTest = selfTest;
  await persistOperation(operation);
  const uid = instanceOf(operation, "/").uid;
  await privateDirectory(resolve(home, ".hive-state"), uid);
  await privateDirectory(resolve(home, ".hive-state", "jobs"), uid);
  await privateDirectory(resolve(home, ".hive-state", "jobs", operation.record.id), uid);
  await privateDirectory(resolve(home, ".hive-state", "tooling"), uid);
  await privateDirectory(toolingStagingRoot(home), uid);
  if (!operation.record.staging.promotionMethod) {
    operation.record.staging.promotionMethod = await (deps.selectMethod ?? selectPromotionMethod)({
      sourceParent: resolve(home, ".hive-state", "jobs", operation.record.id),
      destinationParent: toolingStagingRoot(home),
      io: deps.promotionIO,
    });
    await persistOperation(operation);
  }
  const runner = new ConfinedJobRunner({
    canonicalInstanceHome: home,
    operationId: operation.record.id,
    selfTest,
    journal: (record) => recordStagingJob(operation, record),
    io: deps.runnerOptions?.io,
  });
  return {
    runner,
    context: {
      runner,
      nodePath: deps.nodePath,
      npmCliPath: deps.npmCliPath,
      invokingHome: deps.invokingHome,
      pathEnv: deps.pathEnv,
      archiveDirectory: bootstrapPaths(home, work(operation).reviewedSha256, operation.record.id).archiveRoot,
      promotionMethod: operation.record.staging.promotionMethod.method,
      promotionIO: deps.promotionIO,
    },
  };
}

/** Journaled in-process copy of the reviewed archive; never a job output. */
async function ensureRetainedArchive(operation: AcquiredOperation): Promise<FileSeal> {
  const state = work(operation);
  const home = operation.record.canonicalHome;
  const paths = bootstrapPaths(home, state.reviewedSha256, operation.record.id);
  const uid = instanceOf(operation, "/").uid;
  await privateDirectory(paths.bootstrapRoot, uid);
  if (!state.archiveRoot) {
    state.archiveRoot = { path: paths.archiveRoot, state: "intended", identity: null };
    await persistOperation(operation);
  }
  const root = await privateDirectory(paths.archiveRoot, uid);
  if (state.archiveRoot.state === "intended") {
    state.archiveRoot = { path: paths.archiveRoot, state: "observed", identity: root };
    if (!operation.record.retainedPaths.includes(paths.archiveRoot))
      operation.record.retainedPaths.push(paths.archiveRoot);
    await persistOperation(operation);
  }
  if (await exists(paths.archiveCopy)) {
    const retained = await sealFile(paths.archiveCopy, { uid });
    if (retained.sha256 !== state.reviewedSha256) {
      throw new BootstrapUnresolvedError("retained archive copy does not match the reviewed digest; retained");
    }
    state.archiveCopy = strip(retained);
    await persistOperation(operation);
    return state.archiveCopy;
  }
  const input = await lstat(state.archiveInput);
  if (!input.isFile() || input.isSymbolicLink())
    throw new BootstrapAbortedError("artifact must be a regular .tgz file");
  const source = await sealFile(state.archiveInput, { uid, allowRoot: true });
  if (source.sha256 !== state.reviewedSha256)
    throw new BootstrapAbortedError("artifact digest differs from the reviewed SHA-256");
  const temporary = `${paths.archiveCopy}.${operation.record.id}.partial`;
  await copyFile(state.archiveInput, temporary, constants.COPYFILE_EXCL);
  const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const copied = await sealFile(temporary, { uid });
  if (copied.sha256 !== state.reviewedSha256) throw new BootstrapAbortedError("archive copy digest mismatch");
  await rename(temporary, paths.archiveCopy);
  await fsyncDirectory(paths.archiveRoot);
  state.archiveCopy = strip(await sealFile(paths.archiveCopy, { uid }));
  await setPhase(operation, "archive-retained");
  return state.archiveCopy;
}

/** Tooling validate-only check: the packaged CLI reports its own release identity against a dummy HIVE_HOME. */
async function toolingValidateOnly(
  runner: ConfinedJobRunner,
  entry: string,
  deps: Pick<BootstrapDeps, "nodePath" | "pathEnv">,
  expected: ReleaseIdentity,
): Promise<void> {
  const job = await runner.prepare("tooling-validate");
  const dummyHome = resolve(job.path, "hive-home");
  await mkdir(dummyHome, { mode: 0o700 });
  const result = await runner.launch(job, {
    command: deps.nodePath,
    args: [resolve(entry, "pkg", "cli.min.js"), ...TOOLING_VALIDATE_ARGS],
    cwd: job.path,
    home: "job",
    pathEnv: deps.pathEnv,
    extraEnv: { HIVE_HOME: dummyHome, HIVE_CONFIG: resolve(dummyHome, "hive.yaml") },
    timeoutMs: 120_000,
    maxOutputBytes: 1024 * 1024,
  });
  requireJobSuccess(result);
  const reported = parseRuntimeLoadingRecord(result.stdout.toString("utf8"), TOOLING_VALIDATE_PREFIX);
  if (
    reported.packageVersion !== expected.packageVersion ||
    reported.sourceRevision !== expected.sourceRevision ||
    reported.dependencyLockSha256 !== expected.dependencyLockSha256
  ) {
    throw new BootstrapAbortedError("tooling validate-only reported another release identity");
  }
}

/** Read `package/pkg/release.json` from the retained archive whose digest names the entry. */
async function archivedReleaseBytes(runner: ConfinedJobRunner, archive: FileSeal, pathEnv: string): Promise<Buffer> {
  const result = requireJobSuccess(
    await runner.run("member-read", {
      command: "/usr/bin/tar",
      args: ["-xOzf", archive.path, "package/pkg/release.json"],
      home: "job",
      pathEnv,
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
    }),
  );
  return result.stdout;
}

/**
 * Re-check an existing final-name entry: required entries, strict release
 * manifest/lock/shrinkwrap consistency, reviewed revision, release bytes equal
 * to the retained archive's member, and (when registered) its tree seal.
 */
export async function recheckFinalEntry(input: {
  entry: string;
  reviewedRevision: string;
  archive: FileSeal;
  runner: ConfinedJobRunner;
  pathEnv: string;
  record: BootstrapRecord | null;
  uid: number;
}): Promise<Release> {
  const { entry } = input;
  try {
    const info = await lstat(entry);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== input.uid || (await realpath(entry)) !== entry) {
      throw new Error("final-name entry is not an owned canonical directory");
    }
    for (const required of TOOLING_REQUIRED_ENTRIES) {
      const item = await lstat(resolve(entry, required));
      if (item.isSymbolicLink() || !(item.isFile() || item.isDirectory())) throw new Error(`missing ${required}`);
    }
    const release = readRelease(entry, true);
    if (release.sourceRevision !== input.reviewedRevision) throw new Error("release revision differs from the review");
    const manifest = await sealFile(resolve(entry, "pkg", "release.json"), { uid: input.uid });
    const archived = await archivedReleaseBytes(input.runner, input.archive, input.pathEnv);
    if (sha256Hex(archived) !== manifest.sha256) throw new Error("release manifest differs from the archive naming it");
    if (input.record) {
      if (input.record.archive.sha256 !== basename(entry)) throw new Error("bootstrap record names another archive");
      await verifyTreeSeal(input.record.packageRoot, { uid: input.uid, closureRoots: [entry] });
    }
    return release;
  } catch (error) {
    throw new BootstrapUnresolvedError(
      `BOOTSTRAP_TOOLING_RECHECK_FAILED: final-name entry retained: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** A committed bootstrap record for this archive digest, if any (strict reader only). */
export async function findBootstrapRecord(
  instance: InstanceKey,
  archiveSha256: string,
): Promise<{ record: BootstrapRecord; selector: string; reference: RecordRef } | null> {
  let names: string[];
  try {
    names = await readdir(registryRoot(instance.canonicalHome));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const found: { record: BootstrapRecord; selector: string; reference: RecordRef }[] = [];
  for (const name of names.sort()) {
    const selector = resolve(registryRoot(instance.canonicalHome), name, "payload.json");
    try {
      const read = await readRegisteredRecord<BootstrapRecord>(selector, { instance, kind: "bootstrap" });
      if (read.payload.archive.sha256 === archiveSha256) {
        found.push({ record: read.payload, selector, reference: read.reference });
      }
    } catch {
      // Other kinds, incomplete or foreign entries are never selectable here.
    }
  }
  return found.at(-1) ?? null;
}

async function registerBootstrap(
  operation: AcquiredOperation,
  instance: InstanceKey,
  entry: string,
  release: Release,
  deps: BootstrapDeps,
): Promise<{ selector: string; reference: RecordRef }> {
  const state = work(operation);
  const uid = instance.uid;
  await setPhase(operation, "registering");
  const manifest = await buildTreeManifest(entry, { uid, closureRoots: [entry] });
  const info = await lstat(entry);
  const seal = async (path: string, allowRoot = false) => strip(await sealFile(path, { uid, allowRoot }));
  const archive = state.archiveCopy ?? (await ensureRetainedArchive(operation));
  const tools = {
    helper: await seal(resolve(entry, "pkg", "deploy.min.js")),
    probe: await seal(resolve(entry, "pkg", "runtime-probe.min.js")),
    diagnostic: await seal(resolve(entry, "pkg", "voice-worker-diagnostic.min.js")),
    node: await seal(deps.nodePath, true),
    npm: await seal(deps.npmCliPath, true),
  };
  const result = await registerRecord({
    operation,
    instance,
    kind: "bootstrap",
    files: [{ name: "package-root.manifest", bytes: manifest }],
    now: deps.now,
    buildPayload: ({ id, files }) => {
      const packageRoot: TreeSeal = {
        path: entry,
        realpath: entry,
        uid: info.uid,
        dev: info.dev,
        ino: info.ino,
        manifest: files["package-root.manifest"],
      };
      state.finalEntry = packageRoot;
      return {
        schemaVersion: 1,
        kind: "bootstrap",
        id,
        instance,
        createdAt: (deps.now ?? Date.now)(),
        archive,
        packageRoot,
        release,
        ...tools,
      } satisfies BootstrapRecord;
    },
  });
  state.registration = result.reference;
  await persistOperation(operation);
  return result;
}

async function finish(
  operation: AcquiredOperation,
  entry: string,
  selector: string,
  release: Release,
): Promise<BootstrapResult> {
  const state = work(operation);
  state.outcome = "validated";
  operation.record.resolution = "healthy";
  await setPhase(operation, "finished");
  log.info("Bootstrap tooling validated", { reused: state.reused });
  return {
    status: BOOTSTRAP_VALIDATED,
    packageRoot: entry,
    recordPath: selector,
    archiveSha256: state.reviewedSha256,
    sourceRevision: release.sourceRevision,
  };
}

/** Execute the bootstrap contract for an acquired, frozen bootstrap operation. */
export async function runBootstrap(
  operation: AcquiredOperation,
  options: { configPath: string },
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const state = work(operation);
  const home = operation.record.canonicalHome;
  const instance = instanceOf(operation, options.configPath);
  const paths = bootstrapPaths(home, state.reviewedSha256, operation.record.id);
  const { runner, context } = await stagingContext(operation, deps);

  // Unconditional sweep: only staging siblings, never a final-name entry.
  const swept = await discardToolingStaging({ canonicalInstanceHome: home, io: deps.promotionIO });
  operation.record.staging.sweepFailures.push(...swept.failures);
  await setPhase(operation, "swept");

  const archive = await ensureRetainedArchive(operation);

  if (await exists(paths.finalEntry)) {
    const registered = await findBootstrapRecord(instance, state.reviewedSha256);
    const release = await recheckFinalEntry({
      entry: paths.finalEntry,
      reviewedRevision: state.reviewedRevision,
      archive,
      runner,
      pathEnv: deps.pathEnv,
      record: registered?.record ?? null,
      uid: instance.uid,
    });
    const helper = await sealFile(resolve(paths.finalEntry, "pkg", "deploy.min.js"), { uid: instance.uid });
    if (helper.sha256 !== operation.record.toolSha256) {
      throw new BootstrapAbortedError("bootstrap helper is not the final-name entry's pkg/deploy.min.js");
    }
    state.reused = true;
    await persistOperation(operation);
    const selector = registered
      ? registered.selector
      : (await registerBootstrap(operation, instance, paths.finalEntry, release, deps)).selector;
    if (registered) {
      state.registration = registered.reference;
      state.finalEntry = registered.record.packageRoot;
    }
    return finish(operation, paths.finalEntry, selector, release);
  }

  const artifact: ResolvedArtifact = {
    archivePath: archive.path,
    archiveSha256: archive.sha256,
    source: { kind: "local", path: archive.path },
  };
  const extracted = await extractAndValidateArtifact(artifact, context, true);
  if (extracted.release.sourceRevision !== state.reviewedRevision) {
    throw new BootstrapAbortedError("archive release revision differs from the reviewed revision");
  }
  // The source helper that was frozen must be this archive's own helper.
  if (extracted.archiveMembers.get("pkg/deploy.min.js") !== operation.record.toolSha256) {
    throw new BootstrapAbortedError("bootstrap helper is not the reviewed archive's pkg/deploy.min.js");
  }
  await setPhase(operation, "extracted");
  const installed = await installStagedArtifact(extracted, context);
  await setPhase(operation, "installed");

  if (await exists(paths.stagingSibling)) throw new BootstrapUnresolvedError("tooling staging sibling already exists");
  state.stagingSibling = paths.stagingSibling;
  await persistOperation(operation);
  const promotion = await promoteTree({
    source: installed.root,
    destination: paths.stagingSibling,
    method: context.promotionMethod,
    journal: (record) => recordStagingPromotion(operation, record),
    io: deps.promotionIO,
  });
  await setPhase(operation, "staged");

  const expected = releaseIdentity(extracted.release);
  try {
    const verification = await verifyClone({
      clone: paths.stagingSibling,
      archiveSha256: archive.sha256,
      expectedRelease: expected,
      requireClean: true,
      requiredEntries: TOOLING_REQUIRED_ENTRIES,
      runner,
      nodePath: deps.nodePath,
      npmCliPath: deps.npmCliPath,
      pathEnv: deps.pathEnv,
      dependencyTree: true,
      runtimeLoading: [],
      io: deps.promotionIO,
    });
    await toolingValidateOnly(runner, paths.stagingSibling, deps, expected);
    state.verification = { release: expected, checks: [...verification.checks, "tooling-validate-only"] };
    operation.record.staging.cloneVerified = true;
    operation.record.staging.candidateRelease = expected;
    await setPhase(operation, "verified");
  } catch (error) {
    promotion.discarded = await discardPromotedTree(
      paths.stagingSibling,
      promotion.destinationIdentity,
      deps.promotionIO,
    );
    await recordStagingPromotion(operation, promotion);
    throw error;
  }

  // Atomic rename to the absent final name under the lock.
  if (await exists(paths.finalEntry))
    throw new BootstrapUnresolvedError("final-name tooling entry appeared concurrently");
  const sibling = await lstat(paths.stagingSibling);
  state.rename = {
    from: paths.stagingSibling,
    to: paths.finalEntry,
    identity: { dev: sibling.dev, ino: sibling.ino },
    state: "intended",
  };
  await persistOperation(operation);
  await rename(paths.stagingSibling, paths.finalEntry);
  await fsyncDirectory(paths.toolingRoot);
  await fsyncDirectory(paths.stagingRoot);
  const renamed = await lstat(paths.finalEntry);
  if (renamed.dev !== sibling.dev || renamed.ino !== sibling.ino) {
    throw new BootstrapUnresolvedError("renamed tooling entry identity could not be observed");
  }
  state.rename.state = "observed";
  if (!operation.record.retainedPaths.includes(paths.finalEntry)) operation.record.retainedPaths.push(paths.finalEntry);
  await setPhase(operation, "renamed");

  const release = readRelease(paths.finalEntry, true);
  const { selector } = await registerBootstrap(operation, instance, paths.finalEntry, release, deps);
  return finish(operation, paths.finalEntry, selector, release);
}

/** Record an aborted bootstrap outcome (staging siblings are discarded by reconciliation or the next run). */
export async function abortBootstrap(operation: AcquiredOperation): Promise<void> {
  const state = work(operation);
  if (state.outcome !== null) return;
  state.outcome = "aborted";
  operation.record.resolution = "deferred";
  await persistOperation(operation);
}

export interface BootstrapReconcileDeps extends BootstrapDeps {
  configPath: string;
  isProcessLive(owner: { pid: number; startTime: string }): Promise<boolean>;
}

/**
 * Mode-specific crash recovery (chunk 5 Task 8 Step 1a.3 Step 4 bootstrap
 * rows). Before the final-name rename: discard staging siblings, sweep job
 * directories (failures reported), retain the reviewed input and registry
 * drafts, persist `aborted`. After the rename: re-check the final-name entry,
 * attach a committed registration from its durable intent or register one from
 * the re-checked entry, persist `validated`. Never reinstalls over or renames
 * away a final-name entry. No service calls.
 */
export async function reconcileBootstrap(
  operation: AcquiredOperation,
  deps: BootstrapReconcileDeps,
): Promise<Record<string, unknown>> {
  const state = work(operation);
  const home = operation.record.canonicalHome;
  const instance = instanceOf(operation, deps.configPath);
  const paths = bootstrapPaths(home, state.reviewedSha256, operation.record.id);
  if (operation.record.signalsBegun !== false) throw new BootstrapUnresolvedError("bootstrap work cannot signal");
  const promotion = operation.record.staging.promotion;
  if (promotion && (promotion.state === "intended" || promotion.state === "copying") && promotion.copyPid !== null) {
    if (promotion.copyStartTime === null) throw new BootstrapUnresolvedError("promotion copy identity unknown");
    if (await deps.isProcessLive({ pid: promotion.copyPid, startTime: promotion.copyStartTime })) {
      throw new OperationUnresolvedError("BUSY: recorded tooling promotion copy is still running");
    }
  }
  let renamed = false;
  if (state.rename) {
    const destination = await lstat(paths.finalEntry).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (destination) {
      if (destination.dev !== state.rename.identity.dev || destination.ino !== state.rename.identity.ino) {
        throw new BootstrapUnresolvedError("final-name entry identity differs from the recorded rename");
      }
      renamed = true;
    } else if (state.rename.state === "observed") {
      throw new BootstrapUnresolvedError("recorded renamed tooling entry is missing");
    }
  }
  const sweep = await discardToolingStaging({ canonicalInstanceHome: home, io: deps.promotionIO });
  operation.record.staging.sweepFailures.push(...sweep.failures);
  if (promotion && !renamed) {
    promotion.discarded = true;
    operation.record.staging.cloneVerified = false;
  }
  await persistOperation(operation);

  if (!renamed) {
    for (const fence of operation.record.registrations ?? []) {
      const outcome = await reconcileRegistration(fence, instance);
      if (outcome.outcome === "unresolved") throw new BootstrapUnresolvedError(`registration: ${outcome.reason}`);
      if (outcome.outcome !== "committed") fence.state = "aborted";
    }
    state.outcome = "aborted";
    operation.record.resolution = "deferred";
    await persistOperation(operation);
    return { outcome: "aborted", sweepFailures: sweep.failures.length };
  }

  state.rename!.state = "observed";
  await persistOperation(operation);
  const { runner } = await stagingContext(operation, deps);
  const archive = state.archiveCopy ?? (await ensureRetainedArchive(operation));
  let committed: RecordRef | null = null;
  for (const fence of operation.record.registrations ?? []) {
    const outcome = await reconcileRegistration(fence, instance);
    if (outcome.outcome === "unresolved") throw new BootstrapUnresolvedError(`registration: ${outcome.reason}`);
    if (outcome.outcome === "committed") {
      fence.state = "committed";
      fence.reference = outcome.reference;
      committed = outcome.reference;
    } else {
      fence.state = "aborted";
    }
  }
  await persistOperation(operation);
  const registered = committed
    ? await readRegisteredRecord<BootstrapRecord>(resolve(registryRoot(home), committed.id, "payload.json"), {
        instance,
        kind: "bootstrap",
        expected: committed,
      })
    : null;
  const release = await recheckFinalEntry({
    entry: paths.finalEntry,
    reviewedRevision: state.reviewedRevision,
    archive,
    runner,
    pathEnv: deps.pathEnv,
    record: registered?.payload ?? null,
    uid: instance.uid,
  });
  const selector = registered
    ? registered.selector
    : (await registerBootstrap(operation, instance, paths.finalEntry, release, deps)).selector;
  if (registered) state.registration = registered.reference;
  const result = await finish(operation, paths.finalEntry, selector, release);
  // Historical validated tooling only; never reported as a successful new bootstrap command.
  return {
    outcome: "validated",
    packageRoot: result.packageRoot,
    recordPath: result.recordPath,
    archiveSha256: result.archiveSha256,
    sourceRevision: result.sourceRevision,
  };
}
