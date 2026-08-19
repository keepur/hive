import { describe, it, expect } from "vitest";
import { describeError } from "./describe-error.js";

describe("describeError", () => {
  it("renders the full cause chain with codes", () => {
    const inner = Object.assign(new Error("invalid onError method"), {
      name: "InvalidArgumentError",
      code: "UND_ERR_INVALID_ARG",
    });
    const outer = new TypeError("fetch failed", { cause: inner });
    expect(describeError(outer)).toBe(
      "TypeError: fetch failed ← InvalidArgumentError: invalid onError method (UND_ERR_INVALID_ARG)",
    );
  });

  it("handles non-Error values", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(new Error("plain"))).toBe("Error: plain");
  });

  it("caps runaway cause chains", () => {
    const cyclic = new Error("a");
    cyclic.cause = cyclic;
    expect(describeError(cyclic).split(" ← ")).toHaveLength(5);
  });
});
