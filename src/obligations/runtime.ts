import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { type DeliveryCapability, fail } from "./types.js";
import { ObligationStore } from "./store.js";
import { ReceiptStore } from "./receipts.js";
import { DeliveryService, safeError } from "./delivery.js";
import { ObligationReader } from "./reader.js";
import { ObligationSweeper } from "./sweeper.js";
import { SlackObligationPoster, type ObligationPoster } from "./slack-post.js";

export class ObligationRuntime implements DeliveryCapability {
  readonly store: ObligationStore;
  readonly receipts: ReceiptStore;
  readonly reader: ObligationReader;
  readonly delivery: DeliveryService;
  readonly sweeper: ObligationSweeper;
  private transport?: ObligationPoster;
  private initialized = false;
  private ready = false;
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  constructor(
    db: Db,
    retentionDays: number,
    readonly canWrite: () => boolean,
    readonly clock: () => Date = () => new Date(),
    readonly bootId = randomUUID(),
    readonly suppliedPoster?: ObligationPoster,
  ) {
    this.store = new ObligationStore(db);
    this.receipts = new ReceiptStore(db, retentionDays);
    this.reader = new ObligationReader(this.store, this.receipts, clock);
    const poster: ObligationPoster = {
      post: (destination, text) =>
        this.transport
          ? this.transport.post(destination, text)
          : Promise.resolve({ kind: "unknown", reason: "unconfirmed_response" }),
    };
    this.delivery = new DeliveryService(this.store, this.receipts, poster, bootId, clock, canWrite);
    this.sweeper = new ObligationSweeper(this.store, this.receipts, this.delivery, poster, bootId, clock, canWrite);
  }
  async init(): Promise<void> {
    await this.store.init();
    await this.receipts.init();
    this.initialized = true;
  }
  async start(botToken: string, echo: (channel: string, ts: string) => void): Promise<void> {
    if (this.ready || this.stopping) return;
    if (!this.initialized) return fail("not_initialized");
    this.transport = this.suppliedPoster ?? new SlackObligationPoster(botToken, echo, this.canWrite, this.clock);
    this.ready = true;
    await this.sweeper.start();
  }
  private track(run: () => Promise<unknown>): Promise<unknown> {
    const promise = run().finally(() => {
      this.inFlight.delete(promise);
    });
    this.inFlight.add(promise);
    return promise;
  }
  discover(agentId: string, input: unknown): Promise<unknown> {
    if (this.stopping || !this.initialized || !this.canWrite()) return Promise.resolve({ state: "unavailable" });
    return this.track(async () => {
      try {
        return await this.reader.discover(agentId, input);
      } catch (err) {
        return { state: "inspection_unavailable", reason: safeError(err) };
      }
    });
  }
  deliver(agentId: string, input: unknown): Promise<unknown> {
    if (!this.ready || this.stopping) return Promise.resolve({ state: "unavailable", retryAllowed: false });
    return this.track(async () => {
      try {
        return await this.delivery.deliver(agentId, input);
      } catch (err) {
        return { state: "delivery_outcome_unknown", reason: safeError(err), retryAllowed: false };
      }
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    await this.sweeper.stop();
    await Promise.allSettled([...this.inFlight]);
    this.transport = undefined;
  }
}
