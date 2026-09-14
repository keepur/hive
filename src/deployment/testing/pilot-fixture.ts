/**
 * Disposable registered-pilot fixtures for KPR-463 S7 unit tests. Every path
 * lives under a fresh temporary directory; nothing here touches an operator
 * instance, a LaunchAgent, a protected pilot worktree or a vendor endpoint.
 * Secrets are dummy strings.
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initialBootstrapWork } from "../bootstrap.js";
import { acquireOperation, finishOperationLock, persistOperation, type AcquiredOperation } from "../operation.js";
import { initialRegistryWork, type RegistryWork } from "../pilot.js";
import { pilotConfigIdentity } from "../pilot-probe.js";
import {
  buildTreeManifest,
  registerRecord,
  type BootstrapRecord,
  type FileSeal,
  type InstanceKey,
  type PilotSnapshot,
  type ProcessSeal,
  type TreeSeal,
} from "../pilot-records.js";
import type { BootIdentity, Release } from "../release.js";
import {
  buildServiceDefinitions,
  buildServiceEnvironment,
  type ServiceDefinition,
  type ServiceInspection,
} from "../services.js";

export const FIXTURE_UID = process.getuid!();
export const FIXTURE_START = "Mon Sep 14 10:00:00 2026";
export const ENGINE_PID = 700;
export const WORKER_PID = 701;
export const SDK_PORT = 3108;
export const BRIDGE_PORT = 3107;
export const FIXTURE_BOOT = "33333333-3333-4333-8333-333333333333";
export const DUMMY_SECRETS = {
  bridgeToken: "dummy-bridge-token",
  livekitApiKey: "dummy-livekit-key",
  livekitApiSecret: "dummy-livekit-secret",
  mongoUri: "mongodb://dummy-user:dummy-pass@127.0.0.1:1",
};

export const FIXTURE_RELEASE: Release = {
  schemaVersion: 1,
  packageVersion: "1.2.3",
  sourceRevision: "c".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: "d".repeat(64),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};

export function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileSealSync(path: string): FileSeal {
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

export function writeFixtureFile(path: string, content: string, mode = 0o644): string {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { mode });
  return path;
}

async function tree(root: string, manifestPath: string): Promise<TreeSeal> {
  writeFileSync(manifestPath, await buildTreeManifest(root, { uid: FIXTURE_UID, closureRoots: [root] }), {
    mode: 0o600,
  });
  const info = lstatSync(root);
  return {
    path: root,
    realpath: root,
    uid: FIXTURE_UID,
    dev: info.dev,
    ino: info.ino,
    manifest: fileSealSync(manifestPath),
  };
}

export interface PilotFixture {
  base: string;
  home: string;
  userHome: string;
  instance: InstanceKey;
  layout: "legacy" | "packaged";
  runtimeRoot: string;
  node: string;
  loaderPath: string;
  bootstrapProbe: string;
  bootstrap: { selector: string; reference: { id: string; sha256: string }; payload: BootstrapRecord };
  snapshot: {
    selector: string;
    reference: { id: string; sha256: string };
    payload: PilotSnapshot;
    payloadSeal: FileSeal;
  };
  definitions: { engine: ServiceDefinition; worker: ServiceDefinition };
  engine: ProcessSeal;
  worker: ProcessSeal;
  loaderConfig: Record<string, unknown>;
  descriptor(overrides?: Partial<BootIdentity>): BootIdentity;
  writeDescriptor(identity?: BootIdentity): void;
  inspection(label: string, process?: ProcessSeal | null): ServiceInspection;
  registryOperation(command: RegistryWork["command"], frozen?: boolean): Promise<AcquiredOperation>;
}

export async function createPilotFixture(
  options: { layout?: "legacy" | "packaged"; admission?: "native" | "unavailable" } = {},
): Promise<PilotFixture> {
  const layout = options.layout ?? "legacy";
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-pilot-fixture-")));
  chmodSync(base, 0o755);
  const home = resolve(base, "instance");
  mkdirSync(home, { mode: 0o755 });
  const userHome = resolve(base, "user");
  mkdirSync(resolve(userHome, "Library", "LaunchAgents"), { recursive: true, mode: 0o755 });
  const configPath = writeFixtureFile(resolve(home, "hive.yaml"), "instance:\n  id: dodi\n");
  const instance: InstanceKey = { canonicalHome: home, configPath, instanceId: "dodi", uid: FIXTURE_UID };

  const runtimeRoot = resolve(base, layout === "legacy" ? "pilot-checkout" : "historical");
  const engineEntry = writeFixtureFile(resolve(runtimeRoot, "pkg/server.min.js"), "engine();\n");
  const workerEntry = writeFixtureFile(
    resolve(runtimeRoot, layout === "legacy" ? "dist/voice-worker/main.js" : "pkg/voice-worker.min.js"),
    "worker();\n",
  );
  const loaderPath = writeFixtureFile(
    resolve(runtimeRoot, layout === "legacy" ? "dist/voice-worker/worker-config.js" : "pkg/runtime-probe.min.js"),
    layout === "legacy" ? "export function loadWorkerConfig(){}\n" : "// historical probe\n",
  );
  for (const name of ["livekit-server-sdk", "@livekit/agents", "@livekit/rtc-node"]) {
    writeFixtureFile(
      resolve(runtimeRoot, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: name === "livekit-server-sdk" ? "2.14.1" : "1.0.0", main: "index.js" }),
    );
    writeFixtureFile(resolve(runtimeRoot, "node_modules", name, "index.js"), "module.exports = {};\n");
  }
  const node = writeFixtureFile(resolve(base, "runtime/node"), "#!node\n", 0o755);
  mkdirSync(resolve(base, "manifests"), { mode: 0o700 });
  const runtimeTree = await tree(runtimeRoot, resolve(base, "manifests/runtime.manifest"));
  const enginePlist = writeFixtureFile(resolve(base, "launch/engine.plist"), "<plist>engine</plist>\n");
  const workerPlist = writeFixtureFile(resolve(base, "launch/worker.plist"), "<plist>worker</plist>\n");

  const archive = writeFixtureFile(resolve(base, "candidate.tgz"), "reviewed archive bytes\n");
  const archiveSha = sha("reviewed archive bytes\n");
  const tooling = resolve(home, ".hive-state/tooling", archiveSha);
  const helper = writeFixtureFile(resolve(tooling, "pkg/deploy.min.js"), "helper\n");
  const bootstrapProbe = writeFixtureFile(resolve(tooling, "pkg/runtime-probe.min.js"), "bootstrap probe\n");
  const diagnostic = writeFixtureFile(resolve(tooling, "pkg/voice-worker-diagnostic.min.js"), "diag\n");
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
    toolSha256: "a".repeat(64),
    ownerStartTime: "start",
  });
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
      archive: fileSealSync(archive),
      packageRoot: toolingTree,
      release: FIXTURE_RELEASE,
      helper: fileSealSync(helper),
      probe: fileSealSync(bootstrapProbe),
      diagnostic: fileSealSync(diagnostic),
      node: fileSealSync(node),
      npm: fileSealSync(node),
    }),
  });
  await finishOperationLock(bootstrapOperation);
  const bootstrapPayload = JSON.parse(readFileSync(bootstrap.selector, "utf8")) as BootstrapRecord;

  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: node,
    hiveHome: home,
    configPath,
    home: userHome,
    pathEnv: "/usr/bin:/bin",
  });
  const definitions = {
    engine: { ...pair.engine, entrypoint: engineEntry },
    worker: { ...pair.worker, entrypoint: workerEntry },
  };
  const seal = (pid: number, definition: ServiceDefinition): ProcessSeal => ({
    pid,
    startTime: FIXTURE_START,
    executable: node,
    command: [definition.nodePath, definition.entrypoint, ...definition.args].join(" "),
    cwd: home,
  });
  const engine = seal(ENGINE_PID, definitions.engine);
  const worker = seal(WORKER_PID, definitions.worker);
  const inspection = (label: string, process: ProcessSeal | null = label.endsWith("agent") ? engine : worker) => {
    const definition = label.endsWith("agent") ? definitions.engine : definitions.worker;
    return {
      label,
      loaded: process !== null,
      enabled: true,
      livePID: process?.pid ?? null,
      startTime: process?.startTime ?? null,
      args: [definition.nodePath, definition.entrypoint, ...definition.args],
      cwd: home,
      configSelection: configPath,
      serviceEnvironment: buildServiceEnvironment(definition),
      plist: null,
      link: null,
      process: process ? { ...process, ppid: 1 } : null,
    } satisfies ServiceInspection;
  };
  const loaderConfig = {
    instanceHome: home,
    instanceId: "dodi",
    healthPort: SDK_PORT,
    mongoDbName: "hive",
    sipTrunkId: "ST_dummy",
    inboundAgents: { "+15550000000": "rae" },
    agentVoices: {},
    defaultStt: "deepgram/flux-general-en",
    defaultTts: "cartesia/sonic-3",
    bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`,
    bridgeToken: DUMMY_SECRETS.bridgeToken,
    mongoUri: DUMMY_SECRETS.mongoUri,
    livekitUrl: "wss://dummy.livekit.invalid",
    livekitApiKey: DUMMY_SECRETS.livekitApiKey,
    livekitApiSecret: DUMMY_SECRETS.livekitApiSecret,
  };
  const configIdentity = pilotConfigIdentity(
    loaderConfig as unknown as Parameters<typeof pilotConfigIdentity>[0],
    instance,
    SDK_PORT,
  );
  const descriptor = (overrides: Partial<BootIdentity> = {}): BootIdentity => ({
    release: FIXTURE_RELEASE,
    component: "voice-worker",
    pid: WORKER_PID,
    bootId: FIXTURE_BOOT,
    startedAt: new Date(Date.UTC(2026, 8, 14, 10)).toISOString(),
    ...overrides,
  });
  const snapshotOperation = await acquireOperation({
    instanceHome: home,
    instanceId: "dodi",
    mode: "capture-pilot",
    workKind: "registry",
    registry: initialRegistryWork("capture-pilot"),
    toolSha256: "a".repeat(64),
    ownerStartTime: "start",
  });
  const native = (options.admission ?? (layout === "packaged" ? "native" : "unavailable")) === "native";
  const registered = await registerRecord({
    operation: snapshotOperation,
    instance,
    kind: "pilot-snapshot",
    files: [
      { name: "engine-effective.plist", bytes: Buffer.from("<plist>engine</plist>\n") },
      { name: "worker-effective.plist", bytes: Buffer.from("<plist>worker</plist>\n") },
    ],
    buildPayload: ({ id, files }) => {
      const save = (definition: ServiceDefinition, source: FileSeal, saved: FileSeal) => ({
        definition,
        inspection: inspection(definition.label),
        effectivePlist: { source, saved },
        instancePlist: {
          path: resolve(home, `service/${definition.label}.plist`),
          existed: false,
          saved: null,
          mode: null,
        },
        link: {
          path: resolve(userHome, `Library/LaunchAgents/${definition.label}.plist`),
          existed: true,
          target: source.path,
        },
        loaded: true,
        enabled: true,
      });
      const loaderSeal = fileSealSync(loaderPath);
      return {
        schemaVersion: 1,
        kind: "pilot-snapshot",
        id,
        instance,
        capturedAt: 1_000,
        captureOperationId: snapshotOperation.record.id,
        toolSha256: "a".repeat(64),
        bootstrap: bootstrap.reference,
        services: [
          save(definitions.engine, fileSealSync(enginePlist), files["engine-effective.plist"]),
          save(definitions.worker, fileSealSync(workerPlist), files["worker-effective.plist"]),
        ],
        runtime: {
          engine,
          worker,
          engineEntry: fileSealSync(engineEntry),
          workerEntry: fileSealSync(workerEntry),
          workerLoader:
            layout === "legacy"
              ? { kind: "legacy-module", file: loaderSeal }
              : {
                  kind: "packaged-probe",
                  file: loaderSeal,
                  runtimeRoot,
                  release: FIXTURE_RELEASE,
                  abi: "hive-pilot-probe/1",
                },
          node: fileSealSync(node),
          roots: [runtimeTree],
          sdkListener: { host: "127.0.0.1", port: SDK_PORT, agentName: "hive-voice" },
          bridgePort: BRIDGE_PORT,
        },
        configIdentity,
        configFiles: [{ path: configPath, seal: fileSealSync(configPath) }],
        slots: [".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) => ({
          path: resolve(home, name),
          identity: null,
          release: null,
        })) as PilotSnapshot["slots"],
        admission: native
          ? {
              kind: "hive-maintenance-v1",
              runtimeRoot,
              release: FIXTURE_RELEASE,
              workerBundle: fileSealSync(workerEntry),
              bootId: FIXTURE_BOOT,
            }
          : { kind: "unavailable" },
      } as PilotSnapshot;
    },
  });
  await finishOperationLock(snapshotOperation);
  const payload = JSON.parse(readFileSync(registered.selector, "utf8")) as PilotSnapshot;
  return {
    base,
    home,
    userHome,
    instance,
    layout,
    runtimeRoot,
    node,
    loaderPath,
    bootstrapProbe,
    bootstrap: { selector: bootstrap.selector, reference: bootstrap.reference, payload: bootstrapPayload },
    snapshot: {
      selector: registered.selector,
      reference: registered.reference,
      payload,
      payloadSeal: registered.registration.payload,
    },
    definitions,
    engine,
    worker,
    loaderConfig,
    descriptor,
    writeDescriptor(identity = descriptor()) {
      writeFixtureFile(resolve(home, ".hive-state/runtime/voice-worker.json"), JSON.stringify(identity), 0o600);
    },
    inspection,
    async registryOperation(command, frozen = true) {
      const operation = await acquireOperation({
        instanceHome: home,
        instanceId: "dodi",
        mode: command,
        workKind: "registry",
        registry: initialRegistryWork(command),
        toolSha256: "a".repeat(64),
        ownerStartTime: "start",
      });
      if (frozen) {
        operation.record.frozenOwner = { pid: process.pid, startTime: FIXTURE_START };
        await persistOperation(operation);
      }
      return operation;
    },
  };
}
