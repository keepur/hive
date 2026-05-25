import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("resolveHiveHome", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
  });

  it("uses HIVE_HOME env var when set", async () => {
    vi.stubEnv("HIVE_HOME", "/custom/hive");
    const { resolveHiveHome } = await import("../paths.js");
    expect(resolveHiveHome()).toBe("/custom/hive");
  });

  it("uses cwd when hive.yaml exists there", async () => {
    vi.stubEnv("HIVE_HOME", "");
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
    }));
    const { resolveHiveHome } = await import("../paths.js");
    expect(resolveHiveHome()).toBe(process.cwd());
  });

  it("walks up from cwd to the nearest parent hive.yaml", async () => {
    vi.stubEnv("HIVE_HOME", "");
    vi.doUnmock("node:fs");
    const root = mkdtempSync(join(tmpdir(), "hive-home-"));
    const nested = join(root, ".hive", "pkg");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "hive.yaml"), "instance:\n  id: catalyst\n");

    const originalCwd = process.cwd();
    try {
      process.chdir(nested);
      const { resolveHiveHome } = await import("../paths.js");
      expect(resolveHiveHome()).toBe(realpathSync(root));
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to ~/hive/", async () => {
    vi.stubEnv("HIVE_HOME", "");
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
    }));
    const { resolveHiveHome } = await import("../paths.js");
    const home = process.env.HOME ?? "/tmp";
    expect(resolveHiveHome()).toBe(resolve(home, "hive"));
  });
});

describe("resolveDotenvPath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns .env for default config", async () => {
    vi.stubEnv("HIVE_CONFIG", "");
    const { resolveDotenvPath } = await import("../paths.js");
    expect(resolveDotenvPath("/home/hive")).toBe("/home/hive/.env");
  });

  it("returns .env-personal for hive-personal.yaml", async () => {
    vi.stubEnv("HIVE_CONFIG", "hive-personal.yaml");
    const { resolveDotenvPath } = await import("../paths.js");
    expect(resolveDotenvPath("/home/hive")).toBe("/home/hive/.env-personal");
  });
});
