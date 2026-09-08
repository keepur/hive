import { randomUUID } from "node:crypto";
import { BSON, type Db, type Filter, type UpdateFilter } from "mongodb";
import { BUILTIN_CATALOG_PROVIDERS } from "./model-catalog-types.js";
import type {
  AcquisitionObservation,
  BeginDiscoveryInput,
  BeginResult,
  CatalogDoc,
  CatalogIdentity,
  CatalogProvider,
  CatalogVersion,
  DiscoveryAttempt,
  FailResult,
  ManualReplacement,
  ModelInput,
  RecoveryResult,
  ReplacementResult,
  SafeCatalogError,
} from "./model-catalog-types.js";
import {
  CatalogError,
  checkBson,
  normalizedPayload,
  reject,
  replacement,
  safeError,
  snapshotId,
  string,
} from "./model-catalog-value.js";
import { catalogCollections, isDuplicate, JOURNALED, recoverProvider } from "./model-catalog-export.js";

const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validDate = (date: unknown): date is Date => date instanceof Date && Number.isFinite(date.getTime());
type ObservationData = { provider: string; seeded: boolean; scanBson?: Uint8Array };
const observations = new WeakMap<AcquisitionObservation, ObservationData>();

function observe(provider: string, snapshot: CatalogDoc | null): AcquisitionObservation {
  const observed = Object.freeze({}) as AcquisitionObservation;
  observations.set(observed, {
    provider,
    seeded: Array.isArray(snapshot?.models) && snapshot.models.length > 0,
    ...(snapshot && Object.hasOwn(snapshot, "scan") ? { scanBson: BSON.serialize({ value: snapshot.scan }) } : {}),
  });
  return observed;
}

function claimFilter(attempt: DiscoveryAttempt, observed: ObservationData, sampledNow: Date): Filter<CatalogDoc> {
  const scanMatches =
    observed.scanBson === undefined
      ? { $eq: [{ $type: "$scan" }, "missing"] }
      : {
          $eq: ["$scan", { $literal: BSON.deserialize(observed.scanBson, { promoteLongs: false }).value }],
        };
  return {
    _id: attempt.provider,
    $expr: {
      $and: [
        scanMatches,
        {
          $eq: [{ $gt: [{ $size: { $cond: [{ $isArray: "$models" }, "$models", []] } }, 0] }, observed.seeded],
        },
        {
          $or: [
            { $eq: [{ $type: "$scan.leaseExpiresAt" }, "missing"] },
            {
              $and: [
                { $eq: [{ $type: "$scan.leaseExpiresAt" }, "date"] },
                { $lte: ["$scan.leaseExpiresAt", { $literal: sampledNow }] },
                { $lte: ["$scan.leaseExpiresAt", "$$NOW"] },
              ],
            },
          ],
        },
        { $gt: [{ $literal: attempt.leaseExpiresAt }, "$$NOW"] },
      ],
    },
  };
}

function exactRunning(doc: CatalogDoc | null, attempt: DiscoveryAttempt, sampledNow: Date): boolean {
  const scan = doc?.scan;
  return (
    scan?.attemptId === attempt.attemptId &&
    scan.outcome === "running" &&
    validDate(scan.startedAt) &&
    scan.startedAt.getTime() === attempt.startedAt.getTime() &&
    validDate(scan.leaseExpiresAt) &&
    scan.leaseExpiresAt.getTime() === attempt.leaseExpiresAt.getTime() &&
    scan.leaseExpiresAt > sampledNow
  );
}

const revisionFilter = (doc: CatalogDoc): Filter<CatalogDoc> =>
  doc.revision === undefined ? { revision: { $exists: false } } : { revision: doc.revision };
const runningFilter = (attempt: DiscoveryAttempt, now: Date): Filter<CatalogDoc> => ({
  "scan.attemptId": attempt.attemptId,
  "scan.outcome": "running",
  "scan.leaseExpiresAt": { $gt: now },
  $expr: { $gt: ["$scan.leaseExpiresAt", "$$NOW"] },
});
const successUpdate = (now: Date): UpdateFilter<CatalogDoc> => ({
  $set: { "scan.outcome": "succeeded", "scan.finishedAt": now, "scan.lastSucceededAt": now },
  $unset: { "scan.error": "", "scan.leaseExpiresAt": "" },
});

export class ModelCatalogStore {
  readonly collections;
  private indexInit?: Promise<void>;
  // At most one local proof per built-in provider; absence never proves noncommit.
  private readonly freshAttempts = new Map<
    CatalogProvider,
    { attemptId: string; startedAtMs: number; leaseExpiresAtMs: number; ready: boolean }
  >();
  private readonly beginInvocations = new Map<CatalogProvider, symbol>();

