#!/usr/bin/env node
/* global process, Buffer, setTimeout, clearTimeout */
/**
 * KPR-463 host preparation recipe (plan chunk 4 Task 9 Step 4d.2, chunk 5
 * Task 9 Step 4d.1a / Step 5).
 *
 * Builtin-only: imports nothing outside `node:*`, executes no candidate code
 * and installs no dependencies. It authenticates the reviewed archive, runs the
 * same confinement self-test the deployment helper runs, reads the single
 * `package/pkg/deploy.min.js` member through a confined `tar` job fed the hashed
 * archive bytes on stdin, and writes those bytes itself into a new private
 * preparation directory. No job-directory file is promoted, executed or read
 * back. A durable `HostPreparation` receipt beside the preparation directory
 * records intended -> created -> extracted -> validated; the prepared helper
 * path is printed only after `validated` is durable.
 *
 * Inputs (explicitly exported, never eval'd): KPR463_INSTANCE, KPR463_INSTANCE_ID,
 * KPR463_CONFIG, KPR463_ARCHIVE, KPR463_SHA, KPR463_REVISION.
 *
 *   KPR463_PREPARED_HELPER="$("$KPR463_NODE" scripts/kpr463-prepare-bootstrap.mjs)"
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const TAR = "/usr/bin/tar";
export const PS = "/bin/ps";
export const HELPER_MEMBER = "package/pkg/deploy.min.js";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_LISTING_BYTES = 20 * 1024 * 1024;
const MAX_MEMBER_BYTES = 128 * 1024 * 1024;
const JOB_TIMEOUT_MS = 120_000;

export class PreparationError extends Error {}

// ── shared contracts (must match src/deployment/confined-job.ts and artifact.ts in effect) ──

function hasUnsafeSeatbeltCharacter(path) {
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === "\\" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Identical profile text to `buildSeatbeltProfile` in confined-job.ts (pinned by test). */
export function buildSeatbeltProfile(canonicalJobDirectory) {
  if (!isAbsolute(canonicalJobDirectory)) throw new PreparationError("confined job directory path must be absolute");
  if (hasUnsafeSeatbeltCharacter(canonicalJobDirectory)) {
    throw new PreparationError("confined job directory path contains a character unsafe for a Seatbelt profile");
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${canonicalJobDirectory}"))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty")' +
      ' (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper")' +
      ' (regex #"^/dev/fd/[0-9]+$"))',
    "",
  ].join("\n");
}

const forbiddenOperatorMember =
  /^(?:hive(?:-[^/]*)?\.yaml|\.env(?:-[^/]*)?|agents|plugins|skills|logs|\.hive-state)(?:\/|$)/;

/** Same member rules as `validateArchiveMembers` in artifact.ts (pinned by test). */
export function validateArchiveMembers(namesOutput, detailOutput) {
  const members = namesOutput.split("\n").filter(Boolean);
  if (members.length === 0) throw new PreparationError("artifact archive is empty");
  for (const member of members) {
    if (
      !member.startsWith("package/") ||
      member.startsWith("/") ||
      member.includes("\\") ||
      member.split("/").includes("..")
    ) {
      throw new PreparationError(`unsafe archive member: ${member}`);
    }
    if (forbiddenOperatorMember.test(member.slice("package/".length))) {
      throw new PreparationError(`artifact contains operator state: ${member}`);
    }
  }
  const details = detailOutput.split("\n").filter(Boolean);
  if (details.length !== members.length) {
    throw new PreparationError("archive detail listing does not match member listing");
  }
  for (const detail of details) {
    const kind = detail[0];
    if (kind !== "-" && kind !== "d") throw new PreparationError("archive links and special members are rejected");
  }
  return { members, kinds: details.map((detail) => detail[0]) };
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

// ── canonical JSON and durable writes ──

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  throw new PreparationError("receipt contains a non-JSON value");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/** Exclusive 0600 temp write, file fsync, atomic rename, parent fsync. */
export function durableWrite(path, value, uid, randomId) {
  const parent = resolve(path, "..");
  assertPrivateDirectory(parent, uid);
  const temporary = `${path}.${randomId()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeAll(fd, Buffer.from(`${canonical(value)}\n`));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const written = lstatSync(temporary);
  if (!written.isFile() || written.uid !== uid) throw new PreparationError("receipt temp file ownership changed");
  renameSync(temporary, path);
  fsyncDirectory(parent);
}

function assertPrivateDirectory(path, uid) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PreparationError(`not a directory: ${path}`);
  if (info.uid !== uid) throw new PreparationError(`foreign-owned directory: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new PreparationError(`group/world-writable directory: ${path}`);
  return { dev: info.dev, ino: info.ino, uid: info.uid };
}

/** Create (0700) or verify a same-UID, non-symlinked, non-foreign-writable directory. */
function ensurePrivateDirectory(path, uid) {
  try {
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(resolve(path, ".."));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return assertPrivateDirectory(path, uid);
}

// ── inputs ──

export function readPreparationInput(env) {
  const instance = env.KPR463_INSTANCE;
  const instanceId = env.KPR463_INSTANCE_ID;
  const config = env.KPR463_CONFIG;
  const archive = env.KPR463_ARCHIVE;
  const sha = env.KPR463_SHA;
  const revision = env.KPR463_REVISION;
  if (!instance || !isAbsolute(instance)) throw new PreparationError("KPR463_INSTANCE must be an absolute path");
  if (!instanceId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(instanceId)) {
    throw new PreparationError("KPR463_INSTANCE_ID must be a safe instance ID");
  }
  if (!config || !isAbsolute(config)) throw new PreparationError("KPR463_CONFIG must be an absolute path");
  if (!archive || !isAbsolute(archive) || !archive.endsWith(".tgz")) {
    throw new PreparationError("KPR463_ARCHIVE must be an absolute .tgz path");
  }
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) throw new PreparationError("KPR463_SHA must be the reviewed 64-hex digest");
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new PreparationError("KPR463_REVISION must be the reviewed 40-hex revision");
  }
  return { instance, instanceId, config, archive, sha, revision };
}

