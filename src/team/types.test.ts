import { describe, it, expect } from "vitest";
import { dmChannelId, internalChannelId } from "./types.js";

describe("dmChannelId", () => {
  it("sorts participants lexicographically", () => {
    expect(dmChannelId("jessica", "device-1")).toBe("dm:device-1:jessica");
    expect(dmChannelId("device-1", "jessica")).toBe("dm:device-1:jessica");
  });

  it("produces stable IDs regardless of argument order", () => {
    expect(dmChannelId("a", "b")).toBe(dmChannelId("b", "a"));
  });
});

describe("internalChannelId", () => {
  it("sorts agents lexicographically", () => {
    expect(internalChannelId("jessica", "sige")).toBe("internal:jessica:sige");
    expect(internalChannelId("sige", "jessica")).toBe("internal:jessica:sige");
  });

  it("produces stable IDs regardless of argument order", () => {
    expect(internalChannelId("a", "b")).toBe(internalChannelId("b", "a"));
  });
});
