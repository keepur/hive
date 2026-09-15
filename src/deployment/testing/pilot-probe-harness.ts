/**
 * In-process pilot probe chain for KPR-463 S7 unit tests: the frozen launch IO
 * runs the real outer `pilot`/`pilot-inventory` implementation, which runs the
 * real historical `pilot-abi`/`pilot-abi-v1` implementation, against the
 * disposable fixture. Only OS/vendor/ledger boundaries are fakes; nothing
 * returns ready-made probe results.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonical } from "../canonical.js";
import {
  probeFailureEnvelope,
  runHistoricalProbe,
  runPilotAbiHandshake,
  type HistoricalProbeDeps,
  type LivekitReader,
  type PilotProbeBoundaries,
} from "../historical-probe.js";
import { nodePilotProbeLaunchIO, type PilotProbeLaunchIO } from "../pilot-observer.js";
import { runPilotProfileProbe, type OuterProbeDeps } from "../pilot-profile-probe.js";
import { classificationOf, resolveRequiredDependencies } from "../pilot-probe.js";
import { sha256Hex } from "../pilot-records.js";
import type { Release } from "../release.js";
import type { MaintenanceReply, RequestMaintenanceOptions } from "../../voice-worker/maintenance-ipc.js";
import {
  DUMMY_SECRETS,
  ENGINE_PID,
  FIXTURE_RELEASE,
  FIXTURE_START,
  WORKER_PID,
  type PilotFixture,
} from "./pilot-fixture.js";

export interface ProbeHarnessState {
  admission: "open" | "closed";
  owner: string | null;
  jobs: number;
  activeCalls: number;
  heartbeatAge: number;
  bridgeAuthenticated: boolean;
}

export interface ProbeHarness {
  calls: string[];
  state: ProbeHarnessState;
  io: PilotProbeLaunchIO;
  reader: LivekitReader;
  handshakeRelease: Release;
  request(options: RequestMaintenanceOptions): Promise<MaintenanceReply>;
}

export function createProbeHarness(f: PilotFixture): ProbeHarness {
  const calls: string[] = [];
  const state: ProbeHarnessState = {
    admission: "open",
    owner: null,
    jobs: 0,
    activeCalls: 0,
    heartbeatAge: 1_000,
    bridgeAuthenticated: true,
  };
  const h: ProbeHarness = {
    calls,
    state,
    io: nodePilotProbeLaunchIO,
    handshakeRelease: FIXTURE_RELEASE,
    reader: {
      listRooms: async () => [{ sid: "RM_raw", name: "room" }],
      listParticipants: async () => [],
      listDispatch: async () => [{ id: "AD_raw", agentName: "hive-voice" }],
      listSipDispatchRule: async () => [
        { sipDispatchRuleId: "SDR_raw", roomConfig: { agents: [{ agentName: "hive-voice" }] } },
      ],
      listSipInboundTrunk: async () => [],
    },
    async request(options) {
      calls.push(`${options.kind}:${options.expectedAdmission}`);
      if (options.kind === "close") {
        if (state.owner !== null && state.owner !== options.operationId) throw new Error("owned by another operation");
        state.admission = "closed";
        state.owner = options.operationId;
      } else if (options.kind === "release") {
        if (state.owner !== null && state.owner !== options.operationId) throw new Error("owned by another operation");
        state.admission = "open";
        state.owner = null;
      }
      if (options.expectedAdmission !== undefined && options.expectedAdmission !== "any") {
        if (options.expectedAdmission !== state.admission) throw new Error("stale or mismatched maintenance reply");
      }
      const requestId = options.randomId ? options.randomId() : randomUUID();
      const supervisor = { pid: WORKER_PID, bootId: f.descriptor().bootId };
      return {
        protocol: 1,
        requestId,
        operationId: options.operationId,
        supervisor,
        ok: true,
        snapshot: {
          supervisor,
          operationId: state.owner,
          admission: state.admission,
          persistenceFault: false,
          unresolved: [],
          childPids: [],
        },
        writtenAt: Date.now(),
      };
    },
  };
  const boundaries = (env: NodeJS.ProcessEnv, selfPath: string): PilotProbeBoundaries => ({
    now: Date.now,
    uid: () => f.instance.uid,
    selfPath,
    env,
    serviceEnvironment: (e) =>
      Object.fromEntries(Object.entries(e).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    readRelease: () => FIXTURE_RELEASE,
    processIdentity: async (pid) =>
      pid === ENGINE_PID
        ? { ...f.engine, ppid: 1 }
        : pid === WORKER_PID
          ? { ...f.worker, ppid: 1 }
          : pid === process.pid
            ? { pid, ppid: 1, startTime: FIXTURE_START, command: "helper", executable: "/node", cwd: "/" }
            : null,
    listenerOwners: async () => [WORKER_PID],
    probeBridge: async (_url, token) => ({
      authenticated: state.bridgeAuthenticated && token === DUMMY_SECRETS.bridgeToken,
      missingDenied: true,
      wrongDenied: true,
      correctStatus: state.bridgeAuthenticated ? 400 : 401,
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
    requestMaintenance: (options) => h.request(options),
    livekit: async () => h.reader,
    resolveDependencies: resolveRequiredDependencies,
    sha256File: async (path) => sha256Hex(await readFile(path)),
  });
  const historicalDeps = (env: NodeJS.ProcessEnv): HistoricalProbeDeps => ({
    ...boundaries(env, f.loaderPath),
    readRelease: () => h.handshakeRelease,
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
        const envelope = await probeFailureEnvelope(args[2], classificationOf(error), "hive-pilot-probe/1");
        return { exitCode: 1, stdout: `${canonical(envelope)}\n` };
      }
    },
    writeRequest: nodePilotProbeLaunchIO.writeRequest,
    importLegacyLoader: async () => () => f.loaderConfig,
    livekitFrom: async () => h.reader,
  });
  h.io = {
    ...nodePilotProbeLaunchIO,
    async run(_node, args, env) {
      if (args[0] !== f.bootstrapProbe) throw new Error("pilot probes run only the registered bootstrap probe");
      calls.push(`outer:${args[1]}`);
      try {
        const output = await runPilotProfileProbe(args[1] as "pilot" | "pilot-inventory", args[2]!, outerDeps(env));
        return { exitCode: 0, stdout: `${canonical(output)}\n` };
      } catch (error) {
        const envelope = await probeFailureEnvelope(args[2], classificationOf(error), null);
        return { exitCode: 1, stdout: `${canonical(envelope)}\n` };
      }
    },
  };
  return h;
}
