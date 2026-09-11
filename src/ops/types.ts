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
