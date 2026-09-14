import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { acquireOperation, type AcquiredOperation } from "./operation.js";
import { canonical, parseCanonical } from "./canonical.js";
import {
  buildTreeManifest,
  canonicalBytes,
  checkSpec,
  decodeBootstrapRecord,
  decodeHoldRecord,
  decodePilotSnapshot,
  decodeRegistration,
  fileSeal,
  inventoryClasses,
  readReference,
  readRegisteredRecord,
  reconcileRegistration,
  registerRecord,
  registrySelector,
  RecordDecodeError,
  sealFile,
  SealMismatchError,
  verifySeal,
  verifyTreeSeal,
  type HoldRecord,
  type InstanceKey,
  type PilotSnapshot,
  type RegistrationFence,
} from "./pilot-records.js";
import { buildServiceDefinitions, buildServiceEnvironment, type ServiceInspection } from "./services.js";
import type { RegistryWork } from "./pilot.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o755);
    } catch {
      // already removed
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const UID = process.getuid!();
const ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const OP = "33333333-3333-4333-8333-333333333333";
const CHECK = "44444444-4444-4444-8444-444444444444";
const SOURCE = "55555555-5555-4555-8555-555555555555";
const DIGEST = "a".repeat(64);

function home(): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-pilot-records-")));
  chmodSync(root, 0o755);
  roots.push(root);
  writeFileSync(resolve(root, "hive.yaml"), "instance:\n  id: dodi\n");
  return root;
}

function instanceOf(root: string): InstanceKey {
  return { canonicalHome: root, configPath: resolve(root, "hive.yaml"), instanceId: "dodi", uid: UID };
}

function registryWork(command: RegistryWork["command"] = "prepare-legacy-hold"): RegistryWork {
  return {
    command,
    phase: "reading",
    selectedSnapshot: null,
    selectedHold: null,
    bootstrap: null,
    capture: null,
    result: null,
    barrier: null,
    outcome: null,
  };
}

async function registryOperation(root: string): Promise<AcquiredOperation> {
  return acquireOperation({
    instanceHome: root,
    instanceId: "dodi",
    mode: "prepare-legacy-hold",
    workKind: "registry",
    registry: registryWork(),
    toolSha256: DIGEST,
    ownerStartTime: "start",
  });
}

const worker = {
  pid: 4242,
  startTime: "Mon Sep 14 10:00:00 2026",
  executable: "/opt/node/bin/node",
  command: "/opt/node/bin/node /pilot/dist/voice-worker/main.js start",
  cwd: "/pilot",
};

function hold(instance: InstanceKey, id = ID, createdAt = 1_000): HoldRecord {
  return {
    schemaVersion: 1,
    kind: "legacy-hold",
    id,
    instance,
    snapshot: { id: SNAPSHOT_ID, sha256: DIGEST },
    toolSha256: DIGEST,
    createdAt,
    pilotWorker: worker,
    sources: [
      {
        id: SOURCE,
        category: "sip-dispatch-rules",
        locator: "sip-rule:digest",
        checks: [CHECK],
        scope: "unknown",
        accounting: "observations-only",
      },
    ],
    checks: [{ id: CHECK, kind: "livekit-inventory" }],
    gaps: inventoryClasses
      .filter((category) => category !== "sip-dispatch-rules")
      .map((category) => ({ category, reason: "LEGACY_ADMISSION_UNOBSERVABLE" })),
    procedure: { kind: "unavailable", reason: "LEGACY_ADMISSION_UNOBSERVABLE" },
  };
}

