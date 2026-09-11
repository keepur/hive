/**
 * KPR-454 D6: the error token. D9's words are "tool name plus an enumerated
 * error token" — never a hashed, truncated or otherwise message-derived
 * value. One exported pure classifier used by BOTH lanes (the C6 /
 * KPR-452-D1 one-predicate discipline; a second classifier drifts).
 *
 * Stored under the detail key `errorSig`, because D8 fixes the tool-health
 * view as keyed (detail.tool, detail.errorSig) — the FIELD name is contract
 * even though the VALUE is this producer's choice. There is no `errorToken`
 * key on any stored document.
 */

export const TOOL_ERROR_TOKENS = [
  "timeout",
  "interrupted",
  "transport-unavailable",
  "not-found",
  "invalid-input",
  "permission-denied",
  "rate-limited",
  "upstream-error",
  "unclassified",
] as const;

export type ToolErrorToken = (typeof TOOL_ERROR_TOKENS)[number];

/**
 * Typed signals the caller can supply. Read FIRST, before any text test.
 *
 * ⚠ EXACTLY TWO, and both are POPULATED BY THIS DIFF. D6 names four candidate
 * signals ("an MCP error class, an HTTP status where one is carried, the SDK's
 * `is_interrupt`, the bridge's own TOOL_CALL_TIMEOUT_MS path"); two have no
 * source at either capture point here, and a declared-but-never-populated
 * field is a surface whose unit tests report coverage the runtime lacks
 * (round-1 finding). `isInterrupt` comes from the Claude lane's
 * `PostToolUseFailure.is_interrupt`; `mcpErrorCode` from a thrown `McpError`'s
 * numeric `.code` at the Lane B site — which is ALSO how "the bridge's own
 * TOOL_CALL_TIMEOUT_MS path" arrives, since that value is handed to the MCP
 * SDK as `RequestOptions.timeout` (tool-bridge.ts:235/:245/:283) and the SDK
 * rejects with JSON-RPC `-32001`, mapped below. A separate `timedOut?:
 * boolean` would be a second name for the same fact with no independent
 * source. `httpStatus` is DEFERRED: neither lane holds a status at its
 * capture point (the Claude lane sees text, Lane B an `errorText(err)`
 * message); a provider adapter that later carries one adds the field, its
 * mapping and its call site together. The rule: a signal is declared when a
 * caller in the same diff supplies it, never in anticipation.
 */
export interface ToolErrorSignals {
  /** SDK PostToolUseFailure.is_interrupt. */
  isInterrupt?: boolean;
  /** A JSON-RPC error code from a thrown MCP error, where one is carried. */
  mcpErrorCode?: number;
}

// Case-insensitive substring tests, applied ONLY after the typed signals.
// Deliberately small and fixed: this list is a classifier, not a parser, and
// every miss is honestly `unclassified` rather than a guess.
const TEXT_RULES: ReadonlyArray<readonly [RegExp, ToolErrorToken]> = [
  [/\binterrupted before a result\b/i, "interrupted"], // KPR-438 background-subagent signature
  [/\b(timed? ?out|deadline exceeded|etimedout)\b/i, "timeout"],
  // `connection closed` is load-bearing: on ANY transport close the SDK
  // rejects EVERY in-flight request with `McpError.fromError(
  // ErrorCode.ConnectionClosed, "Connection closed")` (protocol.js:263),
  // message `MCP error -32000: Connection closed` — the stdio-server-died /
  // in-process-server-crashed case this token exists for (verified against the
  // installed SDK). Matched as TEXT, deliberately not code-mapped: protocol.js
  // :334 throws the same -32000 for `Request was cancelled`, so a code map
  // would conflate a cancellation with a transport fault.
  [
    /\b(econnrefused|econnreset|enotfound|socket hang up|fetch failed|server (is )?unavailable|transport closed|connection closed)\b/i,
    "transport-unavailable",
  ],
  [/\b(not found|no such (tool|file|resource)|unknown tool|enoent)\b/i, "not-found"],
  [/\b(invalid (input|argument|parameter|schema)|validation failed|bad request|missing required)\b/i, "invalid-input"],
  [/\b(permission denied|forbidden|unauthorized|not authorized|eacces|access denied)\b/i, "permission-denied"],
  [/\b(rate limit|too many requests|quota exceeded|throttl)/i, "rate-limited"],
  [/\b(internal (server )?error|upstream (error|failure)|bad gateway|service unavailable)\b/i, "upstream-error"],
];

/**
 * The bound on the TEXT the rules above are run over, applied HERE — at the
 * one classifier boundary both lanes share — rather than at either call site,
 * so neither lane can acquire an uncapped path.
 *
 * `message` is unbounded at both capture points: the Claude lane's
 * `PostToolUseFailure.error` is whatever the tool wrote, and Lane B's
 * `errorText(err)` can carry a whole tool payload as the message (that is how
 * `discover()`'s MCP-`isError`→throw conversion arrives). `observeToolFailure`
 * is synchronous on the turn thread, so without this the eight tests below are
 * O(8·n) of turn latency on a path C15 promises does not move a turn's latency
 * profile. Not a ReDoS bound — every pattern here is anchor-free and linear.
 *
 * 4096 rather than something tighter because it costs nothing to be generous:
 * every signature in the table is a short phrase that a real error puts near
 * the front, the message is read and DISCARDED either way (nothing derived
 * from it is stored — C13), and a signature buried past 4 KB simply classifies
 * as `unclassified`, which is this classifier's honest answer for "I could not
 * tell" rather than a wrong one.
 */
const CLASSIFIER_TEXT_MAX = 4096;

/**
 * TOTAL: every input returns exactly one member of TOOL_ERROR_TOKENS. The
 * message is read here and DISCARDED — no substring of it is ever returned,
 * which is what a test asserts against a credential-shaped and a path-shaped
 * input (AC6).
 */
export function classifyToolError(message: string, signals: ToolErrorSignals = {}): ToolErrorToken {
  // 1. Typed signals first — they are facts, the text is an inference.
  if (signals.isInterrupt) return "interrupted";
  // MCP JSON-RPC codes: -32001 is the SDK's own request timeout (this is how
  // the bridge's TOOL_CALL_TIMEOUT_MS surfaces, D6), -32602 invalid params,
  // -32601 method not found. Anything else falls through to the text rules
  // rather than being guessed at.
  if (signals.mcpErrorCode === -32001) return "timeout";
  if (signals.mcpErrorCode === -32602) return "invalid-input";
  if (signals.mcpErrorCode === -32601) return "not-found";

  // 2. A small fixed set of text tests, over a BOUNDED prefix, then honest
  //    ignorance. The typed signals above are read first and short-circuit, so
  //    a capped text never costs a fact.
  const text = message.length > CLASSIFIER_TEXT_MAX ? message.slice(0, CLASSIFIER_TEXT_MAX) : message;
  for (const [pattern, token] of TEXT_RULES) {
    if (pattern.test(text)) return token;
  }
  return "unclassified";
}
