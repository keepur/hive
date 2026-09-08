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
    mongo.find.mockImplementation(() => ({ toArray: mongo.toArray }));
    mongo.forbiddenWrite.mockImplementation(() => {
      throw new Error("doctor catalog adapter attempted a write");
    });
    mongo.collection.mockImplementation(() => ({
      find: mongo.find,
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
    expect(mongo.MongoClient).toHaveBeenCalledWith("mongodb://doctor", { serverSelectionTimeoutMS: 2000 });
    expect(mongo.connect).toHaveBeenCalledTimes(1);
    expect(mongo.db).toHaveBeenCalledWith("hive_doctor");
    expect(mongo.collection).toHaveBeenCalledWith("agent_model_catalog");
    expect(mongo.find).toHaveBeenCalledWith({ _id: { $ne: "gemini" } });
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
