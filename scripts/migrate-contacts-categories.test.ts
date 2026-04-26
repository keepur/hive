import { describe, expect, it } from "vitest";
import { categorizeContact, pickKeeper } from "./migrate-contacts-categories.js";

const TEAM = new Set(["may@dodihome.com", "corey@dodihome.com"]);

describe("categorizeContact", () => {
  it("team-email match wins over hubspot source (precedence 1 > 2)", () => {
    expect(categorizeContact({ email: "MAY@DODIHOME.COM", source: "hubspot" }, TEAM)).toBe("team-human");
  });
  it("hubspot source → customer when no team match", () => {
    expect(categorizeContact({ email: "stranger@example.com", source: "hubspot" }, TEAM)).toBe("customer");
  });
  it("non-hubspot, non-team → customer (default)", () => {
    expect(categorizeContact({ email: "manual@x.com", source: "manual" }, TEAM)).toBe("customer");
  });
  it("null email + non-hubspot → customer", () => {
    expect(categorizeContact({ email: null, source: "manual" }, TEAM)).toBe("customer");
  });
  it("case-insensitive email match", () => {
    expect(categorizeContact({ email: "Corey@DodiHome.com", source: "manual" }, TEAM)).toBe("team-human");
  });
});

describe("pickKeeper", () => {
  it("returns the most recently updated row", () => {
    const a = { id: "a", updatedAt: new Date("2026-01-01") };
    const b = { id: "b", updatedAt: new Date("2026-04-01") };
    const c = { id: "c", updatedAt: new Date("2026-02-01") };
    expect(pickKeeper([a, b, c]).id).toBe("b");
  });
  it("undefined updatedAt sorts to oldest", () => {
    const a: { id: string; updatedAt?: Date } = { id: "a" };
    const b: { id: string; updatedAt?: Date } = { id: "b", updatedAt: new Date("2026-01-01") };
    expect(pickKeeper([a, b]).id).toBe("b");
  });
});
