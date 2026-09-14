import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initialBootstrapWork } from "./bootstrap.js";
import { acquireOperation, finishOperationLock, persistOperation, type AcquiredOperation } from "./operation.js";
import {
  abortRegistryCommand,
  assertPilotArtifactLineage,
  assessHold,
  captureTicketValidator,
  createCaptureTicket,
  holdCapabilityFor,
  INVENTORY_GAP_REASONS,
  initialRegistryWork,
  loadRegisteredPilot,
  NATIVE_HOLD_ADAPTER_UNAVAILABLE,
  pilotProfileVerifier,
  reconcileRegistryWork,
  registryPilotEvidence,
  resolvePilotMigrationLineage,
  revokeCaptureTicket,
  runInventoryPilot,
  runPrepareLegacyHold,
  runReleaseLegacyHold,
  runVerifyLegacyHold,
  type PilotServiceReader,
  type RegistryCommandDeps,
  type RegistryWork,
} from "./pilot.js";
import {
  assessLegacyHoldRoute,
  LEGACY_HOLD_GAP_CODES,
  MigrationPendingError,
  PilotEvidenceUnavailableError,
} from "./pilot-lifecycle.js";
import {
  buildTreeManifest,
  inventoryClasses,
  readRegisteredRecord,
  registerRecord,
  sealFile,
  type FileSeal,
  type HoldRecord,
  type InstanceKey,
  type PilotSnapshot,
  type TreeSeal,
} from "./pilot-records.js";
import { capturePrior, type LoadedPrior } from "./prior.js";
import { DeferredMaintenance } from "./transaction.js";
import { buildServiceDefinitions, buildServiceEnvironment, type ServiceInspection } from "./services.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const UID = process.getuid!();
const DIGEST = "a".repeat(64);
const START = "Mon Sep 14 10:00:00 2026";
const ENGINE_PID = 100;
const WORKER_PID = 101;
const SDK_PORT = 8081;

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seal(path: string): Promise<FileSeal> {
  const { bytes: _bytes, ...rest } = await sealFile(path, { uid: UID, allowRoot: true });
  void _bytes;
  return rest;
}

async function tree(root: string, manifestPath: string): Promise<TreeSeal> {
  writeFileSync(manifestPath, await buildTreeManifest(root, { uid: UID, closureRoots: [root] }), { mode: 0o600 });
  const info = lstatSync(root);
  return { path: root, realpath: root, uid: UID, dev: info.dev, ino: info.ino, manifest: await seal(manifestPath) };
}

function write(path: string, content: string): string {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { mode: 0o644 });
  return path;
}

interface Fixture {
  base: string;
  home: string;
  instance: InstanceKey;
  pilotDir: string;
  archiveSha: string;
  snapshotSelector: string;
}

async function registryOperation(
  home: string,
  command: RegistryWork["command"] = "prepare-legacy-hold",
): Promise<AcquiredOperation> {
  return acquireOperation({
    instanceHome: home,
    instanceId: "dodi",
    mode: command,
    workKind: "registry",
    registry: initialRegistryWork(command),
    toolSha256: DIGEST,
    ownerStartTime: "start",
  });
}

