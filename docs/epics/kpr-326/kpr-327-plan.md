# KPR-327: Memory Legacy Cutover — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace the legacy FS-style `memory` MCP tools (`memory_read/write/list`) with the Anthropic native memory-tool contract (`view/create/str_replace/insert/delete/rename`) served in-process over the same Mongo collections, keeping `memory_history`/`memory_rollback` as hive extensions, with zero data migration and zero agent-definition changes.

**Architecture:** `src/memory/memory-mcp-server.ts` is rewritten in place — same `createMemoryMcpServer` export, same `MemoryToolDeps`, same server key `"memory"` — mapping a virtual `/memories` mount onto the existing Mongo path space (`agents/<id>/…`, `shared/…`) and onto ScopeRouter filesystem scopes (`scopes/<id>/…`, parity subset only). `agent-runner.ts` drops the vestigial stdio placeholder (KPR-183 leftover) with two behavior-preserving compensations (plugin name-conflict guard, tool-transport inventory). `prefix-builder.ts` gains the manual "memory-first" block (§4.5) and updates the legacy fallback's `memory_read` reference to `view`.

**Tech Stack:** TypeScript strict, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), zod, MongoDB driver, vitest.

## Testing Contract

### Required Test Groups
- **Unit: required** — Scope: full command matrix of the rewritten server (guard, all six commands, both extension tools, fs-scope parity subset, snapshot/onWrite side effects) via a stateful fake Mongo `Db`; prefix-builder block presence/gating; agent-runner wiring invariants (memory in captured servers with db, tool-transport inventory, plugin-conflict rejection). Reason: the whole change is handler logic over an injected `Db` — unit tests exercise the real contract end to end. Minimum assertions: every test listed in Task 2 (spec §4.7 list is a strict subset).
- **Integration: not-required** — Scope: n/a. Reason: the server is in-process and takes `Db` by injection; the repo's test suite has no live-Mongo harness and the fake `Db` covers the exact driver calls used (`findOne/find/insertOne/updateOne/deleteOne/deleteMany`). Harness: none. Minimum assertions: n/a.
- **E2E: not-required** — Scope: n/a. Reason: no agent-spawn E2E harness exists in-repo; spec §7 explicitly defers behavior-fidelity validation ("agents actually use `view`/`str_replace` sensibly") to a qualitative live-instance check at rollout, outside this ticket's gates. Harness: none. Minimum assertions: n/a.

### Critical Flows
1. `create` → `view` round-trip on `/memories/agents/<id>/…` with line-numbered rendering.
2. Mutating command → `memory_versions` snapshot (same doc shape) → `deps.onWrite(path, reason)` fired with per-command reason.
3. Traversal/deny guard: non-`/memories` paths, `..`, `..\`, `%2e%2e`, cross-agent paths all rejected before any DB access.
4. Root/mount-root protection: `delete`/`rename` on `/memories`, `agents/<id>`, `shared` rejected (KPR-295 anti-wipe posture).
5. fs-scope parity subset works (`view/create/str_replace/insert`); `delete/rename/history/rollback` on scope paths return the not-supported errors.
6. `memory_rollback` restores a prior version, snapshots current first, fires `onWrite`.

### Regression Surface
- KPR-213 prefix-cache invalidation: `onWrite` must fire on every Mongo mutation (`create`, `str_replace`, `insert`, `delete`, `rename` — both paths —, `memory_rollback`); `invalidatePrefixCacheByMemoryPath` itself is untouched.
- Agent-runner: `IN_PROCESS_PORTED_SERVERS`, structured-memory auto-pairing, `effectiveCoreServerSet`, delegate handling — all untouched; only the placeholder removal + its two compensations change. Existing test `agent-runner.test.ts:1163` (memory in tool-transport inventory) must keep passing.
- Prefix-builder: hot-tier injection path (`getHotTierPrompt`) untouched; existing prefix-builder tests must keep passing unmodified.
- No changes to `structured-memory-mcp-server.ts`, `memory-store.ts`, `memory-lifecycle*.ts`, `memory-manager.ts`, `fs-memory-store.ts`, `memory-scope.ts`, `tool-transport.ts`, `prefix-invalidation.ts`.

### Commands
```bash
# Targeted (per task):
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/memory/memory-mcp-server.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/prefix-builder.test.ts
# Full gate (before submit):
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

### Harness Requirements
None beyond vitest. The fs-scope tests create a real temp directory (`mkdtempSync(join(tmpdir(), "kpr327-"))`) because `FsMemoryStore` requires an absolute path; clean up in `afterEach`.

### Non-Required Rationale
Integration/E2E: covered above — no live-Mongo or agent-spawn harness exists in this repo's test suite; unit tests exercise the complete handler contract against the injected `Db` boundary, which is the entire runtime surface of this change. Live behavior-fidelity check is a rollout acceptance item per spec §7, not a CI gate.

### Verification Rules
- Every task ends with the exact vitest command(s) above passing; final task requires full `npm run check` green.
- Negative-verify (per operator feedback `feedback_negative_verify_regression_tests`): for the guard tests, temporarily weakening `canonicalize` (e.g. removing the `%2e` check) must make the traversal test fail — do this once during Task 2, confirm, restore.
- No `git commit` without the task's verify step output shown.

---

## Scope confirmations (read before implementing)

**§4.6 / tool-transport reading — confirmed, no code change.** Spec §4.6 says the six-command MCP server "is" the pilot-facing surface and closes with "No work in this ticket beyond that classification note." `src/agents/provider-adapters/tool-transport.ts` is NOT modified. Note: the existing classifier maps in-process servers to `requires-hive-bridge` (see existing test `agent-runner.test.ts:1183-1184`) — the spec's `mcp-bridge-candidate` phrasing is a forward-looking note about the eventual bridging design, not a directive to change classification in this ticket. Leave the classifier and its tests exactly as they are.

**agent-runner.ts — what stays untouched.** `createMemoryMcpServer` call site (send(), ~line 1530-1545), `IN_PROCESS_PORTED_SERVERS` (`src/agents/in-process-servers.ts` and its re-export), structured-memory auto-pairing (`filterCoreServers` line ~1016, `effectiveCoreServerSet` line ~359, stdio placeholder for `structured-memory` line ~480), `resolveMemoryScopes`, and `invalidatePrefixCacheByMemoryPath` wiring all stay exactly as-is. The ONLY agent-runner changes are: (a) delete the vestigial `servers["memory"]` stdio placeholder (lines ~454-477), (b) two behavior-preserving compensations forced by (a) — see Task 3 — and (c) comment updates at the two sites that describe the placeholder.

**Exact legacy wordings carried forward (quoted from current source):**
- fs-scope history/rollback error (memory-mcp-server.ts:261 and :314): `history/rollback not supported for filesystem scopes — use git or equivalent` — reused verbatim for `memory_history`/`memory_rollback` on scope paths.
- delete/rename on scope paths get the analogous new messages `delete not supported on filesystem scopes` / `rename not supported on filesystem scopes` (spec §5: "analogous 'not supported on filesystem scopes' message").

