import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { canonical } from "./canonical.js";
import { finishOperationLock, persistOperation, type AcquiredOperation } from "./operation.js";
import {
  probeFailureEnvelope,
  runHistoricalProbe,
  runPilotAbiHandshake,
  type HistoricalProbeDeps,
  type LivekitReader,
} from "./historical-probe.js";
import { runPilotProfileProbe, type OuterProbeDeps } from "./pilot-profile-probe.js";
import {
  corroborateNativeCapability,
  establishNativeHold,
  invokePilotInventory,
  invokePilotProbe,
  nodePilotProbeLaunchIO,
  preparePilotProbe,
  registeredProbeSubject,
  type NativeHoldDeps,
  type PilotProbeLaunchIO,
} from "./pilot-observer.js";
import { stopPilotWorkerUnderHold } from "./pilot-lifecycle.js";
import { classificationOf, resolveRequiredDependencies, sha256Canonical } from "./pilot-probe.js";
import { sha256Hex } from "./pilot-records.js";
import type { MaintenanceReply, RequestMaintenanceOptions } from "../voice-worker/maintenance-ipc.js";
import { DeferredMaintenance } from "./transaction.js";
import {
  createPilotFixture,
  DUMMY_SECRETS,
  ENGINE_PID,
  FIXTURE_RELEASE,
  SDK_PORT,
  WORKER_PID,
  type PilotFixture,
} from "./testing/pilot-fixture.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

const clock = { now: Date.now, mono: () => performance.now() };

interface World {
  f: PilotFixture;
  calls: string[];
  state: {
    admission: "open" | "closed";
    owner: string | null;
    jobs: number;
    activeCalls: number;
    heartbeatAge: number;
  };
  io: PilotProbeLaunchIO;
  request(options: RequestMaintenanceOptions): Promise<MaintenanceReply>;
  handshakeRelease: typeof FIXTURE_RELEASE;
  reader: LivekitReader;
}

