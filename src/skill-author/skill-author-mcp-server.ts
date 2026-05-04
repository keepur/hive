#!/usr/bin/env node

/**
 * Skill-Author MCP Server (KPR-104).
 *
 * Exposes a single tool — `author_skill` — that writes a SKILL.md to the
 * calling agent's per-agent skills directory:
 *
 *   <HIVE_HOME>/agents/<AGENT_ID>/skills/<slug>/skills/<slug>/SKILL.md
 *
 * The doubled <slug> is intentional: KPR-75's loader (scanWorkflowsFrom in
 * src/agents/skill-loader.ts) treats every skill source as
 * <root>/<workflow>/skills/<X>/SKILL.md, and agent-private is no exception.
 * One author_skill call = one user-facing skill, so we name the workflow
 * and the skill identically.
 *
 * Per-agent skills directory is the 4th skill source introduced by KPR-75
 * (`src/agents/skill-loader.ts`, `src/paths.ts:agentSkillsDir`). The
 * `agentsDir` watcher in `src/index.ts` picks up new SKILL.md files on the
 * next session spawn — no extra hot-reload wiring needed here.
 *
 * Always-on: this server is added to every agent's allowlist in
 * `agent-runner.ts:filterCoreServers` regardless of declared coreServers.
 * No permission flag; no opt-in/opt-out. See KPR-104 spec.
 *
 * Slug validation is code-correctness, not gating: the regex
 * `/^[a-z0-9][a-z0-9-]*$/` rejects every path-traversal vector
 * (../, /, \, .., ., null bytes, dots, slashes) by construction, so
 * `path.join` only ever sees a validated leaf segment.
 *
 * Env vars (set by agent-runner.ts):
 *   AGENT_ID  — the calling agent's id
 *   HIVE_HOME — instance home (resolved by src/paths.ts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Slug regex — lowercase alphanumeric + hyphens, no leading hyphen, non-empty. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Tool description. Embedded SKILL.md format reference (AC #4) — agents read
 * tool descriptions natively (KPR-87 toolkit visibility).
 */
export const AUTHOR_SKILL_DESCRIPTION = [
  "Author a private skill that becomes part of your toolkit on the next session.",
  "",
  "Writes a SKILL.md under your per-agent skills tree at",
  "<HIVE_HOME>/agents/<your-agent-id>/skills/<skillName>/skills/<skillName>/SKILL.md.",
  "(The nested layout is the engine's loader contract; you don't have to think",
  "about it — you pick the skillName and your skill is named that.)",
  "",
  "skillName must match /^[a-z0-9][a-z0-9-]*$/ — lowercase alphanumeric plus",
  "hyphens, must start with a letter or digit. (This is a code constraint, not",
  "a permission gate: it keeps the path safe to construct.)",
  "",
  "content is the full SKILL.md body — frontmatter + markdown. Pass it as-is;",
  "the loader handles malformed frontmatter on next session spawn.",
  "",
  "SKILL.md format:",
  "",
  "    ---",
  "    name: my-skill",
  "    description: One-line summary the model uses to decide when to invoke.",
  "    ---",
  "",
  "    ## When to use",
  "",
  "    Bullet the trigger conditions.",
  "",
  "    ## Instructions",
  "",
  "    Step-by-step. Reference any helper scripts or templates you also dropped",
  "    into this skill's directory.",
  "",
  "Notes:",
  "  - Do NOT include `agents:` in frontmatter. The path is the source of truth",
  "    for agent-private skills; declaring `agents:` is rejected by the loader.",
  "  - Last-writer-wins on identical skillName.",
  "  - The skill loads on the next session spawn (the engine watches your",
  "    agents/ tree).",
].join("\n");

/**
 * Pure handler — exported for unit tests. Returns the SDK content+isError
 * shape. No process.env reads; caller injects agentId and hiveHome.
 */
export function authorSkill(
  args: { skillName: string; content: string },
  deps: { agentId: string | undefined; hiveHome: string | undefined },
): { content: { type: "text"; text: string }[]; isError?: true } {
  if (!deps.agentId || deps.agentId.trim() === "") {
    return {
      content: [
        {
          type: "text",
          text: "AGENT_ID env not set — refusing to write (would land in the wrong agent's skills/).",
        },
      ],
      isError: true,
    };
  }
  if (!deps.hiveHome || deps.hiveHome.trim() === "") {
    return {
      content: [{ type: "text", text: "HIVE_HOME env not set — refusing to write." }],
      isError: true,
    };
  }
  if (!SLUG_RE.test(args.skillName)) {
    return {
      content: [
        {
          type: "text",
          text:
            `skillName=${JSON.stringify(args.skillName)} does not match /^[a-z0-9][a-z0-9-]*$/. ` +
            "Use lowercase alphanumeric plus hyphens, no leading hyphen, no slashes, no dots.",
        },
      ],
      isError: true,
    };
  }

  // Slug is regex-validated — every path component is a known-safe leaf.
  // Layout: <home>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md per
  // KPR-75 loader contract. Workflow dir and skill dir share the slug.
  const skillDir = join(
    resolve(deps.hiveHome),
    "agents",
    deps.agentId,
    "skills",
    args.skillName,
    "skills",
    args.skillName,
  );
  const skillMd = join(skillDir, "SKILL.md");

  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillMd, args.content, { encoding: "utf-8" });
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to write ${skillMd}: ${String(err)}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Wrote ${skillMd}. The skill becomes available on your next session spawn ` +
          "(the engine's agents/ watcher refreshes the skill index automatically).",
      },
    ],
  };
}

// --- Server entry ---

const server = new McpServer({
  name: "hive-skill-author",
  version: "0.1.0",
});

server.registerTool(
  "author_skill",
  {
    title: "Author a private skill",
    description: AUTHOR_SKILL_DESCRIPTION,
    inputSchema: {
      skillName: z.string().describe("Slug for the skill directory. Must match /^[a-z0-9][a-z0-9-]*$/."),
      content: z.string().describe("Full SKILL.md content — frontmatter (name + description) plus markdown body."),
    },
  },
  async ({ skillName, content }) => {
    return authorSkill({ skillName, content }, { agentId: process.env.AGENT_ID, hiveHome: process.env.HIVE_HOME });
  },
);

// Only connect transport when invoked as a process — the test imports the
// module to call `authorSkill` directly without spawning stdio.
if (process.env.NODE_ENV !== "test" && !process.env.HIVE_SKILL_AUTHOR_NO_TRANSPORT) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("skill-author MCP server failed to start:", err);
    process.exit(1);
  });
}