async function fixture(options: { admission?: PilotSnapshot["admission"] } = {}): Promise<Fixture> {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-pilot-")));
  chmodSync(base, 0o755);
  roots.push(base);
  const home = resolve(base, "instance");
  mkdirSync(home, { mode: 0o755 });
  const configPath = write(resolve(home, "hive.yaml"), "instance:\n  id: dodi\n");
  const instance: InstanceKey = { canonicalHome: home, configPath, instanceId: "dodi", uid: UID };

  // Captured external pilot runtime (never modified by the evidence module).
  const pilotDir = resolve(base, "pilot");
  const engineEntry = write(resolve(pilotDir, "pkg/server.min.js"), "engine();\n");
  const workerEntry = write(resolve(pilotDir, "dist/voice-worker/main.js"), "worker();\n");
  const loader = write(
    resolve(pilotDir, "dist/voice-worker/worker-config.js"),
    "export function loadWorkerConfig(){}\n",
  );
  const node = write(resolve(base, "runtime/node"), "#!node\n");
  mkdirSync(resolve(base, "manifests"), { mode: 0o700 });
  const pilotTree = await tree(pilotDir, resolve(base, "manifests/pilot.manifest"));
  const enginePlist = write(resolve(base, "launch/engine.plist"), "<plist>engine</plist>\n");
  const workerPlist = write(resolve(base, "launch/worker.plist"), "<plist>worker</plist>\n");

  // Durable tooling bootstrap keyed on its archive digest.
  const archive = write(resolve(base, "candidate.tgz"), "reviewed archive bytes\n");
  const archiveSha = sha("reviewed archive bytes\n");
  const tooling = resolve(home, ".hive-state/tooling", archiveSha);
  const helper = write(resolve(tooling, "pkg/deploy.min.js"), "helper\n");
  const probe = write(resolve(tooling, "pkg/runtime-probe.min.js"), "probe\n");
  const diagnostic = write(resolve(tooling, "pkg/voice-worker-diagnostic.min.js"), "diag\n");
  const toolingTree = await tree(tooling, resolve(base, "manifests/tooling.manifest"));
  const bootstrapOperation = await acquireOperation({
    instanceHome: home,
    instanceId: "dodi",
    mode: "bootstrap",
    workKind: "bootstrap",
    bootstrap: initialBootstrapWork({
      artifact: archive,
      sha256: archiveSha,
      revision: "c".repeat(40),
      sourceHelper: helper,
    }),
    toolSha256: DIGEST,
    ownerStartTime: "start",
  });
  const seals = {
    archive: await seal(archive),
    helper: await seal(helper),
    probe: await seal(probe),
    diagnostic: await seal(diagnostic),
    node: await seal(node),
  };
  const bootstrap = await registerRecord({
    operation: bootstrapOperation,
    instance,
    kind: "bootstrap",
    buildPayload: ({ id }) => ({
      schemaVersion: 1,
      kind: "bootstrap",
      id,
      instance,
      createdAt: 1_000,
      archive: seals.archive,
      packageRoot: toolingTree,
      release: {
        schemaVersion: 1,
        packageVersion: "1.2.3",
        sourceRevision: "c".repeat(40),
        sourceDirty: false,
        dependencyLockSha256: DIGEST,
        voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
      },
      helper: seals.helper,
      probe: seals.probe,
      diagnostic: seals.diagnostic,
      node: seals.node,
      npm: seals.node,
    }),
  });
  await finishOperationLock(bootstrapOperation);

  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: node,
    hiveHome: home,
    configPath,
    home: resolve(base, "user"),
    pathEnv: "/usr/bin:/bin",
  });
  const engineSource = await seal(enginePlist);
  const workerSource = await seal(workerPlist);
  const snapshotOperation = await registryOperation(home, "capture-pilot");
  const snapshot = await registerRecord({
    operation: snapshotOperation,
    instance,
    kind: "pilot-snapshot",
    files: [
      { name: "engine-effective.plist", bytes: Buffer.from("<plist>engine</plist>\n") },
      { name: "worker-effective.plist", bytes: Buffer.from("<plist>worker</plist>\n") },
    ],
    buildPayload: ({ id, files }) => {
      const save = (definition: typeof pair.engine, pid: number, source: FileSeal, saved: FileSeal) => {
        const args = [definition.nodePath, definition.entrypoint, ...definition.args];
        const inspection: ServiceInspection = {
          label: definition.label,
          loaded: true,
          enabled: true,
          livePID: pid,
          startTime: START,
          args,
          cwd: definition.hiveHome,
          configSelection: definition.configPath,
          serviceEnvironment: buildServiceEnvironment(definition),
          plist: null,
          link: null,
          process: { pid, ppid: 1, startTime: START, command: args.join(" "), executable: node, cwd: home },
        };
        return {
          definition,
          inspection,
          effectivePlist: { source, saved },
          instancePlist: {
            path: resolve(home, `service/${definition.label}.plist`),
            existed: false,
            saved: null,
            mode: null,
          },
          link: {
            path: resolve(base, `user/Library/LaunchAgents/${definition.label}.plist`),
            existed: true,
            target: source.path,
          },
          loaded: true,
          enabled: true,
        };
      };
      const processSeal = (pid: number) => ({ pid, startTime: START, executable: node, command: "node", cwd: home });
      return {
        schemaVersion: 1,
        kind: "pilot-snapshot",
        id,
        instance,
        capturedAt: 1_000,
        captureOperationId: snapshotOperation.record.id,
        toolSha256: DIGEST,
        bootstrap: bootstrap.reference,
        services: [
          save(pair.engine, ENGINE_PID, engineSource, files["engine-effective.plist"]),
          save(pair.worker, WORKER_PID, workerSource, files["worker-effective.plist"]),
        ],
        runtime: {
          engine: processSeal(ENGINE_PID),
          worker: processSeal(WORKER_PID),
          engineEntry: filesSealSync(engineEntry),
          workerEntry: filesSealSync(workerEntry),
          workerLoader: { kind: "legacy-module", file: filesSealSync(loader) },
          node: filesSealSync(node),
          roots: [pilotTree],
          sdkListener: { host: "127.0.0.1", port: SDK_PORT, agentName: "hive-voice" },
          bridgePort: 3107,
        },
        configIdentity: DIGEST,
        configFiles: [{ path: configPath, seal: filesSealSync(configPath) }],
        slots: [".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) => ({
          path: resolve(home, name),
          identity: null,
          release: null,
        })) as PilotSnapshot["slots"],
        admission: options.admission ?? { kind: "unavailable" },
      } as PilotSnapshot;
    },
  });
  await finishOperationLock(snapshotOperation);
  return { base, home, instance, pilotDir, archiveSha, snapshotSelector: snapshot.selector };

  function filesSealSync(path: string): FileSeal {
    const info = lstatSync(path);
    const bytes = readFileSync(path);
    return {
      path,
      realpath: realpathSync(path),
      uid: info.uid,
      mode: info.mode & 0o7777,
      dev: info.dev,
      ino: info.ino,
      size: bytes.length,
      sha256: sha(bytes),
    };
  }
}

