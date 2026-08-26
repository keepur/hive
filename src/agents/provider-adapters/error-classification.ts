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
  | "timeout" // runner deadline fired with ZERO observed progress — the hang signature (KPR-398)
  | "rate-limit" // 429 / rate limit / too many requests
  | "auth" // 401/403/authentication/invalid key
  | "server-error" // 5xx / overloaded / service unavailable
  | "bad-model" // rejected/unknown model id (KPR-312, M8) — config fault, NEVER trips the breaker
  | "turn-deadline" // deadline expiry with proof the provider responded — breaker-INCONCLUSIVE. Lane B sentinel (see TURN_DEADLINE_SUBTYPE, progress-blind) + Claude-lane deadline abort with observed progress (KPR-398)
  | "non-provider"; // everything else — NEVER trips the breaker

export interface TurnFaultInput {
  error?: string; // RunResult.error
  timedOut?: boolean; // RunResult.timedOut (KPR-306)
  aborted?: boolean; // RunResult.aborted
  // KPR-398: per-turn progress evidence (RunResult field names, verbatim, so
  // full-RunResult callers are structurally assignable with no call-site
  // edits). Consulted ONLY inside the timedOut && aborted rule; absent fields
  // are fail-closed (no progress ⇒ hard timeout — a narrowed caller keeps
  // pre-KPR-398 behavior).
  toolCalls?: number;
  streamed?: boolean;
  text?: string;
}

export type TurnClassification =
  | { outcome: "success" } // no error, not aborted
  | { outcome: "aborted" } // operator abort — breaker-neutral
  | { outcome: "fault"; kind: ProviderFaultKind; message: string };

/** Every kind that counts toward the trip streak — all except non-provider
 * and bad-model (a rejected model id is operator config error, not provider
 * unhealth — KPR-312, same reasoning as the non-provider bucketing, now
 * countable instead of invisible). */
export const HARD_FAULT_KINDS: ReadonlySet<ProviderFaultKind> = new Set([
  "connect-fail",
  "timeout",
  "rate-limit",
  "auth",
  "server-error",
]);

/**
 * Lane B wall-clock deadline sentinel. The three native adapters emit this
 * as RunResult.error when the turn's `resourceLimits.timeoutMs` deadline
 * fires (with `timedOut: true` but `aborted: false` — so the Claude-lane
 * `timedOut && aborted` hang rule in classifyTurnResult can never match).
 *
 * Classifies as the dedicated `turn-deadline` kind, which the breaker treats
 * as INCONCLUSIVE — never trips (a Lane B turn's wall clock folds bridged
 * tool execution time in, and a slow-but-healthy tool must never trip a
 * healthy provider — the same asymmetry that keeps toolMs out of the p95
 * llmMs window), but ALSO never resets a hard-fault streak and never closes
 * a half-open probe: unlike every other non-hard fault, a deadline expiry is
 * NOT proof the provider responded (a genuinely hung provider produces
 * exactly this result every turn, since the hive deadline deterministically
 * preempts undici's own timeouts). Short-circuits before the pattern tables.
 */
export const TURN_DEADLINE_SUBTYPE = "error_turn_deadline";

/**
 * SDK result subtypes flattened into RunResult.error verbatim
 * (agent-runner.ts `msg.type === "result"` non-success branch; the Lane B
 * dispatch loops share error_max_turns). These are turn-shape conditions
 * (budget/turn caps, in-execution tool failures), not provider faults —
 * short-circuit them before the pattern tables so e.g.
 * "error_during_execution" can never match a fault row.
 */
const SDK_NON_PROVIDER_SUBTYPES = new Set(["error_max_turns", "error_during_execution"]);

/**
 * First match wins, in row order. The auth row MUST remain a superset of
 * every `isAuthRebuildResumeError` alternate (agent-manager.ts — currently:
 * resolve authentication | credentials\.json | not authenticated |
 * 401 Unauthorized | ANTHROPIC_API_KEY | authToken). It also carries the
 * gemini missing-key sentinel (`api.?key is not available` — KPR-352 §D7: the
 * GeminiInteractionsAdapter's pre-request throw when no Gemini/Google key
 * resolves). A sentinel the auth row misses would classify non-provider and
 * RESET the hard-fault streak, so a persistent auth outage would never trip.
 * Any future addition to the sentinel list must extend this row in the same
 * change (regression-pinned per-alternate in error-classification.test.ts).
 */
const FAULT_PATTERNS: ReadonlyArray<
  readonly [Exclude<ProviderFaultKind, "non-provider" | "timeout" | "turn-deadline">, RegExp]
> = [
  [
    "connect-fail",
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|terminated/i,
  ],
  [
    // The Google alternates cover Gemini's canonical 429 surfaces — the
    // prose message ("Resource has been exhausted (e.g. check quota).",
    // observed classifying non-provider on dodi 2026-08-24), the gRPC-style
    // status token, and the quota-phrased variant. At Google a quota breach
    // IS a 429, so quota-exceeded belongs on this row, not a new kind.
    "rate-limit",
    /\b429\b|rate.?limit|too many requests|resource has been exhausted|RESOURCE_EXHAUSTED|quota exceeded/i,
  ],
  [
    "auth",
    /\b401\b|\b403\b|authentication|unauthorized|invalid.?api.?key|OAuth session is not available|api.?key is not available|not.?authenticated|credentials\.json|ANTHROPIC_API_KEY|authToken|resolve authentication/i,
  ],
  ["server-error", /\b5\d\d\b|overloaded|internal server error|service unavailable|bad gateway|upstream/i],
  [
    // KPR-312 (KPR-310 M8): "There's an issue with the selected model
    // (claude-nonexistent-9). It may not exist or you may not have access to
    // it." — the SDK's rejected-model surface. LAST row by design; the M8
    // string matches no earlier row (verified at delivery, Task 0).
    "bad-model",
    /issue with the selected model|may not exist or you may not have access/i,
  ],
];

