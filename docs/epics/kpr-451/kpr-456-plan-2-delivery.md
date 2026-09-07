# KPR-456 plan chunk 2 — transport, evidence and admitted delivery

Parent: [implementation plan](kpr-456-plan.md). Depends on chunk 1.

## Task 4: A single acknowledged Slack post with no hidden retries

**Create:** src/obligations/slack-post.ts
**Test:** src/obligations/slack-post.test.ts

- [ ] Add this complete implementation. A per-request WebClient isolates provenance when two requests overlap. Its fixed HTTPS URL, redirect rejection and Slack request ID check are intentionally conservative. No environment-controlled API URL/proxy fallback is added.

~~~typescript
import { WebClient, ErrorCode, LogLevel, type WebClientOptions } from "@slack/web-api";
import type { Destination } from "./types.js";

export const NONACCEPTANCE = new Set([
  "not_authed", "invalid_auth", "token_expired", "token_revoked",
  "missing_scope", "no_permission", "not_in_channel", "channel_not_found",
  "is_archived", "ekm_access_denied", "restricted_action",
  "rate_limited", "ratelimited",
]);
export type PostOutcome =
  | { kind: "acknowledged"; ts: string; acknowledgedAt: Date }
  | { kind: "rejected"; reason: "authoritative_refusal" | "rate_limited"; retryAt: Date }
  | { kind: "unknown"; reason: "unconfirmed_response" | "identity_unverified" };
