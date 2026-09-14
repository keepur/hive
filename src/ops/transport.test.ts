import { describe, it, expect } from "vitest";
import { renderRemediation } from "./transport.js";

describe("renderRemediation (D6, C13)", () => {
  it("substitutes declared keys and emits no value that was not in the allow-listed detail", () => {
    const out = renderRemediation("Restart {tool} on {host}", { tool: "gog", host: "mini" });
    expect(out).toBe("Restart gog on mini");
  });

  it("leaves an UNDECLARED placeholder untouched rather than blanking it", () => {
    expect(renderRemediation("Restart {tool} on {host}", { tool: "gog" })).toBe("Restart gog on {host}");
  });

  it("never reads the prototype chain (KPR-407 discipline)", () => {
    expect(renderRemediation("{constructor}/{toString}/{__proto__}", {})).toBe("{constructor}/{toString}/{__proto__}");
  });

  it("renders numbers and booleans without coercing anything else in", () => {
    expect(renderRemediation("{n} retries, deterministic={d}", { n: 3, d: false })).toBe(
      "3 retries, deterministic=false",
    );
  });
});
