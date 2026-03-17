/**
 * Parse Claude Code CLI JSON output and detect dodi-dev escalation markers.
 */

export interface ClaudeCodeOutput {
  sessionId: string | null;
  result: string;
  subtype: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export interface EscalationInfo {
  status: "NEEDS_CONTEXT" | "BLOCKED";
  question: string;
  context: string;
}

/**
 * Parse Claude Code JSON output from stdout.
 * The CLI with --output-format json emits a single JSON object on stdout.
 */
export function parseClaudeOutput(stdout: string): ClaudeCodeOutput | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed);
    if (data.type !== "result") return null;

    return {
      sessionId: data.session_id ?? null,
      result: data.result ?? "",
      subtype: data.subtype ?? "unknown",
      costUsd: data.total_cost_usd ?? 0,
      durationMs: data.duration_ms ?? 0,
      numTurns: data.num_turns ?? 0,
      isError: data.is_error === true,
    };
  } catch {
    return null;
  }
}

// Matches "Status: NEEDS_CONTEXT" or "**Status:** BLOCKED" etc.
const ESCALATION_RE = /\*{0,2}Status:?\*{0,2}\s+(NEEDS_CONTEXT|BLOCKED)/i;

// Matches "Question: ..." or "**Question:** ..."
const QUESTION_RE = /\*{0,2}Question:?\*{0,2}\s+(.+?)(?:\n\n|\n\*{0,2}(?:Context|Status|Files|What)|$)/is;

// Matches "Context: ..." or "**Context:** ..."
const CONTEXT_RE = /\*{0,2}Context:?\*{0,2}\s+(.+?)(?:\n\n\*{0,2}(?:Status|Question|Files|To respond)|$)/is;

/**
 * Scan the result text for dodi-dev escalation markers.
 * The implementer subagent reports: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
 */
export function detectEscalation(result: string): EscalationInfo | null {
  if (!result) return null;

  const statusMatch = ESCALATION_RE.exec(result);
  if (!statusMatch) return null;

  const status = statusMatch[1].toUpperCase() as "NEEDS_CONTEXT" | "BLOCKED";

  const questionMatch = QUESTION_RE.exec(result);
  const question = questionMatch?.[1]?.trim() ?? "";

  const contextMatch = CONTEXT_RE.exec(result);
  const context = contextMatch?.[1]?.trim() ?? "";

  return { status, question, context };
}

/**
 * Determine the task status from parsed output + exit code.
 */
export function resolveTaskStatus(
  exitCode: number | null,
  output: ClaudeCodeOutput | null,
  escalation: EscalationInfo | null,
): "completed" | "failed" | "needs_input" {
  // Escalation markers in output always win
  if (escalation) return "needs_input";

  // Budget or turn limit hit — treat as escalation (Jasper decides what to do)
  if (output?.subtype === "error_max_turns" || output?.subtype === "error_max_budget_usd") {
    return "needs_input";
  }

  // Clean success
  if (exitCode === 0 && output?.subtype === "success") return "completed";

  // Exit 0 but no parseable output — still completed (best effort)
  if (exitCode === 0 && !output) return "completed";

  // Everything else is a failure
  return "failed";
}
