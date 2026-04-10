import { describe, it, expect } from "vitest";
import { claudeProjectSlug } from "./slug.js";

describe("claudeProjectSlug", () => {
  it("transforms a simple path", () => {
    expect(claudeProjectSlug("/Users/mokie/github/hive")).toBe("-Users-mokie-github-hive");
  });

  it("converts underscores in path segments to hyphens", () => {
    // Empirical: /Users/mokie/dev/dodi_v2 → -Users-mokie-dev-dodi-v2
    expect(claudeProjectSlug("/Users/mokie/dev/dodi_v2")).toBe("-Users-mokie-dev-dodi-v2");
  });

  it("converts dots to hyphens", () => {
    expect(claudeProjectSlug("/Users/mokie/code/foo.bar")).toBe("-Users-mokie-code-foo-bar");
  });

  it("strips trailing slashes", () => {
    expect(claudeProjectSlug("/Users/mokie/dev/")).toBe("-Users-mokie-dev");
    expect(claudeProjectSlug("/Users/mokie/dev///")).toBe("-Users-mokie-dev");
  });

  it("collapses consecutive separators", () => {
    expect(claudeProjectSlug("/Users//mokie/dev")).toBe("-Users-mokie-dev");
    expect(claudeProjectSlug("/Users/mokie/foo__bar")).toBe("-Users-mokie-foo-bar");
  });

  it("preserves digits and existing hyphens", () => {
    expect(claudeProjectSlug("/Users/mokie/github/hive-115")).toBe("-Users-mokie-github-hive-115");
  });

  it("rejects relative paths", () => {
    expect(() => claudeProjectSlug("./rel")).toThrow();
    expect(() => claudeProjectSlug("rel")).toThrow();
    expect(() => claudeProjectSlug("")).toThrow();
  });

  it("matches the Hive worktree slug observed on disk", () => {
    // Load-bearing: this conversation runs out of /Users/mokie/github/hive-115
    // and ~/.claude/projects/-Users-mokie-github-hive-115/ exists today.
    expect(claudeProjectSlug("/Users/mokie/github/hive-115")).toBe("-Users-mokie-github-hive-115");
  });
});
