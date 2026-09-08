# KPR-460 — Model catalog scanner lifecycle and truthful freshness Implementation Plan

## TL;DR

Add an engine-owned scanner that checks Claude, Codex, and Grok catalogs every eight hours, safely resumes interrupted work, and exposes truthful discovery status. Implement six tasks after KPR-459 lands, then verify scheduling and recovery with both the stateful fake and an owned standalone Mongo instance.

## Key Points

- Carry the exact due-read observation into acquisition and retain the acquiring store through initial application.
- Use independent bounded provider lanes and a separate export-recovery lane; preserve uncertainty across late responses and shutdown.
- Share persisted-state interpretation between scheduling, the catalog tool, and doctor while keeping saved-list timestamps distinct from successful discovery.
- Preserve Gemini live resolution, plugin manual catalogs, existing output compatibility, and engine lifecycle ownership.
- Require unit and real-Mongo integration coverage; KPR-461 owns notification and application/delivery E2E work.
- ⚠ Fixed timing defaults and the reviewed KPR-459 interfaces are delegated assumptions; delivery remains gated on dependency integration and waterfall readiness.

> **For agentic workers:** Use dodi-dev:implement to execute this plan after the epic's waterfall maturity gate permits delivery.

**Goal:** Check the three stored built-in catalogs every eight hours, recover interrupted work safely, and report saved content, successful discovery, and latest-attempt status truthfully.

**Architecture:** One engine-owned scanner uses one long-lived KPR-459 store over the existing guarded database. Independent provider lanes carry the exact due-read observation into acquisition and retain that store through initial application; a separate maintenance lane recovers exports. A dependency-light status module supplies the same persisted-state interpretation to scheduling, the existing catalog tool, and doctor.

**Tech Stack:** TypeScript ESM, Node 24, MongoDB driver 7.6, Vitest 4.1, existing logger, KPR-459 discovery/store/fault harness, owned standalone WiredTiger test process.

## Authority, dependencies, and boundaries

- Binding specification: `docs/epics/kpr-450/kpr-460-spec.md` at `75a0b01ba87d0c01e092fc57f6514fdebf2e85bb`, final spec review rounds `2/0,0/0`.
- KPR-450 Gate 1 delegates these choices; the operator authorized `drive-epic` in place of absent `/spec-and-implement`. No merged-child Decision Register canon exists. The full Gate 1 snapshot was read from `/Users/mokie/github/hive-KPR-450/.dodi/drive2-context.json`.
- KPR-459 is mature, **not implemented in this planning checkout**. Consume its current `docs/epics/kpr-450/kpr-459-spec.md` and `docs/epics/kpr-450/kpr-459-plan.md`, including the same-read acquisition amendment, operation-constant `$$NOW`, and bounded store-local proof. Delivery starts only after that child lands and the parent waterfall gate permits it. If its delivered API differs, reconcile the documents before implementation; do not fabricate missing modules or weaken its fences.
- KPR-461 owns recipients, notifications, dispatch outcomes, retries, and delivery state. This plan consumes export recovery only. No callbacks, agent assignments, Gemini discovery/storage, plugin discovery, capability changes, new config, cron, telemetry collection, deployment, or live engine boot.
- Reviewed source anchors refer to the current planning head; re-locate by named symbols after KPR-459 merges. Planned dependency files are expressly identified below.

## Testing Contract

### Required Test Groups

- Unit: **required**.
  - Scope: pure status/eligibility; real scanner with KPR-459's stateful fake and real store; tool/doctor adapters and engine source wiring.
  - Reason: timing, cancellation, uncertainty, and future/malformed dates have many observable failure paths that timer-spy tests cannot establish.
  - Minimum assertions: the schedule matrices in Tasks 1–3 and 5–6; provider call counts plus complete catalog/scan/history/change state; bounded lane counts; no unhandled rejection; sanitized output.
- Integration: **required**.
  - Scope: real scanner + real KPR-459 store + guarded, owned standalone Mongo + injected discovery. Both scanner objects share the database but own separate long-lived stores.
  - Reason: actual observation and lease predicates, server timestamps, journaled writes, delayed acknowledgments, and recovery must agree with the fake.
  - Harness: **setup-required in this checkout**; reuse `src/admin/testing/standalone-mongo.ts` and `catalog-db.test-support.ts` delivered by KPR-459. Complete any missing harness requirements rather than skipping.
  - Minimum assertions: Task 4's full cross-product of stale due states and predecessor outcomes; actual matched counts; expired proposals, held matched acknowledgments, manual races, uncertain completion, late acquisition/completion after restart/shutdown, and export recovery while no discovery is due.
- E2E: **not-required**.
  - Scope: live provider authentication/generation, application-to-provider behavior, CoS and Slack delivery.
  - Reason: KPR-461 owns application/delivery E2E; this child proves engine wiring locally and exercises real persistence without starting a configured engine.
  - Harness: **not-applicable**.
  - Minimum assertions: none here; no live credentials, instance databases, Slack messages, or launchd actions.

### Critical Flows

- Startup read → due decision → exact observation claim → current/unexpired acknowledgment → same-store initial apply → committed or unchanged successful scan.
- Seeded restart/recent failure/manual edit → preserve eight-hour cadence from persisted attempt start; exact boundary → one attempt, no missed-interval burst.
- Two due readers → predecessor completes → delayed stale claim misses → later tick reevaluates cadence; consumed unseeded startup opportunity stays consumed.
- Unknown begin/apply/failure → identity retention and bounded reconciliation → positive evidence or safe fresh-observation takeover; never replay rows or fabricate failure.
- Stop → synchronous latch/abort → bounded drain of already-started work → persisted recovery on a new scanner, with successors fencing late old work.
- Manual-after-success and failed-after-success → saved timestamp, successful-check age, latest error, and pending export remain separate in both diagnostics.

### Regression Surface

- KPR-459 store proofs, observation and BSON-presence matching, uniqueness, guard behavior, export envelopes, and manual note rebasing.
- Existing catalog JSON entry order/shape, `source: "curated"`, `asOf` as saved-list time, plugin manual support, unknown-provider wording, Gemini live/cache/errors.
- Existing heartbeat order, provider-plugin activation, stopAll/reload ownership, shared Mongo client, and doctor identity-only exit-code policy.

### Commands

Run in the implementation worktree after KPR-459 lands, never the deployment clone.

- Unit: `npx vitest run src/admin/model-catalog-status.test.ts src/admin/model-catalog-scanner.test.ts src/admin/admin-mcp-server.test.ts src/cli/doctor-model-catalog.test.ts src/cli/doctor.test.ts src/boot-order.test.ts`
- Integration: `npx vitest run src/admin/model-catalog-scanner.integration.test.ts src/admin/model-catalog-store.integration.test.ts`
- E2E: not applicable for this child.
- Adjacent regression: `npx vitest run src/admin/model-catalog-store.test.ts src/admin/model-catalog-discovery.test.ts src/admin/model-catalog-cache.test.ts src/cli/doctor-checks.test.ts src/db/write-guard.test.ts src/agents/spawn-coordinator-heartbeat.test.ts src/agents/circuit-breaker-heartbeat.test.ts src/memory/memory-lifecycle-heartbeat.test.ts`
- Broader regression: `npm run check`
- Build: `npm run build`

### Harness Requirements

