/**
 * Memory MCP Server — Anthropic native memory-tool contract over MongoDB.
 *
 * KPR-327: the legacy FS-style tools (memory_read/write/list) are replaced by
 * the native `memory_20250818` six-command contract — view / create /
 * str_replace / insert / delete / rename — served as an in-process MCP server
 * (the Agent SDK's query() path has no surface for registering the native
 * tool type; see KPR-327 spec). The two hive extension tools
 * (memory_history, memory_rollback) are preserved unchanged in behavior.
 *
 * Storage is unchanged: Mongo `memory` (path → content) + `memory_versions`
 * snapshots. All tool paths live under a virtual `/memories` mount:
 *   /memories/agents/<agentId>/…  → Mongo path agents/<agentId>/…
 *   /memories/shared/…            → Mongo path shared/…
 *   /memories/scopes/<scopeId>/…  → ScopeRouter filesystem scope (parity
 *       subset only: view/create/str_replace/insert via FsMemoryStore's
 *       read/list/write; delete/rename/history/rollback are not supported)
 *
 * KPR-122 lineage: in-process via `createSdkMcpServer`; handlers close over
 * the shared engine `Db`. KPR-183: no stdio shim in this file. KPR-213: every
 * mutating command fires `deps.onWrite(path, reason)` for prefix-cache
 * invalidation.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";
import { ScopeRouter, type ScopeList } from "./memory-scope.js";

export interface MemoryToolDeps {
  db: Db;
  agentId: string;
  /**
   * Filesystem-backed scopes (the engine's archetype layer adds these); the
   * always-present "self" Mongo scope is implicit and does not need to appear
   * in this list.
   */
  memoryScopes: ScopeList;
  /**
   * KPR-213: optional invalidation hook. Fired after any successful mutation
   * of the agent's Mongo memory (create, str_replace, insert, delete, rename,
   * memory_rollback). The handler inspects the path and invalidates either a
   * single agent or all agents (constitution edits affect every prefix).
   */
  onWrite?: (path: string, reason: string) => void;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Native contract: text views are truncated past this many characters. */
const VIEW_TRUNCATE_CHARS = 16000;
/**
 * KPR-328 verdict §1 captures the 16,000-char threshold but no literal notice
 * string from the native contract; this is hive's concrete rendering.
 */
