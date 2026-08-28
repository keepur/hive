/**
 * KPR-393 §D2: intent-trailer detection — true when delivered text ends on
 * an unexecuted first-person commitment ("I'll check…", "on it", "first
 * step is…"). Conservative and English-only by design: bilingual or
 * non-English output is missed, so the telemetry undercounts rather than
 * misfires. Only booleans ever leave this module — callers must never
 * persist the text (redaction posture).
 *
 * Consumer: agent-manager's activity-audit write (every provider — the
 * Claude lane's rate is the control baseline). The phase-2 loop-nudge
 * decision criteria that read this telemetry are documented in
 * docs/epics/kpr-385/kpr-393-spec.md §D3 (Lane B rate ≥3× Claude AND
 * ≥5 occurrences/week AND ≥70% sampled precision, over ≥14d of data).
 */

/** Only the tail is scanned — promises cluster at the end of a reply;
 *  bounding the window cuts false positives from mid-text narration of
 *  work that the rest of the reply then reports as done. */
const TAIL_CHARS = 300;

/**
 * Conservative first-person-future patterns (spec §D2), word-boundary
 * anchored, curly/straight apostrophes. "let me know" is excluded (a
 * request to the reader, not a self-commitment); bare "on it" anchors to
 * clause starts so "based on it" / "still working on it" never match.
 */
const PATTERNS: readonly RegExp[] = [
  /\bI['’]ll\s+\p{L}+/iu, // "I'll check…"
  /\bI\s+will\s+\p{L}+/iu, // "I will draft…"
  /\bI['’]m\s+going\s+to\s+\p{L}+/iu, // "I'm going to pull…"
  /\blet\s+me\s+(?!know\b|be\b|now\b)\p{L}+/iu, // "Let me inspect…" (never "let me know/be/now" — reader-directed or discourse markers)
  /(?:^|[.!?…\n—–]\s*)(?:I['’]m\s+)?on\s+it\b/iu, // clause-start "on it" / "I'm on it" — ^ = true message start (tail is sentinel-prefixed when sliced)
  /\bfirst\s+step\s+is\b/iu, // "First step is to inspect…"
];

/** True when delivered text ends on an unexecuted first-person commitment.
 *  Conservative, English-only. Empty/whitespace text → false. */
export function detectIntentTrailer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let tail = trimmed.slice(-TAIL_CHARS);
  if (tail.length < trimmed.length) {
    // The slice cut mid-text: prefix a space so the ^ clause-anchor cannot
    // bind to a synthetic start created by the cut. (^ remains valid for
    // short messages where the tail IS the whole text, e.g. "On it.")
    tail = " " + tail;
  }
  return PATTERNS.some((re) => re.test(tail));
}