function classifyErrorString(error: string): TurnClassification {
  if (error.trim() === TURN_DEADLINE_SUBTYPE) {
    return { outcome: "fault", kind: "turn-deadline", message: error };
  }
  if (SDK_NON_PROVIDER_SUBTYPES.has(error.trim())) {
    return { outcome: "fault", kind: "non-provider", message: error };
  }
  for (const [kind, pattern] of FAULT_PATTERNS) {
    if (pattern.test(error)) return { outcome: "fault", kind, message: error };
  }
  return { outcome: "fault", kind: "non-provider", message: error };
}

/** KPR-398: proof the provider responded THIS turn. Any one signal suffices;
 * all three absent is indistinguishable from a hung provider.
 * KPR-399: exported — finalizeSpawnResult's persist-on-abort gate
 * (agent-manager.ts) reuses this exact predicate as its D1 progress check, so
 * the classifier and the persist gate can never silently diverge. A body
 * change here is a Decision-Register event: it moves both surfaces at once. */
export function hasObservedProgress(input: TurnFaultInput): boolean {
  return (input.toolCalls ?? 0) > 0 || input.streamed === true || (input.text?.length ?? 0) > 0;
}

/**
 * KPR-399: Claude-lane resume-rejection surfaces. (1) the CLI's
 * unknown-session error — the persisted id's transcript never flushed
 * (abort before first write) or was removed; (2) the Messages API 400 when a
 * resumed transcript ends with a dangling tool_use the CLI did not repair.
 * Docs/community-sourced — REFINE against the live capture at delivery
 * (KPR-350 posture; its matcher was refined in KPR-351 L2). Deliberately
 * narrow: a false positive costs one thread's context (fresh retry), a miss
 * costs a dead thread until the 7d TTL. Neither alternate may overlap the
 * auth row (superset rule) — both classify non-provider today, keeping the
 * arm breaker-invisible (pinned in error-classification.test.ts).
 */
export function isClaudeResumeLoadError(reason: string): boolean {
  return (
    /no conversation found with session/i.test(reason) ||
    /tool_use[\s\S]{0,120}?without[\s\S]{0,40}?tool_result/i.test(reason)
  );
}

/**
 * Classify a finished turn's RunResult. Order (first match wins):
 *  1. timedOut && aborted  → deadline abort (the deadline path sets both;
 *     requiring both is belt-and-suspenders on top of the runner-side
 *     activeQuery guard, which is the primary fix). KPR-398 splits this rule
 *     on observed progress: with progress (toolCalls > 0 | streamed | text
 *     nonempty) → the breaker-INCONCLUSIVE turn-deadline kind; zero or
 *     absent progress → the hard timeout kind (the hang signature —
 *     fail-closed, so a caller passing a narrowed input keeps pre-KPR-398
 *     behavior).
 *  2. aborted (alone)      → aborted (neutral — never reached a
 *     provider-attributable outcome; progress fields are never consulted).
 *  3. no error             → success.
 *  4. pattern tables       → fault kind.
 *  5. default              → non-provider (fail-safe).
 */
export function classifyTurnResult(input: TurnFaultInput): TurnClassification {
  if (input.timedOut === true && input.aborted === true) {
    // KPR-398: the Claude runner's own deadline sets BOTH flags
    // (agent-runner.ts deadline timer → abort()), so this shape covers two
    // very different turns. Observed progress = the provider responded this
    // turn ⇒ the same breaker-INCONCLUSIVE turn-deadline kind Lane B's
    // sentinel gets (never trips, never resets a streak, never closes a
    // probe). Zero progress = the hang signature ⇒ hard timeout, so a
    // genuinely hung provider still trips the breaker. Fail-closed on
    // absent fields.
    if (hasObservedProgress(input)) {
      return {
        outcome: "fault",
        kind: "turn-deadline",
        // Attenuation shape (D9 truth-up, KPR-400 — deliberate, pinned in
        // error-classification.test.ts): a real error string coexisting
        // with deadline+progress becomes the turn-deadline message
        // VERBATIM, suppressing the synthesized evidence string below.
        // Unreachable on the Claude deadline path today (`error` stays
        // undefined — the runner's deadline closes the iterator, nothing
        // throws), but if a future caller supplies both, the error string
        // wins: it carries strictly more debugging signal than the
        // synthesized counters, and the KIND (not the message) is what the
        // breaker keys on.
        message:
          input.error ??
          `turn deadline exceeded with progress (toolCalls=${input.toolCalls ?? 0}, streamed=${input.streamed === true}, textLen=${input.text?.length ?? 0})`,
      };
    }
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
  if (err instanceof TurnAssemblyError) {
    return { outcome: "fault", kind: "non-provider", message: err.message };
  }
  return classifyErrorString(String(err));
}

/**
 * KPR-347: typed wrapper for any throw during Lane B turn assembly
 * (inventory build, prompt assembly, gate construction — the pre-runTurn
 * phase). Exists because assembly failure causes are hive-internal (Mongo,
 * config, filesystem) but their MESSAGES can pattern-match provider-fault
 * rows — a Mongo blip's "ECONNREFUSED" would classify connect-fail and
 * count toward a healthy foreign provider's trip streak. The instanceof
 * short-circuit in classifyThrown runs BEFORE the pattern tables.
 */
export class TurnAssemblyError extends Error {
  override readonly name = "TurnAssemblyError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
