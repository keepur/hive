import type { Db, Collection } from "mongodb";

/**
 * KPR-294: thrown by the write-refusal proxy (`guardDb`) for every gated
 * write method while a `WriteGuard` is engaged (DB identity mismatch or
 * unverifiable). Always surfaced as a REJECTED PROMISE, never a sync throw
 * — see `guardDb` for the rationale.
 */
export class DbIdentityMismatchError extends Error {
  readonly code = "DB_IDENTITY_MISMATCH";

  constructor(guard: WriteGuard) {
    const expected = `${guard.expected.instanceId}/${guard.expected.dbName}`;
    const observed = guard.observed
      ? `${guard.observed.instanceId ?? "<absent>"}/${guard.observed.dbName ?? "<absent>"}`
      : "<absent>";
    super(
      `DB identity mismatch — write refused. Expected instance/db "${expected}", observed "${observed}". ` +
        `Reason: ${guard.reason ?? "unknown"}. Run \`hive doctor\` for identity diagnostics.`,
    );
    this.name = "DbIdentityMismatchError";
  }
}

/**
 * Holds the live engaged/disengaged state that `guardDb`'s proxies consult
 * at call time. Owned/mutated by `DbIdentityMonitor` (KPR-294 Task 3) — this
 * module only defines the shape and the pure engage/disengage transitions.
 */
export class WriteGuard {
  engaged = false;
  reason: string | null = null;
  refusedWriteCount = 0;
  readonly expected: { instanceId: string; dbName: string };
  observed: { instanceId: string | null; dbName: string | null } | null = null;

  constructor(expected: { instanceId: string; dbName: string }) {
    this.expected = expected;
  }

  engage(reason: string, observed?: { instanceId: string | null; dbName: string | null }): void {
    this.engaged = true;
    this.reason = reason;
    this.observed = observed ?? null;
  }

  disengage(): void {
    this.engaged = false;
    this.reason = null;
    this.observed = null;
  }
}

/** Exact spec list — no additions, no omissions. */
export const GATED_COLLECTION_METHODS: ReadonlySet<string> = new Set([
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "bulkWrite",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "createIndex",
  "createIndexes",
  "dropIndex",
  "dropIndexes",
  "drop",
  "rename",
]);

export const GATED_DB_METHODS: ReadonlySet<string> = new Set(["dropDatabase", "createCollection", "renameCollection"]);

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wraps a raw `Collection` so every method in `GATED_COLLECTION_METHODS`
 * checks `guard.engaged` at CALL TIME (never at wrap time — a handle
 * acquired before `engage()` must still be gated afterward) and rejects
 * with `DbIdentityMismatchError` while engaged. All other function
 * properties (`find`, `findOne`, `aggregate`, `watch`, `countDocuments`, …)
 * forward bound to the raw target — unbound would run driver internals
 * with `this` = Proxy, which breaks the driver's ES `#private` fields.
 * Non-function properties forward via `Reflect.get`.
 *
 * Bound/wrapper functions are cached per proxy so repeated property access
 * returns an identical function reference (stable identity for `===`
 * checks and test spies); the gate check itself stays inside the wrapper
 * body so caching never freezes the guard's engaged/disengaged verdict.
 */
function wrapCollection<T extends object = object>(rawCollection: Collection<T>, guard: WriteGuard): Collection<T> {
  const cache = new Map<string | symbol, unknown>();

  const handler: ProxyHandler<Collection<T>> = {
    get(target, prop) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      // `Reflect.get` on the raw target (not `receiver`) so any internal
      // getter logic sees the real collection, not the proxy.
      const value: unknown = Reflect.get(target, prop, target);

      if (typeof value !== "function") {
        return value;
      }

      const fn = value as AnyFn;

      if (typeof prop === "string" && GATED_COLLECTION_METHODS.has(prop)) {
        const wrapper = (...args: unknown[]): unknown => {
          if (guard.engaged) {
            guard.refusedWriteCount++;
            return Promise.reject(new DbIdentityMismatchError(guard));
          }
          return fn.apply(target, args);
        };
        cache.set(prop, wrapper);
        return wrapper;
      }

      // Non-gated methods (find, findOne, aggregate, watch, ...) forward
      // bound to the raw target.
      const bound = fn.bind(target);
      cache.set(prop, bound);
      return bound;
    },
  };

  // The proxy is structurally a Collection<T>; the driver never inspects
  // an object's exact identity for its own methods, only for `#private`
  // fields accessed via `this` inside those methods — which is exactly
  // why gated/non-gated wrappers above always invoke against `target`.
  return new Proxy(rawCollection, handler);
}

/**
 * Wraps a raw `Db` so `collection()` returns a write-guarded `Collection`
 * proxy (see `wrapCollection`), and the three gated Db-level methods
 * (`dropDatabase`, `createCollection`, `renameCollection`) are refused the
 * same way while engaged. Everything else forwards bound to the raw `Db`.
 *
 * Returns a `Proxy<Db>`, which IS typed `Db` — no cast needed at the
 * return; the public surface stays fully `Db`/`Collection` typed.
 */
export function guardDb(rawDb: Db, guard: WriteGuard): Db {
  const cache = new Map<string | symbol, unknown>();

  const handler: ProxyHandler<Db> = {
    get(target, prop) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      if (prop === "collection") {
        const wrapper = (...args: unknown[]): unknown => {
          const rawCollection = (target.collection as unknown as (...a: unknown[]) => Collection).apply(target, args);
          return wrapCollection(rawCollection, guard);
        };
        cache.set(prop, wrapper);
        return wrapper;
      }

      const value: unknown = Reflect.get(target, prop, target);

      if (typeof value !== "function") {
        return value;
      }

      const fn = value as AnyFn;

      if (typeof prop === "string" && GATED_DB_METHODS.has(prop)) {
        const wrapper = (...args: unknown[]): unknown => {
          if (guard.engaged) {
            guard.refusedWriteCount++;
            return Promise.reject(new DbIdentityMismatchError(guard));
          }
          return fn.apply(target, args);
        };
        cache.set(prop, wrapper);
        return wrapper;
      }

      const bound = fn.bind(target);
      cache.set(prop, bound);
      return bound;
    },
  };

  return new Proxy(rawDb, handler);
}
