import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFixture,
  destroyFixture,
  DUMMY_ENV,
  invokeHelper,
  PRELOADER,
  sha256File,
  type S9Fixture,
} from "./testing/s9-harness.js";
import { ensureCandidatePack, ensureHistoricalPack, type PackedRelease } from "./testing/s9-packages.js";
import {
  bootstrapArgs,
  events,
  helperResult,
  INTEGRATION_TIMEOUT_MS,
  oldUpdaterCalled,
  operationRecords,
  secretsLeak,
  waitLatchWaiting,
} from "./testing/s9-test-utils.js";

describe("S9 lifecycle integration (actual frozen helper)", { timeout: INTEGRATION_TIMEOUT_MS }, () => {
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

  it("starts, stops and restarts the packaged pair through the frozen helper", async () => {
    const fx = await fixture({ packed: C, seedHive: C });
    const start = invokeHelper(fx, ["--start"]);
    expect(start.status, start.stderr + start.stdout).toBe(0);
    expect(helperResult(start).status ?? "healthy").toBeTruthy();
    expect(existsSync(join(fx.hiveHome, ".hive-state", "runtime", "engine.json"))).toBe(true);
    expect(existsSync(join(fx.hiveHome, ".hive-state", "runtime", "voice-worker.json"))).toBe(true);
    const enginePlist = join(fx.hiveHome, "service", `com.hive.${fx.instanceId}.agent.plist`);
    const workerPlist = join(fx.hiveHome, "service", `com.hive.${fx.instanceId}.voice-worker.plist`);
    expect(readFileSync(enginePlist, "utf8")).toContain(join(fx.hiveHome, ".hive", "pkg", "server.min.js"));
    expect(readFileSync(workerPlist, "utf8")).toContain(join(fx.hiveHome, ".hive", "pkg", "voice-worker.min.js"));
    const restart = invokeHelper(fx, ["--restart"]);
    expect(restart.status, restart.stderr + restart.stdout).toBe(0);
    const stop = invokeHelper(fx, ["--stop"]);
    expect(stop.status, stop.stderr + stop.stdout).toBe(0);
    expect(JSON.stringify(helperResult(stop))).not.toMatch(/OLD_UPDATER/);
    expect(secretsLeak(`${start.stdout}${restart.stdout}${stop.stdout}`, fx)).toEqual([]);
  });

  it("propagates a persistence-faulted or owned closed gate into failed activation then checked recovery", async () => {
    const closed = await fixture({ packed: C, seedHive: C, flags: { admission: "closed" } });
    const closedStart = invokeHelper(closed, ["--start"]);
    expect(closedStart.status).not.toBe(0);
    expect(JSON.stringify(helperResult(closedStart))).not.toMatch(/"status":"healthy"/);
    const faulted = await fixture({ packed: C, seedHive: C, flags: { admission: "faulted" } });
    const faultedStart = invokeHelper(faulted, ["--start"]);
    expect(faultedStart.status).not.toBe(0);
    expect(`${faultedStart.stdout}${faultedStart.stderr}`).not.toMatch(/"status":"healthy"/);
  });

  it("sends release, then delayed close cannot re-close, and the operation record is resolved", async () => {
    const fx = await fixture({ packed: C, seedHive: C, flags: { delayClose: true } });
    expect(invokeHelper(fx, ["--start"]).status).toBe(0);
    const stop = invokeHelper(fx, ["--stop"]);
    expect(stop.status, stop.stderr + stop.stdout).toBe(0);
    expect(events(fx).some((type) => type === "bootout")).toBe(true);
    expect(existsSync(join(fx.hiveHome, ".hive-state", "deployment", "lock"))).toBe(false);
    expect(JSON.stringify(helperResult(stop))).not.toMatch(/"status":"healthy"/);
    expect(operationRecords(fx).some((path) => path.endsWith("operation.json"))).toBe(true);
  });

  it("preserves operator sentinels across start/stop and a second-instance sibling", async () => {
    const fx = await fixture({ packed: C, seedHive: C });
    const sentinel = join(fx.hiveHome, "hive.yaml.sentinel");
    const agent = join(fx.hiveHome, "agents", "keep.txt");
    const mode = statSync(sentinel).mode;
    expect(invokeHelper(fx, ["--start"]).status).toBe(0);
    expect(invokeHelper(fx, ["--stop"]).status).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("preserve-me\n");
    expect(readFileSync(agent, "utf8")).toBe("agent-sentinel\n");
    expect(statSync(sentinel).mode).toBe(mode);
    expect(oldUpdaterCalled(fx)).toBe(false);
  });

  it("keeps a second instance's process state, labels and .hive-state distinct", async () => {
    const a = await fixture({ packed: C, seedHive: C, instanceId: "s9a" });
    const b = await fixture({ packed: C, seedHive: C, instanceId: "s9b" });
    expect(invokeHelper(a, ["--start"]).status).toBe(0);
    expect(invokeHelper(b, ["--start"]).status).toBe(0);
    const aEngine = join(a.hiveHome, "service", "com.hive.s9a.agent.plist");
    const bEngine = join(b.hiveHome, "service", "com.hive.s9b.agent.plist");
    const aWorker = join(a.hiveHome, "service", "com.hive.s9a.voice-worker.plist");
    const bWorker = join(b.hiveHome, "service", "com.hive.s9b.voice-worker.plist");
    expect(readFileSync(aEngine, "utf8")).toContain(`com.hive.s9a.agent`);
    expect(readFileSync(bEngine, "utf8")).toContain(`com.hive.s9b.agent`);
    expect(readFileSync(aEngine, "utf8")).not.toContain("com.hive.s9b.");
    expect(readFileSync(bEngine, "utf8")).not.toContain("com.hive.s9a.");
    expect(readFileSync(aWorker, "utf8")).toContain(join(a.hiveHome, ".hive", "pkg", "voice-worker.min.js"));
    expect(readFileSync(bWorker, "utf8")).toContain(join(b.hiveHome, ".hive", "pkg", "voice-worker.min.js"));
    const aIdentity = JSON.parse(readFileSync(join(a.hiveHome, ".hive-state", "runtime", "engine.json"), "utf8")) as {
      pid: number;
    };
    const bIdentity = JSON.parse(readFileSync(join(b.hiveHome, ".hive-state", "runtime", "engine.json"), "utf8")) as {
      pid: number;
    };
    expect(aIdentity.pid).toBeGreaterThan(1);
    expect(bIdentity.pid).toBeGreaterThan(1);
    expect(aIdentity.pid).not.toBe(bIdentity.pid);
    expect(existsSync(join(a.hiveHome, ".hive-state", "runtime", "voice-worker.json"))).toBe(true);
    expect(existsSync(join(b.hiveHome, ".hive-state", "runtime", "voice-worker.json"))).toBe(true);
    expect(readFileSync(join(a.hiveHome, "hive.yaml.sentinel"), "utf8")).toBe("preserve-me\n");
    expect(readFileSync(join(b.hiveHome, "hive.yaml.sentinel"), "utf8")).toBe("preserve-me\n");
    expect(invokeHelper(a, ["--stop"]).status).toBe(0);
    expect(invokeHelper(b, ["--stop"]).status).toBe(0);
    expect(existsSync(join(b.hiveHome, ".hive-state"))).toBe(true);
    expect(existsSync(join(a.hiveHome, ".hive-state"))).toBe(true);
  });

  it("fails staging before signals when sandbox-exec is missing, and rolls back without it", async () => {
    const fx = await fixture({ packed: C, seedHive: C, flags: { hideSandboxExec: true } });
    const update = invokeHelper(fx, [`--artifact=${C.tgz}`]);
    expect(update.status).not.toBe(0);
    expect(events(fx)).not.toContain("bootout");
    expect(invokeHelper(fx, ["--start"]).status).toBe(0);
    expect(invokeHelper(fx, ["--stop"]).status).toBe(0);
    const prev = join(fx.hiveHome, ".hive.prev");
    if (!existsSync(prev)) cpSync(join(C.extract, "package"), prev, { recursive: true });
    const rollback = invokeHelper(fx, ["--rollback"]);
    expect(`${rollback.stdout}${rollback.stderr}`).not.toMatch(/sandbox-exec/);
    expect(rollback.status, `${rollback.stderr}\n${rollback.stdout}`).toBe(0);
  });

  it("prints PREVIOUS_OPERATION_RECONCILED after frozen-helper death during bootstrap and does not start the new action", async () => {
    const fx = await fixture({ packed: C, flags: { latchSandbox: true } });
    const { spawnHelper, killHelperTree, continueLatch } = await import("./testing/s9-harness.js");
    const child = spawnHelper(fx, bootstrapArgs(C));
    waitLatchWaiting(fx, "sandbox-exec");
    await killHelperTree(child, fx);
    continueLatch(fx, "sandbox-exec");
    const next = invokeHelper(fx, bootstrapArgs(C));
    expect(next.status).not.toBe(0);
    expect(`${next.stdout}${next.stderr}`).toContain("PREVIOUS_OPERATION_RECONCILED");
    const release = JSON.parse(readFileSync(join(C.extract, "package", "pkg", "release.json"), "utf8")) as {
      sourceDirty: boolean;
    };
    if (!release.sourceDirty) {
      const third = invokeHelper(fx, bootstrapArgs(C));
      expect(third.status, `${third.stderr}\n${third.stdout}`).toBe(0);
      expect(helperResult(third).status).toBe("BOOTSTRAP_VALIDATED");
    }
  });

  it("H own-loader Mongo baseline stays on hive_h_* while C's endpoint is poisoned", async () => {
    const fx = await fixture({ packed: C, seedHive: H, mongoDb: `hive_h_${"s9a"}` });
    expect(H.provenance).toMatch(/harness-built checkpoint/);
    expect(H.revision).not.toBe(C.revision);
    expect(invokeHelper(fx, ["--start"]).status).toBe(0);
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(fx.mongo.uri);
    await client.connect();
    try {
      const hDb = client.db(`hive_h_${fx.instanceId}`);
      const cDb = client.db(`hive_${fx.instanceId}`);
      await cDb.collection("telemetry").insertOne({
        kind: "voice_worker_stats",
        activeCalls: 9,
        supervisorIdentity: { pid: 1, bootId: "deadbeef", component: "voice-worker" },
        supervisorUpdatedAt: new Date(),
      });
      const hRow = await hDb.collection("telemetry").findOne({ kind: "voice_worker_stats" });
      expect(hRow?.activeCalls).toBe(0);
      const profile = await hDb.command({ profile: 2 });
      expect(profile).toBeTruthy();
      const cRow = await cDb.collection("telemetry").findOne({ kind: "voice_worker_stats" });
      expect(cRow?.activeCalls).toBe(9);
    } finally {
      await client.close();
    }
    expect(invokeHelper(fx, ["--stop"]).status).toBe(0);
  });

  it("records H vs C package provenance and helper hash independence", () => {
    expect(C.provenance).toMatch(/independent pack:release/);
    expect(H.provenance).toMatch(/not a production release/);
    expect(H.provenance).toMatch(/cartesia\/sonic-2/);
    expect(sha256File(join(C.extract, "package", "pkg", "deploy.min.js"))).not.toBe(
      sha256File(join(H.extract, "package", "pkg", "deploy.min.js")),
    );
    expect(readdirSync(join(H.extract, "package"))).toContain("pkg");
    expect(existsSync(join(H.extract, "package", "pkg", "runtime-probe.min.js"))).toBe(true);
  });

  it("prints PREVIOUS_OPERATION_RECONCILED after frozen-helper death during promotion and does not start the new action", async () => {
    const fx = await fixture({ packed: C, seedHive: C, flags: { latchPromote: true } });
    const { spawnHelper, killHelperTree, continueLatch } = await import("./testing/s9-harness.js");
    const child = spawnHelper(fx, [`--artifact=${C.tgz}`]);
    waitLatchWaiting(fx, "cp");
    await killHelperTree(child, fx);
    continueLatch(fx, "cp");
    const next = invokeHelper(fx, [`--artifact=${C.tgz}`]);
    expect(next.status).not.toBe(0);
    expect(`${next.stdout}${next.stderr}`).toContain("PREVIOUS_OPERATION_RECONCILED");
    expect(events(fx)).not.toContain("bootout");
  });

  it("recovers a stale lock via the original frozen helper even after the invoke helper bytes change", async () => {
    const fx = await fixture({ packed: C, flags: { latchSandbox: true } });
    const { spawnHelper, killHelperTree, continueLatch } = await import("./testing/s9-harness.js");
    const child = spawnHelper(fx, bootstrapArgs(C));
    waitLatchWaiting(fx, "sandbox-exec");
    await killHelperTree(child, fx);
    continueLatch(fx, "sandbox-exec");
    const original = readFileSync(fx.helper);
    writeFileSync(fx.helper, `${original.toString("utf8")}\n`);
    const next = invokeHelper(fx, bootstrapArgs(C));
    expect(next.status).not.toBe(0);
    expect(`${next.stdout}${next.stderr}`).toContain("PREVIOUS_OPERATION_RECONCILED");
    writeFileSync(fx.helper, original);
  });

  it("starts a capable historical H layout and runs H's probe from outside .hive", async () => {
    const fx = await fixture({ packed: C, seedHive: H, mongoDb: `hive_h_s9a` });
    expect(invokeHelper(fx, ["--start"]).status).toBe(0);
    const historical = join(H.extract, "package", "pkg", "runtime-probe.min.js");
    expect(historical.includes(`${join(fx.hiveHome, ".hive")}`)).toBe(false);
    const stdout = execFileSync(process.execPath, ["--import", pathToFileURL(PRELOADER).href, historical, "config"], {
      encoding: "utf8",
      env: {
        HOME: fx.userHome,
        HIVE_HOME: fx.hiveHome,
        HIVE_CONFIG: fx.configPath,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    expect(stdout).toMatch(/s9a/);
    expect(stdout).not.toContain(DUMMY_ENV.LIVEKIT_API_SECRET);
    expect(stdout).not.toContain(DUMMY_ENV.HIVE_VOICE_BRIDGE_TOKEN);
    expect(invokeHelper(fx, ["--restart"]).status).toBe(0);
    expect(invokeHelper(fx, ["--stop"]).status).toBe(0);
  });

  it("issues real pinned LiveKit list RPCs against the disposable local HTTP server", async () => {
    const fx = await fixture({ packed: C, seedHive: C });
    const sdk = (await import(
      pathToFileURL(join(C.extract, "package", "node_modules", "livekit-server-sdk", "dist", "index.js")).href
    )) as {
      RoomServiceClient: new (url: string, key: string, secret: string) => { listRooms(): Promise<unknown[]> };
      AgentDispatchClient: new (
        url: string,
        key: string,
        secret: string,
      ) => { listDispatch(room: string): Promise<unknown[]> };
      SipClient: new (
        url: string,
        key: string,
        secret: string,
      ) => {
        listSipDispatchRule(options: { page: { limit: number; afterId: string } }): Promise<unknown[]>;
        listSipInboundTrunk(options: { page: { limit: number; afterId: string } }): Promise<unknown[]>;
      };
    };
    const rooms = new sdk.RoomServiceClient(fx.livekit.url, DUMMY_ENV.LIVEKIT_API_KEY, DUMMY_ENV.LIVEKIT_API_SECRET);
    const dispatch = new sdk.AgentDispatchClient(
      fx.livekit.url,
      DUMMY_ENV.LIVEKIT_API_KEY,
      DUMMY_ENV.LIVEKIT_API_SECRET,
    );
    const sip = new sdk.SipClient(fx.livekit.url, DUMMY_ENV.LIVEKIT_API_KEY, DUMMY_ENV.LIVEKIT_API_SECRET);
    const listed = await rooms.listRooms();
    expect(listed.length).toBeGreaterThan(0);
    expect(await dispatch.listDispatch("s9-room")).toBeTruthy();
    const first = await sip.listSipDispatchRule({ page: { limit: 100, afterId: "" } });
    expect(first.length).toBe(100);
    const lastId = (first.at(-1) as { sipDispatchRuleId?: string }).sipDispatchRuleId ?? "";
    const second = await sip.listSipDispatchRule({ page: { limit: 100, afterId: lastId } });
    expect(second.length).toBeGreaterThan(0);
    expect(fx.livekit.requests.some((row) => row.includes("ListRooms"))).toBe(true);
    expect(fx.livekit.requests.some((row) => row.includes("ListSIPDispatchRule"))).toBe(true);
  });
});
