import { describe, expect, it } from "vitest";
import {
  SESSION_SEMANTICS,
  persistsResumableHandle,
  sessionSemanticsFor,
  type AgentProviderId,
  type LaneBProviderId,
} from "./types.js";

describe("SESSION_SEMANTICS (KPR-347 §D3)", () => {
  // Equivalence pin: persistsResumableHandle(sessionSemanticsFor(p)) must
  // equal the deleted RESUMABLE_SESSION_PROVIDERS = {claude, openai}
  // membership for all four current ids (spec T4 — behavior preserved).
  it.each([
    ["claude", true],
    ["openai", true],
    ["gemini", false],
    ["codex", false],
    ["kimi", true],
    ["deepseek", true],
  ] as const)("%s → persistsResumableHandle=%s (old Set membership preserved)", (provider, expected) => {
    expect(persistsResumableHandle(sessionSemanticsFor(provider as AgentProviderId))).toBe(expected);
  });

  it("declares exactly the six current provider ids (Record exhaustiveness is compile-time)", () => {
    expect(Object.keys(SESSION_SEMANTICS).sort()).toEqual([
      "claude",
      "codex",
      "deepseek",
      "gemini",
      "kimi",
      "openai",
    ]);
  });
});

it("LaneBProviderId stays exactly {openai, gemini, codex} — Lane A never joins (KPR-346 canon pin)", () => {
  // Compile-time exhaustiveness in both directions; runtime assert is a formality.
  const laneB: Record<LaneBProviderId, true> = { openai: true, gemini: true, codex: true };
  expect(Object.keys(laneB)).toHaveLength(3);
});