interface ReaderOptions {
  engineStart?: string;
  workerStart?: string;
  owners?: number[];
  census?: number;
  unstable?: boolean;
}

function reader(options: ReaderOptions = {}) {
  const calls: string[] = [];
  let inspections = 0;
  const controllerFor = vi.fn((): PilotServiceReader => ({
    inspect: vi.fn(async (label: string) => {
      calls.push(`inspect:${label}`);
      inspections += 1;
      const worker = label.endsWith("voice-worker");
      const pid = worker ? WORKER_PID : ENGINE_PID;
      const startTime =
        options.unstable && inspections > 2
          ? "Mon Sep 14 11:00:00 2026"
          : ((worker ? options.workerStart : options.engineStart) ?? START);
      return {
        label,
        loaded: true,
        enabled: true,
        livePID: pid,
        startTime,
        args: [],
        cwd: "/",
        configSelection: null,
        serviceEnvironment: null,
        plist: null,
        link: null,
        process: { pid, ppid: 1, startTime, command: "node", executable: "/node", cwd: "/" },
      } as ServiceInspection;
    }),
    listenerOwners: vi.fn(async () => {
      calls.push("listener-owners");
      return options.owners ?? [WORKER_PID];
    }),
    processCensus: vi.fn(async () => {
      calls.push("census");
      return Array.from({ length: options.census ?? 0 }, (_, index) => ({
        pid: 1_000 + index,
        ppid: ENGINE_PID,
        startTime: START,
        command: "child",
      })) as unknown as Awaited<ReturnType<PilotServiceReader["processCensus"]>>;
    }),
  }));
  return { calls, controllerFor };
}

