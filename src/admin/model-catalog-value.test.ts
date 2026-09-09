import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import type { CatalogDoc, CatalogModel, CatalogVersion, ModelInput } from "./model-catalog-types.js";
import {
  CatalogError,
  checkBson,
  diffText,
  normalizedPayload,
  replacement,
  safeError,
  snapshotId,
} from "./model-catalog-value.js";

const MIB = 1024 * 1024;
const BSON_LIMIT = 16 * MIB;
const firstAddedAt = new Date("2026-01-02T03:04:05.000Z");
const replacedAt = new Date("2026-02-03T04:05:06.000Z");

function model(id: string, displayName = id, notes?: string, addedAt = firstAddedAt): CatalogModel {
  return { id, displayName, ...(notes === undefined ? {} : { notes }), addedAt };
}

function current(models?: CatalogModel[], revision?: number, hash?: string): CatalogDoc {
  return {
    _id: "claude",
    provider: "claude",
    ...(models === undefined ? {} : { models }),
    ...(revision === undefined ? {} : { revision }),
    ...(hash === undefined ? {} : { snapshotId: hash }),
  };
}

function expectCatalogError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected CatalogError");
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).safe.code).toBe(code);
  }
}

function payloadWithByteSize(size: number): ModelInput[] {
  const base: ModelInput[] = [{ id: "generated-id", displayName: "" }];
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  base[0]!.displayName = "x".repeat(size - overhead);
  expect(Buffer.byteLength(JSON.stringify(base), "utf8")).toBe(size);
  return base;
}

function baseBsonDoc(): CatalogDoc {
  const addedAt = new Date("2026-03-04T05:06:07.000Z");
  const snapshot = [model("generated-id", "Generated", undefined, addedAt)];
  const version: CatalogVersion = {
    _id: "commit-generated",
    provider: "claude",
    revision: 1,
    snapshotId: "hash-generated",
    source: "manual",
    updatedBy: "test-actor",
    createdAt: addedAt,
    bootstrap: true,
    added: ["generated-id"],
    removed: [],
    modelCount: 1,
    snapshot,
    changeSummary: "",
  };
  return {
    _id: "claude",
    provider: "claude",
    models: snapshot,
    pendingExport: { version },
  };
}

function bsonDocAtSize(target: number, field: "summary" | "scan"): CatalogDoc {
  const doc = baseBsonDoc();
  if (field === "scan") {
    doc.scan = {
      attemptId: "attempt-generated",
      startedAt: new Date("2026-03-04T05:06:07.000Z"),
      outcome: "failed",
      error: { code: "storage", message: "" },
    };
  }
  const initialSize = BSON.calculateObjectSize(doc);
  const filler = "x".repeat(target - initialSize);
  if (field === "summary") doc.pendingExport!.version.changeSummary = filler;
  else doc.scan!.error!.message = filler;
  expect(BSON.calculateObjectSize(doc)).toBe(target);
  return doc;
}

describe("normalizedPayload", () => {
  it.each([
    { name: "a non-array payload", rows: {} },
    { name: "an empty payload", rows: [] },
    {
      name: "duplicate ids",
      rows: [
        { id: "generated-a", displayName: "A" },
        { id: "generated-a", displayName: "Again" },
      ],
    },
    { name: "a padded id", rows: [{ id: " generated-a", displayName: "A" }] },
    { name: "a blank display name", rows: [{ id: "generated-a", displayName: "  " }] },
    { name: "non-string manual notes", rows: [{ id: "generated-a", displayName: "A", notes: 42 }], manual: true },
  ])("rejects $name", ({ rows, manual }) => {
    expectCatalogError(
      () => normalizedPayload("claude", rows, manual),
      rows instanceof Array && rows.length === 0 ? "empty" : "malformed",
    );
  });

  it("normalizes valid manual notes and omits empty notes", () => {
    expect(
      normalizedPayload(
        "claude",
        [
          { id: "generated-a", displayName: "Generated A", notes: "keep this" },
          { id: "generated-b", displayName: "Generated B", notes: "" },
        ],
        true,
      ),
    ).toEqual([
      { id: "generated-a", displayName: "Generated A", notes: "keep this" },
      { id: "generated-b", displayName: "Generated B" },
    ]);
  });

  it.each([
    { name: "exactly 1 MiB", size: MIB, accepted: true },
    { name: "one byte over 1 MiB", size: MIB + 1, accepted: false },
  ])("handles a UTF-8 payload $name", ({ size, accepted }) => {
    const rows = payloadWithByteSize(size);
    if (accepted) expect(normalizedPayload("claude", rows)).toEqual(rows);
    else expectCatalogError(() => normalizedPayload("claude", rows), "too-large");
  });
});

describe("snapshot identity", () => {
  it("hashes the exact provider, order, display names, and notes-or-null input", () => {
    const models = [
      { id: "generated-b", displayName: "Beta" },
      { id: "generated-a", displayName: "Alpha", notes: "manual note" },
    ];
    expect(snapshotId("claude", models)).toBe("5dceaac4656cd4bb5814d6674e574b581039dc90258953a6a4b264dc9c817e4b");
  });

  it.each([
    {
      name: "display name",
      input: [{ id: "generated-a", displayName: "Renamed", notes: "note" }],
    },
    {
      name: "notes",
      input: [{ id: "generated-a", displayName: "Alpha", notes: "new note" }],
    },
    {
      name: "order",
      input: [
        { id: "generated-b", displayName: "Beta" },
        { id: "generated-a", displayName: "Alpha", notes: "note" },
      ],
    },
  ])("changes for a $name-only difference", ({ input }) => {
    const baseline = [
      { id: "generated-a", displayName: "Alpha", notes: "note" },
      { id: "generated-b", displayName: "Beta" },
    ];
    expect(snapshotId("claude", input)).not.toBe(snapshotId("claude", baseline));
  });
});

