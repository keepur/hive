import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../logging/logger.js";

const log = createLogger("integrity");

interface SnapshotEntry {
  path: string;
  hash: string;
}

export function verifyPackageIntegrity(hiveHome: string, hiveStateDir: string): { ok: boolean; warnings: string[] } {
  const snapshotPath = resolve(hiveStateDir, "installed-snapshot.json");
  if (!existsSync(snapshotPath)) {
    log.warn("No installed-snapshot.json — skipping integrity check (first install?)");
    return { ok: true, warnings: [] };
  }

  const parsed = JSON.parse(readFileSync(snapshotPath, "utf-8"));
  if (!Array.isArray(parsed)) {
    return { ok: false, warnings: [`installed-snapshot.json is malformed (expected array, got ${typeof parsed})`] };
  }
  const snapshot: SnapshotEntry[] = parsed;
  const drift: string[] = [];

  for (const entry of snapshot) {
    const fullPath = resolve(hiveHome, entry.path);
    if (!existsSync(fullPath)) {
      drift.push(`missing: ${entry.path}`);
      continue;
    }
    const content = readFileSync(fullPath);
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== entry.hash) {
      drift.push(`modified: ${entry.path}`);
    }
  }

  if (drift.length > 0) {
    log.error("Package integrity check FAILED — refusing to start", { drift });
    throw new Error(
      `Package integrity check failed. ${drift.length} file(s) have been modified or are missing:\n` +
        drift.map((d) => `  - ${d}`).join("\n") +
        `\nReinstall with: npm install @keepur/hive@<version>`,
    );
  }

  return { ok: true, warnings: [] };
}

export function checkAllowlistDrift(hiveHome: string): void {
  const ALLOWLISTED = [
    "skills",
    "plugins",
    "workflow",
    "data",
    "agents",
    "logs",
    ".hive",
    ".hive-state",
    ".env",
    "hive.yaml",
    "hive-",
    "beekeeper.yaml",
    ".hive-generated.json",
  ];

  try {
    const entries = readdirSync(hiveHome);
    const warnings: string[] = [];

    for (const entry of entries) {
      if (ALLOWLISTED.some((p) => entry.startsWith(p))) continue;
      warnings.push(entry);
    }

    if (warnings.length > 0) {
      log.warn("Unexpected files in instance directory", { files: warnings });
    }
  } catch {
    // Non-fatal
  }
}

export function writeSnapshot(stateDir: string, packageRoot: string, declaredFiles: string[]): void {
  const entries: SnapshotEntry[] = [];
  for (const file of declaredFiles) {
    const fullPath = resolve(packageRoot, file);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).isDirectory()) {
      walkDir(fullPath, file, entries);
    } else {
      const content = readFileSync(fullPath);
      entries.push({ path: file, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "installed-snapshot.json"), JSON.stringify(entries, null, 2));
}

function walkDir(dir: string, prefix: string, entries: SnapshotEntry[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      walkDir(full, rel, entries);
    } else {
      const content = readFileSync(full);
      entries.push({ path: rel, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
}