describe("strict record decoding", () => {
  it("accepts an exact hold record and rejects any undeclared or proof-like key", () => {
    const instance = instanceOf("/Users/example/services/hive/dodi");
    const record = hold(instance);
    expect(decodeHoldRecord(record).procedure.kind).toBe("unavailable");
    for (const key of [
      "passed",
      "verified",
      "authorized",
      "command",
      "argv",
      "shell",
      "url",
      "env",
      "expectedResult",
    ]) {
      expect(() => decodeHoldRecord({ ...record, [key]: true })).toThrow(RecordDecodeError);
      expect(() => decodeHoldRecord({ ...record, procedure: { ...record.procedure, [key]: true } })).toThrow();
    }
  });

  it("rejects stringified numbers, fake booleans, future timestamps, bad UUIDs and wrong kinds", () => {
    const record = hold(instanceOf("/Users/example/services/hive/dodi"));
    expect(() => decodeHoldRecord({ ...record, createdAt: "1000" })).toThrow();
    expect(() => decodeHoldRecord({ ...record, createdAt: 5_000 }, 4_000)).toThrow("future timestamp");
    expect(() => decodeHoldRecord({ ...record, id: "not-a-uuid" })).toThrow();
    expect(() => decodeHoldRecord({ ...record, kind: "bootstrap" })).toThrow();
    expect(() => decodeHoldRecord({ ...record, schemaVersion: 2 })).toThrow();
    expect(() =>
      decodeHoldRecord({ ...record, instance: { ...record.instance, uid: "501" } as unknown as InstanceKey }),
    ).toThrow();
    expect(() => checkSpec({ id: CHECK, kind: "admission-status", held: true })).toThrow();
  });

  it("requires every inventory category as an observation or a gap, with unique IDs and resolvable checks", () => {
    const record = hold(instanceOf("/Users/example/services/hive/dodi"));
    expect(() => decodeHoldRecord({ ...record, gaps: record.gaps.slice(1) })).toThrow("neither observed nor a gap");
    expect(() => decodeHoldRecord({ ...record, gaps: [...record.gaps, record.gaps[0]] })).toThrow();
    expect(() => decodeHoldRecord({ ...record, sources: [{ ...record.sources[0], checks: [SOURCE] }] })).toThrow(
      "outside this record",
    );
    expect(() => decodeHoldRecord({ ...record, sources: [record.sources[0], record.sources[0]] })).toThrow("duplicate");
  });

  it("only accepts canonical bytes: duplicate keys, whitespace and alternate spellings fail", () => {
    const record = hold(instanceOf("/Users/example/services/hive/dodi"));
    const bytes = canonicalBytes(record);
    expect(canonical(parseCanonical(bytes))).toBe(canonical(record));
    const text = bytes.toString("utf8");
    expect(() => parseCanonical(Buffer.from(text.replace('{"checks"', '{"checks":[],"checks"')))).toThrow();
    expect(() => parseCanonical(Buffer.from(` ${text}`))).toThrow("noncanonical");
    expect(() => parseCanonical(Buffer.from(text.replace('"createdAt":1000', '"createdAt":1e3')))).toThrow(
      "noncanonical",
    );
    expect(() => parseCanonical(Buffer.alloc(1024 * 1024 + 1, 32))).toThrow("record too large");
  });

  it("decodes a pilot snapshot strictly, including captured services and derived labels", () => {
    const instance = instanceOf("/Users/example/services/hive/dodi");
    const snapshot = pilotSnapshot(instance);
    expect(decodePilotSnapshot(snapshot).services[1].definition.label).toBe("com.hive.dodi.voice-worker");
    const renamed = structuredClone(snapshot);
    renamed.services[0].definition.label = "com.hive.other.agent";
    renamed.services[0].inspection.label = "com.hive.other.agent";
    expect(() => decodePilotSnapshot(renamed)).toThrow();
    const noProcess = structuredClone(snapshot);
    noProcess.services[1].inspection.process = null;
    expect(() => decodePilotSnapshot(noProcess)).toThrow("lacks live process");
    const secretEnv = structuredClone(snapshot);
    (secretEnv.services[1].definition.overrides as Record<string, string>).LIVEKIT_API_SECRET = "s";
    expect(() => decodePilotSnapshot(secretEnv)).toThrow();
    const buffer = structuredClone(snapshot) as unknown as { services: { effectivePlist: unknown }[] };
    buffer.services[0].effectivePlist = { type: "Buffer", data: [1, 2] };
    expect(() => decodePilotSnapshot(buffer)).toThrow();
    const slots = structuredClone(snapshot);
    slots.slots[3].path = "/tmp/elsewhere";
    expect(() => decodePilotSnapshot(slots)).toThrow("slot inventory");
  });

  it("requires a bootstrap package root keyed on its archive digest and tools inside it", () => {
    const instance = instanceOf("/Users/example/services/hive/dodi");
    const root = `/Users/example/services/hive/dodi/.hive-state/tooling/${DIGEST}`;
    const seal = (path: string) => ({ ...fakeSeal(path), sha256: DIGEST });
    const record = {
      schemaVersion: 1,
      kind: "bootstrap",
      id: ID,
      instance,
      createdAt: 1,
      archive: seal("/Users/example/services/hive/dodi/.hive-state/bootstrap/candidate.tgz"),
      packageRoot: { path: root, realpath: root, uid: UID, dev: 1, ino: 2, manifest: fakeSeal("/m") },
      release: releaseFixture(),
      helper: fakeSeal(`${root}/pkg/deploy.min.js`),
      probe: fakeSeal(`${root}/pkg/runtime-probe.min.js`),
      diagnostic: fakeSeal(`${root}/pkg/voice-worker-diagnostic.min.js`),
      node: fakeSeal("/opt/node/bin/node"),
      npm: fakeSeal("/opt/node/lib/node_modules/npm/bin/npm-cli.js"),
    };
    expect(decodeBootstrapRecord(record).packageRoot.path).toBe(root);
    expect(() => decodeBootstrapRecord({ ...record, helper: fakeSeal("/elsewhere/deploy.min.js") })).toThrow();
    expect(() => decodeBootstrapRecord({ ...record, archive: { ...record.archive, sha256: "b".repeat(64) } })).toThrow(
      "keyed",
    );
  });
});

function fakeSeal(path: string) {
  return { path, realpath: path, uid: UID, mode: 0o644, dev: 1, ino: 2, size: 3, sha256: DIGEST };
}

function releaseFixture() {
  return {
    schemaVersion: 1 as const,
    packageVersion: "1.2.3",
    sourceRevision: "c".repeat(40),
    sourceDirty: false,
    dependencyLockSha256: DIGEST,
    voiceWorker: { path: "pkg/voice-worker.min.js" as const, admissionProtocol: 1 as const },
  };
}

function pilotSnapshot(instance: InstanceKey): PilotSnapshot {
  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: "/opt/node/bin/node",
    hiveHome: instance.canonicalHome,
    configPath: instance.configPath,
    home: "/Users/example",
    pathEnv: "/usr/bin:/bin",
  });
  const save = (definition: typeof pair.engine, pid: number) => {
    const args = [definition.nodePath, definition.entrypoint, ...definition.args];
    const inspection: ServiceInspection = {
      label: definition.label,
      loaded: true,
      enabled: true,
      livePID: pid,
      startTime: "Mon Sep 14 10:00:00 2026",
      args,
      cwd: definition.hiveHome,
      configSelection: definition.configPath,
      serviceEnvironment: buildServiceEnvironment(definition),
      plist: null,
      link: null,
      process: {
        pid,
        ppid: 1,
        startTime: "Mon Sep 14 10:00:00 2026",
        command: args.join(" "),
        executable: definition.nodePath,
        cwd: definition.hiveHome,
      },
    };
    return {
      definition,
      inspection,
      effectivePlist: { source: fakeSeal(`/pilot/${definition.label}.plist`), saved: fakeSeal("/saved.plist") },
      instancePlist: {
        path: `${instance.canonicalHome}/service/${definition.label}.plist`,
        existed: false,
        saved: null,
        mode: null,
      },
      link: {
        path: `/Users/example/Library/LaunchAgents/${definition.label}.plist`,
        existed: true,
        target: "/pilot/x.plist",
      },
      loaded: true,
      enabled: true,
    };
  };
  return {
    schemaVersion: 1,
    kind: "pilot-snapshot",
    id: SNAPSHOT_ID,
    instance,
    capturedAt: 10,
    captureOperationId: OP,
    toolSha256: DIGEST,
    bootstrap: { id: ID, sha256: DIGEST },
    services: [save(pair.engine, 100), save(pair.worker, 101)],
    runtime: {
      engine: { ...worker, pid: 100 },
      worker: { ...worker, pid: 101 },
      engineEntry: fakeSeal("/pilot/pkg/server.min.js"),
      workerEntry: fakeSeal("/pilot/dist/voice-worker/main.js"),
      workerLoader: { kind: "legacy-module", file: fakeSeal("/pilot/dist/voice-worker/worker-config.js") },
      node: fakeSeal("/opt/node/bin/node"),
      roots: [{ path: "/pilot", realpath: "/pilot", uid: UID, dev: 1, ino: 9, manifest: fakeSeal("/m") }],
      sdkListener: { host: "127.0.0.1", port: 8081, agentName: "hive-voice" },
      bridgePort: 3107,
    },
    configIdentity: DIGEST,
    configFiles: [{ path: instance.configPath, seal: fakeSeal(instance.configPath) }],
    slots: [".hive", ".hive.prev", ".hive.next", ".hive.broken"].map((name) => ({
      path: `${instance.canonicalHome}/${name}`,
      identity: null,
      release: null,
    })) as PilotSnapshot["slots"],
    admission: { kind: "unavailable" },
  };
}

describe("registry registration and strict reads", () => {
  it("registers an immutable record under the operation lock and reads it back through the strict reader", async () => {
    const root = home();
    const operation = await registryOperation(root);
    const instance = instanceOf(root);
    const result = await registerRecord({
      operation,
      instance,
      kind: "legacy-hold",
      files: [{ name: "inventory.json", bytes: Buffer.from("{}\n") }],
      buildPayload: ({ id }) => hold(instance, id),
      now: () => 2_000,
    });
    expect(result.selector).toBe(registrySelector(root, result.reference.id));
    const read = await readRegisteredRecord<HoldRecord>(result.selector, {
      instance,
      kind: "legacy-hold",
      now: () => 3_000,
    });
    expect(read.payload.id).toBe(result.reference.id);
    expect((await readReference(result.reference, { instance, kind: "legacy-hold" })).payload.kind).toBe("legacy-hold");
    const fences = (operation.record.registrations ?? []) as RegistrationFence[];
    expect(fences[0].state).toBe("committed");
    expect(operation.record.retainedPaths).toContain(
      resolve(root, ".hive-state/deployment/registry", result.reference.id),
    );

    // Wrong kind, wrong instance/config/UID, wrong reference digest.
    await expect(readRegisteredRecord(result.selector, { instance, kind: "bootstrap" })).rejects.toThrow();
    await expect(
      readRegisteredRecord(result.selector, {
        instance: { ...instance, configPath: `${root}/other.yaml` },
        kind: "legacy-hold",
      }),
    ).rejects.toThrow();
    await expect(
      readRegisteredRecord(result.selector, { instance: { ...instance, uid: UID + 1 }, kind: "legacy-hold" }),
    ).rejects.toThrow();
    await expect(
      readReference({ ...result.reference, sha256: "b".repeat(64) }, { instance, kind: "legacy-hold" }),
    ).rejects.toThrow("digest mismatch");
  });

  it("refuses registration without the lock or from the wrong work kind", async () => {
    const root = home();
    const operation = await registryOperation(root);
    const instance = instanceOf(root);
    const foreign: AcquiredOperation = { ...operation, record: { ...operation.record, id: OP } };
    await expect(
      registerRecord({
        operation: foreign,
        instance,
        kind: "legacy-hold",
        buildPayload: ({ id }) => hold(instance, id),
      }),
    ).rejects.toThrow("lock");
    await expect(
      registerRecord({ operation, instance, kind: "bootstrap", buildPayload: ({ id }) => hold(instance, id) }),
    ).rejects.toThrow("bootstrap work");
  });

  it("rejects arbitrary state files, altered payloads/registrations, symlinks and mode/inode changes", async () => {
    const root = home();
    const operation = await registryOperation(root);
    const instance = instanceOf(root);
    const { selector, reference } = await registerRecord({
      operation,
      instance,
      kind: "legacy-hold",
      buildPayload: ({ id }) => hold(instance, id),
    });
    const directory = resolve(selector, "..");
    // Arbitrary same-state file.
    const stray = resolve(root, ".hive-state", "evidence.json");
    writeFileSync(stray, readFileSync(selector), { mode: 0o600 });
    await expect(readRegisteredRecord(stray, { instance, kind: "legacy-hold" })).rejects.toThrow("not a registered");
    // Non-normalized spelling.
    await expect(
      readRegisteredRecord(`${directory}/../${reference.id}/payload.json`, { instance, kind: "legacy-hold" }),
    ).rejects.toThrow();
    // Mode change.
    chmodSync(selector, 0o644);
    await expect(readRegisteredRecord(selector, { instance, kind: "legacy-hold" })).rejects.toThrow("mode");
    chmodSync(selector, 0o600);
    // Altered payload bytes (inode change and content change).
    const bytes = readFileSync(selector);
    const replacement = `${selector}.new`;
    writeFileSync(replacement, bytes, { mode: 0o600 });
    renameSync(replacement, selector);
    await expect(readRegisteredRecord(selector, { instance, kind: "legacy-hold" })).rejects.toThrow("seal mismatch");
    // Symlinked registry entry.
    const linkRoot = home();
    const linkOperation = await registryOperation(linkRoot);
    const linkInstance = instanceOf(linkRoot);
    const linked = await registerRecord({
      operation: linkOperation,
      instance: linkInstance,
      kind: "legacy-hold",
      buildPayload: ({ id }) => hold(linkInstance, id),
    });
    const moved = resolve(linkRoot, "elsewhere");
    renameSync(resolve(linked.selector, ".."), moved);
    symlinkSync(moved, resolve(linked.selector, ".."));
    await expect(
      readRegisteredRecord(linked.selector, { instance: linkInstance, kind: "legacy-hold" }),
    ).rejects.toThrow("symbolic link");
  });

  it("an incomplete registration without its commit is never selectable and reconciles as incomplete", async () => {
    const root = home();
    const operation = await registryOperation(root);
    const instance = instanceOf(root);
    const { selector } = await registerRecord({
      operation,
      instance,
      kind: "legacy-hold",
      buildPayload: ({ id }) => hold(instance, id),
    });
    const fence = structuredClone((operation.record.registrations ?? [])[0]);
    expect(await reconcileRegistration(fence, instance)).toMatchObject({ outcome: "committed" });
    rmSync(resolve(selector, "..", "registration.json"));
    await expect(readRegisteredRecord(selector, { instance, kind: "legacy-hold" })).rejects.toThrow("incomplete");
    expect(await reconcileRegistration(fence, instance)).toEqual({ outcome: "incomplete" });
    // An intended directory that never appeared is absent; a created one without identity is ambiguous.
    const absent: RegistrationFence = {
      ...fence,
      id: OP,
      directory: {
        ...fence.directory,
        path: resolve(root, ".hive-state/deployment/registry", OP),
        state: "intended",
        identity: null,
      },
    };
    expect(await reconcileRegistration(absent, instance)).toEqual({ outcome: "absent" });
    mkdirSync(absent.directory.path, { mode: 0o700 });
    expect(await reconcileRegistration(absent, instance)).toMatchObject({ outcome: "unresolved" });
  });

  it("a commit whose bytes differ from the durable intent is unresolved, never rewritten", async () => {
    const root = home();
    const operation = await registryOperation(root);
    const instance = instanceOf(root);
    const { selector } = await registerRecord({
      operation,
      instance,
      kind: "legacy-hold",
      buildPayload: ({ id }) => hold(instance, id),
    });
    const fence = structuredClone((operation.record.registrations ?? [])[0]);
    const commit = resolve(selector, "..", "registration.json");
    const registration = decodeRegistration(parseCanonical(readFileSync(commit)));
    chmodSync(commit, 0o600);
    rmSync(commit);
    writeFileSync(commit, canonicalBytes({ ...registration, createdAt: registration.createdAt + 1 }), { mode: 0o600 });
    expect(await reconcileRegistration(fence, instance)).toMatchObject({ outcome: "unresolved" });
  });
});

