import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireOperation,
  directoryIdentity,
  finishOperationLock,
  OperationBusyError,
  OperationUnresolvedError,
  persistOperation,
  transferOwnershipToFrozen,
  type AcquiredOperation,
  type OperationRecord,
} from "./operation.js";
import { capturePrior } from "./prior.js";
import {
  inspectOrReconcile,
  lifecycleInterruptedIO,
  PREVIOUS_OPERATION_RECONCILED,
  runReconcileOperation,
  type LifecycleReconcileDeps,
  type ReconcileHostIO,
} from "./reconcile.js";
import {
  buildServiceDefinitions,
  buildServiceEnvironment,
  type ServiceInspection,
  type ServiceSnapshot,
} from "./services.js";
import type { MaintenanceReply } from "../voice-worker/maintenance-ipc.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HELPER = Buffer.from("// frozen helper bytes\n");
const HELPER_SHA = createHash("sha256").update(HELPER).digest("hex");
const SUPERVISOR_BOOT = "11111111-1111-4111-8111-111111111111";

interface Fixture {
  root: string;
  operation: AcquiredOperation;
  pair: ReturnType<typeof buildServiceDefinitions>;
  snapshot: ServiceSnapshot;
}

function inspection(
  definition: ReturnType<typeof buildServiceDefinitions>["engine"],
  pid: number | null,
  loaded = pid !== null,
): ServiceInspection {
  return {
    label: definition.label,
    loaded,
    enabled: true,
    livePID: pid,
    startTime: pid === null ? null : `start-${pid}`,
    args: [definition.nodePath, definition.entrypoint, ...definition.args],
    cwd: definition.hiveHome,
    configSelection: definition.configPath,
    serviceEnvironment: buildServiceEnvironment(definition),
    plist: null,
    link: null,
    process:
      pid === null
        ? null
        : {
            pid,
            ppid: 1,
            startTime: `start-${pid}`,
            command: [definition.nodePath, definition.entrypoint, ...definition.args].join(" "),
            executable: definition.nodePath,
            cwd: definition.hiveHome,
          },
  };
}

async function fixture(mutate?: (record: OperationRecord) => void): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "reconcile-"));
  roots.push(root);
  writeFileSync(resolve(root, "hive.yaml"), "instance:\n  id: dodi\n");
  const operation = await acquireOperation({
    instanceHome: root,
    instanceId: "dodi",
    mode: "update",
    toolSha256: HELPER_SHA,
    ownerStartTime: "parent-start",
    ownerPid: 111,
  });
  const home = operation.record.canonicalHome;
  writeFileSync(resolve(operation.paths.operationDirectory, "deploy.min.js"), HELPER);
  await transferOwnershipToFrozen(
    operation,
    { pid: 222, startTime: "frozen-start" },
    { pid: 111, startTime: "parent-start" },
  );
  mkdirSync(resolve(home, ".hive"));
  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: "/opt/node/bin/node",
    hiveHome: home,
    configPath: resolve(home, "hive.yaml"),
    home: "/Users/example",
    pathEnv: "/usr/bin:/bin",
  });
  const snapshot: ServiceSnapshot = {
    services: [pair.engine, pair.worker].map((definition, index) => ({
      definition,
      inspection: inspection(definition, 500 + index),
      plist: {
        path: resolve(home, "service", `${definition.label}.plist`),
        existed: true,
        bytes: Buffer.from(definition.label),
        mode: 0o600,
      },
      instancePlist: {
        path: resolve(home, "service", `${definition.label}.plist`),
        existed: true,
        bytes: Buffer.from(definition.label),
        mode: 0o600,
      },
      link: {
        path: `/Users/example/Library/LaunchAgents/${definition.label}.plist`,
        existed: true,
        target: resolve(home, "service", `${definition.label}.plist`),
      },
      loaded: true,
      enabled: true,
    })),
  };
  operation.record.priorProfile = "packaged";
  await capturePrior({ operation, services: snapshot, configPath: resolve(home, "hive.yaml"), workerHealthPort: 3107 });
  mutate?.(operation.record);
  await persistOperation(operation);
  return { root, operation, pair, snapshot };
}

