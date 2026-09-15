import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ServiceController,
  buildServiceDefinitions,
  buildServiceEnvironment,
  buildServicePlist,
  captureProgramArguments,
  getServiceLabel,
  getServiceLaunchAgentLink,
  getServicePlistPath,
  reconcileServiceOverrides,
  type ExecFileResult,
  type ServiceFileStat,
  type ServiceIO,
  type ServiceOverrides,
} from "./services.js";

const hiveHome = "/Users/example/Hive & Voice";
const userHome = "/Users/example";
const configPath = `${hiveHome}/hive-personal.yaml`;
const nodePath = "/opt/homebrew/opt/node@24/bin/node";

function definitions(overrides: { engineOverrides?: ServiceOverrides; workerOverrides?: ServiceOverrides } = {}) {
  return buildServiceDefinitions({
    instanceId: "personal_1",
    nodePath,
    hiveHome,
    configPath,
    home: userHome,
    pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    ...overrides,
  });
}

function stat(kind: "file" | "directory" | "symlink" = "file"): ServiceFileStat {
  return {
    mode: kind === "directory" ? 0o40700 : kind === "symlink" ? 0o120777 : 0o100600,
    dev: 1,
    ino: 2,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  };
}

function enoent(): Error & { code: string } {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function unloaded(): Error & { code: number; stderr: string } {
  return Object.assign(new Error("launchctl failed"), {
    code: 113,
    stderr: "Could not find specified service",
  });
}

function noProcess(): Error & { code: number; stdout: string; stderr: string } {
  return Object.assign(new Error("ps exited 1"), { code: 1, stdout: "", stderr: "" });
}

function makeIO(overrides: Partial<ServiceIO> = {}): ServiceIO {
  return {
    execFile: vi.fn(async () => ({ stdout: "", stderr: "" })),
    access: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    lstat: vi.fn(async () => stat()),
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => Buffer.from("prior")),
    readlink: vi.fn(async () => "target"),
    realpath: vi.fn(async (path) => path),
    rename: vi.fn(async () => {}),
    symlink: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    getuid: () => 501,
    now: () => 0,
    sleep: vi.fn(async () => {}),
    randomId: () => "fixed-id",
    ...overrides,
  };
}

function controller(io: ServiceIO, options: { stopTimeoutMs?: number; pollIntervalMs?: number } = {}) {
  return new ServiceController(
    {
      instanceId: "personal_1",
      hiveHome,
      home: userHome,
      operationDir: `${hiveHome}/.hive-state/deployment/operations/test`,
      ...options,
    },
    io,
  );
}

describe("service definitions", () => {
  it("builds the packaged engine and worker pair from explicit absolute selectors", () => {
    const pair = definitions({ workerOverrides: { VOICE_PORT: "4107" } });

    expect(pair.engine).toMatchObject({
      label: "com.hive.personal_1.agent",
      entrypoint: `${hiveHome}/.hive/pkg/server.min.js`,
      args: [],
      configPath,
      stdout: `${hiveHome}/logs/hive.log`,
    });
    expect(pair.worker).toMatchObject({
      label: "com.hive.personal_1.voice-worker",
      entrypoint: `${hiveHome}/.hive/pkg/voice-worker.min.js`,
      args: ["start"],
      configPath,
      stdout: `${hiveHome}/logs/voice-worker.log`,
    });
  });

  it("validates instance IDs before constructing labels or paths", () => {
    expect(getServiceLabel("dodi-1", "engine")).toBe("com.hive.dodi-1.agent");
    expect(getServicePlistPath(hiveHome, "dodi-1", "voice-worker")).toBe(
      `${hiveHome}/service/com.hive.dodi-1.voice-worker.plist`,
    );
    expect(getServiceLaunchAgentLink(userHome, "dodi-1", "engine")).toBe(
      `${userHome}/Library/LaunchAgents/com.hive.dodi-1.agent.plist`,
    );
    for (const invalid of ["", "-dodi", "dodi.one", "dodi/path", "dodi space"]) {
      expect(() => getServiceLabel(invalid, "engine")).toThrow("invalid Hive instance ID");
    }
  });

  it("serializes XML safely and contains only explicit non-secret environment", () => {
    const pair = definitions({ workerOverrides: { VOICE_PORT: "4107" } });
    pair.worker.args = ["start", `room<&"'>`];
    const plist = buildServicePlist(pair.worker);

    expect(plist).toContain("room&lt;&amp;&quot;&apos;&gt;");
    expect(plist).toContain(`<string>${hiveHome.replace("&", "&amp;")}</string>`);
    expect(plist).toContain(`<key>HIVE_CONFIG</key><string>${configPath.replace("&", "&amp;")}</string>`);
    expect(plist).toContain("<key>VOICE_PORT</key><string>4107</string>");
    expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(plist).not.toMatch(/TOKEN|PASSWORD|SECRET/);
  });

  it("rejects unsupported, malformed, and conflicting listener overrides", () => {
    const base = definitions().engine;
    expect(() =>
      buildServiceEnvironment({ ...base, overrides: { DATABASE_URL: "secret" } as unknown as ServiceOverrides }),
    ).toThrow("unsupported service override");
    for (const port of ["", "0", "65536", "12.5", " 12", "abc"]) {
      expect(() => buildServiceEnvironment({ ...base, overrides: { VOICE_PORT: port } })).toThrow(
        "invalid service port override: VOICE_PORT",
      );
    }
    const pair = definitions();
    pair.engine.overrides.VOICE_PORT = "4107";
    pair.worker.overrides.VOICE_PORT = "4207";
    expect(() => reconcileServiceOverrides([pair.engine, pair.worker])).toThrow(
      "conflicting service override: VOICE_PORT",
    );
    pair.worker.overrides = { ADMIN_API_PORT: "4107" };
    expect(() => reconcileServiceOverrides([pair.engine, pair.worker])).toThrow(
      "conflicting service listener overrides",
    );
  });

  it("requires absolute selected paths", () => {
    expect(() =>
      buildServiceDefinitions({
        instanceId: "test",
        nodePath,
        hiveHome: "relative-home",
        configPath,
        home: userHome,
        pathEnv: "/usr/bin",
      }),
    ).toThrow("HIVE_HOME path must be absolute");
  });
});

