import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contained, readRelease, type Release } from "../deployment/release.js";

const PINNED_PACKAGES = {
  "@livekit/agents": "1.6.4",
  "@livekit/rtc-node": "0.13.33",
  "@livekit/agents-plugin-cartesia": "1.6.4",
  "@livekit/agents-plugin-deepgram": "1.6.4",
  "@livekit/agents-plugin-elevenlabs": "1.6.4",
  "@livekit/agents-plugin-silero": "1.6.4",
} as const;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findPackageRoot(resolvedModule: string, expectedName: string, releaseRoot: string): string {
  let directory = dirname(realpathSync(resolvedModule));
  while (inside(releaseRoot, directory)) {
    const manifestPath = resolve(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === expectedName) return contained(releaseRoot, directory);
    } catch {
      // Continue walking only within the selected release.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`package-root:${expectedName}`);
}

function resolveInstalledPackage(
  packageName: keyof typeof PINNED_PACKAGES,
  releaseRoot: string,
  requireFromHelper: NodeRequire,
): { root: string; entry: string; version: string } {
  const entry = contained(releaseRoot, requireFromHelper.resolve(packageName));
  const root = findPackageRoot(entry, packageName, releaseRoot);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: unknown };
  if (manifest.version !== PINNED_PACKAGES[packageName]) throw new Error(`package-version:${packageName}`);
  return { root, entry, version: manifest.version as string };
}

