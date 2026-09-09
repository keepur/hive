import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import {
  BUILTIN_CATALOG_PROVIDERS,
  type CatalogProvider,
  type DiscoveryAttempt,
  type DiscoveredModel,
  type SafeCatalogError,
} from "./model-catalog-types.js";
import { CatalogError, safeError } from "./model-catalog-value.js";
import type { ModelCatalogStore } from "./model-catalog-store.js";
import { catalogDue, catalogTiming } from "./model-catalog-status.js";

export const MAINTENANCE_INTERVAL_MS = 60_000;
export const ATTEMPT_LEASE_MS = 120_000;
export const SHUTDOWN_DRAIN_MS = 5_000;
type Store = Pick<
  ModelCatalogStore,
  "readCatalogState" | "beginDiscoveryAttempt" | "applyDiscovery" | "failDiscoveryAttempt" | "recoverPendingExports"
>;
type Discover = (provider: CatalogProvider, options: { signal: AbortSignal }) => Promise<DiscoveredModel[]>;
type Pending = { attempt: DiscoveryAttempt; phase: "begin" | "apply" | "failure" };
type Lane = {
  startup: boolean;
  invocation?: symbol;
  controller?: AbortController;
  task?: Promise<void>;
  pending?: Pending;
  watchdog?: Timer;
};
type Timer = ReturnType<typeof setTimeout>;
interface Timers {
  setInterval: (callback: () => void, ms: number) => Timer;
  clearInterval: (timer: Timer) => void;
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
}
interface Options {
  now?: () => number;
  uuid?: () => string;
  timers?: Timers;
  scanIntervalMs?: number;
  maintenanceIntervalMs?: number;
  leaseMs?: number;
  drainMs?: number;
  logger?: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
}
const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
export class ModelCatalogScanner {
  private readonly lanes = new Map<CatalogProvider, Lane>(BUILTIN_CATALOG_PROVIDERS.map((p) => [p, { startup: true }]));
  // One current diagnostic epoch per built-in lane and the export lane.
  // Fixed status/code combinations are retained only for its current UUID.
  private readonly diagnostics = new Map<string, { attemptId?: string; seen: Set<string> }>();
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly log: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
  private stopped = false;
  private started = false;
  private interval?: Timer;
  private recovery?: Promise<void>;
  private stopPromise?: Promise<void>;
  constructor(
    private readonly store: Store,
    private readonly discover: Discover,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.log = options.logger ?? createLogger("model-catalog-scanner");
  }
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.interval = this.timers.setInterval(() => {
      void this.tick();
    }, this.options.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS);
    this.interval.unref?.();
    void this.tick();
  }
  private report(provider: string, status: string, attemptId?: string, code?: string, recoveryPending = false): void {
    let diagnostic = this.diagnostics.get(provider);
    if (!diagnostic || diagnostic.attemptId !== attemptId) {
      diagnostic = { attemptId, seen: new Set() };
      this.diagnostics.set(provider, diagnostic);
    }
    const key = JSON.stringify([status, code, recoveryPending]);
    if (diagnostic.seen.has(key)) return;
    diagnostic.seen.add(key);
    const data = { provider, status, attemptId, code, recoveryPending };
    if (code) this.log.warn("Model catalog scanner status", data);
    else this.log.info("Model catalog scanner status", data);
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const tasks: Promise<void>[] = [];
    // Reserve every available lane before running any body or recovery sweep.
    for (const [provider, lane] of this.lanes) {
      if (lane.task) continue;
      const invocation = Symbol(provider);
      lane.invocation = invocation;
      lane.controller = new AbortController();
      const task = Promise.resolve()
        .then(() => this.runLane(provider, lane, invocation))
        .catch(() => {
          if (this.current(lane, invocation))
            this.report(provider, "storage-unavailable", lane.pending?.attempt.attemptId, "storage");
        })
        .finally(() => {
          if (lane.invocation === invocation) {
            if (lane.watchdog) this.timers.clearTimeout(lane.watchdog);
            lane.watchdog = undefined;
            lane.invocation = undefined;
            lane.controller = undefined;
            lane.task = undefined;
          }
        });
      lane.task = task;
      tasks.push(task);
    }
    if (!this.recovery) {
      const task = Promise.resolve()
        .then(async () => {
          if (this.stopped) return;
          const results = await this.store.recoverPendingExports();
          if (this.stopped) return;
          const pending = results.some((r) => r.kind !== "recovered");
          if (pending) this.report("*", "export-recovery-pending", undefined, "storage", true);
          else this.diagnostics.delete("*");
        })
        .catch(() => {
          if (!this.stopped) this.report("*", "export-recovery-pending", undefined, "storage", true);
        })
        .finally(() => {
          if (this.recovery === task) this.recovery = undefined;
        });
      this.recovery = task;
      tasks.push(task);
    }
    await Promise.allSettled(tasks);
  }
  private current(lane: Lane, invocation: symbol): boolean {
    return !this.stopped && lane.invocation === invocation && !lane.controller?.signal.aborted;
  }
  private usable(lane: Lane, invocation: symbol, attempt: DiscoveryAttempt): boolean {
    return this.current(lane, invocation) && attempt.leaseExpiresAt.getTime() > this.now();
  }
  private async fail(
    lane: Lane,
    invocation: symbol,
    attempt: DiscoveryAttempt,
    error: SafeCatalogError,
  ): Promise<void> {
    if (!this.usable(lane, invocation, attempt)) return;
    lane.pending = { attempt, phase: "failure" };
    try {
      const result = await this.store.failDiscoveryAttempt(attempt, error, new Date(this.now()));
      if (!this.current(lane, invocation)) return;
      lane.pending = undefined;
      this.report(
        attempt.provider,
        result.kind,
        attempt.attemptId,
        result.kind === "recorded" ? error.code : undefined,
      );
    } catch {
      if (this.current(lane, invocation))
        this.report(attempt.provider, "failure-record-unknown", attempt.attemptId, "storage");
    }
  }
  private async runLane(provider: CatalogProvider, lane: Lane, invocation: symbol): Promise<void> {
    if (!this.current(lane, invocation)) return;
    // Only an entered, uncertain apply consumes its proof. Begin/failure
    // uncertainty MUST NOT call placeholder apply on a possibly-ready proof.
    const pending = lane.pending;
    if (pending?.phase === "apply") {
      const result = await this.store.applyDiscovery(pending.attempt, []);
      if (!this.current(lane, invocation)) return;
      if (result.kind === "committed" || result.kind === "unchanged" || result.kind === "superseded") {
        lane.pending = undefined;
        this.report(
          provider,
          result.kind,
          pending.attempt.attemptId,
          undefined,
          result.kind === "committed" && result.recoveryPending,
        );
      } else this.report(provider, "commit-unknown", pending.attempt.attemptId, "storage");
    }
    if (!this.current(lane, invocation)) return;
    let state = await this.store.readCatalogState(provider);
    if (!this.current(lane, invocation)) return;
    let recovered = false;
    const unresolved = lane.pending;
    if (unresolved) {
      const scan = catalogTiming(state.snapshot, this.now()).scan;
      if (
        scan.attemptId === unresolved.attempt.attemptId &&
        (scan.outcome === "succeeded" || scan.outcome === "failed")
      ) {
        // Durable success is truthful even when unchanged reconciliation
        // cannot reconstruct the original saved snapshot identity.
        lane.pending = undefined;
        this.report(provider, `observed-${scan.outcome}`, unresolved.attempt.attemptId);
      } else if (unresolved.attempt.leaseExpiresAt.getTime() > this.now()) return;
      else {
        // A different persisted UUID can still be the predecessor of an
        // uncertain begin. It never resolves this identity before expiry.
        // A negative read after expiry permits only recovery + a new due
        // observation; it never means the earlier mutation did not happen.
        if (!this.current(lane, invocation)) return;
        await this.store.recoverPendingExports(provider);
        recovered = true;
        if (!this.current(lane, invocation)) return;
        state = await this.store.readCatalogState(provider);
        if (!this.current(lane, invocation)) return;
        lane.pending = undefined;
      }
    }
    let decision = catalogDue(state.snapshot, this.now(), lane.startup, this.options.scanIntervalMs);
    if (decision.consumeStartup) lane.startup = false;
    if (decision.recover && !recovered) {
      if (!this.current(lane, invocation)) return;
      await this.store.recoverPendingExports(provider);
      if (!this.current(lane, invocation)) return;
      state = await this.store.readCatalogState(provider);
      if (!this.current(lane, invocation)) return;
      decision = catalogDue(state.snapshot, this.now(), lane.startup, this.options.scanIntervalMs);
    }
    if (!decision.due) return;
    if (decision.consumeStartup) lane.startup = false;
    const startedAt = new Date(this.now());
    const attempt: DiscoveryAttempt = {
      provider,
      attemptId: (this.options.uuid ?? randomUUID)(),
      startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + (this.options.leaseMs ?? ATTEMPT_LEASE_MS)),
    };
    if (!this.current(lane, invocation)) return;
    lane.pending = { attempt, phase: "begin" };
    // A deadline reports unfinished work; it never releases the lane or
    // implies cancellation/noncommit of the underlying store operation.
    lane.watchdog = this.timers.setTimeout(
      () => {
        if (this.current(lane, invocation)) this.report(provider, "unfinished", attempt.attemptId, "storage");
      },
      Math.max(0, attempt.leaseExpiresAt.getTime() - this.now()),
    );
    lane.watchdog.unref?.();
    let acquired;
    try {
      acquired = await this.store.beginDiscoveryAttempt(provider, {
        attemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        leaseExpiresAt: attempt.leaseExpiresAt,
        observed: state.observed,
      });
    } catch {
      if (this.current(lane, invocation)) this.report(provider, "acquisition-unknown", attempt.attemptId, "storage");
      return;
    }
    if (!this.current(lane, invocation)) return;
    if (acquired.kind === "busy") {
      lane.pending = undefined;
      return;
    }
    // Keep the originally supplied dates, identity, store, and invocation.
    // A started result alone is not fresh-submission authority.
    if (!this.usable(lane, invocation, attempt)) {
      this.report(provider, "interrupted-acquisition", attempt.attemptId);
      return;
    }
    let rows: DiscoveredModel[];
    try {
      rows = await this.discover(provider, { signal: lane.controller!.signal });
    } catch (error) {
      if (!this.usable(lane, invocation, attempt)) return;
      if (error instanceof CatalogError)
        await this.fail(lane, invocation, attempt, safeError(provider, error.safe.code, error.safe.httpStatus));
      else this.report(provider, "discovery-unfinished", attempt.attemptId, "storage");
      return;
    }
    if (!this.usable(lane, invocation, attempt)) return;
    lane.pending = { attempt, phase: "apply" };
    // Rows live only in this invocation and are never retained for replay.
    const result = await this.store.applyDiscovery(attempt, rows);
    if (!this.current(lane, invocation)) return;
    if (result.kind === "commit-unknown") {
      this.report(provider, result.kind, attempt.attemptId, "storage");
      return;
    }
    if (result.kind === "not-committed") {
      lane.pending = { attempt, phase: "failure" };
      await this.fail(lane, invocation, attempt, result.error);
      return;
    }
    lane.pending = undefined;
    this.report(
      provider,
      result.kind,
      attempt.attemptId,
      undefined,
      result.kind === "committed" && result.recoveryPending,
    );
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; // invalidates every invocation before the first await
    if (this.interval) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    for (const lane of this.lanes.values()) {
      lane.controller?.abort();
      if (lane.watchdog) {
        this.timers.clearTimeout(lane.watchdog);
        lane.watchdog = undefined;
      }
    }
    const tasks = [...this.lanes.values()].flatMap((lane) => (lane.task ? [lane.task] : []));
    if (this.recovery) tasks.push(this.recovery);
    this.stopPromise = (async () => {
      let timer: Timer | undefined;
      const settled = Promise.allSettled(tasks).then(() => true);
      const deadline = new Promise<boolean>((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), this.options.drainMs ?? SHUTDOWN_DRAIN_MS);
      });
      const drained = await Promise.race([settled, deadline]);
      if (timer) this.timers.clearTimeout(timer);
      if (!drained) this.log.warn("Model catalog scanner shutdown drain incomplete", { code: "storage" });
    })();
    return this.stopPromise;
  }
}
