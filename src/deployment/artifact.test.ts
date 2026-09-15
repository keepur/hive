import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { sha256 } from "./release.js";
import {
  ConfinedJobFailedError,
  ConfinedJobRunner,
  SANDBOX_EXEC,
  nodeConfinedJobIO,
  type ConfinedJobIO,
  type ConfinedProcessResult,
  type ConfinementSelfTest,
  type SpawnOptions,
} from "./confined-job.js";
import {
  CP,
  CloneVerificationError,
  PromotionFailedError,
  nodePromotionIO,
  type PromotionRecord,
} from "./clone-promotion.js";
import {
  TAR,
  extractAndValidateArtifact,
  installStagedArtifact,
  preflightStagedConfig,
  resolveArtifact,
  stageVerifiedCandidate,
  validateArchiveMembers,
  type ArtifactStagingContext,
  type ExtractedArtifact,
  type ResolvedArtifact,
} from "./artifact.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NODE = "/fixture/bin/node";
const NPM_CLI = "/fixture/lib/npm/bin/npm-cli.js";

const passed: ConfinementSelfTest = {
  outcome: "passed",
  macosVersion: "26.6.2",
  sandboxExec: SANDBOX_EXEC,
  profileSha256: "e".repeat(64),
  checkedAt: "2026-09-14T00:00:00.000Z",
};

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

const lock = Buffer.from(
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "@keepur/hive", version: "2.0.0" } } }),
);
const manifest = {
  schemaVersion: 1,
  packageVersion: "2.0.0",
  sourceRevision: "b".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: sha256(lock),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};

function buildArchive(root: string, mutate?: (packageDir: string) => void): string {
  const stage = resolve(root, "archive-stage");
  const pkg = resolve(stage, "package");
  mkdirSync(resolve(pkg, "pkg", "mcp"), { recursive: true });
  writeFileSync(resolve(pkg, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "2.0.0" }));
  writeFileSync(resolve(pkg, "npm-shrinkwrap.json"), lock);
  for (const file of [
    "server.min.js",
    "cli.min.js",
    "voice-worker.min.js",
    "voice-worker-diagnostic.min.js",
    "runtime-probe.min.js",
    "deploy.min.js",
    "mcp/voice-livekit.min.js",
  ]) {
    writeFileSync(resolve(pkg, "pkg", file), `// ${file}\n`);
  }
  writeFileSync(resolve(pkg, "pkg", "release.json"), JSON.stringify(manifest));
  mutate?.(pkg);
  const archive = resolve(root, "keepur-hive-2.0.0.tgz");
  execFileSync(TAR, ["-czf", archive, "package"], { cwd: stage });
  rmSync(stage, { recursive: true });
  return archive;
}

type Call = { command: string; args: readonly string[]; options: SpawnOptions };

interface Behaviour {
  install?: () => ConfinedProcessResult | null;
  extract?: () => ConfinedProcessResult | null;
  diagnostic?: (mode: string) => ConfinedProcessResult;
  packSource?: string;
  configProbe?: () => ConfinedProcessResult;
}

/**
 * Test-only launcher: records every confined argv and emulates the confined
 * command's effects. The real Seatbelt primitive is exercised by
 * confined-job.test.ts (sanity) and S9 integration, not here.
 */
