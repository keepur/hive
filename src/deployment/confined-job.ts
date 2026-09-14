/**
 * Seatbelt write confinement for artifact jobs (KPR-463 spec §5.1, plan chunk 5
 * Task 8 Step 1a.3).
 *
 * Every artifact job — registry fetch, archive listing/member reads/extraction,
 * `npm ci`, the dependency-tree check and the runtime-loading check — runs under
 * `/usr/bin/sandbox-exec` with a profile that denies every file write outside
 * the job's own single-use directory. The kernel applies the profile to every
 * descendant, so a detached or reparented straggler can only ever write into a
 * job directory that is never promoted. Settlement is the direct child's exit
 * status plus a verified clone (clone-promotion.ts); nothing here waits for,
 * enumerates or signals descendants.
 *
 * Builtin-only: imports `node:*`, `release.ts` and the logger, so the frozen
 * deployment helper and `populate-engine.ts` share one implementation.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createLogger } from "../logging/logger.js";
import { sha256 } from "./release.js";

const log = createLogger("deployment-confined-job");

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SW_VERS = "/usr/bin/sw_vers";

/** Fixed job kinds. No command, argv or path override is accepted from input. */
export type ConfinedJobKind =
  | "fetch"
  | "member-list"
  | "member-read"
  | "extract"
  | "install"
  | "dependency-tree"
  | "runtime-loading"
  | "config-probe"
  | "tooling-validate";

export interface JobIdentity {
  dev: number;
  ino: number;
  uid: number;
}

export interface JobDirectory {
  operationId: string;
  jobId: string;
  kind: ConfinedJobKind | "self-test";
  /** Canonical realpath of the job directory; the only writable subtree. */
  path: string;
  identity: JobIdentity;
}

/** Marker record of one confined job (staging-integrity evidence, spec §6). */
export interface ConfinedJobRecord {
  jobId: string;
  kind: ConfinedJobKind;
  path: string;
  identity: JobIdentity;
  profileSha256: string;
  state: "created" | "exited";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface ConfinementSelfTest {
  outcome: "passed";
  macosVersion: string;
  sandboxExec: typeof SANDBOX_EXEC;
  profileSha256: string;
  checkedAt: string;
}

export interface ConfinedProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  input?: Buffer;
  onSpawn?: (pid: number) => void;
}

