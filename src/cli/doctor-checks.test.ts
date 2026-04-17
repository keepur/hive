import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchctlPrint, pidAlive, requiredEnvVarsFromConfig, resolveServicePath } from "./doctor-checks.js";

// execFileSync and fetch are mocked per-test via vi.mock for subprocess checks.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});
import { execFileSync } from "node:child_process";
const execMock = vi.mocked(execFileSync);

describe("requiredEnvVarsFromConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("extracts only required() keys, ignoring optional()", () => {
    const p = join(dir, "config.ts");
    writeFileSync(
      p,
      `
      const a = required("SLACK_APP_TOKEN");
      const b = required("SLACK_BOT_TOKEN");
      const c = optional("ANTHROPIC_API_KEY", "");
      const d = optional("MONGODB_URI", "mongodb://localhost:27017");
    `,
    );
    expect(requiredEnvVarsFromConfig(p)).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  });

  it("matches the real src/config.ts — derivation stays in sync with the loader", () => {
    // Smoke test: if someone refactors config.ts in a way that breaks the
    // required("KEY") pattern, doctor would silently stop reporting missing
    // env. Pin the current known-required set.
    const real = requiredEnvVarsFromConfig(join(import.meta.dirname, "../config.ts"));
    expect(real).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  });
});

describe("launchctlPrint", () => {
  beforeEach(() => execMock.mockReset());

  it("parses running + pid", () => {
    execMock.mockReturnValueOnce(
      `{
      state = running
      pid = 12345
    }` as unknown as Buffer,
    );
    const st = launchctlPrint("com.hive.agent");
    expect(st).toEqual({ loaded: true, state: "running", pid: 12345 });
  });

  it("parses not-running state", () => {
    execMock.mockReturnValueOnce(
      `{
      state = not running
    }` as unknown as Buffer,
    );
    expect(launchctlPrint("com.hive.agent")).toEqual({ loaded: true, state: "not running", pid: null });
  });

  it("returns loaded:false when launchctl fails (agent not bootstrapped)", () => {
    execMock.mockImplementationOnce(() => {
      throw new Error("Could not find service");
    });
    expect(launchctlPrint("com.hive.agent")).toEqual({ loaded: false, state: "unknown", pid: null });
  });
});

describe("pidAlive", () => {
  it("returns true for live pid (self)", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
  it("returns false for dead pid", () => {
    expect(pidAlive(999999)).toBe(false);
  });
});

describe("resolveServicePath", () => {
  const originalHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "doctor-home-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null when plist is missing", () => {
    expect(resolveServicePath("com.hive.nonexistent.agent")).toBeNull();
  });

  it("parses WorkingDirectory from a real plist layout", () => {
    const dir = join(tmpHome, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "com.hive.test.plist"),
      `<?xml version="1.0"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hive.test</string>
  <key>WorkingDirectory</key><string>/Users/mokie/services/hive</string>
</dict>
</plist>`,
    );
    expect(resolveServicePath("com.hive.test")).toBe("/Users/mokie/services/hive");
  });

  it("expands ~ in WorkingDirectory", () => {
    const dir = join(tmpHome, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "com.hive.test2.plist"),
      `<plist><dict><key>WorkingDirectory</key><string>~/services/hive</string></dict></plist>`,
    );
    expect(resolveServicePath("com.hive.test2")).toBe(join(tmpHome, "services/hive"));
  });
});

// ── mongoReachable / hasAnyAgent / defaultAgentExists ────────────────────

vi.mock("mongodb", () => {
  const ping = vi.fn();
  const estimatedDocumentCount = vi.fn();
  const findOne = vi.fn();
  const collection = vi.fn(() => ({ estimatedDocumentCount, findOne }));
  const command = vi.fn((cmd: unknown) => ping(cmd));
  const db = vi.fn(() => ({ command, collection }));
  const connect = vi.fn();
  const close = vi.fn();
  const MongoClient = vi.fn(() => ({ connect, db, close }));
  return { MongoClient, __mocks: { connect, close, ping, estimatedDocumentCount, findOne } };
});