- Install locked dependencies with `npm ci` in the delivery worktree. Do not edit another checkout's installed packages. Use generated UUIDs, fixed injectable local clocks, Vitest fake timers for lifecycle/drain, and explicitly controlled fake server clocks.
- Reuse the KPR-459 fake without weakening predicates. Preserve BSON values/field presence. Its `afterTimestamp` hook freezes one operation timestamp before a server-pause barrier; `faultDb` before `run()` delays delegation, and after `run()` delays acknowledgment. They test different facts.
- Real integration owns its mongod PID, loopback port, temporary directory, random database, and client. Use `MONGOD_BINARY` or PATH `mongod`, never an application URI, `.env`, existing server, or production config. Missing executable is a concrete blocker. Assert standalone WiredTiger and the owned database prefix before reset; close client/kill only owned process/remove only owned directory in `finally`/suite hooks.
- Use real timers in the Mongo suite and injected scanner clocks/timer drivers. Take dates relative to `hello.localTime` for server-sensitive schedules. For held-ack tests, move only the injected client clock past the original lease after a real matched operation; this tests client handling, not advancement of Mongo's operation timestamp.
- Every started promise must be observed. Barrier tests release and await their underlying operations in `finally`, including errors after shutdown. Give integration hooks/tests 30-second limits, without changing global test timeouts or skipping tests.
- Mock all discovery at scanner boundaries. Do not invoke the default discovery factory in unit/integration tests. The scanner file imports only its function type, never SDK/config modules.

### Non-Required Rationale

- E2E: real provider/delivery flows require sibling KPR-461 and are outside this child. Source-level engine wiring plus real scanner/store integration cover this child's lifecycle without live boot side effects.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Verification below is future delivery work. Document syntax checks and in-memory execution of embedded plan code are scratch plan checks, not product tests or approval.
- Run the stated checks before commits/completion claims. Keep the final epic PR open for Gate 2; no deployment is authorized by this document.

## File Map and Execution Order

| File | Responsibility |
| --- | --- |
| Create `src/admin/model-catalog-status.ts` | Pure defensive dates, due policy, and common prose; imports only dependency-light catalog types/constants. |
| Create `src/admin/model-catalog-scanner.ts` | Provider/recovery lane ownership, acquisition/application/uncertainty, timers and bounded shutdown. |
| Create `src/admin/model-catalog-status.test.ts` | Date/status and due-policy matrix. |
| Create `src/admin/model-catalog-scanner.test.ts` | Real scanner/store on stateful fake, timer and frozen-server-timestamp schedules. |
| Create `src/admin/model-catalog-scanner.integration.test.ts` | Same scanner/store on owned real Mongo; real delegated mutation/ack barriers. |
| Modify `src/index.ts:25–26,620,935–969` | Construct one scanner on guarded `db`, nonblocking start, immediate shutdown stop. |
| Modify `src/boot-order.test.ts` | Source assertions for store ownership and lifecycle order without booting index. |
| Modify `src/admin/admin-mcp-server.ts:1121–1235`, `.test.ts` | Common built-in status notes, per-provider read isolation, compatible entries/Gemini/plugin behavior. |
| Modify `src/cli/doctor-checks.ts` | Read-only short-lived-client catalog adapter; explicit unavailable result. |
| Modify `src/cli/doctor.ts`, `.test.ts` | Informational Model catalogs section using common notes. |
| Create `src/cli/doctor-model-catalog.test.ts` | Isolated Mongo module mock and read-only adapter tests, avoiding other doctor's mock setup. |
| Modify `CLAUDE.md:256`, `docs/providers.md` | Automatic cadence, manual override, separate timestamps, recovery and shutdown semantics. |
| Existing after KPR-459: `src/admin/model-catalog-{types,value,store,discovery}.ts`, `testing/catalog-db.test-support.ts`, `testing/standalone-mongo.ts` | Consume their reviewed contracts; do not redesign them in this child. |

Tasks 1 → 2 → 3 establish lifecycle. Task 4 verifies it against Mongo. Task 5 can run after Task 1 independently of Tasks 2–4; Task 6 integrates after 2/5 and completes checks. Code blocks are complete new production modules or exact insertion/replacement blocks; merge imports and format touched TypeScript only. Test matrices are required table-driven cases, not optional suggestions.

## Task 1 — Pure status and eligibility

**Files:** Create `src/admin/model-catalog-status.ts`, `src/admin/model-catalog-status.test.ts`.

- [ ] **Step 1:** Create the following module. Accept `unknown` at the read boundary because old/malformed BSON must not become false freshness. Future lease dates remain real active fences, unlike future success/start dates. Do not import the scanner, store, value/BSON module, discovery, config, or SDK here.

```ts
// src/admin/model-catalog-status.ts
import { BUILTIN_CATALOG_PROVIDERS } from "./model-catalog-types.js";

export const SCAN_INTERVAL_MS = 8 * 60 * 60 * 1000;
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
export const dateMs = (value: unknown): number | undefined =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : undefined;
const pastMs = (value: unknown, now: number): number | undefined => {
  const ms = dateMs(value); return ms !== undefined && ms <= now ? ms : undefined;
};
const codes = new Set(["auth", "client-version", "http", "timeout", "canceled", "malformed", "empty", "too-large", "storage"]);
export function catalogTiming(snapshot: unknown, now: number) {
  const doc = record(snapshot), scan = record(doc.scan);
  const seeded = Array.isArray(doc.models) && doc.models.length > 0;
  const started = pastMs(scan.startedAt, now), succeeded = pastMs(scan.lastSucceededAt, now);
  const finished = pastMs(scan.finishedAt, now), lease = dateMs(scan.leaseExpiresAt);
  const completed = scan.outcome === "succeeded" || scan.outcome === "failed";
  const inconsistent = doc.scan !== undefined && (
    started === undefined ||
    (completed && finished === undefined) ||
    (scan.lastSucceededAt !== undefined && succeeded === undefined) ||
    (scan.outcome === "succeeded" && succeeded === undefined) ||
    (finished !== undefined && started !== undefined && finished < started)
  );
  return { doc, scan, seeded, started, succeeded, finished, lease, completed, inconsistent };
}
export function catalogDue(snapshot: unknown, now: number, startupAvailable: boolean, intervalMs = SCAN_INTERVAL_MS) {
  const t = catalogTiming(snapshot, now);
  // A future lease is never bypassed, even if another date is malformed.
  if (t.lease !== undefined && t.lease > now) return { due: false, recover: false, consumeStartup: false };
  const recover = t.scan.outcome === "running";
  const due = recover || t.doc.scan === undefined || (!t.seeded && startupAvailable) ||
    !t.completed || t.inconsistent || t.started === undefined || now >= t.started + intervalMs;
  return { due, recover, consumeStartup: due && !t.seeded };
}
export function catalogStatus(provider: string, snapshot: unknown, now = Date.now()) {
  const t = catalogTiming(snapshot, now);
  const automatic = (BUILTIN_CATALOG_PROVIDERS as readonly string[]).includes(provider);
  const saved = pastMs(t.doc.updatedAt, now);
  const source = t.doc.source === "manual" || t.doc.source === "discovery" ? t.doc.source : "legacy/unknown";
  const ageMs = t.succeeded === undefined ? undefined : now - t.succeeded;
  const freshness = t.scan.lastSucceededAt === undefined ? "never" : ageMs === undefined
    ? "unknown/clock-inconsistent" : ageMs < SCAN_INTERVAL_MS ? "recent" : "overdue";
  const latest = t.scan.outcome === "running"
    ? t.lease === undefined ? "unfinished; lease unknown" : t.lease <= now ? "expired/unresolved" : "running"
    : t.completed ? String(t.scan.outcome) : t.doc.scan === undefined ? "never" : "unknown";
  const error = record(t.scan.error);
  const errorCode = typeof error.code === "string" && codes.has(error.code) ? error.code : "storage";
  const httpStatus = typeof error.httpStatus === "number" && Number.isInteger(error.httpStatus) &&
    error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : undefined;
  return { provider, automatic, seeded: t.seeded, modelCount: Array.isArray(t.doc.models) ? t.doc.models.length : 0,
    source, savedAt: saved, succeededAt: t.succeeded, ageMs, freshness, latest,
    startedAt: t.started, finishedAt: t.finished, leaseExpiresAt: t.lease,
    nextAttemptAt: t.started === undefined ? undefined : t.started + SCAN_INTERVAL_MS,
    timingInconsistent: t.inconsistent, errorCode, httpStatus,
    recoveryPending: Object.hasOwn(t.doc, "pendingExport") };
}
export type CatalogStatus = ReturnType<typeof catalogStatus>;
const when = (ms: number | undefined): string => ms === undefined ? "unknown/clock-inconsistent" : new Date(ms).toISOString();
export function catalogStatusNote(s: CatalogStatus): string {
  const parts = [s.seeded ? `saved ${when(s.savedAt)} (${s.source}), ${s.modelCount} models`
    : "not yet seeded — manual option: agent_model_catalog_refresh"];
  if (s.automatic) {
    parts.push(s.freshness === "never" ? "last discovery success never" :
      `last discovery success ${when(s.succeededAt)} (${s.freshness}${s.ageMs === undefined ? "" : `; age ${Math.floor(s.ageMs / 1000)}s`})`);
    parts.push(`latest attempt ${s.latest}${s.startedAt === undefined ? "" : `, started ${when(s.startedAt)}`}`);
    if (s.latest === "failed") parts.push(`failed at ${when(s.finishedAt)} (${s.errorCode}${s.httpStatus === undefined ? "" : ` HTTP ${s.httpStatus}`})`);
    if (["running", "expired/unresolved", "unfinished; lease unknown"].includes(s.latest)) parts.push(`lease ${when(s.leaseExpiresAt)}`);
    parts.push(`next normal attempt ${when(s.nextAttemptAt)}`);
    if (s.timingInconsistent) parts.push("scan timing unavailable/clock-inconsistent");
    parts.push("automatic checks every 8h; discovery timestamps describe checks, not later manual edits");
  } else parts.push("manually maintained");
  if (s.recoveryPending) parts.push("audit/change recovery pending");
  return `${s.provider}: ${parts.join("; ")}.`;
}
export const catalogUnavailableNote = (provider: string): string => `${provider}: catalog storage unavailable.`;
```

