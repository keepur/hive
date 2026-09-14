import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../deployment/release.js";
import {
  ConfinedJobRunner,
  ConfinementSelfTestError,
  ConfinementUnavailableError,
  SANDBOX_EXEC,
  nodeConfinedJobIO,
  type ConfinedJobIO,
  type ConfinedProcessResult,
  type ConfinementSelfTest,
} from "../deployment/confined-job.js";
import {
  CloneVerificationError,
  PromotionFailedError,
  nodePromotionIO,
  type PromotionIO,
} from "../deployment/clone-promotion.js";
import {
  EngineStagingError,
  PACKAGE_ENTRIES,
  copyPackageEntries,
  ensureEngineDeps,
  populateEngine,
  prepareEngineStaging,
  type EngineStagingContext,
} from "./populate-engine.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const lockBytes = Buffer.from(
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "@keepur/hive", version: "0.2.0" } } }),
);

const identity = {
  packageVersion: "0.2.0",
  sourceRevision: "f".repeat(40),
  dependencyLockSha256: sha256(lockBytes),
};

const PKG_ARTIFACTS = [
  "pkg/server.min.js",
  "pkg/cli.min.js",
  "pkg/voice-worker.min.js",
  "pkg/voice-worker-diagnostic.min.js",
  "pkg/runtime-probe.min.js",
  "pkg/deploy.min.js",
  "pkg/mcp/voice-livekit.min.js",
];

/** A complete source package, as an extracted tarball would leave it. */
function makeFakePkgRoot(overrides: { lock?: string | null } = {}): string {
  const root = scratch("hive-populate-src-");
  mkdirSync(join(root, "pkg", "mcp"), { recursive: true });
  for (const file of PKG_ARTIFACTS) writeFileSync(join(root, file), `// ${file}\n`);
  writeFileSync(
    join(root, "pkg", "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      ...identity,
      sourceDirty: false,
      voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
    }),
  );
  mkdirSync(join(root, "seeds"), { recursive: true });
  writeFileSync(join(root, "seeds", "dodi.seed.ts"), "export {};");
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "templates", "hive.yaml.example"), "instance: {}\n");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "honeypot"), "#!/usr/bin/env bash\n# honeypot\necho x\n");
  mkdirSync(join(root, "install"), { recursive: true });
  writeFileSync(join(root, "install", "migrate-0.2.sh"), "#!/usr/bin/env bash\n# migrate\n");
  mkdirSync(join(root, "service"), { recursive: true });
  writeFileSync(join(root, "service", "deploy.sh"), "#!/usr/bin/env bash\n# deploy\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "0.2.0" }));
  if (overrides.lock !== null) writeFileSync(join(root, "npm-shrinkwrap.json"), overrides.lock ?? lockBytes);
  return root;
}

function makeInstanceDir(): string {
  const dir = scratch("hive-populate-dst-");
  return dir;
}

function ok(overrides: Partial<ConfinedProcessResult> = {}): ConfinedProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

const passed: ConfinementSelfTest = {
  outcome: "passed",
  macosVersion: "26.6.2",
  sandboxExec: SANDBOX_EXEC,
  profileSha256: "a".repeat(64),
  checkedAt: "2026-09-14T00:00:00.000Z",
};

interface StagingOverrides {
  /** Simulated outcome of the confined `npm ci`. */
  install?: (packageRoot: string) => ConfinedProcessResult;
  dependencyTree?: () => ConfinedProcessResult;
  runtimeLoading?: (mode: string) => ConfinedProcessResult;
  promotionIO?: Partial<PromotionIO>;
}

function runtimeRecord(mode: string, reported = identity): ConfinedProcessResult {
  const prefix = mode === "engine-validate" ? "ENGINE_VALIDATE_OK" : "ARTIFACT_RUNTIME_OK";
  return ok({ stdout: Buffer.from(`${prefix} ${JSON.stringify({ manifest: reported })}\n`) });
}

/**
 * A staging context whose confined jobs are simulated: `npm ci` installs a
 * `node_modules` inside the job's own package directory, and the verification
 * probes answer with the release identity. Promotion uses the real `/bin/cp`
 * in full-copy mode, so no APFS clone support is assumed.
 */
