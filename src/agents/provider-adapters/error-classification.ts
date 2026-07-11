/**
 * KPR-306: typed error classification at the provider-adapter boundary.
 *
 * All four adapters resolve provider faults into `RunResult.error: string`
 * (they do not throw for provider faults). This module maps that string —
 * plus the `timedOut`/`aborted` flags — into a typed taxonomy the circuit
 * breaker consumes.
 *
 * Fail-safe bias: an unrecognized error string classifies `non-provider`
 * and NEVER trips the breaker. Under the breaker's reset semantics a missed
 * provider fault doesn't just delay a trip — it resets the consecutive-fault
 * streak — but a false positive (a tool failure tripping the breaker) takes
 * a healthy provider offline outright. The asymmetry dictates the default.
 *
 * Pure and dependency-free by design (no logger, no config).
 */

export type ProviderFaultKind =
  | "connect-fail" // network-level: refused/reset/DNS/fetch failed
  | "timeout" // runner deadline fired (RunResult.timedOut)
  | "rate-limit" // 429 / rate limit / too many requests
  | "auth" // 401/403/authentication/invalid key
  | "server-error" // 5xx / overloaded / service unavailable
  | "non-provider"; // everything else — NEVER trips the breaker

export interface TurnFaultInput {
  error?: string; // RunResult.error
  timedOut?: boolean; // RunResult.timedOut (KPR-306)
  aborted?: boolean; // RunResult.aborted
}

export type TurnClassification =
  | { outcome: "success" } // no error, not aborted
  | { outcome: "aborted" } // operator abort — breaker-neutral
  | { outcome: "fault"; kind: ProviderFaultKind; message: string };

/** Every kind that counts toward the trip streak — all except non-provider. */
export const HARD_FAULT_KINDS: ReadonlySet<ProviderFaultKind> = new Set([
  "connect-fail",
  "timeout",
  "rate-limit",
  "auth",
  "server-error",
]);

/**
 * SDK result subtypes flattened into RunResult.error verbatim
 * (agent-runner.ts `msg.type === "result"` non-success branch). These are
 * turn-shape conditions (budget/turn caps, in-execution tool failures), not
 * provider faults — short-circuit them before the pattern tables so e.g.
 * "error_during_execution" can never match a fault row.
 */
const SDK_NON_PROVIDER_SUBTYPES = new Set(["error_max_turns", "error_during_execution"]);

/**
 * First match wins, in row order. The auth row MUST remain a superset of
 * every `isAuthRebuildResumeError` alternate (agent-manager.ts — currently:
 * resolve authentication | credentials\.json | not authenticated |
 * 401 Unauthorized | ANTHROPIC_API_KEY | authToken). A sentinel the auth row
 * misses would classify non-provider and RESET the hard-fault streak, so a
 * persistent auth outage would never trip. Any future addition to the
 * sentinel list must extend this row in the same change (regression-pinned
 * per-alternate in error-classification.test.ts).
 */
const FAULT_PATTERNS: ReadonlyArray<
  readonly [Exclude<ProviderFaultKind, "non-provider" | "timeout">, RegExp]
> = [
  [
    "connect-fail",
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|terminated/i,
  ],
  ["rate-limit", /\b429\b|rate.?limit|too many requests/i],
  [
    "auth",
    /\b401\b|\b403\b|authentication|unauthorized|invalid.?api.?key|OAuth session is not available|not.?authenticated|credentials\.json|ANTHROPIC_API_KEY|authToken|resolve authentication/i,
  ],
  ["server-error", /\b5\d\d\b|overloaded|internal server error|service unavailable|bad gateway|upstream/i],
];

function classifyErrorString(error: string): TurnClassification {
  if (SDK_NON_PROVIDER_SUBTYPES.has(error.trim())) {
    return { outcome: "fault", kind: "non-provider", message: error };
  }
  for (const [kind, pattern] of FAULT_PATTERNS) {
    if (pattern.test(error)) return { outcome: "fault", kind, message: error };
  }
  return { outcome: "fault", kind: "non-provider", message: error };
}

/**
 * Classify a finished turn's RunResult. Order (first match wins):
 *  1. timedOut && aborted  → timeout fault (the deadline path sets both;
 *     requiring both is belt-and-suspenders on top of the runner-side
 *     activeQuery guard, which is the primary fix).
 *  2. aborted (alone)      → aborted (neutral — never reached a
 *     provider-attributable outcome).
 *  3. no error             → success.
 *  4. pattern tables       → fault kind.
 *  5. default              → non-provider (fail-safe).
 */
export function classifyTurnResult(input: TurnFaultInput): TurnClassification {
  if (input.timedOut === true && input.aborted === true) {
    return { outcome: "fault", kind: "timeout", message: input.error ?? "turn deadline exceeded" };
  }
  if (input.aborted === true) return { outcome: "aborted" };
  if (!input.error) return { outcome: "success" };
  return classifyErrorString(input.error);
}

/**
 * Classify the rare throw path out of `adapter.runTurn` (e.g. codex
 * missing-OAuth throw pre-RunResult). Same tables, same fail-safe default.
 */
export function classifyThrown(err: unknown): TurnClassification {
  return classifyErrorString(String(err));
}