  constructor(
    db: Db,
    private readonly options: { listPluginProviderIds?: () => string[]; now?: () => Date; uuid?: () => string } = {},
  ) {
    this.collections = catalogCollections(db);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async ensureIndexes(): Promise<void> {
    if (!this.indexInit) {
      this.indexInit = Promise.all([
        this.collections.versions.createIndex({ provider: 1, createdAt: -1 }),
        this.collections.changes.createIndex({ "delivery.state": 1, "delivery.nextAttemptAt": 1 }),
      ])
        .then(() => undefined)
        .catch((error) => {
          this.indexInit = undefined;
          throw error;
        });
    }
    return this.indexInit;
  }

  async readCatalogState(provider: string) {
    try {
      const snapshot = await this.collections.catalogs.findOne({ _id: provider });
      return {
        snapshot,
        scan: snapshot?.scan,
        recoveryPending: Boolean(snapshot?.pendingExport),
        observed: observe(provider, snapshot),
      };
    } catch {
      throw new CatalogError(safeError(provider, "storage"));
    }
  }

  async pendingChanges(now = this.now(), limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) reject("changes", "malformed");
    try {
      return await this.collections.changes
        .find({ "delivery.state": "pending", "delivery.nextAttemptAt": { $lte: now } })
        .sort({ "delivery.nextAttemptAt": 1, _id: 1 })
        .limit(limit)
        .toArray();
    } catch {
      throw new CatalogError(safeError("changes", "storage"));
    }
  }

  async recoverPendingExports(provider?: string): Promise<RecoveryResult[]> {
    if (provider !== undefined) return [await recoverProvider(this.collections, provider)];
    let providers: string[];
    try {
      providers = (
        await this.collections.catalogs.find({ pendingExport: { $exists: true } }, { projection: { _id: 1 } }).toArray()
      ).map((doc) => doc._id);
    } catch {
      return [{ provider: "*", kind: "error", error: safeError("all", "storage") }];
    }
    const results: RecoveryResult[] = [];
    for (const id of providers) results.push(await recoverProvider(this.collections, id));
    return results;
  }

  private knownFailure(provider: string, error: unknown, retriable = false): ReplacementResult {
    return {
      kind: "not-committed",
      error: error instanceof CatalogError ? error.safe : safeError(provider, "storage"),
      retriable,
    };
  }

  private async committed(version: CatalogVersion): Promise<ReplacementResult> {
    const recovered = await recoverProvider(this.collections, version.provider);
    return {
      kind: "committed",
      commitId: version._id,
      revision: version.revision,
      snapshotId: version.snapshotId,
      bootstrap: version.bootstrap,
      added: version.added,
      removed: version.removed,
      recoveryPending: recovered.kind !== "recovered",
    };
  }

  private async reconcile(
    provider: string,
    operationId: string,
    attempt?: DiscoveryAttempt,
    validatedIdentity?: CatalogIdentity,
  ): Promise<ReplacementResult> {
    for (let check = 0; check < 2; check++) {
      try {
        // Read catalog FIRST, history SECOND: a later writer must project before replacing the catalog evidence.
        const doc = await this.collections.catalogs.findOne({ _id: provider });
        if (doc?.pendingExport?.version._id === operationId) return this.committed(doc.pendingExport.version);
        const version = await this.collections.versions.findOne({ _id: operationId });
        if (version) return this.committed(version);
        if (
          attempt &&
          validatedIdentity &&
          doc?.scan?.attemptId === operationId &&
          doc.scan.outcome === "succeeded" &&
          doc.scan.lastSucceededAt
        ) {
          return { kind: "unchanged", ...validatedIdentity, lastSucceededAt: doc.scan.lastSucceededAt };
        }
      } catch {
        // A read failure cannot settle a mutation's outcome.
      }
      // One bounded recovery/recheck observes a late commit at this boundary.
      // Negative evidence and every recovery failure still leave it unknown.
      if (check === 0) await recoverProvider(this.collections, provider);
    }
    return { kind: "commit-unknown", operationId, error: safeError(provider, "storage") };
  }

