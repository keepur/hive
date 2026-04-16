import { readFileSync, writeFileSync } from "node:fs";

export interface SkillOrigin {
  type: "registry" | "agent-authored";
  source?: string;
  "base-version"?: string;
  "base-tag"?: string;
  "base-content-hash"?: string;
  "installed-at"?: string;
  modified?: boolean;
}

export interface SkillAuthor {
  "agent-id": string;
  "authored-at": string;
  reason?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  agents: string[];
  workflow?: string;
  origin?: SkillOrigin;
  author?: SkillAuthor;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Handles both inline `[a, b]` and list `- a\n- b` format for agents.
 * Handles nested `origin:` and `author:` blocks.
 */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("No YAML frontmatter found");
  }
  const yamlBlock = match[1]!;
  const body = match[2]!;

  const fm: SkillFrontmatter = {
    name: "",
    description: "",
    agents: [],
  };

  const lines = yamlBlock.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip blank lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!kvMatch) {
      i++;
      continue;
    }

    const key = kvMatch[1]!;
    const value = kvMatch[2]!.trim();

    if (key === "name") {
      fm.name = unquote(value);
    } else if (key === "description") {
      fm.description = unquote(value);
    } else if (key === "workflow") {
      fm.workflow = unquote(value);
    } else if (key === "agents") {
      // Inline format: [a, b, c]
      const inlineMatch = value.match(/^\[([^\]]*)\]$/);
      if (inlineMatch) {
        fm.agents = inlineMatch[1]!
          .split(",")
          .map((s) => unquote(s.trim()))
          .filter((s) => s.length > 0);
      } else if (value === "") {
        // List format: subsequent lines starting with "  - "
        fm.agents = [];
        while (i + 1 < lines.length && lines[i + 1]!.match(/^\s+-\s+/)) {
          i++;
          const item = lines[i]!.replace(/^\s+-\s+/, "").trim();
          fm.agents.push(unquote(item));
        }
      } else {
        // Single value
        fm.agents = [unquote(value)];
      }
    } else if (key === "origin") {
      fm.origin = parseNestedBlock(lines, i) as unknown as SkillOrigin;
      // Skip indented children
      while (i + 1 < lines.length && lines[i + 1]!.match(/^\s+\S/)) {
        i++;
      }
    } else if (key === "author") {
      fm.author = parseNestedBlock(lines, i) as unknown as SkillAuthor;
      while (i + 1 < lines.length && lines[i + 1]!.match(/^\s+\S/)) {
        i++;
      }
    }

    i++;
  }

  return { frontmatter: fm, body };
}

function parseNestedBlock(
  lines: string[],
  startIdx: number,
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  let i = startIdx + 1;
  while (i < lines.length && lines[i]!.match(/^\s+\S/)) {
    const nestedMatch = lines[i]!.match(/^\s+([\w][\w-]*):\s*(.*)/);
    if (nestedMatch) {
      const val = nestedMatch[2]!.trim();
      if (val === "true") {
        result[nestedMatch[1]!] = true;
      } else if (val === "false") {
        result[nestedMatch[1]!] = false;
      } else {
        result[nestedMatch[1]!] = unquote(val);
      }
    }
    i++;
  }
  return result;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize a SkillFrontmatter and body back into SKILL.md content.
 * Field order: name, description, agents (inline), workflow, origin, author.
 */
export function serializeFrontmatter(
  fm: SkillFrontmatter,
  body: string,
): string {
  const lines: string[] = [];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${fm.description}`);

  // Agents in inline format
  const agentsStr = fm.agents.join(", ");
  lines.push(`agents: [${agentsStr}]`);

  if (fm.workflow) {
    lines.push(`workflow: ${fm.workflow}`);
  }

  if (fm.origin) {
    lines.push("origin:");
    serializeNested(lines, fm.origin);
  }

  if (fm.author) {
    lines.push("author:");
    serializeNested(lines, fm.author);
  }

  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function serializeNested(
  lines: string[],
  obj: SkillOrigin | SkillAuthor,
): void {
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    lines.push(`  ${key}: ${String(val)}`);
  }
}

/**
 * Read and parse a SKILL.md file.
 */
export function readSkillMd(path: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const content = readFileSync(path, "utf-8");
  return parseFrontmatter(content);
}

/**
 * Write a SKILL.md file with the given frontmatter and body.
 */
export function writeSkillMd(
  path: string,
  fm: SkillFrontmatter,
  body: string,
): void {
  writeFileSync(path, serializeFrontmatter(fm, body), "utf-8");
}

/**
 * Remove the `origin:` block (and all its indented children) from
 * frontmatter content, used for content-hash computation.
 */
export function stripOriginBlock(content: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) return content;

  const before = fmMatch[1]!;
  const yaml = fmMatch[2]!;
  const after = fmMatch[3]!;
  const body = fmMatch[4]!;

  // Remove "origin:" line and all subsequent indented lines
  const lines = yaml.split("\n");
  const filtered: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (skipping) {
      if (line.match(/^\s+\S/)) {
        continue; // indented child of origin
      }
      skipping = false;
    }
    if (line.match(/^origin:\s*$/)) {
      skipping = true;
      continue;
    }
    // Also match "origin:" with inline value (shouldn't happen but be safe)
    if (line.match(/^origin:\s+\S/)) {
      continue;
    }
    filtered.push(line);
  }

  return before + filtered.join("\n") + after + body;
}