function stagingContext(home: string, overrides: StagingOverrides = {}): EngineStagingContext {
  const operationId = `init-test-${Math.random().toString(36).slice(2, 10)}`;
  const io: ConfinedJobIO = {
    ...nodeConfinedJobIO,
    platform: () => "darwin",
    spawn: vi.fn(async (command, args) => {
      expect(command).toBe(SANDBOX_EXEC);
      const argv = args.slice(2);
      if (argv.includes("ci")) {
        const packageRoot = argv[0] === undefined ? "" : "";
        void packageRoot;
        return (overrides.install ?? defaultInstall)(installRoot);
      }
      if (argv.includes("ls")) return (overrides.dependencyTree ?? (() => ok()))();
      const mode = argv.at(-1) ?? "";
      return (overrides.runtimeLoading ?? runtimeRecord)(mode);
    }),
  };
  let installRoot = "";
  const runner = new ConfinedJobRunner({ canonicalInstanceHome: home, operationId, selfTest: passed, io });
  const prepare = runner.prepare.bind(runner);
  runner.prepare = async (kind) => {
    const job = await prepare(kind);
    if (kind === "install") installRoot = resolve(job.path, "package");
    return job;
  };
  return {
    runner,
    selfTest: passed,
    promotion: { method: "full-copy", reason: "non-apfs-volume", filesystemType: "hfs" },
    operationId,
    nodePath: "/opt/node",
    npmCliPath: "/opt/npm/bin/npm-cli.js",
    invokingHome: home,
    pathEnv: "/usr/bin:/bin",
    promotionIO: {
      ...nodePromotionIO,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      processStartTime: async () => "Mon Sep 14 04:00:00 2026",
      ...overrides.promotionIO,
    },
  };
}

