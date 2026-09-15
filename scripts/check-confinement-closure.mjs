#!/usr/bin/env node
/**
 * T10 confinement-closure harness (KPR-463 Task 3 Step 5).
 *
 * On macOS ARM64 with Node major 24 this records T10(a)–(e) against a real
 * packed artifact using the production launcher, profile and clone path.
 * Any other platform or Node major emits a named skip and exits 0 without
 * a closure record.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function nodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : null;
}

function skipRecord(reason) {
  process.stdout.write(
    `T10_SKIP ${JSON.stringify({
      status: "T10_SKIP",
      reason,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      nodeMajor: nodeMajor(),
      npm: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim(),
    })}\n`,
  );
}

function parseArgs(argv) {
  let artifact = null;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--artifact=")) {
      artifact = arg.slice("--artifact=".length);
      if (!artifact || !artifact.startsWith("/")) throw new Error("--artifact must be an absolute path");
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }
  return { artifact };
}

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

function packRepository(destination) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/generate-shrinkwrap.mjs"), "--pack", "--json", "--pack-destination", destination],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) throw new Error(`pack:release failed: ${result.stderr || result.stdout}`);
  const info = parsePack(result.stdout);
  return join(destination, info.filename);
}

const major = nodeMajor();
if (process.platform !== "darwin" || process.arch !== "arm64" || major !== 24) {
  skipRecord(
    major === 24
      ? `T10 closure requires macOS ARM64 (observed ${process.platform}/${process.arch})`
      : `T10 closure requires macOS ARM64 with Node major 24 (observed ${process.platform}/${process.arch} Node major ${String(major)})`,
  );
  process.exit(0);
}

const {
  ConfinedJobRunner,
  JOB_WRITE_LOCATIONS,
  requireJobSuccess,
  runConfinementSelfTest,
} = await import("../dist/deployment/confined-job.js");
const { selectPromotionMethod } = await import("../dist/deployment/clone-promotion.js");
const { stageVerifiedCandidate } = await import("../dist/deployment/artifact.js");

const { artifact: selected } = parseArgs(process.argv);
const scratch = mkdtempSync(join(tmpdir(), "hive-t10-"));
try {
  const artifact = selected ?? packRepository(join(scratch, "pack"));
  if (!existsSync(artifact) || !artifact.endsWith(".tgz")) throw new Error(`T10 artifact missing: ${artifact}`);

  const instance = join(scratch, "instance");
  const home = join(scratch, "home");
  const dummyHome = join(scratch, "dummy-home");
  mkdirSync(instance, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(dummyHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(dummyHome, "hive.yaml"), "instance:\n  id: t10\n");
  const canonicalHome = realpathSync(instance);
  const operationId = `t10-${createHash("sha256").update(canonicalHome).digest("hex").slice(0, 12)}`;
  const nodePath = process.execPath;
  const npmCliPath = resolveNpmCli();

  const selfTest = await runConfinementSelfTest({
    canonicalInstanceHome: canonicalHome,
    operationId,
    nodePath,
  });
  const jobsParent = join(canonicalHome, ".hive-state", "jobs", operationId);
  mkdirSync(jobsParent, { recursive: true, mode: 0o700 });
  const promotion = await selectPromotionMethod({
    sourceParent: jobsParent,
    destinationParent: canonicalHome,
  });
  const runner = new ConfinedJobRunner({ canonicalInstanceHome: canonicalHome, operationId, selfTest });
  const nextDir = join(canonicalHome, ".hive.next");
  const staged = await stageVerifiedCandidate({
    selector: { artifact },
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
  const hive = join(canonicalHome, ".hive");
  renameSync(nextDir, hive);

  const driver = join(scratch, "t10-sdk-driver.mjs");
  writeFileSync(
    driver,
    `${[
      "import { fork } from 'node:child_process';",
      "import { createRequire } from 'node:module';",
      "import { dirname, join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "import { realpathSync, readFileSync, existsSync } from 'node:fs';",
      "const hive = process.argv[2];",
      "const worker = join(hive, 'pkg', 'voice-worker.min.js');",
      "const requireFrom = createRequire(pathToFileURL(worker).href);",
      "const agentsEntry = requireFrom.resolve('@livekit/agents');",
      "let dir = dirname(realpathSync(agentsEntry));",
      "while (true) {",
      "  const manifest = join(dir, 'package.json');",
      "  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@livekit/agents') break;",
      "  const parent = dirname(dir);",
      "  if (parent === dir) throw new Error('agents-root');",
      "  dir = parent;",
      "}",
      "const sdkChild = join(dir, 'dist', 'ipc', 'job_proc_lazy_main.js');",
      "const inference = requireFrom.resolve('@livekit/local-inference');",
      "const rtc = await import('@livekit/rtc-node');",
      "const silero = await import('@livekit/agents-plugin-silero');",
      "const room = new rtc.Room();",
      "await silero.VAD.load({ forceCPU: true });",
      "await room.disconnect();",
      "await rtc.dispose();",
      "await new Promise((resolve, reject) => {",
      "  const child = fork(sdkChild, [worker], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });",
      "  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sdk timeout')); }, 15000);",
      "  let initialized = false;",
      "  child.on('message', (message) => {",
      "    if (message?.case === 'initializeResponse') {",
      "      initialized = true;",
      "      child.send({ case: 'shutdownRequest', value: {} });",
      "    }",
      "  });",
      "  child.send({ case: 'initializeRequest', value: { loggerOptions: { level: 'error', pretty: false } } });",
      "  child.on('exit', (code, signal) => {",
      "    clearTimeout(timer);",
      "    if (!initialized) reject(new Error('sdk exit without initializeResponse'));",
      "    else if (code) reject(new Error('sdk exit ' + code));",
      "    else if (signal) reject(new Error('sdk signal ' + signal));",
      "    else resolve();",
      "  });",
      "});",
      "process.stdout.write(JSON.stringify({ sdkChild, inference, ok: true }) + '\\n');",
      "",
    ].join("\n")}`,
  );
  const sdkJob = requireJobSuccess(
    await runner.run("runtime-loading", {
      command: nodePath,
      args: [driver, hive],
      cwd: hive,
      home: "job",
      pathEnv: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      extraEnv: { HIVE_HOME: dummyHome, HIVE_CONFIG: join(dummyHome, "hive.yaml") },
      timeoutMs: 120_000,
    }),
  );

  const macos = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
  const runtimeJobs = staged.verification.jobs.filter((job) => job.record.kind === "runtime-loading");
  process.stdout.write(
    `T10_CLOSURE ${JSON.stringify({
      a: { selfTest: selfTest.outcome, macosVersion: selfTest.macosVersion },
      b: {
        installExit: staged.installed.job.exitCode,
        npmLogs: existsSync(join(staged.installed.job.job.path, JOB_WRITE_LOCATIONS.npmLogs)),
      },
      c: { sdk: JSON.parse(sdkJob.stdout.toString("utf8") || "{}") },
      d: {
        jobs: runtimeJobs.map((job) => ({
          exitCode: job.exitCode,
          stdout: job.stdout.toString("utf8").slice(0, 4_096),
        })),
      },
      e: {
        macosVersion: macos.stdout.trim(),
        node: process.version,
        npm: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim(),
        selfTest: selfTest.outcome,
        platform: process.platform,
        arch: process.arch,
      },
    })}\n`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
