import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedPlugin } from "../plugins/types.js";
import { createLogger } from "../logging/logger.js";
import { computeContentHash } from "../skills/content-hash.js";
import { readSkillMd, writeSkillMd } from "../skills/frontmatter.js";
import { commitToState } from "../skills/instance-git.js";
import { agentSkillsDir, hiveHome as RUNTIME_HIVE_HOME } from "../paths.js";

const log = createLogger("skill-loader");

export type SkillIndex = Map<string, SdkPluginConfig[]>;

/** Set of skill directory paths detected as modified from their registry base. */
let _modifiedSkills: Set<string> = new Set();

/** Returns the set of skill paths that were detected as modified on last load. */
export function getModifiedSkills(): Set<string> {
  return _modifiedSkills;
}

type CollisionEntry = {
  source: string;
  /**
   * Path used as the de-dup key — the *real* skill directory on disk
   * (the one a customer-modification check would re-hash). For flat-layout
   * skills this is `<root>/skills/<skill>/`; for old-layout it's the
   * workflow grouping dir.
   */
  realPath: string;
  /** Plugin-config path actually fed to the SDK. May be a projection. */
  pluginPath: string;
  /**
   * Skill name (the inner SKILL.md's directory name). The unit at which
   * `agents:` scoping is decided.
   */
  skillName: string;
  /** True for legacy `<root>/<workflow>/skills/<skill>/SKILL.md` layout. */
  legacy: boolean;
};

/**
 * KPR-214: flat layout (`<root>/skills/<skill>/SKILL.md`) is now the canonical
 * SDK-aligned shape. Each scoped flat skill is exposed to the SDK via a
 * synthetic projection: `<projectionRoot>/<sourceTag>__<skillName>/skills/<skillName>`
 * symlinks to the real skill directory. The projection root is rebuilt
 * deterministically on every load — re-running the loader is idempotent.
 *
 * Legacy `<root>/skills/<workflow>/skills/<skill>/SKILL.md` is still accepted
 * during the transition window (operator-skills repos haven't migrated yet —
 * tracked under [KPR-215](https://linear.app/keepur/issue/KPR-215)). Each legacy
 * source emits a deprecation warning the first time it's seen per load.
 */

const PROJECTION_DIRNAME = ".skill-projections";

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

/**
 * Build a stable, filesystem-safe identifier for the projection-tag derived
 * from `(sourceTag, skillName)`. Hashed to avoid path-length issues with deep
 * source paths and to keep the projection root flat-ish.
 */
function projectionKey(sourceTag: string, realSkillPath: string, skillName: string): string {
  // Source tag distinguishes seed/plugin/customer/agent-private. RealSkillPath
  // disambiguates two skills with the same name across roots that nonetheless
  // legitimately want both projected (e.g., agent-private from two agents).
  const seed = `${sourceTag}::${realSkillPath}`;
  return `${skillName}-${shortHash(seed)}`;
}

/**
 * Scan seed-bundled skills, plugin-bundled skills, agent-private skills (KPR-75),
 * and customer-space skills, building a map of agentId → SdkPluginConfig[] for
 * the skills that agent should see.
 *
 * Precedence (high to low): customer > agent-private > seeds = plugins.
 *
 * Load-bearing pass-ordering invariant: seeds → plugins → agent-private → customer.
 * Reordering breaks the customer-shadow-evicts-agent-private logic.
 *
 * Customer space always wins (shadow). Among non-customer sources, first registered
 * wins — seeds are scanned before plugins so they take priority. Customer→customer
 * collisions are errors. Agent-private skills are scoped per-agent, so two agents
 * each having the same skill name is NOT a collision.
 *
 * @param customerSkillsDir  e.g. <hiveHome>/skills
 * @param plugins            loaded plugins (each may contain a skills/ dir)
 * @param seedDirs           seed directories that may contain skills/
 * @param agentIds           list of agent IDs to scan agents/<id>/skills/ for (KPR-75)
 * @param hiveHomeOverride   testability — overrides the runtime hiveHome const for
 *                           agentSkillsDir() resolution AND for projection root.
 *                           Production callers omit this.
 */