async function world(layout: "legacy" | "packaged"): Promise<World> {
  const f = await createPilotFixture({ layout });
  cleanups.push(f.base);
  f.writeDescriptor();
  const calls: string[] = [];
  const state = {
    admission: "open" as "open" | "closed",
    owner: null as string | null,
    jobs: 0,
    activeCalls: 0,
    heartbeatAge: 1_000,
  };
  const w = { f, calls, state } as World;
  w.handshakeRelease = FIXTURE_RELEASE;
  w.reader = {
    listRooms: async () => [{ sid: "RM_raw", name: "room" }],
    listParticipants: async () => [],
    listDispatch: async () => [{ id: "AD_raw", agentName: "hive-voice" }],
    listSipDispatchRule: async () => [
      { sipDispatchRuleId: "SDR_raw", roomConfig: { agents: [{ agentName: "hive-voice" }] } },
    ],
    listSipInboundTrunk: async () => [],
  };
  w.request = async (options) => {
    calls.push(
      `${options.kind}:${options.operationId === state.owner || options.kind === "close" ? "owner" : "other"}:${options.expectedAdmission}`,
    );
    if (options.kind === "close") {
      state.admission = "closed";
      state.owner = options.operationId;
    } else if (options.kind === "release") {
      if (state.owner !== options.operationId) throw new Error("foreign release");
      state.admission = "open";
      state.owner = null;
    }
    if (options.expectedAdmission !== "any" && options.expectedAdmission !== state.admission) {
      throw new Error("stale or mismatched maintenance reply");
    }
    const requestId = options.randomId ? options.randomId() : randomUUID();
    calls.push(`status-id:${requestId}`);
    return {
      protocol: 1,
      requestId,
      operationId: options.operationId,
      supervisor: { pid: WORKER_PID, bootId: f.descriptor().bootId },
      ok: true,
      snapshot: {
        supervisor: { pid: WORKER_PID, bootId: f.descriptor().bootId },
        operationId: state.owner,
        admission: state.admission,
        persistenceFault: false,
        unresolved: [],
        childPids: [],
      },
      writtenAt: Date.now(),
    };
  };
  const boundaries = (env: NodeJS.ProcessEnv, selfPath: string) => ({
    now: Date.now,
    uid: () => f.instance.uid,
    selfPath,
    env,
    serviceEnvironment: (e: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(e)) as Record<string, string>,
    readRelease: () => FIXTURE_RELEASE,
    processIdentity: async (pid: number) =>
      pid === ENGINE_PID
        ? { ...f.engine, ppid: 1 }
        : pid === WORKER_PID
          ? { ...f.worker, ppid: 1 }
          : pid === process.pid
            ? { pid, ppid: 1, startTime: "Mon Sep 14 10:00:00 2026", command: "helper", executable: "/node", cwd: "/" }
            : null,
    listenerOwners: async () => [WORKER_PID],
    probeBridge: async (_url: string, token: string) => ({
      authenticated: token === DUMMY_SECRETS.bridgeToken,
      missingDenied: true,
      wrongDenied: true,
      correctStatus: 400,
      missingStatus: 401,
      wrongStatus: 403,
    }),
    probeWorkerHttp: async () => ({ rootStatus: 200, agentName: "hive-voice", activeJobs: state.jobs }),
    readTelemetry: async () => ({
      queryStartedAt: Date.now(),
      queryFinishedAt: Date.now(),
      supervisorIdentity: f.descriptor(),
      supervisorUpdatedAt: Date.now() - state.heartbeatAge,
      activeCalls: state.activeCalls,
    }),
    requestMaintenance: (options: RequestMaintenanceOptions) => w.request(options),
    livekit: async () => w.reader,
    resolveDependencies: resolveRequiredDependencies,
    sha256File: async (path: string) => sha256Hex(await readFile(path)),
  });
  const historicalDeps = (env: NodeJS.ProcessEnv): HistoricalProbeDeps => ({
    ...boundaries(env, f.loaderPath),
    readRelease: () => w.handshakeRelease,
    loadWorkerConfig: async () =>
      f.loaderConfig as unknown as Awaited<ReturnType<HistoricalProbeDeps["loadWorkerConfig"]>>,
    serverSdkVersion: () => "2.14.1",
  });
  const outerDeps = (env: NodeJS.ProcessEnv): OuterProbeDeps => ({
    ...boundaries(env, f.bootstrapProbe),
    async run(_node, args, childEnv) {
      calls.push(`historical:${args[1]}`);
      try {
        const output =
          args[1] === "pilot-abi"
            ? await runPilotAbiHandshake(historicalDeps(childEnv))
            : await runHistoricalProbe(args[2]!, historicalDeps(childEnv));
        return { exitCode: 0, stdout: `${canonical(output)}\n` };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: `${canonical(await probeFailureEnvelope(args[2], classificationOf(error), "hive-pilot-probe/1"))}\n`,
        };
      }
    },
    writeRequest: nodePilotProbeLaunchIO.writeRequest,
    importLegacyLoader: async () => () => f.loaderConfig,
    livekitFrom: async () => w.reader,
  });
  w.io = {
    ...nodePilotProbeLaunchIO,
    async run(_node, args, env) {
      expect(args[0]).toBe(f.bootstrapProbe);
      calls.push(`outer:${args[1]}`);
      try {
        const output = await runPilotProfileProbe(args[1] as "pilot", args[2]!, outerDeps(env));
        return { exitCode: 0, stdout: `${canonical(output)}\n` };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: `${canonical(await probeFailureEnvelope(args[2], classificationOf(error), null))}\n`,
        };
      }
    },
  };
  return w;
}

function subject(w: World) {
  return registeredProbeSubject(w.f.snapshot.payload, w.f.snapshot.payloadSeal, w.f.bootstrap.payload);
}

function nativeDeps(w: World, operation: AcquiredOperation): NativeHoldDeps {
  return {
    instance: w.f.instance,
    controller: {
      inspect: async (label) => w.f.inspection(label),
      listenerOwners: async () => [WORKER_PID],
    },
    clock,
    randomId: randomUUID,
    probeIO: w.io,
    readRelease: () => FIXTURE_RELEASE,
    request: (options) => w.request(options),
    wait: async () => {},
  } satisfies NativeHoldDeps & { operation?: AcquiredOperation } as NativeHoldDeps;
  void operation;
}

