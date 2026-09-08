import { describe, expect, it } from "vitest";
import { BUILTIN_CATALOG_PROVIDERS } from "./model-catalog-types.js";
import {
  catalogDue,
  catalogStatus,
  catalogStatusNote,
  catalogTiming,
  catalogUnavailableNote,
  dateMs,
  record,
  SCAN_INTERVAL_MS,
} from "./model-catalog-status.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number): Date => new Date(NOW_MS + offsetMs);
const seededModels = [{ id: "model-a", displayName: "Model A", addedAt: at(-24 * HOUR) }];

const succeeded = (startedOffset = -7 * HOUR, successOffset = -6 * HOUR) => ({
  models: seededModels,
  updatedAt: at(-24 * HOUR),
  source: "discovery",
  scan: {
    attemptId: "attempt-success",
    outcome: "succeeded",
    startedAt: at(startedOffset),
    finishedAt: at(startedOffset + HOUR / 2),
    lastSucceededAt: at(successOffset),
  },
});

const failed = (startedOffset: number, successOffset?: number) => ({
  models: seededModels,
  updatedAt: at(-24 * HOUR),
  source: "discovery",
  scan: {
    attemptId: "attempt-failure",
    outcome: "failed",
    startedAt: at(startedOffset),
    finishedAt: at(startedOffset + HOUR / 2),
    ...(successOffset === undefined ? {} : { lastSucceededAt: at(successOffset) }),
    error: { code: "timeout", message: "safe fixture" },
  },
});

describe("defensive catalog values", () => {
  it.each([null, undefined, 0, "object-looking", [], ["row"]])("normalizes %j to an empty record", (value) => {
    expect(record(value)).toEqual({});
  });

  it("retains a plain record without cloning it", () => {
    const value = { scan: { outcome: "running" } };
    expect(record(value)).toBe(value);
  });

  it.each([
    { name: "an ISO string", value: NOW.toISOString() },
    { name: "an epoch number", value: NOW_MS },
    { name: "null", value: null },
    { name: "an invalid Date", value: new Date(Number.NaN) },
  ])("rejects $name as a BSON date", ({ value }) => {
    expect(dateMs(value)).toBeUndefined();
  });

  it("reads a finite BSON Date", () => {
    expect(dateMs(NOW)).toBe(NOW_MS);
  });
});

