/**
 * KPR-307 §7.4: 15s serial replay poller. Own timer beside the scheduler —
 * NOT a sweeper step (sweeper cadence is 5-min-class; recovery-to-replay
 * latency should track the breaker's ≤60s probe cadence).
 *
 * No breaker-state pre-check by design (§4): while the breaker is open the
 * head attempt fast-fails pre-router for free, and the first post-cooldown
 * attempt IS KPR-306's half-open probe — starving dispatch of traffic would
 * starve recovery.
 */
import { createLogger } from "../logging/logger.js";
import type { Dispatcher } from "../channels/dispatcher.js";
import type { WorkItem } from "../types/work-item.js";
import type { OutageQueueConfig, OutageQueueDoc, OutageQueueStore } from "./outage-queue-store.js";
import { expiryNotice, replayWrap } from "./outage-notices.js";

const log = createLogger("outage-replay");

export class OutageReplayProcessor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private store: OutageQueueStore,
    private dispatcher: Dispatcher,
    private config: OutageQueueConfig,
    private now: () => Date = () => new Date(),
  ) {}

  start(): void {
    // Boot recovery: crash between claim and release leaves `replaying` orphans (§7.1).
    void this.store
      .recoverStaleReplaying()
      .catch((err) => log.warn("Stale-replaying recovery failed", { error: String(err) }));
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.error("Outage replay tick failed", { error: String(err) }));
    }, this.config.replayIntervalMs);
    this.timer.unref();
    log.info("Outage replay processor started", { intervalMs: this.config.replayIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle. Public for tests. Re-entrancy-guarded — a slow drain can outlive the interval. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.expireStale();
      await this.drain();
    } finally {
      this.ticking = false;
    }
  }

  /** §5-2c: age out over-TTL items; one batched per-thread notice for notify-policy docs (§5-2c-ii). */
  private async expireStale(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.config.maxAgeHours * 3600_000);
    const expired = await this.store.expireOlderThan(cutoff);
    if (expired.length === 0) return;
    log.warn("Expired queued outage turns past maxAgeHours", { count: expired.length });

    const groups = new Map<string, OutageQueueDoc[]>();
    for (const doc of expired) {
      if (doc.policy !== "notify") continue;
      const key = `${doc.workItem.source.adapterId ?? doc.workItem.source.kind}:${doc.workItem.threadId ?? doc.workItem.sender}`;
      const list = groups.get(key) ?? [];
      list.push(doc);
      groups.set(key, list);
    }
    for (const docs of groups.values()) {
      const sample = docs[0];
      // Count distinct user messages, not raw docs: a fan-out dispatch enqueues
      // one doc per fanned agent for the same itemId, so docs.length would
      // over-count from the user's perspective (§5-2c-ii).
      const messageCount = new Set(docs.map((d) => d.itemId)).size;
      await this.dispatcher.deliverOutageNotice(sample.workItem, sample.agentId, undefined, expiryNotice(messageCount));
    }
  }

  /**
   * Serial oldest-first drain (§5-2b). Outcomes are DISPATCHER-authored
   * (§5-2g) — dispatch() returns void and never rethrows from turn failures,
   * so drain control re-reads the claimed doc's status (Finding 7 r2):
   * `pending` (fast-fail-again) stops the drain; done/expired/failed continue.
   */
  private async drain(): Promise<void> {
    let attempted = 0;
    for (;;) {
      const doc = await this.store.claimNext();
      if (!doc) break;
      if (attempted === 0) log.info("Outage replay drain start", { firstItemAgent: doc.agentId });
      attempted++;

      const replayItem: WorkItem = {
        ...doc.workItem,
        // §5-2d prompt-note wrap; the stored workItem keeps the original text.
        text: replayWrap(doc.workItem.text, doc.enqueuedAt, doc.policy),
        // Original id kept — dispatch()'s dedup bypasses outageReplay items
        // (Finding 1 r1: a synthetic per-attempt id would repeat while
        // attempts stays 0 and dedup would drop every replay after the first).
        meta: { ...doc.workItem.meta, targetAgentId: doc.agentId, outageReplay: true },
      };

      try {
        await this.dispatcher.dispatch(replayItem);
      } catch (err) {
        // dispatch() never rethrows turn failures; this guards pre-try throws
        // (e.g. session-store reads) from stranding the doc in `replaying`.
        log.error("Replay dispatch threw — doc back to pending, drain stopped", { error: String(err) });
        await this.store.release(doc.itemId, doc.agentId, "pending", String(err));
        break;
      }

      const status = await this.store.statusOf(doc.itemId, doc.agentId);
      if (status === "replaying") {
        // Defensive: no release path fired (should be unreachable — every
        // dispatch path writes an outcome). Revert rather than strand.
        log.warn("Replay dispatch recorded no outcome — doc reverted to pending", {
          agentId: doc.agentId,
        });
        await this.store.release(doc.itemId, doc.agentId, "pending", "no outcome recorded at dispatch");
        break;
      }
      if (status === "pending") break; // fast-failed again — breaker still open, stop draining
      // done / expired / failed → continue to the next item.
    }
    if (attempted > 0) log.info("Outage replay drain end", { attempted });
  }
}
