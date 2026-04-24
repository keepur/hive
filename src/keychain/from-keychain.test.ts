import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

describe("fromKeychain", () => {
  const origPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("returns trimmed value on success", async () => {
    mockExecFileSync.mockReturnValue("secret-value\n" as any);
    const { fromKeychain } = await import("./from-keychain.js");
    expect(fromKeychain("test-inst", "MY_KEY")).toBe("secret-value");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "hive/test-inst/MY_KEY", "-w"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it('returns "" when security command fails (entry missing)', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const { fromKeychain } = await import("./from-keychain.js");
    expect(fromKeychain("test-inst", "MISSING")).toBe("");
  });

  it('returns "" on non-darwin without invoking security', async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { fromKeychain } = await import("./from-keychain.js");
    expect(fromKeychain("test-inst", "ANY")).toBe("");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("scopes the service name by instanceId", async () => {
    mockExecFileSync.mockReturnValue("v" as any);
    const { fromKeychain } = await import("./from-keychain.js");
    fromKeychain("keepur", "FOO");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "hive/keepur/FOO", "-w"],
      expect.anything(),
    );
  });
});
