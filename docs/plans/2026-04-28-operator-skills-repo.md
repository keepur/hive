# KPR-82: Operator Skills Repo Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Single git repo serves as the canonical source of customer-space skills, kept in sync across all of one operator's hive instances via a new `hive skill sync` command (and an automatic post-upgrade hook).

**Architecture:** The operator repo is shape-compatible with an existing skill registry (flat `skills/<skill-name>/SKILL.md`). What's new is **declarative sync semantics**: every skill in the operator repo should be installed in customer space, and every customer-space skill whose `origin.source` points at the operator repo should still exist there. Sync = install-missing + upgrade-stale + report-orphans. Built on existing primitives (`installSkill`, `upgradeSkill`, `shallowClone`, `listSkillsInClone`, `commitToState`); only the orchestration is new.

**Why this is small:** the codebase audit (2026-04-28) confirmed install, upgrade, registry config, multi-registry CLI, git primitives, audit branch, and customer-space preservation all already exist. KPR-82 wires them into a sync orchestrator and a config field.

**Tech Stack:** TypeScript, Node, MongoDB (existing). No new deps.

**Out of scope** (separate tickets):
- Registry (A) infrastructure for Keepur-published skills
- Meta-skills (`skill-import`, `skill-evaluate`, `skill-attribute`) — third-party-repo flow
- Push-back / publish flow (agent-authored skill on instance A → operator repo)
- Per-agent skills (KPR-75)
- Bundle SKU work (paid-tier delivery)

**Freemium alignment:** the operator repo is the single substrate for both tiers. Free customers maintain it themselves; paid customers will receive curated bundles into the same place via Registry (A) later. This plan only touches the substrate.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/config.ts` | Add `operatorSkillsRepo` field | **modify** |
| `src/skills/sync.ts` | `syncOperatorSkills()` orchestrator | **create** |
| `src/skills/sync.test.ts` | Unit tests for sync | **create** |
| `src/skills/customer-space-scan.ts` | Walk `<hiveHome>/skills/` and read origin metadata | **create** |
| `src/cli/skill.ts` | `hive skill sync` subcommand | **modify** |
| `src/cli/update.ts` | Auto-sync hook after `hive update` succeeds | **modify** |
| `setup/templates/hive-yaml.tpl` | Document `operatorSkillsRepo` field | **modify** (if exists) |
| `CLAUDE.md` | Operator-repo workflow note in skills section | **modify** |
| `docs/specs/2026-04-28-operator-skills-repo-design.md` | Design context (short) | **create** |

---

## Pre-flight checks

- [ ] **Print actual signatures before writing any code:**

```bash
cd /Users/mokie/github/hive-KPR-82 && \
  grep -n "^export" src/skills/{install,upgrade,remove,registry-fetch,frontmatter}.ts && \
  grep -n "skillsDir\|hiveHome" src/paths.ts | head -10
```

The plan code blocks below are written against these signatures (verified 2026-04-28):

```typescript
// install.ts
export function installSkill(
  registryUrl: string, skillName: string, targetSkillsDir: string, targetHiveHome: string,
): InstallResult              // SYNC

// upgrade.ts
export async function upgradeSkill(
  skillName: string, skillsDir: string, hiveHome: string,
  promptFn: (yours: string, theirs: string, base?: string) => Promise<"keep" | "take">,
): Promise<UpgradeResult>     // ASYNC, no URL arg, promptFn required

// remove.ts
export async function removeSkill(
  skillName: string, skillsDir: string, hiveHome: string, opts?: RemoveOptions,
): Promise<boolean>            // ASYNC, no URL arg

// registry-fetch.ts
export function shallowClone(url: string): CloneResult
export function listSkillsInClone(cloneDir: string): string[]   // returns names, not objects

// frontmatter.ts
export function readSkillMd(path: string): { frontmatter: SkillFrontmatter; body: string }
// SkillFrontmatter has .origin?: SkillOrigin

