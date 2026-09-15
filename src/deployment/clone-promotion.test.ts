import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sha256 } from "./release.js";
import {
  ConfinedJobRunner,
  SANDBOX_EXEC,
  nodeConfinedJobIO,
  type ConfinedJobIO,
  type ConfinedProcessResult,
  type ConfinementSelfTest,
  type SpawnOptions,
} from "./confined-job.js";
import {
  CANDIDATE_RUNTIME_LOADING_PROBES,
  CP,
  CloneVerificationError,
  InsufficientSpaceError,
  PromotionCopyBusyError,
  PromotionFailedError,
  PromotionPreflightError,
  discardToolingStaging,
  nodePromotionIO,
  parseFilesystemType,
  promoteAndVerify,
  promoteTree,
  reconcileStaging,
  selectPromotionMethod,
  settled,
  sweepLeftoverJobs,
  verifyClone,
  type CloneVerificationOptions,
  type PromotionIO,
  type PromotionRecord,
  type ReleaseIdentity,
} from "./clone-promotion.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-promotion-")));
  roots.push(root);
  const home = resolve(root, "instance & home");
  mkdirSync(home, { mode: 0o700 });
  return home;
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

type Call = { command: string; args: readonly string[]; options: SpawnOptions };

function promotionIO(overrides: Partial<PromotionIO> = {}, spawnImpl?: (call: Call) => Promise<ConfinedProcessResult>) {
  const calls: Call[] = [];
  const io: PromotionIO = {
    ...nodePromotionIO,
    filesystemType: vi.fn(async () => "apfs"),
    freeBytes: vi.fn(async () => Number.MAX_SAFE_INTEGER),
    processStartTime: vi.fn(async () => "Mon Sep 14 04:00:00 2026"),
    spawn: vi.fn(async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      if (spawnImpl) return spawnImpl(call);
      const onSpawn = options.onSpawn;
      return nodePromotionIO.spawn(command, args, { ...options, onSpawn: onSpawn ? () => onSpawn(4242) : undefined });
    }),
    ...overrides,
  };
  return { io, calls };
}

const lockBytes = Buffer.from(
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "@keepur/hive", version: "1.2.3" } } }),
);

const identity: ReleaseIdentity = {
  packageVersion: "1.2.3",
  sourceRevision: "a".repeat(40),
  dependencyLockSha256: sha256(lockBytes),
};

const pkgFiles = [
  "pkg/server.min.js",
  "pkg/cli.min.js",
  "pkg/voice-worker.min.js",
  "pkg/voice-worker-diagnostic.min.js",
  "pkg/runtime-probe.min.js",
  "pkg/deploy.min.js",
  "pkg/mcp/voice-livekit.min.js",
];

/** A complete package tree as an install job would leave it. */
function releaseTree(root: string): Map<string, string> {
  mkdirSync(resolve(root, "pkg", "mcp"), { recursive: true });
  mkdirSync(resolve(root, "node_modules", ".bin"), { recursive: true });
  mkdirSync(resolve(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(resolve(root, "node_modules", "dep", "cli.js"), "cli");
  symlinkSync("../dep/cli.js", resolve(root, "node_modules", ".bin", "dep"));
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "1.2.3" }));
  writeFileSync(resolve(root, "npm-shrinkwrap.json"), lockBytes);
  const members = new Map<string, string>();
  for (const file of pkgFiles) {
    writeFileSync(resolve(root, file), `// ${file}\n`);
    members.set(file, sha256(readFileSync(resolve(root, file))));
  }
  writeFileSync(
    resolve(root, "pkg", "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      ...identity,
      sourceDirty: false,
      voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
    }),
  );
  members.set("pkg/release.json", sha256(readFileSync(resolve(root, "pkg", "release.json"))));
  return members;
}

const passed: ConfinementSelfTest = {
  outcome: "passed",
  macosVersion: "26.6.2",
  sandboxExec: SANDBOX_EXEC,
  profileSha256: "b".repeat(64),
  checkedAt: "2026-09-14T00:00:00.000Z",
};

