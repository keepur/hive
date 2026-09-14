import { describe, expect, it, vi } from "vitest";
import {
  consumeHold,
  HoldNotProvedError,
  HoldProofExpiredError,
  proveNativeHold,
  sampleProofClock,
  stopUnderFreshProof,
  type NativeGateReadback,
  type ProcessSeal,
} from "./stop-proof.js";
import { ServiceController, buildServiceDefinitions, buildServiceEnvironment, type ServiceIO } from "./services.js";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const BOOT = "33333333-3333-4333-8333-333333333333";
const WORKER: ProcessSeal = {
  pid: 4242,
  startTime: "Mon Sep 14 10:00:00 2026",
  executable: "/opt/node/bin/node",
  command: "/opt/node/bin/node /pilot/dist/voice-worker/main.js start",
  cwd: "/Users/example/hive",
};

function readback(overrides: Partial<NativeGateReadback> = {}): NativeGateReadback {
  return {
    operationId: OPERATION,
    requestId: REQUEST,
    requestedAt: 1_000,
    observedAt: 1_000,
    completedAt: 1_100,
    observedMono: 1_000,
    completedMono: 1_100,
    worker: WORKER,
    bootId: BOOT,
    closedOperationId: OPERATION,
    admission: "closed",
    unresolvedAccepted: 0,
    sdkActiveJobs: 0,
    telemetryActiveCalls: 0,
    telemetryUpdatedAt: 990,
    persistenceFault: false,
    sdkRootStatus: 200,
    sdkAgentName: "hive-voice",
    socketOwner: WORKER,
    ...overrides,
  };
}

function expectation(now: number, nowMono = now) {
  return { operationId: OPERATION, requestId: REQUEST, requestedAt: 1_000, worker: WORKER, bootId: BOOT, now, nowMono };
}

describe("native hold proof", () => {
  it("rejects every non-idle, foreign or stale decisive observation", () => {
    const bad: Partial<NativeGateReadback>[] = [
      { admission: "open", closedOperationId: null },
      { closedOperationId: "44444444-4444-4444-8444-444444444444" },
      { unresolvedAccepted: 1 },
      { sdkActiveJobs: 1 },
      { telemetryActiveCalls: 1 },
      { persistenceFault: true },
      { sdkRootStatus: 503 },
      { sdkAgentName: "other" },
      { bootId: "55555555-5555-4555-8555-555555555555" },
      { socketOwner: { ...WORKER, pid: 999 } },
      { worker: { ...WORKER, startTime: "reused pid" } },
      { requestId: "66666666-6666-4666-8666-666666666666" },
      { observedAt: 999 },
      { telemetryUpdatedAt: 1_201 },
      { telemetryUpdatedAt: 1_100 - 60_001 },
    ];
    for (const override of bad) {
      expect(() => proveNativeHold(readback(override), expectation(1_200))).toThrow(HoldNotProvedError);
    }
    // A readback older than 2 s at proof construction never proves anything.
    expect(() => proveNativeHold(readback(), expectation(3_001))).toThrow(HoldNotProvedError);
  });

  it("observe 1000, construct 2999, signal 4998 -> reject", () => {
    const proof = proveNativeHold(readback(), expectation(2_999));
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 4_998, 4_998)).toThrow(HoldProofExpiredError);
  });

  it("observe 1000, construct 1001, persistence returning at 3001 -> reject", () => {
    const proof = proveNativeHold(readback({ completedAt: 1_001, completedMono: 1_001 }), expectation(1_001));
    sampleProofClock(proof, 1_002, 1_002);
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 3_001, 3_001)).toThrow(HoldProofExpiredError);
  });

  it("observe 1000, construct 1500, persist 1900, IPC 2999, signal 3001 -> reject", () => {
    const proof = proveNativeHold(readback(), expectation(1_500));
    sampleProofClock(proof, 1_900, 1_900);
    sampleProofClock(proof, 2_999, 2_999);
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 3_001, 3_001)).toThrow(HoldProofExpiredError);
  });

  it("allows exactly once at 3000 within both original budgets", () => {
    const proof = proveNativeHold(readback(), expectation(1_500));
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 3_000, 3_000)).not.toThrow();
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 3_000, 3_000)).toThrow(HoldProofExpiredError);
  });

  it("rejects wall-clock reversal paired with monotonic progress", () => {
    const proof = proveNativeHold(readback(), expectation(1_500, 1_500));
    expect(() => sampleProofClock(proof, 1_400, 1_600)).toThrow(HoldProofExpiredError);
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 1_700, 1_700)).toThrow(HoldProofExpiredError);
  });

  it("caps expiry by the supervisor heartbeat lifetime", () => {
    const proof = proveNativeHold(
      readback({ telemetryUpdatedAt: 1_000 - 59_000, observedAt: 1_000 }),
      expectation(1_200, 1_200),
    );
    // Read budget allows until 3000, heartbeat only until 2000.
    expect(() => consumeHold(proof, OPERATION, WORKER, BOOT, 2_001, 2_001)).toThrow(HoldProofExpiredError);
  });

  it("is bound to its operation, worker and boot", () => {
    for (const [operation, worker, boot] of [
      ["77777777-7777-4777-8777-777777777777", WORKER, BOOT],
      [OPERATION, { ...WORKER, pid: 1 }, BOOT],
      [OPERATION, WORKER, "88888888-8888-4888-8888-888888888888"],
    ] as const) {
      const proof = proveNativeHold(readback(), expectation(1_200));
      expect(() => consumeHold(proof, operation, worker, boot, 1_300, 1_300)).toThrow(HoldProofExpiredError);
    }
    // Serialized JSON never reconstructs a proof.
    expect(() => consumeHold(JSON.parse(JSON.stringify({})) as object, OPERATION, WORKER, BOOT, 1, 1)).toThrow();
  });
});