- [ ] **Step 2:** Add table-driven status and due tests. Use a `new Date("2026-09-07T12:00:00Z")` clock, explicit BSON `Date` fixtures and separately corrupted values. Required cases: absent doc; shell; empty models; seeded legacy/manual with no scan; running active/expired/missing/invalid lease; recent/overdue success; recent failure with old/recent prior success; manual write after success; pending export independent of all states; exact eight-hour boundary; `startedAt`, `finishedAt`, `lastSucceededAt`, `updatedAt` absent/invalid/future; string dates; null scan; finished-before-start. Success age never negative; equality is overdue/due. A future/invalid successful timestamp cannot be recent, and malformed timing cannot postpone a due attempt indefinitely. Active future lease still wins and malformed lease is left for the store to refuse. Plugins show manual notes without invented discovery timing; Gemini is never passed to stored-status consumers. Embed `test-secret` in raw error message/body/unknown code and assert no appearance in note output. Compare snapshot before/after derivation to prove purity.
- [ ] **Step 3:** Run `npx vitest run src/admin/model-catalog-status.test.ts` and `npm run typecheck`. Expected: every table row passes, no TypeScript diagnostics. Stage only the two task files and commit `feat: derive truthful catalog freshness and due state`.

## Task 2 — Scanner ownership, uncertain attempts, and shutdown

**Files:** Create `src/admin/model-catalog-scanner.ts`, `src/admin/model-catalog-scanner.test.ts`.

- [ ] **Step 1:** Create the scanner below. `tick()` may be called directly for tests; `start()` enables periodic ticks. Only `stop()` makes the object terminal. A lane's invocation is reserved synchronously before any asynchronous read, and its promise remains tracked until the underlying operation settles. No timeout race releases a provider lane. There are at most three pending identities and one export sweep.

