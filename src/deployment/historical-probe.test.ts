import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { acquireOperation, persistOperation, type AcquiredOperation } from "./operation.js";
import {
  collectLivekitInventory,
  runHistoricalProbe,
  runPilotAbiHandshake,
  type HistoricalProbeDeps,
  type LivekitReader,
} from "./historical-probe.js";
import { initialRegistryWork } from "./pilot.js";
import {
  countInventory,
  decodeHistoricalInventory,
  decodeHistoricalObservation,
  decodeHistoricalProbeRequest,
  decodePilotAbiHandshake,
  historicalIdleFault,
  historicalRequestPath,
  resolveRequiredDependencies,
  sameDependencySet,
  type HistoricalProbeRequest,
} from "./pilot-probe.js";
import { canonicalBytes, sealFile, sha256Hex, type FileSeal, type InstanceKey } from "./pilot-records.js";
import { writeNativeFixtureArtifacts } from "./testing/pilot-fixture.js";
import type { Release } from "./release.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const UID = process.getuid!();
const BOOT = "33333333-3333-4333-8333-333333333333";
const SDK_PORT = 3108;
const WORKER_PID = 4242;
const RELEASE: Release = {
  schemaVersion: 1,
  packageVersion: "1.2.3",
  sourceRevision: "c".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: "d".repeat(64),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};
const SECRETS = { token: "dummy-bridge-token", key: "dummy-api-key", secret: "dummy-api-secret" };
const identity = () => ({
  release: RELEASE,
  component: "voice-worker" as const,
  pid: WORKER_PID,
  bootId: BOOT,
  startedAt: new Date(Date.UTC(2026, 8, 14, 10)).toISOString(),
});

async function strip(path: string, allowRoot = false): Promise<FileSeal> {
  const { bytes: _bytes, ...seal } = await sealFile(path, { uid: UID, allowRoot });
  void _bytes;
  return seal;
}

interface Fixture {
  base: string;
  home: string;
  instance: InstanceKey;
  operation: AcquiredOperation;
  probePath: string;
  dependency: string;
  write(
    overrides?: Partial<HistoricalProbeRequest>,
    mode?: number,
  ): Promise<{ path: string; request: HistoricalProbeRequest }>;
  deps(now: () => number, overrides?: Partial<HistoricalProbeDeps>): HistoricalProbeDeps & { calls: string[] };
}

