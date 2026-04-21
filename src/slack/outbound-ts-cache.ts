import { createLogger } from "../logging/logger.js";

const log = createLogger("outbound-ts-cache");

export interface OutboundTsCacheOptions {
  ttlMs?: number;
  maxSize?: number;
}

export class OutboundTsCache {
  private entries = new Map<string, number>(); // key `${channel}:${ts}` → expiry epoch ms
  private ttlMs: number;
  private maxSize: number;

  constructor(opts: OutboundTsCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.maxSize = opts.maxSize ?? 10_000;
  }

  register(channel: string, ts: string): void {
    this.evictExpired();
    if (this.entries.size >= this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
    this.entries.set(this.key(channel, ts), Date.now() + this.ttlMs);
  }

  has(channel: string, ts: string): boolean {
    const expiry = this.entries.get(this.key(channel, ts));
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.entries.delete(this.key(channel, ts));
      return false;
    }
    return true;
  }

  size(): number {
    return this.entries.size;
  }

  private key(channel: string, ts: string): string {
    return `${channel}:${ts}`;
  }

  private evictExpired(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [k, expiry] of this.entries) {
      if (expiry <= now) {
        this.entries.delete(k);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug(`evicted ${evicted} expired entries`, { evicted });
    }
  }
}
