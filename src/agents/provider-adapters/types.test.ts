import { describe, expect, it } from "vitest";
import {
  SESSION_SEMANTICS,
  persistsResumableHandle,
  sessionSemanticsFor,
  type AgentProviderId,
  type LaneBProviderId,
} from "./types.js";

describe("SESSION_SEMANTICS (KPR-347 §D3)", () => {
  // Persistence pin: persistsResumableHandle(sessionSemanticsFor(p)) is true
  // for every provider that holds a real resumable handle. This once mirrored
  // the deleted RESUMABLE_SESSION_PROVIDERS = {claude, openai} membership, but
  // gemini exited stateless-replay in KPR-352 (§D3 — Interactions adapter
  // chains previous_interaction_id, a real server handle), so the old-Set
  // equivalence no longer holds for gemini. codex remains stateless-replay.
  it.each([
    ["claude", true],
    ["openai", true],
    ["gemini", true],
    ["codex", false],
    ["kimi", true],
    ["deepseek", true],
  ] as const)("%s → persistsResumableHandle=%s", (provider, expected) => {
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
