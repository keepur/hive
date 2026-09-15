#!/usr/bin/env node
/**
 * Packed production install + native/SDK acceptance (KPR-463 Task 3 Step 3).
 * Requires an already-built package. Uses the production confined-job and
 * clone-promotion path with the real /usr/bin/sandbox-exec on macOS.
 */
import { fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConfinedJobRunner,
  JOB_WRITE_LOCATIONS,
  nodeConfinedJobIO,
  runConfinementSelfTest,
} from "../dist/deployment/confined-job.js";
import { selectPromotionMethod } from "../dist/deployment/clone-promotion.js";
import { stageVerifiedCandidate } from "../dist/deployment/artifact.js";
import { readRelease, sha256 } from "../dist/deployment/release.js";
import {
  jobDenialLines,
  npmDebugLogPresent,
  startDenialCollector,
  trackJobSpawns,
} from "./sandbox-denial-collector.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(repoRoot, "scripts/generate-shrinkwrap.mjs");
const MISSING_SLACK = "Missing required env var: SLACK_APP_TOKEN";
const VOICE_DISABLED = "voice.livekit.enabled is false";

function parsePack(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith(".js") && existsSync(candidate)) return candidate;
  }
  throw new Error("npm CLI script was not found beside the running Node");
}

function listTar(archive) {
  const names = spawnSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8", timeout: 60_000 });
  const details = spawnSync("/usr/bin/tar", ["-tvzf", archive], { encoding: "utf8", timeout: 60_000 });
  if (names.status !== 0 || details.status !== 0) throw new Error("archive listing failed");
  const members = names.stdout.split("\n").filter(Boolean);
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
  }
  const detailLines = details.stdout.split("\n").filter(Boolean);
  if (detailLines.length !== members.length) throw new Error("archive detail listing does not match member listing");
  for (const detail of detailLines) {
    if (detail[0] !== "-" && detail[0] !== "d") throw new Error("archive links and special members are rejected");
  }
  const forbidden = ["src/", "dist/", "plugins/", "node_modules/", ".env", "hive.yaml"];
  for (const member of members) {
    const rel = member.slice("package/".length);
    if (forbidden.some((item) => rel === item || rel.startsWith(item))) {
      throw new Error(`forbidden archive member: ${member}`);
    }
  }
  return members;
}

function assertNoAncestorModules(start) {
  let directory = start;
  while (true) {
    if (existsSync(join(directory, "node_modules"))) {
      throw new Error(`ancestor node_modules is present at ${directory}`);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function writeSecurityShim(bin, logPath) {
  mkdirSync(bin, { recursive: true });
  const security = join(bin, "security");
  writeFileSync(
    security,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      "const log = process.env.HIVE_SMOKE_KEYCHAIN_LOG;",
      'if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");',
      "process.exit(44);",
      "",
    ].join("\n"),
  );
  chmodSync(security, 0o755);
  writeFileSync(logPath, "");
  return security;
}

function isolatedEnv(home, hiveHome, configPath, bin, tmp, logPath) {
  return {
    HOME: home,
    HIVE_HOME: hiveHome,
    HIVE_CONFIG: configPath,
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: tmp,
    NODE_ENV: "test",
    HIVE_SMOKE_KEYCHAIN_LOG: logPath,
  };
}

function runNode(file, args, env, cwd, timeoutMs = 20_000) {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd,
    env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

function requireExactFailure(result, needle, label) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error || result.signal || result.status === 0) {
    throw new Error(`${label}: expected nonzero ordinary exit (${output.slice(0, 400)})`);
  }
  if (
    output.includes("SyntaxError") ||
    output.includes("Cannot find module") ||
    output.includes("Cannot find package") ||
    output.includes("ERR_MODULE_NOT_FOUND")
  ) {
    throw new Error(`${label}: module/native load error\n${output.slice(0, 400)}`);
  }
  if (!output.includes(needle)) {
    throw new Error(`${label}: missing ${needle}\n${output.slice(0, 400)}`);
  }
}

function findPackageRoot(entry, name, releaseRoot) {
  const root = realpathSync(releaseRoot);
  let directory = dirname(realpathSync(entry));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === name) return directory;
    }
    const parent = dirname(directory);
    const rel = relative(root, directory);
    if (parent === directory || !rel || rel.startsWith("..")) {
      break;
    }
    directory = parent;
  }
  throw new Error(`package-root:${name}`);
}

