import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildSeatbeltProfile as helperProfile } from "../src/deployment/confined-job.js";
import { validateArchiveMembers as helperMembers } from "../src/deployment/artifact.js";
// @ts-expect-error builtin-only runbook recipe is plain JavaScript without declarations
import * as recipe from "./kpr463-prepare-bootstrap.mjs";

interface RunOptions {
  cwd: string;
  input?: Buffer;
}
interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: Buffer;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HELPER = Buffer.from('console.log("frozen helper");\n');
const ARCHIVE = Buffer.from("reviewed archive bytes\n");
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const NODE = "/opt/node/bin/node";

function workspace() {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), "kpr463-prepare-")));
  chmodSync(base, 0o755);
  roots.push(base);
  const instance = resolve(base, "instance");
  mkdirSync(instance, { mode: 0o755 });
  const archive = resolve(base, "candidate.tgz");
  writeFileSync(archive, ARCHIVE, { mode: 0o644 });
  const env = {
    KPR463_INSTANCE: instance,
    KPR463_INSTANCE_ID: "dodi",
    KPR463_CONFIG: resolve(instance, "hive.yaml"),
    KPR463_ARCHIVE: archive,
    KPR463_SHA: SHA,
    KPR463_REVISION: "c".repeat(40),
  };
  return { base, instance, archive, env };
}

function fakeIO(
  options: {
    selfTest?: "deny" | "allow" | "launcher-error";
    names?: string;
    details?: string;
    platform?: string;
    sandbox?: boolean;
  } = {},
) {
  const calls: { command: string; args: string[]; input: string | null }[] = [];
  let counter = 0;
  const io = {
    platform: () => options.platform ?? "darwin",
    sandboxExecPresent: () => options.sandbox ?? true,
    pid: () => process.pid,
    uid: () => process.getuid!(),
    nodePath: () => NODE,
    randomId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    processStartTime: async () => "Mon Sep 14 10:00:00 2026",
    run: async (command: string, args: string[], run: RunOptions): Promise<RunResult> => {
      calls.push({ command, args, input: run.input ? run.input.toString("utf8") : null });
      expect(command).toBe(recipe.SANDBOX_EXEC);
      expect(args[0]).toBe("-p");
      expect(args[1]).toBe(helperProfile(run.cwd));
      const inner = args[2];
      const ok = (stdout: string | Buffer): RunResult => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: Buffer.from(stdout),
      });
      if (inner === NODE) {
        if (options.selfTest === "launcher-error") throw new Error("spawn failed");
        const [outside, inside] = args.slice(5);
        writeFileSync(inside, "x");
        if (options.selfTest === "allow") {
          writeFileSync(outside, "x");
          return ok('{"outside":"written","inside":"ok"}');
        }
        return ok('{"outside":"EPERM","inside":"ok"}');
      }
      expect(inner).toBe(recipe.TAR);
      expect(run.input?.equals(ARCHIVE)).toBe(true);
      const flag = args[3];
      if (flag === "-tzf") return ok(options.names ?? "package/\npackage/pkg/\npackage/pkg/deploy.min.js\n");
      if (flag === "-tvzf") {
        return ok(options.details ?? "drwxr-xr-x 0 package/\ndrwxr-xr-x 0 package/pkg/\n-rw-r--r-- 0 deploy\n");
      }
      if (flag === "-xOzf") {
        expect(args.slice(4)).toEqual(["-", recipe.HELPER_MEMBER]);
        return ok(HELPER);
      }
      throw new Error(`unexpected tar flag ${flag}`);
    },
  };
  return { io, calls };
}

function receipts(instance: string) {
  const root = resolve(instance, ".hive-state/bootstrap");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(root, name), "utf8")) as Record<string, unknown>);
}

