import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CheckGroup = "prereq" | "config" | "agents" | "services";

export interface Check {
  name: string;
  group: CheckGroup;
  required: boolean;
  test: () => boolean | Promise<boolean>;
  remedy?: string;
}

// ── helpers ─────────────────────────────────────────────────────────────

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function brewServiceRunning(name: string): boolean {
  try {
    const out = execFileSync("brew", ["services", "list"], { encoding: "utf-8" });
    return out.split("\n").some((l) => l.startsWith(name) && l.includes("started"));
  } catch {
    return false;
  }
}

export async function httpProbe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ── required-env derivation from config.ts source ──────────────────────

/**
 * Scan src/config.ts source for `required("KEY")` call sites so the doctor's
 * env check mirrors the config loader exactly. Spec #157: do not hardcode —
 * `ANTHROPIC_API_KEY`, `MONGODB_URI`, `BG_TASK_AUTH_TOKEN` are optional-with-
 * fallback and must not false-positive.
 */
export function requiredEnvVarsFromConfig(configTsPath: string): string[] {
  const src = readFileSync(configTsPath, "utf-8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/\brequired\(\s*"([A-Z0-9_]+)"\s*\)/g)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

// ── launchctl print parsing ─────────────────────────────────────────────

export interface LaunchdState {
  loaded: boolean;
  state: "running" | "not running" | "unknown";
  pid: number | null;
}

export function launchctlPrint(label: string): LaunchdState {
  const uid = process.getuid?.();
  if (uid === undefined) return { loaded: false, state: "unknown", pid: null };
  try {
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stateMatch = out.match(/state\s*=\s*([^\n]+?)\s*$/m);
    const pidMatch = out.match(/pid\s*=\s*(\d+)/);
    const raw = stateMatch?.[1];
    const state = raw === "running" ? "running" : raw === "not running" ? "not running" : "unknown";
    return {
      loaded: true,
      state,
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
    };
  } catch {
    return { loaded: false, state: "unknown", pid: null };
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── live checks ────────────────────────────────────────────────────────

export async function mongoReachable(uri: string, dbName: string, timeoutMs = 2000): Promise<boolean> {
  // Dynamic import so unit tests can mock without pulling the driver at module load.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function hasAnyAgent(uri: string, dbName: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const count = await client.db(dbName).collection("agent_definitions").estimatedDocumentCount();
    return count > 0;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function defaultAgentExists(uri: string, dbName: string, defaultAgent: string): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const doc = await client.db(dbName).collection("agent_definitions").findOne({ id: defaultAgent });
    return doc !== null;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function slackAuthOk(botToken: string): Promise<boolean> {
  if (!botToken) return false;
  const { WebClient } = await import("@slack/web-api");
  try {
    const res = await new WebClient(botToken).auth.test();
    return res.ok === true;
  } catch {
    return false;
  }
}

// ── resolved paths ─────────────────────────────────────────────────────

/** Expand ~ in a path. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, process.env.HOME ?? "");
}

/** Resolve the service path that the LaunchAgent actually points at by reading
 *  the plist WorkingDirectory. Returns null if the plist cannot be read. */
export function resolveServicePath(label = "com.hive.agent"): string | null {
  const plist = expandHome(`~/Library/LaunchAgents/${label}.plist`);
  if (!existsSync(plist)) return null;
  const raw = readFileSync(plist, "utf-8");
  const m = raw.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? resolve(expandHome(m[1])) : null;
}
