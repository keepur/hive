import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLogger } from "../logging/logger.js";
import { AdmissionLedger, type AdmissionSnapshot, type SupervisorRef } from "./admission.js";

export type MaintenanceCommand = {
  protocol: 1;
  requestId: string;
  operationId: string;
  supervisor: SupervisorRef;
  kind: "close" | "release" | "status";
};

export type JobEvent = {
  protocol: 1;
  eventId: string;
  supervisor: SupervisorRef;
  jobId: string;
  childPid: number;
  sequence: 1 | 2;
  kind: "entered" | "completed";
};

export interface MaintenanceReply {
  protocol: 1;
  requestId: string;
  operationId: string;
  supervisor: SupervisorRef;
  ok: boolean;
  classification?: string;
  snapshot: AdmissionSnapshot;
  writtenAt: number;
}

export interface CurrentSupervisor {
  protocol: 1;
  supervisor: SupervisorRef;
  bootedAt: number;
  writtenAt: number;
  stateDirectory: string;
  sdkHost: string;
  sdkPort: number;
  instanceId: string;
}

interface SnapshotRecord {
  protocol: 1;
  supervisor: SupervisorRef;
  snapshot: AdmissionSnapshot;
  writtenAt: number;
}

interface CommandReceipt {
  protocol: 1;
  command: MaintenanceCommand;
  outcome: "applied" | "rejected";
  classification?: string;
  writtenAt: number;
}

interface EventReceipt {
  protocol: 1;
  event: JobEvent;
  outcome: "applied";
  writtenAt: number;
}

interface FinalizedMarker {
  protocol: 1;
  operationId: string;
  supervisor: SupervisorRef;
  writtenAt: number;
}

const MAX_MESSAGE_BYTES = 16 * 1024;
const SNAPSHOT_BYTES = 12 * 1024;
const POLL_INTERVAL_MS = 50;
const LIVENESS_INTERVAL_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const logger = createLogger("voice-maintenance-ipc");

export interface MailboxFileSystem {
  chmodSync(path: string, mode: number): void;
  closeSync(fd: number): void;
  fsyncSync(fd: number): void;
  lstatSync(path: string): Stats;
  mkdirSync(path: string, options: { mode: number }): void;
  openSync(path: string, flags: number | string, mode?: number): number;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  realpathSync(path: string): string;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  writeFileSync(fd: number, data: string): void;
  randomUUID(): string;
  getuid(): number;
}

export const nodeMailboxFileSystem: MailboxFileSystem = {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync(path, options) {
    mkdirSync(path, options);
  },
  openSync,
  readdirSync(path) {
    return readdirSync(path);
  },
  readFileSync(path) {
    return readFileSync(path);
  },
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  randomUUID,
  getuid() {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("voice maintenance IPC requires a POSIX user ID");
    return uid;
  },
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function serialize(value: unknown, budget = MAX_MESSAGE_BYTES): string {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > budget) throw new Error("voice maintenance message exceeds size limit");
  return encoded;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`invalid ${label}`);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isSupervisorRef(value: unknown): value is SupervisorRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<SupervisorRef>;
  return (
    hasOnlyKeys(value, ["pid", "bootId"]) &&
    Number.isSafeInteger(ref.pid) &&
    (ref.pid ?? 0) > 1 &&
    typeof ref.bootId === "string" &&
    UUID.test(ref.bootId)
  );
}