describe("service adapters", () => {
  it("uses opaque ps command evidence for paths with spaces and lsof for the executable", async () => {
    const row = `  123   1 Mon Sep  8 12:34:56 2026 ${nodePath} ${hiveHome}/.hive/pkg/voice-worker.min.js start\n`;
    const io = makeIO({
      execFile: vi.fn(async (command, args): Promise<ExecFileResult> => {
        if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
        if (command === "ps") return { stdout: row, stderr: "" };
        if (command === "lsof" && args.includes("cwd")) return { stdout: `p123\nfcwd\nn${hiveHome}\n`, stderr: "" };
        if (command === "lsof" && args.includes("txt")) {
          return { stdout: `p123\nftxt\nn${nodePath}\nftxt\nn/usr/lib/dyld\n`, stderr: "" };
        }
        throw new Error(`unexpected command: ${command}`);
      }),
    });

    const identity = await controller(io).process(123);
    expect(identity).toMatchObject({
      pid: 123,
      ppid: 1,
      startTime: "Mon Sep  8 12:34:56 2026",
      executable: nodePath,
      cwd: hiveHome,
      command: `${nodePath} ${hiveHome}/.hive/pkg/voice-worker.min.js start`,
    });
    expect(identity).not.toHaveProperty("argv");
  });

  it("rejects listener ambiguity and unexpected owners without signaling", async () => {
    const exec = vi.fn(async () => ({ stdout: "p10\nn*:4107\np11\nn*:4107\n", stderr: "" }));
    const io = makeIO({ execFile: exec });
    await expect(controller(io).listener(4107, 10)).rejects.toThrow("unexpected listener owner");
    expect(exec).toHaveBeenCalledTimes(1);

    exec.mockResolvedValueOnce({ stdout: "n*:4107\n", stderr: "" });
    await expect(controller(io).listener(4107, 10)).rejects.toThrow("could not parse listener ownership");

    exec.mockResolvedValueOnce({ stdout: "p10\nf5\nn127.0.0.1:4107\n", stderr: "" });
    await expect(controller(io).listener(4107, 10)).resolves.toEqual({ port: 4107, pid: 10 });
  });

  it("fails missing and escaping entrypoints before any filesystem mutation", async () => {
    const pair = definitions();
    const writeFile = vi.fn(async () => {});
    const mkdir = vi.fn(async () => {});
    const io = makeIO({
      writeFile,
      mkdir,
      realpath: vi.fn(async (path) => {
        if (path === pair.worker.entrypoint) return "/tmp/foreign-worker.min.js";
        return path;
      }),
    });
    await expect(controller(io).write([pair.engine, pair.worker])).rejects.toThrow(
      "service entrypoint escapes canonical .hive",
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();

    const missingIO = makeIO({
      writeFile,
      mkdir,
      realpath: vi.fn(async (path) => {
        if (path === pair.worker.entrypoint) throw enoent();
        return path;
      }),
    });
    await expect(controller(missingIO).write([pair.engine, pair.worker])).rejects.toMatchObject({ code: "ENOENT" });
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("validates all definitions before atomically writing and linting either plist", async () => {
    const pair = definitions({ engineOverrides: { VOICE_PORT: "4107" }, workerOverrides: { VOICE_PORT: "4107" } });
    const calls: string[] = [];
    const io = makeIO({
      execFile: vi.fn(async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "launchctl" && args[0] === "print") throw unloaded();
        if (command === "launchctl") return { stdout: "{ disabled services = {} }", stderr: "" };
        return { stdout: "OK", stderr: "" };
      }),
      access: vi.fn(async () => {
        throw enoent();
      }),
      lstat: vi.fn(async (path) => {
        if (path.includes("Library/LaunchAgents") || path.includes("/service/")) throw enoent();
        return stat();
      }),
      writeFile: vi.fn(async (_path, data) => {
        expect(String(data)).not.toMatch(/TOKEN|PASSWORD|SECRET/);
      }),
    });

    const snapshot = await controller(io).write([pair.engine, pair.worker]);
    expect(snapshot.services).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("plutil -lint"))).toHaveLength(2);
    expect(io.writeFile).toHaveBeenCalledTimes(2);
    expect(io.symlink).toHaveBeenCalledTimes(2);
    expect(io.rename).toHaveBeenCalledTimes(4);
  });

  it("treats an already healthy service with a spaced path as an idempotent bootstrap", async () => {
    const worker = definitions().worker;
    const plist = JSON.stringify({
      Label: worker.label,
      ProgramArguments: [worker.nodePath, worker.entrypoint, ...worker.args],
      WorkingDirectory: worker.hiveHome,
      EnvironmentVariables: buildServiceEnvironment(worker),
    });
    const row = `  123   1 Mon Sep  8 12:34:56 2026 ${worker.nodePath} ${worker.entrypoint} start\n`;
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") {
        return { stdout: "state = running\npid = 123\n", stderr: "" };
      }
      if (command === "launchctl") return { stdout: "{ disabled services = {} }", stderr: "" };
      if (command === "plutil") return { stdout: plist, stderr: "" };
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") return { stdout: row, stderr: "" };
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p123\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p123\nftxt\nn${nodePath}\n`, stderr: "" };
      throw new Error(`unexpected command ${command}`);
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path) => {
        if (path.includes("Library/LaunchAgents")) throw enoent();
        return stat();
      }),
    });

    const inspection = await controller(io).bootstrap(worker);
    expect(inspection.livePID).toBe(123);
    expect(exec.mock.calls.some(([, args]) => args[0] === "bootstrap")).toBe(false);
  });

  it("enables a previously-disabled service before bootstrap and never signals another instance", async () => {
    const worker = definitions().worker;
    const plist = JSON.stringify({
      Label: worker.label,
      ProgramArguments: [worker.nodePath, worker.entrypoint, ...worker.args],
      WorkingDirectory: worker.hiveHome,
      EnvironmentVariables: buildServiceEnvironment(worker),
    });
    const row = `  123   1 Mon Sep  8 12:34:56 2026 ${worker.nodePath} ${worker.entrypoint} start\n`;
    let enabled = false;
    let loaded = false;
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") {
        if (!loaded) throw unloaded();
        return { stdout: "state = running\npid = 123\n", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "print-disabled") {
        return {
          stdout: `{ disabled services = {\n\t"${worker.label}" => ${enabled ? "false" : "true"}\n} }\n`,
          stderr: "",
        };
      }
      if (command === "launchctl" && args[0] === "enable") {
        expect(args[1]).toBe(`gui/501/${worker.label}`);
        enabled = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootstrap") {
        expect(enabled).toBe(true);
        loaded = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "plutil") return { stdout: plist, stderr: "" };
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") return { stdout: row, stderr: "" };
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p123\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p123\nftxt\nn${nodePath}\n`, stderr: "" };
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path) => {
        if (path.includes("Library/LaunchAgents")) throw enoent();
        return stat();
      }),
    });

    const inspection = await controller(io).bootstrap(worker);
    expect(inspection.livePID).toBe(123);
    expect(exec.mock.calls.filter(([, args]) => args[0] === "enable")).toHaveLength(1);
    expect(exec.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(1);
    expect(exec.mock.calls.some(([, args]) => String(args[1] ?? "").includes("keepur"))).toBe(false);
  });

  it("removeWorkerLink disables and unlinks only the target worker registration", async () => {
    const pair = definitions();
    const workerLink = `${userHome}/Library/LaunchAgents/${pair.worker.label}.plist`;
    const engineLink = `${userHome}/Library/LaunchAgents/${pair.engine.label}.plist`;
    const unlinked: string[] = [];
    const plist = JSON.stringify({
      Label: pair.worker.label,
      ProgramArguments: [pair.worker.nodePath, pair.worker.entrypoint, ...pair.worker.args],
      WorkingDirectory: pair.worker.hiveHome,
      EnvironmentVariables: buildServiceEnvironment(pair.worker),
    });
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") throw unloaded();
      if (command === "launchctl" && args[0] === "print-disabled") {
        return { stdout: `{ disabled services = {\n\t"${pair.worker.label}" => false\n} }\n`, stderr: "" };
      }
      if (command === "launchctl" && args[0] === "disable") {
        expect(args[1]).toBe(`gui/501/${pair.worker.label}`);
        return { stdout: "", stderr: "" };
      }
      if (command === "plutil") return { stdout: plist, stderr: "" };
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path) => {
        if (path === workerLink) return stat("symlink");
        if (path === engineLink) return stat("symlink");
        return stat();
      }),
      readlink: vi.fn(async () => `${hiveHome}/service/${pair.worker.label}.plist`),
      unlink: vi.fn(async (path) => {
        unlinked.push(path);
      }),
    });

    await expect(controller(io).removeWorkerLink(pair.engine)).rejects.toThrow("expected voice-worker definition");
    await controller(io).removeWorkerLink(pair.worker);
    expect(unlinked).toEqual([workerLink]);
    expect(exec.mock.calls.filter(([, args]) => args[0] === "disable")).toHaveLength(1);
    expect(exec.mock.calls.some(([, args]) => args[0] === "bootout" || args[0] === "kill")).toBe(false);

    const live = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") return { stdout: "state = running\npid = 123\n", stderr: "" };
      if (command === "launchctl" && args[0] === "print-disabled") {
        return { stdout: "{ disabled services = {} }", stderr: "" };
      }
      if (command === "plutil") return { stdout: plist, stderr: "" };
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") {
        return {
          stdout: `  123   1 Mon Sep  8 12:34:56 2026 ${pair.worker.nodePath} ${pair.worker.entrypoint} start\n`,
          stderr: "",
        };
      }
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p123\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p123\nftxt\nn${nodePath}\n`, stderr: "" };
      throw new Error(`unexpected command ${command}`);
    });
    await expect(
      controller(
        makeIO({
          execFile: live,
          lstat: vi.fn(async (path) => (path.includes("Library/LaunchAgents") ? stat("symlink") : stat())),
          readlink: vi.fn(async () => `${hiveHome}/service/${pair.worker.label}.plist`),
        }),
      ).removeWorkerLink(pair.worker),
    ).rejects.toThrow("cannot remove a live worker registration");
  });

  it("rejects another instance label before invoking launchctl", async () => {
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(controller(makeIO({ execFile })).inspect("com.hive.keepur.agent")).rejects.toThrow(
      "foreign Hive service label",
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("accepts an external pilot plist only through an exact captured profile", async () => {
    const engine = definitions().engine;
    const linkPath = `${userHome}/Library/LaunchAgents/${engine.label}.plist`;
    const pilotPlist = "/Users/example/pilot checkout/service/engine.plist";
    const plist = JSON.stringify({
      Label: engine.label,
      ProgramArguments: [nodePath, "/Users/example/pilot checkout/dist/index.js"],
      WorkingDirectory: hiveHome,
      EnvironmentVariables: buildServiceEnvironment(engine),
    });
    const io = makeIO({
      execFile: vi.fn(async (command, args) => {
        if (command === "launchctl" && args[0] === "print") throw unloaded();
        if (command === "launchctl") return { stdout: "{ disabled services = {} }", stderr: "" };
        return { stdout: plist, stderr: "" };
      }),
      lstat: vi.fn(async (path) => stat(path === linkPath ? "symlink" : "file")),
      readlink: vi.fn(async () => pilotPlist),
      realpath: vi.fn(async (path) => (path === linkPath ? pilotPlist : path)),
    });

    await expect(controller(io).inspect(engine.label)).rejects.toThrow("foreign LaunchAgent link target");
    const captured = new ServiceController(
      {
        instanceId: "personal_1",
        hiveHome,
        home: userHome,
        operationDir: `${hiveHome}/.hive-state/deployment/operations/test`,
        capturedPilotProfile: [{ label: engine.label, plistPath: pilotPlist }],
      },
      io,
    );
    expect((await captured.inspect(engine.label)).plist?.path).toBe(pilotPlist);
  });

  it("fails closed when launchctl disabled-state output is malformed", async () => {
    const engine = definitions().engine;
    const io = makeIO({
      execFile: vi.fn(async (_command, args) => {
        if (args[0] === "print") throw unloaded();
        return { stdout: "unexpected output", stderr: "" };
      }),
    });

    await expect(controller(io).inspect(engine.label)).rejects.toThrow("could not parse launchctl disabled services");
  });

  function bootoutHarness(options: {
    definition: ReturnType<typeof definitions>["worker"] | ReturnType<typeof definitions>["engine"];
    supervisorExitsAfterBootout: boolean;
    listener?: (bootedOut: boolean, supervisorAlive: boolean) => string;
    survivingHelper?: boolean;
  }) {
    const service = options.definition;
    const plist = JSON.stringify({
      Label: service.label,
      ProgramArguments: [service.nodePath, service.entrypoint, ...service.args],
      WorkingDirectory: service.hiveHome,
      EnvironmentVariables: buildServiceEnvironment(service),
    });
    const supervisorRow = `  123   1 Mon Sep  8 12:34:56 2026 ${service.nodePath} ${service.entrypoint}${service.args.length ? " start" : ""}\n`;
    const helperRow = `  200   1 Mon Sep  8 12:34:57 2026 ${service.nodePath} /sdk/job_proc_lazy_main.js\n`;
    let now = 0;
    let bootedOut = false;
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") {
        if (bootedOut) throw unloaded();
        return { stdout: "state = running\npid = 123\n", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "launchctl") return { stdout: "{ disabled services = {} }", stderr: "" };
      if (command === "plutil") return { stdout: plist, stderr: "" };
      if (command === "ps" && args[0] === "-axo") throw new Error("descendant census must not be taken");
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") {
        const pid = Number(args[args.indexOf("-p") + 1]);
        if (pid === 123 && bootedOut && options.supervisorExitsAfterBootout) throw noProcess();
        if (pid === 200 && options.survivingHelper) return { stdout: helperRow, stderr: "" };
        return { stdout: supervisorRow, stderr: "" };
      }
      if (command === "lsof" && args[0] === "-nP") {
        const supervisorAlive = !(bootedOut && options.supervisorExitsAfterBootout);
        const stdout = options.listener?.(bootedOut, supervisorAlive) ?? "";
        if (!stdout) throw noProcess();
        return { stdout, stderr: "" };
      }
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p123\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p123\nftxt\nn${nodePath}\n`, stderr: "" };
      if (command === "kill" || command === "/bin/kill") throw new Error("nothing may be killed");
      throw new Error(`unexpected command ${command}`);
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path) => {
        if (path.includes("Library/LaunchAgents")) throw enoent();
        return stat();
      }),
      now: () => now,
      sleep: vi.fn(async (milliseconds) => {
        now += milliseconds;
      }),
    });
    return { io, exec, bootedOut: () => bootedOut };
  }

  it("does not report worker bootout success while the captured supervisor survives", async () => {
    const worker = definitions().worker;
    const { io, exec } = bootoutHarness({ definition: worker, supervisorExitsAfterBootout: false });
    const mark = vi.fn(async () => {});
    await expect(
      controller(io, { stopTimeoutMs: 2_000, pollIntervalMs: 1_000 }).bootout(worker, {
        markIrreversible: mark,
        healthListenerPort: 3107,
      }),
    ).rejects.toThrow("voice worker supervisor did not exit and release its health listener");
    expect(mark).toHaveBeenCalledOnce();
    expect(exec.mock.calls.filter(([, args]) => args[0] === "bootout")).toHaveLength(1);
  });

  it("completes worker stop on supervisor exit plus listener release despite a surviving non-listener SDK helper", async () => {
    const worker = definitions().worker;
    const { io, exec } = bootoutHarness({
      definition: worker,
      supervisorExitsAfterBootout: true,
      survivingHelper: true,
      listener: (bootedOut) => (bootedOut ? "" : "p123\nn127.0.0.1:3107\n"),
    });
    await controller(io, { stopTimeoutMs: 2_000, pollIntervalMs: 1_000 }).bootout(worker, {
      markIrreversible: async () => {},
      healthListenerPort: 3107,
    });
    expect(exec.mock.calls.some(([command, args]) => command === "ps" && args[0] === "-axo")).toBe(false);
    expect(exec.mock.calls.some(([, args]) => args.includes("200"))).toBe(false);
  });

  it("fails the stop when the old supervisor still holds its health listener past the budget", async () => {
    const worker = definitions().worker;
    const { io } = bootoutHarness({
      definition: worker,
      supervisorExitsAfterBootout: false,
      listener: () => "p123\nn127.0.0.1:3107\n",
    });
    await expect(
      controller(io, { stopTimeoutMs: 2_000, pollIntervalMs: 1_000 }).bootout(worker, {
        markIrreversible: async () => {},
        healthListenerPort: 3107,
      }),
    ).rejects.toThrow("did not exit and release its health listener");
  });

  it("reports a foreign health listener owner and never kills it", async () => {
    const worker = definitions().worker;
    const { io, exec } = bootoutHarness({
      definition: worker,
      supervisorExitsAfterBootout: true,
      listener: (bootedOut) => (bootedOut ? "p999\nn127.0.0.1:3107\n" : "p123\nn127.0.0.1:3107\n"),
    });
    await expect(
      controller(io, { stopTimeoutMs: 2_000, pollIntervalMs: 1_000 }).bootout(worker, {
        markIrreversible: async () => {},
        healthListenerPort: 3107,
      }),
    ).rejects.toThrow("unexpected health listener owner for com.hive.personal_1.voice-worker on port 3107: pid 999");
    expect(exec.mock.calls.some(([command]) => command.includes("kill"))).toBe(false);
  });

  it("refuses a worker bootout without its recorded listener before any irreversible step", async () => {
    const worker = definitions().worker;
    const { io, exec } = bootoutHarness({ definition: worker, supervisorExitsAfterBootout: true });
    const mark = vi.fn(async () => {});
    await expect(controller(io).bootout(worker, { markIrreversible: mark })).rejects.toThrow(
      "requires its recorded health listener port",
    );
    expect(mark).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([, args]) => args[0] === "bootout")).toBe(false);
  });

  it("stops the engine on supervisor PID exit alone", async () => {
    const engine = definitions().engine;
    const { io, exec } = bootoutHarness({ definition: engine, supervisorExitsAfterBootout: true });
    await controller(io, { stopTimeoutMs: 2_000, pollIntervalMs: 1_000 }).bootout(engine, {
      markIrreversible: async () => {},
    });
    expect(exec.mock.calls.some(([command, args]) => command === "lsof" && args[0] === "-nP")).toBe(false);
  });
});

