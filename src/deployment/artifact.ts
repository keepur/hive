/**
 * Candidate artifact staging (KPR-463 plan lifecycle Task 8 Step 3, chunk 5
 * Task 8 Step 1a.3). Fetch, archive listing/member reads, extraction, `npm ci`
 * and the candidate config probe run only as confined jobs in single-use job
 * directories; `.hive.next` is written only by clone promotion after the
 * install job's direct child exits 0, and is verified before any service
 * signal. There is no unconfined subprocess fallback for an artifact job.
 */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readRelease, sha256, type Release } from "./release.js";
import {
  assertConfinedJobRunner,
  requireJobSuccess,
  type ConfinedJobRunner,
  type ConfinedJobResult,
} from "./confined-job.js";
import {
  CANDIDATE_RUNTIME_LOADING_PROBES,
  nodePromotionIO,
  promoteAndVerify,
  promoteTree,
  releaseIdentity,
  type CloneVerification,
  type PromotionIO,
  type PromotionMethod,
  type PromotionRecord,
  type RuntimeLoadingProbe,
} from "./clone-promotion.js";

export const TAR = "/usr/bin/tar";

/** In-process filesystem effects (archive hashing and copying are not artifact jobs). */
export interface ArtifactIO {
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  mkdir(path: string, options: { recursive?: boolean; mode: number }): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  copyExclusive(from: string, to: string): Promise<void>;
}

export const nodeArtifactIO: ArtifactIO = {
  lstat,
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async readFile(path) {
    return readFile(path);
  },
  realpath,
  async copyExclusive(from, to) {
    await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  },
};

/** Everything an artifact entrypoint needs to stage through confined jobs. */
export interface ArtifactStagingContext {
  runner: ConfinedJobRunner;
  /** Recorded Node executable. */
  nodePath: string;
  /** Sealed npm CLI script run by the recorded Node. */
  npmCliPath: string;
  /** Read-only HOME for fetch/install (npm writes are redirected into the job). */
  invokingHome: string;
  pathEnv: string;
  /** Operation-owned directory holding the retained archive clone. */
  archiveDirectory: string;
  /** Fixed at preflight for the whole operation. */
  promotionMethod: PromotionMethod;
  io?: ArtifactIO;
  promotionIO?: PromotionIO;
}

export interface ArtifactSelector {
  tag?: string;
  artifact?: string;
}

export interface ResolvedArtifact {
  /** The operation's retained archive clone; later jobs read only this path. */
  archivePath: string;
  archiveSha256: string;
  source: { kind: "registry"; selector: string; fetchJobId: string } | { kind: "local"; path: string };
}

function validateContext(context: ArtifactStagingContext | undefined): ArtifactStagingContext {
  assertConfinedJobRunner(context?.runner);
  for (const [name, path] of [
    ["node", context.nodePath],
    ["npm CLI", context.npmCliPath],
    ["HOME", context.invokingHome],
    ["archive directory", context.archiveDirectory],
  ] as const) {
    if (!isAbsolute(path)) throw new Error(`${name} path must be absolute for artifact staging`);
  }
  if (context.promotionMethod !== "clone" && context.promotionMethod !== "full-copy") {
    throw new Error("artifact staging requires the preflight promotion method");
  }
  return context;
}

function normalizedTag(tag: string | undefined): string {
  const selected = (tag ?? "latest").trim();
  if (!selected || selected.includes("/") || /\s/.test(selected)) throw new Error("invalid release tag");
  return selected === "latest" ? selected : selected.replace(/^v/, "");
}

function parsePackJson(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length !== 1 || !values[0] || typeof values[0] !== "object") {
    throw new Error("npm pack must produce exactly one archive");
  }
  const filename = (values[0] as { filename?: unknown }).filename;
  if (typeof filename !== "string" || filename.length === 0 || basename(filename) !== filename) {
    throw new Error("npm pack returned an unsafe archive filename");
  }
  return filename;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function regularArchive(path: string, io: ArtifactIO): Promise<string> {
  const selected = await io.lstat(path);
  if (!selected.isFile() || selected.isSymbolicLink()) {
    throw new Error("artifact must be a regular .tgz file");
  }
  const canonical = await io.realpath(path);
  const info = await io.lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || !canonical.endsWith(".tgz")) {
    throw new Error("artifact must be a regular .tgz file");
  }
  return canonical;
}

