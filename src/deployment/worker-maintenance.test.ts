import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import { acquireOperation, persistOperation, type AcquiredOperation } from "./operation.js";
import {
  allSipPages,
  decodeWorkerMaintenanceObservation,
  decodeWorkerMaintenanceRequest,
  pilotConfigIdentity,
  ProbeFailure,
  sha256Canonical,
  workerObservationFault,
  type HistoricalTelemetry,
  type WorkerMaintenanceObservation,
  type WorkerMaintenanceRequest,
} from "./pilot-probe.js";
import { canonicalBytes, sealFile, sha256Hex, type FileSeal, type InstanceKey } from "./pilot-records.js";
import type { Release } from "./release.js";
import { buildServiceDefinitions, buildServiceEnvironment, type ServiceInspection } from "./services.js";
import type { MaintenanceReply } from "../voice-worker/maintenance-ipc.js";
import {
  InstalledWorkerMaintenance,
  stopInstalledWorkerUnderProof,
  WorkerMaintenanceFault,
  type WorkerMaintenanceIO,
} from "./worker-maintenance.js";
import { readOwnLoaderTelemetry, runWorkerMaintenanceProbe, type TelemetryRow } from "./worker-maintenance-probe.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const UID = process.getuid!();
const BOOT = "33333333-3333-4333-8333-333333333333";
const OTHER_BOOT = "66666666-6666-4666-8666-666666666666";
const DIGEST = "a".repeat(64);
const RELEASE: Release = {
  schemaVersion: 1,
  packageVersion: "1.2.3",
  sourceRevision: "c".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: "d".repeat(64),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};
const BOOT_STARTED = Date.UTC(2026, 8, 14, 10, 0, 0);
const identity = (overrides: Partial<{ pid: number; bootId: string; release: Release }> = {}) => ({
  release: overrides.release ?? RELEASE,
  component: "voice-worker" as const,
  pid: overrides.pid ?? 4242,
  bootId: overrides.bootId ?? BOOT,
  startedAt: new Date(BOOT_STARTED).toISOString(),
});

function seal(path: string): FileSeal {
  return { path, realpath: path, uid: UID, mode: 0o644, dev: 1, ino: 2, size: 3, sha256: DIGEST };
}

const ids = {
  request: "11111111-1111-4111-8111-111111111111",
  operation: "22222222-2222-4222-8222-222222222222",
  job: "44444444-4444-4444-8444-444444444444",
  status: "55555555-5555-4555-8555-555555555555",
};

const T0 = BOOT_STARTED + 600_000;

function request(overrides: Partial<WorkerMaintenanceRequest> = {}): WorkerMaintenanceRequest {
  const home = "/Users/example/services/hive/dodi";
  return {
    schemaVersion: 1,
    abi: "hive-worker-maintenance/1",
    action: "observe",
    requestId: ids.request,
    operationId: ids.operation,
    jobId: ids.job,
    instance: { canonicalHome: home, configPath: `${home}/hive.yaml`, instanceId: "dodi", uid: UID },
    phase: "post-close",
    requestedAt: T0,
    deadline: T0 + 2_000,
    maintenanceDeadline: T0 + 30_000,
    runtime: {
      root: { path: `${home}/.hive`, identity: { dev: 1, ino: 7, uid: UID } },
      node: seal("/opt/node/bin/node"),
      probe: seal(`${home}/.hive/pkg/runtime-probe.min.js`),
      config: seal(`${home}/hive.yaml`),
      environmentSha256: DIGEST,
    },
    expectedRelease: RELEASE,
    expectedWorker: {
      pid: 4242,
      startTime: "Mon Sep 14 10:00:00 2026",
      executable: "/opt/node/bin/node",
      command: `/opt/node/bin/node ${home}/.hive/pkg/voice-worker.min.js start`,
      cwd: home,
    },
    idle: { expectedAdmission: "closed", expectedSupervisor: identity(), statusRequestId: ids.status },
    ...overrides,
  };
}