describe("stop under a fresh proof", () => {
  const now = { wall: 0, mono: 0 };
  const clock = { now: () => now.wall, mono: () => now.mono };
  const advance = (ms: number) => {
    now.wall += ms;
    now.mono += ms;
  };

  function harness(options: { persistMs?: number; bootoutDelayMs?: number; collectFail?: boolean } = {}) {
    now.wall = 1_000;
    now.mono = 1_000;
    const signals: string[] = [];
    const release = vi.fn(async () => {});
    const collect = vi.fn(async (challenge: { requestId: string; requestedAt: number }) => {
      if (options.collectFail) throw new Error("status closed by another owner");
      const observedAt = now.wall;
      advance(100);
      return readback({
        requestId: challenge.requestId,
        requestedAt: challenge.requestedAt,
        observedAt,
        completedAt: now.wall,
        observedMono: observedAt,
        completedMono: now.mono,
        telemetryUpdatedAt: observedAt - 10,
      });
    });
    let ids = 0;
    const run = () =>
      stopUnderFreshProof({
        operationId: OPERATION,
        worker: WORKER,
        bootId: BOOT,
        clock,
        maintenanceDeadline: { wall: 31_000, mono: 31_000 },
        randomId: () => `${REQUEST.slice(0, 35)}${ids++}`,
        collect: (challenge) => collect(challenge),
        persistSignalsBegun: async () => {
          advance(options.persistMs ?? 0);
        },
        bootout: async (beforeExec) => {
          advance(options.bootoutDelayMs ?? 0);
          beforeExec();
          signals.push("bootout");
        },
        release,
      });
    return { run, signals, release, collect };
  }

  it("stops once when the proof is consumed within its original budget", async () => {
    const h = harness();
    await expect(h.run()).resolves.toEqual({ kind: "stopped", attempts: 1 });
    expect(h.signals).toEqual(["bootout"]);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("re-collects every decisive observation after an expiry caught at dispatch", async () => {
    const h = harness({ persistMs: 2_500 });
    // Every attempt spends 2.5 s persisting, so dispatch always misses its window;
    // the loop keeps taking complete fresh readbacks until the 30 s deadline, then releases.
    const outcome = await h.run();
    expect(outcome.kind).toBe("deferred");
    expect(h.signals).toEqual([]);
    expect(h.collect.mock.calls.length).toBeGreaterThan(1);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("catches a delayed inspection inside the real controller before launchd dispatch", async () => {
    now.wall = 1_000;
    now.mono = 1_000;
    const pair = buildServiceDefinitions({
      instanceId: "dodi",
      nodePath: "/opt/node/bin/node",
      hiveHome: "/Users/example/hive",
      configPath: "/Users/example/hive/hive.yaml",
      home: "/Users/example",
      pathEnv: "/usr/bin:/bin",
    });
    const plist = JSON.stringify({
      Label: pair.worker.label,
      ProgramArguments: [pair.worker.nodePath, pair.worker.entrypoint, "start"],
      WorkingDirectory: pair.worker.hiveHome,
      EnvironmentVariables: buildServiceEnvironment(pair.worker),
    });
    let bootouts = 0;
    let slowInspect = true;
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "lsof" && args[0] === "-nP") {
        throw Object.assign(new Error("none"), { code: 1, stdout: "" });
      }
      if (bootouts > 0 && command === "launchctl" && args[0] === "print" && args[1].includes("/com.")) {
        throw Object.assign(new Error("gone"), { code: 113, stderr: "Could not find specified service" });
      }
      if (bootouts > 0 && command === "ps" && !args.includes("comm=")) {
        throw Object.assign(new Error("gone"), { code: 1, stdout: "" });
      }
      if (command === "launchctl" && args[0] === "print" && args.length === 2 && args[1].includes("/com.")) {
        if (slowInspect) {
          // The controller's awaited inspection runs after the proof was built.
          advance(2_500);
          slowInspect = false;
        }
        return { stdout: "state = running\npid = 4242\n", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "bootout") {
        bootouts += 1;
        return { stdout: "", stderr: "" };
      }
      if (command === "launchctl") return { stdout: "{ disabled services = {} }", stderr: "" };
      if (command === "plutil") return { stdout: plist, stderr: "" };
      if (command === "ps" && args.includes("comm=")) return { stdout: "/opt/node/bin/node\n", stderr: "" };
      if (command === "ps") {
        return {
          stdout: `4242 1 Mon Sep 14 10:00:00 2026 ${pair.worker.nodePath} ${pair.worker.entrypoint} start\n`,
          stderr: "",
        };
      }
      if (command === "lsof" && args.includes("cwd")) return { stdout: "p4242\nn/Users/example/hive\n", stderr: "" };
      if (command === "lsof") return { stdout: "p4242\nn/opt/node/bin/node\n", stderr: "" };
      throw new Error(`unexpected ${command}`);
    });
    const io: ServiceIO = {
      execFile: exec,
      access: async () => {},
      chmod: async () => {},
      lstat: async (path) => {
        if (path.includes("LaunchAgents")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return {
          mode: 0o100600,
          dev: 1,
          ino: 2,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      },
      mkdir: async () => {},
      readFile: async () => Buffer.from(""),
      readlink: async () => "",
      realpath: async (path) => path,
      rename: async () => {},
      symlink: async () => {},
      unlink: async () => {},
      writeFile: async () => {},
      getuid: () => 501,
      now: () => now.wall,
      sleep: async (ms) => advance(ms),
      randomId: () => "id",
    };
    const controller = new ServiceController(
      {
        instanceId: "dodi",
        hiveHome: "/Users/example/hive",
        home: "/Users/example",
        operationDir: "/Users/example/hive/.hive-state/deployment/operations/x",
      },
      io,
    );
    const release = vi.fn(async () => {});
    let attempt = 0;
    const outcome = await stopUnderFreshProof({
      operationId: OPERATION,
      worker: WORKER,
      bootId: BOOT,
      clock,
      maintenanceDeadline: { wall: 1_000 + 30_000, mono: 1_000 + 30_000 },
      randomId: () => `${REQUEST.slice(0, 35)}${attempt++}`,
      collect: async (challenge) =>
        readback({
          requestId: challenge.requestId,
          requestedAt: challenge.requestedAt,
          observedAt: challenge.requestedAt,
          completedAt: now.wall,
          observedMono: challenge.requestedAt,
          completedMono: now.mono,
          telemetryUpdatedAt: challenge.requestedAt,
        }),
      persistSignalsBegun: async () => {},
      bootout: (beforeExec) =>
        controller.bootout(pair.worker, {
          markIrreversible: async () => {},
          healthListenerPort: 3107,
          beforeExec,
        }),
      release,
    });
    // First attempt expired inside the delayed inspection: no dispatch. The
    // second attempt used a completely fresh readback and dispatched once.
    expect(attempt).toBe(2);
    expect(outcome.kind).toBe("stopped");
    expect(bootouts).toBe(1);
  });

  it("releases and defers when a post-close readback fails", async () => {
    const h = harness({ collectFail: true });
    await expect(h.run()).resolves.toMatchObject({ kind: "deferred" });
    expect(h.signals).toEqual([]);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("propagates a failed terminal release as an error, never a success", async () => {
    const h = harness({ collectFail: true });
    h.release.mockRejectedValueOnce(new Error("release unacknowledged"));
    await expect(h.run()).rejects.toThrow("release unacknowledged");
    expect(h.signals).toEqual([]);
  });
});
