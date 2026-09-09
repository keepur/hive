export interface SupervisorRef {
  pid: number;
  bootId: string;
}

export interface AcceptedJob {
  jobId: string;
  acceptedAt: number;
  phase: "accepted-awaiting-entry" | "entered-awaiting-completion";
  childPid?: number;
}

export interface AdmissionSnapshot {
  supervisor: SupervisorRef;
  operationId: string | null;
  admission: "open" | "closed";
  persistenceFault: boolean;
  unresolved: AcceptedJob[];
  childPids: number[];
}

export interface RequestLike {
  id: string;
  accept(): Promise<void>;
  reject(): Promise<void>;
}

interface LedgerState {
  operationId: string | null;
  persistenceFault: boolean;
  pending: Map<string, AcceptedJob>;
  seen: Set<string>;
  childPids: Set<number>;
}

// Leave 4 KiB of the 16 KiB envelope for protocol fields and diagnostics.
const SNAPSHOT_BUDGET = 12 * 1024;
const RESERVED_OPERATION = "00000000-0000-4000-8000-000000000000";

export class AdmissionLedger {
  private state: LedgerState = {
    operationId: null,
    persistenceFault: false,
    pending: new Map(),
    seen: new Set(),
    childPids: new Set(),
  };

  constructor(
    private readonly supervisor: SupervisorRef,
    private readonly changed: (snapshot: AdmissionSnapshot) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private copy(): LedgerState {
    return {
      ...this.state,
      pending: new Map([...this.state.pending].map(([id, job]) => [id, { ...job }])),
      seen: new Set(this.state.seen),
      childPids: new Set(this.state.childPids),
    };
  }

  private describe(state: LedgerState): AdmissionSnapshot {
    return {
      supervisor: { ...this.supervisor },
      operationId: state.operationId,
      admission: state.operationId === null && !state.persistenceFault ? "open" : "closed",
      persistenceFault: state.persistenceFault,
      unresolved: [...state.pending.values()].map((job) => ({ ...job })),
      childPids: [...state.childPids],
    };
  }

  snapshot(): AdmissionSnapshot {
    return this.describe(this.state);
  }

  private commit(next: LedgerState, failed: LedgerState = this.state): AdmissionSnapshot {
    try {
      this.changed(this.describe(next));
    } catch (error) {
      // Retain conservative state even if the failed write renamed before fsync failed.
      this.state = { ...failed, persistenceFault: true };
      throw error;
    }
    this.state = next;
    return this.snapshot();
  }

  refresh(): AdmissionSnapshot {
    return this.commit(this.copy());
  }

  faultClosed(operationId?: string): void {
    const next = this.copy();
    if (next.operationId === null && operationId) next.operationId = operationId;
    next.persistenceFault = true;
    this.commit(next, next);
  }

  private fits(next: LedgerState): boolean {
    const projected = this.describe(next);
    projected.operationId = RESERVED_OPERATION;
    projected.admission = "closed";
    projected.persistenceFault = false;
    // Account now for every future entry's maximum PID and phase expansion.
    projected.childPids.push(
      ...projected.unresolved.filter((job) => job.childPid === undefined).map(() => Number.MAX_SAFE_INTEGER),
    );
    projected.unresolved = projected.unresolved.map((job) => ({
      ...job,
      phase: "entered-awaiting-completion",
      childPid: Number.MAX_SAFE_INTEGER,
    }));
    return Buffer.byteLength(JSON.stringify(projected), "utf8") <= SNAPSHOT_BUDGET;
  }

  async request(req: RequestLike): Promise<void> {
    if (this.state.operationId !== null || this.state.persistenceFault || this.state.seen.has(req.id) || !req.id) {
      await req.reject();
      return;
    }
    const next = this.copy();
    next.seen.add(req.id);
    next.pending.set(req.id, {
      jobId: req.id,
      acceptedAt: this.now(),
      phase: "accepted-awaiting-entry",
    });
    if (!this.fits(next)) {
      // Emit only the named tracking-capacity diagnostic, without dropping prior jobs.
      await req.reject();
      return;
    }
    try {
      this.commit(next, next);
    } catch (error) {
      await req.reject().catch(() => {});
      throw error;
    }
    // Do not delete in a then/finally/catch: this promise does not await assignment.
    await req.accept();
  }

  close(operationId: string): AdmissionSnapshot {
    if (!operationId) throw new Error("operation ID required");
    if (this.state.operationId !== null && this.state.operationId !== operationId) {
      throw new Error("maintenance owned by another operation");
    }
    const next = this.copy();
    next.operationId = operationId;
    return this.commit(next, next);
  }

  release(operationId: string, finalize: () => void): AdmissionSnapshot {
    // release also cancels an unseen close: claim ownership while persisting the fence.
    this.close(operationId);
    try {
      finalize();
    } catch (error) {
      this.state.persistenceFault = true;
      throw error;
    }
    const next = this.copy();
    next.operationId = null;
    next.persistenceFault = false;
    return this.commit(next);
  }

  entered(ref: SupervisorRef, jobId: string, childPid: number): void {
    this.assertSupervisor(ref);
    const next = this.copy();
    const job = next.pending.get(jobId);
    if (!job || !Number.isSafeInteger(childPid) || childPid <= 1) {
      throw new Error("unknown job entry");
    }
    if (job.childPid !== undefined && job.childPid !== childPid) {
      throw new Error("job child mismatch");
    }
    job.childPid = childPid;
    job.phase = "entered-awaiting-completion";
    next.childPids.add(childPid);
    this.commit(next, next);
  }

  completed(ref: SupervisorRef, jobId: string, childPid: number): void {
    this.assertSupervisor(ref);
    const next = this.copy();
    const job = next.pending.get(jobId);
    if (!job || job.childPid !== childPid || job.phase !== "entered-awaiting-completion") {
      throw new Error("completion lacks matching entry");
    }
    next.pending.delete(jobId);
    this.commit(next);
  }

  pruneExitedChildren(verifiedAbsent: ReadonlySet<number>): void {
    const next = this.copy();
    const unresolvedPids = new Set([...next.pending.values()].map((job) => job.childPid));
    for (const pid of next.childPids) {
      if (!unresolvedPids.has(pid) && verifiedAbsent.has(pid)) next.childPids.delete(pid);
    }
    if (next.childPids.size !== this.state.childPids.size) this.commit(next);
  }

  canStop(operationId: string, sdkActiveJobs: number | null, telemetryActiveCalls: number | null): boolean {
    return (
      !this.state.persistenceFault &&
      this.state.operationId === operationId &&
      this.state.pending.size === 0 &&
      sdkActiveJobs === 0 &&
      telemetryActiveCalls === 0
    );
  }

  private assertSupervisor(ref: SupervisorRef): void {
    if (ref.pid !== this.supervisor.pid || ref.bootId !== this.supervisor.bootId) {
      throw new Error("supervisor mismatch");
    }
  }
}
