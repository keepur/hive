/**
 * Outer `pilot` / `pilot-inventory` probe modes run by the REGISTERED BOOTSTRAP
 * probe (KPR-463 plan chunk 4 Task 9 Step 4b.2, chunk 5 Task 9 Step 4b.1a Step 1
 * and Step 4b.2a).
 *
 * The frozen helper writes a private canonical request under
 * `<operation>/probes/<requestId>/<mode>.json` and launches the captured Node on
 * the bootstrap tooling's `pkg/runtime-probe.min.js` with the captured worker
 * service environment. This process:
 *
 * 1. seals and strictly decodes the request at its fixed path;
 * 2. verifies the active acquired operation (and, for a capture draft, the
 *    capture mode, frozen owner and recorded draft seal);
 * 3. resolves the subject ONLY through the fixed operation draft path or the
 *    strict registry reader — a draft is never selectable elsewhere;
 * 4. verifies it is the subject's own registered bootstrap probe, the selected
 *    service environment and the expected processes against OS readback;
 * 5. selects the captured loader:
 *    - `packaged-probe`: the historical release's own `runtime-probe.min.js`
 *      through the exact `pilot-abi` handshake and `pilot-abi-v1` request;
 *    - `legacy-module`: the hash-verified captured `worker-config.js`, whose
 *      credentials stay in this isolated probe process.
 *
 * Output is one canonical sanitized line; failures carry only a fixed
 * classification. No candidate configuration is imported.
 */
import { resolve } from "node:path";
import { canonical, parseCanonical } from "./canonical.js";
import {
  assertActiveProbeOperation,
  assertProbeEnvironment,
  bridgeObservationOf,
  collectLivekitInventory,
  observedDependencyFiles,
  operationDirectoryOf,
  readSealedRequest,
  sdkObservationOf,
  withProbeDeadline,
  type HistoricalLoaderConfig,
  type LivekitReader,
  type PilotProbeBoundaries,
} from "./historical-probe.js";
import {
  canonicalBytes,
  decodeCaptureDraft,
  readReference,
  readRegisteredRecord,
  registrySelector,
  snapshotBaseline,
  sealFile,
  verifySeal,
  type BootstrapRecord,
  type CaptureDraft,
  type FileSeal,
  type PilotSnapshot,
  type ProcessSeal,
} from "./pilot-records.js";
import {
  countInventory,
  decodeHistoricalInventory,
  decodeHistoricalObservation,
  decodePilotAbiHandshake,
  decodePilotProbeRequest,
  decodeProbeFailure,
  historicalRequestPath,
  HISTORICAL_PROBE_ABI,
  INVENTORY_LIMITATIONS,
  MAX_PROBE_OUTPUT_BYTES,
  pilotConfigIdentity,
  pilotProbeRequestPath,
  ProbeFailure,
  sha256Canonical,
  type HistoricalProbeRequest,
  type PilotInventoryResult,
  type PilotProbeMode,
  type PilotProbeRequest,
  type PilotProbeResult,
} from "./pilot-probe.js";
import { buildServiceEnvironment } from "./services.js";

export type Baseline = CaptureDraft["baseline"];

export interface OuterProbeDeps extends PilotProbeBoundaries {
  /** Launch the captured Node on the historical probe (direct child, bounded, no shell). */
  run(
    node: string,
    args: readonly string[],
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string }>;
  writeRequest(path: string, bytes: Buffer): Promise<void>;
  /** Import the hash-verified captured legacy loader module and return its `loadWorkerConfig`. */
  importLegacyLoader(realpath: string): Promise<() => unknown>;
  /** LiveKit reader resolved relative to a captured loader file (legacy branch only). */
  livekitFrom(loaderRealpath: string, wc: HistoricalLoaderConfig): Promise<LivekitReader>;
}

function sameProcess(
  expected: ProcessSeal,
  observed: { pid: number; startTime: string; executable: string; command: string; cwd: string } | null,
): boolean {
  return (
    observed !== null &&
    observed.pid === expected.pid &&
    observed.startTime === expected.startTime &&
    observed.executable === expected.executable &&
    observed.command === expected.command &&
    observed.cwd === expected.cwd
  );
}

interface ResolvedSubject {
  baseline: Baseline;
  configIdentity: string | null;
}

