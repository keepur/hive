import { describe, expect, it } from "vitest";
import {
  SESSION_SEMANTICS,
  persistsResumableHandle,
  sessionSemanticsFor,
  type AgentProviderId,
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
  ] as const)("%s → persistsResumableHandle=%s (old Set membership preserved)", (provider, expected) => {
    expect(persistsResumableHandle(sessionSemanticsFor(provider as AgentProviderId))).toBe(expected);
  });

  it("declares exactly the four current provider ids (Record exhaustiveness is compile-time)", () => {
    expect(Object.keys(SESSION_SEMANTICS).sort()).toEqual(["claude", "codex", "gemini", "openai"]);
  });
});
