import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import type { Dispatcher } from "../channels/dispatcher.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import {
  ModelCatalogOutbox,
  transition,
  validChange,
  copy,
  type CandidateCursor,
  type Transition,
  type MutationKind,
} from "./model-catalog-outbox.js";
import {
  sameBinding,
  display,
  noticeRetryDeadline,
  type NoticeRetry,
  type ChangeDelivery,
  type NoticePreparation,
  type NoticeReason,
  type RouteResult,
  type SendResult,
} from "./model-catalog-notification.js";

const log = createLogger("model-catalog-notifier");

export const NOTIFIER_DEFAULTS = {
  pollMs: 60_000,
  leaseMs: 120_000,
  renewMs: 30_000,
  drainMs: 5_000,
  batch: 10,
} as const;

type Dispatch = Pick<
  Dispatcher,
  | "resolveCatalogNotificationRoute"
  | "catalogNotificationRouteCurrent"
  | "prepareCatalogNotification"
  | "sendPreparedCatalogNotification"
>;

interface Invocation {
  token: string;
  row: CatalogChangeDoc;
  proven: boolean;
  finished: boolean;
  renewal?: ReturnType<typeof setTimeout>;
  renewing?: Promise<void>;
  reported: Set<NoticeReason>;
}

interface Options {
  now?: () => Date;
  uuid?: () => string;
  pollMs?: number;
  leaseMs?: number;
  renewMs?: number;
  drainMs?: number;
}

export class ModelCatalogNotifier {
  private readonly owner: string;
  private readonly options;
  private active = true;
  private storeOpen = true;
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private stopPromise?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private wakeups = new Set<() => void>();
  private current?: Invocation;
  private nextCandidate?: CandidateCursor;
  private invalidPage = new Set<string>();
  private lastPollFault = false;

  constructor(
    private readonly outbox: ModelCatalogOutbox,
    private readonly dispatcher: Dispatch,
    options: Options = {},
  ) {
    this.options = { ...NOTIFIER_DEFAULTS, ...options };
    for (const value of [this.options.pollMs, this.options.leaseMs, this.options.renewMs, this.options.drainMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid notifier interval");
    }
    this.owner = this.uuid();
  }

  private now(): Date {
    return new Date(this.options.now?.() ?? new Date());
  }

  private uuid(): string {
    return this.options.uuid?.() ?? randomUUID();
  }

  start(): void {
    if (!this.active || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollMs);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.flight) return this.flight;
    // Reserve synchronously, before batch's first awaited read/index operation.
    const flight = Promise.resolve()
      .then(() => this.batch())
      .catch(() => {
        if (!this.lastPollFault) log.warn("Catalog notifications unavailable", { reason: "storage" });
        this.lastPollFault = true;
      });
    this.flight = flight;
    void flight.finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    return flight;
  }