const fetchImpl = (async (url: string | URL) =>
  String(url).endsWith("/worker")
    ? new Response(JSON.stringify({ agent_name: "hive-voice", active_jobs: 0 }), { status: 200 })
    : new Response("ok", { status: 200 })) as typeof fetch;

function deps(f: Fixture, options: ReaderOptions = {}) {
  const r = reader(options);
  const settleBarrier = vi.fn(async () => "released" as const);
  const value: RegistryCommandDeps = {
    instance: f.instance,
    controllerFor: r.controllerFor,
    fetchImpl,
    settleBarrier,
    randomId: randomUUID,
  };
  return { deps: value, calls: r.calls, settleBarrier, controllerFor: r.controllerFor };
}

describe("registered pilot selection and reconstruction", () => {
  it("reconstructs the captured pair only from sealed registry backups and rehashes recovery prerequisites", async () => {
    const f = await fixture();
    const loaded = await loadRegisteredPilot(f.snapshotSelector, f.instance);
    expect(loaded.pilot.services.services.map((item) => item.plist.bytes?.toString())).toEqual([
      "<plist>engine</plist>\n",
      "<plist>worker</plist>\n",
    ]);
    expect(loaded.pilot.generation.worker).toEqual({ pid: WORKER_PID, startTime: START });
    expect(loaded.pilot.capturedPilotProfile.map((item) => item.plistPath)).toEqual([
      resolve(f.base, "launch/engine.plist"),
      resolve(f.base, "launch/worker.plist"),
    ]);
    const provider = registryPilotEvidence(deps(f).deps);
    const pilot = await provider.selectRegisteredSnapshot(f.snapshotSelector, f.instance);
    await expect(provider.verifyRecoveryPrerequisites(pilot)).resolves.toBeUndefined();
  });

  it("an unregistered path, another instance or a changed external tree never yields a usable snapshot", async () => {
    const f = await fixture();
    const provider = registryPilotEvidence(deps(f).deps);
    await expect(
      provider.selectRegisteredSnapshot(resolve(f.home, ".hive-state/other.json"), f.instance),
    ).rejects.toMatchObject({ code: "PILOT_SNAPSHOT_UNREGISTERED" });
    await expect(
      provider.selectRegisteredSnapshot(f.snapshotSelector, { ...f.instance, configPath: `${f.home}/other.yaml` }),
    ).rejects.toMatchObject({ code: "PILOT_SNAPSHOT_INSTANCE_MISMATCH" });
    const pilot = await provider.selectRegisteredSnapshot(f.snapshotSelector, f.instance);
    writeFileSync(resolve(f.pilotDir, "dist/voice-worker/injected.js"), "x\n", { mode: 0o644 });
    await expect(provider.verifyRecoveryPrerequisites(pilot)).rejects.toThrow("PILOT_RECOVERY_PREREQUISITES_CHANGED");
  });
});