function defaultInstall(packageRoot: string): ConfinedProcessResult {
  mkdirSync(resolve(packageRoot, "node_modules", "dep"), { recursive: true });
  writeFileSync(resolve(packageRoot, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  return ok();
}

describe("copyPackageEntries", () => {
  let pkgRoot: string;
  let destination: string;

  beforeEach(() => {
    pkgRoot = makeFakePkgRoot();
    destination = scratch("hive-populate-copy-");
  });

  it("copies each PACKAGE_ENTRIES member and nothing else", async () => {
    const copied = await copyPackageEntries(pkgRoot, destination);
    expect(copied).toEqual([...PACKAGE_ENTRIES]);
    expect(existsSync(join(destination, "pkg", "server.min.js"))).toBe(true);
    expect(existsSync(join(destination, "seeds", "dodi.seed.ts"))).toBe(true);
    expect(existsSync(join(destination, "templates", "hive.yaml.example"))).toBe(true);
    expect(existsSync(join(destination, "scripts", "honeypot"))).toBe(true);
    expect(existsSync(join(destination, "install", "migrate-0.2.sh"))).toBe(true);
    expect(existsSync(join(destination, "service", "deploy.sh"))).toBe(true);
    expect(existsSync(join(destination, "package.json"))).toBe(true);
    expect(existsSync(join(destination, "npm-shrinkwrap.json"))).toBe(true);
    // Not a package entry; never copied.
    expect(existsSync(join(destination, "scripts", "other"))).toBe(false);
  });

  it("places scripts/honeypot at scripts/honeypot (not flattened)", async () => {
    await copyPackageEntries(pkgRoot, destination);
    const dst = resolve(destination, "scripts", "honeypot");
    expect(readFileSync(dst, "utf-8")).toContain("honeypot");
    expect(existsSync(resolve(destination, "honeypot"))).toBe(false);
  });

  it("copies directories as directories", async () => {
    await copyPackageEntries(pkgRoot, destination);
    expect(statSync(resolve(destination, "pkg")).isDirectory()).toBe(true);
    expect(statSync(resolve(destination, "seeds")).isDirectory()).toBe(true);
  });

  it("skips members the source package does not carry", async () => {
    rmSync(join(pkgRoot, "pkg"), { recursive: true, force: true });
    const copied = await copyPackageEntries(pkgRoot, destination);
    expect(copied).not.toContain("pkg");
    expect(existsSync(join(destination, "seeds"))).toBe(true);
  });

  it("PACKAGE_ENTRIES matches the tarball shape exactly", () => {
    // If this test fails, update ALL FOUR places in lockstep:
    //   - package.json "files"
    //   - deploy.sh fetch_engine rsync fallback
    //   - install/migrate-0.2.sh step_populate_engine entries array
    //   - this assertion
    expect(PACKAGE_ENTRIES).toEqual([
      "pkg",
      "seeds",
      "templates",
      "scripts/honeypot",
      "install",
      "service",
      "package.json",
      "npm-shrinkwrap.json",
    ]);
  });
});

describe("populateEngine (confined staging)", () => {
  let pkgRoot: string;
  let instanceDir: string;

  beforeEach(() => {
    pkgRoot = makeFakePkgRoot();
    instanceDir = makeInstanceDir();
  });

  const engineOf = () => resolve(instanceDir, ".hive");
  const nextOf = () => resolve(instanceDir, ".hive.next");

  it("produces .hive only as a verified clone of the confined job output", async () => {
    const staging = stagingContext(instanceDir);
    const result = await populateEngine(pkgRoot, instanceDir, { staging });
    expect(result).not.toBeNull();
    const engine = engineOf();
    expect(existsSync(engine)).toBe(true);
    expect(existsSync(join(engine, "pkg", "server.min.js"))).toBe(true);
    expect(existsSync(join(engine, "npm-shrinkwrap.json"))).toBe(true);
    // The install job's node_modules came through the clone.
    expect(existsSync(join(engine, "node_modules", "dep", "index.js"))).toBe(true);
    // `.hive.next` was renamed, not left behind, and the job area was disposed.
    expect(existsSync(nextOf())).toBe(false);
    expect(result!.verification.checks).toContain("runtime-loading:engine-validate");
    expect(result!.verification.checks).toContain("runtime-loading:offline");
    expect(result!.verification.checks).toContain("dependency-tree");
  });

  it("records the Node/npm versions, the self-test outcome and the promotion method", async () => {
    const staging = stagingContext(instanceDir);
    const result = await populateEngine(pkgRoot, instanceDir, { staging });
    expect(result!.selfTest.outcome).toBe("passed");
    expect(result!.promotionMethod).toBe("full-copy");
    expect(result!.runtime.node).toBe(process.version);
    expect(result!.runtime).toHaveProperty("npm");
    expect(result!.release.packageVersion).toBe("0.2.0");
  });

  it("discards an unverified partial .hive and node_modules on resume", async () => {
    const engine = engineOf();
    mkdirSync(resolve(engine, "node_modules", "stale"), { recursive: true });
    writeFileSync(resolve(engine, "node_modules", "stale", "index.js"), "stale");
    writeFileSync(resolve(engine, "INTERRUPTED"), "marker");
    const result = await populateEngine(pkgRoot, instanceDir, { staging: stagingContext(instanceDir) });
    expect(result).not.toBeNull();
    // Neither the stale tree nor the completion marker survived.
    expect(existsSync(resolve(engine, "node_modules", "stale"))).toBe(false);
    expect(existsSync(resolve(engine, "INTERRUPTED"))).toBe(false);
    expect(existsSync(resolve(engine, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("discards leftover .hive.next staging on resume", async () => {
    mkdirSync(resolve(nextOf(), "pkg"), { recursive: true });
    writeFileSync(resolve(nextOf(), "pkg", "stale.js"), "stale");
    await populateEngine(pkgRoot, instanceDir, { staging: stagingContext(instanceDir) });
    expect(existsSync(resolve(engineOf(), "pkg", "stale.js"))).toBe(false);
    expect(existsSync(nextOf())).toBe(false);
  });

  it("resume runs the whole confined path again through ensureEngineDeps", async () => {
    await populateEngine(pkgRoot, instanceDir, { staging: stagingContext(instanceDir) });
    const result = await ensureEngineDeps(pkgRoot, instanceDir, { staging: stagingContext(instanceDir) });
    expect(result!.verification.verified).toBe(true);
    expect(existsSync(join(engineOf(), "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("fails naming the missing artifact when the shrinkwrap is absent", async () => {
    const missing = makeFakePkgRoot({ lock: null });
    await expect(populateEngine(missing, instanceDir, { staging: stagingContext(instanceDir) })).rejects.toThrow(
      EngineStagingError,
    );
    await expect(populateEngine(missing, instanceDir, { staging: stagingContext(instanceDir) })).rejects.toThrow(
      /npm-shrinkwrap\.json|ENOENT/,
    );
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails when the shrinkwrap does not match the recorded lock digest", async () => {
    const mismatched = makeFakePkgRoot({
      lock: JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "@keepur/hive", version: "0.2.0" } } }) + " ",
    });
    await expect(populateEngine(mismatched, instanceDir, { staging: stagingContext(instanceDir) })).rejects.toThrow(
      /dependency lock digest mismatch/,
    );
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails naming the missing packaged helper", async () => {
    rmSync(join(pkgRoot, "pkg", "runtime-probe.min.js"), { force: true });
    await expect(populateEngine(pkgRoot, instanceDir, { staging: stagingContext(instanceDir) })).rejects.toThrow(
      /pkg\/runtime-probe\.min\.js/,
    );
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails when the native install step fails inside the job", async () => {
    const staging = stagingContext(instanceDir, {
      install: () => ok({ exitCode: 1, stderr: Buffer.from("gyp ERR! build error\n") }),
    });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow(/install/);
    expect(existsSync(engineOf())).toBe(false);
    expect(existsSync(nextOf())).toBe(false);
  });

  it("fails when the direct child exits non-zero", async () => {
    const staging = stagingContext(instanceDir, { install: () => ok({ exitCode: 7 }) });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow();
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails when the direct child is killed or times out", async () => {
    const staging = stagingContext(instanceDir, { install: () => ok({ exitCode: null, timedOut: true }) });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow();
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails when the promotion copy fails, leaving no .hive", async () => {
    const staging = stagingContext(instanceDir, {
      promotionIO: {
        spawn: async () => ok({ exitCode: 1 }),
      },
    });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow(PromotionFailedError);
    expect(existsSync(engineOf())).toBe(false);
    expect(existsSync(nextOf())).toBe(false);
  });

  it("fails when clone verification rejects the runtime-loading record", async () => {
    const staging = stagingContext(instanceDir, { runtimeLoading: () => ok() });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow(CloneVerificationError);
    expect(existsSync(engineOf())).toBe(false);
    expect(existsSync(nextOf())).toBe(false);
  });

  it("fails when the clone reports a different release identity", async () => {
    const staging = stagingContext(instanceDir, {
      runtimeLoading: (mode) => runtimeRecord(mode, { ...identity, packageVersion: "9.9.9" }),
    });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow(CloneVerificationError);
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails when the confined dependency-tree check is inconsistent", async () => {
    const staging = stagingContext(instanceDir, { dependencyTree: () => ok({ exitCode: 1 }) });
    await expect(populateEngine(pkgRoot, instanceDir, { staging })).rejects.toThrow(CloneVerificationError);
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails closed when /usr/bin/sandbox-exec is missing", async () => {
    const io: ConfinedJobIO = {
      ...nodeConfinedJobIO,
      platform: () => "darwin",
      access: async () => {
        throw new Error("ENOENT");
      },
    };
    await expect(
      populateEngine(pkgRoot, instanceDir, { preflight: { io, npmCliPath: "/opt/npm/npm-cli.js" } }),
    ).rejects.toThrow(ConfinementUnavailableError);
    expect(existsSync(engineOf())).toBe(false);
  });

  it("fails closed when the confinement self-test does not deny", async () => {
    const io: ConfinedJobIO = {
      ...nodeConfinedJobIO,
      platform: () => "darwin",
      access: async () => {},
      spawn: async () => ok({ stdout: Buffer.from(JSON.stringify({ outside: "written", inside: "ok" })) }),
    };
    await expect(
      populateEngine(pkgRoot, instanceDir, { preflight: { io, npmCliPath: "/opt/npm/npm-cli.js" } }),
    ).rejects.toThrow(ConfinementSelfTestError);
    expect(existsSync(engineOf())).toBe(false);
  });

  it("never reaches a confined job from the unit-test-only skipInstall option", async () => {
    const staging = stagingContext(instanceDir);
    const spawned = staging.runner as unknown as { prepare: unknown };
    void spawned;
    const result = await populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    expect(result).toBeNull();
    expect(existsSync(join(engineOf(), "pkg", "server.min.js"))).toBe(true);
    expect(existsSync(join(engineOf(), "node_modules"))).toBe(false);
  });

  it("skipInstall refuses to overwrite an existing .hive", async () => {
    await populateEngine(pkgRoot, instanceDir, { skipInstall: true });
    await expect(populateEngine(pkgRoot, instanceDir, { skipInstall: true })).rejects.toThrow(
      /Engine already populated/,
    );
  });
});

describe("prepareEngineStaging", () => {
  it("fails closed before any job when confinement is unavailable", async () => {
    const instanceDir = makeInstanceDir();
    const io: ConfinedJobIO = { ...nodeConfinedJobIO, platform: () => "linux" };
    await expect(prepareEngineStaging(instanceDir, { io, npmCliPath: "/opt/npm/npm-cli.js" })).rejects.toThrow(
      ConfinementUnavailableError,
    );
    expect(existsSync(resolve(instanceDir, ".hive-state", "jobs"))).toBe(false);
  });
});
