import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const commands: { command: string; args: readonly string[] }[] = [];
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      command: string,
      args: readonly string[],
      _options: unknown,
      callback: (...values: unknown[]) => void,
    ) => {
      commands.push({ command, args });
      if (command === "which") return callback(null, { stdout: `${process.execPath}\n`, stderr: "" });
      return callback(Object.assign(new Error(`unexpected host command in unit test: ${command}`), { code: 1 }));
    },
  };
});

import { activate, DeferredMaintenance } from "./transaction.js";
import { acquireOperation, finishOperationLock } from "./operation.js";
import { pilotRecovered } from "./health.js";
import { runNodeLifecycle } from "./lifecycle.js";
import {
  assemblePilotRecoveryEvidence,
  assessLegacyHoldRoute,
  assessPilotRecoveryRoute,
  captureLogFence,
  freshFencedSequence,
  LEGACY_HOLD_GAP_CODES,
  MigrationPendingError,
  pilotRollbackTransaction,
  readFencedMarkers,
  stopPilotWorkerUnderHold,
  unavailablePilotEvidence,
  type PilotEvidenceProvider,
  type PilotRecoveryObservations,
  type RegisteredPilot,
} from "./pilot-lifecycle.js";
import {
  buildServiceDefinitions,
  buildServiceEnvironment,
  type ServiceInspection,
  type ServiceSnapshot,
} from "./services.js";

