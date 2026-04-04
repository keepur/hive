import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { ActivityRecord } from "./types.js";

const log = createLogger("activity-logger");

interface ActivityLogConfig {
  enabled: boolean;
  bufferSize: number;
  flushIntervalMs: number;
  retentionDays: number;
}

export class ActivityLogger {
  private collection!: Collection<ActivityRecord>;
  private buffer: ActivityRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: ActivityLogConfig;
  private connected = false;

  constructor(
    private db: Db,
    config: ActivityLogConfig,
  ) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      log.info("Activity log disabled");
      return;
    }

    this.collection = this.db.collection<ActivityRecord>("activity_log");

    // Index: per-agent queries sorted by time
    await this.collection.createIndex({ agentId: 1, timestamp: -1 });

    // TTL index: auto-delete old records
    await this.collection.createIndex(
      { timestamp: 1 },
      { expireAfterSeconds: this.config.retentionDays * 24 * 60 * 60 },
    );

    this.connected = true;

    // Start periodic flush
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => log.warn("Periodic flush failed", { error: String(err) }));
    }, this.config.flushIntervalMs);

    const count = await this.collection.estimatedDocumentCount();
    log.info("Activity log connected", { records: count, retentionDays: this.config.retentionDays });
  }

  /**
   * Buffer an activity record. Triggers immediate flush if buffer is full.
   */
  record(entry: ActivityRecord): void {
    if (!this.config.enabled || !this.connected) return;

    this.buffer.push(entry);

    if (this.buffer.length >= this.config.bufferSize) {
      this.flush().catch((err) => log.warn("Buffer-full flush failed", { error: String(err) }));
    }
  }

  /**
   * Flush buffered records to MongoDB via bulk insertMany.
   * Retries once on failure, then drops the batch.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);

    try {
      await this.collection.insertMany(batch, { ordered: false });
    } catch (err) {
      log.warn("Bulk write failed, retrying once", {
        count: batch.length,
        error: String(err),
      });
      try {
        await this.collection.insertMany(batch, { ordered: false });
      } catch (retryErr) {
        log.error("Bulk write failed after retry, dropping batch", {
          count: batch.length,
          error: String(retryErr),
        });
        // Don't re-add to buffer — drop and move on
      }
    }
  }

  /**
   * Stop the flush timer and drain remaining buffer.
   * Called during graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length > 0) {
      log.info("Draining activity buffer on shutdown", { count: this.buffer.length });
      await this.flush();
    }

    this.connected = false;
  }
}
