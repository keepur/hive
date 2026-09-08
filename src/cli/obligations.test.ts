import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runObligations, type CliSelection } from "./obligations.js";
import { harness, definition, KEY } from "../obligations/testing/harness.js";
vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: () => null }));
const roots: string[] = [];
beforeEach(() => {
  for (const key of ["MONGODB_URI", "MONGODB_DB", "HIVE_HOME"]) vi.stubEnv(key, "");
  vi.stubEnv("HIVE_CONFIG", undefined); // Absent selects hive.yaml; unstubAllEnvs restores any inherited value.
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-obligations-test-"));
  roots.push(root);
  return root;
}
function fixture(instanceId = "demo", filename = "hive.yaml", root = temporaryRoot()) {
  mkdirSync(root, { recursive: true });
  const path = join(root, filename),
    uri = "mongodb://" + instanceId + ".invalid",
    dbName = "hive_" + instanceId;
  writeFileSync(path, "instance:\n  id: " + instanceId + "\n");
  const suffix = filename.match(/^hive-(.+)\.yaml$/)?.[1];
  writeFileSync(join(root, suffix ? ".env-" + suffix : ".env"), "MONGODB_URI=" + uri + "\nMONGODB_DB=" + dbName + "\n");
  return { root, path, selection: { configPath: path, instanceId, uri, dbName } satisfies CliSelection };
}
function connection(h: Awaited<ReturnType<typeof harness>>, f: ReturnType<typeof fixture>) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async (selection: CliSelection) => {
    expect(selection).toEqual(f.selection);
    return { db: h.fake.db, close };
  });
  return { connect, close };
}
describe("instance-bound obligations CLI", () => {
  it("reads pending and expired initial history without any mutations and closes every client", async () => {
    const h = await harness(),
      f = fixture(),
      c = connection(h, f),
      emit = vi.fn();
    const e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery);
    for (const expired of [false, true]) {
      if (expired) h.at("2026-09-09T07:00:00Z");
      const snapshot = h.snapshot(),
        writes = h.fake.writes(),
        inserts = h.receiptInserts(),
        posts = h.submitted.length;
      for (const command of [["list"], ["show", "demo"]]) {
        await runObligations(["obligations", ...command, "--config", f.path, "--json"], {
          connect: c.connect,
          clock: h.clock,
          emit,
        });
        const view = JSON.parse(emit.mock.calls.at(-1)![0]);
        expect(view.receiptRetentionMs).toBe(86400_000);
        if (command[0] === "show")
          expect(view.occurrences[0]).toMatchObject({
            history: expired ? "expired_unresolved" : "initial_write_pending",
            acknowledgement: { receiptWriteState: "pending" },
            sendable: false,
          });
        else expect(view).toHaveProperty("definitions");
      }
      expect(h.snapshot()).toEqual(snapshot);
      expect(h.fake.writes()).toBe(writes);
      expect(h.receiptInserts()).toBe(inserts);
      expect(h.submitted).toHaveLength(posts);
      expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("pending");
    }
    expect(c.connect).toHaveBeenCalledTimes(4);
    expect(c.close).toHaveBeenCalledTimes(4);
  });
  it("refuses absent/mismatched sentinels without restamping", async () => {
    for (const absent of [true, false]) {
      const h = await harness(),
        f = fixture(),
        c = connection(h, f);
      const sentinel = h.fake.collection("instance_identity");
      if (absent) sentinel.rows.clear();
      else sentinel.rows.get("identity_sentinel")!.instanceId = "other";
      const writes = h.fake.writes();
      await expect(
        runObligations(["obligations", "deactivate", "demo", "--reason", "stop", "--config", f.path], {
          connect: c.connect,
          clock: h.clock,
          emit: () => {},
        }),
      ).rejects.toThrow("identity_unverified");
      expect(h.fake.writes()).toBe(writes);
      expect(c.close).toHaveBeenCalledTimes(1);
    }
  });
  it("registers identically, rejects conflicts, and deactivates only once without changing schedules", async () => {
    const h = await harness(),
      f = fixture(),
      c = connection(h, f),
      json = join(f.root, "definition.json");
    writeFileSync(json, JSON.stringify(definition));
    const deps = { connect: c.connect, clock: h.clock, emit: () => {} };
    const args = ["obligations", "register", "--file", json, "--config", f.path];
    await runObligations(args, deps);
    await runObligations(args, deps);
    writeFileSync(json, JSON.stringify({ ...definition, deliverable: "Different" }));
    await expect(runObligations(args, deps)).rejects.toThrow("definition_conflict");
    await runObligations(["obligations", "deactivate", "demo", "--reason", "first", "--config", f.path], deps);
    const cutoff = (await h.store.get("demo"))!.deactivatedAt;
    h.at("2026-09-08T08:00:00Z");
    await runObligations(["obligations", "deactivate", "demo", "--reason", "second", "--config", f.path], deps);
    expect((await h.store.get("demo"))!.deactivatedAt).toEqual(cutoff);
    expect((await h.fake.collection("agent_definitions").findOne({ _id: "demo-producer" }))!.schedule).toEqual([]);
    expect(c.close).toHaveBeenCalledTimes(5);
  });
  it.each(["config_file", "config_directory", "config_suffix", "home", "home_config", "instance"] as const)(
    "routes %s to the selected instance and leaves the other database intact",
    async (mode) => {
      const original = await harness(),
        selected = await harness({ instanceId: "other" });
      const f1 = fixture(),
        homeRoot = temporaryRoot();
      const f2 = fixture(
        "other",
        ["config_suffix", "home_config"].includes(mode) ? "hive-selected.yaml" : "hive.yaml",
        mode === "instance" ? join(homeRoot, "services", "hive", "other") : undefined,
      );
      let args: string[];
      if (mode === "instance") {
        vi.stubEnv("HOME", homeRoot);
        args = ["--instance", "other"];
      } else if (mode === "home" || mode === "home_config") {
        vi.stubEnv("HIVE_HOME", f2.root);
        if (mode === "home_config") vi.stubEnv("HIVE_CONFIG", "hive-selected.yaml");
        args = [];
      } else args = ["--config", mode === "config_directory" ? f2.root : f2.path];
      const c1 = connection(original, f1),
        c2 = connection(selected, f2);
      const connect = vi.fn(async (selection: CliSelection) => {
        if (selection.dbName === f1.selection.dbName) return c1.connect(selection);
        if (selection.dbName === f2.selection.dbName) return c2.connect(selection);
        throw new Error("unexpected_target");
      });
      const untouched = original.snapshot(),
        writes = selected.fake.writes();
      selected.at("2026-09-07T07:00:00Z");
      await runObligations(["obligations", "deactivate", "demo", "--reason", "selected", ...args], {
        connect,
        clock: selected.clock,
        emit: () => {},
      });
      expect(connect).toHaveBeenCalledWith(f2.selection);
      expect(c1.connect).not.toHaveBeenCalled();
      expect(c2.close).toHaveBeenCalledTimes(1);
      expect(original.snapshot()).toEqual(untouched);
      expect(selected.fake.writes()).toBeGreaterThan(writes);
      expect((await selected.store.get("demo"))!.deactivatedAt).toEqual(selected.clock());
    },
  );
  it("captures environment overrides in the selected target before sentinel verification", async () => {
    const h = await harness({ instanceId: "other", dbName: "hive_override" }),
      f = fixture("other");
    vi.stubEnv("MONGODB_URI", "mongodb://override.invalid");
    vi.stubEnv("MONGODB_DB", "hive_override");
    const selected = {
      ...f,
      selection: { ...f.selection, uri: "mongodb://override.invalid", dbName: "hive_override" },
    };
    const c = connection(h, selected);
    await runObligations(["obligations", "list", "--config", f.path], {
      connect: c.connect,
      clock: h.clock,
      emit: () => {},
    });
    expect(c.connect).toHaveBeenCalledWith(selected.selection);
    expect(c.close).toHaveBeenCalledTimes(1);
  });
  it("rejects missing/conflicting selection before connecting", async () => {
    const f = fixture(),
      connect = vi.fn(async () => {
        throw new Error("must_not_connect");
      });
    const deps = { connect, clock: () => new Date(0), emit: vi.fn() };
    await expect(runObligations(["obligations", "list"], deps)).rejects.toThrow("explicit_instance_required");
    await expect(
      runObligations(["obligations", "list", "--config", f.path, "--instance", "demo"], deps),
    ).rejects.toThrow("choose_config_or_instance");
    expect(connect).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
  });
});
