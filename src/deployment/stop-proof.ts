/**
 * Absolute-expiry stop proof for a verified native maintenance hold (KPR-463
 * plan chunk 4 Task 9 Step 4c.2 and chunk 5 Step 4c.2a).
 *
 * A proof is an opaque, single-use, non-serializable object held in a private
 * WeakMap. It records the original wall-clock and local monotonic expiries of
 * the OLDEST decisive observation (IPC status, SDK health, telemetry query and
 * OS process/socket reads), capped by the supervisor heartbeat's remaining
 * lifetime. Proof construction, signal persistence and later IPC checks never
 * renew it. It is consumed synchronously at the actual launchd dispatch
 * (`BootoutOptions.beforeExec`), so no await can separate the check from the
 * signal.
 *
 * The readback passed to `proveNativeHold` must be populated only by concrete
 * IPC/OS/probe adapters; there is no JSON parser or boolean constructor here.
 * Builtin-only.
 */
import { canonical } from "./canonical.js";

export interface ProcessSeal {
  pid: number;
  startTime: string;
  executable: string;
  command: string;
  cwd: string;
}

export interface NativeGateReadback {
  operationId: string;
  requestId: string;
  requestedAt: number;
  /** Oldest start of the required IPC, SDK, telemetry and OS reads. */
  observedAt: number;
  completedAt: number;
  /** Oldest local monotonic start, measured by the owning frozen process. */
  observedMono: number;
  completedMono: number;
  worker: ProcessSeal;
  bootId: string;
  closedOperationId: string | null;
  admission: "open" | "closed";
  unresolvedAccepted: number;
  sdkActiveJobs: number;
  telemetryActiveCalls: number;
  /** Validated same-boot supervisor heartbeat time (epoch ms). */
  telemetryUpdatedAt: number;
  persistenceFault: boolean;
  sdkRootStatus: number;
  sdkAgentName: string;
  socketOwner: ProcessSeal;
}

export interface HoldExpectation {
  operationId: string;
  requestId: string;
  requestedAt: number;
  worker: ProcessSeal;
  bootId: string;
  now: number;
  nowMono: number;
}

export const DECISIVE_READ_BUDGET_MS = 2_000;
export const HEARTBEAT_MAX_AGE_MS = 60_000;

export class HoldNotProvedError extends Error {}
/** Thrown only before dispatch: no signal was issued in this invocation. */
export class HoldProofExpiredError extends Error {}

interface ProofEntry {
  operationId: string;
  worker: ProcessSeal;
  bootId: string;
  observedAt: number;
  expiresAt: number;
  observedMono: number;
  expiresMono: number;
  lastWall: number;
  lastMono: number;
}

const proofs = new WeakMap<object, ProofEntry>();

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function proveNativeHold(r: NativeGateReadback, e: HoldExpectation): object {
  const match = canonical(r.worker) === canonical(e.worker) && canonical(r.socketOwner) === canonical(e.worker);
  if (
    !match ||
    r.operationId !== e.operationId ||
    r.requestId !== e.requestId ||
    r.requestedAt !== e.requestedAt ||
    !Number.isSafeInteger(r.observedAt) ||
    !Number.isSafeInteger(r.completedAt) ||
    !Number.isSafeInteger(e.now) ||
    r.observedAt < e.requestedAt ||
    r.observedAt > r.completedAt ||
    r.completedAt > e.now ||
    e.now - r.observedAt > DECISIVE_READ_BUDGET_MS ||
    !finite(r.observedMono) ||
    !finite(r.completedMono) ||
    !finite(e.nowMono) ||
    r.observedMono > r.completedMono ||
    r.completedMono > e.nowMono ||
    e.nowMono - r.observedMono > DECISIVE_READ_BUDGET_MS ||
    r.bootId !== e.bootId ||
    r.closedOperationId !== e.operationId ||
    r.admission !== "closed" ||
    r.unresolvedAccepted !== 0 ||
    r.sdkActiveJobs !== 0 ||
    r.telemetryActiveCalls !== 0 ||
    !Number.isSafeInteger(r.telemetryUpdatedAt) ||
    r.telemetryUpdatedAt > e.now ||
    e.now - r.telemetryUpdatedAt > HEARTBEAT_MAX_AGE_MS ||
    r.persistenceFault ||
    r.sdkRootStatus !== 200 ||
    r.sdkAgentName !== "hive-voice"
  ) {
    throw new HoldNotProvedError("legacy hold not proved");
  }
  const proof = Object.freeze({});
  const heartbeatExpiry = r.telemetryUpdatedAt + HEARTBEAT_MAX_AGE_MS;
  proofs.set(proof, {
    operationId: e.operationId,
    worker: { ...e.worker },
    bootId: e.bootId,
    observedAt: r.observedAt,
    expiresAt: Math.min(r.observedAt + DECISIVE_READ_BUDGET_MS, heartbeatExpiry),
    observedMono: r.observedMono,
    expiresMono: Math.min(r.observedMono + DECISIVE_READ_BUDGET_MS, e.nowMono + heartbeatExpiry - e.now),
    lastWall: e.now,
    lastMono: e.nowMono,
  });
  return proof;
}

