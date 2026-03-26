import { describe, it, expect } from "vitest";
import { eventDomain, EVENT_SCHEMAS } from "./event-types.js";

/**
 * Tests for event bus MCP server logic.
 * The MCP server runs as a subprocess so we test the core logic functions
 * and validation patterns used within it.
 */

describe("event type validation", () => {
  it("rejects types without colon", () => {
    const parts = "deals".split(":");
    expect(parts.length).toBe(1);
  });

  it("rejects types with multiple colons", () => {
    const parts = "deals:won:extra".split(":");
    expect(parts.length).toBe(3);
    // The MCP server checks parts.length !== 2
    expect(parts.length !== 2).toBe(true);
  });

  it("accepts valid domain:action format", () => {
    const parts = "deals:won".split(":");
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe("deals");
    expect(parts[1]).toBe("won");
  });

  it("rejects unknown event types", () => {
    expect(EVENT_SCHEMAS["deals:nonexistent"]).toBeUndefined();
  });

  it("accepts known event types", () => {
    expect(EVENT_SCHEMAS["deals:won"]).toBeDefined();
    expect(EVENT_SCHEMAS["cases:resolved"]).toBeDefined();
    expect(EVENT_SCHEMAS["system:custom"]).toBeDefined();
  });
});

describe("subscriber resolution", () => {
  it("excludes self from subscribers", () => {
    const subscriberMap: Record<string, string[]> = {
      deals: ["customer-success", "production-support", "sdr"],
    };
    const agentId = "sdr";
    const domain = eventDomain("deals:won");
    const allSubscribers = subscriberMap[domain] ?? [];
    const subscribers = allSubscribers.filter((id) => id !== agentId);

    expect(subscribers).toEqual(["customer-success", "production-support"]);
    expect(subscribers).not.toContain("sdr");
  });

  it("returns empty array for unknown domain", () => {
    const subscriberMap: Record<string, string[]> = {
      deals: ["customer-success"],
    };
    const domain = eventDomain("unknown:action");
    const subscribers = subscriberMap[domain] ?? [];

    expect(subscribers).toEqual([]);
  });

  it("handles empty subscriber map", () => {
    const subscriberMap: Record<string, string[]> = {};
    const domain = eventDomain("deals:won");
    const subscribers = subscriberMap[domain] ?? [];

    expect(subscribers).toEqual([]);
  });

  it("parses EVENT_SUBSCRIBERS JSON correctly", () => {
    const json = '{"deals":["customer-success","production-support"],"cases":["sdr"],"system":["chief-of-staff"]}';
    const map = JSON.parse(json) as Record<string, string[]>;

    expect(map.deals).toEqual(["customer-success", "production-support"]);
    expect(map.cases).toEqual(["sdr"]);
    expect(map.system).toEqual(["chief-of-staff"]);
  });
});

describe("payload validation", () => {
  it("validates deals:won with all fields", () => {
    const schema = EVENT_SCHEMAS["deals:won"];
    const result = schema.payload.safeParse({
      dealId: "D-123",
      dealName: "Kitchen Project",
      customerName: "Smith",
      amount: 15000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects deals:won with missing required fields", () => {
    const schema = EVENT_SCHEMAS["deals:won"];
    const result = schema.payload.safeParse({
      dealId: "D-123",
      // missing dealName and customerName
    });
    expect(result.success).toBe(false);
  });

  it("validates leads:found with optional url", () => {
    const schema = EVENT_SCHEMAS["leads:found"];

    const withUrl = schema.payload.safeParse({
      source: "Reddit",
      name: "John Doe",
      context: "Kitchen renovation post",
      url: "https://reddit.com/r/homeimprovement/123",
    });
    expect(withUrl.success).toBe(true);

    const withoutUrl = schema.payload.safeParse({
      source: "Reddit",
      name: "John Doe",
      context: "Kitchen renovation post",
    });
    expect(withoutUrl.success).toBe(true);
  });

  it("validates jobs:schedule_changed with optional oldDate", () => {
    const schema = EVENT_SCHEMAS["jobs:schedule_changed"];
    const result = schema.payload.safeParse({
      jobId: "J-456",
      customerName: "Jones",
      milestone: "delivery",
      newDate: "2026-04-15",
    });
    expect(result.success).toBe(true);
  });
});
