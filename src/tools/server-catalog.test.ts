import { describe, it, expect } from "vitest";
import { SERVER_CATALOG, formatCatalogEntry, type ServerCatalogEntry } from "./server-catalog.js";

describe("SERVER_CATALOG", () => {
  it("contains entries for all commonly used servers", () => {
    const expected = ["google", "memory", "contacts", "slack", "brave-search", "resend", "keychain"];
    for (const name of expected) {
      expect(SERVER_CATALOG[name]).toBeDefined();
      expect(SERVER_CATALOG[name].description).toBeTruthy();
    }
  });

  it("every entry has a non-empty description", () => {
    for (const [name, entry] of Object.entries(SERVER_CATALOG)) {
      expect(entry.description, `${name} missing description`).toBeTruthy();
    }
  });
});

describe("formatCatalogEntry", () => {
  it("formats entry with description only", () => {
    const entry: ServerCatalogEntry = { description: "A simple tool" };
    expect(formatCatalogEntry("simple", entry)).toBe("- simple: A simple tool");
  });

  it("formats entry with usage hint", () => {
    const entry: ServerCatalogEntry = {
      description: "A useful tool",
      usage: "Doing useful things",
    };
    const result = formatCatalogEntry("useful", entry);
    expect(result).toBe("- useful: A useful tool\n  → Use for: Doing useful things.");
  });

  it("formats entry with usage and notFor hints", () => {
    const entry: ServerCatalogEntry = {
      description: "Search tool",
      usage: "Broad searches",
      notFor: "Specific lookups — use other-tool instead",
    };
    const result = formatCatalogEntry("search", entry);
    expect(result).toContain("- search: Search tool");
    expect(result).toContain("Use for: Broad searches.");
    expect(result).toContain("Not for: Specific lookups — use other-tool instead.");
  });

  it("formats entry with notFor but no usage", () => {
    const entry: ServerCatalogEntry = {
      description: "Limited tool",
      notFor: "Everything else",
    };
    const result = formatCatalogEntry("limited", entry);
    expect(result).toBe("- limited: Limited tool\n  → Not for: Everything else.");
  });
});
