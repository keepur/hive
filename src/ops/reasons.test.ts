import { describe, it, expect } from "vitest";
import {
  assertReasonTableLegal,
  auditReasonRow,
  compileDetailSchema,
  HIVE_RUNTIME_REASONS,
  REASON_TOOL_FAILED,
  REASON_TOOL_RECOVERED,
} from "./reasons.js";
import { OPS_DETAIL_STRING_MAX } from "./ids.js";
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
