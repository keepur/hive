/**
 * First pilot capture without prior registration (KPR-463 plan chunk 4 Task 9
 * Step 4b.1, chunk 5 Task 9 Step 4b.1a Steps 1–3).
 *
 *   acquire/freeze capture operation -> discover with a private read-only ticket
 *   -> build and seal draft plus staged backups/manifests -> persist sealed
 *   -> registered bootstrap probe with the capture-draft subject
 *   -> repeat process/link/source-seal correspondence and log attribution
 *   -> write immutable validation -> persist validated
 *   -> register the snapshot under the reserved ID (registration last)
 *
 * Nothing here stops, starts, signals, writes or loads a service, and nothing
 * is written to a pilot tree or an external plist: discovery is read-only, all
 * staged copies live under this operation, and only the committed registry
 * entry is selectable. Any failure before validation registers nothing. Native
 * admission capability is recorded only when corroborated from current runtime
 * evidence; the uninstrumented pilot is recorded as `unavailable`.
 */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import { canonical } from "./canonical.js";
import { isPackagedRelease, parseBootIdentity } from "./health.js";
import { persistOperation, type AcquiredOperation } from "./operation.js";
import {
  captureTicketValidator,
  complete,
  createCaptureTicket,
  readSdkListener,
  registry,
  revokeCaptureTicket,
  toRecordInstance,
  type CaptureTicketDeps,
  type PilotProbeDeps,
  type RegistryCommandResult,
} from "./pilot.js";
import {
  freshFencedSequence,
  PilotEvidenceUnavailableError,
  readFencedMarkers,
  type PilotInstanceKey,
} from "./pilot-lifecycle.js";
import { invokePilotProbe, PilotProbeFault, preparePilotProbe, type PilotProbeSubject } from "./pilot-observer.js";
import {
  buildTreeManifest,
  canonicalBytes,
  decodeCaptureDraft,
  readRegisteredRecord,
  registerRecord,
  sealFile,
  verifyTreeSeal,
  within,
  type ArtifactSlot,
  type BootstrapRecord,
  type CaptureDraft,
  type FileSeal,
  type InstanceKey,
  type PilotSnapshot,
  type ProcessSeal,
  type RegisteredRecord,
  type ServiceSave,
  type SnapshotAdmission,
  type TreeSeal,
  type WorkerLoader,
} from "./pilot-records.js";
import { readRelease, type Release } from "./release.js";
import {
  buildServiceEnvironment,
  reconcileServiceOverrides,
  servicePortKeys,
  type CaptureDiscovery,
  type ServiceController,
  type ServiceDefinition,
  type ServiceInspection,
  type ServiceOverrides,
} from "./services.js";

const log = createLogger("deployment-pilot-capture");

export const PILOT_CAPTURE_BLOCKED = "PILOT_CAPTURE_BLOCKED";
/** Bounded tail of a service log searched for the already-running generation's markers. */
export const CAPTURE_LOG_TAIL_BYTES = 64 * 1024 * 1024;

/** A capture that cannot complete; carries one fixed reason code, never raw data. */
export class PilotCaptureBlockedError extends PilotEvidenceUnavailableError {
  constructor(readonly reason: string) {
    super(PILOT_CAPTURE_BLOCKED);
    this.message = `${PILOT_CAPTURE_BLOCKED}: ${reason}`;
  }
}

const blocked = (reason: string): never => {
  throw new PilotCaptureBlockedError(reason);
};

export type CaptureDiscoveryReader = Pick<
  ServiceController,
  "discoverForCapture" | "listenersOf" | "listenerOwners" | "processUid" | "fileWriters"
>;