async function sdkImportOk(hive, isolated) {
  const worker = join(hive, "pkg", "voice-worker.min.js");
  const requireFrom = createRequire(pathToFileURL(worker).href);
  const agentsEntry = requireFrom.resolve("@livekit/agents");
  const agentsRoot = findPackageRoot(agentsEntry, "@livekit/agents", hive);
  const sdkChild = join(agentsRoot, "dist", "ipc", "job_proc_lazy_main.js");
  if (!statSync(sdkChild).isFile()) throw new Error("sdk-child:missing");
  const dummy = mkdtempSync(join(isolated.tmp, "sdk-"));
  const child = fork(sdkChild, [worker], {
    cwd: dummy,
    env: {
      HOME: dummy,
      TMPDIR: dummy,
      PATH: isolated.env.PATH,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  const stderr = [];
  const stdout = [];
  child.on("message", (message) => messages.push(message));
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
  const waitFor = (name, ms = 15_000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const found = messages.find((message) => message && message.case === name);
      if (found) {
        resolvePromise(found);
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error(`timed out waiting for ${name}: ${stderr.join("")}`));
      }, ms);
      const onMessage = (message) => {
        if (message && message.case === name) {
          cleanup();
          resolvePromise(message);
        }
      };
      const onExit = (code, signal) => {
        cleanup();
        rejectPromise(new Error(`sdk child exited before ${name}: ${code} ${signal} ${stderr.join("")}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  try {
    child.send({ case: "initializeRequest", value: { loggerOptions: { level: "error", pretty: false } } });
    await waitFor("initializeResponse");
    child.send({ case: "shutdownRequest", value: {} });
    // Import/prewarm never sends startJobRequest, so the SDK child does not emit
    // `done` (that message is job-task-only). Shutdown without a job resolves
    // join and process.exit(0) after native dispose.
    const exit = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`sdk child did not exit: ${stderr.join("")}`)), 15_000);
      const finish = (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(child.exitCode, child.signalCode);
        return;
      }
      child.once("exit", finish);
    });
    if (exit.code !== 0 || exit.signal) {
      throw new Error(`sdk child exit ${exit.code} ${exit.signal} ${stderr.join("")}`);
    }
    const text = `${stdout.join("")}\n${stderr.join("")}`;
    if (text.includes("voice worker release boot") || text.includes("VoiceWorkerHeartbeat")) {
      throw new Error("sdk import started supervisor boot");
    }
    if (messages.some((message) => message && message.case === "startJobRequest")) {
      throw new Error("sdk import sent startJobRequest");
    }
    process.stdout.write("SDK_IMPORT_OK\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function writeVoiceDisabledConfig(instance) {
  writeFileSync(
    join(instance, "hive.yaml"),
    "instance:\n  id: artifact-install\nvoice:\n  livekit:\n    enabled: false\n",
  );
  writeFileSync(join(instance, ".env"), "SLACK_APP_TOKEN=xapp-dummy\nSLACK_BOT_TOKEN=xoxb-dummy\n");
}

function printRecord(stdout, prefix) {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${prefix} `));
  if (!line) throw new Error(`${prefix} record missing`);
  process.stdout.write(`${line}\n`);
  return JSON.parse(line.slice(prefix.length + 1));
}

async function exerciseInstalled(hive, instance, scratchBin, scratchTmp, logPath, expected) {
  hive = realpathSync(hive);
  instance = realpathSync(instance);
  if (!statSync(join(hive, "pkg", "server.min.js")).isFile()) throw new Error("missing engine service entry");
  if (!statSync(join(hive, "pkg", "voice-worker.min.js")).isFile()) throw new Error("missing worker service entry");
  const release = readRelease(hive);
  if (
    release.packageVersion !== expected.packageVersion ||
    release.sourceRevision !== expected.sourceRevision ||
    release.dependencyLockSha256 !== expected.dependencyLockSha256
  ) {
    throw new Error("installed release identity mismatch");
  }
  const isolated = {
    tmp: scratchTmp,
    env: isolatedEnv(scratchTmp, instance, join(instance, "hive.yaml"), scratchBin, scratchTmp, logPath),
  };
  await sdkImportOk(hive, isolated);

  writeVoiceDisabledConfig(instance);
  const worker = runNode(
    join(hive, "pkg", "voice-worker.min.js"),
    [],
    isolatedEnv(dirname(instance), instance, join(instance, "hive.yaml"), scratchBin, scratchTmp, logPath),
    instance,
  );
  requireExactFailure(worker, VOICE_DISABLED, "voice-worker");

  const emptyHome = mkdtempSync(join(scratchTmp, "empty-"));
  writeFileSync(join(emptyHome, "hive.yaml"), "");
  writeFileSync(join(emptyHome, ".env"), "");
  const server = runNode(
    join(hive, "pkg", "server.min.js"),
    [],
    isolatedEnv(emptyHome, emptyHome, join(emptyHome, "hive.yaml"), scratchBin, scratchTmp, logPath),
    emptyHome,
  );
  requireExactFailure(server, MISSING_SLACK, "server");
}

async function main() {
  if (!existsSync(join(repoRoot, "pkg", "release.json"))) {
    throw new Error("pkg/release.json missing — run npm run bundle first");
  }
  if (existsSync(join(repoRoot, "npm-shrinkwrap.json"))) {
    throw new Error("development root must not contain npm-shrinkwrap.json");
  }
  const scratch = mkdtempSync(join(tmpdir(), "hive-artifact-"));
  const token = scratch.split(sep).at(-1) ?? "hive-artifact";
  try {
    const packedInto = join(scratch, "pack");
    mkdirSync(packedInto, { recursive: true });
    const packOut = spawnSync(process.execPath, [generator, "--pack", "--json", "--pack-destination", packedInto], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (packOut.status !== 0) throw new Error(`pack failed: ${packOut.stderr || packOut.stdout}`);
    if (existsSync(join(repoRoot, "npm-shrinkwrap.json"))) {
      throw new Error("pack wrote a repository-root shrinkwrap");
    }
    const info = parsePack(packOut.stdout);
    const archive = join(packedInto, info.filename);
    const archiveDigest = sha256(readFileSync(archive));
    const lock = readFileSync(join(repoRoot, "package-lock.json"));
    const staged = spawnSync("/usr/bin/tar", ["-xOzf", archive, "package/npm-shrinkwrap.json"], {
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    if (staged.status !== 0) throw new Error("packed shrinkwrap missing");
    if (!Buffer.from(staged.stdout).equals(lock)) throw new Error("packed shrinkwrap does not match package-lock.json");
    listTar(archive);
    const packedRelease = JSON.parse(
      spawnSync("/usr/bin/tar", ["-xOzf", archive, "package/pkg/release.json"], {
        encoding: "utf8",
        timeout: 15_000,
      }).stdout,
    );
    if (process.platform !== "darwin") {
      process.stdout.write(
        `ARTIFACT_INSTALL_SKIP ${JSON.stringify({
          reason: "Steps 2-7 require macOS /usr/bin/sandbox-exec",
          platform: process.platform,
          arch: process.arch,
          node: process.version,
        })}\n`,
      );
      return;
    }

    const home = join(scratch, "home");
    const instance = join(scratch, "instance & space");
    const bin = join(scratch, "bin");
    const tmp = join(scratch, "tmp");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(instance, { recursive: true, mode: 0o700 });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const logPath = join(scratch, "security.log");
    writeSecurityShim(bin, logPath);
    const canonicalHome = realpathSync(instance);
    assertNoAncestorModules(canonicalHome);
    const operationId = `artifact-${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
    const nodePath = process.execPath;
    const npmCliPath = resolveNpmCli();
    const selfTest = await runConfinementSelfTest({
      canonicalInstanceHome: canonicalHome,
      operationId,
      nodePath,
    });
    const collector = startDenialCollector();
    const trackedIO = trackJobSpawns(nodeConfinedJobIO, collector);
    const jobsParent = join(canonicalHome, ".hive-state", "jobs", operationId);
    mkdirSync(jobsParent, { recursive: true, mode: 0o700 });
    const promotion = await selectPromotionMethod({
      sourceParent: jobsParent,
      destinationParent: canonicalHome,
    });
    const runner = new ConfinedJobRunner({
      canonicalInstanceHome: canonicalHome,
      operationId,
      selfTest,
      io: trackedIO,
    });
    const nextDir = join(canonicalHome, ".hive.next");
    const stagedCandidate = await stageVerifiedCandidate({
      selector: { artifact: archive },
      context: {
        runner,
        nodePath,
        npmCliPath,
        invokingHome: home,
        pathEnv: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
        archiveDirectory: join(canonicalHome, ".hive-state", "archives", operationId),
        promotionMethod: promotion.method,
      },
      destination: nextDir,
      requireClean: false,
    });
    const evidence = await collector.stop();
    const denialLines = jobDenialLines(evidence, collector.pids, token);
    const denials = denialLines.length;
    if (denials !== 0) {
      throw new Error(
        `sandbox denials during confined install: ${denials}\n${denialLines.slice(0, 20).join("\n")}`,
      );
    }
    if (!npmDebugLogPresent(stagedCandidate.installed.job.job.path, JOB_WRITE_LOCATIONS.npmLogs)) {
      throw new Error("npm debug log missing from the install job directory");
    }
    const hive = join(canonicalHome, ".hive");
    renameSync(nextDir, hive);
    let runtimeOk = null;
    let engineOk = null;
    for (const job of stagedCandidate.verification.jobs) {
      const text = job.stdout.toString("utf8");
      if (text.includes("ARTIFACT_RUNTIME_OK ")) runtimeOk = printRecord(text, "ARTIFACT_RUNTIME_OK");
      if (text.includes("ENGINE_VALIDATE_OK ")) engineOk = printRecord(text, "ENGINE_VALIDATE_OK");
    }
    if (!runtimeOk || !engineOk) throw new Error("clone verification did not emit both runtime-loading records");
    const expected = {
      packageVersion: packedRelease.packageVersion,
      sourceRevision: packedRelease.sourceRevision,
      dependencyLockSha256: packedRelease.dependencyLockSha256,
    };
    if (
      runtimeOk.manifest.packageVersion !== expected.packageVersion ||
      engineOk.manifest.packageVersion !== expected.packageVersion
    ) {
      throw new Error("runtime-loading identity mismatch against packed manifest");
    }
    await exerciseInstalled(hive, canonicalHome, bin, tmp, logPath, expected);

    const movedParent = join(scratch, "moved & parent");
    mkdirSync(movedParent, { recursive: true, mode: 0o700 });
    const moved = join(movedParent, "instance & space");
    renameSync(canonicalHome, moved);
    const movedHive = join(moved, ".hive");
    await exerciseInstalled(movedHive, moved, bin, tmp, logPath, expected);

    const link = join(scratch, "symlink-home");
    symlinkSync(moved, link);
    await exerciseInstalled(realpathSync(join(link, ".hive")), realpathSync(link), bin, tmp, logPath, expected);

    const macos = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
    process.stdout.write(
      `ARTIFACT_INSTALL_OK ${JSON.stringify({
        archiveSha256: archiveDigest,
        lockSha256: sha256(lock),
        release: expected,
        relativePaths: ["pkg/server.min.js", "pkg/voice-worker.min.js", "pkg/voice-worker-diagnostic.min.js"],
        runtime: { node: process.version, npm: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim() },
        platform: process.platform,
        arch: process.arch,
        macosVersion: macos.stdout.trim(),
        selfTest,
        promotionMethod: promotion.method,
        jobs: {
          install: {
            exitCode: stagedCandidate.installed.job.exitCode,
            denials,
            npmDebugLog: true,
          },
        },
      })}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    console.error(`cause: ${cause.name}: ${cause.message}`);
    if ("stderrTail" in cause && typeof cause.stderrTail === "string" && cause.stderrTail) {
      console.error(`job stderr:\n${cause.stderrTail}`);
    }
  }
  process.exit(1);
}