describe("registered bootstrap pilot probe chain", () => {
  it("observes a legacy loader profile with the captured config identity and no credentials in output", async () => {
    const w = await world("legacy");
    const operation = await w.f.registryOperation("inventory-pilot");
    const prepared = await preparePilotProbe(subject(w), w.io);
    const invoked = await invokePilotProbe(prepared, {
      operationId: operation.record.id,
      expectedEngine: w.f.engine,
      expectedWorker: w.f.worker,
      idle: null,
      clock,
      randomId: randomUUID,
      io: w.io,
    });
    expect(invoked.result.configIdentity).toBe(w.f.snapshot.payload.configIdentity);
    expect(invoked.result.dependencyFiles).toHaveLength(3);
    expect(w.calls).toEqual(["outer:pilot"]);
    const text = JSON.stringify(invoked.result);
    for (const secret of Object.values(DUMMY_SECRETS)) expect(text).not.toContain(secret);
    // A legacy profile can never answer an owner-correlated idle read.
    await expect(
      invokePilotProbe(prepared, {
        operationId: operation.record.id,
        expectedEngine: w.f.engine,
        expectedWorker: w.f.worker,
        idle: { expectedAdmission: "open", expectedSupervisor: w.f.descriptor(), statusRequestId: randomUUID() },
        clock,
        randomId: randomUUID,
        io: w.io,
      }),
    ).rejects.toThrow("PILOT_PROBE_ABI_UNSUPPORTED");
    await finishOperationLock(operation);
  });

  it("rejects a wrong echoed subject, changed dependencies and a changed configuration identity", async () => {
    const w = await world("legacy");
    const operation = await w.f.registryOperation("inventory-pilot");
    const base = subject(w);
    const invocation = {
      operationId: operation.record.id,
      expectedEngine: w.f.engine,
      expectedWorker: w.f.worker,
      idle: null,
      clock,
      randomId: randomUUID,
    };
    const prepared = await preparePilotProbe(base, w.io);
    const swapped: PilotProbeLaunchIO = {
      ...w.io,
      async run(node, args, env, timeout) {
        const out = await w.io.run(node, args, env, timeout);
        const parsed = JSON.parse(out.stdout) as { subject: unknown };
        parsed.subject = { kind: "registered", snapshot: { id: randomUUID(), sha256: "e".repeat(64) } };
        return { exitCode: 0, stdout: `${canonical(parsed)}\n` };
      },
    };
    await expect(invokePilotProbe(prepared, { ...invocation, io: swapped })).rejects.toThrow(
      "PILOT_PROBE_INPUT_INVALID",
    );
    await expect(
      invokePilotProbe({ ...prepared, dependencies: prepared.dependencies.slice(1) }, { ...invocation, io: w.io }),
    ).rejects.toThrow("PILOT_DEPENDENCY_MISMATCH");
    await expect(
      invokePilotProbe(
        { ...prepared, subject: { ...prepared.subject, expectedConfigIdentity: "f".repeat(64) } },
        { ...invocation, io: w.io },
      ),
    ).rejects.toThrow("PILOT_CONFIGURATION_MISMATCH");
    // A different expected worker generation fails OS corroboration inside the probe.
    await expect(
      invokePilotProbe(prepared, { ...invocation, expectedWorker: { ...w.f.worker, startTime: "other" }, io: w.io }),
    ).rejects.toThrow("PILOT_ADMISSION_MISMATCH");
    await finishOperationLock(operation);
  });

  it("the packaged historical layout goes through the exact handshake; an old or mismatched release is unsupported", async () => {
    const w = await world("packaged");
    const operation = await w.f.registryOperation("inventory-pilot");
    const prepared = await preparePilotProbe(subject(w), w.io);
    const invocation = {
      operationId: operation.record.id,
      expectedEngine: w.f.engine,
      expectedWorker: w.f.worker,
      idle: null,
      clock,
      randomId: randomUUID,
      io: w.io,
    };
    const ok = await invokePilotProbe(prepared, invocation);
    expect(w.calls).toEqual(["outer:pilot", "historical:pilot-abi", "historical:pilot-abi-v1"]);
    expect(ok.result.sdk).toMatchObject({ port: SDK_PORT, rootStatus: 200, agentName: "hive-voice" });
    w.handshakeRelease = { ...FIXTURE_RELEASE, packageVersion: "0.9.0" };
    await expect(invokePilotProbe(prepared, invocation)).rejects.toThrow("PILOT_PROBE_ABI_UNSUPPORTED");
    w.handshakeRelease = FIXTURE_RELEASE;
    const inventory = await invokePilotInventory(prepared, { ...invocation, idle: null });
    expect(inventory.result.counts).toMatchObject({ rooms: 1, dispatches: 1, rules: 1 });
    expect(inventory.result.evidenceDigest).toBe(
      sha256Canonical({
        items: inventory.result.items,
        counts: inventory.result.counts,
        limitations: inventory.result.limitations,
      }),
    );
    await finishOperationLock(operation);
  });
});