export interface CaptureDeps extends CaptureTicketDeps {
  instance: PilotInstanceKey;
  /**
   * Read-only discovery controller constructed with this module's capture
   * ticket validator. It carries no captured pilot profile and is never used
   * to stop, start or restore anything.
   */
  discovery: CaptureDiscoveryReader;
  probes: PilotProbeDeps;
  /** Operator-inventoried SDK port when more than one listener matches. */
  pilotSdkPort?: number;
  fetchImpl?: typeof fetch;
  readDescriptor?(path: string): Promise<unknown>;
  readRelease?(root: string, requireClean?: boolean): Release;
  now?: () => number;
  randomId?: () => string;
}

export { captureTicketValidator };

function strip(seal: FileSeal & { bytes?: Buffer }): FileSeal {
  const { path, realpath: real, uid, mode, dev, ino, size, sha256 } = seal;
  return { path, realpath: real, uid, mode, dev, ino, size, sha256 };
}

async function exclusiveWrite(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** Walk up from a module to the nearest directory with a package.json (the checkout/package root). */
async function packageRootOf(entry: string): Promise<string> {
  let directory = dirname(await realpath(entry));
  while (true) {
    if (await exists(resolve(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return blocked("RECOVERY_CLOSURE_ROOT_UNKNOWN");
    directory = parent;
  }
}

function overridesOf(environment: Record<string, string>): ServiceOverrides {
  const overrides: ServiceOverrides = {};
  for (const key of servicePortKeys) if (environment[key] !== undefined) overrides[key] = environment[key];
  return overrides;
}

function definitionOf(discovered: CaptureDiscovery): ServiceDefinition {
  const env = discovered.serviceEnvironment;
  const definition: ServiceDefinition = {
    label: discovered.label,
    nodePath: discovered.args[0],
    entrypoint: discovered.args[1],
    args: discovered.args.slice(2),
    hiveHome: env.HIVE_HOME,
    configPath: env.HIVE_CONFIG,
    home: env.HOME,
    pathEnv: env.PATH,
    overrides: overridesOf(env),
    stdout: discovered.stdout,
    stderr: discovered.stderr,
  };
  // The captured environment must be exactly the reconstructable service environment.
  if (canonical(buildServiceEnvironment(definition)) !== canonical(env))
    blocked("SERVICE_ENVIRONMENT_NOT_RECONSTRUCTABLE");
  return definition;
}

function processSeal(discovered: CaptureDiscovery): ProcessSeal {
  const { pid, startTime, executable, command, cwd } = discovered.process;
  return { pid, startTime, executable, command, cwd };
}

/** Slot identity and strict release only; absence is recorded explicitly. */
async function slotOf(path: string, uid: number, read: (root: string) => Release): Promise<ArtifactSlot> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, identity: null, release: null };
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) blocked("ARTIFACT_SLOT_NOT_OWNED");
  let release: Release | null;
  try {
    release = read(path);
  } catch {
    release = null;
  }
  return { path, identity: { dev: info.dev, ino: info.ino, uid: info.uid }, release };
}

/** Selected `.env[-suffix]` beside the instance, as the engine loader resolves it. */
export function dotenvPathFor(canonicalHome: string, configPath: string): string {
  const suffix = basename(configPath).match(/^hive-(.+)\.yaml$/)?.[1];
  return resolve(canonicalHome, suffix ? `.env-${suffix}` : ".env");
}

/**
 * Bridge port as the engine configuration selects it (`VOICE_PORT` service
 * override, else `instance.ports.voice`, else `instance.portBase + 5`). The
 * captured loader later confirms it independently; a differing dotenv override
 * fails the profile rather than being guessed.
 */
export function bridgePortFor(configText: string, environment: Record<string, string>): number {
  if (environment.VOICE_PORT !== undefined) return Number(environment.VOICE_PORT);
  let document: { instance?: { portBase?: unknown; ports?: { voice?: unknown } } } | null;
  try {
    document = parseYaml(configText) as typeof document;
  } catch {
    return blocked("CONFIG_UNREADABLE");
  }
  const voice = document?.instance?.ports?.voice;
  const base = document?.instance?.portBase ?? 3100;
  const port = voice ?? (typeof base === "number" ? base + 5 : Number.NaN);
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) blocked("BRIDGE_PORT_UNKNOWN");
  return port as number;
}

