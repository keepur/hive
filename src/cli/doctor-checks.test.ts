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
  const aggregate = vi.fn();
  const collection = vi.fn(() => ({ estimatedDocumentCount, findOne, aggregate }));
  const command = vi.fn((cmd: unknown) => ping(cmd));
  const db = vi.fn(() => ({ command, collection }));
  const connect = vi.fn();
  const close = vi.fn();
  const MongoClient = vi.fn(() => ({ connect, db, close }));
  return { MongoClient, __mocks: { connect, close, ping, estimatedDocumentCount, findOne, aggregate } };
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
  it("KPR-229: defaultAgentExists true when an agent has isDefault: true", async () => {
    // Post-fix: query looks for `{ isDefault: true }` (any matching doc),
    // not a specific `id`. Returns true if any agent is flagged.
    mongoMocks.findOne.mockResolvedValue({ _id: "hermi", isDefault: true });
    await expect(defaultAgentExists("mongodb://x", "hive_test")).resolves.toBe(true);
    // The query filter is `{ isDefault: true }` — pin it so a future
    // refactor can't silently revert to the per-id lookup that hid the
    // problem.
    expect(mongoMocks.findOne).toHaveBeenLastCalledWith({ isDefault: true });
  });
  it("KPR-229: defaultAgentExists false when no agent has isDefault: true", async () => {
    mongoMocks.findOne.mockResolvedValue(null);
    await expect(defaultAgentExists("mongodb://x", "hive_test")).resolves.toBe(false);
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

// ── prompt cache observability (KPR-140) ────────────────────────────────

import { cacheHitRatesForDoctor, formatHitRate } from "./doctor-checks.js";

describe("formatHitRate", () => {
  it("renders null as 'no data'", () => {
    expect(formatHitRate(null)).toBe("no data");
  });
  it("renders a fraction as a percentage with one decimal", () => {
    expect(formatHitRate(0.8123)).toBe("81.2%");
    expect(formatHitRate(0)).toBe("0.0%");
  });
});

describe("cacheHitRatesForDoctor", () => {
  beforeEach(() => {
    mongoMocks.connect.mockReset().mockResolvedValue(undefined);
    mongoMocks.close.mockReset().mockResolvedValue(undefined);
    mongoMocks.aggregate.mockReset();
  });

  it("returns [] when the collection has no rows", async () => {
    mongoMocks.aggregate.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
    });
    await expect(cacheHitRatesForDoctor("mongodb://x", "hive_test")).resolves.toEqual([]);
  });

  it("computes hit rate from disjoint counters", async () => {
    mongoMocks.aggregate.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          _id: "agent-a",
          turns: 3,
          inputTokens: 100,
          cacheReadTokens: 400,
          cacheCreationTokens: 0,
          ephemeral5mTokens: 0,
          ephemeral1hTokens: 0,
        };
      },
    });
    const rows = await cacheHitRatesForDoctor("mongodb://x", "hive_test");
    expect(rows).toHaveLength(1);
    expect(rows[0].hitRate).toBeCloseTo(0.8, 4);
    expect(rows[0].turns).toBe(3);
  });

  it("returns [] when the connection throws", async () => {
    mongoMocks.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(cacheHitRatesForDoctor("mongodb://x", "hive_test")).resolves.toEqual([]);
  });
});

// ── datastore identity (KPR-296) ─────────────────────────────────────────

import {
  DOCTOR_DB_IDENTITY_STATS_KIND,
  DOCTOR_SENTINEL_COLLECTION,
  DOCTOR_SENTINEL_ID,
  DOCTOR_SENTINEL_SCHEMA_VERSION,
  formatUptime,
  isTempDbPath,
  mapIdentityStatsDoc,
  mapRosterStatsDoc,
  mapSentinelDoc,
  redactMongoUri,
} from "./doctor-checks.js";
// Producer constants — imported in TESTS only (the source module must not
// import identity-sentinel.ts; see the literal-duplication comment there).
import {
  SENTINEL_COLLECTION,
  SENTINEL_ID,
  SENTINEL_SCHEMA_VERSION,
  DbIdentityMonitor,
} from "../db/identity-sentinel.js";

describe("KPR-296 contract drift pins", () => {
  it("doctor's duplicated sentinel identifiers match the producer's exported constants", () => {
    expect(DOCTOR_SENTINEL_COLLECTION).toBe(SENTINEL_COLLECTION);
    expect(DOCTOR_SENTINEL_ID).toBe(SENTINEL_ID);
    expect(DOCTOR_SENTINEL_SCHEMA_VERSION).toBe(SENTINEL_SCHEMA_VERSION);
    expect(DOCTOR_DB_IDENTITY_STATS_KIND).toBe(DbIdentityMonitor.TELEMETRY_KIND);
  });
  // agent_roster_stats has no exported producer constant — it's a literal
  // inside the writeRosterStats closure in index.ts; pinned by the Task 3
  // grep acceptance instead.
});