async function retainArchive(source: string, context: ArtifactStagingContext, io: ArtifactIO) {
  await io.mkdir(context.archiveDirectory, { recursive: true, mode: 0o700 });
  const retained = resolve(context.archiveDirectory, basename(source));
  await io.copyExclusive(source, retained);
  const archivePath = await regularArchive(retained, io);
  return { archivePath, archiveSha256: sha256(await io.readFile(archivePath)) };
}

/**
 * Resolve exactly one archive. A registry selector runs `npm pack` as a
 * confined fetch job; either way the archive is cloned into the operation
 * directory and its digest is recorded from that clone. No BUILD_DIR fallback.
 */
export async function resolveArtifact(
  selector: ArtifactSelector,
  context: ArtifactStagingContext,
): Promise<ResolvedArtifact> {
  const staging = validateContext(context);
  const io = staging.io ?? nodeArtifactIO;
  if (selector.artifact !== undefined && selector.tag !== undefined) {
    throw new Error("--artifact and --tag are mutually exclusive");
  }
  if (selector.artifact !== undefined) {
    if (!isAbsolute(selector.artifact)) throw new Error("--artifact must be an absolute path");
    const source = await regularArchive(selector.artifact, io);
    const retained = await retainArchive(source, staging, io);
    return { ...retained, source: { kind: "local", path: source } };
  }
  const selected = normalizedTag(selector.tag);
  const job = await staging.runner.prepare("fetch");
  const result = requireJobSuccess(
    await staging.runner.launch(job, {
      command: staging.nodePath,
      args: [staging.npmCliPath, "pack", `@keepur/hive@${selected}`, "--json", "--pack-destination", job.path],
      home: staging.invokingHome,
      pathEnv: staging.pathEnv,
      timeoutMs: 120_000,
    }),
  );
  const fetched = await regularArchive(resolve(job.path, parsePackJson(result.stdout.toString("utf8"))), io);
  if (!contained(job.path, fetched)) throw new Error("npm pack archive escaped its job directory");
  const retained = await retainArchive(fetched, staging, io);
  return { ...retained, source: { kind: "registry", selector: selected, fetchJobId: job.jobId } };
}

const forbiddenOperatorMember =
  /^(?:hive(?:-[^/]*)?\.yaml|\.env(?:-[^/]*)?|agents|plugins|skills|logs|\.hive-state)(?:\/|$)/;

export function validateArchiveMembers(namesOutput: string, detailOutput: string): string[] {
  const members = namesOutput.split("\n").filter(Boolean);
  if (members.length === 0) throw new Error("artifact archive is empty");
  for (const member of members) {
    if (
      !member.startsWith("package/") ||
      member.startsWith("/") ||
      member.includes("\\") ||
      member.split("/").includes("..")
    ) {
      throw new Error(`unsafe archive member: ${member}`);
    }
    const packageRelative = member.slice("package/".length);
    if (forbiddenOperatorMember.test(packageRelative)) {
      throw new Error(`artifact contains operator state: ${member}`);
    }
  }
  const details = detailOutput.split("\n").filter(Boolean);
  if (details.length !== members.length) throw new Error("archive detail listing does not match member listing");
  for (const detail of details) {
    const kind = detail[0];
    if (kind !== "-" && kind !== "d") throw new Error("archive links and special members are rejected");
  }
  return members;
}

export interface ExtractedArtifact {
  /** Extraction output inside its (never promoted) job directory. */
  root: string;
  release: Release;
  archiveSha256: string;
  /** `pkg/...` member digests read from the retained archive clone. */
  archiveMembers: ReadonlyMap<string, string>;
  jobs: ConfinedJobResult[];
}