function verificationRunner(
  home: string,
  respond: (args: readonly string[]) => ConfinedProcessResult = (args) => runtimeSuccess(args, identity),
) {
  const commands: string[] = [];
  const io: ConfinedJobIO = {
    ...nodeConfinedJobIO,
    platform: () => "darwin",
    spawn: vi.fn(async (command, args) => {
      commands.push(command);
      return respond(args.slice(2));
    }),
  };
  return {
    runner: new ConfinedJobRunner({ canonicalInstanceHome: home, operationId: "op-v", selfTest: passed, io }),
    commands,
  };
}

function runtimeSuccess(args: readonly string[], reported: ReleaseIdentity): ConfinedProcessResult {
  const mode = args.at(-1);
  if (mode === "offline")
    return ok({ stdout: Buffer.from(`ARTIFACT_RUNTIME_OK ${JSON.stringify({ manifest: reported })}\n`) });
  if (mode === "engine-validate") {
    return ok({ stdout: Buffer.from(`ENGINE_VALIDATE_OK ${JSON.stringify({ manifest: reported })}\n`) });
  }
  return ok();
}

function verificationOptions(home: string, clone: string, members: Map<string, string>, runner: ConfinedJobRunner) {
  return {
    clone,
    archiveSha256: "c".repeat(64),
    expectedRelease: identity,
    requireClean: true,
    archiveMembers: members,
    runner,
    nodePath: "/opt/node",
    npmCliPath: "/opt/npm/bin/npm-cli.js",
    pathEnv: "/usr/bin:/bin",
    dependencyTree: true,
    runtimeLoading: CANDIDATE_RUNTIME_LOADING_PROBES,
  } satisfies CloneVerificationOptions;
}

describe("promotion method preflight", () => {
  it("parses the destination filesystem type from df and mount output", () => {
    const df =
      "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 50 50 50% /System/Volumes/Data\n";
    const mount = "/dev/disk3s1s1 on / (apfs, sealed)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)\n";
    expect(parseFilesystemType(df, mount)).toBe("apfs");
    expect(() => parseFilesystemType("garbage", mount)).toThrow("mount point");
  });

  it("fixes clone on a same-volume APFS destination after a successful cp -c probe", async () => {
    const home = scratch();
    mkdirSync(resolve(home, ".hive-state", "jobs", "op"), { recursive: true });
    const { io, calls } = promotionIO();
    const selection = await selectPromotionMethod({
      sourceParent: resolve(home, ".hive-state", "jobs", "op"),
      destinationParent: home,
      io,
    });
    expect(selection).toEqual({ method: "clone", reason: "apfs-clone", filesystemType: "apfs" });
    expect(calls[0].command).toBe(CP);
    expect(calls[0].args[0]).toBe("-c");
    expect(existsSync(resolve(home, `.hive-promotion-probe-${String(calls[0].args[2]).split("probe-")[1]}`))).toBe(
      false,
    );
  });

  it("fixes full copy for a non-APFS or cross-volume destination without probing clone", async () => {
    const home = scratch();
    const { io, calls } = promotionIO({ filesystemType: vi.fn(async () => "msdos") });
    expect((await selectPromotionMethod({ sourceParent: home, destinationParent: home, io })).method).toBe("full-copy");
    const realLstat = nodePromotionIO.lstat;
    let first = true;
    const cross = promotionIO({
      lstat: vi.fn(async (path) => {
        const info = await realLstat(path);
        if (first) {
          first = false;
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev: info.dev + 1 });
        }
        return info;
      }),
    });
    expect((await selectPromotionMethod({ sourceParent: home, destinationParent: home, io: cross.io })).reason).toBe(
      "cross-volume",
    );
    expect(calls).toHaveLength(0);
    expect(cross.calls).toHaveLength(0);
  });

  it("fails preflight when an APFS clone probe fails or the volume cannot be classified", async () => {
    const home = scratch();
    const failing = promotionIO({}, async () => ok({ exitCode: 1 }));
    await expect(
      selectPromotionMethod({ sourceParent: home, destinationParent: home, io: failing.io }),
    ).rejects.toThrow(PromotionPreflightError);
    const unknown = promotionIO({
      filesystemType: vi.fn(async () => {
        throw new Error("mount unavailable");
      }),
    });
    await expect(
      selectPromotionMethod({ sourceParent: home, destinationParent: home, io: unknown.io }),
    ).rejects.toThrow(PromotionPreflightError);
  });
});