export interface ObligationPoster {
  post(destination: Destination, text: string): Promise<PostOutcome>;
}
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function attributedText(producer: string, text: string): string {
  return "[" + escapeSlack(producer) + "]\n" + text;
}
type Fetcher = NonNullable<WebClientOptions["fetch"]>;
const ENDPOINT = "https://slack.com/api/chat.postMessage";
const silentLogger = {
  setLevel: () => {}, setName: () => {}, getLevel: () => LogLevel.ERROR,
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
export class SlackObligationPoster implements ObligationPoster {
  constructor(
    private token: string,
    private registerEcho: (channel: string, ts: string) => void,
    private canSend: () => boolean,
    private clock: () => Date = () => new Date(),
    private fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}
  async post(destination: Destination, text: string): Promise<PostOutcome> {
    if (!this.canSend()) return { kind: "unknown", reason: "identity_unverified" };
    let slackOrigin = false;
    let status = 0;
    let retryAfter = 0;
    const client = new WebClient(this.token, {
      slackApiUrl: "https://slack.com/api/",
      allowAbsoluteUrls: false,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 20_000,
      logger: silentLogger,
      fetch: async (url, init) => {
        if (!this.canSend() || String(url) !== ENDPOINT) throw new Error("post_unavailable");
        const response = await this.fetcher(url, { ...init, redirect: "error" });
        status = response.status;
        slackOrigin = response.url === ENDPOINT
          && Boolean(response.headers.get("x-slack-req-id")?.trim());
        const seconds = Number(response.headers.get("retry-after"));
        retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        return response;
      },
    });
    try {
      const response = await client.chat.postMessage({
        channel: destination.channelId,
        ...(destination.threadTs ? { thread_ts: destination.threadTs } : {}),
        text, mrkdwn: false, parse: "none", link_names: false,
        unfurl_links: false, unfurl_media: false,
      });
      const acknowledgedAt = this.clock();
      if (slackOrigin && status === 200 && response.ok === true
        && response.channel === destination.channelId
        && typeof response.ts === "string" && response.ts.trim().length > 0
        && response.ts.length <= 100) {
        this.registerEcho(response.channel, response.ts);
        return { kind: "acknowledged", ts: response.ts, acknowledgedAt };
      }
      return { kind: "unknown", reason: "unconfirmed_response" };
    } catch (err) {
      const error = object(err);
      const data = object(error.data);
      const is429 = slackOrigin && status === 429 && error.code === ErrorCode.RateLimitedError;
      const refusal = slackOrigin && status === 200 && error.code === ErrorCode.PlatformError
        && data.ok === false && typeof data.error === "string" && NONACCEPTANCE.has(data.error);
      if (is429 || refusal) {
        const reported = Number(error.retryAfter);
        const delaySeconds = Math.max(30, retryAfter, Number.isFinite(reported) && reported > 0 ? reported : 0);
        return {
          kind: "rejected",
          reason: is429 || data.error === "rate_limited" || data.error === "ratelimited"
            ? "rate_limited" : "authoritative_refusal",
          retryAt: new Date(this.clock().getTime() + delaySeconds * 1000),
        };
      }
      return { kind: "unknown", reason: "unconfirmed_response" };
    }
  }
}
~~~

No receipt/notice body is logged. Only returned acknowledgement fields cross into the persistence layer. No RetryQueue or normal gateway client is used. A refusal with missing provenance stays unknown even if its string matches the allowlist.

## Task 5: Append-only receipts and retained retention checkpoints

**Create:** src/obligations/receipts.ts
**Modify:** src/activity/activity-logger.ts
**Test:** src/obligations/obligations.integration.test.ts

- [ ] Add this complete implementation.

~~~typescript
import type { Collection, Db } from "mongodb";
import {
  type DeliveryReceiptRecord, type Occurrence, type Acknowledgement,
  receiptSchema, same, fail,
} from "./types.js";
import { ObligationStore, assertWrite, duplicate } from "./store.js";

export type HistoryAvailability =
  | "none" | "present" | "expired" | "initial_write_pending" | "expired_unresolved";
export interface Evidence {
  occurrence: Occurrence;
  history: HistoryAvailability;
  confirmed: boolean;
}
export class ReceiptStore {
  readonly collection: Collection<DeliveryReceiptRecord>;
  constructor(readonly db: Db, readonly retentionDays?: number) {
    if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays <= 0)) fail("invalid_retention");
    this.collection = db.collection<DeliveryReceiptRecord>("activity_log");
  }
  async init(): Promise<void> {
    if (this.retentionDays === undefined) return fail("retention_required");
    await this.collection.createIndex(
      { timestamp: 1 }, { expireAfterSeconds: this.retentionDays * 86400 },
    );
    const partialFilterExpression = { recordKind: "delivery_receipt" };
    await this.collection.createIndex(
      { receiptId: 1 }, { unique: true, partialFilterExpression },
    );
    await this.collection.createIndex(
      { obligationId: 1, dueAt: 1 }, { unique: true, partialFilterExpression },
    );
    await this.collection.createIndex(
      { producerAgentId: 1, dueAt: -1 }, { partialFilterExpression },
    );
    await this.retentionMs();
  }
  async retentionMs(): Promise<number> {
    const indexes = await this.collection.listIndexes().toArray();
    const ttl = indexes.find((i) => same(i.key, { timestamp: 1 }) && typeof i.expireAfterSeconds === "number");
    if (!ttl || ttl.expireAfterSeconds! <= 0) return fail("receipt_retention_unavailable");
    return ttl.expireAfterSeconds! * 1000;
  }
  record(o: Occurrence, a: Acknowledgement): DeliveryReceiptRecord {
    return receiptSchema.parse({
      recordKind: "delivery_receipt", receiptId: a.receiptId,
      obligationId: o.obligationId, dueAt: o.dueAt, producerAgentId: o.producerAgentId,
      destination: o.definition.destination, providerMessageTs: a.providerMessageTs,
      acknowledgedAt: a.acknowledgedAt, timestamp: a.timestamp, schemaVersion: 1,
    });
  }
  async exact(o: Occurrence, a: Acknowledgement): Promise<boolean> {
    const raw = await this.collection.findOne({ recordKind: "delivery_receipt", receiptId: a.receiptId });
    if (!raw) return false;
    const { _id: ignored, ...body } = raw;
    void ignored;
    if (!same(receiptSchema.parse(body), this.record(o, a))) return fail("evidence_integrity");
    return true;
  }
  async insert(o: Occurrence, a: Acknowledgement): Promise<void> {
    try {
      assertWrite(await this.collection.insertOne(this.record(o, a), {
        writeConcern: { w: "majority", wtimeoutMS: 5000 },
      }));
    } catch (err) {
      // Includes commit-then-throw; never blindly report persistence.
      if (await this.exact(o, a)) return;
      if (duplicate(err)) return fail("evidence_integrity");
      throw err;
    }
  }
}
/** Both the sender and checker use this one initial-write repair path. */
export async function reconcileReceipt(
  store: ObligationStore, receipts: ReceiptStore, id: string, now: Date, repair: boolean,
): Promise<Evidence> {
  const retentionMs = await receipts.retentionMs();
  for (let attempt = 0; attempt < 8; attempt++) {
    const o = await store.occurrence(id), a = o.acknowledgement;
    if (!a) {
      if (o.delivery.state === "acknowledged" || ["on_time", "late"].includes(o.evaluation)) return fail("evidence_integrity");
      const unexpected = await receipts.collection.findOne({
        recordKind: "delivery_receipt", obligationId: o.obligationId, dueAt: o.dueAt,
        producerAgentId: o.producerAgentId, destination: o.definition.destination,
      });
      if (unexpected) return fail("evidence_integrity");
      return { occurrence: o, history: "none", confirmed: false };
    }
    if (o.delivery.state !== "acknowledged" || a.receiptId !== o._id + "/receipt"
      || a.providerMessageTs !== o.delivery.providerMessageTs
      || !same(a.acknowledgedAt, o.delivery.acknowledgedAt)) return fail("evidence_integrity");
    const exists = await receipts.exact(o, a);
    const expired = now.getTime() - a.timestamp.getTime() >= retentionMs;
    if (a.receiptWriteState === "persisted") {
      if (!exists && !expired) return fail("evidence_integrity");
      return { occurrence: o, history: exists ? "present" : "expired", confirmed: true };
    }
    if (a.receiptWriteState === "expired_unresolved") {
      return { occurrence: o, history: "expired_unresolved",
        confirmed: o.evaluation === "on_time" || o.evaluation === "late" };
    }
    if (!repair) {
      return { occurrence: o, history: expired && !exists ? "expired_unresolved" : "initial_write_pending",
        confirmed: false };
    }
    if (!exists && !expired) await receipts.insert(o, a);
    const nextState = exists || !expired ? "persisted" : "expired_unresolved";
    try {
      if (await store.cas(o, {
        acknowledgement: { ...a, receiptWriteState: nextState },
        repairAt: null, checkAt: now,
      })) continue;
    } catch {
      const latest = await store.occurrence(id);
      if (latest.acknowledgement?.receiptWriteState === nextState) continue;
      return fail("storage_unavailable");
    }
  }
  return fail("state_contention");
}
~~~