async function tarJob(
  context: ArtifactStagingContext,
  kind: "member-list" | "member-read",
  args: readonly string[],
  maxOutputBytes: number,
): Promise<ConfinedJobResult> {
  return requireJobSuccess(
    await context.runner.run(kind, {
      command: TAR,
      args,
      home: "job",
      pathEnv: context.pathEnv,
      timeoutMs: 120_000,
      maxOutputBytes,
    }),
  );
}

/**
 * List and validate archive members, read Hive-owned `pkg/` member digests,
 * then extract into a fresh job directory. Never writes `.hive.next`.
 */
export async function extractAndValidateArtifact(
  artifact: ResolvedArtifact,
  context: ArtifactStagingContext,
  requireClean: boolean,
): Promise<ExtractedArtifact> {
  const staging = validateContext(context);
  const io = staging.io ?? nodeArtifactIO;
  if (sha256(await io.readFile(artifact.archivePath)) !== artifact.archiveSha256) {
    throw new Error("retained archive digest changed before extraction");
  }
  const jobs: ConfinedJobResult[] = [];
  const names = await tarJob(staging, "member-list", ["-tzf", artifact.archivePath], 20 * 1024 * 1024);
  const details = await tarJob(staging, "member-list", ["-tvzf", artifact.archivePath], 20 * 1024 * 1024);
  jobs.push(names, details);
  const members = validateArchiveMembers(names.stdout.toString("utf8"), details.stdout.toString("utf8"));
  const detailLines = details.stdout.toString("utf8").split("\n").filter(Boolean);
  const archiveMembers = new Map<string, string>();
  for (const [index, member] of members.entries()) {
    if (!member.startsWith("package/pkg/") || detailLines[index]?.[0] !== "-") continue;
    const read = await tarJob(staging, "member-read", ["-xOzf", artifact.archivePath, member], 128 * 1024 * 1024);
    jobs.push(read);
    archiveMembers.set(member.slice("package/".length), sha256(read.stdout));
  }
  const job = await staging.runner.prepare("extract");
  const output = resolve(job.path, "package");
  await io.mkdir(output, { mode: 0o700 });
  const extraction = requireJobSuccess(
    await staging.runner.launch(job, {
      command: TAR,
      args: ["-xzf", artifact.archivePath, "--strip-components=1", "-C", output],
      home: "job",
      pathEnv: staging.pathEnv,
      timeoutMs: 120_000,
    }),
  );
  jobs.push(extraction);
  const root = await io.realpath(output);
  if (root !== output) throw new Error("extraction output changed identity");
  return {
    root,
    release: readRelease(root, requireClean),
    archiveSha256: artifact.archiveSha256,
    archiveMembers,
    jobs,
  };
}

export interface InstalledStage {
  root: string;
  promotion: PromotionRecord;
  job: ConfinedJobResult;
}

/**
 * Clone the extraction output into a fresh install job directory and run the
 * locked production install there, confined, with native scripts enabled.
 */
