/**
 * Locked beta-plugin compatibility preflight (KPR-463 plan chunk 4 Task 9
 * Step 1b). Ports `src/cli/update-preflight.ts`'s `relocateBetaPlugins` into
 * the deployment helper with explicit instance/operation inputs.
 *
 * Only `<home>/.hive/plugins/node_modules/<entry>` may move, and only to the
 * absent `<home>/plugins/node_modules/<entry>`. One level is enumerated (an npm
 * scope directory is one entry). Symlinks, special nodes, foreign owners and
 * foreign-writable ancestors are rejected. An existing destination is never
 * overwritten or merged: both are preserved and `destination-exists` recorded.
 *
 * Every move is journaled in `<operation>/plugin-compat.json` with an
 * intended/observed fence before and after the rename, separately from the
 * operation's artifact-move fence. A partial failure reverses completed renames
 * in reverse order only when the exact identity is still at the destination and
 * the source is absent; anything else is unresolved. After every rename
 * succeeds `compatibility-committed` is persisted, which survives a later
 * deployment failure. Runs no npm, syncs no skills and follows no config.
 *
 * Builtin-only apart from `operation.ts` and the logger.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../logging/logger.js";
import { writeOperationJson, type AcquiredOperation } from "./operation.js";

const log = createLogger("deployment-plugin-compat");

export const PLUGIN_COMPATIBILITY_PENDING = "PLUGIN_COMPATIBILITY_PENDING";
export const PLUGIN_COMPAT_RECORD = "plugin-compat.json";
const MAX_ENTRIES = 4096;
const MAX_TREE_NODES = 1_000_000;

export class PluginCompatibilityPendingError extends Error {
  readonly code = PLUGIN_COMPATIBILITY_PENDING;
}
export class PluginCompatibilityUnresolvedError extends Error {}

export interface PluginNodeIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  kind: "directory" | "file";
}

export interface PluginCompatEntry {
  name: string;
  source: string;
  destination: string;
  identity: PluginNodeIdentity;
  beforeSha256: string;
  state: "planned" | "intended" | "observed" | "reversed" | "destination-exists";
  afterSha256: string | null;
}

export interface CreatedDirectory {
  path: string;
  mode: number;
  identity: { dev: number; ino: number } | null;
  state: "intended" | "observed";
}

export interface PluginCompatRecord {
  schemaVersion: 1;
  operationId: string;
  canonicalHome: string;
  phase: "planned" | "relocating" | "compatibility-committed" | "reversed" | "unresolved";
  createdDirectories: CreatedDirectory[];
  entries: PluginCompatEntry[];
}

export interface PluginCompatPlan {
  sourceRoot: string;
  destinationRoot: string;
  relocate: { name: string; source: string; destination: string; beforeSha256: string }[];
  destinationExists: string[];
}

/** Filesystem boundary; injected only to exercise crash and race fences in tests. */
export interface PluginCompatIO {
  lstat(path: string): Promise<{
    dev: number;
    ino: number;
    uid: number;
    mode: number;
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  mkdir(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  getuid(): number;
  persist(path: string, value: unknown): Promise<void>;
}

export const nodePluginCompatIO: PluginCompatIO = {
  lstat,
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
  async mkdir(path, mode) {
    await mkdir(path, { mode });
  },
  rename,
  async fsyncDirectory(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  getuid() {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("plugin compatibility requires a POSIX user ID");
    return uid;
  },
  persist: writeOperationJson,
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

async function exists(io: PluginCompatIO, path: string): Promise<boolean> {
  try {
    await io.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** A same-UID, non-symlinked directory with no group/world write bit. */
async function ownedDirectory(io: PluginCompatIO, path: string): Promise<{ dev: number; ino: number; mode: number }> {
  const info = await io.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: not a real directory: ${path}`);
  }
  if (info.uid !== io.getuid()) {
    throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: foreign owner: ${path}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: foreign-writable: ${path}`);
  }
  return { dev: info.dev, ino: info.ino, mode: info.mode & 0o777 };
}

function validEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 214 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !/[\0\r\n]/.test(name)
  );
}

/**
 * Deterministic digest of one entry: sorted relative paths, node kind, mode and
 * file bytes. Symlinks, special nodes and foreign owners fail closed.
 */
export async function pluginTreeDigest(io: PluginCompatIO, root: string): Promise<string> {
  const hash = createHash("sha256");
  let nodes = 0;
  const uid = io.getuid();
  const visit = async (path: string, relativePath: string): Promise<void> => {
    nodes += 1;
    if (nodes > MAX_TREE_NODES) throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: too large`);
    const info = await io.lstat(path);
    if (info.isSymbolicLink()) {
      throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: symbolic link: ${relativePath}`);
    }
    if (info.uid !== uid) {
      throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: foreign owner: ${relativePath}`);
    }
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isDirectory()) {
      hash.update(`d\0${relativePath}\0${mode}\n`);
      const names = (await io.readdir(path)).sort();
      for (const name of names) await visit(resolve(path, name), relativePath ? `${relativePath}/${name}` : name);
      return;
    }
    if (!info.isFile()) {
      throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: special node: ${relativePath}`);
    }
    const bytes = await io.readFile(path);
    hash.update(`f\0${relativePath}\0${mode}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  };
  await visit(root, "");
  return hash.digest("hex");
}

function roots(canonicalHome: string) {
  return {
    engine: resolve(canonicalHome, ".hive"),
    enginePlugins: resolve(canonicalHome, ".hive", "plugins"),
    sourceRoot: resolve(canonicalHome, ".hive", "plugins", "node_modules"),
    plugins: resolve(canonicalHome, "plugins"),
    destinationRoot: resolve(canonicalHome, "plugins", "node_modules"),
  };
}

/** Read-only plan. Dry-run uses this; it never creates, moves or journals. */
export async function planBetaPluginCompatibility(
  canonicalHome: string,
  io: PluginCompatIO = nodePluginCompatIO,
): Promise<PluginCompatPlan> {
  const r = roots(canonicalHome);
  const plan: PluginCompatPlan = {
    sourceRoot: r.sourceRoot,
    destinationRoot: r.destinationRoot,
    relocate: [],
    destinationExists: [],
  };
  if (!(await exists(io, r.sourceRoot))) return plan;
  await ownedDirectory(io, canonicalHome);
  await ownedDirectory(io, r.engine);
  await ownedDirectory(io, r.enginePlugins);
  await ownedDirectory(io, r.sourceRoot);
  const names = (await io.readdir(r.sourceRoot)).sort();
  if (names.length > MAX_ENTRIES)
    throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: too many`);
  if (names.length === 0) return plan;
  for (const directory of [r.plugins, r.destinationRoot]) {
    if (await exists(io, directory)) await ownedDirectory(io, directory);
  }
  for (const name of names) {
    if (!validEntryName(name)) {
      throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: unsafe entry name`);
    }
    const source = resolve(r.sourceRoot, name);
    const destination = resolve(r.destinationRoot, name);
    const beforeSha256 = await pluginTreeDigest(io, source);
    if (await exists(io, destination)) plan.destinationExists.push(name);
    else plan.relocate.push({ name, source, destination, beforeSha256 });
  }
  return plan;
}

async function requireLockOwnership(operation: AcquiredOperation, io: PluginCompatIO): Promise<void> {
  let owner: { id?: unknown };
  try {
    owner = JSON.parse((await io.readFile(resolve(operation.paths.lockDirectory, "owner.json"))).toString("utf8"));
  } catch (error) {
    throw new PluginCompatibilityUnresolvedError("plugin compatibility requires the instance operation lock", {
      cause: error,
    });
  }
  if (owner.id !== operation.record.id) {
    throw new PluginCompatibilityUnresolvedError("plugin compatibility requires this operation's lock");
  }
}

function recordPath(operation: AcquiredOperation): string {
  return resolve(operation.paths.operationDirectory, PLUGIN_COMPAT_RECORD);
}

async function nodeIdentity(io: PluginCompatIO, path: string): Promise<PluginNodeIdentity> {
  const info = await io.lstat(path);
  if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
    throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: unsupported node`);
  }
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode & 0o7777,
    kind: info.isDirectory() ? "directory" : "file",
  };
}

