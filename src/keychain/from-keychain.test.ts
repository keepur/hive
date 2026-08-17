import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

describe("fromKeychain", () => {
  const origPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const { clearKeychainCacheForTests } = await import("./from-keychain.js");
    clearKeychainCacheForTests();
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

  it('returns "" on item-not-found (security exit 44) even after a prior success', async () => {
    const { fromKeychain } = await import("./from-keychain.js");
    mockExecFileSync.mockReturnValue("old-value\n" as any);
    expect(fromKeychain("test-inst", "ROTATED")).toBe("old-value");
    // Operator removed the entry — definitive not-found must NOT serve the cache
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("could not be found"), { status: 44 });
    });
    expect(fromKeychain("test-inst", "ROTATED")).toBe("");
  });

  it("serves last-known-good value when security fails unexpectedly (locked keychain)", async () => {
    const { fromKeychain } = await import("./from-keychain.js");
    mockExecFileSync.mockReturnValue("cached-secret\n" as any);
    expect(fromKeychain("test-inst", "GOG_KEYRING_PASSWORD")).toBe("cached-secret");
    // Transient failure — e.g. keychain locked under launchd session
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("User interaction is not allowed"), { status: 36 });
    });
    expect(fromKeychain("test-inst", "GOG_KEYRING_PASSWORD")).toBe("cached-secret");
  });

  it('returns "" on unexpected failure when nothing was ever cached', async () => {
    const { fromKeychain } = await import("./from-keychain.js");
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("User interaction is not allowed"), { status: 36 });
    });
    expect(fromKeychain("test-inst", "NEVER_READ")).toBe("");
  });

  it("does not serve cache after not-found cleared it, even on later unexpected failure", async () => {
    const { fromKeychain } = await import("./from-keychain.js");
    mockExecFileSync.mockReturnValue("v1\n" as any);
    expect(fromKeychain("test-inst", "K")).toBe("v1");
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("not found"), { status: 44 });
    });
    expect(fromKeychain("test-inst", "K")).toBe("");
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("locked"), { status: 36 });
    });
    expect(fromKeychain("test-inst", "K")).toBe("");
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
