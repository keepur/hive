# KPR-454 plan — chunk 2: the contract module

Implements design **D1**, **D4**, **D5**, **D6** (types, registry rows, error tokens, id bound). One task, one commit; its unit coverage is [chunk 2b](kpr-454-plan-2b-contract-tests.md) (Task 3), split out at the Task 2 | Task 3 seam to keep each half inside the 1,000-line review bound. Everything here is pure: no Mongo, no I/O, no singleton. That is deliberate — the enable gate and the classifier must be unit-testable without a database, and the publisher (chunk 3) consumes this module rather than re-declaring any of it.

---

### Task 2: Types, reason registry, error tokens, id bound

**Files** (listed in the order the steps below create them — that order carries the real dependency: `reasons.ts` imports `OPS_TOKEN_RE`, `OPS_DETAIL_STRING_MAX` and `OPS_REMEDIATION_MAX` from `ids.ts`, so `ids.ts` must exist first):
- Create: `src/ops/types.ts` (Step 1)
- Create: `src/ops/ids.ts` (Step 2)
- Create: `src/ops/error-tokens.ts` (Step 3)
- Create: `src/ops/reasons.ts` (Step 4)
- Create: `src/ops/match.ts` (Step 5)

- [ ] **Step 1:** Create `src/ops/types.ts`.

This is the D2 envelope, stated once. Nothing else in the repository may re-declare any of these unions. Note what is **absent** and must stay absent: `owner`, `escalatedTo`, `assignee`, `severity`, `loudness`, `priority`, `destination`, `channel`, `recipient`, and any rendered message string.

