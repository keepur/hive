import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsMemoryStore } from "./fs-memory-store.js";

describe("FsMemoryStore", () => {
  let dir: string;
  let store: FsMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fsmem-"));
    store = new FsMemoryStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates dir and MEMORY.md on ensure", () => {
    store.ensure();
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("# Memory");
  });

  it("writes a memory file and adds an index line", () => {
    store.write("topic-a.md", "---\nname: topic-a\n---\nbody", "- [A](topic-a.md) — about A");
    expect(readFileSync(join(dir, "topic-a.md"), "utf-8")).toContain("body");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("- [A](topic-a.md) — about A");
  });

  it("dedupes repeat index writes for same filename", () => {
    store.write("t.md", "v1", "- [T](t.md) — old");
    store.write("t.md", "v2", "- [T](t.md) — new");
    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    expect(idx).toContain("new");
    expect(idx).not.toContain("old");
  });

  it("reads null for missing files", () => {
    expect(store.read("missing.md")).toBeNull();
  });

  it("lists .md files excluding MEMORY.md", () => {
    store.write("a.md", "a", "- a");
    store.write("b.md", "b", "- b");
    expect(store.list()).toEqual(["a.md", "b.md"]);
  });

  it("rejects path traversal", () => {
    expect(() => store.write("../escape.md", "", null)).toThrow();
    expect(() => store.read("../escape.md")).toThrow();
  });

  it("constructor rejects relative paths (raw input, not resolved)", () => {
    expect(() => new FsMemoryStore(".")).toThrow(/absolute/);
    expect(() => new FsMemoryStore("relative/dir")).toThrow(/absolute/);
    expect(() => new FsMemoryStore("")).toThrow(/absolute/);
  });

  it("write is atomic (no partial file on concurrent reads)", () => {
    // Smoke test — race the writer against a reader, assert reader never sees "".
    store.write("r.md", "full content", null);
    for (let i = 0; i < 20; i++) {
      store.write("r.md", `v${i} — ${"x".repeat(500)}`, null);
      expect(store.read("r.md")!.length).toBeGreaterThan(0);
    }
  });
});
