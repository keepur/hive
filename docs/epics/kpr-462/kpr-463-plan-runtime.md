# KPR-463 implementation plan — worker runtime and evidence

This is chunk 2 of the [parent plan](./kpr-463-plan.md). Its Testing Contract, authority, authorized dodi-dev workflow substitution and S0–S12 serial schedule apply in full. Draft sequencing revision for review; do not deploy or call.

## Task 4: Reversible admission gate and instance-local IPC

**Files:** Reuse `src/voice-worker/admission.ts` and its test from S0; create `src/voice-worker/maintenance-ipc.ts`, `src/voice-worker/maintenance-ipc.integration.test.ts`. Extend admission tests with the new IPC/persistence cases. Modify `src/voice-worker/main.ts` in Task 5/S5.

**Schedule:** S4 implements Steps 2–3 and Step 4 diagnostic data, then Step 5 tests, using S3's read-only process adapter. Step 4 consumer rendering is completed in S6 probes/doctor and S7 CLI/lifecycle. Step 5 assertions involving actual lifecycle cleanup/operation records finish in S9; Task 4 is fully complete only then. Step 1 is preserved Task 1 code; its contract below remains binding and is not reimplemented on resume.

**Shared-module boundary:** Keep the protocol, atomic file helpers, supervisor transport and the single exported `requestMaintenance` implementation together in `src/voice-worker/maintenance-ipc.ts`. Task 2 Step 3 explicitly includes this module and `admission.ts` in the frozen helper's bundle allowlist. The mailbox's runtime imports are limited to Node builtins, `admission.ts` and the existing `src/logging/logger.ts`; the preserved admission module remains import-free. Inject S3's process-identity checks as callbacks from the caller; do not import services, transaction, CLI, config, worker boot/session/telemetry or SDK code here. Importing the mailbox module performs no polling, state creation, instance selection or secret/config lookup; expose explicit start/client/reporter functions for those actions. This preserves one wire protocol and client for all consumers without moving any S0 code or adding another module.

- [x] **Step 1:** Implement the synchronous authority below. The JS callback reserves the job before its first await. SDK assignment/launch completion is deliberately not inferred from the returned promise. Reject repeated job IDs within one boot; record duplicate diagnostics without modifying an earlier entry.

```typescript
export interface SupervisorRef { pid: number; bootId: string }
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
    operationId: null, persistenceFault: false,
    pending: new Map(), seen: new Set(), childPids: new Set(),
  };
  constructor(
    private readonly supervisor: SupervisorRef,
    private readonly changed: (snapshot: AdmissionSnapshot) => void,
    private readonly now: () => number = Date.now,
  ) {}
  private copy(): LedgerState {
    return { ...this.state,
      pending: new Map([...this.state.pending].map(([id, job]) => [id, { ...job }])),
      seen: new Set(this.state.seen), childPids: new Set(this.state.childPids) };
  }
  private describe(state: LedgerState): AdmissionSnapshot {
    return {
      supervisor: { ...this.supervisor }, operationId: state.operationId,
      admission: state.operationId === null && !state.persistenceFault ? "open" : "closed",
      persistenceFault: state.persistenceFault,
      unresolved: [...state.pending.values()].map((job) => ({ ...job })),
      childPids: [...state.childPids],
    };
  }
  snapshot(): AdmissionSnapshot { return this.describe(this.state); }
  private commit(next: LedgerState, failed: LedgerState = this.state): AdmissionSnapshot {
    try { this.changed(this.describe(next)); }
    catch (error) {
      // Retain conservative state even if the failed write renamed before fsync failed.
      this.state = { ...failed, persistenceFault: true };
      throw error;
    }
    this.state = next;
    return this.snapshot();
  }
  refresh(): AdmissionSnapshot { return this.commit(this.copy()); }
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
    projected.childPids.push(...projected.unresolved.filter((j) => j.childPid === undefined)
      .map(() => Number.MAX_SAFE_INTEGER));
    projected.unresolved = projected.unresolved.map((job) => ({ ...job,
      phase: "entered-awaiting-completion", childPid: Number.MAX_SAFE_INTEGER }));
    return Buffer.byteLength(JSON.stringify(projected), "utf8") <= SNAPSHOT_BUDGET;
  }
  async request(req: RequestLike): Promise<void> {
    if (this.state.operationId !== null || this.state.persistenceFault || this.state.seen.has(req.id) || !req.id) {
      await req.reject();
      return;
    }
    const next = this.copy();
    next.seen.add(req.id);
    next.pending.set(req.id, { jobId: req.id, acceptedAt: this.now(), phase: "accepted-awaiting-entry" });
    if (!this.fits(next)) {
      // Emit only the named tracking-capacity diagnostic, without dropping prior jobs.
      await req.reject();
      return;
    }
    try { this.commit(next, next); }
    catch (error) {
      try { await req.reject(); } finally { throw error; }
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
    try { finalize(); }
    catch (error) { this.state.persistenceFault = true; throw error; }
    const next = this.copy();
    next.operationId = null;
    next.persistenceFault = false;
    return this.commit(next);
  }
  entered(ref: SupervisorRef, jobId: string, childPid: number): void {
    this.assertSupervisor(ref);
    const next = this.copy();
    const job = next.pending.get(jobId);
    if (!job || !Number.isSafeInteger(childPid) || childPid <= 1) throw new Error("unknown job entry");
    if (job.childPid !== undefined && job.childPid !== childPid) throw new Error("job child mismatch");
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
    return !this.state.persistenceFault && this.state.operationId === operationId &&
      this.state.pending.size === 0 && sdkActiveJobs === 0 && telemetryActiveCalls === 0;
  }
  private assertSupervisor(ref: SupervisorRef): void {
    if (ref.pid !== this.supervisor.pid || ref.bootId !== this.supervisor.bootId) throw new Error("supervisor mismatch");
  }
}
```

