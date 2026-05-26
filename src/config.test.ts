import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeGoogleAccounts, warnIfLegacyGoogleAccount } from "./config.js";

describe("normalizeGoogleAccounts (KPR-242)", () => {
  it("returns an empty record for undefined or non-object input", () => {
    expect(normalizeGoogleAccounts(undefined)).toEqual({});
    expect(normalizeGoogleAccounts(null)).toEqual({});
    expect(normalizeGoogleAccounts("not an object")).toEqual({});
    expect(normalizeGoogleAccounts(42)).toEqual({});
  });

  it("returns an empty record for array input (typeof [] === 'object' edge case)", () => {
    // YAML maps can't produce arrays at this position, but the input is `unknown` —
    // lock the invariant defensively so a future caller can't smuggle in `[]`
    // or `[["agent", "email"]]` and get stringly-keyed garbage out.
    expect(normalizeGoogleAccounts([])).toEqual({});
    expect(normalizeGoogleAccounts([["agent", "a@x.com"]])).toEqual({});
  });

  it("normalizes a string-valued account entry to a one-element array", () => {
    expect(normalizeGoogleAccounts({ rae: "rae@dodihome.com" })).toEqual({
      rae: ["rae@dodihome.com"],
    });
  });

  it("preserves an array-valued account entry and its order", () => {
    const input = {
      mokie: ["may@dodihome.com", "may.huang@gmail.com", "may@keepur.io"],
    };
    expect(normalizeGoogleAccounts(input)).toEqual({
      mokie: ["may@dodihome.com", "may.huang@gmail.com", "may@keepur.io"],
    });
  });

  it("trims whitespace from string and array entries", () => {
    expect(normalizeGoogleAccounts({ rae: "  rae@dodihome.com  " })).toEqual({
      rae: ["rae@dodihome.com"],
    });
    expect(normalizeGoogleAccounts({ mokie: ["  a@x.com", "b@x.com  "] })).toEqual({
      mokie: ["a@x.com", "b@x.com"],
    });
  });

  it("drops empty strings and non-string array entries", () => {
    expect(normalizeGoogleAccounts({ rae: "" })).toEqual({});
    expect(normalizeGoogleAccounts({ mokie: ["", "  ", "a@x.com"] })).toEqual({
      mokie: ["a@x.com"],
    });
    expect(normalizeGoogleAccounts({ mokie: [null, 42, "a@x.com"] as unknown[] })).toEqual({
      mokie: ["a@x.com"],
    });
  });

  it("drops an agent whose array reduces to empty", () => {
    expect(normalizeGoogleAccounts({ mokie: ["", "  "] })).toEqual({});
  });
});

describe("warnIfLegacyGoogleAccount (KPR-242)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when legacy `google.account` is present", () => {
    warnIfLegacyGoogleAccount({ google: { account: "legacy@example.com" } });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("`google.account` is deprecated");
  });

  it("does not warn when `google.account` is absent", () => {
    warnIfLegacyGoogleAccount({ google: { accounts: { rae: "rae@x.com" } } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when `google` is absent entirely", () => {
    warnIfLegacyGoogleAccount({});
    warnIfLegacyGoogleAccount(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when `google` is non-object", () => {
    warnIfLegacyGoogleAccount({ google: "not an object" } as unknown as Record<string, unknown>);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
