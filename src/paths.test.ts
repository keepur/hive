import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { engineDir, hiveHome, hiveStateDir, instanceGitDir } from "./paths.js";

describe("paths", () => {
  it("engineDir resolves to <hiveHome>/.hive", () => {
    expect(engineDir).toBe(resolve(hiveHome, ".hive"));
  });

  it("hiveStateDir resolves to <hiveHome>/.hive-state", () => {
    expect(hiveStateDir).toBe(resolve(hiveHome, ".hive-state"));
  });

  it("instanceGitDir is under hiveStateDir", () => {
    expect(instanceGitDir).toBe(resolve(hiveStateDir, "git"));
  });
});