async function fixture(): Promise<Fixture> {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-historical-")));
  roots.push(base);
  chmodSync(base, 0o755);
  const home = resolve(base, "instance");
  mkdirSync(home, { mode: 0o755 });
  const configPath = resolve(home, "hive.yaml");
  writeFileSync(configPath, "instance:\n  id: dodi\n", { mode: 0o644 });
  const instance: InstanceKey = { canonicalHome: home, configPath, instanceId: "dodi", uid: UID };
  const historical = resolve(base, "historical");
  mkdirSync(resolve(historical, "pkg"), { recursive: true, mode: 0o755 });
  const probePath = resolve(historical, "pkg", "runtime-probe.min.js");
  writeFileSync(probePath, "// historical probe\n", { mode: 0o644 });
  const dependency = resolve(historical, "node_modules/livekit-server-sdk/index.js");
  mkdirSync(resolve(dependency, ".."), { recursive: true, mode: 0o755 });
  writeFileSync(dependency, "module.exports = {};\n", { mode: 0o644 });
  const operation = await acquireOperation({
    instanceHome: home,
    instanceId: "dodi",
    mode: "prepare-legacy-hold",
    workKind: "registry",
    registry: initialRegistryWork("prepare-legacy-hold"),
    toolSha256: "a".repeat(64),
    ownerStartTime: "start",
  });
  mkdirSync(resolve(home, ".hive-state", "runtime"), { recursive: true });
  writeFileSync(resolve(home, ".hive-state", "runtime", "voice-worker.json"), JSON.stringify(identity()));
  const env = { HIVE_HOME: home, HIVE_CONFIG: configPath, HOME: base, PATH: "/usr/bin:/bin" };
  return {
    base,
    home,
    instance,
    operation,
    probePath,
    dependency,
    async write(overrides = {}, mode = 0o600) {
      const now = Date.now();
      const request: HistoricalProbeRequest = {
        schemaVersion: 1,
        abi: "hive-pilot-probe/1",
        action: "observe",
        requestId: randomUUID(),
        operationId: operation.record.id,
        subject: { kind: "registered", snapshot: { id: randomUUID(), sha256: "b".repeat(64) } },
        instance,
        requestedAt: now,
        deadline: now + 2_000,
        expectedRelease: RELEASE,
        expectedProbe: await strip(probePath),
        sdkPort: SDK_PORT,
        dependencyFiles: [await strip(dependency)],
        idle: null,
        ...overrides,
      };
      const path = historicalRequestPath(home, request);
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, canonicalBytes(request), { mode });
      return { path, request };
    },
    deps(now, overrides = {}) {
      const calls: string[] = [];
      const value: HistoricalProbeDeps & { calls: string[] } = {
        calls,
        now,
        uid: () => UID,
        selfPath: probePath,
        env,
        serviceEnvironment: () => env,
        readRelease: () => RELEASE,
        processIdentity: async (pid) => ({
          pid,
          ppid: 1,
          startTime: "Mon Sep 14 10:00:00 2026",
          command: "node",
          executable: "/node",
          cwd: home,
        }),
        listenerOwners: async () => [WORKER_PID],
        probeBridge: async (_url, token) => {
          calls.push(`bridge:${token === SECRETS.token}`);
          return {
            authenticated: true,
            missingDenied: true,
            wrongDenied: true,
            correctStatus: 400,
            missingStatus: 401,
            wrongStatus: 403,
          };
        },
        probeWorkerHttp: async () => ({ rootStatus: 200, agentName: "hive-voice", activeJobs: 0 }),
        readTelemetry: async (_wc, request) => ({
          queryStartedAt: now(),
          queryFinishedAt: now(),
          supervisorIdentity: identity(),
          supervisorUpdatedAt: request.requestedAt - 1_000,
          activeCalls: 0,
        }),
        requestMaintenance: async (options) => {
          calls.push(`${options.kind}:${options.operationId}:${options.expectedAdmission}`);
          return {
            protocol: 1,
            requestId: options.randomId!(),
            operationId: options.operationId,
            supervisor: { pid: WORKER_PID, bootId: BOOT },
            ok: true,
            snapshot: {
              supervisor: { pid: WORKER_PID, bootId: BOOT },
              operationId: options.expectedAdmission === "closed" ? options.operationId : null,
              admission: options.expectedAdmission as "open" | "closed",
              persistenceFault: false,
              unresolved: [],
              childPids: [],
            },
            writtenAt: now(),
          };
        },
        livekit: async () => reader(),
        resolveDependencies: () => [{ path: dependency, realpath: dependency, version: "2.14.1" }],
        sha256File: async (path) => sha256Hex(await import("node:fs/promises").then((fs) => fs.readFile(path))),
        loadWorkerConfig: async () => ({
          instanceHome: home,
          instanceId: "dodi",
          healthPort: SDK_PORT,
          mongoUri: "mongodb://dummy-user:dummy-pass@127.0.0.1:1",
          mongoDbName: "hive",
          sipTrunkId: "ST_dummy",
          inboundAgents: { "+15550000000": "rae" },
          agentVoices: {},
          defaultStt: "deepgram/flux-general-en",
          defaultTts: "cartesia/sonic-3",
          bridgeUrl: "http://127.0.0.1:3107/v1/chat/completions",
          bridgeToken: SECRETS.token,
          livekitUrl: "wss://dummy.livekit.invalid",
          livekitApiKey: SECRETS.key,
          livekitApiSecret: SECRETS.secret,
        }),
        serverSdkVersion: () => "2.14.1",
        ...overrides,
      };
      return value;
    },
  };
}

function reader(overrides: Partial<LivekitReader> = {}): LivekitReader {
  return {
    listRooms: async () => [{ sid: "RM_raw", name: "room-a" }],
    listParticipants: async () => [{ sid: "PA_raw" }],
    listDispatch: async () => [{ id: "AD_raw", agentName: "hive-voice" }],
    listSipDispatchRule: async (page) =>
      page.afterId === ""
        ? [
            {
              sipDispatchRuleId: "SDR_raw",
              roomConfig: { agents: [{ agentName: "hive-voice" }, { agentName: "other" }] },
            },
          ]
        : [],
    listSipInboundTrunk: async () => [{ sipTrunkId: "ST_raw" }],
    ...overrides,
  };
}