**Truncation wording.** Spec §5 cites "the exact wording from Anthropic's memory-tool documentation as captured in the KPR-328 verdict §1" — but verdict §1 captures only the *threshold*: "truncates text views >16,000 chars" (no literal notice string). This plan therefore fixes a concrete notice (constant `TRUNCATION_NOTICE` below) and flags it as an assumption. Do not go fishing for other wordings — use the constant.

---

### Task 1: Rewrite `memory-mcp-server.ts` — native six-command contract

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/memory/memory-mcp-server.ts` (full rewrite in place, lines 1-373)
- Test: covered in Task 2 (separate task so the server compiles first via typecheck)

- [ ] Step 1: Replace the entire file content with the following. Preserved verbatim from today: `MemoryToolDeps` interface, `escapeRegex`, `isAllowed` + `ALLOWED_PREFIXES` (base guard), snapshot doc shape `{path, content, savedAt, savedBy}`, the fs-scope history/rollback error string, `createMemoryMcpServer` export shape, server name `"memory"`.

```typescript
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
const TRUNCATION_NOTICE =
  "\n[Output truncated at 16,000 characters — use view_range to view the rest of the file.]";
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
          const next = target.content.replace(old_str, new_str ?? "");
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
          const toInsert = insert_text.endsWith("\n")
            ? insert_text.slice(0, -1).split("\n")
            : insert_text.split("\n");
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
      "Rename or move a memory file or directory. Root and mount roots cannot be renamed; the destination must not already exist. Not supported on filesystem scopes, and renames may not cross the Mongo/filesystem boundary.",
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
```

  Implementation notes for this step:
  - The `readForEdit` return-type narrowing (`"write" in target`) must typecheck under strict mode — if the union proves awkward, split into an explicit discriminated union `{ ok: true; content; write } | { ok: false; result: ToolResult }`. Functional behavior above is the contract; local type plumbing may be adjusted.
  - `resolveHistoryPath` is a function declaration after the `return` — hoisting makes this legal; move it above the `return` if lint complains.
  - Keep `escapeRegex`, `isAllowed`, snapshot shape, and `FS_HISTORY_ERROR` exactly as shown (behavior-preservation anchors).
- [ ] Step 2: Verify — `npx tsc --noEmit -p .` (or `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck`). Expected: zero errors in `src/memory/memory-mcp-server.ts`. The old test file will now fail to compile/run — that is expected until Task 2; do NOT run the full test suite yet.
- [ ] Step 3: Commit —
```bash
cd /Users/mokie/github/kpr-327-work
git add src/memory/memory-mcp-server.ts
git commit -m "KPR-327: rewrite memory MCP server to native six-command contract

