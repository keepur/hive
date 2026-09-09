import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contained, readRelease } from "../deployment/release.js";

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

export async function offline(moduleUrl = import.meta.url): Promise<Record<string, unknown>> {
  const helperPath = realpathSync(fileURLToPath(moduleUrl));
  const helperDirectory = dirname(helperPath);
  if (helperDirectory.split(sep).at(-1) !== "pkg") throw new Error("helper-location:not-packaged");
  const releaseRoot = realpathSync(dirname(helperDirectory));
  contained(releaseRoot, helperPath);
  let manifest;
  try {
    manifest = readRelease(releaseRoot);
  } catch {
    throw new Error("release:invalid");
  }
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

async function main(): Promise<void> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  if (process.argv[2] !== "offline") {
    stderrWrite.call(process.stderr, "ARTIFACT_RUNTIME_FAILED mode:offline-required\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let marker: string;
  let failed = false;
  try {
    const evidence = await offline();
    marker = `ARTIFACT_RUNTIME_OK ${JSON.stringify(evidence)}\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const classification = /^[a-z0-9@._/-]+(?::[a-z0-9@._/-]+)?$/i.test(message) ? message : "runtime-check:failed";
    marker = `ARTIFACT_RUNTIME_FAILED ${classification}\n`;
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