/** Read the archive once, no-follow, with identity unchanged across the read. */
function readArchiveOnce(path, maxBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new PreparationError("archive must be a regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new PreparationError("archive changed while opening");
    if (opened.size > maxBytes) throw new PreparationError("archive exceeds the preparation size cap");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new PreparationError("archive changed while reading");
    }
    return {
      bytes,
      seal: {
        path: resolve(path),
        realpath: realpathSync(path),
        uid: opened.uid,
        mode: opened.mode & 0o7777,
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        sha256: sha256(bytes),
      },
    };
  } finally {
    closeSync(fd);
  }
}

// ── host boundary ──

function runProcess(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > options.maxOutputBytes) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, signal, timedOut, truncated, stdout: Buffer.concat(stdout) });
    });
    if (options.input) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

export const nodeHostIO = {
  platform: () => process.platform,
  sandboxExecPresent: () => !absent(SANDBOX_EXEC),
  pid: () => process.pid,
  uid: () => process.getuid(),
  nodePath: () => realpathSync(process.execPath),
  randomId: () => randomUUID(),
  run: runProcess,
  processStartTime: (pid) =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(
        PS,
        ["-p", String(pid), "-o", "lstart="],
        { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, encoding: "utf8" },
        (error, stdout) => (error ? rejectPromise(error) : resolvePromise(stdout.trim())),
      );
    }),
};

// ── confined jobs ──

function createJob(jobsDirectory, name, uid) {
  const path = resolve(jobsDirectory, name);
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(jobsDirectory);
  const real = realpathSync(path);
  assertPrivateDirectory(real, uid);
  return real;
}

async function confined(io, job, command, args, options) {
  const result = await io.run(SANDBOX_EXEC, ["-p", buildSeatbeltProfile(job), command, ...args], {
    cwd: job,
    env: { HOME: job, PATH: "/usr/bin:/bin", TMPDIR: job },
    timeoutMs: JOB_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes,
    input: options.input,
  });
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.truncated) {
    throw new PreparationError(`confined ${options.kind} job failed`);
  }
  return result.stdout;
}

function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

/** Fail closed without `/usr/bin/sandbox-exec` or on any non-denying outcome; no unconfined fallback. */
export async function runSelfTest(io, jobsDirectory, uid) {
  if (io.platform() !== "darwin") throw new PreparationError("preparation requires macOS /usr/bin/sandbox-exec");
  if (!io.sandboxExecPresent()) throw new PreparationError("/usr/bin/sandbox-exec is missing");
  const job = createJob(jobsDirectory, `self-test-${io.randomId()}`, uid);
  const outside = `${job}.outside`;
  const inside = resolve(job, "inside");
  try {
    let stdout;
    try {
      stdout = await confined(io, job, io.nodePath(), ["-e", SELF_TEST_SCRIPT, outside, inside], {
        kind: "self-test",
        maxOutputBytes: 4_096,
      });
    } catch (error) {
      throw new PreparationError("confinement self-test launcher failed", { cause: error });
    }
    let observed;
    try {
      observed = JSON.parse(stdout.toString("utf8"));
    } catch {
      throw new PreparationError("confinement self-test returned no result");
    }
    if (observed.outside !== "EPERM" || !absent(outside)) {
      throw new PreparationError("confinement self-test did not deny a write outside the job directory");
    }
    if (observed.inside !== "ok" || absent(inside)) {
      throw new PreparationError("confinement self-test could not write inside the job directory");
    }
  } finally {
    rmSync(job, { recursive: true, force: true });
    if (!absent(outside)) rmSync(outside, { force: true });
  }
}

// ── recipe ──

/**
 * Prepare the reviewed helper and return its path. Every later archive use
 * consumes the bytes hashed here; the archive path is never re-read.
 */
