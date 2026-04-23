import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { populateEngine, ensureEngineDeps, PACKAGE_ENTRIES } from "./populate-engine.js";

function makeFakePkgRoot(): string {
  const root = resolve(tmpdir(), `hive-populate-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  const dir = resolve(tmpdir(), `hive-populate-dst-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    populateEngine(pkgRoot, instanceDir, { skipInstall: true });
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
    populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    const dst = resolve(instanceDir, ".hive", "scripts", "honeypot");
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf-8")).toContain("honeypot");
    // No sibling at .hive/honeypot — parent-dir logic must not flatten.
    expect(existsSync(resolve(instanceDir, ".hive", "honeypot"))).toBe(false);
  });

  it("package.json content round-trips", () => {
    populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    const pkg = JSON.parse(readFileSync(resolve(instanceDir, ".hive", "package.json"), "utf-8"));
    expect(pkg.name).toBe("@keepur/hive");
    expect(pkg.version).toBe("0.2.0");
  });

  it("throws if .hive/ is already populated", () => {
    populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    expect(() => populateEngine(pkgRoot, instanceDir, { skipInstall: true })).toThrow(/Engine already populated/);
  });

  it("silently skips missing entries (dev install without bundle)", () => {
    rmSync(join(pkgRoot, "pkg"), { recursive: true, force: true });
    populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    const engine = resolve(instanceDir, ".hive");
    expect(existsSync(join(engine, "pkg", "server.min.js"))).toBe(false);
    // Still copies what's available
    expect(existsSync(join(engine, "seeds"))).toBe(true);
    expect(existsSync(join(engine, "package.json"))).toBe(true);
  });

  it("copies directories as directories (not as files)", () => {
    populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    const pkgDir = resolve(instanceDir, ".hive", "pkg");
    expect(statSync(pkgDir).isDirectory()).toBe(true);
    const seedsDir = resolve(instanceDir, ".hive", "seeds");
    expect(statSync(seedsDir).isDirectory()).toBe(true);
  });

  it("PACKAGE_ENTRIES matches the tarball shape exactly", () => {
    // If this test fails, the deploy.sh fetch_engine rsync fallback also needs updating.
    expect(PACKAGE_ENTRIES).toEqual(["pkg", "seeds", "templates", "scripts/honeypot", "package.json"]);
  });

  it("runs npm install in .hive/ by default (no skipInstall)", () => {
    // Fake package.json with no deps → npm install is a no-op but still
    // produces a package-lock.json. Proves the install step ran.
    populateEngine(pkgRoot, instanceDir);
    const engine = resolve(instanceDir, ".hive");
    expect(existsSync(join(engine, "package-lock.json"))).toBe(true);
  });
});

describe("ensureEngineDeps", () => {
  let engine: string;

  beforeEach(() => {
    engine = resolve(tmpdir(), `hive-ensure-deps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(engine, { recursive: true });
  });

  afterEach(() => {
    rmSync(engine, { recursive: true, force: true });
  });

  it("runs npm install when node_modules/ is missing (resume path)", () => {
    writeFileSync(join(engine, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "0.2.0" }));
    ensureEngineDeps(engine);
    expect(existsSync(join(engine, "package-lock.json"))).toBe(true);
  });

  it("is a no-op when node_modules/ already exists", () => {
    writeFileSync(join(engine, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "0.2.0" }));
    mkdirSync(join(engine, "node_modules"), { recursive: true });
    // Marker so we can tell if npm install ran and overwrote anything.
    writeFileSync(join(engine, "node_modules", ".marker"), "present");
    ensureEngineDeps(engine);
    expect(readFileSync(join(engine, "node_modules", ".marker"), "utf-8")).toBe("present");
    // npm install didn't run, so no package-lock.json was produced.
    expect(existsSync(join(engine, "package-lock.json"))).toBe(false);
  });

  it("is a no-op when package.json is absent", () => {
    // Empty engine dir — e.g., a prior init failed before the copy step.
    ensureEngineDeps(engine);
    expect(existsSync(join(engine, "package-lock.json"))).toBe(false);
    expect(existsSync(join(engine, "node_modules"))).toBe(false);
  });
});
