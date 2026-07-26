import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_REGISTRY,
  allCredentialKeys,
  findCredentialEntry,
  findCredentialEntryByKey,
} from "./credential-registry.js";
import { SERVER_CATALOG } from "../tools/server-catalog.js";

// Plugin servers and pseudo-servers that aren't in the core catalog but are
// legitimate registry entries. Keep this list small and explicit so a typo in
// `server` doesn't slip through unnoticed.
const NON_CATALOG_SERVERS = new Set([
  "gemini", // file-ingestion vision, not its own MCP server
  "model-router", // pseudo-server: LLM complexity classifier (KPR-312), not an MCP server
  "kimi", // Lane A passthrough provider (KPR-346), not an MCP server
  "deepseek", // Lane A passthrough provider (KPR-346), not an MCP server
]);

describe("CREDENTIAL_REGISTRY", () => {
  it("has at least the curated set of integrations", () => {
    const servers = CREDENTIAL_REGISTRY.map((e) => e.server);
    for (const expected of [
      "brave-search",
      "linear",
      "github-issues",
      "clickup",
      "quo",
      "voice",
      "recall",
      "resend",
      "gemini",
      "google",
    ]) {
      expect(servers, `missing curated entry: ${expected}`).toContain(expected);
    }
  });

  it("every secret entry has at least one field", () => {
    for (const entry of CREDENTIAL_REGISTRY) {
      if (entry.kind === "secret") {
        expect(entry.fields.length, `entry for ${entry.server} has no fields`).toBeGreaterThan(0);
      }
    }
  });

  it("every oauth entry has oauthInstructions and no fields", () => {
    for (const entry of CREDENTIAL_REGISTRY) {
      if (entry.kind === "oauth") {
        expect(entry.fields, `${entry.server} should have empty fields`).toEqual([]);
        expect(entry.oauthInstructions, `${entry.server} missing oauthInstructions`).toBeTruthy();
      }
    }
  });

  it("all credential keys are unique across the registry", () => {
    const keys = allCredentialKeys();
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it("server names point at known MCP servers (or known non-catalog entries)", () => {
    const catalogKeys = new Set(Object.keys(SERVER_CATALOG));
    for (const entry of CREDENTIAL_REGISTRY) {
      if (NON_CATALOG_SERVERS.has(entry.server)) continue;
      expect(catalogKeys, `${entry.server} not in SERVER_CATALOG`).toContain(entry.server);
    }
  });

  it("every entry has a non-empty helpUrl and description", () => {
    for (const entry of CREDENTIAL_REGISTRY) {
      expect(entry.helpUrl, `${entry.server} missing helpUrl`).toBeTruthy();
      expect(entry.description, `${entry.server} missing description`).toBeTruthy();
    }
  });

  it("findCredentialEntry resolves by server name", () => {
    expect(findCredentialEntry("brave-search")?.title).toBe("Brave Search");
    expect(findCredentialEntry("nonexistent")).toBeUndefined();
  });

  it("findCredentialEntryByKey resolves by env var", () => {
    expect(findCredentialEntryByKey("LINEAR_API_KEY")?.server).toBe("linear");
    expect(findCredentialEntryByKey("GH_TOKEN")?.server).toBe("github-issues");
    expect(findCredentialEntryByKey("NONEXISTENT_KEY")).toBeUndefined();
  });
});
