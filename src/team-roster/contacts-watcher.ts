import type { Db, ChangeStream } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { TeamCache } from "./team-cache.js";

const log = createLogger("contacts-watcher");
const POLL_INTERVAL_MS = 30_000;

/**
 * Engine-side change-stream watcher on the `contacts` collection.
 *
 * The contacts MCP runs in a stdio subprocess and cannot call into the
 * in-process team cache directly. This watcher closes the loop: any write to
 * `contacts` (from the MCP, the HubSpot pipeline, or anything else) →
 * cache.invalidateHumans().
 *
 * Falls back to a 30s polling loop if change streams are unavailable
 * (mirrors `agent-registry.startWatching` semantics).
 */
export class ContactsWatcher {
  private changeStream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = new Date();

  constructor(
    private db: Db,
    private cache: TeamCache,
  ) {}

  async start(): Promise<void> {
    try {
      this.changeStream = this.db.collection("contacts").watch([]);
      this.changeStream.on("change", () => {
        log.debug("contacts changed (change stream), invalidating humans cache");
        this.cache.invalidateHumans();
      });
      this.changeStream.on("error", (err) => {
        log.warn("contacts change stream error, falling back to polling", { error: String(err) });
        this.changeStream = null;
        this.startPolling();
      });
      log.info("contacts change stream started");
    } catch (err) {
      log.info("contacts change stream not available, using polling fallback", { error: String(err) });
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return; // idempotent — error+catch can both call this
    this.pollTimer = setInterval(async () => {
      try {
        const changed = await this.db.collection("contacts").countDocuments({ updatedAt: { $gt: this.lastPollTime } });
        if (changed > 0) {
          log.debug("contacts changed (poll), invalidating humans cache", { changed });
          this.cache.invalidateHumans();
          this.lastPollTime = new Date();
        }
      } catch (err) {
        log.warn("contacts poll failed", { error: String(err) });
      }
    }, POLL_INTERVAL_MS);
    log.info("contacts watcher running via polling", { intervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
