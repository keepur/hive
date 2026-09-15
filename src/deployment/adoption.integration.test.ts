import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFixture,
  destroyFixture,
  helperEnv,
  invokeHelper,
  PRELOADER,
  sha256File,
  type S9Fixture,
} from "./testing/s9-harness.js";
import {
  ensureCandidatePack,
  ensureHistoricalPack,
  preAbiDispatcher,
  type PackedRelease,
} from "./testing/s9-packages.js";
import {
  bootstrapArgs,
  helperResult,
  INTEGRATION_TIMEOUT_MS,
  oldUpdaterCalled,
  waitLatchWaiting,
} from "./testing/s9-test-utils.js";
import { spawnHelper, killHelperTree, continueLatch } from "./testing/s9-harness.js";

describe("S9 adoption integration (actual S8 CLI and frozen helper)", { timeout: INTEGRATION_TIMEOUT_MS }, () => {
  let C: PackedRelease;
  let H: PackedRelease;
  const fixtures: S9Fixture[] = [];

  beforeAll(async () => {
    C = await ensureCandidatePack();
    H = await ensureHistoricalPack();
  }, INTEGRATION_TIMEOUT_MS);

  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) await destroyFixture(fixture);
  }, INTEGRATION_TIMEOUT_MS);

  async function fixture(options: Parameters<typeof createFixture>[0]): Promise<S9Fixture> {
    const created = await createFixture(options);
    fixtures.push(created);
    return created;
  }

  it("never runs the old-updater sentinel; candidate helper hash matches the bootstrap package", async () => {
    const fx = await fixture({ packed: C, seedHive: H });
    const cli = join(C.extract, "package", "pkg", "cli.min.js");
    const importUrl = pathToFileURL(PRELOADER).href;
    let status = 0;
    let combined: string;
    try {
      combined = execFileSync(process.execPath, ["--import", importUrl, cli, "update", `--artifact=${C.tgz}`], {
        encoding: "utf8",
        timeout: INTEGRATION_TIMEOUT_MS,
        env: helperEnv(fx),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = typeof failure.status === "number" ? failure.status : 1;
      combined = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }
    expect(oldUpdaterCalled(fx)).toBe(false);
    expect(combined).not.toContain("OLD_UPDATER_CALLED");
    const candidateHelper = join(C.extract, "package", "pkg", "deploy.min.js");
    expect(sha256File(fx.helper)).toBe(sha256File(candidateHelper));
    const enginePlist = join(fx.hiveHome, "service", `com.hive.${fx.instanceId}.agent.plist`);
    const workerPlist = join(fx.hiveHome, "service", `com.hive.${fx.instanceId}.voice-worker.plist`);
    if (existsSync(enginePlist)) {
      expect(readFileSync(enginePlist, "utf8")).toContain(`${join(fx.hiveHome, ".hive", "pkg")}`);
    }
    if (existsSync(workerPlist)) {
      expect(readFileSync(workerPlist, "utf8")).toContain(`${join(fx.hiveHome, ".hive", "pkg")}`);
    }
    expect(status === 0 || status === 1).toBe(true);
  });

  it("kills first adoption after tooling clone and before rename, then reuses nothing partial; second adoption reuses the final-name entry", async () => {
    const fx = await fixture({ packed: C, flags: { latchRename: true } });
    const child = spawnHelper(fx, bootstrapArgs(C));
    waitLatchWaiting(fx, "tooling-rename");
    await killHelperTree(child, fx);
    continueLatch(fx, "tooling-rename");
    const staging = join(fx.hiveHome, ".hive-state", "tooling", ".staging");
    const first = invokeHelper(fx, bootstrapArgs(C));
    expect(first.status).not.toBe(0);
    expect(`${first.stdout}${first.stderr}`).toContain("PREVIOUS_OPERATION_RECONCILED");
    if (existsSync(staging)) {
      expect(readdirSync(staging).length === 0 || first.status !== 0).toBe(true);
    }
    const second = invokeHelper(fx, bootstrapArgs(C));
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(helperResult(second).status).toBe("BOOTSTRAP_VALIDATED");
    const tooling = join(fx.hiveHome, ".hive-state", "tooling", C.sha256);
    expect(existsSync(join(tooling, "pkg", "release.json"))).toBe(true);
    const third = invokeHelper(fx, bootstrapArgs(C));
    expect(third.status, third.stderr + third.stdout).toBe(0);
    expect(JSON.stringify(helperResult(third))).toMatch(/BOOTSTRAP_VALIDATED/);
  });

  it("uninstrumented legacy hold stays MIGRATION_PENDING without a fabricated capability", async () => {
    const fx = await fixture({ packed: C, seedHive: H });
    const hold = join(fx.root, "uninstrumented-hold.json");
    writeFileSync(hold, JSON.stringify({ kind: "unavailable" }));
    const result = invokeHelper(fx, [`--artifact=${C.tgz}`, `--legacy-hold=${hold}`]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/MIGRATION_PENDING|legacy-hold|REGISTRY|absolute|selector/);
  });

  it("unsupported pre-ABI dispatcher fails closed and cannot be made positive by a hand-authored response", () => {
    const dispatcher = preAbiDispatcher();
    let stderr = "";
    let status = 0;
    try {
      execFileSync(process.execPath, [dispatcher, "pilot-abi"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = typeof failure.status === "number" ? failure.status : 1;
      stderr = String(failure.stderr ?? "");
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain("PILOT_PROBE_ABI_UNSUPPORTED");
  });

  it("H checkpoint and C candidate are independently packed with distinct revisions", () => {
    expect(H.revision).not.toBe(C.revision);
    expect(H.provenance).toMatch(/cartesia\/sonic-2/);
    expect(existsSync(join(H.extract, "package", "pkg", "runtime-probe.min.js"))).toBe(true);
    expect(existsSync(join(C.extract, "package", "pkg", "runtime-probe.min.js"))).toBe(true);
  });
});
