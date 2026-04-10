import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Filesystem-backed memory store that mirrors the Claude Code harness auto-memory format.
 *
 * Layout under `dir`:
 *   MEMORY.md        — index file, one-liner pointer per memory file
 *   <topic>.md       — individual memory with YAML frontmatter
 *
 * All writes use atomic rename (temp file in same directory → renameSync) so concurrent
 * readers never see a partial file. MEMORY.md is updated under the same scheme.
 *
 * The store does NOT take a lock — cross-instance writes on the same file follow
 * last-writer-wins semantics per spec Runtime Failure Mode 5.
 */
export class FsMemoryStore {
  constructor(private readonly dir: string) {
    // Check the raw input — resolve() would silently turn "." into the cwd
    // and let a relative path slip through.
    if (typeof dir !== "string" || !dir.startsWith("/")) {
      throw new Error(`FsMemoryStore requires absolute path, got ${String(dir)}`);
    }
  }

  /** Ensure dir and MEMORY.md exist. Safe to call repeatedly. */
  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
    const memoryMd = join(this.dir, "MEMORY.md");
    if (!existsSync(memoryMd)) {
      this.atomicWrite(memoryMd, "# Memory\n");
    }
  }

  read(relPath: string): string | null {
    const abs = this.safeJoin(relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf-8");
  }

  /** List .md files in the store (excluding MEMORY.md), recursing into subdirectories. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return this.listRecursive(this.dir, "");
  }

  private listRecursive(base: string, prefix: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...this.listRecursive(join(base, entry.name), rel));
      } else if (entry.name.endsWith(".md") && rel !== "MEMORY.md") {
        results.push(rel);
      }
    }
    return results.sort();
  }

  /**
   * Write a memory file and update MEMORY.md with a one-liner pointer.
   *
   * `indexLine` is the one-liner description inserted into MEMORY.md, e.g.
   *   "- [Workshop journal](workshop.md) — prototyping notes across repos"
   * If null, the file is written but MEMORY.md is not touched (useful when the
   * caller maintains the index separately).
   */
  write(relPath: string, content: string, indexLine: string | null): void {
    this.ensure();
    const abs = this.safeJoin(relPath);
    this.atomicWrite(abs, content);
    if (indexLine !== null) {
      // Use the caller's relPath for dedup — basename(abs) would strip directory
      // prefixes, causing the filter to miss links like "(subdir/topic.md)".
      this.updateIndex(relPath, indexLine);
    }
  }

  /** Read-modify-write MEMORY.md under atomic rename. Dedups by filename. */
  private updateIndex(filename: string, indexLine: string): void {
    const memoryMd = join(this.dir, "MEMORY.md");
    const existing = existsSync(memoryMd) ? readFileSync(memoryMd, "utf-8") : "# Memory\n";
    const lines = existing.split("\n");
    // Remove any prior line referencing this file
    const filtered = lines.filter((l) => !l.includes(`(${filename})`));
    filtered.push(indexLine);
    // Ensure trailing newline
    const next = filtered.join("\n").replace(/\n*$/, "\n");
    this.atomicWrite(memoryMd, next);
  }

  private atomicWrite(abs: string, content: string): void {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, content, "utf-8");
    try {
      renameSync(tmp, abs);
    } catch (err) {
      // Clean up temp file on rename failure to avoid leaked .tmp files
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup — ignore if tmp already gone
      }
      throw err;
    }
  }

  private safeJoin(relPath: string): string {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      throw new Error(`FsMemoryStore: invalid relative path ${relPath}`);
    }
    const joined = join(this.dir, relPath);
    // Resolve symlinks in the result and verify it's still inside our dir.
    // Without this, a symlink at `this.dir/link → /etc` would bypass the
    // ".." check above and allow reads/writes outside the store root.
    const resolved = resolve(joined);
    const resolvedDir = resolve(this.dir);
    if (!resolved.startsWith(resolvedDir + "/") && resolved !== resolvedDir) {
      throw new Error(`FsMemoryStore: resolved path escapes store root: ${relPath}`);
    }
    return resolved;
  }
}
