/* eslint-disable @typescript-eslint/no-explicit-any */
import { isDeepStrictEqual } from "node:util";
import { BSON } from "mongodb";
import type { CollectionOptions, Db } from "mongodb";

export type Row = Record<string, any>;
const MISSING = Symbol("missing BSON field");

export const cloneBson = <T>(value: T): T =>
  BSON.deserialize(BSON.serialize({ value }), { promoteLongs: false }).value as T;

export function getPath(row: any, path: string): any {
  const visit = (value: any, parts: string[]): any => {
    if (!parts.length) return value;
    if (Array.isArray(value)) {
      return value.map((item) => visit(item, parts)).filter((item) => item !== MISSING);
    }
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, parts[0])) return MISSING;
    return visit(value[parts[0]], parts.slice(1));
  };
  return visit(row, path.split("."));
}

function bsonEqual(a: any, b: any): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return isDeepStrictEqual(a, b);
  }
  if (a instanceof Date || b instanceof Date || a._bsontype || b._bsontype) return isDeepStrictEqual(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return isDeepStrictEqual(keys, Object.keys(b)) && keys.every((key) => bsonEqual(a[key], b[key]));
}

function expression(row: Row, input: any, serverNow: Date): any {
  if (input === "$$NOW") return serverNow;
  if (typeof input === "string" && input.startsWith("$$")) throw new Error("Unsupported test variable");
  if (typeof input === "string" && input.startsWith("$")) return getPath(row, input.slice(1));
  if (Array.isArray(input)) return input.map((item) => expression(row, item, serverNow));
  if (!input || typeof input !== "object" || input instanceof Date) return input;
  const entries = Object.entries(input);
  if (entries.length !== 1) throw new Error("Unsupported test expression");
  const [op, operands] = entries[0] as [string, any];
  const resolve = (value: any) => expression(row, value, serverNow);
  if (op === "$literal") return operands;
  if (op === "$type") {
    const value = resolve(operands);
    return value === MISSING
      ? "missing"
      : value === null
        ? "null"
        : value instanceof Date
          ? "date"
          : Array.isArray(value)
            ? "array"
            : typeof value === "boolean"
              ? "bool"
              : typeof value;
  }
  if (op === "$isArray") return Array.isArray(resolve(operands));
  if (op === "$cond") return resolve(operands[0]) ? resolve(operands[1]) : resolve(operands[2]);
  if (op === "$size") {
    const value = resolve(operands);
    if (!Array.isArray(value)) throw new Error("$size requires array");
    return value.length;
  }
  if (op === "$and") return operands.every((item: any) => Boolean(resolve(item)));
  if (op === "$or") return operands.some((item: any) => Boolean(resolve(item)));
  const [left, right] = operands.map(resolve);
  if (op === "$eq") return bsonEqual(left, right);
  if (op === "$gt") return left !== MISSING && right !== MISSING && left > right;
  if (op === "$lte") return left !== MISSING && right !== MISSING && left <= right;
  throw new Error(`Unsupported test expression ${op}`);
}

export function matches(row: Row, filter: Row, serverNow = new Date()): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((leg: Row) => matches(row, leg, serverNow));
    if (key === "$and") return value.every((leg: Row) => matches(row, leg, serverNow));
    if (key === "$expr") return Boolean(expression(row, value, serverNow));
    if (key.startsWith("$")) throw new Error(`Unsupported test filter ${key}`);
    const actual = getPath(row, key);
    if (
      value &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      Object.keys(value).some((op) => op.startsWith("$"))
    ) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === "$exists") return (actual !== MISSING) === expected;
        if (op === "$gt") return actual !== MISSING && actual > (expected as any);
        if (op === "$lte") return actual !== MISSING && actual <= (expected as any);
        throw new Error(`Unsupported test operator ${op}`);
      });
    }
    return (value === null && actual === MISSING) || bsonEqual(actual, value);
  });
}