describe("native historical hold adapter", () => {
  async function held(w: World, operation: AcquiredOperation) {
    const recordIntent = async ({ seal, bootId }: { seal: typeof w.f.worker; bootId: string }) => {
      w.calls.push("intent");
      operation.record.registry!.barrier = {
        operationId: operation.record.id,
        supervisor: seal,
        bootId,
        descriptor: null,
        healthListenerPort: SDK_PORT,
        state: "close-intended",
        terminalEvidence: null,
      };
      await persistOperation(operation);
    };
    return establishNativeHold({
      subject: {
        snapshot: w.f.snapshot.payload,
        generation: {
          engine: { pid: ENGINE_PID, startTime: w.f.engine.startTime },
          worker: { pid: WORKER_PID, startTime: w.f.worker.startTime },
        },
      },
      probe: subject(w),
      operation,
      recordIntent,
      deps: nativeDeps(w, operation),
    });
  }

  it("corroborates capability only from current runtime evidence, never from the record", async () => {
    const legacy = await world("legacy");
    const generation = {
      engine: { pid: ENGINE_PID, startTime: legacy.f.engine.startTime },
      worker: { pid: WORKER_PID, startTime: legacy.f.worker.startTime },
    };
    const operation = await legacy.f.registryOperation("prepare-legacy-hold");
    await expect(
      corroborateNativeCapability({ snapshot: legacy.f.snapshot.payload, generation }, nativeDeps(legacy, operation)),
    ).rejects.toMatchObject({ code: "NATIVE_CAPABILITY_UNCORROBORATED" });
    await finishOperationLock(operation);

    const w = await world("packaged");
    const op = await w.f.registryOperation("prepare-legacy-hold");
    const deps = nativeDeps(w, op);
    await expect(
      corroborateNativeCapability({ snapshot: w.f.snapshot.payload, generation }, deps),
    ).resolves.toMatchObject({ worker: { pid: WORKER_PID } });
    w.f.writeDescriptor(w.f.descriptor({ pid: 9999 }));
    await expect(
      corroborateNativeCapability({ snapshot: w.f.snapshot.payload, generation }, deps),
    ).rejects.toMatchObject({
      code: "NATIVE_CAPABILITY_UNCORROBORATED",
    });
    w.f.writeDescriptor();
    await expect(
      corroborateNativeCapability(
        { snapshot: w.f.snapshot.payload, generation },
        { ...deps, controller: { ...deps.controller, listenerOwners: async () => [4444] } },
      ),
    ).rejects.toMatchObject({ code: "NATIVE_CAPABILITY_UNCORROBORATED" });
    await expect(
      corroborateNativeCapability(
        { snapshot: w.f.snapshot.payload, generation },
        { ...deps, readRelease: () => ({ ...FIXTURE_RELEASE, packageVersion: "2.0.0" }) },
      ),
    ).rejects.toMatchObject({ code: "NATIVE_CAPABILITY_UNCORROBORATED" });
    await finishOperationLock(op);
  });

  it("closes under the owning operation, quiesces on fresh owner-correlated reads and stops only at dispatch", async () => {
    const w = await world("packaged");
    const operation = await w.f.registryOperation("prepare-legacy-hold");
    const hold = await held(w, operation);
    expect(w.state).toMatchObject({ admission: "closed", owner: operation.record.id });
    const intent = w.calls.indexOf("intent");
    const close = w.calls.findIndex((call) => call.startsWith("close:"));
    expect(intent).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(intent);
    // The baseline read happened before intent; every status UUID is distinct.
    expect(w.calls.slice(0, intent).some((call) => call === "status:other:open")).toBe(true);
    const ids = w.calls.filter((call) => call.startsWith("status-id:"));
    expect(new Set(ids).size).toBe(ids.length);

    let signals = 0;
    const outcome = await stopPilotWorkerUnderHold({
      session: hold.session,
      operationId: operation.record.id,
      clock,
      randomId: randomUUID,
      persistSignalsBegun: async () => {},
      controller: {
        bootout: async (_definition, options) => {
          options.beforeExec?.();
          signals += 1;
        },
      },
      workerDefinition: w.f.definitions.worker,
      healthListenerPort: SDK_PORT,
    });
    expect(outcome).toMatchObject({ kind: "stopped" });
    expect(signals).toBe(1);
    await hold.session.release();
    expect(w.state.admission).toBe("open");
    await finishOperationLock(operation);
  });

  it("a nonzero baseline defers before any close; nonzero or stale after close releases the same owner", async () => {
    const w = await world("packaged");
    const operation = await w.f.registryOperation("prepare-legacy-hold");
    w.state.jobs = 1;
    await expect(held(w, operation)).rejects.toBeInstanceOf(DeferredMaintenance);
    expect(w.calls.some((call) => call.startsWith("close:"))).toBe(false);
    expect(w.state.admission).toBe("open");

    w.state.jobs = 0;
    w.calls.length = 0;
    operation.record.registry!.barrier = null;
    await persistOperation(operation);
    w.state.heartbeatAge = 1_000;
    const original = w.request;
    w.request = async (options) => {
      const reply = await original(options);
      if (options.kind === "close") w.state.heartbeatAge = 120_000; // heartbeat stale after close
      return reply;
    };
    await expect(held(w, operation)).rejects.toBeInstanceOf(DeferredMaintenance);
    expect(w.calls.some((call) => call.startsWith("close:"))).toBe(true);
    expect(w.calls.some((call) => call.startsWith("release:owner"))).toBe(true);
    expect(w.state).toMatchObject({ admission: "open", owner: null });
    await finishOperationLock(operation);
  });
});
