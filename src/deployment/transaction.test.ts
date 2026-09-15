import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deploymentDryRun, parseDeploymentArguments } from "./main.js";
import {
  acquireOperation,
  directoryIdentity,
  finishOperationLock,
  moveOwnedDirectory,
  persistOperation,
  reconcileArtifactMove,
  reconcileInterruptedOperation,
  type AcquiredOperation,
} from "./operation.js";
import {
  activate,
  ArtifactRotation,
  DeferredMaintenance,
  maintenanceQuiescenceIO,
  quiesce,
  UnresolvedMaintenance,
  type IdleEvidence,
  type TransactionIO,
} from "./transaction.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeTransaction(failure?: string) {
  const calls: string[] = [];
  const fail = async (name: string) => {
    calls.push(name);
    if (failure === name) throw new Error(name);
  };
  const io: TransactionIO = {
    phase: (phase) => fail(`phase:${phase}`),
    preflightAndStage: () => fail("preflight"),
    establishQuiescence: () => fail("quiesce"),
    releaseAdmission: () => fail("release"),
    markSignalsBegun: () => fail("signals"),
    stopWorkerAndChildren: () => fail("stop-worker"),
    stopEngine: () => fail("stop-engine"),
    rotate: () => fail("rotate"),
    installCandidateDefinitions: () => fail("definitions"),
    startEngineAndVerifyBoot: () => fail("start-engine"),
    startWorker: () => fail("start-worker"),
    verifyCandidatePair: () => fail("health"),
    finalizeHealthy: () => fail("finalize"),
    recoverPriorPair: () => fail("recover"),
    finishResolved: () => fail("resolved"),
    retainUnresolved: () => fail("unresolved"),
  };
  return { io, calls };
}

describe("paired activation", () => {
  it("orders worker descendants before engine and persists health before cleanup", async () => {
    const { io, calls } = fakeTransaction();
    await activate(io);
    expect(calls).toEqual([
      "phase:preflight",
      "preflight",
      "phase:staged",
      "quiesce",
      "phase:quiescent",
      "signals",
      "phase:stopping-worker",
      "stop-worker",
      "phase:stopping-engine",
      "stop-engine",
      "phase:rotating",
      "rotate",
      "definitions",
      "phase:starting-engine",
      "start-engine",
      "phase:starting-worker",
      "start-worker",
      "phase:checking",
      "health",
      "phase:healthy",
      "finalize",
      "resolved",
    ]);
  });

  it.each(["registry", "archive", "root", "lock", "native", "config", "prior compatibility"])(
    "%s preflight failure sends no signal, service mutation, or rotation",
    async (classification) => {
      const { io, calls } = fakeTransaction("preflight");
      await expect(activate(io)).rejects.toThrow("preflight");
      expect(calls).toEqual(["phase:preflight", "preflight", "resolved"]);
      expect(calls).not.toContain("signals");
      expect(calls).not.toContain("definitions");
      expect(calls).not.toContain("rotate");
      expect(classification).toBeTruthy();
    },
  );

  it("releases admission when the durable quiescent marker fails before signals", async () => {
    const { io, calls } = fakeTransaction("phase:quiescent");
    await expect(activate(io)).rejects.toThrow("phase:quiescent");
    expect(calls).toEqual([
      "phase:preflight",
      "preflight",
      "phase:staged",
      "quiesce",
      "phase:quiescent",
      "release",
      "resolved",
    ]);
  });

  it("retains unresolved ownership when terminal release acknowledgement is lost", async () => {
    const { io, calls } = fakeTransaction("phase:quiescent");
    io.releaseAdmission = async () => {
      calls.push("release");
      throw new Error("ack lost");
    };
    await expect(activate(io)).rejects.toThrow("maintenance unresolved; no services signaled");
    expect(calls).toContain("unresolved");
    expect(calls).not.toContain("signals");
  });

  it.each(["stop-worker", "stop-engine", "rotate", "definitions", "start-engine", "start-worker", "health"])(
    "recovers the exact prior pair after irreversible %s failure and preserves failure status",
    async (boundary) => {
      const { io, calls } = fakeTransaction(boundary);
      await expect(activate(io)).rejects.toThrow("prior pair restored and verified");
      expect(calls).toContain("phase:recovering");
      expect(calls).toContain("recover");
      expect(calls.at(-1)).toBe("resolved");
    },
  );

  it("reports primary and recovery failures and retains paths", async () => {
    const { io, calls } = fakeTransaction("stop-worker");
    io.recoverPriorPair = async () => {
      calls.push("recover");
      throw new Error("recovery registration failed");
    };
    const error = await activate(io).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(calls.at(-1)).toBe("unresolved");
  });

  it("does not rotate again when cleanup fails after durable candidate health", async () => {
    const { io, calls } = fakeTransaction("finalize");
    await expect(activate(io)).rejects.toThrow("candidate health passed; final cleanup requires reconciliation");
    expect(calls.filter((call) => call === "rotate")).toHaveLength(1);
    expect(calls).not.toContain("recover");
    expect(calls.at(-1)).toBe("unresolved");
  });
});