describe("signal fence, ordered restore and observation-only adapters", () => {
  function bootHarness(definition: ReturnType<typeof definitions>["engine"]) {
    const order: string[] = [];
    const plist = JSON.stringify({
      Label: definition.label,
      ProgramArguments: [definition.nodePath, definition.entrypoint, ...definition.args],
      WorkingDirectory: definition.hiveHome,
      EnvironmentVariables: buildServiceEnvironment(definition),
    });
    let bootedOut = false;
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") {
        order.push("inspect");
        if (bootedOut) throw unloaded();
        return { stdout: "state = running\npid = 123\n", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootout") {
        order.push("bootout");
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      if (command === "launchctl") return { stdout: "{ disabled services = {} }", stderr: "" };
      if (command === "plutil") return { stdout: plist, stderr: "" };
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") {
        if (bootedOut) throw noProcess();
        return {
          stdout: `  123   1 Mon Sep  8 12:34:56 2026 ${definition.nodePath} ${definition.entrypoint}\n`,
          stderr: "",
        };
      }
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p123\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p123\nftxt\nn${nodePath}\n`, stderr: "" };
      throw new Error(`unexpected command ${command}`);
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path) => {
        if (path.includes("Library/LaunchAgents")) throw enoent();
        return stat();
      }),
    });
    return { io, exec, order };
  }

  it("calls beforeExec after markIrreversible and every inspection, immediately before dispatch", async () => {
    const engine = definitions().engine;
    const { io, order } = bootHarness(engine);
    await controller(io).bootout(engine, {
      markIrreversible: async () => {
        order.push("mark");
      },
      beforeExec: () => {
        order.push("fence");
      },
    });
    expect(order.slice(0, 4)).toEqual(["inspect", "mark", "fence", "bootout"]);
  });

  it("a throwing fence issues no launchd signal", async () => {
    const engine = definitions().engine;
    const { io, exec } = bootHarness(engine);
    await expect(
      controller(io).bootout(engine, {
        markIrreversible: async () => {},
        beforeExec: () => {
          throw new Error("fresh operation hold required");
        },
      }),
    ).rejects.toThrow("fresh operation hold required");
    expect(exec.mock.calls.some(([, args]) => args[0] === "bootout")).toBe(false);
  });

  it("listener, writer and UID adapters only observe and parse strictly", async () => {
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "lsof" && args.includes("-p")) {
        return { stdout: "p701\nf21\nn127.0.0.1:8081\nf22\nn*:3108\nf23\nn192.168.1.4:9000\n", stderr: "" };
      }
      if (command === "lsof" && args.includes("-Fpa")) {
        return { stdout: "p701\nf1\naw\np702\nf3\nar\np703\nf4\nau\n", stderr: "" };
      }
      if (command === "ps" && args.includes("uid=")) return { stdout: "  501\n", stderr: "" };
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    });
    const service = controller(makeIO({ execFile: exec }));
    await expect(service.listenersOf(701)).resolves.toEqual([3108, 8081]);
    await expect(service.fileWriters("/tmp/voice-worker.log")).resolves.toEqual([701, 703]);
    await expect(service.processUid(701)).resolves.toBe(501);
    expect(exec.mock.calls.every(([command, args]) => command !== "launchctl" && !args.includes("kill"))).toBe(true);
    const garbage = controller(makeIO({ execFile: vi.fn(async () => ({ stdout: "zzz\n", stderr: "" })) }));
    await expect(garbage.listenersOf(701)).rejects.toThrow("could not parse");
    await expect(garbage.fileWriters("/tmp/x")).rejects.toThrow("could not parse");
    await expect(garbage.processUid(701)).rejects.toThrow("could not parse");
  });

  it("process census observes descendants only and never signals", async () => {
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "ps" && args.includes("-axo")) {
        return {
          stdout: [
            "  100     1 Mon Sep  8 12:34:56 2026 node engine",
            "  200   100 Mon Sep  8 12:34:57 2026 node mcp",
            "  300   200 Mon Sep  8 12:34:58 2026 node grandchild",
            "  400     1 Mon Sep  8 12:34:59 2026 unrelated",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected ${command}`);
    });
    const census = await controller(makeIO({ execFile: exec })).processCensus(100);
    expect(census.map((row) => [row.pid, row.depth])).toEqual([
      [200, 1],
      [300, 2],
    ]);
    expect(exec).toHaveBeenCalledOnce();
  });

  function restoreHarness(
    options: { externalEffective?: boolean; externalChanged?: boolean; loadedAtStart?: string[] } = {},
  ) {
    const pair = definitions();
    const events: string[] = [];
    const loaded = new Set(options.loadedAtStart ?? []);
    const external = "/Users/example/github/pilot/com.hive.personal_1.agent.plist";
    const inspection = (definition: typeof pair.engine, pid: number) => ({
      label: definition.label,
      loaded: true,
      enabled: true,
      livePID: pid,
      startTime: "Mon Sep  8 12:34:56 2026",
      args: [definition.nodePath, definition.entrypoint, ...definition.args],
      cwd: hiveHome,
      configSelection: configPath,
      serviceEnvironment: buildServiceEnvironment(definition),
      plist: null,
      link: null,
      process: {
        pid,
        ppid: 1,
        startTime: "Mon Sep  8 12:34:56 2026",
        command: [definition.nodePath, definition.entrypoint, ...definition.args].join(" "),
        executable: nodePath,
        cwd: hiveHome,
      },
    });
    const engineEffective = options.externalEffective
      ? external
      : getServicePlistPath(hiveHome, "personal_1", "engine");
    const snapshot = {
      services: [
        {
          definition: pair.engine,
          inspection: inspection(pair.engine, 123),
          plist: { path: engineEffective, existed: true, bytes: Buffer.from("engine-effective"), mode: 0o644 },
          instancePlist: options.externalEffective
            ? {
                path: getServicePlistPath(hiveHome, "personal_1", "engine"),
                existed: true,
                bytes: Buffer.from("instance-sentinel"),
                mode: 0o600,
              }
            : { path: engineEffective, existed: true, bytes: Buffer.from("engine-effective"), mode: 0o644 },
          link: {
            path: getServiceLaunchAgentLink(userHome, "personal_1", "engine"),
            existed: true,
            target: engineEffective,
          },
          loaded: true,
          enabled: true,
        },
        {
          definition: pair.worker,
          inspection: inspection(pair.worker, 124),
          plist: { path: getServicePlistPath(hiveHome, "personal_1", "voice-worker"), existed: false },
          instancePlist: { path: getServicePlistPath(hiveHome, "personal_1", "voice-worker"), existed: false },
          link: { path: getServiceLaunchAgentLink(userHome, "personal_1", "voice-worker"), existed: false },
          loaded: true,
          enabled: true,
        },
      ],
    };
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") {
        const label = args[1].split("/").pop()!;
        if (!loaded.has(label)) throw unloaded();
        const pid = label.endsWith("agent") ? 900 : 901;
        return { stdout: `state = running\npid = ${pid}\n`, stderr: "" };
      }
      if (command === "launchctl" && args[0] === "print-disabled")
        return { stdout: "{ disabled services = {} }", stderr: "" };
      if (command === "launchctl" && (args[0] === "enable" || args[0] === "disable")) {
        events.push(`${args[0]}:${args[1]}`);
        return { stdout: "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootstrap") {
        const label = args[2].includes("voice-worker") ? pair.worker.label : pair.engine.label;
        events.push(`bootstrap:${label.endsWith("agent") ? "engine" : "worker"}`);
        loaded.add(label);
        return { stdout: "", stderr: "" };
      }
      if (command === "plutil") {
        const worker = args[args.length - 1].includes("voice-worker");
        const definition = worker ? pair.worker : pair.engine;
        return {
          stdout: JSON.stringify({
            Label: definition.label,
            ProgramArguments: [definition.nodePath, definition.entrypoint, ...definition.args],
            WorkingDirectory: hiveHome,
            EnvironmentVariables: buildServiceEnvironment(definition),
          }),
          stderr: "",
        };
      }
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") {
        const pid = Number(args[args.indexOf("-p") + 1]);
        const definition = pid === 901 ? pair.worker : pair.engine;
        return {
          stdout: `  ${pid}   1 Mon Sep  8 12:40:00 2026 ${[definition.nodePath, definition.entrypoint, ...definition.args].join(" ")}\n`,
          stderr: "",
        };
      }
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p1\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p1\nftxt\nn${nodePath}\n`, stderr: "" };
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path) => {
        if (path.includes("Library/LaunchAgents")) return stat("symlink");
        return stat();
      }),
      readlink: vi.fn(async (path: string) =>
        path.includes("voice-worker") ? getServicePlistPath(hiveHome, "personal_1", "voice-worker") : engineEffective,
      ),
      readFile: vi.fn(async (path: string) =>
        Buffer.from(path === external && options.externalChanged ? "tampered" : "engine-effective"),
      ),
      writeFile: vi.fn(async (path: string) => {
        events.push(`write:${path}`);
      }),
      unlink: vi.fn(async (path: string) => {
        events.push(`unlink:${path}`);
      }),
      symlink: vi.fn(async (target: string) => {
        events.push(`link:${target}`);
      }),
    });
    const ctl = new ServiceController(
      {
        instanceId: "personal_1",
        hiveHome,
        home: userHome,
        operationDir: `${hiveHome}/.hive-state/deployment/operations/test`,
        capturedPilotProfile: [{ label: pair.engine.label, plistPath: external }],
      },
      io,
    );
    return { ctl, snapshot, events, external, exec };
  }

  it("restores files and state first, then engine, the engine check, then worker", async () => {
    const { ctl, snapshot, events } = restoreHarness();
    await ctl.restore(snapshot, {
      afterEngine: async (engine) => {
        events.push(`engine-check:${engine?.livePID}`);
      },
    });
    const firstBootstrap = events.findIndex((event) => event.startsWith("bootstrap"));
    expect(events.slice(0, firstBootstrap).every((event) => !event.startsWith("bootstrap"))).toBe(true);
    expect(events.filter((event) => event.startsWith("bootstrap") || event.startsWith("engine-check"))).toEqual([
      "bootstrap:engine",
      "engine-check:900",
      "bootstrap:worker",
    ]);
  });

  it("restores a captured disabled transition without bootstrapping or touching another instance", async () => {
    const { ctl, snapshot, events, exec } = restoreHarness();
    for (const service of snapshot.services) service.enabled = false;
    await ctl.restoreFilesAndState(snapshot);
    expect(events.filter((event) => event.startsWith("disable:"))).toEqual([
      `disable:gui/501/${definitions().engine.label}`,
      `disable:gui/501/${definitions().worker.label}`,
    ]);
    expect(exec.mock.calls.some(([, args]) => args[0] === "bootstrap")).toBe(false);
    expect(exec.mock.calls.some(([, args]) => String(args[1] ?? "").includes("keepur"))).toBe(false);
  });

  it("refuses to restore over a still-loaded registration", async () => {
    const pair = definitions();
    const { ctl, snapshot, events } = restoreHarness({ loadedAtStart: [pair.worker.label] });
    await expect(ctl.restoreFilesAndState(snapshot)).rejects.toThrow("to be unloaded first");
    expect(events).toEqual([]);
  });

  it("verifies an external effective plist without rewriting it and restores the distinct instance file", async () => {
    const { ctl, snapshot, events, external } = restoreHarness({ externalEffective: true });
    await ctl.restoreFilesAndState(snapshot);
    expect(events.some((event) => event.includes(external) && event.startsWith("write"))).toBe(false);
    expect(events.some((event) => event.startsWith("write:") && event.includes(".plist.tmp-"))).toBe(true);
    expect(events).toContain(`link:${external}`);
  });

  it("blocks restoration when the external original changed since capture", async () => {
    const { ctl, snapshot, events } = restoreHarness({ externalEffective: true, externalChanged: true });
    await expect(ctl.restoreFilesAndState(snapshot)).rejects.toThrow("external service plist changed since capture");
    expect(events.filter((event) => !event.startsWith("unlink"))).toEqual([]);
  });

  it("requires a new process generation when asked", async () => {
    const { ctl, snapshot } = restoreHarness();
    snapshot.services[0].inspection.process!.pid = 900;
    snapshot.services[0].inspection.process!.startTime = "Mon Sep  8 12:40:00 2026";
    await ctl.restoreFilesAndState(snapshot);
    await expect(
      ctl.restoreService(snapshot, snapshot.services[0].definition.label, { requireNewGeneration: true }),
    ).rejects.toThrow("did not start a new process generation");
  });
});

describe("read-only first-capture discovery", () => {
  const pilotRoot = "/Users/example/github/kpr-320-live-call";
  const lease = { operationId: "op", instanceId: "personal_1", hiveHome, configPath };

  function discoveryHarness(
    options: {
      env?: Record<string, string>;
      linkIsSymlink?: boolean;
      processChanges?: boolean;
      foreignWritable?: boolean;
      instancePlistExists?: boolean;
      programArguments?: (label: string) => string[];
    } = {},
  ) {
    const mutations: string[] = [];
    let psCalls = 0;
    const argsFor = (label: string) => {
      const entry = label.endsWith("agent") ? "pkg/server.min.js" : "dist/voice-worker/main.js";
      return options.programArguments?.(label) ?? [nodePath, `${pilotRoot}/${entry}`];
    };
    const plistFor = (label: string) => {
      return JSON.stringify({
        Label: label,
        ProgramArguments: argsFor(label),
        WorkingDirectory: hiveHome,
        StandardOutPath: `${hiveHome}/logs/${label}.log`,
        StandardErrorPath: `${hiveHome}/logs/${label}.err`,
        EnvironmentVariables: options.env ?? {
          HIVE_HOME: hiveHome,
          HIVE_CONFIG: configPath,
          HOME: userHome,
          PATH: "/usr/bin",
        },
      });
    };
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "launchctl" && args[0] === "print") {
        return { stdout: `state = running\npid = ${args[1].endsWith("agent") ? 700 : 701}\n`, stderr: "" };
      }
      if (command === "launchctl" && args[0] === "print-disabled")
        return { stdout: "{ disabled services = {} }", stderr: "" };
      if (command === "launchctl") {
        mutations.push(`launchctl ${args[0]}`);
        throw new Error("discovery must not mutate launchd");
      }
      if (command === "plutil")
        return {
          stdout: plistFor(
            args[args.length - 1].includes("voice-worker")
              ? getServiceLabel("personal_1", "voice-worker")
              : getServiceLabel("personal_1", "engine"),
          ),
          stderr: "",
        };
      if (command === "ps" && args.includes("comm=")) return { stdout: `${nodePath}\n`, stderr: "" };
      if (command === "ps") {
        psCalls += 1;
        const pid = Number(args[args.indexOf("-p") + 1]);
        const label =
          pid === 700 ? getServiceLabel("personal_1", "engine") : getServiceLabel("personal_1", "voice-worker");
        const start = options.processChanges && psCalls > 2 ? "Mon Sep  8 13:00:00 2026" : "Mon Sep  8 12:34:56 2026";
        return { stdout: `  ${pid}   1 ${start} ${argsFor(label).join(" ")}\n`, stderr: "" };
      }
      if (command === "lsof" && args.includes("cwd")) return { stdout: `p1\nfcwd\nn${hiveHome}\n`, stderr: "" };
      if (command === "lsof") return { stdout: `p1\nftxt\nn${nodePath}\n`, stderr: "" };
      throw new Error(`unexpected ${command}`);
    });
    const stats = (kind: "file" | "directory" | "symlink", mode: number, uid = 501) => ({
      ...stat(kind),
      mode,
      uid,
      size: 5,
    });
    const io = makeIO({
      execFile: exec,
      lstat: vi.fn(async (path: string) => {
        if (path.includes("Library/LaunchAgents/"))
          return options.linkIsSymlink === false ? stats("file", 0o100644) : stats("symlink", 0o120755);
        if (path.endsWith(".plist") && path.startsWith(pilotRoot)) return stats("file", 0o100644);
        if (path.startsWith(`${hiveHome}/service/`)) {
          if (!options.instancePlistExists) throw enoent();
          return stats("file", 0o100600);
        }
        if (options.foreignWritable && path === pilotRoot) return stats("directory", 0o40777);
        return stats("directory", 0o40755, path === "/" || path === "/Users" ? 0 : 501);
      }),
      readlink: vi.fn(async (path: string) => `${pilotRoot}/${path.split("/").pop()}`),
      readFile: vi.fn(async () => Buffer.from("plist")),
      writeFile: vi.fn(async (path: string) => {
        mutations.push(`write ${path}`);
      }),
      rename: vi.fn(async (path: string) => {
        mutations.push(`rename ${path}`);
      }),
      unlink: vi.fn(async (path: string) => {
        mutations.push(`unlink ${path}`);
      }),
      symlink: vi.fn(async (path: string) => {
        mutations.push(`symlink ${path}`);
      }),
    });
    return { io, mutations };
  }

  function discoveryController(io: ServiceIO, validator?: (ticket: object) => Promise<typeof lease>) {
    return new ServiceController(
      {
        instanceId: "personal_1",
        hiveHome,
        home: userHome,
        operationDir: `${hiveHome}/.hive-state/deployment/operations/test`,
        captureTicketValidator: validator,
      },
      io,
    );
  }

  it("discovers external effective targets and distinct instance plist roles without mutation", async () => {
    const { io, mutations } = discoveryHarness({ instancePlistExists: true });
    const ticket = Object.freeze({});
    const validator = vi.fn(async (candidate: object) => {
      if (candidate !== ticket) throw new Error("unknown ticket");
      return lease;
    });
    const found = await discoveryController(io, validator).discoverForCapture(ticket);
    expect(found.map((item) => item.label)).toEqual(["com.hive.personal_1.agent", "com.hive.personal_1.voice-worker"]);
    expect(found[0].effectivePlist.path).toBe(`${pilotRoot}/com.hive.personal_1.agent.plist`);
    expect(found[0].instancePlist.path).toBe(getServicePlistPath(hiveHome, "personal_1", "engine"));
    expect(found[0].instancePlist.existed).toBe(true);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(mutations).toEqual([]);
  });

  it.each([
    ["no validator", {}, undefined, "no capture ticket validator"],
    ["foreign lease", {}, async () => ({ ...lease, instanceId: "keepur" }), "another instance"],
    ["non-symlink LaunchAgent", { linkIsSymlink: false }, async () => lease, "not an owned symlink"],
    [
      "secret environment",
      {
        env: {
          HIVE_HOME: hiveHome,
          HIVE_CONFIG: configPath,
          HOME: userHome,
          PATH: "/usr/bin",
          LIVEKIT_API_SECRET: "dummy",
        },
      },
      async () => lease,
      "not allowlisted",
    ],
    ["process replaced during capture", { processChanges: true }, async () => lease, "changed during capture"],
    ["foreign-writable ancestor", { foreignWritable: true }, async () => lease, "foreign-writable ancestor"],
  ] as const)("blocks capture on %s", async (_name, options, validator, message) => {
    const { io, mutations } = discoveryHarness(options);
    await expect(discoveryController(io, validator).discoverForCapture({})).rejects.toThrow(message);
    expect(mutations).toEqual([]);
  });

  it("captures packaged worker argv with a non-path start token", async () => {
    const { io, mutations } = discoveryHarness({
      programArguments: (label) =>
        label.endsWith("voice-worker")
          ? [nodePath, `${pilotRoot}/pkg/voice-worker.min.js`, "start"]
          : [nodePath, `${pilotRoot}/pkg/server.min.js`],
    });
    const found = await discoveryController(io, async () => lease).discoverForCapture({});
    expect(found[1].effectivePlist.path).toBe(`${pilotRoot}/com.hive.personal_1.voice-worker.plist`);
    expect(mutations).toEqual([]);
  });
});

describe("captureProgramArguments", () => {
  it("accepts packaged [abs-node, abs-voice-worker.min.js, start]", () => {
    expect(
      captureProgramArguments(
        [nodePath, "/Users/example/services/hive/.hive/pkg/voice-worker.min.js", "start"],
        hiveHome,
      ),
    ).toEqual([nodePath, "/Users/example/services/hive/.hive/pkg/voice-worker.min.js", "start"]);
  });

  it("accepts pilot [abs-node, relative dist/voice-worker/main.js, start] against an absolute WorkingDirectory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-capture-argv-")));
    try {
      const relative = join("dist", "voice-worker", "main.js");
      mkdirSync(join(root, "dist", "voice-worker"), { recursive: true });
      writeFileSync(join(root, relative), "");
      expect(captureProgramArguments([nodePath, relative, "start"], root)).toEqual([nodePath, relative, "start"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty argv", () => {
    expect(() => captureProgramArguments([], hiveHome)).toThrow("ProgramArguments are empty");
    expect(() => captureProgramArguments(undefined, hiveHome)).toThrow("ProgramArguments are empty");
  });

  it("rejects a relative entrypoint that does not exist after resolve", () => {
    expect(() => captureProgramArguments([nodePath, "dist/voice-worker/main.js", "start"], hiveHome)).toThrow(
      "ProgramArguments entrypoint does not exist under WorkingDirectory",
    );
  });

  it("rejects a non-absolute Node executable", () => {
    expect(() =>
      captureProgramArguments(["node", "/Users/example/pkg/voice-worker.min.js", "start"], hiveHome),
    ).toThrow("ProgramArguments node executable must be an absolute path");
  });
});