export function loadSkillIndex(
  customerSkillsDir: string,
  plugins?: LoadedPlugin[],
  seedDirs?: string[],
  agentIds?: string[],
  hiveHomeOverride?: string,
): SkillIndex {
  const index: SkillIndex = new Map();
  const universalPlugins: SdkPluginConfig[] = [];
  const collisionMap = new Map<string, CollisionEntry>();

  // Projection root rebuilt on every load. Atomic rebuild: tear down the old
  // tree first, then re-link skills as we discover them. Cheap (symlinks only).
  const projectionRoot = join(
    hiveHomeOverride ?? RUNTIME_HIVE_HOME,
    PROJECTION_DIRNAME,
  );
  rebuildProjectionRoot(projectionRoot);

  // Seeds first — win over plugins (first-in-wins among non-customer sources)
  for (const seedDir of seedDirs ?? []) {
    const seedSkillsDir = join(seedDir, "skills");
    if (!existsSync(seedSkillsDir)) continue;
    const seedName = seedDir.split("/").pop() ?? "seed";
    scanSkillsFrom(
      seedSkillsDir,
      `seed:${seedName}`,
      collisionMap,
      index,
      universalPlugins,
      false,
      projectionRoot,
    );
  }

  // Plugins second — lose to seeds (first-in-wins), lose to customer (winsCollisions)
  for (const plugin of plugins ?? []) {
    const pluginSkillsDir = join(plugin.dir, "skills");
    if (!existsSync(pluginSkillsDir)) continue;
    scanSkillsFrom(
      pluginSkillsDir,
      plugin.name,
      collisionMap,
      index,
      universalPlugins,
      false,
      projectionRoot,
    );
  }

  // Agent-private third (KPR-75) — agent-authored, agent-scoped by path.
  // Path is source of truth — frontmatter `agents:` is forbidden.
  // Local-filesystem-only — never commit, push, or sync these.
  //
  // A bad SKILL.md from one agent must not prevent the hive from booting or
  // disable other agents' skills. Catch per-agent so the rest of the index
  // builds normally.
  for (const agentId of agentIds ?? []) {
    const dir = agentSkillsDir(agentId, hiveHomeOverride);
    if (!existsSync(dir)) continue;
    try {
      scanSkillsFrom(
        dir,
        `agent-private:${agentId}`,
        collisionMap,
        index,
        universalPlugins,
        false,
        projectionRoot,
        agentId, // implicitAgentScope
      );
    } catch (err) {
      log.error("Agent-private skill rejected, skipping this agent's private skills", {
        agentId,
        dir,
        error: String(err),
      });
    }
  }

  // Customer space last — wins all collisions
  if (existsSync(customerSkillsDir)) {
    scanSkillsFrom(
      customerSkillsDir,
      "customer",
      collisionMap,
      index,
      universalPlugins,
      true,
      projectionRoot,
    );
  } else {
    log.debug("No customer skills directory found", { path: customerSkillsDir });
  }

  // Merge universal plugins into every agent's list + expose via sentinel
  if (universalPlugins.length > 0) {
    for (const agentId of [...index.keys()]) {
      const existing = index.get(agentId)!;
      existing.push(...universalPlugins);
    }
    index.set("__universal__", universalPlugins);
  }

  // Post-scan: detect customer modifications to registry-installed skills
  _modifiedSkills = detectModifiedSkills(collisionMap);

  log.info("Skill index loaded", {
    skills: collisionMap.size,
    agents: index.size - (index.has("__universal__") ? 1 : 0),
  });

  return index;
}

/**
 * Tear down and recreate the projection root. Cheap because we only ever store
 * symlinks under it. Recursive remove is safe (no real content lives there).
 */
function rebuildProjectionRoot(projectionRoot: string): void {
  // KPR-225 F3-bonus: fail-fast. Pre-fix swallowed errors and let
  // `buildSkillProjection` later throw with a confusing "ENOENT" further
  // down the call stack. Now bad config / EROFS surfaces immediately at
  // load time at the actual root cause.
  if (existsSync(projectionRoot)) {
    rmSync(projectionRoot, { recursive: true, force: true });
  }
  mkdirSync(projectionRoot, { recursive: true });
}

