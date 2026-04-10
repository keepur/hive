import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
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
    if (!resolve(dir).startsWith("/")) {
      throw new Error(`FsMemoryStore requires absolute path, got ${dir}`);
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

  /** List .md files in the store (excluding MEMORY.md). */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort();
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
      this.updateIndex(basename(abs), indexLine);
    }
  }

  /** Read-modify-write MEMORY.md under atomic rename. Dedups by filename. */
  private updateIndex(filename: string, indexLine: string): void {
    const memoryMd = join(this.dir, "MEMORY.md");
    const existing = existsSync(memoryMd)
      ? readFileSync(memoryMd, "utf-8")
      : "# Memory\n";
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
    renameSync(tmp, abs);
  }

  private safeJoin(relPath: string): string {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      throw new Error(`FsMemoryStore: invalid relative path ${relPath}`);
    }
    return join(this.dir, relPath);
  }
}