```typescript
/**
 * KPR-454 / KPR-458 D2-D5: the ops-event contract types.
 *
 * This module is the ONE declaration of the envelope, the three closed
 * vocabularies, the reason-registry document and the subscription document.
 * It imports nothing but types and performs no I/O, so it is safe to import
 * from `src/outage/outage-notices.ts` (type-only) without creating a runtime
 * cycle. The `mongodb` import below is `import type` for exactly that reason:
 * it is erased at compile time and adds no runtime edge.
 */
import type { ObjectId } from "mongodb";

/** D3: who can clear it, and by what act. */
export type OpsClass = "integrity" | "resource" | "judgment" | "informational";

/** D3: does an identical retry reproduce this? Property of the reason, never of the moment. */
export type OpsRetry = "transient" | "deterministic";

/**
 * D3: invocation context. Producer-supplied per event because it varies per
 * publication for the same reason. `obligation` is never derived by the
 * runtime — KPR-456's sweep is the only component that knows a deadline exists.
 */
export type Waiting = "human-now" | "obligation" | "agent" | "nobody";

/** D2: `{kind, id}`. `kind` names the producer's own key space; `id` is stable, never a display name. */
export interface OpsSubject {
  kind: string;
  id: string;
}

/** D2: references only — no text, no URLs. This producer's whole `kind` vocabulary is "workItem". */
export interface OpsEvidence {
  kind: string;
  id: string;
}

/** D2: flat map of scalars whose keys, types and bounds the registry row declares. */
export type OpsDetail = Record<string, string | number | boolean>;

/** The stored document. D9 step 8's complete key set — nothing else is ever written. */
export interface OpsEvent {
  /**
   * Server-assigned; the producer never supplies it, the Node driver mints it
   * client-side at insert. ⚠ `ObjectId`, not `unknown`, and not cosmetic:
   * `insertOne` resolves `OptionalUnlessRequiredId` through `InferIdType`,
   * which maps `_id?: unknown` onto `ObjectId`, and `unknown` is not
   * assignable to it — so chunk 3's `this.store.events.insertOne(doc)` FAILS
   * `tsc` (reproduced in-tree, round 1, tsc 6.0.3 / mongodb 7.6.0). Dropping
   * the field is not the fix: `isMoreRecent`'s `String(a._id)` needs it.
   */
  _id?: ObjectId;
  schemaVersion: number;
  publishedAt: Date;
  producer: string;
  reasonId: string;
  class: OpsClass;
  retry: OpsRetry;
  waiting: Waiting;
  subject: OpsSubject;
  generation: number;
  dedupeKey: string;
  detail: OpsDetail;
  evidence: OpsEvidence[];
  matchedSubscriptions: number;
  matchedSubscriptionIds: string[];
  /** Present on a clearing event only. */
  clears?: string;
  /** Derived from `clears`: the cleared dedupeKey with its generation component removed. */
  clearsFamily?: string;
}

/** D4: one scalar the registry row admits into `detail`. */
export interface DetailKeySpec {
  key: string;
  type: "string" | "number" | "boolean";
  /**
   * Strings only. Required for `type: "string"` — ENFORCED, not merely
   * documented, because the allow-list IS the C13 redaction boundary and an
   * unbounded string key admits an unbounded stored field. Two enforcement
   * points: `assertReasonTableLegal` (code-resident half, a loud development
   * throw) and `compileDetailSchema` (data-sourced half, clamped at
   * `OPS_DETAIL_STRING_MAX`).
   */
  maxLength?: number;
  /** Absent ⇒ required. */
  optional?: boolean;
}

/** D4: one entry per (producer, reasonId). Stored in `ops_reasons`, `_id` = `<producer>:<reasonId>`. */
export interface OpsReason {
  producer: string;
  reasonId: string;
  class: OpsClass;
  retry: OpsRetry;
  /** Required, no default: a bounded parameterised string naming the act that would clear this. */
  remediationTemplate: string;
  detailKeys: DetailKeySpec[];
  /** Marks this reason as a clearing reason for one or more condition reasons of the SAME producer. */
  clearsReasonIds?: string[];
  enabled: boolean;
}

/** D5: the filter grammar. A conjunction of set-membership tests, and nothing else. */
export interface OpsFilter {
  producer?: string[];
  reasonId?: string[];
  class?: OpsClass[];
  waiting?: Waiting[];
  retry?: OpsRetry[];
  subjectKind?: string[];
}

/** D5: a subscription document. This ticket creates the collection and registers ZERO rows. */
export interface OpsSubscription {
  _id: string;
  subscriberId: string;
  subscriberKind: string;
  enabled: boolean;
  filter: OpsFilter;
  transport: { adapterId: string; target: string };
  cadenceProfile?: string;
}

/**
 * The publisher's input. NOTE what is not here and cannot be: `class`,
 * `retry`, `schemaVersion`, `publishedAt`, `dedupeKey`, `clearsFamily`,
 * `matchedSubscriptions`, `matchedSubscriptionIds`. C4 is satisfied
 * structurally — a caller has no parameter that could assert them.
 */
export interface OpsPublishInput {
  producer: string;
  reasonId: string;
  waiting: Waiting;
  subject: OpsSubject;
  detail: OpsDetail;
  evidence: OpsEvidence[];
  /** Optional dedupeKey this event asserts is resolved (D2/C19). */
  clears?: string;
}

/** D2: additive-only. Written on the very first document — never back-filled. */
export const OPS_SCHEMA_VERSION = 1;

export const OPS_EVENTS_COLLECTION = "ops_events";
export const OPS_SUBSCRIPTIONS_COLLECTION = "ops_subscriptions";
export const OPS_REASONS_COLLECTION = "ops_reasons";
```

- [ ] **Step 2:** Create `src/ops/ids.ts` — the D6 bounds.

Four distinct bounds live here and must not be conflated; each acts at a different point and breaches differently, which is why they are four constants rather than one. The difference is a decided part of the design, not an implementation detail.

| Bound | Applies to | On breach |
| --- | --- | --- |
| `^[a-z][a-z0-9-]{0,39}$` | `producer`, `reasonId`, `subject.kind`, `evidence[].kind` | **reject + count** at accept (C5) |
| length 1–200 | `subject.id`, `evidence[].id` | **reject + count** at accept — never truncated (D4: truncation silently merges two tools into one condition) |
| `^[A-Za-z0-9_.:#+@-]{1,200}$` | `detail.workItemId`, `detail.threadId`, `evidence[].id` **at the capture point** | **omit + count `idOmitted`** — never reject (D6) |
| `OPS_DETAIL_STRING_MAX = 200` | every `detail` string value, via the schema the row's `detailKeys` compiles to | **reject + count** at accept, as any schema failure — and the ceiling is applied to the *row itself*, so an unbounded or over-large `maxLength` cannot widen it |