export interface FileStat {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Operating-system boundary for confined jobs; injected in unit tests. */
export interface ConfinedJobIO {
  platform(): NodeJS.Platform;
  spawn(command: string, args: readonly string[], options: SpawnOptions): Promise<ConfinedProcessResult>;
  access(path: string, mode: number): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  rm(path: string): Promise<void>;
  getuid(): number;
  randomId(): string;
  now(): Date;
}

/** Grace for stdio to drain after the direct child exits; a straggler holding a pipe never extends it. */
const STDIO_DRAIN_GRACE_MS = 2_000;

export const nodeConfinedJobIO: ConfinedJobIO = {
  platform: () => process.platform,
  spawn(command, args, options) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        detached: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let drainTimer: NodeJS.Timeout | undefined;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (truncated) return;
        size += chunk.length;
        if (size > options.maxOutputBytes) {
          truncated = true;
          // Only the recorded direct child is ever signaled.
          child.kill("SIGKILL");
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      const finish = () => {
        if (settled || !exit) return;
        settled = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolvePromise({
          exitCode: exit.code,
          signal: exit.signal,
          timedOut,
          outputTruncated: truncated,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once("spawn", () => {
        if (child.pid !== undefined) options.onSpawn?.(child.pid);
        if (options.input && child.stdin) child.stdin.end(options.input);
      });
      child.once("exit", (code, signal) => {
        exit = { code, signal };
        drainTimer = setTimeout(finish, STDIO_DRAIN_GRACE_MS);
        drainTimer.unref();
      });
      child.once("close", finish);
    });
  },
  async access(path, mode) {
    await access(path, mode);
  },
  async mkdir(path, mode) {
    await mkdir(path, { mode });
  },
  lstat,
  realpath,
  async rm(path) {
    // fs.rm never follows symbolic links.
    await rm(path, { recursive: true, force: false });
  },
  getuid() {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("confined jobs require a POSIX user ID");
    return uid;
  },
  randomId: randomUUID,
  now: () => new Date(),
};

export class ConfinementUnavailableError extends Error {}
export class ConfinementSelfTestError extends Error {}
export class ConfinedJobRunnerRequiredError extends Error {}

export class ConfinedJobFailedError extends Error {
  constructor(
    readonly kind: ConfinedJobKind,
    readonly result: Pick<ConfinedProcessResult, "exitCode" | "signal" | "timedOut" | "outputTruncated">,
    /** Bounded diagnostic tail; never logged by this module. */
    readonly stderrTail: string,
  ) {
    const cause = result.timedOut
      ? "timed out"
      : result.outputTruncated
        ? "exceeded its output budget"
        : result.signal
          ? `was terminated by ${result.signal}`
          : `exited with status ${String(result.exitCode)}`;
    super(`confined ${kind} job ${cause}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasUnsafeSeatbeltCharacter(path: string): boolean {
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === "\\" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * SBPL string literals cannot safely carry `"`, `\`, NUL or control
 * characters. Reject them rather than escape: spaces and `&` are ordinary.
 */
export function assertSeatbeltSafePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("confined job directory path must be absolute");
  if (hasUnsafeSeatbeltCharacter(path)) {
    throw new Error("confined job directory path contains a character unsafe for a Seatbelt profile");
  }
  return path;
}

/**
 * Deny every file write except beneath the job directory's canonical realpath
 * and the stdio device nodes; reads, process execution and network stay
 * allowed. Seatbelt matches resolved paths, so the caller passes the realpath.
 */
export function buildSeatbeltProfile(canonicalJobDirectory: string): string {
  const path = assertSeatbeltSafePath(canonicalJobDirectory);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${path}"))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty")' +
      ' (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper")' +
      ' (regex #"^/dev/fd/[0-9]+$"))',
    "",
  ].join("\n");
}

export function jobsRoot(canonicalInstanceHome: string): string {
  return resolve(canonicalInstanceHome, ".hive-state", "jobs");
}

export interface ConfinedEnvironmentOptions {
  /** `"job"` gives the job a private HOME inside its directory. */
  home: "job" | string;
  pathEnv: string;
  extraEnv?: Readonly<Record<string, string>>;
}

const forbiddenExtraKeys = new Set(["NODE_OPTIONS", "NODE_PATH", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME"]);

/** Subdirectories created inside every job before launch. */
export const JOB_WRITE_LOCATIONS = {
  tmp: "tmp",
  npmCache: "npm-cache",
  npmLogs: "npm-logs",
  nodeGyp: "node-gyp",
  cache: "cache",
  home: "home",
} as const;

/**
 * Explicit allowlist. Installer write locations point inside the job; nothing
 * is inherited from the invoking shell. A residual write elsewhere surfaces as
 * a sandbox denial and is fixed by redirecting it, never by widening the profile.
 */
export function confinedJobEnvironment(
  jobDirectory: string,
  options: ConfinedEnvironmentOptions,
): Record<string, string> {
  if (!options.pathEnv || options.pathEnv.includes("\0")) throw new Error("confined job PATH is required");
  const home = options.home === "job" ? resolve(jobDirectory, JOB_WRITE_LOCATIONS.home) : options.home;
  if (!isAbsolute(home)) throw new Error("confined job HOME must be absolute");
  const env: Record<string, string> = {
    HOME: home,
    PATH: options.pathEnv,
    TMPDIR: resolve(jobDirectory, JOB_WRITE_LOCATIONS.tmp),
    XDG_CACHE_HOME: resolve(jobDirectory, JOB_WRITE_LOCATIONS.cache),
    npm_config_cache: resolve(jobDirectory, JOB_WRITE_LOCATIONS.npmCache),
    npm_config_logs_dir: resolve(jobDirectory, JOB_WRITE_LOCATIONS.npmLogs),
    npm_config_devdir: resolve(jobDirectory, JOB_WRITE_LOCATIONS.nodeGyp),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || forbiddenExtraKeys.has(key) || key.toLowerCase().startsWith("npm_")) {
      throw new Error(`confined job environment key is not allowed: ${key}`);
    }
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`invalid confined job environment: ${key}`);
    env[key] = value;
  }
  return env;
}

async function ensureOwnedDirectory(io: ConfinedJobIO, path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await io.mkdir(path, 0o700);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const info = await io.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`job area is not a real directory: ${path}`);
  if (info.uid !== io.getuid()) throw new Error(`job area has a foreign owner: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`job area is group- or world-writable: ${path}`);
}

/**
 * Create one exclusive, single-use job directory under
 * `<instance>/.hive-state/jobs/<operation-id>/<job-id>/`. The leaf `mkdir`
 * fails if it exists; ancestors must be same-UID real directories.
 */
export async function createJobDirectory(
  canonicalInstanceHome: string,
  operationId: string,
  jobId: string,
  kind: JobDirectory["kind"],
  io: ConfinedJobIO = nodeConfinedJobIO,
): Promise<JobDirectory> {
  if (!identifierPattern.test(operationId)) throw new Error("invalid operation ID for a job directory");
  if (!identifierPattern.test(jobId)) throw new Error("invalid job ID");
  assertSeatbeltSafePath(canonicalInstanceHome);
  if ((await io.realpath(canonicalInstanceHome)) !== canonicalInstanceHome) {
    throw new Error("job directories require the canonical instance home");
  }
  const homeInfo = await io.lstat(canonicalInstanceHome);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() || homeInfo.uid !== io.getuid()) {
    throw new Error("instance home is not an owned real directory");
  }
  const state = resolve(canonicalInstanceHome, ".hive-state");
  const jobs = jobsRoot(canonicalInstanceHome);
  const operation = resolve(jobs, operationId);
  const leaf = resolve(operation, jobId);
  await ensureOwnedDirectory(io, state, true);
  await ensureOwnedDirectory(io, jobs, true);
  await ensureOwnedDirectory(io, operation, true);
  try {
    await io.mkdir(leaf, 0o700);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error("job directory already exists; job directories are single-use", { cause: error });
    }
    throw error;
  }
  const canonical = await io.realpath(leaf);
  if (canonical !== leaf || !inside(canonicalInstanceHome, canonical)) {
    throw new Error("job directory resolved outside the instance job area");
  }
  assertSeatbeltSafePath(canonical);
  const info = await io.lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== io.getuid()) {
    throw new Error("job directory identity is not an owned real directory");
  }
  return { operationId, jobId, kind, path: canonical, identity: { dev: info.dev, ino: info.ino, uid: info.uid } };
}

async function prepareWriteLocations(io: ConfinedJobIO, job: JobDirectory): Promise<void> {
  for (const location of Object.values(JOB_WRITE_LOCATIONS)) {
    await io.mkdir(resolve(job.path, location), 0o700);
  }
}

export interface ConfinedJobSpec {
  /** Absolute recorded tool path (Node, `/usr/bin/tar`, ...). */
  command: string;
  args: readonly string[];
  /** Absolute cwd: the job directory (default) or a read-only clone. */
  cwd?: string;
  home: ConfinedEnvironmentOptions["home"];
  pathEnv: string;
  extraEnv?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes?: number;
  input?: Buffer;
}

export interface ConfinedJobResult extends ConfinedProcessResult {
  job: JobDirectory;
  record: ConfinedJobRecord;
}

export interface ConfinedJobRunnerOptions {
  canonicalInstanceHome: string;
  operationId: string;
  selfTest: ConfinementSelfTest;
  /** Persist the job record in the operation marker (before launch and after exit). */
  journal?: (record: ConfinedJobRecord) => Promise<void>;
  io?: ConfinedJobIO;
}

function validateSpec(spec: ConfinedJobSpec): void {
  if (!isAbsolute(spec.command) || spec.command.includes("\0"))
    throw new Error("confined job command must be absolute");
  if (spec.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("confined job arguments must be plain strings");
  }
  if (spec.cwd !== undefined && !isAbsolute(spec.cwd)) throw new Error("confined job cwd must be absolute");
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1) throw new Error("confined job needs a budget");
}

/**
 * Launches artifact jobs only after a passed self-test, each in its own
 * exclusive job directory, through `/usr/bin/sandbox-exec` with an argv array.
 */
export class ConfinedJobRunner {
  readonly #options: ConfinedJobRunnerOptions;
  readonly #io: ConfinedJobIO;
  readonly #used = new Set<string>();

  constructor(options: ConfinedJobRunnerOptions) {
    if (!options.selfTest || options.selfTest.outcome !== "passed") {
      throw new ConfinementUnavailableError("artifact jobs require a passed confinement self-test");
    }
    if (!isAbsolute(options.canonicalInstanceHome)) throw new Error("canonical instance home must be absolute");
    this.#options = options;
    this.#io = options.io ?? nodeConfinedJobIO;
  }

  get selfTest(): ConfinementSelfTest {
    return this.#options.selfTest;
  }

  get operationId(): string {
    return this.#options.operationId;
  }

  /** Create (and journal) a fresh job directory the caller may seed before launch. */
  async prepare(kind: ConfinedJobKind): Promise<JobDirectory> {
    const job = await createJobDirectory(
      this.#options.canonicalInstanceHome,
      this.#options.operationId,
      `${kind}-${this.#io.randomId()}`,
      kind,
      this.#io,
    );
    await prepareWriteLocations(this.#io, job);
    await this.#options.journal?.(this.#record(job, "created", null));
    return job;
  }

  #record(job: JobDirectory, state: ConfinedJobRecord["state"], result: ConfinedProcessResult | null) {
    return {
      jobId: job.jobId,
      kind: job.kind as ConfinedJobKind,
      path: job.path,
      identity: { ...job.identity },
      profileSha256: sha256(buildSeatbeltProfile(job.path)),
      state,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      timedOut: result?.timedOut ?? false,
    } satisfies ConfinedJobRecord;
  }

  async launch(job: JobDirectory, spec: ConfinedJobSpec): Promise<ConfinedJobResult> {
    if (job.kind === "self-test") throw new Error("self-test directories are not artifact jobs");
    if (this.#used.has(job.jobId)) throw new Error("job directories are single-use");
    this.#used.add(job.jobId);
    validateSpec(spec);
    const current = await this.#io.lstat(job.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== job.identity.dev ||
      current.ino !== job.identity.ino
    ) {
      throw new Error("job directory identity changed before launch");
    }
    const profile = buildSeatbeltProfile(job.path);
    const env = confinedJobEnvironment(job.path, spec);
    const result = await this.#io.spawn(SANDBOX_EXEC, ["-p", profile, spec.command, ...spec.args], {
      cwd: spec.cwd ?? job.path,
      env,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes ?? 20 * 1024 * 1024,
      input: spec.input,
    });
    const record = this.#record(job, "exited", result);
    await this.#options.journal?.(record);
    log.info("Confined artifact job exited", {
      kind: job.kind,
      jobId: job.jobId,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
    });
    return { ...result, job, record };
  }

  async run(kind: ConfinedJobKind, spec: ConfinedJobSpec): Promise<ConfinedJobResult> {
    return this.launch(await this.prepare(kind), spec);
  }
}