view/create/str_replace/insert/delete/rename over /memories virtual mount
(Mongo agents/<id> + shared mounts, fs-scope parity subset), preserving
memory_history/memory_rollback, memory_versions snapshots, and KPR-213
onWrite invalidation. Same createMemoryMcpServer export, same server key.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Rewrite `memory-mcp-server.test.ts` for the new contract

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/memory/memory-mcp-server.test.ts` (full rewrite)

- [ ] Step 1: Replace the file with the following. The fake `Db` is upgraded to cover `deleteOne`/`deleteMany`/re-keying `updateOne` and content projection; fs-scope tests use a real temp dir (FsMemoryStore requires an absolute path).

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock SDK helpers so buildMemoryTools returns simple objects we can introspect.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

import { buildMemoryTools } from "./memory-mcp-server.js";

// ── Stateful fake Mongo Db ──────────────────────────────────────────
type Doc = Record<string, any>;
let memoryDocs: Map<string, Doc>;
let versionDocs: Doc[];

function regexMatches(filter: any, path: string): boolean {
  const pattern = filter?.path?.$regex;
  if (typeof pattern !== "string") return false;
  return new RegExp(pattern).test(path);
}

function makeFakeDb(): any {
  const memCol = {
    findOne: vi.fn(async (filter: any) => memoryDocs.get(filter.path) ?? null),
    find: vi.fn((filter: any) => {
      const matched = () =>
        filter?.path?.$regex
          ? [...memoryDocs.values()].filter((d) => regexMatches(filter, d.path))
          : [...memoryDocs.values()].filter((d) => d.path === filter?.path);
      return {
        project: vi.fn(() => ({ toArray: vi.fn(async () => matched().map((d) => ({ ...d }))) })),
        toArray: vi.fn(async () => matched().map((d) => ({ ...d }))),
      };
    }),
    insertOne: vi.fn(async () => ({ insertedId: "x" })),
    updateOne: vi.fn(async (filter: any, update: any, opts: any) => {
      const existing = memoryDocs.get(filter.path);
      if (!existing && !opts?.upsert) return { matchedCount: 0 };
      const doc = existing ?? { path: filter.path };
      Object.assign(doc, update.$set);
      // Re-key support (rename): $set.path moves the doc.
      memoryDocs.delete(filter.path);
      memoryDocs.set(doc.path, doc);
      return { matchedCount: 1 };
    }),
    deleteOne: vi.fn(async (filter: any) => {
      memoryDocs.delete(filter.path);
      return { deletedCount: 1 };
    }),
    deleteMany: vi.fn(async (filter: any) => {
      let n = 0;
      for (const key of [...memoryDocs.keys()]) {
        if (regexMatches(filter, key)) {
          memoryDocs.delete(key);
          n++;
        }
      }
      return { deletedCount: n };
    }),
  };
  const verCol = {
    insertOne: vi.fn(async (doc: any) => {
      versionDocs.push({ ...doc });
      return { insertedId: "v" };
    }),
    find: vi.fn((filter: any) => {
      const matched = versionDocs.filter((v) => v.path === filter.path);
      const chain = (rows: Doc[]) => ({
        sort: vi.fn(() => chain(rows)),
        skip: vi.fn((n: number) => chain(rows.slice(n))),
        limit: vi.fn((n: number) => chain(rows.slice(0, n))),
        toArray: vi.fn(async () => rows),
      });
      // Newest-first: versions are appended chronologically; reverse for sort({savedAt:-1}).
      return chain([...matched].reverse());
    }),
    findOne: vi.fn(async () => null),
    updateOne: vi.fn(async () => ({ matchedCount: 0 })),
    deleteOne: vi.fn(async () => ({ deletedCount: 0 })),
    deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
  };
  return { collection: (name: string) => (name === "memory" ? memCol : verCol) };
}

function seed(path: string, content: string): void {
  memoryDocs.set(path, { path, content, updatedAt: new Date("2026-01-01"), updatedBy: "seed" });
}

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function makeTools(opts: { onWrite?: (p: string, r: string) => void; scopes?: any[] } = {}) {
  return buildMemoryTools({
    db: makeFakeDb(),
    agentId: "alice",
    memoryScopes: opts.scopes ?? [],
    onWrite: opts.onWrite,
  });
}

beforeEach(() => {
  memoryDocs = new Map();
  versionDocs = [];
});

// ── Guard ───────────────────────────────────────────────────────────
describe("path guard", () => {
  it.each([
    "agents/alice/notes.md", // missing /memories prefix
    "/etc/passwd",
    "/memories/../etc/passwd",
    "/memories/agents/alice/../bob/x.md",
    "/memories/agents/alice/..\\..\\x.md",
    "/memories/agents/alice/%2e%2e/x.md",
    "/memories/%2e%2e/agents/alice/x.md",
  ])("view rejects %s", async (path) => {
    const view = getHandler(makeTools(), "view");
    const res = await view({ path });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Access denied/);
  });

  it("rejects cross-agent paths", async () => {
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories/agents/bob/private.md" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Access denied/);
  });

  it("denied paths never touch the DB (create)", async () => {
    const create = getHandler(makeTools(), "create");
    const res = await create({ path: "/memories/agents/bob/x.md", file_text: "hi" });
    expect(res.isError).toBe(true);
    expect(memoryDocs.size).toBe(0);
    expect(versionDocs.length).toBe(0);
  });
});

// ── view ────────────────────────────────────────────────────────────
describe("view", () => {
  it("empty /memories root lists mounts, not an error", async () => {
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("agents/alice/");
    expect(res.content[0].text).toContain("shared/");
  });

  it("renders file content with 6-wide right-aligned 1-indexed line numbers", async () => {
    seed("agents/alice/notes.md", "alpha\nbeta");
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories/agents/alice/notes.md" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("     1\talpha");
    expect(res.content[0].text).toContain("     2\tbeta");
  });

  it("supports view_range [start, end] and [start, -1]", async () => {
    seed("agents/alice/notes.md", "l1\nl2\nl3\nl4");
    const view = getHandler(makeTools(), "view");
    const mid = await view({ path: "/memories/agents/alice/notes.md", view_range: [2, 3] });
    expect(mid.content[0].text).toContain("     2\tl2");
    expect(mid.content[0].text).toContain("     3\tl3");
    expect(mid.content[0].text).not.toContain("l4");
    const tail = await view({ path: "/memories/agents/alice/notes.md", view_range: [3, -1] });
    expect(tail.content[0].text).toContain("     4\tl4");
    expect(tail.content[0].text).not.toContain("l1");
  });

  it("rejects out-of-range view_range", async () => {
    seed("agents/alice/notes.md", "only");
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories/agents/alice/notes.md", view_range: [5, 6] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/view_range/);
  });

  it("lists a directory two levels deep with tab-separated sizes", async () => {
    seed("agents/alice/notes.md", "12345");
    seed("agents/alice/projects/roadmap.md", "abc");
    seed("agents/alice/projects/deep/nested.md", "x");
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories/agents/alice" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("notes.md\t5");
    expect(text).toContain("projects/");
    expect(text).toContain("projects/roadmap.md\t3");
    expect(text).toContain("projects/deep/"); // level-2 dir shown, level-3 file collapsed
    expect(text).not.toContain("nested.md\t");
  });

  it("empty mount root lists as empty directory, not an error", async () => {
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories/shared" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("(empty directory)");
  });

  it("truncates oversize output at 16,000 chars with the truncation notice", async () => {
    seed("agents/alice/big.md", "x".repeat(20000));
    const view = getHandler(makeTools(), "view");
    const res = await view({ path: "/memories/agents/alice/big.md" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.length).toBeLessThan(16200);
    expect(res.content[0].text).toContain("truncated at 16,000 characters");
    expect(res.content[0].text).toContain("view_range");
  });
});

// ── create ──────────────────────────────────────────────────────────
describe("create", () => {
  it("creates a new file and fires onWrite with the create reason", async () => {
    const onWrite = vi.fn();
    const create = getHandler(makeTools({ onWrite }), "create");
    const res = await create({ path: "/memories/agents/alice/new.md", file_text: "hello" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.get("agents/alice/new.md")?.content).toBe("hello");
    expect(onWrite).toHaveBeenCalledWith("agents/alice/new.md", "memory-mcp-create");
    expect(versionDocs.length).toBe(0); // nothing prior to snapshot
  });

  it("overwrite snapshots the prior content first (same doc shape)", async () => {
    seed("agents/alice/x.md", "old");
    const create = getHandler(makeTools(), "create");
    await create({ path: "/memories/agents/alice/x.md", file_text: "new" });
    expect(versionDocs).toHaveLength(1);
    expect(versionDocs[0]).toMatchObject({ path: "agents/alice/x.md", content: "old", savedBy: "seed" });
    expect(versionDocs[0]).toHaveProperty("savedAt");
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("new");
  });

  it("rejects create on root and mount roots", async () => {
    const create = getHandler(makeTools(), "create");
    for (const path of ["/memories", "/memories/shared", "/memories/agents/alice"]) {
      const res = await create({ path, file_text: "x" });
      expect(res.isError).toBe(true);
    }
  });
});

// ── str_replace ─────────────────────────────────────────────────────
describe("str_replace", () => {
  it("replaces a unique occurrence, snapshots prior, fires onWrite", async () => {
    seed("agents/alice/x.md", "hello world");
    const onWrite = vi.fn();
    const sr = getHandler(makeTools({ onWrite }), "str_replace");
    const res = await sr({ path: "/memories/agents/alice/x.md", old_str: "world", new_str: "hive" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("hello hive");
    expect(versionDocs).toHaveLength(1);
    expect(onWrite).toHaveBeenCalledWith("agents/alice/x.md", "memory-mcp-str_replace");
  });

  it("omitted new_str deletes old_str", async () => {
    seed("agents/alice/x.md", "keep DROP keep");
    const sr = getHandler(makeTools(), "str_replace");
    await sr({ path: "/memories/agents/alice/x.md", old_str: "DROP " });
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("keep keep");
  });

  it("errors on zero matches — no snapshot, no write", async () => {
    seed("agents/alice/x.md", "content");
    const sr = getHandler(makeTools(), "str_replace");
    const res = await sr({ path: "/memories/agents/alice/x.md", old_str: "missing", new_str: "y" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/);
    expect(versionDocs).toHaveLength(0);
  });

  it("errors on multiple matches with must-be-unique phrasing — no snapshot", async () => {
    seed("agents/alice/x.md", "dup dup");
    const sr = getHandler(makeTools(), "str_replace");
    const res = await sr({ path: "/memories/agents/alice/x.md", old_str: "dup", new_str: "y" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/must be unique/);
    expect(versionDocs).toHaveLength(0);
  });

  it("sequential same-file edits are last-write-wins with both priors snapshotted", async () => {
    seed("agents/alice/x.md", "base one two");
    const sr = getHandler(makeTools(), "str_replace");
    await sr({ path: "/memories/agents/alice/x.md", old_str: "one", new_str: "ONE" });
    await sr({ path: "/memories/agents/alice/x.md", old_str: "two", new_str: "TWO" });
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("base ONE TWO");
    expect(versionDocs.map((v) => v.content)).toEqual(["base one two", "base ONE two"]);
  });
});

// ── insert ──────────────────────────────────────────────────────────
describe("insert", () => {
  it("insert_line 0 inserts at the beginning", async () => {
    seed("agents/alice/x.md", "second");
    const ins = getHandler(makeTools(), "insert");
    await ins({ path: "/memories/agents/alice/x.md", insert_line: 0, insert_text: "first" });
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("first\nsecond");
  });

  it("inserts after line N, snapshots, fires onWrite with insert reason", async () => {
    seed("agents/alice/x.md", "a\nc");
    const onWrite = vi.fn();
    const ins = getHandler(makeTools({ onWrite }), "insert");
    await ins({ path: "/memories/agents/alice/x.md", insert_line: 1, insert_text: "b" });
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("a\nb\nc");
    expect(versionDocs).toHaveLength(1);
    expect(onWrite).toHaveBeenCalledWith("agents/alice/x.md", "memory-mcp-insert");
  });

  it("rejects insert_line beyond end of file", async () => {
    seed("agents/alice/x.md", "one line");
    const ins = getHandler(makeTools(), "insert");
    const res = await ins({ path: "/memories/agents/alice/x.md", insert_line: 5, insert_text: "y" });
    expect(res.isError).toBe(true);
  });
});

// ── delete ──────────────────────────────────────────────────────────
describe("delete", () => {
  it("deletes a file: snapshot + remove + onWrite with delete reason", async () => {
    seed("agents/alice/x.md", "bye");
    const onWrite = vi.fn();
    const del = getHandler(makeTools({ onWrite }), "delete");
    const res = await del({ path: "/memories/agents/alice/x.md" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.has("agents/alice/x.md")).toBe(false);
    expect(versionDocs).toHaveLength(1);
    expect(onWrite).toHaveBeenCalledWith("agents/alice/x.md", "memory-mcp-delete");
  });

  it("deletes a directory recursively, snapshotting each file", async () => {
    seed("agents/alice/proj/a.md", "A");
    seed("agents/alice/proj/sub/b.md", "B");
    seed("agents/alice/keep.md", "K");
    const onWrite = vi.fn();
    const del = getHandler(makeTools({ onWrite }), "delete");
    const res = await del({ path: "/memories/agents/alice/proj" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.has("agents/alice/proj/a.md")).toBe(false);
    expect(memoryDocs.has("agents/alice/proj/sub/b.md")).toBe(false);
    expect(memoryDocs.has("agents/alice/keep.md")).toBe(true);
    expect(versionDocs).toHaveLength(2);
    expect(onWrite).toHaveBeenCalledTimes(2);
  });

  it("rejects deleting the /memories root and mount roots", async () => {
    seed("agents/alice/x.md", "x");
    const del = getHandler(makeTools(), "delete");
    for (const path of ["/memories", "/memories/agents/alice", "/memories/shared"]) {
      const res = await del({ path });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/Cannot delete/);
    }
    expect(memoryDocs.has("agents/alice/x.md")).toBe(true);
  });
});

// ── rename ──────────────────────────────────────────────────────────
describe("rename", () => {
  it("renames a file: re-keys the doc, snapshots, fires onWrite for both paths", async () => {
    seed("agents/alice/old.md", "body");
    const onWrite = vi.fn();
    const rn = getHandler(makeTools({ onWrite }), "rename");
    const res = await rn({ old_path: "/memories/agents/alice/old.md", new_path: "/memories/agents/alice/new.md" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.has("agents/alice/old.md")).toBe(false);
    expect(memoryDocs.get("agents/alice/new.md")?.content).toBe("body");
    expect(versionDocs).toHaveLength(1);
    expect(onWrite).toHaveBeenCalledWith("agents/alice/old.md", "memory-mcp-rename");
    expect(onWrite).toHaveBeenCalledWith("agents/alice/new.md", "memory-mcp-rename");
  });

  it("rejects overwrite of an existing destination", async () => {
    seed("agents/alice/a.md", "A");
    seed("agents/alice/b.md", "B");
    const rn = getHandler(makeTools(), "rename");
    const res = await rn({ old_path: "/memories/agents/alice/a.md", new_path: "/memories/agents/alice/b.md" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/already exists/);
    expect(memoryDocs.get("agents/alice/b.md")?.content).toBe("B");
  });

  it("allows cross-mount rename agents → shared (both sides pass guard)", async () => {
    seed("agents/alice/x.md", "X");
    const rn = getHandler(makeTools(), "rename");
    const res = await rn({ old_path: "/memories/agents/alice/x.md", new_path: "/memories/shared/x.md" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.get("shared/x.md")?.content).toBe("X");
  });

  it("rejects rename of root and mount roots", async () => {
    const rn = getHandler(makeTools(), "rename");
    const root = await rn({ old_path: "/memories", new_path: "/memories/agents/alice/x" });
    expect(root.isError).toBe(true);
    const mount = await rn({ old_path: "/memories/agents/alice", new_path: "/memories/shared/alice" });
    expect(mount.isError).toBe(true);
  });

  it("renames a directory by re-keying all children", async () => {
    seed("agents/alice/proj/a.md", "A");
    seed("agents/alice/proj/b.md", "B");
    const rn = getHandler(makeTools(), "rename");
    const res = await rn({ old_path: "/memories/agents/alice/proj", new_path: "/memories/agents/alice/archive" });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.get("agents/alice/archive/a.md")?.content).toBe("A");
    expect(memoryDocs.get("agents/alice/archive/b.md")?.content).toBe("B");
    expect(versionDocs).toHaveLength(2);
  });
});

// ── fs scopes (parity subset) ───────────────────────────────────────
describe("filesystem scopes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kpr327-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scoped = (onWrite?: any) =>
    makeTools({ onWrite, scopes: [{ id: "workshop", backing: "filesystem", dir }] });

  it("view lists the scope root and reads scope files", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.md"), "day one");
    const view = getHandler(scoped(), "view");
    const listing = await view({ path: "/memories/scopes/workshop" });
    expect(listing.isError).toBeFalsy();
    expect(listing.content[0].text).toContain("journal.md");
    const file = await view({ path: "/memories/scopes/workshop/journal.md" });
    expect(file.isError).toBeFalsy();
    expect(file.content[0].text).toContain("     1\tday one");
  });

  it("create and str_replace and insert work on scope files", async () => {
    const tools = scoped();
    const create = getHandler(tools, "create");
    const sr = getHandler(tools, "str_replace");
    const ins = getHandler(tools, "insert");
    await create({ path: "/memories/scopes/workshop/notes.md", file_text: "alpha" });
    await sr({ path: "/memories/scopes/workshop/notes.md", old_str: "alpha", new_str: "beta" });
    await ins({ path: "/memories/scopes/workshop/notes.md", insert_line: 0, insert_text: "top" });
    const view = getHandler(tools, "view");
    const res = await view({ path: "/memories/scopes/workshop/notes.md" });
    expect(res.content[0].text).toContain("top");
    expect(res.content[0].text).toContain("beta");
  });

  it("root /memories view lists the scope mount", async () => {
    const view = getHandler(scoped(), "view");
    const res = await view({ path: "/memories" });
    expect(res.content[0].text).toContain("scopes/workshop/");
  });

  it("delete and rename on scope paths return not-supported errors", async () => {
    const tools = scoped();
    const del = await getHandler(tools, "delete")({ path: "/memories/scopes/workshop/x.md" });
    expect(del.isError).toBe(true);
    expect(del.content[0].text).toBe("delete not supported on filesystem scopes");
    const rn = await getHandler(tools, "rename")({
      old_path: "/memories/scopes/workshop/x.md",
      new_path: "/memories/scopes/workshop/y.md",
    });
    expect(rn.isError).toBe(true);
    expect(rn.content[0].text).toBe("rename not supported on filesystem scopes");
  });

  it("rename into scopes/ or across the mongo↔fs boundary is rejected", async () => {
    seed("agents/alice/x.md", "X");
    const rn = getHandler(scoped(), "rename");
    const into = await rn({ old_path: "/memories/agents/alice/x.md", new_path: "/memories/scopes/workshop/x.md" });
    expect(into.isError).toBe(true);
    expect(into.content[0].text).toBe("rename not supported on filesystem scopes");
  });

  it("history/rollback on scope paths return the exact legacy wording", async () => {
    const tools = scoped();
    const hist = await getHandler(tools, "memory_history")({ path: "/memories/scopes/workshop/x.md" });
    expect(hist.isError).toBe(true);
    expect(hist.content[0].text).toBe(
      "history/rollback not supported for filesystem scopes — use git or equivalent",
    );
    const rb = await getHandler(tools, "memory_rollback")({
      path: "/memories/scopes/workshop/x.md",
      version_index: 0,
    });
    expect(rb.isError).toBe(true);
    expect(rb.content[0].text).toBe(
      "history/rollback not supported for filesystem scopes — use git or equivalent",
    );
  });

  it("onWrite does NOT fire for fs-scope writes (parity with legacy)", async () => {
    const onWrite = vi.fn();
    const create = getHandler(scoped(onWrite), "create");
    await create({ path: "/memories/scopes/workshop/notes.md", file_text: "x" });
    expect(onWrite).not.toHaveBeenCalled();
  });
});

// ── history / rollback (hive extensions) ────────────────────────────
describe("memory_history / memory_rollback", () => {
  it("history lists versions after an overwrite", async () => {
    seed("agents/alice/x.md", "v1");
    const tools = makeTools();
    await getHandler(tools, "create")({ path: "/memories/agents/alice/x.md", file_text: "v2" });
    const res = await getHandler(tools, "memory_history")({ path: "/memories/agents/alice/x.md" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("v1");
  });

  it("rollback restores prior content, snapshots current, fires onWrite", async () => {
    seed("agents/alice/x.md", "v1");
    const onWrite = vi.fn();
    const tools = makeTools({ onWrite });
    await getHandler(tools, "create")({ path: "/memories/agents/alice/x.md", file_text: "v2" });
    const res = await getHandler(tools, "memory_rollback")({
      path: "/memories/agents/alice/x.md",
      version_index: 0,
    });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("v1");
    expect(onWrite).toHaveBeenCalledWith("agents/alice/x.md", "memory-mcp-rollback");
  });

  it("history accepts legacy bare paths for backward compatibility", async () => {
    seed("agents/alice/x.md", "v1");
    const tools = makeTools();
    await getHandler(tools, "create")({ path: "/memories/agents/alice/x.md", file_text: "v2" });
    const res = await getHandler(tools, "memory_history")({ path: "agents/alice/x.md" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("v1");
  });
});

// ── legacy tools are gone ───────────────────────────────────────────
describe("legacy surface removed", () => {
  it("no memory_read / memory_write / memory_list tools remain", () => {
    const names = makeTools().map((t: any) => t.name);
    expect(names).not.toContain("memory_read");
    expect(names).not.toContain("memory_write");
    expect(names).not.toContain("memory_list");
    expect(names).toEqual(
      expect.arrayContaining(["view", "create", "str_replace", "insert", "delete", "rename", "memory_history", "memory_rollback"]),
    );
    expect(names).toHaveLength(8);
  });
});
```

  Notes: exact line counts in truncation assertions may need ±1 tolerance depending on notice length; adjust the `toBeLessThan` bound, not the contract. The fake `verCol.find` chain assumes `sort({savedAt:-1})` on append-ordered versions — keep the `reverse()`.
