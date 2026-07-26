import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinExecutor } from "./builtin-executor.js";

// T3 asserts the agent-facing contract — do NOT add assertions on Claude-CLI-internal quirks.

let tmp: string;
let ac: AbortController;
let exec: BuiltinExecutor;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kpr348-"));
  ac = new AbortController();
  exec = new BuiltinExecutor({ cwd: tmp, signal: ac.signal });
});

afterEach(() => {
  ac.abort();
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BuiltinExecutor.Read", () => {
  it("returns cat -n format — line numbers from 1, tab separator", async () => {
    writeFileSync(join(tmp, "f.txt"), "alpha\nbeta\ngamma");
    const out = await exec.execute("Read", { file_path: join(tmp, "f.txt") });
    expect(out).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  it("windows via offset/limit and reports remaining", async () => {
    writeFileSync(join(tmp, "f.txt"), "l1\nl2\nl3\nl4\nl5");
    const out = await exec.execute("Read", { file_path: join(tmp, "f.txt"), offset: 3, limit: 2 });
    expect(out).toContain("     3\tl3");
    expect(out).toContain("     4\tl4");
    expect(out).not.toContain("l5");
    expect(out).toContain("[1 more lines");
  });

  it("default read stops at 2000 lines with a remaining marker", async () => {
    const content = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(tmp, "big.txt"), content);
    const out = await exec.execute("Read", { file_path: join(tmp, "big.txt") });
    expect(out).toContain("  2000\tline2000");
    expect(out).not.toContain("line2001");
    expect(out).toContain("[500 more lines");
  });

  it("truncates a 3000-char line at 2000 with a marker", async () => {
    writeFileSync(join(tmp, "long.txt"), "x".repeat(3000));
    const out = await exec.execute("Read", { file_path: join(tmp, "long.txt") });
    expect(out).toContain("[line truncated]");
    // 6-wide number + tab + 2000 chars + marker
    expect(out).toContain("x".repeat(2000));
    expect(out).not.toContain("x".repeat(2001));
  });

  it("missing file → distinct not-found text", async () => {
    const out = await exec.execute("Read", { file_path: join(tmp, "nope.txt") });
    expect(out).toBe(`Read failed: file not found: ${join(tmp, "nope.txt")}`);
  });

  it("directory → is a directory", async () => {
    const out = await exec.execute("Read", { file_path: tmp });
    expect(out).toBe(`Read failed: ${tmp} is a directory`);
  });

  it("unsupported extension → not supported on this provider lane", async () => {
    writeFileSync(join(tmp, "img.png"), "binary");
    const out = await exec.execute("Read", { file_path: join(tmp, "img.png") });
    expect(out).toContain("not supported on this provider lane");
  });
});

describe("BuiltinExecutor.Edit", () => {
  it("unique replace works and reports 1 replacement", async () => {
    const p = join(tmp, "e.txt");
    writeFileSync(p, "hello world");
    const out = await exec.execute("Edit", { file_path: p, old_string: "world", new_string: "there" });
    expect(out).toBe(`Edited ${p} (1 replacement)`);
    expect(readFileSync(p, "utf8")).toBe("hello there");
  });

  it("not found → distinct text", async () => {
    const p = join(tmp, "e.txt");
    writeFileSync(p, "hello");
    const out = await exec.execute("Edit", { file_path: p, old_string: "xyz", new_string: "abc" });
    expect(out).toBe(`Edit failed: old_string not found in ${p}`);
  });

  it("2 occurrences without replace_all → distinct non-unique text naming the count", async () => {
    const p = join(tmp, "e.txt");
    writeFileSync(p, "a a");
    const out = await exec.execute("Edit", { file_path: p, old_string: "a", new_string: "b" });
    expect(out).toContain("matches 2 locations");
    expect(readFileSync(p, "utf8")).toBe("a a");
  });

  it("replace_all replaces both", async () => {
    const p = join(tmp, "e.txt");
    writeFileSync(p, "a a");
    const out = await exec.execute("Edit", { file_path: p, old_string: "a", new_string: "b", replace_all: true });
    expect(out).toContain("2 replacements");
    expect(readFileSync(p, "utf8")).toBe("b b");
  });

  it("identical strings → distinct text", async () => {
    const p = join(tmp, "e.txt");
    writeFileSync(p, "hello");
    const out = await exec.execute("Edit", { file_path: p, old_string: "hello", new_string: "hello" });
    expect(out).toBe("Edit failed: old_string and new_string are identical");
  });
});

describe("BuiltinExecutor.Write", () => {
  it("creates nested parent dirs", async () => {
    const p = join(tmp, "a", "b", "c.txt");
    const out = await exec.execute("Write", { file_path: p, content: "hi" });
    expect(out).toBe(`Wrote 2 bytes to ${p}`);
    expect(readFileSync(p, "utf8")).toBe("hi");
  });

  it("overwrite replaces content", async () => {
    const p = join(tmp, "w.txt");
    writeFileSync(p, "old content");
    await exec.execute("Write", { file_path: p, content: "new" });
    expect(readFileSync(p, "utf8")).toBe("new");
  });
});

describe("BuiltinExecutor.Bash", () => {
  it("echo hi → hi", async () => {
    const out = await exec.execute("Bash", { command: "echo hi" });
    expect(out).toBe("hi\n");
  });

  it("non-zero exit appends exit code (result, not throw)", async () => {
    const out = await exec.execute("Bash", { command: "exit 3" });
    expect(out).toContain("Exit code 3");
  });

  it("truncates output at 30000 chars", async () => {
    const out = await exec.execute("Bash", { command: "printf 'a%.0s' {1..40000}" });
    expect(out).toContain("[output truncated at 30000 characters]");
  });

  it("timeout kills the command and reports it; child pid gone", async () => {
    const out = await exec.execute("Bash", { command: "sleep 5", timeout: 200 });
    expect(out).toContain("timed out after 200ms");
    // give the kill a moment; no live children remain
    await sleep(1000);
    expect(exec.activeChildPids().length).toBe(0);
  });

  it("relative-path pwd resolves to the executor cwd", async () => {
    const out = await exec.execute("Bash", { command: "pwd" });
    // pwd resolves symlinks (macOS /var → /private/var); compare realpaths.
    expect(realpathSync(out.trim())).toBe(realpathSync(tmp));
  });

  it("does not persist cwd between calls", async () => {
    await exec.execute("Bash", { command: "cd /tmp" });
    const out = await exec.execute("Bash", { command: "pwd" });
    expect(realpathSync(out.trim())).toBe(realpathSync(tmp));
  });
});

describe("BuiltinExecutor.Glob", () => {
  it("returns absolute paths newest-first", async () => {
    const older = join(tmp, "older.ts");
    const newer = join(tmp, "newer.ts");
    writeFileSync(older, "a");
    writeFileSync(newer, "b");
    utimesSync(older, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
    utimesSync(newer, new Date(), new Date());
    const out = await exec.execute("Glob", { pattern: "*.ts" });
    expect(out).toBe(`${newer}\n${older}`);
  });

  it("no match → No files found", async () => {
    const out = await exec.execute("Glob", { pattern: "*.nomatch" });
    expect(out).toBe("No files found");
  });
});

describe("BuiltinExecutor.Grep", () => {
  beforeEach(() => {
    writeFileSync(join(tmp, "a.ts"), "const foo = 1;\nconst bar = 2;\nfoo again");
    writeFileSync(join(tmp, "b.md"), "foo in markdown");
  });

  it("files_with_matches default", async () => {
    const out = await exec.execute("Grep", { pattern: "foo" });
    const lines = out.split("\n").sort();
    expect(lines).toContain(join(tmp, "a.ts"));
    expect(lines).toContain(join(tmp, "b.md"));
  });

  it("count mode", async () => {
    const out = await exec.execute("Grep", { pattern: "foo", path: join(tmp, "a.ts"), output_mode: "count" });
    expect(out).toBe(`${join(tmp, "a.ts")}: 2`);
  });

  it("content mode with -n and context 1", async () => {
    const out = await exec.execute("Grep", {
      pattern: "bar",
      path: join(tmp, "a.ts"),
      output_mode: "content",
      "-n": true,
      context: 1,
    });
    expect(out).toContain("1: const foo = 1;");
    expect(out).toContain("2: const bar = 2;");
    expect(out).toContain("3: foo again");
  });

  it("-i case-insensitive", async () => {
    const out = await exec.execute("Grep", { pattern: "FOO", path: join(tmp, "a.ts"), "-i": true, output_mode: "count" });
    expect(out).toBe(`${join(tmp, "a.ts")}: 2`);
  });

  it("glob filter excludes non-matching extensions", async () => {
    const out = await exec.execute("Grep", { pattern: "foo", glob: "*.ts" });
    expect(out).toContain(join(tmp, "a.ts"));
    expect(out).not.toContain(join(tmp, "b.md"));
  });

  it("no match → No matches found", async () => {
    const out = await exec.execute("Grep", { pattern: "zzzznotfound" });
    expect(out).toBe("No matches found");
  });
});

describe("BuiltinExecutor §D8 empty-string parity (T9)", () => {
  it("Edit with empty new_string deletes the matched substring", async () => {
    const p = join(tmp, "d.txt");
    writeFileSync(p, "goodbye world");
    const out = await exec.execute("Edit", { file_path: p, old_string: "goodbye ", new_string: "" });
    expect(out).toBe(`Edited ${p} (1 replacement)`);
    expect(readFileSync(p, "utf8")).toBe("world");
  });

  it("Write with empty content truncates an existing file to zero bytes", async () => {
    const p = join(tmp, "t.txt");
    writeFileSync(p, "some existing content");
    const out = await exec.execute("Write", { file_path: p, content: "" });
    expect(out).toBe(`Wrote 0 bytes to ${p}`);
    expect(readFileSync(p, "utf8")).toBe("");
  });

  it("Edit still rejects an empty old_string (throws, bridge contains it)", async () => {
    const p = join(tmp, "e.txt");
    writeFileSync(p, "hello");
    await expect(
      exec.execute("Edit", { file_path: p, old_string: "", new_string: "x" }),
    ).rejects.toThrow(/missing required string parameter 'old_string'/);
  });

  it("Edit still rejects an empty file_path (throws)", async () => {
    await expect(
      exec.execute("Edit", { file_path: "", old_string: "a", new_string: "b" }),
    ).rejects.toThrow(/missing required string parameter 'file_path'/);
  });

  it("Write still rejects an empty file_path (throws)", async () => {
    await expect(
      exec.execute("Write", { file_path: "", content: "hi" }),
    ).rejects.toThrow(/missing required string parameter 'file_path'/);
  });

  it("identity guard still fires when old_string === new_string (both non-empty)", async () => {
    const p = join(tmp, "id.txt");
    writeFileSync(p, "x marks");
    const out = await exec.execute("Edit", { file_path: p, old_string: "x", new_string: "x" });
    expect(out).toBe("Edit failed: old_string and new_string are identical");
    expect(readFileSync(p, "utf8")).toBe("x marks");
  });
});

describe("BuiltinExecutor unknown tool", () => {
  it("unknown builtin → contained result text", async () => {
    const out = await exec.execute("Nonexistent", {});
    expect(out).toBe("Tool execution failed (Nonexistent): unknown builtin");
  });
});

describe("BuiltinExecutor contract violations THROW (containment is the bridge's job)", () => {
  it("missing command throws", async () => {
    await expect(exec.execute("Bash", {})).rejects.toThrow(/missing required string parameter 'command'/);
  });

  it("invalid regex throws", async () => {
    await expect(exec.execute("Grep", { pattern: "(" })).rejects.toThrow();
  });
});

describe("BuiltinExecutor.killAll (T5 kill half)", () => {
  it("kills in-flight children via killAll", async () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    const running = exec.execute("Bash", { command: "sleep 30" });
    // let the child spawn
    await sleep(300);
    const pids = exec.activeChildPids();
    expect(pids.length).toBe(1);
    const pid = pids[0]!;
    exec.killAll();
    // poll until the process is gone
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
        await sleep(100);
      } catch {
        break; // ESRCH — gone
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
    await running;
  });

  it("abort signal triggers killAll", async () => {
    const running = exec.execute("Bash", { command: "sleep 30" });
    await sleep(300);
    const pid = exec.activeChildPids()[0]!;
    ac.abort();
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
        await sleep(100);
      } catch {
        break;
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
    await running;
  });
});