describe("clone promotion", () => {
  it("clones an exited job's output into an absent destination, preserving links, and journals the fence", async () => {
    const home = scratch();
    const source = resolve(home, ".hive-state", "jobs", "op", "install-1", "package");
    mkdirSync(source, { recursive: true });
    releaseTree(source);
    const records: PromotionRecord[] = [];
    const { io, calls } = promotionIO();
    const destination = resolve(home, ".hive.next");
    const record = await promoteTree({
      source,
      destination,
      method: process.platform === "darwin" ? "clone" : "full-copy",
      io,
      journal: async (entry) => {
        records.push(entry);
      },
    });
    expect(record.state).toBe("observed");
    expect(records.map((entry) => entry.state)).toEqual(["intended", "copying", "observed"]);
    expect(records[1]).toMatchObject({ copyPid: 4242, copyStartTime: "Mon Sep 14 04:00:00 2026" });
    expect(readlinkSync(resolve(destination, "node_modules", ".bin", "dep"))).toBe("../dep/cli.js");
    expect(lstatSync(resolve(destination, "pkg", "server.min.js")).ino).not.toBe(
      lstatSync(resolve(source, "pkg", "server.min.js")).ino,
    );
    expect(calls).toHaveLength(1);
    // A late write into the job directory never reaches the promoted tree.
    writeFileSync(resolve(source, "pkg", "server.min.js"), "tampered");
    expect(readFileSync(resolve(destination, "pkg", "server.min.js"), "utf8")).toBe("// pkg/server.min.js\n");
  });

  it("refuses an occupied destination and never overwrites it", async () => {
    const home = scratch();
    const source = resolve(home, "source");
    mkdirSync(source);
    mkdirSync(resolve(home, ".hive.next"));
    writeFileSync(resolve(home, ".hive.next", "keep"), "x");
    const { io, calls } = promotionIO();
    await expect(
      promoteTree({ source, destination: resolve(home, ".hive.next"), method: "clone", io }),
    ).rejects.toThrow("occupied");
    expect(calls).toHaveLength(0);
    expect(readFileSync(resolve(home, ".hive.next", "keep"), "utf8")).toBe("x");
  });

  it("gates a full copy on free space before any write", async () => {
    const home = scratch();
    const source = resolve(home, "source");
    mkdirSync(source);
    writeFileSync(resolve(source, "big"), Buffer.alloc(4096));
    const journal = vi.fn();
    const { io, calls } = promotionIO({ freeBytes: vi.fn(async () => 1024) });
    await expect(
      promoteTree({ source, destination: resolve(home, ".hive.next"), method: "full-copy", io, journal }),
    ).rejects.toThrow(InsufficientSpaceError);
    expect(calls).toHaveLength(0);
    expect(journal).not.toHaveBeenCalled();
  });

  it.each(["clone", "full-copy"] as const)(
    "discards a partial destination when the %s promotion fails mid-copy and never switches method",
    async (method) => {
      const home = scratch();
      const source = resolve(home, "source");
      mkdirSync(source);
      const destination = resolve(home, ".hive.next");
      const records: PromotionRecord[] = [];
      const { io, calls } = promotionIO({}, async (call) => {
        call.options.onSpawn?.(99);
        mkdirSync(destination);
        writeFileSync(resolve(destination, "torn"), "partial");
        return ok({ exitCode: 1, stderr: Buffer.from("cp: No space left on device") });
      });
      await expect(
        promoteTree({ source, destination, method, io, journal: async (entry) => void records.push(entry) }),
      ).rejects.toThrow(PromotionFailedError);
      expect(existsSync(destination)).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.includes("-c")).toBe(method === "clone");
      expect(records.at(-1)).toMatchObject({ state: "failed", discarded: true, method, exitCode: 1 });
    },
  );
});

