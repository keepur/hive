import { describe, expect, it } from "vitest";
import { deadlineSchema, registrationSchema, type Obligation } from "./types.js";
import { adjacent, currentDue, scan, windowStart } from "./deadlines.js";

const rule = deadlineSchema.parse({ localTime: "08:00", weekdays: [1, 2, 3, 4, 5], timezone: "UTC" });
function obligation(activeFrom = "2026-09-07T07:00:00.000Z"): Obligation {
  return {
    _id: "demo",
    deliverable: "Demo",
    producerAgentId: "demo-producer",
    deadline: rule,
    destination: { kind: "slack", channelId: "C00000001" },
    noticeDestination: { kind: "slack", channelId: "C00000002" },
    createdBy: "operator",
    activeFrom: new Date(activeFrom),
    createdAt: new Date(activeFrom),
    scanThrough: new Date(activeFrom),
  };
}
describe("strict deadline contract", () => {
  it.each([
    { localTime: "24:00" },
    { localTime: "8:00" },
    { localTime: "00:60" },
    { weekdays: [] },
    { weekdays: [1, 1] },
    { weekdays: [7] },
    { timezone: "not/a-zone" },
    { timezone: "+01:00" },
  ])("rejects invalid %j", (bad) => {
    expect(deadlineSchema.safeParse({ ...rule, ...bad }).success).toBe(false);
  });
  it("rejects caller-owned engine fields and missing notice recipient", () => {
    const o = obligation();
    expect(registrationSchema.safeParse(o).success).toBe(false);
    const { activeFrom, createdAt, scanThrough, noticeDestination, ...input } = o;
    void activeFrom;
    void createdAt;
    void scanThrough;
    void noticeDestination;
    expect(registrationSchema.safeParse(input).success).toBe(false);
  });
  it("clamps the first exclusive lower bound and has no registration backfill", () => {
    const o = obligation();
    const due = new Date("2026-09-07T08:00:00.000Z");
    expect(windowStart(o, due)).toEqual(o.activeFrom);
    expect(currentDue(o, o.activeFrom)).toBeNull();
    expect(currentDue(o, due)).toEqual(due);
    expect(currentDue(o, new Date(due.getTime() + 1))).toEqual(new Date("2026-09-08T08:00:00.000Z"));
    expect(scan(rule, due, due).due).toEqual([]);
    expect(() => windowStart(obligation(due.toISOString()), due)).toThrow("invalid_occurrence");
  });
  it("bounds scanning and resumes without losing dates", () => {
    const start = new Date("2026-09-07T07:59:00.000Z"),
      end = new Date("2026-09-09T08:00:00.000Z");
    let through = start;
    const found: string[] = [];
    while (through < end) {
      const batch = scan(rule, through, end, 30);
      expect(batch.through.getTime() - through.getTime()).toBeLessThanOrEqual(30 * 60_000);
      found.push(...batch.due.map((d) => d.toISOString()));
      through = batch.through;
    }
    expect(found).toEqual(["2026-09-07T08:00:00.000Z", "2026-09-08T08:00:00.000Z", "2026-09-09T08:00:00.000Z"]);
    expect(scan(rule, through, start).through).toEqual(through);
  });
  it("skips the spring gap and produces both autumn fold instants", () => {
    const spring = deadlineSchema.parse({ localTime: "02:30", weekdays: [0], timezone: "America/Los_Angeles" });
    expect(adjacent(spring, new Date("2026-03-08T00:00:00Z"), 1)).toEqual(new Date("2026-03-15T09:30:00Z"));
    const fold = deadlineSchema.parse({ localTime: "01:30", weekdays: [0], timezone: "America/Los_Angeles" });
    const first = adjacent(fold, new Date("2026-11-01T00:00:00Z"), 1);
    const second = adjacent(fold, first, 1);
    expect(first).toEqual(new Date("2026-11-01T08:30:00Z"));
    expect(second).toEqual(new Date("2026-11-01T09:30:00Z"));
    expect(adjacent(fold, second, -1)).toEqual(first);
  });
  it("ignores host timezone for the registered rule", () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ["UTC", "Pacific/Auckland", "America/New_York"]) {
        process.env.TZ = tz;
        expect(adjacent(rule, new Date("2026-09-07T07:00:00Z"), 1)).toEqual(new Date("2026-09-07T08:00:00Z"));
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
