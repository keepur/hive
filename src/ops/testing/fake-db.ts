/* eslint-disable @typescript-eslint/no-explicit-any */
import { ObjectId, type Db } from "mongodb";

/**
 * KPR-454 chunk 3, Step 1 — the in-memory Mongo double the publisher and its
 * acceptance suite run against. Modelled on
 * `src/obligations/testing/fake-db.ts` (same conventions, no new mocking
 * library), with TWO DELIBERATE DIVERGENCES from that file, both load-bearing
 * for this producer:
 *
 *  1. `_id` is minted with the REAL `new ObjectId()`, and this double's sort
 *     uses the same `String(...)` comparison `isMoreRecent` uses. That file
 *     mints `` `${name}/${++counter}` ``, a counter string whose lexicographic
 *     inversion at n >= 10 (`"…/10" < "…/9"`) would make D8's
 *     (publishedAt, _id) tie-break pass or fail for a reason unrelated to the
 *     resolver.
 *  2. `findOne(filter, { sort })` HONOURS `sort`. That file's `findOne`
 *     ignores `options` and returns the first insertion-order match; the epoch
 *     resolver issues `findOne(…, { sort: { publishedAt: -1, _id: -1 } })` on
 *     both of its reads, so a sort-ignoring double would hand back the OLDEST
 *     matching event and the whole epoch mechanism would be tested against the
 *     wrong document.
 *
 * Not emulated, deliberately: unique-index enforcement and MongoDB's
 * IndexOptionsConflict. Neither is a requirement of this double — the
 * index-fault and TTL-conflict cases are driven by a PROGRAMMED rejection
 * (`failAll`/`failNext` with a supplied error), which is what the store's
 * containment actually reacts to, and emulating a conflict would make a
 * second `init()` throw for a reason no production path has.
 *
 * TWO FURTHER DIVERGENCES, both safe and both previously undocumented — the
 * kind a case author only discovers by reading the implementation:
 *
 *  3. `operation()` pushes onto `operations` BEFORE fault injection, so a
 *     FAULTED call is counted. That is what the read-counting surface means:
 *     `operations` is "calls attempted", not "calls that returned". A case
 *     combining `failAll`/`failNext` with an `operations`-length assertion
 *     must therefore expect the faulted attempts in its count — not a bug,
 *     but not the reading the name invites either. (It is also why
 *     `armThrowOnEveryAccess` is the opposite: that throw precedes the push,
 *     so the two absence surfaces — "no operation ran" and "nothing was
 *     recorded" — agree.)
 *  4. `insertOne` does NOT write `_id` back onto the CALLER's document the way
 *     the Node driver does: it mints the id onto its own stored copy and
 *     returns it as `insertedId`, leaving the caller's object untouched. This
 *     double is therefore STRICTER than production — the safe direction. Code
 *     that reads `doc._id` after its own `insertOne` works against real Mongo
 *     and fails here, so a case cannot come to depend on a mutation the
 *     publisher does not need (it reads `insertedId` nowhere and returns the
 *     `_id`-less `doc`, which is exactly why `isMoreRecent`'s `String(a._id)`
 *     is only ever applied to documents read BACK out of the collection).
 */

type Row = Record<string, any>;

/**
 * ⚠ NOT `structuredClone`. `_id` is a real `ObjectId` (divergence 1 above) and
 * `structuredClone` drops its prototype — the clone stringifies to
 * `"[object Object]"`, which silently breaks the one tie-break this double
 * exists to exercise (verified: `String(structuredClone(new ObjectId()))` is
 * `"[object Object]"`). `ObjectId` is copied by reference; it is immutable in
 * every use here.
 */
function copy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof ObjectId) return value as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => copy(entry)) as unknown as T;
  const out: Row = {};
  for (const [key, entry] of Object.entries(value as Row)) out[key] = copy(entry);
  return out as unknown as T;
}

/** Nested-path read, so `"subject.kind"` resolves. */
const get = (row: Row, path: string): any => path.split(".").reduce<any>((value, key) => value?.[key], row);

