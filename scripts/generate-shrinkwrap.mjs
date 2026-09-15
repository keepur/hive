import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const cwd = process.cwd();
const [mode, ...args] = process.argv.slice(2);
if (mode === "--reject-root-pack") throw new Error("Use npm run pack:release; publish its validated .tgz");
if (!["--check-source", "--check", "--pack"].includes(mode)) throw new Error("unknown shrinkwrap mode");
if (existsSync(resolve(cwd, "npm-shrinkwrap.json"))) throw new Error("development root must not contain npm-shrinkwrap.json");
const source = readFileSync(resolve(cwd, "package-lock.json"));
const lock = JSON.parse(source.toString("utf8"));
const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
const root = lock.packages?.[""];
if (lock.lockfileVersion !== 3 || !root || root.name !== pkg.name || root.version !== pkg.version) {
  throw new Error("package-lock root identity mismatch");
}
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (!isDeepStrictEqual(root[field] ?? {}, pkg[field] ?? {})) throw new Error(`package-lock ${field} mismatch`);
}
if (mode !== "--check-source") {
  const manifest = JSON.parse(readFileSync(resolve(cwd, "pkg/release.json"), "utf8"));
  const digest = createHash("sha256").update(source).digest("hex");
  if (manifest.packageVersion !== pkg.version || manifest.dependencyLockSha256 !== digest) {
    throw new Error("bundle lock is stale; rebuild before packing");
  }
}
if (mode === "--pack") {
  let destination = cwd;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i] === "--dry-run") { dryRun = true; continue; }
    if (args[i] === "--pack-destination" && args[i + 1]) { destination = resolve(cwd, args[++i]); continue; }
    throw new Error("unsupported pack argument");
  }
  const scratch = mkdtempSync(resolve(tmpdir(), "hive-release-pack-"));
  const stage = resolve(scratch, "package");
  try {
    mkdirSync(stage);
    const entries = new Set([...pkg.files, "package.json", "README.md", "LICENSE", "LICENSE-APACHE-2.0.txt", "NOTICE"]);
    for (const entry of entries) {
      const rel = relative(cwd, resolve(cwd, entry));
      if (!rel || isAbsolute(entry) || rel === ".." || rel.startsWith(`..${sep}`) || /[*?[\]{}!]/.test(entry)) {
        throw new Error("pack files must be explicit contained paths");
      }
      const from = resolve(cwd, entry);
      if (!existsSync(from)) continue;
      const to = resolve(stage, entry);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true, dereference: false });
    }
    writeFileSync(resolve(stage, "npm-shrinkwrap.json"), source, { flag: "wx" });
    if (!source.equals(readFileSync(resolve(stage, "npm-shrinkwrap.json")))) throw new Error("shrinkwrap copy mismatch");
    const npmArgs = ["pack", "--ignore-scripts", "--json", "--pack-destination", destination];
    if (dryRun) npmArgs.push("--dry-run");
    process.stdout.write(execFileSync("npm", npmArgs, {
      cwd: stage, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