```typescript
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
```

- [ ] **Step 3:** Create `src/ops/error-tokens.ts` — the closed nine-value set and its one classifier.

Two properties are load-bearing and both get tests: the classifier is **total** (every input returns a token), and its output is drawn **only** from the closed set — which is what makes C13 true by construction rather than by a scrub pass. The error text is used for classification and then **discarded**; nothing derived from it is stored.

```typescript
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
  [/\b(econnrefused|econnreset|enotfound|socket hang up|fetch failed|server (is )?unavailable|transport closed|connection closed)\b/i, "transport-unavailable"],
  [/\b(not found|no such (tool|file|resource)|unknown tool|enoent)\b/i, "not-found"],
  [/\b(invalid (input|argument|parameter|schema)|validation failed|bad request|missing required)\b/i, "invalid-input"],
  [/\b(permission denied|forbidden|unauthorized|not authorized|eacces|access denied)\b/i, "permission-denied"],
  [/\b(rate limit|too many requests|quota exceeded|throttl)/i, "rate-limited"],
  [/\b(internal (server )?error|upstream (error|failure)|bad gateway|service unavailable)\b/i, "upstream-error"],
];

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

  // 2. A small fixed set of text tests, then honest ignorance.
  for (const [pattern, token] of TEXT_RULES) {
    if (pattern.test(message)) return token;
  }
  return "unclassified";
}
```

- [ ] **Step 4:** Create `src/ops/reasons.ts` — the two rows, the enable gate, and the detail-schema compiler.

Three things live here and the separation between the first two is the kill switch:

- `HIVE_RUNTIME_REASONS` is the **code-resident** table. It is the *write* direction (the boot upsert's source) and the enable gate's input, and nothing else.
- The accept path resolves a row from the **collection**, via the map `init()` loads back — never from this constant. That is what makes `enabled: false` + restart a working kill switch, and what lets a row this code does not contain (a second reason added later as data, or an out-of-engine producer's) take effect at the next boot with no engine change (AC16).
- `auditReasonRow` is the **diagnostic** half, and it exists because `compileDetailSchema` normalizes a data-sourced row three ways — an over-ceiling `maxLength` (clamped), an unrecognized `spec.type` (falls through to boolean), an unbounded key **name** — each of which fails *closed* but leaves the operator only the generic rejection counter, which D9 reserves for a mis-integrated **producer**. A conforming foreign row declaring `maxLength: 400` would otherwise have every over-200 publish rejected and counted as if the producer were malformed, in the one subsystem whose stated posture is "logged and counted, never silent". It is pure and decides nothing; the gate throws on its output for the code-resident half, and chunk 3's `loadReasons` loop warns and counts on it for the data-sourced half. `compileDetailSchema`'s behaviour is **unchanged** — the clamp asymmetry is correct and stays.
- `assertReasonTableLegal` is a **pure precondition over the code-resident table**, evaluated before any I/O and pinned by a unit test — so a violation is a development-time throw, never an operational boot fault, and it is untouched by D10's rule that `init()`'s I/O is non-fatal to boot. **Its one call site is the `OpsPublisher` constructor** (chunk 3, Task 4, Step 3), *not* `upsertReasons` and *not* `init()`: chunk 4 constructs the publisher outside its `try { await init() } catch`, so the gate stays D10's one **loud** failure mode instead of degrading into the same warn-and-unset posture as a Mongo blip.

```typescript
import { z } from "zod";
import type { DetailKeySpec, OpsReason } from "./types.js";
import { OPS_DETAIL_STRING_MAX, OPS_REMEDIATION_MAX, OPS_TOKEN_RE } from "./ids.js";

/** D1: the engine itself, reporting what it observed. A bounded token, never an enum member. */
export const HIVE_RUNTIME_PRODUCER = "hive-runtime";

export const REASON_TOOL_FAILED = "tool-failed";
export const REASON_TOOL_RECOVERED = "tool-recovered";

/**
 * D5: the two rows this producer ships, both enabled at deploy.
 *
 * ORDER IS LOAD-BEARING (D5): `tool-recovered` is upserted FIRST. Neither
 * order leaves every prefix of the write sequence legal, so the choice is a
 * severity comparison between two illegal middle states. Failure-first would
 * leave a persisted, ENABLED, class:resource row that no registered reason
 * clears — the state D4's enable gate exists to refuse, live and consequential
 * (a condition raised under it could never be cleared: D2's permanent
 * silence). Clearing-first leaves a dangling forward reference that nothing
 * dereferences: `tool-recovered` is informational so nothing selects it, its
 * clearsReasonIds is read only by the gate and by C19's publish-time check,
 * and with `tool-failed` unregistered C5 fails closed on every tool-failed
 * publish so no event carrying a `clears` into that family can exist. A
 * bookkeeping defect beats a silence generator, and the next boot repairs it.
 *
 * DO NOT reorder this array.
 */
export const HIVE_RUNTIME_REASONS: readonly OpsReason[] = [
  {
    producer: HIVE_RUNTIME_PRODUCER,
    reasonId: REASON_TOOL_RECOVERED,
    class: "informational",
    retry: "transient",
    clearsReasonIds: [REASON_TOOL_FAILED],
    // D6: `agentId` is deliberately ABSENT. The only agent slug reachable on
    // the recovery path belongs to the arbitrary later turn whose success
    // triggered it — the same stranger whose work item this producer refuses
    // as evidence and whose waiter it refuses in favour of a fixed
    // `waiting: "nobody"`. `lane` survives: it names the capture point that
    // observed the success, a property of the observation, attributed to
    // nobody.
    detailKeys: [
      { key: "tool", type: "string", maxLength: 200 },
      { key: "lane", type: "string", maxLength: 16 },
    ],
    remediationTemplate: "none; recorded so {tool} reopens as a new epoch if it returns",
    enabled: true,
  },
  {
    producer: HIVE_RUNTIME_PRODUCER,
    reasonId: REASON_TOOL_FAILED,
    class: "resource",
    // D5: the honest default for a mixed population — a tool that failed once
    // may succeed on the same input. D3's stated lever for a genuinely
    // deterministic class is a SECOND reasonId, never a per-event assertion.
    retry: "transient",
    detailKeys: [
      { key: "tool", type: "string", maxLength: 200 },
      { key: "errorSig", type: "string", maxLength: 32 },
      { key: "agentId", type: "string", maxLength: 64, optional: true },
      { key: "lane", type: "string", maxLength: 16 },
      { key: "threadId", type: "string", maxLength: 200, optional: true },
      { key: "workItemId", type: "string", maxLength: 200, optional: true },
      { key: "durationMs", type: "number", optional: true },
    ],
    // D5: interpolates ONLY always-present keys. {agentId} is excluded because
    // it is absent on exactly the detached worker and scribe rows this design
    // calls its most valuable case, and a template naming it would render a
    // hole there and force KPR-468 to invent an optional-parameter rendering
    // rule this ticket has no reason to specify.
    remediationTemplate: "retry {tool}; if it repeats, inspect its {errorSig} failures on lane {lane}",
    enabled: true,
  },
];

/**
 * D4: the bound on a detail KEY NAME. Deliberately NOT `OPS_TOKEN_RE` — that
 * is lowercase-hyphen and would reject this producer's own `errorSig`,
 * `workItemId` and `durationMs`. A key name rides into every stored document
 * for its reason, so an unbounded one is the hole `maxLength` closes for
 * values, still open from the other side.
 */
const DETAIL_KEY_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The three normalizations `compileDetailSchema` performs SILENTLY on a
 * data-sourced row, returned as anomaly strings. PURE — decides nothing.
 * `assertReasonTableLegal` throws on its output (code-resident half, a
 * development-time defect); chunk 3's `loadReasons` warns and counts on it
 * (data-sourced half, where refusing the row would let one operator row disable
 * publishing). All three already fail CLOSED, so this is strictly diagnostic:
 * it separates "this row declares something the engine narrows" from "the
 * producer is mis-integrated", which the bare `rejected` counter cannot.
 */
export function auditReasonRow(row: OpsReason): string[] {
  const anomalies: string[] = [];
  for (const spec of row.detailKeys) {
    const id = `${row.producer}:${row.reasonId} key ${JSON.stringify(spec.key)}`;
    if (!DETAIL_KEY_NAME_RE.test(spec.key)) {
      anomalies.push(`${id}: key NAME fails ${String(DETAIL_KEY_NAME_RE)}`);
    }
    if (spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean") {
      // compileDetailSchema's if/else chain has no default arm, so a foreign
      // "date" or a typo'd "String" silently compiles to z.boolean().
      anomalies.push(`${id}: unrecognized type ${JSON.stringify(spec.type)} — compiled as boolean`);
    }
    if (spec.type === "string" && spec.maxLength !== undefined && spec.maxLength > OPS_DETAIL_STRING_MAX) {
      anomalies.push(`${id}: declares maxLength ${spec.maxLength}, clamped to ${OPS_DETAIL_STRING_MAX}`);
    }
  }
  return anomalies;
}

/**
 * D4's enable gate, as a PURE precondition over the code-resident table.
 * Evaluated before any I/O; a violation is a development-time throw, never an
 * operational boot fault. `informational` reasons are exempt (no clearing
 * act); `judgment` and `integrity` are deliberately not gated (their clearing
 * acts are human-originated and may legitimately be registered later).
 *
 * Also enforces D4's separate registration clause: a row naming an
 * unregistered reason in clearsReasonIds is rejected at registration.
 */
export function assertReasonTableLegal(rows: readonly OpsReason[]): void {
  const ids = new Set(rows.map((r) => `${r.producer}:${r.reasonId}`));
  for (const row of rows) {
    if (!OPS_TOKEN_RE.test(row.producer) || !OPS_TOKEN_RE.test(row.reasonId)) {
      throw new Error(`ops reason table: unbounded token in ${row.producer}:${row.reasonId}`);
    }
    if (row.remediationTemplate.length === 0 || row.remediationTemplate.length > OPS_REMEDIATION_MAX) {
      throw new Error(
        `ops reason table: ${row.reasonId}'s remediationTemplate is empty or exceeds ${OPS_REMEDIATION_MAX} ` +
          `(D4: required, no default, "a bounded parameterised string")`,
      );
    }
    // The three silent normalizations, LOUD for the code-resident half. A
    // developer fixes these before deploy, so there is no reason to let the
    // table ship with a key name or a type the compiler will quietly reshape.
    for (const anomaly of auditReasonRow(row)) {
      throw new Error(`ops reason table: ${anomaly}`);
    }
    // C13: the allow-list IS the redaction boundary, so a string key with no
    // declared bound is a development-time defect and refuses loudly here.
    // The DATA-sourced half is handled differently and deliberately — see
    // compileDetailSchema below.
    for (const spec of row.detailKeys) {
      if (spec.type !== "string") continue;
      const id = `${row.producer}:${row.reasonId} key "${spec.key}"`;
      if (spec.maxLength === undefined) {
        throw new Error(`ops reason table: ${id} is type "string" with no maxLength (D4: required)`);
      }
      if (spec.maxLength < 1 || spec.maxLength > OPS_DETAIL_STRING_MAX) {
        throw new Error(`ops reason table: ${id} declares maxLength ${spec.maxLength}, outside 1..${OPS_DETAIL_STRING_MAX}`);
      }
    }
    for (const cleared of row.clearsReasonIds ?? []) {
      if (!ids.has(`${row.producer}:${cleared}`)) {
        throw new Error(
          `ops reason table: ${row.producer}:${row.reasonId} clears unregistered reason "${cleared}" (D4 registration clause)`,
        );
      }
    }
  }
  for (const row of rows) {
    if (!row.enabled || row.class !== "resource") continue;
    const cleared = rows.some((r) => r.producer === row.producer && (r.clearsReasonIds ?? []).includes(row.reasonId));
    if (!cleared) {
      throw new Error(
        `ops reason table: class:resource reason ${row.producer}:${row.reasonId} is enabled but no registered reason ` +
          `lists it in clearsReasonIds — D2's recovery obligation in enforceable form (C19). Register a clearing ` +
          `reason or ship this row disabled.`,
      );
    }
  }
}

