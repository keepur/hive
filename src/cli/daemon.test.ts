import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlist, getInstanceId, getLabel, getPlistPath, getLaunchAgentLink } from "./daemon.js";

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

// Regression coverage for KPR-69: helpers must resolve from the explicit
// hiveHome parameter, not from process.cwd() / a module-level constant. The
// wizard-from-$HOME bug played out because the old daemon.ts froze hiveHome at
// import time against the wizard's cwd (no hive.yaml present).
describe("daemon helpers (KPR-69)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hive-daemon-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("getInstanceId reads instance.id from <hiveHome>/hive.yaml", () => {
    writeFileSync(join(tmp, "hive.yaml"), "instance:\n  id: catalyst\n");
    expect(getInstanceId(tmp)).toBe("catalyst");
  });

  it("getInstanceId returns 'hive' fallback when hive.yaml is missing", () => {
    expect(getInstanceId(tmp)).toBe("hive");
  });

  it("getLabel composes from the resolved instance id", () => {
    writeFileSync(join(tmp, "hive.yaml"), "instance:\n  id: catalyst\n");
    expect(getLabel(tmp)).toBe("com.hive.catalyst.agent");
  });

  it("getPlistPath lives under the provided hiveHome (not the import-time default)", () => {
    writeFileSync(join(tmp, "hive.yaml"), "instance:\n  id: catalyst\n");
    expect(getPlistPath(tmp)).toBe(join(tmp, "service", "com.hive.catalyst.agent.plist"));
  });

  it("getLaunchAgentLink uses the instance id from the provided hiveHome", () => {
    writeFileSync(join(tmp, "hive.yaml"), "instance:\n  id: catalyst\n");
    const home = process.env.HOME ?? "/tmp";
    expect(getLaunchAgentLink(tmp)).toBe(join(home, "Library", "LaunchAgents", "com.hive.catalyst.agent.plist"));
  });
});
