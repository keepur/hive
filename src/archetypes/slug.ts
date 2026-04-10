/**
 * Transform an absolute filesystem path into the Claude Code harness's
 * project-directory slug, e.g. /Users/mokie/dev/dodi_v2 → -Users-mokie-dev-dodi-v2.
 *
 * Empirically derived from `ls ~/.claude/projects/` listings (Spike C):
 *   /Users/mokie                           → -Users-mokie
 *   /Users/mokie/dev/dodi_v2               → -Users-mokie-dev-dodi-v2
 *   /Users/mokie/github/hive-115           → -Users-mokie-github-hive-115
 *   /Users/mokie/services/hive             → -Users-mokie-services-hive
 *
 * Rules:
 *  - Input must be an absolute path (leading "/"). Throws otherwise.
 *  - Trailing slashes are stripped.
 *  - Every `/`, `_`, and `.` becomes `-` (so a leading `/` yields a leading `-`).
 *  - Alphanumerics and existing `-` are preserved.
 *  - Consecutive separators collapse into a single `-`.
 *
 * This function is the source of truth for workshopSlug/workspaceSlug in Layer 2.
 */
export function claudeProjectSlug(absPath: string): string {
  if (typeof absPath !== "string" || !absPath.startsWith("/")) {
    throw new Error(`claudeProjectSlug: path must be absolute, got ${String(absPath)}`);
  }
  const trimmed = absPath.replace(/\/+$/, "");
  // Replace / _ . with - then collapse runs of -
  return trimmed.replace(/[/_.]/g, "-").replace(/-+/g, "-");
}
