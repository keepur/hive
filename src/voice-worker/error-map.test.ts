import { describe, expect, it } from "vitest";
import { classifyHttpFailure, resolveFailureAction, type BridgeFailureClass } from "./error-map.js";

describe("classifyHttpFailure (KPR-322)", () => {
  it("maps 401 and 400 to bridge_auth", () => {
    expect(classifyHttpFailure(401, "unauthorized")).toBe("bridge_auth");
    expect(classifyHttpFailure(400, "missing hive_agent_id")).toBe("bridge_auth");
  });

  it("maps 503 with 'temporarily' to budget_saturated", () => {
    expect(classifyHttpFailure(503, "Voice temporarily unavailable")).toBe("budget_saturated");
  });

  it("maps other 503 to engine_auth", () => {
    expect(classifyHttpFailure(503, "Voice unavailable")).toBe("engine_auth");
  });

  it("maps remaining HTTP failures to spawn_failed", () => {
    expect(classifyHttpFailure(500, "boom")).toBe("spawn_failed");
    expect(classifyHttpFailure(502, "")).toBe("spawn_failed");
  });
});

describe("resolveFailureAction (KPR-322)", () => {
  it("retries budget_saturated / spawn_failed once, then one apologize_end", () => {
    expect(resolveFailureAction("budget_saturated", false)).toEqual({
      kind: "retry",
      sayFirst: "hold_on",
      delayMs: 2000,
    });
    expect(resolveFailureAction("budget_saturated", true)).toEqual({ kind: "end", say: "apologize_end" });
    expect(resolveFailureAction("spawn_failed", false)).toEqual({
      kind: "retry",
      sayFirst: null,
      delayMs: 0,
    });
    expect(resolveFailureAction("spawn_failed", true)).toEqual({ kind: "end", say: "apologize_end" });
  });

  it("ends engine_unreachable with a single canned_engine_down line", () => {
    expect(resolveFailureAction("engine_unreachable", false)).toEqual({
      kind: "end",
      say: "canned_engine_down",
    });
    expect(resolveFailureAction("engine_unreachable", true)).toEqual({
      kind: "end",
      say: "canned_engine_down",
    });
  });

  it("ends auth failures without retry", () => {
    expect(resolveFailureAction("engine_auth", false)).toEqual({ kind: "end", say: "apologize_end" });
    expect(resolveFailureAction("bridge_auth", false)).toEqual({ kind: "end", say: "apologize_end" });
  });

  it("continues the call after midstream_error (delivered text already spoken)", () => {
    expect(resolveFailureAction("midstream_error", false)).toEqual({ kind: "continue" });
    expect(resolveFailureAction("midstream_error", true)).toEqual({ kind: "continue" });
  });

  it("yields exactly one spoken line per terminal outcome", () => {
    const classes: BridgeFailureClass[] = [
      "budget_saturated",
      "engine_auth",
      "bridge_auth",
      "spawn_failed",
      "engine_unreachable",
      "midstream_error",
    ];
    for (const cls of classes) {
      for (const consumed of [false, true]) {
        const action = resolveFailureAction(cls, consumed);
        if (action.kind === "end") {
          expect(["apologize_end", "canned_engine_down"]).toContain(action.say);
        }
        if (action.kind === "retry") {
          expect(action.sayFirst === "hold_on" || action.sayFirst === null).toBe(true);
        }
      }
    }
  });
});
