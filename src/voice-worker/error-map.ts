/** Bridge failure taxonomy → worker behavior (spec §8 rows). Import-free. */
export type BridgeFailureClass =
  | "budget_saturated" // engine 503 "Voice temporarily unavailable"
  | "engine_auth" // engine 503 "Voice unavailable" (OAuth)
  | "bridge_auth" // 401/400 from E1 — misconfig, won't heal in-call
  | "spawn_failed" // engine 500 (its own outer retry already ran)
  | "engine_unreachable" // ECONNREFUSED / socket error before response
  | "midstream_error"; // SSE error close after first byte

export interface FailureBehavior {
  retryOnce: boolean;
  retryDelayMs: number;
  /** Key into FALLBACK_LINES (static, never LLM-generated). */
  speak: "hold_on" | "apologize_end" | "canned_engine_down" | "none";
  endCall: boolean;
  telemetryOutcome: string;
}

export const FAILURE_BEHAVIOR: Record<BridgeFailureClass, FailureBehavior> = {
  budget_saturated: {
    retryOnce: true,
    retryDelayMs: 2000,
    speak: "hold_on",
    endCall: false,
    telemetryOutcome: "budget_saturated",
  },
  engine_auth: {
    retryOnce: false,
    retryDelayMs: 0,
    speak: "apologize_end",
    endCall: true,
    telemetryOutcome: "engine_auth_failed",
  },
  bridge_auth: {
    retryOnce: false,
    retryDelayMs: 0,
    speak: "apologize_end",
    endCall: true,
    telemetryOutcome: "bridge_auth_failed",
  },
  spawn_failed: {
    retryOnce: true,
    retryDelayMs: 0,
    speak: "none",
    endCall: false,
    telemetryOutcome: "spawn_failed",
  },
  engine_unreachable: {
    retryOnce: false,
    retryDelayMs: 0,
    speak: "canned_engine_down",
    endCall: true,
    telemetryOutcome: "engine_unreachable",
  },
  midstream_error: {
    retryOnce: false,
    retryDelayMs: 0,
    speak: "none",
    endCall: false,
    telemetryOutcome: "midstream_error",
  },
};

/** Static fallback lines — they exist precisely for when the LLM path is broken. */
export const FALLBACK_LINES = {
  hold_on: "Sorry — give me one second.",
  apologize_end: "I'm sorry, I'm having technical trouble on my end. Let me call you back shortly. Goodbye.",
  canned_engine_down: "I'm sorry, I can't continue this call right now. We'll call you back shortly. Goodbye.",
} as const;

export function classifyHttpFailure(status: number, bodySnippet: string): BridgeFailureClass {
  if (status === 401 || status === 400) return "bridge_auth";
  if (status === 503) {
    return bodySnippet.includes("temporarily") ? "budget_saturated" : "engine_auth";
  }
  return "spawn_failed";
}

/**
 * KPR-322 review-round-1 B5: single-action failure decision. The session's
 * error handler executes EXACTLY the returned action — at most ONE spoken
 * line per outcome; the return type makes a double-speak path
 * unrepresentable. Pure; exported for unit tests.
 */
export type FailureAction =
  | { kind: "retry"; sayFirst: "hold_on" | null; delayMs: number }
  | { kind: "continue" } // midstream_error: delivered text was already spoken; the call goes on
  | { kind: "end"; say: "apologize_end" | "canned_engine_down" };

export function resolveFailureAction(cls: BridgeFailureClass, retryAlreadyConsumed: boolean): FailureAction {
  const b = FAILURE_BEHAVIOR[cls];
  if (b.retryOnce && !retryAlreadyConsumed) {
    return { kind: "retry", sayFirst: b.speak === "hold_on" ? "hold_on" : null, delayMs: b.retryDelayMs };
  }
  if (!b.endCall && !b.retryOnce) return { kind: "continue" };
  // Terminal: exhausted retry (budget_saturated / spawn_failed) or hard-end
  // rows (engine_auth / bridge_auth / engine_unreachable).
  return { kind: "end", say: b.speak === "canned_engine_down" ? "canned_engine_down" : "apologize_end" };
}
