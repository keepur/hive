import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderCircuitBreakerSection,
  renderDatastoreIdentitySection,
  renderPrefixCacheSection,
  renderPromptCacheSection,
  renderSpawnCoordinatorSection,
  resolveRequiredEnvVars,
} from "./doctor.js";
import type { DatastoreIdentityReport } from "./doctor-checks.js";

describe("resolveRequiredEnvVars", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-here-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers required-env.json sitting next to the caller (bundled layout)", () => {
    // This is the path taken by an npm-installed hive: pkg/cli.min.js
    // calls into resolveRequiredEnvVars with import.meta.dirname pointing
    // at pkg/, and pkg/required-env.json is the shipped artifact.
    writeFileSync(join(dir, "required-env.json"), JSON.stringify({ requiredEnv: ["FOO", "BAR"] }));

    expect(resolveRequiredEnvVars(dir)).toEqual(["FOO", "BAR"]);
  });

  it("falls back to required-env.json one directory up (split layout)", () => {
    // Defensive — covers a future packaging where the JSON sits next to a
    // dist/ tree rather than alongside the bundle.
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    writeFileSync(join(dir, "required-env.json"), JSON.stringify({ requiredEnv: ["BAZ"] }));

    expect(resolveRequiredEnvVars(sub)).toEqual(["BAZ"]);
  });

  it("scans src/config.ts when no JSON is found (dev / source-checkout)", () => {
    // Simulate src/cli/ → src/config.ts layout that source-checkout dev
    // workflows rely on.
    const srcDir = join(dir, "src");
    const cliDir = join(srcDir, "cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(srcDir, "config.ts"),
      `
      const a = required("ALPHA");
      const b = required("BETA");
      const c = optional("GAMMA", "default");
      `,
    );

    // hereDir = src/cli/ — `..` is src/, `..` is dir, but the source path
    // probe is `<here>/../../src/config.ts` so we need an outer wrapper
    // that mirrors the production package layout (pkg-or-dist/cli/).
    expect(resolveRequiredEnvVars(cliDir)).toEqual(["ALPHA", "BETA"]);
  });

  it("returns [] when neither JSON nor source is reachable", () => {
    // Doctor surfaces this as a single failed check rather than crashing,
    // so `[]` is the correct fail-soft path.
    expect(resolveRequiredEnvVars(dir)).toEqual([]);
  });

  it("ignores a malformed required-env.json and falls through", () => {
    writeFileSync(join(dir, "required-env.json"), "{ this is not json");

    expect(resolveRequiredEnvVars(dir)).toEqual([]);
  });

  it("ignores a JSON whose requiredEnv field is the wrong shape", () => {
    writeFileSync(join(dir, "required-env.json"), JSON.stringify({ requiredEnv: "not-an-array" }));

    expect(resolveRequiredEnvVars(dir)).toEqual([]);
  });
});

