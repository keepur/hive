import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionCwd } from "./session-cwd.js";
import { agentScratchDir, hiveHome } from "../paths.js";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

describe("resolveSessionCwd (KPR-348)", () => {
  it("default path (no archetype cwd) → agent scratch dir created + returned", () => {
    const agentId = `kpr348-cwd-${Date.now()}`;
    const expected = agentScratchDir(agentId, hiveHome);
    cleanups.push(expected);
    const result = resolveSessionCwd({ archetypeCwd: undefined, agentId });
    expect(result).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(statSync(expected).isDirectory()).toBe(true);
  });

  it("archetype path that exists → returned as-is", () => {
    const dir = mkdtempSync(join(tmpdir(), "kpr348-arch-"));
    cleanups.push(dir);
    const result = resolveSessionCwd({ archetypeCwd: dir, agentId: "a" });
    expect(result).toBe(dir);
  });

  it("archetype path missing → throws (refusing to run) and does NOT create it", () => {
    const missing = join(tmpdir(), `kpr348-missing-${Date.now()}`);
    expect(() => resolveSessionCwd({ archetypeCwd: missing, agentId: "a" })).toThrow(/refusing to run/);
    expect(existsSync(missing)).toBe(false);
  });

  it("archetype path is a file → throws not a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kpr348-arch-file-"));
    cleanups.push(dir);
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(() => resolveSessionCwd({ archetypeCwd: file, agentId: "a" })).toThrow(/not a directory/);
  });
});