/** Search a bounded log tail for the running generation's ordered markers, attributed by exclusive writer. */
async function logAttributed(
  path: string,
  pid: number,
  startTime: string,
  markers: readonly string[],
  deps: CaptureDeps,
): Promise<boolean> {
  let fence;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      fence = { path, dev: info.dev, ino: info.ino, offset: Math.max(0, info.size - CAPTURE_LOG_TAIL_BYTES) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const writers = await deps.discovery.fileWriters(path);
  const started = Date.parse(startTime);
  if (!Number.isFinite(started)) return false;
  return freshFencedSequence(
    readFencedMarkers(fence),
    {
      pid,
      notBefore: started - 1_000,
      now: (deps.now ?? Date.now)(),
      exclusiveWriter: writers.length === 1 && writers[0] === pid,
    },
    markers,
  );
}

interface Layout {
  loader: WorkerLoader;
  roots: string[];
  runtimeRoot: string | null;
  release: Release | null;
}

async function layoutOf(workerEntry: string, engineEntry: string, uid: number, deps: CaptureDeps): Promise<Layout> {
  const entry = await realpath(workerEntry);
  const read = deps.readRelease ?? readRelease;
  if (basename(dirname(entry)) === "pkg") {
    const root = dirname(dirname(entry));
    const probe = resolve(root, "pkg", "runtime-probe.min.js");
    let release: Release | null;
    try {
      release = read(root, false);
    } catch {
      release = null;
    }
    if (release && entry === resolve(root, release.voiceWorker.path) && (await exists(probe))) {
      const roots = [root];
      const engineRoot = await packageRootOf(engineEntry);
      if (!within(root, engineRoot) && !roots.includes(engineRoot)) roots.push(engineRoot);
      return {
        loader: {
          kind: "packaged-probe",
          file: strip(await sealFile(probe, { uid })),
          runtimeRoot: root,
          release,
          abi: "hive-pilot-probe/1",
        },
        roots,
        runtimeRoot: root,
        release,
      };
    }
  }
  const legacy = resolve(dirname(entry), "worker-config.js");
  if (!(await exists(legacy))) blocked("PILOT_LOADER_UNAVAILABLE");
  const roots = [await packageRootOf(entry)];
  const engineRoot = await packageRootOf(engineEntry);
  if (!roots.some((root) => within(root, engineRoot))) roots.push(engineRoot);
  return {
    loader: { kind: "legacy-module", file: strip(await sealFile(legacy, { uid })) },
    roots,
    runtimeRoot: null,
    release: null,
  };
}

/**
 * Native admission capability from current runtime evidence only: packaged
 * layout, strict release, declared worker bundle, current descriptor for this
 * live worker PID with the same release, and the SDK socket owned by it.
 */
async function admissionOf(
  layout: Layout,
  worker: CaptureDiscovery,
  sdkPort: number,
  instance: InstanceKey,
  deps: CaptureDeps,
): Promise<SnapshotAdmission> {
  if (layout.loader.kind !== "packaged-probe" || !layout.release || !layout.runtimeRoot) return { kind: "unavailable" };
  try {
    const read = deps.readDescriptor ?? (async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown);
    const descriptor = parseBootIdentity(
      await read(resolve(instance.canonicalHome, ".hive-state", "runtime", "voice-worker.json")),
    );
    const bundle = resolve(layout.runtimeRoot, layout.release.voiceWorker.path);
    const owners = await deps.discovery.listenerOwners(sdkPort);
    if (
      descriptor.component !== "voice-worker" ||
      descriptor.pid !== worker.process.pid ||
      !isPackagedRelease(descriptor.release) ||
      canonical(descriptor.release) !== canonical(layout.release) ||
      (await realpath(worker.args[1])) !== bundle ||
      owners.length !== 1 ||
      owners[0] !== worker.process.pid
    ) {
      return { kind: "unavailable" };
    }
    return {
      kind: "hive-maintenance-v1",
      runtimeRoot: layout.runtimeRoot,
      release: layout.release,
      workerBundle: strip(await sealFile(bundle, { uid: instance.uid })),
      bootId: descriptor.bootId,
    };
  } catch {
    // An alleged protocol or an uncorroborated mailbox never establishes capability.
    return { kind: "unavailable" };
  }
}

function inspectionOf(discovered: CaptureDiscovery, linkMode: number): ServiceInspection {
  return {
    label: discovered.label,
    loaded: true,
    enabled: discovered.enabled,
    livePID: discovered.process.pid,
    startTime: discovered.process.startTime,
    args: [...discovered.args],
    cwd: discovered.cwd,
    configSelection: discovered.configSelection,
    serviceEnvironment: { ...discovered.serviceEnvironment },
    plist: {
      path: discovered.effectivePlist.path,
      canonicalPath: discovered.effectivePlist.realpath,
      dev: discovered.effectivePlist.dev,
      ino: discovered.effectivePlist.ino,
      mode: discovered.effectivePlist.mode,
    },
    link: {
      path: discovered.link.path,
      canonicalPath: discovered.link.resolvedTarget,
      dev: discovered.link.dev,
      ino: discovered.link.ino,
      mode: linkMode,
      target: discovered.link.target,
    },
    process: { ...discovered.process },
  };
}

function stableDiscovery(first: CaptureDiscovery, second: CaptureDiscovery): boolean {
  return (
    first.label === second.label &&
    first.process.pid === second.process.pid &&
    first.process.startTime === second.process.startTime &&
    first.process.command === second.process.command &&
    first.link.target === second.link.target &&
    first.link.dev === second.link.dev &&
    first.link.ino === second.link.ino &&
    first.effectivePlist.realpath === second.effectivePlist.realpath &&
    first.effectivePlist.sha256 === second.effectivePlist.sha256 &&
    first.effectivePlist.dev === second.effectivePlist.dev &&
    first.effectivePlist.ino === second.effectivePlist.ino &&
    first.instancePlist.existed === second.instancePlist.existed &&
    first.instancePlist.seal?.sha256 === second.instancePlist.seal?.sha256
  );
}

interface Staged {
  name: string;
  path: string;
  bytes: Buffer;
}

/**
 * `--capture-pilot --bootstrap-record=<registered-bootstrap>` in the frozen
 * helper. Throws `PilotCaptureBlockedError` (or a probe fault) before
 * validation; the caller records the aborted outcome and nothing is registered.
 */
export async function runCapturePilot(
  operation: AcquiredOperation,
  bootstrapSelector: string,
  deps: CaptureDeps,
): Promise<RegistryCommandResult> {
  const state = registry(operation);
  if (state.command !== "capture-pilot") throw new Error("capture requires capture-pilot registry work");
  const instance = toRecordInstance(deps.instance);
  const uid = instance.uid;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;

  let bootstrap: RegisteredRecord<BootstrapRecord>;
  try {
    bootstrap = await readRegisteredRecord<BootstrapRecord>(bootstrapSelector, { instance, kind: "bootstrap", now });
    const root = bootstrap.payload.packageRoot;
    await verifyTreeSeal(root, { uid, closureRoots: [root.realpath] });
  } catch (error) {
    log.warn("Capture bootstrap record unverified", { reason: error instanceof Error ? error.name : "error" });
    return blocked("BOOTSTRAP_RECORD_UNVERIFIED");
  }
  state.bootstrap = bootstrap.reference;
  state.capture = { phase: "discovering", snapshotId: randomId(), draft: null, validation: null, registration: null };
  state.phase = "reading";
  await persistOperation(operation);
  const snapshotId = state.capture.snapshotId;

  const ticket = await createCaptureTicket(
    operation,
    { configPath: instance.configPath, bootstrap: bootstrap.reference },
    deps,
  );
  try {
    const first = await deps.discovery.discoverForCapture(ticket);
    const [engineFound, workerFound] = [first[0], first[1]];
    if (
      first.length !== 2 ||
      engineFound.label !== `com.hive.${instance.instanceId}.agent` ||
      workerFound.label !== `com.hive.${instance.instanceId}.voice-worker`
    ) {
      blocked("SERVICE_PAIR_UNDISCOVERED");
    }
    for (const found of first) {
      if ((await deps.discovery.processUid(found.process.pid)) !== uid) blocked("PROCESS_UID_MISMATCH");
      if (found.serviceEnvironment.HIVE_HOME !== instance.canonicalHome) blocked("SELECTED_HOME_MISMATCH");
    }
    const nodePath = await realpath(workerFound.args[0]);
    if ((await realpath(engineFound.args[0])) !== nodePath) blocked("SERVICE_NODE_MISMATCH");
    const definitions = [definitionOf(engineFound), definitionOf(workerFound)] as const;
    try {
      reconcileServiceOverrides([...definitions]);
    } catch {
      blocked("SERVICE_OVERRIDES_INCONSISTENT");
    }

    // Private staging under this operation only.
    const captureDirectory = resolve(operation.paths.operationDirectory, "capture");
    const filesDirectory = resolve(captureDirectory, "files");
    await mkdir(captureDirectory, { mode: 0o700 });
    await mkdir(filesDirectory, { mode: 0o700 });
    const staged: Staged[] = [];
    const stage = async (name: string, bytes: Buffer): Promise<FileSeal> => {
      const path = resolve(filesDirectory, name);
      await exclusiveWrite(path, bytes);
      staged.push({ name, path, bytes });
      return strip(await sealFile(path, { uid }));
    };

    const saves: ServiceSave[] = [];
    for (const [index, found] of first.entries()) {
      const role = index === 0 ? "engine" : "worker";
      const linkInfo = await lstat(found.link.path);
      const effectiveSaved = await stage(`${role}-effective.plist`, found.effectivePlist.bytes);
      const instanceSaved = found.instancePlist.seal
        ? await stage(`${role}-instance.plist`, found.instancePlist.seal.bytes)
        : null;
      saves.push({
        definition: definitions[index],
        inspection: inspectionOf(found, linkInfo.mode),
        effectivePlist: { source: strip(found.effectivePlist), saved: effectiveSaved },
        instancePlist: {
          path: found.instancePlist.path,
          existed: found.instancePlist.existed,
          saved: instanceSaved,
          mode: found.instancePlist.seal ? found.instancePlist.seal.mode : null,
        },
        link: { path: found.link.path, existed: true, target: found.link.target },
        loaded: true,
        enabled: found.enabled,
      });
    }

    const engineEntry = strip(await sealFile(engineFound.args[1], { uid }));
    const workerEntry = strip(await sealFile(workerFound.args[1], { uid }));
    const node = strip(await sealFile(workerFound.args[0], { uid, allowRoot: true }));
    const layout = await layoutOf(workerFound.args[1], engineFound.args[1], uid, deps);
    const roots: TreeSeal[] = [];
    for (const [index, root] of layout.roots.entries()) {
      const manifest = await buildTreeManifest(root, { uid, closureRoots: layout.roots }).catch(() =>
        blocked("RECOVERY_CLOSURE_UNSEALABLE"),
      );
      const info = await lstat(root);
      roots.push({
        path: root,
        realpath: await realpath(root),
        uid: info.uid,
        dev: info.dev,
        ino: info.ino,
        manifest: await stage(`root-${index}.manifest`, manifest),
      });
    }

    // SDK listener: owned by the worker, exact shape, never inferred from a candidate default.
    const candidates: number[] = [];
    for (const port of await deps.discovery.listenersOf(workerFound.process.pid)) {
      const sdk = await readSdkListener(port, deps.fetchImpl);
      if (sdk.rootStatus === 200 && sdk.agentName === "hive-voice" && sdk.activeJobs !== null) candidates.push(port);
    }
    const sdkPort =
      deps.pilotSdkPort !== undefined
        ? candidates.includes(deps.pilotSdkPort)
          ? deps.pilotSdkPort
          : blocked("PILOT_SDK_PORT_UNCORROBORATED")
        : candidates.length === 1
          ? candidates[0]
          : blocked(candidates.length === 0 ? "SDK_LISTENER_NOT_FOUND" : "SDK_LISTENER_AMBIGUOUS");
    const sdkOwners = await deps.discovery.listenerOwners(sdkPort);
    if (sdkOwners.length !== 1 || sdkOwners[0] !== workerFound.process.pid) blocked("SDK_LISTENER_NOT_OWNED");

    const configText = await readFile(instance.configPath, "utf8");
    const bridgePort = bridgePortFor(configText, engineFound.serviceEnvironment);
    const bridgeOwners = await deps.discovery.listenerOwners(bridgePort);
    if (bridgeOwners.length !== 1 || bridgeOwners[0] !== engineFound.process.pid) blocked("BRIDGE_LISTENER_NOT_OWNED");

    const dotenv = dotenvPathFor(instance.canonicalHome, instance.configPath);
    const configFiles = [
      { path: instance.configPath, seal: strip(await sealFile(instance.configPath, { uid })) },
      { path: dotenv, seal: (await exists(dotenv)) ? strip(await sealFile(dotenv, { uid })) : null },
    ];
    const read = deps.readRelease ?? readRelease;
    const slots = (await Promise.all(
      [".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) =>
        slotOf(resolve(instance.canonicalHome, name), uid, (root) => read(root, false)),
      ),
    )) as PilotSnapshot["slots"];
    const admission = await admissionOf(layout, workerFound, sdkPort, instance, deps);

    const baseline: CaptureDraft["baseline"] = {
      instance,
      captureOperationId: operation.record.id,
      toolSha256: operation.record.toolSha256,
      bootstrap: bootstrap.reference,
      services: [saves[0], saves[1]],
      runtime: {
        engine: processSeal(engineFound),
        worker: processSeal(workerFound),
        engineEntry,
        workerEntry,
        workerLoader: layout.loader,
        node,
        roots,
        sdkListener: { host: "127.0.0.1", port: sdkPort, agentName: "hive-voice" },
        bridgePort,
      },
      configFiles,
      slots,
      admission,
    };
    const draft: CaptureDraft = {
      schemaVersion: 1,
      kind: "capture-draft",
      operationId: operation.record.id,
      instance,
      createdAt: now(),
      snapshotId,
      baseline,
    };
    const draftBytes = canonicalBytes(draft);
    decodeCaptureDraft(JSON.parse(draftBytes.toString("utf8")) as unknown, now());
    const draftPath = resolve(captureDirectory, "draft.json");
    await exclusiveWrite(draftPath, draftBytes);
    const draftSeal = strip(await sealFile(draftPath, { uid }));
    state.capture.draft = draftSeal;
    state.capture.phase = "sealed";
    state.phase = "probing";
    await persistOperation(operation);

    // Working current pilot profile through the registered bootstrap probe and the captured loader.
    const subject: PilotProbeSubject = {
      instance,
      subject: { kind: "capture-draft", operationId: operation.record.id, draftSha256: draftSeal.sha256 },
      subjectSeal: draftSeal,
      baseline,
      bootstrap: bootstrap.payload,
      expectedConfigIdentity: null,
    };
    let invoked;
    try {
      const prepared = await preparePilotProbe(subject, deps.probes.io);
      invoked = await invokePilotProbe(prepared, {
        operationId: operation.record.id,
        expectedEngine: baseline.runtime.engine,
        expectedWorker: baseline.runtime.worker,
        idle: null,
        clock: deps.probes.clock,
        randomId,
        io: deps.probes.io,
      });
    } catch (error) {
      return blocked(error instanceof PilotProbeFault ? error.classification : "PILOT_PROFILE_UNAVAILABLE");
    }

    // Repeat correspondence after the probe; any replacement invalidates capture.
    const second = await deps.discovery.discoverForCapture(ticket);
    if (second.length !== 2 || !stableDiscovery(first[0], second[0]) || !stableDiscovery(first[1], second[1])) {
      blocked("CAPTURE_UNSTABLE");
    }
    const sdkAfter = await deps.discovery.listenerOwners(sdkPort);
    if (sdkAfter.length !== 1 || sdkAfter[0] !== workerFound.process.pid) blocked("CAPTURE_UNSTABLE");
    const logs = {
      engine: await logAttributed(
        definitions[0].stdout,
        engineFound.process.pid,
        engineFound.process.startTime,
        ["Hive starting up", "Hive is running"],
        deps,
      ),
      worker: await logAttributed(
        definitions[1].stdout,
        workerFound.process.pid,
        workerFound.process.startTime,
        ["registered worker"],
        deps,
      ),
    };
    if (!logs.engine || !logs.worker) blocked("CAPTURE_LOGS_UNATTRIBUTABLE");

    const validationPath = resolve(captureDirectory, "validation.json");
    await exclusiveWrite(
      validationPath,
      canonicalBytes({
        schemaVersion: 1,
        kind: "capture-validation",
        operationId: operation.record.id,
        snapshotId,
        draftSha256: draftSeal.sha256,
        probe: invoked.result,
        os: {
          engine: { pid: engineFound.process.pid, startTime: engineFound.process.startTime },
          worker: { pid: workerFound.process.pid, startTime: workerFound.process.startTime },
          sdkListenerOwner: workerFound.process.pid,
          bridgeListenerOwner: engineFound.process.pid,
          logs,
        },
      }),
    );
    state.capture.validation = strip(await sealFile(validationPath, { uid }));
    state.capture.phase = "validated";
    state.phase = "registering";
    await persistOperation(operation);

    const registered = await registerRecord({
      operation,
      instance,
      kind: "pilot-snapshot",
      id: snapshotId,
      now,
      files: staged.map((item) => ({ name: item.name, bytes: item.bytes })),
      buildPayload: ({ id, files }) => {
        const rehome = (seal: FileSeal | null): FileSeal | null => (seal ? files[basename(seal.path)] : null);
        const services = baseline.services.map((save) => ({
          ...save,
          effectivePlist: { source: save.effectivePlist.source, saved: rehome(save.effectivePlist.saved)! },
          instancePlist: { ...save.instancePlist, saved: rehome(save.instancePlist.saved) },
        })) as PilotSnapshot["services"];
        return {
          schemaVersion: 1,
          kind: "pilot-snapshot",
          id,
          capturedAt: now(),
          configIdentity: invoked.result.configIdentity,
          ...baseline,
          services,
          runtime: {
            ...baseline.runtime,
            roots: baseline.runtime.roots.map((root) => ({ ...root, manifest: rehome(root.manifest)! })),
          },
        } satisfies PilotSnapshot;
      },
    });
    state.capture.phase = "committed";
    state.capture.registration = registered.reference;
    state.selectedSnapshot = registered.reference;
    await persistOperation(operation);
    log.info("Pilot snapshot captured", { admission: admission.kind, loader: layout.loader.kind });
    return complete(
      operation,
      "record-committed",
      {
        status: "PILOT_SNAPSHOT_REGISTERED",
        snapshot: registered.selector,
        loader: layout.loader.kind,
        admission: admission.kind,
      },
      0,
    );
  } finally {
    revokeCaptureTicket(ticket);
  }
}
