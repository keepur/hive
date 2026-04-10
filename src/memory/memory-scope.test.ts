import { describe, it, expect } from "vitest";
import { parseScopesEnv, ScopeRouter } from "./memory-scope.js";

describe("parseScopesEnv", () => {
  it("returns [] when unset", () => {
    expect(parseScopesEnv(undefined)).toEqual([]);
    expect(parseScopesEnv("")).toEqual([]);
  });

  it("parses a valid mixed list", () => {
    const json = JSON.stringify([
      { id: "self", backing: "mongo" },
      { id: "workshop", backing: "filesystem", dir: "/Users/mokie/dev-mem" },
    ]);
    const parsed = parseScopesEnv(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].dir).toBe("/Users/mokie/dev-mem");
  });

  it("rejects filesystem scope without dir", () => {
    const json = JSON.stringify([{ id: "workshop", backing: "filesystem" }]);
    expect(() => parseScopesEnv(json)).toThrow();
  });

  it("rejects filesystem scope with relative dir", () => {
    const json = JSON.stringify([
      { id: "workshop", backing: "filesystem", dir: "rel" },
    ]);
    expect(() => parseScopesEnv(json)).toThrow();
  });

  it("rejects unknown backing", () => {
    const json = JSON.stringify([{ id: "x", backing: "redis" }]);
    expect(() => parseScopesEnv(json)).toThrow();
  });
});

describe("ScopeRouter", () => {
  it("lists scope ids and returns fs stores for filesystem scopes", () => {
    const router = new ScopeRouter([
      { id: "self", backing: "mongo" },
      { id: "workshop", backing: "filesystem", dir: "/tmp/non-existent-xyz" },
    ]);
    expect(router.scopeIds()).toEqual(["self", "workshop"]);
    expect(router.fsStore("self")).toBeUndefined();
    expect(router.fsStore("workshop")).toBeDefined();
  });

  it("requireFs throws with valid list on unknown scope", () => {
    const router = new ScopeRouter([
      { id: "workshop", backing: "filesystem", dir: "/tmp/x" },
    ]);
    expect(() => router.requireFs("typo")).toThrow(/typo.*workshop/);
  });
});
