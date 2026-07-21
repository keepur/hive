/**
 * KPR-349 (spec §D6): derive the Lane B skill index from the agent's
 * already-scoped SDK plugin list (getSkillsForAgent output — agent-scoped,
 * universal-merged, dedup'd, customer-shadowed upstream). Per-skill
 * fail-soft: one bad SKILL.md must never TurnAssemblyError the turn.
 *
 * name = skill DIRECTORY name (the loader's scoping unit and the bridge's
 * lookup key — frontmatter `name` may drift and is ignored).
 * description = frontmatter description, falling back to the name.
 * path = absolute realpath of SKILL.md (projection symlinks pre-resolved).
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import { readSkillMd } from "../../skills/frontmatter.js";
import type { ProviderSkillIndexEntry } from "./turn-assembly.js";

const log = createLogger("provider-skill-index");

export function deriveProviderSkillIndex(sdkPlugins: SdkPluginConfig[]): ProviderSkillIndexEntry[] {
  const entries: ProviderSkillIndexEntry[] = [];
  const seen = new Set<string>();
  for (const plugin of sdkPlugins) {
    const skillsDir = join(plugin.path, "skills");
    let dirNames: string[];
    try {
      dirNames = readdirSync(skillsDir);
    } catch {
      // Plugin without a skills/ dir (or torn down concurrently) — skip
      // silently; projection layout guarantees the shape for real skills.
      continue;
    }
    for (const name of dirNames) {
      try {
        const skillMdPath = join(skillsDir, name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue; // stray file/non-skill dir
        if (seen.has(name)) {
          // First-wins, matching the bridge's Map construction (tool-bridge.ts).
          log.warn("Duplicate skill name in provider index — first entry wins", { skill: name });
          continue;
        }
        const { frontmatter } = readSkillMd(skillMdPath);
        seen.add(name);
        entries.push({
          name,
          description: frontmatter.description || name,
          path: realpathSync(skillMdPath),
        });
      } catch (err) {
        // Per-skill fail-soft (mirrors skill-loader's per-agent posture).
        log.warn("Skill unreadable/unparseable — omitted from provider index", {
          skill: name,
          error: String(err),
        });
      }
    }
  }
  return entries;
}