describe("host preparation recipe contracts", () => {
  it("builds exactly the deployment helper's Seatbelt profile and path rules", () => {
    for (const path of ["/Users/x/services/hive/dodi/.hive-state/jobs/a/b", "/tmp/with space & amp/job"]) {
      expect(recipe.buildSeatbeltProfile(path)).toBe(helperProfile(path));
    }
    for (const unsafe of ['/tmp/a"b', "/tmp/a\\b", "/tmp/a\nb", "/tmp/a\0b"]) {
      expect(() => recipe.buildSeatbeltProfile(unsafe)).toThrow();
      expect(() => helperProfile(unsafe)).toThrow();
    }
  });

  it("applies the same strict archive member rules as staging", () => {
    const cases: [string, string][] = [
      ["package/\npackage/pkg/deploy.min.js\n", "d\n-\n"],
      ["package/../x\n", "-\n"],
      ["/abs\n", "-\n"],
      ["package/hive.yaml\n", "-\n"],
      ["package/.hive-state/x\n", "-\n"],
      ["package/pkg/link\n", "l\n"],
      ["package/a\npackage/b\n", "-\n"],
      ["", ""],
    ];
    for (const [names, details] of cases) {
      const helperOutcome = (() => {
        try {
          return helperMembers(names, details);
        } catch {
          return "rejected";
        }
      })();
      const recipeOutcome = (() => {
        try {
          return (recipe.validateArchiveMembers(names, details) as { members: string[] }).members;
        } catch {
          return "rejected";
        }
      })();
      expect(recipeOutcome).toEqual(helperOutcome);
    }
  });

  it("validates reviewed inputs before touching anything", () => {
    const { env } = workspace();
    for (const [key, bad] of [
      ["KPR463_INSTANCE", "relative"],
      ["KPR463_INSTANCE_ID", "../x"],
      ["KPR463_CONFIG", "hive.yaml"],
      ["KPR463_ARCHIVE", "/tmp/archive.zip"],
      ["KPR463_SHA", "A".repeat(64)],
      ["KPR463_REVISION", "abc"],
    ] as const) {
      expect(() => recipe.readPreparationInput({ ...env, [key]: bad })).toThrow();
    }
  });
});

describe("host preparation recipe", () => {
  it("prepares the helper from the confined member read and records every phase durably", async () => {
    const w = workspace();
    const { io, calls } = fakeIO();
    const prepared = (await recipe.prepareBootstrapHelper(w.env, io)) as string;
    expect(prepared).toMatch(/\.hive-state\/bootstrap\/\.prepare-[0-9a-f-]+\/package\/pkg\/deploy\.min\.js$/);
    expect(readFileSync(prepared).equals(HELPER)).toBe(true);
    // Self-test runs before any archive read; tar jobs are fed the hashed bytes on stdin.
    expect(calls.map((call) => call.args[2])).toEqual([NODE, recipe.TAR, recipe.TAR, recipe.TAR]);
    const [receipt] = receipts(w.instance);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      phase: "validated",
      preparedPath: prepared,
      reviewedRevision: "c".repeat(40),
      adoptedOperationId: null,
      owner: { pid: process.pid },
    });
    expect((receipt.archive as { sha256: string }).sha256).toBe(SHA);
    expect((receipt.helper as { sha256: string }).sha256).toBe(createHash("sha256").update(HELPER).digest("hex"));
    const raw = readFileSync(
      resolve(w.instance, ".hive-state/bootstrap", `.prepare-${String(receipt.id)}.json`),
      "utf8",
    );
    expect(raw).toBe(`${recipe.canonical(receipt)}\n`);
    expect(readdirSync(resolve(w.instance, ".hive-state/jobs"))).toEqual([]);
  });

  it("fails closed before any archive read without sandbox-exec, off macOS, or on a non-denying self-test", async () => {
    for (const options of [
      { sandbox: false },
      { platform: "linux" },
      { selfTest: "allow" as const },
      { selfTest: "launcher-error" as const },
    ]) {
      const w = workspace();
      rmSync(w.archive);
      const { io } = fakeIO(options);
      await expect(recipe.prepareBootstrapHelper(w.env, io)).rejects.toThrow(/sandbox-exec|self-test/);
      expect(receipts(w.instance)).toEqual([]);
    }
  });

  it("a digest mismatch writes no receipt and no preparation directory", async () => {
    const w = workspace();
    const { io, calls } = fakeIO();
    await expect(recipe.prepareBootstrapHelper({ ...w.env, KPR463_SHA: "b".repeat(64) }, io)).rejects.toThrow(
      "reviewed SHA",
    );
    expect(receipts(w.instance)).toEqual([]);
    expect(calls.filter((call) => call.args[2] === recipe.TAR)).toEqual([]);
  });

  it("an unsafe or helper-less archive never reaches validated and prints no path", async () => {
    for (const options of [
      { names: "package/\npackage/pkg/other.js\n", details: "d\n-\n" },
      { names: "package/pkg/deploy.min.js\n", details: "l\n" },
      { names: "package/../escape\n", details: "-\n" },
    ]) {
      const w = workspace();
      const { io } = fakeIO(options);
      await expect(recipe.prepareBootstrapHelper(w.env, io)).rejects.toThrow();
      const [receipt] = receipts(w.instance);
      expect(receipt.phase).toBe("created");
      expect(receipt.helper).toBeNull();
    }
  });
});
