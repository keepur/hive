// scripts/check-bundle-runtime.mjs
/**
 * Bundle runtime smoke test with an isolated child environment (KPR-463
 * Task 3 Step 4). Importing this module does not launch checks.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_DIR = "pkg";
const MISSING_SLACK = "Missing required env var: SLACK_APP_TOKEN";

export function isEntrypoint(argv1, moduleUrl) {
  if (argv1 === undefined) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

export function createScratchLayout(root = mkdtempSync(resolve(tmpdir(), "hive-bundle-smoke-"))) {
  const home = resolve(root, "home");
  const instance = resolve(root, "instance");
  const bin = resolve(root, "bin");
  const tmp = resolve(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(instance, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const configPath = resolve(instance, "hive.yaml");
  writeFileSync(configPath, "instance:\n  id: bundle-smoke\n");
  writeFileSync(resolve(instance, ".env"), "");
  const keychainLog = resolve(root, "security.log");
  writeFileSync(keychainLog, "");
  const security = resolve(bin, "security");
  writeFileSync(
    security,
    `${[
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      "const log = process.env.HIVE_SMOKE_KEYCHAIN_LOG;",
      "if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + \"\\n\");",
      "process.exit(44);",
      "",
    ].join("\n")}`,
  );
  chmodSync(security, 0o755);
  return { root, home, instance, bin, tmp, configPath, keychainLog, security };
}

export function isolatedChildEnv(scratch) {
  return {
    HOME: scratch.home,
    HIVE_HOME: scratch.instance,
    HIVE_CONFIG: scratch.configPath,
    PATH: [scratch.bin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: scratch.tmp,
    NODE_ENV: "test",
    HIVE_SMOKE_KEYCHAIN_LOG: scratch.keychainLog,
  };
}

export function runIsolated(file, args, scratch) {
  try {
    const stdout = execFileSync(process.execPath, [file, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd: scratch.instance,
      env: isolatedChildEnv(scratch),
    });
    return { status: 0, stdout, stderr: "", signal: null };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      signal: error.signal ?? null,
      timedOut: Boolean(error.killed && error.signal === "SIGTERM") || /timed out/i.test(String(error.message ?? "")),
    };
  }
}

function failServer(result, label) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.signal || result.timedOut || result.status === 0) {
    throw new Error(`${label}: expected a nonzero ordinary exit, got status=${result.status} signal=${result.signal}`);
  }
  if (
    output.includes("SyntaxError") ||
    output.includes("Cannot find module") ||
    output.includes("Cannot find package") ||
    output.includes("ERR_MODULE_NOT_FOUND")
  ) {
    throw new Error(`${label}: module/native load error\n${output.slice(0, 400)}`);
  }
  if (!output.includes(MISSING_SLACK)) {
    throw new Error(`${label}: missing exact Slack required-key failure\n${output.slice(0, 400)}`);
  }
}

export function copyRelocatedPackage(engine) {
  mkdirSync(engine, { recursive: true });
  cpSync(PKG_DIR, resolve(engine, "pkg"), { recursive: true });
  if (existsSync("seeds")) cpSync("seeds", resolve(engine, "seeds"), { recursive: true });
  if (existsSync("templates")) cpSync("templates", resolve(engine, "templates"), { recursive: true });
  cpSync("package.json", resolve(engine, "package.json"));
  writeFileSync(resolve(engine, "npm-shrinkwrap.json"), readFileSync("package-lock.json"));
  const repoNodeModules = resolve(process.cwd(), "node_modules");
  if (existsSync(repoNodeModules)) {
    symlinkSync(repoNodeModules, resolve(engine, "node_modules"), "dir");
  }
}

export function runBundleRuntimeChecks() {
  if (!existsSync(PKG_DIR)) {
    throw new Error(`${PKG_DIR}/ not found — run 'npm run bundle' first`);
  }
  const scratch = createScratchLayout();
  try {
    const version = runIsolated(resolve(PKG_DIR, "cli.min.js"), ["--version"], scratch);
    if (version.status !== 0 || !/^hive v\d+\.\d+\.\d+/.test(version.stdout.trim())) {
      throw new Error(`--version: unexpected output: ${version.stdout || version.stderr}`);
    }
    console.log(`  ✓ --version: ${version.stdout.trim()}`);

    const help = runIsolated(resolve(PKG_DIR, "cli.min.js"), ["--help"], scratch);
    if (help.status !== 0 || !help.stdout.includes("hive <command>") || !help.stdout.includes("init")) {
      throw new Error("--help: missing expected content");
    }
    console.log(`  ✓ --help: usage text present (${help.stdout.trim().split("\n").length} lines)`);

    const server = runIsolated(resolve(PKG_DIR, "server.min.js"), [], scratch);
    failServer(server, "server.min.js");
    console.log("  ✓ server.min.js: exact missing Slack key");

    const engine = resolve(scratch.instance, ".hive");
    copyRelocatedPackage(engine);
    const relocated = runIsolated(resolve(engine, "pkg", "server.min.js"), [], scratch);
    failServer(relocated, ".hive/pkg layout");
    console.log("  ✓ .hive/pkg/ layout: exact missing Slack key");
  } finally {
    rmSync(scratch.root, { recursive: true, force: true });
  }
  console.log("\nOK: Bundle runtime checks passed.");
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  try {
    runBundleRuntimeChecks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