async function resolveSubject(request: PilotProbeRequest, deps: OuterProbeDeps): Promise<ResolvedSubject> {
  const home = request.instance.canonicalHome;
  const operationDirectory = operationDirectoryOf(home, request.operationId);
  if (request.subject.kind === "capture-draft") {
    const record = await assertActiveProbeOperation(home, request.operationId, request.idle);
    const capture = record.schemaVersion === 2 ? record.registry?.capture : undefined;
    const frozen = record.schemaVersion === 2 ? record.frozenOwner : null;
    if (
      record.schemaVersion !== 2 ||
      record.workKind !== "registry" ||
      record.mode !== "capture-pilot" ||
      !capture ||
      capture.phase !== "sealed" ||
      !capture.draft ||
      capture.draft.sha256 !== request.subject.draftSha256 ||
      canonical(capture.draft) !== canonical(request.draftOrSnapshotSeal) ||
      !frozen
    ) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    }
    const frozenLive = await deps.processIdentity(frozen.pid, operationDirectory);
    if (!frozenLive || frozenLive.startTime !== frozen.startTime) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    const draftPath = resolve(operationDirectory, "capture", "draft.json");
    if (request.draftOrSnapshotSeal.path !== draftPath) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    let draft: CaptureDraft;
    try {
      draft = decodeCaptureDraft(parseCanonical(await verifySeal(request.draftOrSnapshotSeal, { uid: deps.uid() })));
    } catch (error) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
    }
    if (draft.operationId !== request.operationId || canonical(draft.instance) !== canonical(request.instance)) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    }
    return { baseline: draft.baseline, configIdentity: null };
  }
  await assertActiveProbeOperation(home, request.operationId, request.idle);
  const selector = registrySelector(home, request.subject.snapshot.id);
  if (request.draftOrSnapshotSeal.path !== selector) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  let snapshot: PilotSnapshot;
  try {
    snapshot = (
      await readRegisteredRecord<PilotSnapshot>(selector, {
        instance: request.instance,
        kind: "pilot-snapshot",
        expected: request.subject.snapshot,
        now: deps.now,
      })
    ).payload;
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
  const baseline = snapshotBaseline(snapshot);
  const configIdentity = snapshot.configIdentity;
  return { baseline, configIdentity };
}

function outputLine(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || stdout.length > MAX_PROBE_OUTPUT_BYTES) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  try {
    return parseCanonical(Buffer.from(`${lines[0]}\n`));
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE");
  return value;
}

function requireStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE");
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE");
    out[key] = item;
  }
  return out;
}

/** Strictly validate the captured legacy loader's actual return shape; nothing is defaulted from the candidate. */
export function legacyLoaderConfig(value: unknown, capturedSdkPort: number): HistoricalLoaderConfig {
  if (!value || typeof value !== "object") throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE");
  const o = value as Record<string, unknown>;
  const healthPort =
    o.healthPort === undefined
      ? capturedSdkPort
      : Number.isSafeInteger(o.healthPort)
        ? (o.healthPort as number)
        : Number.NaN;
  if (healthPort !== capturedSdkPort) throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  return {
    instanceHome: requireString(o.instanceHome),
    instanceId: requireString(o.instanceId),
    mongoDbName: requireString(o.mongoDbName),
    sipTrunkId: typeof o.sipTrunkId === "string" ? o.sipTrunkId : requireString(o.sipTrunkId),
    inboundAgents: requireStringMap(o.inboundAgents),
    agentVoices: requireStringMap(o.agentVoices),
    defaultStt: requireString(o.defaultStt),
    defaultTts: requireString(o.defaultTts),
    bridgeUrl: requireString(o.bridgeUrl),
    healthPort,
    bridgeToken: requireString(o.bridgeToken),
    mongoUri: requireString(o.mongoUri),
    livekitUrl: requireString(o.livekitUrl),
    livekitApiKey: requireString(o.livekitApiKey),
    livekitApiSecret: requireString(o.livekitApiSecret),
  };
}

async function sealDependencies(entry: string, roots: readonly string[], deps: OuterProbeDeps): Promise<FileSeal[]> {
  const seals: FileSeal[] = [];
  for (const item of deps.resolveDependencies(entry, roots)) {
    const { bytes: _bytes, ...seal } = await sealFile(item.path, { uid: deps.uid() }).catch((error: unknown) => {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
    });
    void _bytes;
    seals.push(seal);
  }
  return seals;
}

