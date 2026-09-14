import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { acquireOperation, persistOperation, type AcquiredOperation } from "./operation.js";
import {
  BOOTSTRAP_VALIDATED,
  BootstrapUnresolvedError,
  initialBootstrapWork,
  reconcileBootstrap,
  runBootstrap,
  TOOLING_VALIDATE_ARGS,
  type BootstrapDeps,
} from "./bootstrap.js";
import { nodeConfinedJobIO, SANDBOX_EXEC, type ConfinedJobIO, type ConfinedProcessResult } from "./confined-job.js";
import { readRegisteredRecord, type BootstrapRecord } from "./pilot-records.js";
import { parseDeploymentArguments } from "./main.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REVISION = "c".repeat(40);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

interface Fixture {
  home: string;
  archive: string;
  archiveSha: string;
  helperSha: string;
  npmCli: string;
}

function fixture(options: { revision?: string } = {}): Fixture {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-bootstrap-")));
  roots.push(root);
  const home = resolve(root, "instance");
  mkdirSync(home, { mode: 0o755 });
  writeFileSync(resolve(home, "hive.yaml"), "instance:\n  id: dodi\n", { mode: 0o644 });
  const pkgRoot = resolve(root, "build", "package");
  mkdirSync(resolve(pkgRoot, "pkg", "mcp"), { recursive: true, mode: 0o755 });
  const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { "": { version: "1.2.3" } } }));
  writeFileSync(resolve(pkgRoot, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "1.2.3" }));
  writeFileSync(resolve(pkgRoot, "npm-shrinkwrap.json"), lock);
  for (const file of [
    "server.min.js",
    "cli.min.js",
    "voice-worker.min.js",
    "voice-worker-diagnostic.min.js",
    "runtime-probe.min.js",
    "mcp/voice-livekit.min.js",
  ]) {
    writeFileSync(resolve(pkgRoot, "pkg", file), `// ${file}\n`);
  }
  const helper = Buffer.from("// frozen deployment helper\n");
  writeFileSync(resolve(pkgRoot, "pkg", "deploy.min.js"), helper);
  writeFileSync(
    resolve(pkgRoot, "pkg", "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageVersion: "1.2.3",
      sourceRevision: options.revision ?? REVISION,
      sourceDirty: false,
      dependencyLockSha256: sha(lock),
      voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
    }),
  );
  const archive = resolve(root, "candidate.tgz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", resolve(root, "build"), "package"]);
  const npmCli = resolve(root, "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "// npm\n", { mode: 0o644 });
  return { home, archive, archiveSha: sha(readFileSync(archive)), helperSha: sha(helper), npmCli };
}

interface JobHooks {
  calls: string[];
  validateOutput?: (entry: string) => string;
  beforeValidate?: (entry: string) => void;
  crashAfterValidate?: boolean;
}

