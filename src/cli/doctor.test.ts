import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPromptCacheSection, resolveRequiredEnvVars } from "./doctor.js";

describe("resolveRequiredEnvVars", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-here-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers required-env.json sitting next to the caller (bundled layout)", () => {
    // This is the path taken by an npm-installed hive: pkg/cli.min.js
    // calls into resolveRequiredEnvVars with import.meta.dirname pointing
    // at pkg/, and pkg/required-env.json is the shipped artifact.
    writeFileSync(join(dir, "required-env.json"), JSON.stringify({ requiredEnv: ["FOO", "BAR"] }));

    expect(resolveRequiredEnvVars(dir)).toEqual(["FOO", "BAR"]);
  });

  it("falls back to required-env.json one directory up (split layout)", () => {
    // Defensive — covers a future packaging where the JSON sits next to a
    // dist/ tree rather than alongside the bundle.
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    writeFileSync(join(dir, "required-env.json"), JSON.stringify({ requiredEnv: ["BAZ"] }));

    expect(resolveRequiredEnvVars(sub)).toEqual(["BAZ"]);
  });

  it("scans src/config.ts when no JSON is found (dev / source-checkout)", () => {
    // Simulate src/cli/ → src/config.ts layout that source-checkout dev
    // workflows rely on.
    const srcDir = join(dir, "src");
    const cliDir = join(srcDir, "cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(srcDir, "config.ts"),
      `
      const a = required("ALPHA");
      const b = required("BETA");
      const c = optional("GAMMA", "default");
      `,
    );

    // hereDir = src/cli/ — `..` is src/, `..` is dir, but the source path
    // probe is `<here>/../../src/config.ts` so we need an outer wrapper
    // that mirrors the production package layout (pkg-or-dist/cli/).
    expect(resolveRequiredEnvVars(cliDir)).toEqual(["ALPHA", "BETA"]);
  });

  it("returns [] when neither JSON nor source is reachable", () => {
    // Doctor surfaces this as a single failed check rather than crashing,
    // so `[]` is the correct fail-soft path.
    expect(resolveRequiredEnvVars(dir)).toEqual([]);
  });

  it("ignores a malformed required-env.json and falls through", () => {
    writeFileSync(join(dir, "required-env.json"), "{ this is not json");

    expect(resolveRequiredEnvVars(dir)).toEqual([]);
  });

  it("ignores a JSON whose requiredEnv field is the wrong shape", () => {
    writeFileSync(join(dir, "required-env.json"), JSON.stringify({ requiredEnv: "not-an-array" }));

    expect(resolveRequiredEnvVars(dir)).toEqual([]);
  });
});

describe("renderPromptCacheSection", () => {
  it("renders 'no telemetry yet' when the rows are empty", () => {
    const lines: string[] = [];
    renderPromptCacheSection([], (l) => lines.push(l));
    expect(lines.join("\n")).toContain("Prompt cache (last 7 days)");
    expect(lines.join("\n")).toContain("no telemetry yet");
  });

  it("renders one row per agent with hit rate, read, create, input, turns", () => {
    const lines: string[] = [];
    renderPromptCacheSection(
      [
        {
          agentId: "chief-of-staff",
          turns: 12,
          cacheReadTokens: 8000,
          cacheCreationTokens: 1000,
          inputTokens: 1000,
          ephemeral5mTokens: 800,
          ephemeral1hTokens: 200,
          hitRate: 0.8,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toMatch(
      /chief-of-staff: hit=80\.0% read=8000 create=1000 \(5m=800, 1h=200\) input=1000 turns=12/,
    );
  });

  it("omits the ephemeral breakdown when both counters are zero", () => {
    const lines: string[] = [];
    renderPromptCacheSection(
      [
        {
          agentId: "rae",
          turns: 1,
          cacheReadTokens: 50,
          cacheCreationTokens: 50,
          inputTokens: 100,
          ephemeral5mTokens: 0,
          ephemeral1hTokens: 0,
          hitRate: 0.25,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).not.toContain("(5m=");
    expect(lines.join("\n")).toContain("hit=25.0%");
  });

  it("renders 'no data' for a row with null hitRate", () => {
    const lines: string[] = [];
    renderPromptCacheSection(
      [
        {
          agentId: "ghost",
          turns: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          inputTokens: 0,
          ephemeral5mTokens: 0,
          ephemeral1hTokens: 0,
          hitRate: null,
        },
      ],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("hit=no data");
  });
});
