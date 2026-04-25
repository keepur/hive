import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

// Hoisted mocks — must be declared with vi.hoisted so they're available
// at vi.mock factory evaluation time.
const { mockExecFileSync, mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("../paths.js", () => ({
  resolveHiveHome: () => "/tmp/test-hive",
  resolveConfigFile: (home: string) => `${home}/hive.yaml`,
}));

vi.mock("./update-preflight.js", () => ({
  relocateBetaPlugins: () => ({ moved: [], skipped: true }),
}));

describe("runUpdate", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.0" });
      return "";
    });
  });

  it("shells out to deploy.sh with --tag=latest by default", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate();
    expect(mockExecFileSync).toHaveBeenCalledOnce();
    const [script, args] = mockExecFileSync.mock.calls[0];
    expect(String(script)).toBe(resolve("/tmp/test-hive/.hive/service/deploy.sh"));
    expect(args).toContain("--tag=latest");
  });

  it("passes --tag=<tag> when specified", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate({ tag: "0.2.1" });
    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toContain("--tag=0.2.1");
  });

  it("passes --instance=<id> when specified", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate({ tag: "0.2.1", instance: "dodi" });
    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toContain("--tag=0.2.1");
    expect(args).toContain("--instance=dodi");
  });

  it("passes single-instance env vars to deploy.sh (KPR-70)", async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.0" });
      if (path.endsWith("hive.yaml")) {
        return `instance:\n  id: catalyst\n  portBase: 3500\n`;
      }
      return "";
    });
    const { runUpdate } = await import("./update.js");
    await runUpdate({ tag: "0.2.7" });
    const callOpts = mockExecFileSync.mock.calls[0][2] as { env: Record<string, string> };
    expect(callOpts.env.HIVE_SINGLE_INSTANCE).toBe("1");
    expect(callOpts.env.HIVE_SINGLE_ID).toBe("catalyst");
    expect(callOpts.env.HIVE_SINGLE_CONFIG).toBe("hive.yaml");
    expect(callOpts.env.HIVE_SINGLE_LOGS).toBe("logs");
    expect(callOpts.env.HIVE_SINGLE_ROOT).toBe("/tmp/test-hive");
    expect(callOpts.env.HIVE_SINGLE_TAG).toBe("0.2.7");
    // Default port range = portBase..portBase+6 = 3500..3506
    expect(callOpts.env.HIVE_SINGLE_PORTS).toBe("3500 3501 3502 3503 3504 3505 3506");
  });

  it("defaults instance id to 'hive' when hive.yaml missing instance.id", async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.0" });
      return "";
    });
    const { runUpdate } = await import("./update.js");
    await runUpdate();
    const callOpts = mockExecFileSync.mock.calls[0][2] as { env: Record<string, string> };
    expect(callOpts.env.HIVE_SINGLE_ID).toBe("hive");
    expect(callOpts.env.HIVE_SINGLE_PORTS).toBe("3100 3101 3102 3103 3104 3105 3106");
  });

  it("HIVE_SINGLE_LOGS is always 'logs' even with non-default HIVE_CONFIG", async () => {
    // daemon.ts hardcodes logs/ regardless of HIVE_CONFIG, so single-instance
    // mode must too — otherwise health_check reads from a path the service
    // never writes to and auto-rollback fires.
    process.env.HIVE_CONFIG = "hive-personal.yaml";
    try {
      const { runUpdate } = await import("./update.js");
      await runUpdate();
      const callOpts = mockExecFileSync.mock.calls[0][2] as { env: Record<string, string> };
      expect(callOpts.env.HIVE_SINGLE_LOGS).toBe("logs");
      expect(callOpts.env.HIVE_SINGLE_CONFIG).toBe("hive-personal.yaml");
    } finally {
      delete process.env.HIVE_CONFIG;
    }
  });

  it("exits 1 when deploy.sh is missing", async () => {
    mockExistsSync.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits 1 when deploy.sh fails", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("deploy failed");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("runRollback", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.1" });
      if (path.includes(".hive.prev/package.json")) return JSON.stringify({ version: "0.2.0" });
      return "";
    });
  });

  it("shells out to deploy.sh --rollback --instance=<derived>", async () => {
    const { runRollback } = await import("./rollback.js");
    await runRollback();
    const [script, args] = mockExecFileSync.mock.calls[0];
    expect(String(script)).toBe(resolve("/tmp/test-hive/.hive/service/deploy.sh"));
    expect(args).toContain("--rollback");
    // default instance comes from HIVE_SINGLE_ID (= "hive" when hive.yaml has no instance.id)
    expect(args).toContain("--instance=hive");
  });

  it("uses explicit --instance when specified", async () => {
    const { runRollback } = await import("./rollback.js");
    await runRollback({ instance: "keepur" });
    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toContain("--instance=keepur");
  });

  it("passes single-instance env vars AND --instance matching HIVE_SINGLE_ID (KPR-70)", async () => {
    // The --instance arg must agree with HIVE_SINGLE_ID — otherwise deploy.sh's
    // rollback short-circuit can't find the row in single-instance mode.
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.1" });
      if (path.includes(".hive.prev/package.json")) return JSON.stringify({ version: "0.2.0" });
      if (path.endsWith("hive.yaml")) return `instance:\n  id: catalyst\n  portBase: 3500\n`;
      return "";
    });
    const { runRollback } = await import("./rollback.js");
    await runRollback();
    const [, args, callOpts] = mockExecFileSync.mock.calls[0] as [unknown, string[], { env: Record<string, string> }];
    expect(callOpts.env.HIVE_SINGLE_INSTANCE).toBe("1");
    expect(callOpts.env.HIVE_SINGLE_ID).toBe("catalyst");
    expect(callOpts.env.HIVE_SINGLE_LOGS).toBe("logs");
    expect(callOpts.env.HIVE_SINGLE_PORTS).toBe("3500 3501 3502 3503 3504 3505 3506");
    // Critical: --instance must match HIVE_SINGLE_ID, NOT the hiveHome basename.
    // Custom install path /tmp/test-hive (basename "test-hive") with instance.id
    // "catalyst" must still pass --instance=catalyst.
    expect(args).toContain("--instance=catalyst");
  });

  it("exits 1 when .hive.prev does not exist", async () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith(".hive.prev"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { runRollback } = await import("./rollback.js");
    await expect(runRollback()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