describe("clone verification", () => {
  function fixture() {
    const home = scratch();
    const clone = resolve(home, ".hive.next");
    mkdirSync(clone);
    const members = releaseTree(clone);
    return { home, clone, members };
  }

  it("verifies required entries, manifest/lock, containment, archive members, dependency tree and runtime loading", async () => {
    const { home, clone, members } = fixture();
    const { runner, commands } = verificationRunner(home);
    const result = await verifyClone(verificationOptions(home, clone, members, runner));
    expect(result.checks).toEqual([
      "required-entries",
      "manifest-lock",
      "containment",
      "archive-members",
      "dependency-tree",
      "runtime-loading:offline",
      "runtime-loading:engine-validate",
    ]);
    expect(commands.every((command) => command === SANDBOX_EXEC)).toBe(true);
    expect(settled(result.jobs, result)).toBe(true);
    expect(settled([...result.jobs, { ...result.jobs[0], exitCode: 1 }], result)).toBe(false);
    expect(settled(result.jobs, null)).toBe(false);
  });

  it("runs runtime loading with dummy selectors inside its job directory, never the operator home", async () => {
    const { home, clone, members } = fixture();
    const envs: Record<string, string>[] = [];
    const io: ConfinedJobIO = {
      ...nodeConfinedJobIO,
      platform: () => "darwin",
      spawn: vi.fn(async (_command, args, options) => {
        envs.push(options.env);
        return runtimeSuccess(args, identity);
      }),
    };
    const runner = new ConfinedJobRunner({ canonicalInstanceHome: home, operationId: "op-env", selfTest: passed, io });
    await verifyClone(verificationOptions(home, clone, members, runner));
    const runtime = envs.filter((env) => env.HIVE_HOME);
    expect(runtime).toHaveLength(2);
    for (const env of runtime) {
      const jobs = resolve(home, ".hive-state", "jobs", "op-env");
      expect(env.HIVE_HOME.startsWith(jobs)).toBe(true);
      expect(env.HIVE_CONFIG.startsWith(jobs)).toBe(true);
      expect(env.HOME.startsWith(jobs)).toBe(true);
    }
  });

  it.each([
    [
      "a missing required entry",
      (clone: string) => rmSync(resolve(clone, "pkg", "voice-worker.min.js")),
      "required-entries",
    ],
    [
      "a manifest/lock digest mismatch",
      (clone: string) => writeFileSync(resolve(clone, "npm-shrinkwrap.json"), "{}"),
      "manifest-lock",
    ],
    [
      "an escaping symbolic link",
      (clone: string) => symlinkSync("/etc/hosts", resolve(clone, "node_modules", "escape")),
      "containment",
    ],
    [
      "a pkg entry differing from its archive member",
      (clone: string) => writeFileSync(resolve(clone, "pkg", "server.min.js"), "torn write"),
      "archive-members",
    ],
    [
      "an extra pkg entry absent from the archive",
      (clone: string) => writeFileSync(resolve(clone, "pkg", "injected.js"), "x"),
      "archive-members",
    ],
  ])("fails on %s", async (_name, mutate, check) => {
    const { home, clone, members } = fixture();
    mutate(clone);
    const { runner } = verificationRunner(home);
    await expect(verifyClone(verificationOptions(home, clone, members, runner))).rejects.toMatchObject({ check });
  });

  it("fails when the staged archive identity differs from the clone", async () => {
    const { home, clone, members } = fixture();
    const { runner } = verificationRunner(home);
    await expect(
      verifyClone({
        ...verificationOptions(home, clone, members, runner),
        expectedRelease: { ...identity, packageVersion: "9.9.9" },
      }),
    ).rejects.toMatchObject({ check: "manifest-lock" });
  });

  it("fails on an inconsistent dependency tree job", async () => {
    const { home, clone, members } = fixture();
    const { runner } = verificationRunner(home, (args) =>
      args.includes("ls") ? ok({ exitCode: 1 }) : runtimeSuccess(args, identity),
    );
    await expect(verifyClone(verificationOptions(home, clone, members, runner))).rejects.toMatchObject({
      check: "dependency-tree",
    });
  });

  it.each([
    ["a non-zero diagnostic", () => ok({ exitCode: 1 })],
    ["exit 0 without a success record", () => ok({ stdout: Buffer.from("loaded fine\n") })],
    [
      "a success record naming another release",
      (args: readonly string[]) => runtimeSuccess(args, { ...identity, sourceRevision: "f".repeat(40) }),
    ],
  ])("fails runtime loading on %s", async (_name, respond) => {
    const { home, clone, members } = fixture();
    const { runner } = verificationRunner(home, (args) => (args.includes("ls") ? ok() : respond(args)));
    await expect(verifyClone(verificationOptions(home, clone, members, runner))).rejects.toMatchObject({
      check: "runtime-loading:offline",
    });
  });

  it("refuses to verify without the confined job runner", async () => {
    const { home, clone, members } = fixture();
    await expect(
      verifyClone({ ...verificationOptions(home, clone, members, undefined as unknown as ConfinedJobRunner) }),
    ).rejects.toThrow("confined job runner");
  });

  it("promoteAndVerify discards the clone before returning a verification failure", async () => {
    const home = scratch();
    const source = resolve(home, ".hive-state", "jobs", "op", "install-1", "package");
    mkdirSync(source, { recursive: true });
    const members = releaseTree(source);
    const { runner } = verificationRunner(home, (args) => (args.includes("ls") ? ok({ exitCode: 1 }) : ok()));
    const destination = resolve(home, ".hive.next");
    const records: PromotionRecord[] = [];
    const { io } = promotionIO();
    await expect(
      promoteAndVerify({
        source,
        destination,
        method: "full-copy",
        io,
        journal: async (entry) => void records.push(entry),
        verification: { ...verificationOptions(home, destination, members, runner) },
      }),
    ).rejects.toThrow(CloneVerificationError);
    expect(existsSync(destination)).toBe(false);
    expect(records.at(-1)).toMatchObject({ state: "observed", discarded: true });
  });
});

