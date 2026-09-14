/**
 * KPR-454 D4/D6: this producer's bounds, and why they differ.
 *
 * Deliberately NOT counted here — the count rotted once already. They fall
 * into three groups whose behaviour ON BREACH differs, and that difference is
 * the whole reason they are separate constants rather than one number: the
 * accept-path value bounds REJECT AND COUNT (`OPS_TOKEN_RE`,
 * `OPS_ID_MAX_LENGTH`, `OPS_EVIDENCE_MAX`, `OPS_DETAIL_STRING_MAX`,
 * `OPS_CLEARS_MAX_LENGTH`; `OPS_REMEDIATION_MAX` is the registration-time
 * sibling and THROWS, because its subject is code-resident); the capture-point
 * bound OMITS (`ADMISSIBLE_ID_RE` via `admissibleIdOrUndefined`); and the log
 * bound only SHORTENS what is printed and changes no decision at all
 * (`OPS_LOG_VALUE_MAX` via `clipForLog`). Each constant's own comment says
 * which group it is in and why.
 *
 * ⚠ There is deliberately NO stored-list bound on `matchedSubscriptionIds`, and
 * a fourth group must not be minted for one. KPR-458 D2 fixes
 * `matchedSubscriptions` as that list's LENGTH and calls the list "the only
 * join between the synchronous half and the swept half", bounded by "the
 * registered subscription set, which is operator-registered data and does not
 * grow with traffic". A truncating bound there breaks the identity and silently
 * strands every subscriber past the cut — KPR-468's sweep reads the stamped
 * list and never re-evaluates a filter. See the stamp site in publisher.ts.
 *
 * The token bound and the length bound are ACCEPT-PATH validation: a breach
 * is a mis-integrated producer, so it rejects and increments the rejection
 * counter (C5), never truncates.
 *
 * `admissibleIdOrUndefined` is a CAPTURE-POINT bound and behaves the opposite
 * way: a
 * breach OMITS the key. Three independent paths put text this producer did
 * not author into `detail.workItemId` / `detail.threadId` / `evidence[].id` —
 * the ws/app channel accepts a client-supplied WorkItem id and threadId
 * behind a bare `typeof === "string"` (ws-adapter.ts:262/:563, validated at
 * ws/protocol.ts:228/:235), the voice channel takes its callId verbatim from
 * the Vapi webhook body (voice-adapter.ts:192, becoming the id at :275 and
 * the `voice:` threadId at :236), and `sched:` ids embed the operator's
 * free-form cron task label (scheduler.ts:231/:236). Omission is chosen over
 * rejection on three grounds (D6): rejecting would discard a real failure
 * record over one optional attribute; the rejection counter is the
 * mis-integrated-producer signal and must not be client-drivable; and an
 * omitted id lands in the already-specified absent-workItemId shape
 * (`evidence: []`, `waiting: "nobody"`) rather than a new one.
 *
 * The charset is sized to the id population D6's two tables enumerate under a
 * stated inclusion criterion — every value that can reach a turn's
 * WorkItemContext.workItemId or .threadId. `+` carries `sms:<line>:+1555…`
 * and `@` carries `imessage:<apple-id-email>`; each carries exactly one shape,
 * so each is what a careless tightening would drop first.
 */

/** D2: producer / reasonId / subject.kind / evidence[].kind. */
export const OPS_TOKEN_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * D4: subject.id and evidence[].id. Generous against the real population
 * (`mcp__<server>__<tool>`).
 *
 * ⚠ ALSO the bound on a subscription row's `_id` in `evaluateMatches`
 * (match.ts) — by ADJACENCY, not derivation, and with the OTHER breach
 * behaviour: there a breach SKIPS the row from the match list rather than
 * rejecting the publish, because a malformed subscription row must not be able
 * to suppress a real failure record. Either use may move without the other.
 *
 * ⚠ AND the bound on an acknowledgement's `actorId` at KPR-468's intake seam
 * (intake.ts, step 2) — adjacency again, with a THIRD breach behaviour: the
 * act is refused `unattributed`, never truncated.
 */
export const OPS_ID_MAX_LENGTH = 200;

/** D2: at most 4 references per event. This producer never emits more than one. */
export const OPS_EVIDENCE_MAX = 4;

/**
 * D6/C13: the hard ceiling on any string value admitted into `detail`, and
 * the default when a row declares no `maxLength`. A ceiling rather than a
 * default because `detailKeys` may arrive as DATA — `loadReasons()` compiles
 * whatever `ops_reasons` holds, including a row this engine's code does not
 * contain (D4, AC16) — so `{key:"x", type:"string"}` with no bound, or one
 * declaring `maxLength: 1_000_000`, would otherwise put an unbounded string
 * into a stored document through the very schema that IS the redaction
 * boundary. 200 reuses `OPS_ID_MAX_LENGTH` and covers every key this
 * producer's own rows declare.
 *
 * ⚠ The reuse is ADJACENCY, not derivation: the two are equal today by
 * judgement and either may move without the other.
 *
 * ⚠ And this is an ENGINE-WIDE ceiling on every producer, including a foreign
 * one whose row this code does not contain. KPR-458 D12 assigns the
 * `maxLength` column to the producer; KPR-454 narrows it — a legitimate engine
 * bound, but a real divergence from the contract as a foreign author reads it.
 * A producer needing more does not raise its own `maxLength` (clamped, and
 * reported by `auditReasonRow`); it asks for this constant to move, which is an
 * engine change with a review attached.
 */
export const OPS_DETAIL_STRING_MAX = 200;

