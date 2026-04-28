import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOperatorSkills } from "./sync.js";

vi.mock("./registry-fetch.js", () => ({
  shallowClone: vi.fn(),
  listSkillsInClone: vi.fn(),
}));
vi.mock("./install.js", () => ({ installSkill: vi.fn() }));
vi.mock("./upgrade.js", () => ({ upgradeSkill: vi.fn() }));
vi.mock("./remove.js", () => ({ removeSkill: vi.fn() }));

import { shallowClone, listSkillsInClone } from "./registry-fetch.js";
import { installSkill } from "./install.js";
import { upgradeSkill } from "./upgrade.js";
import { removeSkill } from "./remove.js";

const REPO = "https://github.com/op/skills";
const HEAD_SHA = "deadbeef";

describe("syncOperatorSkills", () => {
  let hiveHome: string;
  let cleanup: ReturnType<typeof vi.fn>;

  function writeCustomerSkill(workflow: string, name: string, origin?: object) {
    const dir = join(hiveHome, "skills", workflow, "skills", name);
    mkdirSync(dir, { recursive: true });
    const fm = origin
      ? `name: ${name}\ndescription: test\norigin:\n${Object.entries(origin)
          .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n")}`
      : `name: ${name}\ndescription: test`;
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\nbody\n`);
  }

  beforeEach(() => {
    hiveHome = mkdtempSync(join(tmpdir(), "sync-test-"));
    cleanup = vi.fn();
    vi.mocked(shallowClone).mockReturnValue({
      dir: "/tmp/clone",
      headSha: HEAD_SHA,
      cleanup,
    } as never);
    vi.mocked(listSkillsInClone).mockReturnValue([]);
    vi.mocked(installSkill).mockReturnValue({
      name: "stub",
      workflow: "default",
      version: HEAD_SHA,
      path: "/stub",
    } as never);
    vi.mocked(upgradeSkill).mockResolvedValue({
      name: "stub",
      action: "applied",
    } as never);
    vi.mocked(removeSkill).mockResolvedValue(true);
  });

  afterEach(() => {
    rmSync(hiveHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("installs skills missing from customer space", async () => {
    vi.mocked(listSkillsInClone).mockReturnValue(["alpha", "beta"]);

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.installed.sort()).toEqual(["alpha", "beta"]);
    expect(installSkill).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalled();
  });

  it("skips skills already at operator HEAD", async () => {
    writeCustomerSkill("default", "alpha", {
      type: "registry",
      source: REPO,
      "base-version": HEAD_SHA,
      modified: false,
    });
    vi.mocked(listSkillsInClone).mockReturnValue(["alpha"]);

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.upToDate).toEqual(["alpha"]);
    expect(installSkill).not.toHaveBeenCalled();
    expect(upgradeSkill).not.toHaveBeenCalled();
  });

  it("upgrades skills with stale base-version", async () => {
    writeCustomerSkill("default", "alpha", {
      type: "registry",
      source: REPO,
      "base-version": "oldsha",
      modified: false,
    });
    vi.mocked(listSkillsInClone).mockReturnValue(["alpha"]);

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.upgraded).toEqual(["alpha"]);
    expect(upgradeSkill).toHaveBeenCalledOnce();
    expect(upgradeSkill).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining("skills"),
      hiveHome,
      expect.any(Function),
    );
  });

  it("never overwrites customer-modified skills", async () => {
    writeCustomerSkill("default", "alpha", {
      type: "registry",
      source: REPO,
      "base-version": "oldsha",
      modified: true,
    });
    vi.mocked(listSkillsInClone).mockReturnValue(["alpha"]);

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.modifiedSkipped).toEqual(["alpha"]);
    expect(upgradeSkill).not.toHaveBeenCalled();
  });

  it("reports orphans without removing them by default", async () => {
    writeCustomerSkill("default", "ghost", {
      type: "registry",
      source: REPO,
      "base-version": "x",
      modified: false,
    });
    vi.mocked(listSkillsInClone).mockReturnValue([]);

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.orphaned).toEqual(["ghost"]);
    expect(result.pruned).toEqual([]);
    expect(removeSkill).not.toHaveBeenCalled();
  });

  it("removes orphans when prune: true", async () => {
    writeCustomerSkill("default", "ghost", {
      type: "registry",
      source: REPO,
      "base-version": "x",
      modified: false,
    });
    vi.mocked(listSkillsInClone).mockReturnValue([]);

    const result = await syncOperatorSkills(REPO, hiveHome, { prune: true });
    expect(result.orphaned).toEqual(["ghost"]);
    expect(result.pruned).toEqual(["ghost"]);
    expect(removeSkill).toHaveBeenCalledOnce();
    expect(removeSkill).toHaveBeenCalledWith(
      "ghost",
      expect.stringContaining("skills"),
      hiveHome,
      { force: true },
    );
  });

  it("dry-run reports actions without performing them", async () => {
    vi.mocked(listSkillsInClone).mockReturnValue(["alpha"]);

    const result = await syncOperatorSkills(REPO, hiveHome, { dryRun: true });
    expect(result.installed).toEqual(["alpha"]);
    expect(installSkill).not.toHaveBeenCalled();
  });

  it("ignores customer skills sourced from a different repo", async () => {
    writeCustomerSkill("default", "elsewhere", {
      type: "registry",
      source: "https://github.com/other/skills",
      "base-version": "x",
      modified: false,
    });
    vi.mocked(listSkillsInClone).mockReturnValue([]);

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.orphaned).toEqual([]);
  });

  it("continues sync when a single skill fails", async () => {
    vi.mocked(listSkillsInClone).mockReturnValue(["alpha", "beta"]);
    vi.mocked(installSkill).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const result = await syncOperatorSkills(REPO, hiveHome);
    expect(result.errors).toHaveLength(1);
    expect(result.installed).toEqual(["beta"]);
  });
});
