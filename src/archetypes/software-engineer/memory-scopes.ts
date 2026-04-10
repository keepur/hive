import { homedir } from "node:os";
import { join } from "node:path";
import type { ArchetypeMemoryContext, MemoryScope } from "../registry.js";
import type { SoftwareEngineerConfig } from "./config.js";
import { workshopSlug, workspaceSlug } from "./paths.js";

/**
 * Returns memory scopes for a software-engineer agent:
 *   - "self" — MongoDB (always present, added by agent-runner; included here for completeness)
 *   - "workshop" — filesystem at ~/.claude/projects/<workshop-slug>/memory/
 *   - "workspace:<name>" — filesystem at ~/.claude/projects/<workspace-slug>/memory/ (per workspace)
 */
export function memoryScopes(ctx: ArchetypeMemoryContext<SoftwareEngineerConfig>): MemoryScope[] {
  const cfg = ctx.archetypeConfig;
  const home = homedir();
  const scopes: MemoryScope[] = [];

  // Workshop scope
  scopes.push({
    id: "workshop",
    backing: "filesystem",
    dir: join(home, ".claude/projects", workshopSlug(cfg), "memory"),
  });

  // Per-workspace scopes
  for (const ws of cfg.workspaces) {
    scopes.push({
      id: `workspace:${ws.name}`,
      backing: "filesystem",
      dir: join(home, ".claude/projects", workspaceSlug(ws), "memory"),
    });
  }

  return scopes;
}