- [ ] Step 2: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/memory/memory-mcp-server.test.ts`. Expected: all tests pass (~35 tests). Negative-verify once: comment out the `/%2e|%2f|%5c/i` check in `canonicalize`, rerun, confirm the `%2e%2e` guard tests FAIL, restore, rerun green.
- [ ] Step 3: Commit —
```bash
cd /Users/mokie/github/kpr-327-work
git add src/memory/memory-mcp-server.test.ts
git commit -m "KPR-327: rewrite memory MCP server tests for native contract

Guard/traversal, six-command semantics, snapshot+onWrite side effects,
fs-scope parity subset + not-supported errors, history/rollback, truncation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: agent-runner cleanup — drop the vestigial stdio placeholder

> **Revision 2026-07-12 (post-demotion).** The 2026-07-11 deliver lane demoted this ticket at this task (see the KPR-327 demotion comment): the `describe("AgentRunner — MEMORY_SCOPES_JSON wiring")` block (`agent-runner.test.ts:2857-2936`, 4 tests) observes `resolveMemoryScopes()` output **solely** via `servers.memory.env.MEMORY_SCOPES_JSON` on the stdio placeholder this task deletes — an observation seam the original plan failed to enumerate. Resolution (option 1 of the demotion comment, sharpened): capture the deps `AgentRunner.send()` passes to `createMemoryMcpServer` at the **factory boundary** via a wrapping module mock, and assert on `deps.memoryScopes`. This preserves the block's wiring-level coverage intent — that `send()` threads the resolved scope list into the memory server — which a direct `resolveMemoryScopes()` unit test would lose and deleting the block would abandon (the function is live, called code). The capture must sit on `createMemoryMcpServer` itself, **not** the SDK's `createSdkMcpServer` mock: the SDK layer receives only `{name, version, tools}` where the tools close over deps opaquely. Steps 0 and 5(d) below are new; the uncommitted WIP already present in the child worktree implements Steps 1–5(a-c) faithfully and is kept, not redone.
>
> **Worktree note (applies to every task in this plan):** the deliver lane executes in the child worktree `/Users/mokie/github/kpr-327-work` (branch `may/kpr-327-memory-legacy-cutover`) — never on the epic branch. This plan's `/Users/mokie/github/kpr-326-work/...` file paths in **Files:** headers are epic-worktree spellings from drafting time; resolve them against the child worktree. All commit-step `cd` lines were corrected to the child worktree in this revision (caught by plan-review round 2).

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/agent-runner.ts` (lines ~454-477 removed; small edits at ~225-232, ~819, ~1195-1217, ~1522-1529)
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/agent-runner.test.ts` (tests at lines ~234, ~250, ~775-804; **plus** the scope-wiring block at ~2857-2936 and a top-of-file capture mock — Step 5d)

