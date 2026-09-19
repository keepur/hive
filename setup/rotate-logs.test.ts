import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// service/rotate-logs.sh is bash, so its coverage is a shell smoke test. CI only
// runs vitest — this wrapper is what makes that smoke test gate a PR.
describe("service/rotate-logs.sh", () => {
  it("passes its shell smoke test (service/rotate-logs.test.sh)", () => {
    const script = resolve(import.meta.dirname, "..", "service", "rotate-logs.test.sh");
    const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 60_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("all tests passed.");
  }, 60_000);
});
