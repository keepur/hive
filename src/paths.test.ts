import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { engineDir, hiveHome, hiveStateDir, instanceGitDir, sdkConfigDir } from "./paths.js";

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

  it("sdkConfigDir resolves to <hiveHome>/.claude-sdk-config", () => {
    expect(sdkConfigDir()).toBe(resolve(hiveHome, ".claude-sdk-config"));
  });

  it("sdkConfigDir honors an explicit home arg", () => {
    expect(sdkConfigDir("/tmp/fake-hive")).toBe(resolve("/tmp/fake-hive", ".claude-sdk-config"));
  });
});
