import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmissionSnapshot } from "../voice-worker/admission.js";
import type { MaintenanceReply } from "../voice-worker/maintenance-ipc.js";
import type { BootIdentity, Release } from "./release.js";
import {
  bootIdentityIsCurrent,
  boundedHealthWindows,
  freshAdmissionStatus,
  freshOrderedEngineMarkers,
  packagedHeartbeatFresh,
  packagedHealthy,
  parseBootIdentity,
  pilotRecovered,
  readEngineMarkersAfter,
  type PackagedEvidence,
  type PilotRecoveryEvidence,
} from "./health.js";
import {
  assertRuntimeProbeEnvironment,
  classifyWorkerHeartbeatDocument,
  probeBridge,
  probeOutboundSetup,
  probeWorkerHttp,
  runtimeProbeErrorResult,
  workerHttpRegistered,
} from "./runtime-probe.js";

const RELEASE: Release = {
  schemaVersion: 1,
  packageVersion: "1.2.3",
  sourceRevision: "a".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: "b".repeat(64),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};
const WORKER: BootIdentity = {
  release: RELEASE,
  component: "voice-worker",
  pid: 8123,
  bootId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-09-09T12:00:00.000Z",
};
const ENGINE: BootIdentity = {
  ...WORKER,
  component: "engine",
  pid: 8122,
  bootId: "22222222-2222-4222-8222-222222222222",
};
const SNAPSHOT: AdmissionSnapshot = {
  supervisor: { pid: WORKER.pid, bootId: WORKER.bootId },
  admission: "open",
  operationId: null,
  persistenceFault: false,
  unresolved: [],
  childPids: [],
};

function healthy(overrides: Partial<PackagedEvidence> = {}): PackagedEvidence {
  return {
    installed: RELEASE,
    engine: ENGINE,
    worker: WORKER,
    voiceEnabled: true,
    processPathsMatch: true,
    configSelectorsMatch: true,
    freshOrderedEngineMarkers: true,
    engineAlive: true,
    workerAlive: true,
    heartbeatFresh: true,
    heartbeatMatchesSupervisor: true,
    admissionSnapshot: SNAPSHOT,
    admissionFresh: true,
    sdkRootStatus: 200,
    sdkAgentName: "hive-voice",
    sdkSocketOwned: true,
    bridgeAuthenticated: true,
    bridgeMissingDenied: true,
    bridgeWrongDenied: true,
    dependenciesContained: true,
    ...overrides,
  };
}

describe("packagedHealthy", () => {
  it("accepts fresh corroborated open admission without requiring zero active jobs", () => {
    expect(packagedHealthy(healthy())).toBe(true);
  });

  it.each([
    [
      "persistence-faulted closed gate",
      { admissionSnapshot: { ...SNAPSHOT, admission: "closed", persistenceFault: true } },
    ],
    [
      "maintenance-owned closed gate",
      {
        admissionSnapshot: {
          ...SNAPSHOT,
          admission: "closed",
          operationId: "33333333-3333-4333-8333-333333333333",
        },
      },
    ],
    ["missing admission evidence", { admissionSnapshot: null }],
    ["stale admission evidence", { admissionFresh: false }],
    ["wrong supervisor PID", { admissionSnapshot: { ...SNAPSHOT, supervisor: { ...SNAPSHOT.supervisor, pid: 9999 } } }],
    [
      "wrong supervisor boot",
      {
        admissionSnapshot: {
          ...SNAPSHOT,
          supervisor: { ...SNAPSHOT.supervisor, bootId: "44444444-4444-4444-8444-444444444444" },
        },
      },
    ],
    ["foreign SDK listener", { sdkSocketOwned: false }],
    ["SDK reports 503 despite worker info", { sdkRootStatus: 503 }],
    ["wrong installed revision", { installed: { ...RELEASE, sourceRevision: "c".repeat(40) } }],
  ])("rejects %s", (_name, override) => {
    expect(packagedHealthy(healthy(override as Partial<PackagedEvidence>))).toBe(false);
  });

  it("does not require worker evidence when voice is disabled", () => {
    expect(
      packagedHealthy(
        healthy({
          voiceEnabled: false,
          worker: null,
          workerAlive: false,
          heartbeatFresh: false,
          heartbeatMatchesSupervisor: false,
          admissionSnapshot: null,
          admissionFresh: false,
          sdkRootStatus: null,
          sdkAgentName: null,
          sdkSocketOwned: false,
          bridgeAuthenticated: false,
          bridgeMissingDenied: false,
          bridgeWrongDenied: false,
        }),
      ),
    ).toBe(true);
  });
});

