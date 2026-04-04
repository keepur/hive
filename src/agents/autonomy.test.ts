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
    const result = resolveAutonomy({ codeTask: true });
    expect(result.codeTask).toBe(true);
  });

  it("per-agent can restrict within instance ceiling", () => {
    const result = resolveAutonomy(
      { externalComms: true, codeTask: true },
      { externalComms: false },
    );
    expect(result.externalComms).toBe(false);
    expect(result.codeTask).toBe(true);
  });

  it("per-agent cannot escalate beyond instance ceiling", () => {
    const result = resolveAutonomy(
      { codeTask: false },
      { codeTask: true },
    );
    expect(result.codeTask).toBe(false);
  });

  it("per-agent cannot escalate beyond hardcoded default when instance unset", () => {
    // codeTask hardcoded default is false, instance doesn't override
    // Agent tries to enable — should stay false (ceiling = hardcoded = false)
    const result = resolveAutonomy(
      {},
      { codeTask: true },
    );
    expect(result.codeTask).toBe(false);
  });

  it("full resolution chain with mixed flags", () => {
    const result = resolveAutonomy(
      { externalComms: true, codeTask: true, codeAccess: true },
      { externalComms: false, codeTask: true, codeAccess: true },
    );
    expect(result.externalComms).toBe(false); // agent restricted
    expect(result.codeTask).toBe(true);       // both allow
    expect(result.codeAccess).toBe(true);     // both allow
  });

  it("agent unset flags inherit from instance ceiling", () => {
    const result = resolveAutonomy(
      { codeTask: true, codeAccess: true },
      { codeTask: true }, // codeAccess not specified — inherits ceiling
    );
    expect(result.codeAccess).toBe(true);
  });

  it("all flags false when instance blocks everything", () => {
    const result = resolveAutonomy(
      { externalComms: false, codeTask: false, codeAccess: false },
      { externalComms: true, codeTask: true, codeAccess: true },
    );
    expect(result.externalComms).toBe(false);
    expect(result.codeTask).toBe(false);
    expect(result.codeAccess).toBe(false);
  });
});