export async function installStagedArtifact(
  extracted: ExtractedArtifact,
  context: ArtifactStagingContext,
): Promise<InstalledStage> {
  const staging = validateContext(context);
  const job = await staging.runner.prepare("install");
  const root = resolve(job.path, "package");
  const promotion = await promoteTree({
    source: extracted.root,
    destination: root,
    method: staging.promotionMethod,
    io: staging.promotionIO ?? nodePromotionIO,
  });
  const result = requireJobSuccess(
    await staging.runner.launch(job, {
      command: staging.nodePath,
      args: [staging.npmCliPath, "ci", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"],
      cwd: root,
      home: staging.invokingHome,
      pathEnv: staging.pathEnv,
      timeoutMs: 600_000,
    }),
  );
  return { root, promotion, job: result };
}

export interface StageCandidateOptions {
  selector: ArtifactSelector;
  context: ArtifactStagingContext;
  /** `.hive.next`; written only by the promotion below. */
  destination: string;
  requireClean: boolean;
  /** Persist the `.hive.next` promotion fence. */
  journalPromotion?: (record: PromotionRecord) => Promise<void>;
  /** Called with the archive digest and staged identity before promotion. */
  onResolved?: (artifact: ResolvedArtifact, extracted: ExtractedArtifact) => Promise<void>;
  runtimeLoading?: readonly RuntimeLoadingProbe[];
}

export interface StagedCandidate {
  artifact: ResolvedArtifact;
  extracted: ExtractedArtifact;
  installed: InstalledStage;
  promotion: PromotionRecord;
  verification: CloneVerification;
}

/**
 * Update staging: confined fetch → confined listing/member reads/extraction →
 * confined install → clone into `.hive.next` → clone-only verification. Every
 * failure happens before any service signal; a failed verification discards
 * the clone, and a job directory is never promoted into service.
 */
export async function stageVerifiedCandidate(options: StageCandidateOptions): Promise<StagedCandidate> {
  const staging = validateContext(options.context);
  const artifact = await resolveArtifact(options.selector, staging);
  const extracted = await extractAndValidateArtifact(artifact, staging, options.requireClean);
  await options.onResolved?.(artifact, extracted);
  const installed = await installStagedArtifact(extracted, staging);
  const { promotion, verification } = await promoteAndVerify({
    source: installed.root,
    destination: options.destination,
    method: staging.promotionMethod,
    journal: options.journalPromotion,
    io: staging.promotionIO,
    verification: {
      archiveSha256: artifact.archiveSha256,
      expectedRelease: releaseIdentity(extracted.release),
      requireClean: options.requireClean,
      archiveMembers: extracted.archiveMembers,
      runner: staging.runner,
      nodePath: staging.nodePath,
      npmCliPath: staging.npmCliPath,
      pathEnv: staging.pathEnv,
      dependencyTree: true,
      runtimeLoading: options.runtimeLoading ?? CANDIDATE_RUNTIME_LOADING_PROBES,
    },
  });
  return { artifact, extracted, installed, promotion, verification };
}

export interface StagedConfigOptions {
  /** The verified clone (read-only). */
  clone: string;
  context: ArtifactStagingContext;
  serviceEnvironment: Record<string, string>;
  expectedInstanceId: string;
  expectedDatabaseName?: string;
  expectedVoiceEnabled?: boolean;
}

function parseProbe(stdout: string, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${name} returned invalid JSON`);
  }
}

/** Candidate `runtime-probe config` from the verified clone, as a confined job. */
export async function preflightStagedConfig(options: StagedConfigOptions): Promise<Record<string, unknown>> {
  const staging = validateContext(options.context);
  const { HOME: home, PATH: pathEnv, ...rest } = options.serviceEnvironment;
  if (!home || !pathEnv) throw new Error("staged config probe requires the service HOME and PATH");
  const job = requireJobSuccess(
    await staging.runner.run("config-probe", {
      command: staging.nodePath,
      args: [resolve(options.clone, "pkg", "runtime-probe.min.js"), "config"],
      home,
      pathEnv,
      extraEnv: rest,
      timeoutMs: 30_000,
      maxOutputBytes: 2 * 1024 * 1024,
    }),
  );
  const result = parseProbe(job.stdout.toString("utf8"), "staged config probe");
  if (result.ok !== true || result.instanceId !== options.expectedInstanceId) {
    throw new Error("staged config is incompatible with selected instance");
  }
  const database = result.database as { name?: unknown } | undefined;
  if (options.expectedDatabaseName !== undefined && database?.name !== options.expectedDatabaseName) {
    throw new Error("staged config changes database identity");
  }
  const voice = result.voice as { livekitEnabled?: unknown } | undefined;
  if (options.expectedVoiceEnabled !== undefined && voice?.livekitEnabled !== options.expectedVoiceEnabled) {
    throw new Error("staged config changes voice enablement unexpectedly");
  }
  return result;
}