/** Settlement input: the direct child must exit 0 within its budget. */
export function requireJobSuccess<T extends ConfinedJobResult>(result: T): T {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.outputTruncated) {
    throw new ConfinedJobFailedError(result.record.kind, result, result.stderr.subarray(-2_048).toString("utf8"));
  }
  return result;
}

/** Runtime guard for public artifact entrypoints: no unconfined fallback exists. */
export function assertConfinedJobRunner(runner: unknown): asserts runner is ConfinedJobRunner {
  if (!(runner instanceof ConfinedJobRunner)) {
    throw new ConfinedJobRunnerRequiredError("artifact jobs require the confined job runner");
  }
}

const SELF_TEST_SCRIPT = [
  'const fs = require("node:fs");',
  "const result = {};",
  'try { fs.writeFileSync(process.argv[1], "x", { flag: "wx" }); result.outside = "written"; }',
  "catch (error) { result.outside = error && error.code ? error.code : 'error'; }",
  'try { fs.writeFileSync(process.argv[2], "x", { flag: "wx" }); result.inside = "ok"; }',
  "catch (error) { result.inside = error && error.code ? error.code : 'error'; }",
  "process.stdout.write(JSON.stringify(result));",
].join("\n");

export interface SelfTestOptions {
  canonicalInstanceHome: string;
  operationId: string;
  /** Recorded Node used for the probe. */
  nodePath: string;
  io?: ConfinedJobIO;
}