- [ ] Step 0 (added 2026-07-12): sync the child branch with the epic head before resuming. The child branch was cut from `fa4fa6a`; the epic branch has since merged KPR-329 (`2bb6a4b`, touches agent-runner.ts tool-search wiring — disjoint from this task's regions) plus this plan revision. The branch is local-only (never pushed), so rebase:
```bash
cd /Users/mokie/github/kpr-327-work
git stash -u        # preserve the Task 3 WIP (agent-runner.ts + agent-runner.test.ts)
git fetch origin
git rebase origin/kpr-326
git stash pop       # expect clean; WIP regions are test ~193-268/~793-816, source ~225-232/~453-477/~801/~1204/~1522
```
  If `git stash pop` reports conflicts, the stash entry is retained — resolve the conflicted hunks manually (the WIP hunk regions above are disjoint from the epic's KPR-329 hunks, so conflicts are unexpected), verify the working tree matches the WIP intent, then `git stash drop`. Then re-verify the two committed tasks still hold post-rebase: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/memory/memory-mcp-server.test.ts` → 46/46. Line anchors throughout this task may drift slightly post-rebase — anchor by the quoted code, not the numbers.

Everything else in agent-runner.ts stays untouched: `createMemoryMcpServer` call in `send()`, `IN_PROCESS_PORTED_SERVERS`, structured-memory auto-pairing and its stdio placeholder, `resolveMemoryScopes`, `invalidatePrefixCacheByMemoryPath` wiring. Confirmed by research: the in-process branch at ~1530 sets `mcpServers["memory"]` independently of the placeholder, and `buildSystemPrompt` derives `coreServerNames` from `Object.keys(mcpServers)` AFTER that overwrite (line ~1684), so the toolkit section is unaffected by the removal.

Two behavior-preserving compensations are REQUIRED because two code paths currently depend on the placeholder key existing:
1. **Plugin name-conflict guard** (line ~819: `if (servers[name])`) — without the placeholder, a plugin shipping an MCP server named `memory` would no longer be skipped. Generalize the guard to also reserve all `IN_PROCESS_PORTED_SERVERS` names (strictly safer; no behavior change for the other 9, which keep their placeholders).
2. **`buildToolTransportInventory`** (line ~1194) iterates `filterCoreServers(buildAllServerConfigs())` — without the placeholder, `memory` vanishes from the inventory and the existing test at agent-runner.test.ts:1163 fails. Push the in-process memory descriptor explicitly (mirroring the existing `team-roster` push).

- [ ] Step 1: Delete the placeholder block (lines ~454-477): the comment beginning `// Memory MCP server — KPR-122: in-process at runtime…` through the closing `};` of `servers["memory"] = {...}`, including the now-unused `const memoryScopes: ScopeDecl[] = this.resolveMemoryScopes();` line. Verify afterwards that `ScopeDecl` is still imported/used (it is — `resolveMemoryScopes` return type, line ~391); if `mcpPath("memory/memory-mcp-server.js")` was the only use of nothing else, no other cleanup is needed (`mcpPath` has many other callers).
- [ ] Step 2: Update the plugin-conflict guard at line ~819:
```typescript
        // KPR-327: in-process ported server names are reserved even when they
        // have no stdio placeholder in `servers` (memory lost its placeholder
        // with the native-contract cutover) — a plugin must never claim one.
        if (servers[name] || IN_PROCESS_PORTED_SERVERS.has(name)) {
          log.warn("Plugin server name conflicts with core server, skipping", {
            plugin: plugin.name, server: name,
          });
          continue;
        }
```
- [ ] Step 3: In `buildToolTransportInventory` (after the `for (const [name, serverConfig] of Object.entries(mcpServers))` loop, before the `if (this.teamRoster)` block), add:
```typescript
    // KPR-327: "memory" has no stdio placeholder in buildAllServerConfigs
    // anymore (native-contract cutover), so it is absent from the filtered
    // map — surface its in-process descriptor explicitly, mirroring the
    // runtime wiring in send().
    if (!!this.db && this.shouldEnableInProcessServer("memory") && !mcpServers["memory"]) {
      inventory.push(classifyToolTransport({
        name: "memory",
        transport: "sdk-in-process",
        source: "core",
        requiresTurnContext: TURN_CONTEXT_DEPENDENT_SERVERS.has("memory"),
        requiresHiveRuntime: true,
        inProcess: true,
      }));
    }
```
- [ ] Step 4: Update the two stale comments: (a) the block at lines ~225-232 (`// KPR-183: the 10 KPR-122-ported in-process servers…`) — note that `memory` no longer has a vestigial stdio entry (KPR-327) while the other nine keep theirs; (b) the comment at ~1522-1529 in `send()` — replace the "stdio entry in buildAllServerConfigs is a vestigial placeholder… we overwrite the slot" language with: this is the ONLY wiring for the memory server post-KPR-327 (no placeholder exists).
- [ ] Step 5: Update `agent-runner.test.ts`. Add a shared stub near the other helpers:
```typescript
// KPR-327: memory has no stdio placeholder — tests that assert its presence
// must run the in-process branch, which requires a db handle. Collection
// methods are no-op stubs; in-process factories only close over them.
function makeFakeInProcessDb(): any {
  const col = {
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({ project: vi.fn(() => ({ toArray: vi.fn(async () => []) })), toArray: vi.fn(async () => []), sort: vi.fn(() => ({ limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })) })) })),
    insertOne: vi.fn(async () => ({})),
    updateOne: vi.fn(async () => ({})),
    deleteOne: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({})),
    createIndex: vi.fn(async () => "idx"),
    countDocuments: vi.fn(async () => 0),
  };
  return { collection: vi.fn(() => col) };
}
```
  Then: (a) tests "includes core servers" (~line 234) and "filters servers by agent coreServers allowlist" (~line 250): construct the runner with the db positional arg — `new AgentRunner(makeAgentConfig({ coreServers }), memoryManager as any, [], new Map(), "{}", undefined, undefined, makeFakeInProcessDb())` — assertions unchanged (server key sets are identical; the memory/structured-memory entries are now in-process SDK objects from the mocked `createSdkMcpServer`). (b) Test "skips plugin server that conflicts with core server name" (~line 775): pass `makeFakeInProcessDb()` the same way and replace the two `servers.memory.args` assertions (lines ~802-803) with:
```typescript
    // Core in-process memory server wins; the plugin server never registers.
    expect(servers.memory.type).toBe("sdk");
    expect(servers.memory.args).toBeUndefined();
```
  (c) If other tests fail on a missing `memory` key or a factory calling an unstubbed collection method, extend the stub — do not weaken assertions. The tool-transport test at ~1163 must pass UNCHANGED (it already passes `{} as any` as db and never invokes collection methods).

  (d) **(added 2026-07-12)** Rewrite the `describe("AgentRunner — MEMORY_SCOPES_JSON wiring")` block (~2857-2936) onto the factory-boundary capture seam. Two pieces:

  **(d-i)** Top of file, alongside the existing `vi.mock("@anthropic-ai/claude-agent-sdk", …)` block, add a wrapping module mock. `vi.hoisted` is required — `vi.mock` factories are hoisted above `const` bindings:

```typescript
// KPR-327: the memory server's stdio placeholder (and its MEMORY_SCOPES_JSON
// env serialization) no longer exists — the scope-wiring tests observe what
// send() passes to createMemoryMcpServer instead. Wrapping mock: capture deps,
// delegate to the real factory (whose createSdkMcpServer import is the SDK
// mock above, so returned servers keep the {name, type: "sdk"} test shape).
const memoryDepsCapture = vi.hoisted(() => ({ deps: [] as any[] }));
vi.mock("../memory/memory-mcp-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/memory-mcp-server.js")>();
  return {
    ...actual,
    createMemoryMcpServer: vi.fn((deps: any) => {
      memoryDepsCapture.deps.push(deps);
      return actual.createMemoryMcpServer(deps);
    }),
  };
});
```

  **(d-ii)** Replace the describe block. The four archetype-registration setups are **verbatim from the current tests** — only the runner construction (now needs a db so `send()` takes the in-process branch; `AgentRunner` is cached per-instance so each fresh runner captures exactly once) and the observation lines change. Assertions are unchanged: `send()` passes `resolveMemoryScopes()`'s full output (self included) as `deps.memoryScopes`, exactly what `MEMORY_SCOPES_JSON` used to serialize:

```typescript
describe("AgentRunner — memoryScopes wiring into createMemoryMcpServer (KPR-327)", () => {
  function makeScopesRunner(overrides: Partial<AgentConfig> = {}) {
    return new AgentRunner(
      makeAgentConfig({ coreServers: ["memory"], ...overrides }),
      makeMockMemoryManager() as any,
      [],
      new Map(),
      "{}",
      undefined,
      undefined,
      makeFakeInProcessDb(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryDepsCapture.deps.length = 0; // plain array — clearAllMocks does not reset it
    __resetRegistryForTests();
  });
  afterEach(() => __resetRegistryForTests());

  it("defaults to self-mongo only when no archetype is set", async () => {
    const runner = makeScopesRunner();
    await runner.send("hello");
    expect(memoryDepsCapture.deps).toHaveLength(1); // wiring broke if the factory was never (or repeatedly) called
    const scopes = memoryDepsCapture.deps.at(-1)!.memoryScopes;
    expect(scopes).toEqual([{ id: "self", backing: "mongo" }]);
  });

  it("leads with self-mongo and appends archetype scopes", async () => {
    registerArchetype({
      id: "scoped",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [
        { id: "workshop", backing: "filesystem", dir: "/tmp/workshop" },
        { id: "workspace:dodi_v2", backing: "filesystem", dir: "/tmp/dodi" },
      ],
      sessionOptions: () => ({}),
    });
    const runner = makeScopesRunner({ archetype: "scoped", archetypeConfig: {} });
    await runner.send("hello");
    expect(memoryDepsCapture.deps).toHaveLength(1); // wiring broke if the factory was never (or repeatedly) called
    const scopes = memoryDepsCapture.deps.at(-1)!.memoryScopes;
    expect(scopes[0]).toEqual({ id: "self", backing: "mongo" });
    expect(scopes).toHaveLength(3);
    expect(scopes.find((s: { id: string }) => s.id === "workshop")).toEqual({
      id: "workshop",
      backing: "filesystem",
      dir: "/tmp/workshop",
    });
    expect(scopes.find((s: { id: string }) => s.id === "workspace:dodi_v2")).toBeDefined();
  });

  it("dedupes self when an archetype incorrectly returns its own self entry", async () => {
    registerArchetype({
      id: "with-self",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [
        { id: "self", backing: "filesystem", dir: "/tmp/should-be-filtered" },
        { id: "workshop", backing: "filesystem", dir: "/tmp/workshop" },
      ],
      sessionOptions: () => ({}),
    });
    const runner = makeScopesRunner({ archetype: "with-self", archetypeConfig: {} });
    await runner.send("hello");
    expect(memoryDepsCapture.deps).toHaveLength(1); // wiring broke if the factory was never (or repeatedly) called
    const scopes = memoryDepsCapture.deps.at(-1)!.memoryScopes;
    const selfEntries = scopes.filter((s: { id: string }) => s.id === "self");
    expect(selfEntries).toHaveLength(1);
    expect(selfEntries[0]).toEqual({ id: "self", backing: "mongo" });
    expect(scopes[0]).toEqual({ id: "self", backing: "mongo" });
  });

  it("falls back to self-mongo only when memoryScopes throws", async () => {
    registerArchetype({
      id: "throwing",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => {
        throw new Error("intentional");
      },
      sessionOptions: () => ({}),
    });
    const runner = makeScopesRunner({ archetype: "throwing", archetypeConfig: {} });
    await runner.send("hello");
    expect(memoryDepsCapture.deps).toHaveLength(1); // wiring broke if the factory was never (or repeatedly) called
    const scopes = memoryDepsCapture.deps.at(-1)!.memoryScopes;
    expect(scopes).toEqual([{ id: "self", backing: "mongo" }]);
  });
});
```

  Notes: other tests in the file will also push into `memoryDepsCapture.deps` when they run with a db — harmless; these tests read `.at(-1)` immediately after their own `send()`. The pre-existing local `makeFakeDb` helper inside the in-process describe (~2740) is left as-is (optional consolidation with `makeFakeInProcessDb` is non-blocking implementer judgment). The wrapping mock changes no behavior for any other test: it delegates to the real factory.
- [ ] Step 6: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts` → all pass, including the unchanged test at :1163 and the four rewritten scope-wiring tests. Then `npm run typecheck` with the same env → clean.
- [ ] Step 7: Commit —
```bash
cd /Users/mokie/github/kpr-327-work
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "KPR-327: drop vestigial memory stdio placeholder (KPR-183 leftover)

Reserve in-process ported server names in the plugin-conflict guard and
surface memory's in-process descriptor in buildToolTransportInventory
explicitly — both previously rode on the placeholder key existing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: prefix-builder — memory-first block + fallback tool reference

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/prefix-builder.ts` (after toolkit push ~line 123; fallback branch ~lines 137-145)
- Test: `/Users/mokie/github/kpr-326-work/src/agents/prefix-builder.test.ts` (additions only)

- [ ] Step 1: In `buildPrefix`, immediately after the `parts.push(buildToolkitSection({...}))` call and before the `// --- Memory injection ---` section, insert (wording per spec §4.5, near-verbatim; gated on the agent actually having the memory server so agents without it get no dangling guidance):
```typescript
  // KPR-327: manual "memory-first" guidance for the native-shaped file-tier
  // memory MCP. The Agent SDK injects no system instruction for MCP tools
  // (unlike the native memory_20250818 API tool), so hive authors it here —
  // explicitly deferring to the hot tier injected below to avoid redundant
  // view-everything-first round-trips. Static text: lives in the cached
  // prefix; KPR-213 invalidation semantics are unchanged.
  if (ctx.coreServerNames.includes("memory")) {
    parts.push(
      "## File-Tier Memory\n" +
        "You have a file-tier memory at `/memories` (tools: view, create, str_replace, insert, delete, rename). " +
        "Your hot-tier memory is already injected in this prompt — do **not** re-`view` files to rediscover what's already here. " +
        "`view` file-tier paths when a task needs detail beyond the hot tier, and record durable file-worthy material there.",
    );
  }
```
- [ ] Step 2: Update the legacy fallback branch (currently ~lines 139-145). Replace the file-list block so the listed paths are addressable by the new tool and the tool reference is `view`:
```typescript
    const memoryFiles = await ctx.memoryManager.list(memoryDir);
    const mdFiles = memoryFiles.filter((f) => f.endsWith(".md") && f !== "memory.md");
    if (mdFiles.length > 0) {
      parts.push(
        `## Available Memory Files\nYou have ${mdFiles.length} reference file(s) in your memory directory:\n` +
          mdFiles.map((f) => `- /memories/${memoryDir}/${f}`).join("\n") +
          `\n\nRead relevant files via the memory MCP server (\`view\`) before starting tasks that may relate to them.`,
      );
    }