```ts
// src/admin/model-catalog-scanner.ts
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import { BUILTIN_CATALOG_PROVIDERS, type CatalogProvider, type DiscoveryAttempt,
  type DiscoveredModel, type SafeCatalogError } from "./model-catalog-types.js";
import { CatalogError, safeError } from "./model-catalog-value.js";
import type { ModelCatalogStore } from "./model-catalog-store.js";
import { catalogDue, catalogTiming } from "./model-catalog-status.js";

export const MAINTENANCE_INTERVAL_MS = 60_000;
export const ATTEMPT_LEASE_MS = 120_000;
export const SHUTDOWN_DRAIN_MS = 5_000;
type Store = Pick<ModelCatalogStore, "readCatalogState" | "beginDiscoveryAttempt" |
  "applyDiscovery" | "failDiscoveryAttempt" | "recoverPendingExports">;
type Discover = (provider: CatalogProvider, options: { signal: AbortSignal }) => Promise<DiscoveredModel[]>;
type Pending = { attempt: DiscoveryAttempt; phase: "begin" | "apply" | "failure" };
type Lane = { startup: boolean; invocation?: symbol; controller?: AbortController;
  task?: Promise<void>; pending?: Pending; watchdog?: Timer };
type Timer = ReturnType<typeof setTimeout>;
interface Timers {
  setInterval: (callback: () => void, ms: number) => Timer;
  clearInterval: (timer: Timer) => void;
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
}
interface Options {
  now?: () => number; uuid?: () => string; timers?: Timers;
  scanIntervalMs?: number; maintenanceIntervalMs?: number; leaseMs?: number; drainMs?: number;
  logger?: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
}
const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
};
export class ModelCatalogScanner {
  private readonly lanes = new Map<CatalogProvider, Lane>(BUILTIN_CATALOG_PROVIDERS.map((p) => [p, { startup: true }]));
  private readonly lastDiagnostic = new Map<string, string>();
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly log: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
  private stopped = false;
  private started = false;
  private interval?: Timer;
  private recovery?: Promise<void>;
  private stopPromise?: Promise<void>;
  constructor(private readonly store: Store, private readonly discover: Discover, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now; this.timers = options.timers ?? realTimers;
    this.log = options.logger ?? createLogger("model-catalog-scanner");
  }
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.interval = this.timers.setInterval(() => { void this.tick(); }, this.options.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS);
    this.interval.unref?.();
    void this.tick();
  }
  private report(provider: string, status: string, attemptId?: string, code?: string, recoveryPending = false): void {
    const key = JSON.stringify([status, attemptId, code, recoveryPending]);
    if (this.lastDiagnostic.get(provider) === key) return;
    this.lastDiagnostic.set(provider, key);
    const data = { provider, status, attemptId, code, recoveryPending };
    if (code) this.log.warn("Model catalog scanner status", data);
    else this.log.info("Model catalog scanner status", data);
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const tasks: Promise<void>[] = [];
    // Reserve every available lane before running any body or recovery sweep.
    for (const [provider, lane] of this.lanes) {
      if (lane.task) continue;
      const invocation = Symbol(provider); lane.invocation = invocation;
      lane.controller = new AbortController();
      const task = Promise.resolve().then(() => this.runLane(provider, lane, invocation)).catch(() => {
        if (this.current(lane, invocation)) this.report(provider, "storage-unavailable", lane.pending?.attempt.attemptId, "storage");
      }).finally(() => {
        if (lane.invocation === invocation) {
          if (lane.watchdog) this.timers.clearTimeout(lane.watchdog);
          lane.watchdog = undefined; lane.invocation = undefined; lane.controller = undefined; lane.task = undefined;
        }
      });
      lane.task = task; tasks.push(task);
    }
    if (!this.recovery) {
      const task = Promise.resolve().then(async () => {
        if (this.stopped) return;
        const results = await this.store.recoverPendingExports();
        if (this.stopped) return;
        const pending = results.some((r) => r.kind !== "recovered");
        if (pending) this.report("*", "export-recovery-pending", undefined, "storage", true);
        else this.lastDiagnostic.delete("*");
      }).catch(() => {
        if (!this.stopped) this.report("*", "export-recovery-pending", undefined, "storage", true);
      }).finally(() => { if (this.recovery === task) this.recovery = undefined; });
      this.recovery = task; tasks.push(task);
    }
    await Promise.allSettled(tasks);
  }
  private current(lane: Lane, invocation: symbol): boolean {
    return !this.stopped && lane.invocation === invocation && !lane.controller?.signal.aborted;
  }
  private usable(lane: Lane, invocation: symbol, attempt: DiscoveryAttempt): boolean {
    return this.current(lane, invocation) && attempt.leaseExpiresAt.getTime() > this.now();
  }
  private async fail(lane: Lane, invocation: symbol, attempt: DiscoveryAttempt, error: SafeCatalogError): Promise<void> {
    if (!this.usable(lane, invocation, attempt)) return;
    lane.pending = { attempt, phase: "failure" };
    try {
      const result = await this.store.failDiscoveryAttempt(attempt, error, new Date(this.now()));
      if (!this.current(lane, invocation)) return;
      lane.pending = undefined;
      this.report(attempt.provider, result.kind, attempt.attemptId, result.kind === "recorded" ? error.code : undefined);
    } catch {
      if (this.current(lane, invocation)) this.report(attempt.provider, "failure-record-unknown", attempt.attemptId, "storage");
    }
  }
  private async runLane(provider: CatalogProvider, lane: Lane, invocation: symbol): Promise<void> {
    if (!this.current(lane, invocation)) return;
    // Only an entered, uncertain apply consumes its proof. Begin/failure
    // uncertainty MUST NOT call placeholder apply on a possibly-ready proof.
    const pending = lane.pending;
    if (pending?.phase === "apply") {
      const result = await this.store.applyDiscovery(pending.attempt, []);
      if (!this.current(lane, invocation)) return;
      if (result.kind === "committed" || result.kind === "unchanged" || result.kind === "superseded") {
        lane.pending = undefined;
        this.report(provider, result.kind, pending.attempt.attemptId, undefined, result.kind === "committed" && result.recoveryPending);
      } else this.report(provider, "commit-unknown", pending.attempt.attemptId, "storage");
    }
    if (!this.current(lane, invocation)) return;
    let state = await this.store.readCatalogState(provider);
    if (!this.current(lane, invocation)) return;
    let recovered = false;
    const unresolved = lane.pending;
    if (unresolved) {
      const scan = catalogTiming(state.snapshot, this.now()).scan;
      if (scan.attemptId === unresolved.attempt.attemptId && (scan.outcome === "succeeded" || scan.outcome === "failed")) {
        // Durable success is truthful even when unchanged reconciliation
        // cannot reconstruct the original saved snapshot identity.
        lane.pending = undefined;
        this.report(provider, `observed-${scan.outcome}`, unresolved.attempt.attemptId);
      } else if (typeof scan.attemptId === "string" && scan.attemptId !== unresolved.attempt.attemptId) {
        lane.pending = undefined; // supersession, not a failure claim
      } else if (unresolved.attempt.leaseExpiresAt.getTime() > this.now()) return;
      else {
        // A negative read after expiry permits only recovery + a new due
        // observation; it never means the earlier mutation did not happen.
        if (!this.current(lane, invocation)) return;
        await this.store.recoverPendingExports(provider);
        recovered = true;
        if (!this.current(lane, invocation)) return;
        state = await this.store.readCatalogState(provider);
        if (!this.current(lane, invocation)) return;
        lane.pending = undefined;
      }
    }
    let decision = catalogDue(state.snapshot, this.now(), lane.startup, this.options.scanIntervalMs);
    if (decision.consumeStartup) lane.startup = false;
    if (decision.recover && !recovered) {
      if (!this.current(lane, invocation)) return;
      await this.store.recoverPendingExports(provider);
      if (!this.current(lane, invocation)) return;
      state = await this.store.readCatalogState(provider);
      if (!this.current(lane, invocation)) return;
      decision = catalogDue(state.snapshot, this.now(), lane.startup, this.options.scanIntervalMs);
    }
    if (!decision.due) return;
    if (decision.consumeStartup) lane.startup = false;
    const startedAt = new Date(this.now());
    const attempt: DiscoveryAttempt = { provider, attemptId: (this.options.uuid ?? randomUUID)(), startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + (this.options.leaseMs ?? ATTEMPT_LEASE_MS)) };
    if (!this.current(lane, invocation)) return;
    lane.pending = { attempt, phase: "begin" };
    // A deadline reports unfinished work; it never releases the lane or
    // implies cancellation/noncommit of the underlying store operation.
    lane.watchdog = this.timers.setTimeout(() => {
      if (this.current(lane, invocation)) this.report(provider, "unfinished", attempt.attemptId, "storage");
    }, Math.max(0, attempt.leaseExpiresAt.getTime() - this.now()));
    lane.watchdog.unref?.();
    let acquired;
    try {
      acquired = await this.store.beginDiscoveryAttempt(provider, { attemptId: attempt.attemptId,
        startedAt: attempt.startedAt, leaseExpiresAt: attempt.leaseExpiresAt, observed: state.observed });
    } catch {
      if (this.current(lane, invocation)) this.report(provider, "acquisition-unknown", attempt.attemptId, "storage");
      return;
    }
    if (!this.current(lane, invocation)) return;
    if (acquired.kind === "busy") { lane.pending = undefined; return; }
    // Keep the originally supplied dates, identity, store, and invocation.
    // A started result alone is not fresh-submission authority.
    if (!this.usable(lane, invocation, attempt)) { this.report(provider, "interrupted-acquisition", attempt.attemptId); return; }
    let rows: DiscoveredModel[];
    try { rows = await this.discover(provider, { signal: lane.controller!.signal }); }
    catch (error) {
      if (!this.usable(lane, invocation, attempt)) return;
      if (error instanceof CatalogError) await this.fail(lane, invocation, attempt, safeError(provider, error.safe.code, error.safe.httpStatus));
      else this.report(provider, "discovery-unfinished", attempt.attemptId, "storage");
      return;
    }
    if (!this.usable(lane, invocation, attempt)) return;
    lane.pending = { attempt, phase: "apply" };
    // Rows live only in this invocation and are never retained for replay.
    const result = await this.store.applyDiscovery(attempt, rows);
    if (!this.current(lane, invocation)) return;
    if (result.kind === "commit-unknown") { this.report(provider, result.kind, attempt.attemptId, "storage"); return; }
    if (result.kind === "not-committed") { lane.pending = { attempt, phase: "failure" }; await this.fail(lane, invocation, attempt, result.error); return; }
    lane.pending = undefined;
    this.report(provider, result.kind, attempt.attemptId, undefined, result.kind === "committed" && result.recoveryPending);
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; // invalidates every invocation before the first await
    if (this.interval) { this.timers.clearInterval(this.interval); this.interval = undefined; }
    for (const lane of this.lanes.values()) {
      lane.controller?.abort();
      if (lane.watchdog) { this.timers.clearTimeout(lane.watchdog); lane.watchdog = undefined; }
    }
    const tasks = [...this.lanes.values()].flatMap((lane) => lane.task ? [lane.task] : []);
    if (this.recovery) tasks.push(this.recovery);
    this.stopPromise = (async () => {
      let timer: Timer | undefined;
      const settled = Promise.allSettled(tasks).then(() => true);
      const deadline = new Promise<boolean>((resolve) => { timer = this.timers.setTimeout(() => resolve(false), this.options.drainMs ?? SHUTDOWN_DRAIN_MS); });
      const drained = await Promise.race([settled, deadline]);
      if (timer) this.timers.clearTimeout(timer);
      if (!drained) this.log.warn("Model catalog scanner shutdown drain incomplete", { code: "storage" });
    })();
    return this.stopPromise;
  }
}
```

