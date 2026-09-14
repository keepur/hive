import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireOperation, finishOperationLock, writeOperationJson, type AcquiredOperation } from "./operation.js";
import {
  capturePrior,
  decodePriorSnapshot,
  loadPrior,
  PriorSnapshotIncompleteError,
  restorePrior,
  verifyPrior,
} from "./prior.js";
import { buildServiceDefinitions, buildServiceEnvironment, type ServiceSnapshot } from "./services.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; operation: AcquiredOperation; snapshot: ServiceSnapshot }> {
  const root = mkdtempSync(join(tmpdir(), "prior-snapshot-"));
  roots.push(root);
  const operation = await acquireOperation({
    instanceHome: root,
    instanceId: "dodi",
    mode: "update",
    toolSha256: "a".repeat(64),
    ownerStartTime: "start",
  });
  const home = operation.record.canonicalHome;
  mkdirSync(resolve(home, ".hive"));
  const pair = buildServiceDefinitions({
    instanceId: "dodi",
    nodePath: "/opt/node/bin/node",
    hiveHome: home,
    configPath: resolve(home, "hive.yaml"),
    home: "/Users/example",
    pathEnv: "/usr/bin:/bin",
  });
  const inspection = (definition: typeof pair.engine, pid: number) => ({
    label: definition.label,
    loaded: true,
    enabled: true,
    livePID: pid,
    startTime: "Mon Sep 14 10:00:00 2026",
    args: [definition.nodePath, definition.entrypoint, ...definition.args],
    cwd: home,
    configSelection: definition.configPath,
    serviceEnvironment: buildServiceEnvironment(definition),
    plist: null,
    link: null,
    process: {
      pid,
      ppid: 1,
      startTime: "Mon Sep 14 10:00:00 2026",
      command: [definition.nodePath, definition.entrypoint, ...definition.args].join(" "),
      executable: definition.nodePath,
      cwd: home,
    },
  });
  const external = "/Users/example/github/kpr-320-live-call/com.hive.dodi.agent.plist";
  const snapshot: ServiceSnapshot = {
    services: [
      {
        definition: pair.engine,
        inspection: inspection(pair.engine, 10),
        plist: { path: external, existed: true, bytes: Buffer.from("pilot-effective-engine"), mode: 0o644 },
        instancePlist: {
          path: resolve(home, "service", "com.hive.dodi.agent.plist"),
          existed: true,
          bytes: Buffer.from("instance-sentinel"),
          mode: 0o600,
        },
        link: {
          path: "/Users/example/Library/LaunchAgents/com.hive.dodi.agent.plist",
          existed: true,
          target: external,
        },
        loaded: true,
        enabled: true,
      },
      {
        definition: pair.worker,
        inspection: { ...inspection(pair.worker, 11) },
        plist: { path: resolve(home, "service", "com.hive.dodi.voice-worker.plist"), existed: false },
        instancePlist: { path: resolve(home, "service", "com.hive.dodi.voice-worker.plist"), existed: false },
        link: { path: "/Users/example/Library/LaunchAgents/com.hive.dodi.voice-worker.plist", existed: false },
        loaded: false,
        enabled: false,
      },
    ],
  };
  return { root, operation, snapshot };
}

describe("reconstructable prior snapshot", () => {
  it("round-trips definitions, both plist roles and slot identities from sealed backups", async () => {
    const { operation, snapshot } = await fixture();
    await capturePrior({
      operation,
      services: snapshot,
      configPath: resolve(operation.record.canonicalHome, "hive.yaml"),
      workerHealthPort: 3107,
    });
    const loaded = await loadPrior(operation.record);
    expect(loaded.prior.slots.find((slot) => slot.name === ".hive")?.identity).not.toBeNull();
    expect(loaded.prior.slots.find((slot) => slot.name === ".hive.next")?.identity).toBeNull();
    const [engine, worker] = loaded.services.services;
    expect(engine.plist.bytes?.toString()).toBe("pilot-effective-engine");
    expect(engine.instancePlist.bytes?.toString()).toBe("instance-sentinel");
    expect(engine.link.target).toBe(snapshot.services[0].link.target);
    expect(worker.plist.existed).toBe(false);
    expect(worker.loaded).toBe(false);
    // Plist bytes never appear in the JSON snapshot itself.
    expect(readFileSync(operation.paths.priorSnapshot, "utf8")).not.toContain("instance-sentinel");
    await finishOperationLock(operation);
  });

  it("rejects a tampered backup instead of restoring it", async () => {
    const { operation, snapshot } = await fixture();
    await capturePrior({ operation, services: snapshot, configPath: "/x/hive.yaml", workerHealthPort: null });
    writeFileSync(resolve(operation.paths.operationDirectory, "com.hive.dodi.agent.instance.plist.original"), "evil");
    await expect(loadPrior(operation.record)).rejects.toThrow("backup seal mismatch");
    await finishOperationLock(operation);
  });

  it("names the missing fields of an older summary snapshot and never guesses", async () => {
    const { operation } = await fixture();
    await writeOperationJson(operation.paths.priorSnapshot, {
      schemaVersion: 1,
      toolSha256: "a",
      artifactSlots: [],
      services: [],
    });
    const error = await loadPrior(operation.record).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PriorSnapshotIncompleteError);
    expect((error as PriorSnapshotIncompleteError).missing).toEqual(
      expect.arrayContaining(["schemaVersion", "operationId", "slots"]),
    );
    await finishOperationLock(operation);
  });

  it("rejects undeclared fields, wrong operation association and inconsistent absence", async () => {
    const { operation, snapshot } = await fixture();
    const prior = await capturePrior({
      operation,
      services: snapshot,
      configPath: "/x/hive.yaml",
      workerHealthPort: null,
    });
    expect(() => decodePriorSnapshot({ ...prior, verified: true })).toThrow("unexpected field prior.verified");
    const absentWithBackup = structuredClone(prior);
    absentWithBackup.services[1].effectivePlist.sha256 = "b".repeat(64);
    expect(() => decodePriorSnapshot(absentWithBackup)).toThrow("absence carries backup fields");
    await writeOperationJson(operation.paths.priorSnapshot, { ...prior, operationId: "someone-else" });
    await expect(loadPrior(operation.record)).rejects.toThrow("another operation");
    await finishOperationLock(operation);
  });

  it("restores in order and verifies only the captured profile", async () => {
    const { operation, snapshot } = await fixture();
    await capturePrior({ operation, services: snapshot, configPath: "/x/hive.yaml", workerHealthPort: null });
    const loaded = await loadPrior(operation.record);
    const calls: string[] = [];
    await restorePrior(
      {
        restore: async (_services, hooks) => {
          calls.push("files+engine");
          await hooks?.afterEngine?.(null);
          calls.push("worker");
        },
      },
      loaded,
      { verifyEngine: async () => void calls.push("engine-check") },
    );
    expect(calls).toEqual(["files+engine", "engine-check", "worker"]);
    const profile: string[] = [];
    await verifyPrior(
      { ...loaded, prior: { ...loaded.prior, priorProfile: "pilot" } },
      {
        packaged: async () => void profile.push("packaged"),
        pilot: async () => void profile.push("pilot"),
        stopped: async () => void profile.push("stopped"),
      },
    );
    expect(profile).toEqual(["pilot"]);
    await finishOperationLock(operation);
  });
});
