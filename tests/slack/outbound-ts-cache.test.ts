import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutboundTsCache } from "../../src/slack/outbound-ts-cache.js";

describe("OutboundTsCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("registers and finds a ts", () => {
    const c = new OutboundTsCache();
    c.register("C1", "1.1");
    expect(c.has("C1", "1.1")).toBe(true);
  });

  it("misses on wrong channel", () => {
    const c = new OutboundTsCache();
    c.register("C1", "1.1");
    expect(c.has("C2", "1.1")).toBe(false);
  });

  it("expires after TTL", () => {
    const c = new OutboundTsCache({ ttlMs: 1000 });
    c.register("C1", "1.1");
    vi.advanceTimersByTime(1001);
    expect(c.has("C1", "1.1")).toBe(false);
  });

  it("evicts oldest at max size", () => {
    const c = new OutboundTsCache({ maxSize: 2 });
    c.register("C1", "1");
    c.register("C1", "2");
    c.register("C1", "3");
    expect(c.has("C1", "1")).toBe(false);
    expect(c.has("C1", "3")).toBe(true);
  });
});
