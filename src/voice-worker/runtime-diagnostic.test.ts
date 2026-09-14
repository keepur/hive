import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { sha256 } from "../deployment/release.js";
import { parseRuntimeLoadingRecord } from "../deployment/clone-promotion.js";
import {
  engineValidate,
  externalSpecifiers,
  main,
  nodeEngineValidateIO,
  type EngineValidateIO,
} from "./runtime-diagnostic.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const lockBytes = Buffer.from(
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "@keepur/hive", version: "9.9.9" } } }),
);

const identity = {
  packageVersion: "9.9.9",
  sourceRevision: "d".repeat(40),
  dependencyLockSha256: sha256(lockBytes),
};

const REQUIRED_ARTIFACTS = [
  "pkg/cli.min.js",
  "pkg/voice-worker.min.js",
  "pkg/voice-worker-diagnostic.min.js",
  "pkg/runtime-probe.min.js",
  "pkg/deploy.min.js",
  "pkg/mcp/voice-livekit.min.js",
];

/** An installed release whose helper lives at `<root>/pkg/voice-worker-diagnostic.min.js`. */
function releaseTree(options: { bundle?: string | null; externals?: readonly string[] } = {}) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-engine-validate-")));
  roots.push(root);
  mkdirSync(resolve(root, "pkg", "mcp"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "9.9.9" }));
  writeFileSync(resolve(root, "npm-shrinkwrap.json"), lockBytes);
  for (const file of REQUIRED_ARTIFACTS) writeFileSync(resolve(root, file), `// ${file}\n`);
  writeFileSync(
    resolve(root, "pkg", "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      ...identity,
      sourceDirty: false,
      voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
    }),
  );
  for (const name of options.externals ?? ["fake-external"]) {
    const directory = resolve(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    writeFileSync(resolve(directory, "index.js"), "module.exports = { loaded: true };\n");
  }
  const bundle =
    options.bundle === undefined
      ? 'import { createRequire as c } from "module";\nconst require = c(import.meta.url);\n' +
        (options.externals ?? ["fake-external"]).map((name) => `import ${JSON.stringify(name)};`).join("\n") +
        "\nexport default 1;\n"
      : options.bundle;
  if (bundle !== null) writeFileSync(resolve(root, "pkg", "server.min.js"), bundle);
  // The mode derives its release root from the helper's own location.
  return { root, moduleUrl: pathToFileURL(resolve(root, "pkg", "voice-worker-diagnostic.min.js")).href };
}

function recordingIO(overrides: Partial<EngineValidateIO> = {}) {
  const imported: string[] = [];
  const io: EngineValidateIO = {
    ...nodeEngineValidateIO,
    async import(path) {
      imported.push(path);
      return nodeEngineValidateIO.import(path);
    },
    ...overrides,
  };
  return { io, imported };
}

describe("externalSpecifiers", () => {
  it("derives every bare specifier form esbuild emits for an external", () => {
    const source = [
      'import{createRequire as a}from"module";',
      'import b from"mongodb";',
      'import*as c from"@slack/web-api";',
      'export{x}from"@anthropic-ai/sdk";',
      'import"better-sqlite3";',
      'const d=await import("xlsx");',
      'const e=require("pdf-parse");',
      'const f=__require("mammoth");',
    ].join("\n");
    expect(externalSpecifiers(source)).toEqual([
      "@anthropic-ai/sdk",
      "@slack/web-api",
      "better-sqlite3",
      "mammoth",
      "mongodb",
      "pdf-parse",
      "xlsx",
    ]);
  });

  it("ignores builtins, relative and absolute paths", () => {
    const source = 'import"node:fs";import"fs";import"./local.js";import"../up.js";import"/abs.js";import"real-pkg";';
    expect(externalSpecifiers(source)).toEqual(["real-pkg"]);
  });

  it("never mistakes a property access or a non-import call for an import", () => {
    const source = 'Buffer.from("deadbeef");Array.from("abc");const from=(x)=>x;from("not an import");';
    expect(externalSpecifiers(source)).toEqual([]);
  });
});

