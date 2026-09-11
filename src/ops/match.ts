import { OPS_ID_MAX_LENGTH } from "./ids.js";
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
  //
  // ⚠ THE TERM VALUES ARE GUARDED HERE; THE CONTAINER IS GUARDED BY
  // `isAdmissibleSubscriptionRow` below, and it has to be — the two failures
  // are not the same failure. A missing or `null` `filter` makes
  // `filter.producer` THROW before `term()` is ever called, and a STRING
  // `filter` makes every `filter.<key>` read `undefined`, so `term()` returns
  // true six times and the malformed row matches EVERYTHING — fail-OPEN, the
  // exact inversion of the posture this comment claims. Both are container
  // shapes, not term shapes, so the ONE guard for them sits in that predicate
  // (a second copy here would be the drift this file's one-evaluator
  // discipline forbids).
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
 * ⚠ THE ROW-ADMISSIBILITY PREDICATE, and the ONE copy of it. `OpsSubscription`
 * is a compile-time claim about a document `loadSubscriptions()` read out of
 * `ops_subscriptions` with no shape check (store.ts — a bare
 * `find({enabled:true})`, by design: validating there would let one operator
 * row disable the reload). A row is therefore UNTRUSTED, and one it cannot
 * evaluate is SKIPPED — the same rule chunk 3 states for `loadReasons`: one
 * malformed operator row must cost THAT ROW, never the producer.
 *
 * EXPORTED because the LOAD path needs exactly the answer the MATCH path acts
 * on. Skipping per event is right and costs nothing, but on its own it left the
 * operator with `subscriptions: 1` in the snapshot, `matchedSubscriptionIds: []`
 * on every event forever, and nothing saying why — the silence the `ops_reasons`
 * loader does not have. `OpsPublisher.reloadSubscriptions()` calls this ONCE PER
 * RELOAD to count and name what it skipped; a second predicate anywhere would be
 * the drift this file's one-evaluator discipline forbids, because the counter
 * must name exactly the rows the matcher skips.
 *
 * `enabled` is deliberately NOT tested here. A disabled row is a legitimate
 * operator state and never an anomaly, and `loadSubscriptions()` has already
 * filtered it out on the load path.
 */
