import { describe, it, expect } from "vitest";
import { isAuthError } from "./voice-adapter.js";

describe("isAuthError", () => {
  it.each([
    "Could not resolve authentication method",
    "Expected ANTHROPIC_API_KEY or authToken",
    "Error reading credentials.json",
    "401 Unauthorized: token expired",
    "user not authenticated",
  ])("matches: %s", (msg) => {
    expect(isAuthError(new Error(msg))).toBe(true);
  });

  it.each(["ECONNREFUSED 127.0.0.1:6333", "Tool call failed", "Validation error: missing field"])(
    "does not match: %s",
    (msg) => {
      expect(isAuthError(new Error(msg))).toBe(false);
    },
  );

  it("handles non-Error throws via String() coercion", () => {
    expect(isAuthError("Could not resolve authentication method")).toBe(true);
    expect(isAuthError({ message: "Could not resolve authentication method" })).toBe(false); // String({...}) === "[object Object]"
  });
});