  async replaceManual(input: ManualReplacement): Promise<ReplacementResult> {
    let rows: ModelInput[];
    try {
      const provider = string(input.provider, "provider", true);
      if (provider === "gemini") {
        throw new CatalogError({
          code: "malformed",
          message: "Gemini is always resolved live and cannot be refreshed.",
        });
      }
      const valid: string[] = [...BUILTIN_CATALOG_PROVIDERS, ...(this.options.listPluginProviderIds?.() ?? [])];
      if (!valid.includes(provider)) {
        throw new CatalogError({
          code: "malformed",
          message: `Unknown provider '${provider}'. Valid: ${valid.join(", ")}.`,
        });
      }
      string(input.updatedBy, provider);
      if (input.changeSummary !== undefined && typeof input.changeSummary !== "string") reject(provider, "malformed");
      rows = normalizedPayload(provider, input.models, true);
    } catch (error) {
      return this.knownFailure("manual", error);
    }
    return this.write(
      input.provider,
      rows,
      input.updatedBy,
      this.options.uuid?.() ?? randomUUID(),
      input.changeSummary,
    );
  }

  async applyDiscovery(attempt: DiscoveryAttempt, input: unknown): Promise<ReplacementResult> {
    // Invalid operation identities could never have reached this writer. Other
    // validation/refusal is definitive only while we own a never-submitted token.
    if (!BUILTIN_CATALOG_PROVIDERS.includes(attempt.provider) || !tokenPattern.test(attempt.attemptId)) {
      return this.knownFailure("discovery", new CatalogError(safeError("attempt", "malformed")));
    }
    const proof = this.freshAttempts.get(attempt.provider);
    if (!proof || proof.attemptId !== attempt.attemptId || !proof.ready) {
      return this.reconcile(attempt.provider, attempt.attemptId, attempt);
    }
    // An expired proof cannot authorize submission, even if input dates were edited.
    if (proof.leaseExpiresAtMs <= this.now().getTime()) return { kind: "superseded" };
    // Consume before any await: parallel calls with this UUID can only reconcile.
    proof.ready = false;
    let rows: ModelInput[];
    try {
      this.validateAttempt(attempt);
      if (
        attempt.startedAt.getTime() !== proof.startedAtMs ||
        attempt.leaseExpiresAt.getTime() !== proof.leaseExpiresAtMs
      ) {
        reject("attempt", "malformed");
      }
      // Own the dates across awaits; caller mutation cannot extend this attempt.
      attempt = {
        ...attempt,
        startedAt: new Date(proof.startedAtMs),
        leaseExpiresAt: new Date(proof.leaseExpiresAtMs),
      };
      rows = normalizedPayload(attempt.provider, input);
    } catch (error) {
      if (this.freshAttempts.get(attempt.provider) === proof) proof.ready = true;
      return this.knownFailure("discovery", error);
    }
    const result = await this.write(
      attempt.provider,
      rows,
      "system:model-catalog-scanner",
      attempt.attemptId,
      undefined,
      attempt,
    );
    // The write loop returns not-committed only if every mutation was refused
    // before submission or acknowledged as unmatched. Unknown never restores it.
    if (result.kind === "not-committed" && this.freshAttempts.get(attempt.provider) === proof) proof.ready = true;
    return result;
  }

  private validateAttempt(attempt: DiscoveryAttempt): void {
    if (
      !BUILTIN_CATALOG_PROVIDERS.includes(attempt.provider) ||
      !tokenPattern.test(attempt.attemptId) ||
      !validDate(attempt.startedAt) ||
      !validDate(attempt.leaseExpiresAt) ||
      attempt.leaseExpiresAt <= attempt.startedAt
    ) {
      reject("attempt", "malformed");
    }
  }

