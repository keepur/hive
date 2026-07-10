import { describe, it, expect } from "vitest";
import {
  classifyTurnResult,
  classifyThrown,
  HARD_FAULT_KINDS,
  type ProviderFaultKind,
} from "./error-classification.js";

function faultKind(error: string): ProviderFaultKind {
  const c = classifyTurnResult({ error });
  if (c.outcome !== "fault") throw new Error(`expected fault, got ${c.outcome}`);
  return c.kind;
}

describe("classifyTurnResult (KPR-306)", () => {
  it("classifies timedOut + aborted as a timeout fault (precedence over aborted)", () => {
    expect(classifyTurnResult({ timedOut: true, aborted: true })).toEqual({
      outcome: "fault",
      kind: "timeout",
      message: "turn deadline exceeded",
    });
    // Even with an error string present, timeout wins.
    expect(classifyTurnResult({ timedOut: true, aborted: true, error: "whatever" })).toMatchObject({
      kind: "timeout",
      message: "whatever",
    });
  });

  it("classifies aborted-without-timedOut as neutral aborted", () => {
    expect(classifyTurnResult({ aborted: true })).toEqual({ outcome: "aborted" });
    expect(classifyTurnResult({ aborted: true, error: "ECONNREFUSED" })).toEqual({ outcome: "aborted" });
  });

  it("classifies no-error as success", () => {
    expect(classifyTurnResult({})).toEqual({ outcome: "success" });
    expect(classifyTurnResult({ error: "" })).toEqual({ outcome: "success" });
  });

  it.each([
    "connect ECONNREFUSED 127.0.0.1:443",
    "read ECONNRESET",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "connect ETIMEDOUT",
    "write EPIPE",
    "socket hang up",
    "TypeError: fetch failed",
    "network error while streaming",
    "terminated",
  ])("connect-fail: %s", (s) => expect(faultKind(s)).toBe("connect-fail"));

  it.each([
    "429 Too Many Requests",
    "rate limit exceeded",
    "rate-limited, retry later",
    "too many requests",
  ])("rate-limit: %s", (s) => expect(faultKind(s)).toBe("rate-limit"));

  it.each([
    "401 unauthorized-ish", // \b401\b
    "403 Forbidden",
    "authentication failure",
    "Unauthorized",
    "invalid api key",
    "invalid_api_key",
    "OAuth session is not available",
  ])("auth: %s", (s) => expect(faultKind(s)).toBe("auth"));

  // The auth row MUST be a superset of every isAuthRebuildResumeError
  // alternate (agent-manager.ts) — asserted individually so a sentinel
  // addition without a matching row extension fails here, not in prod.
  it.each([
    "could not resolve authentication",
    "missing credentials.json",
    "not authenticated",
    "401 Unauthorized",
    "ANTHROPIC_API_KEY is not set",
    "invalid authToken",
  ])("auth-rebuild sentinel alternate classifies auth (superset pin): %s", (s) =>
    expect(faultKind(s)).toBe("auth"),
  );

  it.each([
    "500 Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "Overloaded",
    "upstream connect error",
  ])("server-error: %s", (s) => expect(faultKind(s)).toBe("server-error"));

  it("classifies SDK result subtypes as non-provider (short-circuit)", () => {
    expect(faultKind("error_max_turns")).toBe("non-provider");
    expect(faultKind("error_during_execution")).toBe("non-provider");
  });

  it("classifies unknown strings as non-provider (fail-safe default)", () => {
    expect(faultKind("Something exploded in a tool handler")).toBe("non-provider");
    expect(faultKind("boom")).toBe("non-provider");
  });
});

describe("classifyThrown", () => {
  it("runs String(err) through the same tables", () => {
    const c = classifyThrown(new Error("fetch failed"));
    expect(c).toMatchObject({ outcome: "fault", kind: "connect-fail" });
  });

  it("defaults to non-provider", () => {
    expect(classifyThrown(new Error("weird"))).toMatchObject({ kind: "non-provider" });
    expect(classifyThrown(undefined)).toMatchObject({ kind: "non-provider" });
  });
});

describe("HARD_FAULT_KINDS", () => {
  it("contains every kind except non-provider", () => {
    expect([...HARD_FAULT_KINDS].sort()).toEqual(
      ["auth", "connect-fail", "rate-limit", "server-error", "timeout"].sort(),
    );
    expect(HARD_FAULT_KINDS.has("non-provider")).toBe(false);
  });
});
