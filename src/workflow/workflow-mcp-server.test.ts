import { describe, it, expect } from "vitest";
import { computePlanStatus } from "./types.js";

describe("computePlanStatus", () => {
  it("returns active when tasks are in progress", () => {
    expect(computePlanStatus([{ state: "todo" }, { state: "in_progress" }])).toBe("active");
  });

  it("returns completed when all terminal with at least one done", () => {
    expect(computePlanStatus([{ state: "done" }, { state: "cancelled" }])).toBe("completed");
  });

  it("returns cancelled when all cancelled", () => {
    expect(computePlanStatus([{ state: "cancelled" }, { state: "cancelled" }])).toBe("cancelled");
  });

  it("returns active for empty task list", () => {
    expect(computePlanStatus([])).toBe("active");
  });

  it("returns active when mix of terminal and non-terminal", () => {
    expect(computePlanStatus([{ state: "done" }, { state: "blocked" }])).toBe("active");
  });
});