- [ ] **Step 2:** Add the complete initial success/unchanged test below before expanding Task 3. It uses the real planned store, so accidentally replacing the store between acquisition/application breaks successful persistence. Add a companion fault fixture in which the injected store facade deliberately uses a fresh store for `applyDiscovery`; assert `scan.outcome` remains running and no catalog/history is manufactured. That negative control validates that the harness actually observes store-local proof.

```ts
// src/admin/model-catalog-scanner.test.ts — initial test; extend in Task 3
import { describe, it, expect, vi } from "vitest";
import { ModelCatalogStore } from "./model-catalog-store.js";
import { ModelCatalogScanner } from "./model-catalog-scanner.js";
import { SCAN_INTERVAL_MS } from "./model-catalog-status.js";
import { createCatalogFake } from "./testing/catalog-db.test-support.js";
describe("model catalog scanner", () => {
  it("commits through the acquiring store, then records unchanged success without rewriting content", async () => {
    let now = Date.parse("2026-09-07T12:00:00Z");
    const fake = createCatalogFake(() => new Date(now));
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(now) });
    const discover = vi.fn(async (provider: string) => [{ id: `${provider}-model`, displayName: provider }]);
    const scanner = new ModelCatalogScanner(store, discover, { now: () => now });
    try {
      await scanner.tick();
      expect(discover.mock.calls.map(([p]) => p)).toEqual(["claude", "grok", "codex"]);
      const first = (await store.readCatalogState("codex")).snapshot!;
      expect(first.scan?.outcome).toBe("succeeded");
      expect(first.scan?.lastSucceededAt).toEqual(new Date(now));
      expect(fake.rows("agent_model_catalog_versions").size).toBe(3);
      expect(fake.rows("agent_model_catalog_changes").size).toBe(3);
      now += SCAN_INTERVAL_MS - 1; await scanner.tick(); expect(discover).toHaveBeenCalledTimes(3);
      now++; await scanner.tick(); expect(discover).toHaveBeenCalledTimes(6);
      const next = (await store.readCatalogState("codex")).snapshot!;
      expect(next.models).toEqual(first.models); expect(next.updatedAt).toEqual(first.updatedAt);
      expect(next.revision).toBe(first.revision); expect(next.commitId).toBe(first.commitId);
      expect(next.scan?.lastSucceededAt).toEqual(new Date(now));
      expect(fake.rows("agent_model_catalog_versions").size).toBe(3);
      expect(fake.rows("agent_model_catalog_changes").size).toBe(3);
    } finally { await scanner.stop(); }
  });
});
```

- [ ] **Step 3:** Run `npx vitest run src/admin/model-catalog-status.test.ts src/admin/model-catalog-scanner.test.ts` and `npm run typecheck`. Expected: initial commit, unchanged freshness, and proof-negative control pass; no TypeScript diagnostics. Keep this task uncommitted until Task 3's complete uncertainty coverage passes.

## Task 3 — Deterministic lifecycle and interleaving tests

**Files:** Extend `src/admin/model-catalog-scanner.test.ts`; reuse KPR-459 `src/admin/testing/catalog-db.test-support.ts` unchanged unless a demonstrated missing generic fault hook is required.

- [ ] **Step 1:** Build fixtures around `createCatalogFake`, `ModelCatalogStore`, `faultDb`, `deferred`, injected clocks, and logger spies. Use actual store mutations and compare all three collections after each schedule. The following complete schedule captures a delayed scanner claim after another scanner completes. Expand its state/outcome table in Step 2; preserve exact `observed` objects inside real scanner calls rather than generating observations in tests.

```ts
// Add imports and test to src/admin/model-catalog-scanner.test.ts.
import { randomUUID } from "node:crypto";
import { deferred, faultDb, cloneBson } from "./testing/catalog-db.test-support.js";
it("discards a consumed missing-catalog startup decision when another scanner fails", async () => {
  const now = Date.parse("2026-09-07T12:00:00Z"), fake = createCatalogFake(() => new Date(now));
  const gate = deferred<void>(), entered = deferred<void>(), delayedId = randomUUID();
  const delayedDb = faultDb(fake.db, async (name, method, args, run) => {
    if (name === "agent_model_catalog" && method === "updateOne" && args[1].$set?.["scan.attemptId"] === delayedId) {
      entered.resolve(); await gate.promise;
    }
    return run();
  });
  const discoverA = vi.fn(async () => { throw new CatalogError(safeError("codex", "auth")); });
  const discoverB = vi.fn(async (_provider: string) => [{ id: "new", displayName: "New" }]);
  // UUID assignment is deterministic by stable provider order; only codex is delayed.
  let issued = 0;
  const a = new ModelCatalogScanner(new ModelCatalogStore(fake.db, { now: () => new Date(now) }), discoverA, { now: () => now });
  const b = new ModelCatalogScanner(new ModelCatalogStore(delayedDb, { now: () => new Date(now) }), discoverB,
    { now: () => now, uuid: () => ++issued === 3 ? delayedId : randomUUID() });
  const bTick = b.tick();
  try {
    await entered.promise; await a.tick();
    const before = cloneBson(fake.rows("agent_model_catalog").get("codex")!);
    expect(before.scan.outcome).toBe("failed");
    gate.resolve(); await bTick;
    expect(discoverB.mock.calls.filter((call) => call[0] === "codex")).toHaveLength(0);
    expect(fake.rows("agent_model_catalog").get("codex")).toEqual(before);
    await b.tick();
    expect(discoverB.mock.calls.filter((call) => call[0] === "codex")).toHaveLength(0);
    expect(fake.rows("agent_model_catalog").get("codex")).toEqual(before);
  } finally { gate.resolve(); await bTick; await Promise.all([a.stop(), b.stop()]); }
});
// Merge with imports: CatalogError, safeError from ./model-catalog-value.js.
```

- [ ] **Step 2:** Implement every schedule below as named/table-driven tests. For outcome cases compare complete `scan`, saved fields, versions and changes, including delivery state; assertions merely counting `begin` calls are insufficient.

