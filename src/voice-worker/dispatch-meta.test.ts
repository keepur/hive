import { describe, expect, it } from "vitest";
import { parseDispatchMetadata } from "./dispatch-meta.js";

describe("parseDispatchMetadata (KPR-322)", () => {
  it("returns {} for empty or missing input", () => {
    expect(parseDispatchMetadata(undefined)).toEqual({});
    expect(parseDispatchMetadata("")).toEqual({});
  });

  it("returns {} for invalid JSON", () => {
    expect(parseDispatchMetadata("{not json")).toEqual({});
  });

  it("returns {} for non-object JSON", () => {
    expect(parseDispatchMetadata("[]")).toEqual({});
    expect(parseDispatchMetadata("null")).toEqual({});
    expect(parseDispatchMetadata('"x"')).toEqual({});
  });

  it("returns the parsed object", () => {
    expect(parseDispatchMetadata('{"hive_agent_id":"luna","stt":"deepgram/nova-3"}')).toEqual({
      hive_agent_id: "luna",
      stt: "deepgram/nova-3",
    });
  });
});
