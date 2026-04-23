import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

describe("runMigrate", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
  });

  it("invokes bash against migrate-0.2.sh with just the instance dir by default", async () => {
    const { runMigrate } = await import("./migrate.js");
    await runMigrate({ instanceDir: "/fake/instance" });

    expect(mockExecFileSync).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExecFileSync.mock.calls[0];
    expect(cmd).toBe("bash");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toHaveLength(2);
    expect(String(args[0])).toMatch(/install\/migrate-0\.2\.sh$/);
    expect(args[1]).toBe("/fake/instance");
    expect(opts).toMatchObject({ stdio: "inherit" });
  });

  it("prefixes --dry-run when dryRun is true", async () => {
    const { runMigrate } = await import("./migrate.js");
    await runMigrate({ instanceDir: "/fake/instance", dryRun: true });

    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(args[1]).toBe("--dry-run");
    expect(args[2]).toBe("/fake/instance");
  });

  it("exits 1 when migrate-0.2.sh is not found at the resolved pkgRoot", async () => {
    mockExistsSync.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runMigrate } = await import("./migrate.js");
    await expect(runMigrate({ instanceDir: "/fake/instance" })).rejects.toThrow(/process\.exit\(1\)/);
    expect(mockExecFileSync).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits 1 when execFileSync throws (bash returned non-zero)", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("bash exited non-zero");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const { runMigrate } = await import("./migrate.js");
    await expect(runMigrate({ instanceDir: "/fake/instance" })).rejects.toThrow(/process\.exit\(1\)/);

    exitSpy.mockRestore();
  });
});
