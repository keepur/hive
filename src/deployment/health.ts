import type { AdmissionSnapshot } from "../voice-worker/admission.js";
import type { MaintenanceReply } from "../voice-worker/maintenance-ipc.js";
import type { BootIdentity, Release, RuntimeRelease } from "./release.js";

export const HEALTH_FUTURE_SKEW_MS = 5_000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function onlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseBootIdentity(value: unknown): BootIdentity {
  if (!value || typeof value !== "object") throw new Error("invalid runtime boot identity");
  const identity = value as Partial<BootIdentity>;
  const release = identity.release as Record<string, unknown> | undefined;
  if (
    !onlyKeys(value, ["release", "component", "pid", "bootId", "startedAt"]) ||
    (identity.component !== "engine" && identity.component !== "voice-worker") ||
    !Number.isSafeInteger(identity.pid) ||
    (identity.pid ?? 0) <= 1 ||
    typeof identity.bootId !== "string" ||
    !UUID.test(identity.bootId) ||
    typeof identity.startedAt !== "string" ||
    !Number.isFinite(Date.parse(identity.startedAt)) ||
    !release ||
    typeof release !== "object"
  ) {
    throw new Error("invalid runtime boot identity");
  }
  if ("classification" in release) {
    if (
      !onlyKeys(release, [
        "classification",
        "packageVersion",
        "sourceRevision",
        "sourceDirty",
        "dependencyLockSha256",
      ]) ||
      release.classification !== "source/unavailable" ||
      release.packageVersion !== null ||
      release.sourceRevision !== null ||
      release.sourceDirty !== null ||
      release.dependencyLockSha256 !== null
    ) {
      throw new Error("invalid source runtime identity");
    }
  } else if (
    !onlyKeys(release, [
      "schemaVersion",
      "packageVersion",
      "sourceRevision",
      "sourceDirty",
      "dependencyLockSha256",
      "voiceWorker",
    ]) ||
    release.schemaVersion !== 1 ||
    typeof release.packageVersion !== "string" ||
    typeof release.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(release.sourceRevision) ||
    typeof release.sourceDirty !== "boolean" ||
    typeof release.dependencyLockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(release.dependencyLockSha256) ||
    !(release.voiceWorker && typeof release.voiceWorker === "object") ||
    !onlyKeys(release.voiceWorker, ["path", "admissionProtocol"]) ||
    (release.voiceWorker as { path?: unknown }).path !== "pkg/voice-worker.min.js" ||
    (release.voiceWorker as { admissionProtocol?: unknown }).admissionProtocol !== 1
  ) {
    throw new Error("invalid packaged runtime identity");
  }
  return identity as BootIdentity;
}

export interface PackagedEvidence {
  installed: Release;
  engine: BootIdentity;
  worker: BootIdentity | null;
  voiceEnabled: boolean;
  processPathsMatch: boolean;
  configSelectorsMatch: boolean;
  freshOrderedEngineMarkers: boolean;
  engineAlive: boolean;
  workerAlive: boolean;
  heartbeatFresh: boolean;
  heartbeatMatchesSupervisor: boolean;
  admissionSnapshot: AdmissionSnapshot | null;
  admissionFresh: boolean;
  sdkRootStatus: number | null;
  sdkAgentName: string | null;
  sdkSocketOwned: boolean;
  bridgeAuthenticated: boolean;
  bridgeMissingDenied: boolean;
  bridgeWrongDenied: boolean;
  dependenciesContained: boolean;
}

export function isPackagedRelease(release: RuntimeRelease): release is Release {
  return !("classification" in release);
}

export function sameRelease(left: Release, right: RuntimeRelease): boolean {
  return (
    isPackagedRelease(right) &&
    left.packageVersion === right.packageVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.dependencyLockSha256 === right.dependencyLockSha256 &&
    left.sourceDirty === right.sourceDirty
  );
}

