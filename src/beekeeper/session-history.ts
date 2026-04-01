import { readdir, stat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../logging/logger.js";

const log = createLogger("beekeeper-session-history");

const MAX_SESSIONS = 50;
const MAX_PREVIEW_CHARS = 200;
/** How many lines to scan before giving up on finding a user message */
const MAX_SCAN_LINES = 20;
/** Skip Beekeeper's inaugural prompt */
const BEEKEEPER_INIT_PROMPT = "You are now connected. Briefly acknowledge readiness.";

export interface WorkspaceSession {
  sessionId: string;
  lastActiveAt: string; // ISO timestamp
  preview: string;
}

/**
 * Convert an absolute filesystem path to Claude Code's project key.
 * /Users/mokie/github/hive → -Users-mokie-github-hive
 */
export function pathToProjectKey(absolutePath: string): string {
  return absolutePath.replace(/\//g, "-");
}

/**
 * Extract the first real user message from a session JSONL file.
 * Skips the Beekeeper init prompt ("You are now connected...").
 * Returns null if no user message found within MAX_SCAN_LINES.
 */
async function extractPreview(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stream = handle.createReadStream({ encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineCount = 0;
    let result: string | null = null;
    try {
      for await (const line of rl) {
        if (++lineCount > MAX_SCAN_LINES) break;
        if (!line.startsWith("{")) continue;

        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user") continue;

          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;

          const textBlock = content.find((b: { type: string }) => b.type === "text");
          if (!textBlock?.text) continue;

          // Skip Beekeeper's init prompt — grab the next real message
          if (textBlock.text === BEEKEEPER_INIT_PROMPT) continue;

          const text = textBlock.text as string;
          result = text.length > MAX_PREVIEW_CHARS ? text.slice(0, MAX_PREVIEW_CHARS) + "..." : text;
          break;
        } catch {
          // Malformed JSON line, skip
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return result;
  } catch {
    // File read error
  } finally {
    await handle?.close();
  }
  return null;
}

/**
 * List resumable sessions for a workspace path.
 * Scans ~/.claude/projects/{project-key}/ for .jsonl files.
 */
export async function listWorkspaceSessions(
  absolutePath: string,
  activeSessionIds: Set<string>,
): Promise<(WorkspaceSession & { active: boolean })[]> {
  const projectKey = pathToProjectKey(absolutePath);
  const projectDir = join(homedir(), ".claude", "projects", projectKey);

  // Verify projectDir resolves inside ~/.claude/projects/
  const expectedBase = join(homedir(), ".claude", "projects");
  try {
    const resolved = await realpath(projectDir);
    if (!resolved.startsWith(expectedBase + "/")) return [];
  } catch {
    // Directory doesn't exist
    return [];
  }

  let entries;
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));

  // Stat all files in parallel for mtime
  const fileInfos = await Promise.all(
    jsonlFiles.map(async (filename) => {
      const filePath = join(projectDir, filename);
      try {
        const s = await stat(filePath);
        return {
          sessionId: filename.replace(".jsonl", ""),
          filePath,
          mtime: s.mtime,
        };
      } catch {
        return null;
      }
    }),
  );

  // Sort by mtime descending, take top N
  const sorted = fileInfos
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, MAX_SESSIONS);

  // Extract previews in parallel
  const sessions = await Promise.all(
    sorted.map(async (info) => {
      const preview = await extractPreview(info.filePath);
      return {
        sessionId: info.sessionId,
        lastActiveAt: info.mtime.toISOString(),
        preview: preview ?? "(no preview)",
        active: activeSessionIds.has(info.sessionId),
      };
    }),
  );

  log.info("Listed workspace sessions", {
    projectKey,
    total: jsonlFiles.length,
    returned: sessions.length,
  });

  return sessions;
}
