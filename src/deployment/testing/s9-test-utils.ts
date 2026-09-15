import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HelperResult, S9Fixture } from "./s9-harness.js";
import { continueLatch, invokeHelper, waitFor } from "./s9-harness.js";
import type { PackedRelease } from "./s9-packages.js";

export const INTEGRATION_TIMEOUT_MS = 15 * 60_000;

export function parseHelperJson(text: string): Record<string, unknown> {
  const chunks = [text.trim(), ...text.trim().split("\n").reverse()];
  for (const chunk of chunks) {
    const start = chunk.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(chunk.slice(start)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // keep scanning
    }
  }
  throw new Error(`helper produced no JSON result:\n${text.slice(-2_000)}`);
}

export function helperResult(result: HelperResult): Record<string, unknown> {
  const combined = `${result.stdout}\n${result.stderr}`;
  try {
    return parseHelperJson(combined);
  } catch {
    return { status: "UNPARSED", stdout: result.stdout, stderr: result.stderr, exit: result.status };
  }
}

export function bootstrapArgs(packed: PackedRelease): string[] {
  return ["--bootstrap", `--artifact=${packed.tgz}`, `--sha256=${packed.sha256}`, `--revision=${packed.revision}`];
}

export function invokeBootstrap(fixture: S9Fixture, packed: PackedRelease): HelperResult {
  return invokeHelper(fixture, bootstrapArgs(packed));
}

export function events(fixture: S9Fixture): string[] {
  const path = join(fixture.control, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return String((JSON.parse(line) as { type?: string }).type ?? line);
      } catch {
        return line;
      }
    });
}

export function oldUpdaterCalled(fixture: S9Fixture): boolean {
  const log = join(fixture.hiveHome, "old-updater.log");
  return existsSync(log) && readFileSync(log, "utf8").includes("OLD_UPDATER_CALLED");
}

export function plistProgramArguments(plistPath: string): string {
  return readFileSync(plistPath, "utf8");
}

export function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (entry === name) return path;
      try {
        stack.push(path);
      } catch {
        // not a directory
      }
    }
  }
  return null;
}

export function findT7Job(fixture: S9Fixture): string | null {
  const pidPath = findFile(join(fixture.hiveHome, ".hive-state", "jobs"), ".t7-writer.pid");
  return pidPath ? pidPath.replace(/\/\.t7-writer\.pid$/, "") : null;
}

export function writeT7Latch(job: string, name: string, hiveHome?: string): void {
  const roots = [job];
  if (hiveHome) {
    roots.push(join(hiveHome, ".hive.next"), join(hiveHome, ".hive"));
  }
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      writeFileSync(join(root, `.t7-${name}`), "1\n");
      return;
    } catch {
      // renamed out from under us
    }
  }
  throw new Error(`T7 latch root missing for ${name}`);
}

export function waitT7Job(fixture: S9Fixture, timeoutMs = 600_000): string {
  if (!waitFor(() => findT7Job(fixture) !== null, timeoutMs)) {
    const jobs = join(fixture.hiveHome, ".hive-state", "jobs");
    const listing = existsSync(jobs) ? readdirSync(jobs).join(",") : "missing";
    throw new Error(`T7 writer job not observed under ${jobs} (${listing})`);
  }
  return findT7Job(fixture)!;
}

export function helperLogTail(fixture: S9Fixture, bytes = 6_000): string {
  const parts: string[] = [];
  for (const name of ["helper.stdout", "helper.stderr", "events.jsonl"] as const) {
    const path = join(fixture.control, name);
    if (!existsSync(path)) {
      parts.push(`--- ${name} missing ---`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    parts.push(`--- ${name} ---\n${text.slice(-bytes)}`);
  }
  return parts.join("\n");
}

export function waitLatchWaiting(fixture: S9Fixture, name: string, timeoutMs = 600_000): void {
  const flag = join(fixture.control, "latches", `${name}.waiting`);
  if (!waitFor(() => existsSync(flag), timeoutMs)) {
    throw new Error(`latch ${name} never armed\n${helperLogTail(fixture)}`);
  }
}

export function releaseLatch(fixture: S9Fixture, name: string): void {
  continueLatch(fixture, name);
}

export function secretsLeak(text: string, fixture: S9Fixture): string[] {
  const banned = [fixture.mongo.uri, "s9-lk-secret-s9-lk-secret", "s9-bridge-token", "xoxb-s9-dummy", "xapp-s9-dummy"];
  return banned.filter((value) => text.includes(value));
}

export function operationRecords(fixture: S9Fixture): string[] {
  const root = join(fixture.hiveHome, ".hive-state", "deployment");
  const found: string[] = [];
  const stack = existsSync(root) ? [root] : [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (entry.endsWith(".json") || entry === "operation.json") found.push(path);
      try {
        if (statSync(path).isDirectory()) stack.push(path);
      } catch {
        // vanished
      }
    }
  }
  return found;
}