function set(row: Row, path: string, value: unknown): void {
  const parts = path.split(".");
  let target = row;
  for (const key of parts.slice(0, -1)) target = target[key] ??= {};
  target[parts.at(-1)!] = copy(value);
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const x = a as Row;
    const y = b as Row;
    const keys = (row: Row) =>
      Object.keys(row)
        .filter((k) => row[k] !== undefined)
        .sort();
    const xk = keys(x);
    const yk = keys(y);
    return xk.length === yk.length && xk.every((k, i) => k === yk[i] && same(x[k], y[k]));
  }
  return a === b;
}

/**
 * Equality only, per the harness requirements. An operator-shaped term throws
 * rather than silently matching nothing, so a future test reaching for one
 * fails loudly instead of reporting coverage it lacks.
 */
function predicate(actual: any, expected: any): boolean {
  if (
    expected &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    !(expected instanceof Date) &&
    !(expected instanceof ObjectId)
  ) {
    const operator = Object.keys(expected).find((key) => key.startsWith("$"));
    if (operator !== undefined) throw new Error("unsupported_filter_" + operator);
  }
  return same(actual, expected);
}

export function matchesFilter(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => predicate(get(row, key), value));
}

/**
 * The SAME `String(...)` comparison `publisher.ts`'s `isMoreRecent` uses, so
 * the double and the code under test agree on same-millisecond order.
 */
function compare(a: any, b: any): number {
  if (a instanceof ObjectId || b instanceof ObjectId) {
    const x = String(a);
    const y = String(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (same(a, b)) return 0;
  return a < b ? -1 : 1;
}

function sorted(rows: Row[], sort: Row): Row[] {
  const spec = Object.entries(sort);
  if (spec.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const [key, direction] of spec) {
      const result = compare(get(a, key), get(b, key));
      if (result !== 0) return result * (direction as number);
    }
    return 0;
  });
}

type Context = { filter?: Row; update?: Row; document?: Row; options?: Row };
type When = (ctx: Context) => boolean;
type Hook = { collection: string; operation: string; after: boolean; when: When; run: () => Promise<void> };
type Fault = { collection: string; operation: string; when: When; once: boolean; error: unknown };

const matches = (declared: string, actual: string): boolean => declared === "*" || declared === actual;

export class FakeDb {
  readonly collections = new Map<string, FakeCollection>();
  /** Every call, in order — the read-counting surface. */
  readonly operations: Array<{ collection: string; operation: string; context: Context }> = [];
  private hooks: Hook[] = [];
  private faults: Fault[] = [];
  private armed = false;
  readonly db = { collection: (name: string) => this.collection(name) } as unknown as Db;

  collection(name: string): FakeCollection {
    if (this.armed) throw new Error("armed_throw_on_every_access");
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(this, name));
    return this.collections.get(name)!;
  }

  /**
   * The armed-to-throw mode, replacing a `throwingDb()` factory. A `Db` whose
   * every property access throws is not constructible for either of its named
   * consumers — `OpsStore`'s constructor calls `db.collection()` three times,
   * and the two claims that need it ("match evaluation performs no I/O", "a
   * success with no open condition performs no database access") need a WIRED
   * publisher, which needs a successful `init()`. So: one live `FakeDb`, armed
   * AFTER `init()`. The throw precedes the `operations` push, so an armed
   * access leaves no trace either — both surfaces assert the same absence.
   */
  armThrowOnEveryAccess(): void {
    this.armed = true;
  }

  async operation<T>(collection: string, operation: string, context: Context, action: () => T): Promise<T> {
    if (this.armed) throw new Error("armed_throw_on_every_access");
    this.operations.push({ collection, operation, context: copy(context) });
    await this.hook(collection, operation, context, false);
    const index = this.faults.findIndex(
      (f) => matches(f.collection, collection) && f.operation === operation && f.when(context),
    );
    if (index >= 0) {
      const fault = this.faults[index]!;
      if (fault.once) this.faults.splice(index, 1);
      throw fault.error;
    }
    const result = copy(action());
    await this.hook(collection, operation, context, true);
    return copy(result);
  }

  private async hook(collection: string, operation: string, ctx: Context, after: boolean): Promise<void> {
    const index = this.hooks.findIndex(
      (h) => matches(h.collection, collection) && h.operation === operation && h.after === after && h.when(ctx),
    );
    if (index >= 0) {
      const [hook] = this.hooks.splice(index, 1);
      await hook!.run();
    }
  }

  /** Reject the NEXT matching call. `collection` accepts `"*"`. */
  failNext(
    collection: string,
    operation: string,
    error: unknown = new Error("injected"),
    when: When = () => true,
  ): void {
    this.faults.push({ collection, operation, when, once: true, error });
  }

  /** Reject EVERY matching call until `clearFaults()`. `collection` accepts `"*"`. */
  failAll(
    collection: string,
    operation: string,
    error: unknown = new Error("injected"),
    when: When = () => true,
  ): void {
    this.faults.push({ collection, operation, when, once: false, error });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /**
   * Hold the caller inside one operation, and release it on demand. Copied
   * from `src/obligations/testing/fake-db.ts:118` — `await reached` blocks
   * until the drainer is inside that operation, `release()` lets it continue.
   * The `R1 · F · R2` interleaving has no other construction that observes the
   * open-condition map at all.
   */
  pause(
    collection: string,
    operation: string,
    when: When = () => true,
    after = false,
  ): { reached: Promise<void>; release(): void } {
    let signal!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hooks.push({
      collection,
      operation,
      when,
      after,
      run: async () => {
        signal();
        await gate;
      },
    });
    return { reached, release };
  }
}

