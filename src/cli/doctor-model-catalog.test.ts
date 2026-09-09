import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mongo = vi.hoisted(() => ({
  MongoClient: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  db: vi.fn(),
  collection: vi.fn(),
  find: vi.fn(),
  toArray: vi.fn(),
  outboxFind: vi.fn(),
  outboxToArray: vi.fn(),
  forbiddenWrite: vi.fn(),
}));

vi.mock("mongodb", () => ({ MongoClient: mongo.MongoClient }));

import { catalogStatus, catalogStatusNote } from "../admin/model-catalog-status.js";
import { modelCatalogsForDoctor } from "./doctor-checks.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe("modelCatalogsForDoctor", () => {
  beforeEach(() => {
    for (const mock of Object.values(mongo)) mock.mockReset();
    mongo.connect.mockResolvedValue(undefined);
    mongo.close.mockResolvedValue(undefined);
    mongo.toArray.mockResolvedValue([]);
    mongo.outboxToArray.mockResolvedValue([]);
    mongo.find.mockImplementation(() => ({ toArray: mongo.toArray }));
    mongo.outboxFind.mockImplementation((filter: { provider?: { $ne?: string } } = {}) => ({
      async *[Symbol.asyncIterator]() {
        for (const row of await mongo.outboxToArray()) {
          if (filter.provider?.$ne !== undefined && row.provider === filter.provider.$ne) continue;
          yield row;
        }
      },
    }));
    mongo.forbiddenWrite.mockImplementation(() => {
      throw new Error("doctor catalog adapter attempted a write");
    });
    mongo.collection.mockImplementation((name: string) => ({
      find: name === "agent_model_catalog_changes" ? mongo.outboxFind : mongo.find,
      createIndex: mongo.forbiddenWrite,
      insertOne: mongo.forbiddenWrite,
      updateOne: mongo.forbiddenWrite,
      deleteOne: mongo.forbiddenWrite,
    }));
    mongo.db.mockImplementation(() => ({ collection: mongo.collection }));
    mongo.MongoClient.mockImplementation(function () {
      return {
        connect: mongo.connect,
        db: mongo.db,
        close: mongo.close,
      };
    });
  });

  it("returns all built-ins in stable order after an empty successful read", async () => {
    const report = await modelCatalogsForDoctor("mongodb://doctor", "hive_doctor", NOW.getTime());

    expect(report.kind).toBe("available");
    if (report.kind !== "available") throw new Error("expected available report");
    expect(report.rows.map((row) => row.provider)).toEqual(["claude", "grok", "codex"]);
    expect(report.rows.every((row) => !row.seeded && row.freshness === "never")).toBe(true);
    expect(report.notifications).toEqual({ kind: "available", rows: [] });
    expect(mongo.MongoClient).toHaveBeenCalledWith("mongodb://doctor", { serverSelectionTimeoutMS: 2000 });
    expect(mongo.connect).toHaveBeenCalledTimes(1);
    expect(mongo.db).toHaveBeenCalledWith("hive_doctor");
    expect(mongo.db).toHaveBeenCalledTimes(1);
    expect(mongo.collection).toHaveBeenCalledWith("agent_model_catalog");
    expect(mongo.collection).toHaveBeenCalledWith("agent_model_catalog_changes");
    expect(mongo.find).toHaveBeenCalledWith({ _id: { $ne: "gemini" } });
    expect(mongo.outboxFind).toHaveBeenCalledWith({ provider: { $ne: "gemini" } }, { projection: expect.any(Object) });
    expect(mongo.close).toHaveBeenCalledTimes(1);
    expect(mongo.forbiddenWrite).not.toHaveBeenCalled();
  });

  it("adds stored plugins lexically as manual rows, excludes Gemini, and preserves durable dates", async () => {
    const codex = {
      _id: "codex",
      provider: "codex",
      models: [{ id: "gpt-5.5", displayName: "GPT-5.5", addedAt: at(-24 * HOUR) }],
      source: "manual",
      updatedAt: at(-HOUR),
      scan: {
        outcome: "failed",
        startedAt: at(-2 * HOUR),
        finishedAt: at(-HOUR),
        lastSucceededAt: at(-9 * HOUR),
        error: { code: "auth", message: "test-secret", httpStatus: 401 },
      },
    };
    const sol = {
      _id: "sol",
      provider: "sol",
      models: [{ id: "sol-2", displayName: "Sol 2", addedAt: at(-24 * HOUR) }],
      source: "manual",
      updatedAt: at(-2 * HOUR),
      pendingExport: {},
    };
    const alpha = { _id: "alpha", provider: "alpha", models: [], source: "manual", updatedAt: at(-HOUR) };
    mongo.toArray.mockResolvedValue([sol, { _id: "gemini", models: [{ id: "ignored" }] }, codex, alpha, { _id: 7 }]);

    const report = await modelCatalogsForDoctor("mongodb://doctor", "hive_doctor", NOW.getTime());

    expect(report.kind).toBe("available");
    if (report.kind !== "available") throw new Error("expected available report");
    expect(report.rows.map((row) => row.provider)).toEqual(["claude", "grok", "codex", "alpha", "sol"]);
    expect(report.rows.map((row) => row.provider)).not.toContain("gemini");
    const codexRow = report.rows.find((row) => row.provider === "codex")!;
    expect(codexRow).toMatchObject({
      automatic: true,
      source: "manual",
      savedAt: at(-HOUR).getTime(),
      succeededAt: at(-9 * HOUR).getTime(),
      freshness: "overdue",
      latest: "failed",
      errorCode: "auth",
      httpStatus: 401,
    });
    expect(catalogStatusNote(codexRow)).toBe(catalogStatusNote(catalogStatus("codex", codex, NOW.getTime())));
    expect(catalogStatusNote(codexRow)).not.toContain("test-secret");
    const solRow = report.rows.find((row) => row.provider === "sol")!;
    expect(solRow).toMatchObject({ automatic: false, source: "manual", recoveryPending: true });
    expect(catalogStatusNote(solRow)).toBe(catalogStatusNote(catalogStatus("sol", sol, NOW.getTime())));
    expect(catalogStatusNote(solRow)).toContain("manually maintained");
    expect(catalogStatusNote(solRow)).not.toContain("discovery");
    expect(report.notifications).toEqual({ kind: "available", rows: [] });
    expect(mongo.forbiddenWrite).not.toHaveBeenCalled();
  });

  it("keeps catalog facts available when only the outbox read fails", async () => {
    mongo.outboxToArray.mockRejectedValue(new Error("test-secret outbox failure"));

    const report = await modelCatalogsForDoctor("mongodb://doctor", "hive_doctor", NOW.getTime());

    expect(report.kind).toBe("available");
    if (report.kind !== "available") throw new Error("expected available report");
    expect(report.rows.map((row) => row.provider)).toEqual(["claude", "grok", "codex"]);
    expect(report.notifications).toEqual({ kind: "unavailable" });
    expect(mongo.close).toHaveBeenCalledTimes(1);
    expect(mongo.forbiddenWrite).not.toHaveBeenCalled();
  });

  it("streams projected outbox-only plugin and future-intent timing on the same temporary database", async () => {
    mongo.outboxToArray.mockResolvedValue([
      {
        _id: "sol-change",
        provider: "sol",
        createdAt: at(-HOUR),
        delivery: { state: "pending", attempts: 0, nextAttemptAt: at(-1) },
      },
      {
        _id: "codex-future-intent",
        provider: "codex",
        createdAt: at(-HOUR),
        delivery: {
          state: "claimed",
          attempts: 1,
          nextAttemptAt: at(-HOUR),
          preparation: {
            id: "preparation-1",
            binding: {
              agentId: "chief",
              homeBase: "catalog-alerts",
              adapterId: "slack",
              channelId: "C123ABC",
            },
            processedAt: at(-30 * 60 * 1000),
          },
          claim: {
            token: "claim-1",
            owner: "notifier-1",
            startedAt: at(-30 * 60 * 1000),
            leaseExpiresAt: at(HOUR),
            stage: "sending",
            sendIntent: {
              preparationId: "preparation-1",
              startedAt: at(HOUR / 2),
              previouslyUncertain: false,
            },
          },
        },
      },
      {
        _id: "gemini-change",
        provider: "gemini",
        createdAt: at(-HOUR),
        delivery: { state: "pending", attempts: 0, nextAttemptAt: at(-1) },
      },
    ]);

    const report = await modelCatalogsForDoctor("mongodb://doctor", "hive_doctor", NOW.getTime());

    expect(report.kind).toBe("available");
    if (report.kind !== "available" || report.notifications.kind !== "available") {
      throw new Error("expected available reports");
    }
    expect(report.notifications.rows.map((row) => row.provider)).toEqual(["codex", "sol"]);
    expect(report.notifications.rows.find((row) => row.provider === "codex")).toMatchObject({
      claimed: 1,
      prepared: 1,
      uncertain: 1,
      timingTrouble: true,
    });
    expect(mongo.MongoClient).toHaveBeenCalledTimes(1);
    expect(mongo.db).toHaveBeenCalledTimes(1);
    expect(mongo.forbiddenWrite).not.toHaveBeenCalled();
  });

  it("returns unavailable and closes the client when connection fails", async () => {
    mongo.connect.mockRejectedValue(new Error("test-secret connection failure"));

    await expect(modelCatalogsForDoctor("mongodb://doctor", "hive_doctor")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(mongo.close).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable and closes the client when the catalog read fails", async () => {
    mongo.toArray.mockRejectedValue(new Error("test-secret read failure"));

    await expect(modelCatalogsForDoctor("mongodb://doctor", "hive_doctor")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(mongo.close).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when MongoClient construction fails", async () => {
    mongo.MongoClient.mockImplementationOnce(function () {
      throw new Error("test-secret constructor failure");
    });

    await expect(modelCatalogsForDoctor("mongodb://doctor", "hive_doctor")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(mongo.connect).not.toHaveBeenCalled();
    expect(mongo.close).not.toHaveBeenCalled();
  });

  it("swallows close failure without replacing an available result", async () => {
    mongo.close.mockRejectedValue(new Error("test-secret close failure"));

    const report = await modelCatalogsForDoctor("mongodb://doctor", "hive_doctor", NOW.getTime());

    expect(report.kind).toBe("available");
    expect(mongo.close).toHaveBeenCalledTimes(1);
  });

  it("swallows close failure without replacing an unavailable read result", async () => {
    mongo.toArray.mockRejectedValue(new Error("test-secret read failure"));
    mongo.close.mockRejectedValue(new Error("test-secret close failure"));

    await expect(modelCatalogsForDoctor("mongodb://doctor", "hive_doctor")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(mongo.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the pure status dependency free of runtime config, SDK, store, scanner, and discovery imports", () => {
    const statusSource = readFileSync(join(import.meta.dirname, "../admin/model-catalog-status.ts"), "utf8");
    expect(statusSource).not.toMatch(/\.\/model-catalog-(?:store|scanner|discovery|value)|\.\.\/config|agent-sdk/);
  });
});
