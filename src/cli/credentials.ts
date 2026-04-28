/**
 * `hive credentials` — late-binding management of third-party API keys
 * stored in Honeypot. Uses the same CREDENTIAL_REGISTRY as the bootstrap
 * wizard so the surface stays consistent.
 *
 * Subcommands:
 *   list                Show curated keys + which ones are set
 *   add <KEY>           Interactive prompt to set/rotate one key
 *   remove <KEY>        Delete one key
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { CREDENTIAL_REGISTRY, findCredentialEntryByKey, type CredentialField } from "../setup/credential-registry.js";

export interface CredentialsCliIO {
  ask: (q: string) => Promise<string>;
  log: (msg: string) => void;
  setSecret: (key: string, value: string) => void;
  removeSecret: (key: string) => void;
  hasSecret: (key: string) => boolean;
  /** Called after the command finishes — closes readline in the prod adapter. */
  close?: () => void;
}

/** Production IO: real terminal + honeypot CLI. */
export function defaultCliIO(): CredentialsCliIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => new Promise((res) => rl.question(`${q}: `, (a) => res(a.trim()))),
    log: (m) => console.log(m),
    setSecret: (k, v) => execFileSync("honeypot", ["set", k, v], { stdio: ["pipe", "pipe", "pipe"] }),
    removeSecret: (k) => execFileSync("honeypot", ["rm", k], { stdio: ["pipe", "pipe", "pipe"] }),
    hasSecret: (k) => {
      try {
        execFileSync("honeypot", ["get", k], { stdio: ["pipe", "pipe", "pipe"] });
        return true;
      } catch {
        return false;
      }
    },
    close: () => rl.close(),
  };
}

export async function runCredentialsCommand(
  subcommand: string | undefined,
  args: string[],
  io: CredentialsCliIO = defaultCliIO(),
): Promise<number> {
  try {
    switch (subcommand) {
      case undefined:
      case "list":
      case "ls":
        return listCredentials(io);
      case "add":
        return await addCredential(args[0], io);
      case "remove":
      case "rm":
      case "delete":
        return removeCredential(args[0], io);
      case "help":
      case "--help":
      case "-h":
        return printHelp(io);
      default:
        io.log(`Unknown subcommand: ${subcommand}`);
        return printHelp(io);
    }
  } finally {
    io.close?.();
  }
}

function printHelp(io: CredentialsCliIO): number {
  io.log("Usage:");
  io.log("  hive credentials list                  Show curated keys and which are set");
  io.log("  hive credentials add <KEY>             Set or rotate a credential");
  io.log("  hive credentials remove <KEY>          Delete a credential");
  io.log("");
  io.log("Credentials are stored in macOS Keychain under hive/<instanceId>/<KEY>.");
  return 0;
}

function listCredentials(io: CredentialsCliIO): number {
  io.log("Third-party credentials (curated registry):");
  io.log("");
  for (const entry of CREDENTIAL_REGISTRY) {
    if (entry.kind === "oauth") {
      io.log(`  --  ${entry.server.padEnd(20)} oauth — ${entry.helpUrl}`);
      continue;
    }
    for (const field of entry.fields) {
      const present = io.hasSecret(field.key);
      const mark = present ? "ok" : "--";
      io.log(`  ${mark}  ${field.key.padEnd(24)} (${entry.server})`);
    }
  }
  io.log("");
  io.log("Add or rotate: hive credentials add <KEY>");
  io.log("Remove:        hive credentials remove <KEY>");
  return 0;
}

async function addCredential(key: string | undefined, io: CredentialsCliIO): Promise<number> {
  if (!key) {
    io.log("Usage: hive credentials add <KEY>");
    return 1;
  }
  const entry = findCredentialEntryByKey(key);
  if (!entry) {
    io.log(`Unknown key: ${key}.`);
    io.log("Run `hive credentials list` to see known keys.");
    return 1;
  }
  if (entry.kind === "oauth") {
    io.log(`${entry.server} uses OAuth, not a static API key.`);
    if (entry.oauthInstructions) io.log(entry.oauthInstructions);
    return 1;
  }
  const field = entry.fields.find((f) => f.key === key) as CredentialField;
  io.log(`${entry.title} — ${entry.description}`);
  io.log(`Get a key: ${entry.helpUrl}`);
  const value = await io.ask(field.label);
  if (!value) {
    io.log("Empty value — aborting.");
    return 1;
  }
  try {
    io.setSecret(key, value);
  } catch (err) {
    io.log(`Failed to store ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.log(`✓ ${key} stored in Honeypot.`);
  return 0;
}

function removeCredential(key: string | undefined, io: CredentialsCliIO): number {
  if (!key) {
    io.log("Usage: hive credentials remove <KEY>");
    return 1;
  }
  if (!io.hasSecret(key)) {
    io.log(`${key} is not set — nothing to remove.`);
    return 1;
  }
  try {
    io.removeSecret(key);
  } catch (err) {
    io.log(`Failed to remove ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.log(`- ${key} removed from Honeypot.`);
  return 0;
}