const TRUNCATION_NOTICE = "\n[Output truncated at 16,000 characters — use view_range to view the rest of the file.]";
/** Exact legacy wording — carried forward unchanged (pre-KPR-327 lines 261/314). */
const FS_HISTORY_ERROR = "history/rollback not supported for filesystem scopes — use git or equivalent";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function buildMemoryTools(deps: MemoryToolDeps) {
  const { db, agentId } = deps;
  const collection = db.collection("memory");
  const versions = db.collection("memory_versions");

  const ALLOWED_PREFIXES = [`agents/${agentId}/`, "shared/"];
  function isAllowed(path: string): boolean {
    if (path.includes("..")) return false;
    return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  // Filesystem scopes only — "self" stays implicit and is not part of the router.
  const fsScopes = (deps.memoryScopes ?? []).filter((s) => s.id !== "self");
  const router = new ScopeRouter(fsScopes);
  const MOUNT_ROOTS = [`agents/${agentId}`, "shared"];

  // ── Path resolution ────────────────────────────────────────────────

  type Resolved =
    | { kind: "root" }
    | { kind: "scopes-root" }
    | { kind: "mongo"; path: string; isMountRoot: boolean }
    | { kind: "fs"; scopeId: string; rel: string }
    | { kind: "denied"; message: string };

  /**
   * Canonicalize a raw tool path. Returns the stripped path relative to the
   * /memories mount ("" = mount root), or null when the path is rejected:
   * URL-encoded traversal/separators (%2e / %2f / %5c), backslash or plain
   * `..` traversal, or a path outside /memories.
   */
  function canonicalize(raw: string): string | null {
    if (/%2e|%2f|%5c/i.test(raw)) return null;
    let p = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    if (p.includes("..")) return null;
    if (p !== "/memories" && !p.startsWith("/memories/")) return null;
    return p === "/memories" ? "" : p.slice("/memories/".length);
  }

  function resolvePath(raw: string): Resolved {
    const stripped = canonicalize(raw);
    if (stripped === null) {
      return {
        kind: "denied",
        message: `Access denied: paths must start with /memories and must not contain traversal sequences (got: ${raw})`,
      };
    }
    if (stripped === "") return { kind: "root" };
    if (stripped === "scopes") return { kind: "scopes-root" };
    if (stripped.startsWith("scopes/")) {
      const rest = stripped.slice("scopes/".length);
      const slash = rest.indexOf("/");
      const scopeId = slash === -1 ? rest : rest.slice(0, slash);
      const rel = slash === -1 ? "" : rest.slice(slash + 1);
      const decl = router.get(scopeId);
      if (!decl || decl.backing !== "filesystem") {
        return {
          kind: "denied",
          message: `Unknown filesystem scope: ${scopeId}. Valid: ${router.scopeIds().join(", ") || "(none)"}`,
        };
      }
      return { kind: "fs", scopeId, rel };
    }
    if (MOUNT_ROOTS.includes(stripped)) return { kind: "mongo", path: stripped, isMountRoot: true };
    if (isAllowed(stripped)) return { kind: "mongo", path: stripped, isMountRoot: false };
    return {
      kind: "denied",
      message: `Access denied: you can only access /memories/agents/${agentId}/, /memories/shared/, and /memories/scopes/<scope>/`,
    };
  }

  // ── Mongo helpers ──────────────────────────────────────────────────

  interface MemoryDoc {
    path: string;
    content?: unknown;
    updatedAt?: unknown;
    updatedBy?: unknown;
  }

  async function snapshot(doc: MemoryDoc): Promise<void> {
    await versions.insertOne({
      path: doc.path,
      content: doc.content,
      savedAt: doc.updatedAt,
      savedBy: doc.updatedBy,
    });
  }

  async function upsertDoc(path: string, content: string): Promise<void> {
    await collection.updateOne(
      { path },
      { $set: { content, updatedAt: new Date(), updatedBy: agentId } },
      { upsert: true },
    );
  }

  async function docsUnder(prefixNoSlash: string): Promise<MemoryDoc[]> {
    const prefix = prefixNoSlash.endsWith("/") ? prefixNoSlash : prefixNoSlash + "/";
    const raw = await collection
      .find({ path: { $regex: `^${escapeRegex(prefix)}` } })
      .project({ path: 1, content: 1, updatedAt: 1, updatedBy: 1 })
      .toArray();
    return raw as unknown as MemoryDoc[];
  }

  // ── Rendering ──────────────────────────────────────────────────────

  function renderFileView(displayPath: string, content: string, viewRange?: number[]): ToolResult {
    const lines = content.split("\n");
    let start = 1;
    let end = lines.length;
    if (viewRange) {
      const [s, e] = viewRange;
      if (!Number.isInteger(s) || s < 1 || s > lines.length) {
        return fail(`Invalid view_range: start line ${s} is out of range 1..${lines.length}`);
      }
      if (e !== -1 && (!Number.isInteger(e) || e < s)) {
        return fail(`Invalid view_range: end line ${e} must be -1 or >= start line ${s}`);
      }
      start = s;
      end = e === -1 ? lines.length : Math.min(e, lines.length);
    }
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
      .join("\n");
    let text = `${displayPath}:\n${body}`;
    if (text.length > VIEW_TRUNCATE_CHARS) {
      text = text.slice(0, VIEW_TRUNCATE_CHARS) + TRUNCATION_NOTICE;
    }
    return ok(text);
  }

  /** Two-level directory listing over Mongo docs, tab-separated sizes (chars). */
  function renderMongoDirListing(displayPath: string, prefixNoSlash: string, docs: MemoryDoc[]): string {
    const prefix = prefixNoSlash + "/";
    const files = new Map<string, number>();
    const dirs = new Set<string>();
    for (const d of docs) {
      const rel = String(d.path).slice(prefix.length);
      const parts = rel.split("/");
      if (parts.length === 1) {
        files.set(rel, String(d.content ?? "").length);
      } else {
        dirs.add(`${parts[0]}/`);
        if (parts.length === 2) {
          files.set(rel, String(d.content ?? "").length);
        } else {
          dirs.add(`${parts[0]}/${parts[1]}/`);
        }
      }
    }
    const entries = [...[...dirs].sort(), ...[...files.keys()].sort().map((n) => `${n}\t${files.get(n)}`)];
    return `Directory: ${displayPath}\n${entries.join("\n")}`;
  }

  // ── fs-scope helpers (parity subset: read/list/write only) ────────

  function fsRead(scopeId: string, rel: string): string | null {
    return router.requireFs(scopeId).read(rel);
  }

  // ── Shared read for str_replace / insert ───────────────────────────

  async function readForEdit(
    r: Resolved,
    rawPath: string,
  ): Promise<{ content: string; write: (next: string, reason: string) => Promise<void> } | ToolResult> {
    if (r.kind === "denied") return fail(r.message);
    if (r.kind === "root" || r.kind === "scopes-root") return fail(`Invalid path: ${rawPath} is a directory`);
    if (r.kind === "fs") {
      if (!r.rel) return fail(`Invalid path: ${rawPath} is a directory`);
      const body = fsRead(r.scopeId, r.rel);
      if (body === null) return fail(`File not found: ${rawPath}`);
      const { scopeId, rel } = r;
      return {
        content: body,
        write: async (next) => {
          // Existing file — do not touch the MEMORY.md index (null indexLine).
          router.requireFs(scopeId).write(rel, next, null);
        },
      };
    }
    if (r.isMountRoot) return fail(`Invalid path: ${rawPath} is a directory`);
    const doc = (await collection.findOne({ path: r.path })) as MemoryDoc | null;
    if (!doc) return fail(`File not found: ${rawPath}`);
    const path = r.path;
    return {
      content: String(doc.content ?? ""),
      write: async (next, reason) => {
        await snapshot(doc);
        await upsertDoc(path, next);
        deps.onWrite?.(path, reason);
      },
    };
  }

  // ── Tools ──────────────────────────────────────────────────────────

  return [
    tool(
      "view",
      `View the contents of a memory file or list the contents of a memory directory. All memory paths start with /memories. Your mounts: /memories/agents/${agentId}/ (private), /memories/shared/ (team-shared)${router.scopeIds().length > 0 ? `, /memories/scopes/{${router.scopeIds().join("|")}}/ (filesystem scopes)` : ""}. Directories list two levels deep with file sizes; files render with 1-indexed line numbers. Use view_range to read a slice of a large file.`,
      {
        path: z.string().describe(`Path to view, e.g. "/memories" or "/memories/agents/${agentId}/notes.md"`),
        view_range: z
          .array(z.number().int())
          .length(2)
          .optional()
          .describe("Optional [start_line, end_line] (1-indexed, inclusive); end_line -1 means end of file"),
      },
      async ({ path, view_range }) => {
        try {
          const r = resolvePath(path);
          if (r.kind === "denied") return fail(r.message);
          if (r.kind === "root") {
            const lines = [
              "Directory: /memories",
              `agents/${agentId}/`,
              "shared/",
              ...router.scopeIds().map((id) => `scopes/${id}/`),
            ];
            return ok(lines.join("\n"));
          }
          if (r.kind === "scopes-root") {
            const ids = router.scopeIds();
            if (ids.length === 0) return ok("Directory: /memories/scopes\n(empty directory)");
            return ok(`Directory: /memories/scopes\n${ids.map((id) => `${id}/`).join("\n")}`);
          }
          if (r.kind === "fs") {
            const store = router.requireFs(r.scopeId);
            if (!r.rel) {
              const names = store.list();
              if (names.length === 0) return ok(`Directory: ${path}\n(empty directory)`);
              const entries = names.map((n) => `${n}\t${(store.read(n) ?? "").length}`);
              return ok(`Directory: /memories/scopes/${r.scopeId}\n${entries.join("\n")}`);
            }
            const body = store.read(r.rel);
            if (body === null) return fail(`File not found: ${path}`);
            return renderFileView(`/memories/scopes/${r.scopeId}/${r.rel}`, body, view_range);
          }
          // Mongo mount
          if (!r.isMountRoot) {
            const doc = (await collection.findOne({ path: r.path })) as MemoryDoc | null;
            if (doc) return renderFileView(`/memories/${r.path}`, String(doc.content ?? ""), view_range);
          }
          if (view_range) return fail("view_range is not supported for directory listings");
          const docs = await docsUnder(r.path);
          if (docs.length === 0) {
            if (r.isMountRoot) return ok(`Directory: /memories/${r.path}\n(empty directory)`);
            return fail(`Path not found: ${path}`);
          }
          return ok(renderMongoDirListing(`/memories/${r.path}`, r.path, docs));
        } catch (err) {
          return fail(`view error: ${String(err)}`);
        }
      },
    ),
    tool(
      "create",
      `Create or overwrite a memory file with the given content. Paths start with /memories (e.g. "/memories/agents/${agentId}/notes.md"). Overwriting snapshots the prior version (recoverable via memory_history / memory_rollback).`,
      {
        path: z.string().describe("File path to create or overwrite"),
        file_text: z.string().describe("Full content of the file"),
      },
      async ({ path, file_text }) => {
        try {
          const r = resolvePath(path);
          if (r.kind === "denied") return fail(r.message);
          if (r.kind === "root" || r.kind === "scopes-root") {
            return fail(`Invalid path for create: ${path} is a directory`);
          }
          if (r.kind === "fs") {
            if (!r.rel) return fail(`Invalid path for create: ${path} is a directory`);
            const store = router.requireFs(r.scopeId);
            const indexLine = `- [${r.rel.replace(/\.md$/, "")}](${r.rel}) — (updated by ${agentId})`;
            store.write(r.rel, file_text, indexLine);
            return ok(`File created: ${path}`);
          }
          if (r.isMountRoot) return fail(`Invalid path for create: ${path} is a directory`);
          const existing = (await collection.findOne({ path: r.path })) as MemoryDoc | null;
          if (existing) await snapshot(existing);
          await upsertDoc(r.path, file_text);
          deps.onWrite?.(r.path, "memory-mcp-create");
          return ok(`File created: ${path}`);
        } catch (err) {
          return fail(`create error: ${String(err)}`);
        }
      },
    ),
    tool(
      "str_replace",
      "Replace a unique occurrence of old_str in a memory file with new_str. Omit new_str to delete old_str. Errors if old_str is not found or is not unique in the file.",
      {
        path: z.string().describe("File path"),
        old_str: z.string().describe("Exact text to replace — must appear exactly once in the file"),
        new_str: z.string().optional().describe("Replacement text; omit to delete old_str"),
      },
      async ({ path, old_str, new_str }) => {
        try {
          if (old_str === "") {
            return fail("No replacement was performed: old_str must be non-empty");
          }
          const r = resolvePath(path);
          const target = await readForEdit(r, path);
          if ("isError" in target || "content" in target === false) return target as ToolResult;
          if (!("write" in target)) return target as ToolResult;
          const occurrences = target.content.split(old_str).length - 1;
          if (occurrences === 0) {
            return fail(`No replacement was performed: old_str was not found in ${path}`);
          }
          if (occurrences > 1) {
            return fail(
              `No replacement was performed: found ${occurrences} occurrences of old_str in ${path} — old_str must be unique`,
            );
          }
          // Literal splice — String.prototype.replace processes $$, $&, $`, $' in the
          // replacement string, which would silently corrupt content containing those
          // sequences. Uniqueness is already enforced above, so split/join is exact.
          const next = target.content.split(old_str).join(new_str ?? "");
          await target.write(next, "memory-mcp-str_replace");
          return ok(`The file ${path} has been edited`);
        } catch (err) {
          return fail(`str_replace error: ${String(err)}`);
        }
      },
    ),
    tool(
      "insert",
      "Insert text into a memory file after the given line number. insert_line 0 inserts at the beginning of the file.",
      {
        path: z.string().describe("File path"),
        insert_line: z.number().int().min(0).describe("Line number to insert after (0 = beginning of file)"),
        insert_text: z.string().describe("Text to insert"),
      },
      async ({ path, insert_line, insert_text }) => {
        try {
          const r = resolvePath(path);
          const target = await readForEdit(r, path);
          if (!("write" in target)) return target as ToolResult;
          const lines = target.content.split("\n");
          if (insert_line > lines.length) {
            return fail(`Invalid insert_line ${insert_line}: must be between 0 and ${lines.length}`);
          }
          const toInsert = insert_text.endsWith("\n") ? insert_text.slice(0, -1).split("\n") : insert_text.split("\n");
          lines.splice(insert_line, 0, ...toInsert);
          await target.write(lines.join("\n"), "memory-mcp-insert");
          return ok(`Inserted ${toInsert.length} line(s) after line ${insert_line} in ${path}`);
        } catch (err) {
          return fail(`insert error: ${String(err)}`);
        }
      },
    ),
    tool(
      "delete",
      "Delete a memory file, or a directory recursively. The /memories root and the mount roots cannot be deleted. Not supported on filesystem scopes. Deleted files are snapshotted and recoverable via memory_history / memory_rollback.",
      {
        path: z.string().describe("File or directory path to delete"),
      },
      async ({ path }) => {
        try {
          const r = resolvePath(path);
          if (r.kind === "denied") return fail(r.message);
          if (r.kind === "root") return fail("Cannot delete the /memories root");
          if (r.kind === "scopes-root" || r.kind === "fs") {
            return fail("delete not supported on filesystem scopes");
          }
          if (r.isMountRoot) return fail(`Cannot delete mount root: ${path}`);
          const doc = (await collection.findOne({ path: r.path })) as MemoryDoc | null;
          if (doc) {
            await snapshot(doc);
            await collection.deleteOne({ path: r.path });
            deps.onWrite?.(r.path, "memory-mcp-delete");
            return ok(`File deleted: ${path}`);
          }
          const children = await docsUnder(r.path);
          if (children.length === 0) return fail(`Path not found: ${path}`);
          for (const child of children) {
            await snapshot(child);
          }
          await collection.deleteMany({ path: { $regex: `^${escapeRegex(r.path + "/")}` } });
          for (const child of children) {
            deps.onWrite?.(String(child.path), "memory-mcp-delete");
          }
          return ok(`Deleted directory ${path} (${children.length} file(s))`);
        } catch (err) {
          return fail(`delete error: ${String(err)}`);
        }
      },
    ),
    tool(
      "rename",
      "Rename or move a memory file or directory. Root and mount roots cannot be renamed; the destination must not already exist. Not supported on filesystem scopes, and renames may not cross the Mongo/filesystem boundary. Version history remains keyed to the pre-rename path: after renaming a→b, use memory_history with the old path to view prior versions, and a memory_rollback of the old path recreates the file at the old path.",
      {
        old_path: z.string().describe("Current path"),
        new_path: z.string().describe("New path"),
      },
      async ({ old_path, new_path }) => {
        try {
          const src = resolvePath(old_path);
          const dst = resolvePath(new_path);
          if (src.kind === "denied") return fail(src.message);
          if (dst.kind === "denied") return fail(dst.message);
          if (src.kind === "root" || dst.kind === "root") {
            return fail("Cannot rename the /memories root");
          }
          if (src.kind === "fs" || dst.kind === "fs" || src.kind === "scopes-root" || dst.kind === "scopes-root") {
            return fail("rename not supported on filesystem scopes");
          }
          if (src.isMountRoot || dst.isMountRoot) {
            return fail("Cannot rename a mount root");
          }
          const destDoc = (await collection.findOne({ path: dst.path })) as MemoryDoc | null;
          const destChildren = await docsUnder(dst.path);
          if (destDoc || destChildren.length > 0) {
            return fail(`Cannot rename: destination ${new_path} already exists`);
          }
          const srcDoc = (await collection.findOne({ path: src.path })) as MemoryDoc | null;
          if (srcDoc) {
            await snapshot(srcDoc);
            await collection.updateOne(
              { path: src.path },
              { $set: { path: dst.path, updatedAt: new Date(), updatedBy: agentId } },
            );
            deps.onWrite?.(src.path, "memory-mcp-rename");
            deps.onWrite?.(dst.path, "memory-mcp-rename");
            return ok(`Renamed ${old_path} to ${new_path}`);
          }
          const children = await docsUnder(src.path);
          if (children.length === 0) return fail(`Path not found: ${old_path}`);
          for (const child of children) {
            const childOld = String(child.path);
            const childNew = dst.path + "/" + childOld.slice(src.path.length + 1);
            await snapshot(child);
            await collection.updateOne(
              { path: childOld },
              { $set: { path: childNew, updatedAt: new Date(), updatedBy: agentId } },
            );
            deps.onWrite?.(childOld, "memory-mcp-rename");
            deps.onWrite?.(childNew, "memory-mcp-rename");
          }
          return ok(`Renamed ${old_path} to ${new_path} (${children.length} file(s))`);
        } catch (err) {
          return fail(`rename error: ${String(err)}`);
        }
      },
    ),
    tool(
      "memory_history",
      "View previous versions of a memory file (hive extension beyond the native contract). Mongo mounts only.",
      {
        path: z.string().describe(`File path, e.g. "/memories/agents/${agentId}/notes.md"`),
        limit: z.number().optional().describe("Max versions to return (default 10)"),
      },
      async ({ path, limit }) => {
        try {
          const resolved = resolveHistoryPath(path);
          if ("error" in resolved) return fail(resolved.error);
          const history = await versions
            .find({ path: resolved.path })
            .sort({ savedAt: -1 })
            .limit(limit ?? 10)
            .toArray();
          if (history.length === 0) {
            return ok(`No version history for: ${path}`);
          }
          const lines = history.map((v, i) => {
            const savedAt = v.savedAt as unknown;
            const date = savedAt instanceof Date ? savedAt.toISOString() : String(savedAt);
            const by = v.savedBy ? ` by ${String(v.savedBy)}` : "";
            const body = typeof v.content === "string" ? v.content : String(v.content ?? "");
            const preview = body.slice(0, 100).replace(/\n/g, " ");
            return `[${i}] ${date}${by} (${body.length} chars)\n    ${preview}...`;
          });
          return ok(lines.join("\n\n"));
        } catch (err) {
          return fail(`memory_history error: ${String(err)}`);
        }
      },
    ),
    tool(
      "memory_rollback",
      "Restore a memory file to a previous version (hive extension). Mongo mounts only. Use memory_history first to find the version index.",
      {
        path: z.string().describe("File path to rollback"),
        version_index: z.number().describe("Version index from memory_history (0 = most recent previous version)"),
      },
      async ({ path, version_index }) => {
        try {
          const resolved = resolveHistoryPath(path);
          if ("error" in resolved) return fail(resolved.error);
          const mongoPath = resolved.path;
          const history = await versions
            .find({ path: mongoPath })
            .sort({ savedAt: -1 })
            .skip(version_index)
            .limit(1)
            .toArray();
          if (history.length === 0) {
            return fail(`Version ${version_index} not found for: ${path}`);
          }
          const target = history[0];
          const current = (await collection.findOne({ path: mongoPath })) as MemoryDoc | null;
          if (current) await snapshot(current);
          await collection.updateOne(
            { path: mongoPath },
            { $set: { content: target.content, updatedAt: new Date(), updatedBy: `${agentId}:rollback` } },
            { upsert: true },
          );
          // KPR-213: prefix cache invalidation for the agent-tool rollback path.
          deps.onWrite?.(mongoPath, "memory-mcp-rollback");
          const savedAt = target.savedAt as unknown;
          const date = savedAt instanceof Date ? savedAt.toISOString() : String(savedAt);
          return ok(`Rolled back ${path} to version from ${date}`);
        } catch (err) {
          return fail(`memory_rollback error: ${String(err)}`);
        }
      },
    ),
  ];

  /**
   * Resolve a history/rollback path to a Mongo path. Accepts the /memories
   * form (canonical post-KPR-327) and the bare legacy form
   * ("agents/<id>/…" / "shared/…") for backward compatibility with
   * DB-stored prompts that predate the cutover.
   */
  function resolveHistoryPath(raw: string): { path: string } | { error: string } {
    if (raw.startsWith("/")) {
      const r = resolvePath(raw);
      if (r.kind === "denied") return { error: r.message };
      if (r.kind === "fs" || r.kind === "scopes-root") return { error: FS_HISTORY_ERROR };
      if (r.kind === "root" || r.isMountRoot) return { error: `Invalid path: ${raw} is a directory` };
      return { path: r.path };
    }
    if (raw.startsWith("scopes/")) return { error: FS_HISTORY_ERROR };
    if (!isAllowed(raw)) {
      return { error: `Access denied: you can only access agents/${agentId}/ and shared/` };
    }
    return { path: raw };
  }
}

export function createMemoryMcpServer(deps: MemoryToolDeps) {
  return createSdkMcpServer({
    name: "memory",
    version: "0.3.0",
    tools: buildMemoryTools(deps),
  });
}
