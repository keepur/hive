import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompareFixture } from "../src/voice/testing/compare-fixture.js";
import { benchRunHeader } from "./voice-engine-bench.js";

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
  it("exits 2 on a duplicated --call and 1 on a --call id with no rows", () => {
    const dup = run([
      "--input",
      `${FIX}/kpr-465-compare.jsonl`,
      "--call",
      "call-cold-a=A0-cold",
      "--call",
      "call-cold-a=A0-cold",
    ]);
    expect(dup.status).toBe(2);
    expect(dup.stderr).toMatch(/call id "call-cold-a" is listed more than once/);
    const typo = run(["--input", `${FIX}/kpr-465-compare.jsonl`, "--call", "call-cold-typo=A0-cold"]);
    expect(typo.status).toBe(1);
    expect(JSON.parse(typo.stdout).failures).toEqual([
      "call call-cold-typo (A0-cold) has no engine attempts — check the --call id",
    ]);
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
  it("consumes the bench CLI's own --out file: the run header line is skipped, other malformed lines still fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "kpr465-"));
    const header = benchRunHeader({
      arm: "A1-warm-bench",
      agent: "mokie-bench",
      workerBootId: "00000000-0000-4000-8000-000000000000",
      startedAt: "2026-09-11T00:00:00.000Z",
      calls: 1,
      drill: null,
      warmup: false,
    });
    const rows = readFileSync(`${FIX}/kpr-465-bench-results.jsonl`, "utf8");
    const withHeader = join(dir, "bench-out.jsonl");
    writeFileSync(withHeader, `${JSON.stringify(header)}\n${rows}`);
    const args = ["--input", `${FIX}/kpr-465-compare.jsonl`, "--call", "call-bench-1=A1-warm-bench", "--bench-results"];
    const ok = run([...args, withHeader]);
    expect(ok.stderr).not.toMatch(/voice-latency-compare:/);
    expect(ok.status).toBe(0);
    const report = JSON.parse(ok.stdout);
    // The fixture's barge-in row (t5, keywordPass false) lands in notApplicable, not fail: the CLI passes bargeIn through.
    expect(report.benchAssertions).toEqual({
      rows: 5,
      keyword: { pass: 3, fail: 0, notApplicable: 2 },
      tool: { pass: 1, fail: 0, unobserved: 0 },
    });
    // Narrow: a non-header line missing the row fields is still rejected, header or not.
    const malformed = join(dir, "bench-malformed.jsonl");
    writeFileSync(malformed, `${JSON.stringify(header)}\n${rows}${JSON.stringify({ arm: "A1-warm-bench" })}\n`);
    const bad = run([...args, malformed]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/bench result row missing callId\/turnId\/arm/);
    // A `run: true` line that also carries a callId is not the header shape — still validated as a row.
    const runWithCall = join(dir, "bench-run-with-call.jsonl");
    writeFileSync(runWithCall, `${JSON.stringify({ run: true, callId: "call-bench-1" })}\n${rows}`);
    expect(run([...args, runWithCall]).status).toBe(2);
  });

  // create-tests audit (post pre-PR review round 5): closes a genuine gap — no
  // test exercised an unknown-key input file through the CLI. The chunk B
  // plan's own draft text said this case "exits 0 ... reports malformedRows
  // >= 1", but that's wrong by design: the reader already marks a call with
  // malformed rows incomplete (voice-diagnostic-reader.ts), and R1 minimum
  // assertion (12) turns an incomplete call into ok:false, which exits 1 —
  // never 0. This test pins the real, correct behavior.
  it("an unknown key in the input file surfaces as a malformed row, marks the call incomplete, and exits 1 (not 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kpr465-"));
    const jsonl = readFileSync(`${FIX}/kpr-465-compare.jsonl`, "utf8");
    const withUnknownKey = jsonl.replace(
      '"event":"engine_received","correlation":"worker"',
      '"event":"engine_received","correlation":"worker","transcript":"secret"',
    );
    const path = join(dir, "unknown-key.jsonl");
    writeFileSync(path, withUnknownKey);
    const r = run(["--input", path, "--call", "call-cold-a=A0-cold"]);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(["call call-cold-a (A0-cold) is incomplete"]);
    expect(report.arms[0]!.calls[0]!.malformedRows).toBeGreaterThanOrEqual(1);
    expect(report.arms[0]!.calls[0]!.complete).toBe(false);
    expect(r.stdout).not.toContain("secret");
  });
});
