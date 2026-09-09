import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export interface Release {
  schemaVersion: 1;
  packageVersion: string;
  sourceRevision: string;
  sourceDirty: boolean;
  dependencyLockSha256: string;
  voiceWorker: {
    path: "pkg/voice-worker.min.js";
    admissionProtocol: 1;
  };
}

export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function contained(root: string, path: string): string {
  const base = realpathSync(root);
  const actual = realpathSync(path);
  const rel = relative(base, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("runtime path escapes release");
  }
  return actual;
}

export function readRelease(root: string, requireClean = false): Release {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (pkg.name !== "@keepur/hive" || typeof pkg.version !== "string") {
    throw new Error("unexpected package identity");
  }

  const raw: unknown = JSON.parse(readFileSync(resolve(root, "pkg/release.json"), "utf8"));
  if (!raw || typeof raw !== "object") {
    throw new Error("release manifest missing");
  }

  const release = raw as Partial<Release>;
  if (
    release.schemaVersion !== 1 ||
    release.packageVersion !== pkg.version ||
    typeof release.sourceDirty !== "boolean" ||
    !/^[a-f0-9]{40}$/.test(release.sourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/.test(release.dependencyLockSha256 ?? "") ||
    release.voiceWorker?.path !== "pkg/voice-worker.min.js" ||
    release.voiceWorker.admissionProtocol !== 1
  ) {
    throw new Error("unsupported or inconsistent release manifest");
  }
  if (requireClean && release.sourceDirty) {
    throw new Error("dirty candidate is ineligible for migration");
  }

  const lock = readFileSync(resolve(root, "npm-shrinkwrap.json"));
  if (sha256(lock) !== release.dependencyLockSha256) {
    throw new Error("dependency lock digest mismatch");
  }

  const locked = JSON.parse(lock.toString("utf8"));
  const lockedRoot = locked.packages?.[""];
  if (lockedRoot?.version !== pkg.version) {
    throw new Error("shrinkwrap version mismatch");
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    if (!isDeepStrictEqual(lockedRoot[field] ?? {}, pkg[field] ?? {})) {
      throw new Error(`shrinkwrap ${field} mismatch`);
    }
  }

  for (const file of [
    "pkg/server.min.js",
    "pkg/cli.min.js",
    release.voiceWorker.path,
    "pkg/voice-worker-diagnostic.min.js",
    "pkg/runtime-probe.min.js",
    "pkg/deploy.min.js",
    "pkg/mcp/voice-livekit.min.js",
  ]) {
    if (!statSync(contained(root, resolve(root, file))).isFile()) {
      throw new Error(`missing artifact: ${file}`);
    }
  }

  return release as Release;
}

export interface SourceUnavailableRelease {
  classification: "source/unavailable";
  packageVersion: null;
  sourceRevision: null;
  sourceDirty: null;
  dependencyLockSha256: null;
}

export type RuntimeRelease = Release | SourceUnavailableRelease;

export function bootIdentity(release: RuntimeRelease, component: "engine" | "voice-worker") {
  return {
    release,
    component,
    pid: process.pid,
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
}

export type BootIdentity = ReturnType<typeof bootIdentity>;

const sourceUnavailable = (): SourceUnavailableRelease => ({
  classification: "source/unavailable",
  packageVersion: null,
  sourceRevision: null,
  sourceDirty: null,
  dependencyLockSha256: null,
});

/** Resolve release identity from the canonical module that is actually executing. */
export function packageRootForModule(moduleUrl: string, component: "engine" | "voice-worker"): string | null {
  const entrypoint = realpathSync(fileURLToPath(moduleUrl));
  const expectedName = component === "engine" ? "server.min.js" : "voice-worker.min.js";
  const packageDirectory = dirname(entrypoint);
  if (basename(packageDirectory) === "pkg" && basename(entrypoint) === expectedName) {
    return dirname(packageDirectory);
  }
  return null;
}

/** Resolve release identity from the canonical module that is actually executing. */
export function bootIdentityForModule(moduleUrl: string, component: "engine" | "voice-worker"): BootIdentity {
  const packageRoot = packageRootForModule(moduleUrl, component);
  return bootIdentity(packageRoot === null ? sourceUnavailable() : readRelease(packageRoot), component);
}

export function bootIdentityLogFields(identity: BootIdentity): Record<string, unknown> {
  return {
    bootIdentity: identity,
    component: identity.component,
    pid: identity.pid,
    bootId: identity.bootId,
    startedAt: identity.startedAt,
    releaseClassification: "classification" in identity.release ? identity.release.classification : "packaged",
    packageVersion: identity.release.packageVersion,
    sourceRevision: identity.release.sourceRevision,
    sourceDirty: identity.release.sourceDirty,
    dependencyLockSha256: identity.release.dependencyLockSha256,
  };
}

/** Persist the local observation record consumed by runtime health checks. */
export function writeBootIdentityRecord(path: string, identity: BootIdentity): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