describe("sweep and reconciliation", () => {
  function jobTree(home: string, operationId: string) {
    const path = resolve(home, ".hive-state", "jobs", operationId, "install-1", "package");
    mkdirSync(path, { recursive: true });
    writeFileSync(resolve(path, "output"), "x");
  }

  it("sweeps leftover operation trees except the live operation and reports failures without throwing", async () => {
    const home = scratch();
    jobTree(home, "old-1");
    jobTree(home, "live");
    const foreign = resolve(home, "outside-target");
    mkdirSync(foreign);
    symlinkSync(foreign, resolve(home, ".hive-state", "jobs", "linked"));
    const report = await sweepLeftoverJobs({ canonicalInstanceHome: home, keepOperationIds: ["live"] });
    expect(report.removed).toEqual([resolve(home, ".hive-state", "jobs", "old-1")]);
    expect(report.failures).toEqual([
      { path: resolve(home, ".hive-state", "jobs", "linked"), message: expect.any(String) },
    ]);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(resolve(home, ".hive-state", "jobs", "live"))).toBe(true);

    jobTree(home, "old-2");
    const failing = promotionIO({
      rm: vi.fn(async () => {
        throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
      }),
    });
    const failed = await sweepLeftoverJobs({ canonicalInstanceHome: home, keepOperationIds: ["live"], io: failing.io });
    expect(failed.failures.some((failure) => failure.path.endsWith("old-2"))).toBe(true);
  });

  it("discards tooling staging siblings and leaves final-name entries", async () => {
    const home = scratch();
    const tooling = resolve(home, ".hive-state", "tooling");
    mkdirSync(resolve(tooling, ".staging", `${"d".repeat(64)}.op-1`), { recursive: true });
    mkdirSync(resolve(tooling, "d".repeat(64)), { recursive: true });
    const report = await discardToolingStaging({ canonicalInstanceHome: home });
    expect(report.removed).toHaveLength(1);
    expect(existsSync(resolve(tooling, "d".repeat(64)))).toBe(true);
  });

  function promotion(home: string, overrides: Partial<PromotionRecord> = {}): PromotionRecord {
    const destination = resolve(home, ".hive.next");
    const info = existsSync(destination) ? lstatSync(destination) : null;
    return {
      method: "clone",
      source: resolve(home, ".hive-state", "jobs", "op", "install-1", "package"),
      destination,
      state: "observed",
      copyPid: 77,
      copyStartTime: "start",
      exitCode: 0,
      destinationIdentity: info ? { dev: info.dev, ino: info.ino } : null,
      discarded: false,
      ...overrides,
    };
  }

  it("discards an unverified recorded clone, sweeps job trees and never adopts a job directory", async () => {
    const home = scratch();
    mkdirSync(resolve(home, ".hive.next"));
    jobTree(home, "op");
    const result = await reconcileStaging({
      canonicalInstanceHome: home,
      staging: { promotion: promotion(home), cloneVerified: false },
      isProcessLive: async () => false,
      includeToolingStaging: true,
    });
    expect(result.discarded).toEqual([resolve(home, ".hive.next")]);
    expect(existsSync(resolve(home, ".hive.next"))).toBe(false);
    expect(existsSync(resolve(home, ".hive-state", "jobs", "op"))).toBe(false);
    expect(result.retainedVerifiedClone).toBeNull();
  });

  it("retains a verified clone for the lifecycle reconciler and refuses a changed identity", async () => {
    const home = scratch();
    mkdirSync(resolve(home, ".hive.next"));
    const verified = await reconcileStaging({
      canonicalInstanceHome: home,
      staging: { promotion: promotion(home), cloneVerified: true },
      isProcessLive: async () => false,
    });
    expect(verified.retainedVerifiedClone).toBe(resolve(home, ".hive.next"));
    const recorded = promotion(home);
    rmSync(resolve(home, ".hive.next"), { recursive: true });
    mkdirSync(resolve(home, ".hive.next"));
    chmodSync(resolve(home, ".hive.next"), 0o700);
    await expect(
      reconcileStaging({
        canonicalInstanceHome: home,
        staging: { promotion: recorded, cloneVerified: false },
        isProcessLive: async () => false,
      }),
    ).rejects.toThrow("identity changed");
    expect(existsSync(resolve(home, ".hive.next"))).toBe(true);
  });

  it("returns busy while the recorded promotion copy is live, then discards the partial destination", async () => {
    const home = scratch();
    const destination = resolve(home, ".hive.next");
    mkdirSync(destination);
    cpSync(destination, `${destination}-unused`, { recursive: true });
    const copying = promotion(home, { state: "copying", destinationIdentity: null });
    await expect(
      reconcileStaging({
        canonicalInstanceHome: home,
        staging: { promotion: copying, cloneVerified: false },
        isProcessLive: async ({ pid }) => pid === 77,
      }),
    ).rejects.toThrow(PromotionCopyBusyError);
    expect(existsSync(destination)).toBe(true);
    const after = await reconcileStaging({
      canonicalInstanceHome: home,
      staging: { promotion: copying, cloneVerified: false },
      isProcessLive: async () => false,
    });
    expect(after.discarded).toEqual([destination]);
  });
});