describe("inventory and explicit legacy deferral", () => {
  it("prepare on the uninstrumented pilot registers an unavailable hold and returns MIGRATION_PENDING without any mutation", async () => {
    const f = await fixture();
    const { deps: d, calls, settleBarrier } = deps(f, { census: 0 });
    const operation = await registryOperation(f.home);
    const result = await runPrepareLegacyHold(operation, f.snapshotSelector, d);
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({ status: "MIGRATION_PENDING", gaps: [...LEGACY_HOLD_GAP_CODES] });
    expect(operation.record.registry?.outcome).toBe("migration-pending");
    expect(operation.record.signalsBegun).toBe(false);
    expect(settleBarrier).not.toHaveBeenCalled();
    // Only read-only service reads ever happened.
    expect(calls.every((call) => /^(inspect:|listener-owners|census)/.test(call))).toBe(true);
    await finishOperationLock(operation);

    const hold = await readRegisteredRecord<HoldRecord>(String(result.result.holdRecord), {
      instance: f.instance,
      kind: "legacy-hold",
    });
    expect(hold.payload.procedure).toEqual({ kind: "unavailable", reason: "LEGACY_ADMISSION_UNOBSERVABLE" });
    // Every class keeps a gap; observations are never complete accounting.
    expect(hold.payload.gaps.map((gap) => gap.category)).toEqual([...inventoryClasses]);
    expect(hold.payload.sources.every((source) => source.accounting === "observations-only")).toBe(true);
    expect(hold.payload.gaps.find((gap) => gap.category === "outstanding-assignments")?.reason).toBe(
      INVENTORY_GAP_REASONS["outstanding-assignments"],
    );
  });

  it("zero descendants and zero SDK jobs still leave assignment accounting incomplete", async () => {
    const f = await fixture();
    const { deps: d } = deps(f, { census: 0 });
    const operation = await registryOperation(f.home, "inventory-pilot");
    const result = await runInventoryPilot(operation, f.snapshotSelector, d);
    expect(result.exitCode).toBe(0);
    expect(result.result.status).toBe("INVENTORY_RECORDED");
    expect((result.result.gaps as { category: string }[]).map((gap) => gap.category)).toContain(
      "outstanding-assignments",
    );
    expect(JSON.stringify(result.result)).not.toMatch(/held|verified|authorized/);
    await finishOperationLock(operation);
  });

  it("a verified registered hold record is only a selector: verify recomputes and still defers", async () => {
    const f = await fixture();
    const { deps: d } = deps(f);
    const prepare = await registryOperation(f.home);
    const prepared = await runPrepareLegacyHold(prepare, f.snapshotSelector, d);
    await finishOperationLock(prepare);
    const verify = await registryOperation(f.home, "verify-legacy-hold");
    const verified = await runVerifyLegacyHold(verify, String(prepared.result.holdRecord), d);
    expect(verified.exitCode).toBe(1);
    expect(verified.result.status).toBe("MIGRATION_PENDING");
    await finishOperationLock(verify);

    const release = await registryOperation(f.home, "release-legacy-hold");
    const released = await runReleaseLegacyHold(release, String(prepared.result.holdRecord), d);
    expect(released.result.status).toBe("HOLD_NEVER_ESTABLISHED");
    expect(d.settleBarrier).not.toHaveBeenCalled();
    await finishOperationLock(release);
  });

  it("a same-number PID with another start time or an unstable generation fails before registering", async () => {
    const f = await fixture();
    const reused = deps(f, { workerStart: "Mon Sep 14 12:00:00 2026" });
    const operation = await registryOperation(f.home);
    await expect(runPrepareLegacyHold(operation, f.snapshotSelector, reused.deps)).rejects.toMatchObject({
      code: "PILOT_GENERATION_UNVERIFIED",
    });
    expect(operation.record.registry?.selectedHold).toBeNull();
    const aborted = await abortRegistryCommand(operation, "PILOT_GENERATION_UNVERIFIED");
    expect(aborted.exitCode).toBe(1);
    await finishOperationLock(operation);

    const loaded = await loadRegisteredPilot(f.snapshotSelector, f.instance);
    await expect(assessHold(loaded, deps(f, { unstable: true }).deps)).rejects.toMatchObject({
      code: "PILOT_GENERATION_UNSTABLE",
    });
  });

  it("the lifecycle route through the registry provider defers with fixed gaps; no JSON or record can make it capable", async () => {
    const f = await fixture();
    const { deps: d } = deps(f);
    const provider = registryPilotEvidence(d);
    const prepare = await registryOperation(f.home);
    const prepared = await runPrepareLegacyHold(prepare, f.snapshotSelector, d);
    await finishOperationLock(prepare);
    const error = await assessLegacyHoldRoute({
      holdSelector: String(prepared.result.holdRecord),
      instance: f.instance,
      provider,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationPendingError);
    expect((error as MigrationPendingError).gaps).toEqual([...LEGACY_HOLD_GAP_CODES]);
    const unregistered = await assessLegacyHoldRoute({
      holdSelector: resolve(f.home, ".hive-state/deployment/registry/hold.json"),
      instance: f.instance,
      provider,
    }).catch((caught: unknown) => caught);
    expect((unregistered as MigrationPendingError).gaps[0]).toBe("LEGACY_HOLD_UNREGISTERED");
    await expect(provider.establishHold({} as never, {} as never, async () => {})).rejects.toBeInstanceOf(
      PilotEvidenceUnavailableError,
    );
  });

  it("a snapshot claiming native admission still defers: capability is never read from a record", () => {
    const capable = {
      admission: { kind: "hive-maintenance-v1" },
    } as unknown as PilotSnapshot;
    expect(holdCapabilityFor(capable)).toMatchObject({
      kind: "unavailable",
      gaps: [NATIVE_HOLD_ADAPTER_UNAVAILABLE, ...LEGACY_HOLD_GAP_CODES],
    });
    expect(holdCapabilityFor({ admission: { kind: "unavailable" } } as PilotSnapshot).kind).toBe("unavailable");
  });
});

describe("migration lineage", () => {
  async function recordMigration(f: Fixture, options: { archiveBytes?: string } = {}) {
    const loaded = await loadRegisteredPilot(f.snapshotSelector, f.instance);
    const operation = await acquireOperation({
      instanceHome: f.home,
      instanceId: "dodi",
      mode: "update",
      toolSha256: DIGEST,
      ownerStartTime: "start",
      priorProfile: "pilot",
    });
    await capturePrior({
      operation,
      services: loaded.pilot.services,
      configPath: f.instance.configPath,
      workerHealthPort: SDK_PORT,
      pilot: {
        snapshotPath: loaded.pilot.selector,
        snapshotSha256: loaded.pilot.sha256,
        bootstrapPath: loaded.pilot.bootstrap.selector,
        bootstrapSha256: loaded.pilot.bootstrap.sha256,
      },
    });
    const archivePath = write(
      resolve(operation.paths.operationDirectory, "archive/candidate.tgz"),
      options.archiveBytes ?? "reviewed archive bytes\n",
    );
    operation.record.retainedPaths.push(archivePath);
    operation.record.candidateArchiveSha256 = f.archiveSha;
    operation.record.staging.candidateRelease = {
      packageVersion: "1.2.3",
      sourceRevision: "c".repeat(40),
      dependencyLockSha256: DIGEST,
    };
    operation.record.staging.promotion = {
      method: "clone",
      source: "/job",
      destination: resolve(f.home, ".hive.next"),
      state: "observed",
      copyPid: null,
      copyStartTime: null,
      exitCode: 0,
      destinationIdentity: { dev: 7, ino: 8 },
      discarded: false,
    };
    operation.record.staging.cloneVerified = true;
    operation.record.resolution = "healthy";
    await persistOperation(operation);
    await finishOperationLock(operation);
    return loaded.pilot;
  }

  it("with no resolved migration the update is a first migration; reapply must stage the retained archive SHA", async () => {
    const f = await fixture();
    const initial = await loadRegisteredPilot(f.snapshotSelector, f.instance);
    await expect(assertPilotArtifactLineage(initial.pilot, "b".repeat(64))).resolves.toBeUndefined();
    expect(await resolvePilotMigrationLineage(initial.pilot, f.home)).toBeNull();

    const pilot = await recordMigration(f);
    expect(await resolvePilotMigrationLineage(pilot, f.home)).toMatchObject({
      candidateArchiveSha256: f.archiveSha,
      candidateCurrent: { device: 7, inode: 8 },
    });
    await expect(assertPilotArtifactLineage(pilot, f.archiveSha)).resolves.toBeUndefined();
    await expect(assertPilotArtifactLineage(pilot, "b".repeat(64))).rejects.toThrow(
      "REAPPLY_ARTIFACT_LINEAGE_MISMATCH",
    );
  });

  it("a migration whose retained archive changed has no verified lineage and blocks reapply", async () => {
    const f = await fixture();
    const pilot = await recordMigration(f, { archiveBytes: "tampered\n" });
    expect(await resolvePilotMigrationLineage(pilot, f.home)).toBeNull();
    await expect(assertPilotArtifactLineage(pilot, f.archiveSha)).rejects.toBeInstanceOf(DeferredMaintenance);
    await expect(assertPilotArtifactLineage(pilot, f.archiveSha)).rejects.toThrow("REAPPLY_LINEAGE_UNVERIFIED");
  });
});

describe("pilot profile verifier for interrupted recovery", () => {
  it("missing activation fences are unresolved, never read from offset zero", async () => {
    const f = await fixture();
    const loaded = await loadRegisteredPilot(f.snapshotSelector, f.instance);
    const verify = pilotProfileVerifier(deps(f).deps);
    const prior = {
      prior: {
        canonicalHome: f.home,
        operationId: randomUUID(),
        pilot: {
          snapshotPath: loaded.pilot.selector,
          snapshotSha256: loaded.pilot.sha256,
          bootstrapPath: loaded.pilot.bootstrap.selector,
          bootstrapSha256: loaded.pilot.bootstrap.sha256,
        },
      },
    } as unknown as LoadedPrior;
    await expect(verify(prior)).rejects.toThrow("PILOT_ACTIVATION_FENCE_MISSING");
    const wrongBootstrap = {
      prior: { ...prior.prior, pilot: { ...prior.prior.pilot!, bootstrapSha256: "b".repeat(64) } },
    } as unknown as LoadedPrior;
    await expect(verify(wrongBootstrap)).rejects.toThrow("PILOT_BOOTSTRAP_REFERENCE_MISMATCH");
  });

  it("fresh fences but no captured-loader bridge probe fail the pilot profile closed", async () => {
    const f = await fixture();
    const loaded = await loadRegisteredPilot(f.snapshotSelector, f.instance);
    const operationId = randomUUID();
    const operationDirectory = resolve(f.home, ".hive-state/deployment/operations", operationId);
    const log = write(resolve(f.base, "logs/engine.log"), "");
    const info = lstatSync(log);
    write(
      resolve(operationDirectory, "pilot-activation.json"),
      JSON.stringify({
        engineLog: { path: log, dev: info.dev, ino: info.ino, offset: 0 },
        workerLog: { path: log, dev: info.dev, ino: info.ino, offset: 0 },
        wallStartedAt: 1,
        stopped: { engine: null, worker: null },
      }),
    );
    const prior = {
      prior: {
        canonicalHome: f.home,
        operationId,
        pilot: {
          snapshotPath: loaded.pilot.selector,
          snapshotSha256: loaded.pilot.sha256,
          bootstrapPath: loaded.pilot.bootstrap.selector,
          bootstrapSha256: loaded.pilot.bootstrap.sha256,
        },
      },
    } as unknown as LoadedPrior;
    await expect(pilotProfileVerifier(deps(f).deps)(prior)).rejects.toThrow("PILOT_PROFILE_UNVERIFIED");
  });
});

describe("registry crash reconciliation", () => {
  it("an interrupted prepare with a committed hold reconciles as migration-pending without service reads", async () => {
    const f = await fixture();
    const { deps: d, controllerFor } = deps(f);
    const operation = await registryOperation(f.home);
    await runPrepareLegacyHold(operation, f.snapshotSelector, d);
    // Simulate the crash before the durable outcome.
    const state = operation.record.registry!;
    state.outcome = null;
    state.result = null;
    state.phase = "registering";
    await persistOperation(operation);
    controllerFor.mockClear();
    const reconciled = await reconcileRegistryWork(operation, d);
    expect(reconciled.outcome).toBe("migration-pending");
    expect(controllerFor).not.toHaveBeenCalled();
    await finishOperationLock(operation);
  });

  it("a recorded release barrier is settled through the shared terminal release before the outcome", async () => {
    const f = await fixture();
    const { deps: d } = deps(f);
    const operation = await registryOperation(f.home, "release-legacy-hold");
    const state = operation.record.registry!;
    state.barrier = {
      operationId: randomUUID(),
      supervisor: { pid: WORKER_PID, startTime: START, executable: "/node", command: "node", cwd: "/" },
      bootId: randomUUID(),
      descriptor: null,
      healthListenerPort: SDK_PORT,
      state: "release-intended",
      terminalEvidence: null,
    };
    await persistOperation(operation);
    write(resolve(operation.paths.operationDirectory, "barrier-release.json"), '{"outcome":"released"}\n');
    const reconciled = await reconcileRegistryWork(operation, d);
    expect(d.settleBarrier).toHaveBeenCalledWith(
      expect.objectContaining({ barrierOperationId: state.barrier.operationId, healthListenerPort: SDK_PORT }),
    );
    expect(reconciled).toMatchObject({ outcome: "assessment-complete", barrier: "released" });
    expect(state.barrier.state).toBe("released");
    await finishOperationLock(operation);
  });

  it("inventory/verify work carrying a barrier is invalid and an unsettleable barrier stays unresolved", async () => {
    const f = await fixture();
    const { deps: d } = deps(f);
    const operation = await registryOperation(f.home, "verify-legacy-hold");
    operation.record.registry!.barrier = {
      operationId: randomUUID(),
      supervisor: { pid: WORKER_PID, startTime: START, executable: "/node", command: "node", cwd: "/" },
      bootId: randomUUID(),
      descriptor: null,
      healthListenerPort: SDK_PORT,
      state: "closed",
      terminalEvidence: null,
    };
    await expect(reconcileRegistryWork(operation, d)).rejects.toThrow("carries a barrier");
    operation.record.registry!.command = "prepare-legacy-hold";
    d.settleBarrier = vi.fn(async () => {
      throw new Error("terminal maintenance release did not correlate");
    });
    await expect(reconcileRegistryWork(operation, d)).rejects.toThrow("did not correlate");
    await expect(abortRegistryCommand(operation, "X")).rejects.toThrow("REGISTRY_BARRIER_UNSETTLED");
  });
});

describe("capture tickets", () => {
  it("are opaque, bound to the live frozen capture operation and revocable", async () => {
    const f = await fixture();
    const operation = await registryOperation(f.home, "capture-pilot");
    const live = { isProcessLive: vi.fn(async () => true) };
    await expect(
      createCaptureTicket(
        operation,
        { configPath: f.instance.configPath, bootstrap: { id: randomUUID(), sha256: DIGEST } },
        live,
      ),
    ).rejects.toThrow("frozen helper");
    operation.record.frozenOwner = { pid: process.pid, startTime: START };
    await persistOperation(operation);
    const ticket = await createCaptureTicket(
      operation,
      { configPath: f.instance.configPath, bootstrap: { id: randomUUID(), sha256: DIGEST } },
      live,
    );
    const validate = captureTicketValidator(live);
    await expect(validate(ticket)).resolves.toMatchObject({ operationId: operation.record.id, instanceId: "dodi" });
    expect(JSON.stringify(ticket)).toBe("{}");
    await expect(validate(JSON.parse(JSON.stringify(ticket)) as object)).rejects.toThrow("unknown capture ticket");
    live.isProcessLive.mockResolvedValueOnce(false);
    await expect(validate(ticket)).rejects.toThrow("PILOT_CAPTURE_BLOCKED");
    revokeCaptureTicket(ticket);
    await expect(validate(ticket)).rejects.toThrow("unknown capture ticket");
    await finishOperationLock(operation);
  });
});
