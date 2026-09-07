# KPR-456 plan chunk 5 — atomic test harness and pure boundaries

Parent: [implementation plan](kpr-456-plan.md). These are real tests to execute after applying the production chunks; this drafting phase does not claim their results.

## Task 15: Atomic fake Mongo driver with crash barriers

**Create:** src/obligations/testing/fake-db.ts

- [ ] Add this complete test-only support module. It is a Mongo-boundary fake, not a fake obligation store: all registry/receipt/service code under test is production code.

~~~typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from "mongodb";
import { same } from "../types.js";

type Row = Record<string, any>;
const copy = <T>(value: T): T => structuredClone(value);
const get = (row: Row, path: string): any => path.split(".").reduce((v, k) => v?.[k], row);
function set(row: Row, path: string, value: unknown): void {
  const parts = path.split(".");
  let target = row;
  for (const key of parts.slice(0, -1)) target = target[key] ??= {};
  target[parts.at(-1)!] = copy(value);
}
function unset(row: Row, path: string): void {
  const parts = path.split(".");
  let target = row;
  for (const key of parts.slice(0, -1)) {
    if (!target[key]) return;
    target = target[key];
  }
  delete target[parts.at(-1)!];
}
function predicate(actual: any, expected: any): boolean {
  if (!expected || typeof expected !== "object" || expected instanceof Date || Array.isArray(expected)) {
    return same(actual, expected);
  }
  if (!Object.keys(expected).some((key) => key.startsWith("$"))) return same(actual, expected);
  return Object.entries(expected).every(([op, value]: [string, any]) => {
    switch (op) {
      case "$exists": return (actual !== undefined) === value;
      case "$type": return value === "date" && actual instanceof Date;
      case "$ne": return !same(actual, value);
      case "$in": return value.some((v: any) => same(actual, v));
      case "$lt": return actual !== undefined && actual < value;
      case "$lte": return actual !== undefined && actual <= value;
      case "$gt": return actual !== undefined && actual > value;
      case "$gte": return actual !== undefined && actual >= value;
      default: throw new Error("unsupported_filter_" + op);
    }
  });
}
export function matchesFilter(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return value.every((f: Row) => matchesFilter(row, f));
    if (key === "$or") return value.some((f: Row) => matchesFilter(row, f));
    if (key === "$expr") {
      const [a, b] = value.$lt;
      const resolve = (x: any) => typeof x === "string" && x.startsWith("$") ? get(row, x.slice(1)) : x;
      return resolve(a) !== undefined && resolve(b) !== undefined && resolve(a) < resolve(b);
    }
    return predicate(get(row, key), value);
  });
}
type Context = { filter?: Row; update?: Row; document?: Row; options?: Row };
type Hook = { collection: string; operation: string; after: boolean; when: (ctx: Context) => boolean; run: () => Promise<void> };
export class FakeDb {
  readonly collections = new Map<string, FakeCollection>();
  readonly operations: Array<{ collection: string; operation: string; context: Context }> = [];
  private hooks: Hook[] = [];
  private localFaults: Array<Pick<Hook, "collection" | "operation" | "when">> = [];
  readonly db = { collection: (name: string) => this.collection(name) } as unknown as Db;
  collection(name: string): FakeCollection {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(this, name));
    return this.collections.get(name)!;
  }
  async operation<T>(collection: string, operation: string, context: Context, action: () => T): Promise<T> {
    this.operations.push({ collection, operation, context: copy(context) });
    await this.hook(collection, operation, context, false);
    const fault = this.localFaults.findIndex((f) =>
      f.collection === collection && f.operation === operation && f.when(context));
    const target = this.collection(collection);
    const before = fault < 0 ? undefined : copy(target.rows);
    const result = copy(action()); // Atomic test-and-mutate; snapshot results before an after barrier.
    if (before) {
      this.localFaults.splice(fault, 1);
      target.stageLocal(before);
      throw new Error("injected_majority_timeout");
    }
    await this.hook(collection, operation, context, true);
    return copy(result);
  }
  private async hook(collection: string, operation: string, ctx: Context, after: boolean): Promise<void> {
    const index = this.hooks.findIndex((h) =>
      h.collection === collection && h.operation === operation && h.after === after && h.when(ctx));
    if (index >= 0) {
      const [hook] = this.hooks.splice(index, 1);
      await hook!.run();
    }
  }
  failNext(collection: string, operation: string, after = false, when: Hook["when"] = () => true): void {
    this.hooks.push({ collection, operation, after, when, run: async () => { throw new Error("injected"); } });
  }
  pause(collection: string, operation: string, when: Hook["when"] = () => true, after = false): {
    reached: Promise<void>; release(): void;
  } {
    let signal!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { signal = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.hooks.push({
      collection, operation, when, after,
      run: async () => { signal(); await gate; },
    });
    return { reached, release };
  }
  localTimeoutNext(collection: string, operation: string, when: Hook["when"] = () => true): void {
    this.localFaults.push({ collection, operation, when });
  }
  commitLocal(name: string): void { this.collection(name).resolveLocal(true); }
  rollbackLocal(name: string): void { this.collection(name).resolveLocal(false); }
  writes(name?: string): number {
    return this.operations.filter((op) =>
      (!name || op.collection === name) && ["insertOne", "updateOne", "replaceOne", "deleteMany", "createIndex"].includes(op.operation)).length;
  }
}
export class FakeCollection {
  // Direct fixture edits/TTL deletion affect durable state. Local-only writes
  // live in a separate overlay and never appear in majority reads.
  readonly rows = new Map<string, Row>();
  private readonly localRows = new Map<string, Row | null>();
  readonly indexes: Row[] = [{ key: { _id: 1 }, name: "_id_", unique: true }];
  private counter = 0;
  constructor(private owner: FakeDb, private name: string) {}
  stageLocal(before: Map<string, Row>): void {
    if (this.localRows.size) throw new Error("resolve_staged_write_first");
    for (const id of new Set([...before.keys(), ...this.rows.keys()])) {
      if (!same(before.get(id), this.rows.get(id))) this.localRows.set(id, copy(this.rows.get(id) ?? null));
    }
    this.rows.clear();
    for (const [id, row] of before) this.rows.set(id, copy(row));
  }
  resolveLocal(commit: boolean): void {
    if (commit) for (const [id, row] of this.localRows) {
      if (row) this.rows.set(id, copy(row)); else this.rows.delete(id);
    }
    this.localRows.clear();
  }
  private visible(options: Row): Row[] {
    if (options.readConcern?.level === "majority") return [...this.rows.values()];
    const local = new Map(this.rows);
    for (const [id, row] of this.localRows) {
      if (row) local.set(id, row); else local.delete(id);
    }
    return [...local.values()];
  }
  private unique(row: Row, replacing?: string): void {
    for (const index of this.indexes) {
      if (!index.unique || (index.partialFilterExpression && !matchesFilter(row, index.partialFilterExpression))) continue;
      for (const other of this.rows.values()) {
        if (other._id === replacing) continue;
        if (index.partialFilterExpression && !matchesFilter(other, index.partialFilterExpression)) continue;
        if (Object.keys(index.key).every((key) => same(get(other, key), get(row, key)))) throw { code: 11000 };
      }
    }
  }
  async createIndex(key: Row, options: Row = {}): Promise<string> {
    return this.owner.operation(this.name, "createIndex", { document: { key, ...options } }, () => {
      const existing = this.indexes.find((i) => same(i.key, key));
      if (existing) {
        if (!same(existing.expireAfterSeconds, options.expireAfterSeconds)
          || Boolean(existing.unique) !== Boolean(options.unique)) throw { code: 85 };
        return existing.name;
      }
      const name = Object.entries(key).map(([k, v]) => k + "_" + v).join("_");
      this.indexes.push({ key: copy(key), name, ...copy(options) });
      for (const row of this.rows.values()) this.unique(row, row._id);
      return name;
    });
  }
  listIndexes(): { toArray(): Promise<Row[]> } {
    return { toArray: () => this.owner.operation(this.name, "listIndexes", {}, () => this.indexes) };
  }
  async findOne(filter: Row, options: Row = {}): Promise<Row | null> {
    return this.owner.operation(this.name, "findOne", { filter, options }, () =>
      this.visible(options).find((row) => matchesFilter(row, filter)) ?? null);
  }
  find(filter: Row = {}, options: Row = {}): any {
    let sort: Row = {}, limit = Number.MAX_SAFE_INTEGER;
    const cursor = {
      sort(value: Row) { sort = value; return cursor; },
      limit(value: number) { limit = value; return cursor; },
      project() { return cursor; },
      toArray: () => this.owner.operation(this.name, "find", { filter, options }, () =>
        this.visible(options).filter((row) => matchesFilter(row, filter)).sort((a, b) => {
          for (const [key, direction] of Object.entries(sort)) {
            if (same(get(a, key), get(b, key))) continue;
            return (get(a, key) < get(b, key) ? -1 : 1) * direction;
          }
          return 0;
        }).slice(0, limit)),
    };
    return cursor;
  }
  async countDocuments(filter: Row = {}, options: Row = {}): Promise<number> {
    return this.owner.operation(this.name, "countDocuments", { filter, options }, () =>
      this.visible(options).filter((row) => matchesFilter(row, filter)).length);
  }
  async insertOne(document: Row, options: Row = {}): Promise<Row> {
    return this.owner.operation(this.name, "insertOne", { document, options }, () => {
      const row = { ...copy(document), _id: document._id ?? this.name + "/" + ++this.counter };
      this.unique(row);
      this.rows.set(row._id, row);
      return { acknowledged: true, insertedId: row._id };
    });
  }
  async updateOne(filter: Row, update: Row, options: Row = {}): Promise<Row> {
    return this.owner.operation(this.name, "updateOne", { filter, update, options }, () => {
      const old = [...this.rows.values()].find((row) => matchesFilter(row, filter));
      if (!old && !options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      const row = old ? copy(old) : { ...copy(filter), _id: filter._id ?? this.name + "/" + ++this.counter };
      if (!old && update.$setOnInsert) Object.assign(row, copy(update.$setOnInsert));
      for (const [key, value] of Object.entries(update.$set ?? {})) set(row, key, value);
      for (const key of Object.keys(update.$unset ?? {})) unset(row, key);
      for (const [key, value] of Object.entries(update.$max ?? {})) {
        if (get(row, key) === undefined || get(row, key) < value!) set(row, key, value);
      }
      for (const [key, value] of Object.entries(update.$inc ?? {})) set(row, key, (get(row, key) ?? 0) + Number(value));
      this.unique(row, old?._id);
      this.rows.set(row._id, row);
      return { acknowledged: true, matchedCount: old ? 1 : 0, modifiedCount: old ? 1 : 0, upsertedCount: old ? 0 : 1 };
    });
  }
  async replaceOne(filter: Row, document: Row, options: Row = {}): Promise<Row> {
    return this.owner.operation(this.name, "replaceOne", { filter, document, options }, () => {
      const old = [...this.rows.values()].find((row) => matchesFilter(row, filter));
      if (!old) return { acknowledged: true, matchedCount: 0 };
      this.unique(document, old._id);
      this.rows.set(old._id, copy(document));
      return { acknowledged: true, matchedCount: 1 };
    });
  }
  async deleteMany(filter: Row): Promise<Row> {
    return this.owner.operation(this.name, "deleteMany", { filter }, () => {
      let deletedCount = 0;
      for (const [id, row] of this.rows) if (matchesFilter(row, filter)) {
        this.rows.delete(id); deletedCount++;
      }
      return { acknowledged: true, deletedCount };
    });
  }
}
~~~

Local-timeout tests explicitly commit or roll back their staged overlay before further writes to that collection; normal writes, including failNext(..., true), are durable. All read/write options are recorded. The fake deliberately throws on unsupported filter operators, so a production query cannot silently become a permissive test match. For production-only driver method additions, extend the fake semantics with a focused assertion before relying on that query in races.

## Task 16: Pure recurrence and transport tests

**Create:** src/obligations/deadlines.test.ts

- [ ] Add:

~~~typescript
import { describe, expect, it } from "vitest";
import { deadlineSchema, registrationSchema, type Obligation } from "./types.js";
import { adjacent, currentDue, scan, windowStart } from "./deadlines.js";

const rule = deadlineSchema.parse({ localTime: "08:00", weekdays: [1,2,3,4,5], timezone: "UTC" });
function obligation(activeFrom = "2026-09-07T07:00:00.000Z"): Obligation {
  return {
    _id: "demo", deliverable: "Demo", producerAgentId: "demo-producer",
    deadline: rule, destination: { kind: "slack", channelId: "C00000001" },
    noticeDestination: { kind: "slack", channelId: "C00000002" }, createdBy: "operator",
    activeFrom: new Date(activeFrom), createdAt: new Date(activeFrom), scanThrough: new Date(activeFrom),
  };
}
describe("strict deadline contract", () => {
  it.each([
    { localTime: "24:00" }, { localTime: "8:00" }, { localTime: "00:60" },
    { weekdays: [] }, { weekdays: [1,1] }, { weekdays: [7] },
    { timezone: "not/a-zone" }, { timezone: "+01:00" },
  ])("rejects invalid %j", (bad) => {
    expect(deadlineSchema.safeParse({ ...rule, ...bad }).success).toBe(false);
  });
  it("rejects caller-owned engine fields and missing notice recipient", () => {
    const o = obligation();
    expect(registrationSchema.safeParse(o).success).toBe(false);
    const { activeFrom, createdAt, scanThrough, noticeDestination, ...input } = o;
    void activeFrom; void createdAt; void scanThrough; void noticeDestination;
    expect(registrationSchema.safeParse(input).success).toBe(false);
  });
  it("clamps the first exclusive lower bound and has no registration backfill", () => {
    const o = obligation();
    const due = new Date("2026-09-07T08:00:00.000Z");
    expect(windowStart(o, due)).toEqual(o.activeFrom);
    expect(currentDue(o, o.activeFrom)).toBeNull();
    expect(currentDue(o, due)).toEqual(due);
    expect(currentDue(o, new Date(due.getTime() + 1))).toEqual(new Date("2026-09-08T08:00:00.000Z"));
    expect(scan(rule, due, due).due).toEqual([]);
    expect(() => windowStart(obligation(due.toISOString()), due)).toThrow("invalid_occurrence");
  });
  it("bounds scanning and resumes without losing dates", () => {
    const start = new Date("2026-09-07T07:59:00.000Z"), end = new Date("2026-09-09T08:00:00.000Z");
    let through = start;
    const found: string[] = [];
    while (through < end) {
      const batch = scan(rule, through, end, 30);
      expect(batch.through.getTime() - through.getTime()).toBeLessThanOrEqual(30 * 60_000);
      found.push(...batch.due.map((d) => d.toISOString()));
      through = batch.through;
    }
    expect(found).toEqual(["2026-09-07T08:00:00.000Z", "2026-09-08T08:00:00.000Z", "2026-09-09T08:00:00.000Z"]);
    expect(scan(rule, through, start).through).toEqual(through);
  });
  it("skips the spring gap and produces both autumn fold instants", () => {
    const spring = deadlineSchema.parse({ localTime: "02:30", weekdays: [0], timezone: "America/Los_Angeles" });
    expect(adjacent(spring, new Date("2026-03-08T00:00:00Z"), 1)).toEqual(new Date("2026-03-15T09:30:00Z"));
    const fold = deadlineSchema.parse({ localTime: "01:30", weekdays: [0], timezone: "America/Los_Angeles" });
    const first = adjacent(fold, new Date("2026-11-01T00:00:00Z"), 1);
    const second = adjacent(fold, first, 1);
    expect(first).toEqual(new Date("2026-11-01T08:30:00Z"));
    expect(second).toEqual(new Date("2026-11-01T09:30:00Z"));
    expect(adjacent(fold, second, -1)).toEqual(first);
  });
  it("ignores host timezone for the registered rule", () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ["UTC", "Pacific/Auckland", "America/New_York"]) {
        process.env.TZ = tz;
        expect(adjacent(rule, new Date("2026-09-07T07:00:00Z"), 1)).toEqual(new Date("2026-09-07T08:00:00Z"));
      }
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });
});
~~~

