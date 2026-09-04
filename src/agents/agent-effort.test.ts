import { describe, expect, it } from "vitest";
import { AGENT_EFFORT_LEVELS, isAgentEffort } from "./agent-effort.js";

describe("agent-effort (KPR-430)", () => {
  it("accepts exactly the five SDK levels", () => {
    expect([...AGENT_EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const level of AGENT_EFFORT_LEVELS) expect(isAgentEffort(level)).toBe(true);
  });

  it("rejects the Lane B suffix-only levels, garbage, and non-strings", () => {
    for (const bad of [
      "minimal",
      "none",
      "xhighest",
      "",
      "MAX",
      " max",
      7,
      null,
      undefined,
      {},
      ["max"],
    ]) {
      expect(isAgentEffort(bad)).toBe(false);
    }
  });
});