async function sameNode(io: PluginCompatIO, path: string, identity: PluginNodeIdentity): Promise<boolean> {
  try {
    const current = await nodeIdentity(io, path);
    return current.dev === identity.dev && current.ino === identity.ino && current.kind === identity.kind;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Reverse completed renames in reverse order; never overwrite an occupied or changed source. */
async function reverseCompleted(
  record: PluginCompatRecord,
  io: PluginCompatIO,
  persist: () => Promise<void>,
): Promise<void> {
  let unresolved = false;
  for (const entry of [...record.entries].reverse()) {
    if (entry.state !== "intended" && entry.state !== "observed") continue;
    const atSource = await sameNode(io, entry.source, entry.identity);
    const atDestination = await sameNode(io, entry.destination, entry.identity);
    if (atSource && !atDestination) {
      // Intended but the rename never happened.
      entry.state = "planned";
      await persist();
      continue;
    }
    if (atDestination && !atSource && !(await exists(io, entry.source))) {
      await io.rename(entry.destination, entry.source);
      if (!(await sameNode(io, entry.source, entry.identity))) {
        unresolved = true;
        continue;
      }
      entry.state = "reversed";
      await persist();
      continue;
    }
    unresolved = true;
  }
  record.phase = unresolved ? "unresolved" : "reversed";
  await persist();
  if (unresolved) {
    throw new PluginCompatibilityUnresolvedError("beta plugin relocation could not be reversed safely; retained");
  }
}

export interface ApplyPluginCompatOptions {
  operation: AcquiredOperation;
  io?: PluginCompatIO;
}

export interface PluginCompatResult {
  record: PluginCompatRecord | null;
  moved: string[];
  destinationExists: string[];
}

/**
 * Locked relocation, executed after lock/ownership and migration eligibility
 * checks and before candidate staging. Idempotent: a committed record for this
 * operation returns without moving anything again.
 */
export async function applyBetaPluginCompatibility(options: ApplyPluginCompatOptions): Promise<PluginCompatResult> {
  const io = options.io ?? nodePluginCompatIO;
  const { operation } = options;
  await requireLockOwnership(operation, io);
  const home = operation.record.canonicalHome;
  const path = recordPath(operation);
  if (await exists(io, path)) {
    const existing = decodePluginCompatRecord(JSON.parse((await io.readFile(path)).toString("utf8")));
    if (existing.operationId !== operation.record.id) throw new PluginCompatibilityUnresolvedError("foreign record");
    if (existing.phase === "compatibility-committed") {
      return {
        record: existing,
        moved: existing.entries.filter((entry) => entry.state === "observed").map((entry) => entry.name),
        destinationExists: existing.entries
          .filter((entry) => entry.state === "destination-exists")
          .map((entry) => entry.name),
      };
    }
    throw new PluginCompatibilityUnresolvedError("an uncommitted plugin compatibility record requires reconciliation");
  }
  const plan = await planBetaPluginCompatibility(home, io);
  if (plan.relocate.length === 0 && plan.destinationExists.length === 0) {
    return { record: null, moved: [], destinationExists: [] };
  }
  const r = roots(home);
  const record: PluginCompatRecord = {
    schemaVersion: 1,
    operationId: operation.record.id,
    canonicalHome: home,
    phase: "planned",
    createdDirectories: [],
    entries: [],
  };
  for (const name of plan.destinationExists) {
    const source = resolve(r.sourceRoot, name);
    record.entries.push({
      name,
      source,
      destination: resolve(r.destinationRoot, name),
      identity: await nodeIdentity(io, source),
      beforeSha256: await pluginTreeDigest(io, source),
      state: "destination-exists",
      afterSha256: null,
    });
  }
  for (const item of plan.relocate) {
    record.entries.push({
      ...item,
      identity: await nodeIdentity(io, item.source),
      state: "planned",
      afterSha256: null,
    });
  }
  const persist = () => io.persist(path, record);
  // Durable before any directory creation or rename.
  await persist();
  if (plan.relocate.length === 0) {
    record.phase = "compatibility-committed";
    await persist();
    return { record, moved: [], destinationExists: plan.destinationExists };
  }
  record.phase = "relocating";
  await persist();
  const moved: string[] = [];
  try {
    const homeMode = (await ownedDirectory(io, home)).mode;
    for (const directory of [r.plugins, r.destinationRoot]) {
      if (await exists(io, directory)) {
        await ownedDirectory(io, directory);
        continue;
      }
      const created: CreatedDirectory = { path: directory, mode: homeMode & 0o755, identity: null, state: "intended" };
      record.createdDirectories.push(created);
      await persist();
      await io.mkdir(directory, created.mode);
      await io.fsyncDirectory(resolve(directory, ".."));
      const identity = await ownedDirectory(io, directory);
      created.identity = { dev: identity.dev, ino: identity.ino };
      created.state = "observed";
      await persist();
    }
    for (const entry of record.entries) {
      if (entry.state !== "planned") continue;
      entry.state = "intended";
      await persist();
      // Revalidate both paths immediately before rename.
      if (!(await sameNode(io, entry.source, entry.identity))) throw new Error("source identity changed");
      if ((await pluginTreeDigest(io, entry.source)) !== entry.beforeSha256) throw new Error("source content changed");
      if (await exists(io, entry.destination)) throw new Error("destination became occupied");
      await io.rename(entry.source, entry.destination);
      await io.fsyncDirectory(r.destinationRoot);
      await io.fsyncDirectory(r.sourceRoot);
      if (!(await sameNode(io, entry.destination, entry.identity))) {
        throw new PluginCompatibilityUnresolvedError("relocated plugin identity could not be observed");
      }
      entry.state = "observed";
      await persist();
      moved.push(entry.name);
    }
    for (const entry of record.entries) {
      if (entry.state === "observed") entry.afterSha256 = await pluginTreeDigest(io, entry.destination);
    }
    record.phase = "compatibility-committed";
    await persist();
  } catch (error) {
    log.warn("Beta plugin relocation failed; reversing completed renames", { moved: moved.length });
    await reverseCompleted(record, io, persist);
    throw new PluginCompatibilityPendingError(`${PLUGIN_COMPATIBILITY_PENDING}: relocation reversed`, {
      cause: error,
    });
  }
  log.info("Beta plugin compatibility committed", {
    moved: moved.length,
    destinationExists: plan.destinationExists.length,
  });
  return { record, moved, destinationExists: plan.destinationExists };
}

/**
 * Interrupted-operation reconciliation using the same list and algorithm. A
 * committed relocation is left as the durable compatibility action; an
 * uncommitted partial list is reversed or retained unresolved.
 */
export async function reconcileBetaPluginCompatibility(
  operation: AcquiredOperation,
  io: PluginCompatIO = nodePluginCompatIO,
): Promise<PluginCompatRecord["phase"] | "absent"> {
  const path = recordPath(operation);
  if (!(await exists(io, path))) return "absent";
  const record = decodePluginCompatRecord(JSON.parse((await io.readFile(path)).toString("utf8")));
  if (record.operationId !== operation.record.id || record.canonicalHome !== operation.record.canonicalHome) {
    throw new PluginCompatibilityUnresolvedError("plugin compatibility record belongs to another operation");
  }
  if (record.phase === "compatibility-committed" || record.phase === "reversed") return record.phase;
  if (record.phase === "unresolved") {
    throw new PluginCompatibilityUnresolvedError("plugin compatibility record is unresolved; retained");
  }
  await reverseCompleted(record, io, () => io.persist(path, record));
  return record.phase;
}

// ── strict decoding ───────────────────────────────────────────────────────

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) {
    throw new Error("unexpected plugin compatibility record fields");
  }
  return row;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error("invalid string");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid integer");
  return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("invalid enum");
  return value as T;
}