`changed` is required in packaged mode and synchronously persists the **complete** snapshot before committing a transition. Inject an explicit no-op only in in-memory unit fixtures. A failed reservation write retains the attempted unresolved entry, rejects that request without calling accept, and latches closed admission even if the next write succeeds. A failed close retains its operation owner; a failed completion/prune keeps the prior unresolved job/child; a failed release retains closed admission and the same owner. `refresh`/status/heartbeat never clear `persistenceFault`; fresh status must classify it `persistence-fault`, not return a successful quiescence or open-admission result. Recovery is the explicit same-owner `release`: first persist the entire retained **closed** state, then durably finalize that operation, then persist open state before acknowledging. None of these steps clears unresolved jobs. An unowned fault can be claimed by close/release under the instance operation lock; a different existing owner cannot be replaced. Any failing step keeps the fault/owner and reports `maintenance-unresolved` before signals. Do not swallow `changed` failures; record sanitized failure classes, and retry persistence of the latched snapshot on subsequent refreshes without clearing the latch. If even diagnostics cannot be written, the fresh acknowledgement is unavailable, never inferred from the older on-disk snapshot. Once a callback starts, request reservation and gate changes are serialized by the same supervisor event loop.

`childPids` means observed children whose exit has **not yet been verified**, not lifetime history. Once per second, use the injected read-only process adapter to build `verifiedAbsent`: only a successful process census proving the PID absent qualifies; permission/parse/command errors, a still-present or reused PID, and elapsed time do not. Apply pruning synchronously against the current ledger and never remove any PID still referenced by an unresolved job, even when the process is absent. Completed children still present remain listed for Task 7's shutdown census; genuine completion plus verified exit permits pruning. `fits` reserves all future entry expansion before accepting each request, so both unresolved diagnostics and completed-but-not-exited PIDs fit without truncation. Capacity exhaustion rejects **new** requests with `tracking-capacity`; it never evicts existing entries. This bounded admission guard has no operator override/configuration and recovers capacity only through genuine completion and verified-exit pruning. The admission ledger retains all unresolved jobs independently of display convenience.

- [ ] **Step 2:** Implement a private filesystem mailbox, avoiding Unix-socket pathname limits for long/symlinked macOS homes. It lives at `<canonical instance>/.hive-state/voice-worker/<bootId>/`, with mode 0700 directories and 0600 JSON files, never under `.hive`.

Protocol types in `maintenance-ipc.ts`:

```typescript
import type { AdmissionSnapshot, SupervisorRef } from "./admission.js";
export type MaintenanceCommand = {
  protocol: 1; requestId: string; operationId: string; supervisor: SupervisorRef;
  kind: "close" | "release" | "status";
};
export type JobEvent = {
  protocol: 1; eventId: string; supervisor: SupervisorRef;
  jobId: string; childPid: number; sequence: 1 | 2;
  kind: "entered" | "completed";
};
export interface MaintenanceReply {
  protocol: 1; requestId: string; operationId: string; supervisor: SupervisorRef;
  ok: boolean; classification?: string; snapshot: AdmissionSnapshot; writtenAt: number;
}
```

File layout and ownership:

| Path | Writer | Contents/reader rule |
| --- | --- | --- |
| `.hive-state/voice-worker/current.json` | supervisor | protocol, supervisor PID/bootId, boot time, canonical state directory, configured SDK host/port and instance ID; no credentials |
| `<bootId>/commands/<requestId>.json` | lifecycle process | one immutable command; random UUID filename; consumer validates exact body/filename and ref |
| `<bootId>/replies/<requestId>.json` | supervisor | fresh reply after mutation, snapshot and command receipt have been durably written; matching operation/request/ref required |
| `<bootId>/command-receipts/<requestId>.json` | supervisor | immutable validated command body and applied outcome; reject conflicting reuse; retain until command deletion and directory fsync succeed |
| `<bootId>/finalized/<operationId>.json` | supervisor | immutable protocol/supervisor/operation terminal fence; release writes this before opening admission; retain for the entire supervisor boot |
| `<bootId>/jobs/<eventId>.json` | job child | entered sequence 1 or completed sequence 2; no call metadata/transcripts/numbers |
| `<bootId>/snapshot.json` | supervisor | latest ledger plus supervisor identity and liveness timestamp |
| `.hive-state/deployment/operation.json` | locked lifecycle process | barrier ownership retained across interruptions, described in Task 8 |

Use this atomic write function, with caller-provided paths restricted to validated UUID filenames and the owned directory:

```typescript
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    renamed = true;
    fsyncSync(directoryFd);
  } catch (error) { errors.push(error); }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { errors.push(error); }
    }
    if (tempCreated && !renamed) {
      try { unlinkSync(temp); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
      }
    }
    if (directoryFd !== undefined) {
      try { closeSync(directoryFd); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, "atomic state write failed");
}
```

