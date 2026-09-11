import { describe, it, expect } from "vitest";
import { classifyToolError, TOOL_ERROR_TOKENS } from "./error-tokens.js";

describe("classifyToolError (KPR-454 D6)", () => {
  it("is total and closed over TOOL_ERROR_TOKENS", () => {
    const inputs = [
      "",
      "x",
      "ETIMEDOUT",
      "The tool call was interrupted before a result was received",
      "ECONNREFUSED 127.0.0.1:27017",
      "no such file",
      "invalid input: expected string",
      "permission denied",
      "429 Too Many Requests",
      "502 Bad Gateway",
      "\x00￿",
      "a".repeat(10_000),
    ];
    for (const input of inputs) {
      expect(TOOL_ERROR_TOKENS as readonly string[]).toContain(classifyToolError(input));
    }
  });

  it("reads typed signals before any text test", () => {
    expect(classifyToolError("operation timed out", { isInterrupt: true })).toBe("interrupted");
    expect(classifyToolError("something", { mcpErrorCode: -32602 })).toBe("invalid-input");
    expect(classifyToolError("something", { mcpErrorCode: -32601 })).toBe("not-found");
  });

  it("maps the MCP SDK's own request timeout (-32001) — the bridge's TOOL_CALL_TIMEOUT_MS path", () => {
    expect(classifyToolError("weird vendor failure #7719", { mcpErrorCode: -32001 })).toBe("timeout");
  });

  it("classifies an MCP transport death (-32000 ConnectionClosed) as transport-unavailable", () => {
    expect(classifyToolError("MCP error -32000: Connection closed")).toBe("transport-unavailable");
    expect(classifyToolError("MCP error -32000: Request was cancelled")).toBe("unclassified");
  });

  it("an unmapped JSON-RPC code falls through to the text rules, never to a guess", () => {
    expect(classifyToolError("ECONNREFUSED 127.0.0.1:1", { mcpErrorCode: -32603 })).toBe("transport-unavailable");
    expect(classifyToolError("weird vendor failure #7719", { mcpErrorCode: -32603 })).toBe("unclassified");
  });

  it("detects the KPR-438 background-subagent signature", () => {
    expect(classifyToolError("The tool call was interrupted before a result was received")).toBe("interrupted");
  });

  it("returns `unclassified` rather than guessing", () => {
    expect(classifyToolError("weird vendor failure #7719")).toBe("unclassified");
  });

  it("runs the text rules over a BOUNDED prefix — both lanes hand it an unbounded message", () => {
    // `observeToolFailure` is synchronous on the turn thread and the message is
    // unbounded at both capture points (Lane B's `errorText(err)` can carry a
    // whole tool payload), so the eight rules must not be O(8·n) of turn
    // latency. Asserted by BEHAVIOUR, not by timing: a signature inside the
    // 4096-char window classifies, the same signature past it does not.
    const filler = "x".repeat(4000);
    expect(classifyToolError(`${filler} ECONNREFUSED 127.0.0.1:27017`)).toBe("transport-unavailable");
    expect(classifyToolError(`${"x".repeat(5000)} ECONNREFUSED 127.0.0.1:27017`)).toBe("unclassified");

    // Exactly at the boundary: the cap is a slice of the first 4096 chars, so
    // a signature ending on char 4096 still classifies.
    const head = "y".repeat(4096 - " ETIMEDOUT".length);
    expect(classifyToolError(`${head} ETIMEDOUT`)).toBe("timeout");
  });

  it("a typed signal still wins over a message longer than the text cap", () => {
    // The signals are read BEFORE the slice, so capping the text can never
    // cost a fact the caller supplied.
    expect(classifyToolError("z".repeat(100_000), { isInterrupt: true })).toBe("interrupted");
    expect(classifyToolError("z".repeat(100_000), { mcpErrorCode: -32001 })).toBe("timeout");
  });

  it("stays TOTAL for a non-string message — classifies, never throws", () => {
    // `message` is typed `string` and validated nowhere on the way here: the
    // Claude lane arrives through an unchecked `input as
    // PostToolUseFailureHookInput` on a repo whose SDK floats above the
    // lockfile. A throw here would be contained by `observeToolFailure` into a
    // warn and NO RECORDED FAILURE — a silent coverage hole in the producer
    // that exists to close silent coverage holes — so the cap must not have
    // introduced one. Each case asserts a TOKEN, not merely "did not throw".
    const nonStrings: ReadonlyArray<[string, unknown, string]> = [
      ["undefined", undefined, "unclassified"],
      ["null", null, "unclassified"],
      ["a number", 500, "unclassified"],
      ["a plain object", {}, "unclassified"],
      // Coercion is preserved rather than short-circuited to "", so an SDK that
      // hands the Error instead of its `.message` still classifies off it —
      // exactly what `pattern.test(message)` did before the cap existed.
      ["an Error", new Error("ECONNREFUSED 127.0.0.1:27017"), "transport-unavailable"],
      // The clamp runs AFTER coercion, so a long toString() cannot escape it.
      [
        "an object whose toString is past the cap",
        { toString: () => `${"x".repeat(5000)} ECONNREFUSED 127.0.0.1:27017` },
        "unclassified",
      ],
      // No primitive conversion at all: unclassifiable, still not a throw.
      ["a null-prototype object", Object.create(null), "unclassified"],
      [
        "a throwing toString",
        {
          toString: () => {
            throw new Error("nope");
          },
        },
        "unclassified",
      ],
    ];
    for (const [label, value, expected] of nonStrings) {
      expect(() => classifyToolError(value as unknown as string), label).not.toThrow();
      expect(classifyToolError(value as unknown as string), label).toBe(expected);
    }
    // The typed signals are read before the text is touched at all, so they
    // survive a non-string message too.
    expect(classifyToolError(undefined as unknown as string, { isInterrupt: true })).toBe("interrupted");
  });

  it("returns a member of the closed nine-value set, so no input byte can ride out (C13)", () => {
    for (const input of [
      "auth failed for sk-ant-api03-DEADBEEF at /Users/mokie/.env",
      "operation timed out after 600000ms",
      "Bearer eyJhbGciOi… rate limit exceeded",
      "",
    ]) {
      const token = classifyToolError(input);
      expect(
        TOOL_ERROR_TOKENS.some((t) => t === token),
        input,
      ).toBe(true);
      expect(token.length).toBeLessThanOrEqual(Math.max(...TOOL_ERROR_TOKENS.map((t) => t.length)));
    }
  });
});
