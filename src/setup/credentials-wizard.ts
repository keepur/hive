/**
 * Wizard stage that walks the curated CREDENTIAL_REGISTRY and seeds any
 * provided values into Honeypot. Skipping is first-class — every prompt
 * has a "no, not now" path that never aborts setup.
 *
 * IO is injected so tests can drive the flow without touching the real
 * terminal or `honeypot` CLI.
 */

import { execFileSync } from "node:child_process";
import { CREDENTIAL_REGISTRY } from "./credential-registry.js";

export interface CredentialsWizardIO {
  ask: (q: string, defaultVal?: string) => Promise<string>;
  /**
   * Same shape as `ask` but the value should be treated as a secret
   * (the prod adapter currently delegates to `ask` because the existing
   * wizard already does the same for tokens like SLACK_BOT_TOKEN — we
   * don't bring in a new dep for masked input here).
   */
  askSecret: (q: string) => Promise<string>;
  confirm: (q: string, defaultYes?: boolean) => Promise<boolean>;
  log: (msg: string) => void;
  setSecret: (key: string, value: string) => void;
  /** Probe whether a key is already stored. */
  hasSecret: (key: string) => boolean;
}

export interface CredentialsStageResult {
  /** Servers whose credentials are now (or remain) configured. */
  configured: string[];
  /** Servers the operator skipped or for which no value was collected. */
  skipped: string[];
}

/** Production setSecret — calls `honeypot set <KEY> <value>`. */
export function defaultSetSecret(key: string, value: string): void {
  execFileSync("honeypot", ["set", key, value], { stdio: ["pipe", "pipe", "pipe"] });
}

/** Production hasSecret — `honeypot get <KEY>` exits 0 iff the key exists. */
export function defaultHasSecret(key: string): boolean {
  try {
    execFileSync("honeypot", ["get", key], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the registry, prompting the operator for each entry. Always returns
 * — never throws on user "no". Returns the per-entry classification so
 * callers can print a summary or feed it into telemetry later.
 */
export async function runCredentialsStage(io: CredentialsWizardIO): Promise<CredentialsStageResult> {
  const configured: string[] = [];
  const skipped: string[] = [];

  io.log("");
  io.log("These are optional integrations. You can add any/all of them later");
  io.log("with `hive credentials add <KEY>`. Skipping is fine.");

  for (const entry of CREDENTIAL_REGISTRY) {
    io.log("");
    io.log(`── ${entry.title} ─────────────────────`);
    io.log(`  ${entry.description}`);
    io.log(`  Get a key: ${entry.helpUrl}`);

    if (entry.kind === "oauth") {
      io.log("");
      io.log(`  ${entry.oauthInstructions ?? ""}`);
      // OAuth entries are never stored here; we just acknowledge and move on.
      // Confirm-to-continue keeps the flow obvious in interactive mode and
      // is safe-to-skip (any answer = continue, treated as skipped).
      await io.confirm("Continue", true);
      skipped.push(entry.server);
      continue;
    }

    const allPresent = entry.fields.every((f) => io.hasSecret(f.key));
    if (allPresent) {
      io.log("  ✓ already configured");
      const redo = await io.confirm("Replace existing value?", false);
      if (!redo) {
        configured.push(entry.server);
        continue;
      }
    }

    const provide = await io.confirm("Provide a key now?", false);
    if (!provide) {
      skipped.push(entry.server);
      continue;
    }

    let allCollected = true;
    for (const field of entry.fields) {
      const value = field.secret === false ? await io.ask(field.label) : await io.askSecret(field.label);
      if (!value) {
        io.log(`  ⚠ Empty value for ${field.key} — skipping ${entry.server}.`);
        allCollected = false;
        break;
      }
      try {
        io.setSecret(field.key, value);
      } catch (err) {
        io.log(`  ⚠ Failed to store ${field.key}: ${err instanceof Error ? err.message : String(err)}`);
        allCollected = false;
        break;
      }
    }

    if (allCollected) {
      configured.push(entry.server);
      io.log(`  ✓ ${entry.server} stored in Honeypot`);
    } else {
      skipped.push(entry.server);
    }
  }

  io.log("");
  io.log(`── Credentials summary ─────────────────────`);
  io.log(`  Configured (${configured.length}): ${configured.join(", ") || "(none)"}`);
  io.log(`  Skipped (${skipped.length}):    ${skipped.join(", ") || "(none)"}`);
  io.log(`  Run \`hive credentials list\` later to review, \`hive credentials add <KEY>\` to add more.`);

  return { configured, skipped };
}