Validate `.hive-state`, boot directories and mailbox entries with `lstat`/realpath before use: reject a symlinked state child, wrong owner, non-regular message file, file above 16 KiB, bad protocol/UUID, unknown kind or a ref that differs from this supervisor. Resolve an intentional symlink of the **instance home** once, then require all state descendants to remain within that real root. Bind mailbox creation and snapshot initialization before SDK workers can fork. Do not place credential values in these records. Check UTF-8 serialized size before each mailbox write as well as before reads; snapshot reservation leaves 4 KiB for the strictly bounded envelope, classification and liveness fields. Receipt files contain command/event identity and outcome, not another full snapshot. Never truncate unresolved entries to make a reply fit. Directory creation and consumed-message/receipt deletion also fsync their parent directory; do not claim durable deletion while unlink/fsync failed. If atomic rename succeeded but directory fsync failed, leave the target for reconciliation and classify the write as failed; never undo it by blindly deleting the destination. Temp cleanup is best effort with failures retained in the thrown aggregate, so cleanup cannot hide the primary write failure.

The supervisor polls every 50 ms, draining job events in `(jobId, sequence)` order before commands; it also publishes liveness at least every second. Processing is synchronous between timer callbacks so close and request reservation cannot interleave inside a mutation. Use the following command state machine after structural/ref validation; these are the only production callers of ledger close/release. `FinalizedOperations` reads/writes the boot-local `finalized` files above using atomic writes; an existing exact marker is idempotent after revalidating its contents and fsyncing its parent directory, conflicting/corrupt/unreadable state is uncertainty rather than absence. Only ENOENT means not finalized.

```typescript
export interface FinalizedOperations {
  has(operationId: string): boolean;
  finalize(operationId: string, supervisor: SupervisorRef): void;
}
export function applyMaintenance(
  command: MaintenanceCommand, ledger: AdmissionLedger, finalized: FinalizedOperations,
): AdmissionSnapshot {
  const snapshot = ledger.snapshot();
  if (snapshot.supervisor.pid !== command.supervisor.pid ||
      snapshot.supervisor.bootId !== command.supervisor.bootId) throw new Error("supervisor mismatch");
  switch (command.kind) {
    case "close":
      if (finalized.has(command.operationId)) throw new Error("operation-finalized");
      return ledger.close(command.operationId);
    case "release":
      if (finalized.has(command.operationId) && snapshot.operationId === null && !snapshot.persistenceFault) {
        // Already terminal and open: duplicate release does not close/reopen admission.
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
```

Import `AdmissionLedger` as a value in this module in addition to the two type imports. `MaintenanceReply.operationId` is **always the requesting operation's correlation ID**, including release and open status. Only `MaintenanceReply.snapshot.operationId` describes gate ownership and becomes null when the gate is open. No reply with `snapshot.persistenceFault: true` can have `ok: true`. A successful release reply requires `snapshot.admission === "open"`, `snapshot.operationId === null`, `snapshot.persistenceFault === false` and the matching durable finalized-operation marker. A successful close requires closed admission, the matching owner and no persistence fault. An ordinary status reply reports current ownership/fault state; **even a fresh open status cannot prove that a delayed close will never execute**.

Release is terminal cancellation for that operation on that boot, including when admission is open and no close has been observed. It first claims/persists closed ownership, durably writes the finalization marker, then persists open admission. The finalization marker rejects every later close with `operation-finalized`, including a close with a different request UUID. A release that fails after writing its marker is retryable by the same operation and retains its closed fault/owner until reconciled. Release from a different current owner is an ownership error and never opens that owner's gate. Retain every finalization marker for the entire boot: no TTL or fixed-count eviction may re-enable an old close. Markers are separate small files, not accumulated in snapshots/replies or an unbounded in-memory cache. Old boot state may be cleaned only after independently proving that supervisor/tree exited and no retained lifecycle operation needs its evidence.

Before applying a command, validate any existing receipt against the **entire immutable command**; conflicting request-ID reuse is invalid. Check the terminal fence before replaying any close receipt so a pre-release close acknowledgement can never be returned as current closed-gate evidence. A matching applied close receipt causes no second mutation; reply from a freshly persisted current snapshot, with success only if that operation still owns a nonfaulted closed gate. Status always refreshes current state. Release retries use the idempotent terminal cancellation above to reconcile any fault left by the first attempt, never reopen another owner's gate. After a first application, durably persist its bounded receipt, write the fresh reply, then delete the command and fsync its directory before collecting the receipt. If unlink or its directory fsync fails, retain the receipt and retry cleanup; a surviving command must not be reapplied. Transport retries preserve the request UUID/body. An interrupted receipt/reply write retains the command, latches `faultClosed(command.operationId)` before further requests, and reports a sanitized persistence failure; repeated failures keep the same in-memory owner/fault even if the diagnostic write fails. A serialized command is never acknowledged from an older snapshot or cached reply. Corrupt/invalid/ref-mismatched messages only produce sanitized diagnostics and cannot select or steal an operation owner.

Event application is idempotent: retain event-ID receipts containing exact ref/job/PID/sequence/kind until the corresponding message has been durably deleted; if replayed after a completed job, verify the receipt rather than reapply completion. Write the receipt as part of the event's snapshot persistence callback before committing the mutation; a snapshot/receipt failure therefore retains the unresolved entry and command processing observes a latched fault. A receipt found on retry is only applied evidence when the same live ledger already reflects that transition; if the prior commit faulted, reapply the matching still-unresolved transition, never drop it from a receipt alone. Do not evict receipts while messages remain merely to meet a count bound. Keep receipt files out of reply snapshots; reap completed receipts after durable message deletion. This prevents retry from turning valid completion into an unknown-job error while preserving uncertain work.

