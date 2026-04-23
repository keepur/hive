import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { relocateBetaPlugins } from "./update-preflight.js";

function makeDirs(): { hive: string; engine: string; cleanup: () => void } {
  const hive = resolve(tmpdir(), `hive-update-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const engine = resolve(hive, ".hive");
  mkdirSync(engine, { recursive: true });
  return { hive, engine, cleanup: () => rmSync(hive, { recursive: true, force: true }) };
}

describe("relocateBetaPlugins", () => {
  let hive: string, engine: string, cleanup: () => void;

  beforeEach(() => {
    ({ hive, engine, cleanup } = makeDirs());
  });

  afterEach(() => cleanup());

  it("moves plugins from <engine>/plugins/node_modules/ to <hive>/plugins/node_modules/", () => {
    const src = resolve(engine, "plugins", "node_modules", "@keepur", "example");
    mkdirSync(src, { recursive: true });
    writeFileSync(resolve(src, "package.json"), '{"name":"@keepur/example","version":"1.0.0"}');

    const result = relocateBetaPlugins(hive, engine);
    expect(result.moved).toEqual(["@keepur"]);
    expect(existsSync(resolve(hive, "plugins", "node_modules", "@keepur", "example", "package.json"))).toBe(true);
    expect(existsSync(resolve(engine, "plugins", "node_modules", "@keepur"))).toBe(false);
  });

  it("is a no-op when no plugins are misrouted", () => {
    const result = relocateBetaPlugins(hive, engine);
    expect(result).toEqual({ moved: [], skipped: true });
  });

  it("is idempotent — skips entries that already exist at the destination", () => {
    const src = resolve(engine, "plugins", "node_modules", "pluginA");
    const dst = resolve(hive, "plugins", "node_modules", "pluginA");
    mkdirSync(src, { recursive: true });
    writeFileSync(resolve(src, "marker"), "engine-dir");
    mkdirSync(dst, { recursive: true });
    writeFileSync(resolve(dst, "marker"), "hive-home-canonical");

    const result = relocateBetaPlugins(hive, engine);
    expect(result.moved).toEqual([]);
    // Hive-home copy is untouched (canonical wins).
    const content = readFileSync(resolve(dst, "marker"), "utf-8");
    expect(content).toBe("hive-home-canonical");
  });

  it("handles a missing engine plugins dir cleanly", () => {
    // engine exists but <engine>/plugins/ does not — simulates fresh 0.2.0-GA
    // install or a post-migration state.
    const result = relocateBetaPlugins(hive, engine);
    expect(result.skipped).toBe(true);
  });
});
