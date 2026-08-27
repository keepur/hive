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
    // Boot sweep (KPR-403): immediate pass — the first interval tick is 15s
    // out. The recovery sweep also rides every tick() as its first step now;
    // boot-only recovery (§7.1's original shape) stranded orphans younger
    // than the bound at boot forever. This void call runs outside the tick
    // guard and can pathologically overlap the first tick's drain on a slow
    // boot query — the per-doc deadline bound (fresh claim ⇒ young ⇒
    // skipped) plus the store's CAS write cover that window.
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

  /** One poll cycle. Public for tests. Re-entrancy-guarded — a slow drain can
   *  outlive the interval. Ordering is deliberate (KPR-403): sweep → expire →
   *  drain, so a recovered over-age orphan is expired (with its batched
   *  notice) in the same tick rather than replayed, and a recovered fresh
   *  orphan is claimable by the same tick's drain. The guard also means the
   *  folded sweep can never run while this process's own replay dispatch is
   *  in flight — it structurally cannot see its own live claim. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // KPR-403: periodic re-sweep — boot-only recovery stranded orphans
      // younger than the bound at boot. Failure must not starve expire/drain.
      await this.store
        .recoverStaleReplaying()
        .catch((err) => log.warn("Stale-replaying recovery failed", { error: String(err) }));
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
   * Serial class-ordered drain (§5-2b; KPR-400 F2: claimNext encapsulates
   * the ordering — fast-fail-class docs before post-turn-fault-class docs,
   * oldest-first within class, so the post-cooldown probe slot goes to the
   * cheapest available real turn). Outcomes are DISPATCHER-authored
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
