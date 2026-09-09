import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unresolvedJobDiagnostics, type RequestLike, type SupervisorRef } from "./admission.js";
import {
  corroborateMaintenanceBeforeStop,
  createJobReporter,
  createMaintenanceSupervisor,
  nodeMailboxFileSystem,
  requestMaintenance,
  writeJsonAtomic,
  writeJsonAtomicWithFileSystem,
  type JobEvent,
  type MailboxFileSystem,
  type MaintenanceCommand,
  type MaintenanceReply,
} from "./maintenance-ipc.js";

const SUPERVISOR: SupervisorRef = {
  pid: 41_201,
  bootId: "11111111-1111-4111-8111-111111111111",
};
const OP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_A = "10000000-0000-4000-8000-000000000001";
const REQUEST_B = "20000000-0000-4000-8000-000000000002";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(label = "instance & state"): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "hive-maintenance-ipc-"));
  temporaryRoots.push(root);
  const home = join(root, label);
  mkdirSync(home, { mode: 0o700 });
  return { root, home };
}

function request(id: string, accepted = vi.fn(), rejected = vi.fn()): RequestLike {
  return {
    id,
    async accept() {
      accepted();
    },
    async reject() {
      rejected();
    },
  };
}

interface HarnessOptions {
  home?: string;
  fileSystem?: MailboxFileSystem;
  inspectChildPids?: (pids: readonly number[]) => Promise<ReadonlyMap<number, "absent" | "present" | "unknown">>;
}

