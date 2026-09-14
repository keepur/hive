import { describe, it, expect } from "vitest";
import {
  BLOCK_EVIDENCE_KIND_RULING,
  BLOCK_EVIDENCE_KIND_WORK_ITEM,
  BLOCK_SUBJECT_KIND,
  HIVE_AGENT_PRODUCER,
  HIVE_AGENT_REASONS,
  REASON_BLOCK_CLEARED,
  REASON_COORDINATION_BLOCK,
  REASON_SEMANTIC_BLOCK,
} from "./block-reasons.js";
import { assertReasonTableLegal, auditReasonRow } from "./reasons.js";
import { OPS_TOKEN_RE } from "./ids.js";
import type { OpsReason } from "./types.js";

/** KPR-501 AC12 (reason table) and AC15's constant half. */

/** The order pin, as a predicate, so a reordered table can be shown to fail it. */
const clearingRowFirst = (rows: readonly OpsReason[]) => rows[0]?.reasonId === REASON_BLOCK_CLEARED;

describe("HIVE_AGENT_REASONS (KPR-501 D3, AC12)", () => {
  it("the shipped table is legal on its own", () => {
    expect(() => assertReasonTableLegal(HIVE_AGENT_REASONS)).not.toThrow();
    for (const row of HIVE_AGENT_REASONS) expect(auditReasonRow(row), row.reasonId).toEqual([]);
  });

  it("upserts the clearing reason FIRST (D3 write order is load-bearing)", () => {
    expect(HIVE_AGENT_REASONS[0].reasonId).toBe("block-cleared");
    expect(HIVE_AGENT_REASONS.map((r) => r.reasonId)).toEqual([
      REASON_BLOCK_CLEARED,
      REASON_COORDINATION_BLOCK,
      REASON_SEMANTIC_BLOCK,
    ]);
    expect(clearingRowFirst(HIVE_AGENT_REASONS)).toBe(true);
  });

  it("a reordered table (block-cleared after coordination-block) passes the pure gate but fails the order pin", () => {
    const [cleared, coordination, semantic] = HIVE_AGENT_REASONS;
    const reordered = [coordination!, cleared!, semantic!];
    expect(() => assertReasonTableLegal(reordered)).not.toThrow();
    expect(clearingRowFirst(reordered)).toBe(false);
  });

  it("refuses a table with coordination-block enabled and block-cleared removed", () => {
    const rows = HIVE_AGENT_REASONS.filter((r) => r.reasonId !== REASON_BLOCK_CLEARED);
    expect(() => assertReasonTableLegal(rows)).toThrow(/clearsReasonIds/);
  });

  it("ships the D3 rows exactly: classes, retry, clears, detail keys and bounds, all enabled", () => {
    const shape = HIVE_AGENT_REASONS.map((r) => ({
      producer: r.producer,
      reasonId: r.reasonId,
      class: r.class,
      retry: r.retry,
      clearsReasonIds: r.clearsReasonIds,
      detailKeys: r.detailKeys.map((k) => [k.key, k.type, k.maxLength, k.optional === true]),
      enabled: r.enabled,
    }));
    expect(shape).toEqual([
      {
        producer: "hive-agent",
        reasonId: "block-cleared",
        class: "informational",
        retry: "transient",
        clearsReasonIds: ["coordination-block", "semantic-block"],
        detailKeys: [
          ["agentId", "string", 200, false],
          ["outcome", "string", 16, false],
          ["workItemId", "string", 200, true],
          ["threadId", "string", 200, true],
        ],
        enabled: true,
      },
      {
        producer: "hive-agent",
        reasonId: "coordination-block",
        class: "resource",
        retry: "deterministic",
        clearsReasonIds: undefined,
        detailKeys: [
          ["agentId", "string", 200, false],
          ["blockedOn", "string", 16, false],
          ["blockedOnAgentId", "string", 64, true],
          ["workItemId", "string", 200, true],
          ["threadId", "string", 200, true],
        ],
        enabled: true,
      },
      {
        producer: "hive-agent",
        reasonId: "semantic-block",
        class: "judgment",
        retry: "deterministic",
        clearsReasonIds: undefined,
        detailKeys: [
          ["agentId", "string", 200, false],
          ["workItemId", "string", 200, true],
          ["threadId", "string", 200, true],
        ],
        enabled: true,
      },
    ]);
  });

  it("ships the three D3 remediation templates verbatim", () => {
    expect(HIVE_AGENT_REASONS.map((r) => r.remediationTemplate)).toEqual([
      "none; recorded so {agentId}'s block closes ({outcome}) and reopens as a new epoch if it returns",
      "{agentId} is blocked on {blockedOn}; supply what it is waiting for, and it clears the block itself (clear_block, resumed or cancelled)",
      "{agentId} needs a ruling above its authority; a named human rules, and the agent clears the block citing the ruling",
    ]);
  });

  it("the remediation templates interpolate only always-present keys", () => {
    for (const row of HIVE_AGENT_REASONS) {
      const required = new Set(row.detailKeys.filter((k) => !k.optional).map((k) => k.key));
      const names = [...row.remediationTemplate.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
      expect(names.length, `${row.reasonId} interpolates nothing`).toBeGreaterThan(0);
      for (const name of names) {
        expect(required.has(name!), `${row.reasonId} interpolates optional/undeclared {${name}}`).toBe(true);
      }
    }
  });
});

describe("D12 exported constants (KPR-501 AC15, constant half)", () => {
  it("exports the seven constants with the D12 values", () => {
    expect({
      HIVE_AGENT_PRODUCER,
      REASON_COORDINATION_BLOCK,
      REASON_SEMANTIC_BLOCK,
      REASON_BLOCK_CLEARED,
      BLOCK_SUBJECT_KIND,
      BLOCK_EVIDENCE_KIND_WORK_ITEM,
      BLOCK_EVIDENCE_KIND_RULING,
    }).toEqual({
      HIVE_AGENT_PRODUCER: "hive-agent",
      REASON_COORDINATION_BLOCK: "coordination-block",
      REASON_SEMANTIC_BLOCK: "semantic-block",
      REASON_BLOCK_CLEARED: "block-cleared",
      BLOCK_SUBJECT_KIND: "agent-work",
      BLOCK_EVIDENCE_KIND_WORK_ITEM: "work-item",
      BLOCK_EVIDENCE_KIND_RULING: "ruling",
    });
  });

  it("every token literal satisfies OPS_TOKEN_RE", () => {
    for (const token of [
      HIVE_AGENT_PRODUCER,
      REASON_COORDINATION_BLOCK,
      REASON_SEMANTIC_BLOCK,
      REASON_BLOCK_CLEARED,
      BLOCK_SUBJECT_KIND,
      BLOCK_EVIDENCE_KIND_WORK_ITEM,
      BLOCK_EVIDENCE_KIND_RULING,
    ]) {
      expect(OPS_TOKEN_RE.test(token), token).toBe(true);
    }
  });
});
