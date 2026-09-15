import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  cpSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startDisposableMongo, type DisposableMongo } from "./s9-mongo.js";
import { startLivekitMock, type LivekitMock } from "./s9-livekit.js";
import type { PackedRelease } from "./s9-packages.js";

const REPO = resolve(fileURLToPath(new URL("../../../package.json", import.meta.url)), "..");
export const PRELOADER = resolve(REPO, "src/deployment/testing/s9-preloader.mjs");
export const STANDIN = resolve(REPO, "src/deployment/testing/s9-standin.mjs");

export const DUMMY_ENV = {
  SLACK_APP_TOKEN: "xapp-s9-dummy",
  SLACK_BOT_TOKEN: "xoxb-s9-dummy",
  LIVEKIT_API_KEY: "s9-lk-key",
  LIVEKIT_API_SECRET: "s9-lk-secret-s9-lk-secret",
  HIVE_VOICE_BRIDGE_TOKEN: "s9-bridge-token",
  DEEPGRAM_API_KEY: "s9-deepgram",
  CARTESIA_API_KEY: "s9-cartesia",
  ELEVENLABS_API_KEY: "s9-eleven",
};

export interface S9Flags {
  bypassInstallSandbox?: boolean;
  renamePromote?: boolean;
  hideSandboxExec?: boolean;
  latchCp?: boolean;
  latchRename?: boolean;
  latchRotate?: boolean;
  latchSandbox?: boolean;
  latchPromote?: boolean;
  delayClose?: boolean;
  admission?: "open" | "closed" | "faulted";
}

export interface S9Fixture {
  root: string;
  home: string;
  hiveHome: string;
  userHome: string;
  configPath: string;
  control: string;
  instanceId: string;
  ports: { base: number; voice: number; worker: number; mongo: number; livekit: number };
  mongo: DisposableMongo;
  livekit: LivekitMock;
  helper: string;
  cli: string;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("port bind failed"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
    server.on("error", rejectPromise);
  });
}

function writeEnv(path: string, extra: Record<string, string> = {}): void {
  const lines = Object.entries({ ...DUMMY_ENV, ...extra }).map(([key, value]) => `${key}=${value}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export function writeControl(
  fixture: Pick<S9Fixture, "control" | "home" | "userHome" | "root" | "ports">,
  flags: S9Flags = {},
  extras: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(fixture.control, "config.json"),
    JSON.stringify(
      {
        allowRoots: [fixture.root, fixture.home, fixture.userHome, tmpdir(), "/tmp", "/private/tmp"],
        repoRoot: REPO,
        standinPath: STANDIN,
        mongoUri: extras.mongoUri ?? `mongodb://127.0.0.1:${fixture.ports.mongo}`,
        mongoDb: extras.mongoDb ?? `hive_${extras.instanceId ?? "s9a"}`,
        workerPort: fixture.ports.worker,
        voicePort: fixture.ports.voice,
        bridgeToken: DUMMY_ENV.HIVE_VOICE_BRIDGE_TOKEN,
        flags,
      },
      null,
      2,
    ),
  );
}

