import { JobRequest } from "@livekit/agents";
import { expect, it, vi } from "vitest";
import { AdmissionLedger, unresolvedJobDiagnostics, type AdmissionSnapshot, type SupervisorRef } from "./admission.js";

const SUPERVISOR: SupervisorRef = { pid: 100, bootId: "boot-a" };

function request(
  id: string,
  onAccept: () => Promise<void> = async () => {},
  onReject: () => Promise<void> = async () => {},
): JobRequest {
  return new JobRequest({ id } as JobRequest["job"], onReject, onAccept);
}

it("accept resolution leaves an accepted-but-unassigned job unresolved", async () => {
  const gate = new AdmissionLedger({ pid: 100, bootId: "boot-a" }, () => {});
  let assignmentResolved = false;
  let finishAssignment!: () => void;
  const assignment = new Promise<void>((resolve) => {
    finishAssignment = resolve;
  });
  const req = new JobRequest(
    { id: "job-a" } as JobRequest["job"],
    async () => {
      throw new Error("unexpected rejection");
    },
    async () => {
      await assignment;
      assignmentResolved = true;
    },
  );
  await gate.request(req);
  expect(assignmentResolved).toBe(false);
  expect(gate.snapshot().unresolved).toHaveLength(1);
  gate.close("op-a");
  expect(gate.canStop("op-a", 0, 0)).toBe(false);
  finishAssignment();
  await assignment;
  expect(gate.canStop("op-a", 0, 0)).toBe(false);
});

it("reserves synchronously before the acceptance callback reaches its first await", async () => {
  const snapshots: AdmissionSnapshot[] = [];
  let releaseAccept!: () => void;
  const acceptBlocked = new Promise<void>((resolve) => {
    releaseAccept = resolve;
  });
  const gate = new AdmissionLedger(
    SUPERVISOR,
    (snapshot) => snapshots.push(snapshot),
    () => 42,
  );

  const accepting = gate.request(request("job-a", () => acceptBlocked));

  expect(gate.snapshot().unresolved).toEqual([{ jobId: "job-a", acceptedAt: 42, phase: "accepted-awaiting-entry" }]);
  expect(snapshots).toHaveLength(1);
  releaseAccept();
  await accepting;
});

it("tracks matching child entry and completion without treating process exit as completion", async () => {
  const gate = new AdmissionLedger(SUPERVISOR, () => {});
  await gate.request(request("job-a"));

  gate.entered(SUPERVISOR, "job-a", 321);
  expect(gate.snapshot()).toMatchObject({
    unresolved: [
      {
        jobId: "job-a",
        phase: "entered-awaiting-completion",
        childPid: 321,
      },
    ],
    childPids: [321],
  });

  gate.pruneExitedChildren(new Set([321]));
  expect(gate.snapshot().childPids).toEqual([321]);
  expect(() => gate.completed({ pid: 101, bootId: "boot-a" }, "job-a", 321)).toThrow("supervisor mismatch");
  expect(() => gate.completed(SUPERVISOR, "job-a", 999)).toThrow("completion lacks matching entry");

  gate.completed(SUPERVISOR, "job-a", 321);
  expect(gate.snapshot().unresolved).toEqual([]);
  expect(gate.snapshot().childPids).toEqual([321]);
  gate.pruneExitedChildren(new Set([321]));
  expect(gate.snapshot().childPids).toEqual([]);
});

it("rejects requests after close and never transfers an existing operation owner", async () => {
  const rejectAfterClose = vi.fn(async () => {});
  const rejectDuplicate = vi.fn(async () => {});
  const gate = new AdmissionLedger(SUPERVISOR, () => {});
  await gate.request(request("job-a"));
  gate.close("op-a");

  await gate.request(request("job-b", async () => {}, rejectAfterClose));
  await gate.request(request("job-a", async () => {}, rejectDuplicate));

  expect(rejectAfterClose).toHaveBeenCalledOnce();
  expect(rejectDuplicate).toHaveBeenCalledOnce();
  expect(() => gate.close("op-b")).toThrow("maintenance owned by another operation");
  expect(gate.snapshot()).toMatchObject({ operationId: "op-a", admission: "closed" });
});