The supervisor should not auto-open a barrier merely because a timer expires or the client disappears: expiration might overlap launchd shutdown. The next lifecycle invocation reconciles the recorded operation with the current PID/boot as specified in Task 8. Requests remain rejectable until release has durably reconciled/finalized the owner; lifecycle may report resumed admission only after its matching successful release reply.

Job children inherit **only local identity additions** before `cli.runApp`: `HIVE_VOICE_SUPERVISOR_PID`, `HIVE_VOICE_SUPERVISOR_BOOT_ID`, `HIVE_VOICE_STATE_DIR`. Existing LiveKit auth environment inheritance remains unchanged. These variables do not select a different instance or secret store. Child event writer validates its local environment, job ID, own PID and state containment and writes entered/completed atomically. Missing/invalid tracking state in a packaged worker fails before starting call work; developer/source runs can explicitly use a local in-memory reporter, but no packaged acceptance mode may disable tracking.

- [ ] **Step 3:** Export the shared `requestMaintenance` client from `maintenance-ipc.ts` with exact matching and a hard supplied deadline; Task 8 imports this same implementation. Use a new UUID for each logical command, record its initial request timestamp, poll its one reply at 50 ms, and preserve UUID/body on transport retries. Require same protocol, request/correlation operation ID, PID/boot, reply timestamp at or after the initial request, `ok: true`, `persistenceFault: false`, and expected snapshot admission/ownership. Verify live launchd PID/process identity independently before trusting current.json, before close, and immediately before stop. A fresh file from an old boot cannot pass. Do not reissue close after starting release; a new maintenance attempt uses a new operation UUID only after the previous release is acknowledged/reconciled.

Close/status polling shares the **same** 30-second maintenance deadline. Abort release has a separate bounded 2-second acknowledgement budget so a timeout can be reported safely. Do not reset the 30 seconds per request. On every abort after recording a barrier request, send release for that exact operation/supervisor even when close timed out or fresh status says open. Require its terminal successful release reply before clearing the lifecycle marker or reporting availability restored; status alone never finalizes the operation. If release acknowledgement is missing, faulted or mismatched, retain operation/barrier ownership and report `maintenance-unresolved`; leave services/artifacts intact. The next locked invocation retries the same release against the same live boot. Before signals, status must confirm the still-owned closed gate with no persistence fault/unresolved jobs; a reply for a finalized operation cannot establish quiescence.

- [ ] **Step 4:** Expose diagnostics for unresolved entries in CLI/probe output: job ID, supervisor PID/boot, accepted timestamp/age, phase and observed child PID if available. In particular, `accepted-awaiting-entry` after assignment/prewarm/import failure and `entered-awaiting-completion` after lost acknowledgement remain unresolved until the genuine completion path settles them. SDK job-count zero, assignment timeout, dead child, stale heartbeat or elapsed time **never** clear these records. A planned lifecycle operation defers; this ticket introduces no `--force`, ledger-clear or call-termination flag. An operator can investigate retained state; a separate incident recovery decision is not disguised as a normal update.

- [ ] **Step 5:** Verify and checkpoint the S4 ledger/transport slice; consumer rendering remains assigned to S6/S7. The matrix below also names consumer behavior: assertions that lifecycle sends release, resolves cleanup or clears its operation record are added to `src/deployment/lifecycle.integration.test.ts` and run with Task 9 Step 5 in S9 against the actual Task 8 orchestration. S4 tests the protocol/ledger side of those cases without importing future lifecycle code.

```bash
npx vitest run src/voice-worker/admission.test.ts src/voice-worker/maintenance-ipc.integration.test.ts
```

Minimum cases: close/release/status happy path; request-after-close rejection; reserve-before-accept; duplicate job ID; completion from wrong boot/job/PID; sequence 2 before sequence 1 file order; idempotent event replay; ledger-write/command/reply failure; stale current/reply; request-owner conflict; second instance; special-path/symlink home; missing entry/completion; timed-out release; retained unresolved diagnostics. These S4 IPC tests call the exported shared client and verify import alone starts no polling, creates no state and invokes no process/config lookup; S8 checks its compiled transitive bundle closure, and S9 exercises it through the real frozen helper. Add these regression assertions using injected filesystem/process adapters and a deterministic mailbox clock:

