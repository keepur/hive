/**
 * Operation-record fences (KPR-463 plan chunk 5 Task 8 Step 6a.1a / Task 9
 * Step 5a.1a): work-kind dispatch, fixed mode/phase/target refusal, and the
 * creation/commit/promotion/rename fences. Real temp directories only — no
 * operator config, Keychain, launchd or vendor call.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  OPERATION_SCHEMA_VERSION,
  OperationBusyError,
  OperationUnresolvedError,
  acquireOperation,
  decodeOperationRecord,
  directoryIdentity,
  disposeOwnedDirectory,
  emptyStaging,
  finishOperationLock,
  locateDirectoryIdentity,
  moveOwnedDirectory,
  operationPaths,
  persistOperation,
  reconcileArtifactMove,
  recordStagingJob,
  recordStagingPromotion,
  sameDirectoryIdentity,
  setOperationPhase,
  workKindForMode,
  writeOperationJson,
  type OperationRecord,
} from "./operation.js";
import { initialRegistryWork } from "./pilot.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-operation-")));
  roots.push(root);
  return root;
}

const DIGEST = "a".repeat(64);

function acquire(instanceHome: string, overrides: Partial<Parameters<typeof acquireOperation>[0]> = {}) {
  return acquireOperation({
    instanceHome,
    instanceId: "kpr463unit",
    mode: "update",
    toolSha256: DIGEST,
    ownerStartTime: "Mon Sep 14 04:00:00 2026",
    ...overrides,
  });
}

function record(overrides: Partial<OperationRecord> = {}): Record<string, unknown> {
  return {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    id: "11111111-1111-4111-8111-111111111111",
    workKind: "lifecycle",
    ownerPid: 4242,
    frozenOwner: null,
    ownerStartTime: "Mon Sep 14 04:00:00 2026",
    canonicalHome: "/tmp/instance",
    instanceId: "kpr463unit",
    mode: "update",
    phase: "preflight",
    toolSha256: DIGEST,
    startedAt: "2026-09-14T04:00:00.000Z",
    signalsBegun: false,
    priorProfile: "stopped",
    priorSnapshotPath: "/tmp/instance/prior.json",
    retainedPaths: [],
    staging: emptyStaging(),
    ...overrides,
  } as unknown as Record<string, unknown>;
}

describe("work-kind dispatch (fixed modes only)", () => {
  it("maps every lifecycle mode to lifecycle work", () => {
    for (const mode of ["update", "check", "rollback", "start", "stop", "restart", "pilot-rollback"] as const) {
      expect(workKindForMode(mode)).toBe("lifecycle");
    }
  });

  it("maps bootstrap and every registry runbook mode away from lifecycle work", () => {
    expect(workKindForMode("bootstrap")).toBe("bootstrap");
    for (const mode of [
      "capture-pilot",
      "inventory-pilot",
      "prepare-legacy-hold",
      "verify-legacy-hold",
      "release-legacy-hold",
    ] as const) {
      expect(workKindForMode(mode)).toBe("registry");
    }
  });

  it("refuses to acquire when the mode and the declared work kind disagree", async () => {
    const root = home();
    await expect(acquire(root, { workKind: "registry" })).rejects.toThrow(/mode does not match its work kind/);
    await expect(acquire(root, { mode: "inventory-pilot", workKind: "registry" })).rejects.toThrow(
      /registry work requires exactly its registry state/,
    );
    await expect(acquire(root, { mode: "update", registry: initialRegistryWork("inventory-pilot") })).rejects.toThrow(
      /registry work requires exactly its registry state/,
    );
  });
});

describe("operation record decoding", () => {
  it("accepts the current schema and a legacy v1 record", () => {
    expect(decodeOperationRecord(record())).toMatchObject({ schemaVersion: OPERATION_SCHEMA_VERSION });
    expect(decodeOperationRecord({ schemaVersion: 1, id: "x" })).toMatchObject({ schemaVersion: 1 });
  });

  it("refuses a non-object, an unknown schema, and a missing or unknown work kind", () => {
    for (const value of [null, [], "record", 3]) {
      expect(() => decodeOperationRecord(value)).toThrow(OperationUnresolvedError);
    }
    expect(() => decodeOperationRecord(record({ schemaVersion: 99 as never }))).toThrow(/schema is unsupported/);
    expect(() => decodeOperationRecord(record({ workKind: undefined as never }))).toThrow(/work kind is missing/);
    expect(() => decodeOperationRecord(record({ workKind: "artifact" as never }))).toThrow(/work kind is missing/);
  });

  it("refuses a frozen owner that is absent, stringified or non-positive", () => {
    const withOwner = (frozenOwner: unknown) => {
      const value = record();
      if (frozenOwner === undefined) delete value.frozenOwner;
      else value.frozenOwner = frozenOwner;
      return value;
    };
    expect(() => decodeOperationRecord(withOwner(undefined))).toThrow(/frozen owner is missing or invalid/);
    // A stringified number is not a PID.
    expect(() => decodeOperationRecord(withOwner({ pid: "4242", startTime: "s" }))).toThrow(/frozen owner/);
    expect(() => decodeOperationRecord(withOwner({ pid: 0, startTime: "s" }))).toThrow(/frozen owner/);
    expect(() => decodeOperationRecord(withOwner({ pid: 4242, startTime: 1 }))).toThrow(/frozen owner/);
    expect(decodeOperationRecord(withOwner({ pid: 4242, startTime: "s" }))).toMatchObject({
      frozenOwner: { pid: 4242 },
    });
  });

  it("refuses non-lifecycle work that carries lifecycle signal or artifact fields", () => {
    const registryWork = record({ workKind: "registry" as never });
    registryWork.registry = { command: "inventory-pilot" };
    expect(decodeOperationRecord({ ...registryWork })).toMatchObject({ workKind: "registry" });
    expect(() => decodeOperationRecord({ ...registryWork, signalsBegun: true })).toThrow(
      /carries lifecycle signal or artifact fields/,
    );
    expect(() => decodeOperationRecord({ ...registryWork, artifactMove: { from: "a", to: "b" } })).toThrow(
      /carries lifecycle signal or artifact fields/,
    );
  });

  it("refuses mismatched or doubled work-state branches", () => {
    const registryWork = record({ workKind: "registry" as never });
    expect(() => decodeOperationRecord({ ...registryWork })).toThrow(/registry work state is missing or mismatched/);
    expect(() =>
      decodeOperationRecord({ ...registryWork, registry: { command: "x" }, bootstrap: { phase: "y" } }),
    ).toThrow(/registry work state is missing or mismatched/);
    // A boolean masquerading as work state is not work state.
    expect(() => decodeOperationRecord({ ...registryWork, registry: true })).toThrow(/missing or mismatched/);
    expect(() => decodeOperationRecord({ ...record(), bootstrap: { phase: "y" } })).toThrow(
      /lifecycle work carries non-lifecycle state/,
    );
  });

  it("refuses incomplete staging fields", () => {
    const { selfTest: _selfTest, ...partial } = emptyStaging();
    void _selfTest;
    expect(() => decodeOperationRecord(record({ staging: partial as never }))).toThrow(/staging fields are incomplete/);
    expect(() => decodeOperationRecord(record({ staging: { ...emptyStaging(), jobs: {} } as never }))).toThrow(
      /staging fields are incomplete/,
    );
    expect(() =>
      decodeOperationRecord(record({ staging: { ...emptyStaging(), cloneVerified: "true" } as never })),
    ).toThrow(/staging fields are incomplete/);
  });
});

describe("operation acquisition fences", () => {
  it("records the lock, the operation directory and both record copies", async () => {
    const root = home();
    const operation = await acquire(root);
    const paths = operationPaths(root, operation.record.id);
    expect(lstatSync(paths.lockDirectory).isDirectory()).toBe(true);
    expect(lstatSync(paths.operationDirectory).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(paths.operationRecord, "utf8"))).toMatchObject({ id: operation.record.id });
    expect(JSON.parse(readFileSync(paths.currentRecord, "utf8"))).toMatchObject({ id: operation.record.id });
    await finishOperationLock(operation);
  });

  it("refuses an invalid instance ID, helper digest or non-directory home", async () => {
    const root = home();
    await expect(acquire(root, { instanceId: "../escape" })).rejects.toThrow(/invalid Hive instance ID/);
    await expect(acquire(root, { toolSha256: "short" })).rejects.toThrow(/invalid deployment helper digest/);
    const link = resolve(root, "link");
    symlinkSync(root, link);
    // realpath resolves the link, so the symlinked home is accepted as its target;
    // a plain file is not a home at all.
    const file = resolve(root, "file");
    writeFileSync(file, "x");
    await expect(acquire(file)).rejects.toThrow(/invalid canonical instance home/);
  });

  it("reports the live owner rather than stealing an existing lock", async () => {
    const root = home();
    const first = await acquire(root);
    await expect(acquire(root)).rejects.toBeInstanceOf(OperationBusyError);
    await expect(acquire(root)).rejects.toThrow(new RegExp(`operation=${first.record.id}`));
    await finishOperationLock(first);
  });

  it("treats a lock without trustworthy owner metadata as unresolved, not busy", async () => {
    const root = home();
    const paths = operationPaths(root, "unused");
    mkdirSync(paths.lockDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(paths.lockDirectory, "owner.json"), "{ not json");
    await expect(acquire(root)).rejects.toBeInstanceOf(OperationUnresolvedError);
  });

  it("requires reconciliation when the previous record is unreadable, foreign or unsettled", async () => {
    for (const previous of [
      "{ not json",
      JSON.stringify(record({ canonicalHome: "/elsewhere" })),
      JSON.stringify(record({ instanceId: "other" })),
      JSON.stringify(record({ phase: "unresolved" })),
      JSON.stringify(record({ signalsBegun: true })),
    ]) {
      const root = home();
      const paths = operationPaths(root, "unused");
      mkdirSync(resolve(paths.deploymentRoot), { recursive: true, mode: 0o700 });
      writeFileSync(paths.currentRecord, previous);
      await expect(acquire(root)).rejects.toBeInstanceOf(OperationUnresolvedError);
    }
  });

  it("retains the settled previous record beside the new operation", async () => {
    const root = home();
    const first = await acquire(root);
    first.record.resolution = "deferred";
    await persistOperation(first);
    await finishOperationLock(first);
    const second = await acquire(root);
    const retained = JSON.parse(
      readFileSync(resolve(second.paths.operationDirectory, "previous-operation.json"), "utf8"),
    );
    expect(retained).toMatchObject({ id: first.record.id, resolution: "deferred" });
    await finishOperationLock(second);
  });
});

describe("staging and phase fences", () => {
  it("appends job and promotion records durably and advances the phase", async () => {
    const root = home();
    const operation = await acquire(root);
    await recordStagingJob(operation, {
      jobId: "job-1",
      kind: "install",
      path: resolve(root, ".hive-state", "jobs", "op", "job-1"),
      identity: { dev: 1, ino: 2, uid: process.getuid!() },
      profileSha256: "b".repeat(64),
      state: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    await recordStagingPromotion(operation, {
      method: "full-copy",
      source: resolve(root, "src"),
      destination: resolve(root, ".hive.next"),
      state: "observed",
      copyPid: 99,
      copyStartTime: "Mon Sep 14 04:00:00 2026",
      exitCode: 0,
      destinationIdentity: { dev: 1, ino: 3 },
      discarded: false,
    });
    await setOperationPhase(operation, "staged");
    const persisted = JSON.parse(readFileSync(operation.paths.currentRecord, "utf8"));
    expect(persisted.phase).toBe("staged");
    expect(persisted.staging.jobs).toHaveLength(1);
    expect(persisted.staging.promotion).toMatchObject({ method: "full-copy", state: "observed" });
    expect(decodeOperationRecord(persisted)).toMatchObject({ phase: "staged" });
    await finishOperationLock(operation);
  });

  it("writes operation JSON atomically and leaves no temporary behind", async () => {
    const root = home();
    const path = resolve(root, "state.json");
    await writeOperationJson(path, { a: 1 });
    await writeOperationJson(path, { a: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 2 });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("owned-directory identity fences", () => {
  it("binds identity to dev/ino and refuses a replaced directory", async () => {
    const root = home();
    const target = resolve(root, "tree");
    mkdirSync(target, { mode: 0o700 });
    const identity = await directoryIdentity(target);
    expect(await sameDirectoryIdentity(target, identity)).toBe(true);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { mode: 0o700 });
    expect(await sameDirectoryIdentity(target, identity)).toBe(false);
    rmSync(target, { recursive: true, force: true });
    expect(await sameDirectoryIdentity(target, identity)).toBe(false);
    // A file or a symlink is never an owned directory identity.
    writeFileSync(target, "x");
    await expect(directoryIdentity(target)).rejects.toThrow(/not an owned directory/);
  });

  it("renames only into an absent destination, fenced on both sides", async () => {
    const root = home();
    const operation = await acquire(root);
    const from = resolve(root, ".hive");
    const to = resolve(root, ".hive.prev");
    mkdirSync(from, { mode: 0o700 });
    mkdirSync(to, { mode: 0o700 });
    await expect(moveOwnedDirectory(operation, from, to)).rejects.toThrow(/destination is occupied/);
    rmSync(to, { recursive: true, force: true });
    const identity = await moveOwnedDirectory(operation, from, to);
    expect(lstatSync(to).isDirectory()).toBe(true);
    expect(operation.record.artifactMove).toMatchObject({ from, to, state: "observed" });
    expect(operation.record.retainedPaths).toContain(to);
    expect(operation.record.retainedPaths).not.toContain(from);
    expect(await locateDirectoryIdentity(identity, [from, to])).toBe(to);
    // Neither side, or both sides, is ambiguous rather than a guess.
    await expect(locateDirectoryIdentity(identity, [from])).rejects.toBeInstanceOf(OperationUnresolvedError);
    await finishOperationLock(operation);
  });

  it("refuses an artifact path outside the instance home", async () => {
    const root = home();
    const outside = home();
    const operation = await acquire(root);
    mkdirSync(resolve(outside, "tree"), { mode: 0o700 });
    await expect(moveOwnedDirectory(operation, resolve(outside, "tree"), resolve(root, ".hive"))).rejects.toThrow(
      /escapes instance home/,
    );
    await finishOperationLock(operation);
  });

  it("disposes only a proven identity and only after a durable resolution", async () => {
    const root = home();
    const operation = await acquire(root);
    const target = resolve(root, ".hive.prev");
    mkdirSync(target, { mode: 0o700 });
    const identity = await directoryIdentity(target);
    // No resolution yet: disposal is refused outright.
    await expect(disposeOwnedDirectory(operation, target, identity)).rejects.toThrow(/durable verified resolution/);
    operation.record.resolution = "completed";
    await persistOperation(operation);
    // A different inode now occupies the path; it must not be removed.
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { mode: 0o700 });
    await expect(disposeOwnedDirectory(operation, target, identity)).rejects.toThrow(/identity changed/);
    expect(lstatSync(target).isDirectory()).toBe(true);
    await disposeOwnedDirectory(operation, target, await directoryIdentity(target));
    expect(operation.record.artifactDisposal).toMatchObject({ path: target, state: "observed" });
    await finishOperationLock(operation);
  });
});

describe("artifact move reconciliation", () => {
  it("reports which side of the rename an interrupted move landed on", async () => {
    const root = home();
    const operation = await acquire(root);
    const from = resolve(root, ".hive");
    const to = resolve(root, ".hive.prev");
    mkdirSync(from, { mode: 0o700 });
    const identity = await directoryIdentity(from);
    operation.record.artifactMove = { from, to, directoryIdentity: identity, state: "intended" };
    expect(await reconcileArtifactMove(operation.record)).toBe("before");
    await moveOwnedDirectory(operation, from, to);
    expect(await reconcileArtifactMove(operation.record)).toBe("after");
    await finishOperationLock(operation);
  });

  it("is unresolved when the recorded identity is on neither side", async () => {
    const root = home();
    const operation = await acquire(root);
    const from = resolve(root, ".hive");
    mkdirSync(from, { mode: 0o700 });
    const identity = await directoryIdentity(from);
    rmSync(from, { recursive: true, force: true });
    operation.record.artifactMove = {
      from,
      to: resolve(root, ".hive.prev"),
      directoryIdentity: identity,
      state: "intended",
    };
    await expect(reconcileArtifactMove(operation.record)).rejects.toBeInstanceOf(OperationUnresolvedError);
    await finishOperationLock(operation);
  });
});
