import { describe, it, expect } from "vitest";
import { eventDomain, EVENT_SCHEMAS, EVENT_DOMAINS } from "./event-types.js";

describe("eventDomain", () => {
  it("extracts domain from domain:action format", () => {
    expect(eventDomain("deals:won")).toBe("deals");
    expect(eventDomain("cases:resolved")).toBe("cases");
    expect(eventDomain("jobs:complete")).toBe("jobs");
    expect(eventDomain("leads:found")).toBe("leads");
    expect(eventDomain("system:task_blocked")).toBe("system");
  });

  it("returns entire string when no colon present", () => {
    expect(eventDomain("deals")).toBe("deals");
  });

  it("handles multiple colons by taking first segment", () => {
    expect(eventDomain("deals:won:extra")).toBe("deals");
  });
});

describe("EVENT_SCHEMAS", () => {
  it("has schemas for all domains", () => {
    for (const domain of EVENT_DOMAINS) {
      const domainEvents = Object.keys(EVENT_SCHEMAS).filter((k) => eventDomain(k) === domain);
      expect(domainEvents.length).toBeGreaterThan(0);
    }
  });

  it("all schemas have description and payload", () => {
    for (const [type, schema] of Object.entries(EVENT_SCHEMAS)) {
      expect(schema.description).toBeTruthy();
      expect(schema.payload).toBeTruthy();
      // Verify payload is a Zod schema with safeParse
      expect(typeof schema.payload.safeParse).toBe("function");
    }
  });

  it("validates deals:won payload correctly", () => {
    const schema = EVENT_SCHEMAS["deals:won"];
    const valid = schema.payload.safeParse({
      dealId: "D-123",
      dealName: "Jones Kitchen",
      customerName: "Jones",
      amount: 25000,
    });
    expect(valid.success).toBe(true);

    const withoutOptional = schema.payload.safeParse({
      dealId: "D-123",
      dealName: "Jones Kitchen",
      customerName: "Jones",
    });
    expect(withoutOptional.success).toBe(true);

    const invalid = schema.payload.safeParse({
      dealId: "D-123",
      // missing required fields
    });
    expect(invalid.success).toBe(false);
  });

  it("validates system:custom payload correctly", () => {
    const schema = EVENT_SCHEMAS["system:custom"];
    const valid = schema.payload.safeParse({ message: "test alert" });
    expect(valid.success).toBe(true);

    const invalid = schema.payload.safeParse({});
    expect(invalid.success).toBe(false);
  });
});
