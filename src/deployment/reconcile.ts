/**
 * Concrete next-invocation reconciliation (KPR-463 plan chunk 4 Task 8 Step 1a,
 * chunk 5 Task 8 Step 1a.3 Step 4).
 *
 * Parent side (`inspectOrReconcile`, called after dry-run and before any new
 * acquisition): validate the existing lock/current record, return busy while
 * the original parent OR its frozen helper child is live, serialize contenders
 * through an exclusive `<lock>/reconcile` claim (never by unlinking the lock),
 * then run the ORIGINAL hash-verified frozen helper with the internal
 * `--reconcile-operation` mode. Successful reconciliation is reported as
 * `PREVIOUS_OPERATION_RECONCILED` and never executes the newly requested action.
 *
 * Frozen side (`runReconcileOperation`): record the recovery executor, dispatch
 * by durable work kind before reading any lifecycle field, and for lifecycle
 * work drive `reconcileInterruptedOperation` with the concrete adapters below.
 * Staging reconciliation (live recorded promotion copy busy, unverified clones
 * discarded, job trees swept non-fatally) runs inside that shared gate.
 *
 * There is no age-based lock removal, no descendant census and no kill.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logging/logger.js";
import { requestMaintenance } from "../voice-worker/maintenance-ipc.js";
import { freshAdmissionStatus, parseBootIdentity } from "./health.js";
import {
  decodeOperationRecord,
  directoryIdentity,
  disposeOwnedDirectory,
  locateDirectoryIdentity,
  moveOwnedDirectory,
  OperationBusyError,
  OperationUnresolvedError,
  operationPaths,
  persistOperation,
  RECONCILE_CLAIM_DIRECTORY,
  reconcileInterruptedOperation,
  sameDirectoryIdentity,
  writeOperationJson,
  type AcquiredOperation,
  type InterruptedOperationIO,
  type InterruptedOperationResult,
  type OperationRecord,
  type OperationWorkKind,
  type ProcessOwner,
} from "./operation.js";
import {
  loadPrior,
  PriorSnapshotIncompleteError,
  restorePrior,
  verifyPrior,
  verifyStoppedPrior,
  type LoadedPrior,
} from "./prior.js";
import { ArtifactRotation } from "./transaction.js";
import { PluginCompatibilityUnresolvedError, reconcileBetaPluginCompatibility } from "./plugin-compat.js";
import type { ServiceController, ServiceInspection } from "./services.js";

const log = createLogger("deployment-reconcile");
const execFile = promisify(nodeExecFile);

export const PREVIOUS_OPERATION_RECONCILED = "PREVIOUS_OPERATION_RECONCILED";

export interface ReconcileClaim {
  schemaVersion: 1;
  claimId: string;
  operationId: string;
  claimant: ProcessOwner;
  executor: ProcessOwner | null;
  claimedAt: string;
}

/** Process/filesystem boundary for the parent-side reconciler. */
export interface ReconcileHostIO {
  /** Start time of a live PID, null when absent. Throws when OS readback is unavailable. */
  processStartTime(pid: number): Promise<string | null>;
  self(): Promise<ProcessOwner>;
  runFrozen(
    nodePath: string,
    helperPath: string,
    args: readonly string[],
    env: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now(): Date;
  randomId(): string;
}

async function psStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid PID");
  try {
    const result = await execFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return result.stdout.trim() || null;
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code === 1 && !String(failure.stdout ?? "").trim()) return null;
    throw new OperationUnresolvedError("process identity readback is unavailable", { cause: error });
  }
}