  private async db<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.serial.then(() => (this.storeOpen ? fn() : undefined));
    this.serial = run.catch(() => undefined);
    return run;
  }

  private pause(ms = this.options.pollMs): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakeups.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref();
      this.wakeups.add(finish);
    });
  }

  private report(i: Invocation, reason: NoticeReason): void {
    if (i.reported.has(reason)) return;
    i.reported.add(reason);
    log.warn("Catalog notification remains unresolved", {
      provider: display(i.row.provider, 160),
      changeId: i.row._id,
      attempts: i.row.delivery.attempts,
      stage: i.row.delivery.claim?.stage,
      reason,
      retryAt:
        i.row.delivery.state === "pending" && !i.row.delivery.retryBlocked
          ? i.row.delivery.nextAttemptAt.toISOString()
          : undefined,
    });
  }

  private canStart(i: Invocation): boolean {
    return (
      this.active &&
      this.current === i &&
      !i.finished &&
      i.proven &&
      i.row.delivery.state === "claimed" &&
      i.row.delivery.claim?.token === i.token &&
      i.row.delivery.claim.leaseExpiresAt.getTime() > this.now().getTime()
    );
  }

  // Must run under db(); callers decide whether expiry is permitted (receipt/release only).
  private async currentRow(i: Invocation, live: boolean): Promise<CatalogChangeDoc | undefined> {
    const row = await this.outbox.read(i.row._id);
    if (
      !row ||
      !validChange(row) ||
      row.delivery.state !== "claimed" ||
      row.delivery.claim?.token !== i.token ||
      (live && row.delivery.claim.leaseExpiresAt <= this.now())
    ) {
      i.proven = false;
      this.report(i, "lease-lost");
      return;
    }
    i.row = copy(row);
    i.proven = true;
    return row;
  }

  // Must run under db(); never run two mutating operations in parallel.
  private async settle(i: Invocation, t: Transition): Promise<CatalogChangeDoc | undefined> {
    if (!this.storeOpen) return;
    i.proven = false;
    let result = await this.outbox.apply(t, () => this.storeOpen);
    for (;;) {
      if (result.kind === "applied" && (t.kind !== "claim" || result.source === "ack")) {
        i.row = copy(result.row);
        i.proven = true;
        return i.row;
      }
      if (result.kind === "advanced") {
        // A greater version proves the old exact CAS cannot arrive against this state.
        // Only a known receipt can be rebased; never infer successful turn/claim from advancement.
        const row = result.row;
        const receipt = t.after.delivery.receipt;
        const prepared = row.delivery.preparation;
        if (
          t.kind !== "ack" ||
          !receipt ||
          !prepared ||
          prepared.id !== receipt.preparationId ||
          !sameBinding(prepared.binding, receipt.binding)
        ) {
          this.report(i, "lease-lost");
          return;
        }
        const rest = copy(row.delivery);
        const claim = rest.claim!;
        delete rest.claim;
        delete rest.diagnostic;
        t = transition(
          "ack",
          row,
          {
            ...rest,
            state: "delivered",
            receipt: copy(receipt),
            uncertainSend: claim.sendIntent?.previouslyUncertain ?? Boolean(rest.uncertainSend),
          },
          this.now(),
          false,
        );
        if (!this.storeOpen) return;
        result = await this.outbox.apply(t, () => this.storeOpen);
        continue;
      }
      if (result.kind === "superseded") {
        this.report(i, "lease-lost");
        return;
      }
      if (result.kind === "miss" && t.kind !== "ack") {
        this.report(i, "lease-lost");
        return;
      }
      this.report(i, "storage");
      if (!this.active || !this.storeOpen) return;
      const expiry =
        t.kind === "claim" ? t.after.delivery.claim!.leaseExpiresAt : t.before.delivery.claim!.leaseExpiresAt;
      if (t.kind !== "ack" && this.now() >= expiry) return;
      await this.pause(
        t.kind === "ack"
          ? this.options.pollMs
          : Math.min(this.options.pollMs, Math.max(1, expiry.getTime() - this.now().getTime())),
      );
      if (!this.active || !this.storeOpen) return;
      result = await this.outbox.evidence(t, () => this.storeOpen);
      // Unknown acquisition is NEVER converted into fresh proof, even if its token appears.
      if (t.kind === "claim") {
        if (result.kind === "superseded") return;
        if (this.now() >= expiry) return;
        result = { kind: "unknown" };
        continue;
      }
      if (result.kind !== "unknown") continue;
      // A settled exception can leave a delayed remote write. Repeat only this EXACT CAS;
      // its old-version predicate makes either ordering idempotent. No new transition/turn/post.
      if (this.storeOpen && (t.kind === "ack" || this.now() < expiry)) {
        result = await this.outbox.apply(t, () => this.storeOpen);
      }
    }
  }

  private async write(
    i: Invocation,
    kind: MutationKind,
    live: boolean,
    change: (d: ChangeDelivery, now: Date) => ChangeDelivery,
  ): Promise<boolean> {
    const result = await this.db(async () => {
      const row = await this.currentRow(i, live);
      if (!row) return;
      const at = this.now();
      return this.settle(i, transition(kind, row, change(copy(row.delivery), at), at, live));
    });
    return Boolean(result);
  }

  private renew(i: Invocation): void {
    if (!this.active || i.finished || !i.proven) return;
    i.renewal = setTimeout(() => {
      i.renewal = undefined;
      if (!this.active || i.finished) return;
      i.renewing = this.write(i, "renew", true, (d, at) => ({
        ...d,
        claim: {
          ...d.claim!,
          leaseExpiresAt: new Date(
            Math.max(d.claim!.leaseExpiresAt.getTime() + 1, at.getTime() + this.options.leaseMs),
          ),
        },
      }))
        .then((ok) => {
          if (ok) this.renew(i);
        })
        .catch(() => {
          i.proven = false;
          this.report(i, "storage");
        });
    }, this.options.renewMs);
    i.renewal.unref();
  }

  private async route(i: Invocation): Promise<RouteResult | undefined> {
    const before = await this.db(() => this.currentRow(i, true));
    if (!before || !this.canStart(i)) return;
    const route = await this.dispatcher.resolveCatalogNotificationRoute({
      check: async () => {
        if (!this.canStart(i)) return false;
        const row = await this.db(() => this.currentRow(i, true));
        return Boolean(row) && this.canStart(i);
      },
      current: () => this.canStart(i),
    });
    const after = await this.db(() => this.currentRow(i, true));
    if (!after || !this.canStart(i)) return;
    if (route.kind === "route" && !this.dispatcher.catalogNotificationRouteCurrent(route.route)) {
      return { kind: "unresolved", reason: "recipient-changed" };
    }
    return route;
  }

  private async release(
    i: Invocation,
    reason: NoticeReason,
    uncertain: boolean,
    retry: NoticeRetry = {},
  ): Promise<void> {
    if (!this.active) return;
    await this.write(i, "release", false, (d, at) => {
      const rest = { ...d };
      delete rest.claim;
      const next = noticeRetryDeadline(at, d.attempts, retry);
      if (!next) {
        return {
          ...rest,
          state: "pending",
          uncertainSend: uncertain,
          retryBlocked: true,
          diagnostic: { reason: "retry-deadline-unrepresentable", at },
          nextAttemptAt: at,
        };
      }
      return {
        ...rest,
        state: "pending",
        uncertainSend: uncertain,
        diagnostic: { reason, at },
        nextAttemptAt: next,
      };
    });
    this.report(i, i.row.delivery.retryBlocked ? "retry-deadline-unrepresentable" : reason);
  }

  private async acknowledge(
    i: Invocation,
    p: NoticePreparation,
    receipt: Extract<SendResult, { kind: "acknowledged" }>,
  ): Promise<void> {
    await this.db(async () => {
      for (;;) {
        if (!this.storeOpen) return;
        try {
          const row = await this.outbox.read(i.row._id);
          if (row && validChange(row)) {
            const delivered = row.delivery.receipt;
            if (
              row.delivery.state === "delivered" &&
              delivered?.preparationId === p.id &&
              delivered.channelId === receipt.channelId &&
              delivered.messageTs === receipt.messageTs &&
              sameBinding(delivered.binding, p.binding)
            ) {
              i.row = row;
              log.info("Catalog notification delivered", {
                provider: display(i.row.provider, 160),
                changeId: i.row._id,
                attempts: i.row.delivery.attempts,
                stage: "delivered",
              });
              return;
            }
            if (
              row.delivery.state !== "claimed" ||
              row.delivery.claim?.token !== i.token ||
              row.delivery.preparation?.id !== p.id ||
              !sameBinding(row.delivery.preparation.binding, p.binding)
            ) {
              this.report(i, "lease-lost");
              return;
            }
            if (!this.storeOpen) return;
            const at = this.now();
            const claim = row.delivery.claim;
            const rest = { ...row.delivery };
            delete rest.claim;
            delete rest.diagnostic;
            const settled = await this.settle(
              i,
              transition(
                "ack",
                row,
                {
                  ...rest,
                  state: "delivered",
                  uncertainSend: claim.sendIntent?.previouslyUncertain ?? Boolean(rest.uncertainSend),
                  receipt: {
                    preparationId: p.id,
                    binding: copy(p.binding),
                    channelId: receipt.channelId,
                    messageTs: receipt.messageTs,
                    acknowledgedAt: at,
                  },
                },
                at,
                false,
              ),
            );
            if (settled?.delivery.state === "delivered") {
              log.info("Catalog notification delivered", {
                provider: display(i.row.provider, 160),
                changeId: i.row._id,
                attempts: i.row.delivery.attempts,
                stage: "delivered",
              });
            }
            return;
          }
        } catch {
          // The known receipt survives unavailable evidence.
        }
        this.report(i, "storage");
        if (!this.active || !this.storeOpen) return;
        await this.pause();
      }
    });
  }

  private async process(i: Invocation): Promise<void> {
    const first = await this.route(i);
    if (!first) return;
    if (first.kind !== "route") {
      await this.release(i, first.reason, Boolean(i.row.delivery.uncertainSend), first);
      return;
    }
    let preparation = i.row.delivery.preparation;
    if (!preparation || !sameBinding(preparation.binding, first.route)) {
      const changed = Boolean(preparation);
      const outcome = await this.dispatcher.prepareCatalogNotification(
        i.row,
        first.route,
        () => this.canStart(i),
        () => this.now(),
      );
      if (!this.active) return;
      if (outcome.kind !== "prepared") {
        await this.release(i, outcome.reason, Boolean(i.row.delivery.uncertainSend));
        return;
      }
      preparation = outcome.preparation;
      const prepared = preparation;
      if (
        !(await this.write(i, "prepare", true, (d, at) => ({
          ...d,
          preparation: prepared,
          ...(changed ? { diagnostic: { reason: "recipient-changed" as const, at } } : {}),
        })))
      )
        return;
    }
    const selected = await this.route(i);
    if (!selected) return;
    if (selected.kind !== "route" || !sameBinding(selected.route, preparation.binding)) {
      await this.release(
        i,
        selected.kind === "unresolved" ? selected.reason : "recipient-changed",
        Boolean(i.row.delivery.uncertainSend),
        selected.kind === "unresolved" ? selected : {},
      );
      return;
    }
    const prepared = preparation;
    if (
      !(await this.write(i, "send-intent", true, (d, at) => ({
        ...d,
        claim: {
          ...d.claim!,
          stage: "sending",
          sendIntent: {
            preparationId: prepared.id,
            startedAt: at,
            previouslyUncertain: Boolean(d.uncertainSend),
          },
        },
      })))
    )
      return;
    const finalRoute = await this.route(i);
    if (!finalRoute) return;
    if (finalRoute.kind !== "route" || !sameBinding(finalRoute.route, prepared.binding)) {
      await this.release(
        i,
        finalRoute.kind === "unresolved" ? finalRoute.reason : "recipient-changed",
        Boolean(i.row.delivery.claim?.sendIntent?.previouslyUncertain),
        finalRoute.kind === "unresolved" ? finalRoute : {},
      );
      return;
    }
    // Re-read from the current positively persisted row, never use an unpersisted response.
    const persisted = i.row.delivery.preparation!;
    if (persisted.id !== prepared.id) return;
    const result = await this.dispatcher.sendPreparedCatalogNotification(persisted, () => this.canStart(i));
    if (result.kind === "acknowledged") {
      await this.acknowledge(i, persisted, result);
      return;
    }
    await this.release(
      i,
      result.reason,
      result.kind === "outcome-unknown" || Boolean(i.row.delivery.claim?.sendIntent?.previouslyUncertain),
      result,
    );
  }

  private async batch(): Promise<void> {
    if (!this.active) return;
    await this.db(() => this.outbox.ensureIndexes());
    if (!this.active) return;
    const page = await this.db(() => this.outbox.due(this.now(), this.options.batch, this.nextCandidate));
    if (!page) return;
    this.nextCandidate = page.next;
    const invalidThisPage = new Set<string>();
    this.lastPollFault = false;
    for (const row of page.rows) {
      if (!this.active) break;
      if (!validChange(row)) {
        const signature = `${row._id}:${String(row.delivery?.version)}:invalid-state`;
        invalidThisPage.add(signature);
        if (!this.invalidPage.has(signature)) {
          log.warn("Invalid catalog notification state", { changeId: row._id, reason: "invalid-state" });
        }
        continue;
      }
      const i: Invocation = {
        token: this.uuid(),
        row,
        proven: false,
        finished: false,
        reported: new Set(),
      };
      this.current = i;
      try {
        const at = this.now();
        const d = copy(row.delivery);
        const claim = transition(
          "claim",
          row,
          {
            ...d,
            state: "claimed",
            attempts: d.attempts + 1,
            lastAttemptAt: at,
            uncertainSend: Boolean(d.uncertainSend || d.claim?.sendIntent),
            claim: {
              token: i.token,
              owner: this.owner,
              startedAt: at,
              leaseExpiresAt: new Date(at.getTime() + this.options.leaseMs),
              stage: "preparing",
            },
          },
          at,
          false,
        );
        const acquired = await this.db(() => this.settle(i, claim));
        if (acquired && this.canStart(i)) {
          log.info("Catalog notification attempt started", {
            provider: display(i.row.provider, 160),
            changeId: i.row._id,
            attempts: i.row.delivery.attempts,
            stage: "preparing",
          });
          this.renew(i);
          await this.process(i);
        }
      } catch {
        i.proven = false;
        this.report(i, "storage");
      } finally {
        i.finished = true;
        if (i.renewal) clearTimeout(i.renewal);
        await i.renewing;
        // Already-started renewals remain observed and retain the local latch.
        if (this.current === i) this.current = undefined;
      }
    }
    this.invalidPage = invalidThisPage;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.current?.renewal) clearTimeout(this.current.renewal);
    for (const wake of [...this.wakeups]) wake();
    const flight = this.flight ?? Promise.resolve();
    this.stopPromise = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.storeOpen = false;
        resolve();
      };
      const timer = setTimeout(finish, this.options.drainMs);
      void flight.then(finish, finish);
    });
    return this.stopPromise;
  }
}