export class FakeCollection {
  /** Insertion order, as an array. */
  readonly rows: Row[] = [];
  readonly indexes: Row[] = [{ key: { _id: 1 }, name: "_id_" }];

  constructor(
    private readonly owner: FakeDb,
    private readonly name: string,
  ) {}

  async createIndex(key: Row, options: Row = {}): Promise<string> {
    return this.owner.operation(this.name, "createIndex", { document: { key, ...options } }, () => {
      const existing = this.indexes.find((index) => same(index.key, key));
      if (existing) return existing.name as string;
      const name = Object.entries(key)
        .map(([field, direction]) => field + "_" + direction)
        .join("_");
      this.indexes.push({ key: copy(key), name, ...copy(options) });
      return name;
    });
  }

  async findOne(filter: Row = {}, options: Row = {}): Promise<Row | null> {
    return this.owner.operation(this.name, "findOne", { filter, options }, () => {
      const candidates = this.rows.filter((row) => matchesFilter(row, filter));
      return sorted(candidates, options.sort ?? {})[0] ?? null;
    });
  }

  find(filter: Row = {}, options: Row = {}): any {
    let sort: Row = {};
    let limit = Number.MAX_SAFE_INTEGER;
    const cursor = {
      sort: (value: Row) => {
        sort = value;
        return cursor;
      },
      limit: (value: number) => {
        limit = value;
        return cursor;
      },
      project: () => cursor,
      toArray: () =>
        this.owner.operation(this.name, "find", { filter, options }, () =>
          sorted(
            this.rows.filter((row) => matchesFilter(row, filter)),
            sort,
          ).slice(0, limit),
        ),
    };
    return cursor;
  }

  async countDocuments(filter: Row = {}, options: Row = {}): Promise<number> {
    return this.owner.operation(
      this.name,
      "countDocuments",
      { filter, options },
      () => this.rows.filter((row) => matchesFilter(row, filter)).length,
    );
  }

  async insertOne(document: Row, options: Row = {}): Promise<Row> {
    return this.owner.operation(this.name, "insertOne", { document, options }, () => {
      // Divergence 1: a REAL ObjectId, so the (publishedAt, _id) tie-break
      // rests on the same per-process monotonic value the driver mints.
      const row = { ...copy(document), _id: document._id ?? new ObjectId() };
      this.rows.push(row);
      return { acknowledged: true, insertedId: row._id };
    });
  }

  async updateOne(filter: Row, update: Row, options: Row = {}): Promise<Row> {
    return this.owner.operation(this.name, "updateOne", { filter, update, options }, () => {
      const old = this.rows.find((row) => matchesFilter(row, filter));
      if (!old && !options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      const row = old ?? { ...copy(filter), _id: filter._id ?? new ObjectId() };
      if (!old && update.$setOnInsert) Object.assign(row, copy(update.$setOnInsert));
      for (const [key, value] of Object.entries(update.$set ?? {})) set(row, key, value);
      if (!old) this.rows.push(row);
      return { acknowledged: true, matchedCount: old ? 1 : 0, modifiedCount: old ? 1 : 0, upsertedCount: old ? 0 : 1 };
    });
  }
}