async function absent(io: ConfinedJobIO, path: string): Promise<boolean> {
  try {
    await io.lstat(path);
    return false;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function macosVersion(io: ConfinedJobIO): Promise<string> {
  try {
    const result = await io.spawn(SW_VERS, ["-productVersion"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });
    const version = result.stdout.toString("utf8").trim();
    return result.exitCode === 0 && /^[0-9]+(?:\.[0-9]+)*$/.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fail-closed preflight: with the production launcher and profile, a write to
 * a sibling outside a scratch job directory must fail with EPERM and leave no
 * file, and a write inside must succeed. There is no unconfined fallback.
 */
export async function runConfinementSelfTest(options: SelfTestOptions): Promise<ConfinementSelfTest> {
  const io = options.io ?? nodeConfinedJobIO;
  if (io.platform() !== "darwin") {
    throw new ConfinementUnavailableError("artifact confinement requires macOS /usr/bin/sandbox-exec");
  }
  try {
    await io.access(SANDBOX_EXEC, constants.X_OK);
  } catch {
    throw new ConfinementUnavailableError("/usr/bin/sandbox-exec is missing or not executable");
  }
  if (!isAbsolute(options.nodePath)) throw new Error("self-test Node path must be absolute");
  const version = await macosVersion(io);
  const job = await createJobDirectory(
    options.canonicalInstanceHome,
    options.operationId,
    `self-test-${io.randomId()}`,
    "self-test",
    io,
  );
  const outside = resolve(dirname(job.path), `${basename(job.path)}.outside`);
  const insidePath = resolve(job.path, "inside");
  const profile = buildSeatbeltProfile(job.path);
  try {
    let result: ConfinedProcessResult;
    try {
      result = await io.spawn(
        SANDBOX_EXEC,
        ["-p", profile, options.nodePath, "-e", SELF_TEST_SCRIPT, outside, insidePath],
        {
          cwd: job.path,
          env: { HOME: job.path, PATH: "/usr/bin:/bin", TMPDIR: job.path },
          timeoutMs: 30_000,
          maxOutputBytes: 4_096,
        },
      );
    } catch (error) {
      throw new ConfinementSelfTestError("confinement self-test launcher failed", { cause: error });
    }
    if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
      throw new ConfinementSelfTestError("confinement self-test probe did not complete");
    }
    let observed: { outside?: unknown; inside?: unknown };
    try {
      observed = JSON.parse(result.stdout.toString("utf8")) as typeof observed;
    } catch {
      throw new ConfinementSelfTestError("confinement self-test probe returned no result");
    }
    const outsideAbsent = await absent(io, outside);
    if (observed.outside !== "EPERM" || !outsideAbsent) {
      throw new ConfinementSelfTestError("confinement self-test did not deny a write outside the job directory");
    }
    if (observed.inside !== "ok" || (await absent(io, insidePath))) {
      throw new ConfinementSelfTestError("confinement self-test could not write inside the job directory");
    }
    const outcome: ConfinementSelfTest = {
      outcome: "passed",
      macosVersion: version,
      sandboxExec: SANDBOX_EXEC,
      profileSha256: sha256(profile),
      checkedAt: io.now().toISOString(),
    };
    log.info("Artifact confinement self-test passed", { macosVersion: version });
    return outcome;
  } finally {
    await io.rm(job.path).catch(() => {});
    if (!(await absent(io, outside).catch(() => false))) await io.rm(outside).catch(() => {});
  }
}