```
  (Only the path prefix and the tool name change; the surrounding hot-tier/legacy structure is untouched per spec §3.)
- [ ] Step 3: Append two tests to `prefix-builder.test.ts` (existing tests must pass unmodified — the new block is gated on `coreServerNames`, which every existing test leaves empty):
```typescript
  it("KPR-327: includes memory-first block only when agent has the memory server", async () => {
    const cfg = makeAgentConfig();
    const withMemory = await buildPrefix(cfg, makeCtx({ coreServerNames: ["memory"] }));
    expect(withMemory).toContain("## File-Tier Memory");
    expect(withMemory).toContain("/memories");
    expect(withMemory).toContain("view, create, str_replace, insert, delete, rename");
    const without = await buildPrefix(cfg, makeCtx({ coreServerNames: [] }));
    expect(without).not.toContain("## File-Tier Memory");
  });

  it("KPR-327: legacy fallback references view with /memories paths, not memory_read", async () => {
    const mm = makeMemoryManager({
      getHotTierPrompt: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue(["notes.md"]),
    });
    const out = await buildPrefix(makeAgentConfig(), makeCtx({ memoryManager: mm as any }));
    expect(out).toContain("- /memories/agents/test-agent/notes.md");
    expect(out).toContain("`view`");
    expect(out).not.toContain("memory_read");
  });