const supervisor = { pid: 4242, bootId: "11111111-1111-4111-8111-111111111111" };
const idle = (overrides: Partial<IdleEvidence> = {}): IdleEvidence => ({
  supervisor,
  registered: true,
  ownedSocket: true,
  sdkActiveJobs: 0,
  telemetryActiveCalls: 0,
  ...overrides,
});

describe("reversible maintenance", () => {
  it.each([
    ["unregistered", { registered: false }],
    ["foreign socket", { ownedSocket: false }],
    ["unknown SDK jobs", { sdkActiveJobs: null }],
    ["accepted/running job", { sdkActiveJobs: 1 }],
    ["unknown telemetry", { telemetryActiveCalls: null }],
    ["active call", { telemetryActiveCalls: 1 }],
  ] as const)("defers %s before recording or closing a gate", async (_name, overrides) => {
    const close = vi.fn();
    const release = vi.fn();
    const record = vi.fn();
    await expect(
      quiesce(
        {
          now: () => 0,
          wait: async () => {},
          inspect: async () => idle(overrides),
          close,
          status: async () => ({ unresolved: 0, closed: true }),
          release,
          recordBarrierRequested: record,
        },
        supervisor.bootId,
      ),
    ).rejects.toBeInstanceOf(DeferredMaintenance);
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("waits for accepted-but-unassigned work and active-call races to settle", async () => {
    let now = 0;
    let inspections = 0;
    const calls: string[] = [];
    const result = await quiesce(
      {
        now: () => now,
        wait: async (ms) => {
          calls.push("wait");
          now += ms;
        },
        inspect: async () => idle(inspections++ === 1 ? { telemetryActiveCalls: 1 } : {}),
        close: async () => calls.push("close"),
        status: async () => ({ unresolved: inspections < 3 ? 1 : 0, closed: true }),
        release: async () => calls.push("release"),
        recordBarrierRequested: async () => calls.push("record"),
      },
      supervisor.bootId,
    );
    expect(result.telemetryActiveCalls).toBe(0);
    expect(calls.slice(0, 2)).toEqual(["record", "close"]);
    expect(calls).not.toContain("release");
  });

  it("requires terminal release after wrong boot and preserves services", async () => {
    const calls: string[] = [];
    let inspection = 0;
    await expect(
      quiesce(
        {
          now: () => 0,
          wait: async () => {},
          inspect: async () =>
            inspection++ === 0
              ? idle()
              : idle({ supervisor: { ...supervisor, bootId: "22222222-2222-4222-8222-222222222222" } }),
          close: async () => calls.push("close"),
          status: async () => ({ unresolved: 0, closed: true }),
          release: async () => calls.push("release"),
          recordBarrierRequested: async () => calls.push("record"),
        },
        supervisor.bootId,
      ),
    ).rejects.toBeInstanceOf(DeferredMaintenance);
    expect(calls).toEqual(["record", "close", "release"]);
  });

  it("classifies a release acknowledgement loss as unresolved", async () => {
    await expect(
      quiesce(
        {
          now: () => 0,
          wait: async () => {},
          inspect: async () => idle(),
          close: async () => {
            throw new Error("close reply lost");
          },
          status: async () => ({ unresolved: 0, closed: true }),
          release: async () => {
            throw new Error("lost");
          },
          recordBarrierRequested: async () => {},
        },
        supervisor.bootId,
      ),
    ).rejects.toBeInstanceOf(UnresolvedMaintenance);
  });

  it("times out unresolved accepted work, then requires the terminal release", async () => {
    let now = 0;
    const release = vi.fn();
    await expect(
      quiesce(
        {
          now: () => now,
          wait: async (ms) => {
            now += ms;
          },
          inspect: async () => idle(),
          close: async () => {},
          status: async () => ({ unresolved: 1, closed: true }),
          release,
          recordBarrierRequested: async () => {},
        },
        supervisor.bootId,
      ),
    ).rejects.toThrow("accepted work did not settle");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the shared request client and validates terminal release ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "hive-transaction-maintenance-"));
    roots.push(root);
    mkdirSync(join(root, ".hive-state"), { mode: 0o700 });
    const operation = await acquireOperation({
      instanceHome: root,
      instanceId: "test",
      mode: "restart",
      toolSha256: "a".repeat(64),
      ownerStartTime: "start",
    });
    const request = vi.fn(async (options: { kind: string; operationId: string }) => ({
      protocol: 1 as const,
      requestId: "33333333-3333-4333-8333-333333333333",
      operationId: options.operationId,
      supervisor,
      ok: true,
      snapshot: {
        supervisor,
        operationId: options.kind === "release" ? null : options.operationId,
        admission: options.kind === "release" ? ("open" as const) : ("closed" as const),
        persistenceFault: false,
        unresolved: [],
        childPids: [],
      },
      writtenAt: 1,
    }));
    const adapter = maintenanceQuiescenceIO({
      operation,
      instanceHome: root,
      instanceId: "test",
      inspect: async () => idle(),
      corroborateSupervisor: async () => supervisor,
      request: request as never,
    });
    await adapter.recordBarrierRequested(operation.record.id, supervisor);
    await adapter.close(operation.record.id, 10);
    expect(await adapter.status(operation.record.id, 10)).toEqual({ unresolved: 0, closed: true });
    await adapter.release(operation.record.id, 10);
    expect(request.mock.calls.map((call) => call[0].kind)).toEqual(["close", "status", "release"]);
    await finishOperationLock(operation);
  });
});