| Cases | Schedule and minimum assertions |
| --- | --- |
| Startup | Missing/empty/shell/legacy seed with no scan → one immediate discovery per built-in; completed recent seeded success/failure skips; active leases defer; no Gemini/plugin calls. Unseeded recent failure overrides once; `busy` or uncertain begin never re-arms it. |
| Cadence | Repeat minute ticks after failure → no retry until `startedAt + 8h`; success same; exact boundary due; three missed intervals → one request; manual timestamp/notes refresh changes neither due anchor nor last success. Future/malformed scan timing is due only subject to store lease fence. |
| Isolation/no overlap | Hold Claude discovery, Claude read/begin/apply/failure separately, and a full export sweep. Concurrent ticks/start calls cannot duplicate held lane or recovery; Grok/Codex still complete and later become due. Started store promise held past lease remains locally busy. Capture `unhandledRejection`; all held rejections are observed. |
| Two due scanners | Cross product: seeded-overdue, missing, legacy-scanless, expired-running × predecessor changed success, unchanged success where seeded (use initial changed seed for genuinely missing), and failure. B holds its conditional claim before delegation, A completes while B's proposal is live, B misses and makes no request. B's next tick reads completed cadence; unseeded exception consumed even when A failed. For empty/missing predecessor “unchanged” is impossible: explicitly assert bootstrap changed commit rather than invent seeded content. |
| Observation scope | Manual first seed between due read/claim invalidates seeded bit, yields busy; manual seeded edit retaining scan/seeded bit and export recovery alone do not reject an otherwise eligible claim. Manual write during discovery is rebased with retained notes and does not move scan cadence. |
| Typed failures | Auth/http/client-version/empty/malformed/too-large/timeout → fenced failed scan, original saved fields and last success preserved. Untyped thrown discovery is fixed unfinished/storage diagnostic and cannot expose raw error or invent success. Successful next attempt clears prior persisted error. |
| Outcomes | `committed` with/without pending recovery and `unchanged` never fail; `not-committed` gets one safe failure if still usable, including retriable refusal with no immediate replay; `superseded` cannot fail a successor. |
| Unknown begin | Hold actual begin promise: overlapping ticks skip forever until settlement, even expired. Throw after delegated claim with evidence read unavailable → preserve UUID, no discovery/placeholder apply/failure; active original lease waits. Recover after expiry from fresh read with new UUID. Negative read alone never permits early replacement. |
| Unknown apply | Both changed/unchanged writes throw ambiguously; delay mutation until after negative reconciliation. Keep UUID and discard rows, never fail/replay. Later positive envelope/history or succeeded scan resolves truth; unavailable evidence, failed recovery/index/guard read paths stay unknown. Only apply-entered uncertainty uses `[]`; begin/failure uncertainty does not. |
| Unknown failure | Throw failure acknowledgment/evidence read; later failed state resolves cadence; absent evidence waits through original lease. No placeholder application through its ready proof and no fabricated failure during expiration. |
| Three timestamp schedules | Delay before delegation beyond proposal expiry → unmatched claim, with and without successor. Use fake `afterTimestamp` to freeze pre-expiry `$$NOW`, then advance local/server clocks beyond expiry: unchanged observation allows expired running claim (`matchedCount: 1`, returned started) with no proof/request/apply/failure/freshness/history. Changing predecessor observation during pause forces miss despite old timestamp. Hold a matched ack past expiry separately; original dates are unchanged and no request starts. |
| Rechecks | Stop/cancel/expire after begin response and after discovery resolution before apply → no next step; test clock advancement on these boundaries, not merely after already-started HTTP. Ambiguous started with no store proof may fetch but only reconciliation-only apply follows, never fabricated success. |
| Restart/takeover | Fresh scanner/store observes active old token → wait. Expired running → bounded read/recovery and fresh same-read observation acquisition. Predecessor success between recovery reread and claim → busy then normal cadence. Old shell/claim/apply/failure released after successor completes must miss and preserve successor. Late positive success observed before takeover avoids a fresh request. |
| Export maintenance | Recover on startup/minute ticks even with no due provider, including plugin manual changes; pending warnings persist until cleared; double recovery preserves delivery fields; failed/stuck sweep leaves provider lanes free. List/status does not initiate recovery. |
| Stop matrix | Stop during read/begin/discovery/apply/failure/recovery; latch clears interval and aborts active signals synchronously; no subsequent scanner-level method starts. Already-entered store sequence may finish. Repeated stop returns same promise; direct tick/start after stop inert. Hold matched begin ack until after stop and drain, both before/after lease expiry; no new step. Fake timers prove 4999ms unfinished, 5000ms drain resolves once; release later failures and assert observed rejection/no new writes. New scanner recovers persisted state. |
| Sanitization/logging | Raw injected SDK/HTTP/Mongo/command message containing `test-secret`, bearer URL and account metadata never enters logger/tool/doctor text. Repeated unchanged storage uncertainty emits one warning for same provider/attempt/status; successful outcomes and later distinct attempts remain observable. |

- [ ] **Step 3:** Run unit commands from Tasks 1–2 plus `npx vitest run src/admin/model-catalog-store.test.ts`. Expected: all schedules pass, timers cleared, zero leaked/unhandled promises, all persistence invariants preserved. Stage scanner and its test, then commit `feat: run fenced catalog discovery in bounded provider lanes`.

## Task 4 — Prove scanner interleavings against standalone Mongo

**Files:** Create `src/admin/model-catalog-scanner.integration.test.ts`; consume KPR-459 harness files.

- [ ] **Step 1:** Set up `beforeAll`/`afterAll` around `startStandaloneMongo()` with 30-second hook limits; `beforeEach` checks `/^hive_kpr459_test_/` before `dropDatabase()`. Import `guardDb`/`WriteGuard` for guarded variants and KPR-459 `faultDb` for real mutations. Use complete store instances and injected discovery, no fake store results. Every test stops all scanners and releases/awaits barriers in `finally` before owned Mongo teardown.
- [ ] **Step 2:** Add the test below and table-driven real-Mongo versions of the schedules in Step 3. This specifically proves post-ack lease handling; it does not claim a real server pause after `$$NOW` capture.

```ts
// src/admin/model-catalog-scanner.integration.test.ts
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { ModelCatalogStore } from "./model-catalog-store.js";
import { ModelCatalogScanner, ATTEMPT_LEASE_MS } from "./model-catalog-scanner.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";
import { deferred, faultDb } from "./testing/catalog-db.test-support.js";
let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;
beforeAll(async () => { mongo = await startStandaloneMongo(); }, 30_000);
afterAll(async () => { await mongo?.close(); }, 30_000);
beforeEach(async () => { expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/); await mongo.db.dropDatabase(); });
it("accepts a matched claim but does not discover after its acknowledgment expires", async () => {
  let now = new Date((await mongo.db.admin().command({ hello: 1 })).localTime).getTime();
  const entered = deferred<void>(), release = deferred<void>(); let matched = -1;
  const db = faultDb(mongo.db, async (name, method, args, run) => {
    const isClaim = name === "agent_model_catalog" && method === "updateOne" && args[0]._id === "codex" && args[1].$set?.["scan.outcome"] === "running";
    const result = await run();
    if (isClaim) { matched = result.matchedCount; entered.resolve(); await release.promise; }
    return result;
  });
  const store = new ModelCatalogStore(db, { now: () => new Date(now) });
  const discover = vi.fn(async (provider: string) => [{ id: `${provider}-model`, displayName: provider }]);
  const scanner = new ModelCatalogScanner(store, discover, { now: () => now });
  const tick = scanner.tick();
  try {
    await entered.promise; expect(matched).toBe(1);
    const before = await mongo.db.collection("agent_model_catalog").findOne({ _id: "codex" } as never);
    now += ATTEMPT_LEASE_MS + 1; release.resolve(); await tick;
    expect(discover.mock.calls.filter(([p]) => p === "codex")).toHaveLength(0);
    expect(await mongo.db.collection("agent_model_catalog").findOne({ _id: "codex" } as never)).toEqual(before);
    expect(before?.scan.outcome).toBe("running"); expect(before?.models).toBeUndefined();
    expect(before?.updatedAt).toBeUndefined(); expect(before?.scan.lastSucceededAt).toBeUndefined();
    expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments({ provider: "codex" })).toBe(0);
    expect(await mongo.db.collection("agent_model_catalog_changes").countDocuments({ provider: "codex" })).toBe(0);
  } finally { release.resolve(); await tick; await scanner.stop(); }
}, 30_000);
```

