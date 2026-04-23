import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSnapshot } from "./integrity.js";

describe("writeSnapshot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "integrity-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes installed-snapshot.json under stateDir, not packageRoot", () => {
    const packageRoot = join(tmp, "engine");
    const stateDir = join(tmp, "state");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"x"}');

    writeSnapshot(stateDir, packageRoot, ["package.json"]);

    expect(existsSync(resolve(stateDir, "installed-snapshot.json"))).toBe(true);
    expect(existsSync(resolve(packageRoot, ".hive", "installed-snapshot.json"))).toBe(false);
  });

  it("records declared files with sha256 hashes", () => {
    const packageRoot = join(tmp, "engine");
    const stateDir = join(tmp, "state");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"x"}');

    writeSnapshot(stateDir, packageRoot, ["package.json"]);

    const snapshot = JSON.parse(readFileSync(resolve(stateDir, "installed-snapshot.json"), "utf-8"));
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toHaveProperty("path", "package.json");
    expect(snapshot[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
