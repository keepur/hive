/**
 * Transform an absolute filesystem path into the Claude Code harness's
 * project-directory slug, e.g. /Users/alice/projects/my_app → -Users-alice-projects-my-app.
 *
 * Empirically derived from `ls ~/.claude/projects/` listings:
 *   /Users/alice                           → -Users-alice
 *   /Users/alice/projects/my_app           → -Users-alice-projects-my-app
 *   /Users/alice/github/hive-115           → -Users-alice-github-hive-115
 *   /Users/alice/services/hive             → -Users-alice-services-hive
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