| Scenario | Required assertions |
| --- | --- |
| close command survives failed unlink, then release succeeds | replay original close and a new-request-ID close for that operation; admission stays open, owner stays null, response is `operation-finalized`; a new operation may close normally |
| close delayed beyond timeout; status overtakes it and reports open | lifecycle still sends release, persists finalization, and only then resolves cleanup; deliver delayed close after release and prove it cannot close admission |
| release arrives before close; release response is lost; repeated release/status/close are reordered | same-operation release is idempotent, status alone never resolves abort, terminal fence wins over old close receipt, and another operation's closed gate is untouched |
| one-shot reservation write failure, then successful writes | first request reject exactly once/accept zero; unknown reservation retained; second request rejected; fresh status has closed/faulted state and cannot authorize stop; explicit release persists retained state and opens only after finalization |
| fail close write, terminal-marker write, release closed-state write or release open-state write separately | same owner and closed/faulted gate survive; fresh successful refresh does not clear the latch; release retry reconciles without deleting jobs; no signal/bootout/drain occurs |
| completion snapshot/receipt failure, or event deletion failure | unresolved entry survives failed commit; a receipt alone cannot clear it; matching retry completes once; a consumed-event replay never clears another job or errors as unknown |
| 4,000 accept/enter/complete/verified-exit cycles in one supervisor boot | every reply stays below 16 KiB, completed-child storage does not grow with cycles, and subsequent close/status/release succeeds; repeat while retaining one unresolved job and prove its full entry/PID survives |
| completed child still present/unknown, unresolved child absent, or tracking capacity exhausted | no unverified/unresolved PID pruned; new oversized request rejected before accept; existing jobs/diagnostics unchanged; completing and verifying exits restores capacity without a force flag |
| write, file fsync, close, rename, directory fsync and cleanup failures | pre-rename failure leaves old target intact; temps removed when cleanup succeeds; after-rename fsync failure is uncertain and never acknowledged; all opened descriptors are closed; cleanup error preserves primary error |
| release and open-status correlation | top-level operationId equals request operation UUID, nested snapshot.operationId is null, and only successful terminal release clears the lifecycle record |

Expected: both Vitest files exit 0 with every S4 protocol/ledger case executed; the assigned lifecycle/marker cases must also pass in S9 before Task 4 completion. No test calls drain or signals a real worker.

## Task 5: Wire tracking and immutable boot evidence without altering conversation logic

**Files:** Reuse `src/voice-worker/job-lifecycle.ts` and its tests from S0; modify `main.ts`, `telemetry.ts`, `worker-config.ts`, `src/index.ts`, and related tests.

**Schedule:** S5 executes Steps 2–6 after release/identity helpers (S1), `WorkerConfig.healthPort` (S2), service process adapters (S3) and the mailbox/reporter (S4) exist. Step 1 is preserved Task 1 code. No packaged artifact is needed for the source/SDK-fixture checks at this checkpoint.

- [x] **Step 1:** Use this complete entry/cleanup envelope in `job-lifecycle.ts`. It registers shutdown tracking before configuration, metadata parsing, Mongo connection or session work. SDK callback concurrency is handled by an explicit cleanup promise; entry return does not imply job completion.

```typescript
import type { JobContext } from "@livekit/agents";
function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
export interface JobReporter { entered(): void; completed(): void }
export async function withJobLifecycle(
  ctx: Pick<JobContext, "addShutdownCallback">,
  reporter: JobReporter,
  work: (hooks: {
    delegateCleanup(): () => void;
    setEarlyCleanup(cleanup: () => Promise<void>): void;
  }) => Promise<void>,
): Promise<void> {
  const entrySettled = latch();
  const cleanupDone = latch();
  let delegated = false;
  let earlyCleanup = async (): Promise<void> => {};
  ctx.addShutdownCallback(async () => {
    await entrySettled.promise;
    if (delegated) await cleanupDone.promise;
    else await earlyCleanup();
    reporter.completed();
  });
  try {
    reporter.entered();
    await work({
      delegateCleanup() {
        delegated = true;
        return cleanupDone.resolve;
      },
      setEarlyCleanup(cleanup) { earlyCleanup = cleanup; },
    });
  } finally {
    entrySettled.resolve();
  }
}
```

If ordered session teardown rejects before its final hook, cleanup remains unresolved and the reporter cannot claim completion; the SDK may eventually terminate the job, but maintenance still defers. `completed()` writing unsuccessfully also leaves the supervisor ledger unresolved. These conservative outcomes are intentional and must be diagnostic, never swallowed as proof of safety.

- [ ] **Step 2:** In `main.ts`, keep the existing exported symlink-safe `isEntrypoint` guard. Make config/session/telemetry imports lazy inside supervisor boot/agent entry so the SDK can import/prewarm the packaged default export without loading secrets. Do not move the SDK's dynamic process modules into the bundle. Replace only the default entry implementation with this block, adding the indicated pure tracking imports at module scope:

```typescript
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const reporter = createJobReporter(ctx.job.id);
    await withJobLifecycle(ctx, reporter, async (hooks) => {
      const { loadWorkerConfig } = await import("./worker-config.js");
      const { runCallSession } = await import("./session.js");
      const { VoiceWorkerHeartbeat } = await import("./telemetry.js");
      const wc = loadWorkerConfig();
      const meta = parseDispatchMetadata(ctx.job.metadata);
      const cell = resolveCell(meta, wc);
      const mongo = new MongoClient(wc.mongoUri);
      hooks.setEarlyCleanup(() => mongo.close());
      await mongo.connect();
      const heartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
        defaultStt: wc.defaultStt, defaultTts: wc.defaultTts,
      });
      const cleanupFinished = hooks.delegateCleanup();
      await runCallSession(ctx, wc, meta, cell, heartbeat, async () => {
        await mongo.close();
        cleanupFinished();
      });
    });
  },
});
```

`createJobReporter` comes from `maintenance-ipc.ts`; `withJobLifecycle` from `job-lifecycle.ts`. The existing `session.ts` callback remains `releaseCall → flush → closeMongo`; no new sibling callback can race Mongo close. Do not alter STT/TTS, warm execution, speech handling, logging metrics or per-agent routing. The new wrapper adds one lifecycle callback but does not call `ctx.connect`, `ctx.shutdown`, or change a successful call's entry-return semantics.