describe("fresh evidence validation", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects stale prior logs, wrong PID/boot and truncated reads", () => {
    const now = Date.parse("2026-09-09T12:01:00.000Z");
    const records = [
      { message: "Hive starting up", pid: ENGINE.pid, bootId: ENGINE.bootId, timestamp: now - 1_000 },
      { message: "Hive is running", pid: ENGINE.pid, bootId: ENGINE.bootId, timestamp: now },
    ];
    expect(freshOrderedEngineMarkers(records, ENGINE, now - 2_000, now)).toBe(true);
    expect(freshOrderedEngineMarkers(records, ENGINE, now + 1, now)).toBe(false);
    expect(freshOrderedEngineMarkers(records, { ...ENGINE, pid: 7 }, now - 2_000, now)).toBe(false);
    expect(freshOrderedEngineMarkers(records, { ...ENGINE, bootId: WORKER.bootId }, now - 2_000, now)).toBe(false);
    expect(freshOrderedEngineMarkers(records, ENGINE, now - 2_000, now, true)).toBe(false);
  });

  it("reads only post-bootstrap log bytes and treats truncation or malformed records as uncertainty", () => {
    const root = mkdtempSync(join(tmpdir(), "health-log-"));
    roots.push(root);
    const log = join(root, "hive.log");
    writeFileSync(
      log,
      `${JSON.stringify({ msg: "Hive is running", pid: 1, bootId: "old", ts: "2026-01-01T00:00:00Z" })}\n`,
    );
    const offset = statSync(log).size;
    appendFileSync(
      log,
      [
        { msg: "Hive starting up", pid: ENGINE.pid, bootId: ENGINE.bootId, ts: "2026-09-09T12:00:00Z" },
        { msg: "Hive is running", pid: ENGINE.pid, bootId: ENGINE.bootId, ts: "2026-09-09T12:00:01Z" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const read = readEngineMarkersAfter(log, offset);
    expect(read.truncatedOrMalformed).toBe(false);
    expect(read.records.map((record) => record.message)).toEqual(["Hive starting up", "Hive is running"]);
    truncateSync(log, offset - 1);
    expect(readEngineMarkersAfter(log, offset).truncatedOrMalformed).toBe(true);
  });

  it("requires current PID/start time and rejects future identities", () => {
    const now = Date.parse("2026-09-09T12:00:02.000Z");
    expect(
      bootIdentityIsCurrent(WORKER, { pid: WORKER.pid, startTime: WORKER.startedAt }, "voice-worker", now - 3_000, now),
    ).toBe(true);
    expect(
      bootIdentityIsCurrent(WORKER, { pid: WORKER.pid, startTime: "different" }, "voice-worker", now - 3_000, now),
    ).toBe(false);
    expect(
      bootIdentityIsCurrent(
        { ...WORKER, startedAt: "2026-09-09T12:00:10.000Z" },
        { pid: WORKER.pid, startTime: "2026-09-09T12:00:10.000Z" },
        "voice-worker",
        now - 3_000,
        now,
      ),
    ).toBe(false);
  });

  it("rejects missing, malformed, legacy and future packaged heartbeat identity", () => {
    const now = Date.parse("2026-09-09T12:00:20.000Z");
    expect(packagedHeartbeatFresh(WORKER, WORKER, now - 1_000, now - 2_000, now)).toBe(true);
    expect(packagedHeartbeatFresh(null, WORKER, now - 1_000, now - 2_000, now)).toBe(false);
    expect(packagedHeartbeatFresh(WORKER, WORKER, now + 6_000, now - 2_000, now)).toBe(false);
    expect(() => parseBootIdentity({ ...WORKER, bootId: "bad" })).toThrow("invalid runtime boot identity");
    const legacy = {
      ...WORKER,
      release: {
        classification: "source/unavailable" as const,
        packageVersion: null,
        sourceRevision: null,
        sourceDirty: null,
        dependencyLockSha256: null,
      },
    };
    expect(packagedHeartbeatFresh(legacy, WORKER, now - 1_000, now - 2_000, now)).toBe(false);
    expect(packagedHealthy(healthy({ worker: legacy }))).toBe(false);
  });

  it("requires a fresh correlated successful mailbox status and live corroboration", () => {
    const requestedAt = 1_000;
    const reply: MaintenanceReply = {
      protocol: 1,
      requestId: "55555555-5555-4555-8555-555555555555",
      operationId: "66666666-6666-4666-8666-666666666666",
      supervisor: SNAPSHOT.supervisor,
      ok: true,
      snapshot: SNAPSHOT,
      writtenAt: 1_001,
    };
    const context = {
      reply,
      requestId: reply.requestId,
      operationId: reply.operationId,
      requestedAt,
      expectedSupervisor: SNAPSHOT.supervisor,
      processCorroborated: true,
      now: 1_010,
    };
    expect(freshAdmissionStatus(context)).toBe(true);
    expect(freshAdmissionStatus({ ...context, requestId: "77777777-7777-4777-8777-777777777777" })).toBe(false);
    expect(freshAdmissionStatus({ ...context, requestedAt: 1_002 })).toBe(false);
    expect(freshAdmissionStatus({ ...context, processCorroborated: false })).toBe(false);
  });
});

describe("runtime probe evidence", () => {
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("sends three empty no-turn bridge requests and recognizes only the exact success error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(400, { error: "call.metadata.hive_agent_id required" }))
      .mockResolvedValueOnce(response(401, { error: "Unauthorized" }))
      .mockResolvedValueOnce(response(401, { error: "Unauthorized" }));
    const result = await probeBridge("http://127.0.0.1:3000/v1/chat/completions", "secret", fetcher, () => "wrong");
    expect(result).toMatchObject({ authenticated: true, missingDenied: true, wrongDenied: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.body).toBe("{}");
      expect(String(init?.body)).not.toContain("messages");
      expect(String(init?.body)).not.toContain("hive_agent_id");
    }
  });

  it("requires exact shared service environment before any config import", () => {
    const environment = {
      HIVE_HOME: "/fixture/hive",
      HIVE_CONFIG: "/fixture/hive/hive-alt.yaml",
      HOME: "/fixture/home",
      PATH: "/usr/bin:/bin",
      VOICE_PORT: "4111",
    };
    expect(assertRuntimeProbeEnvironment(environment)).toEqual(environment);
    expect(() => assertRuntimeProbeEnvironment({ ...environment, LIVEKIT_API_SECRET: "secret" })).toThrow(
      "runtime probe environment differs from service environment",
    );
  });

  it("reports missing secret names without returning values or arbitrary errors", () => {
    expect(runtimeProbeErrorResult(new Error("voice worker missing required config: livekitApiSecret"))).toEqual({
      ok: false,
      classification: "missing-required-key",
      missingSecretNames: ["LIVEKIT_API_SECRET"],
    });
    expect(JSON.stringify(runtimeProbeErrorResult(new Error("provider replied with secret-value")))).not.toContain(
      "secret-value",
    );
  });

  it.each([
    ["valid token denied", [401, { error: "Unauthorized" }]],
    ["arbitrary 400", [400, { error: "different" }]],
  ])("fails authentication for %s", async (_name, correct) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(correct[0] as number, correct[1]))
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(response(401, {}));
    expect((await probeBridge("http://127.0.0.1:1/", "secret", fetcher, () => "wrong")).authenticated).toBe(false);
  });

  it("requires known active-job telemetry in addition to root and worker endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { message: "OK" }))
      .mockResolvedValueOnce(response(200, { agent_name: "hive-voice" }));
    const evidence = await probeWorkerHttp(3107, fetcher);
    expect(evidence.activeJobs).toBeNull();
    expect(workerHttpRegistered(evidence)).toBe(false);
  });

  it("classifies missing, malformed, stale and future worker heartbeat documents", () => {
    const now = Date.parse("2026-09-09T12:01:00Z");
    expect(classifyWorkerHeartbeatDocument(null, now).fresh).toBe(false);
    expect(classifyWorkerHeartbeatDocument({ supervisorIdentity: { pid: 1 } }, now).fresh).toBe(false);
    expect(
      classifyWorkerHeartbeatDocument({ supervisorIdentity: WORKER, supervisorUpdatedAt: new Date(now - 61_000) }, now)
        .fresh,
    ).toBe(false);
    expect(
      classifyWorkerHeartbeatDocument({ supervisorIdentity: WORKER, supervisorUpdatedAt: new Date(now + 6_000) }, now)
        .fresh,
    ).toBe(false);
    expect(
      classifyWorkerHeartbeatDocument({ supervisorIdentity: WORKER, supervisorUpdatedAt: new Date(now - 10_000) }, now)
        .fresh,
    ).toBe(true);
  });

  it("uses only the injected read-only outbound listing boundary", async () => {
    const list = vi
      .fn()
      .mockResolvedValue([{ sipTrunkId: "ST_expected", numbers: ["+15555550123"], address: "trunk.example.test" }]);
    await expect(
      probeOutboundSetup(
        {
          sipTrunkId: "ST_expected",
          twilioNumber: "+15555550123",
          twilioTrunkDomain: "sip:trunk.example.test/",
        },
        list,
      ),
    ).resolves.toMatchObject({ ok: true, trunkExists: true, numberMatches: true, domainMatches: true });
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("pilotRecovered", () => {
  const good: PilotRecoveryEvidence = {
    engineLiveIdentityMatches: true,
    workerLiveIdentityMatches: true,
    effectiveArgumentsMatch: true,
    workingDirectoryMatches: true,
    configSelectorsMatch: true,
    executableHashesMatch: true,
    dependencyPathsAndVersionsMatch: true,
    freshOrderedEngineMarkers: true,
    bridgeAuthenticated: true,
    bridgeMissingDenied: true,
    bridgeWrongDenied: true,
    sdkRootStatus: 200,
    sdkAgentName: "hive-voice",
    sdkSocketOwned: true,
    registrationFresh: true,
    manifestIdentity: "legacy/unavailable",
    releaseBootIdentity: "legacy/unavailable",
    supervisorIdentity: "legacy/unavailable",
  };

  it("accepts the separate captured legacy profile", () => expect(pilotRecovered(good)).toBe(true));
  it("rejects missing legacy-only evidence", () =>
    expect(pilotRecovered({ ...good, registrationFresh: false })).toBe(false));
  it("cannot label legacy recovery as packaged", () =>
    expect(pilotRecovered({ ...good, manifestIdentity: "packaged" as never })).toBe(false));
});

describe("boundedHealthWindows", () => {
  it("uses three independent windows with two bounded gaps", async () => {
    let now = 100;
    const deadlines: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const result = await boundedHealthWindows(
      async (deadline) => {
        deadlines.push(deadline);
        return null;
      },
      { now: () => now, sleep },
    );
    expect(result).toBeNull();
    expect(deadlines).toEqual([30_100, 40_100, 50_100]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