describe("catalogDue", () => {
  it.each([
    {
      name: "an absent document",
      snapshot: undefined,
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: true },
    },
    {
      name: "a shell document",
      snapshot: { _id: "codex", provider: "codex" },
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: true },
    },
    {
      name: "an empty catalog",
      snapshot: { models: [] },
      startupAvailable: true,
      expected: { due: true, recover: false, consumeStartup: true },
    },
    {
      name: "a seeded legacy catalog",
      snapshot: { models: seededModels, updatedAt: at(-HOUR) },
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: false },
    },
    {
      name: "a scanless manual catalog",
      snapshot: { models: seededModels, source: "manual", updatedAt: at(-HOUR) },
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: false },
    },
    {
      name: "an active running lease",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(HOUR) },
      },
      startupAvailable: true,
      expected: { due: false, recover: false, consumeStartup: false },
    },
    {
      name: "an expired running lease",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(-1) },
      },
      startupAvailable: false,
      expected: { due: true, recover: true, consumeStartup: false },
    },
    {
      name: "a running scan with a missing lease",
      snapshot: { models: seededModels, scan: { outcome: "running", startedAt: at(-HOUR) } },
      startupAvailable: false,
      expected: { due: true, recover: true, consumeStartup: false },
    },
    {
      name: "a running scan with an invalid lease",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(Number.NaN) },
      },
      startupAvailable: false,
      expected: { due: true, recover: true, consumeStartup: false },
    },
    {
      name: "a recent success",
      snapshot: succeeded(),
      startupAvailable: true,
      expected: { due: false, recover: false, consumeStartup: false },
    },
    {
      name: "a success one millisecond before the interval",
      snapshot: succeeded(-SCAN_INTERVAL_MS + 1, -HOUR),
      startupAvailable: false,
      expected: { due: false, recover: false, consumeStartup: false },
    },
    {
      name: "a success at the exact interval boundary",
      snapshot: succeeded(-SCAN_INTERVAL_MS, -HOUR),
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: false },
    },
    {
      name: "an overdue success",
      snapshot: succeeded(-9 * HOUR, -9 * HOUR),
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: false },
    },
    {
      name: "a recent failure with an overdue prior success",
      snapshot: failed(-HOUR, -12 * HOUR),
      startupAvailable: false,
      expected: { due: false, recover: false, consumeStartup: false },
    },
    {
      name: "a recent failure with a recent prior success",
      snapshot: failed(-HOUR, -2 * HOUR),
      startupAvailable: false,
      expected: { due: false, recover: false, consumeStartup: false },
    },
    {
      name: "a failed attempt at the exact interval boundary",
      snapshot: failed(-SCAN_INTERVAL_MS, -HOUR),
      startupAvailable: false,
      expected: { due: true, recover: false, consumeStartup: false },
    },
    {
      name: "an unseeded recent success after startup was consumed",
      snapshot: { ...succeeded(), models: [] },
      startupAvailable: false,
      expected: { due: false, recover: false, consumeStartup: false },
    },
    {
      name: "an unseeded recent success while startup is available",
      snapshot: { ...succeeded(), models: [] },
      startupAvailable: true,
      expected: { due: true, recover: false, consumeStartup: true },
    },
  ])("derives eligibility for $name", ({ snapshot, startupAvailable, expected }) => {
    expect(catalogDue(snapshot, NOW_MS, startupAvailable)).toEqual(expected);
  });

  it.each([
    { name: "missing startedAt", patch: { startedAt: undefined } },
    { name: "an invalid startedAt", patch: { startedAt: new Date(Number.NaN) } },
    { name: "a future startedAt", patch: { startedAt: at(HOUR) } },
    { name: "missing finishedAt", patch: { finishedAt: undefined } },
    { name: "an invalid finishedAt", patch: { finishedAt: new Date(Number.NaN) } },
    { name: "a future finishedAt", patch: { finishedAt: at(HOUR) } },
    { name: "missing lastSucceededAt", patch: { lastSucceededAt: undefined } },
    { name: "an invalid lastSucceededAt", patch: { lastSucceededAt: new Date(Number.NaN) } },
    { name: "a future lastSucceededAt", patch: { lastSucceededAt: at(HOUR) } },
    {
      name: "string dates",
      patch: {
        startedAt: at(-HOUR).toISOString(),
        finishedAt: at(-HOUR / 2).toISOString(),
        lastSucceededAt: at(-HOUR / 2).toISOString(),
      },
    },
    { name: "finishedAt before startedAt", patch: { startedAt: at(-HOUR), finishedAt: at(-2 * HOUR) } },
  ])("does not postpone eligibility for malformed timing with $name", ({ patch }) => {
    const base = succeeded();
    const snapshot = { ...base, scan: { ...base.scan, ...patch } };
    expect(catalogDue(snapshot, NOW_MS, false)).toEqual({ due: true, recover: false, consumeStartup: false });
    expect(catalogTiming(snapshot, NOW_MS).inconsistent).toBe(true);
  });

  it("treats an explicit null scan as malformed and due", () => {
    const snapshot = { models: seededModels, scan: null };
    expect(catalogDue(snapshot, NOW_MS, false)).toEqual({ due: true, recover: false, consumeStartup: false });
    expect(catalogTiming(snapshot, NOW_MS).inconsistent).toBe(true);
  });

  it("never bypasses an active future lease because other timing is malformed", () => {
    const snapshot = {
      models: [],
      scan: {
        outcome: "succeeded",
        startedAt: at(HOUR),
        finishedAt: "2026-09-07T13:01:00.000Z",
        lastSucceededAt: at(2 * HOUR),
        leaseExpiresAt: at(3 * HOUR),
      },
    };
    expect(catalogTiming(snapshot, NOW_MS).inconsistent).toBe(true);
    expect(catalogDue(snapshot, NOW_MS, true)).toEqual({ due: false, recover: false, consumeStartup: false });
  });

  it("anchors cadence to discovery start rather than a later manual write", () => {
    const base = succeeded(-SCAN_INTERVAL_MS, -7 * HOUR);
    const manual = { ...base, source: "manual", updatedAt: at(-1) };
    expect(catalogDue(manual, NOW_MS, false)).toEqual(catalogDue(base, NOW_MS, false));
    expect(catalogDue(manual, NOW_MS, false).due).toBe(true);
    expect(catalogStatus("codex", manual, NOW_MS)).toMatchObject({
      source: "manual",
      savedAt: NOW_MS - 1,
      succeededAt: NOW_MS - 7 * HOUR,
      nextAttemptAt: NOW_MS,
    });
  });
});

