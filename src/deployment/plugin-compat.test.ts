import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { acquireOperation, type AcquiredOperation } from "./operation.js";
import {
  applyBetaPluginCompatibility,
  nodePluginCompatIO,
  planBetaPluginCompatibility,
  PluginCompatibilityPendingError,
  PluginCompatibilityUnresolvedError,
  reconcileBetaPluginCompatibility,
  type PluginCompatIO,
} from "./plugin-compat.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-plugin-compat-")));
  chmodSync(root, 0o755);
  roots.push(root);
  mkdirSync(resolve(root, ".hive"), { mode: 0o755 });
  return root;
}

async function acquire(root: string): Promise<AcquiredOperation> {
  return acquireOperation({
    instanceHome: root,
    instanceId: "dodi",
    mode: "update",
    toolSha256: "a".repeat(64),
    ownerStartTime: "start",
  });
}

function beta(root: string, name: string, file = "package.json", contents = "{}"): string {
  const directory = resolve(root, ".hive", "plugins", "node_modules", name);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  writeFileSync(resolve(directory, file), contents, { mode: 0o640 });
  return directory;
}

function compatRecord(operation: AcquiredOperation): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(operation.paths.operationDirectory, "plugin-compat.json"), "utf8"));
}

describe("locked beta plugin compatibility (ported relocateBetaPlugins coverage)", () => {
  it("moves a scoped directory as one entry and retains modes", async () => {
    const root = home();
    beta(root, "@keepur/example");
    const operation = await acquire(root);
    const result = await applyBetaPluginCompatibility({ operation });
    expect(result.moved).toEqual(["@keepur"]);
    const moved = resolve(root, "plugins", "node_modules", "@keepur", "example", "package.json");
    expect(existsSync(moved)).toBe(true);
    expect(statSync(moved).mode & 0o777).toBe(0o640);
    expect(existsSync(resolve(root, ".hive", "plugins", "node_modules", "@keepur"))).toBe(false);
    const record = compatRecord(operation) as {
      phase: string;
      entries: { afterSha256: string; beforeSha256: string }[];
    };
    expect(record.phase).toBe("compatibility-committed");
    expect(record.entries[0].afterSha256).toBe(record.entries[0].beforeSha256);
  });

  it("is a no-op without a source and writes no record", async () => {
    const root = home();
    const operation = await acquire(root);
    expect(await applyBetaPluginCompatibility({ operation })).toEqual({
      record: null,
      moved: [],
      destinationExists: [],
    });
    expect(existsSync(resolve(operation.paths.operationDirectory, "plugin-compat.json"))).toBe(false);
    expect(existsSync(resolve(root, "plugins"))).toBe(false);
  });

  it("never overwrites an existing destination and preserves both copies", async () => {
    const root = home();
    beta(root, "pluginA", "marker", "engine-dir");
    const destination = resolve(root, "plugins", "node_modules", "pluginA");
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    writeFileSync(resolve(destination, "marker"), "hive-home-canonical");
    const operation = await acquire(root);
    const result = await applyBetaPluginCompatibility({ operation });
    expect(result.moved).toEqual([]);
    expect(result.destinationExists).toEqual(["pluginA"]);
    expect(readFileSync(resolve(destination, "marker"), "utf8")).toBe("hive-home-canonical");
    expect(readFileSync(resolve(root, ".hive", "plugins", "node_modules", "pluginA", "marker"), "utf8")).toBe(
      "engine-dir",
    );
    expect((compatRecord(operation) as { entries: { state: string }[] }).entries[0].state).toBe("destination-exists");
  });

  it("dry-run planning is read-only", async () => {
    const root = home();
    beta(root, "pluginA");
    const plan = await planBetaPluginCompatibility(root);
    expect(plan.relocate.map((item) => item.name)).toEqual(["pluginA"]);
    expect(existsSync(resolve(root, "plugins"))).toBe(false);
    expect(existsSync(resolve(root, ".hive-state"))).toBe(false);
  });

  it("requires the operation's own instance lock", async () => {
    const root = home();
    beta(root, "pluginA");
    const operation = await acquire(root);
    const foreign: AcquiredOperation = { ...operation, record: { ...operation.record, id: "someone-else" } };
    await expect(applyBetaPluginCompatibility({ operation: foreign })).rejects.toBeInstanceOf(
      PluginCompatibilityUnresolvedError,
    );
    expect(existsSync(resolve(root, ".hive", "plugins", "node_modules", "pluginA"))).toBe(true);
  });

  it("rejects symbolic links and foreign-writable ancestors before any move", async () => {
    const root = home();
    beta(root, "pluginA");
    symlinkSync(resolve(root, ".hive"), resolve(root, ".hive", "plugins", "node_modules", "linked"));
    const operation = await acquire(root);
    await expect(applyBetaPluginCompatibility({ operation })).rejects.toBeInstanceOf(PluginCompatibilityPendingError);
    expect(existsSync(resolve(root, "plugins"))).toBe(false);

    const second = home();
    beta(second, "pluginB");
    chmodSync(resolve(second, ".hive", "plugins", "node_modules"), 0o777);
    await expect(planBetaPluginCompatibility(second)).rejects.toBeInstanceOf(PluginCompatibilityPendingError);
  });

  it("reverses a completed rename when a later rename fails", async () => {
    const root = home();
    beta(root, "a-first");
    beta(root, "b-second");
    const operation = await acquire(root);
    let renames = 0;
    const io: PluginCompatIO = {
      ...nodePluginCompatIO,
      async rename(from, to) {
        renames += 1;
        if (renames === 2) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
        await nodePluginCompatIO.rename(from, to);
      },
    };
    await expect(applyBetaPluginCompatibility({ operation, io })).rejects.toBeInstanceOf(
      PluginCompatibilityPendingError,
    );
    expect(existsSync(resolve(root, ".hive", "plugins", "node_modules", "a-first", "package.json"))).toBe(true);
    expect(existsSync(resolve(root, ".hive", "plugins", "node_modules", "b-second", "package.json"))).toBe(true);
    expect(existsSync(resolve(root, "plugins", "node_modules", "a-first"))).toBe(false);
    expect((compatRecord(operation) as { phase: string }).phase).toBe("reversed");
  });

  it("reconciles an interrupted relocation by reversing observed moves and leaves unmoved intents", async () => {
    const root = home();
    beta(root, "a-first");
    beta(root, "b-second");
    const operation = await acquire(root);
    let renames = 0;
    class Crash extends Error {}
    const io: PluginCompatIO = {
      ...nodePluginCompatIO,
      async rename(from, to) {
        renames += 1;
        if (renames === 2) throw new Crash("process died before second rename");
        await nodePluginCompatIO.rename(from, to);
      },
      // Simulate a crash: persistence of the reversal never happens.
      async persist(path, value) {
        if ((value as { phase: string }).phase === "reversed" || renames >= 2) throw new Crash("crash");
        await nodePluginCompatIO.persist(path, value);
      },
    };
    await expect(applyBetaPluginCompatibility({ operation, io })).rejects.toThrow();
    // The durable record still shows the first entry observed, the second intended.
    expect((compatRecord(operation) as { entries: { state: string }[] }).entries.map((e) => e.state)).toEqual([
      "observed",
      "intended",
    ]);
    expect(await reconcileBetaPluginCompatibility(operation)).toBe("reversed");
    expect(existsSync(resolve(root, ".hive", "plugins", "node_modules", "a-first", "package.json"))).toBe(true);
    expect(existsSync(resolve(root, "plugins", "node_modules", "a-first"))).toBe(false);
  });

  it("leaves a changed destination unresolved and never overwrites it", async () => {
    const root = home();
    beta(root, "a-first");
    beta(root, "b-second");
    const operation = await acquire(root);
    let renames = 0;
    const io: PluginCompatIO = {
      ...nodePluginCompatIO,
      async rename(from, to) {
        renames += 1;
        if (renames === 2) {
          // Someone replaces the relocated first entry before reversal.
          rmSync(resolve(root, "plugins", "node_modules", "a-first"), { recursive: true });
          mkdirSync(resolve(root, "plugins", "node_modules", "a-first"));
          throw new Error("injected");
        }
        await nodePluginCompatIO.rename(from, to);
      },
    };
    await expect(applyBetaPluginCompatibility({ operation, io })).rejects.toThrow();
    expect((compatRecord(operation) as { phase: string }).phase).toBe("unresolved");
    expect(existsSync(resolve(root, "plugins", "node_modules", "a-first"))).toBe(true);
    await expect(reconcileBetaPluginCompatibility(operation)).rejects.toBeInstanceOf(
      PluginCompatibilityUnresolvedError,
    );
  });

  it("a committed relocation survives a later deployment failure and is idempotent", async () => {
    const root = home();
    beta(root, "pluginA");
    const operation = await acquire(root);
    await applyBetaPluginCompatibility({ operation });
    expect(await reconcileBetaPluginCompatibility(operation)).toBe("compatibility-committed");
    const again = await applyBetaPluginCompatibility({ operation });
    expect(again.moved).toEqual(["pluginA"]);
    expect(existsSync(resolve(root, "plugins", "node_modules", "pluginA", "package.json"))).toBe(true);
  });
});