/**
 * D6: redaction IS the schema. The `detail` validator is BUILT FROM the
 * registry row's detailKeys — never a hand-written second schema, or the two
 * drift. Compiled once per row and cached by the caller (the store's reason
 * map holds the compiled schema beside the row).
 *
 * Strict: an unknown key, a wrong scalar type, an over-length value or a
 * non-scalar all fail, and the accept path rejects + counts (C5, C13).
 *
 * ⚠ THE DATA-SOURCED HALF, decided explicitly. `assertReasonTableLegal` guards
 * only the CODE-RESIDENT table; this compiles whatever `loadReasons()` read
 * out of `ops_reasons`, including a row no engine code contains (D4, AC16),
 * so it cannot rely on the gate having run. It therefore never trusts
 * `spec.maxLength`: a string key is ALWAYS bounded at
 * `Math.min(spec.maxLength ?? OPS_DETAIL_STRING_MAX, OPS_DETAIL_STRING_MAX)`.
 * The two halves fail differently on purpose — a code-resident defect is loud
 * because a developer fixes it before deploy, a data-sourced one is clamped
 * because refusing the row would let one operator (or foreign-producer) row
 * disable publishing, and C13 requires that nothing unbounded is STORED, not
 * that the row be rejected. The clamp bounds the SCHEMA, never a value: an
 * over-length value still fails and the publish is rejected and counted (D4
 * forbids truncating).
 */
