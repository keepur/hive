import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { populateEngine, PACKAGE_ENTRIES } from "./populate-engine.js";

function makeFakePkgRoot(): string {
  const root = resolve(
    tmpdir(),
    `hive-populate-src-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "server.min.js"), "// server bundle");
  writeFileSync(join(root, "pkg", "cli.min.js"), "// cli bundle");
  mkdirSync(join(root, "seeds"), { recursive: true });
  writeFileSync(join(root, "seeds", "dodi.seed.ts"), "export {};");
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "templates", "hive.yaml.example"), "instance: {}\n");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "honeypot"), "#!/usr/bin/env bash\n# honeypot\necho x\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "0.2.0" }));
  return root;
}

function makeInstanceDir(): string {
  const dir = resolve(
    tmpdir(),
    `hive-populate-dst-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("populateEngine", () => {
  let pkgRoot: string;
  let instanceDir: string;

  beforeEach(() => {
    pkgRoot = makeFakePkgRoot();
    instanceDir = makeInstanceDir();
  });

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(instanceDir, { recursive: true, force: true });
  });

  it("creates .hive/ and copies each PACKAGE_ENTRIES member", () => {
    populateEngine(pkgRoot, instanceDir);
    const engine = resolve(instanceDir, ".hive");
    expect(existsSync(engine)).toBe(true);
    expect(existsSync(join(engine, "pkg", "server.min.js"))).toBe(true);
    expect(existsSync(join(engine, "pkg", "cli.min.js"))).toBe(true);
    expect(existsSync(join(engine, "seeds", "dodi.seed.ts"))).toBe(true);
    expect(existsSync(join(engine, "templates", "hive.yaml.example"))).toBe(true);
    expect(existsSync(join(engine, "scripts", "honeypot"))).toBe(true);
    expect(existsSync(join(engine, "package.json"))).toBe(true);
  });

  it("places scripts/honeypot at .hive/scripts/honeypot (not flattened)", () => {
    populateEngine(pkgRoot, instanceDir);
    const dst = resolve(instanceDir, ".hive", "scripts", "honeypot");
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf-8")).toContain("honeypot");
    // No sibling at .hive/honeypot — parent-dir logic must not flatten.
    expect(existsSync(resolve(instanceDir, ".hive", "honeypot"))).toBe(false);
  });

  it("package.json content round-trips", () => {
    populateEngine(pkgRoot, instanceDir);
    const pkg = JSON.parse(
      readFileSync(resolve(instanceDir, ".hive", "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe("@keepur/hive");
    expect(pkg.version).toBe("0.2.0");
  });

  it("throws if .hive/ is already populated", () => {
    populateEngine(pkgRoot, instanceDir);
    expect(() => populateEngine(pkgRoot, instanceDir)).toThrow(
      /Engine already populated/,
    );
  });

  it("silently skips missing entries (dev install without bundle)", () => {
    rmSync(join(pkgRoot, "pkg"), { recursive: true, force: true });
    populateEngine(pkgRoot, instanceDir);
    const engine = resolve(instanceDir, ".hive");
    expect(existsSync(join(engine, "pkg", "server.min.js"))).toBe(false);
    // Still copies what's available
    expect(existsSync(join(engine, "seeds"))).toBe(true);
    expect(existsSync(join(engine, "package.json"))).toBe(true);
  });

  it("copies directories as directories (not as files)", () => {
    populateEngine(pkgRoot, instanceDir);
    const pkgDir = resolve(instanceDir, ".hive", "pkg");
    expect(statSync(pkgDir).isDirectory()).toBe(true);
    const seedsDir = resolve(instanceDir, ".hive", "seeds");
    expect(statSync(seedsDir).isDirectory()).toBe(true);
  });

  it("PACKAGE_ENTRIES matches the tarball shape exactly", () => {
    // If this test fails, the deploy.sh fetch_engine rsync fallback also needs updating.
    expect(PACKAGE_ENTRIES).toEqual([
      "pkg",
      "seeds",
      "templates",
      "scripts/honeypot",
      "package.json",
    ]);
  });
});