const roots: string[] = [];
afterEach(() => {
  commands.splice(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const instance = {
  canonicalHome: "/Users/example/services/hive/dodi",
  configPath: "/Users/example/services/hive/dodi/hive.yaml",
  instanceId: "dodi",
  uid: 501,
};
const pair = buildServiceDefinitions({
  instanceId: "dodi",
  nodePath: "/opt/node/bin/node",
  hiveHome: instance.canonicalHome,
  configPath: instance.configPath,
  home: "/Users/example",
  pathEnv: "/usr/bin:/bin",
});

function inspection(
  definition: typeof pair.engine,
  pid: number,
  entry = definition.entrypoint,
  start = `start-${pid}`,
): ServiceInspection {
  const args = [definition.nodePath, entry, ...definition.args];
  return {
    label: definition.label,
    loaded: true,
    enabled: true,
    livePID: pid,
    startTime: start,
    args,
    cwd: definition.hiveHome,
    configSelection: definition.configPath,
    serviceEnvironment: buildServiceEnvironment(definition),
    plist: null,
    link: null,
    process: {
      pid,
      ppid: 1,
      startTime: start,
      command: args.join(" "),
      executable: definition.nodePath,
      cwd: definition.hiveHome,
    },
  };
}

const PILOT_ENGINE = "/Users/example/github/kpr-320-live-call/pkg/server.min.js";
const PILOT_WORKER = "/Users/example/github/kpr-320-live-call/dist/voice-worker/main.js";

function pilotServices(): ServiceSnapshot {
  return {
    services: [
      [pair.engine, 100, PILOT_ENGINE],
      [pair.worker, 101, PILOT_WORKER],
    ].map(([definition, pid, entry]) => {
      const d = definition as typeof pair.engine;
      return {
        definition: d,
        inspection: inspection(d, pid as number, entry as string),
        plist: {
          path: `/Users/example/github/kpr-320-live-call/${d.label}.plist`,
          existed: true,
          bytes: Buffer.from("p"),
          mode: 0o644,
        },
        instancePlist: { path: `${instance.canonicalHome}/service/${d.label}.plist`, existed: false },
        link: {
          path: `/Users/example/Library/LaunchAgents/${d.label}.plist`,
          existed: true,
          target: `/Users/example/github/kpr-320-live-call/${d.label}.plist`,
        },
        loaded: true,
        enabled: true,
      };
    }),
  };
}

function registered(overrides: Partial<RegisteredPilot> = {}): RegisteredPilot {
  return {
    selector: "/Users/example/services/hive/dodi/.hive-state/deployment/registry/u/payload.json",
    sha256: "a".repeat(64),
    bootstrap: {
      selector: "/Users/example/services/hive/dodi/.hive-state/deployment/registry/b/payload.json",
      sha256: "b".repeat(64),
    },
    instance,
    services: pilotServices(),
    capturedPilotProfile: [],
    sdkListenerPort: 8081,
    generation: { engine: { pid: 100, startTime: "start-100" }, worker: { pid: 101, startTime: "start-101" } },
    ...overrides,
  };
}

function provider(
  overrides: Partial<PilotEvidenceProvider> = {},
): PilotEvidenceProvider & Record<string, ReturnType<typeof vi.fn>> {
  return {
    selectRegisteredSnapshot: vi.fn(async () => registered()),
    selectHoldSnapshot: vi.fn(async () => registered()),
    verifyRecoveryPrerequisites: vi.fn(async () => {}),
    assessHoldCapability: vi.fn(async () => ({ kind: "native-capable" as const })),
    establishHold: vi.fn(async () => {
      throw new Error("not used");
    }),
    resolveMigrationLineage: vi.fn(async () => null),
    observePilotRecovery: vi.fn(async () => {
      throw new Error("not used");
    }),
    ...overrides,
  } as PilotEvidenceProvider & Record<string, ReturnType<typeof vi.fn>>;
}

describe("pilot route assessment", () => {
  it("without the evidence registry, a legacy hold is the executed MIGRATION_PENDING result", async () => {
    const error = await assessLegacyHoldRoute({
      holdSelector: "/x/hold.json",
      instance,
      provider: unavailablePilotEvidence,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MigrationPendingError);
    expect((error as MigrationPendingError).gaps).toEqual([
      "PILOT_EVIDENCE_REGISTRY_UNAVAILABLE",
      ...LEGACY_HOLD_GAP_CODES,
    ]);
  });

  it("an uninstrumented pilot defers with concrete gaps and never establishes a hold", async () => {
    const p = provider({
      assessHoldCapability: vi.fn(async () => ({
        kind: "unavailable" as const,
        gaps: [...LEGACY_HOLD_GAP_CODES],
        holdRecordPath: "/r/hold/payload.json",
      })),
    });
    const error = await assessLegacyHoldRoute({ holdSelector: "/x/hold.json", instance, provider: p }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ code: "MIGRATION_PENDING", holdRecordPath: "/r/hold/payload.json" });
    expect(p.verifyRecoveryPrerequisites).toHaveBeenCalledOnce();
    expect(p.establishHold).not.toHaveBeenCalled();
  });

  it("rejects a snapshot from another instance or config selector", async () => {
    const p = provider({
      selectHoldSnapshot: vi.fn(async () => registered({ instance: { ...instance, configPath: "/other.yaml" } })),
    });
    await expect(assessLegacyHoldRoute({ holdSelector: "/x", instance, provider: p })).rejects.toThrow(
      "another instance",
    );
    expect(p.assessHoldCapability).not.toHaveBeenCalled();
  });

  it("returns the verified snapshot only for independently corroborated native capability", async () => {
    const p = provider();
    await expect(assessLegacyHoldRoute({ holdSelector: "/x", instance, provider: p })).resolves.toMatchObject({
      sdkListenerPort: 8081,
    });
  });

  it("pilot recovery requires durable first-migration lineage and the same candidate in .hive", async () => {
    const candidate = {
      identity: { device: 1, inode: 2 },
      release: { packageVersion: "1.0.0", sourceRevision: "c".repeat(40), dependencyLockSha256: "d".repeat(64) },
    };
    await expect(
      assessPilotRecoveryRoute({ snapshotSelector: "/s", instance, provider: provider(), currentCandidate: candidate }),
    ).rejects.toThrow("PILOT_RECOVERY_LINEAGE_MISSING");
    const lineage = {
      migrationOperationId: "op",
      candidateArchiveSha256: "e".repeat(64),
      candidateRelease: candidate.release,
      candidateCurrent: candidate.identity,
    };
    const p = provider({ resolveMigrationLineage: vi.fn(async () => lineage) });
    await expect(
      assessPilotRecoveryRoute({
        snapshotSelector: "/s",
        instance,
        provider: p,
        currentCandidate: { ...candidate, identity: { device: 1, inode: 3 } },
      }),
    ).rejects.toThrow("PILOT_RECOVERY_CANDIDATE_MISMATCH");
    expect(p.verifyRecoveryPrerequisites).not.toHaveBeenCalled();
    await expect(
      assessPilotRecoveryRoute({ snapshotSelector: "/s", instance, provider: p, currentCandidate: candidate }),
    ).resolves.toMatchObject({ lineage });
    await expect(
      assessPilotRecoveryRoute({
        snapshotSelector: "/s",
        instance,
        provider: unavailablePilotEvidence,
        currentCandidate: candidate,
      }),
    ).rejects.toBeInstanceOf(MigrationPendingError);
  });
});

describe("fenced legacy logs", () => {
  function logFile(): string {
    const root = mkdtempSync(join(tmpdir(), "pilot-log-"));
    roots.push(root);
    const path = join(root, "hive.log");
    writeFileSync(path, `${JSON.stringify({ msg: "Hive is running", ts: "2026-09-14T09:00:00Z" })}\n`);
    return path;
  }
  const line = (msg: string, ts: string, pid?: number) => `${JSON.stringify({ msg, ts, ...(pid ? { pid } : {}) })}\n`;

  it("reads only appended bytes and treats rotation or truncation as uncertainty", () => {
    const path = logFile();
    const fence = captureLogFence(path);
    appendFileSync(
      path,
      line("Hive starting up", "2026-09-14T10:00:01Z", 900) + line("Hive is running", "2026-09-14T10:00:02Z", 900),
    );
    const read = readFencedMarkers(fence);
    expect(read.records.map((record) => record.message)).toEqual(["Hive starting up", "Hive is running"]);
    const expected = {
      pid: 900,
      notBefore: Date.parse("2026-09-14T10:00:00Z"),
      now: Date.parse("2026-09-14T10:01:00Z"),
      exclusiveWriter: false,
    };
    expect(freshFencedSequence(read, expected, ["Hive starting up", "Hive is running"])).toBe(true);
    truncateSync(path, fence.offset - 1);
    expect(readFencedMarkers(fence).uncertain).toBe(true);
    renameSync(path, `${path}.1`);
    writeFileSync(path, line("Hive starting up", "2026-09-14T10:00:01Z", 900));
    expect(readFencedMarkers(fence).uncertain).toBe(true);
  });

  it("attributes PID-less legacy lines only with exclusive-writer corroboration and rejects foreign writers", () => {
    const path = logFile();
    const fence = captureLogFence(path);
    appendFileSync(
      path,
      line("Hive starting up", "2026-09-14T10:00:01Z") + line("Hive is running", "2026-09-14T10:00:02Z"),
    );
    const expected = {
      pid: 900,
      notBefore: Date.parse("2026-09-14T10:00:00Z"),
      now: Date.parse("2026-09-14T10:01:00Z"),
      exclusiveWriter: false,
    };
    const sequence = ["Hive starting up", "Hive is running"];
    expect(freshFencedSequence(readFencedMarkers(fence), expected, sequence)).toBe(false);
    expect(freshFencedSequence(readFencedMarkers(fence), { ...expected, exclusiveWriter: true }, sequence)).toBe(true);
    appendFileSync(path, line("registered worker", "2026-09-14T10:00:03Z", 777));
    expect(freshFencedSequence(readFencedMarkers(fence), { ...expected, exclusiveWriter: true }, sequence)).toBe(false);
    // Stale pre-fence lines never count, even with offset zero data present.
    expect(
      freshFencedSequence(
        readFencedMarkers(fence),
        { ...expected, notBefore: Date.parse("2026-09-14T11:00:00Z"), exclusiveWriter: true },
        sequence,
      ),
    ).toBe(false);
  });
});

describe("pilot recovery evidence", () => {
  const captured = {
    engine: inspection(pair.engine, 100, PILOT_ENGINE),
    worker: inspection(pair.worker, 101, PILOT_WORKER),
  };
  const markers = (pid: number, messages: string[]) => ({
    uncertain: false,
    records: messages.map((message, index) => ({ message, pid, timestamp: 2_000 + index })),
  });
  function observations(overrides: Partial<PilotRecoveryObservations> = {}): PilotRecoveryObservations {
    return {
      captured,
      live: {
        engine: inspection(pair.engine, 200, PILOT_ENGINE, new Date(1_500).toString()),
        worker: inspection(pair.worker, 201, PILOT_WORKER, new Date(1_500).toString()),
      },
      stopped: { engine: { pid: 100, startTime: "start-100" }, worker: { pid: 101, startTime: "start-101" } },
      activationStartedAt: 1_000,
      now: 10_000,
      executableHashesMatch: true,
      dependencyPathsAndVersionsMatch: true,
      engineLog: markers(200, ["Hive starting up", "Hive is running"]),
      workerLog: markers(201, ["registered worker"]),
      engineExclusiveWriter: false,
      workerExclusiveWriter: false,
      bridge: { authenticated: true, missingDenied: true, wrongDenied: true },
      sdk: { rootStatus: 200, agentName: "hive-voice" },
      sdkSocketOwner: 201,
      ...overrides,
    };
  }

  it("passes only with every current observation and keeps new identity fields legacy/unavailable", () => {
    const evidence = assemblePilotRecoveryEvidence(observations());
    expect(pilotRecovered(evidence)).toBe(true);
    expect(evidence).toMatchObject({
      manifestIdentity: "legacy/unavailable",
      releaseBootIdentity: "legacy/unavailable",
      supervisorIdentity: "legacy/unavailable",
    });
  });

  it.each([
    [
      "the stopped generation still running",
      {
        live: {
          engine: inspection(pair.engine, 100, PILOT_ENGINE, "start-100"),
          worker: inspection(pair.worker, 201, PILOT_WORKER, new Date(1_500).toString()),
        },
      },
    ],
    [
      "an unparseable process start time",
      {
        live: {
          engine: inspection(pair.engine, 200, PILOT_ENGINE, "not a start time"),
          worker: inspection(pair.worker, 201, PILOT_WORKER, new Date(1_500).toString()),
        },
      },
    ],
    ["a changed dependency closure", { dependencyPathsAndVersionsMatch: false }],
    ["a heartbeat without a fresh registration line", { workerLog: markers(201, []) }],
    ["a foreign SDK socket owner", { sdkSocketOwner: 999 }],
    ["unattributable engine logs", { engineLog: { uncertain: true, records: [] } }],
    ["a failed wrong-token denial", { bridge: { authenticated: true, missingDenied: true, wrongDenied: false } }],
    [
      "the candidate entrypoint instead of the captured pilot",
      { live: { engine: inspection(pair.engine, 200), worker: inspection(pair.worker, 201, PILOT_WORKER) } },
    ],
  ] as const)("fails with %s", (_name, override) => {
    expect(
      pilotRecovered(assemblePilotRecoveryEvidence(observations(override as Partial<PilotRecoveryObservations>))),
    ).toBe(false);
  });
});

describe("pilot rollback transaction", () => {
  function rollbackHarness(options: { verifyPilotFails?: boolean; quiesceDefers?: boolean } = {}) {
    const calls: string[] = [];
    const candidate: ServiceSnapshot = { services: [] };
    const pilot = registered();
    const p = provider({
      observePilotRecovery: vi.fn(async () => {
        calls.push("observe-pilot");
        const started = new Date(5_000).toString();
        const live = {
          engine: inspection(pair.engine, 200, PILOT_ENGINE, started),
          worker: inspection(pair.worker, 201, PILOT_WORKER, started),
        };
        return {
          captured: { engine: pilot.services.services[0].inspection, worker: pilot.services.services[1].inspection },
          live,
          stopped: { engine: { pid: 50, startTime: "c" }, worker: { pid: 51, startTime: "c" } },
          activationStartedAt: 0,
          now: 10_000,
          executableHashesMatch: !options.verifyPilotFails,
          dependencyPathsAndVersionsMatch: true,
          engineLog: {
            uncertain: false,
            records: [
              { message: "Hive starting up", pid: 200, timestamp: 1 },
              { message: "Hive is running", pid: 200, timestamp: 2 },
            ],
          },
          workerLog: { uncertain: false, records: [{ message: "registered worker", pid: 201, timestamp: 3 }] },
          engineExclusiveWriter: false,
          workerExclusiveWriter: false,
          bridge: { authenticated: true, missingDenied: true, wrongDenied: true },
          sdk: { rootStatus: 200, agentName: "hive-voice" },
          sdkSocketOwner: 201,
        };
      }),
      verifyRecoveryPrerequisites: vi.fn(async () => void calls.push("verify-prereqs")),
    });
    let loaded = true;
    const io = pilotRollbackTransaction({
      controller: {
        bootout: vi.fn(async (definition) => {
          calls.push(`bootout:${definition.label.endsWith("agent") ? "engine" : "worker"}`);
          loaded = false;
        }),
        inspect: vi.fn(async (label: string) => ({ ...inspection(pair.engine, 1), label, loaded })),
        restoreFilesAndState: vi.fn(
          async (snapshot) => void calls.push(snapshot === candidate ? "files:candidate" : "files:pilot"),
        ),
        restoreService: vi.fn(async (snapshot, label) => {
          calls.push(
            `start:${snapshot === candidate ? "candidate" : "pilot"}:${label.endsWith("agent") ? "engine" : "worker"}`,
          );
          return null;
        }),
      },
      provider: p,
      pilot,
      candidate,
      candidateDefinitions: pair,
      candidateWorkerHealthPort: 3107,
      phase: async (phase) => void calls.push(`phase:${phase}`),
      quiesceCandidate: async () => {
        calls.push("quiesce-candidate");
        if (options.quiesceDefers) throw new DeferredMaintenance("active call");
        return true;
      },
      releaseCandidate: async () => void calls.push("release-candidate"),
      markSignalsBegun: async () => void calls.push("signals"),
      stopCandidateWorker: async () => void calls.push("bootout:worker"),
      verifyCandidatePacked: async () => void calls.push("verify-packaged"),
      captureFences: () => ({
        engineLog: { path: "/l", dev: 1, ino: 1, offset: 0 },
        workerLog: { path: "/w", dev: 1, ino: 2, offset: 0 },
        wallStartedAt: 0,
        stopped: { engine: null, worker: null },
      }),
      finishResolved: async (resolution) => void calls.push(`resolved:${resolution}`),
      retainUnresolved: async () => void calls.push("unresolved"),
    });
    return { io, calls, p };
  }

  it("quiesces and stops the candidate worker before engine, restores pilot definitions only, then engine before worker", async () => {
    const { io, calls } = rollbackHarness();
    await activate(io);
    const effects = calls.filter((call) => !call.startsWith("phase:"));
    expect(effects).toEqual([
      "quiesce-candidate",
      "signals",
      "bootout:worker",
      "bootout:engine",
      "verify-prereqs",
      "files:pilot",
      "start:pilot:engine",
      "start:pilot:worker",
      "observe-pilot",
      "resolved:healthy",
    ]);
    expect(calls.some((call) => call.includes("rotate") || call.includes("move"))).toBe(false);
  });

  it("a failed pilot profile restores candidate definitions and the packaged profile, and still fails", async () => {
    const { io, calls } = rollbackHarness({ verifyPilotFails: true });
    await expect(activate(io)).rejects.toThrow("prior pair restored and verified");
    const tail = calls.slice(calls.indexOf("phase:recovering"));
    expect(tail).toEqual(
      expect.arrayContaining([
        "files:candidate",
        "start:candidate:engine",
        "start:candidate:worker",
        "verify-packaged",
        "resolved:recovered",
      ]),
    );
    expect(tail.indexOf("start:candidate:engine")).toBeLessThan(tail.indexOf("start:candidate:worker"));
  });

  it("a candidate that cannot quiesce is deferred with no signal and no restore", async () => {
    const { io, calls } = rollbackHarness({ quiesceDefers: true });
    await expect(activate(io)).rejects.toThrow("active call");
    expect(calls).not.toContain("signals");
    expect(
      calls.some((call) => call.startsWith("bootout") || call.startsWith("files") || call.startsWith("start")),
    ).toBe(false);
  });
});

describe("pilot worker stop under a native hold", () => {
  it("defers with terminal release and no bootout when the gate is not proved", async () => {
    const bootout = vi.fn();
    const release = vi.fn(async () => {});
    const outcome = await stopPilotWorkerUnderHold({
      session: {
        worker: { pid: 101, startTime: "s", executable: "/n", command: "c", cwd: "/" },
        bootId: "11111111-1111-4111-8111-111111111111",
        maintenanceDeadline: { wall: Date.now() + 30_000, mono: performance.now() + 30_000 },
        collect: async () => {
          throw new Error("PILOT_TELEMETRY_STALE");
        },
        release,
      },
      operationId: "22222222-2222-4222-8222-222222222222",
      clock: { now: Date.now, mono: () => performance.now() },
      randomId: () => "33333333-3333-4333-8333-333333333333",
      persistSignalsBegun: vi.fn(),
      controller: { bootout },
      workerDefinition: pair.worker,
      healthListenerPort: 8081,
    });
    expect(outcome).toMatchObject({ kind: "deferred" });
    expect(bootout).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("lifecycle wiring of the pilot routes", () => {
  it("--legacy-hold without an evidence provider is MIGRATION_PENDING before capture, staging, close or signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pilot-lifecycle-"));
    roots.push(root);
    writeFileSync(join(root, "hive.yaml"), "instance:\n  id: kpr463unit\nvoice:\n  livekit:\n    enabled: true\n");
    const operation = await acquireOperation({
      instanceHome: root,
      instanceId: "kpr463unit",
      mode: "update",
      toolSha256: "f".repeat(64),
      ownerStartTime: "start",
    });
    await expect(
      runNodeLifecycle(
        operation,
        { mode: "update", artifact: "/tmp/candidate.tgz", legacyHold: "/tmp/hold.json" },
        { HOME: root, PATH: "/usr/bin:/bin", HIVE_CONFIG: "hive.yaml" },
      ),
    ).rejects.toBeInstanceOf(MigrationPendingError);
    expect(commands.map((entry) => entry.command)).toEqual(["which"]);
    expect(existsSync(operation.paths.priorSnapshot)).toBe(false);
    expect(existsSync(resolve(operation.record.canonicalHome, ".hive.next"))).toBe(false);
    const record = JSON.parse(readFileSync(operation.paths.currentRecord, "utf8"));
    expect(record).toMatchObject({ resolution: "deferred", signalsBegun: false });
    expect(record.staging.selfTest).toBeNull();
    await finishOperationLock(operation);
  });

  it("--pilot-recovery without an evidence provider defers before touching services", async () => {
    const root = mkdtempSync(join(tmpdir(), "pilot-lifecycle-"));
    roots.push(root);
    writeFileSync(join(root, "hive.yaml"), "instance:\n  id: kpr463unit\n");
    const operation = await acquireOperation({
      instanceHome: root,
      instanceId: "kpr463unit",
      mode: "pilot-rollback",
      toolSha256: "f".repeat(64),
      ownerStartTime: "start",
    });
    await expect(
      runNodeLifecycle(
        operation,
        { mode: "pilot-rollback", pilotRecovery: "/tmp/snapshot.json" },
        { HOME: root, PATH: "/usr/bin:/bin", HIVE_CONFIG: "hive.yaml" },
      ),
    ).rejects.toBeInstanceOf(MigrationPendingError);
    expect(commands.map((entry) => entry.command)).toEqual(["which"]);
    expect(JSON.parse(readFileSync(operation.paths.currentRecord, "utf8"))).toMatchObject({
      resolution: "deferred",
      signalsBegun: false,
    });
    await finishOperationLock(operation);
  });
});
