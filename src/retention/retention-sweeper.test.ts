import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { RetentionSweeper, expandRule } from "./retention-sweeper.js";
import type { RetentionConfig } from "../config.js";

function makeHive(): string {
  const root = resolve(tmpdir(), `hive-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function touch(path: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const now = Date.now();
  const t = (now - ageDays * 86400_000) / 1000;
  utimesSync(path, t, t);
}

function baseCfg(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    enabled: false,
    intervalMs: 60_000,
    defaultDays: 7,
    paths: {},
    ...overrides,
  };
}

describe("expandRule", () => {
  let hive: string;
  beforeEach(() => {
    hive = makeHive();
  });
  afterEach(() => rmSync(hive, { recursive: true, force: true }));

  it("resolves a static rule to a single absolute path", () => {
    mkdirSync(join(hive, "data"), { recursive: true });
    expect(expandRule(hive, "data")).toEqual([join(hive, "data")]);
  });

  it("expands a single-star rule across direct children", () => {
    mkdirSync(join(hive, "agents", "milo", "scratch"), { recursive: true });
    mkdirSync(join(hive, "agents", "river", "scratch"), { recursive: true });
    mkdirSync(join(hive, "agents", "jasper", "workshop"), { recursive: true });
    const expanded = expandRule(hive, "agents/*/scratch").sort();
    expect(expanded).toEqual([
      join(hive, "agents", "milo", "scratch"),
      join(hive, "agents", "river", "scratch"),
    ]);
  });

  it("returns empty when parent doesn't exist", () => {
    expect(expandRule(hive, "missing/*/scratch")).toEqual([]);
  });

  it("rejects rules with more than one star", () => {
    expect(() => expandRule(hive, "agents/*/foo/*")).toThrow(/at most one/);
  });
});

describe("RetentionSweeper.sweep", () => {
  let hive: string;
  let report: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hive = makeHive();
    report = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => rmSync(hive, { recursive: true, force: true }));

  it("reports age-over candidates in dry-run mode without deleting", async () => {
    touch(join(hive, "data", "old.csv"), 10);
    touch(join(hive, "data", "new.csv"), 1);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.dryRun).toBe(true);
    expect(r.candidates.map((c) => c.path)).toEqual([join(hive, "data", "old.csv")]);
    expect(r.deleted).toEqual([]);
    expect(existsSync(join(hive, "data", "old.csv"))).toBe(true);
    expect(report).toHaveBeenCalledOnce();
  });

  it("deletes candidates when enabled", async () => {
    touch(join(hive, "data", "old.csv"), 10);
    const sweeper = new RetentionSweeper(
      baseCfg({ enabled: true, paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.deleted.map((c) => c.path)).toEqual([join(hive, "data", "old.csv")]);
    expect(existsSync(join(hive, "data", "old.csv"))).toBe(false);
  });

  it("honors .retention-days override in a target directory", async () => {
    mkdirSync(join(hive, "data"), { recursive: true });
    writeFileSync(join(hive, "data", ".retention-days"), "30\n");
    touch(join(hive, "data", "old.csv"), 10); // 10 < 30, so NOT a candidate
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates).toEqual([]);
  });

  it("skips rules with days=0 (keep forever)", async () => {
    touch(join(hive, "agents", "milo", "reports", "standup.md"), 365);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { "agents/*/reports": { days: 0 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates).toEqual([]);
  });

  it("expands star rules into per-agent roots", async () => {
    touch(join(hive, "agents", "milo", "scratch", "old.txt"), 10);
    touch(join(hive, "agents", "river", "scratch", "old.txt"), 10);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { "agents/*/scratch": { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates.map((c) => c.path).sort()).toEqual([
      join(hive, "agents", "milo", "scratch", "old.txt"),
      join(hive, "agents", "river", "scratch", "old.txt"),
    ]);
  });

  it("ignores invalid .retention-days content and falls back to rule default", async () => {
    mkdirSync(join(hive, "data"), { recursive: true });
    writeFileSync(join(hive, "data", ".retention-days"), "not-a-number");
    touch(join(hive, "data", "old.csv"), 10);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates.map((c) => c.path)).toEqual([join(hive, "data", "old.csv")]);
  });
});