export function isAdmissibleSubscriptionRow(sub: OpsSubscription): boolean {
  // THE CONTAINER GUARD. Without it a row whose `filter` is missing or
  // `null` makes `matchesFilter`'s first read throw — out of the "pure"
  // evaluator, out of `accept()` (which has no try of its own), out of
  // `runJob`, and into the drainer's catch, where it is counted as a
  // publishFault and warned. Every event, for as long as the row exists:
  // accept step 8 never runs, so NO ops_events document is written for ANY
  // event, no open-condition entry is created so no recovery is ever
  // enqueued either, and the 60 s reload keeps re-loading the row, so it
  // survives reloads, SIGUSR1 and restarts. Plus one warn line per tool
  // failure AND per recovery — the flood the `overflowWarned` latch exists
  // to prevent, on a path that has no latch. One row, the whole producer.
  //
  // Fail-CLOSED on selection, matching `term()`'s stated posture: a string
  // `filter` is skipped rather than (as it was) matching every event.
  //
  // ⚠ A PROTOTYPE TEST, which is what makes "plain object" TRUE rather than
  // aspirational. The first version of this guard was truthy ∧ typeof-object ∧
  // not-array, and three artifacts called that a plain-object test — it is not:
  // it admits every OTHER non-plain object, and those are exactly the shapes the
  // Mongo driver deserializes a scalar BSON field into. A hand-written row
  // carrying `filter: ISODate(…)`, or a `filter: ObjectId("…")` pasted from a
  // sibling field, read `undefined` on all six terms, so `term()` answered true
  // six times and the row was an UNDECLARED MATCH-ALL subscription whose `_id`
  // rode into `matchedSubscriptionIds` on every stored event. Store-only in this
  // ticket; real spurious delivery on KPR-468, which inherits this evaluator.
  // Safe because every BSON SUBDOCUMENT deserializes with `Object.prototype`.
  //
  // `proto === null` is admitted DELIBERATELY, not by oversight:
  // `Object.create(null)` is a legitimate plain-ish object and some BSON
  // deserialization options produce them, so a bare `=== Object.prototype`
  // would skip a legal row. Pinned by a case in match.test.ts.
  //
  // `filter` is read through an `unknown` local because the guard's whole
  // premise is that the compile-time type is a claim about the row, not a
  // runtime guarantee — the narrowing `OpsFilter` would otherwise impose here is
  // exactly the fiction being tested.
  const filter: unknown = sub.filter;
  const proto = filter !== null && typeof filter === "object" ? Object.getPrototypeOf(filter) : undefined;
  if (proto !== Object.prototype && proto !== null) return false;
  // THE ID BOUND (C2). `_id` is written VERBATIM into
  // `matchedSubscriptionIds` on every matching stored event, and accept
  // step 2 bounds subject/evidence/detail only — so an `ObjectId` or a
  // 100 KB string `_id` from a hand-written row rides into every document
  // this producer stores, forever. Bounded like `clears` is: rejected,
  // never truncated, since a truncated id names a different subscriber.
  //
  // SKIPPED FROM THE MATCH LIST rather than rejecting the publish, decided
  // explicitly. Rejecting would let one malformed SUBSCRIPTION row suppress
  // a real FAILURE record — precisely the "one row kills the producer"
  // posture the container guard above exists to close — and it would spend
  // `rejected`, D9's mis-integrated-PRODUCER signal, on an operator's typo
  // in a different collection. Skipping loses only a delivery that could
  // not have been addressed anyway.
  //
  // ⚠ CONSEQUENCE, stated rather than softened: a row whose `_id` was
  // auto-minted as an `ObjectId` (i.e. inserted without an explicit string
  // `_id`) is never matched, on any event, for as long as it exists.
  // NOT UNOBSERVABLY, which is the half that used to be missing and the reason
  // this predicate is exported: the reload counts it on
  // `subscriptionRowAnomalies` and names its clipped `_id` once per reload, so
  // the operator has a signal rather than an empty match list. The skip itself
  // is by design — `OpsSubscription._id: string` is the contract, a subscription
  // id is an operator-authored slug, and storing an ObjectId into
  // `matchedSubscriptionIds: string[]` would make the stored document lie about
  // its own type. A registration path (KPR-468) must mint the slug.
  //
  // `OPS_ID_MAX_LENGTH` by ADJACENCY, not derivation: 200 is generous for a
  // slug and the two may move independently. This is the omit-on-breach
  // group (ids.ts), not the reject-and-count group.
  if (typeof sub._id !== "string" || sub._id.length < 1 || sub._id.length > OPS_ID_MAX_LENGTH) return false;
  return true;
}

/**
 * Returns the matched subscription ids, in registration order. The count is
 * its length. Zero is a stored, queryable FACT and never a failure (C2/C3):
 * this function has no fallback, no catch-all and no default subscription,
 * and none may be added.
 *
 * A per-row try/catch would contain a throw but still cost a log line per
 * EVENT; the admissibility gate above skips instead, which costs nothing and is
 * the honest answer, because a row that cannot be evaluated cannot have been
 * satisfied and a row that cannot be NAMED cannot be delivered to.
 *
 * An object carrying no recognized key still matches everything. That is NOT a
 * hole: `filter: {}` is the legal match-all row, so "an object the grammar
 * recognizes nothing in" is by design, not by accident.
 */
export function evaluateMatches(
  event: Parameters<typeof matchesFilter>[0],
  subscriptions: readonly OpsSubscription[],
): string[] {
  const matched: string[] = [];
  for (const sub of subscriptions) {
    if (!sub.enabled) continue;
    if (!isAdmissibleSubscriptionRow(sub)) continue;
    if (matchesFilter(event, sub.filter)) matched.push(sub._id);
  }
  return matched;
}