function harness(options: HarnessOptions = {}) {
  const made = options.home ? undefined : makeHome();
  const home = options.home ?? made!.home;
  let now = 10_000;
  const supervisor = createMaintenanceSupervisor({
    instanceHome: home,
    instanceId: "dodi",
    supervisor: SUPERVISOR,
    bootedAt: 9_000,
    sdkHost: "127.0.0.1",
    sdkPort: 32_007,
    now: () => now,
    fileSystem: options.fileSystem,
    inspectChildPids: options.inspectChildPids,
  });
  const stages: string[] = [];
  const send = async (
    kind: MaintenanceCommand["kind"],
    operationId: string,
    requestId: string,
    beforePoll?: () => void,
    deadlineDelta = 500,
  ): Promise<MaintenanceReply> =>
    requestMaintenance({
      instanceHome: home,
      instanceId: "dodi",
      operationId,
      kind,
      deadline: now + deadlineDelta,
      supervisor: SUPERVISOR,
      corroborateSupervisor: async (stage) => {
        stages.push(stage);
        return SUPERVISOR;
      },
      expectedAdmission: kind === "status" ? "any" : undefined,
      now: () => now,
      randomId: () => requestId,
      fileSystem: options.fileSystem,
      sleep: async (milliseconds) => {
        now += milliseconds;
        beforePoll?.();
        beforePoll = undefined;
        await supervisor.pollOnce();
      },
    });
  return {
    home,
    supervisor,
    stages,
    send,
    now: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function bootPath(home: string): string {
  return join(realpathSync(home), ".hive-state", "voice-worker", SUPERVISOR.bootId);
}

function readReply(home: string, requestId: string): MaintenanceReply {
  return JSON.parse(readFileSync(join(bootPath(home), "replies", `${requestId}.json`), "utf8")) as MaintenanceReply;
}

function writeCommand(home: string, command: MaintenanceCommand): void {
  writeJsonAtomic(join(bootPath(home), "commands", `${command.requestId}.json`), command);
}

function command(requestId: string, operationId: string, kind: MaintenanceCommand["kind"]): MaintenanceCommand {
  return { protocol: 1, requestId, operationId, supervisor: SUPERVISOR, kind };
}

describe("maintenance mailbox protocol", () => {
  it("keeps import inert and initializes private state only through the explicit producer", () => {
    const { home } = makeHome();
    expect(readdirSync(home)).toEqual([]);

    const h = harness({ home });

    expect(lstatSync(join(home, ".hive-state")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(bootPath(home), "snapshot.json")).mode & 0o777).toBe(0o600);
    expect(h.supervisor.stateDirectory).toBe(bootPath(home));
  });

  it("closes, reports fresh status, rejects later admission, and terminally releases", async () => {
    const h = harness();
    const accepted = vi.fn();
    const rejected = vi.fn();
    await h.supervisor.ledger.request(request("job-before-close", accepted));

    const closed = await h.send("close", OP_A, REQUEST_A);
    await h.supervisor.ledger.request(request("job-after-close", vi.fn(), rejected));
    const status = await h.send("status", OP_A, REQUEST_B);
    const released = await h.send("release", OP_A, "30000000-0000-4000-8000-000000000003");

    expect(accepted).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledOnce();
    expect(closed.snapshot).toMatchObject({ admission: "closed", operationId: OP_A, persistenceFault: false });
    expect(status.snapshot.unresolved).toHaveLength(1);
    expect(released).toMatchObject({ operationId: OP_A, ok: true, snapshot: { admission: "open", operationId: null } });
    expect(h.stages).toEqual(["before-current", "before-close", "before-current", "before-current"]);
  });

  it("sorts sequence 1 before sequence 2, validates identity, and replays consumed events idempotently", async () => {
    const h = harness();
    await h.supervisor.ledger.request(request("job-a"));
    const reporter = createJobReporter({
      jobId: "job-a",
      pid: 51_001,
      env: {
        HIVE_VOICE_SUPERVISOR_PID: String(SUPERVISOR.pid),
        HIVE_VOICE_SUPERVISOR_BOOT_ID: SUPERVISOR.bootId,
        HIVE_VOICE_STATE_DIR: h.supervisor.stateDirectory,
      },
    });
    reporter.entered();
    reporter.completed();
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ unresolved: [], childPids: [51_001] });

    const wrongEvent: JobEvent = {
      protocol: 1,
      eventId: "40000000-0000-4000-8000-000000000004",
      supervisor: SUPERVISOR,
      jobId: "missing-job",
      childPid: 51_002,
      sequence: 2,
      kind: "completed",
    };
    writeJsonAtomic(join(bootPath(h.home), "jobs", `${wrongEvent.eventId}.json`), wrongEvent);
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ persistenceFault: false, unresolved: [] });
  });

  it("rejects wrong boot, wrong PID completion, duplicate jobs, and missing reporter tracking", async () => {
    const h = harness();
    const duplicateRejected = vi.fn();
    await h.supervisor.ledger.request(request("job-a"));
    await h.supervisor.ledger.request(request("job-a", vi.fn(), duplicateRejected));
    h.supervisor.ledger.entered(SUPERVISOR, "job-a", 51_001);
    expect(() => h.supervisor.ledger.completed(SUPERVISOR, "job-a", 51_002)).toThrow("matching entry");
    expect(() => h.supervisor.ledger.completed({ ...SUPERVISOR, bootId: OP_B }, "job-a", 51_001)).toThrow(
      "supervisor mismatch",
    );
    expect(() => createJobReporter({ jobId: "job-a", env: {}, pid: 51_001 })).toThrow("tracking identity");
    expect(duplicateRejected).toHaveBeenCalledOnce();
    expect(h.supervisor.ledger.snapshot().unresolved).toHaveLength(1);
  });

  it("retains accepted and entered diagnostics regardless of age or absent process observations", async () => {
    const h = harness({ inspectChildPids: async (pids) => new Map(pids.map((pid) => [pid, "absent" as const])) });
    await h.supervisor.ledger.request(request("awaiting-entry"));
    await h.supervisor.ledger.request(request("awaiting-completion"));
    h.supervisor.ledger.entered(SUPERVISOR, "awaiting-completion", 51_001);
    h.advance(90_000);
    await h.supervisor.pollOnce();

    expect(unresolvedJobDiagnostics(h.supervisor.ledger.snapshot(), h.now())).toEqual([
      expect.objectContaining({
        jobId: "awaiting-entry",
        supervisorPid: SUPERVISOR.pid,
        supervisorBootId: SUPERVISOR.bootId,
        ageMs: 90_000,
        phase: "accepted-awaiting-entry",
      }),
      expect.objectContaining({
        jobId: "awaiting-completion",
        childPid: 51_001,
        phase: "entered-awaiting-completion",
      }),
    ]);
    expect(h.supervisor.ledger.snapshot().childPids).toEqual([51_001]);
  });

  it("prunes only completed children whose absence was positively verified", async () => {
    let observations = new Map<number, "absent" | "present" | "unknown">();
    const h = harness({ inspectChildPids: async () => observations });
    for (const [jobId, pid] of [
      ["present-child", 51_011],
      ["unknown-child", 51_012],
      ["absent-child", 51_013],
    ] as const) {
      await h.supervisor.ledger.request(request(jobId));
      h.supervisor.ledger.entered(SUPERVISOR, jobId, pid);
      h.supervisor.ledger.completed(SUPERVISOR, jobId, pid);
    }
    observations = new Map([
      [51_011, "present"],
      [51_012, "unknown"],
      [51_013, "absent"],
    ]);
    h.advance(1_000);
    await h.supervisor.pollOnce();

    expect(h.supervisor.ledger.snapshot().childPids).toEqual([51_011, 51_012]);
  });

  it("uses an intentional symlinked home while rejecting symlinked state children", () => {
    const { root, home } = makeHome("real home with spaces & symbols");
    const link = join(root, "selected-home");
    symlinkSync(home, link);
    const h = harness({ home: link });
    expect(h.supervisor.stateDirectory.startsWith(realpathSync(home))).toBe(true);
    h.supervisor.stop();

    const badBoot = "55555555-5555-4555-8555-555555555555";
    const bad = join(realpathSync(home), ".hive-state", "voice-worker", badBoot);
    symlinkSync(bootPath(home), bad);
    expect(() =>
      createMaintenanceSupervisor({
        instanceHome: link,
        instanceId: "dodi",
        supervisor: { pid: 41_202, bootId: badBoot },
        bootedAt: 1,
        sdkHost: "127.0.0.1",
        sdkPort: 32_008,
      }),
    ).toThrow("not private");
  });

  it("ignores non-regular, symlinked, oversized, and structurally invalid messages without changing ownership", async () => {
    const h = harness();
    const commands = join(bootPath(h.home), "commands");
    const directoryId = "90000000-0000-4000-8000-000000000009";
    mkdirSync(join(commands, `${directoryId}.json`), { mode: 0o700 });
    const oversizedId = "91000000-0000-4000-8000-000000000009";
    writeFileSync(join(commands, `${oversizedId}.json`), "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    const target = join(h.home, "outside.json");
    writeFileSync(target, JSON.stringify(command(REQUEST_A, OP_A, "close")), { mode: 0o600 });
    symlinkSync(target, join(commands, "92000000-0000-4000-8000-000000000009.json"));
    writeFileSync(join(commands, "93000000-0000-4000-8000-000000000009.json"), '{"protocol":2}\n', {
      mode: 0o600,
    });

    await h.supervisor.pollOnce();

    expect(h.supervisor.ledger.snapshot()).toMatchObject({
      admission: "open",
      operationId: null,
      persistenceFault: false,
    });
  });

  it("separates instances and refuses stale current supervisor identity", async () => {
    const first = harness();
    const secondHome = makeHome("second").home;
    const secondRef = { pid: 41_202, bootId: "66666666-6666-4666-8666-666666666666" };
    createMaintenanceSupervisor({
      instanceHome: secondHome,
      instanceId: "keepur",
      supervisor: secondRef,
      bootedAt: 1,
      sdkHost: "127.0.0.1",
      sdkPort: 32_008,
    });

    await expect(
      requestMaintenance({
        instanceHome: first.home,
        instanceId: "dodi",
        operationId: OP_A,
        kind: "status",
        deadline: Date.now() + 100,
        corroborateSupervisor: async () => secondRef,
      }),
    ).rejects.toThrow("stale current");
    await expect(
      requestMaintenance({
        instanceHome: first.home,
        instanceId: "keepur",
        operationId: OP_A,
        kind: "status",
        deadline: Date.now() + 100,
        corroborateSupervisor: async () => SUPERVISOR,
      }),
    ).rejects.toThrow("another instance");
    expect(readdirSync(join(bootPath(first.home), "commands"))).toEqual([]);
    expect(
      readdirSync(join(realpathSync(secondHome), ".hive-state", "voice-worker", secondRef.bootId, "commands")),
    ).toEqual([]);
  });

  it("rejects state owned by a different user before reading mailbox messages", () => {
    const { home } = makeHome();
    const wrongOwnerFs: MailboxFileSystem = {
      ...nodeMailboxFileSystem,
      lstatSync(path) {
        const stat = lstatSync(path);
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "uid") return target.uid + 1;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
      },
    };

    expect(() =>
      createMaintenanceSupervisor({
        instanceHome: home,
        instanceId: "dodi",
        supervisor: SUPERVISOR,
        bootedAt: 1,
        sdkHost: "127.0.0.1",
        sdkPort: 32_007,
        fileSystem: wrongOwnerFs,
      }),
    ).toThrow("wrong owner");
  });

  it("requires an independent matching supervisor identity immediately before stop", async () => {
    await expect(corroborateMaintenanceBeforeStop(SUPERVISOR, async () => SUPERVISOR)).resolves.toBeUndefined();
    await expect(
      corroborateMaintenanceBeforeStop(SUPERVISOR, async () => ({ ...SUPERVISOR, pid: SUPERVISOR.pid + 1 })),
    ).rejects.toThrow("changed before stop");
  });

  it("rejects stale replies and times out release without inferring restored admission", async () => {
    const h = harness();
    const stale: MaintenanceReply = {
      protocol: 1,
      requestId: REQUEST_A,
      operationId: OP_A,
      supervisor: SUPERVISOR,
      ok: true,
      snapshot: h.supervisor.ledger.snapshot(),
      writtenAt: 1,
    };
    writeJsonAtomic(join(bootPath(h.home), "replies", `${REQUEST_A}.json`), stale);
    await expect(h.send("status", OP_A, REQUEST_A)).rejects.toThrow("stale or mismatched");

    let now = 1_000;
    await expect(
      requestMaintenance({
        instanceHome: h.home,
        instanceId: "dodi",
        operationId: OP_A,
        kind: "release",
        deadline: 1_100,
        corroborateSupervisor: async () => SUPERVISOR,
        now: () => now,
        randomId: () => REQUEST_B,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("timed out");
    expect(readdirSync(join(bootPath(h.home), "commands"))).toContain(`${REQUEST_B}.json`);
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ admission: "open", operationId: null });
  });

  it("lets a terminal release overtake delayed close and defeats the old close receipt", async () => {
    const h = harness();
    writeCommand(h.home, command(REQUEST_A, OP_A, "close"));
    writeCommand(h.home, command(REQUEST_B, OP_A, "release"));
    // Lexical request ordering processes close then release in one poll. A retained
    // close is delivered again after the finalization fence exists.
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ admission: "open", operationId: null });
    writeCommand(h.home, command("30000000-0000-4000-8000-000000000003", OP_A, "close"));
    await h.supervisor.pollOnce();

    expect(readReply(h.home, "30000000-0000-4000-8000-000000000003")).toMatchObject({
      ok: false,
      classification: "operation-finalized",
      operationId: OP_A,
      snapshot: { admission: "open", operationId: null },
    });
    const next = await h.send("close", OP_B, "40000000-0000-4000-8000-000000000004");
    expect(next.snapshot.operationId).toBe(OP_B);
  });

  it("makes release-before-close terminal across lost response, repeats, status, and a foreign owner", async () => {
    const h = harness();
    const release = await h.send("release", OP_A, REQUEST_A);
    expect(release.snapshot.operationId).toBeNull();
    const repeated = await h.send("release", OP_A, REQUEST_B);
    expect(repeated).toMatchObject({ ok: true, operationId: OP_A, snapshot: { operationId: null } });
    const openStatus = await h.send("status", OP_A, "25000000-0000-4000-8000-000000000002");
    expect(openStatus).toMatchObject({
      ok: true,
      operationId: OP_A,
      snapshot: { admission: "open", operationId: null },
    });
    await expect(h.send("close", OP_A, "30000000-0000-4000-8000-000000000003")).rejects.toThrow("operation-finalized");

    await h.send("close", OP_B, "40000000-0000-4000-8000-000000000004");
    await expect(h.send("release", OP_A, "50000000-0000-4000-8000-000000000005")).rejects.toThrow("owner-conflict");
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ admission: "closed", operationId: OP_B });
  });

  it("treats a corrupt terminal marker as uncertainty and never acknowledges a close", async () => {
    const h = harness();
    await h.send("release", OP_A, REQUEST_A);
    const marker = join(bootPath(h.home), "finalized", `${OP_A}.json`);
    writeFileSync(marker, "not-json\n", { mode: 0o600 });

    await expect(h.send("close", OP_A, REQUEST_B)).rejects.toThrow("persistence");
    expect(h.supervisor.ledger.snapshot()).toMatchObject({
      admission: "closed",
      operationId: OP_A,
      persistenceFault: true,
    });
  });
});