describe("engineValidate", () => {
  it("emits a success record naming the loaded release identity", async () => {
    const { root, moduleUrl } = releaseTree();
    const { io, imported } = recordingIO();
    const evidence = (await engineValidate({ moduleUrl, io })) as {
      manifest: { packageVersion: string; sourceRevision: string; dependencyLockSha256: string };
      engineBundle: { path: string; sha256: string };
      externals: { specifier: string; path: string }[];
    };
    expect(evidence.manifest).toMatchObject(identity);
    expect(evidence.engineBundle.path).toBe("pkg/server.min.js");
    expect(evidence.engineBundle.sha256).toBe(sha256(readFileSync(resolve(root, "pkg", "server.min.js"))));
    expect(evidence.externals.map((entry) => entry.specifier)).toEqual(["fake-external"]);
    // Third-party package initialization only — never a Hive module.
    expect(imported).toEqual([resolve(root, "node_modules", "fake-external", "index.js")]);
    expect(imported.some((path) => path.startsWith(resolve(root, "pkg")))).toBe(false);
    // The success record is exactly what clone verification parses.
    expect(parseRuntimeLoadingRecord(`ENGINE_VALIDATE_OK ${JSON.stringify(evidence)}\n`, "ENGINE_VALIDATE_OK")).toEqual(
      identity,
    );
  });

  it("never imports shared config, dotenv, Keychain, Mongo, Slack or LiveKit code", async () => {
    const { moduleUrl } = releaseTree();
    const { io, imported } = recordingIO();
    await engineValidate({ moduleUrl, io });
    for (const path of imported) {
      expect(path).not.toMatch(/(?:^|\/)(?:config|dotenv)\.[cm]?js$/);
      expect(path).not.toMatch(/keychain|honeypot|slack|livekit|mongodb/i);
    }
  });

  it("binds no listening socket", async () => {
    const { moduleUrl } = releaseTree();
    const listen = vi.spyOn(Server.prototype, "listen");
    await engineValidate({ moduleUrl });
    expect(listen).not.toHaveBeenCalled();
  });

  it("fails closed when the engine bundle is missing", async () => {
    // `readRelease` already requires `pkg/server.min.js`, so a missing bundle
    // never reaches the mode's own check; the mode's `engine-bundle:missing`
    // classification covers the file vanishing after that strict gate.
    const { moduleUrl } = releaseTree({ bundle: null });
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("release:invalid");
  });

  it("fails when the engine bundle is a symbolic link", async () => {
    const { root, moduleUrl } = releaseTree({ bundle: null });
    symlinkSync(resolve(root, "pkg", "cli.min.js"), resolve(root, "pkg", "server.min.js"));
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("engine-bundle:not-a-regular-file");
  });

  it("fails when the engine bundle does not compile as an ES module", async () => {
    const { moduleUrl } = releaseTree({ bundle: 'module.exports = 1; return 5;\nimport "fake-external";\n' });
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("engine-bundle:uncompilable");
  });

  it("never evaluates the engine bundle while compiling it", async () => {
    const { moduleUrl } = releaseTree({
      bundle: 'import "fake-external";\nprocess.exit(17);\nthrow new Error("evaluated");\n',
    });
    await expect(engineValidate({ moduleUrl })).resolves.toMatchObject({ manifest: identity });
  });

  it("fails when the derived specifier set is empty", async () => {
    const { moduleUrl } = releaseTree({ bundle: 'import "node:fs";\nexport default 1;\n' });
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("engine-externals:none");
  });

  it("fails when an external does not resolve", async () => {
    const { moduleUrl } = releaseTree({ bundle: 'import "absent-external";\nexport default 1;\n' });
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("engine-external-resolve:absent-external");
  });

  it("fails when an external resolves outside the release", async () => {
    const { root, moduleUrl } = releaseTree();
    const outside = mkdtempSync(resolve(tmpdir(), "hive-engine-outside-"));
    roots.push(outside);
    writeFileSync(resolve(outside, "escaped.js"), "export default 1;\n");
    const { io } = recordingIO({ resolve: () => resolve(outside, "escaped.js") });
    await expect(engineValidate({ moduleUrl, io })).rejects.toThrow("engine-external-containment:fake-external");
    expect(root).not.toBe(outside);
  });

  it("fails when an external resolves to a Hive module rather than a dependency", async () => {
    const { root, moduleUrl } = releaseTree();
    const { io } = recordingIO({ resolve: () => resolve(root, "pkg", "cli.min.js") });
    await expect(engineValidate({ moduleUrl, io })).rejects.toThrow("engine-external-hive-module:fake-external");
  });

  it("fails when an external cannot be imported", async () => {
    const { root, moduleUrl } = releaseTree();
    writeFileSync(resolve(root, "node_modules", "fake-external", "index.js"), "throw new Error('boom');\n");
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("engine-external-import:fake-external");
  });

  it("fails when the loaded identity differs from a supplied expected release", async () => {
    const { moduleUrl } = releaseTree();
    await expect(
      engineValidate({ moduleUrl, expected: { ...identity, sourceRevision: "e".repeat(40) } }),
    ).rejects.toThrow("release-identity:mismatch");
    await expect(engineValidate({ moduleUrl, expected: identity })).resolves.toMatchObject({ manifest: identity });
  });

  it("refuses an unpackaged helper location", async () => {
    const { root } = releaseTree();
    await expect(engineValidate({ moduleUrl: pathToFileURL(resolve(root, "package.json")).href })).rejects.toThrow(
      "helper-location:not-packaged",
    );
  });

  it("fails when the release manifest is unreadable", async () => {
    const { root, moduleUrl } = releaseTree();
    writeFileSync(resolve(root, "pkg", "release.json"), "{}");
    await expect(engineValidate({ moduleUrl })).rejects.toThrow("release:invalid");
  });
});

describe("diagnostic entrypoint", () => {
  function captureMain() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    return { stdout, stderr };
  }

  afterEach(() => {
    process.exitCode = 0;
  });

  it("rejects an unsupported mode without printing any success record", async () => {
    const { stdout, stderr } = captureMain();
    await main(["node", "diagnostic", "boot"]);
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("ARTIFACT_RUNTIME_FAILED mode:unsupported\n");
  });

  it("never exits 0 without the engine-validate record", async () => {
    const { stdout, stderr } = captureMain();
    // The test process is not a packaged release, so the mode must fail.
    await main(["node", "diagnostic", "engine-validate"]);
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toMatch(/^ENGINE_VALIDATE_FAILED [a-z0-9@._/-]+(?::[a-z0-9@._/-]+)?\n$/);
  });

  it("treats exit 0 without the record as a verification failure", () => {
    expect(() => parseRuntimeLoadingRecord("", "ENGINE_VALIDATE_OK")).toThrow("success record missing");
    expect(() => parseRuntimeLoadingRecord("ENGINE_VALIDATE_OK {}\n", "ENGINE_VALIDATE_OK")).toThrow(
      "success record has no release identity",
    );
  });
});