describe("historical ABI wire decoders", () => {
  it("accepts only the exact handshake and fails any other ABI, projection or SDK as unsupported", () => {
    const handshake = {
      schemaVersion: 1,
      abi: "hive-pilot-probe/1",
      projection: 1,
      serverSdk: "2.14.1",
      operations: ["observe", "inventory"],
      release: RELEASE,
    };
    expect(decodePilotAbiHandshake(handshake).release).toEqual(RELEASE);
    for (const bad of [
      { ...handshake, abi: "hive-pilot-probe/2" },
      { ...handshake, projection: 2 },
      { ...handshake, serverSdk: "2.15.0" },
      { ...handshake, operations: ["observe"] },
      { ...handshake, extra: true },
    ]) {
      expect(() => decodePilotAbiHandshake(bad)).toThrow();
    }
    expect(() => decodePilotAbiHandshake({ ...handshake, abi: "hive-pilot-probe/2" })).toThrow(
      "PILOT_PROBE_ABI_UNSUPPORTED",
    );
  });

  it("refuses an inventory request carrying idle, an overlong deadline and reused IDs", async () => {
    const f = await fixture();
    const { request } = await f.write();
    expect(decodeHistoricalProbeRequest(JSON.parse(JSON.stringify(request))).action).toBe("observe");
    expect(() =>
      decodeHistoricalProbeRequest({
        ...request,
        action: "inventory",
        idle: { expectedAdmission: "open", expectedSupervisor: identity(), statusRequestId: randomUUID() },
      }),
    ).toThrow("PILOT_PROBE_INPUT_INVALID");
    expect(() => decodeHistoricalProbeRequest({ ...request, deadline: request.requestedAt + 2_001 })).toThrow();
    expect(
      decodeHistoricalProbeRequest({ ...request, action: "inventory", deadline: request.requestedAt + 30_000 }),
    ).toBeTruthy();
    expect(() =>
      decodeHistoricalProbeRequest({
        ...request,
        idle: { expectedAdmission: "open", expectedSupervisor: identity(), statusRequestId: request.requestId },
      }),
    ).toThrow("PILOT_PROBE_INPUT_INVALID");
  });

  it("compares dependency sets exactly and resolves required modules only inside sealed roots", async () => {
    const f = await fixture();
    for (const name of ["livekit-server-sdk", "@livekit/agents", "@livekit/rtc-node"]) {
      const root = resolve(f.base, "historical/node_modules", name);
      mkdirSync(root, { recursive: true, mode: 0o755 });
      writeFileSync(resolve(root, "package.json"), JSON.stringify({ name, version: "9.9.9", main: "index.js" }));
      writeFileSync(resolve(root, "index.js"), "module.exports = {};\n");
    }
    writeNativeFixtureArtifacts(resolve(f.base, "historical"));
    const resolved = resolveRequiredDependencies(f.probePath, [resolve(f.base, "historical")]);
    expect(resolved.slice(0, 3).map((item) => item.version)).toEqual(["9.9.9", "9.9.9", "9.9.9"]);
    // The native artifacts the worker loads are captured too — a JS-only set
    // would miss a stale addon, shared library or model swap.
    const natives = resolved.slice(3).map((item) => relative(resolve(f.base, "historical"), item.realpath));
    expect(natives).toContain(
      `node_modules/@livekit/rtc-ffi-bindings-${process.platform}-${process.arch}/rtc-node.${process.platform}-${process.arch}.node`,
    );
    expect(natives).toContain(
      `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/libonnxruntime.1.24.3.dylib`,
    );
    expect(natives).toContain(
      `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`,
    );
    expect(natives).toContain("node_modules/@livekit/agents-plugin-silero/dist/silero_vad.onnx");
    expect(natives).toContain("node_modules/@livekit/agents-plugin-silero/src/silero_vad.onnx");
    // Another platform's ONNX payload is never captured.
    expect(natives.some((path) => path.includes("napi-v6/linux/x64"))).toBe(false);
    expect(() => resolveRequiredDependencies(f.probePath, [resolve(f.base, "elsewhere")])).toThrow(
      "PILOT_DEPENDENCY_MISMATCH",
    );
    // A missing native artifact fails the capture, never silently shrinks it.
    rmSync(resolve(f.base, "historical/node_modules/@livekit/agents-plugin-silero"), { recursive: true, force: true });
    expect(() => resolveRequiredDependencies(f.probePath, [resolve(f.base, "historical")])).toThrow(
      "PILOT_DEPENDENCY_MISMATCH",
    );
    expect(sameDependencySet([{ realpath: "/a", sha256: "1" }], [{ realpath: "/a", sha256: "1" }])).toBe(true);
    expect(sameDependencySet([{ realpath: "/a", sha256: "1" }], [{ realpath: "/a", sha256: "2" }])).toBe(false);
    expect(sameDependencySet([], [{ realpath: "/a", sha256: "1" }])).toBe(false);
  });
});