- [ ] **Step 3:** Required real-Mongo schedules (all assert provider counts, real claim/completion matched counts, full snapshot/scan and version/change payloads/counts):

1. Startup changed success → next due unchanged success; manual during discovery preserves retained notes and cadence; failed provider preserves content and prior success while others complete. Compare saved-write time with successful-check time explicitly.
2. Run Task 3's two-reader matrix on real Mongo: seeded-overdue/missing/legacy-scanless/expired-running × changed/unchanged-applicable/failure. Hold B before real claim delegation after its own due read; A completes; B's real conditional update returns zero and B's next tick respects completed cadence. Never synthesize unchanged bootstrap.
3. Interleave manual first seed before claim (must miss), seeded manual edit and pending-export clear (eligibility observation remains valid). Do not regenerate B's observation in the interceptor.
4. Expire B's proposal before delegation with and without a successor. For lease fixtures, use server-relative dates and/or explicitly set expired test fixture dates in the owned DB; assert actual mismatch. Separately hold real matched acknowledgments past local lease deadline as above, plus stop/drain before releasing them. Leave catalog/freshness untouched when only the running token was accepted.
5. Ambiguous changed/unchanged completion: interceptor stores a deferred real `run()` operation and throws; evidence reads initially negative/unavailable, recovery can fail, current guard can reject. Scanner does not fail/replay or allocate a new UUID before lease expiration. Release real mutation while original lease remains server-valid; later tick observes positive evidence/succeeded scan. Capture and await the detached delegated promise explicitly.
6. Restart with old active lease → no new request; expired running takeover → new UUID from scanner's fresh due read. Delay old shell/claim and old success/failure until after successor starts **and completes**; all obsolete conditional mutations miss. Complete predecessor between takeover's observed read and delegation → zero match; next tick waits eight hours from observed completed start.
7. Shutdown with acquisition and completion still outstanding: no new scanner step after latch/drain; already-started store mutation can succeed without a successor or miss after newer observation. New scanner recovers interrupted token/pending export. Doctor/list truth reads the final durable state, not shutdown's local conclusion.
8. Commit envelope with failed projection; provider not due on next tick; export lane recovers exact history/change including a manual plugin change. Duplicate recovery leaves any existing delivery subdocument byte-identical. One failed export cannot cancel other providers.

Reuse KPR-459's separate client/server-clock, exact timestamp equality, and malformed-lease predicate tests in its store suites. The frozen-`$$NOW` server-pause schedule remains in Task 3's exact stateful fake; a real client barrier must never be reported as equivalent server-pause evidence.

- [ ] **Step 4:** Run `npx vitest run src/admin/model-catalog-scanner.integration.test.ts src/admin/model-catalog-store.integration.test.ts`. Expected: real standalone suite passes all matrix rows, no skipped tests, only owned temporary database/process used, no leftover child. Stage new integration test and any strictly required generic harness correction; commit `test: verify scanner leases and recovery against standalone Mongo`.

## Task 5 — Existing catalog tool and doctor report durable truth

**Files:** Modify `src/admin/admin-mcp-server.ts`, `src/admin/admin-mcp-server.test.ts`, `src/cli/doctor-checks.ts`, `src/cli/doctor.ts`, `src/cli/doctor.test.ts`; create `src/cli/doctor-model-catalog.test.ts`.

- [ ] **Step 1:** In `agent_model_catalog_list`, remove only this handler's `await ensureIndexes()`; list reads must not depend on any unrelated index write. Keep validation and its provider order, Gemini block, and JSON-before-notes return structure. Import `catalogStatus`, `catalogStatusNote`, `catalogUnavailableNote` from the pure module. KPR-459 already constructs `catalogStore` once in `buildAdminTools`; replace the stored-provider loop with the following. Remove an unused `catalogDocs` binding if it has no remaining reader after this change. Sample one `statusNow` for all provider notes. Replace the outer raw-error catch with fixed `Model catalog storage unavailable.` text; do not alter Gemini's existing safe-error logic.

```ts
const statusNow = Date.now();
for (const p of wantCurated) {
  try {
    const { snapshot: doc } = await catalogStore.readCatalogState(p);
    notes.push(catalogStatusNote(catalogStatus(p, doc, statusNow)));
    if (!doc || !Array.isArray(doc.models)) continue;
    const asOf = doc.updatedAt instanceof Date
      ? Number.isFinite(doc.updatedAt.getTime()) ? doc.updatedAt.toISOString() : "unknown"
      : String(doc.updatedAt);
    for (const m of doc.models) entries.push({ provider: p, id: m.id, displayName: m.displayName,
      ...(m.notes ? { notes: m.notes } : {}), source: "curated", asOf });
  } catch {
    const text = catalogUnavailableNote(p);
    if (provider === p) return { isError: true, content: [{ type: "text", text }] };
    notes.push(text);
  }
}
```

Set list description to: `List valid LLM model ids for agent model assignment. Claude/grok/codex use stored catalogs checked automatically every eight hours; notes report saved-list time, successful discovery, latest attempt and pending recovery. Plugins are manually maintained. Gemini is resolved live (cached ~10 min). Returns a JSON entries array followed by provider notes. Listing does not trigger built-in discovery.` Set refresh description to: `Replace one stored catalog with the FULL list, not a delta. The manual write performs no vendor calls. The next successful built-in scan replaces membership, names and order while retaining notes for retained IDs; a manual edit does not postpone discovery. Plugin catalogs remain manual; Gemini remains live and cannot be refreshed.`

- [ ] **Step 2:** Add the read-only adapter below to `src/cli/doctor-checks.ts`, merging top-level imports. A successful read with no rows still renders all built-ins; failed reads return unavailable. Only stored non-Gemini plugin IDs are added in deterministic lexical order. Import neither store nor discovery. Construction is inside `try`, and cleanup cannot replace a safe unavailable outcome with a raw error.

```ts
// Imports and addition in src/cli/doctor-checks.ts
import { BUILTIN_CATALOG_PROVIDERS } from "../admin/model-catalog-types.js";
import { catalogStatus, type CatalogStatus } from "../admin/model-catalog-status.js";
export type ModelCatalogReport = { kind: "available"; rows: CatalogStatus[] } | { kind: "unavailable" };
export async function modelCatalogsForDoctor(uri: string, dbName: string, now = Date.now()): Promise<ModelCatalogReport> {
  let client: import("mongodb").MongoClient | undefined;
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    const docs = await client.db(dbName).collection("agent_model_catalog")
      .find({ _id: { $ne: "gemini" } } as never).toArray();
    const byId = new Map(docs.filter((doc) => typeof doc._id === "string").map((doc) => [String(doc._id), doc]));
    const builtinIds: readonly string[] = BUILTIN_CATALOG_PROVIDERS;
    const plugins = [...byId.keys()].filter((id) => !builtinIds.includes(id) && id !== "gemini").sort();
    return { kind: "available", rows: [...builtinIds, ...plugins].map((id) => catalogStatus(id, byId.get(id), now)) };
  } catch { return { kind: "unavailable" }; }
  finally { await client?.close().catch(() => {}); }
}
```

- [ ] **Step 3:** In `src/cli/doctor.ts`, import `modelCatalogsForDoctor` and `ModelCatalogReport` from `doctor-checks`, plus `catalogStatusNote` from the pure module. Add this renderer and call it in the existing `if (config)` informational section immediately after `renderCircuitBreakerSection(breakerRows)`. Do not assign its result to `allPassed` or change the identity section.