The original timestamp never changes. A persisted checkpoint is terminal even when activity history is absent; absence before TTL is an integrity error. A pending row that exists after its retention age still proves initial insertion and may publish persisted. An absent pending row after TTL becomes expired_unresolved; no insert occurs. Read-only inspection never publishes a marker or repairs data.

- [ ] In src/activity/activity-logger.ts import TURN_ACTIVITY_FILTER from ./types.js and replace only the startup diagnostic count:

~~~typescript
const count = await this.collection.countDocuments(TURN_ACTIVITY_FILTER);
~~~

Update the existing logger fake from estimatedDocumentCount to countDocuments and assert this filter. There are no other activity_log aggregators in the inspected source/scripts/setup/plugins baseline. Re-run the repository search during implementation; any newly merged turn aggregate must apply the same discriminator filter at its initial match. Do not alter TurnTelemetryStore, fabricate turn fields, or gate ReceiptStore.init on activity.enabled.

## Task 6: Atomic admission and token-fenced outcomes

**Create:** src/obligations/delivery.ts

- [ ] Add this complete implementation.

~~~typescript
import type { Admission, Attempt, Occurrence } from "./types.js";
import {
  deliveryInputSchema, fail, cancelledAt, same, occurrenceId, ObligationError,
} from "./types.js";
import { windowStart } from "./deadlines.js";
import { ObligationStore } from "./store.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { attributedText, type ObligationPoster, type PostOutcome } from "./slack-post.js";