function reply(r: WorkerMaintenanceRequest, overrides: Partial<MaintenanceReply["snapshot"]> = {}): MaintenanceReply {
  return {
    protocol: 1,
    requestId: r.idle.statusRequestId,
    operationId: r.operationId,
    supervisor: { pid: r.idle.expectedSupervisor.pid, bootId: r.idle.expectedSupervisor.bootId },
    ok: true,
    snapshot: {
      supervisor: { pid: r.idle.expectedSupervisor.pid, bootId: r.idle.expectedSupervisor.bootId },
      operationId: r.idle.expectedAdmission === "closed" ? r.operationId : null,
      admission: r.idle.expectedAdmission,
      persistenceFault: false,
      unresolved: [],
      childPids: [],
      ...overrides,
    },
    writtenAt: r.requestedAt + 60,
  };
}

function observation(
  r: WorkerMaintenanceRequest,
  requestSha: string,
  overrides: Partial<WorkerMaintenanceObservation> = {},
): WorkerMaintenanceObservation {
  return {
    schemaVersion: 1,
    abi: "hive-worker-maintenance/1",
    action: "observe",
    requestId: r.requestId,
    operationId: r.operationId,
    jobId: r.jobId,
    instance: r.instance,
    phase: r.phase,
    requestSha256: requestSha,
    startedAt: r.requestedAt + 10,
    finishedAt: r.requestedAt + 200,
    release: r.expectedRelease,
    sdk: { host: "127.0.0.1", port: 3108, rootStatus: 200, agentName: "hive-voice", activeJobs: 0 },
    idle: {
      status: { requestedAt: r.requestedAt + 20, finishedAt: r.requestedAt + 100, reply: reply(r) },
      telemetry: {
        queryStartedAt: r.requestedAt + 20,
        queryFinishedAt: r.requestedAt + 90,
        supervisorIdentity: r.idle.expectedSupervisor,
        supervisorUpdatedAt: r.requestedAt - 5_000,
        activeCalls: 0,
      },
    },
    ...overrides,
  };
}