describe("redactMongoUri", () => {
  it("redacts userinfo on a plain mongodb:// URI", () => {
    expect(redactMongoUri("mongodb://user:pass@localhost:27017/x")).toBe("mongodb://<credentials>@localhost:27017/x");
  });
  it("redacts userinfo on a mongodb+srv:// URI", () => {
    expect(redactMongoUri("mongodb+srv://u:p@cluster.example.com")).toBe(
      "mongodb+srv://<credentials>@cluster.example.com",
    );
  });
  it("leaves a credential-less URI unchanged", () => {
    expect(redactMongoUri("mongodb://localhost:27017")).toBe("mongodb://localhost:27017");
  });
  it("leaves a URI with '@' only after the first '/' unchanged (no userinfo)", () => {
    expect(redactMongoUri("mongodb://localhost:27017/db?replicaSet=rs@0")).toBe(
      "mongodb://localhost:27017/db?replicaSet=rs@0",
    );
  });
});

describe("isTempDbPath", () => {
  it("true for /tmp and subpaths", () => {
    expect(isTempDbPath("/tmp")).toBe(true);
    expect(isTempDbPath("/tmp/xyz")).toBe(true);
  });
  it("true for /private/tmp subpaths", () => {
    expect(isTempDbPath("/private/tmp/mongo-impostor")).toBe(true);
  });
  it("true for /var/folders subpaths", () => {
    expect(isTempDbPath("/var/folders/ab/cd")).toBe(true);
  });
  it("false for unrelated or look-alike paths", () => {
    expect(isTempDbPath("/opt/homebrew/var/mongodb")).toBe(false);
    expect(isTempDbPath("/tmpfoo")).toBe(false);
    expect(isTempDbPath("/data/tmp")).toBe(false);
  });
});

describe("formatUptime", () => {
  it("formats days+hours", () => {
    expect(formatUptime(266_520)).toBe("3d2h");
  });
  it("formats hours+minutes", () => {
    expect(formatUptime(3_700)).toBe("1h1m");
  });
  it("formats minutes only", () => {
    expect(formatUptime(90)).toBe("1m");
  });
});

describe("mapSentinelDoc", () => {
  const expected = { instanceId: "dodi", dbName: "hive_dodi" };

  it("null doc -> absent", () => {
    expect(mapSentinelDoc(null, expected)).toEqual({ state: "absent" });
  });

  it("exact match -> verified, with stampedBy formatting and stampedAt passthrough", () => {
    const stampedAt = new Date("2026-07-01T00:00:00Z");
    const result = mapSentinelDoc(
      {
        instanceId: "dodi",
        dbName: "hive_dodi",
        sentinelId: "abc-123",
        schemaVersion: 1,
        stampedAt,
        stampedBy: { engineVersion: "0.9.2", hostname: "mokiemon" },
      },
      expected,
    );
    expect(result).toEqual({
      state: "verified",
      observed: { instanceId: "dodi", dbName: "hive_dodi", sentinelId: "abc-123" },
      schemaVersionNewer: false,
      stampedAt,
      stampedBy: "0.9.2@mokiemon",
    });
  });

  it("instanceId differs (dbName equal) -> mismatch", () => {
    const result = mapSentinelDoc({ instanceId: "keepur", dbName: "hive_dodi" }, expected);
    expect(result.state).toBe("mismatch");
  });

  it("dbName differs (instanceId equal) -> mismatch (inverse direction)", () => {
    const result = mapSentinelDoc({ instanceId: "dodi", dbName: "hive_keepur" }, expected);
    expect(result.state).toBe("mismatch");
  });

  it("match ignores sentinelId/stampedAt/stampedBy/wall clock — still verified", () => {
    const result = mapSentinelDoc(
      {
        instanceId: "dodi",
        dbName: "hive_dodi",
        sentinelId: "foreign-sentinel-id",
        stampedAt: new Date("2000-01-01T00:00:00Z"),
        stampedBy: { engineVersion: "0.0.1", hostname: "someone-elses-box" },
      },
      expected,
    );
    expect(result.state).toBe("verified");
  });

  it("schemaVersion newer + matching identity -> verified with schemaVersionNewer true", () => {
    const result = mapSentinelDoc({ instanceId: "dodi", dbName: "hive_dodi", schemaVersion: 2 }, expected);
    expect(result).toMatchObject({ state: "verified", schemaVersionNewer: true });
  });

  it("schemaVersion newer + mismatch -> mismatch with schemaVersionNewer true", () => {
    const result = mapSentinelDoc({ instanceId: "keepur", dbName: "hive_dodi", schemaVersion: 2 }, expected);
    expect(result).toMatchObject({ state: "mismatch", schemaVersionNewer: true });
  });

  it("malformed doc (missing instanceId) -> mismatch with observed.instanceId '<invalid>', no throw", () => {
    expect(() => mapSentinelDoc({ dbName: "hive_dodi" }, expected)).not.toThrow();
    const result = mapSentinelDoc({ dbName: "hive_dodi" }, expected);
    expect(result).toMatchObject({ state: "mismatch", observed: { instanceId: "<invalid>" } });
  });
});