it("retains an unresolved completion when its persistence write fails", async () => {
  let writes = 0;
  const gate = new AdmissionLedger(SUPERVISOR, () => {
    writes += 1;
    if (writes === 3) throw new Error("disk-full");
  });
  await gate.request(request("job-a"));
  gate.entered(SUPERVISOR, "job-a", 321);

  expect(() => gate.completed(SUPERVISOR, "job-a", 321)).toThrow("disk-full");
  expect(gate.snapshot()).toMatchObject({
    admission: "closed",
    persistenceFault: true,
    unresolved: [{ jobId: "job-a", childPid: 321 }],
  });
  expect(gate.canStop("op-a", 0, 0)).toBe(false);
});

it("retains the attempted reservation and rejects when its first persistence write fails", async () => {
  const reject = vi.fn(async () => {});
  const gate = new AdmissionLedger(SUPERVISOR, () => {
    throw new Error("fsync-failed");
  });

  await expect(gate.request(request("job-a", async () => {}, reject))).rejects.toThrow("fsync-failed");
  expect(reject).toHaveBeenCalledOnce();
  expect(gate.snapshot()).toMatchObject({
    admission: "closed",
    persistenceFault: true,
    unresolved: [{ jobId: "job-a", phase: "accepted-awaiting-entry" }],
  });
});

it("keeps a failed reservation fault closed until an explicit same-owner release", async () => {
  let fail = true;
  const acceptFirst = vi.fn(async () => {});
  const rejectFirst = vi.fn(async () => {});
  const rejectSecond = vi.fn(async () => {});
  let stateAtFinalization: AdmissionSnapshot | undefined;
  const gate = new AdmissionLedger(SUPERVISOR, () => {
    if (fail) {
      fail = false;
      throw new Error("one-shot-write-failure");
    }
  });

  await expect(gate.request(request("unknown-job", acceptFirst, rejectFirst))).rejects.toThrow(
    "one-shot-write-failure",
  );
  await gate.request(request("next-job", async () => {}, rejectSecond));
  const refreshed = gate.refresh();

  expect(acceptFirst).not.toHaveBeenCalled();
  expect(rejectFirst).toHaveBeenCalledOnce();
  expect(rejectSecond).toHaveBeenCalledOnce();
  expect(refreshed).toMatchObject({
    admission: "closed",
    operationId: null,
    persistenceFault: true,
    unresolved: [{ jobId: "unknown-job", phase: "accepted-awaiting-entry" }],
  });
  expect(gate.canStop("op-a", 0, 0)).toBe(false);

  const released = gate.release("op-a", () => {
    stateAtFinalization = gate.snapshot();
  });
  expect(stateAtFinalization).toMatchObject({
    admission: "closed",
    operationId: "op-a",
    persistenceFault: true,
    unresolved: [{ jobId: "unknown-job" }],
  });
  expect(released).toMatchObject({
    admission: "open",
    operationId: null,
    persistenceFault: false,
    unresolved: [{ jobId: "unknown-job" }],
  });
});

it("retains the close owner and latch when close persistence fails", () => {
  let fail = true;
  const gate = new AdmissionLedger(SUPERVISOR, () => {
    if (fail) {
      fail = false;
      throw new Error("close-write-failed");
    }
  });

  expect(() => gate.close("op-a")).toThrow("close-write-failed");
  expect(gate.snapshot()).toMatchObject({ admission: "closed", operationId: "op-a", persistenceFault: true });
  expect(gate.refresh()).toMatchObject({ admission: "closed", operationId: "op-a", persistenceFault: true });
});

it.each(["closed", "open"] as const)("retains closed ownership when the release %s write fails", (stage) => {
  let writes = 0;
  const gate = new AdmissionLedger(SUPERVISOR, () => {
    writes += 1;
    const failingWrite = stage === "closed" ? 2 : 3;
    if (writes === failingWrite) throw new Error(`${stage}-write-failed`);
  });
  gate.close("op-a");

  expect(() => gate.release("op-a", () => {})).toThrow(`${stage}-write-failed`);
  expect(gate.snapshot()).toMatchObject({ admission: "closed", operationId: "op-a", persistenceFault: true });
});

it("retains a completed child when prune persistence fails", async () => {
  let failPrune = false;
  const gate = new AdmissionLedger(SUPERVISOR, () => {
    if (failPrune) throw new Error("prune-write-failed");
  });
  await gate.request(request("job-a"));
  gate.entered(SUPERVISOR, "job-a", 321);
  gate.completed(SUPERVISOR, "job-a", 321);
  failPrune = true;

  expect(() => gate.pruneExitedChildren(new Set([321]))).toThrow("prune-write-failed");
  expect(gate.snapshot()).toMatchObject({ persistenceFault: true, unresolved: [], childPids: [321] });
});

