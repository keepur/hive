import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { evaluateMatches, matchesFilter } from "./match.js";
import { OPS_ID_MAX_LENGTH } from "./ids.js";
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

// ───────────────────────────────────────────────────────────────────────────
// The row-admissibility gate. `ops_subscriptions` is operator-writable and
// `loadSubscriptions()` applies no shape check, so `OpsSubscription` is a
// compile-time claim about a runtime document. The rule these cases pin is the
// one chunk 3 states for `loadReasons`: one malformed operator row must cost
// THAT ROW, never the producer.
// ───────────────────────────────────────────────────────────────────────────

describe("a malformed subscription row is skipped, never fatal (the container guard)", () => {
  // Each of these four was independently broken before the guard: the first
  // two THREW out of the "pure" evaluator (`filter.producer` on
  // undefined/null), and the last two matched EVERYTHING — every
  // `filter.<key>` read on a string or an array is `undefined`, so `term()`
  // answered true six times and the row was fail-OPEN, inverting the posture
  // `term()`'s own comment claims.
  const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
    ["filter missing", undefined],
    ["filter null", null],
    ["filter a string (was fail-OPEN: matched every event)", "producer"],
    ["filter an array (was fail-OPEN)", [{ producer: ["hive-runtime"] }]],
  ];

  it.each(MALFORMED)("%s: the row matches nothing and evaluateMatches still answers", (_label, filter) => {
    const bad = { ...sub("bad", {}), filter } as unknown as OpsSubscription;
    expect(evaluateMatches(EVENT, [bad])).toEqual([]);
  });

  it.each(MALFORMED)("%s: a legitimate sibling row still matches — the producer survives", (_label, filter) => {
    const bad = { ...sub("bad", {}), filter } as unknown as OpsSubscription;
    // Both orders: the malformed row must not shadow a good row behind it, and
    // must not be able to abort the loop before one ahead of it is reached.
    expect(evaluateMatches(EVENT, [bad, sub("good", { producer: ["hive-runtime"] })])).toEqual(["good"]);
    expect(evaluateMatches(EVENT, [sub("good", { producer: ["hive-runtime"] }), bad])).toEqual(["good"]);
  });

  it("an object the grammar recognizes nothing in still matches — {} is the legal match-all row", () => {
    expect(evaluateMatches(EVENT, [sub("all", {})])).toEqual(["all"]);
    expect(
      evaluateMatches(EVENT, [{ ...sub("weird", {}), filter: { $or: [] } } as unknown as OpsSubscription]),
    ).toEqual(["weird"]);
  });
});

describe("a subscription _id is bounded before it is stored (C2)", () => {
  const idOf = (value: unknown) => ({ ...sub("placeholder", {}), _id: value }) as unknown as OpsSubscription;

  it("a maximum-length _id matches — the bound is not off by one", () => {
    const id = "s".repeat(OPS_ID_MAX_LENGTH);
    expect(evaluateMatches(EVENT, [idOf(id)])).toEqual([id]);
  });

  it.each([
    ["one over the bound", "s".repeat(OPS_ID_MAX_LENGTH + 1)],
    ["grossly over the bound", "s".repeat(100_000)],
    ["empty", ""],
  ])("%s: skipped from the match list, never truncated", (_label, id) => {
    const matched = evaluateMatches(EVENT, [idOf(id)]);
    expect(matched).toEqual([]);
    // The "never truncated" half, stated as an assertion rather than as prose:
    // no prefix of the over-bound id appears anywhere in the answer.
    expect(matched.join("")).not.toContain("s");
  });

  it("a real auto-minted ObjectId _id is skipped — matchedSubscriptionIds is string[] and must not lie", () => {
    const oid = new ObjectId();
    const matched = evaluateMatches(EVENT, [idOf(oid)]);
    expect(matched).toEqual([]);
    expect(JSON.stringify(matched)).not.toContain(oid.toHexString());
  });

  it("an inadmissible _id does not suppress a good sibling", () => {
    expect(evaluateMatches(EVENT, [idOf("s".repeat(OPS_ID_MAX_LENGTH + 1)), sub("good", {})])).toEqual(["good"]);
  });
});