type FaultMethod = "write" | "file-fsync" | "close" | "rename" | "directory-fsync" | "unlink";

function faultableFileSystem() {
  let fault: { method: FaultMethod; match?: (path: string) => boolean; remaining: number } | undefined;
  const fdPaths = new Map<number, string>();
  const openFds = new Set<number>();
  const trip = (method: FaultMethod, path: string): void => {
    if (fault?.method === method && fault.remaining > 0 && (!fault.match || fault.match(path))) {
      fault.remaining -= 1;
      const error = new Error(`injected ${method}`) as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
  };
  const fs: MailboxFileSystem = {
    ...nodeMailboxFileSystem,
    openSync(path, flags, mode) {
      const fd = openSync(path, flags, mode);
      fdPaths.set(fd, path);
      openFds.add(fd);
      return fd;
    },
    closeSync(fd) {
      const path = fdPaths.get(fd) ?? "unknown";
      trip("close", path);
      closeSync(fd);
      fdPaths.delete(fd);
      openFds.delete(fd);
    },
    fsyncSync(fd) {
      const path = fdPaths.get(fd) ?? "unknown";
      trip(lstatSync(path).isDirectory() ? "directory-fsync" : "file-fsync", path);
      fsyncSync(fd);
    },
    writeFileSync(fd, data) {
      trip("write", fdPaths.get(fd) ?? "unknown");
      writeFileSync(fd, data);
    },
    renameSync(from, to) {
      trip("rename", to);
      renameSync(from, to);
    },
    unlinkSync(path) {
      trip("unlink", path);
      unlinkSync(path);
    },
  };
  return {
    fs,
    openFds,
    fail(method: FaultMethod, match?: (path: string) => boolean, count = 1) {
      fault = { method, match, remaining: count };
    },
    clear() {
      fault = undefined;
    },
  };
}

describe("durability and conservative failure handling", () => {
  it.each<[FaultMethod]>([["write"], ["file-fsync"], ["close"], ["rename"], ["directory-fsync"]])(
    "keeps atomic write invariants across %s failure",
    (method) => {
      const { home } = makeHome();
      const directory = join(home, "atomic");
      mkdirSync(directory, { mode: 0o700 });
      const target = join(directory, "state.json");
      writeFileSync(target, '{"old":true}\n', { mode: 0o600 });
      const f = faultableFileSystem();
      f.fail(method);

      expect(() => writeJsonAtomicWithFileSystem(target, { next: true }, f.fs)).toThrow("atomic state write failed");
      if (method !== "directory-fsync") expect(readFileSync(target, "utf8")).toBe('{"old":true}\n');
      else expect(readFileSync(target, "utf8")).toBe('{"next":true}\n');
      expect(readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      expect(f.openFds.size).toBe(0);
    },
  );

  it("preserves the primary atomic error when temp cleanup also fails and closes all descriptors", () => {
    const { home } = makeHome();
    const directory = join(home, "atomic");
    mkdirSync(directory, { mode: 0o700 });
    const target = join(directory, "state.json");
    const base = faultableFileSystem();
    let writeFailed = false;
    const fs: MailboxFileSystem = {
      ...base.fs,
      writeFileSync() {
        writeFailed = true;
        throw new Error("primary-write");
      },
      unlinkSync() {
        throw new Error("cleanup-failed");
      },
    };

    let caught: unknown;
    try {
      writeJsonAtomicWithFileSystem(target, { next: true }, fs);
    } catch (error) {
      caught = error;
    }
    expect(writeFailed).toBe(true);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String).join(" ")).toContain("primary-write");
    expect((caught as AggregateError).errors.map(String).join(" ")).toContain("cleanup-failed");
    expect(base.openFds.size).toBe(0);
  });

  it("faults closed on close persistence and reply persistence failures", async () => {
    for (const target of ["snapshot.json", "/replies/"]) {
      const f = faultableFileSystem();
      const h = harness({ fileSystem: f.fs });
      await expect(
        h.send("close", OP_A, REQUEST_A, () => {
          f.fail("rename", (path) => path.endsWith(target) || path.includes(target));
        }),
      ).rejects.toThrow();
      expect(h.supervisor.ledger.snapshot()).toMatchObject({
        admission: "closed",
        operationId: OP_A,
        persistenceFault: true,
      });
    }
  });

  it("retries one command-file transport failure with the same immutable request", async () => {
    const f = faultableFileSystem();
    const h = harness({ fileSystem: f.fs });
    f.fail("rename", (path) => path.includes("/commands/"));

    const reply = await h.send("close", OP_A, REQUEST_A);

    expect(reply).toMatchObject({ ok: true, requestId: REQUEST_A, operationId: OP_A });
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ admission: "closed", operationId: OP_A });
  });

  it.each(["command-receipt", "directory-fsync"] as const)(
    "does not acknowledge an uncertain %s write and keeps the same owner fault closed",
    async (failure) => {
      const f = faultableFileSystem();
      const h = harness({ fileSystem: f.fs });
      await expect(
        h.send("close", OP_A, REQUEST_A, () => {
          if (failure === "command-receipt") {
            f.fail("rename", (path) => path.includes("/command-receipts/"));
          } else {
            f.fail("directory-fsync", (path) => path.includes("/command-receipts"));
          }
        }),
      ).rejects.toThrow();
      expect(h.supervisor.ledger.snapshot()).toMatchObject({
        admission: "closed",
        operationId: OP_A,
        persistenceFault: true,
      });
    },
  );

  it.each([
    ["closed-state", (path: string, call: number) => path.endsWith("snapshot.json") && call === 1],
    ["finalization", (path: string) => path.includes("/finalized/")],
    ["open-state", (path: string, call: number) => path.endsWith("snapshot.json") && call === 2],
  ])("retains owner and fault when release %s persistence fails, then reconciles", async (_name, shouldFail) => {
    const f = faultableFileSystem();
    const h = harness({ fileSystem: f.fs });
    await h.supervisor.ledger.request(request("retained-job"));
    let snapshotRenames = 0;
    await expect(
      h.send("release", OP_A, REQUEST_A, () => {
        f.fail("rename", (path) => {
          if (path.endsWith("snapshot.json")) snapshotRenames += 1;
          return shouldFail(path, snapshotRenames);
        });
      }),
    ).rejects.toThrow();
    expect(h.supervisor.ledger.snapshot()).toMatchObject({
      admission: "closed",
      operationId: OP_A,
      persistenceFault: true,
      unresolved: [{ jobId: "retained-job" }],
    });
    f.clear();
    const retry = await h.send("release", OP_A, REQUEST_B);
    expect(retry.snapshot).toMatchObject({
      admission: "open",
      operationId: null,
      persistenceFault: false,
      unresolved: [{ jobId: "retained-job" }],
    });
  });

  it("retains command receipt across failed unlink, then lets terminal release defeat every old close", async () => {
    const f = faultableFileSystem();
    const h = harness({ fileSystem: f.fs });
    const oldCommand = join(bootPath(h.home), "commands", `${REQUEST_A}.json`);
    const closed = await h.send("close", OP_A, REQUEST_A, () => f.fail("unlink", (path) => path === oldCommand, 20));
    expect(closed.ok).toBe(true);
    expect(readdirSync(dirname(oldCommand))).toContain(`${REQUEST_A}.json`);

    // Reusing the request ID with a different immutable body is invalid and
    // cannot transfer the gate to the conflicting operation.
    writeJsonAtomic(oldCommand, command(REQUEST_A, OP_B, "close"));
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ admission: "closed", operationId: OP_A });
    writeJsonAtomic(oldCommand, command(REQUEST_A, OP_A, "close"));

    f.clear();
    await h.send("release", OP_A, REQUEST_B);
    writeCommand(h.home, command("30000000-0000-4000-8000-000000000003", OP_A, "close"));
    await h.supervisor.pollOnce();
    expect(readReply(h.home, "30000000-0000-4000-8000-000000000003")).toMatchObject({
      ok: false,
      classification: "operation-finalized",
    });
    expect(h.supervisor.ledger.snapshot()).toMatchObject({ admission: "open", operationId: null });
  });

  it.each(["receipt", "snapshot"] as const)(
    "keeps completion unresolved when %s persistence fails and applies an exact retry once",
    async (target) => {
      const f = faultableFileSystem();
      const h = harness({ fileSystem: f.fs });
      await h.supervisor.ledger.request(request("job-a"));
      h.supervisor.ledger.entered(SUPERVISOR, "job-a", 51_001);
      const event: JobEvent = {
        protocol: 1,
        eventId: "70000000-0000-4000-8000-000000000007",
        supervisor: SUPERVISOR,
        jobId: "job-a",
        childPid: 51_001,
        sequence: 2,
        kind: "completed",
      };
      writeJsonAtomic(join(bootPath(h.home), "jobs", `${event.eventId}.json`), event);
      f.fail("rename", (path) =>
        target === "receipt" ? path.includes("/event-receipts/") : path.endsWith("snapshot.json"),
      );
      await h.supervisor.pollOnce();
      expect(h.supervisor.ledger.snapshot()).toMatchObject({
        persistenceFault: true,
        unresolved: [{ jobId: "job-a", childPid: 51_001 }],
      });

      f.clear();
      await h.supervisor.pollOnce();
      expect(h.supervisor.ledger.snapshot()).toMatchObject({ persistenceFault: true, unresolved: [] });
      await h.supervisor.pollOnce();
      expect(h.supervisor.ledger.snapshot().unresolved).toEqual([]);
    },
  );

  it("retains receipt when event deletion fails and never applies completion to another job", async () => {
    const f = faultableFileSystem();
    const h = harness({ fileSystem: f.fs });
    await h.supervisor.ledger.request(request("job-a"));
    await h.supervisor.ledger.request(request("job-b"));
    h.supervisor.ledger.entered(SUPERVISOR, "job-a", 51_001);
    h.supervisor.ledger.entered(SUPERVISOR, "job-b", 51_002);
    const event: JobEvent = {
      protocol: 1,
      eventId: "80000000-0000-4000-8000-000000000008",
      supervisor: SUPERVISOR,
      jobId: "job-a",
      childPid: 51_001,
      sequence: 2,
      kind: "completed",
    };
    const eventPath = join(bootPath(h.home), "jobs", `${event.eventId}.json`);
    writeJsonAtomic(eventPath, event);
    f.fail("unlink", (path) => path === eventPath);
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot().unresolved.map((job) => job.jobId)).toEqual(["job-b"]);
    expect(readdirSync(join(bootPath(h.home), "event-receipts"))).toContain(`${event.eventId}.json`);

    f.clear();
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot().unresolved.map((job) => job.jobId)).toEqual(["job-b"]);
    expect(readdirSync(join(bootPath(h.home), "jobs"))).toEqual([]);
  });
});

