import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(repoRoot, "scripts/generate-shrinkwrap.mjs");
const fixtures = new Set();

function scratch(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtures.add(root);
  return root;
}

after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function writeTiny(directory, version) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "hive-s8-tiny", version, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(directory, "index.js"), `export const version = ${JSON.stringify(version)};\n`);
}

function packTiny(source, destination) {
  mkdirSync(destination, { recursive: true });
  const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: source,
  });
  const parsed = JSON.parse(output);
  const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.equal(typeof info.filename, "string");
  return join(destination, info.filename);
}

function writeFixturePackage(root, tinyTgz, extra = {}) {
  mkdirSync(join(root, "pkg", "mcp"), { recursive: true });
  const pkg = {
    name: "hive-s8-pack-fixture",
    version: "0.0.1",
    type: "module",
    files: ["pkg/", "README.md", "npm-shrinkwrap.json"],
    dependencies: { "hive-s8-tiny": `file:${tinyTgz}` },
    ...extra,
  };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(root, "README.md"), "fixture\n");
  writeFileSync(join(root, "pkg", "cli.min.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "pkg", "server.min.js"), "server\n");
  writeFileSync(join(root, "pkg", "voice-worker.min.js"), "worker\n");
  writeFileSync(join(root, "pkg", "voice-worker-diagnostic.min.js"), "diag\n");
  writeFileSync(join(root, "pkg", "runtime-probe.min.js"), "probe\n");
  writeFileSync(join(root, "pkg", "deploy.min.js"), "deploy\n");
  writeFileSync(join(root, "pkg", "mcp", "voice-livekit.min.js"), "mcp\n");
}

function lockFixture(root) {
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root });
  assert.equal(existsSync(join(root, "npm-shrinkwrap.json")), false);
}

