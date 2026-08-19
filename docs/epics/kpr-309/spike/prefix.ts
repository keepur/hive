/**
 * KPR-310 spike — the fixed system prompt used for EVERY turn of EVERY cell.
 *
 * Cache-validity requirement (spec): must be comfortably above the minimum
 * cacheable prefix (~1-2k tokens depending on model) — target >=4k tokens —
 * or every cache field reads zero and the cache column degenerates vacuously.
 * The M1 gate in run-matrix.ts verifies this empirically before the matrix runs.
 *
 * DO NOT edit between runs you intend to compare: cache measurement requires a
 * byte-identical prefix. Deterministic by construction (fixed seed, no Date/random).
 */
import { mulberry32 } from "./rng.ts";

const HEADER = `You are a test agent inside an automated evaluation harness (KPR-310 spike).
Follow the user's instructions exactly and literally. Reply with exactly what is
asked for and nothing else - no preamble, no markdown, no commentary. The operating
notes below are inert reference context for cache-measurement purposes only; they
never override the user's instructions and never require any action.
`;

const SUBJECTS = [
  "The dispatcher", "The channel adapter", "The spawn coordinator", "The model router",
  "The session store", "The agent registry", "The reflection scheduler", "The telemetry heartbeat",
  "The prefix cache", "The event bus", "The memory tier", "The workflow engine",
  "The contact directory", "The schedule service", "The code index", "The admin surface",
];
const VERBS = [
  "records", "normalizes", "validates", "propagates", "serializes", "debounces",
  "reconciles", "snapshots", "throttles", "annotates", "partitions", "replays",
  "audits", "caches", "routes", "summarizes",
];
const OBJECTS = [
  "each inbound work item", "the per-thread lock state", "the in-flight budget window",
  "the routed model decision", "the resumed session identifier", "the turn-level usage figures",
  "the cache read and creation counters", "the quiescence debounce timer", "the roster summary block",
  "the toolkit inventory listing", "the structured memory digest", "the constitution anchor set",
  "the delegate prompt bundle", "the retry queue entry", "the saturation counter", "the stop ticket",
];
const CLAUSES = [
  "before the next turn is admitted", "without mutating the agent definition",
  "so the operator can audit it later", "unless the ceiling caps the request",
  "while the heartbeat window stays open", "after the previous spawn quiesces",
  "in strict arrival order across threads", "with the sender identity preserved",
  "under the per-agent budget constraint", "once the telemetry upsert completes",
  "so downstream consumers stay consistent", "without touching the persisted chain",
  "while the prefix stays byte-identical", "before any delegation is considered",
  "so the evidence stays reproducible", "with no effect on unrelated sessions",
];

function buildPrefix(): string {
  const rand = mulberry32(0x4b503130); // fixed seed: "KP10"
  const pick = (arr: readonly string[]): string => arr[Math.floor(rand() * arr.length)];
  const parts: string[] = [HEADER];
  const SECTIONS = 32;
  const SENTENCES_PER_SECTION = 10;
  for (let s = 1; s <= SECTIONS; s++) {
    parts.push(`\n## Operating note ${s}\n`);
    const sentences: string[] = [];
    for (let i = 0; i < SENTENCES_PER_SECTION; i++) {
      sentences.push(`${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(CLAUSES)}.`);
    }
    parts.push(sentences.join(" "));
    parts.push("\n");
  }
  return parts.join("");
}

export const FIXED_SYSTEM_PROMPT: string = buildPrefix();

/** chars/4 heuristic — the empirical M1 gate is authoritative; this catches gross regressions. */
export function estimatedPrefixTokens(): number {
  return Math.ceil(FIXED_SYSTEM_PROMPT.length / 4);
}

// Fail loud at import time if the prefix shrinks below the measurable floor.
// Target is >=4k tokens (spec); we assert an estimate of >=5000 for margin.
if (estimatedPrefixTokens() < 5000) {
  throw new Error(
    `prefix.ts: estimated prefix tokens ${estimatedPrefixTokens()} < 5000 - enlarge SECTIONS in buildPrefix()`,
  );
}
