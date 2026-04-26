import type { ChangeStream, Collection } from "mongodb";
import type { TeamCache } from "./team-cache.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("team-roster:contacts-watcher");
const POLL_INTERVAL_MS = 30_000;

/**
 * Watches the `contacts` collection for changes and invalidates the humans
 * slice on any write. Coarse-by-design: HubSpot's nightly customer sync
 * triggers ~7K wasted invalidations per night, but the humans cache holds
 * <100 records so each repopulate is a tiny query.
 *
 * Uses change-stream when available (replica set), falls back to polling
 * by checking max(updatedAt) since the last tick.
 */
export class ContactsWatcher {
  private changeStream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = new Date(0);

  constructor(
    private readonly contactsCol: Collection<any>,
    private readonly cache: TeamCache,
  ) {}

  async start(): Promise<void> {
    try {
      this.changeStream = this.contactsCol.watch([], {});
      this.changeStream.on("change", () => {
        log.debug("contacts change detected — invalidating humans cache");
        this.cache.invalidateHumans();
      });
      this.changeStream.on("error", (err) => {
        log.warn("change-stream error, falling back to polling", { error: String(err) });
        this.changeStream?.close().catch(() => {});
        this.changeStream = null;
        this.startPolling();
      });
      log.info("contacts watcher running via change-stream");
    } catch (err) {
      log.info("change-stream unavailable, using polling", { error: String(err) });
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const changed = await this.contactsCol.countDocuments({ updatedAt: { $gt: this.lastPollTime } });
        if (changed > 0) {
          log.debug("contacts poll detected change — invalidating humans cache", { changed });
          this.cache.invalidateHumans();
        }
        this.lastPollTime = new Date();
      } catch (err) {
        log.error("poll failed", { error: String(err) });
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
