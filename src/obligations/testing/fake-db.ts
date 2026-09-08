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
      case "$exists":
        return (actual !== undefined) === value;
      case "$type":
        return value === "date" && actual instanceof Date;
      case "$ne":
        return !same(actual, value);
      case "$in":
        return value.some((v: any) => same(actual, v));
      case "$lt":
        return actual !== undefined && actual < value;
      case "$lte":
        return actual !== undefined && actual <= value;
      case "$gt":
        return actual !== undefined && actual > value;
      case "$gte":
        return actual !== undefined && actual >= value;
      default:
        throw new Error("unsupported_filter_" + op);
    }
  });
}
export function matchesFilter(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$and") return value.every((f: Row) => matchesFilter(row, f));
    if (key === "$or") return value.some((f: Row) => matchesFilter(row, f));
    if (key === "$expr") {
      const [a, b] = value.$lt;
      const resolve = (x: any) => (typeof x === "string" && x.startsWith("$") ? get(row, x.slice(1)) : x);
      return resolve(a) !== undefined && resolve(b) !== undefined && resolve(a) < resolve(b);
    }
    return predicate(get(row, key), value);
  });
}
type Context = { filter?: Row; update?: Row; document?: Row; options?: Row };
type Hook = {
  collection: string;
  operation: string;
  after: boolean;
  when: (ctx: Context) => boolean;
  run: () => Promise<void>;
};
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
    const fault = this.localFaults.findIndex(
      (f) => f.collection === collection && f.operation === operation && f.when(context),
    );
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
    const index = this.hooks.findIndex(
      (h) => h.collection === collection && h.operation === operation && h.after === after && h.when(ctx),
    );
    if (index >= 0) {
      const [hook] = this.hooks.splice(index, 1);
      await hook!.run();
    }
  }
  failNext(collection: string, operation: string, after = false, when: Hook["when"] = () => true): void {
    this.hooks.push({
      collection,
      operation,
      after,
      when,
      run: async () => {
        throw new Error("injected");
      },
    });
  }
  pause(
    collection: string,
    operation: string,
    when: Hook["when"] = () => true,
    after = false,
  ): {
    reached: Promise<void>;
    release(): void;
  } {
    let signal!: () => void, release!: () => void;
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
  localTimeoutNext(collection: string, operation: string, when: Hook["when"] = () => true): void {
    this.localFaults.push({ collection, operation, when });
  }
  commitLocal(name: string): void {
    this.collection(name).resolveLocal(true);
  }
  rollbackLocal(name: string): void {
    this.collection(name).resolveLocal(false);
  }
  writes(name?: string): number {
    return this.operations.filter(
      (op) =>
        (!name || op.collection === name) &&
        ["insertOne", "updateOne", "replaceOne", "deleteMany", "createIndex"].includes(op.operation),
    ).length;
  }
}
export class FakeCollection {
  // Direct fixture edits/TTL deletion affect durable state. Local-only writes
  // live in a separate overlay and never appear in majority reads.
  readonly rows = new Map<string, Row>();
  private readonly localRows = new Map<string, Row | null>();
  readonly indexes: Row[] = [{ key: { _id: 1 }, name: "_id_", unique: true }];
  private counter = 0;
  constructor(
    private owner: FakeDb,
    private name: string,
  ) {}
  stageLocal(before: Map<string, Row>): void {
    if (this.localRows.size) throw new Error("resolve_staged_write_first");
    for (const id of new Set([...before.keys(), ...this.rows.keys()])) {
      if (!same(before.get(id), this.rows.get(id))) this.localRows.set(id, copy(this.rows.get(id) ?? null));
    }
    this.rows.clear();
    for (const [id, row] of before) this.rows.set(id, copy(row));
  }
  resolveLocal(commit: boolean): void {
    if (commit)
      for (const [id, row] of this.localRows) {
        if (row) this.rows.set(id, copy(row));
        else this.rows.delete(id);
      }
    this.localRows.clear();
  }
  private visible(options: Row): Row[] {
    if (options.readConcern?.level === "majority") return [...this.rows.values()];
    const local = new Map(this.rows);
    for (const [id, row] of this.localRows) {
      if (row) local.set(id, row);
      else local.delete(id);
    }
    return [...local.values()];
  }
  private unique(row: Row, replacing?: string): void {
    for (const index of this.indexes) {
      if (!index.unique || (index.partialFilterExpression && !matchesFilter(row, index.partialFilterExpression)))
        continue;
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
        if (
          !same(existing.expireAfterSeconds, options.expireAfterSeconds) ||
          Boolean(existing.unique) !== Boolean(options.unique)
        )
          throw { code: 85 };
        return existing.name;
      }
      const name = Object.entries(key)
        .map(([k, v]) => k + "_" + v)
        .join("_");
      this.indexes.push({ key: copy(key), name, ...copy(options) });
      for (const row of this.rows.values()) this.unique(row, row._id);
      return name;
    });
  }
  listIndexes(): { toArray(): Promise<Row[]> } {
    return { toArray: () => this.owner.operation(this.name, "listIndexes", {}, () => this.indexes) };
  }
  async findOne(filter: Row, options: Row = {}): Promise<Row | null> {
    return this.owner.operation(
      this.name,
      "findOne",
      { filter, options },
      () => this.visible(options).find((row) => matchesFilter(row, filter)) ?? null,
    );
  }
  find(filter: Row = {}, options: Row = {}): any {
    let sort: Row = {},
      limit = Number.MAX_SAFE_INTEGER;
    const cursor = {
      sort(value: Row) {
        sort = value;
        return cursor;
      },
      limit(value: number) {
        limit = value;
        return cursor;
      },
      project() {
        return cursor;
      },
      toArray: () =>
        this.owner.operation(this.name, "find", { filter, options }, () =>
          this.visible(options)
            .filter((row) => matchesFilter(row, filter))
            .sort((a, b) => {
              for (const [key, direction] of Object.entries(sort)) {
                if (same(get(a, key), get(b, key))) continue;
                return (get(a, key) < get(b, key) ? -1 : 1) * direction;
              }
              return 0;
            })
            .slice(0, limit),
        ),
    };
    return cursor;
  }
  async countDocuments(filter: Row = {}, options: Row = {}): Promise<number> {
    return this.owner.operation(
      this.name,
      "countDocuments",
      { filter, options },
      () => this.visible(options).filter((row) => matchesFilter(row, filter)).length,
    );
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
      for (const [id, row] of this.rows)
        if (matchesFilter(row, filter)) {
          this.rows.delete(id);
          deletedCount++;
        }
      return { acknowledged: true, deletedCount };
    });
  }
}