function host(live: Record<number, string>, overrides: Partial<ReconcileHostIO> = {}): ReconcileHostIO {
  return {
    processStartTime: async (pid) => live[pid] ?? null,
    self: async () => ({ pid: 333, startTime: "contender-start" }),
    runFrozen: vi.fn(async () => ({
      exitCode: 0,
      stdout: `{"status":"${PREVIOUS_OPERATION_RECONCILED}"}\n`,
      stderr: "",
    })),
    now: () => new Date("2026-09-14T12:00:00Z"),
    randomId: () => "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

function deps(
  f: Fixture,
  overrides: Partial<LifecycleReconcileDeps> = {},
  liveInspections?: Record<string, ServiceInspection>,
) {
  const calls: string[] = [];
  const controller = {
    inspect: vi.fn(async (label: string) => {
      calls.push(`inspect:${label}`);
      return (
        liveInspections?.[label] ?? f.snapshot.services.find((item) => item.definition.label === label)!.inspection
      );
    }),
    bootout: vi.fn(async (definition: { label: string }) => {
      calls.push(`bootout:${definition.label}`);
    }),
    listenerOwners: vi.fn(async () => [] as number[]),
    restore: vi.fn(
      async (
        _snapshot: ServiceSnapshot,
        hooks?: { afterEngine?: (engine: ServiceInspection | null) => Promise<void> },
      ) => {
        calls.push("restore:files+engine");
        await hooks?.afterEngine?.(f.snapshot.services[0].inspection);
        calls.push("restore:worker");
      },
    ),
  };
  const value: LifecycleReconcileDeps = {
    controller,
    host: { processStartTime: async () => null },
    verifyPackaged: vi.fn(async () => {
      calls.push("verify:packaged");
    }),
    ...overrides,
  };
  return { value, calls, controller };
}

/** Run the parent side with the frozen side executed in-process through the real reconciler. */
function chainedHost(
  f: Fixture,
  live: Record<number, string>,
  lifecycle: LifecycleReconcileDeps,
  extra: Partial<ReconcileHostIO> = {},
) {
  const base = host(live, extra);
  base.runFrozen = vi.fn(async (_node: string, helper: string, args: readonly string[]) => {
    try {
      const result = await runReconcileOperation({
        operationRecordPath: args[0].slice("--reconcile-operation=".length),
        claimId: args[1].slice("--reconcile-claim=".length),
        selfPath: helper,
        selfSha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
        host: { ...base, self: async () => ({ pid: 444, startTime: "executor-start" }) },
        lifecycle: async () => lifecycle,
      });
      return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  });
  return base;
}

describe("stale lock inspection and serialized takeover", () => {
  it("is clear when no lock exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-clear-"));
    roots.push(root);
    await expect(inspectOrReconcile({ instanceHome: root, env: {}, io: host({}) })).resolves.toEqual({
      status: "clear",
    });
  });

  it("treats a lock without owner metadata as ambiguous, never stale", async () => {
    const f = await fixture();
    unlinkSync(resolve(f.operation.paths.lockDirectory, "owner.json"));
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io: host({}) })).rejects.toThrow(
      "DIRECTORY_CREATION_UNRESOLVED",
    );
  });

  it("returns busy for a live original parent", async () => {
    const f = await fixture();
    const io = host({ 111: "parent-start" });
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toBeInstanceOf(OperationBusyError);
    expect(io.runFrozen).not.toHaveBeenCalled();
  });

  it("returns busy for a live frozen child after its parent died", async () => {
    const f = await fixture();
    const io = host({ 222: "frozen-start" });
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toThrow("live frozen helper");
    expect(io.runFrozen).not.toHaveBeenCalled();
  });

  it("does not mistake a reused PID with another start time for the owner", async () => {
    const f = await fixture();
    const io = host({ 111: "reused", 222: "reused" });
    const outcome = await inspectOrReconcile({ instanceHome: f.root, env: {}, io });
    expect(outcome.status).toBe("reconciled");
    expect(io.runFrozen).toHaveBeenCalledWith(
      expect.any(String),
      resolve(f.operation.paths.operationDirectory, "deploy.min.js"),
      [
        `--reconcile-operation=${f.operation.paths.operationRecord}`,
        "--reconcile-claim=44444444-4444-4444-8444-444444444444",
      ],
      expect.objectContaining({ HIVE_HOME: f.operation.record.canonicalHome }),
    );
  });

  it("serializes contenders: a live claimant is busy, an abandoned claim is taken over with an attempt record", async () => {
    const f = await fixture();
    const claimDirectory = resolve(f.operation.paths.lockDirectory, "reconcile");
    mkdirSync(claimDirectory);
    const previous = {
      schemaVersion: 1,
      claimId: "55555555-5555-4555-8555-555555555555",
      operationId: f.operation.record.id,
      claimant: { pid: 777, startTime: "other" },
      executor: { pid: 778, startTime: "other-exec" },
      claimedAt: "2026-09-14T11:00:00Z",
    };
    writeFileSync(resolve(claimDirectory, "owner.json"), JSON.stringify(previous));
    await expect(
      inspectOrReconcile({ instanceHome: f.root, env: {}, io: host({ 778: "other-exec" }) }),
    ).rejects.toThrow("live contender");
    const io = host({});
    await inspectOrReconcile({ instanceHome: f.root, env: {}, io });
    expect(
      existsSync(
        resolve(f.operation.paths.operationDirectory, "reconcile-attempts", `${previous.claimId}.abandoned.json`),
      ),
    ).toBe(true);
  });

  it("keeps a claim without metadata unresolved", async () => {
    const f = await fixture();
    mkdirSync(resolve(f.operation.paths.lockDirectory, "reconcile"));
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io: host({}) })).rejects.toThrow(
      "reconcile claim exists without trustworthy metadata",
    );
  });

  it("refuses a frozen helper whose digest changed", async () => {
    const f = await fixture();
    writeFileSync(resolve(f.operation.paths.operationDirectory, "deploy.min.js"), "replaced");
    const io = host({});
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toThrow("digest changed");
    expect(io.runFrozen).not.toHaveBeenCalled();
  });

  it("retains the lock when the original helper cannot reconcile", async () => {
    const f = await fixture();
    const io = host({}, { runFrozen: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "unknown argument" })) });
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toBeInstanceOf(
      OperationUnresolvedError,
    );
    expect(existsSync(resolve(f.operation.paths.lockDirectory, "owner.json"))).toBe(true);
  });
});