  private async write(
    provider: string,
    rows: ModelInput[],
    actor: string,
    operationId: string,
    summary?: string,
    attempt?: DiscoveryAttempt,
  ): Promise<ReplacementResult> {
    // Discovery enters only with the consumed local proof: no older invocation
    // with this UUID may be outstanding. Unproven/restarted calls never enter.
    for (let tries = 0; tries < 8; tries++) {
      let current: CatalogDoc | null;
      try {
        // Existing-operation evidence precedes any fallible recovery/index writes.
        current = await this.collections.catalogs.findOne({ _id: provider });
        if (attempt) {
          if (current?.pendingExport?.version._id === operationId) return this.committed(current.pendingExport.version);
          const prior = await this.collections.versions.findOne({ _id: operationId });
          if (prior) return this.committed(prior);
          if (current?.scan?.attemptId === operationId && current.scan.outcome === "succeeded") {
            return this.reconcile(provider, operationId, attempt);
          }
        }
        await this.ensureIndexes();
        const recovered = await recoverProvider(this.collections, provider);
        if (recovered.kind !== "recovered") {
          // Only the local never-submitted proof licenses refusal here;
          // unresolved/restarted UUIDs are handled entirely by reconcile().
          if (attempt) {
            const result = await this.reconcile(provider, operationId, attempt);
            if (result.kind === "committed") return result;
          }
          return this.knownFailure(provider, new CatalogError(recovered.error), true);
        }
        current = await this.collections.catalogs.findOne({ _id: provider });
        if (attempt) {
          const prior = await this.collections.versions.findOne({ _id: operationId });
          if (prior) return this.committed(prior);
          if (current?.scan?.attemptId === operationId && current.scan.outcome === "succeeded") {
            return this.reconcile(provider, operationId, attempt);
          }
        }
      } catch (error) {
        return this.knownFailure(provider, error, true);
      }
      const now = this.now();
      if (
        attempt &&
        (!current ||
          current.scan?.attemptId !== attempt.attemptId ||
          current.scan.outcome !== "running" ||
          !current.scan.leaseExpiresAt ||
          current.scan.leaseExpiresAt <= now)
      ) {
        return { kind: "superseded" };
      }
      let next: ReturnType<typeof replacement>;
      try {
        next = replacement(current, provider, rows, attempt ? "discovery" : "manual", actor, operationId, now, summary);
      } catch (error) {
        return this.knownFailure(provider, error);
      }
      const filter: Filter<CatalogDoc> = {
        _id: provider,
        ...(current ? revisionFilter(current) : {}),
        pendingExport: { $exists: false },
        ...(attempt ? runningFilter(attempt, now) : {}),
      };

      const success = attempt ? successUpdate(now) : {};
      if (attempt && next.unchanged && current) {
        try {
          const changed = await this.collections.catalogs.updateOne(filter, success, JOURNALED);
          if (!changed.matchedCount) continue;
          return {
            kind: "unchanged",
            commitId: current.commitId,
            revision: current.revision ?? 0,
            snapshotId: current.snapshotId ?? snapshotId(provider, current.models ?? []),
            lastSucceededAt: now,
          };
        } catch (error) {
          // With the local proof, this guard refusal excludes every submission.
          if (error && typeof error === "object" && "code" in error && error.code === "DB_IDENTITY_MISMATCH") {
            return this.knownFailure(provider, error, true);
          }
          return this.reconcile(provider, operationId, attempt, {
            commitId: current.commitId,
            revision: current.revision ?? 0,
            snapshotId: current.snapshotId ?? snapshotId(provider, current.models ?? []),
          });
        }
      }
      try {
        const prospective: CatalogDoc = { ...(current ?? { _id: provider }), ...next.fields };
        if (attempt && current?.scan) {
          prospective.scan = { ...current.scan, outcome: "succeeded", finishedAt: now, lastSucceededAt: now };
        }
        if (prospective.scan && attempt) {
          delete prospective.scan.error;
          delete prospective.scan.leaseExpiresAt;
        }
        checkBson(prospective);
      } catch (error) {
        return this.knownFailure(provider, error);
      }
      try {
        if (!current) {
          await this.collections.catalogs.insertOne({ _id: provider, ...next.fields }, JOURNALED);
        } else {
          const changed = await this.collections.catalogs.updateOne(
            filter,
            {
              $set: { ...next.fields, ...success.$set },
              ...(success.$unset ? { $unset: success.$unset } : {}),
            },
            JOURNALED,
          );
          if (!changed.matchedCount) continue;
        }
      } catch (error) {
        if (!current && isDuplicate(error)) continue;
        // The local proof makes this guard refusal definitive; reentry cannot reach it.
        if (error && typeof error === "object" && "code" in error && error.code === "DB_IDENTITY_MISMATCH") {
          return this.knownFailure(provider, error, true);
        }
        return this.reconcile(provider, operationId, attempt);
      }
      return this.committed(next.version);
    }
    // All CAS attempts were acknowledged misses; no older same-UUID write exists here.
    return this.knownFailure(provider, new CatalogError(safeError(provider, "storage")), true);
  }

