/**
 * KPR-391 (§8): cross-provider classification cross-check.
 *
 * The extraction (turn scaffold + shared dispatch loop + module registry)
 * moved where the three Lane B adapters' error strings are BUILT, but the
 * §7.1 error-string contract says none of them may change by a character.
 * `error-classification.test.ts` pins the pattern rows; this file pins the
 * other end of the same contract — the adapters' characteristic verbatim
 * strings still land on the SAME `ProviderFaultKind` at the classification
 * boundary the circuit breaker consumes, and the gemini stale-handle
 * sentinel still satisfies the manager's `isStaleServerHandleError` gate.
 *
 * Guarding at the classification boundary (not by string equality against
 * the adapter modules) is deliberate: a silent re-word that still matched a
 * fault row would pass a string-equality test written against itself, but a
 * re-word that fell off its row is exactly the regression that would take a
 * persistent auth outage invisible to the breaker.
 *
 * Fixture shapes replicate `error-classification.test.ts`'s result-literal
 * helpers (replicate, don't cross-import — §Harness Requirements).
 */

import { describe, it, expect } from "vitest";
import { classifyTurnResult, TURN_DEADLINE_SUBTYPE, type ProviderFaultKind } from "./error-classification.js";
import { isStaleServerHandleError } from "../agent-manager.js";

function faultKind(error: string): ProviderFaultKind {
  const c = classifyTurnResult({ error });
  if (c.outcome !== "fault") throw new Error(`expected fault, got ${c.outcome}`);
  return c.kind;
}

describe("Lane B adapter error strings → ProviderFaultKind (KPR-391 §8 cross-check)", () => {
  it.each([
    // codex-subscription-adapter.ts — pre-request OAuth throw.
    "Codex OAuth session is not available; run `codex login` first",
    // openai-agents-adapter.ts — KPR-351 API-key single path fast-fail.
    "OpenAI API key is not available; set OPENAI_API_KEY in the instance .env and restart — hive credentials add does not carry this key yet",
    // gemini-interactions-adapter.ts — KPR-352 §D7 missing-key throw.
    "Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY, and restart the service",
  ])("auth: %s", (s) => expect(faultKind(s)).toBe("auth"));

  it.each([
    // codex request-failure decoration at a 429 status.
    "Codex subscription request failed (429): slow down",
    // gemini stream-phase failure carrying Google's prose 429.
    "Gemini interaction stream failed (429): Resource has been exhausted (e.g. check quota).",
  ])("rate-limit: %s", (s) => expect(faultKind(s)).toBe("rate-limit"));

  it("round-budget exhaustion stays non-provider (shared dispatch loop emits error_max_turns)", () => {
    expect(faultKind("error_max_turns")).toBe("non-provider");
  });

  it("the scaffold's #407 deadline result classifies turn-deadline, never the breaker-tripping timeout kind", () => {
    // The scaffold emits `timedOut: true` with `aborted: false` precisely so
    // the Claude-lane `timedOut && aborted` hang rule cannot match.
    expect(classifyTurnResult({ error: TURN_DEADLINE_SUBTYPE, timedOut: true, aborted: false })).toEqual({
      outcome: "fault",
      kind: "turn-deadline",
      message: TURN_DEADLINE_SUBTYPE,
    });
  });
});

describe("gemini stale-handle sentinel → isStaleServerHandleError (KPR-391 §8 cross-check)", () => {
  it("the decorated round-1 resume rejection still opens the manager self-heal arm", () => {
    expect(
      isStaleServerHandleError("gemini interaction resume rejected (status 400): Request contains an invalid argument."),
    ).toBe(true);
  });

  it("an undecorated request failure at the same status does NOT self-heal (stays an ordinary provider fault)", () => {
    expect(
      isStaleServerHandleError("Gemini interaction request failed (400): Request contains an invalid argument."),
    ).toBe(false);
  });
});