describe("worker-maintenance wire contract", () => {
  it("decodes the exact request and refuses phase/admission, deadline, ID reuse and probe-path swaps", () => {
    const r = request();
    expect(decodeWorkerMaintenanceRequest(r).phase).toBe("post-close");
    expect(() => decodeWorkerMaintenanceRequest({ ...r, phase: "baseline" })).toThrow(ProbeFailure);
    expect(() =>
      decodeWorkerMaintenanceRequest({ ...r, idle: { ...r.idle, expectedAdmission: "any" } } as never),
    ).toThrow();
    expect(() => decodeWorkerMaintenanceRequest({ ...r, deadline: r.requestedAt + 2_001 })).toThrow();
    expect(() => decodeWorkerMaintenanceRequest({ ...r, deadline: r.maintenanceDeadline + 1 })).toThrow();
    expect(() => decodeWorkerMaintenanceRequest({ ...r, idle: { ...r.idle, statusRequestId: r.requestId } })).toThrow();
    expect(() =>
      decodeWorkerMaintenanceRequest({
        ...r,
        runtime: { ...r.runtime, probe: seal("/elsewhere/runtime-probe.min.js") },
      }),
    ).toThrow();
    expect(() => decodeWorkerMaintenanceRequest({ ...r, operationIdOverride: ids.status } as never)).toThrow();
  });

  it("decodes observations strictly: null idle, unknown keys and malformed replies fail", () => {
    const r = request();
    const o = observation(r, DIGEST);
    expect(decodeWorkerMaintenanceObservation(JSON.parse(JSON.stringify(o))).phase).toBe("post-close");
    expect(() => decodeWorkerMaintenanceObservation({ ...o, idle: null })).toThrow();
    expect(() => decodeWorkerMaintenanceObservation({ ...o, held: true })).toThrow();
    expect(() =>
      decodeWorkerMaintenanceObservation({
        ...o,
        idle: { ...o.idle, status: { ...o.idle.status, reply: { ...o.idle.status.reply, extra: 1 } } },
      }),
    ).toThrow();
  });

  it("correlates an observation with its own request, status UUID, owner, boot and timestamps", () => {
    const r = request();
    const ok = observation(r, DIGEST);
    expect(workerObservationFault(ok, r, DIGEST, T0 + 500)).toBeNull();
    expect(workerObservationFault(ok, r, "b".repeat(64), T0 + 500)).toBe("PILOT_PROBE_INPUT_INVALID");
    const wrongStatus = observation(r, DIGEST);
    wrongStatus.idle.status.reply = { ...reply(r), requestId: ids.job };
    expect(workerObservationFault(wrongStatus, r, DIGEST, T0 + 500)).toBe("PILOT_ADMISSION_MISMATCH");
    const openInClosed = observation(r, DIGEST);
    openInClosed.idle.status.reply = reply(r, { admission: "open", operationId: null });
    expect(workerObservationFault(openInClosed, r, DIGEST, T0 + 500)).toBe("PILOT_ADMISSION_MISMATCH");
    const foreignOwner = observation(r, DIGEST);
    foreignOwner.idle.status.reply = reply(r, { operationId: ids.job });
    expect(workerObservationFault(foreignOwner, r, DIGEST, T0 + 500)).toBe("PILOT_ADMISSION_MISMATCH");
    const wrongBoot = observation(r, DIGEST);
    wrongBoot.idle.telemetry.supervisorIdentity = identity({ bootId: OTHER_BOOT });
    expect(workerObservationFault(wrongBoot, r, DIGEST, T0 + 500)).toBe("PILOT_TELEMETRY_WRONG_BOOT");
    const stale = observation(r, DIGEST);
    stale.idle.telemetry.supervisorUpdatedAt = stale.idle.telemetry.queryFinishedAt - 60_001;
    expect(workerObservationFault(stale, r, DIGEST, T0 + 500)).toBe("PILOT_TELEMETRY_STALE");
    const future = observation(r, DIGEST);
    future.idle.telemetry.supervisorUpdatedAt = future.idle.telemetry.queryFinishedAt + 1;
    expect(workerObservationFault(future, r, DIGEST, T0 + 500)).toBe("PILOT_TELEMETRY_STALE");
    const late = observation(r, DIGEST, { finishedAt: r.deadline + 1 });
    expect(workerObservationFault(late, r, DIGEST, T0 + 5_000)).toBe("PILOT_PROBE_DEADLINE");
    const early = observation(r, DIGEST, { startedAt: r.requestedAt - 1 });
    expect(workerObservationFault(early, r, DIGEST, T0 + 500)).toBe("PILOT_PROBE_DEADLINE");
  });
});

