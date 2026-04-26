import { describe, expect, it } from "vitest";
import { AGENT_ID_RENAME_MAP, isNewId, isOldId, newIdFor } from "./agent-id-rename-map.js";

describe("AGENT_ID_RENAME_MAP", () => {
  it("contains 10 renames", () => {
    expect(Object.keys(AGENT_ID_RENAME_MAP.rename)).toHaveLength(10);
  });

  it("includes nora as unchanged", () => {
    expect(AGENT_ID_RENAME_MAP.unchanged).toContain("nora");
  });

  it("newIdFor returns mapped values", () => {
    expect(newIdFor("chief-of-staff")).toBe("mokie");
    expect(newIdFor("vp-engineering")).toBe("jasper");
  });

  it("newIdFor returns undefined for unknown ids", () => {
    expect(newIdFor("nora")).toBeUndefined();
    expect(newIdFor("not-an-agent")).toBeUndefined();
  });

  it("isOldId true for known old ids", () => {
    expect(isOldId("chief-of-staff")).toBe(true);
    expect(isOldId("mokie")).toBe(false);
    expect(isOldId("nora")).toBe(false);
  });

  it("isNewId true for new ids and unchanged", () => {
    expect(isNewId("mokie")).toBe(true);
    expect(isNewId("nora")).toBe(true);
    expect(isNewId("chief-of-staff")).toBe(false);
  });

  it("rename targets are all distinct", () => {
    const targets = Object.values(AGENT_ID_RENAME_MAP.rename);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("no rename target collides with another rename source", () => {
    const sources = new Set(Object.keys(AGENT_ID_RENAME_MAP.rename));
    for (const target of Object.values(AGENT_ID_RENAME_MAP.rename)) {
      expect(sources.has(target)).toBe(false);
    }
  });
});