export function packagedHealthy(evidence: PackagedEvidence): boolean {
  if (
    !sameRelease(evidence.installed, evidence.engine.release) ||
    !evidence.engineAlive ||
    !evidence.processPathsMatch ||
    !evidence.configSelectorsMatch ||
    !evidence.freshOrderedEngineMarkers ||
    !evidence.dependenciesContained
  ) {
    return false;
  }
  if (!evidence.voiceEnabled) return true;

  const snapshot = evidence.admissionSnapshot;
  return (
    evidence.worker !== null &&
    sameRelease(evidence.installed, evidence.worker.release) &&
    evidence.workerAlive &&
    snapshot !== null &&
    evidence.admissionFresh &&
    snapshot.supervisor.pid === evidence.worker.pid &&
    snapshot.supervisor.bootId === evidence.worker.bootId &&
    snapshot.admission === "open" &&
    snapshot.operationId === null &&
    snapshot.persistenceFault === false &&
    evidence.heartbeatFresh &&
    evidence.heartbeatMatchesSupervisor &&
    evidence.sdkRootStatus === 200 &&
    evidence.sdkAgentName === "hive-voice" &&
    evidence.sdkSocketOwned &&
    evidence.bridgeAuthenticated &&
    evidence.bridgeMissingDenied &&
    evidence.bridgeWrongDenied
  );
}

export interface PilotRecoveryEvidence {
  engineLiveIdentityMatches: boolean;
  workerLiveIdentityMatches: boolean;
  effectiveArgumentsMatch: boolean;
  workingDirectoryMatches: boolean;
  configSelectorsMatch: boolean;
  executableHashesMatch: boolean;
  dependencyPathsAndVersionsMatch: boolean;
  freshOrderedEngineMarkers: boolean;
  bridgeAuthenticated: boolean;
  bridgeMissingDenied: boolean;
  bridgeWrongDenied: boolean;
  sdkRootStatus: number | null;
  sdkAgentName: string | null;
  sdkSocketOwned: boolean;
  registrationFresh: boolean;
  manifestIdentity: "legacy/unavailable";
  releaseBootIdentity: "legacy/unavailable";
  supervisorIdentity: "legacy/unavailable";
}

/** Legacy recovery is deliberately independent from packaged-release health. */
export function pilotRecovered(evidence: PilotRecoveryEvidence): boolean {
  return (
    evidence.manifestIdentity === "legacy/unavailable" &&
    evidence.releaseBootIdentity === "legacy/unavailable" &&
    evidence.supervisorIdentity === "legacy/unavailable" &&
    evidence.engineLiveIdentityMatches &&
    evidence.workerLiveIdentityMatches &&
    evidence.effectiveArgumentsMatch &&
    evidence.workingDirectoryMatches &&
    evidence.configSelectorsMatch &&
    evidence.executableHashesMatch &&
    evidence.dependencyPathsAndVersionsMatch &&
    evidence.freshOrderedEngineMarkers &&
    evidence.bridgeAuthenticated &&
    evidence.bridgeMissingDenied &&
    evidence.bridgeWrongDenied &&
    evidence.sdkRootStatus === 200 &&
    evidence.sdkAgentName === "hive-voice" &&
    evidence.sdkSocketOwned &&
    evidence.registrationFresh
  );
}

export interface ObservedProcess {
  pid: number;
  startTime: string;
}

export function bootIdentityIsCurrent(
  identity: BootIdentity,
  process: ObservedProcess | null,
  expectedComponent: BootIdentity["component"],
  activationStartedAt: number,
  now = Date.now(),
): boolean {
  const startedAt = Date.parse(identity.startedAt);
  return (
    identity.component === expectedComponent &&
    process !== null &&
    identity.pid === process.pid &&
    process.startTime === identity.startedAt &&
    Number.isFinite(startedAt) &&
    startedAt >= activationStartedAt &&
    startedAt <= now + HEALTH_FUTURE_SKEW_MS
  );
}

export interface EngineMarker {
  message: string;
  pid: number;
  bootId: string;
  timestamp: number;
}

export interface EngineMarkerRead {
  records: EngineMarker[];
  truncatedOrMalformed: boolean;
  endOffset: number;
}

