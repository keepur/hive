import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolveSessionCwd } from "./session-cwd.js";
import { agentScratchDir, hiveHome } from "../paths.js";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

describe("resolveSessionCwd (KPR-348)", () => {
  it("default path → agent scratch dir created + returned", () => {
    const agentId = `kpr348-cwd-${Date.now()}`;
    const expected = agentScratchDir(agentId, hiveHome);
    cleanups.push(expected);
    const result = resolveSessionCwd(agentId);
    expect(result).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(statSync(expected).isDirectory()).toBe(true);
  });
});