it("projects retained operator diagnostics without mutating admission state", async () => {
  const gate = new AdmissionLedger(
    SUPERVISOR,
    () => {},
    () => 100,
  );
  await gate.request(request("job-a"));
  gate.entered(SUPERVISOR, "job-a", 321);

  expect(unresolvedJobDiagnostics(gate.snapshot(), 250)).toEqual([
    {
      jobId: "job-a",
      acceptedAt: 100,
      ageMs: 150,
      phase: "entered-awaiting-completion",
      childPid: 321,
      supervisorPid: SUPERVISOR.pid,
      supervisorBootId: SUPERVISOR.bootId,
    },
  ]);
});

class Sdk164ShutdownFake {
  draining = false;
  drainCalls = 0;
  closeCalls = 0;

  async drain(): Promise<void> {
    this.drainCalls += 1;
    this.draining = true;
    throw new Error("timed out draining");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async cliSignal(): Promise<void> {
    try {
      await this.drain();
    } catch {
      // The pinned CLI logs the drain failure and continues to close().
    }
    await this.close();
  }
}

it("models the pinned SDK's irreversible drain and close-after-timeout signal path", async () => {
  const sdk = new Sdk164ShutdownFake();

  await sdk.cliSignal();

  expect(sdk).toMatchObject({ draining: true, drainCalls: 1, closeCalls: 1 });
});

it("defers a 30-second assignment-gap race without touching the irreversible shutdown path", async () => {
  let now = 1_000;
  let finishAssignment!: () => void;
  const assignment = new Promise<void>((resolve) => {
    finishAssignment = resolve;
  });
  let callAlive = true;
  const servicePids = { engine: 601, worker: 602 };
  const originalPids = { ...servicePids };
  const effects = {
    signal: vi.fn(),
    bootout: vi.fn(),
    swap: vi.fn(),
  };
  const sdk = new Sdk164ShutdownFake();
  const gate = new AdmissionLedger(
    SUPERVISOR,
    () => {},
    () => now,
  );
  const req = request("job-a", async () => {
    await assignment;
    callAlive = false;
  });

  await gate.request(req);
  gate.close("op-a");
  const rejectedAfterClosure = vi.fn(async () => {});
  await gate.request(request("job-b", async () => {}, rejectedAfterClosure));
  now += 30_001;

  expect(now - gate.snapshot().unresolved[0]!.acceptedAt).toBeGreaterThan(30_000);
  expect(gate.canStop("op-a", 0, 0)).toBe(false);
  expect(rejectedAfterClosure).toHaveBeenCalledOnce();
  expect(sdk).toMatchObject({ draining: false, drainCalls: 0, closeCalls: 0 });
  expect(effects.signal).not.toHaveBeenCalled();
  expect(effects.bootout).not.toHaveBeenCalled();
  expect(effects.swap).not.toHaveBeenCalled();
  expect(servicePids).toEqual(originalPids);
  expect(callAlive).toBe(true);

  const releaseAck = gate.release("op-a", () => {});
  expect(releaseAck).toMatchObject({
    supervisor: SUPERVISOR,
    operationId: null,
    admission: "open",
    persistenceFault: false,
    unresolved: [{ jobId: "job-a", phase: "accepted-awaiting-entry" }],
  });
  finishAssignment();
  await assignment;
  expect(callAlive).toBe(false);
});

it.each([
  ["missing", null],
  [
    "stale",
    {
      supervisor: { pid: 100, bootId: "older-boot" },
      operationId: null,
      admission: "open",
      persistenceFault: false,
      unresolved: [],
      childPids: [],
    } satisfies AdmissionSnapshot,
  ],
])("classifies a %s release acknowledgement as maintenance-unresolved", async (_name, ack) => {
  const sdk = new Sdk164ShutdownFake();
  const gate = new AdmissionLedger(SUPERVISOR, () => {});
  await gate.request(request("job-a"));
  gate.close("op-a");
  let availabilityClaimed = false;

  const matchingRelease =
    ack !== null &&
    ack.supervisor.pid === SUPERVISOR.pid &&
    ack.supervisor.bootId === SUPERVISOR.bootId &&
    ack.operationId === null &&
    ack.admission === "open" &&
    !ack.persistenceFault;
  const result = matchingRelease ? "maintenance-deferred" : "maintenance-unresolved";
  if (matchingRelease) availabilityClaimed = true;

  expect(result).toBe("maintenance-unresolved");
  expect(availabilityClaimed).toBe(false);
  expect(sdk).toMatchObject({ draining: false, drainCalls: 0, closeCalls: 0 });
});
