import { createLogger } from "../logging/logger.js";
import type { RegistryConfig } from "../config.js";

const log = createLogger("registry-resolver");

export interface ResolvedRegistry {
  name: string;
  url: string;
}

export interface ParsedSkillSpec {
  name: string;
  registryName?: string;
  inlineUrl?: string;
}

/**
 * Parse a skill specifier into its components.
 * Formats:
 *   - "morning-briefing" → plain name
 *   - "keepur-default:morning-briefing" → registry prefix + name
 *   - "https://github.com/foo/bar#skills/morning-briefing" → inline URL
 *   - "file:///path/to/repo#skills/morning-briefing" → local URL
 *   - "https://github.com/owner/repo/tree/main/skills/name" → GitHub web URL (convenience)
 */
export function parseSkillSpec(spec: string): ParsedSkillSpec {
  // Inline URL with fragment
  if (spec.includes("#skills/")) {
    const hashIdx = spec.indexOf("#skills/");
    const url = spec.slice(0, hashIdx);
    const name = spec.slice(hashIdx + "#skills/".length);
    return { name, inlineUrl: url };
  }

  // GitHub web URL convenience form
  const ghMatch = spec.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/[^/]+\/skills\/([^/]+)/);
  if (ghMatch) {
    return {
      name: ghMatch[3]!,
      inlineUrl: `https://github.com/${ghMatch[1]}/${ghMatch[2]}`,
    };
  }

  // Registry prefix (contains : but not ://)
  if (spec.includes(":") && !spec.includes("://")) {
    const colonIdx = spec.indexOf(":");
    const registry = spec.slice(0, colonIdx);
    const name = spec.slice(colonIdx + 1);
    return { name, registryName: registry };
  }

  // Plain name
  return { name: spec };
}

/**
 * Resolve which registry to use for a skill install/upgrade.
 */
export function resolveRegistry(spec: ParsedSkillSpec, registries: RegistryConfig[]): ResolvedRegistry {
  if (spec.inlineUrl) {
    const name = inferRegistryName(spec.inlineUrl);
    log.debug("resolved inline registry", { inlineUrl: spec.inlineUrl, name });
    return { name, url: spec.inlineUrl };
  }

  if (spec.registryName) {
    const found = registries.find((r) => r.name === spec.registryName);
    if (!found) {
      throw new Error(
        `Unknown registry: "${spec.registryName}". ` +
          `Configured registries: ${registries.map((r) => r.name).join(", ")}`,
      );
    }
    log.debug("resolved named registry", { registryName: spec.registryName, url: found.url });
    return { name: found.name, url: found.url };
  }

  const defaultReg = registries.find((r) => r.default) ?? registries[0];
  if (!defaultReg) {
    throw new Error("No skill registries configured. Add one with: hive registry add <url>");
  }
  log.debug("resolved default registry", { registryName: defaultReg.name, url: defaultReg.url });
  return { name: defaultReg.name, url: defaultReg.url };
}

function inferRegistryName(url: string): string {
  try {
    const cleaned = url.replace(/\.git$/, "");
    const parts = cleaned.split("/").filter(Boolean);
    return parts.slice(-2).join("-");
  } catch {
    return "inline";
  }
}
