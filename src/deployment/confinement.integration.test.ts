import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixture, destroyFixture, type S9Fixture } from "./testing/s9-harness.js";
import { ensureCandidatePack, ensureT7Pack, type PackedRelease } from "./testing/s9-packages.js";
import { INTEGRATION_TIMEOUT_MS, waitLatchWaiting, waitT7Job, writeT7Latch } from "./testing/s9-test-utils.js";

const darwin = process.platform === "darwin";
const sandboxPresent = existsSync("/usr/bin/sandbox-exec");

describe("S9 T7 confinement integration (actual frozen helper)", { timeout: INTEGRATION_TIMEOUT_MS }, () => {
  let C: PackedRelease;
  let T7: PackedRelease;
  const fixtures: S9Fixture[] = [];

  beforeAll(async () => {
    if (!darwin || !sandboxPresent) return;
    C = await ensureCandidatePack();
    T7 = await ensureT7Pack(C);
  }, INTEGRATION_TIMEOUT_MS);

  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) await destroyFixture(fixture);
  }, INTEGRATION_TIMEOUT_MS);

  async function fixture(options: Parameters<typeof createFixture>[0]): Promise<S9Fixture> {
    const created = await createFixture(options);
    fixtures.push(created);
    return created;
  }

  it.runIf(darwin && sandboxPresent)(
    "T7 positive driven: confinement holds and the promoted tree stays clean",
    async () => {
      const { spawnHelper, waitFor, continueLatch } = await import("./testing/s9-harness.js");
      const fx = await fixture({ packed: C, seedHive: C, flags: { latchCp: true, latchRotate: true } });
      const child = spawnHelper(fx, [`--artifact=${T7.tgz}`]);
      const job = waitT7Job(fx);
      waitLatchWaiting(fx, "cp");
      writeT7Latch(job, "clone", fx.hiveHome);
      expect(waitFor(() => existsSync(join(job, ".t7-outside-clone.json")), 60_000)).toBe(true);
      const outside = JSON.parse(readFileSync(join(job, ".t7-outside-clone.json"), "utf8")) as {
        ok: boolean;
        code?: string;
        path: string;
      }[];
      expect(outside.every((row) => row.ok === false && row.code === "EPERM")).toBe(true);
      continueLatch(fx, "cp");
      try {
        waitLatchWaiting(fx, "rotate");
      } catch (error) {
        const stdout = existsSync(join(fx.control, "helper.stdout"))
          ? readFileSync(join(fx.control, "helper.stdout"), "utf8").slice(-4000)
          : "";
        const stderr = existsSync(join(fx.control, "helper.stderr"))
          ? readFileSync(join(fx.control, "helper.stderr"), "utf8").slice(-4000)
          : "";
        throw new Error(`${(error as Error).message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`, { cause: error });
      }
      writeT7Latch(job, "verified", fx.hiveHome);
      writeT7Latch(job, "rotated", fx.hiveHome);
      continueLatch(fx, "rotate");
      const status = await new Promise<number>((resolvePromise) => {
        child.on("exit", (code) => resolvePromise(code ?? 1));
      });
      expect(status, "T7 update should complete").toBe(0);
      expect(existsSync(join(fx.hiveHome, ".hive", "t7-corrupt-clone"))).toBe(false);
      expect(existsSync(join(fx.hiveHome, ".hive", "t7-corrupt-rotated"))).toBe(false);
      const promotedCli = readFileSync(join(fx.hiveHome, ".hive", "pkg", "cli.min.js"));
      expect(promotedCli.includes("T7_HELD_rotated")).toBe(false);
    },
  );

  it.runIf(darwin && sandboxPresent)(
    "T7 negative 1: skipping sandbox-exec with clone kept actually corrupts the promoted tree",
    async () => {
      const { spawnHelper, continueLatch, waitFor } = await import("./testing/s9-harness.js");
      const fx = await fixture({
        packed: C,
        seedHive: C,
        flags: { latchCp: true, bypassInstallSandbox: true },
      });
      const child = spawnHelper(fx, [`--artifact=${T7.tgz}`]);
      const job = waitT7Job(fx);
      waitLatchWaiting(fx, "cp");
      writeT7Latch(job, "clone", fx.hiveHome);
      expect(waitFor(() => existsSync(join(job, ".t7-outside-clone.json")), 60_000)).toBe(true);
      const outside = JSON.parse(readFileSync(join(job, ".t7-outside-clone.json"), "utf8")) as { ok: boolean }[];
      expect(outside.some((row) => row.ok)).toBe(true);
      writeT7Latch(job, "verified", fx.hiveHome);
      writeT7Latch(job, "rotated", fx.hiveHome);
      continueLatch(fx, "cp");
      await new Promise<void>((resolvePromise) => child.on("exit", () => resolvePromise()));
      const corrupted =
        existsSync(join(fx.hiveHome, ".hive", "t7-corrupt-clone")) ||
        existsSync(join(fx.hiveHome, ".hive.next", "t7-corrupt-clone")) ||
        existsSync(join(fx.hiveHome, ".hive", "t7-corrupt-verified")) ||
        existsSync(join(fx.hiveHome, ".hive.next", "t7-corrupt-verified"));
      expect(corrupted).toBe(true);
    },
  );

  it.runIf(darwin && sandboxPresent)(
    "T7 negative 2: confinement kept with promotion-by-rename lets the held descriptor corrupt .hive",
    async () => {
      const { spawnHelper, continueLatch } = await import("./testing/s9-harness.js");
      const fx = await fixture({
        packed: C,
        seedHive: C,
        flags: { latchCp: true, latchRotate: true, renamePromote: true },
      });
      const child = spawnHelper(fx, [`--artifact=${T7.tgz}`]);
      const job = waitT7Job(fx);
      waitLatchWaiting(fx, "cp");
      writeT7Latch(job, "clone", fx.hiveHome);
      continueLatch(fx, "cp");
      waitLatchWaiting(fx, "rotate");
      writeT7Latch(job, "verified", fx.hiveHome);
      writeT7Latch(job, "rotated", fx.hiveHome);
      continueLatch(fx, "rotate");
      await new Promise<void>((resolvePromise) => child.on("exit", () => resolvePromise()));
      const hiveCli = join(fx.hiveHome, ".hive", "pkg", "cli.min.js");
      expect(existsSync(hiveCli)).toBe(true);
      const promoted = readFileSync(hiveCli, "utf8");
      const renamedJobTree =
        existsSync(join(fx.hiveHome, ".hive", ".t7-writer.pid")) ||
        existsSync(join(fx.hiveHome, ".hive", "s9-t7-writer")) ||
        promoted.includes("T7_HELD_");
      expect(renamedJobTree, "rename-promote must put the job tree (or a held write) into .hive").toBe(true);
    },
  );

  it.runIf(!(darwin && sandboxPresent))("records the real-sandbox-exec skip reason", () => {
    expect(darwin && sandboxPresent, "T7 positives require Darwin /usr/bin/sandbox-exec").toBeFalsy();
  });
});
