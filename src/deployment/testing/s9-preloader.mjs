/**
 * S9 OS-boundary preloader. Loaded only by lifecycle/adoption/confinement
 * integration tests via `--import` / NODE_OPTIONS. It wraps builtin
 * child_process and a few filesystem/clock entrypoints, then calls
 * syncBuiltinESMExports. Production helper/parser/reconciler stay unchanged.
 *
 * Never intercepts /usr/bin/sandbox-exec except T7 negative 1 (install job
 * only). T2/T10 never load this file.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const CP = "/bin/cp";
const PRELOADER = fileURLToPath(import.meta.url);
const homedir = process.env.HOME;
const controlFromHome =
  homedir && isAbsolute(homedir) && existsSync(join(homedir, ".s9-control"))
    ? readFileSync(join(homedir, ".s9-control"), "utf8").trim()
    : "";
const CONTROL = process.env.HIVE_S9_CONTROL || controlFromHome;

if (!CONTROL || !isAbsolute(CONTROL)) {
  throw new Error("S9 preloader requires absolute HIVE_S9_CONTROL or $HOME/.s9-control");
}

function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(1, ms));
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function appendEvent(event) {
  try {
    fs.appendFileSync(join(CONTROL, "events.jsonl"), JSON.stringify({ ts: Date.now(), pid: process.pid, ...event }) + "\n");
  } catch {
    // Control directory may be mid-cleanup.
  }
}

function config() {
  return readJson(join(CONTROL, "config.json"), { allowRoots: [], flags: {} });
}

function forbiddenOperatorPath(path) {
  if (typeof path !== "string" || !path) return false;
  const real = path;
  const blocked = ["/Users/mokie/services/hive", "/Users/mokie/Library/LaunchAgents"];
  return blocked.some((root) => real === root || real.startsWith(`${root}/`));
}

function allowed(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return true;
  if (forbiddenOperatorPath(path)) {
    const roots = config().allowRoots ?? [];
    return roots.some((root) => path === root || path.startsWith(`${root}${sep}`) || path.startsWith(`${root}/`));
  }
  return true;
}

function assertAllowed(...paths) {
  for (const path of paths) {
    if (path && !allowed(path)) {
      throw new Error(`S9 preloader aborted: operator path ${path}`);
    }
  }
}

function waitLatch(name, timeoutMs = 600_000) {
  const flag = join(CONTROL, "latches", name);
  const start = Date.now();
  mkdirSync(join(CONTROL, "latches"), { recursive: true });
  writeAtomic(join(CONTROL, "latches", `${name}.waiting`), { pid: process.pid, at: Date.now() });
  while (!existsSync(flag)) {
    if (Date.now() - start > timeoutMs) throw new Error(`S9 latch timeout: ${name}`);
    sleepSync(25);
  }
}

function maybeLatchCp(argv) {
  const flags = config().flags ?? {};
  const source = argv.at(-2);
  if (
    argv.includes("-R") &&
    flags.latchCp &&
    typeof source === "string" &&
    existsSync(join(source, ".t7-writer.pid"))
  ) {
    waitLatch("cp");
  }
  const destination = argv.at(-1);
  if (flags.latchPromote && argv.includes("-R") && typeof destination === "string" && destination.endsWith(`${sep}.hive.next`)) {
    waitLatch("cp");
  }
}

function maybeLatchRename(from, to) {
  const flags = config().flags ?? {};
  if (flags.latchRename && typeof to === "string" && to.includes(`${sep}tooling${sep}`) && !to.includes(".staging")) {
    waitLatch("tooling-rename");
  }
  if (
    flags.latchRotate &&
    typeof from === "string" &&
    typeof to === "string" &&
    from.endsWith(`${sep}.hive.next`) &&
    to.endsWith(`${sep}.hive`)
  ) {
    waitLatch("rotate");
  }
}

function launchdState() {
  return readJson(join(CONTROL, "launchd.json"), { services: {} });
}

function saveLaunchd(state) {
  writeAtomic(join(CONTROL, "launchd.json"), state);
}

function padStartTime(value) {
  const text = String(value ?? "").trim();
  if (text.length === 24) return text;
  return (text + " ".repeat(24)).slice(0, 24);
}

function readLstart(pid) {
  try {
    const out = childProcess.execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return padStartTime(out.trim());
  } catch {
    return padStartTime(new Date().toString());
  }
}

function parsePlistArgs(plistPath) {
  try {
    const json = childProcess.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(json);
    return {
      args: parsed.ProgramArguments ?? [],
      cwd: parsed.WorkingDirectory,
      env: parsed.EnvironmentVariables ?? {},
      stdout: parsed.StandardOutPath,
      stderr: parsed.StandardErrorPath,
    };
  } catch {
    return null;
  }
}

function instanceSlice(hiveHome) {
  const cfg = config();
  const instances = cfg.instances && typeof cfg.instances === "object" ? cfg.instances : {};
  const keys = [];
  if (hiveHome) keys.push(hiveHome);
  try {
    if (hiveHome) keys.push(fs.realpathSync(hiveHome));
  } catch {
    // selector may not exist yet
  }
  const slice = keys.map((key) => (Object.prototype.hasOwnProperty.call(instances, key) ? instances[key] : null)).find(Boolean) ?? null;
  return {
    mongoUri: slice?.mongoUri ?? cfg.mongoUri ?? "",
    mongoDb: slice?.mongoDb ?? cfg.mongoDb ?? "",
    workerPort: slice?.workerPort ?? cfg.workerPort,
    voicePort: slice?.voicePort ?? cfg.voicePort,
    bridgeToken: cfg.bridgeToken ?? "",
    flags: cfg.flags ?? {},
    standinPath: cfg.standinPath,
    repoRoot: cfg.repoRoot,
  };
}

function spawnStandin(label, plistPath) {
  const parsed = parsePlistArgs(plistPath);
  if (!parsed || parsed.args.length < 2) throw new Error(`S9 stand-in missing plist arguments for ${label}`);
  const hiveHome = parsed.env?.HIVE_HOME;
  const slice = instanceSlice(hiveHome);
  const standin = slice.standinPath;
  if (!standin || !existsSync(standin)) throw new Error("S9 stand-in path missing");
  const role = label.endsWith(".voice-worker") ? "worker" : "engine";
  const listenPort = role === "worker" ? Number(slice.workerPort) : Number(slice.voicePort);
  const env = {
    ...parsed.env,
    HIVE_S9_CONTROL: CONTROL,
    HIVE_S9_ROLE: role,
    HIVE_S9_LABEL: label,
    HIVE_S9_REPO: slice.repoRoot,
    HIVE_S9_MONGO_URI: slice.mongoUri ?? "",
    HIVE_S9_MONGO_DB: slice.mongoDb ?? "",
    HIVE_S9_WORKER_PORT: String(slice.workerPort ?? ""),
    HIVE_S9_VOICE_PORT: String(slice.voicePort ?? ""),
    HIVE_S9_BRIDGE_TOKEN: slice.bridgeToken ?? "",
    HIVE_S9_ADMISSION: slice.flags?.admission ?? "open",
    HIVE_S9_DELAY_CLOSE: slice.flags?.delayClose ? "1" : "",
    PATH: parsed.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    NODE_PATH: join(slice.repoRoot, "node_modules"),
  };
  const child = childProcess.spawn(parsed.args[0], [standin, `--role=${role}`, `--plist=${plistPath}`], {
    cwd: parsed.cwd,
    env,
    stdio: ["ignore", parsed.stdout ? fs.openSync(parsed.stdout, "a") : "ignore", parsed.stderr ? fs.openSync(parsed.stderr, "a") : "ignore"],
    detached: true,
  });
  child.unref();
  if (!child.pid) throw new Error(`S9 stand-in failed to spawn for ${label}`);
  const startTime = readLstart(child.pid);
  const state = launchdState();
  state.services[label] = {
    pid: child.pid,
    ppid: process.pid,
    startTime,
    command: parsed.args.join(" "),
    cwd: parsed.cwd,
    executable: parsed.args[0],
    loaded: true,
    enabled: true,
    plistPath,
    hiveHome,
    listenPort,
  };
  saveLaunchd(state);
  appendEvent({ type: "standin-spawn", label, pid: child.pid });
  const identityName = role === "worker" ? "voice-worker.json" : "engine.json";
  if (hiveHome) {
    const identityPath = join(hiveHome, ".hive-state", "runtime", identityName);
    const started = Date.now();
    while (true) {
      if (existsSync(identityPath)) {
        try {
          const identity = JSON.parse(readFileSync(identityPath, "utf8"));
          if (identity.pid === child.pid) break;
        } catch {
          // identity is still being replaced
        }
      }
      if (Date.now() - started > 20_000) throw new Error(`S9 stand-in identity timeout for ${label}`);
      sleepSync(25);
    }
  }
  return child.pid;
}

function handleLaunchctl(args) {
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const cmd = args[0];
  const state = launchdState();
  if (cmd === "print-disabled") {
    const lines = ["disabled services = {"];
    for (const [label, service] of Object.entries(state.services)) {
      lines.push(`\t"${label}" => ${service.enabled ? "false" : "true"}`);
    }
    lines.push("}");
    return { stdout: `${lines.join("\n")}\n`, stderr: "", status: 0 };
  }
  if (cmd === "print") {
    const target = args[1] ?? "";
    const label = target.startsWith(`${domain}/`) ? target.slice(domain.length + 1) : target;
    const service = state.services[label];
    if (!service?.loaded) {
      const error = new Error("Could not find service");
      error.status = 1;
      error.code = 1;
      error.stdout = "";
      error.stderr = "Could not find service\n";
      throw error;
    }
    const lines = [`state = ${service.pid ? "running" : "not running"}`];
    if (service.pid) lines.push(`pid = ${service.pid}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", status: 0 };
  }
  if (cmd === "enable" || cmd === "disable") {
    const target = args[1] ?? "";
    const label = target.startsWith(`${domain}/`) ? target.slice(domain.length + 1) : target;
    state.services[label] = { ...(state.services[label] ?? {}), enabled: cmd === "enable", loaded: state.services[label]?.loaded ?? false };
    saveLaunchd(state);
    appendEvent({ type: cmd, label });
    return { stdout: "", stderr: "", status: 0 };
  }
  if (cmd === "bootstrap") {
    const plistPath = args[2];
    assertAllowed(plistPath);
    const parsed = parsePlistArgs(plistPath);
    const label = parsed ? basename(plistPath, ".plist") : "";
    spawnStandin(label, plistPath);
    appendEvent({ type: "bootstrap", label });
    return { stdout: "", stderr: "", status: 0 };
  }
  if (cmd === "bootout") {
    const target = args[1] ?? "";
    const label = target.startsWith(`${domain}/`) ? target.slice(domain.length + 1) : target;
    const service = state.services[label];
    if (service?.pid) {
      const pid = service.pid;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      const until = Date.now() + 2_000;
      while (Date.now() < until) {
        try {
          process.kill(pid, 0);
          sleepSync(10);
        } catch {
          break;
        }
      }
    }
    state.services[label] = { ...(service ?? {}), pid: null, loaded: false };
    saveLaunchd(state);
    appendEvent({ type: "bootout", label });
    return { stdout: "", stderr: "", status: 0 };
  }
  return null;
}

function fakePsCommand(pid) {
  for (const service of Object.values(launchdState().services)) {
    if (service?.pid === Number(pid)) return service;
  }
  return null;
}

function handlePs(args) {
  const pIndex = args.indexOf("-p");
  if (pIndex < 0) return null;
  const pid = Number(args[pIndex + 1]);
  const service = fakePsCommand(pid);
  if (!service) return null;
  const format = args[args.indexOf("-o") + 1] ?? "";
  if (format === "uid=") {
    return { stdout: `${process.getuid?.() ?? 0}\n`, stderr: "", status: 0 };
  }
  if (format === "comm=") {
    return { stdout: `${service.executable}\n`, stderr: "", status: 0 };
  }
  if (format === "lstart=") {
    return { stdout: `${service.startTime}\n`, stderr: "", status: 0 };
  }
  if (String(format).includes("command=")) {
    const ppid = service.ppid ?? 1;
    return {
      stdout: `${String(service.pid).padStart(5)} ${String(ppid).padStart(5)} ${padStartTime(service.startTime)} ${service.command}\n`,
      stderr: "",
      status: 0,
    };
  }
  return null;
}

function handleLsof(args) {
  const joined = args.join(" ");
  if (joined.includes("-d") && joined.includes("cwd")) {
    const pIndex = args.indexOf("-p");
    const service = fakePsCommand(args[pIndex + 1]);
    if (!service) return null;
    return { stdout: `p${service.pid}\nfcwd\nn${service.cwd}\n`, stderr: "", status: 0 };
  }
  if (joined.includes("-d") && joined.includes("txt")) {
    const pIndex = args.indexOf("-p");
    const service = fakePsCommand(args[pIndex + 1]);
    if (!service) return null;
    return { stdout: `p${service.pid}\nftxt\nn${service.executable}\n`, stderr: "", status: 0 };
  }
  const tcp = args.find((value) => String(value).startsWith("-iTCP:"));
  if (tcp && joined.includes("LISTEN")) {
    const port = Number(String(tcp).slice("-iTCP:".length));
    const cfg = config();
    const services = Object.values(launchdState().services);
    let service = services.find((candidate) => candidate?.pid && Number(candidate.listenPort) === port);
    if (!service?.pid) {
      const workerPort = Number(cfg.workerPort);
      const voicePort = Number(cfg.voicePort);
      if (Number.isFinite(port) && port === workerPort) {
        service = services.find(
          (candidate) => candidate?.pid && String(candidate.plistPath ?? candidate.command ?? "").includes("voice-worker"),
        );
      } else if (Number.isFinite(port) && port === voicePort) {
        service = services.find(
          (candidate) =>
            candidate?.pid &&
            (String(candidate.plistPath ?? "").includes(".agent.plist") ||
              String(candidate.command ?? "").includes("server.min.js")),
        );
      }
    }
    if (!service?.pid) {
      const error = new Error("lsof: no matching listeners");
      error.status = 1;
      error.code = 1;
      error.stdout = "";
      error.stderr = "";
      throw error;
    }
    // Historical packed probes parse only `p`/`n` field letters.
    return { stdout: `p${service.pid}\nn127.0.0.1:${port}\n`, stderr: "", status: 0 };
  }
  return null;
}

function handleSecurity(args) {
  if (args[0] === "find-generic-password") {
    const error = new Error("item not found");
    error.status = 44;
    error.code = 44;
    error.stdout = "";
    error.stderr = "";
    throw error;
  }
  return null;
}

function isSandboxExec(command) {
  return command === SANDBOX_EXEC || basename(command) === "sandbox-exec";
}

function isInstallJob(args) {
  const text = args.join(" ");
  return text.includes("npm-cli.js") && (text.includes("ci") || text.includes("--omit=dev"));
}

function replaceCpWithRename(args) {
  const source = args.at(-2);
  const destination = args.at(-1);
  assertAllowed(source, destination);
  appendEvent({ type: "rename-promote", source, destination });
  return childProcess.spawn("/bin/mv", [source, destination], { stdio: "pipe" });
}

function wrapSpawn(original) {
  return function spawn(command, args, options) {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    assertAllowed(command, opts?.cwd, ...(argv.filter((value) => typeof value === "string" && value.startsWith("/"))));
    const flags = config().flags ?? {};
    if (isSandboxExec(command)) {
      appendEvent({ type: "sandbox-exec", argv: argv.slice(0, 4), cwd: opts?.cwd });
      if (flags.latchSandbox) waitLatch("sandbox-exec");
      if (flags.bypassInstallSandbox && isInstallJob(argv)) {
        appendEvent({ type: "sandbox-bypass-install" });
        const inner = argv.slice(2);
        return original.call(this, inner[0], inner.slice(1), opts);
      }
      return original.call(this, command, argv, opts);
    }
    if (command === CP || basename(command) === "cp") {
      appendEvent({ type: "cp", argv });
      maybeLatchCp(argv);
      const destination = argv.at(-1);
      if (argv.includes("-R") && flags.renamePromote && argv.includes("-c")) {
        appendEvent({ type: "rename-promote-spawn", destination });
        return replaceCpWithRename(argv);
      }
    }
    if (typeof command === "string" && (command === process.execPath || basename(command) === "node")) {
      const injected = injectImport(argv);
      return original.call(this, command, injected, opts);
    }
    return original.call(this, command, argv, opts);
  };
}

function injectImport(argv) {
  if (!Array.isArray(argv)) return argv;
  if (argv.some((arg) => String(arg).includes("s9-preloader"))) return argv;
  // Stand-in is the fake service process; it must not wrap launchctl/ps.
  if (argv.some((arg) => String(arg).includes("s9-standin"))) return argv;
  const url = `file://${PRELOADER}`;
  return ["--import", url, ...argv];
}

function wrapExec(original, sync) {
  function wrapped(file, args, options, callback) {
    let argv = [];
    let opts = {};
    let cb = callback;
    if (typeof args === "function") {
      cb = args;
    } else if (typeof options === "function") {
      argv = Array.isArray(args) ? args : [];
      opts = Array.isArray(args) ? {} : args ?? {};
      cb = options;
    } else {
      argv = Array.isArray(args) ? args : [];
      opts = options ?? {};
    }
    const command = file;
    assertAllowed(command, ...(argv.filter((value) => typeof value === "string" && value.startsWith("/"))));
    const flags = config().flags ?? {};
    try {
      if (flags.hideSandboxExec && (command === SANDBOX_EXEC || basename(command) === "sandbox-exec")) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      let handled = null;
      if (basename(command) === "launchctl" || command === "launchctl") handled = handleLaunchctl(argv);
      else if (basename(command) === "ps" || command === "ps" || command === "/bin/ps") handled = handlePs(argv);
      else if (basename(command) === "lsof" || command === "lsof") handled = handleLsof(argv);
      else if (basename(command) === "security" || command === "security") handled = handleSecurity(argv);
      if (handled) {
        if (sync) return handled.stdout;
        if (typeof cb === "function") {
          queueMicrotask(() => cb(null, handled.stdout, handled.stderr));
          return {};
        }
        return Promise.resolve({ stdout: handled.stdout, stderr: handled.stderr });
      }
    } catch (error) {
      if (sync) throw error;
      if (typeof cb === "function") {
        queueMicrotask(() => cb(error, error.stdout ?? "", error.stderr ?? ""));
        return {};
      }
      return Promise.reject(error);
    }
    if ((command === CP || basename(command) === "cp") && Array.isArray(argv)) {
      appendEvent({ type: "cp", argv, via: sync ? "execFileSync" : "execFile" });
      maybeLatchCp(argv);
    }
    if (typeof command === "string" && (command === process.execPath || basename(command) === "node") && Array.isArray(argv)) {
      argv = injectImport(argv);
    }
    if (sync) return original.call(this, command, argv, opts);
    return original.call(this, command, argv, opts, cb);
  }
  if (!sync) {
    wrapped[promisify.custom] = (file, args, options) =>
      new Promise((resolve, reject) => {
        wrapped(file, args ?? [], options ?? {}, (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
            return;
          }
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      });
  }
  return wrapped;
}

function wrapAccess(original) {
  return function access(path, mode, callback) {
    const flags = config().flags ?? {};
    if (flags.hideSandboxExec && path === SANDBOX_EXEC) {
      const error = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      if (typeof mode === "function") return mode(error);
      if (typeof callback === "function") return callback(error);
      return Promise.reject(error);
    }
    return original.apply(this, arguments);
  };
}

function wrapRename(original, sync) {
  return function rename(from, to, callback) {
    assertAllowed(from, to);
    maybeLatchRename(from, to);
    if (sync) return original.call(this, from, to);
    return original.call(this, from, to, callback);
  };
}

function wrapPromisesRename(original) {
  return async function rename(from, to) {
    assertAllowed(from, to);
    maybeLatchRename(from, to);
    return original.call(this, from, to);
  };
}

childProcess.spawn = wrapSpawn(childProcess.spawn);
childProcess.execFile = wrapExec(childProcess.execFile, false);
childProcess.execFileSync = wrapExec(childProcess.execFileSync, true);
fs.access = wrapAccess(fs.access);
const originalAccessSync = fs.accessSync.bind(fs);
fs.accessSync = function (path, mode) {
  const flags = config().flags ?? {};
  if (flags.hideSandboxExec && path === SANDBOX_EXEC) {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }
  return originalAccessSync(path, mode);
};
const originalRenameSync = fs.renameSync.bind(fs);
fs.renameSync = wrapRename(originalRenameSync, true);
fs.rename = wrapRename(fs.rename.bind(fs), false);

function wrapPromisesAccess(mod) {
  if (!mod?.access) return;
  const originalAccess = mod.access.bind(mod);
  mod.access = async (path, mode) => {
    const flags = config().flags ?? {};
    if (flags.hideSandboxExec && path === SANDBOX_EXEC) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return originalAccess(path, mode);
  };
}

function wrapPromisesModule(mod) {
  if (!mod) return;
  wrapPromisesAccess(mod);
  if (mod.rename) mod.rename = wrapPromisesRename(mod.rename.bind(mod));
}

if (fs.promises) wrapPromisesModule(fs.promises);
for (const id of ["fs/promises", "node:fs/promises"]) {
  try {
    wrapPromisesModule(require(id));
  } catch {
    // builtin id not present
  }
}

try {
  Module.syncBuiltinESMExports();
} catch {
  // Older Node without the helper still has the CJS wraps above.
}

if (process.argv.some((value) => String(value).includes("runtime-probe"))) {
  delete process.env.__CF_USER_TEXT_ENCODING;
}

appendEvent({ type: "preloader-loaded", argv: process.argv.slice(1, 3) });
