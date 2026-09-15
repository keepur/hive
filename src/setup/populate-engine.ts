/**
 * `hive init` engine population (KPR-463 plan Task 3 Step 1). `.hive` is
 * produced only as a verified clone of a confined job's output: the source
 * package is validated with `readRelease`, only `PACKAGE_ENTRIES` are copied
 * in-process into a fresh exclusive job directory, the locked production
 * install runs confined in that directory, and the job output is cloned into
 * `.hive.next`, verified by reading the clone only, and finally renamed into
 * place. There is no unconfined install fallback and no direct write to
 * `.hive`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, realpath, rename, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readRelease, type Release } from "../deployment/release.js";
import {
  ConfinedJobRunner,
  requireJobSuccess,
  runConfinementSelfTest,
  type ConfinedJobIO,
  type ConfinedJobResult,
  type ConfinementSelfTest,
} from "../deployment/confined-job.js";
import {
  CANDIDATE_RUNTIME_LOADING_PROBES,
  disposeOperationJobs,
  discardPromotedTree,
  promoteAndVerify,
  releaseIdentity,
  selectPromotionMethod,
  type CloneVerification,
  type PromotionIO,
  type PromotionMethodSelection,
  type PromotionRecord,
  type SweepReport,
} from "../deployment/clone-promotion.js";

/**
 * Entries mirror package.json `files` plus the two members npm always includes
 * in a pack tarball without listing them (`package.json` and, when present,
 * `npm-shrinkwrap.json` — the lock `readRelease` hashes). One path per line.
 * `scripts/honeypot` is a single binary (not the whole scripts/ dir), so the
 * copy must operate on that exact path.
 *
 * Must match Phase 3's `fetch_engine` tarball shape byte-for-byte so `hive
 * update` and `hive init` land on identical `.hive/` layouts. If the package
 * `files` field changes, update both here and deploy.sh's fetch_engine at
 * the same time.
 */
export const PACKAGE_ENTRIES = [
  "pkg",
  "seeds",
  "templates",
  "scripts/honeypot",
  "install",
  "service",
  "package.json",
  "npm-shrinkwrap.json",
] as const;

export class EngineStagingError extends Error {}

/** Filesystem boundary of the in-process subset copy and the final rename. */
export interface PopulateEngineIO {
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(
    path: string,
  ): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[]>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

export const nodePopulateEngineIO: PopulateEngineIO = {
  lstat,
  async readdir(path) {
    return readdir(path, { withFileTypes: true });
  },
  readlink,
  symlink,
  async mkdir(path) {
    await mkdir(path, { mode: 0o700 });
  },
  async copyFile(from, to) {
    await copyFile(from, to);
  },
  rename,
  realpath,
};

/** Everything the confined init staging path needs; production builds it at preflight. */
export interface EngineStagingContext {
  runner: ConfinedJobRunner;
  selfTest: ConfinementSelfTest;
  promotion: PromotionMethodSelection;
  operationId: string;
  nodePath: string;
  npmCliPath: string;
  invokingHome: string;
  pathEnv: string;
  promotionIO?: PromotionIO;
  io?: PopulateEngineIO;
}

export interface PopulateEngineOptions {
  /**
   * Copy `PACKAGE_ENTRIES` straight into `.hive` and stop, skipping the
   * confined install, the clone promotion and clone verification. Injected
   * unit-test-only; no shipped CLI flag reaches it.
   */
  skipInstall?: boolean;
  /** Prepared staging context; built from a real preflight when absent. */
  staging?: EngineStagingContext;
  /** Reject a source package built from a dirty checkout. */
  requireClean?: boolean;
  /** Boundaries for the preflight when `staging` is not supplied. */
  preflight?: EngineStagingPreflightOptions;
}

export interface EngineStagingPreflightOptions {
  nodePath?: string;
  npmCliPath?: string;
  invokingHome?: string;
  pathEnv?: string;
  io?: ConfinedJobIO;
  promotionIO?: PromotionIO;
  fileIO?: PopulateEngineIO;
}

/** Staging-integrity evidence for the init operation. */
export interface PopulateEngineResult {
  engineDir: string;
  release: Release;
  selfTest: ConfinementSelfTest;
  promotionMethod: PromotionMethodSelection["method"];
  runtime: { node: string; npm: string | null };
  install: ConfinedJobResult;
  promotion: PromotionRecord;
  verification: CloneVerification;
  disposal: SweepReport | null;
}

function npmVersion(npmCliPath: string): string | null {
  // Read the sealed npm CLI's own manifest rather than spawning it; init runs
  // no unconfined subprocess of its own.
  for (const candidate of [
    resolve(dirname(npmCliPath), "..", "package.json"),
    resolve(dirname(npmCliPath), "package.json"),
  ]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === "npm" && typeof manifest.version === "string") return manifest.version;
    } catch {
      // Fall through to the next candidate.
    }
  }
  return null;
}