function harness(behaviour: Behaviour = {}) {
  const parent = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-artifact-")));
  roots.push(parent);
  const home = resolve(parent, "instance & home");
  mkdirSync(resolve(home, ".hive-state", "deployment", "operations", "op-a"), { recursive: true, mode: 0o700 });
  const calls: Call[] = [];
  const io: ConfinedJobIO = {
    ...nodeConfinedJobIO,
    platform: () => "darwin",
    spawn: vi.fn(async (command, args, options) => {
      calls.push({ command, args, options });
      if (command !== SANDBOX_EXEC) throw new Error(`unconfined artifact subprocess: ${command}`);
      const [flag, , tool, ...rest] = args;
      expect(flag).toBe("-p");
      if (tool === TAR) {
        if (rest[0] === "-xzf") {
          const override = behaviour.extract?.();
          if (override) return override;
        }
        const stdout = execFileSync(TAR, rest, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 });
        return ok({ stdout });
      }
      if (tool !== NODE) throw new Error(`unexpected confined tool ${tool}`);
      if (rest[0] === NPM_CLI && rest[1] === "pack") {
        const destination = rest[rest.indexOf("--pack-destination") + 1];
        copyFileSync(behaviour.packSource!, resolve(destination, basename(behaviour.packSource!)));
        return ok({ stdout: Buffer.from(JSON.stringify([{ filename: basename(behaviour.packSource!) }])) });
      }
      if (rest[0] === NPM_CLI && rest[1] === "ci") {
        const override = behaviour.install?.();
        if (override) return override;
        mkdirSync(resolve(options.cwd, "node_modules", "dep"), { recursive: true });
        writeFileSync(resolve(options.cwd, "node_modules", "dep", "index.js"), "module.exports = 1;");
        return ok();
      }
      if (rest[0] === NPM_CLI && rest[1] === "ls") return ok();
      if (rest[0]?.endsWith("voice-worker-diagnostic.min.js")) {
        const mode = rest[1];
        if (behaviour.diagnostic) return behaviour.diagnostic(mode);
        const prefix = mode === "offline" ? "ARTIFACT_RUNTIME_OK" : "ENGINE_VALIDATE_OK";
        return ok({ stdout: Buffer.from(`${prefix} ${JSON.stringify({ manifest })}\n`) });
      }
      if (rest[0]?.endsWith("runtime-probe.min.js")) {
        return (
          behaviour.configProbe?.() ??
          ok({ stdout: Buffer.from(JSON.stringify({ ok: true, instanceId: "dodi", database: { name: "hive_dodi" } })) })
        );
      }
      throw new Error(`unexpected confined command ${rest.join(" ")}`);
    }),
  };
  const promotions: Call[] = [];
  const promotionIO = {
    ...nodePromotionIO,
    spawn: vi.fn(async (command: string, args: readonly string[], options: SpawnOptions) => {
      promotions.push({ command, args, options });
      return nodePromotionIO.spawn(command, args, options);
    }),
  };
  const runner = new ConfinedJobRunner({ canonicalInstanceHome: home, operationId: "op-a", selfTest: passed, io });
  const context: ArtifactStagingContext = {
    runner,
    nodePath: NODE,
    npmCliPath: NPM_CLI,
    invokingHome: resolve(parent, "operator-home"),
    pathEnv: "/usr/bin:/bin",
    archiveDirectory: resolve(home, ".hive-state", "deployment", "operations", "op-a", "archive"),
    promotionMethod: "full-copy",
    promotionIO,
  };
  return { parent, home, calls, promotions, context, next: resolve(home, ".hive.next") };
}

describe("archive boundary", () => {
  it("accepts ordinary package files and directories", () => {
    expect(
      validateArchiveMembers(
        "package/\npackage/pkg/server.min.js\n",
        "drwx------ package/\n-rw------- package/pkg/server.min.js\n",
      ),
    ).toHaveLength(2);
  });

  it.each([
    ["traversal", "package/../hive.yaml\n", "-rw------- package/../hive.yaml\n"],
    ["operator state", "package/.env\n", "-rw------- package/.env\n"],
    ["symlink", "package/pkg/server.min.js\n", "lrwxr-xr-x package/pkg/server.min.js -> /tmp/server\n"],
  ])("rejects %s archive input", (_name, names, details) => {
    expect(() => validateArchiveMembers(names, details)).toThrow();
  });
});