describe("catalogStatus", () => {
  it.each([
    {
      name: "an absent document",
      snapshot: undefined,
      expected: {
        seeded: false,
        modelCount: 0,
        source: "legacy/unknown",
        savedAt: undefined,
        succeededAt: undefined,
        ageMs: undefined,
        freshness: "never",
        latest: "never",
        timingInconsistent: false,
      },
    },
    {
      name: "a shell document",
      snapshot: { _id: "codex", provider: "codex" },
      expected: { seeded: false, modelCount: 0, freshness: "never", latest: "never" },
    },
    {
      name: "an empty catalog",
      snapshot: { models: [] },
      expected: { seeded: false, modelCount: 0, freshness: "never", latest: "never" },
    },
    {
      name: "a seeded legacy catalog",
      snapshot: { models: seededModels, updatedAt: at(-HOUR) },
      expected: {
        seeded: true,
        modelCount: 1,
        source: "legacy/unknown",
        savedAt: NOW_MS - HOUR,
        freshness: "never",
        latest: "never",
      },
    },
    {
      name: "a scanless manual catalog",
      snapshot: { models: seededModels, source: "manual", updatedAt: at(-HOUR) },
      expected: { seeded: true, source: "manual", freshness: "never", latest: "never" },
    },
    {
      name: "an active running scan",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(HOUR) },
      },
      expected: {
        freshness: "never",
        latest: "running",
        startedAt: NOW_MS - HOUR,
        leaseExpiresAt: NOW_MS + HOUR,
        timingInconsistent: false,
      },
    },
    {
      name: "an expired running scan",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(-1) },
      },
      expected: { latest: "expired/unresolved", leaseExpiresAt: NOW_MS - 1 },
    },
    {
      name: "a running scan with no lease",
      snapshot: { models: seededModels, scan: { outcome: "running", startedAt: at(-HOUR) } },
      expected: { latest: "unfinished; lease unknown", leaseExpiresAt: undefined },
    },
    {
      name: "a running scan with an invalid lease",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: "test-secret" },
      },
      expected: { latest: "unfinished; lease unknown", leaseExpiresAt: undefined },
    },
    {
      name: "a recent success",
      snapshot: succeeded(),
      expected: {
        freshness: "recent",
        latest: "succeeded",
        succeededAt: NOW_MS - 6 * HOUR,
        ageMs: 6 * HOUR,
        timingInconsistent: false,
      },
    },
    {
      name: "a success one millisecond before the freshness boundary",
      snapshot: succeeded(-7 * HOUR, -SCAN_INTERVAL_MS + 1),
      expected: { freshness: "recent", ageMs: SCAN_INTERVAL_MS - 1 },
    },
    {
      name: "a success at the exact freshness boundary",
      snapshot: succeeded(-SCAN_INTERVAL_MS, -SCAN_INTERVAL_MS),
      expected: { freshness: "overdue", ageMs: SCAN_INTERVAL_MS },
    },
    {
      name: "a failure with an overdue prior success",
      snapshot: failed(-HOUR, -12 * HOUR),
      expected: { freshness: "overdue", latest: "failed", ageMs: 12 * HOUR, errorCode: "timeout" },
    },
    {
      name: "a failure with a recent prior success",
      snapshot: failed(-HOUR, -2 * HOUR),
      expected: { freshness: "recent", latest: "failed", ageMs: 2 * HOUR, errorCode: "timeout" },
    },
  ])("reports independent saved, success, and attempt facts for $name", ({ snapshot, expected }) => {
    expect(catalogStatus("codex", snapshot, NOW_MS)).toMatchObject({ provider: "codex", automatic: true, ...expected });
  });

  it.each([
    { name: "an absent updatedAt", updatedAt: undefined },
    { name: "an invalid updatedAt", updatedAt: new Date(Number.NaN) },
    { name: "a future updatedAt", updatedAt: at(HOUR) },
    { name: "a string updatedAt", updatedAt: at(-HOUR).toISOString() },
  ])("does not invent a saved timestamp from $name", ({ updatedAt }) => {
    const status = catalogStatus("codex", { models: seededModels, source: "manual", updatedAt }, NOW_MS);
    expect(status).toMatchObject({ savedAt: undefined, source: "manual", seeded: true });
    expect(catalogStatusNote(status)).toContain("saved unknown/clock-inconsistent (manual)");
  });

  it.each([
    { name: "an invalid Date", lastSucceededAt: new Date(Number.NaN) },
    { name: "a future Date", lastSucceededAt: at(HOUR) },
    { name: "a string date", lastSucceededAt: at(-HOUR).toISOString() },
  ])("never reports false freshness or negative age for $name", ({ lastSucceededAt }) => {
    const base = succeeded();
    const status = catalogStatus("codex", { ...base, scan: { ...base.scan, lastSucceededAt } }, NOW_MS);
    expect(status).toMatchObject({
      succeededAt: undefined,
      ageMs: undefined,
      freshness: "unknown/clock-inconsistent",
      timingInconsistent: true,
    });
    expect(catalogStatusNote(status)).not.toContain("age -");
  });

  it("marks a succeeded outcome without lastSucceededAt as inconsistent and never fresh", () => {
    const base = succeeded();
    const scan: Record<string, unknown> = { ...base.scan };
    delete scan.lastSucceededAt;
    expect(catalogStatus("codex", { ...base, scan }, NOW_MS)).toMatchObject({
      freshness: "never",
      succeededAt: undefined,
      ageMs: undefined,
      timingInconsistent: true,
    });
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "invalid", value: new Date(Number.NaN) },
    { name: "future", value: at(HOUR) },
    { name: "a string", value: at(-HOUR).toISOString() },
  ])("marks a $name attempt start as inconsistent without scheduling from it", ({ value }) => {
    const base = succeeded();
    const status = catalogStatus("codex", { ...base, scan: { ...base.scan, startedAt: value } }, NOW_MS);
    expect(status).toMatchObject({ startedAt: undefined, nextAttemptAt: undefined, timingInconsistent: true });
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "invalid", value: new Date(Number.NaN) },
    { name: "future", value: at(HOUR) },
    { name: "a string", value: at(-HOUR).toISOString() },
  ])("marks a $name completion time as inconsistent", ({ value }) => {
    const base = succeeded();
    const status = catalogStatus("codex", { ...base, scan: { ...base.scan, finishedAt: value } }, NOW_MS);
    expect(status).toMatchObject({ finishedAt: undefined, latest: "succeeded", timingInconsistent: true });
  });

  it("marks completion before start as inconsistent", () => {
    const base = succeeded();
    const status = catalogStatus(
      "codex",
      { ...base, scan: { ...base.scan, startedAt: at(-HOUR), finishedAt: at(-2 * HOUR) } },
      NOW_MS,
    );
    expect(status).toMatchObject({
      startedAt: NOW_MS - HOUR,
      finishedAt: NOW_MS - 2 * HOUR,
      timingInconsistent: true,
    });
  });

  it("treats a null scan as present but unknown and inconsistent", () => {
    expect(catalogStatus("codex", { models: seededModels, scan: null }, NOW_MS)).toMatchObject({
      latest: "unknown",
      freshness: "never",
      timingInconsistent: true,
    });
  });
});

