import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRelease, sha256, type Release } from "./release.js";

const ARTIFACTS = [
  "pkg/server.min.js",
  "pkg/cli.min.js",
  "pkg/voice-worker.min.js",
  "pkg/voice-worker-diagnostic.min.js",
  "pkg/runtime-probe.min.js",
  "pkg/deploy.min.js",
  "pkg/mcp/voice-livekit.min.js",
] as const;

const packageJson = {
  name: "@keepur/hive",
  version: "1.2.3",
  dependencies: { yaml: "^2.8.2" },
  devDependencies: { vitest: "^5.0.0" },
  optionalDependencies: { fsevents: "^2.3.3" },
};

describe("readRelease", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hive-release-decoder-"));
    mkdirSync(join(root, "pkg", "mcp"), { recursive: true });
    for (const artifact of ARTIFACTS) {
      writeFileSync(join(root, artifact), artifact);
    }
    writePackage(packageJson);
    writeLock({
      lockfileVersion: 3,
      packages: {
        "": {
          name: packageJson.name,
          version: packageJson.version,
          dependencies: packageJson.dependencies,
          devDependencies: packageJson.devDependencies,
          optionalDependencies: packageJson.optionalDependencies,
        },
      },
    });
    writeManifest();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePackage(value: unknown): void {
    writeFileSync(join(root, "package.json"), JSON.stringify(value));
  }

  function writeLock(value: unknown): void {
    writeFileSync(join(root, "npm-shrinkwrap.json"), JSON.stringify(value));
  }

  function lockDigest(): string {
    return sha256(readFileSync(join(root, "npm-shrinkwrap.json")));
  }

  function writeManifest(overrides: Partial<Release> = {}): void {
    const manifest: Release = {
      schemaVersion: 1,
      packageVersion: packageJson.version,
      sourceRevision: "a".repeat(40),
      sourceDirty: false,
      dependencyLockSha256: lockDigest(),
      voiceWorker: {
        path: "pkg/voice-worker.min.js",
        admissionProtocol: 1,
      },
      ...overrides,
    };
    writeFileSync(join(root, "pkg", "release.json"), JSON.stringify(manifest));
  }

  it("decodes a complete release rooted at the explicitly supplied package", () => {
    expect(readRelease(root)).toEqual({
      schemaVersion: 1,
      packageVersion: packageJson.version,
      sourceRevision: "a".repeat(40),
      sourceDirty: false,
      dependencyLockSha256: lockDigest(),
      voiceWorker: {
        path: "pkg/voice-worker.min.js",
        admissionProtocol: 1,
      },
    });
  });

  it("rejects a missing manifest", () => {
    unlinkSync(join(root, "pkg", "release.json"));
    expect(() => readRelease(root)).toThrow();
  });

  it("rejects a missing required artifact", () => {
    unlinkSync(join(root, "pkg", "runtime-probe.min.js"));
    expect(() => readRelease(root)).toThrow();
  });

  it("rejects a required artifact symlinked outside the release root", () => {
    const external = join(tmpdir(), `hive-release-external-${process.pid}-${Date.now()}.js`);
    writeFileSync(external, "external");
    unlinkSync(join(root, "pkg", "server.min.js"));
    symlinkSync(external, join(root, "pkg", "server.min.js"));
    try {
      expect(() => readRelease(root)).toThrow("runtime path escapes release");
    } finally {
      rmSync(external, { force: true });
    }
  });

  it("rejects a manifest whose dependency-lock digest does not match the shrinkwrap bytes", () => {
    writeManifest({ dependencyLockSha256: "b".repeat(64) });
    expect(() => readRelease(root)).toThrow("dependency lock digest mismatch");
  });

  it("rejects an unknown manifest schema", () => {
    writeManifest({ schemaVersion: 2 as 1 });
    expect(() => readRelease(root)).toThrow("unsupported or inconsistent release manifest");
  });

  it("rejects a dirty release when clean provenance is required for migration", () => {
    writeManifest({ sourceDirty: true });
    expect(() => readRelease(root, true)).toThrow("dirty candidate is ineligible for migration");
    expect(readRelease(root).sourceDirty).toBe(true);
  });

  it("rejects an unexpected package identity", () => {
    writePackage({ ...packageJson, name: "@example/forged" });
    expect(() => readRelease(root)).toThrow("unexpected package identity");
  });

  it("rejects a manifest version that differs from package.json", () => {
    writeManifest({ packageVersion: "9.9.9" });
    expect(() => readRelease(root)).toThrow("unsupported or inconsistent release manifest");
  });

  it("rejects a shrinkwrap root version that differs from package.json", () => {
    const lock = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
    lock.packages[""].version = "9.9.9";
    writeLock(lock);
    writeManifest();
    expect(() => readRelease(root)).toThrow("shrinkwrap version mismatch");
  });

  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    it(`rejects a shrinkwrap ${field} map that differs from package.json`, () => {
      const lock = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
      lock.packages[""][field] = { forged: "1.0.0" };
      writeLock(lock);
      writeManifest();
      expect(() => readRelease(root)).toThrow(`shrinkwrap ${field} mismatch`);
    });
  }
});
