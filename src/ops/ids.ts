/**
 * KPR-454 D4/D6: the four bounds, and why they differ.
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

/** D4: subject.id and evidence[].id. Generous against the real population (`mcp__<server>__<tool>`). */
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

/** D6: the capture-point admissibility bound for externally-authored ids. */
export const ADMISSIBLE_ID_RE = /^[A-Za-z0-9_.:#+@-]{1,200}$/;

export function isOpsToken(value: string): boolean {
  return OPS_TOKEN_RE.test(value);
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