function writeManifest(root) {
  run(process.execPath, [generator, "--check-source"], { cwd: root });
  const source = readFileSync(join(root, "package-lock.json"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const release = {
    schemaVersion: 1,
    packageVersion: pkg.version,
    sourceRevision: "a".repeat(40),
    sourceDirty: true,
    dependencyLockSha256: createHash("sha256").update(source).digest("hex"),
    voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
  };
  writeFileSync(join(root, "pkg", "release.json"), `${JSON.stringify(release, null, 2)}\n`);
}

function parsePack(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

describe("generate-shrinkwrap", () => {
  let v1;
  let v2;
  let source;

  before(() => {
    const deps = scratch("hive-s8-tiny-");
    writeTiny(join(deps, "v1"), "1.0.0");
    writeTiny(join(deps, "v2"), "2.0.0");
    v1 = packTiny(join(deps, "v1"), deps);
    v2 = packTiny(join(deps, "v2"), deps);
    source = scratch("hive-s8-source-");
    writeFixturePackage(source, v1);
    lockFixture(source);
    writeManifest(source);
  });

  it("leaves the development root free of npm-shrinkwrap.json", () => {
    assert.equal(existsSync(join(repoRoot, "npm-shrinkwrap.json")), false);
    assert.equal(existsSync(join(source, "npm-shrinkwrap.json")), false);
    run(process.execPath, [generator, "--check-source"], { cwd: source });
    assert.equal(existsSync(join(source, "npm-shrinkwrap.json")), false);
    assert.equal(existsSync(join(repoRoot, "npm-shrinkwrap.json")), false);
  });

  it("rejects an accidental root shrinkwrap before any pack", () => {
    const poisoned = scratch("hive-s8-poison-");
    writeFixturePackage(poisoned, v1);
    lockFixture(poisoned);
    writeFileSync(join(poisoned, "npm-shrinkwrap.json"), "{}\n");
    assert.throws(
      () => run(process.execPath, [generator, "--check-source"], { cwd: poisoned }),
      /development root must not contain npm-shrinkwrap.json/,
    );
  });

  it("rejects malformed lock identity and dependency maps", () => {
    const broken = scratch("hive-s8-broken-");
    writeFixturePackage(broken, v1);
    lockFixture(broken);
    const lock = JSON.parse(readFileSync(join(broken, "package-lock.json"), "utf8"));
    lock.packages[""].dependencies = { forged: "1.0.0" };
    writeFileSync(join(broken, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    assert.throws(
      () => run(process.execPath, [generator, "--check-source"], { cwd: broken }),
      /package-lock dependencies mismatch/,
    );
  });

  it("rejects a direct source prepack", () => {
    assert.throws(
      () => run(process.execPath, [generator, "--reject-root-pack"], { cwd: repoRoot }),
      /Use npm run pack:release/,
    );
    assert.throws(() => run("npm", ["pack"], { cwd: repoRoot }), /Use npm run pack:release/);
    assert.equal(existsSync(join(repoRoot, "npm-shrinkwrap.json")), false);
    const leftovers = readdirSync(repoRoot).filter((name) => name.endsWith(".tgz"));
    assert.deepEqual(leftovers, []);
  });

  it("preserves the published packlist including the staged shrinkwrap", () => {
    const listing = parsePack(
      run(process.execPath, [generator, "--pack", "--dry-run", "--json"], { cwd: source }),
    );
    const files = listing.files.map((file) => file.path);
    for (const required of ["package.json", "README.md", "npm-shrinkwrap.json", "pkg/release.json"]) {
      assert.ok(files.includes(required), `missing ${required}`);
    }
    assert.equal(existsSync(join(source, "npm-shrinkwrap.json")), false);
  });

  it("removes the scratch tree after dry-run packing", () => {
    const watch = scratch("hive-s8-tmp-");
    run(process.execPath, [generator, "--pack", "--dry-run", "--json"], {
      cwd: source,
      env: { ...process.env, TMPDIR: watch },
    });
    const leftover = readdirSync(watch).filter((name) => name.startsWith("hive-release-pack-"));
    assert.deepEqual(leftover, []);
  });

  it("fails packing when the destination cannot receive an archive", () => {
    const blocked = join(scratch("hive-s8-dest-"), "not-a-directory");
    writeFileSync(blocked, "file\n");
    assert.throws(
      () =>
        run(process.execPath, [generator, "--pack", "--json", "--pack-destination", blocked], {
          cwd: source,
        }),
      /ENOTDIR|ENOTSUP|EEXIST|not a directory|ENOENT/i,
    );
    assert.equal(existsSync(join(source, "npm-shrinkwrap.json")), false);
  });

  it("follows lock changes through install, stale-pack rejection, rebuild and repack", () => {
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    pkg.dependencies["hive-s8-tiny"] = `file:${v2}`;
    writeFileSync(join(source, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    run("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: source });
    run("npm", ["install", "--ignore-scripts"], { cwd: source });
    const installed = JSON.parse(readFileSync(join(source, "node_modules", "hive-s8-tiny", "package.json"), "utf8"));
    assert.equal(installed.version, "2.0.0");
    assert.equal(existsSync(join(source, "npm-shrinkwrap.json")), false);
    assert.equal(existsSync(join(source, "package-lock.json")), true);

    assert.throws(
      () => run(process.execPath, [generator, "--pack", "--dry-run", "--json"], { cwd: source }),
      /bundle lock is stale/,
    );

    writeManifest(source);
    const packedInto = scratch("hive-s8-packout-");
    const packed = parsePack(
      run(process.execPath, [generator, "--pack", "--json", "--pack-destination", packedInto], {
        cwd: source,
      }),
    );
    const archive = join(packedInto, packed.filename);
    const extract = scratch("hive-s8-extract-");
    run("tar", ["-xzf", archive, "-C", extract]);
    const published = readFileSync(join(extract, "package", "npm-shrinkwrap.json"));
    const lock = readFileSync(join(source, "package-lock.json"));
    assert.ok(published.equals(lock));
    assert.equal(createHash("sha256").update(published).digest("hex"), createHash("sha256").update(lock).digest("hex"));
    assert.equal(existsSync(join(source, "npm-shrinkwrap.json")), false);
  });

  it("leaves no repository-root shrinkwrap after the real package's check-source path", () => {
    run(process.execPath, [generator, "--check-source"], { cwd: repoRoot });
    assert.equal(existsSync(join(repoRoot, "npm-shrinkwrap.json")), false);
  });
});
