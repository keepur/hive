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