describe("LiveKit inventory normalization", () => {
  it("emits only salted digests and safe agent names, one item per distinct SIP rule agent", async () => {
    const operationId = randomUUID();
    const items = await collectLivekitInventory(reader(), operationId);
    const text = JSON.stringify(items);
    for (const raw of ["RM_raw", "PA_raw", "AD_raw", "SDR_raw", "ST_raw", "room-a"]) expect(text).not.toContain(raw);
    expect(countInventory(items)).toEqual({ rooms: 1, participants: 1, dispatches: 1, rules: 1, inboundTrunks: 1 });
    expect(items.filter((item) => item.kind === "sip-rule").map((item) => item.agentName)).toEqual([
      "hive-voice",
      "other",
    ]);
    const other = await collectLivekitInventory(reader(), randomUUID());
    expect(other[0].id).not.toBe(items[0].id);
  });

  it("follows the pinned cursor, and fails closed on a repeated cursor, denial or partial rows", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ sipTrunkId: `ST_${start + index}` }));
    const paged = await collectLivekitInventory(
      reader({
        listSipInboundTrunk: async ({ afterId }) =>
          afterId === "" ? page(0, 100) : afterId === "ST_99" ? page(100, 3) : [],
      }),
      randomUUID(),
    );
    expect(countInventory(paged).inboundTrunks).toBe(103);
    await expect(
      collectLivekitInventory(reader({ listSipInboundTrunk: async () => page(0, 100) }), randomUUID()),
    ).rejects.toThrow("PILOT_INVENTORY_INCOMPLETE");
    await expect(
      collectLivekitInventory(
        reader({
          listRooms: async () => {
            throw new Error("permission denied");
          },
        }),
        randomUUID(),
      ),
    ).rejects.toThrow("PILOT_INVENTORY_INCOMPLETE");
    await expect(
      collectLivekitInventory(reader({ listParticipants: async () => [{ sid: "" }] }), randomUUID()),
    ).rejects.toThrow("PILOT_INVENTORY_INCOMPLETE");
  });
});