export async function createFixture(options: {
  packed: PackedRelease;
  instanceId?: string;
  seedHive?: PackedRelease;
  flags?: S9Flags;
  personal?: boolean;
  mongoDb?: string;
}): Promise<S9Fixture> {
  const instanceId = options.instanceId ?? "s9a";
  const root = mkdtempSync(join(tmpdir(), "hive-s9-fix-"));
  const userHome = join(root, "home");
  const hiveHome = join(userHome, "hive");
  mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true, mode: 0o755 });
  mkdirSync(join(hiveHome, "logs"), { recursive: true, mode: 0o755 });
  mkdirSync(join(hiveHome, "service"), { recursive: true, mode: 0o755 });
  mkdirSync(join(hiveHome, ".hive-state"), { recursive: true, mode: 0o700 });
  const [base, mongoPort, livekitPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const voice = base + 5;
  const worker = base + 7;
  const mongo = await startDisposableMongo(mongoPort);
  const livekit = await startLivekitMock(livekitPort);
  const configName = options.personal ? "hive-personal.yaml" : "hive.yaml";
  const configPath = join(hiveHome, configName);
  writeFileSync(
    configPath,
    [
      "instance:",
      `  id: ${instanceId}`,
      `  portBase: ${base}`,
      "voice:",
      "  livekit:",
      "    enabled: true",
      `    url: ${livekit.url}`,
      "    sipTrunkId: ST_s9",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  writeEnv(join(hiveHome, ".env"), { MONGODB_URI: mongo.uri });
  if (options.personal) {
    writeEnv(join(hiveHome, ".env-personal"), {
      MONGODB_URI: mongo.uri,
      HIVE_VOICE_BRIDGE_TOKEN: "s9-personal-bridge",
      VOICE_PORT: String(voice + 10),
    });
  }
  if (options.seedHive) {
    cpSync(join(options.seedHive.extract, "package"), join(hiveHome, ".hive"), { recursive: true });
    writeFileSync(
      join(hiveHome, ".hive", "service", "deploy.sh"),
      '#!/bin/bash\necho OLD_UPDATER_CALLED >> "$HIVE_HOME/old-updater.log"\nexit 97\n',
      { mode: 0o755 },
    );
  }
  writeFileSync(join(hiveHome, "hive.yaml.sentinel"), "preserve-me\n", { mode: 0o644 });
  mkdirSync(join(hiveHome, "agents"), { recursive: true });
  writeFileSync(join(hiveHome, "agents", "keep.txt"), "agent-sentinel\n", { mode: 0o644 });
  const control = join(root, "control");
  mkdirSync(join(control, "latches"), { recursive: true });
  const fixture: S9Fixture = {
    root,
    home: hiveHome,
    hiveHome,
    userHome,
    configPath,
    control,
    instanceId,
    ports: { base, voice, worker, mongo: mongoPort, livekit: livekitPort },
    mongo,
    livekit,
    helper: join(options.packed.extract, "package", "pkg", "deploy.min.js"),
    cli: join(options.packed.extract, "package", "pkg", "cli.min.js"),
  };
  writeControl(fixture, options.flags ?? {}, {
    mongoUri: mongo.uri,
    mongoDb: options.mongoDb ?? `hive_${instanceId}`,
    instanceId,
  });
  writeFileSync(join(userHome, ".s9-control"), `${control}\n`, { mode: 0o600 });
  return fixture;
}

export async function destroyFixture(fixture: S9Fixture): Promise<void> {
  await fixture.mongo.stop().catch(() => {});
  await fixture.livekit.stop().catch(() => {});
  rmSync(fixture.root, { recursive: true, force: true });
}

export interface HelperResult {
  status: number;
  stdout: string;
  stderr: string;
  pid: number | undefined;
}

export function helperEnv(fixture: S9Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const importUrl = pathToFileURL(PRELOADER).href;
  const pathEnv = `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${dirname(process.execPath)}`;
  return {
    HOME: fixture.userHome,
    PATH: pathEnv,
    TMPDIR: tmpdir(),
    USER: process.env.USER ?? "s9",
    LOGNAME: process.env.LOGNAME ?? "s9",
    LANG: "C",
    LC_ALL: "C",
    HIVE_HOME: fixture.hiveHome,
    HIVE_CONFIG: fixture.configPath,
    HIVE_SINGLE_INSTANCE: "1",
    HIVE_S9_CONTROL: fixture.control,
    NODE_OPTIONS: `--import ${importUrl}`,
    ...extra,
  };
}

export function invokeHelper(
  fixture: S9Fixture,
  args: readonly string[],
  options: { helper?: string; timeoutMs?: number; extraEnv?: NodeJS.ProcessEnv } = {},
): HelperResult {
  const helper = options.helper ?? fixture.helper;
  const importUrl = pathToFileURL(PRELOADER).href;
  try {
    const stdout = execFileSync(process.execPath, ["--import", importUrl, helper, ...args], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15 * 60_000,
      env: helperEnv(fixture, options.extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: "", pid: undefined };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      pid: undefined,
    };
  }
}

export function spawnHelper(
  fixture: S9Fixture,
  args: readonly string[],
  options: { helper?: string; extraEnv?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const helper = options.helper ?? fixture.helper;
  const importUrl = pathToFileURL(PRELOADER).href;
  const stdout = openSync(join(fixture.control, "helper.stdout"), "a");
  const stderr = openSync(join(fixture.control, "helper.stderr"), "a");
  const child = spawn(process.execPath, ["--import", importUrl, helper, ...args], {
    env: helperEnv(fixture, options.extraEnv),
    stdio: ["ignore", stdout, stderr],
    detached: true,
  });
  return child;
}

export async function killHelperTree(
  child: ChildProcess,
  fixture?: Pick<S9Fixture, "hiveHome" | "root">,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const killPid = (target: number): void => {
    try {
      const children = execFileSync("/usr/bin/pgrep", ["-P", String(target)], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 1);
      for (const descendant of children) killPid(descendant);
    } catch {
      // no children
    }
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  };
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // not a process group leader
  }
  killPid(pid);
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  if (fixture) {
    for (const needle of [fixture.hiveHome, fixture.root]) {
      try {
        execFileSync("/usr/bin/pkill", ["-9", "-f", needle], { stdio: "ignore" });
      } catch {
        // no remaining descendants
      }
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(timer);
      resolve();
      return;
    }
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === second) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function continueLatch(fixture: S9Fixture, name: string): void {
  mkdirSync(join(fixture.control, "latches"), { recursive: true });
  writeFileSync(join(fixture.control, "latches", name), "1\n");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function waitFor(predicate: () => boolean, timeoutMs = 60_000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return predicate();
}

export { randomUUID, symlinkSync, chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync };
