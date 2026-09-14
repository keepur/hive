/**
 * Durable, reconstructable prior snapshot (KPR-463 plan chunk 4 Task 8 Step
 * 5a.1). This is the single source both ordinary failure recovery and
 * next-invocation reconciliation use to restore the exact prior service pair:
 * complete service definitions and inspections, sealed plist backups for both
 * the effective and the instance-owned plist roles, link targets,
 * loaded/enabled state, artifact slot identities and the prior health profile.
 *
 * Decoding is strict and exact-key. Plist bytes are reconstructed only from a
 * sealed backup file inside the operation directory, never from JSON. An older
 * incomplete snapshot is reported with its exact missing fields and is never
 * reconstructed by guessing.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildServiceEnvironment,
  type CapturedServiceDefinition,
  type ServiceController,
  type ServiceDefinition,
  type ServiceInspection,
  type ServiceSnapshot,
} from "./services.js";
import {
  writeOperationJson,
  type AcquiredOperation,
  type DirectoryIdentity,
  type OperationRecord,
} from "./operation.js";

export const PRIOR_SNAPSHOT_SCHEMA_VERSION = 2;

export class PriorSnapshotIncompleteError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`prior snapshot cannot be reconstructed; missing fields: ${missing.join(", ")}`);
  }
}

export interface SavedFile {
  path: string;
  existed: boolean;
  /** Private sealed backup inside the operation directory. */
  backup: string | null;
  sha256: string | null;
  mode: number | null;
}

export interface SavedService {
  definition: ServiceDefinition;
  inspection: ServiceInspection;
  effectivePlist: SavedFile;
  instancePlist: SavedFile;
  link: { path: string; existed: boolean; target: string | null };
  loaded: boolean;
  enabled: boolean;
}

export const INSTANCE_SLOT_NAMES = [".hive", ".hive.prev", ".hive.next", ".hive.broken"] as const;
export const RESERVED_SLOT_NAMES = ["prior-prev", "prior-broken", "rollback-current", "failed-prev"] as const;

export interface SavedSlot {
  name: string;
  path: string;
  identity: DirectoryIdentity | null;
}

export interface PilotReference {
  /** Registered snapshot selector (registry payload path) and its digest. */
  snapshotPath: string;
  snapshotSha256: string;
  bootstrapPath: string;
  bootstrapSha256: string;
}

export interface PriorSnapshot {
  schemaVersion: typeof PRIOR_SNAPSHOT_SCHEMA_VERSION;
  kind: "prior-snapshot";
  operationId: string;
  canonicalHome: string;
  instanceId: string;
  configPath: string;
  uid: number;
  mode: OperationRecord["mode"];
  priorProfile: OperationRecord["priorProfile"];
  toolSha256: string;
  hostNodePath: string | null;
  hostNpmPath: string | null;
  capturedAt: string;
  services: SavedService[];
  slots: SavedSlot[];
  reservedSlots: SavedSlot[];
  workerHealthPort: number | null;
  pilot: PilotReference | null;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function slotIdentity(path: string): Promise<DirectoryIdentity | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`artifact slot is not a real directory: ${path}`);
    if (process.getuid?.() !== info.uid) throw new Error(`artifact slot has a foreign owner: ${path}`);
    return { device: info.dev, inode: info.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function backupPath(operation: AcquiredOperation, label: string, role: "effective" | "instance"): string {
  return resolve(
    operation.paths.operationDirectory,
    role === "effective" ? `${label}.plist.original` : `${label}.instance.plist.original`,
  );
}

function savedFile(
  operation: AcquiredOperation,
  label: string,
  role: "effective" | "instance",
  file: CapturedServiceDefinition["plist"],
  effectivePath: string,
): SavedFile {
  if (!file.existed) return { path: file.path, existed: false, backup: null, sha256: null, mode: null };
  // Coincident roles share the effective backup: one file, two recorded roles.
  const backupRole = role === "instance" && file.path === effectivePath ? "effective" : role;
  return {
    path: file.path,
    existed: true,
    backup: backupPath(operation, label, backupRole),
    sha256: sha256(file.bytes!),
    mode: file.mode ?? 0o600,
  };
}

async function writeBackup(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
  } finally {
    await handle.close().catch(() => {});
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

export interface CapturePriorInput {
  operation: AcquiredOperation;
  /** Captured service pair: a `ServiceController.capture` result or a reconstructed pilot snapshot. */
  services: ServiceSnapshot;
  configPath: string;
  workerHealthPort: number | null;
  pilot?: PilotReference | null;
  now?: () => Date;
}

/** Persist the complete prior snapshot before any service or artifact mutation. */
export async function capturePrior(input: CapturePriorInput): Promise<PriorSnapshot> {
  const { operation } = input;
  const home = operation.record.canonicalHome;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("prior snapshot requires a POSIX user ID");
  const prior: PriorSnapshot = {
    schemaVersion: PRIOR_SNAPSHOT_SCHEMA_VERSION,
    kind: "prior-snapshot",
    operationId: operation.record.id,
    canonicalHome: home,
    instanceId: operation.record.instanceId,
    configPath: input.configPath,
    uid,
    mode: operation.record.mode,
    priorProfile: operation.record.priorProfile,
    toolSha256: operation.record.toolSha256,
    hostNodePath: operation.record.hostNodePath ?? null,
    hostNpmPath: operation.record.hostNpmPath ?? null,
    capturedAt: (input.now?.() ?? new Date()).toISOString(),
    services: input.services.services.map((item) => ({
      definition: { ...item.definition, args: [...item.definition.args], overrides: { ...item.definition.overrides } },
      inspection: item.inspection,
      effectivePlist: savedFile(operation, item.definition.label, "effective", item.plist, item.plist.path),
      instancePlist: savedFile(operation, item.definition.label, "instance", item.instancePlist, item.plist.path),
      link: { path: item.link.path, existed: item.link.existed, target: item.link.target ?? null },
      loaded: item.loaded,
      enabled: item.enabled,
    })),
    slots: await Promise.all(
      INSTANCE_SLOT_NAMES.map(async (name) => ({
        name,
        path: resolve(home, name),
        identity: await slotIdentity(resolve(home, name)),
      })),
    ),
    reservedSlots: await Promise.all(
      RESERVED_SLOT_NAMES.map(async (name) => ({
        name,
        path: resolve(operation.paths.operationDirectory, name),
        identity: await slotIdentity(resolve(operation.paths.operationDirectory, name)),
      })),
    ),
    workerHealthPort: input.workerHealthPort,
    pilot: input.pilot ?? null,
  };
  // Seal backups for both plist roles before the snapshot that references them.
  for (const item of input.services.services) {
    for (const [role, file] of [
      ["effective", item.plist],
      ["instance", item.instancePlist],
    ] as const) {
      if (!file.existed || (role === "instance" && file.path === item.plist.path)) continue;
      await writeBackup(backupPath(operation, item.definition.label, role), file.bytes!);
    }
  }
  await writeOperationJson(operation.paths.priorSnapshot, prior);
  return prior;
}

// ── strict decoding ───────────────────────────────────────────────────────

function record(value: unknown, keys: readonly string[], name: string, missing: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const row = value as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(row, key)) missing.push(`${name}.${key}`);
  for (const key of Object.keys(row)) if (!keys.includes(key)) throw new Error(`unexpected field ${name}.${key}`);
  return row;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || /[\0\r\n]/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function abs(value: unknown, name: string): string {
  const out = str(value, name);
  if (!isAbsolute(out)) throw new Error(`${name} must be absolute`);
  return out;
}

function nullableStr(value: unknown, name: string): string | null {
  return value === null ? null : str(value, name);
}

function int(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid ${name}`);
  return value as number;
}

function bool(value: unknown, name: string): boolean {
  if (value !== true && value !== false) throw new Error(`invalid ${name}`);
  return value;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${name}`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`invalid ${name}[${index}]`);
    return item;
  });
}

function decodeDefinition(value: unknown, missing: string[]): ServiceDefinition {
  const o = record(
    value,
    [
      "label",
      "nodePath",
      "entrypoint",
      "args",
      "hiveHome",
      "configPath",
      "home",
      "pathEnv",
      "overrides",
      "stdout",
      "stderr",
    ],
    "definition",
    missing,
  );
  if (missing.length) throw new PriorSnapshotIncompleteError(missing);
  if (!o.overrides || typeof o.overrides !== "object" || Array.isArray(o.overrides)) {
    throw new Error("invalid definition.overrides");
  }
  const overrides = o.overrides as Record<string, unknown>;
  const definition: ServiceDefinition = {
    label: str(o.label, "definition.label"),
    nodePath: abs(o.nodePath, "definition.nodePath"),
    entrypoint: abs(o.entrypoint, "definition.entrypoint"),
    args: strings(o.args, "definition.args"),
    hiveHome: abs(o.hiveHome, "definition.hiveHome"),
    configPath: abs(o.configPath, "definition.configPath"),
    home: abs(o.home, "definition.home"),
    pathEnv: str(o.pathEnv, "definition.pathEnv"),
    overrides: Object.fromEntries(Object.entries(overrides).map(([key, item]) => [key, str(item, key)])),
    stdout: abs(o.stdout, "definition.stdout"),
    stderr: abs(o.stderr, "definition.stderr"),
  };
  buildServiceEnvironment(definition);
  return definition;
}

function decodeFileIdentity(value: unknown, name: string, missing: string[], withTarget: boolean) {
  if (value === null) return null;
  const keys = ["path", "canonicalPath", "dev", "ino", "mode", ...(withTarget ? ["target"] : [])];
  const o = record(value, keys, name, missing);
  return {
    path: abs(o.path, `${name}.path`),
    canonicalPath: abs(o.canonicalPath, `${name}.canonicalPath`),
    dev: int(o.dev, `${name}.dev`),
    ino: int(o.ino, `${name}.ino`),
    mode: int(o.mode, `${name}.mode`),
    ...(withTarget ? { target: str(o.target, `${name}.target`) } : {}),
  };
}

function decodeInspection(value: unknown, missing: string[]): ServiceInspection {
  const o = record(
    value,
    [
      "label",
      "loaded",
      "enabled",
      "livePID",
      "startTime",
      "args",
      "cwd",
      "configSelection",
      "serviceEnvironment",
      "plist",
      "link",
      "process",
    ],
    "inspection",
    missing,
  );
  if (missing.length) throw new PriorSnapshotIncompleteError(missing);
  let processIdentity: ServiceInspection["process"] = null;
  if (o.process !== null) {
    const p = record(
      o.process,
      ["pid", "ppid", "startTime", "command", "executable", "cwd"],
      "inspection.process",
      missing,
    );
    processIdentity = {
      pid: int(p.pid, "process.pid"),
      ppid: int(p.ppid, "process.ppid"),
      startTime: str(p.startTime, "process.startTime"),
      command: str(p.command, "process.command"),
      executable: abs(p.executable, "process.executable"),
      cwd: abs(p.cwd, "process.cwd"),
    };
  }
  let environment: Record<string, string> | null = null;
  if (o.serviceEnvironment !== null) {
    const env = o.serviceEnvironment;
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("invalid inspection.serviceEnvironment");
    environment = Object.fromEntries(
      Object.entries(env as Record<string, unknown>).map(([key, item]) => [key, str(item, key)]),
    );
  }
  const plist = decodeFileIdentity(o.plist, "inspection.plist", missing, false);
  const link = decodeFileIdentity(o.link, "inspection.link", missing, true) as ServiceInspection["link"];
  return {
    label: str(o.label, "inspection.label"),
    loaded: bool(o.loaded, "inspection.loaded"),
    enabled: bool(o.enabled, "inspection.enabled"),
    livePID: o.livePID === null ? null : int(o.livePID, "inspection.livePID"),
    startTime: nullableStr(o.startTime, "inspection.startTime"),
    args: o.args === null ? null : strings(o.args, "inspection.args"),
    cwd: nullableStr(o.cwd, "inspection.cwd"),
    configSelection: nullableStr(o.configSelection, "inspection.configSelection"),
    serviceEnvironment: environment,
    plist,
    link,
    process: processIdentity,
  };
}

function decodeSavedFile(value: unknown, name: string, missing: string[]): SavedFile {
  const o = record(value, ["path", "existed", "backup", "sha256", "mode"], name, missing);
  const existed = bool(o.existed, `${name}.existed`);
  const out: SavedFile = {
    path: abs(o.path, `${name}.path`),
    existed,
    backup: o.backup === null ? null : abs(o.backup, `${name}.backup`),
    sha256: nullableStr(o.sha256, `${name}.sha256`),
    mode: o.mode === null ? null : int(o.mode, `${name}.mode`),
  };
  if (
    existed &&
    (out.backup === null || out.sha256 === null || !/^[a-f0-9]{64}$/.test(out.sha256) || out.mode === null)
  ) {
    throw new Error(`${name} existed without a sealed backup`);
  }
  if (!existed && (out.backup !== null || out.sha256 !== null || out.mode !== null)) {
    throw new Error(`${name} absence carries backup fields`);
  }
  return out;
}

function decodeSlot(value: unknown, name: string, missing: string[]): SavedSlot {
  const o = record(value, ["name", "path", "identity"], name, missing);
  let identity: DirectoryIdentity | null = null;
  if (o.identity !== null) {
    const i = record(o.identity, ["device", "inode"], `${name}.identity`, missing);
    identity = { device: int(i.device, "device"), inode: int(i.inode, "inode") };
  }
  return { name: str(o.name, `${name}.name`), path: abs(o.path, `${name}.path`), identity };
}

export const PRIOR_SNAPSHOT_KEYS = [
  "schemaVersion",
  "kind",
  "operationId",
  "canonicalHome",
  "instanceId",
  "configPath",
  "uid",
  "mode",
  "priorProfile",
  "toolSha256",
  "hostNodePath",
  "hostNpmPath",
  "capturedAt",
  "services",
  "slots",
  "reservedSlots",
  "workerHealthPort",
  "pilot",
] as const;

/** Strictly decode a prior snapshot. An incomplete older record names what is missing. */
export function decodePriorSnapshot(value: unknown): PriorSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PriorSnapshotIncompleteError(["<root>"]);
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== PRIOR_SNAPSHOT_SCHEMA_VERSION) {
    // The S7-prefix schema-1 summary never saved definitions or backups.
    throw new PriorSnapshotIncompleteError(
      PRIOR_SNAPSHOT_KEYS.filter((key) => !Object.hasOwn(row, key) || key === "schemaVersion"),
    );
  }
  const missing: string[] = [];
  const o = record(value, PRIOR_SNAPSHOT_KEYS, "prior", missing);
  if (missing.length) throw new PriorSnapshotIncompleteError(missing);
  if (o.kind !== "prior-snapshot") throw new Error("invalid prior snapshot kind");
  const modes: OperationRecord["mode"][] = [
    "update",
    "check",
    "rollback",
    "start",
    "stop",
    "restart",
    "pilot-rollback",
  ];
  const profiles: OperationRecord["priorProfile"][] = ["packaged", "pilot", "stopped"];
  if (!modes.includes(o.mode as OperationRecord["mode"])) throw new Error("invalid prior snapshot mode");
  if (!profiles.includes(o.priorProfile as OperationRecord["priorProfile"])) throw new Error("invalid prior profile");
  if (!Array.isArray(o.services) || o.services.length > 2) throw new Error("invalid prior services");
  const services = o.services.map((item, index) => {
    const s = record(
      item,
      ["definition", "inspection", "effectivePlist", "instancePlist", "link", "loaded", "enabled"],
      `services[${index}]`,
      missing,
    );
    if (missing.length) throw new PriorSnapshotIncompleteError(missing);
    const definition = decodeDefinition(s.definition, missing);
    const inspection = decodeInspection(s.inspection, missing);
    if (missing.length) throw new PriorSnapshotIncompleteError(missing);
    const link = record(s.link, ["path", "existed", "target"], `services[${index}].link`, missing);
    if (missing.length) throw new PriorSnapshotIncompleteError(missing);
    const saved: SavedService = {
      definition,
      inspection,
      effectivePlist: decodeSavedFile(s.effectivePlist, `services[${index}].effectivePlist`, missing),
      instancePlist: decodeSavedFile(s.instancePlist, `services[${index}].instancePlist`, missing),
      link: {
        path: abs(link.path, "link.path"),
        existed: bool(link.existed, "link.existed"),
        target: nullableStr(link.target, "link.target"),
      },
      loaded: bool(s.loaded, "loaded"),
      enabled: bool(s.enabled, "enabled"),
    };
    if (saved.definition.label !== saved.inspection.label) throw new Error("prior service label mismatch");
    if (saved.link.existed !== (saved.link.target !== null)) throw new Error("prior link target inconsistent");
    if (saved.loaded && saved.inspection.livePID !== null && saved.inspection.process === null) {
      throw new PriorSnapshotIncompleteError([`services[${index}].inspection.process`]);
    }
    return saved;
  });
  if (missing.length) throw new PriorSnapshotIncompleteError(missing);
  if (new Set(services.map((item) => item.definition.label)).size !== services.length) {
    throw new Error("duplicate prior service label");
  }
  const slots = Array.isArray(o.slots)
    ? o.slots.map((item, index) => decodeSlot(item, `slots[${index}]`, missing))
    : [];
  const reservedSlots = Array.isArray(o.reservedSlots)
    ? o.reservedSlots.map((item, index) => decodeSlot(item, `reservedSlots[${index}]`, missing))
    : [];
  if (missing.length) throw new PriorSnapshotIncompleteError(missing);
  if (
    JSON.stringify(slots.map((slot) => slot.name)) !== JSON.stringify(INSTANCE_SLOT_NAMES) ||
    JSON.stringify(reservedSlots.map((slot) => slot.name)) !== JSON.stringify(RESERVED_SLOT_NAMES)
  ) {
    throw new Error("prior snapshot slot inventory is incomplete");
  }
  let pilot: PilotReference | null = null;
  if (o.pilot !== null) {
    const p = record(o.pilot, ["snapshotPath", "snapshotSha256", "bootstrapPath", "bootstrapSha256"], "pilot", missing);
    if (missing.length) throw new PriorSnapshotIncompleteError(missing);
    pilot = {
      snapshotPath: abs(p.snapshotPath, "pilot.snapshotPath"),
      snapshotSha256: str(p.snapshotSha256, "pilot.snapshotSha256"),
      bootstrapPath: abs(p.bootstrapPath, "pilot.bootstrapPath"),
      bootstrapSha256: str(p.bootstrapSha256, "pilot.bootstrapSha256"),
    };
  }
  return {
    schemaVersion: PRIOR_SNAPSHOT_SCHEMA_VERSION,
    kind: "prior-snapshot",
    operationId: str(o.operationId, "operationId"),
    canonicalHome: abs(o.canonicalHome, "canonicalHome"),
    instanceId: str(o.instanceId, "instanceId"),
    configPath: abs(o.configPath, "configPath"),
    uid: int(o.uid, "uid"),
    mode: o.mode as OperationRecord["mode"],
    priorProfile: o.priorProfile as OperationRecord["priorProfile"],
    toolSha256: str(o.toolSha256, "toolSha256"),
    hostNodePath: o.hostNodePath === null ? null : abs(o.hostNodePath, "hostNodePath"),
    hostNpmPath: o.hostNpmPath === null ? null : abs(o.hostNpmPath, "hostNpmPath"),
    capturedAt: str(o.capturedAt, "capturedAt"),
    services,
    slots,
    reservedSlots,
    workerHealthPort: o.workerHealthPort === null ? null : int(o.workerHealthPort, "workerHealthPort"),
    pilot,
  };
}

export interface LoadedPrior {
  prior: PriorSnapshot;
  services: ServiceSnapshot;
}

async function readSealedBackup(file: SavedFile, operationDirectory: string): Promise<Buffer | undefined> {
  if (!file.existed) return undefined;
  const backup = file.backup!;
  if (!inside(operationDirectory, backup)) throw new Error("prior plist backup escapes the operation directory");
  const info = await lstat(backup);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("prior plist backup is not a regular file");
  const bytes = await readFile(backup);
  if (sha256(bytes) !== file.sha256) throw new Error("prior plist backup seal mismatch");
  return bytes;
}

/**
 * Load and reconstruct the prior service snapshot for the recorded operation.
 * Every backup is re-hashed; the operation/instance association must match.
 */
export async function loadPrior(
  record: Pick<OperationRecord, "id" | "canonicalHome" | "instanceId" | "priorSnapshotPath">,
): Promise<LoadedPrior> {
  const operationDirectory = resolve(record.canonicalHome, ".hive-state", "deployment", "operations", record.id);
  if (record.priorSnapshotPath !== resolve(operationDirectory, "prior-snapshot.json")) {
    throw new Error("prior snapshot path does not belong to the recorded operation");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(record.priorSnapshotPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PriorSnapshotIncompleteError(["<file>"]);
    throw error;
  }
  const prior = decodePriorSnapshot(raw);
  if (
    prior.operationId !== record.id ||
    prior.canonicalHome !== record.canonicalHome ||
    prior.instanceId !== record.instanceId ||
    (await realpath(record.canonicalHome)) !== prior.canonicalHome
  ) {
    throw new Error("prior snapshot belongs to another operation or instance");
  }
  const services: CapturedServiceDefinition[] = [];
  for (const saved of prior.services) {
    const effectiveBytes = await readSealedBackup(saved.effectivePlist, operationDirectory);
    const instanceBytes =
      saved.instancePlist.path === saved.effectivePlist.path
        ? effectiveBytes
        : await readSealedBackup(saved.instancePlist, operationDirectory);
    services.push({
      definition: saved.definition,
      inspection: saved.inspection,
      plist: {
        path: saved.effectivePlist.path,
        existed: saved.effectivePlist.existed,
        ...(effectiveBytes ? { bytes: effectiveBytes, mode: saved.effectivePlist.mode ?? 0o600 } : {}),
      },
      instancePlist: {
        path: saved.instancePlist.path,
        existed: saved.instancePlist.existed,
        ...(instanceBytes ? { bytes: instanceBytes, mode: saved.instancePlist.mode ?? 0o600 } : {}),
      },
      link: {
        path: saved.link.path,
        existed: saved.link.existed,
        ...(saved.link.target !== null ? { target: saved.link.target } : {}),
      },
      loaded: saved.loaded,
      enabled: saved.enabled,
    });
  }
  return { prior, services: { services } };
}

export interface RestorePriorHooks {
  /** Fresh engine boot verification for the captured profile, before the worker starts. */
  verifyEngine(engine: ServiceInspection | null): Promise<void>;
}

/** Ordered restoration shared by ordinary recovery and stale reconciliation. */
export async function restorePrior(
  controller: Pick<ServiceController, "restore">,
  loaded: Pick<LoadedPrior, "services">,
  hooks: RestorePriorHooks,
): Promise<void> {
  await controller.restore(loaded.services, { afterEngine: (engine) => hooks.verifyEngine(engine) });
}

export interface PriorProfileVerifiers {
  packaged(loaded: LoadedPrior): Promise<void>;
  pilot(loaded: LoadedPrior): Promise<void>;
  stopped(loaded: LoadedPrior): Promise<void>;
}

/** Verify the restored pair against the captured profile; never the wrong profile. */
export async function verifyPrior(loaded: LoadedPrior, verifiers: PriorProfileVerifiers): Promise<void> {
  switch (loaded.prior.priorProfile) {
    case "packaged":
      return verifiers.packaged(loaded);
    case "pilot":
      return verifiers.pilot(loaded);
    case "stopped":
      return verifiers.stopped(loaded);
  }
}

/** Stopped-profile check: every captured label is unloaded again. */
export async function verifyStoppedPrior(
  controller: Pick<ServiceController, "inspect">,
  loaded: LoadedPrior,
): Promise<void> {
  for (const saved of loaded.prior.services) {
    if (saved.loaded) throw new Error("stopped prior profile recorded a loaded service");
    if ((await controller.inspect(saved.definition.label)).loaded) {
      throw new Error(`stopped prior profile left ${saved.definition.label} loaded`);
    }
  }
}
