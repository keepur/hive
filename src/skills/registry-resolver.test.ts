import { describe, it, expect } from "vitest";
import { parseSkillSpec, resolveRegistry } from "./registry-resolver.js";
import type { RegistryConfig } from "../config.js";

describe("parseSkillSpec", () => {
  it("parses a plain name", () => {
    expect(parseSkillSpec("morning-briefing")).toEqual({ name: "morning-briefing" });
  });

  it("parses a registry prefix", () => {
    expect(parseSkillSpec("keepur-default:quality-gate")).toEqual({
      name: "quality-gate",
      registryName: "keepur-default",
    });
  });

  it("parses an inline URL with fragment", () => {
    expect(parseSkillSpec("https://github.com/foo/bar#skills/quality-gate")).toEqual({
      name: "quality-gate",
      inlineUrl: "https://github.com/foo/bar",
    });
  });

  it("parses a file URL with fragment", () => {
    expect(parseSkillSpec("file:///path/to/repo#skills/quality-gate")).toEqual({
      name: "quality-gate",
      inlineUrl: "file:///path/to/repo",
    });
  });

  it("parses a GitHub web URL (convenience form)", () => {
    expect(parseSkillSpec("https://github.com/owner/repo/tree/main/skills/test-skill")).toEqual({
      name: "test-skill",
      inlineUrl: "https://github.com/owner/repo",
    });
  });
});

describe("resolveRegistry", () => {
  const registries: RegistryConfig[] = [
    { name: "keepur-default", url: "https://github.com/keepur/hive-skills", default: true },
    { name: "my-registry", url: "https://github.com/myorg/skills" },
  ];

  it("returns inline URL directly without consulting configured registries", () => {
    const result = resolveRegistry({ name: "my-skill", inlineUrl: "https://github.com/foo/bar" }, registries);
    expect(result.url).toBe("https://github.com/foo/bar");
    expect(result.name).toBe("foo-bar");
  });

  it("resolves a named registry from config", () => {
    const result = resolveRegistry({ name: "quality-gate", registryName: "my-registry" }, registries);
    expect(result).toEqual({ name: "my-registry", url: "https://github.com/myorg/skills" });
  });

  it("throws for an unknown registry name", () => {
    expect(() => resolveRegistry({ name: "quality-gate", registryName: "no-such-registry" }, registries)).toThrow(
      /Unknown registry: "no-such-registry"/,
    );
  });

  it("uses the default registry when no prefix is given", () => {
    const result = resolveRegistry({ name: "morning-briefing" }, registries);
    expect(result).toEqual({
      name: "keepur-default",
      url: "https://github.com/keepur/hive-skills",
    });
  });

  it("falls back to first registry when no default is marked", () => {
    const noDefault: RegistryConfig[] = [
      { name: "first", url: "https://github.com/a/b" },
      { name: "second", url: "https://github.com/c/d" },
    ];
    const result = resolveRegistry({ name: "some-skill" }, noDefault);
    expect(result).toEqual({ name: "first", url: "https://github.com/a/b" });
  });

  it("throws when no registries are configured", () => {
    expect(() => resolveRegistry({ name: "some-skill" }, [])).toThrow(/No skill registries configured/);
  });
});