describe("own-loader telemetry read", () => {
  const telemetryRequest = (now: number) => ({
    action: "observe" as const,
    requestedAt: now,
    deadline: now + 2_000,
    expectedRelease: RELEASE,
    idle: request().idle,
  });
  const row = (overrides: TelemetryRow = {}): TelemetryRow => ({
    kind: "voice_worker_stats",
    supervisorIdentity: identity(),
    supervisorUpdatedAt: new Date(T0 - 1_000),
    activeCalls: 0,
    ...overrides,
  });
  const read = (rows: TelemetryRow[] | Error, now = T0) =>
    readOwnLoaderTelemetry({ mongoUri: "mongodb://127.0.0.1:1", mongoDbName: "hive" }, telemetryRequest(now), {
      now: () => now,
      query: async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      },
    });

  it("returns a valid current row and passes a measured nonzero count through unchanged", async () => {
    const valid: HistoricalTelemetry = await read([row()]);
    expect(valid.activeCalls).toBe(0);
    expect((await read([row({ activeCalls: 3 })])).activeCalls).toBe(3);
  });

  it("classifies missing, duplicate, malformed, stale, future, wrong-boot and failed reads without zeroing", async () => {
    await expect(read([])).rejects.toThrow("PILOT_TELEMETRY_MISSING");
    await expect(read([row(), row()])).rejects.toThrow("PILOT_TELEMETRY_INVALID");
    for (const activeCalls of [-1, 1.5, "0", true, undefined]) {
      await expect(read([row({ activeCalls })])).rejects.toThrow("PILOT_TELEMETRY_INVALID");
    }
    await expect(read([row({ supervisorIdentity: { pid: 1 } })])).rejects.toThrow("PILOT_TELEMETRY_INVALID");
    await expect(read([row({ supervisorUpdatedAt: "not a date" })])).rejects.toThrow("PILOT_TELEMETRY_INVALID");
    await expect(read([row({ supervisorUpdatedAt: new Date(T0 - 60_001) })])).rejects.toThrow("PILOT_TELEMETRY_STALE");
    await expect(read([row({ supervisorUpdatedAt: new Date(T0 + 1) })])).rejects.toThrow("PILOT_TELEMETRY_STALE");
    // Job-owned `updatedAt` never substitutes for the supervisor heartbeat.
    await expect(
      read([{ ...row({ supervisorUpdatedAt: new Date(T0 - 90_000) }), updatedAt: new Date(T0) } as TelemetryRow]),
    ).rejects.toThrow("PILOT_TELEMETRY_STALE");
    await expect(read([row({ supervisorIdentity: identity({ bootId: OTHER_BOOT }) })])).rejects.toThrow(
      "PILOT_TELEMETRY_WRONG_BOOT",
    );
    await expect(
      read([row({ supervisorIdentity: identity({ release: { ...RELEASE, packageVersion: "9.9.9" } }) })]),
    ).rejects.toThrow("PILOT_TELEMETRY_WRONG_BOOT");
    await expect(read(new Error("denied"))).rejects.toThrow("PILOT_TELEMETRY_QUERY_FAILED");
    await expect(
      readOwnLoaderTelemetry(
        { mongoUri: "x", mongoDbName: "hive" },
        { ...telemetryRequest(T0), idle: null },
        { now: () => T0, query: async () => [row()] },
      ),
    ).rejects.toThrow("PILOT_PROBE_INPUT_INVALID");
    await expect(
      readOwnLoaderTelemetry({ mongoUri: "x", mongoDbName: "hive" }, telemetryRequest(T0), {
        now: () => T0 + 2_000,
        query: async () => [row()],
      }),
    ).rejects.toThrow("PILOT_PROBE_DEADLINE");
  });
});