function jobIO(f: Fixture, hooks: JobHooks): ConfinedJobIO {
  return {
    ...nodeConfinedJobIO,
    async spawn(command, args, options): Promise<ConfinedProcessResult> {
      expect(command).toBe(SANDBOX_EXEC);
      expect(args[0]).toBe("-p");
      const [tool, ...rest] = args.slice(2);
      const done = (stdout = "", exitCode = 0): ConfinedProcessResult => ({
        exitCode,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      });
      if (tool === "/usr/bin/tar") {
        hooks.calls.push(`tar:${rest[0]}`);
        const result = spawnSync(tool, rest, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 });
        return {
          exitCode: result.status,
          signal: null,
          timedOut: false,
          outputTruncated: false,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
      if (rest[0] === f.npmCli) {
        hooks.calls.push(`npm:${rest[1]}`);
        if (rest[1] === "ci") {
          mkdirSync(resolve(options.cwd, "node_modules", "dep"), { recursive: true, mode: 0o755 });
          writeFileSync(resolve(options.cwd, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
        }
        return done();
      }
      if (rest[0]?.endsWith("/pkg/cli.min.js")) {
        hooks.calls.push(`validate:${rest.slice(1).join(" ")}`);
        const entry = dirname(dirname(rest[0]));
        hooks.beforeValidate?.(entry);
        if (hooks.validateOutput) return done(hooks.validateOutput(entry));
        const release = JSON.parse(readFileSync(resolve(entry, "pkg", "release.json"), "utf8"));
        return done(`TOOLING_VALIDATE_OK ${JSON.stringify({ manifest: release })}\n`);
      }
      throw new Error(`unexpected confined command ${tool}`);
    },
  };
}

function deps(f: Fixture, hooks: JobHooks): BootstrapDeps {
  return {
    nodePath: realpathSync(process.execPath),
    npmCliPath: f.npmCli,
    pathEnv: "/usr/bin:/bin",
    invokingHome: f.home,
    selfTest: async () => ({
      outcome: "passed",
      macosVersion: "test",
      sandboxExec: SANDBOX_EXEC,
      profileSha256: "e".repeat(64),
      checkedAt: new Date().toISOString(),
    }),
    runnerOptions: { io: jobIO(f, hooks) },
    selectMethod: async () => ({ method: "full-copy", reason: "non-apfs-volume", filesystemType: "test" }),
  };
}

async function bootstrapOperation(f: Fixture, helperSha = f.helperSha, reviewedSha = f.archiveSha) {
  return acquireOperation({
    instanceHome: f.home,
    instanceId: "dodi",
    mode: "bootstrap",
    workKind: "bootstrap",
    bootstrap: initialBootstrapWork({
      artifact: f.archive,
      sha256: reviewedSha,
      revision: REVISION,
      sourceHelper: resolve(f.home, ".hive-state", "bootstrap", ".prepare-x", "package", "pkg", "deploy.min.js"),
    }),
    toolSha256: helperSha,
    ownerStartTime: "start",
  });
}

async function releaseLock(operation: AcquiredOperation) {
  const { finishOperationLock } = await import("./operation.js");
  await finishOperationLock(operation);
}

const configPath = (f: Fixture) => resolve(f.home, "hive.yaml");

// Real tar, exclusive fsynced registry/operation writes: slow on APFS by design.
describe("durable tooling bootstrap", { timeout: 120_000 }, () => {
  it("stages, verifies, renames to the final digest name and registers the record last", async () => {
    const f = fixture();
    const hooks: JobHooks = { calls: [] };
    const operation = await bootstrapOperation(f);
    const result = await runBootstrap(operation, { configPath: configPath(f) }, deps(f, hooks));
    const final = resolve(f.home, ".hive-state", "tooling", f.archiveSha);
    expect(result).toEqual({
      status: BOOTSTRAP_VALIDATED,
      packageRoot: final,
      recordPath: result.recordPath,
      archiveSha256: f.archiveSha,
      sourceRevision: REVISION,
    });
    expect(existsSync(resolve(final, "node_modules", "dep", "index.js"))).toBe(true);
    expect(readdirSync(resolve(f.home, ".hive-state", "tooling", ".staging"))).toEqual([]);
    expect(existsSync(resolve(f.home, ".hive-state", "bootstrap", f.archiveSha, "candidate.tgz"))).toBe(true);
    expect(hooks.calls).toContain(`validate:${TOOLING_VALIDATE_ARGS.join(" ")}`);
    expect(hooks.calls.filter((call) => call === "npm:ci")).toHaveLength(1);
    const work = operation.record.bootstrap!;
    expect(work.rename?.state).toBe("observed");
    expect(work.outcome).toBe("validated");
    expect(operation.record.registrations?.[0].state).toBe("committed");
    const instance = { canonicalHome: f.home, configPath: configPath(f), instanceId: "dodi", uid: process.getuid!() };
    const record = await readRegisteredRecord<BootstrapRecord>(result.recordPath, { instance, kind: "bootstrap" });
    expect(record.payload.packageRoot.path).toBe(final);
    expect(record.payload.archive.sha256).toBe(f.archiveSha);
  });

  it("a host-prepared helper without a validated receipt aborts before any self-test, job or install", async () => {
    const f = fixture();
    const hooks: JobHooks = { calls: [] };
    let selfTests = 0;
    const operation = await acquireOperation({
      instanceHome: f.home,
      instanceId: "dodi",
      mode: "bootstrap",
      workKind: "bootstrap",
      bootstrap: initialBootstrapWork({
        artifact: f.archive,
        sha256: f.archiveSha,
        revision: REVISION,
        sourceHelper: resolve(
          f.home,
          ".hive-state",
          "bootstrap",
          `.prepare-${randomUUID()}`,
          "package",
          "pkg",
          "deploy.min.js",
        ),
      }),
      toolSha256: f.helperSha,
      ownerStartTime: "start",
    });
    const d = deps(f, hooks);
    await expect(
      runBootstrap(
        operation,
        { configPath: configPath(f) },
        {
          ...d,
          selfTest: async (options) => {
            selfTests += 1;
            return d.selfTest!(options);
          },
        },
      ),
    ).rejects.toThrow("PREPARATION_ORPHAN_RETAINED");
    expect(selfTests).toBe(0);
    expect(hooks.calls).toEqual([]);
    expect(operation.record.bootstrap?.adoption).toBeNull();
    await releaseLock(operation).catch(() => {});
  });

  it("sweeps staging siblings at start and reuses a final-name entry without reinstalling", async () => {
    const f = fixture();
    const first = await bootstrapOperation(f);
    await runBootstrap(first, { configPath: configPath(f) }, deps(f, { calls: [] }));
    await releaseLock(first);
    const stale = resolve(f.home, ".hive-state", "tooling", ".staging", `${f.archiveSha}.old-operation`);
    mkdirSync(stale, { mode: 0o700 });
    const hooks: JobHooks = { calls: [] };
    const second = await bootstrapOperation(f);
    const result = await runBootstrap(second, { configPath: configPath(f) }, deps(f, hooks));
    expect(existsSync(stale)).toBe(false);
    expect(hooks.calls.some((call) => call.startsWith("npm:"))).toBe(false);
    expect(second.record.bootstrap!.reused).toBe(true);
    expect(result.packageRoot).toBe(resolve(f.home, ".hive-state", "tooling", f.archiveSha));
  });

  it("re-registers a missing record from a re-checked final entry and never replaces a failed re-check", async () => {
    const f = fixture();
    const first = await bootstrapOperation(f);
    const created = await runBootstrap(first, { configPath: configPath(f) }, deps(f, { calls: [] }));
    await releaseLock(first);
    rmSync(dirname(created.recordPath), { recursive: true, force: true });
    const second = await bootstrapOperation(f);
    const again = await runBootstrap(second, { configPath: configPath(f) }, deps(f, { calls: [] }));
    expect(again.recordPath).not.toBe(created.recordPath);
    await releaseLock(second);

    const final = resolve(f.home, ".hive-state", "tooling", f.archiveSha);
    const releasePath = resolve(final, "pkg", "release.json");
    const release = JSON.parse(readFileSync(releasePath, "utf8"));
    chmodSync(releasePath, 0o644);
    writeFileSync(releasePath, JSON.stringify({ ...release, sourceDirty: true }));
    const third = await bootstrapOperation(f);
    await expect(runBootstrap(third, { configPath: configPath(f) }, deps(f, { calls: [] }))).rejects.toBeInstanceOf(
      BootstrapUnresolvedError,
    );
    expect(existsSync(final)).toBe(true);
  });

  it("discards the staging sibling when the validate-only success record is missing, even on exit 0", async () => {
    const f = fixture();
    const operation = await bootstrapOperation(f);
    const hooks: JobHooks = { calls: [], validateOutput: () => "" };
    await expect(runBootstrap(operation, { configPath: configPath(f) }, deps(f, hooks))).rejects.toThrow();
    expect(existsSync(resolve(f.home, ".hive-state", "tooling", f.archiveSha))).toBe(false);
    expect(readdirSync(resolve(f.home, ".hive-state", "tooling", ".staging"))).toEqual([]);
    expect(operation.record.registrations ?? []).toEqual([]);
  });

  it("requires an absent final-name destination at rename", async () => {
    const f = fixture();
    const operation = await bootstrapOperation(f);
    const hooks: JobHooks = {
      calls: [],
      beforeValidate: () => mkdirSync(resolve(f.home, ".hive-state", "tooling", f.archiveSha), { mode: 0o700 }),
    };
    await expect(runBootstrap(operation, { configPath: configPath(f) }, deps(f, hooks))).rejects.toBeInstanceOf(
      BootstrapUnresolvedError,
    );
    expect(operation.record.bootstrap!.rename).toBeNull();
  });

  it("refuses an unreviewed digest, a foreign helper or a revision mismatch before any install", async () => {
    const f = fixture();
    const wrongDigest = await bootstrapOperation(f, f.helperSha, "b".repeat(64));
    const hooks: JobHooks = { calls: [] };
    await expect(runBootstrap(wrongDigest, { configPath: configPath(f) }, deps(f, hooks))).rejects.toThrow("reviewed");
    expect(hooks.calls).toEqual([]);
    await releaseLock({ ...wrongDigest });

    const foreignHelper = await bootstrapOperation(f, "d".repeat(64));
    const helperHooks: JobHooks = { calls: [] };
    await expect(runBootstrap(foreignHelper, { configPath: configPath(f) }, deps(f, helperHooks))).rejects.toThrow(
      "pkg/deploy.min.js",
    );
    expect(helperHooks.calls.some((call) => call.startsWith("npm:"))).toBe(false);
  });

  it("reconciles a crash before the rename as aborted and after the rename as validated with its registration", async () => {
    const f = fixture();
    const before = await bootstrapOperation(f);
    const crash = new Error("frozen helper killed after verification");
    const hooks: JobHooks = {
      calls: [],
      beforeValidate: () => undefined,
    };
    const crashingDeps = deps(f, hooks);
    const originalSpawn = crashingDeps.runnerOptions!.io!.spawn;
    crashingDeps.runnerOptions!.io!.spawn = async (command, args, options) => {
      const result = await originalSpawn(command, args, options);
      if (args[2] === crashingDeps.nodePath && args[3]?.endsWith("/pkg/cli.min.js")) throw crash;
      return result;
    };
    await expect(runBootstrap(before, { configPath: configPath(f) }, crashingDeps)).rejects.toBe(crash);
    const reconciledBefore = await reconcileBootstrap(before, {
      ...deps(f, { calls: [] }),
      configPath: configPath(f),
      isProcessLive: async () => false,
    });
    expect(reconciledBefore.outcome).toBe("aborted");
    expect(readdirSync(resolve(f.home, ".hive-state", "tooling", ".staging"))).toEqual([]);
    expect(existsSync(resolve(f.home, ".hive-state", "tooling", f.archiveSha))).toBe(false);
    await releaseLock(before);

    const after = await bootstrapOperation(f);
    const registerCrash = deps(f, { calls: [] });
    // Crash between the observed rename and registration: fail the Node seal.
    registerCrash.nodePath = resolve(f.home, "missing-node");
    await expect(runBootstrap(after, { configPath: configPath(f) }, registerCrash)).rejects.toThrow();
    expect(after.record.bootstrap!.rename?.state).toBe("observed");
    expect(after.record.bootstrap!.registration).toBeNull();
    await persistOperation(after);
    const reconciledAfter = await reconcileBootstrap(after, {
      ...deps(f, { calls: [] }),
      configPath: configPath(f),
      isProcessLive: async () => false,
    });
    expect(reconciledAfter.outcome).toBe("validated");
    expect(after.record.bootstrap!.registration).not.toBeNull();
  });
});

describe("runbook helper argument contract", () => {
  const artifact = "/tmp/candidate.tgz";
  const good = ["--bootstrap", `--artifact=${artifact}`, `--sha256=${"a".repeat(64)}`, `--revision=${REVISION}`];

  it("accepts the exact bootstrap invocation and rejects missing or malformed review inputs", () => {
    expect(parseDeploymentArguments(good)).toMatchObject({ mode: "bootstrap", artifact, sha256: "a".repeat(64) });
    expect(() => parseDeploymentArguments(good.slice(0, 3))).toThrow("--revision");
    expect(() => parseDeploymentArguments([...good.slice(0, 2), "--sha256=abc", `--revision=${REVISION}`])).toThrow();
    expect(() => parseDeploymentArguments([...good, "--tag=latest"])).toThrow();
    expect(() => parseDeploymentArguments([...good, "--rollback"])).toThrow("mutually exclusive");
    expect(() => parseDeploymentArguments([...good, `--sha256=${"b".repeat(64)}`])).toThrow("duplicate");
    expect(() => parseDeploymentArguments([`--sha256=${"a".repeat(64)}`])).toThrow("only with --bootstrap");
  });

  it("requires absolute selectors and mode-specific flags for pilot/hold modes", () => {
    const selector = "/Users/example/services/hive/dodi/.hive-state/deployment/registry/x/payload.json";
    expect(parseDeploymentArguments(["--capture-pilot", `--bootstrap-record=${selector}`]).mode).toBe("capture-pilot");
    expect(() => parseDeploymentArguments(["--capture-pilot"])).toThrow("--bootstrap-record");
    expect(() => parseDeploymentArguments([`--bootstrap-record=${selector}`])).toThrow();
    expect(() => parseDeploymentArguments(["--capture-pilot", "--bootstrap-record=relative.json"])).toThrow("absolute");
    expect(() =>
      parseDeploymentArguments([`--inventory-pilot=${selector}`, `--verify-legacy-hold=${selector}`]),
    ).toThrow("mutually exclusive");
    expect(() => parseDeploymentArguments([`--prepare-legacy-hold=${selector}`, `--artifact=${artifact}`])).toThrow();
    expect(() => parseDeploymentArguments([`--release-legacy-hold=${selector}`, "--pilot-sdk-port=8081"])).toThrow();
    expect(parseDeploymentArguments([`--verify-legacy-hold=${selector}`, "--dry-run"]).dryRun).toBe(true);
  });
});