```ts
export function renderModelCatalogsSection(report: ModelCatalogReport, emit: (line: string) => void = console.log): void {
  emit("\nModel catalogs");
  if (report.kind === "unavailable") { emit("  catalog storage unavailable"); return; }
  for (const row of report.rows) emit(`  ${catalogStatusNote(row)}`);
}
// In runDoctor's existing if (config) block:
renderModelCatalogsSection(await modelCatalogsForDoctor(config.mongo.uri, config.mongo.dbName));
```

- [ ] **Step 4:** Extend real admin-handler fixtures using KPR-459's stateful catalog fake. Built-in successful rows now intentionally have notes; update assertions assuming one content item while retaining first-item JSON byte/order expectations. Unseeded text keeps `not yet seeded` and the manual option; update exact old prose expectations only to the new specified note. Test each status table state, manual-after-success, unchanged freshness, future/invalid dates, and seeded failed scan returning old entries plus failure note. One stored-provider read error → safe hard error; all-provider read error → other rows plus safe unavailable note, never unseeded. Assert reads call no index initializer, begin/apply/discover/recovery. Preserve `Valid: claude, grok, codex, sol`, plugin manual rows, and all Gemini cache/key/empty/hard-error/partial behavior tests.
- [ ] **Step 5:** In the new doctor adapter test file use `vi.mock("mongodb")` with a constructor mock exposing only `connect`, `db().collection().find().toArray()`, and `close`. All write/index methods throw if called. Test empty successful read returns three built-ins in order, plugin inclusion/manual status, Gemini exclusion, connect/read/constructor failure returns unavailable, close on success/failure, and close failure swallowed. Inject dates from the same status fixtures and compare rendered note exactly with `catalogStatusNote(catalogStatus(...))`. In `doctor.test.ts` add renderer tests for unavailable, built-ins and plugin, and a source assertion that the new call is standalone in the informational block and never changes `allPassed`. No runtime SDK/config import is introduced by the pure module or adapter; existing doctor imports remain unchanged.
- [ ] **Step 6:** Run `npx vitest run src/admin/admin-mcp-server.test.ts src/admin/model-catalog-status.test.ts src/cli/doctor-model-catalog.test.ts src/cli/doctor.test.ts src/cli/doctor-checks.test.ts` and `npm run typecheck`. Expected: legacy entry shape/order and Gemini/plugin regressions pass; both surfaces report identical durable timing; no writes or raw error text. Stage only task files and commit `feat: report catalog discovery freshness in admin and doctor`.

## Task 6 — Wire the engine, document, and verify

**Files:** Modify `src/index.ts`, `src/boot-order.test.ts`, `CLAUDE.md`, `docs/providers.md`.

- [ ] **Step 1:** Add imports for `ModelCatalogStore`, `ModelCatalogScanner`, and `discoverProviderModels`. Immediately after `memoryLifecycleHeartbeat.start()` in the existing heartbeat block add:

```ts
const modelCatalogStore = new ModelCatalogStore(db);
const modelCatalogScanner = new ModelCatalogScanner(modelCatalogStore, discoverProviderModels);
modelCatalogScanner.start();
```

`db` is `guardDb(rawDb, writeGuard)` from the identity-verified boot path. The scanner's store does not need the plugin resolver for built-in discovery or all-provider export recovery; admin's existing separate store retains that resolver for manual validation. Do not await a tick/index/discovery at boot or create another Mongo client. This location follows provider/plugin activation and meeting wiring, so do not extend the boot test's pre-wiring start allowlist.

- [ ] **Step 2:** At the first line inside the `shutdown` function, before logging and all other subsystem waits, add `await modelCatalogScanner.stop();`. Calling it immediately trips its synchronous latch/abort, then waits no more than its five-second drain before existing shutdown work continues. Leave the old heartbeat stops in place; do not couple scanner stop to `agentManager.stopAll`, registry reload, admin agent enable/disable, or config reload. Mongo closes after this scanner drain; already-started store operations remain observed if drain expired.
- [ ] **Step 3:** Extend `src/boot-order.test.ts` using its existing stripped source/readFileSync pattern, never importing `index.ts`. Assert exactly one scanner store construction and one scanner construction/start, exact guarded-db constructor argument, plugin activation and `guardDb` precede construction, start is not awaited, start precedes Slack adapter start, and the scanner stop is the first shutdown statement and precedes the first unrelated await and `mongoClient.close`. Assert no scanner references occur in reload/stopAll wiring. Keep the existing spawn boundary allowlist unchanged. Unit stop matrix proves runtime boundedness; source checks prove the actual integration sites.
- [ ] **Step 4:** Update the `Which model ids are valid` paragraph in `CLAUDE.md` and add a short `Automatic model catalogs (KPR-460)` paragraph in `docs/providers.md`: built-ins every eight hours anchored to attempt start; startup absent/overdue checks; one-minute export maintenance; manual replacement's next-scan behavior; independent saved/check/latest-attempt facts; unchanged-success freshness; honest retained catalogs after failures; interrupted leases/restart and five-second scanner drain. Plugins remain manual, Gemini live-only, no assignment changes. State that KPR-461 owns CoS delivery without claiming that notifications are already live.
- [ ] **Step 5:** Format only changed `.ts` files with `npx prettier --write` and explicit task paths. Run the Unit, Integration, and Adjacent regression commands in the Testing Contract, followed by `npm run check` and `npm run build`. Expected: all targeted/full checks and build exit zero; tests skipped for missing Mongo/harness are unacceptable. If unrelated baseline failures occur, record exact command/error and establish unchanged baseline separately; do not silently count them as passing or widen this ticket into unrelated fixes. Run `git diff --check` and inspect the diff for forbidden provider/notification/config/deployment changes. Stage task files and commit `feat: start catalog scanner with engine lifecycle` only after verification.

## Handoff and evidence

- KPR-461 can consume durable `agent_model_catalog_changes` and recovery independently of a successful discovery. No ephemeral callback is needed, and scanner status never acknowledges delivery.
- The per-provider process state is bounded: one lane promise/controller/current invocation plus at most one unresolved identity, and no replay payload. Pending exports remain in KPR-459's existing durable envelope.
- No-plan-to-product shortcut: status/scanner modules and harnesses are future implementation. Report actual product test commands/results only when delivery executes them. This draft itself does not apply readiness labels, approve its review, or authorize bypassing waterfall maturity.
- Draft-author scratch evidence: 11 virtual modules assembled from the two plans (including scanner/status, dependent store/fake, example tests and doctor adapter) passed strict TypeScript checking with zero diagnostics and no emitted files. Five in-memory probes passed: same-store changed/unchanged cadence; stale missing-catalog claim after a competing failure; frozen-operation-timestamp expired acceptance and recovery; held acknowledgment after terminal stop; and future-success/manual-timestamp status. These did not run Vitest/product code, real Mongo, providers, credentials, or the engine. Independent plan review and delivery verification remain outstanding.

## Assumptions

- Fixed production defaults are 8h/60s/120s/5s; overrides exist only as constructor test seams.
- Invalid durable dates are diagnostic trouble and due candidates, while the store retains final authority over future/malformed leases.
- A local store operation that never settles intentionally stalls only its provider until shutdown/restart; expiration does not cancel Mongo.
- An expired accepted claim may leave interrupted running state. Same-read observation fences successors; post-response checks prevent new discovery, and fresh-observation takeover recovers it without synthetic failure.
- A genuinely absent catalog cannot produce an unchanged bootstrap. Test matrices cover the corresponding changed seed and reserve unchanged outcomes for seeded fixtures.