async function runHistoricalChild(
  request: PilotProbeRequest,
  mode: PilotProbeMode,
  baseline: Baseline,
  environment: Record<string, string>,
  deps: OuterProbeDeps,
): Promise<PilotProbeResult | PilotInventoryResult> {
  const loader = baseline.runtime.workerLoader;
  if (loader.kind !== "packaged-probe") throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  if (loader.file.realpath !== resolve(loader.runtimeRoot, "pkg", "runtime-probe.min.js")) {
    throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  }
  const node = baseline.runtime.node.path;
  const remaining = () => request.deadline - deps.now();
  if (remaining() <= 0) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  const handshake = await deps.run(node, [loader.file.path, "pilot-abi"], environment, remaining());
  if (handshake.exitCode !== 0) throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  const abi = decodePilotAbiHandshake(outputLine(handshake.stdout));
  if (canonical(abi.release) !== canonical(loader.release)) throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  const historical: HistoricalProbeRequest = {
    schemaVersion: 1,
    abi: HISTORICAL_PROBE_ABI,
    action: mode === "pilot" ? "observe" : "inventory",
    requestId: request.requestId,
    operationId: request.operationId,
    subject: request.subject,
    instance: request.instance,
    requestedAt: request.requestedAt,
    deadline: request.deadline,
    expectedRelease: loader.release,
    expectedProbe: loader.file,
    sdkPort: baseline.runtime.sdkListener.port,
    dependencyFiles: mode === "pilot" ? await sealDependencies(loader.file.realpath, [loader.runtimeRoot], deps) : [],
    idle: request.idle,
  };
  const path = historicalRequestPath(request.instance.canonicalHome, historical);
  await deps.writeRequest(path, canonicalBytes(historical));
  if (remaining() <= 0) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  const child = await deps.run(node, [loader.file.path, "pilot-abi-v1", path], environment, remaining());
  const parsed = outputLine(child.stdout);
  if (child.exitCode !== 0) {
    let classification: ProbeFailure["classification"] = "PILOT_PROBE_ABI_UNSUPPORTED";
    try {
      const failure = decodeProbeFailure(parsed, HISTORICAL_PROBE_ABI);
      if (failure.requestId === request.requestId) classification = failure.classification;
    } catch {
      // Unknown failure shape: unsupported.
    }
    throw new ProbeFailure(classification);
  }
  const header = (value: {
    requestId: string;
    operationId: string;
    subject: unknown;
    instance: unknown;
    release: unknown;
    startedAt: number;
    finishedAt: number;
  }) => {
    if (
      value.requestId !== request.requestId ||
      value.operationId !== request.operationId ||
      canonical(value.subject) !== canonical(request.subject) ||
      canonical(value.instance) !== canonical(request.instance) ||
      canonical(value.release) !== canonical(loader.release)
    ) {
      throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    }
    if (
      value.startedAt < request.requestedAt ||
      value.startedAt > value.finishedAt ||
      value.finishedAt > request.deadline
    ) {
      throw new ProbeFailure("PILOT_PROBE_DEADLINE");
    }
  };
  if (mode === "pilot") {
    const observation = decodeHistoricalObservation(parsed);
    header(observation);
    if ((request.idle === null) !== (observation.idle === null)) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
    return {
      schemaVersion: 1,
      requestId: observation.requestId,
      instance: observation.instance,
      subject: observation.subject,
      startedAt: observation.startedAt,
      finishedAt: observation.finishedAt,
      classification: "PILOT_OBSERVED",
      configIdentity: observation.configIdentity,
      bridge: observation.bridge,
      sdk: observation.sdk,
      idle: observation.idle,
      dependencyFiles: observation.dependencyFiles,
    };
  }
  const inventory = decodeHistoricalInventory(parsed);
  header(inventory);
  return inventoryResult(request, inventory.startedAt, inventory.finishedAt, inventory.configIdentity, inventory.items);
}

function inventoryResult(
  request: PilotProbeRequest,
  startedAt: number,
  finishedAt: number,
  configIdentity: string,
  items: PilotInventoryResult["items"],
): PilotInventoryResult {
  const counts = countInventory(items);
  const limitations = [...INVENTORY_LIMITATIONS] as PilotInventoryResult["limitations"];
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    instance: request.instance,
    subject: request.subject,
    startedAt,
    finishedAt,
    classification: "PILOT_INVENTORY_OBSERVED",
    configIdentity,
    items,
    counts,
    limitations,
    evidenceDigest: sha256Canonical({ items, counts, limitations }),
  };
}