function sameSupervisor(left: SupervisorRef, right: SupervisorRef): boolean {
  return left.pid === right.pid && left.bootId === right.bootId;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function fsyncDirectory(path: string, fs: MailboxFileSystem): void {
  let fd: number | undefined;
  const errors: unknown[] = [];
  try {
    fd = fs.openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch (error) {
    errors.push(error);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "directory fsync failed");
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const errors: unknown[] = [];
  let fd: number | undefined;
  let directoryFd: number | undefined;
  let tempCreated = false;
  let renamed = false;
  try {
    directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    fd = openSync(temp, "wx", 0o600);
    tempCreated = true;
    writeFileSync(fd, serialize(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    renamed = true;
    fsyncSync(directoryFd);
  } catch (error) {
    errors.push(error);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    }
    if (tempCreated && !renamed) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (!isMissing(error)) errors.push(error);
      }
    }
    if (directoryFd !== undefined) {
      try {
        closeSync(directoryFd);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "atomic state write failed");
}

export function writeJsonAtomicWithFileSystem(path: string, value: unknown, fs: MailboxFileSystem): void {
  const encoded = serialize(value);
  const tempId = fs.randomUUID();
  assertUuid(tempId, "atomic temporary ID");
  const temp = `${path}.${tempId}.tmp`;
  const errors: unknown[] = [];
  let fd: number | undefined;
  let directoryFd: number | undefined;
  let tempCreated = false;
  let renamed = false;
  try {
    directoryFd = fs.openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    fd = fs.openSync(temp, "wx", 0o600);
    tempCreated = true;
    fs.writeFileSync(fd, encoded);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, path);
    renamed = true;
    fs.fsyncSync(directoryFd);
  } catch (error) {
    errors.push(error);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    }
    if (tempCreated && !renamed) {
      try {
        fs.unlinkSync(temp);
      } catch (error) {
        if (!isMissing(error)) errors.push(error);
      }
    }
    if (directoryFd !== undefined) {
      try {
        fs.closeSync(directoryFd);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "atomic state write failed");
}

function assertDirectory(path: string, realRoot: string, fs: MailboxFileSystem): string {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("voice maintenance state directory is not private");
  if (stat.uid !== fs.getuid()) throw new Error("voice maintenance state has wrong owner");
  if ((stat.mode & 0o777) !== 0o700) throw new Error("voice maintenance state has wrong permissions");
  const canonical = fs.realpathSync(path);
  if (!isInside(realRoot, canonical)) throw new Error("voice maintenance state escaped instance root");
  return canonical;
}

function ensureDirectory(path: string, realRoot: string, fs: MailboxFileSystem): string {
  try {
    assertDirectory(path, realRoot, fs);
  } catch (error) {
    if (!isMissing(error)) throw error;
    fs.mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(dirname(path), fs);
  }
  fs.chmodSync(path, 0o700);
  return assertDirectory(path, realRoot, fs);
}

function assertMessageFile(path: string, realRoot: string, fs: MailboxFileSystem): Stats {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("voice maintenance message is not a regular file");
  if (stat.uid !== fs.getuid()) throw new Error("voice maintenance message has wrong owner");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("voice maintenance message has wrong permissions");
  if (stat.size > MAX_MESSAGE_BYTES) throw new Error("voice maintenance message exceeds size limit");
  const canonical = fs.realpathSync(path);
  if (!isInside(realRoot, canonical)) throw new Error("voice maintenance message escaped instance root");
  return stat;
}

function readJson(path: string, realRoot: string, fs: MailboxFileSystem): unknown {
  assertMessageFile(path, realRoot, fs);
  const bytes = fs.readFileSync(path);
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("voice maintenance message exceeds size limit");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function readOptionalJson(path: string, realRoot: string, fs: MailboxFileSystem): unknown | undefined {
  try {
    return readJson(path, realRoot, fs);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function writeImmutable(path: string, value: unknown, realRoot: string, fs: MailboxFileSystem): void {
  const existing = readOptionalJson(path, realRoot, fs);
  if (existing !== undefined) {
    if (!sameValue(existing, value)) throw new Error("conflicting immutable voice maintenance record");
    fsyncDirectory(dirname(path), fs);
    return;
  }
  writeJsonAtomicWithFileSystem(path, value, fs);
}

function unlinkDurable(path: string, fs: MailboxFileSystem): void {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  fsyncDirectory(dirname(path), fs);
}

function parseCommand(value: unknown, filename: string, supervisor: SupervisorRef): MaintenanceCommand {
  if (!value || typeof value !== "object") throw new Error("invalid maintenance command");
  const command = value as Partial<MaintenanceCommand>;
  assertUuid(command.requestId, "request ID");
  assertUuid(command.operationId, "operation ID");
  if (filename !== `${command.requestId}.json`) throw new Error("request filename mismatch");
  if (
    command.protocol !== 1 ||
    !isSupervisorRef(command.supervisor) ||
    !sameSupervisor(command.supervisor, supervisor)
  ) {
    throw new Error("maintenance command supervisor mismatch");
  }
  if (command.kind !== "close" && command.kind !== "release" && command.kind !== "status") {
    throw new Error("unknown maintenance command");
  }
  const allowed = ["protocol", "requestId", "operationId", "supervisor", "kind"];
  if (Object.keys(command).some((key) => !allowed.includes(key))) throw new Error("invalid maintenance command fields");
  return command as MaintenanceCommand;
}

function parseJobEvent(value: unknown, filename: string, supervisor: SupervisorRef): JobEvent {
  if (!value || typeof value !== "object") throw new Error("invalid voice job event");
  const event = value as Partial<JobEvent>;
  assertUuid(event.eventId, "event ID");
  if (filename !== `${event.eventId}.json`) throw new Error("event filename mismatch");
  if (event.protocol !== 1 || !isSupervisorRef(event.supervisor) || !sameSupervisor(event.supervisor, supervisor)) {
    throw new Error("job event supervisor mismatch");
  }
  if (
    typeof event.jobId !== "string" ||
    event.jobId.length < 1 ||
    event.jobId.length > 512 ||
    event.jobId.includes("\0")
  ) {
    throw new Error("invalid job ID");
  }
  if (!Number.isSafeInteger(event.childPid) || (event.childPid ?? 0) <= 1) throw new Error("invalid child PID");
  if (
    (event.kind === "entered" && event.sequence !== 1) ||
    (event.kind === "completed" && event.sequence !== 2) ||
    (event.kind !== "entered" && event.kind !== "completed")
  ) {
    throw new Error("invalid job event sequence");
  }
  const allowed = ["protocol", "eventId", "supervisor", "jobId", "childPid", "sequence", "kind"];
  if (Object.keys(event).some((key) => !allowed.includes(key))) throw new Error("invalid job event fields");
  return event as JobEvent;
}

function isAdmissionSnapshot(value: unknown): value is AdmissionSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<AdmissionSnapshot>;
  if (
    !hasOnlyKeys(value, ["supervisor", "operationId", "admission", "persistenceFault", "unresolved", "childPids"]) ||
    !isSupervisorRef(snapshot.supervisor) ||
    (snapshot.operationId !== null && (typeof snapshot.operationId !== "string" || !UUID.test(snapshot.operationId))) ||
    (snapshot.admission !== "open" && snapshot.admission !== "closed") ||
    typeof snapshot.persistenceFault !== "boolean" ||
    !Array.isArray(snapshot.unresolved) ||
    !Array.isArray(snapshot.childPids)
  ) {
    return false;
  }
  if ((snapshot.admission === "open") !== (snapshot.operationId === null && !snapshot.persistenceFault)) return false;
  const jobIds = new Set<string>();
  for (const value of snapshot.unresolved) {
    if (!value || typeof value !== "object") return false;
    const job = value as AdmissionSnapshot["unresolved"][number];
    if (
      !hasOnlyKeys(value, ["jobId", "acceptedAt", "phase", "childPid"]) ||
      typeof job.jobId !== "string" ||
      job.jobId.length < 1 ||
      job.jobId.length > 512 ||
      !Number.isFinite(job.acceptedAt) ||
      (job.phase !== "accepted-awaiting-entry" && job.phase !== "entered-awaiting-completion") ||
      (job.childPid !== undefined && (!Number.isSafeInteger(job.childPid) || job.childPid <= 1)) ||
      (job.phase === "entered-awaiting-completion" && job.childPid === undefined) ||
      jobIds.has(job.jobId)
    ) {
      return false;
    }
    jobIds.add(job.jobId);
  }
  return (
    snapshot.childPids.every((pid) => Number.isSafeInteger(pid) && pid > 1) &&
    new Set(snapshot.childPids).size === snapshot.childPids.length
  );
}

function parseReply(value: unknown): MaintenanceReply {
  if (!value || typeof value !== "object") throw new Error("invalid maintenance reply");
  const reply = value as Partial<MaintenanceReply>;
  if (
    !hasOnlyKeys(value, [
      "protocol",
      "requestId",
      "operationId",
      "supervisor",
      "ok",
      "classification",
      "snapshot",
      "writtenAt",
    ]) ||
    reply.protocol !== 1 ||
    typeof reply.requestId !== "string" ||
    !UUID.test(reply.requestId) ||
    typeof reply.operationId !== "string" ||
    !UUID.test(reply.operationId) ||
    !isSupervisorRef(reply.supervisor) ||
    typeof reply.ok !== "boolean" ||
    (reply.classification !== undefined && typeof reply.classification !== "string") ||
    !isAdmissionSnapshot(reply.snapshot) ||
    typeof reply.writtenAt !== "number" ||
    !Number.isFinite(reply.writtenAt)
  ) {
    throw new Error("invalid maintenance reply");
  }
  return reply as MaintenanceReply;
}

function classify(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  if (message.includes("operation-finalized")) return "operation-finalized";
  if (message.includes("owned by another")) return "owner-conflict";
  if (message.includes("supervisor mismatch")) return "supervisor-mismatch";
  if (message.includes("finalized operation marker")) return "persistence-failure";
  if (message.includes("persistence") || message.includes("atomic") || message.includes("fsync")) {
    return "persistence-failure";
  }
  return "invalid-request";
}

export interface FinalizedOperations {
  has(operationId: string): boolean;
  finalize(operationId: string, supervisor: SupervisorRef): void;
}

export function applyMaintenance(
  command: MaintenanceCommand,
  ledger: AdmissionLedger,
  finalized: FinalizedOperations,
): AdmissionSnapshot {
  const snapshot = ledger.snapshot();
  if (!sameSupervisor(snapshot.supervisor, command.supervisor)) throw new Error("supervisor mismatch");
  switch (command.kind) {
    case "close":
      if (finalized.has(command.operationId)) throw new Error("operation-finalized");
      return ledger.close(command.operationId);
    case "release":
      if (finalized.has(command.operationId) && snapshot.operationId === null && !snapshot.persistenceFault) {
        finalized.finalize(command.operationId, command.supervisor);
        return ledger.refresh();
      }
      return ledger.release(command.operationId, () => finalized.finalize(command.operationId, command.supervisor));
    case "status":
      if (snapshot.operationId !== null && snapshot.operationId !== command.operationId) {
        throw new Error("maintenance owned by another operation");
      }
      return ledger.refresh();
  }
}

interface MailboxLayout {
  realHome: string;
  stateRoot: string;
  voiceRoot: string;
  bootRoot: string;
  commands: string;
  replies: string;
  commandReceipts: string;
  eventReceipts: string;
  finalized: string;
  jobs: string;
  snapshot: string;
  current: string;
}

function createLayout(instanceHome: string, bootId: string, fs: MailboxFileSystem): MailboxLayout {
  if (!isAbsolute(instanceHome)) throw new Error("instance home must be absolute");
  assertUuid(bootId, "boot ID");
  const realHome = fs.realpathSync(instanceHome);
  const stateRoot = ensureDirectory(join(realHome, ".hive-state"), realHome, fs);
  const voiceRoot = ensureDirectory(join(stateRoot, "voice-worker"), realHome, fs);
  const bootRoot = ensureDirectory(join(voiceRoot, bootId), realHome, fs);
  const commands = ensureDirectory(join(bootRoot, "commands"), realHome, fs);
  const replies = ensureDirectory(join(bootRoot, "replies"), realHome, fs);
  const commandReceipts = ensureDirectory(join(bootRoot, "command-receipts"), realHome, fs);
  const eventReceipts = ensureDirectory(join(bootRoot, "event-receipts"), realHome, fs);
  const finalized = ensureDirectory(join(bootRoot, "finalized"), realHome, fs);
  const jobs = ensureDirectory(join(bootRoot, "jobs"), realHome, fs);
  return {
    realHome,
    stateRoot,
    voiceRoot,
    bootRoot,
    commands,
    replies,
    commandReceipts,
    eventReceipts,
    finalized,
    jobs,
    snapshot: join(bootRoot, "snapshot.json"),
    current: join(voiceRoot, "current.json"),
  };
}

function openLayout(instanceHome: string, bootId: string, fs: MailboxFileSystem): MailboxLayout {
  if (!isAbsolute(instanceHome)) throw new Error("instance home must be absolute");
  assertUuid(bootId, "boot ID");
  const realHome = fs.realpathSync(instanceHome);
  const stateRoot = assertDirectory(join(realHome, ".hive-state"), realHome, fs);
  const voiceRoot = assertDirectory(join(stateRoot, "voice-worker"), realHome, fs);
  const bootRoot = assertDirectory(join(voiceRoot, bootId), realHome, fs);
  return {
    realHome,
    stateRoot,
    voiceRoot,
    bootRoot,
    commands: assertDirectory(join(bootRoot, "commands"), realHome, fs),
    replies: assertDirectory(join(bootRoot, "replies"), realHome, fs),
    commandReceipts: assertDirectory(join(bootRoot, "command-receipts"), realHome, fs),
    eventReceipts: assertDirectory(join(bootRoot, "event-receipts"), realHome, fs),
    finalized: assertDirectory(join(bootRoot, "finalized"), realHome, fs),
    jobs: assertDirectory(join(bootRoot, "jobs"), realHome, fs),
    snapshot: join(bootRoot, "snapshot.json"),
    current: join(voiceRoot, "current.json"),
  };
}

function createFinalizedOperations(
  layout: MailboxLayout,
  expectedSupervisor: SupervisorRef,
  now: () => number,
  fs: MailboxFileSystem,
): FinalizedOperations {
  const markerFor = (operationId: string): string => {
    assertUuid(operationId, "operation ID");
    return join(layout.finalized, `${operationId}.json`);
  };
  const readMarker = (operationId: string): unknown | undefined => {
    try {
      return readOptionalJson(markerFor(operationId), layout.realHome, fs);
    } catch (error) {
      throw new Error("finalized operation marker unreadable", { cause: error });
    }
  };
  return {
    has(operationId) {
      assertDirectory(layout.finalized, layout.realHome, fs);
      const value = readMarker(operationId);
      if (value === undefined) return false;
      const marker = value as Partial<FinalizedMarker>;
      if (
        !hasOnlyKeys(value as object, ["protocol", "operationId", "supervisor", "writtenAt"]) ||
        marker.protocol !== 1 ||
        marker.operationId !== operationId ||
        !isSupervisorRef(marker.supervisor) ||
        !sameSupervisor(marker.supervisor, expectedSupervisor) ||
        typeof marker.writtenAt !== "number" ||
        !Number.isFinite(marker.writtenAt)
      ) {
        throw new Error("invalid finalized operation marker");
      }
      return true;
    },
    finalize(operationId, supervisor) {
      assertDirectory(layout.finalized, layout.realHome, fs);
      const marker: FinalizedMarker = { protocol: 1, operationId, supervisor: { ...supervisor }, writtenAt: now() };
      const path = markerFor(operationId);
      const existing = readMarker(operationId);
      if (existing !== undefined) {
        const prior = existing as Partial<FinalizedMarker>;
        if (
          !hasOnlyKeys(existing as object, ["protocol", "operationId", "supervisor", "writtenAt"]) ||
          prior.protocol !== 1 ||
          prior.operationId !== operationId ||
          !isSupervisorRef(prior.supervisor) ||
          !sameSupervisor(prior.supervisor, supervisor) ||
          typeof prior.writtenAt !== "number" ||
          !Number.isFinite(prior.writtenAt)
        ) {
          throw new Error("conflicting finalized operation marker");
        }
        fsyncDirectory(layout.finalized, fs);
        return;
      }
      writeJsonAtomicWithFileSystem(path, marker, fs);
    },
  };
}

function commandReceiptMatches(value: unknown, command: MaintenanceCommand): value is CommandReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<CommandReceipt>;
  return (
    hasOnlyKeys(value, ["protocol", "command", "outcome", "classification", "writtenAt"]) &&
    receipt.protocol === 1 &&
    sameValue(receipt.command, command) &&
    (receipt.outcome === "applied" || receipt.outcome === "rejected") &&
    (receipt.classification === undefined || typeof receipt.classification === "string") &&
    typeof receipt.writtenAt === "number" &&
    Number.isFinite(receipt.writtenAt)
  );
}

function eventReceiptMatches(value: unknown, event: JobEvent): value is EventReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<EventReceipt>;
  return (
    hasOnlyKeys(value, ["protocol", "event", "outcome", "writtenAt"]) &&
    receipt.protocol === 1 &&
    sameValue(receipt.event, event) &&
    receipt.outcome === "applied" &&
    typeof receipt.writtenAt === "number" &&
    Number.isFinite(receipt.writtenAt)
  );
}

function successfulReply(
  command: MaintenanceCommand,
  snapshot: AdmissionSnapshot,
  finalized: FinalizedOperations,
): boolean {
  if (snapshot.persistenceFault) return false;
  if (command.kind === "close") {
    return snapshot.admission === "closed" && snapshot.operationId === command.operationId;
  }
  if (command.kind === "release") {
    return snapshot.admission === "open" && snapshot.operationId === null && finalized.has(command.operationId);
  }
  return true;
}

export type ChildProcessObservation = "absent" | "present" | "unknown";

export interface MaintenanceSupervisorOptions {
  instanceHome: string;
  instanceId: string;
  supervisor: SupervisorRef;
  bootedAt: number;
  sdkHost: string;
  sdkPort: number;
  now?: () => number;
  fileSystem?: MailboxFileSystem;
  inspectChildPids?: (pids: readonly number[]) => Promise<ReadonlyMap<number, ChildProcessObservation>>;
}

export interface MaintenanceSupervisor {
  readonly ledger: AdmissionLedger;
  readonly stateDirectory: string;
  pollOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createMaintenanceSupervisor(options: MaintenanceSupervisorOptions): MaintenanceSupervisor {
  const fs = options.fileSystem ?? nodeMailboxFileSystem;
  const now = options.now ?? Date.now;
  if (!isSupervisorRef(options.supervisor)) throw new Error("invalid supervisor reference");
  if (!Number.isFinite(options.bootedAt) || options.bootedAt < 0) throw new Error("invalid supervisor boot time");
  if (!INSTANCE_ID.test(options.instanceId) || options.instanceId.length > 128) {
    throw new Error("invalid instance ID");
  }
  if (options.sdkHost !== "127.0.0.1") {
    throw new Error("invalid SDK host");
  }
  if (!Number.isSafeInteger(options.sdkPort) || options.sdkPort < 1 || options.sdkPort > 65535) {
    throw new Error("invalid SDK port");
  }
  const layout = createLayout(options.instanceHome, options.supervisor.bootId, fs);
  const finalized = createFinalizedOperations(layout, options.supervisor, now, fs);
  let stagedEventReceipt: EventReceipt | undefined;

  const persistSnapshot = (snapshot: AdmissionSnapshot): void => {
    assertDirectory(layout.bootRoot, layout.realHome, fs);
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (snapshotBytes > SNAPSHOT_BYTES) throw new Error("voice admission snapshot exceeds reserved size");
    if (stagedEventReceipt) {
      assertDirectory(layout.eventReceipts, layout.realHome, fs);
      writeImmutable(
        join(layout.eventReceipts, `${stagedEventReceipt.event.eventId}.json`),
        stagedEventReceipt,
        layout.realHome,
        fs,
      );
    }
    const record: SnapshotRecord = {
      protocol: 1,
      supervisor: { ...options.supervisor },
      snapshot,
      writtenAt: now(),
    };
    writeJsonAtomicWithFileSystem(layout.snapshot, record, fs);
  };

  const ledger = new AdmissionLedger(options.supervisor, persistSnapshot, now);
  persistSnapshot(ledger.snapshot());
  const current: CurrentSupervisor = {
    protocol: 1,
    supervisor: { ...options.supervisor },
    bootedAt: options.bootedAt,
    writtenAt: now(),
    stateDirectory: layout.bootRoot,
    sdkHost: options.sdkHost,
    sdkPort: options.sdkPort,
    instanceId: options.instanceId,
  };
  writeJsonAtomicWithFileSystem(layout.current, current, fs);

  const faultForPersistence = (operationId?: string): void => {
    try {
      ledger.faultClosed(operationId);
    } catch {
      // The in-memory latch is set by AdmissionLedger even when diagnostic persistence fails.
    }
  };

  const writeReply = (
    command: MaintenanceCommand,
    ok: boolean,
    snapshot: AdmissionSnapshot,
    classification?: string,
  ): void => {
    assertDirectory(layout.replies, layout.realHome, fs);
    const reply: MaintenanceReply = {
      protocol: 1,
      requestId: command.requestId,
      operationId: command.operationId,
      supervisor: { ...options.supervisor },
      ok: ok && !snapshot.persistenceFault,
      ...(classification ? { classification } : {}),
      snapshot,
      writtenAt: now(),
    };
    writeJsonAtomicWithFileSystem(join(layout.replies, `${command.requestId}.json`), reply, fs);
  };

  const processEvent = (filename: string, event: JobEvent): void => {
    assertDirectory(layout.jobs, layout.realHome, fs);
    assertDirectory(layout.eventReceipts, layout.realHome, fs);
    const eventPath = join(layout.jobs, filename);
    const receiptPath = join(layout.eventReceipts, `${event.eventId}.json`);
    const existing = readOptionalJson(receiptPath, layout.realHome, fs);
    if (existing !== undefined && !eventReceiptMatches(existing, event)) {
      throw new Error("conflicting voice job event receipt");
    }
    const reflected = (() => {
      const job = ledger.snapshot().unresolved.find((candidate) => candidate.jobId === event.jobId);
      if (event.kind === "entered") {
        return (
          (job?.phase === "entered-awaiting-completion" && job.childPid === event.childPid) ||
          (existing !== undefined && job === undefined)
        );
      }
      return job === undefined;
    })();
    if (!reflected) {
      stagedEventReceipt = {
        protocol: 1,
        event,
        outcome: "applied",
        writtenAt: existing && eventReceiptMatches(existing, event) ? existing.writtenAt : now(),
      };
      try {
        if (event.kind === "entered") ledger.entered(event.supervisor, event.jobId, event.childPid);
        else ledger.completed(event.supervisor, event.jobId, event.childPid);
      } finally {
        stagedEventReceipt = undefined;
      }
    } else if (ledger.snapshot().persistenceFault) {
      // A receipt can prove what this live ledger attempted, but never substitutes
      // for persisting the ledger state that remains authoritative.
      ledger.refresh();
    }
    unlinkDurable(eventPath, fs);
    unlinkDurable(receiptPath, fs);
  };

  const processCommand = (filename: string, command: MaintenanceCommand): void => {
    assertDirectory(layout.commands, layout.realHome, fs);
    assertDirectory(layout.commandReceipts, layout.realHome, fs);
    const commandPath = join(layout.commands, filename);
    const receiptPath = join(layout.commandReceipts, `${command.requestId}.json`);
    let existing = readOptionalJson(receiptPath, layout.realHome, fs);
    if (existing !== undefined && !commandReceiptMatches(existing, command)) {
      throw new Error("conflicting maintenance command receipt");
    }

    let snapshot: AdmissionSnapshot;
    let classification: string | undefined;
    let applied = false;
    try {
      if (command.kind === "close" && finalized.has(command.operationId)) throw new Error("operation-finalized");
      if (existing && commandReceiptMatches(existing, command) && command.kind === "close") {
        snapshot = ledger.refresh();
        if (existing.outcome === "rejected") classification = existing.classification ?? "invalid-request";
      } else {
        snapshot = applyMaintenance(command, ledger, finalized);
        applied = true;
      }
    } catch (error) {
      classification = classify(error);
      const persistenceFailure =
        classification === "persistence-failure" ||
        (error instanceof AggregateError && !["operation-finalized", "owner-conflict"].includes(classification));
      if (persistenceFailure) faultForPersistence(command.operationId);
      try {
        snapshot = ledger.refresh();
      } catch {
        return;
      }
    }

    const ok = classification === undefined && successfulReply(command, snapshot, finalized);
    if (!ok && !classification) classification = snapshot.persistenceFault ? "persistence-fault" : "state-mismatch";
    const receipt: CommandReceipt =
      existing && commandReceiptMatches(existing, command)
        ? existing
        : {
            protocol: 1,
            command,
            outcome: applied && ok ? "applied" : "rejected",
            ...(classification ? { classification } : {}),
            writtenAt: now(),
          };
    try {
      writeImmutable(receiptPath, receipt, layout.realHome, fs);
      existing = receipt;
      writeReply(command, ok, snapshot, classification);
    } catch {
      faultForPersistence(command.operationId);
      return;
    }
    try {
      unlinkDurable(commandPath, fs);
      unlinkDurable(receiptPath, fs);
    } catch {
      // Retaining a command receipt prevents reapplication after uncertain cleanup.
    }
  };

  let lastLiveness = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;

  const pollOnce = async (): Promise<void> => {
    assertDirectory(layout.bootRoot, layout.realHome, fs);
    assertDirectory(layout.jobs, layout.realHome, fs);
    assertDirectory(layout.commands, layout.realHome, fs);
    const events: { filename: string; event: JobEvent }[] = [];
    for (const filename of fs.readdirSync(layout.jobs)) {
      try {
        const event = parseJobEvent(
          readJson(join(layout.jobs, filename), layout.realHome, fs),
          filename,
          options.supervisor,
        );
        events.push({ filename, event });
      } catch (error) {
        logger.warn("Ignored invalid voice job event", { file: filename, classification: classify(error) });
      }
    }
    events.sort((left, right) => {
      const jobOrder = left.event.jobId < right.event.jobId ? -1 : left.event.jobId > right.event.jobId ? 1 : 0;
      return jobOrder || left.event.sequence - right.event.sequence;
    });
    for (const { filename, event } of events) {
      try {
        processEvent(filename, event);
      } catch (error) {
        if (classify(error) === "persistence-failure" || error instanceof AggregateError) {
          faultForPersistence();
        }
        logger.warn("Voice job event remains unresolved", { file: filename, classification: classify(error) });
      }
    }

    for (const filename of fs.readdirSync(layout.commands).sort()) {
      try {
        const command = parseCommand(
          readJson(join(layout.commands, filename), layout.realHome, fs),
          filename,
          options.supervisor,
        );
        processCommand(filename, command);
      } catch (error) {
        logger.warn("Ignored invalid maintenance command", { file: filename, classification: classify(error) });
      }
    }

    if (now() - lastLiveness >= LIVENESS_INTERVAL_MS) {
      lastLiveness = now();
      if (options.inspectChildPids) {
        const pids = [...ledger.snapshot().childPids];
        try {
          const observations = await options.inspectChildPids(pids);
          const verifiedAbsent = new Set(pids.filter((pid) => observations.get(pid) === "absent"));
          ledger.pruneExitedChildren(verifiedAbsent);
        } catch {
          // An unavailable or partial census proves no process absent.
        }
      }
      try {
        ledger.refresh();
      } catch {
        // AdmissionLedger retains the in-memory fault latch.
      }
    }
  };

  const schedule = (): void => {
    timer = setTimeout(async () => {
      if (!polling) {
        polling = true;
        try {
          await pollOnce();
        } catch (error) {
          faultForPersistence();
          logger.warn("Voice maintenance poll failed", { classification: classify(error) });
        } finally {
          polling = false;
        }
      }
      if (timer !== undefined) schedule();
    }, POLL_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    ledger,
    stateDirectory: layout.bootRoot,
    pollOnce,
    start() {
      if (timer === undefined) schedule();
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export interface CreateJobReporterOptions {
  jobId: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => number;
  fileSystem?: MailboxFileSystem;
}

export function createJobReporter(options: CreateJobReporterOptions): { entered(): void; completed(): void } {
  const fs = options.fileSystem ?? nodeMailboxFileSystem;
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const supervisorPid = Number(env.HIVE_VOICE_SUPERVISOR_PID);
  const bootId = env.HIVE_VOICE_SUPERVISOR_BOOT_ID;
  const stateDirectory = env.HIVE_VOICE_STATE_DIR;
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 1 || !bootId || !UUID.test(bootId)) {
    throw new Error("invalid packaged voice tracking identity");
  }
  if (!stateDirectory || !isAbsolute(stateDirectory) || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("invalid packaged voice tracking state");
  }
  if (typeof options.jobId !== "string" || options.jobId.length < 1 || options.jobId.length > 512) {
    throw new Error("invalid tracked voice job ID");
  }
  const realState = fs.realpathSync(stateDirectory);
  if (
    realState !== resolve(realState) ||
    realState.split(sep).at(-1) !== bootId ||
    dirname(realState).split(sep).at(-1) !== "voice-worker" ||
    dirname(dirname(realState)).split(sep).at(-1) !== ".hive-state"
  ) {
    throw new Error("voice tracking state does not match boot identity");
  }
  const root = dirname(dirname(dirname(realState)));
  assertDirectory(realState, root, fs);
  const jobs = assertDirectory(join(realState, "jobs"), root, fs);
  const supervisor: SupervisorRef = { pid: supervisorPid, bootId };
  let entered = false;
  let completed = false;
  const writeEvent = (kind: JobEvent["kind"], sequence: JobEvent["sequence"]): void => {
    assertDirectory(jobs, root, fs);
    const eventId = fs.randomUUID();
    assertUuid(eventId, "event ID");
    const event: JobEvent = {
      protocol: 1,
      eventId,
      supervisor,
      jobId: options.jobId,
      childPid: pid,
      sequence,
      kind,
    };
    writeJsonAtomicWithFileSystem(join(jobs, `${eventId}.json`), event, fs);
  };
  return {
    entered() {
      if (entered) throw new Error("voice job entry already reported");
      writeEvent("entered", 1);
      entered = true;
    },
    completed() {
      if (!entered || completed) throw new Error("voice job completion lacks entry");
      writeEvent("completed", 2);
      completed = true;
    },
  };
}

function parseCurrent(value: unknown): CurrentSupervisor {
  if (!value || typeof value !== "object") throw new Error("invalid current voice supervisor");
  const current = value as Partial<CurrentSupervisor>;
  if (
    !hasOnlyKeys(value, [
      "protocol",
      "supervisor",
      "bootedAt",
      "writtenAt",
      "stateDirectory",
      "sdkHost",
      "sdkPort",
      "instanceId",
    ]) ||
    current.protocol !== 1 ||
    !isSupervisorRef(current.supervisor) ||
    typeof current.bootedAt !== "number" ||
    !Number.isFinite(current.bootedAt) ||
    typeof current.writtenAt !== "number" ||
    !Number.isFinite(current.writtenAt) ||
    typeof current.stateDirectory !== "string" ||
    !isAbsolute(current.stateDirectory) ||
    current.sdkHost !== "127.0.0.1" ||
    !Number.isSafeInteger(current.sdkPort) ||
    (current.sdkPort ?? 0) < 1 ||
    (current.sdkPort ?? 0) > 65535 ||
    typeof current.instanceId !== "string" ||
    !INSTANCE_ID.test(current.instanceId) ||
    current.instanceId.length > 128
  ) {
    throw new Error("invalid current voice supervisor");
  }
  return current as CurrentSupervisor;
}

export type SupervisorIdentityStage = "before-current" | "before-close" | "before-stop";
export type CorroborateSupervisor = (stage: SupervisorIdentityStage) => Promise<SupervisorRef>;

export interface RequestMaintenanceOptions {
  instanceHome: string;
  instanceId: string;
  operationId: string;
  kind: MaintenanceCommand["kind"];
  deadline: number;
  corroborateSupervisor: CorroborateSupervisor;
  supervisor?: SupervisorRef;
  expectedAdmission?: "open" | "closed" | "any";
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  randomId?: () => string;
  fileSystem?: MailboxFileSystem;
}

export async function requestMaintenance(options: RequestMaintenanceOptions): Promise<MaintenanceReply> {
  const fs = options.fileSystem ?? nodeMailboxFileSystem;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  assertUuid(options.operationId, "operation ID");
  if (!Number.isFinite(options.deadline)) throw new Error("maintenance deadline required");

  const independentlyObserved = await options.corroborateSupervisor("before-current");
  if (!isSupervisorRef(independentlyObserved)) throw new Error("invalid independently observed supervisor");
  const realHome = fs.realpathSync(options.instanceHome);
  const stateRoot = assertDirectory(join(realHome, ".hive-state"), realHome, fs);
  const voiceRoot = assertDirectory(join(stateRoot, "voice-worker"), realHome, fs);
  const current = parseCurrent(readJson(join(voiceRoot, "current.json"), realHome, fs));
  if (current.instanceId !== options.instanceId)
    throw new Error("current voice supervisor belongs to another instance");
  if (!sameSupervisor(current.supervisor, independentlyObserved)) throw new Error("stale current voice supervisor");
  if (options.supervisor && !sameSupervisor(current.supervisor, options.supervisor)) {
    throw new Error("current voice supervisor differs from retained operation");
  }
  const layout = openLayout(realHome, current.supervisor.bootId, fs);
  if (fs.realpathSync(current.stateDirectory) !== layout.bootRoot) throw new Error("current state directory mismatch");
  if (options.kind === "close") {
    const beforeClose = await options.corroborateSupervisor("before-close");
    if (!sameSupervisor(beforeClose, current.supervisor)) throw new Error("voice supervisor changed before close");
  }

  const requestId = (options.randomId ?? fs.randomUUID)();
  assertUuid(requestId, "request ID");
  const command: MaintenanceCommand = {
    protocol: 1,
    requestId,
    operationId: options.operationId,
    supervisor: { ...current.supervisor },
    kind: options.kind,
  };
  const commandPath = join(layout.commands, `${requestId}.json`);
  const replyPath = join(layout.replies, `${requestId}.json`);
  const requestedAt = now();
  let commandWritten = false;
  let lastWriteError: unknown;
  while (now() <= options.deadline) {
    if (!commandWritten) {
      try {
        assertDirectory(layout.commands, layout.realHome, fs);
        writeImmutable(commandPath, command, layout.realHome, fs);
        commandWritten = true;
      } catch (error) {
        lastWriteError = error;
      }
    }
    if (commandWritten) {
      let value: unknown | undefined;
      try {
        assertDirectory(layout.replies, layout.realHome, fs);
        value = readOptionalJson(replyPath, layout.realHome, fs);
      } catch (error) {
        throw new Error("invalid maintenance reply", { cause: error });
      }
      if (value !== undefined) {
        const reply = parseReply(value);
        if (
          reply.requestId !== requestId ||
          reply.operationId !== options.operationId ||
          !sameSupervisor(reply.supervisor, current.supervisor) ||
          !sameSupervisor(reply.snapshot.supervisor, current.supervisor) ||
          reply.writtenAt < requestedAt
        ) {
          throw new Error("stale or mismatched maintenance reply");
        }
        if (!reply.ok || reply.snapshot.persistenceFault) {
          throw new Error(reply.classification ?? "maintenance-unresolved");
        }
        const expected =
          options.expectedAdmission ??
          (options.kind === "close" ? "closed" : options.kind === "release" ? "open" : "any");
        if (
          (expected !== "any" && reply.snapshot.admission !== expected) ||
          (expected === "closed" && reply.snapshot.operationId !== options.operationId) ||
          (expected === "open" && reply.snapshot.operationId !== null)
        ) {
          throw new Error("maintenance reply has unexpected admission ownership");
        }
        return reply;
      }
    }
    if (now() >= options.deadline) break;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, options.deadline - now())));
  }
  throw new Error(commandWritten ? "maintenance request timed out" : "maintenance command write timed out", {
    cause: lastWriteError,
  });
}

export async function corroborateMaintenanceBeforeStop(
  supervisor: SupervisorRef,
  corroborateSupervisor: CorroborateSupervisor,
): Promise<void> {
  const observed = await corroborateSupervisor("before-stop");
  if (!sameSupervisor(observed, supervisor)) throw new Error("voice supervisor changed before stop");
}
