import { describe, it, expect } from "vitest";
import { buildPlist } from "./daemon.js";

describe("buildPlist", () => {
  it("ProgramArguments points at the provided serverPath", () => {
    const plist = buildPlist({
      label: "com.hive.test.agent",
      nodePath: "/usr/local/bin/node",
      serverPath: "/home/me/hive/.hive/dist/index.js",
      hiveHome: "/home/me/hive",
      home: "/home/me",
      pathEnv: "/usr/bin",
      logsDir: "/home/me/hive/logs",
    });
    expect(plist).toContain("<string>/home/me/hive/.hive/dist/index.js</string>");
  });

  it("WorkingDirectory stays at hiveHome (not under .hive/)", () => {
    const plist = buildPlist({
      label: "com.hive.test.agent",
      nodePath: "/usr/local/bin/node",
      serverPath: "/home/me/hive/.hive/dist/index.js",
      hiveHome: "/home/me/hive",
      home: "/home/me",
      pathEnv: "/usr/bin",
      logsDir: "/home/me/hive/logs",
    });
    expect(plist).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/home\/me\/hive<\/string>/);
  });
});
