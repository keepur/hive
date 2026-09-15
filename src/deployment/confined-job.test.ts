import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  ConfinedJobFailedError,
  ConfinedJobRunner,
  ConfinedJobRunnerRequiredError,
  ConfinementSelfTestError,
  ConfinementUnavailableError,
  SANDBOX_EXEC,
  assertConfinedJobRunner,
  assertSeatbeltSafePath,
  buildSeatbeltProfile,
  confinedJobEnvironment,
  createJobDirectory,
  nodeConfinedJobIO,
  requireJobSuccess,
  runConfinementSelfTest,
  type ConfinedJobIO,
  type ConfinedJobRecord,
  type ConfinedProcessResult,
  type ConfinementSelfTest,
  type SpawnOptions,
} from "./confined-job.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function instanceRoot(name = "instance & voice"): string {
  const parent = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-confined-")));
  roots.push(parent);
  const home = resolve(parent, name);
  mkdirSync(home, { mode: 0o700 });
  return home;
}

const passed: ConfinementSelfTest = {
  outcome: "passed",
  macosVersion: "26.6.2",
  sandboxExec: SANDBOX_EXEC,
  profileSha256: "a".repeat(64),
  checkedAt: "2026-09-14T00:00:00.000Z",
};

function processResult(overrides: Partial<ConfinedProcessResult> = {}): ConfinedProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };

function fakeIO(spawnImpl: (call: SpawnCall) => Promise<ConfinedProcessResult> | ConfinedProcessResult) {
  const calls: SpawnCall[] = [];
  const io: ConfinedJobIO = {
    ...nodeConfinedJobIO,
    platform: () => "darwin",
    access: vi.fn(async () => {}),
    spawn: vi.fn(async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      return spawnImpl(call);
    }),
  };
  return { io, calls };
}

describe("Seatbelt profile and job paths", () => {
  it("allows spaces and ampersands but rejects SBPL-hostile characters", () => {
    expect(assertSeatbeltSafePath("/Users/example/Hive & Voice/.hive-state/jobs/op/job")).toContain("&");
    for (const bad of ['/tmp/a"b', "/tmp/a\\b", "/tmp/a\0b", "/tmp/a\nb", "/tmp/a\tb", "/tmp/ab"]) {
      expect(() => assertSeatbeltSafePath(bad)).toThrow("unsafe for a Seatbelt profile");
    }
    expect(() => assertSeatbeltSafePath("relative/job")).toThrow("absolute");
  });

  it("denies every write except the canonical job directory and stdio devices", () => {
    const profile = buildSeatbeltProfile("/private/var/hive home/.hive-state/jobs/op/install-1");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/private/var/hive home/.hive-state/jobs/op/install-1"))');
    expect(profile.match(/allow file-write\* \(subpath/g)).toHaveLength(1);
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).not.toMatch(/\$HOME|\.hive\.next|deny network|deny process/);
  });

  it("points every installer write location inside the job and admits no inherited node selectors", () => {
    const job = "/private/var/h/.hive-state/jobs/op/install-1";
    const env = confinedJobEnvironment(job, { home: "job", pathEnv: "/usr/bin:/bin" });
    for (const key of [
      "TMPDIR",
      "TMP",
      "TEMP",
      "npm_config_cache",
      "npm_config_logs_dir",
      "npm_config_devdir",
      "HOME",
      "XDG_CACHE_HOME",
    ]) {
      expect(env[key]?.startsWith(`${job}/`)).toBe(true);
    }
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["NODE_OPTIONS", "NODE_PATH"]));
    expect(() =>
      confinedJobEnvironment(job, { home: "job", pathEnv: "/bin", extraEnv: { NODE_OPTIONS: "--x" } }),
    ).toThrow("not allowed");
    expect(() =>
      confinedJobEnvironment(job, { home: "job", pathEnv: "/bin", extraEnv: { npm_config_cache: "/Users/x/.npm" } }),
    ).toThrow("not allowed");
    expect(() => confinedJobEnvironment(job, { home: "job", pathEnv: "/bin", extraEnv: { TMPDIR: "/tmp" } })).toThrow(
      "not allowed",
    );
    expect(
      confinedJobEnvironment(job, { home: "/Users/x", pathEnv: "/bin", extraEnv: { HIVE_HOME: "/h" } }),
    ).toMatchObject({
      HOME: "/Users/x",
      HIVE_HOME: "/h",
    });
  });
});

