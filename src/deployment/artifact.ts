import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, realpath, readdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readRelease, sha256, type Release } from "./release.js";

const execFile = promisify(nodeExecFile);

export interface ArtifactCommandResult {
  stdout: string;
  stderr: string;
}

export interface ArtifactIO {
  execFile(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ): Promise<ArtifactCommandResult>;
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  mkdir(path: string, options: { recursive?: boolean; mode: number }): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

export const nodeArtifactIO: ArtifactIO = {
  async execFile(command, args, options) {
    const result = await execFile(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  lstat,
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async readFile(path) {
    return readFile(path);
  },
  realpath,
  readdir,
};

export interface ArtifactSelector {
  tag?: string;
  artifact?: string;
}

export interface ResolvedArtifact {
  archivePath: string;
  archiveSha256: string;
  source: { kind: "registry"; selector: string } | { kind: "local"; path: string };
}

function normalizedTag(tag: string | undefined): string {
  const selected = (tag ?? "latest").trim();
  if (!selected || selected.includes("/") || /\s/.test(selected)) throw new Error("invalid release tag");
  return selected === "latest" ? selected : selected.replace(/^v/, "");
}

function parsePackJson(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length !== 1 || !values[0] || typeof values[0] !== "object") {
    throw new Error("npm pack must produce exactly one archive");
  }
  const filename = (values[0] as { filename?: unknown }).filename;
  if (typeof filename !== "string" || filename.length === 0 || basename(filename) !== filename) {
    throw new Error("npm pack returned an unsafe archive filename");
  }
  return filename;
}

async function regularArchive(path: string, io: ArtifactIO): Promise<string> {
  const selected = await io.lstat(path);
  if (!selected.isFile() || selected.isSymbolicLink()) {
    throw new Error("artifact must be a regular .tgz file");
  }
  const canonical = await io.realpath(path);
  const info = await io.lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || !canonical.endsWith(".tgz")) {
    throw new Error("artifact must be a regular .tgz file");
  }
  return canonical;
}

export async function resolveArtifact(
  selector: ArtifactSelector,
  downloadsDirectory: string,
  io: ArtifactIO = nodeArtifactIO,
): Promise<ResolvedArtifact> {
  if (selector.artifact !== undefined && selector.tag !== undefined) {
    throw new Error("--artifact and --tag are mutually exclusive");
  }
  if (selector.artifact !== undefined) {
    if (!isAbsolute(selector.artifact)) throw new Error("--artifact must be an absolute path");
    const archivePath = await regularArchive(selector.artifact, io);
    return {
      archivePath,
      archiveSha256: sha256(await io.readFile(archivePath)),
      source: { kind: "local", path: archivePath },
    };
  }
  const selected = normalizedTag(selector.tag);
  await io.mkdir(downloadsDirectory, { recursive: true, mode: 0o700 });
  const result = await io.execFile(
    "npm",
    ["pack", `@keepur/hive@${selected}`, "--json", "--pack-destination", downloadsDirectory],
    { timeout: 120_000 },
  );
  const archivePath = await regularArchive(resolve(downloadsDirectory, parsePackJson(result.stdout)), io);
  const root = await io.realpath(downloadsDirectory);
  const rel = relative(root, archivePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("npm pack archive escaped operation downloads");
  }
  return {
    archivePath,
    archiveSha256: sha256(await io.readFile(archivePath)),
    source: { kind: "registry", selector: selected },
  };
}

const forbiddenOperatorMember =
  /^(?:hive(?:-[^/]*)?\.yaml|\.env(?:-[^/]*)?|agents|plugins|skills|logs|\.hive-state)(?:\/|$)/;

export function validateArchiveMembers(namesOutput: string, detailOutput: string): string[] {
  const members = namesOutput.split("\n").filter(Boolean);
  if (members.length === 0) throw new Error("artifact archive is empty");
  for (const member of members) {
    if (
      !member.startsWith("package/") ||
      member.startsWith("/") ||
      member.includes("\\") ||
      member.split("/").includes("..")
    ) {
      throw new Error(`unsafe archive member: ${member}`);
    }
    const packageRelative = member.slice("package/".length);
    if (forbiddenOperatorMember.test(packageRelative)) {
      throw new Error(`artifact contains operator state: ${member}`);
    }
  }
  const details = detailOutput.split("\n").filter(Boolean);
  if (details.length !== members.length) throw new Error("archive detail listing does not match member listing");
  for (const detail of details) {
    const kind = detail[0];
    if (kind !== "-" && kind !== "d") throw new Error("archive links and special members are rejected");
  }
  return members;
}

export interface ExtractedArtifact {
  root: string;
  release: Release;
}

export async function extractAndValidateArtifact(
  artifact: ResolvedArtifact,
  ownedNext: string,
  requireClean: boolean,
  io: ArtifactIO = nodeArtifactIO,
): Promise<ExtractedArtifact> {
  try {
    const info = await io.lstat(ownedNext);
    if (!info.isDirectory() || info.isSymbolicLink() || (await io.readdir(ownedNext)).length !== 0) {
      throw new Error("owned staging directory must be an empty real directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await io.mkdir(ownedNext, { mode: 0o700 });
  }
  const [names, details] = await Promise.all([
    io.execFile("tar", ["-tzf", artifact.archivePath], { timeout: 120_000 }),
    io.execFile("tar", ["-tvzf", artifact.archivePath], { timeout: 120_000 }),
  ]);
  validateArchiveMembers(names.stdout, details.stdout);
  await io.execFile("tar", ["-xzf", artifact.archivePath, "--strip-components=1", "-C", ownedNext], {
    timeout: 120_000,
  });
  const root = await io.realpath(ownedNext);
  if (root !== ownedNext) throw new Error("staged artifact root changed identity");
  return { root, release: readRelease(root, requireClean) };
}

export interface StagePreflightOptions {
  packageRoot: string;
  npmPath?: string;
  nodePath?: string;
  serviceEnvironment: Record<string, string>;
  expectedInstanceId: string;
  expectedDatabaseName?: string;
  expectedVoiceEnabled?: boolean;
  io?: ArtifactIO;
}

function parseProbe(stdout: string, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${name} returned invalid JSON`);
  }
}

/** Locked production install plus offline/config preflight for the staged release. */
export async function installAndPreflightStage(options: StagePreflightOptions): Promise<Record<string, unknown>> {
  const io = options.io ?? nodeArtifactIO;
  const npmPath = options.npmPath ?? "npm";
  const nodePath = options.nodePath ?? process.execPath;
  await io.execFile(npmPath, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"], {
    cwd: options.packageRoot,
    timeout: 600_000,
  });
  const diagnostic = resolve(options.packageRoot, "pkg", "voice-worker-diagnostic.min.js");
  const probe = resolve(options.packageRoot, "pkg", "runtime-probe.min.js");
  await io.execFile(nodePath, [diagnostic, "offline"], {
    cwd: options.packageRoot,
    env: { HOME: options.serviceEnvironment.HOME, PATH: options.serviceEnvironment.PATH },
    timeout: 120_000,
  });
  const result = parseProbe(
    (
      await io.execFile(nodePath, [probe, "config"], {
        cwd: options.packageRoot,
        env: options.serviceEnvironment,
        timeout: 30_000,
      })
    ).stdout,
    "staged config probe",
  );
  if (result.ok !== true || result.instanceId !== options.expectedInstanceId) {
    throw new Error("staged config is incompatible with selected instance");
  }
  const database = result.database as { name?: unknown } | undefined;
  if (options.expectedDatabaseName !== undefined && database?.name !== options.expectedDatabaseName) {
    throw new Error("staged config changes database identity");
  }
  const voice = result.voice as { livekitEnabled?: unknown } | undefined;
  if (options.expectedVoiceEnabled !== undefined && voice?.livekitEnabled !== options.expectedVoiceEnabled) {
    throw new Error("staged config changes voice enablement unexpectedly");
  }
  return result;
}
