import { describe, it, expect } from "vitest";
import {
  assertReasonTableLegal,
  auditReasonRow,
  compileDetailSchema,
  HIVE_RUNTIME_REASONS,
  REASON_TOOL_FAILED,
  REASON_TOOL_RECOVERED,
} from "./reasons.js";
import { OPS_DETAIL_STRING_MAX, OPS_LOG_ANOMALY_VALUE_MAX, OPS_LOG_VALUE_MAX } from "./ids.js";
import type { DetailKeySpec, OpsReason } from "./types.js";

describe("HIVE_RUNTIME_REASONS + assertReasonTableLegal (KPR-454 D5, AC10)", () => {
  it("the shipped table is legal", () => {
    expect(() => assertReasonTableLegal(HIVE_RUNTIME_REASONS)).not.toThrow();
  });

  it("refuses an enabled class:resource reason that nothing clears (C19 at registration)", () => {
    const rows = HIVE_RUNTIME_REASONS.filter((r) => r.reasonId !== REASON_TOOL_RECOVERED);
    expect(() => assertReasonTableLegal(rows)).toThrow(/clearsReasonIds/);
  });

  it("refuses a clearsReasonIds naming an unregistered reason (D4 registration clause)", () => {
    const rows = [{ ...HIVE_RUNTIME_REASONS[0], clearsReasonIds: ["nope"] }, HIVE_RUNTIME_REASONS[1]];
    expect(() => assertReasonTableLegal(rows)).toThrow(/unregistered reason/);
  });

  const patch = (over: Partial<OpsReason>) =>
    HIVE_RUNTIME_REASONS.map((r) => (r.reasonId === REASON_TOOL_FAILED ? { ...r, ...over } : r));

  it("refuses a string detail key with no maxLength (the allow-list IS the redaction boundary)", () => {
    const rows = patch({ detailKeys: [{ key: "loose", type: "string" }] });
    expect(() => assertReasonTableLegal(rows)).toThrow(/no maxLength/);
  });

  it("refuses a maxLength above the ceiling", () => {
    const rows = patch({ detailKeys: [{ key: "huge", type: "string", maxLength: 1_000_000 }] });
    expect(() => assertReasonTableLegal(rows)).toThrow(new RegExp(`outside 1\\.\\.${OPS_DETAIL_STRING_MAX}`));
  });

  it("refuses an over-long remediationTemplate (D4: a BOUNDED parameterised string)", () => {
    expect(() => assertReasonTableLegal(patch({ remediationTemplate: "x".repeat(501) }))).toThrow(
      /remediationTemplate/,
    );
  });

  it("refuses an EMPTY remediationTemplate — the other half of D4's `required, no default`", () => {
    // The case above drives only the `> OPS_REMEDIATION_MAX` arm of the gate's
    // single `length === 0 || length > MAX` predicate. A row spelled
    // `remediationTemplate: ""` reaches the other arm, and with no case here
    // the whole `length === 0 ||` disjunct can be deleted with the suite still
    // green (measured). D4 says required with no default: a row that declares
    // nothing to do about its own condition is a development-time defect, not
    // a row to publish and let KPR-468 render an empty remediation from.
    expect(() => assertReasonTableLegal(patch({ remediationTemplate: "" }))).toThrow(/remediationTemplate/);
  });

  it("refuses the two silent normalizations the compiler would otherwise perform", () => {
    const badType = patch({ detailKeys: [{ key: "when", type: "date" } as unknown as DetailKeySpec] });
    expect(() => assertReasonTableLegal(badType)).toThrow(/unrecognized type/);
    const badName = patch({ detailKeys: [{ key: "a".repeat(80), type: "string", maxLength: 40 }] });
    expect(() => assertReasonTableLegal(badName)).toThrow(/key NAME/);
  });

  it("auditReasonRow reports and decides nothing — the operator-inserted row's path", () => {
    const row = { ...HIVE_RUNTIME_REASONS[1], detailKeys: [{ key: "x", type: "string", maxLength: 400 }] };
    expect(auditReasonRow(row)).toHaveLength(1);
    expect(auditReasonRow(row)[0]).toMatch(new RegExp(`clamped to ${OPS_DETAIL_STRING_MAX}`));
    for (const shipped of HIVE_RUNTIME_REASONS) expect(auditReasonRow(shipped), shipped.reasonId).toEqual([]);
  });

  it("upserts the clearing reason FIRST (D5 write order is load-bearing)", () => {
    expect(HIVE_RUNTIME_REASONS[0].reasonId).toBe(REASON_TOOL_RECOVERED);
    expect(HIVE_RUNTIME_REASONS[1].reasonId).toBe(REASON_TOOL_FAILED);
  });

  it("tool-recovered declares no agentId detail key (D6)", () => {
    const recovered = HIVE_RUNTIME_REASONS.find((r) => r.reasonId === REASON_TOOL_RECOVERED)!;
    expect(recovered.detailKeys.map((k) => k.key)).toEqual(["tool", "lane"]);
  });

  it("the remediation templates interpolate only always-present keys", () => {
    for (const row of HIVE_RUNTIME_REASONS) {
      const required = new Set(row.detailKeys.filter((k) => !k.optional).map((k) => k.key));
      for (const [, name] of row.remediationTemplate.matchAll(/\{(\w+)\}/g)) {
        expect(required.has(name), `${row.reasonId} interpolates optional/undeclared {${name}}`).toBe(true);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The WIDTH of an anomaly line. Round 2 bounded how MANY of these `loadReasons`
// writes to the boot log (REASON_ROW_ANOMALY_LOG_MAX = 5); every value they
// interpolate comes from an `ops_reasons` document nothing on the load path
// validates, so without a clip five lines is still unbounded bytes — and row
// count is unbounded on top of that.
// ───────────────────────────────────────────────────────────────────────────

describe("auditReasonRow bounds the WIDTH of every anomaly line (C13)", () => {
  const HUGE = 200_000;
  const rowWith = (spec: unknown, over: Partial<OpsReason> = {}): OpsReason =>
    ({ ...HIVE_RUNTIME_REASONS[1]!, detailKeys: [spec as DetailKeySpec], ...over }) as OpsReason;

  // The ceiling a single line may occupy: the clipped key (80) + the clipped
  // type (80) + the clipped producer and reasonId (64 each) + the fixed prose
  // and the stringified regex. Deliberately loose — this pins "bounded", not a
  // byte count that would rot on a reworded message.
  const LINE_CEILING = 4 * OPS_LOG_ANOMALY_VALUE_MAX + 200;

  it.each([
    ["key NAME", { key: "k".repeat(HUGE), type: "string", maxLength: 40 }],
    ["type", { key: "ok", type: "d".repeat(HUGE) }],
    ["maxLength (a digit-string coerces past the ceiling)", { key: "ok", type: "string", maxLength: "9".repeat(HUGE) }],
  ])("a %s of 200 000 characters costs a BOUNDED line, not 200 000 of log", (_label, spec) => {
    const anomalies = auditReasonRow(rowWith(spec));
    expect(anomalies.length).toBeGreaterThan(0); // able-to-fail: an arm really fired
    for (const line of anomalies) {
      expect(line.length, line.slice(0, 120)).toBeLessThan(LINE_CEILING);
      expect(line).toContain("…"); // the clip marker really fired
    }
  });

  it("the row's own producer/reasonId are clipped too — they name the row, and are foreign text", () => {
    const anomalies = auditReasonRow(
      rowWith({ key: "ok", type: "date" }, { producer: "p".repeat(HUGE), reasonId: "r".repeat(HUGE) }),
    );
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.length).toBeLessThan(LINE_CEILING);
    expect(anomalies[0]).toContain(`${"p".repeat(OPS_LOG_VALUE_MAX)}…`);
    expect(anomalies[0]).not.toContain("p".repeat(OPS_LOG_VALUE_MAX + 1));
  });

  it("a LEGAL maximum-length key name survives intact — what makes clipping at the SOURCE lossless", () => {
    // DETAIL_KEY_NAME_RE admits at most 64 characters, and the clip is above
    // that, so it cannot fire on a legal name. This is the whole answer to
    // "would clipping degrade assertReasonTableLegal's developer-facing throw":
    // for every input where the throw's actionability matters, nothing is
    // clipped.
    const legal = `k${"y".repeat(63)}`;
    expect(legal).toHaveLength(64);
    const anomalies = auditReasonRow(rowWith({ key: legal, type: "date" }));
    expect(anomalies).toHaveLength(1); // the type arm only — the NAME is legal
    expect(anomalies[0]).toContain(legal);
    expect(anomalies[0]).not.toContain("…");
    // …and the throw path carries it whole.
    const rows = HIVE_RUNTIME_REASONS.map((r) =>
      r.reasonId === REASON_TOOL_FAILED ? rowWith({ key: legal, type: "date" }) : r,
    );
    expect(() => assertReasonTableLegal(rows)).toThrow(new RegExp(legal));
  });

  it("where the clip DOES fire the name is illegal, and the throw still identifies it", () => {
    const illegal = "z".repeat(HUGE);
    const rows = HIVE_RUNTIME_REASONS.map((r) =>
      r.reasonId === REASON_TOOL_FAILED ? rowWith({ key: illegal, type: "string", maxLength: 40 }) : r,
    );
    // It says WHAT is wrong (the bound the name failed) and WHICH name, to 80
    // characters — enough to find it in a table a developer wrote.
    expect(() => assertReasonTableLegal(rows)).toThrow(/key NAME fails/);
    expect(() => assertReasonTableLegal(rows)).toThrow(new RegExp("z".repeat(OPS_LOG_ANOMALY_VALUE_MAX)));
  });

  it("a non-string key or type does not throw out of the audit — a hand-edited row can hold either", () => {
    expect(() => auditReasonRow(rowWith({ key: 42, type: null }))).not.toThrow();
    expect(() => auditReasonRow(rowWith({}))).not.toThrow();
    expect(auditReasonRow(rowWith({ key: 42, type: null })).length).toBeGreaterThan(0);
  });
});

describe("compileDetailSchema (KPR-454 D6, AC3)", () => {
  const schema = compileDetailSchema(HIVE_RUNTIME_REASONS.find((r) => r.reasonId === REASON_TOOL_FAILED)!.detailKeys);
  it("accepts a well-formed detail", () => {
    expect(schema.safeParse({ tool: "Bash", errorSig: "timeout", lane: "claude" }).success).toBe(true);
  });
  it("rejects an undeclared key", () => {
    expect(schema.safeParse({ tool: "Bash", errorSig: "timeout", lane: "claude", oops: "x" }).success).toBe(false);
  });
  it("rejects a wrong scalar type, a non-scalar and an over-length value", () => {
    expect(schema.safeParse({ tool: 1, errorSig: "timeout", lane: "claude" }).success).toBe(false);
    expect(schema.safeParse({ tool: { a: 1 }, errorSig: "timeout", lane: "claude" }).success).toBe(false);
    expect(schema.safeParse({ tool: "a".repeat(201), errorSig: "timeout", lane: "claude" }).success).toBe(false);
  });
  it("rejects a missing required key and accepts a missing optional one", () => {
    expect(schema.safeParse({ errorSig: "timeout", lane: "claude" }).success).toBe(false);
    expect(schema.safeParse({ tool: "Bash", errorSig: "timeout", lane: "claude" }).success).toBe(true);
  });

  it("bounds a string key that declares NO maxLength, at the ceiling", () => {
    const s = compileDetailSchema([{ key: "x", type: "string" }]);
    expect(s.safeParse({ x: "a".repeat(OPS_DETAIL_STRING_MAX) }).success).toBe(true);
    expect(s.safeParse({ x: "a".repeat(OPS_DETAIL_STRING_MAX + 1) }).success).toBe(false);
  });

  it("clamps a maxLength that exceeds the ceiling rather than honouring it", () => {
    const s = compileDetailSchema([{ key: "x", type: "string", maxLength: 1_000_000 }]);
    expect(s.safeParse({ x: "a".repeat(OPS_DETAIL_STRING_MAX + 1) }).success).toBe(false);
  });
});
