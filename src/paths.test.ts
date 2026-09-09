import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { engineDir, hiveHome, hiveStateDir, instanceGitDir, resolveDotenvPath } from "./paths.js";

const originalConfig = process.env.HIVE_CONFIG;

afterEach(() => {
  if (originalConfig === undefined) delete process.env.HIVE_CONFIG;
  else process.env.HIVE_CONFIG = originalConfig;
});

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

  it.each([
    [undefined, ".env"],
    ["hive.yaml", ".env"],
    ["hive-personal.yaml", ".env-personal"],
    ["/srv/selected/hive-personal.yaml", ".env-personal"],
    ["/srv/hive-parent/config/hive-personal.yaml", ".env-personal"],
    ["/outside/another-instance/hive-personal.yaml", ".env-personal"],
  ])("keeps dotenv under the selected home for selector %s", (selector, dotenv) => {
    if (selector === undefined) delete process.env.HIVE_CONFIG;
    else process.env.HIVE_CONFIG = selector;

    expect(resolveDotenvPath("/selected/symlink-home")).toBe(resolve("/selected/symlink-home", dotenv));
  });
});
