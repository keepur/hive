import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHostNpmCli } from "./host-npm.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(kind: "cli" | "shim"): { root: string; pathEnv: string; npmCli: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-host-npm-")));
  roots.push(root);
  const npmCli = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "#!/usr/bin/env node\n", { mode: 0o644 });
  chmodSync(npmCli, 0o755);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npmOnPath = join(bin, "npm");
  if (kind === "cli") symlinkSync(npmCli, npmOnPath);
  else {
    writeFileSync(npmOnPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return { root, pathEnv: `${bin}:/usr/bin:/bin`, npmCli };
}

describe("resolveHostNpmCli", () => {
  it("resolves PATH npm to its real npm-cli.js", async () => {
    const f = fixture("cli");
    expect(await resolveHostNpmCli(f.pathEnv)).toBe(f.npmCli);
  });

  it("rejects a host npm that is not npm-cli.js", async () => {
    const f = fixture("shim");
    await expect(resolveHostNpmCli(f.pathEnv)).rejects.toThrow(
      "host npm prerequisite must resolve to its real npm-cli.js",
    );
  });

  it("requires an explicit PATH", async () => {
    await expect(resolveHostNpmCli("")).rejects.toThrow("explicit PATH is required to resolve npm");
  });
});
