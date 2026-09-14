/**
 * KPR-468 chunk 6 — the STRUCTURAL half of the acceptance suite.
 *
 * Two criterion `describe`s live here rather than in
 * `notifier-acceptance.integration.test.ts`: AC2 in full (its three
 * source-tree scans) and AC15's structural half. AC15's RUNTIME half — and
 * every other criterion — is in the acceptance file, which cross-references
 * this one rather than duplicating these scans.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// The notifier's OWN file set — KPR-454's producer modules and every test
// double are excluded, because this constrains the notifier's sources rather
// than its siblings or its harness.
const NOTIFIER_FILES = [
  "notification-types.ts",
  "transport.ts",
  "slack-transport.ts",
  "notification-store.ts",
  "ingest.ts",
  "delivery.ts",
  "notifier.ts",
  "intake.ts",
  "notifier-singleton.ts",
].map((f) => join(here, f));

describe("AC2 — the notifier never evaluates a match and is off the turn path", () => {
  it("imports src/ops/match.ts from nowhere in its own file set (C2, C17)", () => {
    // Re-evaluation would let a subscription registered after accept acquire a
    // past event, contradicting D5, and would make the stored count a lie.
    for (const file of NOTIFIER_FILES) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+"\.\/match\.js"/);
    }
  });

  it("is imported by no turn-path module (containment (a))", () => {
    // "Off the turn path" is a CHECKED property here, not a claim.
    const turnPath = [
      "agents/agent-runner.ts",
      "agents/provider-adapters/tool-bridge.ts",
      "channels/dispatcher.ts",
      "agents/agent-manager.ts",
    ].map((rel) => readFileSync(join(here, "..", rel), "utf8"));
    for (const source of turnPath) {
      expect(source).not.toMatch(
        /from\s+"[^"]*ops\/(notifier|intake|delivery|ingest|transport|slack-transport|notification-)/,
      );
    }
  });

  it("imports nothing from src/obligations/ (KPR-456 contract separation)", () => {
    // KPR-456's poster, its PostOutcome taxonomy and its NONACCEPTANCE set are
    // a separate contract epic canon preserves in force. The hardening is
    // COPIED into slack-transport.ts, never imported.
    for (const file of sources(here)) {
      if (file.includes("/testing/")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+"[^"]*obligations\//);
    }
  });
});

describe("AC15 — activity_log is not a failure oracle here (C12)", () => {
  it("reads no activity_log field and touches neither agent_events nor the scheduler", () => {
    for (const file of NOTIFIER_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/activity_log|costUsd|agent_events|EVENT_SCHEMAS|checkEvents/);
    }
  });

  // The regression-surface bullet this AC is tied to also names the
  // `subscribe:` agent-definition field, delivery routing, the retry queue
  // and the outage queue — none of which the assertion above's regex
  // touches. Widened here rather than folded into the regex above: the
  // `subscribe:` token needs its own care (`OpsSubscription`/`subscriptionId`
  // are legitimate and pervasive in these files; only the literal
  // colon-terminated field key is checked) and the queue/routing modules are
  // checked by import path, which also catches a re-implemented parallel
  // queue that never spells either module's name.
  it("imports nothing from the dispatcher, the retry queue or the outage queue, and never names the subscribe: field", () => {
    for (const file of NOTIFIER_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+"[^"]*\/(channels|sweeper|outage)\//);
      expect(source, file).not.toMatch(/outage_queue|outageQueue|retryQueue|retry-queue|retry_queue/);
      expect(source, file).not.toMatch(/subscribe:/);
    }
  });
});
