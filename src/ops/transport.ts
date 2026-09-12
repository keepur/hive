/**
 * KPR-468 D6: KPR-458's transport interface, transcribed UNCHANGED. The three
 * closed sets below are contract; an adapter never extends them and maps
 * everything it cannot prove to `unknown`.
 */
import type { OpsClass, OpsDetail, OpsEvidence, OpsRetry, OpsSubject, Waiting } from "./types.js";
import type { DeliveryReference, OpsNotificationState } from "./notification-types.js";

/** Proof that nothing was accepted. C8's ONLY retry-permitting status. */
export type NonacceptanceReason =
  | "unauthenticated"
  | "unauthorized"
  | "target-unknown"
  | "target-ineligible"
  | "payload-rejected"
  | "refused-rate-limit";

/** Everything else. Never re-sent, always surfaced as uncertainty (C8). */
export type UncertaintyReason = "timeout" | "transport-fault" | "ambiguous-response" | "crashed-after-submission";

export type DeliveryOutcome =
  | { status: "accepted"; reference: DeliveryReference; at: Date }
  | { status: "rejected"; reason: NonacceptanceReason }
  | { status: "unknown"; reason: UncertaintyReason };

/**
 * D6: STRUCTURED, never a pre-rendered string. It carries the RESOLVED
 * target, which is a faithful reading of D6 rather than an amendment —
 * `deliver` takes exactly one argument, so the target the notifier resolved
 * from `subscription.transport.target` must ride the view. D6 bars an adapter
 * from CHOOSING or DISCOVERING a recipient; being handed one is the point.
 *
 * NEVER in this view: a rendered message string, a subscriber id, a channel
 * or person NAME, a severity, an owner, or anything D2 lists as explicitly
 * absent. The adapter owns rendering, because a Slack block, an SMS body and
 * a push payload are different artifacts of the same fact.
 */
export interface NotificationView {
  /** Opaque; names one ledger row. Confers no authority (D7, D9). */
  handle: string;
  /** Adapter-scoped, resolved by the notifier, opaque to it. */
  target: unknown;
  event: {
    producer: string;
    reasonId: string;
    class: OpsClass;
    retry: OpsRetry;
    waiting: Waiting;
    subject: OpsSubject;
    generation: number;
    dedupeKey: string;
    publishedAt: Date;
    detail: OpsDetail;
    evidence: OpsEvidence[];
  };
  remediation?: { template: string; parameters: OpsDetail };
  ledger: {
    state: OpsNotificationState;
    eventCount: number;
    nudgeCount: number;
    attemptCount: number;
    firstSeenAt: Date;
    lastEventAt: Date;
  };
}

export interface OpsTransport {
  readonly adapterId: string;
  /** Shape check, run at SUBSCRIPTION LOAD time (D6, D10) — not at code registration. */
  validateTarget(target: unknown): boolean;
  deliver(n: NotificationView): Promise<DeliveryOutcome>;
}

/**
 * D6: `{key}` substitution over ALLOW-LISTED parameters only. Pure. Offered to
 * adapters, never imposed — the ledger stores no rendered string (C13, AC12).
 *
 * Three properties, each deliberate:
 *  - `hasOwnProperty` rather than `key in`, so a template naming `constructor`
 *    or `__proto__` cannot read the prototype chain (the KPR-407 discipline).
 *  - An UNDECLARED placeholder is left untouched rather than blanked, so a
 *    template/registry mismatch is visible to a responder instead of silently
 *    producing a sentence with a hole in it.
 *  - No length cap is applied here and none is needed: the template is
 *    registry-bounded by KPR-454's OPS_REMEDIATION_MAX and each substituted
 *    value is registry-bounded by its declared `maxLength`, so the render is
 *    bounded by construction. Adapters still bound their own payloads.
 */
export function renderRemediation(template: string, detail: OpsDetail): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(detail, key) ? String(detail[key]) : whole,
  );
}