**Create:** src/obligations/testing/refusals.ts

- [ ] Pin the design's closed list independently of the production export. Both transport suites import this fixture; never derive test rows from NONACCEPTANCE.

~~~typescript
export const SPEC_REFUSALS = [
  "not_authed", "invalid_auth", "token_expired", "token_revoked",
  "missing_scope", "no_permission", "not_in_channel", "channel_not_found",
  "is_archived", "ekm_access_denied", "restricted_action",
  "rate_limited", "ratelimited",
] as const;
~~~

**Create:** src/obligations/slack-post.test.ts

- [ ] Add:

~~~typescript
import { describe, expect, it, vi } from "vitest";
import type { WebClientOptions } from "@slack/web-api";
import { NONACCEPTANCE, SlackObligationPoster } from "./slack-post.js";
import { SPEC_REFUSALS } from "./testing/refusals.js";

const ENDPOINT = "https://slack.com/api/chat.postMessage";
const now = () => new Date("2026-09-07T08:00:00.000Z");
const destination = { kind: "slack" as const, channelId: "C00000001", threadTs: "1725696000.000001" };
export function slackResponse(body: unknown, status = 200, provenance = true, retryAfter?: string, url = ENDPOINT): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (provenance) headers.set("x-slack-req-id", "fixture-request");
  if (retryAfter) headers.set("retry-after", retryAfter);
  const response = new Response(JSON.stringify(body), { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
describe("dedicated Slack obligation transport", () => {
  it("requires complete acknowledgement and records the echo with explicit threading", async () => {
    const fetcher = vi.fn(async (...args: Parameters<NonNullable<WebClientOptions["fetch"]>>) => {
      void args; return slackResponse({ ok: true, channel: destination.channelId, ts: "1.000001" });
    });
    const echo = vi.fn();
    const poster = new SlackObligationPoster("fixture-token", echo, () => true, now, fetcher);
    expect(await poster.post(destination, "complete text")).toEqual({
      kind: "acknowledged", ts: "1.000001", acknowledgedAt: now(),
    });
    expect(echo).toHaveBeenCalledWith(destination.channelId, "1.000001");
    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain("thread_ts");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(ENDPOINT);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
  it("pins exactly the thirteen approved refusal codes", () => {
    expect(SPEC_REFUSALS).toHaveLength(13);
    expect([...NONACCEPTANCE].sort()).toEqual([...SPEC_REFUSALS].sort());
  });
  it.each(SPEC_REFUSALS)("only retries authoritative refusal %s", async (error) => {
    const fetcher = vi.fn(async () => slackResponse({ ok: false, error }));
    const poster = new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher);
    expect((await poster.post(destination, "x")).kind).toBe("rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid_auth", "not_in_channel"])("does not treat raw text %s as a JSON refusal", async (body) => {
    const fetcher = vi.fn(async () => {
      const response = new Response(body, { status: 200, headers: {
        "content-type": "text/plain", "x-slack-req-id": "fixture",
      } });
      Object.defineProperty(response, "url", { value: ENDPOINT });
      return response;
    });
    const echo = vi.fn();
    expect(await new SlackObligationPoster("fixture", echo, () => true, now, fetcher).post(destination, "x"))
      .toMatchObject({ kind: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(echo).not.toHaveBeenCalled();
  });
  it("rejects a Slack 429 without SDK retries and honors Retry-After", async () => {
    const fetcher = vi.fn(async () => slackResponse({ ok: false, error: "ratelimited" }, 429, true, "120"));
    const result = await new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher).post(destination, "x");
    expect(result).toEqual({ kind: "rejected", reason: "rate_limited", retryAt: new Date(now().getTime() + 120_000) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "internal_error", "fatal_error", "service_unavailable", "new_future_code",
  ])("keeps %s unknown", async (error) => {
    const fetcher = vi.fn(async () => slackResponse({ ok: false, error }));
    const result = await new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher).post(destination, "x");
    expect(result.kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ ok: true, channel: "C99999999", ts: "1" }, 200, true],
    [{ ok: true, channel: destination.channelId }, 200, true],
    [{ ok: true, ts: "1" }, 200, true],
    [{ ok: false, error: "invalid_auth" }, 200, false],
    [{ ok: false, error: "invalid_auth" }, 502, true],
    [{ ok: false, error: "ratelimited" }, 429, false],
  ] as const)("defaults malformed/proxy/unproven response to unknown", async (body, status, provenance) => {
    const fetcher = vi.fn(async () => slackResponse(body, status, provenance));
    const poster = new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher);
    expect((await poster.post(destination, "x")).kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["https://proxy.invalid/api/chat.postMessage", "https://slack.com/api/other"])(
    "requires the exact response URL for an allowlisted body from %s", async (url) => {
      const fetcher = vi.fn(async () => slackResponse({ ok: false, error: "invalid_auth" }, 200, true, undefined, url));
      const echo = vi.fn();
      expect(await new SlackObligationPoster("fixture", echo, () => true, now, fetcher).post(destination, "x"))
        .toMatchObject({ kind: "unknown" });
      expect(fetcher).toHaveBeenCalledTimes(1); expect(echo).not.toHaveBeenCalled();
    },
  );
  it("rejects a redirect at the physical fetch boundary without retry", async () => {
    const fetcher = vi.fn(async (...args: Parameters<NonNullable<WebClientOptions["fetch"]>>) => {
      expect(String(args[0])).toBe(ENDPOINT);
      expect(args[1]).toMatchObject({ redirect: "error" });
      throw new TypeError("fetch failed: unexpected redirect");
    });
    const echo = vi.fn();
    expect(await new SlackObligationPoster("fixture", echo, () => true, now, fetcher).post(destination, "x"))
      .toMatchObject({ kind: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(echo).not.toHaveBeenCalled();
  });
  it("does not retry timeout or send through an engaged identity guard", async () => {
    const fetcher = vi.fn(async () => { throw new Error("timeout"); });
    const poster = new SlackObligationPoster("fixture", vi.fn(), () => true, now, fetcher);
    expect((await poster.post(destination, "x")).kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const blocked = new SlackObligationPoster("fixture", vi.fn(), () => false, now, fetcher);
    expect((await blocked.post(destination, "x")).kind).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
~~~

- [ ] Run the unit commands in the main contract. Continue to [assembly and fault tests](kpr-456-plan-6-integration-tests.md).