describe("historical ABI helpers", () => {
  it("pages SIP lists with the pinned cursor algorithm and fails closed on repeats and overflow", async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` })), [{ id: "r100" }]];
    const cursors: string[] = [];
    const rows = await allSipPages(
      async (page) => {
        cursors.push(page.afterId);
        return pages[cursors.length - 1];
      },
      (row) => row.id,
    );
    expect(rows).toHaveLength(101);
    expect(cursors).toEqual(["", "r99"]);
    await expect(
      allSipPages(
        async () => Array.from({ length: 100 }, () => ({ id: "same" })),
        (row) => row.id,
      ),
    ).rejects.toThrow("PILOT_INVENTORY_INCOMPLETE");
    let n = 0;
    await expect(
      allSipPages(
        async () => Array.from({ length: 100 }, () => ({ id: `x${n++}` })),
        (row) => row.id,
      ),
    ).rejects.toThrow("PILOT_INVENTORY_INCOMPLETE");
  });

  it("projects configuration identity without credentials and rejects credential-bearing bridge URLs", () => {
    const instance: InstanceKey = request().instance;
    const wc = {
      instanceHome: instance.canonicalHome,
      instanceId: "dodi",
      mongoDbName: "hive_dodi",
      sipTrunkId: "ST_1",
      inboundAgents: { "+1": "mokie" },
      agentVoices: {},
      defaultStt: "deepgram/flux-general-en",
      defaultTts: "cartesia/sonic-3",
      bridgeUrl: "http://127.0.0.1:3107/v1/chat/completions",
    };
    expect(pilotConfigIdentity(wc, instance, 3108)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      pilotConfigIdentity({ ...wc, bridgeUrl: "http://u:p@127.0.0.1:3107/v1/chat/completions" }, instance, 3108),
    ).toThrow("PILOT_CONFIGURATION_MISMATCH");
    expect(() => pilotConfigIdentity({ ...wc, instanceId: "other" }, instance, 3108)).toThrow();
  });
});

// ── installed probe against an acquired operation ──────────────────────────

interface ProbeFixture {
  root: string;
  operation: AcquiredOperation;
  instance: InstanceKey;
  env: Record<string, string>;
  probePath: string;
  requestFor(
    phase: WorkerMaintenanceRequest["phase"],
    now: number,
  ): Promise<{ path: string; request: WorkerMaintenanceRequest }>;
}

async function probeFixture(): Promise<ProbeFixture> {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-worker-maintenance-")));
  roots.push(root);
  chmodSync(root, 0o755);
  writeFileSync(resolve(root, "hive.yaml"), "instance:\n  id: dodi\n", { mode: 0o644 });
  mkdirSync(resolve(root, ".hive", "pkg"), { recursive: true, mode: 0o755 });
  const probePath = resolve(root, ".hive", "pkg", "runtime-probe.min.js");
  writeFileSync(probePath, "// probe\n", { mode: 0o644 });
  const operation = await acquireOperation({
    instanceHome: root,
    instanceId: "dodi",
    mode: "restart",
    toolSha256: DIGEST,
    ownerStartTime: "start",
  });
  const instance: InstanceKey = {
    canonicalHome: root,
    configPath: resolve(root, "hive.yaml"),
    instanceId: "dodi",
    uid: UID,
  };
  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: process.execPath,
    hiveHome: root,
    configPath: resolve(root, "hive.yaml"),
    home: "/Users/example",
    pathEnv: "/usr/bin:/bin",
  });
  const env = buildServiceEnvironment(pair.worker);
  const strip = async (path: string, allowRoot = false) => {
    const { bytes: _b, ...value } = await sealFile(path, { uid: UID, allowRoot });
    void _b;
    return value;
  };
  const rootInfo = await import("node:fs/promises").then((fs) => fs.lstat(resolve(root, ".hive")));
  const runtime = {
    root: { path: resolve(root, ".hive"), identity: { dev: rootInfo.dev, ino: rootInfo.ino, uid: rootInfo.uid } },
    node: await strip(process.execPath, true),
    probe: await strip(probePath),
    config: await strip(resolve(root, "hive.yaml")),
    environmentSha256: sha256Canonical(env),
  };
  return {
    root,
    operation,
    instance,
    env,
    probePath,
    async requestFor(phase, now) {
      const jobId = crypto.randomUUID();
      const r: WorkerMaintenanceRequest = {
        ...request(),
        requestId: crypto.randomUUID(),
        operationId: operation.record.id,
        jobId,
        instance,
        phase,
        requestedAt: now,
        deadline: now + 2_000,
        maintenanceDeadline: now + 30_000,
        runtime,
        expectedWorker: { ...request().expectedWorker, cwd: root },
        idle: {
          expectedAdmission: phase === "baseline" ? "open" : "closed",
          expectedSupervisor: identity(),
          statusRequestId: crypto.randomUUID(),
        },
      };
      const directory = resolve(operation.paths.operationDirectory, "probes", jobId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = resolve(directory, "worker-maintenance.json");
      writeFileSync(path, canonicalBytes(r), { mode: 0o600 });
      return { path, request: r };
    },
  };
}

function probeDeps(f: ProbeFixture, now: () => number, overrides: Record<string, unknown> = {}) {
  mkdirSync(resolve(f.root, ".hive-state", "runtime"), { recursive: true });
  writeFileSync(resolve(f.root, ".hive-state", "runtime", "voice-worker.json"), JSON.stringify(identity()));
  const calls: string[] = [];
  return {
    calls,
    deps: {
      now,
      uid: () => UID,
      selfPath: f.probePath,
      execPath: process.execPath,
      env: f.env,
      serviceEnvironment: () => f.env,
      readRelease: () => RELEASE,
      loadWorkerConfig: async () => ({
        instanceHome: f.root,
        instanceId: "dodi",
        healthPort: 3108,
        mongoUri: "mongodb://127.0.0.1:1",
        mongoDbName: "hive",
      }),
      inspectWorker: async () => ({ ...request().expectedWorker, ppid: 1, cwd: f.root }),
      processStartTime: async () => request().expectedWorker.startTime,
      listenerPid: async () => 4242,
      probeWorkerHttp: async () => ({ rootStatus: 200, agentName: "hive-voice", activeJobs: 0 }),
      readTelemetry: async (_wc: unknown, r: { requestedAt: number }) => ({
        queryStartedAt: now(),
        queryFinishedAt: now(),
        supervisorIdentity: identity(),
        supervisorUpdatedAt: r.requestedAt - 1_000,
        activeCalls: 0,
      }),
      requestMaintenance: async (options: {
        operationId: string;
        kind: string;
        expectedAdmission?: string;
        randomId?: () => string;
      }) => {
        calls.push(`${options.kind}:${options.operationId}:${options.expectedAdmission}`);
        const snapshot = {
          supervisor: { pid: 4242, bootId: BOOT },
          operationId: options.expectedAdmission === "closed" ? options.operationId : null,
          admission: options.expectedAdmission as "open" | "closed",
          persistenceFault: false,
          unresolved: [],
          childPids: [],
        };
        return {
          protocol: 1 as const,
          requestId: options.randomId!(),
          operationId: options.operationId,
          supervisor: { pid: 4242, bootId: BOOT },
          ok: true,
          snapshot,
          writtenAt: now(),
        };
      },
      ...overrides,
    },
  };
}

describe("installed worker-maintenance probe", () => {
  it("observes a closed same-owner gate for the acquired operation and seals the request digest", async () => {
    const f = await probeFixture();
    f.operation.record.barrierOperationId = f.operation.record.id;
    f.operation.record.supervisor = { pid: 4242, bootId: BOOT };
    await persistOperation(f.operation);
    const now = Date.now();
    const { path, request: r } = await f.requestFor("post-close", now);
    const { deps, calls } = probeDeps(f, () => now + 5);
    const result = await runWorkerMaintenanceProbe(path, deps as never);
    expect(calls).toEqual([`status:${f.operation.record.id}:closed`]);
    expect(result.idle.status.reply.requestId).toBe(r.idle.statusRequestId);
    expect(result.requestSha256).toBe(sha256Hex(canonicalBytes(r)));
    expect(
      workerObservationFault(
        decodeWorkerMaintenanceObservation(parseCanonical(canonicalBytes(result))),
        r,
        result.requestSha256,
        now + 10,
      ),
    ).toBeNull();
  });

  it("refuses a baseline after this attempt closed, a foreign lock and a swapped probe or environment", async () => {
    const f = await probeFixture();
    const now = Date.now();
    f.operation.record.barrierOperationId = f.operation.record.id;
    f.operation.record.supervisor = { pid: 4242, bootId: BOOT };
    await persistOperation(f.operation);
    const baseline = await f.requestFor("baseline", now);
    await expect(runWorkerMaintenanceProbe(baseline.path, probeDeps(f, () => now + 5).deps as never)).rejects.toThrow(
      "PILOT_ADMISSION_MISMATCH",
    );
    const closed = await f.requestFor("post-close", now);
    const swapped = resolve(f.root, ".hive", "pkg", "other.min.js");
    writeFileSync(swapped, "// other\n", { mode: 0o644 });
    await expect(
      runWorkerMaintenanceProbe(closed.path, probeDeps(f, () => now + 5, { selfPath: swapped }).deps as never),
    ).rejects.toThrow("PILOT_DEPENDENCY_MISMATCH");
    await expect(
      runWorkerMaintenanceProbe(
        closed.path,
        probeDeps(f, () => now + 5, { serviceEnvironment: () => ({ ...f.env, WS_PORT: "4000" }) }).deps as never,
      ),
    ).rejects.toThrow("PILOT_CONFIGURATION_MISMATCH");
    await expect(
      runWorkerMaintenanceProbe(
        closed.path,
        probeDeps(f, () => now + 5, { listenerPid: async () => 9999 }).deps as never,
      ),
    ).rejects.toThrow("PILOT_ADMISSION_MISMATCH");
    await expect(runWorkerMaintenanceProbe(closed.path, probeDeps(f, () => now + 2_500).deps as never)).rejects.toThrow(
      "PILOT_PROBE_DEADLINE",
    );
    writeFileSync(resolve(f.operation.paths.lockDirectory, "owner.json"), JSON.stringify({ id: ids.job }));
    await expect(runWorkerMaintenanceProbe(closed.path, probeDeps(f, () => now + 5).deps as never)).rejects.toThrow(
      "PILOT_PROBE_INPUT_INVALID",
    );
  });
});

// ── frozen-side observer ────────────────────────────────────────────────────

function inspection(root: string): ServiceInspection {
  const e = { ...request().expectedWorker, cwd: root };
  return {
    label: "com.hive.dodi.voice-worker",
    loaded: true,
    enabled: true,
    livePID: e.pid,
    startTime: e.startTime,
    args: [],
    cwd: root,
    configSelection: `${root}/hive.yaml`,
    serviceEnvironment: {},
    plist: null,
    link: null,
    process: { ...e, ppid: 1 },
  };
}

async function observerFixture(
  options: {
    clock?: { now(): number; mono(): number };
    respond?: (r: WorkerMaintenanceRequest, sha: string) => { exitCode: number; stdout: string };
  } = {},
) {
  const f = await probeFixture();
  const writes = new Map<string, Buffer>();
  const runs: { node: string; args: readonly string[] }[] = [];
  let wall = Date.now();
  const clock = options.clock ?? { now: () => wall, mono: () => wall };
  const io: WorkerMaintenanceIO = {
    async run(node, args) {
      runs.push({ node, args });
      wall += 300;
      const bytes = writes.get(args[2])!;
      const r = decodeWorkerMaintenanceRequest(parseCanonical(bytes));
      const respond =
        options.respond ?? ((req, sha) => ({ exitCode: 0, stdout: `${canonical(observation(req, sha))}\n` }));
      return respond(r, sha256Hex(bytes));
    },
    readDescriptor: async () => identity(),
    readRelease: () => RELEASE,
    seal: async (path) => seal(path),
    rootIdentity: async () => ({ dev: 1, ino: 7, uid: UID }),
    async writeRequest(path, bytes) {
      writes.set(path, bytes);
    },
  };
  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: process.execPath,
    hiveHome: f.root,
    configPath: resolve(f.root, "hive.yaml"),
    home: "/Users/example",
    pathEnv: "/usr/bin:/bin",
  });
  const bootouts: string[] = [];
  const controller = {
    inspect: async () => inspection(f.root),
    listener: async (port: number) => ({ port, pid: 4242 }),
    async bootout(_definition: unknown, opts: { beforeExec?(): void }) {
      opts.beforeExec?.();
      bootouts.push("worker");
    },
  };
  const observer = new InstalledWorkerMaintenance({
    operation: f.operation,
    instance: f.instance,
    workerDefinition: pair.worker,
    serviceEnvironment: f.env,
    nodePath: process.execPath,
    configPath: resolve(f.root, "hive.yaml"),
    controller,
    clock,
    io,
  });
  return {
    f,
    observer,
    runs,
    writes,
    bootouts,
    controller,
    pair,
    advance: (ms: number) => (wall += ms),
    now: () => wall,
  };
}

describe("frozen installed-worker observer", () => {
  it("writes a private per-job request and runs only the installed probe with the fixed argv", async () => {
    const x = await observerFixture();
    x.observer.bindDeadline(x.now() + 30_000);
    const read = await x.observer.observe();
    expect(read.observation.phase).toBe("baseline");
    expect(read.idle.registered).toBe(true);
    expect(x.runs).toHaveLength(1);
    const [probe, mode, input] = x.runs[0].args;
    expect(probe).toBe(resolve(x.f.root, ".hive", "pkg", "runtime-probe.min.js"));
    expect(mode).toBe("worker-maintenance");
    expect(input).toMatch(
      new RegExp(`${x.f.operation.paths.operationDirectory}/probes/[0-9a-f-]{36}/worker-maintenance.json$`),
    );
    expect(x.runs[0].args).toHaveLength(3);
  });

  it("changes phase only after this operation's close and uses fresh distinct UUIDs every read", async () => {
    const x = await observerFixture();
    x.observer.bindDeadline(x.now() + 30_000);
    await x.observer.observe();
    await expect(x.observer.observe({ final: true })).rejects.toBeInstanceOf(WorkerMaintenanceFault);
    x.observer.markClosed();
    await x.observer.observe();
    const requests = [...x.writes.values()].map((bytes) => decodeWorkerMaintenanceRequest(parseCanonical(bytes)));
    expect(requests.map((r) => r.phase)).toEqual(["baseline", "post-close"]);
    const all = requests.flatMap((r) => [r.requestId, r.jobId, r.idle.statusRequestId]);
    expect(new Set(all).size).toBe(all.length);
    expect(requests[1].idle.expectedAdmission).toBe("closed");
  });

  it("never extends the original deadline and fails on exit-1 envelopes or extra output", async () => {
    const x = await observerFixture({
      respond: (r) => ({
        exitCode: 1,
        stdout: `${canonical({ schemaVersion: 1, abi: "hive-worker-maintenance/1", requestId: r.requestId, classification: "PILOT_TELEMETRY_STALE" })}\n`,
      }),
    });
    const deadline = x.now() + 30_000;
    x.observer.bindDeadline(deadline);
    x.observer.bindDeadline(deadline + 60_000);
    expect(x.observer.maintenanceDeadline?.wall).toBe(deadline);
    await expect(x.observer.observe()).rejects.toThrow("PILOT_TELEMETRY_STALE");
    const extra = await observerFixture({
      respond: (r, sha) => ({ exitCode: 0, stdout: `${canonical(observation(r, sha))}\n{}\n` }),
    });
    extra.observer.bindDeadline(extra.now() + 30_000);
    await expect(extra.observer.observe()).rejects.toThrow("PILOT_PROBE_INPUT_INVALID");
    x.advance(31_000);
    await expect(x.observer.observe()).rejects.toThrow("PILOT_PROBE_DEADLINE");
  });

  it("stops the worker only after a final closed read consumed at dispatch, and defers with release otherwise", async () => {
    const x = await observerFixture();
    x.f.operation.record.barrierOperationId = x.f.operation.record.id;
    x.observer.bindDeadline(x.now() + 30_000);
    x.observer.markClosed();
    let released = 0;
    let persisted = 0;
    const base = {
      observer: x.observer,
      operationId: x.f.operation.record.id,
      worker: { ...request().expectedWorker, cwd: x.f.root },
      bootId: BOOT,
      clock: { now: x.now, mono: x.now },
      persistSignalsBegun: async () => void (persisted += 1),
      controller: x.controller as never,
      workerDefinition: x.pair.worker,
      healthListenerPort: () => 3108,
      release: async () => void (released += 1),
    };
    expect(await stopInstalledWorkerUnderProof(base)).toEqual({ kind: "stopped", attempts: 1 });
    expect(x.bootouts).toEqual(["worker"]);
    expect(persisted).toBe(1);
    const lastRequest = [...x.writes.values()].map((b) => decodeWorkerMaintenanceRequest(parseCanonical(b))).at(-1)!;
    expect(lastRequest.phase).toBe("final");

    const nonzero = await observerFixture({
      respond: (r, sha) => {
        const o = observation(r, sha);
        o.idle.telemetry.activeCalls = 1;
        return { exitCode: 0, stdout: `${canonical(o)}\n` };
      },
    });
    nonzero.observer.bindDeadline(nonzero.now() + 30_000);
    nonzero.observer.markClosed();
    const deferred = await stopInstalledWorkerUnderProof({
      ...base,
      observer: nonzero.observer,
      operationId: nonzero.f.operation.record.id,
      clock: { now: nonzero.now, mono: nonzero.now },
      controller: nonzero.controller as never,
    });
    expect(deferred.kind).toBe("deferred");
    expect(nonzero.bootouts).toEqual([]);
    expect(released).toBe(1);
  });
});