```
- [ ] Step 4: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/prefix-builder.test.ts` → all pass (existing 10 + new 2).
- [ ] Step 5: Commit —
```bash
cd /Users/mokie/github/kpr-327-work
git add src/agents/prefix-builder.ts src/agents/prefix-builder.test.ts
git commit -m "KPR-327: memory-first prompt block + view reference in legacy fallback

Manual re-injection of the native tool's memory-first guidance (spec 4.5),
gated on the memory server; explicitly defers to the injected hot tier.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Full gate + legacy-name sweep verification

**Files:**
- Modify: none expected (verification only; fix-forward anything the gate surfaces)

- [ ] Step 1: In-repo legacy-name sweep (spec §4.7 — must come back clean after Tasks 1-4):
```bash
cd /Users/mokie/github/kpr-327-work
grep -rn "memory_read\|memory_write\|memory_list" src/ docs/ seeds/ scripts/ --include="*.ts" --include="*.md" | grep -v "kpr-32[678]" || echo CLEAN
```
  Expected: `CLEAN` (the epic docs themselves may reference the legacy names historically — excluded). `memory_history`/`memory_rollback` legitimately remain. The DB-stored-prompt sweep on live instances (dodi/keepur) is an operator rollout item per spec §4.7, NOT part of this ticket's code or gates.
- [ ] Step 2: Verify — full quality gate:
```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
  Expected: typecheck + lint + format + test all green. If format rewrites files, re-stage and amend the relevant task commit or add a `KPR-327: format` commit.