/** D4: a remediation template is "a bounded parameterised string" — the bound. */
export const OPS_REMEDIATION_MAX = 500;

/**
 * The bound on a `clears` key — the one string the accept path STORES (and
 * derives an INDEXED `clearsFamily` from) that none of the bounds above
 * reach: `subject`/`detail`/`evidence` are each bounded on their own, and the
 * `clears` legality test reads one component of the key.
 *
 * ⚠ DELIBERATELY LOOSE, and the arithmetic matters. D2's dedupeKey is
 * `<producer>:<subject.kind>:<subject.id>:<reasonId>:<generation>`, so its
 * maximum legal length under the bounds above is three tokens (40 each, per
 * `OPS_TOKEN_RE`) + one id (200) + four separators + the generation's decimal
 * digits — **324 plus the generation**. A tighter number (e.g.
 * `OPS_ID_MAX_LENGTH + 64` = 264) would REJECT a legitimate key from a
 * foreign producer whose own producer/subject.kind tokens are long, which is
 * the exact opposite of what this guards: the job is to stop an UNBOUNDED
 * string being stored and indexed, not to re-derive the key grammar at the
 * accept path. 512 leaves the generation ~188 digits no counter will reach.
 */
export const OPS_CLEARS_MAX_LENGTH = 512;

/** D6: the capture-point admissibility bound for externally-authored ids. */
export const ADMISSIBLE_ID_RE = /^[A-Za-z0-9_.:#+@-]{1,200}$/;

/**
 * C13: the bound on any operator- or foreign-producer-authored value this
 * producer writes into a LOG line. Its own group rather than a reuse of the
 * bounds above, because it governs a different surface: the others decide what
 * is STORED (and reject or omit on breach), this one only shortens what is
 * PRINTED and never changes a decision.
 *
 * It exists because two of the FOUR places that name such a value are reached
 * PRECISELY when it failed its own bound — the accept path's `bad-token` /
 * `bad-subject-kind` rejections (publisher.ts), and the registry loader's
 * unusable-row skip and per-row anomaly tally (store.ts) — so logging them raw
 * is the one place this producer's log lines are unbounded. The third is
 * `auditLoadedEnableGate` (publisher.ts), where the value came from a LOADED
 * `ops_reasons` row rather than from a breach: nothing validates a row's
 * `producer`/`reasonId` against the token bound on the load path (D5 loads
 * whatever the collection holds), so the clip is the same defence there for the
 * same reason. 64 is long enough to identify a legitimate token (the token
 * bound is 40) and short enough that a megabyte of foreign input costs one log
 * line of it.
 *
 * ⚠ THE FOURTH, added late and formerly MISSED BY THIS ENUMERATION: the
 * anomaly TEXT `auditReasonRow` composes (reasons.ts), which `loadReasons`
 * writes into the boot log up to `REASON_ROW_ANOMALY_LOG_MAX` times per row.
 * Round 2 bounded the COUNT of those lines and left their WIDTH open, and the
 * enumeration above asserted a coverage the code lacked — a row's `producer`
 * and `reasonId` are clipped at this bound there, and its `key` / `type` /
 * `maxLength` at `OPS_LOG_ANOMALY_VALUE_MAX` below.
 */
export const OPS_LOG_VALUE_MAX = 64;

/**
 * C13: the same log group as `OPS_LOG_VALUE_MAX`, at a SECOND bound, because
 * the value it governs has a second legal maximum.
 *
 * `auditReasonRow` names a `detailKeys` entry's `key` and `type`, both from a
 * document this engine did not author and neither validated on the load path.
 * Their CODE-DECLARED legal maxima are `DETAIL_KEY_NAME_RE`'s 64 characters
 * (reasons.ts) and the three literals `"string" | "number" | "boolean"` — so a
 * bound ABOVE 64 never fires on a legal value, which is what makes clipping at
 * the SOURCE lossless for `assertReasonTableLegal`'s developer-facing throws
 * too: where the clip fires, the name is by definition illegal and the message
 * already says so (`key NAME fails /^[A-Za-z].../`), and its first 80
 * characters identify it completely.
 *
 * 80 rather than `OPS_LOG_VALUE_MAX`: 64 is sized against `OPS_TOKEN_RE`'s 40
 * and would fire at EXACTLY the key-name bound, an adjacency that would start
 * silently clipping legal names the day `DETAIL_KEY_NAME_RE` widened. The
 * headroom states the relationship instead of coinciding with it.
 */
export const OPS_LOG_ANOMALY_VALUE_MAX = 80;

export function isOpsToken(value: string): boolean {
  return OPS_TOKEN_RE.test(value);
}

/**
 * C13. Takes `unknown` DELIBERATELY: every caller sits on the fail-closed
 * accept/load path, where the value is typed `string` but arrives from a
 * document this engine did not author, so a non-string must shorten to a
 * marker rather than throw out of a log statement.
 *
 * `max` is a parameter rather than a second function because there is one clip
 * PREDICATE and two bounds (see `OPS_LOG_ANOMALY_VALUE_MAX`); a second copy of
 * three lines is how the two drift.
 */
export function clipForLog(value: unknown, max: number = OPS_LOG_VALUE_MAX): string {
  const text = typeof value === "string" ? value : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * D6. `undefined` in ⇒ `undefined` out, so a capture point can write
 * `const workItemId = admissibleIdOrUndefined(ctx?.workItemId)` and the
 * absent case and the inadmissible case converge on one shape by
 * construction rather than by a second branch.
 */
export function admissibleIdOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return ADMISSIBLE_ID_RE.test(value) ? value : undefined;
}
