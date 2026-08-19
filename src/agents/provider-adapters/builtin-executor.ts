/**
 * KPR-348 (spec §D5): the builtin executor — hive-native Bash/Read/Write/
 * Edit/Glob/Grep whose semantics match the agent-facing contract the tool
 * descriptions promise. Only {kind:"static"} schema producer in the fleet
 * (canon 1). Sandboxing posture: none beyond the guardrail gate — parity
 * with the Claude lane's bypassPermissions (DOD-212 lane-equivalence note
 * in the spec).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { glob } from "tinyglobby";
import type { HiveToolSchemaEntry } from "./tool-transport.js";

const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const OUTPUT_TRUNCATE_CHARS = 30_000;
const READ_DEFAULT_LIMIT = 2_000;
const READ_LINE_TRUNCATE = 2_000;
const GREP_MAX_FILE_BYTES = 5_000_000;
const KILL_GRACE_MS = 5_000;

const UNSUPPORTED_READ_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf", ".ipynb",
]);

export const EXECUTOR_BACKED_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
]);

export const BUILTIN_TOOL_DEFINITIONS: HiveToolSchemaEntry[] = [
  {
    name: "Bash",
    description:
      "Execute a bash command. Combined stdout+stderr is returned (truncated at 30000 chars); " +
      "a non-zero exit appends the exit code. Working directory and environment do NOT persist " +
      "between calls — use absolute paths. Default timeout 120000ms, max 600000ms. " +
      "For long-running detached work use the background task tools instead.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
        description: { type: "string", description: "Short description of what this command does" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "Read",
    description:
      "Read a text file. Returns cat -n style output (line numbers from 1). Reads up to 2000 " +
      "lines by default; use offset/limit for larger files. Long lines are truncated at 2000 chars. " +
      "Images, PDFs, and notebooks are not supported on this provider lane.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start reading from (1-based)" },
        limit: { type: "number", description: "Number of lines to read" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "Write",
    description: "Write a file, creating parent directories and overwriting any existing content.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "Edit",
    description:
      "Exact string replacement in a file. old_string must match exactly and (unless replace_all) " +
      "be unique in the file; old_string and new_string must differ.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to modify" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "Glob",
    description:
      "Find files matching a glob pattern (e.g. **/*.ts). Results are absolute paths sorted by " +
      "modification time, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Directory to search (default: session cwd)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "Grep",
    description:
      "Search file contents with a JavaScript regular expression. Supported options only: " +
      "glob file filter, output_mode (files_with_matches | content | count), case-insensitive, " +
      "line numbers, context lines.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (JavaScript syntax)" },
        path: { type: "string", description: "Directory or file to search (default: session cwd)" },
        glob: { type: "string", description: "Glob filter for files to search (e.g. *.ts)" },
        output_mode: {
          type: "string",
          enum: ["files_with_matches", "content", "count"],
          description: "Output shape (default files_with_matches)",
        },
        "-i": { type: "boolean", description: "Case-insensitive matching" },
        "-n": { type: "boolean", description: "Include line numbers (content mode)" },
        context: { type: "number", description: "Lines of context around each match (content mode)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

export class BuiltinExecutor {
  private readonly cwd: string;
  private readonly signal: AbortSignal;
  private readonly children = new Set<ChildProcess>();
  private readonly onAbort = () => this.killAll();

  constructor(opts: { cwd: string; signal: AbortSignal }) {
    this.cwd = opts.cwd;
    this.signal = opts.signal;
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /**
   * Throw-safe is NOT this layer's contract — the bridge wrapper contains
   * throws (§D3). This method throws freely on contract violations; the
   * error texts below that are RESULTS (not throws) are the agent-facing
   * failure modes the Claude lane also surfaces as results.
   */
  async execute(name: string, input: unknown): Promise<string> {
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    switch (name) {
      case "Bash":
        return this.bash(args);
      case "Read":
        return this.read(args);
      case "Write":
        return this.write(args);
      case "Edit":
        return this.edit(args);
      case "Glob":
        return this.globTool(args);
      case "Grep":
        return this.grep(args);
      default:
        return `Tool execution failed (${name}): unknown builtin`;
    }
  }

  /**
   * Test-only accessor: the live child pids (KPR-348 T5-kill assertion reads
   * these directly rather than shelling out to pgrep). Not part of the runtime
   * contract — the bridge/adapter never call it.
   */
  activeChildPids(): number[] {
    return [...this.children].map((c) => c.pid).filter((p): p is number => typeof p === "number");
  }

  /** SIGTERM the process groups, SIGKILL stragglers after the grace window. */
  killAll(): void {
    for (const child of this.children) {
      killGroup(child, "SIGTERM");
      const timer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      timer.unref();
    }
  }

  private bash(args: Record<string, unknown>): Promise<string> {
    const command = requireString(args, "command");
    const timeoutMs = Math.min(
      typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : BASH_DEFAULT_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS,
    );
    return new Promise((resolve) => {
      // argv array (CLAUDE.md no-shell-string rule governs ENGINE interpolation;
      // command is the agent's own surface — Claude-lane bypassPermissions parity).
      // detached: own process group, so abort/timeout kills the whole tree.
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: this.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      let output = "";
      let truncated = false;
      const append = (chunk: Buffer) => {
        if (output.length >= OUTPUT_TRUNCATE_CHARS) {
          truncated = true;
          return;
        }
        output += chunk.toString("utf8");
        if (output.length > OUTPUT_TRUNCATE_CHARS) {
          output = output.slice(0, OUTPUT_TRUNCATE_CHARS);
          truncated = true;
        }
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs);
      timer.unref();
      child.on("error", (err) => {
        clearTimeout(timer);
        this.children.delete(child);
        resolve(`Tool execution failed (Bash): ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        let text = output;
        if (truncated) text += "\n[output truncated at 30000 characters]";
        if (timedOut) text += `\n[command timed out after ${timeoutMs}ms and was killed]`;
        else if (code !== null && code !== 0) text += `\nExit code ${code}`;
        resolve(text);
      });
    });
  }

  private async read(args: Record<string, unknown>): Promise<string> {
    const filePath = requireString(args, "file_path");
    if (UNSUPPORTED_READ_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      return `Read failed: ${extname(filePath)} files are not supported on this provider lane (text files only)`;
    }
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return `Read failed: file not found: ${filePath}`;
    }
    if (st.isDirectory()) return `Read failed: ${filePath} is a directory`;
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : READ_DEFAULT_LIMIT;
    const window = lines.slice(offset - 1, offset - 1 + limit);
    const body = window
      .map((line, i) => {
        const n = offset + i;
        const text = line.length > READ_LINE_TRUNCATE ? `${line.slice(0, READ_LINE_TRUNCATE)}… [line truncated]` : line;
        return `${String(n).padStart(6)}\t${text}`;
      })
      .join("\n");
    const remaining = lines.length - (offset - 1 + window.length);
    return remaining > 0 ? `${body}\n[${remaining} more lines — use offset/limit to read further]` : body;
  }

  private async write(args: Record<string, unknown>): Promise<string> {
    const filePath = requireString(args, "file_path");
    const content = requireString(args, "content", { allowEmpty: true });
    mkdirSync(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
  }

  private async edit(args: Record<string, unknown>): Promise<string> {
    const filePath = requireString(args, "file_path");
    const oldString = requireString(args, "old_string");
    const newString = requireString(args, "new_string", { allowEmpty: true });
    const replaceAll = args.replace_all === true;
    if (oldString === newString) return "Edit failed: old_string and new_string are identical";
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return `Edit failed: file not found: ${filePath}`;
    }
    const count = raw.split(oldString).length - 1;
    if (count === 0) return `Edit failed: old_string not found in ${filePath}`;
    if (count > 1 && !replaceAll) {
      return `Edit failed: old_string matches ${count} locations in ${filePath} — make it unique or pass replace_all: true`;
    }
    const next = replaceAll ? raw.split(oldString).join(newString) : raw.replace(oldString, newString);
    await writeFile(filePath, next, "utf8");
    return `Edited ${filePath} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? "s" : ""})`;
  }

  private async globTool(args: Record<string, unknown>): Promise<string> {
    const pattern = requireString(args, "pattern");
    const searchPath = typeof args.path === "string" ? args.path : this.cwd;
    const matches = await glob(pattern, { cwd: searchPath, absolute: true, dot: false });
    if (matches.length === 0) return "No files found";
    const withMtime = await Promise.all(
      matches.map(async (m) => {
        try {
          return { m, mtime: (await stat(m)).mtimeMs };
        } catch {
          return { m, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.map((e) => e.m).join("\n");
  }

  private async grep(args: Record<string, unknown>): Promise<string> {
    const pattern = requireString(args, "pattern");
    const flags = args["-i"] === true ? "i" : "";
    const re = new RegExp(pattern, flags); // invalid regex throws → bridge contains it
    const searchPath = typeof args.path === "string" ? args.path : this.cwd;
    const mode = typeof args.output_mode === "string" ? args.output_mode : "files_with_matches";
    const withLineNumbers = args["-n"] === true;
    const context = typeof args.context === "number" && args.context > 0 ? Math.floor(args.context) : 0;

    let files: string[];
    const st = await stat(searchPath).catch(() => null);
    if (st?.isFile()) {
      files = [searchPath];
    } else {
      const filePattern = typeof args.glob === "string" ? `**/${args.glob}` : "**/*";
      files = await glob(filePattern, {
        cwd: searchPath,
        absolute: true,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
      });
    }

    const out: string[] = [];
    let totalChars = 0;
    for (const file of files) {
      const fst = await stat(file).catch(() => null);
      if (!fst?.isFile() || fst.size > GREP_MAX_FILE_BYTES) continue;
      const raw = await readFile(file, "utf8").catch(() => null);
      if (raw === null || raw.includes("\0")) continue; // unreadable / binary
      const lines = raw.split("\n");
      const matchIdx: number[] = [];
      lines.forEach((line, i) => {
        if (re.test(line)) matchIdx.push(i);
      });
      if (matchIdx.length === 0) continue;
      if (mode === "files_with_matches") {
        out.push(file);
      } else if (mode === "count") {
        out.push(`${file}: ${matchIdx.length}`);
      } else {
        out.push(`== ${file} ==`);
        const emitted = new Set<number>();
        for (const i of matchIdx) {
          for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
            if (emitted.has(j)) continue;
            emitted.add(j);
            out.push(withLineNumbers ? `${j + 1}: ${lines[j]}` : lines[j]);
          }
        }
      }
      totalChars = out.reduce((n, s) => n + s.length + 1, 0);
      if (totalChars > OUTPUT_TRUNCATE_CHARS) {
        out.push("[grep output truncated at 30000 characters]");
        break;
      }
    }
    return out.length > 0 ? out.join("\n") : "No matches found";
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  opts?: { allowEmpty?: boolean },
): string {
  const v = args[key];
  if (typeof v !== "string" || (v.length === 0 && !opts?.allowEmpty)) {
    throw new Error(`missing required string parameter '${key}'`); // bridge wrapper contains this
  }
  return v;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal); // negative pid = process group (detached:true)
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