  async beginDiscoveryAttempt(provider: CatalogProvider, input: BeginDiscoveryInput): Promise<BeginResult> {
    // The observation stays separate from the persisted/returned attempt token.
    const attempt: DiscoveryAttempt = {
      provider,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      leaseExpiresAt: input.leaseExpiresAt,
    };
    this.validateAttempt(attempt);
    attempt.startedAt = new Date(attempt.startedAt);
    attempt.leaseExpiresAt = new Date(attempt.leaseExpiresAt);
    const observed = observations.get(input.observed);
    if (!observed || observed.provider !== provider || attempt.leaseExpiresAt <= this.now())
      reject(provider, "malformed");
    const invocation = Symbol(provider),
      previousProof = this.freshAttempts.get(provider);
    this.beginInvocations.set(provider, invocation);
    const acknowledgedStart = (): BeginResult => {
      // A match means acceptance even if this response is now expired/obsolete.
      // Only a current acknowledgment with remaining lease grants local proof.
      if (
        attempt.leaseExpiresAt > this.now() &&
        this.beginInvocations.get(provider) === invocation &&
        this.freshAttempts.get(provider) === previousProof
      ) {
        this.freshAttempts.set(provider, {
          attemptId: attempt.attemptId,
          startedAtMs: attempt.startedAt.getTime(),
          leaseExpiresAtMs: attempt.leaseExpiresAt.getTime(),
          ready: true,
        });
      }
      return { kind: "started", attempt };
    };
    const uncertainStart = async (): Promise<BeginResult> => {
      // One bounded evidence reread, never a retry or a new proof.
      try {
        const after = await this.collections.catalogs.findOne({ _id: provider });
        if (exactRunning(after, attempt, this.now())) return { kind: "started", attempt };
      } catch {
        // Negative/unavailable evidence cannot prove non-acquisition.
      }
      throw new CatalogError(safeError(provider, "storage"));
    };
    try {
      await this.ensureIndexes();
      // This read detects a missing shell/existing token only. It NEVER refreshes observed.
      const current = await this.collections.catalogs.findOne({ _id: provider });
      if (current?.scan?.attemptId === attempt.attemptId) {
        return exactRunning(current, attempt, this.now()) ? { kind: "started", attempt } : { kind: "busy" };
      }
      if (!current) {
        try {
          await this.collections.catalogs.insertOne({ _id: provider, provider }, JOURNALED);
        } catch (error) {
          if (!isDuplicate(error)) return await uncertainStart();
        }
      }
      // Local time is sampled after index/shell work; $$NOW is the server operation timestamp.
      const filter = claimFilter(attempt, observed, this.now());
      try {
        const acquired = await this.collections.catalogs.updateOne(
          filter,
          {
            $set: {
              "scan.attemptId": attempt.attemptId,
              "scan.startedAt": attempt.startedAt,
              "scan.leaseExpiresAt": attempt.leaseExpiresAt,
              "scan.outcome": "running",
            },
            $unset: { "scan.finishedAt": "", "scan.error": "" },
          },
          { ...JOURNALED, upsert: false },
        );
        return acquired.matchedCount ? acknowledgedStart() : { kind: "busy" };
      } catch {
        return await uncertainStart();
      }
    } catch {
      throw new CatalogError(safeError(provider, "storage"));
    } finally {
      // An older response cannot remove a successor invocation marker or proof.
      if (this.beginInvocations.get(provider) === invocation) this.beginInvocations.delete(provider);
    }
  }

  async failDiscoveryAttempt(
    attempt: DiscoveryAttempt,
    error: SafeCatalogError,
    finishedAt: Date,
  ): Promise<FailResult> {
    this.validateAttempt(attempt);
    if (!validDate(finishedAt)) reject(attempt.provider, "malformed");
    const allowed = [
      "auth",
      "client-version",
      "http",
      "timeout",
      "canceled",
      "malformed",
      "empty",
      "too-large",
      "storage",
    ];
    if (!allowed.includes(error.code)) reject(attempt.provider, "malformed");
    const status =
      Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599
        ? error.httpStatus
        : undefined;
    const safe = safeError(attempt.provider, error.code, status);
    try {
      const result = await this.collections.catalogs.updateOne(
        { _id: attempt.provider, ...runningFilter(attempt, this.now()) },
        {
          $set: { "scan.outcome": "failed", "scan.finishedAt": finishedAt, "scan.error": safe },
          $unset: { "scan.leaseExpiresAt": "" },
        },
        JOURNALED,
      );
      return { kind: result.matchedCount ? "recorded" : "superseded" };
    } catch {
      try {
        const doc = await this.collections.catalogs.findOne({ _id: attempt.provider });
        if (doc?.scan?.attemptId === attempt.attemptId && doc.scan.outcome === "failed") {
          return { kind: "recorded" };
        }
      } catch {
        // Preserve uncertainty as a storage exception.
      }
      throw new CatalogError(safeError(attempt.provider, "storage"));
    }
  }
}