// paths.ts
export const skillsDir = resolve(hiveHome, "skills")   // CONSTANT, bound to runtime hiveHome
```

If any of these have changed, stop and reconcile before proceeding.

- [ ] **Read these for context:**
  - `src/skills/install.ts` (lines 19–105) — full install flow
  - `src/skills/upgrade.ts` (lines 23–105) — `findInstalledSkill` + upgrade
  - `src/skills/instance-git.ts` — `commitToState` (called inside install/upgrade/remove)
  - `src/cli/skill.ts` — dispatch pattern, `await import("../config.js")` lazy-load
  - `src/cli/update.ts` — where `deploy.sh` is invoked
  - `docs/specs/2026-04-15-skills-customer-space-design.md` — ownership model

- [ ] **Verify worktree is on KPR-82 branch:** `git branch --show-current` → `KPR-82`

- [ ] **Verify config symlinks exist** so tests can find config:
  - `ls -la .env hive.yaml` → both should be symlinks to `~/github/hive/`

---

### Task 1: Config field — `operatorSkillsRepo`

**Files:**
- Modify: `src/config.ts` — add field to the loaded config object
- Modify: `setup/templates/hive-yaml.tpl` if it exists; otherwise note location of doc-comment in actual `hive.yaml`

- [ ] **Step 1:** Add type and loading logic to `src/config.ts`.

Locate the existing `skillRegistries` block (around the line that reads `A.skillRegistries??[{name:"keepur-default",...}]`). Add immediately after:

```typescript
  operatorSkillsRepo: A.operatorSkillsRepo
    ? {
        url: String(A.operatorSkillsRepo.url),
        branch: A.operatorSkillsRepo.branch ? String(A.operatorSkillsRepo.branch) : "main",
      }
    : null,
```

The field is opt-in. `null` means "not configured — sync is a no-op."

- [ ] **Step 2:** If `setup/templates/hive-yaml.tpl` exists, add a commented example block:

```yaml
# Operator skills repo — canonical source for customer-space skills.
# All instances belonging to one operator pull from this repo.
# Skills authored locally still live in <hiveHome>/skills/; commit them
# to this repo to propagate to your other instances.
#
# operatorSkillsRepo:
#   url: https://github.com/<operator>/<repo>
#   branch: main   # optional, default: main
```

If the template doesn't exist, add the same doc-comment to a new section in `CLAUDE.md` (covered in Task 6).

- [ ] **Step 3:** Verify

```bash
cd /Users/mokie/github/hive-KPR-82 && npm run build && \
  node -e "import('./dist/config.js').then(m => console.log('operatorSkillsRepo:', m.config.operatorSkillsRepo))"
```

Expected: `operatorSkillsRepo: null` (because not yet configured in hive.yaml). If the symlinked hive.yaml from `~/github/hive/` has been edited to add `operatorSkillsRepo:`, the value will be the parsed object instead — that's fine.

- [ ] **Step 4:** Commit

```bash
git add src/config.ts setup/templates/hive-yaml.tpl
git commit -m "config(KPR-82): add operatorSkillsRepo field"
```

---

### Task 2: Customer-space scanner

**Files:**
- Create: `src/skills/customer-space-scan.ts`
- Create: `src/skills/customer-space-scan.test.ts`

**Why a separate module:** the sync orchestrator needs to enumerate "what's installed and from where" without reaching into the agent runtime loader. The agent runtime's `skill-loader.ts` is concerned with eligibility and content; sync only needs path + frontmatter origin. Keep them decoupled.

- [ ] **Step 1:** Create `src/skills/customer-space-scan.ts`.

```typescript
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillOrigin } from "./frontmatter.js";
import { readSkillMd } from "./frontmatter.js";

export interface InstalledSkill {
  /** Skill directory name (e.g., "morning-briefing") */
  name: string;
  /** Workflow projection (e.g., "morning-briefing" or "default") */
  workflow: string;
  /** Absolute path to the SKILL.md file */
  skillMdPath: string;
  /** Origin metadata from frontmatter, if present */
  origin?: SkillOrigin;
}

/**
 * Walk <hiveHome>/skills/<workflow>/skills/<name>/SKILL.md and return
 * one entry per installed skill with parsed origin frontmatter.
 *
 * Skills without a SKILL.md or with unparseable frontmatter are skipped
 * (logged at debug level by the caller).
 */
