import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("yaml", () => ({
  parse: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockParseYaml = vi.mocked(parseYaml);

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.BEEKEEPER_AUTH_TOKEN = "test-token-abc";
    process.env.BEEKEEPER_CONFIG = "/tmp/beekeeper.yaml";
    process.env.HOME = "/Users/testuser";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads a valid YAML config and returns correct BeekeeperConfig structure", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      port: 4000,
      default_workspace: "my-workspace",
      model: "claude-sonnet-4-5",
      workspaces: { home: "/home/user/projects" },
      confirm_operations: ["rm -rf", "git push --force"],
    });

    const config = loadConfig();

    expect(config).toEqual({
      port: 4000,
      defaultWorkspace: "my-workspace",
      model: "claude-sonnet-4-5",
      workspaces: { home: "/home/user/projects" },
      confirmOperations: ["rm -rf", "git push --force"],
      authToken: "test-token-abc",
    });
  });

  it("throws if config file not found", () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => loadConfig()).toThrow("Beekeeper config not found");
  });

  it("throws if BEEKEEPER_AUTH_TOKEN env var is missing", () => {
    delete process.env.BEEKEEPER_AUTH_TOKEN;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({ port: 3099 });

    expect(() => loadConfig()).toThrow("Missing required env var: BEEKEEPER_AUTH_TOKEN");
  });

  it("expands ~ in workspace paths", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      workspaces: {
        hive: "~/github/hive",
        work: "~/work/projects",
      },
    });

    const config = loadConfig();

    expect(config.workspaces.hive).toBe("/Users/testuser/github/hive");
    expect(config.workspaces.work).toBe("/Users/testuser/work/projects");
  });

  it("falls back to default port (3099) when port is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.port).toBe(3099);
  });

  it("falls back to default model when model is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.model).toBe("claude-opus-4-5-20250514");
  });

  it("falls back to default confirm_operations when field is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.confirmOperations).toContain("git push --force");
    expect(config.confirmOperations).toContain("rm -rf");
    expect(config.confirmOperations.length).toBeGreaterThan(0);
  });

  it("falls back to empty workspaces when workspaces field is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.workspaces).toEqual({});
  });

  it("falls back to default_workspace 'hive' when field is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.defaultWorkspace).toBe("hive");
  });

  it("uses BEEKEEPER_CONFIG env var to locate config file", () => {
    process.env.BEEKEEPER_CONFIG = "/custom/path/beekeeper.yaml";
    mockExistsSync.mockReturnValue(false);

    expect(() => loadConfig()).toThrow("/custom/path/beekeeper.yaml");
  });
});
