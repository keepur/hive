#!/usr/bin/env node
/**
 * T7 detached writer. Started from a harness-local npm lifecycle script.
 * Holds a descriptor on a job-output pkg/ file, then at latch files written
 * by the unconfined harness: (i) attempts fresh writes outside the job
 * directory and (ii) writes through the held descriptor.
 */
import { appendFileSync, openSync, writeSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function findJobPackage(start) {
  let dir = start;
  for (let i = 0; i < 24; i++) {
    if (existsSync(resolve(dir, "pkg", "cli.min.js")) && existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function findHome(start) {
  let dir = start;
  for (let i = 0; i < 24; i++) {
    if (dir.endsWith("/.hive-state") || dir.includes("/.hive-state/jobs/")) {
      return dir.split("/.hive-state")[0];
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, "..", "..", "..", "..");
}

const jobRoot = findJobPackage(process.env.npm_config_local_prefix || process.cwd());
const hiveHome = process.env.HIVE_T7_HOME || findHome(jobRoot);
const target = resolve(jobRoot, "pkg", "cli.min.js");
const fd = openSync(target, "r+");
const pidPath = resolve(jobRoot, ".t7-writer.pid");
writeFileSync(pidPath, `${process.pid}\n`);

function wait(name) {
  const flags = [
    resolve(jobRoot, `.t7-${name}`),
    resolve(hiveHome, ".hive.next", `.t7-${name}`),
    resolve(hiveHome, ".hive", `.t7-${name}`),
  ];
  const start = Date.now();
  while (!flags.some((flag) => existsSync(flag))) {
    if (Date.now() - start > 600_000) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return true;
}

function liveRoot() {
  for (const root of [jobRoot, resolve(hiveHome, ".hive.next"), resolve(hiveHome, ".hive")]) {
    if (existsSync(root)) return root;
  }
  return jobRoot;
}

function attemptOutside(tag) {
  const targets = [
    resolve(hiveHome, ".hive.next", `t7-corrupt-${tag}`),
    resolve(hiveHome, ".hive", `t7-corrupt-${tag}`),
    resolve(hiveHome, ".hive.prev", `t7-corrupt-${tag}`),
    resolve(hiveHome, ".hive-state", "deployment", `t7-corrupt-${tag}`),
    resolve(process.env.HOME ?? "/tmp", `t7-corrupt-${tag}`),
  ];
  const results = [];
  for (const path of targets) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `t7-outside-${tag}\n`);
      results.push({ path, ok: true });
    } catch (error) {
      results.push({ path, ok: false, code: error.code ?? String(error) });
    }
  }
  writeFileSync(resolve(liveRoot(), `.t7-outside-${tag}.json`), JSON.stringify(results, null, 2));
}

function writeHeld(tag) {
  try {
    writeSync(fd, Buffer.from(`\nT7_HELD_${tag}\n`));
    writeFileSync(resolve(liveRoot(), `.t7-held-${tag}`), "ok\n");
  } catch (error) {
    try {
      writeFileSync(resolve(liveRoot(), `.t7-held-${tag}`), `${error.code ?? error}\n`);
    } catch {
      // destination vanished
    }
  }
}

for (const name of ["clone", "verified", "rotated"]) {
  if (!wait(name)) break;
  attemptOutside(name);
  if (name !== "clone") writeHeld(name);
}

try {
  appendFileSync(resolve(jobRoot, ".t7-done"), "done\n");
} catch {
  // job directory may already be gone
}