- [ ] Step 3: Commit — only if Step 2 produced fixes:
```bash
cd /Users/mokie/github/kpr-327-work
git add -A && git commit -m "KPR-327: quality-gate fixes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Out of scope (verified against spec — restated for the implementer)

Do not touch: `src/memory/structured-memory-mcp-server.ts`, `src/memory/memory-store.ts`, `src/memory/memory-lifecycle.ts`, `src/memory/memory-lifecycle-heartbeat.ts`, `src/memory/memory-manager.ts`, `src/memory/fs-memory-store.ts` (no new methods — parity subset uses read/list/write only), `src/memory/memory-scope.ts`, `src/agents/provider-adapters/tool-transport.ts` (spec §4.6 is a classification NOTE only — confirmed, no code change; existing `requires-hive-bridge` classification and its tests stand), `src/agents/prefix-invalidation.ts`, `src/agents/in-process-servers.ts`, `agent_memory`/`agent_memory_autodream_state` collections, hot-tier injection (`getHotTierPrompt` call path). No data migration, no agent-definition changes, no seed/constitution edits (in-repo sweep found none referencing legacy names).

## Assumptions (carried into the return contract)

1. **Truncation notice wording is hive-defined.** KPR-328 verdict §1 captures only the threshold ("truncates text views >16,000 chars"), not a literal notice string; the plan fixes `TRUNCATION_NOTICE` as the concrete rendering.
2. **Memory-first block is gated on `coreServerNames.includes("memory")`** — spec §4.5 gives wording and placement but not gating; injecting tool guidance into agents without the server would be wrong, so the gate is the conservative reading.
3. **`memory_history`/`memory_rollback` accept both `/memories/...` and legacy bare paths** — "unchanged from today" is read as unchanged storage/query behavior with addressing adapted to the new namespace; bare-path acceptance keeps DB-stored prompts working through the operator sweep window.
4. **Legacy fallback path listing gains the `/memories/` prefix** alongside the mandated `memory_read`→`view` reference change, so the listed paths are actually addressable by the referenced tool.
5. **Placeholder removal compensations** (plugin-guard reservation, explicit tool-transport inventory push) are treated as part of the mandated cleanup because both code paths verifiably depended on the placeholder key (agent-runner.ts:819, agent-runner.test.ts:1163) — behavior-preserving, not scope creep.
