import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sha256 } from "./release.js";
import { stagingRequired, validatePromotedRelease, type LifecycleCommand } from "./lifecycle.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function promotedRelease(withDependencies: boolean): string {
  const root = resolve(realpathSync(mkdtempSync(resolve(tmpdir(), "hive-promoted-"))), ".hive.prev");
  roots.push(resolve(root, ".."));
  mkdirSync(resolve(root, "pkg", "mcp"), { recursive: true });
  const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { "": { version: "1.0.0" } } }));
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "1.0.0" }));
  writeFileSync(resolve(root, "npm-shrinkwrap.json"), lock);
  for (const file of [
    "server.min.js",
    "cli.min.js",
    "voice-worker.min.js",
    "voice-worker-diagnostic.min.js",
    "runtime-probe.min.js",
    "deploy.min.js",
    "mcp/voice-livekit.min.js",
  ]) {
    writeFileSync(resolve(root, "pkg", file), "//");
  }
  writeFileSync(
    resolve(root, "pkg", "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageVersion: "1.0.0",
      sourceRevision: "c".repeat(40),
      sourceDirty: false,
      dependencyLockSha256: sha256(lock),
      voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
    }),
  );
  if (withDependencies) mkdirSync(resolve(root, "node_modules"));
  return root;
}

describe("lifecycle staging boundaries", () => {
  it("runs confined staging only for operations that promote a new artifact", () => {
    const modes: LifecycleCommand["mode"][] = [
      "update",
      "check",
      "rollback",
      "start",
      "stop",
      "restart",
      "pilot-rollback",
    ];
    expect(Object.fromEntries(modes.map((mode) => [mode, stagingRequired(mode)]))).toEqual({
      update: true,
      check: true,
      rollback: false,
      start: false,
      stop: false,
      restart: false,
      "pilot-rollback": false,
    });
  });

  it("validates a promoted rollback release in-process without any packaged diagnostic or sandbox-exec", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(validatePromotedRelease(promotedRelease(true)).packageVersion).toBe("1.0.0");
      expect(() => validatePromotedRelease(promotedRelease(false))).toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
