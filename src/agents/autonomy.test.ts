import { describe, it, expect } from "vitest";
import { resolveAutonomy, AUTONOMY_DEFAULTS } from "./autonomy.js";

describe("resolveAutonomy", () => {
  it("returns hardcoded defaults when no overrides provided", () => {
    const result = resolveAutonomy();
    expect(result).toEqual(AUTONOMY_DEFAULTS);
  });

  it("returns hardcoded defaults when empty overrides provided", () => {
    const result = resolveAutonomy({}, {});
    expect(result).toEqual(AUTONOMY_DEFAULTS);
  });

  it("instance ceiling can restrict a default-true flag", () => {
    const result = resolveAutonomy({ externalComms: false });
    expect(result.externalComms).toBe(false);
  });

  it("instance ceiling can enable a default-false flag", () => {
    const result = resolveAutonomy({ codeAccess: true });
    expect(result.codeAccess).toBe(true);
  });

  it("per-agent can restrict within instance ceiling", () => {
    const result = resolveAutonomy(
      { externalComms: true },
      { externalComms: false },
    );
    expect(result.externalComms).toBe(false);
  });

  it("per-agent cannot escalate beyond instance ceiling", () => {
    const result = resolveAutonomy(
      { codeAccess: false },
      { codeAccess: true },
    );
    expect(result.codeAccess).toBe(false);
  });

  it("per-agent cannot escalate beyond hardcoded default when instance unset", () => {
    // codeAccess hardcoded default is false, instance doesn't override
    // Agent tries to enable — should stay false (ceiling = hardcoded = false)
    const result = resolveAutonomy(
      {},
      { codeAccess: true },
    );
    expect(result.codeAccess).toBe(false);
  });

  it("full resolution chain with mixed flags", () => {
    const result = resolveAutonomy(
      { externalComms: true, codeAccess: true },
      { externalComms: false, codeAccess: true },
    );
    expect(result.externalComms).toBe(false); // agent restricted
    expect(result.codeAccess).toBe(true);     // both allow
  });

  it("agent unset flags inherit from instance ceiling", () => {
    const result = resolveAutonomy(
      { codeAccess: true },
      {}, // codeAccess not specified — inherits ceiling
    );
    expect(result.codeAccess).toBe(true);
  });

  it("all flags false when instance blocks everything", () => {
    const result = resolveAutonomy(
      { externalComms: false, codeAccess: false },
      { externalComms: true, codeAccess: true },
    );
    expect(result.externalComms).toBe(false);
    expect(result.codeAccess).toBe(false);
  });
});
