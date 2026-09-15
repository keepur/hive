import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../../package.json", import.meta.url)), "..");
const CACHE = "/tmp/hive-s9-packages";
const H_CACHE = join(CACHE, "H");
const C_CACHE = join(CACHE, "C");
const T7_CACHE = join(CACHE, "T7");

export interface PackedRelease {
  kind: "H" | "C" | "T7";
  tgz: string;
  sha256: string;
  revision: string;
  extract: string;
  provenance: string;
}

const lockDir = join(CACHE, ".lock");

async function withLock<T>(work: () => Promise<T>): Promise<T> {
  mkdirSync(CACHE, { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - start > 30 * 60_000) throw new Error("S9 package lock timeout", { cause: error });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function packFilename(output: string): string {
  const start = output.indexOf("[");
  if (start < 0) {
    const line = output.trim().split("\n").at(-1) ?? "";
    if (line.endsWith(".tgz")) return line;
    throw new Error("pack did not print a tarball name");
  }
  const parsed = JSON.parse(output.slice(start)) as { filename?: string }[];
  const filename = parsed[0]?.filename;
  if (!filename) throw new Error("pack JSON missing filename");
  return filename;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function extractPack(tgz: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  execFileSync("/usr/bin/tar", ["-xzf", tgz, "-C", dest], { stdio: "pipe" });
}

function npmCi(extract: string): void {
  const packageRoot = join(extract, "package");
  execFileSync("npm", ["ci", "--omit=dev"], {
    cwd: packageRoot,
    stdio: "pipe",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
}

function readRevision(extract: string): string {
  const release = JSON.parse(readFileSync(join(extract, "package", "pkg", "release.json"), "utf8")) as {
    sourceRevision: string;
  };
  return release.sourceRevision;
}

export async function ensureCandidatePack(): Promise<PackedRelease> {
  return withLock(async () => {
    mkdirSync(C_CACHE, { recursive: true });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    const probeMin = join(REPO, "pkg", "runtime-probe.min.js");
    const helperMin = join(REPO, "pkg", "deploy.min.js");
    const fingerprint = [
      head,
      existsSync(probeMin) ? sha256File(probeMin) : "missing-probe",
      existsSync(helperMin) ? sha256File(helperMin) : "missing-helper",
    ].join("\n");
    const marker = join(C_CACHE, "HEAD");
    const extract = join(C_CACHE, "extract");
    const helper = join(extract, "package", "pkg", "deploy.min.js");
    let tgz = execFileSync("/bin/ls", ["-1", C_CACHE], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(C_CACHE, name))
      .find((path) => existsSync(path));
    if (!tgz || !existsSync(helper) || !existsSync(marker) || readFileSync(marker, "utf8").trim() !== fingerprint) {
      const packed = execFileSync(
        "node",
        ["scripts/generate-shrinkwrap.mjs", "--pack", "--pack-destination", C_CACHE],
        {
          cwd: REPO,
          encoding: "utf8",
        },
      );
      tgz = resolve(C_CACHE, packFilename(packed));
      extractPack(tgz, extract);
      npmCi(extract);
      writeFileSync(marker, `${fingerprint}\n`);
    } else if (!existsSync(join(extract, "package", "node_modules"))) {
      npmCi(extract);
    }
    return {
      kind: "C",
      tgz,
      sha256: sha256File(tgz),
      revision: readRevision(extract),
      extract,
      provenance: `candidate pack of ${REPO} HEAD=${head} independent pack:release + npm ci --omit=dev`,
    };
  });
}

export async function ensureHistoricalPack(): Promise<PackedRelease> {
  return withLock(async () => {
    mkdirSync(H_CACHE, { recursive: true });
    const packed = existsSync(H_CACHE)
      ? execFileSync("/bin/ls", ["-1", H_CACHE], { encoding: "utf8" })
          .split("\n")
          .filter((name) => name.endsWith(".tgz"))
          .map((name) => join(H_CACHE, name))
      : [];
    const hTgz =
      packed.find((path) => existsSync(path)) ??
      execFileSync("/bin/ls", ["-1", CACHE], { encoding: "utf8" })
        .split("\n")
        .filter((name) => name.endsWith(".tgz"))
        .map((name) => join(CACHE, name))
        .at(-1);
    if (!hTgz || !existsSync(hTgz)) throw new Error("H package tarball missing; H bundle did not finish");
    const extract = join(H_CACHE, "extract");
    if (!existsSync(join(extract, "package", "pkg", "deploy.min.js"))) extractPack(hTgz, extract);
    if (!existsSync(join(extract, "package", "node_modules"))) npmCi(extract);
    const revision = readRevision(extract);
    return {
      kind: "H",
      tgz: hTgz,
      sha256: sha256File(hTgz),
      revision,
      extract,
      provenance: `harness-built checkpoint worktree /tmp/hive-s9-h revision=${revision} (defaultTts cartesia/sonic-2, dbName hive_h_\${id}); independent bundle/pack/npm ci --omit=dev; not a production release`,
    };
  });
}

export async function ensureT7Pack(candidate: PackedRelease): Promise<PackedRelease> {
  return withLock(async () => {
    const dest = join(T7_CACHE, "extract");
    mkdirSync(T7_CACHE, { recursive: true });
    extractPack(candidate.tgz, dest);
    const pkgRoot = join(dest, "package");
    const writerDir = join(pkgRoot, "s9-t7-writer");
    mkdirSync(join(writerDir), { recursive: true });
    writeFileSync(
      join(writerDir, "package.json"),
      JSON.stringify({
        name: "s9-t7-writer",
        version: "1.0.0",
        type: "module",
        scripts: {
          postinstall: "node spawn-writer.mjs",
        },
      }),
    );
    writeFileSync(
      join(writerDir, "spawn-writer.mjs"),
      `import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const writer = new URL("./writer.mjs", import.meta.url);
const child = spawn(process.execPath, [fileURLToPath(writer)], {
  detached: true,
  stdio: "ignore",
  cwd: process.cwd(),
  env: process.env,
});
child.unref();
process.exit(0);
`,
    );
    writeFileSync(join(writerDir, "writer.mjs"), readFileSync(join(REPO, "src/deployment/testing/s9-t7-writer.mjs")));
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, "s9-t7-writer": "file:./s9-t7-writer" };
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify(manifest, null, 2));
    execFileSync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock-only=false"],
      {
        cwd: pkgRoot,
        stdio: "pipe",
      },
    );
    const lock = readFileSync(join(pkgRoot, "npm-shrinkwrap.json"));
    const releasePath = join(pkgRoot, "pkg", "release.json");
    const release = JSON.parse(readFileSync(releasePath, "utf8")) as { dependencyLockSha256: string };
    release.dependencyLockSha256 = createHash("sha256").update(lock).digest("hex");
    writeFileSync(releasePath, JSON.stringify(release));
    const tgz = join(T7_CACHE, "hive-s9-t7.tgz");
    execFileSync("/usr/bin/tar", ["-czf", tgz, "-C", dest, "--exclude", "package/node_modules", "package"]);
    return {
      kind: "T7",
      tgz,
      sha256: sha256File(tgz),
      revision: release.dependencyLockSha256.slice(0, 40),
      extract: dest,
      provenance: `production pack plus harness-local file:s9-t7-writer lifecycle; lock digest rewritten; ${candidate.provenance}`,
    };
  });
}

export function preAbiDispatcher(): string {
  return resolve(REPO, "src/deployment/testing/s9-preabi-dispatcher.mjs");
}