async function operationFixture(): Promise<{ root: string; operation: AcquiredOperation }> {
  const root = mkdtempSync(join(tmpdir(), "hive-operation-"));
  roots.push(root);
  mkdirSync(join(root, ".hive-state"), { mode: 0o700 });
  const operation = await acquireOperation({
    instanceHome: root,
    instanceId: "test",
    mode: "update",
    toolSha256: "b".repeat(64),
    ownerStartTime: "fixture-start",
  });
  return { root, operation };
}

/** Record `.hive.next` as the observed, verified clone written by promotion. */
async function markVerifiedClone(operation: AcquiredOperation): Promise<void> {
  const next = resolve(operation.record.canonicalHome, ".hive.next");
  const identity = await directoryIdentity(next);
  operation.record.staging.promotion = {
    method: "clone",
    source: resolve(operation.record.canonicalHome, ".hive-state", "jobs", operation.record.id, "install-1", "package"),
    destination: next,
    state: "observed",
    copyPid: 1234,
    copyStartTime: "fixture",
    exitCode: 0,
    destinationIdentity: { dev: identity.device, ino: identity.inode },
    discarded: false,
  };
  operation.record.staging.cloneVerified = true;
  await persistOperation(operation);
}

describe("durable operation and artifact ownership", () => {
  it("serializes symlink aliases through the same canonical lock", async () => {
    const { root, operation } = await operationFixture();
    const alias = `${root}-alias`;
    roots.push(alias);
    symlinkSync(root, alias);
    await expect(
      acquireOperation({
        instanceHome: alias,
        instanceId: "test",
        mode: "stop",
        toolSha256: "c".repeat(64),
        ownerStartTime: "other",
      }),
    ).rejects.toThrow("another lifecycle operation");
    expect(operation.record.canonicalHome).toBe(realpathSync(root));
    await finishOperationLock(operation);
  });

  it("fences a rename and reconciles an interrupted observed-marker write by inode", async () => {
    const { root, operation } = await operationFixture();
    const from = resolve(root, ".hive.next");
    const to = resolve(root, ".hive");
    mkdirSync(from);
    const identity = await directoryIdentity(from);
    operation.record.artifactMove = { from, to, directoryIdentity: identity, state: "intended" };
    renameSync(from, to);
    expect(await reconcileArtifactMove(operation.record)).toBe("after");
    renameSync(to, from);
    expect(await reconcileArtifactMove(operation.record)).toBe("before");
    await finishOperationLock(operation);
  });

  it("rotates update paths and restores exact identities while retaining failed candidate", async () => {
    const { root, operation } = await operationFixture();
    for (const name of [".hive", ".hive.prev", ".hive.next", ".hive.broken"]) {
      mkdirSync(resolve(root, name));
      writeFileSync(resolve(root, name, "identity"), name);
    }
    await markVerifiedClone(operation);
    const rotation = new ArtifactRotation(operation, async () => true);
    await rotation.capture();
    await rotation.reserveBroken();
    await rotation.rotateUpdate();
    await rotation.recoverUpdate();
    expect(readFileSync(resolve(root, ".hive", "identity"), "utf8")).toBe(".hive");
    expect(readFileSync(resolve(root, ".hive.prev", "identity"), "utf8")).toBe(".hive.prev");
    expect(readFileSync(resolve(root, ".hive.broken", "identity"), "utf8")).toBe(".hive.next");
    operation.record.resolution = "recovered";
    await rotation.disposeSupersededBroken();
    await finishOperationLock(operation);
  });

  it("refuses to rotate a .hive.next that is not the recorded verified clone", async () => {
    const { root, operation } = await operationFixture();
    mkdirSync(resolve(root, ".hive"));
    mkdirSync(resolve(root, ".hive.next"));
    const unverified = new ArtifactRotation(operation, async () => true);
    await unverified.capture();
    await expect(unverified.rotateUpdate()).rejects.toThrow("not the recorded verified clone");
    await markVerifiedClone(operation);
    operation.record.staging.cloneVerified = false;
    await expect(unverified.rotateUpdate()).rejects.toThrow("not the recorded verified clone");
    operation.record.staging.cloneVerified = true;
    renameSync(resolve(root, ".hive.next"), resolve(root, "replaced"));
    mkdirSync(resolve(root, ".hive.next"));
    const swapped = new ArtifactRotation(operation, async () => true);
    await swapped.capture();
    await expect(swapped.rotateUpdate()).rejects.toThrow("not the recorded verified clone");
    expect(realpathSync(resolve(root, ".hive"))).toBe(resolve(realpathSync(root), ".hive"));
    await finishOperationLock(operation);
  });

  it("reconciles an interrupted staging operation: unverified clone discarded, job trees swept, never adopted", async () => {
    const { root, operation } = await operationFixture();
    const home = operation.record.canonicalHome;
    mkdirSync(resolve(home, ".hive.next"));
    writeFileSync(resolve(home, ".hive.next", "partial"), "torn");
    const jobDirectory = resolve(home, ".hive-state", "jobs", operation.record.id, "install-1", "package");
    mkdirSync(jobDirectory, { recursive: true });
    writeFileSync(resolve(jobDirectory, "straggler-output"), "late");
    await markVerifiedClone(operation);
    operation.record.staging.cloneVerified = false;
    await persistOperation(operation);
    const filesystem = vi.fn();
    await reconcileInterruptedOperation(root, {
      ownerIsLive: async () => false,
      releaseBarrier: async () => {},
      reconcileFilesystem: filesystem,
      recoverAfterSignals: async () => {
        throw new Error("no signals were recorded");
      },
    });
    expect(() => realpathSync(resolve(home, ".hive.next"))).toThrow();
    expect(() => realpathSync(resolve(home, ".hive-state", "jobs", operation.record.id))).toThrow();
    expect(filesystem).toHaveBeenCalledOnce();
    const persisted = JSON.parse(readFileSync(resolve(home, ".hive-state", "deployment", "operation.json"), "utf8"));
    expect(persisted).toMatchObject({ schemaVersion: 2, resolution: "deferred" });
    expect(persisted.staging.promotion.discarded).toBe(true);
  });

  it("reports a live recorded promotion copy as busy without discarding anything", async () => {
    const { root, operation } = await operationFixture();
    const home = operation.record.canonicalHome;
    mkdirSync(resolve(home, ".hive.next"));
    await markVerifiedClone(operation);
    operation.record.staging.promotion = { ...operation.record.staging.promotion!, state: "copying" };
    operation.record.staging.cloneVerified = false;
    await persistOperation(operation);
    const live = vi.fn(async (owner: { pid: number }) => owner.pid === 1234);
    await expect(
      reconcileInterruptedOperation(root, {
        ownerIsLive: live,
        releaseBarrier: async () => {},
        reconcileFilesystem: async () => {},
        recoverAfterSignals: async () => {},
      }),
    ).rejects.toThrow("promotion copy is still running");
    expect(realpathSync(resolve(home, ".hive.next"))).toBe(resolve(home, ".hive.next"));
  });

  it("ordinary rollback success consumes previous and retains replaced current as broken", async () => {
    const { root, operation } = await operationFixture();
    mkdirSync(resolve(root, ".hive"));
    mkdirSync(resolve(root, ".hive.prev"));
    writeFileSync(resolve(root, ".hive", "identity"), "current");
    writeFileSync(resolve(root, ".hive.prev", "identity"), "previous");
    const rotation = new ArtifactRotation(operation, async () => true);
    await rotation.capture();
    await rotation.rotateRollback();
    operation.record.resolution = "healthy";
    await rotation.finalizeRollbackSuccess();
    expect(readFileSync(resolve(root, ".hive", "identity"), "utf8")).toBe("previous");
    expect(readFileSync(resolve(root, ".hive.broken", "identity"), "utf8")).toBe("current");
    expect(() => realpathSync(resolve(root, ".hive.prev"))).toThrow();
    await finishOperationLock(operation);
  });

  it("supports two failed updates then rollback with one owned broken generation", async () => {
    const { root, operation: first } = await operationFixture();
    for (const [name, marker] of [
      [".hive", "current"],
      [".hive.prev", "previous"],
      [".hive.next", "candidate-one"],
    ]) {
      mkdirSync(resolve(root, name));
      writeFileSync(resolve(root, name, "identity"), marker);
    }
    await markVerifiedClone(first);
    const firstRotation = new ArtifactRotation(first, async () => true);
    await firstRotation.capture();
    await firstRotation.rotateUpdate();
    await firstRotation.recoverUpdate();
    first.record.resolution = "recovered";
    await persistOperation(first);
    await finishOperationLock(first);

    const second = await acquireOperation({
      instanceHome: root,
      instanceId: "test",
      mode: "update",
      toolSha256: "e".repeat(64),
      ownerStartTime: "second",
    });
    mkdirSync(resolve(root, ".hive.next"));
    writeFileSync(resolve(root, ".hive.next", "identity"), "candidate-two");
    await markVerifiedClone(second);
    const secondRotation = new ArtifactRotation(second, async () => true);
    await secondRotation.capture();
    await secondRotation.reserveBroken();
    await secondRotation.rotateUpdate();
    await secondRotation.recoverUpdate();
    second.record.resolution = "recovered";
    await persistOperation(second);
    await secondRotation.disposeSupersededBroken();
    expect(readFileSync(resolve(root, ".hive.broken", "identity"), "utf8")).toBe("candidate-two");
    expect(readFileSync(resolve(root, ".hive", "identity"), "utf8")).toBe("current");
    expect(readFileSync(resolve(root, ".hive.prev", "identity"), "utf8")).toBe("previous");
    await finishOperationLock(second);

    const rollback = await acquireOperation({
      instanceHome: root,
      instanceId: "test",
      mode: "rollback",
      toolSha256: "f".repeat(64),
      ownerStartTime: "rollback",
    });
    const rollbackRotation = new ArtifactRotation(rollback, async () => true);
    await rollbackRotation.capture();
    await rollbackRotation.reserveBroken();
    await rollbackRotation.rotateRollback();
    rollback.record.resolution = "healthy";
    await persistOperation(rollback);
    await rollbackRotation.finalizeRollbackSuccess();
    await rollbackRotation.disposeSupersededBroken();
    expect(readFileSync(resolve(root, ".hive", "identity"), "utf8")).toBe("previous");
    expect(readFileSync(resolve(root, ".hive.broken", "identity"), "utf8")).toBe("current");
    await finishOperationLock(rollback);
  });

  it("failed rollback restores current, previous and an existing broken identity", async () => {
    const { root, operation } = await operationFixture();
    for (const [name, marker] of [
      [".hive", "current"],
      [".hive.prev", "previous"],
      [".hive.broken", "diagnostic"],
    ]) {
      mkdirSync(resolve(root, name));
      writeFileSync(resolve(root, name, "identity"), marker);
    }
    const rotation = new ArtifactRotation(operation, async () => true);
    await rotation.capture();
    await rotation.reserveBroken();
    await rotation.rotateRollback();
    await rotation.recoverRollback();
    expect(readFileSync(resolve(root, ".hive", "identity"), "utf8")).toBe("current");
    expect(readFileSync(resolve(root, ".hive.prev", "identity"), "utf8")).toBe("previous");
    expect(readFileSync(resolve(root, ".hive.broken", "identity"), "utf8")).toBe("diagnostic");
    operation.record.resolution = "recovered";
    await persistOperation(operation);
    await finishOperationLock(operation);
  });

  it("refuses unknown broken ownership before moving anything", async () => {
    const { root, operation } = await operationFixture();
    mkdirSync(resolve(root, ".hive.broken"));
    const rotation = new ArtifactRotation(operation, async () => false);
    await expect(rotation.capture()).rejects.toThrow("not owned recovery evidence");
    expect(realpathSync(resolve(root, ".hive.broken"))).toBe(resolve(realpathSync(root), ".hive.broken"));
    await finishOperationLock(operation);
  });

  it("never overwrites an occupied artifact destination", async () => {
    const { root, operation } = await operationFixture();
    mkdirSync(resolve(root, "from"));
    mkdirSync(resolve(root, "to"));
    await expect(moveOwnedDirectory(operation, resolve(root, "from"), resolve(root, "to"))).rejects.toThrow(
      "destination is occupied",
    );
    await finishOperationLock(operation);
  });

  it("requires a fresh terminal barrier release before clearing a stale pre-signal lock", async () => {
    const { root, operation } = await operationFixture();
    operation.record.barrierOperationId = operation.record.id;
    operation.record.supervisor = supervisor;
    await persistOperation(operation);
    const calls: string[] = [];
    await reconcileInterruptedOperation(root, {
      ownerIsLive: async () => false,
      releaseBarrier: async (record) => {
        expect(record.barrierOperationId).toBe(record.id);
        calls.push("terminal-release");
      },
      reconcileFilesystem: async (_record, move) => {
        expect(move).toBeNull();
        calls.push("filesystem");
      },
      recoverAfterSignals: async () => calls.push("recover"),
      completeDurableResolution: async () => calls.push("durable"),
      verifyDeferredResolution: async () => calls.push("deferred"),
    });
    expect(calls).toEqual(["terminal-release", "filesystem"]);
    const next = await acquireOperation({
      instanceHome: root,
      instanceId: "test",
      mode: "stop",
      toolSha256: "d".repeat(64),
      ownerStartTime: "next",
    });
    await finishOperationLock(next);
  });

  it("routes a stale post-signal operation through checked recovery", async () => {
    const { root, operation } = await operationFixture();
    operation.record.signalsBegun = true;
    await persistOperation(operation);
    const recover = vi.fn();
    await reconcileInterruptedOperation(root, {
      ownerIsLive: async () => false,
      releaseBarrier: async () => {
        throw new Error("release must not run after signals");
      },
      reconcileFilesystem: async () => {
        throw new Error("pre-signal cleanup must not run");
      },
      recoverAfterSignals: recover,
      completeDurableResolution: async () => {
        throw new Error("unfinished activation is not a durable resolution");
      },
      verifyDeferredResolution: async () => {
        throw new Error("unfinished activation is not deferred");
      },
    });
    expect(recover).toHaveBeenCalledOnce();
  });

  it("completes a durable healthy resolution without checked recovery or rotation", async () => {
    const { root, operation } = await operationFixture();
    operation.record.signalsBegun = true;
    operation.record.resolution = "healthy";
    await persistOperation(operation);
    const calls: string[] = [];
    const result = await reconcileInterruptedOperation(root, {
      ownerIsLive: async () => false,
      releaseBarrier: async () => void calls.push("release"),
      reconcileFilesystem: async () => void calls.push("filesystem"),
      recoverAfterSignals: async () => void calls.push("recover"),
      completeDurableResolution: async () => void calls.push("durable"),
      verifyDeferredResolution: async () => void calls.push("deferred"),
    });
    expect(calls).toEqual(["durable"]);
    expect(result.resolution).toBe("healthy");
  });

  it("keeps a lock busy while the recorded frozen helper lives after its parent died", async () => {
    const { root, operation } = await operationFixture();
    operation.record.frozenOwner = { pid: 4321, startTime: "frozen" };
    await persistOperation(operation);
    const noop = async () => {};
    await expect(
      reconcileInterruptedOperation(root, {
        ownerIsLive: async (owner) => owner.pid === 4321,
        releaseBarrier: noop,
        reconcileFilesystem: noop,
        recoverAfterSignals: noop,
        completeDurableResolution: noop,
        verifyDeferredResolution: noop,
      }),
    ).rejects.toThrow("frozen helper is still live");
    await finishOperationLock(operation);
  });

  it("first migration moves only the verified clone into an absent .hive and recovers to captured absence", async () => {
    const { operation } = await operationFixture();
    const home = operation.record.canonicalHome;
    mkdirSync(resolve(home, ".hive.prev"));
    writeFileSync(resolve(home, ".hive.prev", "marker"), "old");
    mkdirSync(resolve(home, ".hive.next"));
    const next = await directoryIdentity(resolve(home, ".hive.next"));
    operation.record.staging.promotion = {
      method: "clone",
      source: resolve(home, ".hive-state", "jobs", "j"),
      destination: resolve(home, ".hive.next"),
      state: "observed",
      copyPid: null,
      copyStartTime: null,
      exitCode: 0,
      destinationIdentity: { dev: next.device, ino: next.inode },
      discarded: false,
    };
    operation.record.staging.cloneVerified = true;
    await persistOperation(operation);
    const rotation = new ArtifactRotation(operation, async () => false);
    await rotation.capture();
    expect(rotation.captured.current).toBeUndefined();
    await expect(rotation.rotateUpdate()).rejects.toThrow("current and owned next");
    await rotation.rotateFirstMigration();
    expect(readFileSync(resolve(home, ".hive.prev", "marker"), "utf8")).toBe("old");
    await rotation.recoverFirstMigration();
    expect((await directoryIdentity(resolve(home, ".hive.broken"))).inode).toBe(next.inode);
    expect(() => realpathSync(resolve(home, ".hive"))).toThrow();
    expect(readFileSync(resolve(home, ".hive.prev", "marker"), "utf8")).toBe("old");
    await finishOperationLock(operation);
  });

  it("first migration refuses an unverified clone", async () => {
    const { root, operation } = await operationFixture();
    mkdirSync(resolve(operation.record.canonicalHome, ".hive.next"));
    const rotation = new ArtifactRotation(operation, async () => false);
    await rotation.capture();
    await expect(rotation.rotateFirstMigration()).rejects.toThrow("not the recorded verified clone");
    expect(root).toBeTruthy();
    await finishOperationLock(operation);
  });
});