export async function prepareBootstrapHelper(env, io = nodeHostIO) {
  const input = readPreparationInput(env);
  const uid = io.uid();
  const home = realpathSync(input.instance);
  assertPrivateDirectory(home, uid);
  const stateRoot = resolve(home, ".hive-state");
  ensurePrivateDirectory(stateRoot, uid);
  const bootstrapRoot = resolve(stateRoot, "bootstrap");
  const bootstrapIdentity = ensurePrivateDirectory(bootstrapRoot, uid);
  const id = io.randomId();
  const jobsRoot = resolve(stateRoot, "jobs");
  ensurePrivateDirectory(jobsRoot, uid);
  const jobsDirectory = resolve(jobsRoot, id);
  mkdirSync(jobsDirectory, { mode: 0o700 });
  fsyncDirectory(jobsRoot);

  // Self-test before any archive read.
  await runSelfTest(io, jobsDirectory, uid);

  const archive = readArchiveOnce(input.archive, MAX_ARCHIVE_BYTES);
  if (archive.seal.sha256 !== input.sha) throw new PreparationError("archive digest does not match the reviewed SHA");
  const ownerPid = io.pid();
  const ownerStart = await io.processStartTime(ownerPid);
  if (!ownerStart) throw new PreparationError("preparer start time is unavailable");

  const directoryPath = resolve(bootstrapRoot, `.prepare-${id}`);
  const receiptPath = `${directoryPath}.json`;
  const preparedPath = resolve(directoryPath, HELPER_MEMBER);
  const receipt = {
    schemaVersion: 1,
    id,
    instance: { canonicalHome: home, configPath: input.config, instanceId: input.instanceId, uid },
    owner: { pid: ownerPid, startTime: ownerStart },
    archive: archive.seal,
    reviewedRevision: input.revision,
    preparedPath,
    parent: { path: bootstrapRoot, identity: bootstrapIdentity },
    phase: "intended",
    directory: null,
    helper: null,
    adoptedOperationId: null,
  };
  if (!absent(receiptPath) || !absent(directoryPath)) throw new PreparationError("preparation UUID already exists");
  durableWrite(receiptPath, receipt, uid, io.randomId);

  mkdirSync(directoryPath, { mode: 0o700 });
  fsyncDirectory(bootstrapRoot);
  const created = assertPrivateDirectory(directoryPath, uid);
  receipt.phase = "created";
  receipt.directory = { path: directoryPath, identity: created };
  durableWrite(receiptPath, receipt, uid, io.randomId);

  // Confined listing and single-member read over the hashed bytes on stdin.
  const listJob = createJob(jobsDirectory, `member-list-${io.randomId()}`, uid);
  const names = await confined(io, listJob, TAR, ["-tzf", "-"], {
    kind: "member-list",
    maxOutputBytes: MAX_LISTING_BYTES,
    input: archive.bytes,
  });
  const details = await confined(io, listJob, TAR, ["-tvzf", "-"], {
    kind: "member-list",
    maxOutputBytes: MAX_LISTING_BYTES,
    input: archive.bytes,
  });
  const listing = validateArchiveMembers(names.toString("utf8"), details.toString("utf8"));
  const helperIndexes = listing.members.flatMap((member, index) => (member === HELPER_MEMBER ? [index] : []));
  if (helperIndexes.length !== 1 || listing.kinds[helperIndexes[0]] !== "-") {
    throw new PreparationError("archive must contain exactly one regular package/pkg/deploy.min.js");
  }
  const readJob = createJob(jobsDirectory, `member-read-${io.randomId()}`, uid);
  const helperBytes = await confined(io, readJob, TAR, ["-xOzf", "-", HELPER_MEMBER], {
    kind: "member-read",
    maxOutputBytes: MAX_MEMBER_BYTES,
    input: archive.bytes,
  });
  if (helperBytes.length === 0) throw new PreparationError("helper member is empty");

  // The recipe writes the helper bytes itself; nothing from a job directory is copied.
  for (const segment of [resolve(directoryPath, "package"), resolve(directoryPath, "package/pkg")]) {
    mkdirSync(segment, { mode: 0o700 });
    fsyncDirectory(resolve(segment, ".."));
  }
  const fd = openSync(
    preparedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeAll(fd, helperBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(resolve(preparedPath, ".."));
  receipt.phase = "extracted";
  durableWrite(receiptPath, receipt, uid, io.randomId);

  // Verify the written helper's seal against the member bytes before validating.
  const written = readArchiveOnce(preparedPath, MAX_MEMBER_BYTES);
  if (written.seal.sha256 !== sha256(helperBytes) || written.seal.uid !== uid || (written.seal.mode & 0o022) !== 0) {
    throw new PreparationError("written helper does not seal the confined member bytes");
  }
  receipt.helper = written.seal;
  receipt.phase = "validated";
  durableWrite(receiptPath, receipt, uid, io.randomId);

  // Job directories are disposable leftovers; a failed removal is not fatal.
  try {
    rmSync(jobsDirectory, { recursive: true, force: true });
  } catch {
    // swept by the next operation under its lock
  }
  return preparedPath;
}

function isEntrypoint(argv1, moduleUrl) {
  if (!argv1) return false;
  if (pathToFileURL(argv1).href === moduleUrl) return true;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  prepareBootstrapHelper(process.env).then(
    (path) => process.stdout.write(`${path}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