export function applyUpdate(row: Row, update: Row): void {
  for (const [op, fields] of Object.entries(update)) {
    if (op !== "$set" && op !== "$unset") throw new Error(`Unsupported test update ${op}`);
    for (const [path, value] of Object.entries(fields)) {
      const parts = path.split("."),
        last = parts.pop()!;
      let target = row,
        missing = false;
      for (const key of parts) {
        if (!Object.hasOwn(target, key)) {
          if (op === "$unset") {
            missing = true;
            break;
          }
          target[key] = {};
        }
        if (
          target[key] === null ||
          typeof target[key] !== "object" ||
          Array.isArray(target[key]) ||
          target[key] instanceof Date ||
          target[key]._bsontype
        ) {
          if (op === "$unset") {
            missing = true;
            break;
          }
          throw new Error("Cannot create dotted field in non-document");
        }
        target = target[key];
      }
      if (missing) continue;
      if (op === "$set") target[last] = cloneBson(value);
      else delete target[last];
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

export function createCatalogFake(
  serverNow: () => Date = () => new Date(),
  hooks: {
    afterTimestamp?: (operation: { collection: string; filter: Row; update: Row; serverNow: Date }) => Promise<void>;
  } = {},
) {
  const tables = new Map<string, Map<string, Row>>(),
    indexes: Row[] = [];
  const rows = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const db = {
    collection(name: string) {
      const table = rows(name);
      return {
        async findOne(filter: Row) {
          const operationNow = new Date(serverNow());
          const found = [...table.values()].find((row) => matches(row, filter, operationNow));
          return found ? cloneBson(found) : null;
        },
        async insertOne(input: Row) {
          if (table.has(input._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
          table.set(input._id, cloneBson(input));
          return { acknowledged: true, insertedId: input._id };
        },
        async updateOne(filter: Row, update: Row, options: Row = {}) {
          if (options.upsert) throw new Error("Unsupported test upsert");
          const operationNow = new Date(serverNow()),
            ownedFilter = cloneBson(filter),
            ownedUpdate = cloneBson(update);
          // Models a pause AFTER server timestamp capture, unlike faultDb's delegation barrier.
          await hooks.afterTimestamp?.({
            collection: name,
            filter: ownedFilter,
            update: ownedUpdate,
            serverNow: new Date(operationNow),
          });
          const row = [...table.values()].find((item) => matches(item, ownedFilter, operationNow));
          if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
          const next = cloneBson(row);
          applyUpdate(next, ownedUpdate);
          table.set(row._id, next);
          return {
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: Number(!isDeepStrictEqual(row, next)),
          };
        },
        async createIndex(keys: Row, options: Row) {
          indexes.push({ name, keys, options });
          return "test-index";
        },
        find(filter: Row = {}, options: Row = {}) {
          let order: Row = {},
            maximum = Infinity;
          const cursor = {
            sort(value: Row) {
              order = value;
              return cursor;
            },
            limit(value: number) {
              maximum = value;
              return cursor;
            },
            async toArray() {
              const operationNow = new Date(serverNow());
              const result = [...table.values()]
                .filter((row) => matches(row, filter, operationNow))
                .sort((a, b) => {
                  for (const [key, direction] of Object.entries(order)) {
                    const x = getPath(a, key),
                      y = getPath(b, key);
                    if (x < y) return -direction;
                    if (x > y) return direction;
                  }
                  return 0;
                })
                .slice(0, maximum);
              return result.map((row) =>
                cloneBson(
                  options.projection
                    ? Object.fromEntries(
                        Object.keys(options.projection)
                          .filter((key) => options.projection[key])
                          .map((key) => [key, row[key]]),
                      )
                    : row,
                ),
              );
            },
          };
          return cursor;
        },
      };
    },
  } as unknown as Db;
  return { db, rows, indexes };
}

export function faultDb(
  db: Db,
  intercept: (collection: string, method: string, args: any[], run: () => Promise<any>) => Promise<any>,
): Db {
  return new Proxy(db, {
    get(target, key) {
      if (key === "collection") {
        return (name: string, options?: CollectionOptions) => {
          const collection = target.collection(name, options);
          return new Proxy(collection, {
            get(col, method) {
              const value = Reflect.get(col, method, col);
              if (typeof value !== "function") return value;
              if (["findOne", "insertOne", "updateOne", "createIndex"].includes(String(method))) {
                return (...args: any[]) => intercept(name, String(method), args, () => value.apply(col, args));
              }
              return value.bind(col);
            },
          });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