describe("renderPromptCacheSection", () => {
  it("renders 'no telemetry yet' when the rows are empty", () => {
    const lines: string[] = [];
    renderPromptCacheSection([], (l) => lines.push(l));
    expect(lines.join("\n")).toContain("Prompt cache (last 7 days)");
    expect(lines.join("\n")).toContain("no telemetry yet");
  });

  it("renders one row per agent with hit rate, read, create, input, turns", () => {
    const lines: string[] = [];
    renderPromptCacheSection(
      [
        {
          agentId: "chief-of-staff",
          turns: 12,
          cacheReadTokens: 8000,
          cacheCreationTokens: 1000,
          inputTokens: 1000,
          ephemeral5mTokens: 800,
          ephemeral1hTokens: 200,
          hitRate: 0.8,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toMatch(
      /chief-of-staff: hit=80\.0% read=8000 create=1000 \(5m=800, 1h=200\) input=1000 turns=12/,
    );
  });

  it("omits the ephemeral breakdown when both counters are zero", () => {
    const lines: string[] = [];
    renderPromptCacheSection(
      [
        {
          agentId: "rae",
          turns: 1,
          cacheReadTokens: 50,
          cacheCreationTokens: 50,
          inputTokens: 100,
          ephemeral5mTokens: 0,
          ephemeral1hTokens: 0,
          hitRate: 0.25,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).not.toContain("(5m=");
    expect(lines.join("\n")).toContain("hit=25.0%");
  });

  it("renders 'no data' for a row with null hitRate", () => {
    const lines: string[] = [];
    renderPromptCacheSection(
      [
        {
          agentId: "ghost",
          turns: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          inputTokens: 0,
          ephemeral5mTokens: 0,
          ephemeral1hTokens: 0,
          hitRate: null,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("hit=no data");
  });
});

describe("renderPrefixCacheSection", () => {
  it("renders 'no heartbeat yet' when no row is available", () => {
    const lines: string[] = [];
    renderPrefixCacheSection(null, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("Prefix cache (live engine)");
    expect(lines.join("\n")).toContain("no heartbeat yet");
  });

  it("renders the stats line with hit rate, entries, p99, oldest age, and heartbeat freshness", () => {
    const lines: string[] = [];
    renderPrefixCacheSection(
      {
        hits: 80,
        misses: 20,
        entryCount: 5,
        lastBuildP99Ms: 42,
        oldestEntryAgeMs: 3_500_000,
        staleSeconds: 12,
      },
      (l) => lines.push(l),
    );
    const out = lines.join("\n");
    expect(out).toContain("hit-rate=80.0%");
    expect(out).toContain("entries=5");
    expect(out).toContain("p99-build=42ms");
    expect(out).toContain("oldest=3500s");
    expect(out).toContain("heartbeat 12s ago");
  });

  it("warns when the heartbeat is stale (>120s)", () => {
    const lines: string[] = [];
    renderPrefixCacheSection(
      {
        hits: 0,
        misses: 0,
        entryCount: 0,
        lastBuildP99Ms: 0,
        oldestEntryAgeMs: 0,
        staleSeconds: 300,
      },
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toMatch(/heartbeat is stale/);
  });

  it("warns when the oldest entry exceeds 24h (possible invalidation gap)", () => {
    const lines: string[] = [];
    renderPrefixCacheSection(
      {
        hits: 1,
        misses: 0,
        entryCount: 1,
        lastBuildP99Ms: 0,
        oldestEntryAgeMs: 25 * 60 * 60 * 1000,
        staleSeconds: 5,
      },
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toMatch(/oldest entry > 24h/);
  });

  it("renders 'no data' hit-rate when no calls have happened yet", () => {
    const lines: string[] = [];
    renderPrefixCacheSection(
      {
        hits: 0,
        misses: 0,
        entryCount: 0,
        lastBuildP99Ms: 0,
        oldestEntryAgeMs: 0,
        staleSeconds: 1,
      },
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("hit-rate=no data");
  });
});

describe("renderSpawnCoordinatorSection (KPR-220 Phase 11)", () => {
  it("renders 'no heartbeat yet' when no rows are available", () => {
    const lines: string[] = [];
    renderSpawnCoordinatorSection([], (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain("Spawn coordinator (live engine, per agent)");
    expect(out).toContain("no heartbeat yet");
  });

  it("renders one line per agent with budget, source, saturation, and freshness", () => {
    const lines: string[] = [];
    renderSpawnCoordinatorSection(
      [
        {
          agentId: "agent-a",
          activeSpawns: 2,
          budget: 5,
          budgetSource: "spawnBudget",
          saturationCount: 3,
          lastSaturationAt: Date.now() - 10_000,
          lastSpawnAt: Date.now() - 1_000,
          lastError: null,
          stopped: false,
          staleSeconds: 5,
        },
      ],
      (l) => lines.push(l),
    );
    const out = lines.join("\n");
    expect(out).toContain("agent-a");
    expect(out).toContain("active=2");
    expect(out).toContain("budget=5");
    expect(out).toContain("source=spawnBudget");
    expect(out).toContain("saturations=3");
    expect(out).toContain("heartbeat 5s ago");
  });

  it("flags stopped agents distinctly (spec S8)", () => {
    const lines: string[] = [];
    renderSpawnCoordinatorSection(
      [
        {
          agentId: "agent-stop",
          activeSpawns: 0,
          budget: 5,
          budgetSource: "default",
          saturationCount: 0,
          lastSaturationAt: null,
          lastSpawnAt: null,
          lastError: null,
          stopped: true,
          staleSeconds: 1,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("STOPPED");
  });

  it("flags stale heartbeat when >120s", () => {
    const lines: string[] = [];
    renderSpawnCoordinatorSection(
      [
        {
          agentId: "agent-stale",
          activeSpawns: 0,
          budget: 5,
          budgetSource: "default",
          saturationCount: 0,
          lastSaturationAt: null,
          lastSpawnAt: null,
          lastError: null,
          stopped: false,
          staleSeconds: 300,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("stale-heartbeat");
  });

  it("renders last error on a second line when present", () => {
    const lines: string[] = [];
    renderSpawnCoordinatorSection(
      [
        {
          agentId: "agent-err",
          activeSpawns: 0,
          budget: 5,
          budgetSource: "default",
          saturationCount: 1,
          lastSaturationAt: Date.now(),
          lastSpawnAt: Date.now(),
          lastError: "something broke",
          stopped: false,
          staleSeconds: 1,
        },
      ],
      (l) => lines.push(l),
    );
    const out = lines.join("\n");
    expect(out).toContain("last error: something broke");
  });
});

describe("renderCircuitBreakerSection (KPR-306)", () => {
  function collect() {
    const lines: string[] = [];
    return { lines, emit: (l: string) => lines.push(l) };
  }
  const baseRow = {
    provider: "claude",
    state: "closed" as const,
    enabled: true,
    reason: null,
    consecutiveHardFaults: 0,
    tripCount: 0,
    lastTripAt: null,
    fastFailCount: 0,
    lastFaultMessage: null,
    p95Ms: null,
    sampleCount: 0,
    probeInFlight: false,
    openedAt: null,
    nextProbeEligibleAt: null,
    staleSeconds: 5,
  };

  it("renders 'no heartbeat yet' when no rows are available", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection([], emit);
    expect(lines[1]).toContain("no heartbeat yet");
  });

  it("renders a closed row with trips, streak, p95 and fast-fails", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection(
      [{ ...baseRow, tripCount: 2, p95Ms: 41_000, sampleCount: 37, fastFailCount: 118 }],
      emit,
    );
    expect(lines[1]).toContain("claude: state=closed trips=2 consec-faults=0 p95=41s (n=37) fast-fails=118");
    expect(lines[1]).not.toContain("[");
  });

  it("renders an open row with reason, next-probe countdown, [OPEN] flag and last-fault line", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection(
      [
        {
          ...baseRow,
          provider: "gemini",
          state: "open",
          reason: "connect-fail",
          openedAt: Date.now() - 45_000,
          nextProbeEligibleAt: Date.now() + 14_000,
          lastFaultMessage: "fetch failed: connect ECONNREFUSED",
          fastFailCount: 9,
        },
      ],
      emit,
    );
    expect(lines[1]).toContain("state=open reason=connect-fail");
    expect(lines[1]).toContain("[OPEN]");
    expect(lines[2]).toContain("last fault: fetch failed: connect ECONNREFUSED");
  });

  it("flags shadow mode and half-open state", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection(
      [{ ...baseRow, state: "half-open", reason: "auth", probeInFlight: true, enabled: false }],
      emit,
    );
    expect(lines[1]).toContain("state=half-open");
    expect(lines[1]).toContain("probe-in-flight=true");
    expect(lines[1]).toContain("[HALF-OPEN,shadow]");
  });

  it("warns on stale heartbeat (>120s) without any failure semantics", () => {
    const { lines, emit } = collect();
    renderCircuitBreakerSection([{ ...baseRow, staleSeconds: 300 }], emit);
    expect(lines[1]).toContain("stale-heartbeat");
    expect(lines[2]).toContain("⚠ heartbeat is stale");
    // Renderer returns void — structurally incapable of flipping the exit
    // code (D4): only renderDatastoreIdentitySection returns a verdict.
    expect(renderCircuitBreakerSection([], () => {})).toBeUndefined();
  });
});

describe("renderDatastoreIdentitySection (KPR-296)", () => {
  function makeIdentityReport(overrides: Partial<DatastoreIdentityReport> = {}): DatastoreIdentityReport {
    return {
      uri: "mongodb://localhost:27017",
      dbName: "hive_test",
      instanceId: "test",
      server: {
        host: "localhost:27017",
        version: "8.0.11",
        pid: 4242,
        uptimeSeconds: 266_520,
        dbPath: "/opt/homebrew/var/mongodb",
        note: null,
      },
      sentinel: {
        state: "verified",
        observed: { instanceId: "test", dbName: "hive_test", sentinelId: "abc-123" },
        schemaVersionNewer: false,
        stampedAt: new Date("2026-07-05T00:00:00Z"),
        stampedBy: "0.9.2@mokiemon",
      },
      agentDefinitionsCount: 11,
      identityStats: {
        state: "verified",
        writesRefused: false,
        refusedWriteCount: 0,
        lastVerifiedAt: new Date(),
        lastMismatchAt: null,
        observedInstanceId: "test",
        observedDbName: "hive_test",
        staleSeconds: 12,
      },
      rosterStats: {
        docCount: 11,
        activeCount: 10,
        disabledCount: 1,
        lastGoodAt: new Date("2026-07-06T04:11:00Z"),
        lastGoodSource: "reload",
        degraded: false,
        degradedSince: null,
        blockedReloadCount: 0,
        lastBlockedAt: null,
        updatedAt: new Date("2026-07-06T04:11:00Z"),
      },
      ...overrides,
    };
  }

  function render(report: DatastoreIdentityReport | null): { out: string; failed: boolean } {
    const lines: string[] = [];
    const { failed } = renderDatastoreIdentitySection(report, (l) => lines.push(l));
    return { out: lines.join("\n"), failed };
  }

  it("1. happy path: all-green factory renders success, no warnings/failures", () => {
    const { out, failed } = render(makeIdentityReport());
    expect(failed).toBe(false);
    expect(out).toContain("Datastore identity");
    expect(out).toContain("server:");
    expect(out).toContain("dbPath:");
    expect(out).toContain("target:");
    const checkmarks = out.match(/✓/g) ?? [];
    expect(checkmarks.length).toBe(3);
    expect(out).not.toContain("✗");
    expect(out).not.toContain("⚠");
  });

  it("2. I5: null report renders unreachable, does not throw", () => {
    expect(() => render(null)).not.toThrow();
    const { out, failed } = render(null);
    expect(failed).toBe(false);
    expect(out).toContain('unreachable — see "MongoDB reachable" above');
  });

  it("3. F1: sentinel mismatch hard-fails with remediation", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: {
          state: "mismatch",
          observed: { instanceId: "other", dbName: "hive_other", sentinelId: "zzz" },
          schemaVersionNewer: false,
        },
      }),
    );
    expect(failed).toBe(true);
    expect(out).toMatch(/✗ identity sentinel MISMATCH — expected test\/hive_test, observed other\/hive_other/);
    expect(out).toContain("HIVE_DB_SENTINEL_RESTAMP=1");
  });

  it("4. F2: roster guard degraded hard-fails with remediation", () => {
    const { out, failed } = render(
      makeIdentityReport({
        rosterStats: {
          docCount: 11,
          activeCount: 10,
          disabledCount: 1,
          lastGoodAt: new Date("2026-07-06T04:11:00Z"),
          lastGoodSource: "reload",
          degraded: true,
          degradedSince: new Date("2026-07-06T04:10:00Z"),
          blockedReloadCount: 4,
          lastBlockedAt: new Date("2026-07-06T04:12:00Z"),
          updatedAt: new Date("2026-07-06T04:12:00Z"),
        },
      }),
    );
    expect(failed).toBe(true);
    expect(out).toMatch(/✗ roster guard DEGRADED/);
    expect(out).toContain("SIGUSR1 after restore");
  });

  it("5. F3 (mismatch): fresh non-verified identity monitor hard-fails", () => {
    const { out, failed } = render(
      makeIdentityReport({
        identityStats: {
          state: "mismatch",
          writesRefused: true,
          refusedWriteCount: 7,
          lastVerifiedAt: null,
          lastMismatchAt: new Date(),
          observedInstanceId: "other",
          observedDbName: "hive_other",
          staleSeconds: 10,
        },
      }),
    );
    expect(failed).toBe(true);
    expect(out).toContain("engine identity monitor: mismatch");
    expect(out).toContain("refused=7");
  });

  it("6. F3 (cant_verify): hard-fails", () => {
    const { out, failed } = render(
      makeIdentityReport({
        identityStats: {
          state: "cant_verify",
          writesRefused: true,
          refusedWriteCount: 2,
          lastVerifiedAt: null,
          lastMismatchAt: null,
          observedInstanceId: null,
          observedDbName: null,
          staleSeconds: 10,
        },
      }),
    );
    expect(failed).toBe(true);
    expect(out).toContain("engine identity monitor: cant_verify");
  });

  it("7. F3 (unknown future state, edge #12): fail-closed", () => {
    const { out, failed } = render(
      makeIdentityReport({
        identityStats: {
          state: "quarantined",
          writesRefused: false,
          refusedWriteCount: 0,
          lastVerifiedAt: null,
          lastMismatchAt: null,
          observedInstanceId: "test",
          observedDbName: "hive_test",
          staleSeconds: 5,
        },
      }),
    );
    expect(failed).toBe(true);
    expect(out).toContain("engine identity monitor: quarantined");
  });

  it("8. F3 requires freshness: stale non-verified warns instead of failing", () => {
    const { out, failed } = render(
      makeIdentityReport({
        identityStats: {
          state: "mismatch",
          writesRefused: true,
          refusedWriteCount: 3,
          lastVerifiedAt: null,
          lastMismatchAt: new Date(),
          observedInstanceId: "other",
          observedDbName: "hive_other",
          staleSeconds: 300,
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("heartbeat is stale (300s)");
    expect(out).toContain("last state: mismatch");
  });

  it("9. W6 on verified-but-stale: warns, does not fail", () => {
    const staleVerified = render(
      makeIdentityReport({
        identityStats: {
          state: "verified",
          writesRefused: false,
          refusedWriteCount: 0,
          lastVerifiedAt: new Date(),
          lastMismatchAt: null,
          observedInstanceId: "test",
          observedDbName: "hive_test",
          staleSeconds: 300,
        },
      }),
    );
    expect(staleVerified.failed).toBe(false);
    expect(staleVerified.out).toContain("heartbeat is stale (300s)");

    const nullStale = render(
      makeIdentityReport({
        identityStats: {
          state: "verified",
          writesRefused: false,
          refusedWriteCount: 0,
          lastVerifiedAt: new Date(),
          lastMismatchAt: null,
          observedInstanceId: "test",
          observedDbName: "hive_test",
          staleSeconds: null,
        },
      }),
    );
    expect(nullStale.failed).toBe(false);
    expect(nullStale.out).toContain("heartbeat is stale");
  });

  it("10. W1: sentinel absent with existing hive data warns, does not fail", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: { state: "absent" },
        agentDefinitionsCount: 11,
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("sentinel absent but DB has hive data (11 agent defs)");
    expect(out).toContain("HAS booted");
  });

  it("11. I1: sentinel absent with empty DB is pre-first-boot info, no warn", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: { state: "absent" },
        agentDefinitionsCount: 0,
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("○ identity sentinel absent, DB empty");
    // No sentinel-related warning line should be present.
    expect(out).not.toMatch(/⚠ identity sentinel/);
  });

  it("12. sentinel absent + null agent count warns cannot-confirm", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: { state: "absent" },
        agentDefinitionsCount: null,
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("cannot confirm pre-first-boot");
  });

  it("13. W2: verified with newer schemaVersion warns; also alongside F1 mismatch", () => {
    const verifiedNewer = render(
      makeIdentityReport({
        sentinel: {
          state: "verified",
          observed: { instanceId: "test", dbName: "hive_test", sentinelId: "abc-123" },
          schemaVersionNewer: true,
          stampedAt: null,
          stampedBy: null,
        },
      }),
    );
    expect(verifiedNewer.failed).toBe(false);
    expect(verifiedNewer.out).toContain("schemaVersion is newer");

    const mismatchNewer = render(
      makeIdentityReport({
        sentinel: {
          state: "mismatch",
          observed: { instanceId: "other", dbName: "hive_other", sentinelId: "zzz" },
          schemaVersionNewer: true,
        },
      }),
    );
    expect(mismatchNewer.failed).toBe(true);
    expect(mismatchNewer.out).toContain("schemaVersion is newer");
  });

  it("14. W3: temp dbPath warns with impostor signature; alias, null, and non-temp paths behave", () => {
    const tmp = render(
      makeIdentityReport({
        server: {
          host: "localhost:27017",
          version: "8.0.11",
          pid: 1,
          uptimeSeconds: 10,
          dbPath: "/tmp/mongo-8DqT",
          note: null,
        },
      }),
    );
    expect(tmp.out).toContain("TEMP directory");
    expect(tmp.out).toContain("Jul-4 impostor signature");

    const privateTmpAlias = render(
      makeIdentityReport({
        server: {
          host: "localhost:27017",
          version: "8.0.11",
          pid: 1,
          uptimeSeconds: 10,
          dbPath: "/private/tmp/x",
          note: null,
        },
      }),
    );
    expect(privateTmpAlias.out).toContain("TEMP directory");

    const nullPath = render(
      makeIdentityReport({
        server: {
          host: "localhost:27017",
          version: "8.0.11",
          pid: 1,
          uptimeSeconds: 10,
          dbPath: null,
          note: null,
        },
      }),
    );
    expect(nullPath.out).toContain("(default)");
    expect(nullPath.out).not.toContain("TEMP directory");

    const happy = render(makeIdentityReport());
    expect(happy.out).not.toContain("TEMP directory");
  });

  it("15. I4: server all-null with note omits server line, no failure", () => {
    const { out, failed } = render(
      makeIdentityReport({
        server: {
          host: null,
          version: null,
          pid: null,
          uptimeSeconds: null,
          dbPath: null,
          note: "serverStatus failed: not authorized",
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("○ server fingerprint unavailable — serverStatus failed: not authorized");
    expect(out).not.toContain("server:");
  });

  it("16. W4 (edge #14): validation evicted every agent warns, does not fail", () => {
    const { out, failed } = render(
      makeIdentityReport({
        agentDefinitionsCount: 5,
        rosterStats: {
          docCount: 5,
          activeCount: 0,
          disabledCount: 2,
          lastGoodAt: new Date("2026-07-06T04:11:00Z"),
          lastGoodSource: "reload",
          degraded: false,
          degradedSince: null,
          blockedReloadCount: 0,
          lastBlockedAt: null,
          updatedAt: new Date("2026-07-06T04:11:00Z"),
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("validation evicted every agent");
  });

  it("17. I3: all-disabled is recorded operator state, no W4 warn", () => {
    const { out, failed } = render(
      makeIdentityReport({
        agentDefinitionsCount: 5,
        rosterStats: {
          docCount: 5,
          activeCount: 0,
          disabledCount: 5,
          lastGoodAt: new Date("2026-07-06T04:11:00Z"),
          lastGoodSource: "reload",
          degraded: false,
          degradedSince: null,
          blockedReloadCount: 0,
          lastBlockedAt: null,
          updatedAt: new Date("2026-07-06T04:11:00Z"),
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("○ all 5 agents disabled (recorded operator state)");
    expect(out).not.toContain("validation evicted every agent");
  });

  it("18. W5: any delta between live count and last-good roster warns divergence", () => {
    const { out, failed } = render(
      makeIdentityReport({
        agentDefinitionsCount: 11,
        rosterStats: {
          docCount: 8,
          activeCount: 8,
          disabledCount: 0,
          lastGoodAt: new Date("2026-07-06T04:11:00Z"),
          lastGoodSource: "reload",
          degraded: false,
          degradedSince: null,
          blockedReloadCount: 0,
          lastBlockedAt: null,
          updatedAt: new Date("2026-07-06T04:11:00Z"),
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("roster divergence: DB has 11 agent defs, engine last committed 8");
    expect(out).toContain("SIGUSR1");
  });

  it("19. W5 (edge #15 shape): all-zero roster with live agents still warns divergence, not W4", () => {
    const { out, failed } = render(
      makeIdentityReport({
        agentDefinitionsCount: 11,
        rosterStats: {
          docCount: 0,
          activeCount: 0,
          disabledCount: 0,
          lastGoodAt: null,
          lastGoodSource: null,
          degraded: false,
          degradedSince: null,
          blockedReloadCount: 0,
          lastBlockedAt: null,
          updatedAt: null,
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("roster divergence: DB has 11 agent defs, engine last committed 0");
    expect(out).not.toContain("validation evicted every agent");
  });

  it("20. E3 pin: ancient roster updatedAt never produces a staleness warning", () => {
    const { out, failed } = render(
      makeIdentityReport({
        rosterStats: {
          docCount: 11,
          activeCount: 10,
          disabledCount: 1,
          lastGoodAt: new Date("2026-07-06T04:11:00Z"),
          lastGoodSource: "reload",
          degraded: false,
          degradedSince: null,
          blockedReloadCount: 0,
          lastBlockedAt: null,
          updatedAt: new Date("2026-05-01T00:00:00Z"),
        },
      }),
    );
    expect(failed).toBe(false);
    expect(out).not.toContain("⚠");
  });

  it("21. I2: missing telemetry docs render info lines, cross-check hint when sentinel also absent", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: { state: "absent" },
        agentDefinitionsCount: 0,
        identityStats: null,
        rosterStats: null,
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("○ no db_identity_stats telemetry yet");
    expect(out).toContain("○ no agent_roster_stats telemetry yet");
    expect(out).toContain("cross-check the sentinel result above");
  });

  it("22. sentinel read error (edge #5) warns, does not fail", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: { state: "error", message: "boom" },
      }),
    );
    expect(failed).toBe(false);
    expect(out).toContain("⚠ sentinel read failed: boom");
  });

  it("23. composite incident shape (spec edge #1): caught even when sentinel sees only absent+empty", () => {
    const { out, failed } = render(
      makeIdentityReport({
        sentinel: { state: "absent" },
        agentDefinitionsCount: 0,
        server: {
          host: "localhost:27017",
          version: "8.0.11",
          pid: 1,
          uptimeSeconds: 10,
          dbPath: "/tmp/x",
          note: null,
        },
        identityStats: {
          state: "mismatch",
          writesRefused: true,
          refusedWriteCount: 3,
          lastVerifiedAt: null,
          lastMismatchAt: new Date(),
          observedInstanceId: "impostor",
          observedDbName: "impostor_db",
          staleSeconds: 5,
        },
      }),
    );
    expect(failed).toBe(true);
    expect(out).toContain("TEMP directory");
    expect(out).toContain("○ identity sentinel absent, DB empty");
    expect(out).toContain("engine identity monitor: mismatch");
  });
});