/**
 * Copy exactly `PACKAGE_ENTRIES` from the source package into `destination`,
 * in process. Missing entries are skipped (a dev checkout has no `pkg/`);
 * symbolic links are recreated rather than followed.
 */
export async function copyPackageEntries(
  pkgRoot: string,
  destination: string,
  io: PopulateEngineIO = nodePopulateEngineIO,
): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of PACKAGE_ENTRIES) {
    const source = resolve(pkgRoot, entry);
    let info;
    try {
      info = await io.lstat(source);
    } catch {
      continue;
    }
    const target = resolve(destination, entry);
    // Only `scripts/honeypot` has an intermediate directory; create it under
    // the destination root without ever walking above it.
    for (const segment of entry
      .split("/")
      .slice(0, -1)
      .reduce<string[]>((paths, part) => {
        paths.push(paths.length === 0 ? part : `${paths[paths.length - 1]}/${part}`);
        return paths;
      }, [])) {
      const directory = resolve(destination, segment);
      if (await absent(io, directory)) await io.mkdir(directory);
    }
    await copyEntry(io, source, target, info);
    copied.push(entry);
  }
  return copied;
}

async function copyEntry(
  io: PopulateEngineIO,
  source: string,
  target: string,
  info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<void> {
  if (info.isSymbolicLink()) {
    await io.symlink(await io.readlink(source), target);
    return;
  }
  if (info.isDirectory()) {
    await io.mkdir(target);
    for (const child of await io.readdir(source)) {
      await copyEntry(io, resolve(source, child.name), resolve(target, child.name), child);
    }
    return;
  }
  if (!info.isFile()) throw new EngineStagingError(`source package member is not a regular entry: ${source}`);
  await io.copyFile(source, target);
}

async function absent(io: PopulateEngineIO, path: string): Promise<boolean> {
  try {
    await io.lstat(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * Preflight for an init that was not handed a staging context: the fail-closed
 * Seatbelt self-test and the promotion method, both against the real instance
 * directory. A missing `/usr/bin/sandbox-exec`, a self-test that does not deny
 * or an unusable promotion method fails here, before any job runs.
 */
export async function prepareEngineStaging(
  instanceDir: string,
  options: EngineStagingPreflightOptions = {},
): Promise<EngineStagingContext> {
  const home = await realpath(instanceDir);
  const operationId = `init-${randomUUID()}`;
  const nodePath = options.nodePath ?? process.execPath;
  const npmCliPath = options.npmCliPath ?? resolveNpmCli();
  const selfTest = await runConfinementSelfTest({
    canonicalInstanceHome: home,
    operationId,
    nodePath,
    io: options.io,
  });
  const jobsParent = resolve(home, ".hive-state", "jobs", operationId);
  await mkdir(jobsParent, { recursive: true, mode: 0o700 });
  const promotion = await selectPromotionMethod({
    sourceParent: jobsParent,
    destinationParent: home,
    io: options.promotionIO,
  });
  return {
    runner: new ConfinedJobRunner({ canonicalInstanceHome: home, operationId, selfTest, io: options.io }),
    selfTest,
    promotion,
    operationId,
    nodePath,
    npmCliPath,
    invokingHome: options.invokingHome ?? process.env.HOME ?? home,
    pathEnv: options.pathEnv ?? process.env.PATH ?? "/usr/bin:/bin",
    promotionIO: options.promotionIO,
    io: options.fileIO,
  };
}

function resolveNpmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith(".js") && existsSync(candidate)) return candidate;
  }
  throw new EngineStagingError("engine staging requires the npm CLI script; none was found beside the running Node");
}

/**
 * Populate `<instance>/.hive` from the running CLI's package.
 *
 * Resume never trusts an existing `node_modules`, a partial `.hive` or a
 * completion marker: unverified staging is discarded and the whole job and
 * clone run again. A missing package, lock or packaged helper fails naming the
 * missing artifact rather than silently returning.
 */
export async function populateEngine(
  pkgRoot: string,
  instanceDir: string,
  opts: PopulateEngineOptions = {},
): Promise<PopulateEngineResult | null> {
  const engineDir = resolve(instanceDir, ".hive");
  if (opts.skipInstall) {
    if (existsSync(engineDir)) {
      throw new EngineStagingError(
        `Engine already populated at ${engineDir}. If this is a resume after an ` +
          `interrupted init, rm -rf ${engineDir} and re-run 'hive init'. ` +
          `populateEngine does not silently overwrite.`,
      );
    }
    mkdirSync(engineDir, { recursive: true });
    await copyPackageEntries(pkgRoot, engineDir, opts.staging?.io ?? nodePopulateEngineIO);
    return null;
  }

  // 1. Validate the source package. A missing package.json, lock or packaged
  //    helper fails here by name, before any staging directory is created.
  let release: Release;
  try {
    release = readRelease(pkgRoot, opts.requireClean ?? false);
  } catch (error) {
    throw new EngineStagingError(
      `source package at ${pkgRoot} is not a complete release: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const staging = opts.staging ?? (await prepareEngineStaging(instanceDir, opts.preflight));
  const io = staging.io ?? nodePopulateEngineIO;
  const home = await io.realpath(instanceDir);
  const nextDir = resolve(home, ".hive.next");

  // 2. Discard unverified staging from an interrupted run. Nothing is served
  //    from `.hive` yet at init, so a partial tree is never adopted.
  for (const path of [nextDir, resolve(home, ".hive")]) {
    if (!(await absent(io, path))) await discardPromotedTree(path, null, staging.promotionIO);
  }

  // 3. In-process copy of only PACKAGE_ENTRIES into a fresh exclusive job.
  const job = await staging.runner.prepare("install");
  const root = resolve(job.path, "package");
  await io.mkdir(root);
  await copyPackageEntries(pkgRoot, root, io);

  // 4. Confined locked production install with native scripts enabled.
  const install = requireJobSuccess(
    await staging.runner.launch(job, {
      command: staging.nodePath,
      args: [staging.npmCliPath, "ci", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"],
      cwd: root,
      home: staging.invokingHome,
      pathEnv: staging.pathEnv,
      timeoutMs: 600_000,
    }),
  );

  // 5. Clone into `.hive.next`, then verify by reading the clone only.
  const { promotion, verification } = await promoteAndVerify({
    source: root,
    destination: nextDir,
    method: staging.promotion.method,
    io: staging.promotionIO,
    verification: {
      archiveSha256: null,
      expectedRelease: releaseIdentity(release),
      requireClean: opts.requireClean ?? false,
      runner: staging.runner,
      nodePath: staging.nodePath,
      npmCliPath: staging.npmCliPath,
      pathEnv: staging.pathEnv,
      dependencyTree: true,
      runtimeLoading: CANDIDATE_RUNTIME_LOADING_PROBES,
    },
  });

  // 6. Rename the verified clone into place. No service exists yet at init.
  if (!(await absent(io, engineDir))) {
    throw new EngineStagingError(`engine directory reappeared during staging: ${engineDir}`);
  }
  try {
    await io.rename(nextDir, engineDir);
  } catch (error) {
    await discardPromotedTree(nextDir, promotion.destinationIdentity, staging.promotionIO).catch(() => false);
    throw new EngineStagingError(`verified engine clone could not be renamed into place: ${engineDir}`, {
      cause: error,
    });
  }

  // 7. Deferred job-directory disposal; a failure here never fails the install.
  const disposal = await disposeOperationJobs({
    canonicalInstanceHome: home,
    operationId: staging.operationId,
    io: staging.promotionIO,
  }).catch(() => null);

  return {
    engineDir,
    release,
    selfTest: staging.selfTest,
    promotionMethod: staging.promotion.method,
    runtime: { node: process.version, npm: npmVersion(staging.npmCliPath) },
    install,
    promotion,
    verification,
    disposal,
  };
}

/**
 * Resume entry point. There is no "deps already present" shortcut: an
 * interrupted init left unverified staging, which is discarded and re-run
 * through the same confined path as a first install.
 */
export async function ensureEngineDeps(
  pkgRoot: string,
  instanceDir: string,
  opts: PopulateEngineOptions = {},
): Promise<PopulateEngineResult | null> {
  return populateEngine(pkgRoot, instanceDir, opts);
}
