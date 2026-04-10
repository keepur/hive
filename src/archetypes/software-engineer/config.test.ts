import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { validateConfig } from "./config.js";

// Use a temp directory tree for filesystem existence checks
const TMP = "/tmp/se-config-test";
const WORKSHOP = `${TMP}/dev`;
const WS1 = `${TMP}/dev/dodi_v2`;
const WS2 = `${TMP}/dev/hive`;
const OUTSIDE = `${TMP}/other`;

beforeEach(() => {
  mkdirSync(WS1, { recursive: true });
  mkdirSync(WS2, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function validConfig() {
  return {
    workshop: WORKSHOP,
    workspaces: [{ name: "dodi_v2", path: WS1, tracker: { type: "linear", project: "DOD" } }],
  };
}

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    const cfg = validateConfig(validConfig());
    expect(cfg.workshop).toBe(WORKSHOP);
    expect(cfg.workspaces).toHaveLength(1);
    expect(cfg.workspaces[0].name).toBe("dodi_v2");
    expect(cfg.workspaces[0].tracker).toEqual({ type: "linear", project: "DOD" });
  });

  it("accepts empty workspaces array", () => {
    const cfg = validateConfig({ workshop: WORKSHOP, workspaces: [] });
    expect(cfg.workspaces).toEqual([]);
  });

  it("accepts config without workspaces key (defaults to empty)", () => {
    const cfg = validateConfig({ workshop: WORKSHOP });
    expect(cfg.workspaces).toEqual([]);
  });

  it("preserves primary flag", () => {
    const raw = validConfig();
    raw.workspaces[0].primary = true;
    const cfg = validateConfig(raw);
    expect(cfg.workspaces[0].primary).toBe(true);
  });

  // ── Rejection rules ──────────────────────────────────────────────────

  it("rejects non-object config", () => {
    expect(() => validateConfig(null)).toThrow("must be an object");
    expect(() => validateConfig("string")).toThrow("must be an object");
  });

  it("rejects missing workshop", () => {
    expect(() => validateConfig({ workspaces: [] })).toThrow("absolute path");
  });

  it("rejects relative workshop", () => {
    expect(() => validateConfig({ workshop: "relative/path" })).toThrow("absolute path");
  });

  it("rejects non-existent workshop", () => {
    expect(() => validateConfig({ workshop: "/nonexistent/path" })).toThrow("does not exist");
  });

  it("rejects workshop that is not a directory", () => {
    const file = `${TMP}/dev/file.txt`;
    writeFileSync(file, "x");
    expect(() => validateConfig({ workshop: file })).toThrow("not a directory");
  });

  it("rejects workspace outside workshop", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "outside", path: OUTSIDE, tracker: { type: "github", repo: "x/y" } }],
      }),
    ).toThrow("must be inside workshop");
  });

  it("rejects workspace with relative path", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "bad", path: "relative", tracker: { type: "github", repo: "x/y" } }],
      }),
    ).toThrow("absolute path");
  });

  it("rejects workspace with non-existent path", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "gone", path: `${WORKSHOP}/gone`, tracker: { type: "github", repo: "x/y" } }],
      }),
    ).toThrow("does not exist");
  });

  it("rejects workspace without tracker", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "dodi_v2", path: WS1 }],
      }),
    ).toThrow("tracker is required");
  });

  it("rejects tracker with invalid type", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "dodi_v2", path: WS1, tracker: { type: "jira" } }],
      }),
    ).toThrow("tracker.type must be one of");
  });

  it("rejects linear tracker without project", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "dodi_v2", path: WS1, tracker: { type: "linear" } }],
      }),
    ).toThrow("linear tracker requires project");
  });

  it("rejects github tracker without repo", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "dodi_v2", path: WS1, tracker: { type: "github" } }],
      }),
    ).toThrow("github tracker requires repo");
  });

  it("rejects clickup tracker without list", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "dodi_v2", path: WS1, tracker: { type: "clickup" } }],
      }),
    ).toThrow("clickup tracker requires list");
  });

  it("rejects duplicate workspace names", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [
          { name: "dodi_v2", path: WS1, tracker: { type: "linear", project: "DOD" } },
          { name: "dodi_v2", path: WS2, tracker: { type: "github", repo: "x/y" } },
        ],
      }),
    ).toThrow('duplicate workspace name "dodi_v2"');
  });

  it("rejects workspace with empty name", () => {
    expect(() =>
      validateConfig({
        workshop: WORKSHOP,
        workspaces: [{ name: "", path: WS1, tracker: { type: "linear", project: "DOD" } }],
      }),
    ).toThrow("name is required");
  });

  // ── Tracker type coverage ────────────────────────────────────────────

  it("accepts github tracker", () => {
    const cfg = validateConfig({
      workshop: WORKSHOP,
      workspaces: [{ name: "hive", path: WS2, tracker: { type: "github", repo: "dodi-hq/hive" } }],
    });
    expect(cfg.workspaces[0].tracker).toEqual({ type: "github", repo: "dodi-hq/hive" });
  });

  it("accepts clickup tracker", () => {
    const cfg = validateConfig({
      workshop: WORKSHOP,
      workspaces: [{ name: "hive", path: WS2, tracker: { type: "clickup", list: "12345" } }],
    });
    expect(cfg.workspaces[0].tracker).toEqual({ type: "clickup", list: "12345" });
  });
});