/**
 * Build the per-skill projection that the SDK can load:
 *   <projectionRoot>/<projectionKey>/skills/<skillName>  ->  realSkillDir
 * Returns the projected plugin path (the parent of the skills/ dir).
 *
 * Idempotent: tolerates the projection root being torn down concurrently
 * (parallel test runs share /Users/<u>/hive/.skill-projections by default).
 */
function buildSkillProjection(
  projectionRoot: string,
  sourceTag: string,
  skillName: string,
  realSkillDir: string,
): string {
  const key = projectionKey(sourceTag, realSkillDir, skillName);
  const pluginDir = join(projectionRoot, key);
  const skillsDir = join(pluginDir, "skills");
  const linkPath = join(skillsDir, skillName);
  // Belt-and-suspenders: re-create the projection root if a sibling loader
  // raced and removed it between rebuildProjectionRoot() and now.
  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(projectionRoot, { recursive: true });
      mkdirSync(skillsDir, { recursive: true });
    } else {
      throw err;
    }
  }
  // Resolve symlinks on the real path so projection isn't a chain of links.
  const realResolved = (() => {
    try {
      return realpathSync(realSkillDir);
    } catch {
      return realSkillDir;
    }
  })();
  if (!existsSync(linkPath)) {
    try {
      symlinkSync(realResolved, linkPath, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return pluginDir;
}

/**
 * Remove all index entries that reference the given plugin path.
 * Used when customer-space shadows a plugin/seed/agent-private skill.
 */
function removeSkillFromIndex(
  pluginPath: string,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
): void {
  // Remove from per-agent entries
  for (const [agentId, configs] of index) {
    const filtered = configs.filter((c) => c.path !== pluginPath);
    if (filtered.length !== configs.length) {
      if (filtered.length === 0) {
        index.delete(agentId);
      } else {
        index.set(agentId, filtered);
      }
    }
  }

  // Remove from universalPlugins array (mutate in place)
  for (let i = universalPlugins.length - 1; i >= 0; i--) {
    if (universalPlugins[i]!.path === pluginPath) {
      universalPlugins.splice(i, 1);
    }
  }
}

/**
 * Yield each candidate skill found inside `rootDir`, supporting both the new
 * flat layout and the legacy double-`skills/` layout.
 *
 *   Flat (preferred):       <rootDir>/<skill>/SKILL.md
 *   Legacy (deprecated):    <rootDir>/<workflow>/skills/<skill>/SKILL.md
 *
 * Each yielded record describes the unit at which scoping is decided (one
 * SKILL.md = one scoping unit, even when grouped by a legacy workflow).
 */
function* iterateSkillsRoot(
  rootDir: string,
  source: string,
): Generator<{
  skillName: string;
  realSkillDir: string;
  legacy: boolean;
  /** For legacy entries, the workflow grouping name (else null). */
  legacyWorkflow: string | null;
}> {
  let entries: string[];
  try {
    entries = readdirSync(rootDir).filter((d) => {
      try {
        return statSync(join(rootDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    log.warn("Failed to read skills directory", { source, path: rootDir, error: String(err) });
    return;
  }

  let legacyWarned = false;

  for (const entry of entries) {
    const entryPath = join(rootDir, entry);

    // Flat layout: SKILL.md directly inside the entry dir.
    if (existsSync(join(entryPath, "SKILL.md"))) {
      yield {
        skillName: entry,
        realSkillDir: entryPath,
        legacy: false,
        legacyWorkflow: null,
      };
      continue;
    }

    // Legacy layout: workflow/skills/<inner>/SKILL.md.
    const legacySkillsSubdir = join(entryPath, "skills");
    if (existsSync(legacySkillsSubdir)) {
      try {
        if (!statSync(legacySkillsSubdir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!legacyWarned) {
        log.warn(
          "Deprecated double-`skills/` layout detected — flatten to <root>/skills/<skill>/SKILL.md (KPR-214). Operator-skills repo migration tracked under KPR-215.",
          { source, root: rootDir, workflow: entry },
        );
        legacyWarned = true;
      }
      let inners: string[];
      try {
        inners = readdirSync(legacySkillsSubdir).filter((d) => {
          try {
            return statSync(join(legacySkillsSubdir, d)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch (err) {
        log.warn("Failed to read legacy workflow skills dir", {
          source,
          workflow: entry,
          error: String(err),
        });
        continue;
      }
      for (const inner of inners) {
        const innerPath = join(legacySkillsSubdir, inner);
        if (!existsSync(join(innerPath, "SKILL.md"))) continue;
        yield {
          skillName: inner,
          realSkillDir: innerPath,
          legacy: true,
          legacyWorkflow: entry,
        };
      }
      continue;
    }

    log.debug("Top-level dir has neither SKILL.md nor legacy skills/, skipping", {
      source,
      entry,
    });
  }
}

/**
 * Scan one top-level skills directory (plugin, customer, seed, or agent-private),
 * register non-colliding skills into the index, and append to universalPlugins
 * for hive-wide skills.
 *
 * When winsCollisions is true (customer space), collisions with non-customer
 * sources shadow the existing entry. Customer→customer collisions are errors.
 *
 * When implicitAgentScope is set (agent-private skills, KPR-75):
 *   - The collision key becomes per-agent (`<agentId>::<skill>`), so two
 *     agents each having the same skill name is NOT a collision.
 *   - Frontmatter `agents:` in agent-private skills is a hard error — the path
 *     is the source of truth.
 *   - Skills are bound to the implicit-scope agent only.
 *
 * When customer pass runs with no implicitAgentScope, after agent scope is
 * known from frontmatter, also evict any per-agent-keyed entries in
 * collisionMap+index for those agents — preserves operator authority over
 * agent-private skills.
 */
function scanSkillsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
  winsCollisions: boolean,
  projectionRoot: string,
  implicitAgentScope?: string,
): void {
  for (const found of iterateSkillsRoot(rootDir, source)) {
    const { skillName, realSkillDir, legacy, legacyWorkflow } = found;

    // Collision key: legacy entries collide on workflow grouping (preserves
    // the pre-KPR-214 invariant that a "workflow" is a single shadow unit);
    // flat entries collide on skill name (each skill is its own unit).
    // Customer-shadow eviction needs to find legacy skills regardless of which
    // layout the customer uses, so the cross-layout flattened key is also
    // tracked separately when needed (see customer-shadow eviction below).
    const layoutKey = legacy ? legacyWorkflow! : skillName;
    const collisionKey = implicitAgentScope ? `${implicitAgentScope}::${layoutKey}` : layoutKey;

    // Determine the SDK plugin path. Flat skills get a synthetic projection
    // (so the SDK sees the layout it expects). Legacy skills already have the
    // expected layout — point the SDK at the workflow dir directly.
    let pluginPath: string;
    if (legacy) {
      // legacyWorkflow is non-null for legacy entries; the workflow dir is
      // realSkillDir's parent's parent.
      const workflowDir = join(rootDir, legacyWorkflow!);
      pluginPath = workflowDir;
    } else {
      pluginPath = buildSkillProjection(projectionRoot, source, skillName, realSkillDir);
    }

    const existing = collisionMap.get(collisionKey);
    if (existing) {
      if (winsCollisions && existing.source !== "customer") {
        // Customer shadows plugin/seed — remove their entries and replace
        log.warn("Customer skill shadows non-customer skill", {
          skill: skillName,
          shadowed: existing,
          customer: { source, realPath: realSkillDir },
        });
        removeSkillFromIndex(existing.pluginPath, index, universalPlugins);
        collisionMap.set(collisionKey, {
          source,
          realPath: realSkillDir,
          pluginPath,
          skillName,
          legacy,
        });
      } else if (winsCollisions && existing.source === "customer") {
        // Customer→customer collision — error, load neither
        log.error("Customer skill collision — both skipped", {
          skill: skillName,
          first: existing,
          second: { source, realPath: realSkillDir },
        });
        // Remove the first customer version that was already loaded
        removeSkillFromIndex(existing.pluginPath, index, universalPlugins);
        collisionMap.delete(collisionKey);
        continue;
      } else {
        // Plugin→plugin or agent-private→agent-private (same agent) collision — first wins
        log.warn("Skill collision — keeping first, skipping second", {
          skill: skillName,
          kept: existing,
          skipped: { source, realPath: realSkillDir },
        });
        continue;
      }
    } else {
      collisionMap.set(collisionKey, {
        source,
        realPath: realSkillDir,
        pluginPath,
        skillName,
        legacy,
      });
    }

    const pluginConfig: SdkPluginConfig = { type: "local", path: pluginPath };

    // Determine scope from frontmatter (or implicit agent scope for KPR-75).
    const agentIds = new Set<string>();
    let hasAll = false;

    const skillMd = join(realSkillDir, "SKILL.md");
    const declaredAgents = parseAgentsFromFrontmatter(readFileSync(skillMd, "utf-8"));

    if (implicitAgentScope) {
      // Path is the source of truth for agent-private skills. Frontmatter
      // `agents:` is forbidden — surfaces a clear error rather than letting
      // the file silently scope incorrectly.
      if (declaredAgents.length > 0) {
        throw new Error(
          `Agent-private skill at ${skillMd} declares agents: in frontmatter. ` +
            `For skills under agents/${implicitAgentScope}/skills/, the path is the source of truth — ` +
            `remove the agents: field.`,
        );
      }
      agentIds.add(implicitAgentScope);
    } else {
      for (const agent of declaredAgents) {
        if (agent === "all") {
          hasAll = true;
        } else {
          agentIds.add(agent);
        }
      }
    }

    // Customer-shadow eviction: when customer skill is loading and any agent
    // it scopes to has an agent-private skill of the same name, evict the
    // agent-private version. Operator authority preserved.
    //
    // The agent-private collision-key uses the agent's layout key (workflow
    // for legacy, skill name for flat). Cross-layout shadowing therefore uses
    // the stored `entry.skillName`, not the collision-key suffix, so an operator
    // who flattens customer skills while leaving agent private legacy still gets
    // the correct precedence — and vice versa.
    if (winsCollisions && !implicitAgentScope) {
      if (hasAll) {
        // KPR-225 F2: customer skill with `agents: [all]` shadows EVERY
        // agent-private skill of the same name. Pre-fix bug: the original
        // loop only iterated `agentIds`, which is empty when hasAll=true,
        // so no eviction happened and `getSkillsForAgent` returned both the
        // agent-private and the universal customer skill simultaneously.
        //
        // KPR-227: match by `entry.skillName` rather than the bare suffix
        // of `perAgentKey`. Agent-private collision keys are
        // `<agentId>::<layoutKey>`, where `layoutKey === legacyWorkflow` for
        // legacy nested layouts and `layoutKey === skillName` for flat ones.
        // An `endsWith("::" + skillName)` filter only catches the flat case
        // and silently misses legacy private skills whose workflow name
        // differs from the skill name (e.g. `luna::blog-flow` for skill
        // `publish-blog-post`). Comparing `entry.skillName` covers both.
        // The source guard preserves the invariant that only agent-private
        // entries are evictable — customer/seed/plugin entries are never
        // removed by this operator-authority rule.
        const evictionKeys: string[] = [];
        for (const [perAgentKey, entry] of collisionMap.entries()) {
          if (entry.source.startsWith("agent-private:") && entry.skillName === skillName) {
            evictionKeys.push(perAgentKey);
          }
        }
        for (const perAgentKey of evictionKeys) {
          const evicted = collisionMap.get(perAgentKey)!;
          log.warn("Customer-space [all] skill shadows agent-private skill", {
            skill: skillName,
            agentKey: perAgentKey,
            shadowed: evicted.realPath,
            winner: realSkillDir,
          });
          removeSkillFromIndex(evicted.pluginPath, index, universalPlugins);
          collisionMap.delete(perAgentKey);
        }
      } else {
        for (const agentId of agentIds) {
          // Match the targeted agent's private entries by stored skillName,
          // not by the customer's layout key. A flat customer skill scoped to
          // one agent must still shadow legacy private keys like
          // `luna::blog-flow` when `entry.skillName === "publish-blog-post"`.
          const evictionKeys: string[] = [];
          for (const [perAgentKey, entry] of collisionMap.entries()) {
            if (entry.source === `agent-private:${agentId}` && entry.skillName === skillName) {
              evictionKeys.push(perAgentKey);
            }
          }
          for (const perAgentKey of evictionKeys) {
            const evicted = collisionMap.get(perAgentKey);
            if (evicted) {
              log.warn("Customer-space skill shadows agent-private skill", {
                skill: skillName,
                agent: agentId,
                shadowed: evicted.realPath,
                winner: realSkillDir,
              });
              removeSkillFromIndex(evicted.pluginPath, index, universalPlugins);
              collisionMap.delete(perAgentKey);
            }
          }
        }
      }
    }

    if (hasAll) {
      universalPlugins.push(pluginConfig);
      log.debug("Skill registered as universal", { source, skillName, legacy });
    } else if (agentIds.size > 0) {
      for (const agentId of agentIds) {
        const existingList = index.get(agentId) ?? [];
        existingList.push(pluginConfig);
        index.set(agentId, existingList);
      }
      log.debug("Skill registered", {
        source,
        skillName,
        legacy,
        agents: [...agentIds],
      });
    }
  }
}

/**
 * Look up skills for a specific agent. Merges agent-specific + universal.
 */
export function getSkillsForAgent(index: SkillIndex, agentId: string): SdkPluginConfig[] {
  const agentSkills = index.get(agentId) ?? [];
  const universal = index.get("__universal__") ?? [];

  // If agent already has universal plugins merged (from loadSkillIndex), avoid duplicates
  if (agentSkills.length > 0 && universal.length > 0) {
    const paths = new Set(agentSkills.map((p) => p.path));
    const missing = universal.filter((p) => !paths.has(p.path));
    return [...agentSkills, ...missing];
  }

  // Agent not in index — just return universal
  if (agentSkills.length === 0 && universal.length > 0) {
    return [...universal];
  }

  return agentSkills;
}

/**
 * After skills are loaded, check each customer-space skill with an origin block
 * containing a base-content-hash. If the current content hash differs, mark
 * the skill as modified (in-memory only) and log a warning.
 *
 * Returns the set of modified skill directory paths for testability.
 */
function detectModifiedSkills(
  collisionMap: Map<string, CollisionEntry>,
): Set<string> {
  const modified = new Set<string>();

  for (const [skillKey, entry] of collisionMap) {
    // Only check customer-space skills — never write to plugin directories
    if (entry.source !== "customer") continue;

    const skillMdPath = join(entry.realPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const { frontmatter, body } = readSkillMd(skillMdPath);
      if (!frontmatter.origin?.["base-content-hash"]) continue;

      const currentHash = computeContentHash(entry.realPath);
      if (currentHash !== frontmatter.origin["base-content-hash"]) {
        // Record in-memory first so state is consistent even if the disk
        // persistence below fails (permissions, read-only FS, etc).
        modified.add(entry.realPath);
        log.warn("Registry-installed skill has been modified", {
          skill: entry.skillName,
          collisionKey: skillKey,
          source: frontmatter.origin.source,
          baseHash: frontmatter.origin["base-content-hash"],
          currentHash,
        });

        if (!frontmatter.origin.modified) {
          frontmatter.origin.modified = true;
          // The write below triggers fs.watch; loadSkillIndex re-entering is
          // safe because on the next pass frontmatter.origin.modified is
          // already true, so this branch is skipped and no further write
          // occurs. The 500ms debounce in index.ts coalesces the trigger.
          try {
            writeSkillMd(skillMdPath, frontmatter, body);
            // Resolve hiveHome from the skill path (the customer skills dir is
            // <hiveHome>/skills, so go up one). Avoids an extra parameter on
            // detectModifiedSkills now that the entry carries the real path.
            const hiveHome = resolve(entry.realPath, "..", "..");
            commitToState(
              hiveHome,
              [relative(hiveHome, skillMdPath)],
              `detect-modified: ${entry.skillName} content hash changed`,
            );
          } catch (err) {
            log.error("Failed to persist modified flag to disk", {
              path: skillMdPath,
              error: String(err),
            });
          }
        }
      }
    } catch {
      // If we can't parse frontmatter, skip silently
    }
  }

  return modified;
}

/**
 * Parse the agents field from SKILL.md YAML frontmatter.
 * Returns empty array if no frontmatter or no agents field.
 */
function parseAgentsFromFrontmatter(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];

  const frontmatter = match[1]!;

  // Match "agents:" followed by YAML list items
  const agentsMatch = frontmatter.match(/^agents:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (agentsMatch) {
    return agentsMatch[1]!
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
  }

  // Also support inline format: agents: [sdr, chief-of-staff]
  const inlineMatch = frontmatter.match(/^agents:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}