export function scanCustomerSpaceSkills(skillsRoot: string): InstalledSkill[] {
  if (!existsSync(skillsRoot)) return [];
  const results: InstalledSkill[] = [];

  for (const workflow of readdirSync(skillsRoot)) {
    const workflowDir = join(skillsRoot, workflow);
    if (!statSync(workflowDir).isDirectory()) continue;

    const skillsSubdir = join(workflowDir, "skills");
    if (!existsSync(skillsSubdir)) continue;

    for (const name of readdirSync(skillsSubdir)) {
      const skillDir = join(skillsSubdir, name);
      if (!statSync(skillDir).isDirectory()) continue;

      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      let origin: SkillOrigin | undefined;
      try {
        const { frontmatter } = readSkillMd(skillMdPath);
        origin = frontmatter.origin;
      } catch {
        // Unparseable frontmatter — skip origin but still report the skill exists
      }

      results.push({ name, workflow, skillMdPath, origin });
    }
  }

  return results;
}

/**
 * Filter installed skills by origin source URL.
 * Used by sync to find skills that came from a specific operator repo.
 */
export function skillsFromSource(
  installed: InstalledSkill[],
  sourceUrl: string,
): InstalledSkill[] {
  return installed.filter((s) => s.origin?.source === sourceUrl);
}
```

- [ ] **Step 2:** Create `src/skills/customer-space-scan.test.ts` (vitest, in-tmpdir fixture).

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCustomerSpaceSkills, skillsFromSource } from "./customer-space-scan.js";

describe("scanCustomerSpaceSkills", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(workflow: string, name: string, frontmatter: string) {
    const dir = join(root, workflow, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
  }

  it("returns empty array for missing root", () => {
    expect(scanCustomerSpaceSkills(join(root, "nonexistent"))).toEqual([]);
  });

  it("finds skills under workflow/skills/<name>/SKILL.md", () => {
    writeSkill("morning-briefing", "wakeup", "name: wakeup\ndescription: test");
    writeSkill("default", "helper", "name: helper\ndescription: test");

    const found = scanCustomerSpaceSkills(root);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.name).sort()).toEqual(["helper", "wakeup"]);
  });

  it("parses origin frontmatter", () => {
    writeSkill(
      "default",
      "from-op",
      `name: from-op
description: test
origin:
  type: registry
  source: https://github.com/operator/skills
  base-version: abc123
  base-content-hash: deadbeef
  installed-at: 2026-04-28T00:00:00Z
  modified: false`,
    );

    const found = scanCustomerSpaceSkills(root);
    expect(found[0].origin?.source).toBe("https://github.com/operator/skills");
    expect(found[0].origin?.modified).toBe(false);
  });

  it("skips directories without SKILL.md", () => {
    mkdirSync(join(root, "default", "skills", "incomplete"), { recursive: true });
    expect(scanCustomerSpaceSkills(root)).toEqual([]);
  });

  it("skillsFromSource filters by origin URL", () => {
    writeSkill(
      "default",
      "a",
      "name: a\ndescription: test\norigin:\n  source: https://op.git",
    );
    writeSkill(
      "default",
      "b",
      "name: b\ndescription: test\norigin:\n  source: https://other.git",
    );

    const all = scanCustomerSpaceSkills(root);
    const filtered = skillsFromSource(all, "https://op.git");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("a");
  });
});
```

- [ ] **Step 3:** Verify

