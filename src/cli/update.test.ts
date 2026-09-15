import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readFile: vi.fn(),
  lstat: vi.fn(() => ({ isFile: () => true, isSymbolicLink: () => false })),
}));

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mocks.readFile(...args),
  lstatSync: (...args: unknown[]) => mocks.lstat(...args),
  existsSync: () => true,
}));
vi.mock("../paths.js", () => ({
  resolveHiveHome: () => "/tmp/test-hive",
  resolveConfigFile: () => "/tmp/test-hive/hive.yaml",
}));
vi.mock("./deployment-helper.js", () => ({
  invokeDeploymentHelper: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("./single-instance-env.js", () => ({
  deriveSingleInstanceEnv: (_home: string, tag?: string) => ({
    HIVE_SINGLE_INSTANCE: "1",
    HIVE_SINGLE_ID: "catalyst",
    HIVE_SINGLE_CONFIG: "/tmp/test-hive/hive.yaml",
    HIVE_SINGLE_ROOT: "/tmp/test-hive",
    ...(tag ? { HIVE_SINGLE_TAG: tag } : {}),
  }),
}));

describe("packaged update CLI", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.readFile.mockReturnValue(JSON.stringify({ version: "0.15.3" }));
    mocks.lstat.mockReturnValue({ isFile: () => true, isSymbolicLink: () => false });
  });

  it("routes tag update to this CLI package's helper", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate({ tag: "v0.16.0", instance: "catalyst" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0][2]).toEqual(["--tag=v0.16.0", "--instance=catalyst"]);
  });

  it("routes an absolute regular artifact and preserves dry-run", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate({ artifact: "/tmp/candidate.tgz", dryRun: true });
    expect(mocks.lstat).toHaveBeenCalledWith("/tmp/candidate.tgz");
    expect(mocks.invoke.mock.calls[0][2]).toEqual([
      "--artifact=/tmp/candidate.tgz",
      "--instance=catalyst",
      "--dry-run",
    ]);
  });

  it("rejects tag plus artifact before invoking the helper", async () => {
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate({ tag: "latest", artifact: "/tmp/candidate.tgz" })).rejects.toThrow("mutually exclusive");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["candidate.tgz", "/tmp/candidate.zip"])("rejects invalid artifact %s before effects", async (artifact) => {
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate({ artifact })).rejects.toThrow("absolute .tgz");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects an instance that differs from the selected config", async () => {
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate({ instance: "other" })).rejects.toThrow("does not match");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("packaged rollback CLI", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("routes rollback and dry-run through the same helper", async () => {
    const { runRollback } = await import("./rollback.js");
    await runRollback({ instance: "catalyst", dryRun: true });
    expect(mocks.invoke.mock.calls[0][2]).toEqual(["--rollback", "--instance=catalyst", "--dry-run"]);
  });

  it("rejects an instance mismatch before helper execution", async () => {
    const { runRollback } = await import("./rollback.js");
    await expect(runRollback({ instance: "keepur" })).rejects.toThrow("does not match");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
