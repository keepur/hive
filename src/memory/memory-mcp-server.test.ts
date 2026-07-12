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

  it("replaces literally — $$ and $& in new_str are not treated as replacement patterns", async () => {
    seed("agents/alice/x.md", "the item PRICE_PLACEHOLDER today");
    const sr = getHandler(makeTools(), "str_replace");
    const res = await sr({
      path: "/memories/agents/alice/x.md",
      old_str: "PRICE_PLACEHOLDER",
      new_str: "costs $$50 ($& escaped)",
    });
    expect(res.isError).toBeFalsy();
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("the item costs $$50 ($& escaped) today");
  });

  it("rejects empty old_str — no snapshot, no write", async () => {
    seed("agents/alice/x.md", "content");
    const sr = getHandler(makeTools(), "str_replace");
    const res = await sr({ path: "/memories/agents/alice/x.md", old_str: "", new_str: "y" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/non-empty/);
    expect(memoryDocs.get("agents/alice/x.md")?.content).toBe("content");
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

  const scoped = (onWrite?: any) => makeTools({ onWrite, scopes: [{ id: "workshop", backing: "filesystem", dir }] });

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
    const rn = await getHandler(
      tools,
      "rename",
    )({
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
    expect(hist.content[0].text).toBe("history/rollback not supported for filesystem scopes — use git or equivalent");
    const rb = await getHandler(
      tools,
      "memory_rollback",
    )({
      path: "/memories/scopes/workshop/x.md",
      version_index: 0,
    });
    expect(rb.isError).toBe(true);
    expect(rb.content[0].text).toBe("history/rollback not supported for filesystem scopes — use git or equivalent");
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
    const res = await getHandler(
      tools,
      "memory_rollback",
    )({
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
      expect.arrayContaining([
        "view",
        "create",
        "str_replace",
        "insert",
        "delete",
        "rename",
        "memory_history",
        "memory_rollback",
      ]),
    );
    expect(names).toHaveLength(8);
  });
});