function findSingleFile(root: string, basename: string, releaseRoot: string): string {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`asset-symlink:${basename}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === basename) found.push(contained(releaseRoot, path));
    }
  };
  visit(root);
  if (found.length !== 1) throw new Error(`asset-count:${basename}`);
  return found[0]!;
}

function relativeEvidence(releaseRoot: string, path: string) {
  const actual = contained(releaseRoot, path);
  return { path: relative(releaseRoot, actual), sha256: sha256(actual) };
}

function loadedNativeEvidence(releaseRoot: string, before: Set<string>, after: readonly string[]) {
  const loaded = after
    .map((path) => realpathSync(path))
    .filter((path) => !before.has(path) && inside(releaseRoot, path) && /\.(?:node|dylib|so(?:\.\d+)*)$/i.test(path));
  const rtc = loaded.filter((path) => /rtc|livekit/i.test(path));
  const onnx = loaded.filter((path) => /onnxruntime/i.test(path));
  if (rtc.length === 0) throw new Error("native-load:rtc");
  if (onnx.length === 0) throw new Error("native-load:onnx");
  return {
    rtc: rtc.map((path) => relativeEvidence(releaseRoot, path)),
    onnx: onnx.map((path) => relativeEvidence(releaseRoot, path)),
  };
}

function npmVersion(): string {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) throw new Error("runtime-version:npm");
  return result.stdout.trim();
}

/**
 * The release this packaged helper belongs to. Derived from the helper's own
 * `import.meta.url` — never from the working directory, an environment
 * variable or an operator-supplied path — so both modes validate an explicit
 * release root and nothing else.
 */
function packagedRelease(moduleUrl: string): { helperPath: string; releaseRoot: string; manifest: Release } {
  const helperPath = realpathSync(fileURLToPath(moduleUrl));
  const helperDirectory = dirname(helperPath);
  if (helperDirectory.split(sep).at(-1) !== "pkg") throw new Error("helper-location:not-packaged");
  const releaseRoot = realpathSync(dirname(helperDirectory));
  contained(releaseRoot, helperPath);
  let manifest: Release;
  try {
    manifest = readRelease(releaseRoot);
  } catch {
    throw new Error("release:invalid");
  }
  return { helperPath, releaseRoot, manifest };
}

export async function offline(moduleUrl = import.meta.url): Promise<Record<string, unknown>> {
  const { helperPath, releaseRoot, manifest } = packagedRelease(moduleUrl);
  const requireFromHelper = createRequire(pathToFileURL(helperPath));
  const packages = Object.fromEntries(
    Object.keys(PINNED_PACKAGES).map((name) => {
      const packageName = name as keyof typeof PINNED_PACKAGES;
      return [packageName, resolveInstalledPackage(packageName, releaseRoot, requireFromHelper)];
    }),
  ) as Record<keyof typeof PINNED_PACKAGES, { root: string; entry: string; version: string }>;

  const initialReport = process.report.getReport() as { sharedObjects: string[] };
  const before = new Set(initialReport.sharedObjects.map((path) => realpathSync(path)));
  let room: { disconnect(): Promise<void> } | null = null;
  let rtcModule: { dispose(): Promise<void> } | null = null;
  try {
    const agents = await import("@livekit/agents").catch(() => {
      throw new Error("package-import:@livekit/agents");
    });
    const rtc = await import("@livekit/rtc-node").catch(() => {
      throw new Error("package-import:@livekit/rtc-node");
    });
    const cartesia = await import("@livekit/agents-plugin-cartesia").catch(() => {
      throw new Error("package-import:@livekit/agents-plugin-cartesia");
    });
    const deepgram = await import("@livekit/agents-plugin-deepgram").catch(() => {
      throw new Error("package-import:@livekit/agents-plugin-deepgram");
    });
    const elevenlabs = await import("@livekit/agents-plugin-elevenlabs").catch(() => {
      throw new Error("package-import:@livekit/agents-plugin-elevenlabs");
    });
    const silero = await import("@livekit/agents-plugin-silero").catch(() => {
      throw new Error("package-import:@livekit/agents-plugin-silero");
    });
    if (typeof agents.defineAgent !== "function" || !cartesia.TTS || !deepgram.STT || !elevenlabs.TTS) {
      throw new Error("worker-runtime-export:missing");
    }
    rtcModule = rtc;
    try {
      room = new rtc.Room();
    } catch {
      throw new Error("native-load:rtc");
    }
    await silero.VAD.load({ forceCPU: true }).catch(() => {
      throw new Error("native-load:silero");
    });
    const model = findSingleFile(packages["@livekit/agents-plugin-silero"].root, "silero_vad.onnx", releaseRoot);
    const loadedReport = process.report.getReport() as { sharedObjects: string[] };
    const native = loadedNativeEvidence(releaseRoot, before, loadedReport.sharedObjects);
    const sdkChild = contained(
      releaseRoot,
      resolve(packages["@livekit/agents"].root, "dist", "ipc", "job_proc_lazy_main.js"),
    );
    if (!statSync(sdkChild).isFile()) throw new Error("sdk-child:missing");
    let inferenceHelper: string | null = null;
    try {
      inferenceHelper = contained(releaseRoot, requireFromHelper.resolve("@livekit/local-inference"));
    } catch {
      throw new Error("inference-helper:missing");
    }
    return {
      manifest,
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, info]) => [
          name,
          { version: info.version, entry: relative(releaseRoot, info.entry) },
        ]),
      ),
      native,
      sileroModel: relativeEvidence(releaseRoot, model),
      sdkChild: relative(releaseRoot, sdkChild),
      inferenceHelper: relative(releaseRoot, inferenceHelper),
      runtime: {
        node: process.version,
        npm: npmVersion(),
        platform: process.platform,
        arch: process.arch,
      },
    };
  } finally {
    if (room) await room.disconnect();
    if (rtcModule) await rtcModule.dispose();
  }
}

/**
 * Every bare specifier the built engine bundle imports, derived from the
 * bundle's own bytes rather than a hand-maintained list, so the set can never
 * drift from what was actually built. Relative/absolute paths and Node
 * builtins are not externals. The three forms below are exactly what esbuild
 * emits for an `external` dependency in ESM output; `from` is deliberately not
 * matched when followed by `(` so a minified identifier or `X.from("…")` can
 * never masquerade as an import.
 */
const EXTERNAL_FORMS: readonly RegExp[] = [
  /(?<![$\w.])from\s*(["'])([^"'\\\n]*)\1/g,
  /(?<![$\w.])import\s*(["'])([^"'\\\n]*)\1/g,
  /(?<![$\w.])(?:__)?(?:import|require)\s*\(\s*(["'])([^"'\\\n]*)\1\s*\)/g,
];

/** npm package specifier shape (optional scope, optional deep path). */
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9._~@/-]+)?$/;

export function externalSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const form of EXTERNAL_FORMS) {
    for (const match of source.matchAll(form)) {
      const specifier = match[2];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:") || isBuiltin(specifier)) continue;
      if (!PACKAGE_SPECIFIER.test(specifier)) continue;
      found.add(specifier);
    }
  }
  return [...found].sort();
}

/** Module-system boundary of the engine validate-only mode; injected in unit tests. */
export interface EngineValidateIO {
  /** Parse as an ES module without evaluating it. Throws on a compile failure. */
  compileModule(source: Buffer): void;
  /** Resolve a bare specifier exactly as the engine bundle would. */
  resolve(specifier: string, fromPath: string): string;
  /** Import one already-resolved third-party entry file. */
  import(path: string): Promise<unknown>;
}

export const nodeEngineValidateIO: EngineValidateIO = {
  compileModule(source) {
    // `--check` parses without running any of it, so `pkg/server.min.js`'s
    // `main()` and its eagerly constructed shared config never evaluate.
    const result = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: source,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("engine-bundle:uncompilable");
  },
  resolve(specifier, fromPath) {
    return createRequire(pathToFileURL(fromPath)).resolve(specifier);
  },
  async import(path) {
    return import(pathToFileURL(path).href);
  },
};

export interface EngineValidateOptions {
  moduleUrl?: string;
  /** Optional identity the loaded release must equal. */
  expected?: { packageVersion: string; sourceRevision: string; dependencyLockSha256: string } | null;
  io?: EngineValidateIO;
}

/**
 * Engine half of the candidate runtime-loading check (KPR-463 plan Task 3
 * Step 2a). `pkg/server.min.js` statically imports the eagerly constructed
 * shared config and evaluates `main()` on load, so no argument branch inside
 * it can run before configuration initialization. The engine is therefore
 * proven loadable *offline*: the bundle compiles as an ES module without being
 * evaluated, and every external it imports resolves and initializes from
 * inside this release.
 *
 * Secret-free by construction: it imports no shared config, dotenv, Keychain,
 * Mongo, Slack or LiveKit code, binds no listening socket, starts no model
 * turn/room/call, and names no operator `.env`, Keychain namespace or real
 * instance home. Success is exit 0 *together with* `ENGINE_VALIDATE_OK`.
 */
export async function engineValidate(options: EngineValidateOptions = {}): Promise<Record<string, unknown>> {
  const io = options.io ?? nodeEngineValidateIO;
  const { releaseRoot, manifest } = packagedRelease(options.moduleUrl ?? import.meta.url);
  const expected = options.expected;
  if (
    expected &&
    (expected.packageVersion !== manifest.packageVersion ||
      expected.sourceRevision !== manifest.sourceRevision ||
      expected.dependencyLockSha256 !== manifest.dependencyLockSha256)
  ) {
    throw new Error("release-identity:mismatch");
  }

  const bundlePath = resolve(releaseRoot, "pkg", "server.min.js");
  let info;
  try {
    info = lstatSync(bundlePath);
  } catch {
    throw new Error("engine-bundle:missing");
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("engine-bundle:not-a-regular-file");
  const bundle = contained(releaseRoot, bundlePath);
  const source = readFileSync(bundle);
  io.compileModule(source);

  const specifiers = externalSpecifiers(source.toString("utf8"));
  if (specifiers.length === 0) throw new Error("engine-externals:none");
  const modules = resolve(releaseRoot, "node_modules");
  const externals: { specifier: string; path: string; sha256: string }[] = [];
  for (const specifier of specifiers) {
    let resolved: string;
    try {
      resolved = io.resolve(specifier, bundle);
    } catch {
      throw new Error(`engine-external-resolve:${specifier}`);
    }
    let actual: string;
    try {
      actual = contained(releaseRoot, resolved);
    } catch {
      throw new Error(`engine-external-containment:${specifier}`);
    }
    // Third-party package initialization only: an external that resolves back
    // into Hive's own tree would import engine code, not a dependency.
    if (!inside(modules, actual) || actual === modules) throw new Error(`engine-external-hive-module:${specifier}`);
    try {
      await io.import(actual);
    } catch {
      throw new Error(`engine-external-import:${specifier}`);
    }
    externals.push({ specifier, ...relativeEvidence(releaseRoot, actual) });
  }

  return {
    manifest,
    engineBundle: relativeEvidence(releaseRoot, bundle),
    externals,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

const MODES = {
  offline: { run: () => offline(), ok: "ARTIFACT_RUNTIME_OK", failed: "ARTIFACT_RUNTIME_FAILED" },
  "engine-validate": { run: () => engineValidate(), ok: "ENGINE_VALIDATE_OK", failed: "ENGINE_VALIDATE_FAILED" },
} as const;

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const requested = argv[2];
  const selected = requested === "offline" || requested === "engine-validate" ? MODES[requested] : null;
  if (!selected) {
    stderrWrite.call(process.stderr, "ARTIFACT_RUNTIME_FAILED mode:unsupported\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let marker: string;
  let failed = false;
  try {
    const evidence = await selected.run();
    marker = `${selected.ok} ${JSON.stringify(evidence)}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const classification = /^[a-z0-9@._/-]+(?::[a-z0-9@._/-]+)?$/i.test(message) ? message : "runtime-check:failed";
    marker = `${selected.failed} ${classification}\n`;
    failed = true;
    process.exitCode = 1;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  (failed ? stderrWrite : stdoutWrite).call(failed ? process.stderr : process.stdout, marker);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) void main();
