import { describe, it, expect, vi } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../config.js", () => ({
  config: {},
}));

import { parseClassifierOutput } from "./meeting-classifier.js";

describe("parseClassifierOutput", () => {
  const validIds = new Set(["jasper", "river", "jessica"]);

  it("parses valid JSON response", () => {
    const result = parseClassifierOutput(
      '{ "respond": ["jasper", "river"] }',
      validIds,
    );
    expect(result).toEqual(["jasper", "river"]);
  });

  it("extracts JSON from surrounding text", () => {
    const result = parseClassifierOutput(
      'Here is my answer: { "respond": ["jasper"] } hope that helps',
      validIds,
    );
    expect(result).toEqual(["jasper"]);
  });

  it("filters out invalid agent IDs", () => {
    const result = parseClassifierOutput(
      '{ "respond": ["jasper", "nonexistent"] }',
      validIds,
    );
    expect(result).toEqual(["jasper"]);
  });

  it("returns null for unparseable text", () => {
    const result = parseClassifierOutput(
      "I think jasper should respond",
      validIds,
    );
    expect(result).toBeNull();
  });

  it("returns null for empty text", () => {
    const result = parseClassifierOutput("", validIds);
    expect(result).toBeNull();
  });

  it("handles respond field that is not an array", () => {
    const result = parseClassifierOutput('{ "respond": "jasper" }', validIds);
    expect(result).toBeNull();
  });

  it("returns empty array when all IDs are invalid", () => {
    const result = parseClassifierOutput(
      '{ "respond": ["nonexistent"] }',
      validIds,
    );
    expect(result).toEqual([]);
  });
});