- [ ] **Step 3:** Supervisor boot derives the release/boot identity from its actual module before writing heartbeat. After config load and before SDK creation: create the mailbox and ledger; export supervisor tracking refs for children; log the release/boot identity; write and start the heartbeat; call SDK CLI with:

```typescript
cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: "hive-voice",
  host: "127.0.0.1",
  port: wc.healthPort,
  requestFunc: (request) => ledger.request(request),
  ...livekitServerAuth(wc),
}));
```

Preserve `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` export into worker-process env for SDK children. Reuse current shared secret resolution. Leave production CLI signal behavior intact; maintenance never calls it until quiescence is established. On supervisor boot failure, log only the existing named failure class and exit nonzero. Register timer/resource cleanup on exit without reopening a closed gate. The SDK's `/` and `/worker` are the existing public listener; mailbox adds no network listener.

- [ ] **Step 4:** Extend `VoiceWorkerHeartbeat` constructor with an **optional** fourth `supervisorIdentity?: BootIdentity` argument after existing `intervalMs`. Supervisor `writeBoot` and `writeOnce` add `supervisorIdentity` and `supervisorUpdatedAt: new Date()` only when this argument is present. Job instances do not supply it. Do not overwrite these fields from noteCallStarted/noteCallEnded/noteError, even though those methods currently update the separate legacy `updatedAt` field. Keep counter `$inc`, boot ghost-call reset, error preservation and existing default-cell behavior unchanged.

Use `supervisorUpdatedAt`, not `updatedAt`, for new readiness freshness. Keep `updatedAt` for legacy display only. Tests must prove that fresh job writes cannot refresh a dead supervisor and that an old supervisor identity is not replaced by a child.

- [ ] **Step 5:** In `src/index.ts`, locate the existing `Hive starting up` and `Hive is running` log calls and attach the same boot identity object created once at process startup. Emit a separate structured release boot line if needed, but preserve both marker strings and their order. Scope each marker with `pid`, `bootId`, source revision/version/lock digest and component. Write a local identity record under `.hive-state/runtime/engine.json` with PID/boot/start time for observed identity lookup; health must still corroborate live launchd/OS evidence and fresh ordered log markers.

Packaged entrypoints require their manifest. Source/developer entrypoints remain startable: explicitly classify their identity as `source/unavailable` with actual PID/boot, never apply an unrelated existing `pkg/release.json` to a `src`/`dist` process. The release helper identifies the actual canonical entrypoint, not cwd. A missing manifest from a `.hive/pkg` service is a startup failure.

- [ ] **Step 6:** Verify the wrapper and telemetry boundary before committing.

```bash
npm run build
npx vitest run src/voice-worker/job-lifecycle.test.ts src/voice-worker/main.test.ts src/voice-worker/telemetry.test.ts src/voice-worker/session.test.ts src/voice-worker/sdk-lifecycle.integration.test.ts
npm run typecheck
```

Minimum assertions: pre-config/metadata/Mongo failure; early cleanup completes only during shutdown; entry normal return stays unresolved; session cleanup ordered before completion; thrown cleanup prevents completion; SDK concurrent callbacks cannot close Mongo early; production import does not start supervisor/load config; same boot identity persists under child counters. Existing symlink and conversation/session tests remain passing.

## Task 6: Configuration, no-call health and doctor evidence

**Files:** Create `src/deployment/ports.ts`, `src/deployment/ports.test.ts`, `src/deployment/runtime-probe.ts`, `src/deployment/health.ts`, `src/deployment/health.test.ts`. Modify `src/config.ts`, `src/voice-worker/worker-config.ts`, `src/cli/doctor.ts`, `src/cli/doctor-checks.ts` and tests.

**Schedule:** S2 implements Step 1 plus its ports/worker-config unit cases before Task 5 needs `healthPort`. S6 implements Steps 2–5 plus the local health/doctor/bridge cases in Step 6, after Task 7/S3 supplies `buildServiceEnvironment`, the shared dotenv resolver and OS adapters. S6 builds probe source; real packaged probe execution waits for S8/S9. Add and run Step 6's transaction closed-gate propagation cases in S9, after transaction source and the artifact exist; Task 6 is not fully complete until then.

- [ ] **Step 1:** Resolve the new listener without changing existing ports. Pure helper:

```typescript
export function voiceWorkerPort(base: unknown, override: unknown): number {
  const portBase = base === undefined ? 3100 : base;
  if (!Number.isSafeInteger(portBase) || typeof portBase !== "number") throw new Error("invalid instance.portBase");
  const port = override === undefined ? portBase + 7 : override;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid instance.ports.voiceWorker");
  }
  return port;
}
export function assertWorkerPortAvailableInConfig(workerPort: number, listeners: Record<string, number>): void {
  for (const [name, port] of Object.entries(listeners)) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ${name} port`);
    if (port === workerPort) throw new Error(`voiceWorker port collides with ${name}`);
  }
}
```

Add `voice.workerPort: voiceWorkerPort(hive.instance?.portBase, ports.voiceWorker)` in `config.ts`; add `healthPort: config.voice.workerPort` in `WorkerConfig`. When LiveKit is enabled, validate against **actual resolved** existing config ports, including legacy environment/Keychain overrides: background task, meeting/recall, code task, WebSocket, admin API, voice bridge and Slack internal. Use `{ background: config.background.port, recall: config.recall.monitorPort, codeTask: config.codeTask.port, ws: config.ws.port, adminApi: config.adminApi.port, voice: config.voice.port, slackInternal: config.slackInternal.port, beekeeper: config.beekeeper.port }` after config construction. Include any additional actual resolved listener found during source integration. Do not invent `portBase+5` as bridge truth if `VOICE_PORT` overrides it. Validate candidate config and existing service-owned sockets before any plist mutation. A foreign owner fails preflight; no kill command is permitted.

The secret-free YAML reader used for CLI identity should report configured worker port as a planning hint only. A candidate `runtime-probe config` under the intended service environment supplies authoritative resolved listeners/config compatibility. Voice-disabled flow never calls loadWorkerConfig or a vendor probe; it still identifies and quiesces an already-running stale worker using that supervisor's recorded port/config selection before removal.

- [ ] **Step 2:** Implement a packaged `runtime-probe.min.js` with explicit `config`, `bridge`, `worker`, `outbound` modes and JSON output. It uses dynamic config imports only inside selected modes. Every corresponding probe subprocess must use Task 7's shared `buildServiceEnvironment` from `src/deployment/services.ts`, with exactly the intended service's explicit HOME/PATH/HIVE_HOME/HIVE_CONFIG and captured, validated non-secret overrides, including `VOICE_PORT`. Deep-compare the probe environment with the generated service environment before importing config; they must match. Never spread an interactive shell's secret environment into a launchd-compatibility test. Normal service secrets come from matching dotenv/Honeypot through Task 7's basename-correct `resolveDotenvPath`. Request/response output is whitelist-only.

| Mode | Required behavior | Forbidden behavior |
| --- | --- | --- |
| config | resolve shared config/secret names, instance ID, database identity, actual listener ports, voice flags; report missing key **names** and sanitized compatibility | echo credentials, full Mongo URI, env dictionary, model turn, vendor request |
| bridge | use resolved bridge token internally for three POST `{}` requests; correct token must return known missing-agent 400; absent/wrong token denied with 401 or existing 403; report booleans/status/classification | print token/headers, call GET /health with bridge credentials, send messages or agent IDs |
| worker | local SDK GET `/` and `/worker`, supervisor identity/heartbeat age, ledger snapshot, current socket-owner confirmation supplied by trusted OS adapter | treat `/worker` 200 or heartbeat alone as registered/readiness |
| outbound | explicitly requested read-only LiveKit authentication and outbound trunk lookup, routing/config relationship checks, sanitized ID/existence result | createDispatch, createRoom, createSipParticipant, trunk mutation or real call |

Bridge implementation uses `fetch` with `AbortSignal.timeout(2000)`, the loopback URL already produced by `loadWorkerConfig`, `Content-Type: application/json`, `Authorization: Bearer <in-process token>`, `body: "{}"`. For wrong-token probe use a newly generated random value, not a modified real token. Require JSON `{ error: "call.metadata.hive_agent_id required" }` from the correct-token probe, matching `voice-adapter.ts:184`; an arbitrary 400 is failure. Tests inject a spawn spy at the adapter boundary and assert zero calls in all three requests. Do not log error response bodies that could contain provider data.

Outbound lookup uses `livekit-server-sdk`'s installed `SipClient` and `listSipOutboundTrunk()` as already used by `scripts/livekit-setup.ts:58`; select the configured `sipTrunkId` and compare existing configured number/trunk-domain relationships without creating or altering SIP objects. An unknown/missing trunk or auth failure fails explicit deployment acceptance. Ordinary doctor does not run this network mode. If the exact SDK cannot expose a required relationship, record a concrete read-only evidence gap; do not fabricate a match.

- [ ] **Step 3:** Implement health classification as a conjunction of independently gathered evidence. Main exported type/function:

```typescript
import type { BootIdentity, Release } from "./release.js";
import type { AdmissionSnapshot } from "../voice-worker/admission.js";
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
function sameRelease(a: Release, b: Release): boolean {
  return a.packageVersion === b.packageVersion && a.sourceRevision === b.sourceRevision &&
    a.dependencyLockSha256 === b.dependencyLockSha256 && a.sourceDirty === b.sourceDirty;
}
export function packagedHealthy(e: PackagedEvidence): boolean {
  if (!sameRelease(e.installed, e.engine.release) || !e.engineAlive || !e.processPathsMatch ||
      !e.configSelectorsMatch || !e.freshOrderedEngineMarkers || !e.dependenciesContained) return false;
  if (!e.voiceEnabled) return true;
  return e.worker !== null && sameRelease(e.installed, e.worker.release) && e.workerAlive &&
    e.admissionSnapshot !== null && e.admissionFresh &&
    e.admissionSnapshot.supervisor.pid === e.worker.pid &&
    e.admissionSnapshot.supervisor.bootId === e.worker.bootId &&
    e.admissionSnapshot.admission === "open" && e.admissionSnapshot.operationId === null &&
    e.admissionSnapshot.persistenceFault === false &&
    e.heartbeatFresh && e.heartbeatMatchesSupervisor && e.sdkRootStatus === 200 &&
    e.sdkAgentName === "hive-voice" && e.sdkSocketOwned && e.bridgeAuthenticated &&
    e.bridgeMissingDenied && e.bridgeWrongDenied;
}
```

Evidence constructors additionally verify protocol/schema, boot ID equality to the expected activation, process PID/start-time match, finite timestamps no more than five seconds in the future, current supervisor heartbeat no older than 60 seconds, and record created after the captured activation boundary. A fabricated structurally valid BootIdentity is not sufficient. Engine marker scanner reads only post-bootstrap bytes, handles truncation as uncertainty/failure, requires starting-before-running for the current PID/boot, and verifies that same PID remains live at the final check. Plain heartbeat timestamp `updatedAt` cannot satisfy a packaged heartbeat.

For enabled-worker activation, gather `admissionSnapshot` through a new correlated Task 4 `status` request during the current health window. Set `admissionFresh` only after validating the fresh successful reply's protocol, request/correlation operation ID, timestamp at or after that request, supervisor PID/boot and independently corroborated live process identity; require open admission, null snapshot owner and no persistence fault. A saved snapshot, cached reply or heartbeat cannot substitute for this acknowledgement. Missing, stale, wrong-supervisor, maintenance-owned or persistence-fault evidence fails activation even when all SDK, bridge and process checks pass. Update every evidence constructor/caller and healthy fixture with these required fields; voice-disabled fixtures use `admissionSnapshot: null, admissionFresh: false`. This status check does not replace Task 4's terminal release acknowledgement when reconciling a prior barrier.

Engine and worker receive independent bounded retries: 3 × 30-second windows, with 10 seconds between windows (maximum 110 seconds each). Start engine, await its fresh boot, start worker, await registration and paired evidence. Per-request/probe timeouts must fit within each absolute window; nested retries cannot extend the contract. A worker whose heartbeat is fresh but whose SDK root is 503 never passes.

- [ ] **Step 4:** Implement `pilotRecovered` separately with no calls to `packagedHealthy` and no new-manifest requirement. Required true booleans: captured engine/worker live identities and effective arguments match, working directory/config selectors match, executable hashes match, dependency canonical paths and locked versions match, fresh engine marker pair scoped to recovered PID, bridge correct/absent/wrong probes pass from the recovered environment, SDK root 200 and agent `hive-voice` at the captured **legacy** listener, verified socket owner, current registration after recovered startup. Return `legacy/unavailable` for manifest/release boot ID/supervisor identity fields absent in the pilot. If fresh log scoping cannot be established for the captured runtime, fail recovery verification; never accept stale lines.

The legacy probe runs from retained candidate tooling **with the captured pilot loader/config environment**, and resolves dependency/executable evidence against the captured pilot paths. For the inventoried `dist/voice-worker/main.js` pilot, dynamically import the captured, hash-verified sibling `dist/voice-worker/worker-config.js` in an isolated subprocess and use its `loadWorkerConfig()` result for the no-turn bridge probe; this preserves the actual pilot loader and dependency resolution. Capture/validate this module path before cutover. If the pilot lacks a usable captured loader, leave recovery verification blocked rather than silently substitute candidate config semantics. Do not pretend the helper's own candidate imports prove the pilot's imports. OS open-file/process evidence and preserved pilot package/lock hashes provide that comparison. Valid legacy recovery establishes usable recovery only; final acceptance always requires packagedHealthy after reapply. [Chunk 4 Task 9 Step 4b and Task 8 Step 5a](./kpr-463-plan-pilot.md) define the serialized capture, strict registration/current readback, sealed loader/dependency closure, activation log fences, OS corroboration and concrete pilot probe/reconstruction adapters completing this step in S7; S9 exercises their actual bundled boundary. [Chunk 5](./kpr-463-plan-pilot-boundaries.md) supplies the sealed first-capture subject and exact supported historical packaged-probe ABI; old config/bridge/worker outputs are not a loader/inventory API.

- [ ] **Step 5:** Extend doctor voice output to display installed package identity separately from observed engine/worker identity. Add optional supervisor fields to `VoiceWorkerStatsRow` and preserve unavailable legacy state. Print registration/health and unresolved-maintenance classification without changing the existing doctor policy that only datastore identity failures affect the exit code. Use local probes by default; outbound is explicit via deployment acceptance. Secret values must never appear in fixture snapshots/output.

- [ ] **Step 6:** Verify the S6 local evidence boundary with the command below. The ports/loader subset already checked S2; the separate transaction propagation requirement below is completed in S9.

```bash
npx vitest run src/deployment/ports.test.ts src/deployment/health.test.ts src/voice-worker/worker-config.test.ts src/voice-worker/telemetry.test.ts src/cli/doctor-checks.test.ts src/cli/doctor.test.ts src/channels/voice/voice-adapter.test.ts src/channels/voice/voice-adapter.integration.test.ts
```

Expected: all pass. Require negative cases for stale prior logs, wrong PID/start time/boot/revision, foreign listener, missing/malformed heartbeat, future timestamp, `/worker` 200 with `/` 503, unknown active-call telemetry, valid token denied, arbitrary 400, disabled voice missing keys, explicit health-port collision, legacy-only fields missing, legacy recovery falsely labeled packaged. With all other enabled-worker evidence healthy, require `packagedHealthy` to return false separately for a persistence-faulted closed gate with null owner, a maintenance-owned closed gate without a persistence fault, missing/stale admission evidence, and a mismatched snapshot supervisor PID/boot. Require true for a fresh corroborated open/null-owner/fault-free snapshot, without imposing an idle-job condition on normal activation. In S9, the transaction health fixture must propagate each closed-gate failure into failed activation/checked recovery, never a healthy result. Checkpoint the S6 worker/evidence and Task 3 diagnostic sources after self-review, fresh build and passing local tests; next is S7 lifecycle source integration. This checkpoint does not claim the S8 artifact or S9 integration gates.