/**
 * Record an intermediate clock sample (collection, persistence, inspection).
 * Either clock moving backwards invalidates the proof.
 */
export function sampleProofClock(proof: object, now: number, nowMono: number): void {
  const entry = proofs.get(proof);
  if (!entry) throw new HoldProofExpiredError("fresh operation hold required");
  if (!Number.isSafeInteger(now) || !finite(nowMono) || now < entry.lastWall || nowMono < entry.lastMono) {
    proofs.delete(proof);
    throw new HoldProofExpiredError("clock reversal invalidates the hold proof");
  }
  entry.lastWall = now;
  entry.lastMono = nowMono;
}

/** Single use; must run synchronously immediately before OS dispatch. */
export function consumeHold(
  proof: object,
  operationId: string,
  worker: ProcessSeal,
  bootId: string,
  now: number,
  nowMono: number,
): void {
  const entry = proofs.get(proof);
  proofs.delete(proof);
  if (
    !entry ||
    !Number.isSafeInteger(now) ||
    entry.operationId !== operationId ||
    canonical(entry.worker) !== canonical(worker) ||
    entry.bootId !== bootId ||
    now < entry.observedAt ||
    now < entry.lastWall ||
    now > entry.expiresAt ||
    !finite(nowMono) ||
    nowMono < entry.observedMono ||
    nowMono < entry.lastMono ||
    nowMono > entry.expiresMono
  ) {
    throw new HoldProofExpiredError("fresh operation hold required");
  }
}

export interface StopProofClock {
  now(): number;
  mono(): number;
}

export interface GateChallenge {
  operationId: string;
  requestId: string;
  requestedAt: number;
}

export interface VerifiedStopOptions {
  operationId: string;
  worker: ProcessSeal;
  bootId: string;
  clock: StopProofClock;
  /** Original quiescence deadline; retries and persistence never extend it. */
  maintenanceDeadline: { wall: number; mono: number };
  randomId(): string;
  /** Fresh, complete decisive observations under this challenge. */
  collect(challenge: GateChallenge): Promise<NativeGateReadback>;
  /** Conservative crash metadata; never permission to ignore expiry. */
  persistSignalsBegun(): Promise<void>;
  /** Fixed worker bootout adapter; must call `beforeExec` synchronously just before dispatch. */
  bootout(beforeExec: () => void): Promise<void>;
  /** Same-owner terminal release; a failure propagates as unresolved. */
  release(): Promise<void>;
}

export type VerifiedStopOutcome = { kind: "stopped"; attempts: number } | { kind: "deferred"; reason: string };

/**
 * Collect, prove, persist, then stop with the proof consumed at dispatch. An
 * expiry before dispatch triggers a complete fresh observation (never an IPC
 * refresh alone) within the original deadline, otherwise terminal release and
 * a typed deferred outcome. Errors after dispatch propagate to checked recovery.
 */
export async function stopUnderFreshProof(options: VerifiedStopOptions): Promise<VerifiedStopOutcome> {
  let attempts = 0;
  let lastWall = Number.NEGATIVE_INFINITY;
  let lastMono = Number.NEGATIVE_INFINITY;
  const sample = (): { now: number; mono: number } => {
    const now = options.clock.now();
    const mono = options.clock.mono();
    if (now < lastWall || mono < lastMono) throw new HoldProofExpiredError("clock reversal during stop proof");
    lastWall = now;
    lastMono = mono;
    return { now, mono };
  };
  const defer = async (reason: string): Promise<VerifiedStopOutcome> => {
    await options.release();
    return { kind: "deferred", reason };
  };
  while (true) {
    let start: { now: number; mono: number };
    try {
      start = sample();
    } catch {
      return defer("clock reversal before stop");
    }
    if (start.now >= options.maintenanceDeadline.wall || start.mono >= options.maintenanceDeadline.mono) {
      return defer("maintenance deadline elapsed before a fresh stop proof");
    }
    attempts += 1;
    const challenge: GateChallenge = {
      operationId: options.operationId,
      requestId: options.randomId(),
      requestedAt: start.now,
    };
    let proof: object;
    try {
      const readback = await options.collect(challenge);
      const at = sample();
      proof = proveNativeHold(readback, {
        ...challenge,
        worker: options.worker,
        bootId: options.bootId,
        now: at.now,
        nowMono: at.mono,
      });
    } catch (error) {
      return defer(error instanceof Error ? error.message : "stop proof not established");
    }
    let signalIssued = false;
    try {
      await options.persistSignalsBegun();
      const persisted = sample();
      sampleProofClock(proof, persisted.now, persisted.mono);
      await options.bootout(() => {
        const dispatch = sample();
        consumeHold(proof, options.operationId, options.worker, options.bootId, dispatch.now, dispatch.mono);
        signalIssued = true;
      });
      return { kind: "stopped", attempts };
    } catch (error) {
      if (!signalIssued && error instanceof HoldProofExpiredError) continue;
      throw error;
    }
  }
}