describe("mapIdentityStatsDoc", () => {
  const now = new Date("2026-07-06T00:00:00Z").getTime();

  it("null -> null", () => {
    expect(mapIdentityStatsDoc(null, now)).toBeNull();
  });

  it("full doc maps all fields + staleSeconds from pinned now", () => {
    const updatedAt = new Date(now - 45_000);
    const lastVerifiedAt = new Date(now - 10_000);
    const lastMismatchAt = new Date(now - 500_000);
    const result = mapIdentityStatsDoc(
      {
        state: "verified",
        writesRefused: false,
        refusedWriteCount: 3,
        lastVerifiedAt,
        lastMismatchAt,
        observedInstanceId: "dodi",
        observedDbName: "hive_dodi",
        updatedAt,
      },
      now,
    );
    expect(result).toEqual({
      state: "verified",
      writesRefused: false,
      refusedWriteCount: 3,
      lastVerifiedAt,
      lastMismatchAt,
      observedInstanceId: "dodi",
      observedDbName: "hive_dodi",
      staleSeconds: 45,
    });
  });

  it("missing state -> 'unknown'", () => {
    const result = mapIdentityStatsDoc({}, now);
    expect(result?.state).toBe("unknown");
  });

  it("missing counters -> defaults", () => {
    const result = mapIdentityStatsDoc({}, now);
    expect(result).toMatchObject({
      writesRefused: false,
      refusedWriteCount: 0,
      lastVerifiedAt: null,
      lastMismatchAt: null,
      observedInstanceId: null,
      observedDbName: null,
    });
  });

  it("non-Date updatedAt -> staleSeconds null", () => {
    const result = mapIdentityStatsDoc({ updatedAt: "2026-07-06T00:00:00Z" }, now);
    expect(result?.staleSeconds).toBeNull();
  });

  it("unknown state string passes through verbatim", () => {
    const result = mapIdentityStatsDoc({ state: "some_future_state" }, now);
    expect(result?.state).toBe("some_future_state");
  });
});

describe("mapRosterStatsDoc", () => {
  it("null -> null", () => {
    expect(mapRosterStatsDoc(null)).toBeNull();
  });

  it("full doc round-trips", () => {
    const lastGoodAt = new Date("2026-07-05T00:00:00Z");
    const degradedSince = new Date("2026-07-04T00:00:00Z");
    const lastBlockedAt = new Date("2026-07-03T00:00:00Z");
    const updatedAt = new Date("2026-07-06T00:00:00Z");
    const result = mapRosterStatsDoc({
      docCount: 12,
      activeCount: 10,
      disabledCount: 2,
      lastGoodAt,
      lastGoodSource: "reload",
      degraded: true,
      degradedSince,
      blockedReloadCount: 4,
      lastBlockedAt,
      updatedAt,
    });
    expect(result).toEqual({
      docCount: 12,
      activeCount: 10,
      disabledCount: 2,
      lastGoodAt,
      lastGoodSource: "reload",
      degraded: true,
      degradedSince,
      blockedReloadCount: 4,
      lastBlockedAt,
      updatedAt,
    });
  });

  it("partial doc (only frozen E2 fields) -> nulls/defaults, no throw", () => {
    expect(() =>
      mapRosterStatsDoc({
        docCount: 5,
        activeCount: 5,
        lastGoodAt: new Date("2026-07-05T00:00:00Z"),
        lastGoodSource: "boot",
      }),
    ).not.toThrow();
    const result = mapRosterStatsDoc({
      docCount: 5,
      activeCount: 5,
      lastGoodAt: new Date("2026-07-05T00:00:00Z"),
      lastGoodSource: "boot",
    });
    expect(result).toMatchObject({
      disabledCount: null,
      degradedSince: null,
      blockedReloadCount: 0,
      lastBlockedAt: null,
      degraded: false,
    });
  });

  it("degraded missing -> false", () => {
    const result = mapRosterStatsDoc({ docCount: 1 });
    expect(result?.degraded).toBe(false);
  });
});