/** Read only bytes appended after the caller's pre-bootstrap offset. */
export function readEngineMarkersAfter(path: string, startOffset: number): EngineMarkerRead {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error("invalid engine log offset");
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < startOffset) return { records: [], truncatedOrMalformed: true, endOffset: size };
    const bytes = Buffer.alloc(size - startOffset);
    let consumed = 0;
    while (consumed < bytes.length) {
      const count = readSync(fd, bytes, consumed, bytes.length - consumed, startOffset + consumed);
      if (count === 0) break;
      consumed += count;
    }
    const text = bytes.subarray(0, consumed).toString("utf8");
    const complete = text.length === 0 || text.endsWith("\n");
    const records: EngineMarker[] = [];
    let malformed = !complete;
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const value = JSON.parse(line) as { msg?: unknown; pid?: unknown; bootId?: unknown; ts?: unknown };
        const timestamp = typeof value.ts === "string" ? Date.parse(value.ts) : Number.NaN;
        if (
          typeof value.msg !== "string" ||
          !Number.isSafeInteger(value.pid) ||
          typeof value.bootId !== "string" ||
          !Number.isFinite(timestamp)
        ) {
          malformed = true;
          continue;
        }
        records.push({ message: value.msg, pid: value.pid as number, bootId: value.bootId, timestamp });
      } catch {
        malformed = true;
      }
    }
    return { records, truncatedOrMalformed: malformed, endOffset: startOffset + consumed };
  } finally {
    closeSync(fd);
  }
}

/** Classify only records read after the captured bootstrap offset. */
export function freshOrderedEngineMarkers(
  records: readonly EngineMarker[],
  identity: Pick<BootIdentity, "pid" | "bootId">,
  activationStartedAt: number,
  now = Date.now(),
  readWasTruncated = false,
): boolean {
  if (readWasTruncated) return false;
  const matching = records.filter(
    (record) =>
      record.pid === identity.pid &&
      record.bootId === identity.bootId &&
      Number.isFinite(record.timestamp) &&
      record.timestamp >= activationStartedAt &&
      record.timestamp <= now + HEALTH_FUTURE_SKEW_MS,
  );
  const starting = matching.findIndex((record) => record.message === "Hive starting up");
  return starting >= 0 && matching.slice(starting + 1).some((record) => record.message === "Hive is running");
}

export function packagedHeartbeatFresh(
  identity: BootIdentity | null,
  expected: Pick<BootIdentity, "pid" | "bootId">,
  updatedAt: number,
  activationStartedAt: number,
  now = Date.now(),
): boolean {
  return (
    identity !== null &&
    isPackagedRelease(identity.release) &&
    identity.component === "voice-worker" &&
    identity.pid === expected.pid &&
    identity.bootId === expected.bootId &&
    Number.isFinite(updatedAt) &&
    updatedAt >= activationStartedAt &&
    updatedAt <= now + HEALTH_FUTURE_SKEW_MS &&
    now - updatedAt <= WORKER_HEARTBEAT_MAX_AGE_MS
  );
}

export interface AdmissionReplyContext {
  reply: MaintenanceReply | null;
  requestId: string;
  operationId: string;
  requestedAt: number;
  expectedSupervisor: { pid: number; bootId: string };
  processCorroborated: boolean;
  now?: number;
}

export function freshAdmissionStatus(context: AdmissionReplyContext): boolean {
  const reply = context.reply;
  const now = context.now ?? Date.now();
  return (
    reply !== null &&
    reply.protocol === 1 &&
    reply.ok &&
    reply.requestId === context.requestId &&
    reply.operationId === context.operationId &&
    reply.writtenAt >= context.requestedAt &&
    reply.writtenAt <= now + HEALTH_FUTURE_SKEW_MS &&
    reply.supervisor.pid === context.expectedSupervisor.pid &&
    reply.supervisor.bootId === context.expectedSupervisor.bootId &&
    reply.snapshot.supervisor.pid === context.expectedSupervisor.pid &&
    reply.snapshot.supervisor.bootId === context.expectedSupervisor.bootId &&
    context.processCorroborated &&
    reply.snapshot.admission === "open" &&
    reply.snapshot.operationId === null &&
    reply.snapshot.persistenceFault === false
  );
}

export async function boundedHealthWindows<T>(
  check: (deadline: number, attempt: number) => Promise<T | null>,
  options: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    windowMs?: number;
    gapMs?: number;
  } = {},
): Promise<T | null> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const windowMs = options.windowMs ?? 30_000;
  const gapMs = options.gapMs ?? 10_000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const value = await check(now() + windowMs, attempt);
    if (value !== null) return value;
    if (attempt < 3) await sleep(gapMs);
  }
  return null;
}
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
