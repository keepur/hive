import type { Options as SdkQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ArchetypeSessionContext } from "../registry.js";
import type { SoftwareEngineerConfig } from "./config.js";

/**
 * Session options for a software-engineer agent:
 *   - cwd: workshop root (agent's working directory)
 *   - settingSources: ["project"] only — pulls workspace CLAUDE.md,
 *     excludes global user settings/MCP servers to keep Hive-managed tools authoritative
 */
export function sessionOptions(ctx: ArchetypeSessionContext<SoftwareEngineerConfig>): Partial<SdkQueryOptions> {
  return {
    cwd: ctx.archetypeConfig.workshop,
    settingSources: ["project"],
  };
}