describe("confined artifact staging", () => {
  it("refuses every artifact entrypoint without the confined job runner before any subprocess", async () => {
    const { context, calls, promotions, next } = harness();
    const unconfined = { ...context, runner: undefined } as unknown as ArtifactStagingContext;
    const artifact: ResolvedArtifact = {
      archivePath: "/tmp/a.tgz",
      archiveSha256: "0".repeat(64),
      source: { kind: "local", path: "/tmp/a.tgz" },
    };
    await expect(resolveArtifact({ tag: "latest" }, unconfined)).rejects.toThrow("confined job runner");
    await expect(extractAndValidateArtifact(artifact, unconfined, false)).rejects.toThrow("confined job runner");
    await expect(installStagedArtifact({} as ExtractedArtifact, unconfined)).rejects.toThrow("confined job runner");
    await expect(
      stageVerifiedCandidate({
        selector: { tag: "latest" },
        context: unconfined,
        destination: next,
        requireClean: false,
      }),
    ).rejects.toThrow("confined job runner");
    await expect(
      preflightStagedConfig({ clone: next, context: unconfined, serviceEnvironment: {}, expectedInstanceId: "dodi" }),
    ).rejects.toThrow("confined job runner");
    expect(calls).toHaveLength(0);
    expect(promotions).toHaveLength(0);
  });

  it("stages a local artifact through confined jobs and writes .hive.next only by verified promotion", async () => {
    const h = harness();
    const archive = buildArchive(h.parent);
    const promotionRecords: PromotionRecord[] = [];
    const staged = await stageVerifiedCandidate({
      selector: { artifact: archive },
      context: h.context,
      destination: h.next,
      requireClean: true,
      journalPromotion: async (record) => void promotionRecords.push(record),
    });
    expect(staged.artifact.archiveSha256).toBe(sha256(readFileSync(archive)));
    expect(staged.artifact.archivePath.startsWith(h.context.archiveDirectory)).toBe(true);
    expect(staged.verification.checks).toContain("archive-members");
    expect(staged.verification.checks).toContain("runtime-loading:engine-validate");
    expect(existsSync(resolve(h.next, "node_modules", "dep", "index.js"))).toBe(true);
    expect(promotionRecords.at(-1)).toMatchObject({ state: "observed", destination: h.next, method: "full-copy" });

    // Every artifact subprocess is a sandbox-exec argv; only the orchestrator's promotion copy is /bin/cp.
    expect(h.calls.every((call) => call.command === SANDBOX_EXEC)).toBe(true);
    expect(h.promotions.every((call) => call.command === CP && !call.args.includes("-c"))).toBe(true);
    const jobs = resolve(h.home, ".hive-state", "jobs", "op-a");
    for (const call of h.calls) {
      const profile = String(call.args[1]);
      const writable = profile.match(/\(subpath "([^"]+)"\)/)?.[1] ?? "";
      expect(relative(jobs, writable).startsWith("..")).toBe(false);
      expect(writable.startsWith(h.next)).toBe(false);
    }
    // No job directory was promoted: the promotion source was a job tree, the destination a distinct clone.
    expect(staged.installed.root.startsWith(jobs)).toBe(true);
    expect(staged.promotion.source).toBe(staged.installed.root);
  });

  it("fetches a registry selector as a confined job and clones the archive out of the job directory", async () => {
    const h = harness();
    const archive = buildArchive(h.parent);
    const behaviourHarness = harness({ packSource: archive });
    const resolved = await resolveArtifact({ tag: "v2.0.0" }, behaviourHarness.context);
    expect(resolved.source).toMatchObject({ kind: "registry", selector: "2.0.0" });
    expect(resolved.archivePath.startsWith(behaviourHarness.context.archiveDirectory)).toBe(true);
    expect(resolved.archiveSha256).toBe(sha256(readFileSync(archive)));
    const fetch = behaviourHarness.calls[0];
    expect(fetch.args.slice(2)).toEqual([
      NODE,
      NPM_CLI,
      "pack",
      "@keepur/hive@2.0.0",
      "--json",
      "--pack-destination",
      expect.stringContaining("/.hive-state/jobs/op-a/fetch-"),
    ]);
    expect(fetch.options.env.npm_config_cache.includes("/.hive-state/jobs/op-a/fetch-")).toBe(true);
  });

  it("fails before promotion when the install job's direct child exits non-zero", async () => {
    const h = harness({ install: () => ok({ exitCode: 1, stderr: Buffer.from("gyp ERR!") }) });
    const archive = buildArchive(h.parent);
    await expect(
      stageVerifiedCandidate({
        selector: { artifact: archive },
        context: h.context,
        destination: h.next,
        requireClean: false,
      }),
    ).rejects.toThrow(ConfinedJobFailedError);
    expect(existsSync(h.next)).toBe(false);
    expect(h.promotions).toHaveLength(1); // only the intermediate clone into the install job
  });

  it("fails before any install when extraction exits non-zero or members are unsafe", async () => {
    const h = harness({ extract: () => ok({ exitCode: 2 }) });
    const archive = buildArchive(h.parent);
    await expect(
      stageVerifiedCandidate({
        selector: { artifact: archive },
        context: h.context,
        destination: h.next,
        requireClean: false,
      }),
    ).rejects.toThrow(ConfinedJobFailedError);
    expect(existsSync(h.next)).toBe(false);

    const unsafe = harness();
    const linked = buildArchive(unsafe.parent, (pkg) => symlinkSync("/etc/hosts", resolve(pkg, "pkg", "hosts")));
    await expect(
      stageVerifiedCandidate({
        selector: { artifact: linked },
        context: unsafe.context,
        destination: unsafe.next,
        requireClean: false,
      }),
    ).rejects.toThrow("archive links");
    expect(unsafe.calls.some((call) => call.args.includes("-xzf"))).toBe(false);
  });

  it("discards the clone when runtime loading fails verification", async () => {
    const h = harness({ diagnostic: () => ok({ exitCode: 0, stdout: Buffer.from("exited quietly\n") }) });
    const archive = buildArchive(h.parent);
    await expect(
      stageVerifiedCandidate({
        selector: { artifact: archive },
        context: h.context,
        destination: h.next,
        requireClean: false,
      }),
    ).rejects.toThrow(CloneVerificationError);
    expect(existsSync(h.next)).toBe(false);
  });

  it("discards a partial .hive.next when promotion fails mid-copy and does not switch method", async () => {
    const h = harness();
    const archive = buildArchive(h.parent);
    let copies = 0;
    h.context.promotionIO = {
      ...nodePromotionIO,
      spawn: vi.fn(async (command: string, args: readonly string[], options: SpawnOptions) => {
        h.promotions.push({ command, args, options });
        copies += 1;
        if (args.at(-1) === h.next) {
          mkdirSync(h.next);
          writeFileSync(resolve(h.next, "partial"), "x");
          return ok({ exitCode: 1 });
        }
        return nodePromotionIO.spawn(command, args, options);
      }),
    };
    await expect(
      stageVerifiedCandidate({
        selector: { artifact: archive },
        context: h.context,
        destination: h.next,
        requireClean: false,
      }),
    ).rejects.toThrow(PromotionFailedError);
    expect(existsSync(h.next)).toBe(false);
    expect(copies).toBe(2);
    expect(h.promotions.every((call) => !call.args.includes("-c"))).toBe(true);
  });

  it("runs the candidate config probe from the clone as a confined job under the service environment", async () => {
    const h = harness();
    mkdirSync(h.next);
    const result = await preflightStagedConfig({
      clone: h.next,
      context: h.context,
      serviceEnvironment: {
        HOME: "/Users/example",
        PATH: "/usr/bin:/bin",
        HIVE_HOME: h.home,
        HIVE_CONFIG: resolve(h.home, "hive.yaml"),
        VOICE_PORT: "3105",
      },
      expectedInstanceId: "dodi",
      expectedDatabaseName: "hive_dodi",
    });
    expect(result.instanceId).toBe("dodi");
    expect(h.calls[0].command).toBe(SANDBOX_EXEC);
    expect(h.calls[0].options.env).toMatchObject({ HOME: "/Users/example", HIVE_HOME: h.home, VOICE_PORT: "3105" });
    expect(h.calls[0].options.env.TMPDIR.includes("/.hive-state/jobs/op-a/config-probe-")).toBe(true);

    const mismatch = harness({
      configProbe: () => ok({ stdout: Buffer.from(JSON.stringify({ ok: true, instanceId: "keepur" })) }),
    });
    mkdirSync(mismatch.next);
    await expect(
      preflightStagedConfig({
        clone: mismatch.next,
        context: mismatch.context,
        serviceEnvironment: { HOME: "/Users/example", PATH: "/usr/bin" },
        expectedInstanceId: "dodi",
      }),
    ).rejects.toThrow("incompatible");
  });
});
