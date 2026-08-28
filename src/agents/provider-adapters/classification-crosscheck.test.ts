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
    // grok-gateway-adapter.ts — gatewayErrorMessage C5 decoration at a 401 status.
    "Grok gateway request failed (401): key not in allowlist",
    // grok-gateway-adapter.ts — bare-construction guard (manager resolves
    // GROK_GATEWAY_KEY before construction; this throw only surfaces if the
    // adapter is ever constructed without it, e.g. a future call-site bug).
    "Grok gateway API key is not available; seed GROK_GATEWAY_KEY via `hive credentials add GROK_GATEWAY_KEY`",
  ])("auth: %s", (s) => expect(faultKind(s)).toBe("auth"));

  it.each([
    // codex request-failure decoration at a 429 status.
    "Codex subscription request failed (429): slow down",
    // gemini stream-phase failure carrying Google's prose 429.
    "Gemini interaction stream failed (429): Resource has been exhausted (e.g. check quota).",
    // grok-gateway-adapter.ts — gatewayErrorMessage C5 decoration at a 429 status.
    "Grok gateway request failed (429): too many requests",
  ])("rate-limit: %s", (s) => expect(faultKind(s)).toBe("rate-limit"));

  it.each([
    // grok-gateway-adapter.ts — gatewayErrorMessage C5 decoration at a 503 status.
    "Grok gateway request failed (503): upstream unavailable",
  ])("server-error: %s", (s) => expect(faultKind(s)).toBe("server-error"));

  it.each([
    // grok-gateway-adapter.ts — consumeGrokSse edge-3 drop decoration: a
    // stream that ended without finish_reason (not aborted by hive) is a
    // gateway drop, phrased to land on the connect-fail row via "terminated".
    // Deliberate attribution: the loopback gateway is grok route
    // infrastructure — its death classifies as a grok provider fault by
    // design (KPR-306/307 key on the route, not on the vendor endpoint).
    // assembleToolCalls' own incomplete-fragment message is a different
    // string that also carries "terminated" and is pinned separately below.
    // Raw `fetch failed`/`ECONNREFUSED` throws from the gateway fetch call
    // are already row-pinned by the shared FAULT_PATTERNS connect-fail
    // regex and need no adapter-specific row here.
    "Grok gateway stream ended without finish_reason — connection terminated mid-stream",
    // grok-gateway-adapter.ts — Edge 3 spirit guard: finish_reason=tool_calls
    // with zero assembled tool calls is a gateway stream-shape fault, phrased
    // onto the same connect-fail row via "terminated" (r1 fix — was
    // previously worded "malformed stream", which matched no FAULT_PATTERNS
    // row and misclassified non-provider).
    "Grok gateway stream signaled tool_calls but no tool calls were assembled — connection terminated mid-stream",
    // grok-gateway-adapter.ts — assembleToolCalls incomplete-fragment guard
    // (id/name never arrived for an indexed fragment): same connect-fail
    // routing via "terminated".
    "Grok gateway stream delivered an incomplete tool_call at index 0 (missing id or name) — connection terminated mid-stream",
  ])("connect-fail: %s", (s) => expect(faultKind(s)).toBe("connect-fail"));

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
