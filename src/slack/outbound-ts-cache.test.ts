import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutboundTsCache } from "./outbound-ts-cache.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("OutboundTsCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers and finds a ts", () => {
    const cache = new OutboundTsCache({ ttlMs: 5_000 });
    cache.register("C123", "1234.5678");
    expect(cache.has("C123", "1234.5678")).toBe(true);
  });

  it("misses on wrong channel", () => {
    const cache = new OutboundTsCache({ ttlMs: 5_000 });
    cache.register("C123", "1234.5678");
    expect(cache.has("C999", "1234.5678")).toBe(false);
  });

  it("misses on wrong ts", () => {
    const cache = new OutboundTsCache({ ttlMs: 5_000 });
    cache.register("C123", "1234.5678");
    expect(cache.has("C123", "9999.0000")).toBe(false);
  });

  it("expires after TTL", () => {
    const cache = new OutboundTsCache({ ttlMs: 5_000 });
    cache.register("C123", "1234.5678");
    expect(cache.has("C123", "1234.5678")).toBe(true);

    vi.advanceTimersByTime(5_001);
    expect(cache.has("C123", "1234.5678")).toBe(false);
  });

  it("does not expire before TTL elapses", () => {
    const cache = new OutboundTsCache({ ttlMs: 5_000 });
    cache.register("C123", "1234.5678");

    vi.advanceTimersByTime(4_999);
    expect(cache.has("C123", "1234.5678")).toBe(true);
  });

  it("evicts oldest entry at max size", () => {
    const cache = new OutboundTsCache({ ttlMs: 60_000, maxSize: 3 });
    cache.register("C1", "ts1");
    cache.register("C2", "ts2");
    cache.register("C3", "ts3");
    expect(cache.size()).toBe(3);

    // Adding a 4th entry should evict the oldest (C1:ts1)
    cache.register("C4", "ts4");
    expect(cache.size()).toBe(3);
    expect(cache.has("C1", "ts1")).toBe(false);
    expect(cache.has("C2", "ts2")).toBe(true);
    expect(cache.has("C3", "ts3")).toBe(true);
    expect(cache.has("C4", "ts4")).toBe(true);
  });

  it("size reflects registered entries", () => {
    const cache = new OutboundTsCache({ ttlMs: 60_000 });
    expect(cache.size()).toBe(0);
    cache.register("C1", "ts1");
    cache.register("C2", "ts2");
    expect(cache.size()).toBe(2);
  });

  it("evicts expired entries on next register call", () => {
    const cache = new OutboundTsCache({ ttlMs: 1_000 });
    cache.register("C1", "ts1");
    cache.register("C2", "ts2");
    expect(cache.size()).toBe(2);

    vi.advanceTimersByTime(1_001);

    // Register triggers evictExpired — expired entries are purged
    cache.register("C3", "ts3");
    expect(cache.size()).toBe(1);
    expect(cache.has("C1", "ts1")).toBe(false);
    expect(cache.has("C2", "ts2")).toBe(false);
    expect(cache.has("C3", "ts3")).toBe(true);
  });
});
