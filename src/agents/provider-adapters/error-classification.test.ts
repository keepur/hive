import { describe, it, expect } from "vitest";
import {
  classifyTurnResult,
  classifyThrown,
  HARD_FAULT_KINDS,
  TurnAssemblyError,
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
    // KPR-352 §D7: the GeminiInteractionsAdapter missing-key throw — pinned
    // per the auth row's standing rule (alternates land with their sentinel).
    "Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY",
    // KPR-351 R1: the OpenAIAgentsAdapter missing-key throw — pinned per the
    // auth row's standing rule (alternates land with their sentinel). No row
    // edit needed: the existing `api.?key is not available` alternate matches.
    "OpenAI API key is not available; set OPENAI_API_KEY (hive credentials add OPENAI_API_KEY)",
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
  it("contains every kind except non-provider and bad-model", () => {
    expect([...HARD_FAULT_KINDS].sort()).toEqual(
      ["auth", "connect-fail", "rate-limit", "server-error", "timeout"].sort(),
    );
    expect(HARD_FAULT_KINDS.has("non-provider")).toBe(false);
  });
});

describe("bad-model (KPR-312 — KPR-310 verdict anomaly 1, M8)", () => {
  // Pinned VERBATIM, character-for-character, so pattern drift against the
  // observed SDK surface is caught (spec §6).
  const M8_ERROR =
    "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.";

  it("classifies the verbatim M8 string via classifyTurnResult", () => {
    expect(classifyTurnResult({ error: M8_ERROR })).toEqual({
      outcome: "fault",
      kind: "bad-model",
      message: M8_ERROR,
    });
  });

  it("classifies the verbatim M8 string via classifyThrown (the path M8 actually took)", () => {
    expect(classifyThrown(new Error(M8_ERROR))).toMatchObject({ kind: "bad-model" });
  });

  it("classifies the FULL observed M8 throw shape (SDK wrapper prefix + M8 text)", () => {
    // The observed throw wraps the M8 text — classifyThrown String()s it into
    // "Error: Claude Code returned an error result: <M8 text>"; the row must
    // match inside that envelope, not only the bare substring.
    expect(
      classifyThrown(new Error(`Claude Code returned an error result: ${M8_ERROR}`)),
    ).toMatchObject({ kind: "bad-model" });
  });

  it("matches each alternate independently", () => {
    expect(faultKind("issue with the selected model")).toBe("bad-model");
    expect(faultKind("It may not exist or you may not have access to it")).toBe("bad-model");
  });

  it("is never breaker-eligible", () => {
    expect(HARD_FAULT_KINDS.has("bad-model")).toBe(false);
  });

  it("is the LAST row — earlier rows keep precedence on overlapping strings", () => {
    // A string matching both server-error and bad-model classifies server-error
    // (first match wins), proving the appended row cannot re-bucket old inputs.
    expect(faultKind("503 issue with the selected model")).toBe("server-error");
  });
});

describe("TurnAssemblyError (KPR-347 §D6)", () => {
  it("a wrapped Mongo ECONNREFUSED classifies non-provider — the instanceof pre-check beats the pattern tables", () => {
    const msg = "connect ECONNREFUSED 127.0.0.1:27017";
    expect(classifyThrown(new TurnAssemblyError(msg, { cause: new Error(msg) }))).toEqual({
      outcome: "fault", kind: "non-provider", message: msg,
    });
    // Contrast case: the SAME message unwrapped pattern-matches connect-fail —
    // proving the type, not string luck, carries the classification.
    expect(classifyThrown(new Error(msg))).toMatchObject({ outcome: "fault", kind: "connect-fail" });
  });
});

describe("KPR-350 §D3 — stale-resume strings stay non-provider (no 404 row, ever)", () => {
  it.each([
    "Previous response with id 'resp_abc123' not found.",
    "400 invalid_request_error: previous_response_id 'resp_x' not found",
    "Previous response resp_9 has expired",
  ])("classifies non-provider: %s", (error) => {
    expect(classifyTurnResult({ error })).toEqual({
      outcome: "fault",
      kind: "non-provider",
      message: error,
    });
  });
});
