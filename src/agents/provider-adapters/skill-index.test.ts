import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { deriveProviderSkillIndex } from "./skill-index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kpr349-skills-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Create <pluginDir>/skills/<skill>/SKILL.md with the given raw content. */
function writeSkill(pluginDir: string, skill: string, content: string): string {
  const dir = join(pluginDir, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "SKILL.md");
  writeFileSync(p, content, "utf-8");
  return p;
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nagents: [all]\n---\nBody for ${name}.\n`;
}

function plugin(path: string): SdkPluginConfig {
  return { type: "local", path };
}

describe("deriveProviderSkillIndex (KPR-349 §D6)", () => {
  it("dir name wins over drifted frontmatter name; description + realpath captured", () => {
    const pdir = join(root, "plugin-a");
    const p = writeSkill(pdir, "greet", frontmatter("greet-skill-drifted", "Say hello"));
    const out = deriveProviderSkillIndex([plugin(pdir)]);
    expect(out).toEqual([{ name: "greet", description: "Say hello", path: realpathSync(p) }]);
  });

  it("emits an entry per skill dir in a multi-skill plugin", () => {
    const pdir = join(root, "plugin-multi");
    writeSkill(pdir, "alpha", frontmatter("alpha", "Do alpha"));
    writeSkill(pdir, "beta", frontmatter("beta", "Do beta"));
    const out = deriveProviderSkillIndex([plugin(pdir)]);
    expect(out.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("empty description falls back to the skill name", () => {
    const pdir = join(root, "plugin-empty-desc");
    // description: (empty) — parses to "" and must fall back to the dir name.
    writeSkill(pdir, "gamma", `---\nname: gamma\ndescription:\nagents: [all]\n---\nBody.\n`);
    const out = deriveProviderSkillIndex([plugin(pdir)]);
    expect(out).toEqual([expect.objectContaining({ name: "gamma", description: "gamma" })]);
  });

  it("corrupt SKILL.md (no frontmatter delimiters) is skipped without throwing; siblings intact", () => {
    const pdir = join(root, "plugin-corrupt");
    writeSkill(pdir, "good", frontmatter("good", "Good skill"));
    writeSkill(pdir, "bad", "no frontmatter here at all\njust prose\n");
    let out: ReturnType<typeof deriveProviderSkillIndex> = [];
    expect(() => {
      out = deriveProviderSkillIndex([plugin(pdir)]);
    }).not.toThrow();
    expect(out.map((e) => e.name)).toEqual(["good"]);
  });

  it("plugin path with no skills/ dir is skipped silently (no throw)", () => {
    const pdir = join(root, "plugin-no-skills");
    mkdirSync(pdir, { recursive: true });
    expect(deriveProviderSkillIndex([plugin(pdir)])).toEqual([]);
  });

  it("duplicate skill name across two plugins → first wins, one entry total", () => {
    const p1 = join(root, "plugin-1");
    const p2 = join(root, "plugin-2");
    writeSkill(p1, "dup", frontmatter("dup", "First description"));
    writeSkill(p2, "dup", frontmatter("dup", "Second description"));
    const out = deriveProviderSkillIndex([plugin(p1), plugin(p2)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "dup", description: "First description" });
  });

  it("symlinked skill dir → path is the realpath (symlink segment resolved away)", () => {
    // Real skill lives under a differently-named directory; the plugin's
    // skills/ dir reaches it via a symlink (projection layout).
    const realHome = join(root, "real-skills", "actual-target");
    mkdirSync(realHome, { recursive: true });
    writeFileSync(join(realHome, "SKILL.md"), frontmatter("linked", "Linked skill"), "utf-8");

    const pdir = join(root, "plugin-symlink");
    mkdirSync(join(pdir, "skills"), { recursive: true });
    symlinkSync(realHome, join(pdir, "skills", "linked"), "dir");

    const out = deriveProviderSkillIndex([plugin(pdir)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("linked");
    // realpath resolves through the symlink to the actual-target directory.
    expect(out[0]!.path).not.toContain(`${join("skills", "linked")}`);
    expect(out[0]!.path).toContain("actual-target");
  });

  it("empty plugin list → []", () => {
    expect(deriveProviderSkillIndex([])).toEqual([]);
  });
});