describe("single-use job directories", () => {
  it("creates exclusive owned job directories under the instance job area", async () => {
    const home = instanceRoot();
    const job = await createJobDirectory(home, "op-1", "install-1", "install");
    expect(job.path).toBe(resolve(home, ".hive-state", "jobs", "op-1", "install-1"));
    await expect(createJobDirectory(home, "op-1", "install-1", "install")).rejects.toThrow("single-use");
    await expect(createJobDirectory(home, "op-1", "../escape", "install")).rejects.toThrow("invalid job ID");
  });

  it("refuses a non-canonical home and a symlinked job area", async () => {
    const home = instanceRoot();
    const alias = `${home}-alias`;
    symlinkSync(home, alias);
    await expect(createJobDirectory(alias, "op", "job", "install")).rejects.toThrow("canonical instance home");
    mkdirSync(resolve(home, ".hive-state"), { mode: 0o700 });
    const elsewhere = resolve(dirname(home), "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, resolve(home, ".hive-state", "jobs"));
    await expect(createJobDirectory(home, "op", "job", "install")).rejects.toThrow("not a real directory");
  });
});

describe("confined job runner", () => {
  it("refuses to exist without a passed self-test", () => {
    expect(
      () =>
        new ConfinedJobRunner({
          canonicalInstanceHome: "/tmp",
          operationId: "op",
          selfTest: { outcome: "failed" } as unknown as ConfinementSelfTest,
        }),
    ).toThrow(ConfinementUnavailableError);
    expect(() => assertConfinedJobRunner(undefined)).toThrow(ConfinedJobRunnerRequiredError);
  });

  it("launches only through sandbox-exec with an argv array, journals the job and is single-use", async () => {
    const home = instanceRoot();
    const { io, calls } = fakeIO(() => processResult({ stdout: Buffer.from("ok") }));
    const records: ConfinedJobRecord[] = [];
    const runner = new ConfinedJobRunner({
      canonicalInstanceHome: home,
      operationId: "op-2",
      selfTest: passed,
      io,
      journal: async (record) => {
        records.push(record);
      },
    });
    const job = await runner.prepare("install");
    expect(existsSync(resolve(job.path, "npm-cache"))).toBe(true);
    const result = await runner.launch(job, {
      command: "/opt/node/bin/node",
      args: ["/opt/npm/bin/npm-cli.js", "ci", "--omit=dev"],
      home: "job",
      pathEnv: "/usr/bin:/bin",
      timeoutMs: 600_000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(SANDBOX_EXEC);
    expect(calls[0].args.slice(0, 2)).toEqual(["-p", buildSeatbeltProfile(job.path)]);
    expect(calls[0].args.slice(2)).toEqual(["/opt/node/bin/node", "/opt/npm/bin/npm-cli.js", "ci", "--omit=dev"]);
    expect(calls[0].options.cwd).toBe(job.path);
    expect(calls[0].options.env.npm_config_cache).toBe(resolve(job.path, "npm-cache"));
    expect(result.exitCode).toBe(0);
    expect(records.map((record) => record.state)).toEqual(["created", "exited"]);
    expect(records[1]).toMatchObject({ kind: "install", exitCode: 0, path: job.path });
    await expect(
      runner.launch(job, { command: "/bin/true", args: [], home: "job", pathEnv: "/bin", timeoutMs: 10 }),
    ).rejects.toThrow("single-use");
    expect(calls).toHaveLength(1);
  });

  it("fails settlement on a non-zero, signaled, timed-out or truncated direct child", async () => {
    const home = instanceRoot();
    for (const failure of [
      { exitCode: 1 },
      { exitCode: null, signal: "SIGKILL" },
      { exitCode: null, signal: "SIGKILL", timedOut: true },
      { exitCode: null, signal: "SIGKILL", outputTruncated: true },
    ]) {
      const { io } = fakeIO(() => processResult({ ...failure, stderr: Buffer.from("npm ERR! native build") }));
      const runner = new ConfinedJobRunner({ canonicalInstanceHome: home, operationId: "op-3", selfTest: passed, io });
      const result = await runner.run("install", {
        command: "/opt/node",
        args: [],
        home: "job",
        pathEnv: "/bin",
        timeoutMs: 1_000,
      });
      expect(() => requireJobSuccess(result)).toThrow(ConfinedJobFailedError);
    }
  });

  it("rejects relative commands and cwd before spawning", async () => {
    const home = instanceRoot();
    const { io, calls } = fakeIO(() => processResult());
    const runner = new ConfinedJobRunner({ canonicalInstanceHome: home, operationId: "op-4", selfTest: passed, io });
    await expect(
      runner.run("fetch", { command: "npm", args: [], home: "job", pathEnv: "/bin", timeoutMs: 5 }),
    ).rejects.toThrow("absolute");
    expect(calls).toHaveLength(0);
  });
});

describe("confinement self-test", () => {
  function selfTestIO(outcome: { outside: string; inside: string }, createOutside = false) {
    return fakeIO((call) => {
      if (call.command === "/usr/bin/sw_vers") return processResult({ stdout: Buffer.from("26.6.2\n") });
      const [outsidePath, insidePath] = call.args.slice(-2);
      if (createOutside) writeFileSync(outsidePath, "x");
      if (outcome.inside === "ok") writeFileSync(insidePath, "x");
      return processResult({ stdout: Buffer.from(JSON.stringify(outcome)) });
    });
  }

  it("passes only when the outside write is denied with EPERM and the inside write succeeds", async () => {
    const home = instanceRoot();
    const { io, calls } = selfTestIO({ outside: "EPERM", inside: "ok" });
    const result = await runConfinementSelfTest({
      canonicalInstanceHome: home,
      operationId: "op",
      nodePath: "/opt/node",
      io,
    });
    expect(result).toMatchObject({ outcome: "passed", macosVersion: "26.6.2", sandboxExec: SANDBOX_EXEC });
    const probe = calls.find((call) => call.command === SANDBOX_EXEC)!;
    expect(probe.args[0]).toBe("-p");
    expect(probe.args[2]).toBe("/opt/node");
    expect(existsSync(resolve(home, ".hive-state", "jobs", "op"))).toBe(true);
  });

  it("fails closed when sandbox-exec is missing, before any job directory or spawn", async () => {
    const home = instanceRoot();
    const { io, calls } = selfTestIO({ outside: "EPERM", inside: "ok" });
    io.access = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    await expect(
      runConfinementSelfTest({ canonicalInstanceHome: home, operationId: "op", nodePath: "/opt/node", io }),
    ).rejects.toThrow(ConfinementUnavailableError);
    expect(calls).toHaveLength(0);
    expect(existsSync(resolve(home, ".hive-state"))).toBe(false);
  });

  it("fails closed off macOS", async () => {
    const home = instanceRoot();
    const { io } = selfTestIO({ outside: "EPERM", inside: "ok" });
    io.platform = () => "linux";
    await expect(
      runConfinementSelfTest({ canonicalInstanceHome: home, operationId: "op", nodePath: "/opt/node", io }),
    ).rejects.toThrow(ConfinementUnavailableError);
  });

  it.each([
    ["a profile that does not deny", { outside: "written", inside: "ok" }, false],
    ["a non-EPERM denial", { outside: "EACCES", inside: "ok" }, false],
    ["a stray outside file despite EPERM", { outside: "EPERM", inside: "ok" }, true],
    ["an inside write failure", { outside: "EPERM", inside: "EPERM" }, false],
  ])("fails closed on %s", async (_name, outcome, createOutside) => {
    const home = instanceRoot();
    const { io } = selfTestIO(outcome, createOutside);
    await expect(
      runConfinementSelfTest({ canonicalInstanceHome: home, operationId: "op", nodePath: "/opt/node", io }),
    ).rejects.toThrow(ConfinementSelfTestError);
    const jobs = resolve(home, ".hive-state", "jobs", "op");
    expect(existsSync(jobs) ? (await import("node:fs")).readdirSync(jobs) : []).toEqual([]);
  });

  it("fails closed on a launcher error or failed probe", async () => {
    const home = instanceRoot();
    const { io } = fakeIO((call) => {
      if (call.command === SANDBOX_EXEC) throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
      return processResult({ stdout: Buffer.from("26.6.2") });
    });
    await expect(
      runConfinementSelfTest({ canonicalInstanceHome: home, operationId: "op", nodePath: "/opt/node", io }),
    ).rejects.toThrow("launcher failed");
    const { io: failing } = fakeIO(() => processResult({ exitCode: 65 }));
    await expect(
      runConfinementSelfTest({ canonicalInstanceHome: home, operationId: "op2", nodePath: "/opt/node", io: failing }),
    ).rejects.toThrow("did not complete");
  });

  it.skipIf(process.platform !== "darwin")(
    "denies an outside write under the real sandbox-exec (macOS sanity)",
    async () => {
      const home = instanceRoot();
      const result = await runConfinementSelfTest({
        canonicalInstanceHome: home,
        operationId: "real-self-test",
        nodePath: process.execPath,
      });
      expect(result.outcome).toBe("passed");
    },
  );
});

describe("node process boundary", () => {
  it("captures the direct child's exit status and bounds a straggler holding stdio", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
      "process.stdout.write(String(child.pid));",
      "child.unref();",
      "process.exit(3);",
    ].join("\n");
    const started = Date.now();
    const result = await nodeConfinedJobIO.spawn(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 20_000,
      maxOutputBytes: 1_024,
    });
    const straggler = Number(result.stdout.toString("utf8"));
    try {
      expect(result.exitCode).toBe(3);
      expect(Date.now() - started).toBeLessThan(7_000);
    } finally {
      if (Number.isSafeInteger(straggler) && straggler > 0) {
        try {
          process.kill(straggler, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });

  it("terminates only the direct child on timeout", async () => {
    const result = await nodeConfinedJobIO.spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 200,
      maxOutputBytes: 1_024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
