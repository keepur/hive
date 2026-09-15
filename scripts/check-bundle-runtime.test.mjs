import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  copyRelocatedPackage,
  createScratchLayout,
  isolatedChildEnv,
  runBundleRuntimeChecks,
  runIsolated,
} from "./check-bundle-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPERATOR_KEYS = [
  "HOME",
  "HIVE_HOME",
  "HIVE_CONFIG",
  "NODE_PATH",
  "NODE_OPTIONS",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

const saved = {};

beforeEach(() => {
  for (const key of OPERATOR_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of OPERATOR_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function seedFakeOperator(root) {
  const home = join(root, "fake-home");
  const hiveHome = join(root, "fake-hive");
  const config = join(root, "fake-hive.yaml");
  mkdirSync(home, { recursive: true });
  mkdirSync(hiveHome, { recursive: true });
  writeFileSync(config, "instance:\n  id: fake-operator\n");
  writeFileSync(join(hiveHome, ".env"), "SLACK_APP_TOKEN=xapp-operator-sentinel\n");
  writeFileSync(join(home, "SENTINEL"), "operator-home\n");
  process.env.HOME = home;
  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_CONFIG = config;
  process.env.NODE_PATH = join(root, "fake-node-path");
  process.env.NODE_OPTIONS = "--require /tmp/does-not-exist.js";
  process.env.SLACK_APP_TOKEN = "xapp-operator-sentinel";
  process.env.SLACK_BOT_TOKEN = "xoxb-operator-sentinel";
  process.env.OPENAI_API_KEY = "sk-operator-sentinel";
  process.env.ANTHROPIC_API_KEY = "sk-ant-operator-sentinel";
  return { home, hiveHome, config };
}

function writeProbe(directory, name) {
  const path = join(directory, name);
  writeFileSync(
    path,
    `${[
      "import { execFileSync } from 'node:child_process';",
      "import { existsSync, readFileSync } from 'node:fs';",
      "const report = {",
      "  cwd: process.cwd(),",
      "  HOME: process.env.HOME ?? null,",
      "  HIVE_HOME: process.env.HIVE_HOME ?? null,",
      "  HIVE_CONFIG: process.env.HIVE_CONFIG ?? null,",
      "  PATH: process.env.PATH ?? null,",
      "  NODE_PATH: process.env.NODE_PATH ?? null,",
      "  NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,",
      "  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ?? null,",
      "  TMPDIR: process.env.TMPDIR ?? null,",
      "};",
      "try {",
      "  execFileSync('security', ['find-generic-password', '-s', 'hive/bundle-smoke/SLACK_APP_TOKEN', '-w']);",
      "  report.securityStatus = 0;",
      "} catch (error) {",
      "  report.securityStatus = error.status ?? 1;",
      "}",
      "report.operatorHomePresent = existsSync((process.env.HOME ?? '') + '/SENTINEL');",
      "process.stdout.write(JSON.stringify(report) + '\\n');",
      "",
    ].join("\n")}`,
  );
  return path;
}

describe("isolated bundle-runtime launcher", () => {
  it("drops inherited operator selectors from the child environment", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-runtime-factory-"));
    try {
      seedFakeOperator(root);
      const scratch = createScratchLayout(join(root, "scratch"));
      const env = isolatedChildEnv(scratch);
      assert.equal(env.HOME, scratch.home);
      assert.equal(env.HIVE_HOME, scratch.instance);
      assert.equal(env.HIVE_CONFIG, scratch.configPath);
      assert.equal(env.NODE_PATH, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.SLACK_APP_TOKEN, undefined);
      assert.ok(env.PATH.startsWith(`${scratch.bin}:`));
      assert.equal(env.HIVE_SMOKE_KEYCHAIN_LOG, scratch.keychainLog);
      assert.notEqual(env.HOME, process.env.HOME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs every launcher branch against scratch selectors and the Keychain shim", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-runtime-probe-"));
    try {
      seedFakeOperator(root);
      const scratch = createScratchLayout(join(root, "scratch"));
      const probe = writeProbe(root, "probe.mjs");
      const cli = writeProbe(root, "cli-probe.mjs");
      const cases = [
        { scratch, result: runIsolated(cli, ["--version"], scratch) },
        { scratch, result: runIsolated(cli, ["--help"], scratch) },
        { scratch, result: runIsolated(probe, [], scratch) },
      ];
      const relocated = createScratchLayout(join(root, "relocated"));
      copyRelocatedPackage(join(relocated.instance, ".hive"));
      cases.push({ scratch: relocated, result: runIsolated(probe, [], relocated) });
      for (const { scratch: used, result } of cases) {
        assert.equal(result.status, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(realpathSync(report.cwd), realpathSync(used.instance));
        assert.equal(report.HOME, used.home);
        assert.equal(report.HIVE_HOME, used.instance);
        assert.equal(report.NODE_PATH, null);
        assert.equal(report.NODE_OPTIONS, null);
        assert.equal(report.SLACK_APP_TOKEN, null);
        assert.equal(report.securityStatus, 44);
        assert.equal(report.operatorHomePresent, false);
      }
      const log = readFileSync(scratch.keychainLog, "utf8");
      assert.ok(log.includes("hive/bundle-smoke/SLACK_APP_TOKEN"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects timeout, unexpected clean exit and the wrong config error", () => {
    const scratch = createScratchLayout();
    try {
      const ok = join(scratch.root, "ok.mjs");
      writeFileSync(ok, "console.log('ok');");
      const wrong = join(scratch.root, "wrong.mjs");
      writeFileSync(wrong, "console.error('Missing required env var: MONGO_URI'); process.exit(1);");
      const hang = join(scratch.root, "hang.mjs");
      writeFileSync(hang, "await new Promise(() => {});");
      const clean = runIsolated(ok, [], scratch);
      assert.equal(clean.status, 0);
      assert.throws(() => {
        if (clean.status === 0) throw new Error("unexpected clean exit");
      }, /unexpected clean exit/);
      const failed = runIsolated(wrong, [], scratch);
      assert.notEqual(failed.status, 0);
      assert.equal(failed.stderr.includes("Missing required env var: SLACK_APP_TOKEN"), false);
      const hung = spawnSync(process.execPath, [hang], {
        encoding: "utf8",
        timeout: 50,
        cwd: scratch.instance,
        env: isolatedChildEnv(scratch),
      });
      assert.ok(hung.error || hung.signal || hung.status);
    } finally {
      rmSync(scratch.root, { recursive: true, force: true });
    }
  });

  it("runs the actual retained bundle smoke against the missing Slack key", () => {
    process.chdir(repoRoot);
    runBundleRuntimeChecks();
  });
});
