#!/usr/bin/env node

/**
 * Memory MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to read, write, and list their own memory files.
 *
 * Env vars:
 *   AGENT_ID         — the agent's ID (e.g. "chief-of-staff")
 *   MEMORY_REPO_PATH — absolute path to the hive-memory repo
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname, resolve, normalize } from "node:path";
import { execSync } from "node:child_process";

const AGENT_ID = process.env.AGENT_ID ?? "";
const REPO_PATH = process.env.MEMORY_REPO_PATH ?? "";

if (!AGENT_ID || !REPO_PATH) {
  process.stderr.write("memory-mcp-server: AGENT_ID and MEMORY_REPO_PATH are required\n");
  process.exit(1);
}

// Agents can access their own directory and shared/
const ALLOWED_PREFIXES = [`agents/${AGENT_ID}/`, "shared/"];

function isAllowed(path: string): boolean {
  const normalized = normalize(path).replace(/\\/g, "/");
  if (normalized.includes("..")) return false;
  return ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function git(command: string): string {
  try {
    return execSync(`git -C "${REPO_PATH}" ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
  } catch {
    return "";
  }
}

const server = new McpServer({
  name: "hive-memory",
  version: "0.1.0",
});

server.registerTool("memory_read", {
  title: "Read Memory",
  description: `Read a file from your memory. Your files are under "agents/${AGENT_ID}/". Shared files are under "shared/".`,
  inputSchema: {
    path: z.string().describe('Relative path, e.g. "agents/' + AGENT_ID + '/memory.md" or "shared/contacts.md"'),
  },
}, async ({ path }) => {
  if (!isAllowed(path)) {
    return { content: [{ type: "text", text: `Access denied: you can only access agents/${AGENT_ID}/ and shared/` }], isError: true };
  }

  try {
    const fullPath = join(REPO_PATH, path);
    const content = await readFile(fullPath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch {
    return { content: [{ type: "text", text: `File not found: ${path}` }], isError: true };
  }
});

server.registerTool("memory_write", {
  title: "Write Memory",
  description: `Write content to a memory file. Automatically commits and pushes. Your files are under "agents/${AGENT_ID}/".`,
  inputSchema: {
    path: z.string().describe('Relative path, e.g. "agents/' + AGENT_ID + '/memory.md"'),
    content: z.string().describe("The full content to write to the file"),
  },
}, async ({ path, content }) => {
  if (!isAllowed(path)) {
    return { content: [{ type: "text", text: `Access denied: you can only write to agents/${AGENT_ID}/ and shared/` }], isError: true };
  }

  try {
    const fullPath = join(REPO_PATH, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");

    // Git commit and push
    git("add -A");
    const status = git("status --porcelain");
    if (status) {
      git(`commit -m "${AGENT_ID}: update ${path}"`);
      git("push");
    }

    return { content: [{ type: "text", text: `Written and pushed: ${path}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to write: ${String(err)}` }], isError: true };
  }
});

server.registerTool("memory_list", {
  title: "List Memory Files",
  description: `List files in a memory directory. Defaults to your own agent directory.`,
  inputSchema: {
    path: z.string().optional().describe(`Directory to list, defaults to "agents/${AGENT_ID}/"`),
  },
}, async ({ path }) => {
  const dir = path || `agents/${AGENT_ID}/`;

  if (!isAllowed(dir.endsWith("/") ? dir : dir + "/")) {
    return { content: [{ type: "text", text: `Access denied: you can only list agents/${AGENT_ID}/ and shared/` }], isError: true };
  }

  try {
    const fullPath = join(REPO_PATH, dir);
    const entries = await readdir(fullPath);

    const results: string[] = [];
    for (const entry of entries) {
      const entryPath = join(fullPath, entry);
      const s = await stat(entryPath);
      results.push(s.isDirectory() ? `${entry}/` : entry);
    }

    return { content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "(empty directory)" }] };
  } catch {
    return { content: [{ type: "text", text: `Directory not found: ${dir}` }], isError: true };
  }
});

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
