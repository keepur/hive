import type { OpsEvent, OpsFilter, OpsSubscription } from "./types.js";

/**
 * KPR-458 D5 / C7 / C17: a conjunction of set-membership tests over the fixed
 * attribute list, and NOTHING else. No OR, negation, nesting, wildcard,
 * regex, comparison operator, arithmetic or scripting. A subscriber needing a
 * disjunction registers a second subscription — a row, not code.
 *
 * PURE and I/O-FREE. This is the one thing that runs synchronously with the
 * publish insert (C2), and a test evaluates it with the database handle
 * instrumented to throw on any access to prove the claim (AC5).
 */
export function matchesFilter(
  event: Pick<OpsEvent, "producer" | "reasonId" | "class" | "waiting" | "retry" | "subject">,
  filter: OpsFilter,
): boolean {
  // An absent field matches everything; a present field matches when the
  // event's value is IN the list; present fields are ANDed.
  //
  // `term()` is not tidiness. A subscription is a DATA row read out of Mongo
  // and `OpsFilter` is a compile-time claim about it, not a runtime guarantee:
  // a row carrying `{ producer: { $ne: "…" } }` makes a bare
  // `filter.producer.includes(…)` THROW, and that throw escapes the pure
  // evaluator into the accept path where the drainer's catch counts it as a
  // publishFault — so one malformed row would suppress publishing for every
  // event. A non-array term value is therefore not a list, cannot be
  // satisfied, and yields no match: fail-closed on SELECTION (nobody is
  // notified) rather than fail-open or fail-loud. Unknown keys (`$or` and
  // friends) are simply not read — ignored, never interpreted (C7).
  const term = <T extends string>(values: readonly T[] | undefined, actual: string): boolean => {
    if (values === undefined) return true;
    if (!Array.isArray(values)) return false;
    return (values as readonly string[]).includes(actual);
  };
  if (!term(filter.producer, event.producer)) return false;
  if (!term(filter.reasonId, event.reasonId)) return false;
  if (!term(filter.class, event.class)) return false;
  if (!term(filter.waiting, event.waiting)) return false;
  if (!term(filter.retry, event.retry)) return false;
  if (!term(filter.subjectKind, event.subject.kind)) return false;
  return true;
}

/**
 * Returns the matched subscription ids, in registration order. The count is
 * its length. Zero is a stored, queryable FACT and never a failure (C2/C3):
 * this function has no fallback, no catch-all and no default subscription,
 * and none may be added.
 */
export function evaluateMatches(
  event: Parameters<typeof matchesFilter>[0],
  subscriptions: readonly OpsSubscription[],
): string[] {
  const matched: string[] = [];
  for (const sub of subscriptions) {
    if (!sub.enabled) continue;
    if (matchesFilter(event, sub.filter)) matched.push(sub._id);
  }
  return matched;
}