```bash
cd /Users/mokie/github/hive-KPR-82 && npx vitest run src/skills/customer-space-scan.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 4:** Commit

```bash
git add src/skills/customer-space-scan.ts src/skills/customer-space-scan.test.ts
git commit -m "feat(skills,KPR-82): scan customer-space skills with origin metadata"
```

---

### Task 3: Sync orchestrator

**Files:**
- Create: `src/skills/sync.ts`
- Create: `src/skills/sync.test.ts`

**Algorithm:**

1. Shallow-clone operator repo, capture HEAD sha
2. List skills in clone (`listSkillsInClone`)
3. Scan customer space (`scanCustomerSpaceSkills`)
4. For each skill in operator repo:
   - **Not in customer space** → `installSkill()` (count: `installed`)
   - **In customer space, `origin.modified === true`** → skip, report (count: `modifiedSkipped`) — never overwrite customer edits
   - **In customer space, `origin.base-version === clone.headSha`** → skip (count: `upToDate`)
   - **In customer space, base-version differs** → `upgradeSkill()` (count: `upgraded`)
5. For each customer skill with `origin.source === operatorRepoUrl` not present in remote:
   - Always report (count: `orphaned`)
   - Remove only if `opts.prune === true` (count: `pruned`)
6. Cleanup temp clone
7. Return summary

**Signature notes (from pre-flight):**
- `installSkill(registryUrl, skillName, skillsDir, hiveHome)` — sync, returns `InstallResult`
- `upgradeSkill(skillName, skillsDir, hiveHome, promptFn)` — async, returns `Promise<UpgradeResult>`. **No URL arg** — it reads `origin.source` from the installed skill's frontmatter. **`promptFn` required**, fires only when there's a 3-way merge conflict on a customer-modified skill. Sync pre-filters `origin.modified === true`, so it should never fire; pass a thrower as defensive coding.
- `removeSkill(skillName, skillsDir, hiveHome, opts)` — async, returns `Promise<boolean>`. Pass `{ force: true }` to skip the interactive confirmation (sync's prune pre-filtered orphans, no need to re-confirm).
- `listSkillsInClone(cloneDir)` — returns `string[]` of skill names (not objects).
- `skillsDir` from `paths.ts` is a constant bound to runtime hiveHome. Sync compute its own `customerSkillsDir = join(targetHiveHome, "skills")` so tests can use a tmpdir.

- [ ] **Step 1:** Create `src/skills/sync.ts`.

```typescript
import { join } from "node:path";
import { shallowClone, listSkillsInClone } from "./registry-fetch.js";
import { installSkill } from "./install.js";
import { upgradeSkill } from "./upgrade.js";
import { removeSkill } from "./remove.js";
import { scanCustomerSpaceSkills, skillsFromSource } from "./customer-space-scan.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-sync");

/**
 * Defensive promptFn for upgradeSkill. Sync pre-filters customer-modified
 * skills, so this should never be called. If it is, the assumption is broken
 * and the caller should know.
 */
const refuseConflict = async (): Promise<"keep" | "take"> => {
  throw new Error(
    "Sync hit a 3-way merge conflict — this should not happen because customer-modified skills are pre-filtered. File a bug.",
  );
};

export interface SyncResult {
  /** Operator repo HEAD sha at time of sync */
  headSha: string;
  /** Skills newly installed from operator repo */
  installed: string[];
  /** Skills upgraded to a newer operator-repo version */
  upgraded: string[];
  /** Skills already at operator-repo HEAD — no action */
  upToDate: string[];
  /** Customer-modified skills skipped (origin.modified === true) */
  modifiedSkipped: string[];
  /** Skills present locally but no longer in operator repo */
  orphaned: string[];
  /** Orphaned skills actually removed (only when opts.prune) */
  pruned: string[];
  /** Per-skill failures, sync continues past each */
  errors: { skill: string; error: string }[];
}

export interface SyncOptions {
  /** Remove orphaned skills (origin.source matches but no longer in repo). Default: false. */
  prune?: boolean;
  /** Report changes without applying them. Default: false. */
  dryRun?: boolean;
}

/**
 * Sync customer-space skills against an operator repo.
 *
 * Idempotent. Safe to re-run. Customer-modified skills are never overwritten
 * (the upgrade flow's keep/take logic is bypassed for sync — we always keep
 * local modifications and report them).
 */