async function runLegacyLoader(
  request: PilotProbeRequest,
  mode: PilotProbeMode,
  baseline: Baseline,
  startedAt: number,
  deps: OuterProbeDeps,
): Promise<PilotProbeResult | PilotInventoryResult> {
  const loader = baseline.runtime.workerLoader;
  if (loader.kind !== "legacy-module") throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  // A legacy profile has no native capability: an idle request cannot be answered.
  if (request.idle !== null) throw new ProbeFailure("PILOT_PROBE_ABI_UNSUPPORTED");
  const sdkPort = baseline.runtime.sdkListener.port;
  const home = request.instance.canonicalHome;
  let wc: HistoricalLoaderConfig;
  try {
    const load = await withProbeDeadline(deps.importLegacyLoader(loader.file.realpath), request.deadline, deps.now);
    wc = legacyLoaderConfig(await Promise.resolve(load()), sdkPort);
  } catch (error) {
    if (error instanceof ProbeFailure && error.classification !== "PILOT_LOADER_UNAVAILABLE") throw error;
    throw new ProbeFailure("PILOT_LOADER_UNAVAILABLE", { cause: error });
  }
  if (wc.instanceHome !== home && wc.instanceHome !== request.instance.canonicalHome) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  let bridgePort: number;
  try {
    const url = new URL(wc.bridgeUrl);
    bridgePort = Number(url.port || "80");
  } catch (error) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH", { cause: error });
  }
  if (bridgePort !== baseline.runtime.bridgePort) throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  const configIdentity = pilotConfigIdentity({ ...wc, instanceHome: home }, request.instance, sdkPort);
  if (mode === "pilot-inventory") {
    const reader = await deps.livekitFrom(loader.file.realpath, wc);
    const items = await withProbeDeadline(
      collectLivekitInventory(reader, request.operationId),
      request.deadline,
      deps.now,
    );
    const finishedAt = deps.now();
    if (finishedAt > request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
    return inventoryResult(request, startedAt, finishedAt, configIdentity, items);
  }
  const [bridge, http] = await withProbeDeadline(
    Promise.all([deps.probeBridge(wc.bridgeUrl, wc.bridgeToken), deps.probeWorkerHttp(sdkPort)]),
    request.deadline,
    deps.now,
  );
  const dependencyFiles = await observedDependencyFiles(
    deps,
    loader.file.realpath,
    baseline.runtime.roots.map((root) => root.realpath),
  );
  const finishedAt = deps.now();
  if (finishedAt > request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    instance: request.instance,
    subject: request.subject,
    startedAt,
    finishedAt,
    classification: "PILOT_OBSERVED",
    configIdentity,
    bridge: bridgeObservationOf(bridge),
    sdk: sdkObservationOf(sdkPort, http),
    idle: null,
    dependencyFiles,
  };
}

/** Execute one outer pilot probe; throws `ProbeFailure` with a fixed classification. */
export async function runPilotProfileProbe(
  mode: PilotProbeMode,
  inputPath: string,
  deps: OuterProbeDeps,
): Promise<PilotProbeResult | PilotInventoryResult> {
  const bytes = await readSealedRequest(inputPath, deps.uid());
  let request: PilotProbeRequest;
  try {
    request = decodePilotProbeRequest(parseCanonical(bytes), mode);
  } catch (error) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID", { cause: error });
  }
  const home = request.instance.canonicalHome;
  if (inputPath !== pilotProbeRequestPath(home, request, mode)) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  const startedAt = deps.now();
  if (startedAt < request.requestedAt || startedAt >= request.deadline) throw new ProbeFailure("PILOT_PROBE_DEADLINE");

  const { baseline } = await resolveSubject(request, deps);
  if (canonical(baseline.instance) !== canonical(request.instance)) throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  if (canonical(request.bootstrap) !== canonical(baseline.bootstrap))
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  try {
    const bootstrap = await readReference<BootstrapRecord>(request.bootstrap, {
      instance: request.instance,
      kind: "bootstrap",
      now: deps.now,
    });
    const { realpath } = await import("node:fs/promises");
    if ((await realpath(deps.selfPath)) !== bootstrap.payload.probe.realpath) {
      throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH");
    }
    await verifySeal(bootstrap.payload.probe, { uid: deps.uid() });
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
  }

  const environment = assertProbeEnvironment(deps, request.instance);
  if (canonical(environment) !== canonical(buildServiceEnvironment(baseline.services[1].definition))) {
    throw new ProbeFailure("PILOT_CONFIGURATION_MISMATCH");
  }
  if (
    request.subject.kind === "capture-draft" &&
    (canonical(request.expectedEngine) !== canonical(baseline.runtime.engine) ||
      canonical(request.expectedWorker) !== canonical(baseline.runtime.worker))
  ) {
    throw new ProbeFailure("PILOT_PROBE_INPUT_INVALID");
  }
  const operationDirectory = operationDirectoryOf(home, request.operationId);
  for (const expected of [request.expectedEngine, request.expectedWorker]) {
    if (!sameProcess(expected, await deps.processIdentity(expected.pid, operationDirectory))) {
      throw new ProbeFailure("PILOT_ADMISSION_MISMATCH");
    }
  }
  try {
    await verifySeal(baseline.runtime.workerLoader.file, { uid: deps.uid() });
  } catch (error) {
    throw new ProbeFailure("PILOT_DEPENDENCY_MISMATCH", { cause: error });
  }
  return baseline.runtime.workerLoader.kind === "packaged-probe"
    ? runHistoricalChild(request, mode, baseline, environment, deps)
    : runLegacyLoader(request, mode, baseline, startedAt, deps);
}