describe("file and tree seals", () => {
  it("detects hash, mode and inode changes and rejects foreign-writable files", async () => {
    const root = home();
    const file = resolve(root, "node");
    writeFileSync(file, "binary", { mode: 0o755 });
    const { bytes, ...seal } = await sealFile(file, { uid: UID });
    expect(bytes.toString()).toBe("binary");
    expect(fileSeal(seal)).toEqual(seal);
    await verifySeal(seal, { uid: UID });
    writeFileSync(file, "changed");
    await expect(verifySeal(seal, { uid: UID })).rejects.toBeInstanceOf(SealMismatchError);
    chmodSync(file, 0o777);
    await expect(sealFile(file, { uid: UID })).rejects.toThrow("writable");
    const symlink = resolve(root, "node-link");
    symlinkSync(file, symlink);
    chmodSync(file, 0o755);
    await expect(verifySeal({ ...seal, path: symlink }, { uid: UID })).rejects.toThrow();
  });

  it("rewalks tree manifests, catching content changes and links escaping the sealed closure", async () => {
    const root = home();
    const pilot = resolve(root, "pilot");
    mkdirSync(resolve(pilot, "node_modules", "pkg"), { recursive: true, mode: 0o755 });
    writeFileSync(resolve(pilot, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", { mode: 0o644 });
    mkdirSync(resolve(pilot, ".git"), { mode: 0o755 });
    writeFileSync(resolve(pilot, ".git", "HEAD"), "ref");
    symlinkSync("pkg", resolve(pilot, "node_modules", "alias"));
    const options = { uid: UID, closureRoots: [pilot] };
    const manifest = await buildTreeManifest(pilot, options);
    expect(manifest.toString()).not.toContain(".git");
    const manifestPath = resolve(root, "manifest");
    writeFileSync(manifestPath, manifest, { mode: 0o600 });
    const { bytes: _unused, ...manifestSeal } = await sealFile(manifestPath, { uid: UID });
    void _unused;
    const info = await import("node:fs/promises").then((fs) => fs.lstat(pilot));
    const seal = { path: pilot, realpath: pilot, uid: UID, dev: info.dev, ino: info.ino, manifest: manifestSeal };
    await verifyTreeSeal(seal, options);
    writeFileSync(resolve(pilot, "node_modules", "pkg", "index.js"), "module.exports = 2;\n");
    await expect(verifyTreeSeal(seal, options)).rejects.toThrow("tree contents changed");
    symlinkSync(root, resolve(pilot, "escape"));
    await expect(buildTreeManifest(pilot, options)).rejects.toThrow("escapes");
  });
});