describe("historical pilot-abi modes inside the historical loader process", () => {
  it("handshakes with its own release and rejects a non-pinned server SDK", async () => {
    const f = await fixture();
    const handshake = await runPilotAbiHandshake(f.deps(Date.now));
    expect(handshake).toMatchObject({ abi: "hive-pilot-probe/1", serverSdk: "2.14.1", release: RELEASE });
    await expect(runPilotAbiHandshake(f.deps(Date.now, { serverSdkVersion: () => "2.13.0" }))).rejects.toThrow(
      "PILOT_PROBE_ABI_UNSUPPORTED",
    );
  });

  it("observes through its own loader and never emits credentials or the Mongo URI", async () => {
    const f = await fixture();
    const { path, request } = await f.write();
    const deps = f.deps(() => request.requestedAt + 5);
    const result = decodeHistoricalObservation(
      JSON.parse(JSON.stringify(await runHistoricalProbe(path, deps))) as unknown,
    );
    expect(result).toMatchObject({ requestId: request.requestId, idle: null, sdk: { port: SDK_PORT, activeJobs: 0 } });
    expect(result.bridge).toEqual({
      correctStatus: 400,
      correctClassification: "missing-agent",
      missingStatus: 401,
      wrongStatus: 403,
    });
    expect(deps.calls).toContain("bridge:true");
    const text = JSON.stringify(result);
    for (const secret of [...Object.values(SECRETS), "dummy-pass", "mongodb://", "+15550000000"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reads owner-correlated closed status only after this operation recorded its close", async () => {
    const f = await fixture();
    const idle = {
      expectedAdmission: "closed" as const,
      expectedSupervisor: identity(),
      statusRequestId: randomUUID(),
    };
    const early = await f.write({ idle });
    await expect(
      runHistoricalProbe(
        early.path,
        f.deps(() => early.request.requestedAt + 5),
      ),
    ).rejects.toThrow("PILOT_ADMISSION_MISMATCH");
    f.operation.record.registry!.barrier = {
      operationId: f.operation.record.id,
      supervisor: { pid: WORKER_PID, startTime: "s", executable: "/node", command: "node", cwd: f.home },
      bootId: BOOT,
      descriptor: null,
      healthListenerPort: SDK_PORT,
      state: "closed",
      terminalEvidence: null,
    };
    await persistOperation(f.operation);
    const closed = await f.write({ idle: { ...idle, statusRequestId: randomUUID() } });
    const deps = f.deps(() => closed.request.requestedAt + 5);
    const result = (await runHistoricalProbe(closed.path, deps)) as ReturnType<typeof decodeHistoricalObservation>;
    expect(deps.calls).toContain(`status:${f.operation.record.id}:closed`);
    expect(result.idle?.status.reply.requestId).toBe(closed.request.idle!.statusRequestId);
    expect(
      historicalIdleFault(result.idle!, { ...closed.request, idle: closed.request.idle! }, RELEASE, result),
    ).toBeNull();
    // An open baseline read is refused once this operation has closed.
    const open = await f.write({ idle: { ...idle, expectedAdmission: "open", statusRequestId: randomUUID() } });
    await expect(
      runHistoricalProbe(
        open.path,
        f.deps(() => open.request.requestedAt + 5),
      ),
    ).rejects.toThrow("PILOT_ADMISSION_MISMATCH");
  });

  it("fails closed on wrong release, swapped probe, changed dependencies, bridge denial, port mismatch or unsafe input", async () => {
    const f = await fixture();
    const now = (request: HistoricalProbeRequest) => () => request.requestedAt + 5;
    const a = await f.write();
    await expect(
      runHistoricalProbe(
        a.path,
        f.deps(now(a.request), { readRelease: () => ({ ...RELEASE, packageVersion: "9.9.9" }) }),
      ),
    ).rejects.toThrow("PILOT_DEPENDENCY_MISMATCH");
    const b = await f.write();
    await expect(runHistoricalProbe(b.path, f.deps(now(b.request), { selfPath: f.dependency }))).rejects.toThrow(
      "PILOT_DEPENDENCY_MISMATCH",
    );
    const c = await f.write();
    await expect(
      runHistoricalProbe(c.path, f.deps(now(c.request), { sha256File: async () => "e".repeat(64) })),
    ).rejects.toThrow("PILOT_DEPENDENCY_MISMATCH");
    const d = await f.write();
    await expect(
      runHistoricalProbe(
        d.path,
        f.deps(now(d.request), {
          probeBridge: async () => ({
            authenticated: false,
            missingDenied: true,
            wrongDenied: true,
            correctStatus: 401,
            missingStatus: 401,
            wrongStatus: 401,
          }),
        }),
      ),
    ).rejects.toThrow("PILOT_BRIDGE_FAILED");
    const e = await f.write({ sdkPort: SDK_PORT + 1 });
    await expect(runHistoricalProbe(e.path, f.deps(now(e.request)))).rejects.toThrow("PILOT_CONFIGURATION_MISMATCH");
    const g = await f.write({}, 0o644);
    await expect(runHistoricalProbe(g.path, f.deps(now(g.request)))).rejects.toThrow("PILOT_PROBE_INPUT_INVALID");
    const h = await f.write();
    await expect(
      runHistoricalProbe(
        h.path,
        f.deps(now(h.request), {
          loadWorkerConfig: async () => {
            throw new Error("voice worker missing required config: bridgeToken");
          },
        }),
      ),
    ).rejects.toThrow("PILOT_LOADER_UNAVAILABLE");
  });

  it("inventories through its own loader with counts matching the normalized items", async () => {
    const f = await fixture();
    const now = Date.now();
    const { path, request } = await f.write({
      action: "inventory",
      requestedAt: now,
      deadline: now + 30_000,
      dependencyFiles: [],
    });
    const result = decodeHistoricalInventory(
      JSON.parse(
        JSON.stringify(
          await runHistoricalProbe(
            path,
            f.deps(() => request.requestedAt + 5),
          ),
        ),
      ) as unknown,
    );
    expect(result.counts).toEqual({ rooms: 1, participants: 1, dispatches: 1, rules: 1, inboundTrunks: 1 });
    expect(result.limitations).toEqual(["EXTERNAL_PRODUCERS_UNFENCED", "PENDING_ASSIGNMENTS_UNOBSERVABLE"]);
    expect(() => decodeHistoricalInventory({ ...result, counts: { ...result.counts, rooms: 0 } })).toThrow(
      "PILOT_INVENTORY_INCOMPLETE",
    );
  });
});