describe("bounded tracking and process census", () => {
  it("runs 4,000 complete cycles without growing completed child state or replies", async () => {
    // This storage-bound case still uses real files, atomic temp creation and
    // rename. The separately injected atomic-write matrix proves fsync behavior;
    // avoiding 16,000 physical disk flushes keeps this regression practical.
    const h = harness({ fileSystem: { ...nodeMailboxFileSystem, fsyncSync() {} } });
    await h.supervisor.ledger.request(request("retained-unknown"));
    h.supervisor.ledger.entered(SUPERVISOR, "retained-unknown", 59_999);
    for (let index = 0; index < 4_000; index += 1) {
      const jobId = `cycle-${index}`;
      const pid = 60_000 + index;
      await h.supervisor.ledger.request(request(jobId));
      h.supervisor.ledger.entered(SUPERVISOR, jobId, pid);
      h.supervisor.ledger.completed(SUPERVISOR, jobId, pid);
      h.supervisor.ledger.pruneExitedChildren(new Set([pid]));
    }
    expect(h.supervisor.ledger.snapshot()).toMatchObject({
      admission: "open",
      unresolved: [{ jobId: "retained-unknown", phase: "entered-awaiting-completion", childPid: 59_999 }],
      childPids: [59_999],
    });
    const close = await h.send("close", OP_A, REQUEST_A);
    const status = await h.send("status", OP_A, REQUEST_B);
    const release = await h.send("release", OP_A, "30000000-0000-4000-8000-000000000003");
    for (const reply of [close, status, release]) {
      expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThan(16 * 1024);
    }
  }, 30_000);

  it("does not prune present, unknown, or unresolved PIDs and recovers capacity only after completion plus verified exit", async () => {
    const h = harness();
    let index = 0;
    let rejected = false;
    while (!rejected) {
      const accepted = vi.fn();
      const reject = vi.fn();
      await h.supervisor.ledger.request(request(`capacity-${index}-${"x".repeat(300)}`, accepted, reject));
      rejected = reject.mock.calls.length === 1;
      index += 1;
      expect(index).toBeLessThan(100);
    }
    const before = h.supervisor.ledger.snapshot();
    expect(before.unresolved.length).toBeGreaterThan(1);
    const first = before.unresolved[0]!;
    h.supervisor.ledger.entered(SUPERVISOR, first.jobId, 71_001);
    h.supervisor.ledger.pruneExitedChildren(new Set([71_001]));
    expect(h.supervisor.ledger.snapshot().childPids).toContain(71_001);
    h.supervisor.ledger.completed(SUPERVISOR, first.jobId, 71_001);
    h.supervisor.ledger.pruneExitedChildren(new Set());
    expect(h.supervisor.ledger.snapshot().childPids).toContain(71_001);
    h.supervisor.ledger.pruneExitedChildren(new Set([71_001]));
    expect(h.supervisor.ledger.snapshot().childPids).not.toContain(71_001);

    const acceptedAfterRecovery = vi.fn();
    await h.supervisor.ledger.request(request("capacity-recovered", acceptedAfterRecovery));
    expect(acceptedAfterRecovery).toHaveBeenCalledOnce();
    expect(h.supervisor.ledger.snapshot().unresolved.slice(0, -1)).toEqual(before.unresolved.slice(1));
  });
});