describe("status notes and purity", () => {
  it.each([
    { name: "unseeded", snapshot: {} },
    {
      name: "active",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(HOUR) },
      },
    },
    {
      name: "expired",
      snapshot: {
        models: seededModels,
        scan: { outcome: "running", startedAt: at(-HOUR), leaseExpiresAt: at(-HOUR / 2) },
      },
    },
    { name: "successful", snapshot: succeeded() },
    { name: "failed", snapshot: failed(-HOUR, -2 * HOUR) },
  ])("keeps pending export independent of $name scheduling and status", ({ snapshot }) => {
    const baselineDue = catalogDue(snapshot, NOW_MS, true);
    const baselineStatus = catalogStatus("codex", snapshot, NOW_MS);
    const withPending = { ...snapshot, pendingExport: undefined };
    expect(catalogDue(withPending, NOW_MS, true)).toEqual(baselineDue);
    expect(catalogStatus("codex", withPending, NOW_MS)).toEqual({ ...baselineStatus, recoveryPending: true });
    expect(catalogStatusNote(catalogStatus("codex", withPending, NOW_MS))).toContain("audit/change recovery pending");
  });

  it("renders the complete automatic unseeded note", () => {
    expect(catalogStatusNote(catalogStatus("claude", undefined, NOW_MS))).toBe(
      "claude: not yet seeded — manual option: agent_model_catalog_refresh; last discovery success never; latest attempt never; next normal attempt unknown/clock-inconsistent; automatic checks every 8h; discovery timestamps describe checks, not later manual edits.",
    );
  });

  it("renders plugin catalogs as manual without invented discovery timing", () => {
    const storedProviders = [...BUILTIN_CATALOG_PROVIDERS, "plugin-provider"];
    expect(storedProviders).not.toContain("gemini");
    const status = catalogStatus(
      "plugin-provider",
      { models: seededModels, source: "manual", updatedAt: at(-HOUR), pendingExport: {} },
      NOW_MS,
    );
    const note = catalogStatusNote(status);
    expect(status.automatic).toBe(false);
    expect(note).toBe(
      "plugin-provider: saved 2026-09-07T11:00:00.000Z (manual), 1 models; manually maintained; audit/change recovery pending.",
    );
    expect(note).not.toContain("discovery");
    expect(note).not.toContain("next normal attempt");
  });

  it.each([
    {
      name: "a recognized code and safe HTTP status",
      error: { code: "auth", message: "test-secret", body: "test-secret", httpStatus: 401 },
      expectedCode: "auth",
      expectedStatus: 401,
      expectedSuffix: "(auth HTTP 401)",
    },
    {
      name: "an unknown code and invalid HTTP status",
      error: {
        code: "unknown-test-secret",
        message: "test-secret",
        body: { token: "test-secret" },
        httpStatus: 999,
      },
      expectedCode: "storage",
      expectedStatus: undefined,
      expectedSuffix: "(storage)",
    },
  ])("sanitizes $name", ({ error, expectedCode, expectedStatus, expectedSuffix }) => {
    const base = failed(-HOUR, -2 * HOUR);
    const status = catalogStatus("codex", { ...base, scan: { ...base.scan, error } }, NOW_MS);
    const note = catalogStatusNote(status);
    expect(status).toMatchObject({ errorCode: expectedCode, httpStatus: expectedStatus });
    expect(note).toContain(expectedSuffix);
    expect(note).not.toContain("test-secret");
  });

  it("returns a fixed storage-unavailable note", () => {
    expect(catalogUnavailableNote("grok")).toBe("grok: catalog storage unavailable.");
  });

  it("does not mutate the persisted snapshot while deriving timing, due state, status, or notes", () => {
    const snapshot = {
      _id: "codex",
      provider: "codex",
      models: seededModels,
      source: "manual",
      updatedAt: at(-HOUR),
      scan: {
        outcome: "failed",
        startedAt: at(-2 * HOUR),
        finishedAt: at(-HOUR),
        lastSucceededAt: at(-3 * HOUR),
        leaseExpiresAt: at(-HOUR),
        error: { code: "timeout", message: "test-secret", body: { detail: "test-secret" } },
      },
      pendingExport: { version: { nested: at(-4 * HOUR) } },
    };
    const before = structuredClone(snapshot);

    catalogTiming(snapshot, NOW_MS);
    catalogDue(snapshot, NOW_MS, true);
    catalogStatusNote(catalogStatus("codex", snapshot, NOW_MS));

    expect(snapshot).toEqual(before);
  });
});