export function decodePluginCompatRecord(value: unknown): PluginCompatRecord {
  const o = exact(value, ["schemaVersion", "operationId", "canonicalHome", "phase", "createdDirectories", "entries"]);
  if (o.schemaVersion !== 1) throw new Error("unsupported plugin compatibility schema");
  if (!Array.isArray(o.createdDirectories) || !Array.isArray(o.entries)) throw new Error("invalid arrays");
  const home = text(o.canonicalHome);
  const r = roots(home);
  const entries = o.entries.map((item): PluginCompatEntry => {
    const e = exact(item, ["name", "source", "destination", "identity", "beforeSha256", "state", "afterSha256"]);
    const name = text(e.name);
    if (!validEntryName(name)) throw new Error("unsafe plugin entry name");
    if (e.source !== resolve(r.sourceRoot, name) || e.destination !== resolve(r.destinationRoot, name)) {
      throw new Error("plugin compatibility paths are outside the eligible roots");
    }
    const i = exact(e.identity, ["dev", "ino", "uid", "mode", "kind"]);
    const digest = text(e.beforeSha256);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid digest");
    if (e.afterSha256 !== null && !/^[a-f0-9]{64}$/.test(text(e.afterSha256))) throw new Error("invalid digest");
    return {
      name,
      source: e.source as string,
      destination: e.destination as string,
      identity: {
        dev: integer(i.dev),
        ino: integer(i.ino),
        uid: integer(i.uid),
        mode: integer(i.mode),
        kind: oneOf(i.kind, ["directory", "file"]),
      },
      beforeSha256: digest,
      state: oneOf(e.state, ["planned", "intended", "observed", "reversed", "destination-exists"]),
      afterSha256: e.afterSha256 as string | null,
    };
  });
  const createdDirectories = o.createdDirectories.map((item): CreatedDirectory => {
    const c = exact(item, ["path", "mode", "identity", "state"]);
    if (c.path !== r.plugins && c.path !== r.destinationRoot) throw new Error("created directory is not eligible");
    let identity: CreatedDirectory["identity"] = null;
    if (c.identity !== null) {
      const i = exact(c.identity, ["dev", "ino"]);
      identity = { dev: integer(i.dev), ino: integer(i.ino) };
    }
    return { path: c.path as string, mode: integer(c.mode), identity, state: oneOf(c.state, ["intended", "observed"]) };
  });
  return {
    schemaVersion: 1,
    operationId: text(o.operationId),
    canonicalHome: home,
    phase: oneOf(o.phase, ["planned", "relocating", "compatibility-committed", "reversed", "unresolved"]),
    createdDirectories,
    entries,
  };
}