describe("frozen-side reconciliation by work kind", () => {
  it("refuses an executor that is not the original frozen helper", async () => {
    const f = await fixture();
    await expect(
      runReconcileOperation({
        operationRecordPath: f.operation.paths.operationRecord,
        claimId: "44444444-4444-4444-8444-444444444444",
        selfPath: "/tmp/new-candidate/deploy.min.js",
        selfSha256: HELPER_SHA,
        host: host({}),
        lifecycle: async () => deps(f).value,
      }),
    ).rejects.toThrow("not the original frozen helper");
  });

  it("dispatches non-lifecycle work before reading lifecycle fields and stays unresolved without its handler", async () => {
    const f = await fixture((record) => {
      record.workKind = "bootstrap";
      record.priorSnapshotPath = "/nonexistent";
    });
    const lifecycle = vi.fn();
    const io = chainedHost(f, {}, deps(f).value);
    (io.runFrozen as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_node: string, helper: string, args: readonly string[]) => {
        try {
          await runReconcileOperation({
            operationRecordPath: args[0].slice("--reconcile-operation=".length),
            claimId: args[1].slice("--reconcile-claim=".length),
            selfPath: helper,
            selfSha256: HELPER_SHA,
            host: host({}),
            lifecycle,
          });
          return { exitCode: 0, stdout: "", stderr: "" };
        } catch (error) {
          return { exitCode: 1, stdout: "", stderr: String(error) };
        }
      },
    );
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toBeInstanceOf(
      OperationUnresolvedError,
    );
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("pre-signal: fresh terminal release, owned incomplete .hive.next removed by identity, lock archived, new action not started", async () => {
    const f = await fixture((record) => {
      record.barrierOperationId = record.id;
      record.supervisor = { pid: 600, bootId: SUPERVISOR_BOOT };
      record.supervisorProcess = { pid: 600, startTime: "sup-start" };
      record.workerHealthPort = 3107;
      record.phase = "barrier-requested";
    });
    const home = f.operation.record.canonicalHome;
    mkdirSync(resolve(home, ".hive.next"));
    const identity = await directoryIdentity(resolve(home, ".hive.next"));
    f.operation.record.staging.promotion = {
      method: "clone",
      source: resolve(home, ".hive-state", "jobs", "x"),
      destination: resolve(home, ".hive.next"),
      state: "observed",
      copyPid: null,
      copyStartTime: null,
      exitCode: 0,
      destinationIdentity: { dev: identity.device, ino: identity.inode },
      discarded: false,
    };
    f.operation.record.staging.cloneVerified = true;
    await persistOperation(f.operation);
    mkdirSync(resolve(home, ".hive-state", "runtime"), { recursive: true });
    writeFileSync(
      resolve(home, ".hive-state", "runtime", "voice-worker.json"),
      JSON.stringify({
        release: {
          classification: "source/unavailable",
          packageVersion: null,
          sourceRevision: null,
          sourceDirty: null,
          dependencyLockSha256: null,
        },
        component: "voice-worker",
        pid: 600,
        bootId: SUPERVISOR_BOOT,
        startedAt: "2026-09-14T11:00:00Z",
      }),
    );
    const request = vi.fn(async (options: { kind: string; operationId: string }): Promise<MaintenanceReply> => ({
      protocol: 1,
      requestId: "66666666-6666-4666-8666-666666666666",
      operationId: options.operationId,
      supervisor: { pid: 600, bootId: SUPERVISOR_BOOT },
      ok: true,
      snapshot: {
        supervisor: { pid: 600, bootId: SUPERVISOR_BOOT },
        operationId: null,
        admission: "open",
        persistenceFault: false,
        unresolved: [],
        childPids: [],
      },
      writtenAt: Date.now(),
    }));
    const d = deps(f, {
      host: { processStartTime: async (pid) => (pid === 600 ? "sup-start" : null) },
      request: request as never,
    });
    const io = chainedHost(f, {}, d.value);
    const outcome = await inspectOrReconcile({ instanceHome: f.root, env: {}, io });
    expect(outcome.status).toBe("reconciled");
    expect(outcome.status === "reconciled" && outcome.outcome.resolution).toBe("deferred");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "release", operationId: f.operation.record.id }),
    );
    expect(existsSync(resolve(home, ".hive.next"))).toBe(false);
    expect(d.controller.bootout).not.toHaveBeenCalled();
    expect(existsSync(f.operation.paths.lockDirectory)).toBe(false);
    const next = await acquireOperation({
      instanceHome: f.root,
      instanceId: "dodi",
      mode: "stop",
      toolSha256: HELPER_SHA,
      ownerStartTime: "x",
    });
    await finishOperationLock(next);
  });

  it("records supervisor-exited only after PID exit plus listener release, without faking an acknowledgement", async () => {
    const f = await fixture((record) => {
      record.barrierOperationId = record.id;
      record.supervisor = { pid: 600, bootId: SUPERVISOR_BOOT };
      record.supervisorProcess = { pid: 600, startTime: "sup-start" };
      record.workerHealthPort = 3107;
    });
    const request = vi.fn();
    const d = deps(f, { request: request as never });
    await lifecycleInterruptedIO(d.value).releaseBarrier(f.operation.record);
    expect(request).not.toHaveBeenCalled();
    const evidence = JSON.parse(
      readFileSync(resolve(f.operation.paths.operationDirectory, "barrier-release.json"), "utf8"),
    );
    expect(evidence).toMatchObject({ outcome: "supervisor-exited", listenerReleased: true });

    d.controller.listenerOwners.mockResolvedValueOnce([999]);
    await expect(lifecycleInterruptedIO(d.value).releaseBarrier(f.operation.record)).rejects.toThrow(
      "unidentified owner",
    );
    await finishOperationLock(f.operation);
  });

  it("post-signal: stops identified services worker-before-engine, restores in order, verifies the captured profile", async () => {
    const f = await fixture((record) => {
      record.signalsBegun = true;
      record.phase = "starting-engine";
    });
    const d = deps(f);
    const io = chainedHost(f, {}, d.value);
    const outcome = await inspectOrReconcile({ instanceHome: f.root, env: {}, io });
    expect(outcome.status === "reconciled" && outcome.outcome.resolution).toBe("recovered");
    const order = d.calls.filter(
      (call) => call.startsWith("bootout") || call.startsWith("restore") || call.startsWith("verify"),
    );
    expect(order).toEqual([
      "bootout:com.hive.dodi.voice-worker",
      "bootout:com.hive.dodi.agent",
      "restore:files+engine",
      "restore:worker",
      "verify:packaged",
    ]);
  });

  it("post-signal: an unidentified live registration stays unresolved and nothing is stopped", async () => {
    const f = await fixture((record) => {
      record.signalsBegun = true;
    });
    const foreign = inspection(f.pair.worker, 900);
    foreign.args = ["/usr/bin/node", "/somewhere/else.js"];
    const d = deps(f, {}, { [f.pair.worker.label]: foreign });
    const io = chainedHost(f, {}, d.value);
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toBeInstanceOf(
      OperationUnresolvedError,
    );
    expect(d.controller.bootout).not.toHaveBeenCalled();
    expect(existsSync(resolve(f.operation.paths.lockDirectory, "owner.json"))).toBe(true);
  });

  it("durable healthy resolution completes cleanup and never rotates the accepted release back", async () => {
    const f = await fixture((record) => {
      record.signalsBegun = true;
      record.resolution = "healthy";
      record.phase = "healthy";
    });
    const d = deps(f);
    const io = chainedHost(f, {}, d.value);
    const outcome = await inspectOrReconcile({ instanceHome: f.root, env: {}, io });
    expect(outcome.status === "reconciled" && outcome.outcome.resolution).toBe("healthy");
    expect(d.controller.bootout).not.toHaveBeenCalled();
    expect(d.controller.restore).not.toHaveBeenCalled();
    expect(d.value.verifyPackaged).toHaveBeenCalledOnce();
  });

  it("a legacy record without a reconstructable prior snapshot stays unresolved after signals", async () => {
    const f = await fixture((record) => {
      record.signalsBegun = true;
    });
    writeFileSync(f.operation.record.priorSnapshotPath, JSON.stringify({ schemaVersion: 1, services: [] }));
    const d = deps(f);
    const io = chainedHost(f, {}, d.value);
    await expect(inspectOrReconcile({ instanceHome: f.root, env: {}, io })).rejects.toBeInstanceOf(
      OperationUnresolvedError,
    );
    expect(d.controller.bootout).not.toHaveBeenCalled();
  });
});

describe("frozen ownership transfer", () => {
  it("requires the recorded parent and never switches to another frozen helper", async () => {
    const f = await fixture();
    await expect(
      transferOwnershipToFrozen(f.operation, { pid: 999, startTime: "x" }, { pid: 111, startTime: "parent-start" }),
    ).rejects.toThrow("already transferred");
    const other = await acquireOperation({
      instanceHome: mkdtempSync(join(tmpdir(), "reconcile-transfer-")),
      instanceId: "dodi",
      mode: "stop",
      toolSha256: HELPER_SHA,
      ownerStartTime: "p",
      ownerPid: 50,
    });
    roots.push(other.record.canonicalHome);
    await expect(
      transferOwnershipToFrozen(other, { pid: 51, startTime: "c" }, { pid: 49, startTime: "p" }),
    ).rejects.toThrow("not launched by the recorded operation owner");
    await transferOwnershipToFrozen(other, { pid: 51, startTime: "c" }, { pid: 50, startTime: "p" });
    expect(JSON.parse(readFileSync(other.paths.currentRecord, "utf8")).frozenOwner).toEqual({
      pid: 51,
      startTime: "c",
    });
    await finishOperationLock(other);
  });
});
