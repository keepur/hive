import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const harness = join(resolve(dirname(fileURLToPath(import.meta.url))), "check-confinement-closure.mjs");
const source = readFileSync(harness, "utf8");

function confinedDriverSource(file) {
  const start = file.indexOf("writeFileSync(\n    driver,");
  assert.notEqual(start, -1, "T10(c) driver write is missing");
  const joinAt = file.indexOf('].join("\\n")}', start);
  assert.notEqual(joinAt, -1, "T10(c) driver join is missing");
  const chunk = file.slice(start, joinAt);
  const lines = [...chunk.matchAll(/^\s+"((?:[^"\\]|\\.)*)"/gm)].map((match) => JSON.parse(`"${match[1]}"`));
  assert.ok(lines.length > 10, "T10(c) driver template is empty");
  return lines.join("\n");
}

describe("T10(c) confined SDK driver", () => {
  const driver = confinedDriverSource(source);

  it("skips before packing on a non-24 Node major", () => {
    const skipExit = source.indexOf("process.exit(0)");
    const packCall = source.indexOf("packRepository(join(scratch");
    assert.ok(skipExit >= 0 && packCall > skipExit);
  });

  it("forks the inference helper with registered EOT runners, not {}", () => {
    assert.match(driver, /lk_eot_audio/);
    assert.match(driver, /pathToFileURL\(eotRunner\)\.href/);
    assert.match(driver, /JSON\.stringify\(runners\)/);
    assert.doesNotMatch(driver, /JSON\.stringify\(\{\}\)/);
    assert.match(driver, /eot runner missing/);
    assert.match(driver, /empty inference runners/);
    assert.match(
      driver,
      /fork\(inferenceHelper, \[JSON\.stringify\(runners\)\], \{ stdio: \['ignore', 'pipe', 'pipe', 'ipc'\] \}\)/,
    );
  });

  it("keeps the job-helper IPC pattern and does not start a live Worker", () => {
    assert.match(driver, /fork\(jobHelper, \[worker\]/);
    assert.match(driver, /initializeRequest/);
    assert.match(driver, /shutdownRequest/);
    assert.doesNotMatch(driver, /startJobRequest/);
    assert.doesNotMatch(driver, /runApp/);
    assert.doesNotMatch(driver, /new Worker\b/);
  });

  it("gives the inference child more than 15s for EOT initialize", () => {
    assert.match(driver, /waitInitialized\(fork\(jobHelper[\s\S]*?\), 15000\)/);
    assert.match(driver, /waitInitialized\(fork\(inferenceHelper[\s\S]*?\), 120000\)/);
    assert.match(source, /timeoutMs: 240_000/);
  });

  it("records inference runner keys on T10_CLOSURE.c", () => {
    assert.match(driver, /inferenceRunners: Object\.keys\(runners\)/);
    assert.match(source, /inferenceRunners: sdk\.inferenceRunners/);
    assert.match(source, /lk_eot_audio/);
  });
});