export const nodeReconcileHostIO: ReconcileHostIO = {
  processStartTime: psStartTime,
  async self() {
    const startTime = await psStartTime(process.pid);
    if (!startTime) throw new OperationUnresolvedError("own process identity is unavailable");
    return { pid: process.pid, startTime };
  },
  async runFrozen(nodePath, helperPath, args, env) {
    try {
      const result = await execFile(nodePath, [helperPath, ...args], {
        encoding: "utf8",
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
      };
    }
  },
  now: () => new Date(),
  randomId: randomUUID,
};

export async function processIsLive(
  io: Pick<ReconcileHostIO, "processStartTime">,
  owner: ProcessOwner,
): Promise<boolean> {
  const startTime = await io.processStartTime(owner.pid);
  // A reused PID with another start time is not the original owner.
  return startTime !== null && startTime === owner.startTime;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function parseClaim(value: unknown, operationId: string): ReconcileClaim {
  const claim = value as Partial<ReconcileClaim> | null;
  const owner = (candidate: unknown): candidate is ProcessOwner =>
    !!candidate &&
    typeof candidate === "object" &&
    Number.isSafeInteger((candidate as ProcessOwner).pid) &&
    typeof (candidate as ProcessOwner).startTime === "string";
  if (
    !claim ||
    claim.schemaVersion !== 1 ||
    typeof claim.claimId !== "string" ||
    claim.operationId !== operationId ||
    !owner(claim.claimant) ||
    (claim.executor !== null && !owner(claim.executor)) ||
    typeof claim.claimedAt !== "string"
  ) {
    throw new OperationUnresolvedError("reconcile claim metadata is invalid");
  }
  return claim as ReconcileClaim;
}

interface StaleLock {
  canonicalHome: string;
  record: OperationRecord;
  paths: ReturnType<typeof operationPaths>;
}

/** Strictly validate the lock owner and current record without trusting either alone. */
async function readStaleLock(instanceHome: string): Promise<StaleLock | null> {
  const canonicalHome = await realpath(instanceHome);
  const deploymentRoot = resolve(canonicalHome, ".hive-state", "deployment");
  const lockDirectory = resolve(deploymentRoot, "lock");
  try {
    const info = await lstat(lockDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new OperationUnresolvedError("deployment lock is not a real directory");
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  let owner: { id?: unknown; ownerPid?: unknown; ownerStartTime?: unknown; canonicalHome?: unknown };
  try {
    owner = JSON.parse(await readFile(resolve(lockDirectory, "owner.json"), "utf8")) as typeof owner;
  } catch (error) {
    // A crash after mkdir but before owner metadata is ambiguous, not stale.
    throw new OperationUnresolvedError("DIRECTORY_CREATION_UNRESOLVED: deployment lock has no owner metadata", {
      cause: error,
    });
  }
  let decoded: ReturnType<typeof decodeOperationRecord>;
  try {
    decoded = decodeOperationRecord(JSON.parse(await readFile(resolve(deploymentRoot, "operation.json"), "utf8")));
  } catch (error) {
    throw new OperationUnresolvedError("stale lock has no decodable current operation record", { cause: error });
  }
  if (decoded.schemaVersion === 1) {
    throw new OperationUnresolvedError("schema-1 operation predates reconcilable ownership; retained");
  }
  const record = decoded;
  if (
    owner.id !== record.id ||
    owner.ownerPid !== record.ownerPid ||
    owner.ownerStartTime !== record.ownerStartTime ||
    owner.canonicalHome !== canonicalHome ||
    record.canonicalHome !== canonicalHome
  ) {
    throw new OperationUnresolvedError("stale lock and operation owner do not match");
  }
  return { canonicalHome, record, paths: operationPaths(canonicalHome, record.id) };
}

async function assertOwnersDead(io: Pick<ReconcileHostIO, "processStartTime">, record: OperationRecord): Promise<void> {
  if (await processIsLive(io, { pid: record.ownerPid, startTime: record.ownerStartTime })) {
    throw new OperationBusyError(`operation ${record.id} is owned by a live invoking process`);
  }
  if (record.frozenOwner && (await processIsLive(io, record.frozenOwner))) {
    throw new OperationBusyError(`operation ${record.id} is owned by a live frozen helper`);
  }
}

export type InspectOrReconcileOutcome =
  | { status: "clear" }
  | { status: "reconciled"; operationId: string; workKind: OperationWorkKind; outcome: Record<string, unknown> };

export interface InspectOrReconcileOptions {
  instanceHome: string;
  env: NodeJS.ProcessEnv;
  io?: ReconcileHostIO;
}

/**
 * Parent-side stale-lock handling before any new acquisition. Returns `clear`
 * when no lock exists; otherwise busy/unresolved errors, or the original frozen
 * helper's reconciliation outcome (the caller must exit nonzero).
 */
export async function inspectOrReconcile(options: InspectOrReconcileOptions): Promise<InspectOrReconcileOutcome> {
  const io = options.io ?? nodeReconcileHostIO;
  const stale = await readStaleLock(options.instanceHome);
  if (!stale) return { status: "clear" };
  const { record, paths } = stale;
  await assertOwnersDead(io, record);

  const claimDirectory = resolve(paths.lockDirectory, RECONCILE_CLAIM_DIRECTORY);
  const claimPath = resolve(claimDirectory, "owner.json");
  const attempts = resolve(paths.operationDirectory, "reconcile-attempts");
  const self = await io.self();
  const claim: ReconcileClaim = {
    schemaVersion: 1,
    claimId: io.randomId(),
    operationId: record.id,
    claimant: self,
    executor: null,
    claimedAt: io.now().toISOString(),
  };
  await mkdir(attempts, { recursive: true, mode: 0o700 });
  try {
    await mkdir(claimDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    let previous: ReconcileClaim;
    try {
      previous = parseClaim(JSON.parse(await readFile(claimPath, "utf8")), record.id);
    } catch (cause) {
      // Metadata missing after mkdir is ambiguous; never taken over by age.
      throw new OperationUnresolvedError("reconcile claim exists without trustworthy metadata", { cause });
    }
    if (
      (await processIsLive(io, previous.claimant)) ||
      (previous.executor !== null && (await processIsLive(io, previous.executor)))
    ) {
      throw new OperationBusyError(`operation ${record.id} is being reconciled by a live contender`);
    }
    // Abandoned claim: preserve an immutable attempt record before takeover.
    await writeOperationJson(resolve(attempts, `${previous.claimId}.abandoned.json`), previous);
  }
  await writeOperationJson(resolve(attempts, `${claim.claimId}.json`), claim);
  await writeOperationJson(claimPath, claim);

  // Re-read every original record and liveness fence after acquiring the claim.
  const again = await readStaleLock(options.instanceHome);
  if (!again || again.record.id !== record.id || again.record.toolSha256 !== record.toolSha256) {
    throw new OperationUnresolvedError("stale operation changed while the reconcile claim was acquired");
  }
  await assertOwnersDead(io, again.record);
  const current = parseClaim(JSON.parse(await readFile(claimPath, "utf8")), record.id);
  if (current.claimId !== claim.claimId) throw new OperationBusyError("another contender took the reconcile claim");

  // The recovery executor is the ORIGINAL hash-verified frozen helper.
  const helper = resolve(paths.operationDirectory, "deploy.min.js");
  const helperInfo = await lstat(helper).catch((cause: unknown) => {
    throw new OperationUnresolvedError("original frozen helper is missing; operation retained", { cause });
  });
  if (!helperInfo.isFile() || helperInfo.isSymbolicLink()) {
    throw new OperationUnresolvedError("original frozen helper is not a regular file");
  }
  if (
    createHash("sha256")
      .update(await readFile(helper))
      .digest("hex") !== record.toolSha256
  ) {
    throw new OperationUnresolvedError("original frozen helper digest changed; operation retained");
  }
  const nodePath = record.hostNodePath ?? process.execPath;
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "HIVE_CONFIG"] as const) {
    const value = options.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HIVE_HOME = stale.canonicalHome;
  const result = await io.runFrozen(
    nodePath,
    helper,
    [`--reconcile-operation=${paths.operationRecord}`, `--reconcile-claim=${claim.claimId}`],
    env,
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  let outcome: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outcome = parsed as Record<string, unknown>;
  } catch {
    outcome = null;
  }
  if (result.exitCode !== 0 || outcome?.status !== PREVIOUS_OPERATION_RECONCILED) {
    log.warn("Previous operation reconciliation did not resolve", { operationId: record.id });
    throw new OperationUnresolvedError(
      `previous operation ${record.id} could not be reconciled; lock and evidence retained`,
    );
  }
  return { status: "reconciled", operationId: record.id, workKind: record.workKind, outcome };
}

// ── frozen side ───────────────────────────────────────────────────────────

/** Supplied by the registry/bootstrap unit (chunk 5 Task 8 Step 1a.3 Step 4). */
export type NonLifecycleReconciler = (record: OperationRecord, claimId: string) => Promise<Record<string, unknown>>;

export interface LifecycleReconcileDeps {
  controller: Pick<ServiceController, "inspect" | "bootout" | "listenerOwners" | "restore">;
  host: Pick<ReconcileHostIO, "processStartTime">;
  /** Full packaged-release profile of the current `.hive` pair. */
  verifyPackaged(options: { minimumStartedAt: number }): Promise<void>;
  /** Pilot-recovery profile; supplied by the registry/hold evidence unit. */
  verifyPilot?(loaded: LoadedPrior): Promise<void>;
  /** Maintenance client (defaults to the shared `requestMaintenance`). */
  request?: typeof requestMaintenance;
  now?: () => number;
}

function packagedCommand(record: OperationRecord, component: "engine" | "voice-worker"): string {
  return resolve(
    record.canonicalHome,
    ".hive",
    "pkg",
    component === "engine" ? "server.min.js" : "voice-worker.min.js",
  );
}

/** A live registration is identified only as the captured prior or the packaged candidate. */
function identifiedService(record: OperationRecord, loaded: LoadedPrior, inspection: ServiceInspection): boolean {
  if (!inspection.loaded) return true;
  if (!inspection.process || !inspection.args) return false;
  const saved = loaded.prior.services.find((item) => item.definition.label === inspection.label);
  if (saved && JSON.stringify(saved.inspection.args) === JSON.stringify(inspection.args)) return true;
  const component = inspection.label.endsWith(".voice-worker") ? "voice-worker" : "engine";
  return inspection.args[1] === packagedCommand(record, component);
}

function slotIdentity(loaded: LoadedPrior, name: string) {
  return loaded.prior.slots.find((slot) => slot.name === name)?.identity ?? undefined;
}

function rotationFor(acquired: AcquiredOperation, loaded: LoadedPrior): ArtifactRotation {
  const rotation = new ArtifactRotation(acquired, async () => true);
  const promoted = acquired.record.staging.promotion;
  rotation.adoptCaptured({
    current: slotIdentity(loaded, ".hive"),
    previous: slotIdentity(loaded, ".hive.prev"),
    broken: slotIdentity(loaded, ".hive.broken"),
    next:
      promoted?.destinationIdentity && !promoted.discarded
        ? { device: promoted.destinationIdentity.dev, inode: promoted.destinationIdentity.ino }
        : undefined,
  });
  return rotation;
}

async function loadPriorOrUnresolved(record: OperationRecord): Promise<LoadedPrior> {
  try {
    return await loadPrior(record);
  } catch (error) {
    if (error instanceof PriorSnapshotIncompleteError) {
      throw new OperationUnresolvedError(`PRIOR_SNAPSHOT_INCOMPLETE: ${error.missing.join(",")}`, { cause: error });
    }
    throw error;
  }
}

/** Pre-signal: the captured live pair must still be the exact captured generation. */
async function assertLivePairUnchanged(deps: LifecycleReconcileDeps, loaded: LoadedPrior): Promise<void> {
  for (const saved of loaded.prior.services) {
    const live = await deps.controller.inspect(saved.definition.label);
    if (live.loaded !== saved.loaded)
      throw new OperationUnresolvedError(`${saved.definition.label} load state changed`);
    if (
      saved.inspection.process &&
      (live.process?.pid !== saved.inspection.process.pid ||
        live.process?.startTime !== saved.inspection.process.startTime)
    ) {
      throw new OperationUnresolvedError(`${saved.definition.label} generation changed before any recorded signal`);
    }
  }
}

/** Interrupted beta-plugin relocation uses the same list and algorithm (Task 9 Step 1b). */
async function reconcilePluginCompatibility(acquired: AcquiredOperation): Promise<void> {
  try {
    await reconcileBetaPluginCompatibility(acquired);
  } catch (error) {
    if (error instanceof PluginCompatibilityUnresolvedError) {
      throw new OperationUnresolvedError(`PLUGIN_COMPATIBILITY_UNRESOLVED: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

async function removeOwnedIncompleteNext(acquired: AcquiredOperation): Promise<void> {
  const promoted = acquired.record.staging.promotion;
  if (!promoted?.destinationIdentity || promoted.discarded) return;
  const identity = { device: promoted.destinationIdentity.dev, inode: promoted.destinationIdentity.ino };
  if (!(await sameDirectoryIdentity(promoted.destination, identity))) return;
  acquired.record.resolution = acquired.record.resolution ?? "deferred";
  await disposeOwnedDirectory(acquired, promoted.destination, identity);
  promoted.discarded = true;
  await persistOperation(acquired);
}

async function restoreReservedBroken(acquired: AcquiredOperation, loaded: LoadedPrior): Promise<void> {
  const broken = slotIdentity(loaded, ".hive.broken");
  if (!broken) return;
  const home = acquired.record.canonicalHome;
  const location = await locateDirectoryIdentity(broken, [
    resolve(home, ".hive.broken"),
    resolve(acquired.paths.operationDirectory, "prior-broken"),
  ]);
  if (location !== resolve(home, ".hive.broken")) {
    await moveOwnedDirectory(acquired, location, resolve(home, ".hive.broken"));
  }
}

/** Finish an interrupted disposal only against its recorded identity. */
async function finishPendingDisposal(acquired: AcquiredOperation): Promise<void> {
  const disposal = acquired.record.artifactDisposal;
  if (!disposal || disposal.state === "observed") return;
  if (await sameDirectoryIdentity(disposal.path, disposal.directoryIdentity)) {
    await rm(disposal.path, { recursive: true, force: false });
  }
  try {
    await lstat(disposal.path);
    throw new OperationUnresolvedError("pending disposal target still exists with another identity");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  acquired.record.artifactDisposal = { ...disposal, state: "observed" };
  acquired.record.retainedPaths = acquired.record.retainedPaths.filter((path) => path !== disposal.path);
  await persistOperation(acquired);
}

export function lifecycleInterruptedIO(deps: LifecycleReconcileDeps): InterruptedOperationIO {
  const request = deps.request ?? requestMaintenance;
  const now = deps.now ?? Date.now;
  const acquiredFor = (record: OperationRecord): AcquiredOperation => ({
    paths: operationPaths(record.canonicalHome, record.id),
    record,
  });
  const verifyProfile = (loaded: LoadedPrior) =>
    verifyPrior(loaded, {
      packaged: () => deps.verifyPackaged({ minimumStartedAt: Date.parse(loaded.prior.capturedAt) }),
      pilot: async (value) => {
        if (!deps.verifyPilot) throw new OperationUnresolvedError("PILOT_PROFILE_VERIFIER_UNAVAILABLE");
        await deps.verifyPilot(value);
      },
      stopped: (value) => verifyStoppedPrior(deps.controller, value),
    });

  return {
    ownerIsLive: (owner) => processIsLive(deps.host, owner),

    async releaseBarrier(record) {
      if (!record.barrierOperationId || !record.supervisor) {
        throw new OperationUnresolvedError("recorded barrier has no supervisor identity");
      }
      const supervisorProcess = record.supervisorProcess;
      if (!supervisorProcess || record.workerHealthPort === undefined) {
        throw new OperationUnresolvedError("recorded barrier lacks supervisor start time or health listener");
      }
      const runtimeRecord = resolve(record.canonicalHome, ".hive-state", "runtime", "voice-worker.json");
      const corroborate = async () => {
        const identity = parseBootIdentity(JSON.parse(await readFile(runtimeRecord, "utf8")));
        const startTime = await deps.host.processStartTime(identity.pid);
        if (startTime === null) throw new Error("current voice supervisor is not running");
        return { pid: identity.pid, bootId: identity.bootId };
      };
      if (await processIsLive(deps.host, supervisorProcess)) {
        // Fresh same-boot terminal release even if the close never arrived.
        const reply = await request({
          instanceHome: record.canonicalHome,
          instanceId: record.instanceId,
          operationId: record.barrierOperationId,
          kind: "release",
          deadline: now() + 2_000,
          expectedAdmission: "open",
          supervisor: record.supervisor,
          corroborateSupervisor: corroborate,
        });
        if (reply.operationId !== record.barrierOperationId || reply.snapshot.operationId !== null) {
          throw new OperationUnresolvedError("terminal maintenance release did not correlate");
        }
        await writeOperationJson(resolve(acquiredFor(record).paths.operationDirectory, "barrier-release.json"), {
          outcome: "released",
          requestId: reply.requestId,
          operationId: reply.operationId,
          supervisor: reply.supervisor,
          writtenAt: reply.writtenAt,
        });
        return;
      }
      // The recorded supervisor exited: prove exit + listener release, never fake an ack.
      const owners = await deps.controller.listenerOwners(record.workerHealthPort);
      if (owners.length > 0) {
        let replacement: { pid: number; bootId: string };
        try {
          replacement = await corroborate();
        } catch (cause) {
          throw new OperationUnresolvedError("health listener has an unidentified owner after supervisor exit", {
            cause,
          });
        }
        if (owners.length !== 1 || owners[0] !== replacement.pid || replacement.bootId === record.supervisor.bootId) {
          throw new OperationUnresolvedError("health listener owner is not a corroborated replacement supervisor");
        }
        const requestedAt = now();
        const reply = await request({
          instanceHome: record.canonicalHome,
          instanceId: record.instanceId,
          operationId: record.barrierOperationId,
          kind: "status",
          deadline: requestedAt + 2_000,
          expectedAdmission: "open",
          corroborateSupervisor: corroborate,
        });
        if (
          !freshAdmissionStatus({
            reply,
            requestId: reply.requestId,
            operationId: record.barrierOperationId,
            requestedAt,
            expectedSupervisor: replacement,
            processCorroborated: true,
          })
        ) {
          throw new OperationUnresolvedError("replacement supervisor admission is not open");
        }
      }
      await writeOperationJson(resolve(acquiredFor(record).paths.operationDirectory, "barrier-release.json"), {
        outcome: "supervisor-exited",
        supervisor: { ...supervisorProcess, bootId: record.supervisor.bootId },
        healthListenerPort: record.workerHealthPort,
        listenerReleased: owners.length === 0,
      });
    },

    async reconcileFilesystem(record) {
      const acquired = acquiredFor(record);
      let loaded: LoadedPrior | null = null;
      try {
        loaded = await loadPrior(record);
      } catch (error) {
        if (!(error instanceof PriorSnapshotIncompleteError)) throw error;
        // No snapshot means no pre-signal move could have been journaled.
        if (record.artifactMove) {
          throw new OperationUnresolvedError(`PRIOR_SNAPSHOT_INCOMPLETE: ${error.missing.join(",")}`, { cause: error });
        }
      }
      if (loaded) {
        await assertLivePairUnchanged(deps, loaded);
        await restoreReservedBroken(acquired, loaded);
      }
      await reconcilePluginCompatibility(acquired);
      await removeOwnedIncompleteNext(acquired);
    },

    async recoverAfterSignals(record) {
      const acquired = acquiredFor(record);
      const loaded = await loadPriorOrUnresolved(record);
      // A relocation is committed before staging; an uncommitted list here is unresolved.
      await reconcilePluginCompatibility(acquired);
      // Stop only identified services, worker before engine.
      const ordered = [
        ...loaded.prior.services.filter((item) => item.definition.label.endsWith(".voice-worker")),
        ...loaded.prior.services.filter((item) => !item.definition.label.endsWith(".voice-worker")),
      ];
      for (const saved of ordered) {
        const live = await deps.controller.inspect(saved.definition.label);
        if (!identifiedService(record, loaded, live)) {
          throw new OperationUnresolvedError(`${saved.definition.label} has an unidentified live registration`);
        }
        if (!live.loaded) continue;
        const isWorker = saved.definition.label.endsWith(".voice-worker");
        const port = record.workerHealthPort ?? loaded.prior.workerHealthPort ?? undefined;
        if (isWorker && port === undefined) throw new OperationUnresolvedError("worker health listener is unknown");
        await deps.controller.bootout(saved.definition, {
          markIrreversible: async () => {},
          ...(isWorker ? { healthListenerPort: port } : {}),
        });
      }
      const rotation = rotationFor(acquired, loaded);
      if ((record.mode === "update" || record.mode === "check") && rotation.captured.next) {
        if (rotation.captured.current) await rotation.recoverUpdate();
        else await rotation.recoverFirstMigration();
      } else if (record.mode === "rollback" && rotation.captured.current && rotation.captured.previous) {
        await rotation.recoverRollback();
      } else {
        await restoreReservedBroken(acquired, loaded);
      }
      await restorePrior(deps.controller, loaded, {
        verifyEngine: async (engine) => {
          const saved = loaded.prior.services.find((item) => !item.definition.label.endsWith(".voice-worker"));
          if (saved?.loaded && (!engine || engine.livePID === null)) {
            throw new Error("prior engine did not restart before the worker");
          }
        },
      });
      record.resolution = "recovered";
      await persistOperation(acquired);
      await verifyProfile(loaded);
    },

    async completeDurableResolution(record) {
      const acquired = acquiredFor(record);
      const loaded = await loadPriorOrUnresolved(record);
      await finishPendingDisposal(acquired);
      if (record.resolution === "recovered") {
        await verifyProfile(loaded);
        return;
      }
      // Healthy: verify the recorded final pair; never rotate it back.
      if (record.mode !== "stop") {
        await deps.verifyPackaged({ minimumStartedAt: Date.parse(record.startedAt) });
      }
      const home = record.canonicalHome;
      const rotation = rotationFor(acquired, loaded);
      if (record.mode === "rollback" && rotation.captured.current) {
        const rollbackCurrent = resolve(acquired.paths.operationDirectory, "rollback-current");
        if (await sameDirectoryIdentity(rollbackCurrent, rotation.captured.current)) {
          await moveOwnedDirectory(acquired, rollbackCurrent, resolve(home, ".hive.broken"));
        }
      }
      if ((record.mode === "update" || record.mode === "check") && rotation.captured.previous) {
        const priorPrevious = resolve(acquired.paths.operationDirectory, "prior-prev");
        if (await sameDirectoryIdentity(priorPrevious, rotation.captured.previous)) {
          await disposeOwnedDirectory(acquired, priorPrevious, rotation.captured.previous);
        }
      }
      const broken = rotation.captured.broken;
      const priorBroken = resolve(acquired.paths.operationDirectory, "prior-broken");
      if (broken && (await sameDirectoryIdentity(priorBroken, broken))) {
        if (record.mode === "update" || record.mode === "check") {
          const occupied = await directoryIdentity(resolve(home, ".hive.broken")).then(
            () => true,
            () => false,
          );
          if (!occupied) await moveOwnedDirectory(acquired, priorBroken, resolve(home, ".hive.broken"));
        } else {
          await disposeOwnedDirectory(acquired, priorBroken, broken);
        }
      }
    },

    async verifyDeferredResolution(record) {
      const acquired = acquiredFor(record);
      await finishPendingDisposal(acquired);
      let loaded: LoadedPrior | null = null;
      try {
        loaded = await loadPrior(record);
      } catch (error) {
        if (!(error instanceof PriorSnapshotIncompleteError) || record.artifactMove) throw error;
      }
      if (loaded) {
        await assertLivePairUnchanged(deps, loaded);
        await restoreReservedBroken(acquired, loaded);
      }
      await reconcilePluginCompatibility(acquired);
      await removeOwnedIncompleteNext(acquired);
    },
  };
}

export interface RunReconcileOperationOptions {
  operationRecordPath: string;
  claimId: string;
  selfPath: string;
  selfSha256: string;
  host?: ReconcileHostIO;
  lifecycle: (record: OperationRecord) => Promise<LifecycleReconcileDeps>;
  nonLifecycle?: Partial<Record<Exclude<OperationWorkKind, "lifecycle">, NonLifecycleReconciler>>;
}

/** Internal `--reconcile-operation` mode executed by the original frozen helper. */
export async function runReconcileOperation(options: RunReconcileOperationOptions): Promise<Record<string, unknown>> {
  const host = options.host ?? nodeReconcileHostIO;
  const decoded = decodeOperationRecord(JSON.parse(await readFile(options.operationRecordPath, "utf8")));
  if (decoded.schemaVersion !== 2) throw new OperationUnresolvedError("reconcile mode requires a schema-2 record");
  const paths = operationPaths(decoded.canonicalHome, decoded.id);
  if (options.operationRecordPath !== paths.operationRecord) {
    throw new OperationUnresolvedError("reconcile operation path is not the recorded operation record");
  }
  if (
    options.selfPath !== resolve(paths.operationDirectory, "deploy.min.js") ||
    options.selfSha256 !== decoded.toolSha256
  ) {
    throw new OperationUnresolvedError("reconcile executor is not the original frozen helper");
  }
  const stale = await readStaleLock(decoded.canonicalHome);
  if (!stale || stale.record.id !== decoded.id) throw new OperationUnresolvedError("reconcile lock no longer matches");
  const claimPath = resolve(paths.lockDirectory, RECONCILE_CLAIM_DIRECTORY, "owner.json");
  const claim = parseClaim(JSON.parse(await readFile(claimPath, "utf8")), decoded.id);
  if (claim.claimId !== options.claimId) throw new OperationBusyError("reconcile claim is owned by another contender");
  if (claim.executor !== null && (await processIsLive(host, claim.executor))) {
    throw new OperationBusyError("reconcile claim already has a live executor");
  }
  // Record the recovery executor before it mutates state.
  claim.executor = await host.self();
  await writeOperationJson(claimPath, claim);
  await writeOperationJson(
    resolve(paths.operationDirectory, "reconcile-attempts", `${claim.claimId}.executor.json`),
    claim,
  );

  // Dispatch by durable work kind before any lifecycle field is read.
  const record = stale.record;
  if (record.workKind !== "lifecycle") {
    const handler = options.nonLifecycle?.[record.workKind];
    if (!handler) {
      throw new OperationUnresolvedError(`NON_LIFECYCLE_RECONCILER_UNAVAILABLE: ${record.workKind}`);
    }
    const outcome = await handler(record, claim.claimId);
    return { status: PREVIOUS_OPERATION_RECONCILED, operationId: record.id, workKind: record.workKind, ...outcome };
  }
  const deps = await options.lifecycle(record);
  const result: InterruptedOperationResult = await reconcileInterruptedOperation(
    record.canonicalHome,
    lifecycleInterruptedIO(deps),
    { reconcileClaimId: claim.claimId },
  );
  return { status: PREVIOUS_OPERATION_RECONCILED, workKind: "lifecycle", ...result };
}