describe("replacement", () => {
  it("preserves retained timestamps, timestamps new models, and retimestamps reintroduced models", () => {
    const result = replacement(
      current([model("generated-retained", "Old retained"), model("generated-removed", "Removed")], 4),
      "claude",
      [
        { id: "generated-retained", displayName: "Current retained" },
        { id: "generated-new", displayName: "New or reintroduced" },
      ],
      "manual",
      "test-actor",
      "commit-generated",
      replacedAt,
    );

    expect(result.fields.models).toEqual([
      model("generated-retained", "Current retained"),
      model("generated-new", "New or reintroduced", undefined, replacedAt),
    ]);
    expect(result.version).toMatchObject({
      revision: 5,
      bootstrap: false,
      added: ["generated-new"],
      removed: ["generated-removed"],
      changeSummary: "+1 (generated-new), -1 (generated-removed)",
    });
    expect(result.fields.pendingExport.change).toBeDefined();
  });

  it.each([
    { name: "omitted", replacement: { id: "generated-a", displayName: "A" } },
    { name: "empty", replacement: { id: "generated-a", displayName: "A", notes: "" } },
  ])("clears manual notes when they are $name", ({ replacement: row }) => {
    const result = replacement(
      current([model("generated-a", "A", "old note")], 1),
      "claude",
      [row],
      "manual",
      "test-actor",
      "commit-generated",
      replacedAt,
    );
    expect(result.fields.models[0]).not.toHaveProperty("notes");
  });

  it("preserves the latest persisted notes during discovery", () => {
    const result = replacement(
      current([model("generated-a", "A", "latest manual note")], 8),
      "claude",
      [{ id: "generated-a", displayName: "A from discovery", notes: "ignored discovery note" }],
      "discovery",
      "catalog-discovery",
      "attempt-generated",
      replacedAt,
    );
    expect(result.fields.models[0]).toMatchObject({ notes: "latest manual note", addedAt: firstAddedAt });
  });

  it.each([
    {
      name: "display name",
      previous: [model("generated-a", "Old")],
      input: [{ id: "generated-a", displayName: "New" }],
      source: "manual" as const,
    },
    {
      name: "notes",
      previous: [model("generated-a", "A", "old")],
      input: [{ id: "generated-a", displayName: "A", notes: "new" }],
      source: "manual" as const,
    },
    {
      name: "order",
      previous: [model("generated-a", "A"), model("generated-b", "B")],
      input: [
        { id: "generated-b", displayName: "B" },
        { id: "generated-a", displayName: "A" },
      ],
      source: "manual" as const,
    },
  ])("records a version but no membership change for a $name-only difference", ({ previous, input, source }) => {
    const result = replacement(
      current(previous, 2, snapshotId("claude", previous)),
      "claude",
      input,
      source,
      "test-actor",
      "commit-generated",
      replacedAt,
    );
    expect(result.unchanged).toBe(false);
    expect(result.version).toMatchObject({ added: [], removed: [], bootstrap: false });
    expect(result.fields.pendingExport.change).toBeUndefined();
  });

  it("detects an unchanged legacy document missing snapshotId and advances a missing revision", () => {
    const previous = [model("generated-a", "A", "note")];
    const result = replacement(
      current(previous),
      "claude",
      [{ id: "generated-a", displayName: "A", notes: "note" }],
      "manual",
      "test-actor",
      "commit-generated",
      replacedAt,
    );
    expect(result.unchanged).toBe(true);
    expect(result.version.revision).toBe(1);
  });

  it.each([
    { name: "absent models", doc: current() },
    { name: "an empty model list", doc: current([], 7) },
  ])("treats $name as bootstrap", ({ doc }) => {
    const result = replacement(
      doc,
      "claude",
      [{ id: "generated-a", displayName: "A" }],
      "manual",
      "test-actor",
      "commit-generated",
      replacedAt,
      "",
    );
    expect(result.version.bootstrap).toBe(true);
    expect(result.version.added).toEqual(["generated-a"]);
    expect(result.version.changeSummary).toBe("+1 (generated-a), -0");
    expect(result.fields.pendingExport.change).toEqual(
      expect.objectContaining({ _id: "commit-generated", bootstrap: true }),
    );
  });

  it("uses a nonempty supplied summary", () => {
    const result = replacement(
      null,
      "claude",
      [{ id: "generated-a", displayName: "A" }],
      "manual",
      "test-actor",
      "commit-generated",
      replacedAt,
      "operator summary",
    );
    expect(result.version.changeSummary).toBe("operator summary");
  });
});

describe("safe errors and BSON bounds", () => {
  it("constructs only the stable safe error message", () => {
    expect(safeError("claude", "http", 429)).toEqual({
      code: "http",
      message: "Model catalog claude: http (HTTP 429).",
      httpStatus: 429,
    });
  });

  it("formats deterministic membership diffs", () => {
    expect(diffText(["generated-a", "generated-b"], ["generated-c"])).toBe(
      "+2 (generated-a, generated-b), -1 (generated-c)",
    );
  });

  it.each([
    { field: "summary" as const, size: BSON_LIMIT - 1, accepted: true },
    { field: "summary" as const, size: BSON_LIMIT, accepted: false },
    { field: "scan" as const, size: BSON_LIMIT - 1, accepted: true },
    { field: "scan" as const, size: BSON_LIMIT, accepted: false },
  ])("handles a prospective BSON envelope with a large $field at $size bytes", ({ field, size, accepted }) => {
    const doc = bsonDocAtSize(size, field);
    if (accepted) expect(() => checkBson(doc)).not.toThrow();
    else expectCatalogError(() => checkBson(doc), "too-large");
  });
});