export async function syncOperatorSkills(
  operatorRepoUrl: string,
  targetHiveHome: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    headSha: "",
    installed: [],
    upgraded: [],
    upToDate: [],
    modifiedSkipped: [],
    orphaned: [],
    pruned: [],
    errors: [],
  };

  log.info("Sync starting", { repo: operatorRepoUrl, dryRun: !!opts.dryRun });

  const customerSkillsDir = join(targetHiveHome, "skills");
  const clone = shallowClone(operatorRepoUrl);
  result.headSha = clone.headSha;

  try {
    const remoteSkillNames = listSkillsInClone(clone.dir);
    const allCustomer = scanCustomerSpaceSkills(customerSkillsDir);
    const fromOperator = skillsFromSource(allCustomer, operatorRepoUrl);

    for (const remoteName of remoteSkillNames) {
      const existing = fromOperator.find((s) => s.name === remoteName);

      if (!existing) {
        if (opts.dryRun) {
          result.installed.push(remoteName);
          continue;
        }
        try {
          installSkill(operatorRepoUrl, remoteName, customerSkillsDir, targetHiveHome);
          result.installed.push(remoteName);
          log.info("Installed", { skill: remoteName });
        } catch (err) {
          result.errors.push({ skill: remoteName, error: String(err) });
          log.warn("Install failed", { skill: remoteName, err });
        }
        continue;
      }

      if (existing.origin?.modified === true) {
        result.modifiedSkipped.push(remoteName);
        log.info("Skipped (customer-modified)", { skill: remoteName });
        continue;
      }

      if (existing.origin?.["base-version"] === clone.headSha) {
        result.upToDate.push(remoteName);
        continue;
      }

      if (opts.dryRun) {
        result.upgraded.push(remoteName);
        continue;
      }
      try {
        await upgradeSkill(remoteName, customerSkillsDir, targetHiveHome, refuseConflict);
        result.upgraded.push(remoteName);
        log.info("Upgraded", { skill: remoteName });
      } catch (err) {
        result.errors.push({ skill: remoteName, error: String(err) });
        log.warn("Upgrade failed", { skill: remoteName, err });
      }
    }

    // Orphan detection
    for (const customer of fromOperator) {
      if (!remoteSkillNames.includes(customer.name)) {
        result.orphaned.push(customer.name);
        if (opts.prune && !opts.dryRun) {
          try {
            await removeSkill(customer.name, customerSkillsDir, targetHiveHome, { force: true });
            result.pruned.push(customer.name);
            log.info("Pruned orphan", { skill: customer.name });
          } catch (err) {
            result.errors.push({ skill: customer.name, error: String(err) });
            log.warn("Prune failed", { skill: customer.name, err });
          }
        }
      }
    }
  } finally {
    clone.cleanup();
  }

  log.info("Sync complete", {
    installed: result.installed.length,
    upgraded: result.upgraded.length,
    upToDate: result.upToDate.length,
    modifiedSkipped: result.modifiedSkipped.length,
    orphaned: result.orphaned.length,
    pruned: result.pruned.length,
    errors: result.errors.length,
  });

  return result;
}
```

- [ ] **Step 2:** Create `src/skills/sync.test.ts` with these scenarios:

Tests should mock `shallowClone`, `installSkill`, `upgradeSkill`, `removeSkill` (vitest `vi.mock`) and use a tmpdir for `targetHiveHome`. Stub `listSkillsInClone` to return controlled skill lists. Use `scanCustomerSpaceSkills` for real (it's filesystem-based, fixture-friendly).

```typescript
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
    // shallowClone is sync — returns CloneResult directly
    vi.mocked(shallowClone).mockReturnValue({
      dir: "/tmp/clone",
      headSha: HEAD_SHA,
      cleanup,
    } as never);
    vi.mocked(listSkillsInClone).mockReturnValue([]);
    vi.mocked(installSkill).mockReturnValue({
      name: "stub", workflow: "default", version: HEAD_SHA, path: "/stub",
    } as never);
    vi.mocked(upgradeSkill).mockResolvedValue({
      name: "stub", action: "applied",
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
    // Verify the no-URL signature: (skillName, skillsDir, hiveHome, promptFn)
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
    // Verify force: true is passed (skip interactive confirm)
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
```

- [ ] **Step 3:** Verify

```bash
cd /Users/mokie/github/hive-KPR-82 && npx vitest run src/skills/sync.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 4:** Commit

```bash
git add src/skills/sync.ts src/skills/sync.test.ts
git commit -m "feat(skills,KPR-82): syncOperatorSkills orchestrator with prune + dry-run"
```

---

### Task 4: `hive skill sync` CLI subcommand

**Files:**
- Modify: `src/cli/skill.ts` — add `sync` case to subcommand switch

- [ ] **Step 1:** Add `sync` to the subcommand switch in `src/cli/skill.ts`. The existing pattern uses `await import("../config.js")` for lazy config load (see `case "add"`). `hiveHome` is already imported from `paths.js` at the top of the file.

Add to imports at top of file:

```typescript
import { syncOperatorSkills, type SyncResult } from "../skills/sync.js";
```

Add inside the `runSkill()` switch (after `case "remove"` is conventional):

```typescript
    case "sync": {
      verifyGitAvailable();
      const { config } = await import("../config.js");
      if (!config.operatorSkillsRepo) {
        console.error("No operatorSkillsRepo configured in hive.yaml. Set:");
        console.error("");
        console.error("  operatorSkillsRepo:");
        console.error("    url: https://github.com/<operator>/<repo>");
        console.error("");
        process.exit(1);
      }
      const dryRun = args.includes("--dry-run");
      const prune = args.includes("--prune");
      const result = await syncOperatorSkills(
        config.operatorSkillsRepo.url,
        hiveHome,
        { dryRun, prune },
      );
      printSyncSummary(result, { dryRun, prune });
      if (result.errors.length > 0) process.exit(1);
      break;
    }
```

Add the `printSyncSummary` helper at the bottom of the file (or in a shared helper module if the existing CLI has one):

```typescript
function printSyncSummary(
  r: SyncResult,
  opts: { dryRun: boolean; prune: boolean },
): void {
  const prefix = opts.dryRun ? "(dry-run) " : "";
  console.log(`${prefix}Sync result @ ${r.headSha.slice(0, 8)}:`);
  if (r.installed.length) console.log(`  installed (${r.installed.length}): ${r.installed.join(", ")}`);
  if (r.upgraded.length) console.log(`  upgraded (${r.upgraded.length}): ${r.upgraded.join(", ")}`);
  if (r.upToDate.length) console.log(`  up to date: ${r.upToDate.length}`);
  if (r.modifiedSkipped.length)
    console.log(`  customer-modified (skipped): ${r.modifiedSkipped.join(", ")}`);
  if (r.orphaned.length) {
    console.log(`  orphaned (${r.orphaned.length}): ${r.orphaned.join(", ")}`);
    if (!opts.prune)
      console.log(`    re-run with --prune to remove orphans`);
  }
  if (r.pruned.length) console.log(`  pruned: ${r.pruned.join(", ")}`);
  if (r.errors.length) {
    console.log(`  errors (${r.errors.length}):`);
    for (const e of r.errors) console.log(`    ${e.skill}: ${e.error}`);
  }
}
```

- [ ] **Step 2:** Update the help text in `src/cli/skill.ts` (search for the existing help-print block) to include:

```
  sync [--dry-run] [--prune]
        Sync customer-space skills with the configured operatorSkillsRepo.
        Installs missing, upgrades stale, leaves customer-modified alone.
        --dry-run: report changes without applying.
        --prune: remove customer-space skills that are sourced from this repo
                 but no longer present in it.
```

- [ ] **Step 3:** Verify

```bash
cd /Users/mokie/github/hive-KPR-82 && npm run typecheck && npm run build
```

Expected: clean typecheck + build.

```bash
node dist/cli.js skill sync --dry-run 2>&1 | head
```

Expected (when no `operatorSkillsRepo` configured): `No operatorSkillsRepo configured...`

- [ ] **Step 4:** Commit

```bash
git add src/cli/skill.ts
git commit -m "feat(cli,KPR-82): hive skill sync [--dry-run] [--prune]"
```

---

### Task 5: Auto-sync after `hive update`

**Files:**
- Modify: `src/cli/update.ts` — call sync after successful upgrade

- [ ] **Step 1:** Locate the `runUpdate()` function in `src/cli/update.ts`. After the `deploy.sh` invocation succeeds (exit 0), add:

```typescript
  // Post-upgrade skill sync (KPR-82) — opt-in via operatorSkillsRepo config.
  // Failure here is non-fatal: engine upgrade succeeded; sync can be re-run manually.
  try {
    const { config } = await import("../config.js");
    if (config.operatorSkillsRepo) {
      console.log("");
      console.log("Syncing skills from operator repo...");
      const { syncOperatorSkills } = await import("../skills/sync.js");
      const { hiveHome } = await import("../paths.js");
      const result = await syncOperatorSkills(
        config.operatorSkillsRepo.url,
        hiveHome,
      );
      if (result.installed.length || result.upgraded.length) {
        console.log(
          `  installed: ${result.installed.length}, upgraded: ${result.upgraded.length}, up-to-date: ${result.upToDate.length}`,
        );
      } else {
        console.log("  all skills up to date");
      }
      if (result.errors.length) {
        console.warn(`  ${result.errors.length} skill(s) failed to sync — re-run 'hive skill sync' manually`);
      }
    }
  } catch (err) {
    console.warn(`Post-upgrade skill sync failed (non-fatal): ${err}`);
    console.warn("Re-run manually with: hive skill sync");
  }
```

The dynamic imports keep `update.ts` startup lean for the no-op case (no operator repo configured — most users today). If `update.ts` already imports `hiveHome` statically, drop the dynamic import for it.

- [ ] **Step 2:** Verify

```bash
cd /Users/mokie/github/hive-KPR-82 && npm run typecheck
```

Expected: clean.

- [ ] **Step 3:** Commit

```bash
git add src/cli/update.ts
git commit -m "feat(update,KPR-82): auto-sync skills after successful upgrade"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` — add operator-repo workflow note
- Create: `docs/specs/2026-04-28-operator-skills-repo-design.md` — short design doc

- [ ] **Step 1:** Add to `CLAUDE.md` under the existing "Conventions" or "Dev vs Deploy" section (whichever is closer to skills topics — search for "skills" mentions in CLAUDE.md):

```markdown
## Skills distribution (KPR-82)

Customer-space skills (`<hiveHome>/skills/`) are kept in sync across an
operator's hive instances by pulling from a single git repo declared in
`hive.yaml`:

```yaml
operatorSkillsRepo:
  url: https://github.com/<operator>/<repo>
  branch: main   # optional, default: main
```

The operator repo has the same shape as a skill registry — a flat
`skills/<skill-name>/` layout. Run `hive skill sync` to install/upgrade
all skills from the repo into customer space; `hive update` runs sync
automatically after a successful engine upgrade.

**Customer-modified skills are never overwritten.** If `origin.modified`
is true on a local skill, sync skips it and reports the divergence.

**Authoring flow (until publish-back ships):** author or edit a skill on
any instance, then commit it to the operator repo manually. Other
instances pick it up on next `hive skill sync` (or next `hive update`).
```

- [ ] **Step 2:** Create `docs/specs/2026-04-28-operator-skills-repo-design.md`:

```markdown
# Operator Skills Repo — Design (KPR-82)

**Status:** Implemented 2026-04-28
**Supersedes nothing.** Builds on `2026-04-15-skills-customer-space-design.md`.

## Problem

Customer-space skills are gitignored and instance-local. When an operator
runs hives on multiple machines (one for dev, one for production, one
for migration), skills authored on machine A do not propagate to machines
B and C. The 2026-04-25 morning-briefing incident — properly designed
skills stranded on the wrong machine for 7+ days — is the canonical
example.

## Solution

A single git repo, declared in `hive.yaml` as `operatorSkillsRepo`, is
the canonical source of one operator's customer-space skills. All of
that operator's instances pull from it.

The operator repo has the same shape as a skill registry (flat
`skills/<skill-name>/`). What's new is **declarative sync**: every skill
in the operator repo *should* be installed in every instance, and every
instance reports orphans when the operator removes a skill.

## Sync semantics

- **Install missing** — skill in repo, not in customer space → `installSkill()`
- **Upgrade stale** — skill in both, base-version differs → `upgradeSkill()`
- **Skip up-to-date** — skill in both, base-version matches HEAD → no-op
- **Skip customer-modified** — `origin.modified === true` → never overwrite
- **Report orphans** — skill in customer space (sourced from this repo) but no longer in repo
- **Prune (opt-in)** — `--prune` removes orphans

## What this is NOT

- **Not a registry replacement.** Existing `skillRegistries[]` config still works for one-off `hive skill add @registry/name` installs. The operator repo is for "everything in this repo, kept in sync."
- **Not a marketplace.** No customer-to-customer skill sharing. (See `project_skills_distribution_strategy.md`.)
- **Not push-back.** Authoring on instance A → operator repo is manual today. Future ticket: `hive skill publish` or auto-commit.
- **Not the paid-tier delivery channel.** That's Registry (A), a separate ticket. The operator repo is the substrate; both free DIY and paid bundle delivery (later) write into the same place.

## Freemium alignment

Free customers maintain the operator repo themselves. Paid customers
will eventually receive curated bundles into the same `<hiveHome>/skills/`
location via Registry (A). One mechanism, two audiences. (See
`project_freemium_model.md`.)
```

- [ ] **Step 3:** Commit

```bash
git add CLAUDE.md docs/specs/2026-04-28-operator-skills-repo-design.md
git commit -m "docs(KPR-82): operator skills repo workflow and design"
```

---

### Task 7: Full check + smoke test

- [ ] **Step 1:** Run the full check.

```bash
cd /Users/mokie/github/hive-KPR-82 && npm run check
```

Expected: typecheck + lint + format + test all pass.

- [ ] **Step 2:** Run bundle decontamination (KPR-80 lesson — make sure no plugin-specific strings leaked).

```bash
cd /Users/mokie/github/hive-KPR-82 && npm run check:bundle
```

Expected: `OK: N bundle file(s) clean of forbidden strings`.

- [ ] **Step 3:** End-to-end smoke test against a local bare repo (no GitHub round-trip needed).

```bash
# Build a local bare repo with one skill
SCRATCH=$(mktemp -d) && cd "$SCRATCH"
mkdir source && cd source
git init -q
mkdir -p skills/sync-smoke-test
cat > skills/sync-smoke-test/SKILL.md <<'EOF'
---
name: sync-smoke-test
description: KPR-82 sync smoke test
workflow: default
---
# Sync smoke test
EOF
git add . && git -c user.email=test@test -c user.name=test commit -qm init
cd .. && git clone --bare source bare.git
SMOKE_URL="file://$SCRATCH/bare.git"
echo "Smoke URL: $SMOKE_URL"

# Then in the test hive.yaml (or temp), set operatorSkillsRepo.url to $SMOKE_URL
# and run:
cd /Users/mokie/github/hive-KPR-82
node dist/cli.js skill sync --dry-run
```

Expected dry-run output:
```
(dry-run) Sync result @ <8-char-sha>:
  installed (1): sync-smoke-test
```

Without `--dry-run`, verify the skill lands at `<hiveHome>/skills/default/skills/sync-smoke-test/SKILL.md` with an `origin:` block whose `source` is the file:// URL. Re-running sync should report `up to date: 1` (idempotent).

Document the smoke flow in the PR description.

---

### Task 8: PR

- [ ] Push branch and open PR with `dodi-dev:submit`. Base: `main`. Title: `KPR-82: operator skills repo for cross-instance sync`.

PR body should include:
- Link to KPR-82
- One-paragraph summary (what this ships, what it doesn't)
- Smoke test repo URL + reproduction steps
- Explicit list of out-of-scope items (Registry A, meta-skills, push-back, KPR-75)
- Reference to `project_freemium_model.md` for substrate-vs-tier framing

---

## Acceptance criteria (mapped from KPR-82 ticket)

- [x] **A skill authored on one instance can be installed on another instance via a single command.** — `hive skill sync` after operator commits to repo.
- [x] **`hive update` does not lose customer-space skills.** — already true; sync runs *after* upgrade.
- [x] **`hive skill list` shows what's installed and from where.** — already implemented; origin frontmatter carries source URL.
- [x] **Recovery from "lost skill suite" goes through official tool, not git archaeology.** — fresh instance + `hive skill sync` restores from operator repo.

## Follow-up tickets to file after this lands

- **Push-back / publish flow** — `hive skill publish <name>` to commit a customer-authored skill back to operator repo. Per the deploy-skill auto-commit feedback, must be an explicit operator action, not implicit on every save.
- **Meta-skills** — `skill-import`, `skill-evaluate`, `skill-attribute` for third-party-repo flow (per the freemium boundary, these stay in the free tier).
- **Registry (A)** — Keepur-hosted distribution channel for paid bundles.
- **Background sync** — optional cron or watch-mode for instances that prefer continuous sync over update-time.