export function claimable(a: Attempt, now: Date): boolean {
  return a.state === "pending" || (a.state === "rejected" && (!a.retryAt || a.retryAt <= now));
}
export function safeError(err: unknown): string {
  return err instanceof ObligationError ? err.code : "storage_unavailable";
}
export class DeliveryService {
  constructor(
    readonly store: ObligationStore,
    readonly receipts: ReceiptStore,
    readonly poster: ObligationPoster,
    readonly bootId: string,
    readonly clock: () => Date,
    readonly canWrite: () => boolean,
  ) {}
  async historical(o: Occurrence): Promise<unknown> {
    if (!this.canWrite()) return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    try {
      const evidence = await reconcileReceipt(this.store, this.receipts, o._id, this.clock(), true);
      return {
        state: evidence.confirmed ? "confirmed_delivery" : "delivery_evidence_incomplete",
        dueAt: evidence.occurrence.dueAt, acknowledgement: evidence.occurrence.acknowledgement,
        history: evidence.history, cancelled: cancelledAt(await this.store.definitionFor(o), o.dueAt),
        retryAllowed: false,
      };
    } catch (err) {
      return { state: "delivery_outcome_unknown", reason: safeError(err), retryAllowed: false };
    }
  }
  async transfer(a: Admission, obligationId: string): Promise<boolean> {
    // Admission is authority even if deactivation has since committed.
    const d = await this.store.get(obligationId);
    if (!same(d?.deliveryAdmission, a)) return false;
    for (let n = 0; n < 8; n++) {
      const o = await this.store.occurrence(a.occurrenceId);
      if (o.delivery.claimToken === a.claimToken) {
        return o.delivery.state === "sending";
      }
      if (!claimable(o.delivery, this.clock())) {
        await this.store.release(obligationId, a);
        return false;
      }
      const sending: Attempt = {
        intentId: a.intentId, claimToken: a.claimToken, ownerBootId: a.ownerBootId,
        state: "sending", startedAt: this.clock(),
      };
      try {
        if (await this.store.cas(o, { delivery: sending })) return true;
      } catch {
        const observed = await this.store.occurrence(o._id);
        return observed.delivery.claimToken === a.claimToken && observed.delivery.state === "sending";
      }
    }
    return false;
  }
  async settle(id: string, token: string, outcome: PostOutcome): Promise<Occurrence | null> {
    for (let n = 0; n < 8; n++) {
      const o = await this.store.occurrence(id);
      if (o.delivery.claimToken !== token) return null;
      if (o.delivery.state === "acknowledged") return o;
      if (!["sending", "unknown"].includes(o.delivery.state)) return null;
      const now = this.clock();
      const patch: Partial<Occurrence> = { checkAt: now };
      if (outcome.kind === "acknowledged") {
        patch.delivery = {
          ...o.delivery, state: "acknowledged",
          acknowledgedAt: outcome.acknowledgedAt, providerMessageTs: outcome.ts,
        };
        delete patch.delivery.reason;
        patch.acknowledgement = {
          receiptId: o._id + "/receipt", providerMessageTs: outcome.ts,
          acknowledgedAt: outcome.acknowledgedAt, timestamp: now, receiptWriteState: "pending",
        };
        patch.repairAt = now;
      } else {
        patch.delivery = { ...o.delivery, state: outcome.kind, reason: outcome.reason };
        if (outcome.kind === "rejected") patch.delivery.retryAt = outcome.retryAt;
      }
      try {
        if (await this.store.cas(o, patch)) return await this.store.occurrence(id);
      } catch {
        const observed = await this.store.occurrence(id);
        if (observed.delivery.claimToken === token && observed.delivery.state === outcome.kind) return observed;
        return null;
      }
    }
    return null;
  }
  async deliver(agentId: string, input: unknown): Promise<unknown> {
    const parsed = deliveryInputSchema.safeParse(input);
    if (!parsed.success) return { state: "invalid_input", retryAllowed: false };
    if (!this.canWrite()) return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    const { obligationId, text } = parsed.data;
    const dueAt = new Date(parsed.data.dueAt);
    const d = (await this.store.get(obligationId)) ?? fail("unknown_obligation");
    if (d.producerAgentId !== agentId) return fail("wrong_producer");
    const now = this.clock();
    const lower = windowStart(d, dueAt);
    const body = attributedText(agentId, text);
    if (body.length > 3900) return fail("content_invalid");
    if (now <= lower) return fail("window_not_open");
    // All identity/input/recurrence/window checks precede materialization.
    // Historical acknowledged responses remain available after cancellation.
    const id = occurrenceId(obligationId, dueAt);
    const existing = await this.store.occurrences.findOne({ _id: id });
    if (existing) {
      const o = await this.store.occurrence(id);
      await this.store.definitionFor(o);
      if (o.delivery.state === "acknowledged") return this.historical(o);
    }
    if (cancelledAt(d, dueAt)) return fail("expectation_cancelled");
    if (!this.canWrite()) return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    const o = await this.store.materialize(d, dueAt);
    if (o.delivery.state === "acknowledged") return this.historical(o);
    if (!claimable(o.delivery, now)) {
      return { state: o.delivery.state, retryAt: o.delivery.retryAt, retryAllowed: false };
    }
    const a = await this.store.admit(o, this.bootId);
    if (!a) {
      const latest = (await this.store.get(obligationId)) ?? fail("definition_missing");
      return { state: cancelledAt(latest, dueAt) ? "expectation_cancelled" : "admission_unavailable",
        retryAllowed: false };
    }
    let transferred = false;
    try { transferred = await this.transfer(a, obligationId); }
    catch { return { state: "delivery_outcome_unknown", reason: "storage_unavailable", retryAllowed: false }; }
    if (!transferred) return { state: "delivery_outcome_unknown", retryAllowed: false };
    // Release is cleanup, never a second authority check. A release failure
    // retains the slot for recovery and cannot cause a duplicate submission.
    try { await this.store.release(obligationId, a); } catch { /* durable handoff retained */ }
    if (!this.canWrite()) return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    const result = await this.poster.post(d.destination, body);
    try {
      const settled = await this.settle(id, a.claimToken, result);
      if (!settled) return { state: "delivery_outcome_unknown", retryAllowed: false };
      if (settled.delivery.state === "acknowledged") return this.historical(settled);
      return { state: settled.delivery.state, retryAt: settled.delivery.retryAt,
        retryAllowed: settled.delivery.state === "rejected" && !cancelledAt(
          (await this.store.get(obligationId)) ?? fail("definition_missing"), dueAt,
        ) };
    } catch {
      return { state: "delivery_outcome_unknown", reason: "storage_unavailable", retryAllowed: false };
    }
  }
  /** Reconcile a persisted handoff, never submit it to Slack. */
  async recoverAdmission(obligationId: string, a: Admission): Promise<void> {
    const o = await this.store.occurrence(a.occurrenceId);
    if (o.delivery.claimToken === a.claimToken) {
      // Matching occurrence proves the transfer. Clearing this exact slot
      // does not reclaim a live owner's attempt or confer another authority.
      await this.store.release(obligationId, a);
      return;
    }
    if (a.ownerBootId === this.bootId) return;
    if (claimable(o.delivery, this.clock())) {
      const unknown: Attempt = {
        intentId: a.intentId, claimToken: a.claimToken, ownerBootId: a.ownerBootId,
        state: "unknown", reason: "interrupted_attempt",
      };
      if (!(await this.store.cas(o, { delivery: unknown, checkAt: this.clock() }))) return;
      // Only a durably observed matching transfer/outcome permits release.
      const observed = await this.store.occurrence(o._id);
      if (observed.delivery.claimToken !== a.claimToken) return;
    }
    // Different non-claimable token proves the admission lost.
    await this.store.release(obligationId, a);
  }
}
~~~

PostOutcome is a trusted internal transport result, never a tool parameter. If a custom test/standalone poster throws, catch it in the runtime capability wrapper as an unknown result; no retry is triggered. Production SlackObligationPoster returns a classified outcome for every submitted failure.

Recovering an orphan admission whose occurrence is missing is an integrity fault. The reader must expose it; do not clear the slot or manufacture successful delivery. Such partial restores are outside automatic recovery.

- [ ] Execute:

~~~bash
npx vitest run src/obligations/slack-post.test.ts src/activity/activity-logger.test.ts
npm run typecheck
git diff --check
~~~

Expected: exit 0 and one physical HTTP submission for every ambiguous transport test. Run receipt/admission integration cases after chunk 3 supplies the checker/reader needed by the shared harness. Commit only after verification:

~~~bash
git add src/obligations/slack-post.ts src/obligations/receipts.ts src/obligations/delivery.ts src/activity/activity-logger.ts src/activity/activity-logger.test.ts src/obligations/slack-post.test.ts
git commit -m "feat: persist admitted obligation sends and delivery receipt checkpoints"
~~~
