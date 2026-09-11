import { describe, it, expect } from "vitest";
import { evaluateMatches, matchesFilter } from "./match.js";
import type { OpsFilter, OpsSubscription } from "./types.js";

const EVENT = {
  producer: "hive-runtime",
  reasonId: "tool-failed",
  class: "resource",
  waiting: "human-now",
  retry: "transient",
  subject: { kind: "tool", id: "Bash" },
} as const;

const TERMS: ReadonlyArray<{ term: keyof OpsFilter; hit: OpsFilter; miss: OpsFilter }> = [
  { term: "producer", hit: { producer: ["hive-runtime"] }, miss: { producer: ["florist"] } },
  { term: "reasonId", hit: { reasonId: ["tool-failed"] }, miss: { reasonId: ["tool-recovered"] } },
  { term: "class", hit: { class: ["resource"] }, miss: { class: ["informational"] } },
  { term: "waiting", hit: { waiting: ["human-now"] }, miss: { waiting: ["nobody"] } },
  { term: "retry", hit: { retry: ["transient"] }, miss: { retry: ["deterministic"] } },
  { term: "subjectKind", hit: { subjectKind: ["tool"] }, miss: { subjectKind: ["provider"] } },
];

function sub(id: string, filter: OpsFilter, enabled = true): OpsSubscription {
  return {
    _id: id,
    subscriberId: "nobody",
    subscriberKind: "test",
    enabled,
    filter,
    transport: { adapterId: "none", target: "none" },
  };
}

describe("the D5 filter grammar (KPR-454 AC5, C7)", () => {
  it("an absent field matches everything", () => {
    expect(matchesFilter(EVENT, {})).toBe(true);
  });

  it("every one of the six terms discriminates, in both directions", () => {
    for (const { term, hit, miss } of TERMS) {
      expect(matchesFilter(EVENT, hit), `${term} hit`).toBe(true);
      expect(matchesFilter(EVENT, miss), `${term} miss`).toBe(false);
    }
  });

  it("TERMS enumerates the six the D5 grammar declares (a literal, not a derivation)", () => {
    expect(TERMS.map((t) => t.term).sort()).toEqual([
      "class",
      "producer",
      "reasonId",
      "retry",
      "subjectKind",
      "waiting",
    ]);
  });

  it("present fields are ANDed — one mismatch is enough", () => {
    expect(matchesFilter(EVENT, { producer: ["hive-runtime"], reasonId: ["tool-failed"] })).toBe(true);
    expect(matchesFilter(EVENT, { producer: ["hive-runtime"], reasonId: ["tool-recovered"] })).toBe(false);
    expect(matchesFilter(EVENT, { reasonId: ["tool-recovered", "tool-failed"] })).toBe(true);
  });

  it("an empty list matches nothing — it is membership, not 'unset'", () => {
    expect(matchesFilter(EVENT, { producer: [] })).toBe(false);
  });

  it("an operator-shaped key is IGNORED, never interpreted", () => {
    expect(matchesFilter(EVENT, { $or: [{ producer: ["florist"] }] } as unknown as OpsFilter)).toBe(true);
    expect(matchesFilter(EVENT, { producer: { $ne: "hive-runtime" } } as unknown as OpsFilter)).toBe(false);
  });

  it("no wildcard, no regex, no prefix semantics — values compare by equality only", () => {
    expect(matchesFilter(EVENT, { producer: ["hive-*"] })).toBe(false);
    expect(matchesFilter(EVENT, { producer: ["hive"] })).toBe(false);
    expect(matchesFilter(EVENT, { subjectKind: ["TOOL"] })).toBe(false);
  });

  it("a disabled subscription never matches", () => {
    expect(evaluateMatches(EVENT, [sub("s1", {}, false)])).toEqual([]);
  });

  it("returns matched ids in registration order", () => {
    const subs = [sub("a", {}), sub("b", { reasonId: ["tool-recovered"] }), sub("c", { producer: ["hive-runtime"] })];
    expect(evaluateMatches(EVENT, subs)).toEqual(["a", "c"]);
  });

  it("zero matches returns [] and is not an error", () => {
    expect(evaluateMatches(EVENT, [])).toEqual([]);
    expect(evaluateMatches(EVENT, [sub("x", { producer: ["florist"] })])).toEqual([]);
  });
});
