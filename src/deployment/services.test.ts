import { describe, expect, it, vi } from "vitest";
import {
  ServiceController,
  buildServiceDefinitions,
  buildServiceEnvironment,
  buildServicePlist,
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