describe("helper argument and pure dry-run boundary", () => {
  it("parses every S7 lifecycle selector", () => {
    expect(
      parseDeploymentArguments([
        "--artifact=/tmp/candidate.tgz",
        "--instance=dodi",
        "--legacy-hold=/tmp/hold.json",
        "--dry-run",
      ]),
    ).toMatchObject({
      mode: "update",
      artifact: "/tmp/candidate.tgz",
      instance: "dodi",
      legacyHold: "/tmp/hold.json",
      dryRun: true,
    });
    expect(parseDeploymentArguments(["--restart"])).toMatchObject({ mode: "restart" });
    expect(parseDeploymentArguments(["--check", "--tag=latest"])).toMatchObject({ mode: "check" });
    expect(parseDeploymentArguments(["--pilot-recovery=/tmp/snapshot.json"])).toMatchObject({
      mode: "pilot-rollback",
    });
  });

  it("rejects conflicting selectors before any operation", () => {
    expect(() => parseDeploymentArguments(["--tag=latest", "--artifact=/tmp/candidate.tgz"])).toThrow(
      "mutually exclusive",
    );
    expect(() => parseDeploymentArguments(["--start", "--stop"])).toThrow("mutually exclusive");
    expect(() => parseDeploymentArguments(["--legacy-hold=/tmp/hold.json"])).toThrow("artifact update");
  });

  it("accepts the internal reconcile mode only with exactly its operation record and claim", () => {
    const claim = "44444444-4444-4444-8444-444444444444";
    expect(
      parseDeploymentArguments([`--reconcile-operation=/state/operation.json`, `--reconcile-claim=${claim}`]),
    ).toMatchObject({ reconcileOperation: "/state/operation.json", reconcileClaim: claim });
    expect(() => parseDeploymentArguments([`--reconcile-operation=/state/operation.json`])).toThrow("used together");
    expect(() =>
      parseDeploymentArguments([
        `--reconcile-operation=/state/operation.json`,
        `--reconcile-claim=${claim}`,
        "--restart",
      ]),
    ).toThrow("accepts only");
    expect(() =>
      parseDeploymentArguments([`--reconcile-operation=relative.json`, `--reconcile-claim=${claim}`]),
    ).toThrow("accepts only");
  });

  it("dry-run reads selectors only and leaves the filesystem byte-for-byte unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "hive-dry-run-"));
    roots.push(root);
    writeFileSync(join(root, "hive-personal.yaml"), "instance:\n  id: dodi\nvoice:\n  livekit:\n    enabled: true\n");
    const before = readFileSync(join(root, "hive-personal.yaml"));
    const plan = await deploymentDryRun(parseDeploymentArguments(["--tag=v0.16.0", "--instance=dodi", "--dry-run"]), {
      HIVE_HOME: root,
      HIVE_CONFIG: "hive-personal.yaml",
      HOME: root,
      PATH: "/usr/bin:/bin",
    });
    expect(plan).toMatchObject({ status: "DRY_RUN", target: "dodi", voiceEnabled: true });
    // Presence only: dry-run runs no self-test, promotion probe or artifact job.
    expect(plan.stagingPrerequisites).toMatchObject({ selfTest: "unverified", promotionMethod: "unverified" });
    const rollback = await deploymentDryRun(parseDeploymentArguments(["--rollback", "--dry-run"]), {
      HIVE_HOME: root,
      HIVE_CONFIG: "hive-personal.yaml",
      HOME: root,
      PATH: "/usr/bin:/bin",
    });
    expect(rollback.stagingPrerequisites).toBe("not-required");
    expect(readFileSync(join(root, "hive-personal.yaml"))).toEqual(before);
    expect(() => realpathSync(join(root, ".hive-state"))).toThrow();
  });
});

describe("S9 closed-gate propagation into failed activation / checked recovery", () => {
  it.each([
    "persistence-faulted closed gate",
    "maintenance-owned closed gate",
    "missing admission evidence",
    "stale admission evidence",
    "mismatched snapshot supervisor PID/boot",
  ])("%s fails activation, runs checked recovery, and never records healthy", async (name) => {
    const { io, calls } = fakeTransaction();
    io.verifyCandidatePair = async () => {
      calls.push("health");
      throw new Error(name);
    };
    await expect(activate(io)).rejects.toThrow("activation failed; prior pair restored and verified");
    expect(calls).toContain("phase:recovering");
    expect(calls).toContain("recover");
    expect(calls).toContain("resolved");
    expect(calls).not.toContain("finalize");
    expect(calls).not.toContain("phase:healthy");
  });
});