export function compileDetailSchema(keys: readonly DetailKeySpec[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const spec of keys) {
    let field: z.ZodTypeAny;
    if (spec.type === "string") {
      field = z.string().max(Math.min(spec.maxLength ?? OPS_DETAIL_STRING_MAX, OPS_DETAIL_STRING_MAX));
    } else if (spec.type === "number") {
      field = z.number().finite();
    } else {
      field = z.boolean();
    }
    shape[spec.key] = spec.optional ? field.optional() : field;
  }
  // .strict() is the allow-list: any key not declared by the row is rejected.
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}
```

- [ ] **Step 5:** Create `src/ops/match.ts` — the D5 grammar, and nothing more.

```typescript
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
export function matchesFilter(event: Pick<OpsEvent, "producer" | "reasonId" | "class" | "waiting" | "retry" | "subject">, filter: OpsFilter): boolean {
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
```

- [ ] **Step 6:** Verify the module compiles and the gate is armed.

Run: `npm run typecheck`

**This is the first green `npm run typecheck` in the plan, and that is by design.** Task 1 (chunk 1, Step 6) deliberately did not run it and stated that it would FAIL until this step: `src/outage/outage-notices.ts` carries `import type { Waiting } from "../ops/types.js"` from Task 1, and `src/ops/types.ts` only exists as of Step 1 above. Expected here: clean — that import now resolves, and `Collection<OpsEvent>.insertOne` will compile in chunk 3 because `_id` is declared `ObjectId` rather than `unknown` (Step 1's ⚠ note).

- [ ] **Step 7:** Commit.

```bash
git add src/ops/types.ts src/ops/ids.ts src/ops/error-tokens.ts src/ops/reasons.ts src/ops/match.ts
git commit -m "feat(KPR-454): ops event contract types, reason registry, error tokens, id bound

D1/D4/D5/D6: the envelope and three closed vocabularies stated once; the two
hive-runtime reason rows with clearing-first write order and the pure D4
enable gate; the total nine-value error-token classifier; the accept-path
token/length bounds and the capture-point admissibility bound; the D5
conjunction matcher. All pure — no Mongo, no I/O, no singleton.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