import * as mongodb from "mongodb";
const mongoMocks = (mongodb as unknown as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
import { mongoReachable, hasAnyAgent, defaultAgentExists } from "./doctor-checks.js";

describe("mongoReachable", () => {
  beforeEach(() => {
    mongoMocks.connect.mockReset();
    mongoMocks.close.mockReset().mockResolvedValue(undefined);
    mongoMocks.ping.mockReset();
  });

  it("returns true when ping succeeds", async () => {
    mongoMocks.connect.mockResolvedValue(undefined);
    mongoMocks.ping.mockResolvedValue({ ok: 1 });
    await expect(mongoReachable("mongodb://x", "hive_test")).resolves.toBe(true);
  });

  it("returns false when connect throws", async () => {
    mongoMocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(mongoReachable("mongodb://x", "hive_test")).resolves.toBe(false);
  });
});

describe("hasAnyAgent / defaultAgentExists", () => {
  beforeEach(() => {
    mongoMocks.connect.mockReset().mockResolvedValue(undefined);
    mongoMocks.close.mockReset().mockResolvedValue(undefined);
    mongoMocks.estimatedDocumentCount.mockReset();
    mongoMocks.findOne.mockReset();
  });

  it("hasAnyAgent true when count>0", async () => {
    mongoMocks.estimatedDocumentCount.mockResolvedValue(3);
    await expect(hasAnyAgent("mongodb://x", "hive_test")).resolves.toBe(true);
  });
  it("hasAnyAgent false when count=0", async () => {
    mongoMocks.estimatedDocumentCount.mockResolvedValue(0);
    await expect(hasAnyAgent("mongodb://x", "hive_test")).resolves.toBe(false);
  });
  it("defaultAgentExists true when doc found", async () => {
    mongoMocks.findOne.mockResolvedValue({ id: "chief-of-staff" });
    await expect(defaultAgentExists("mongodb://x", "hive_test", "chief-of-staff")).resolves.toBe(true);
  });
  it("defaultAgentExists false when doc missing", async () => {
    mongoMocks.findOne.mockResolvedValue(null);
    await expect(defaultAgentExists("mongodb://x", "hive_test", "ghost")).resolves.toBe(false);
  });
});

// ── slackAuthOk ─────────────────────────────────────────────────────────

vi.mock("@slack/web-api", () => {
  const test = vi.fn();
  const WebClient = vi.fn(() => ({ auth: { test } }));
  return { WebClient, __test: test };
});
import * as slack from "@slack/web-api";
const slackTest = (slack as unknown as { __test: ReturnType<typeof vi.fn> }).__test;
import { slackAuthOk } from "./doctor-checks.js";

describe("slackAuthOk", () => {
  // NOTE: no mockReset() in beforeEach — using mockImplementationOnce per test
  // avoids a vitest quirk where mockReset() + sync-throw impl interacts badly
  // with unhandled-rejection detection for dynamic-imported mocked modules.
  beforeEach(() => slackTest.mockClear());

  it("returns false when token is empty (skips HTTP)", async () => {
    await expect(slackAuthOk("")).resolves.toBe(false);
    expect(slackTest).not.toHaveBeenCalled();
  });
  it("returns true when auth.test ok", async () => {
    slackTest.mockImplementationOnce(async () => ({ ok: true }));
    await expect(slackAuthOk("xoxb-x")).resolves.toBe(true);
  });
  it("returns false when auth.test ok=false", async () => {
    slackTest.mockImplementationOnce(async () => ({ ok: false }));
    await expect(slackAuthOk("xoxb-x")).resolves.toBe(false);
  });
  it("returns false when auth.test throws", async () => {
    slackTest.mockImplementationOnce(() => {
      throw new Error("invalid_auth");
    });
    await expect(slackAuthOk("xoxb-x")).resolves.toBe(false);
  });
});
