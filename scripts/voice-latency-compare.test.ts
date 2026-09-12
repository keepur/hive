import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompareFixture } from "../src/voice/testing/compare-fixture.js";

const FIX = "docs/epics/kpr-462/fixtures";
function run(args: string[]) {
  return spawnSync("npx", ["tsx", "scripts/voice-latency-compare.ts", ...args], { encoding: "utf8" });
}

describe("voice-latency-compare CLI", () => {
  it("exits 0 with ok:true on the fixture and echoes the seed", () => {
    const r = run([
      "--input",
      `${FIX}/kpr-465-compare.jsonl`,
      "--call",
      "call-cold-a=A0-cold",
      "--call",
      "call-warm-a=A1-warm",
      "--pair",
      "A1-warm=A0-cold",
      "--engine-log",
      `${FIX}/kpr-465-engine-log.jsonl`,
      "--seed",
      "20260911",
    ]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ ok: true, seed: 20260911, crossCheck: { mismatched: 1 } });
  });
  it("exits 1 on a mislabelled arm", () => {
    const r = run(["--input", `${FIX}/kpr-465-compare.jsonl`, "--call", "call-warm-mislabel=A1-warm"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).failures[0]).toMatch(/warm_arm_has_cold_steady_turn/);
  });
  it("exits 2 on missing --call, on an unlabelled arm, and on a bad pair", () => {
    expect(run(["--input", `${FIX}/kpr-465-compare.jsonl`]).status).toBe(2);
    expect(run(["--input", `${FIX}/kpr-465-compare.jsonl`, "--call", "call-cold-a=A0"]).status).toBe(2);
    expect(
      run(["--input", `${FIX}/kpr-465-compare.jsonl`, "--call", "call-cold-a=A0-cold", "--pair", "nope"]).status,
    ).toBe(2);
  });
  it("accepts multiple --input files and a bench-results join", () => {
    const dir = mkdtempSync(join(tmpdir(), "kpr465-"));
    const f = buildCompareFixture();
    const half = f.jsonl.split("\n");
    writeFileSync(join(dir, "a.jsonl"), `${half.slice(0, Math.floor(half.length / 2)).join("\n")}\n`);
    writeFileSync(join(dir, "b.jsonl"), `${half.slice(Math.floor(half.length / 2)).join("\n")}\n`);
    const r = run([
      "--input",
      join(dir, "a.jsonl"),
      "--input",
      join(dir, "b.jsonl"),
      "--call",
      "call-bench-1=A1-warm-bench",
      "--bench-results",
      `${FIX}/kpr-465-bench-results.jsonl`,
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).benchAssertions.tool).toEqual({ pass: 1, fail: 0, unobserved: 0 });
  });
});
