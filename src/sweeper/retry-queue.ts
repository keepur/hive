import { createLogger } from "../logging/logger.js";
import type { WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "../channels/channel-adapter.js";

const log = createLogger("retry-queue");

interface RetryEntry {
  result: WorkResult;
  adapter: ChannelAdapter;
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
}

export interface RetryQueueConfig {
  maxAttempts: number; // default 3
  baseDelayMs: number; // default 30000
}

export interface RetryQueueStats {
  pending: number;
  retried: number;
  dropped: number;
  errors: string[];
}

export class RetryQueue {
  private entries: RetryEntry[] = [];
  private config: RetryQueueConfig;

  constructor(config: RetryQueueConfig) {
    this.config = config;
  }

  enqueue(result: WorkResult, adapter: ChannelAdapter): void {
    this.entries.push({
      result,
      adapter,
      attempts: 0,
      nextRetryAt: Date.now() + this.config.baseDelayMs,
      createdAt: Date.now(),
    });
    log.info("Delivery queued for retry", {
      agentId: result.agentId,
      adapterId: adapter.id,
      queueSize: this.entries.length,
    });
  }

  async processRetries(): Promise<RetryQueueStats> {
    const now = Date.now();
    const stats: RetryQueueStats = { pending: 0, retried: 0, dropped: 0, errors: [] };
    const remaining: RetryEntry[] = [];

    for (const entry of this.entries) {
      if (entry.nextRetryAt > now) {
        remaining.push(entry);
        stats.pending++;
        continue;
      }

      entry.attempts++;
      try {
        await entry.adapter.deliver(entry.result);
        stats.retried++;
        log.info("Retry delivery succeeded", {
          agentId: entry.result.agentId,
          adapterId: entry.adapter.id,
          attempt: entry.attempts,
        });
      } catch (err) {
        if (entry.attempts >= this.config.maxAttempts) {
          stats.dropped++;
          const errMsg = `Dropped after ${entry.attempts} attempts: ${String(err)}`;
          stats.errors.push(errMsg);
          log.error("Retry delivery exhausted", {
            agentId: entry.result.agentId,
            adapterId: entry.adapter.id,
            attempts: entry.attempts,
            error: String(err),
          });
        } else {
          entry.nextRetryAt = now + this.config.baseDelayMs * Math.pow(2, entry.attempts);
          remaining.push(entry);
          stats.pending++;
          log.warn("Retry delivery failed, will retry", {
            agentId: entry.result.agentId,
            adapterId: entry.adapter.id,
            attempt: entry.attempts,
            nextRetryAt: new Date(entry.nextRetryAt).toISOString(),
            error: String(err),
          });
        }
      }
    }

    this.entries = remaining;
    return stats;
  }

  get size(): number {
    return this.entries.length;
  }
}
