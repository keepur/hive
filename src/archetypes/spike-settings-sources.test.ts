// Spike A permanent regression test.
//
// Validates the load-bearing assumption that `settingSources: ["project"]`
// causes the Claude Agent SDK to surface CLAUDE.md from the cwd into the
// model's context, without pulling Hive-hostile user/global settings.
//
// If this test fails, the archetype plumbing in agent-runner that relies on
// settingSources to inject workspace CLAUDE.md is broken — pivot to manually
// pre-loading CLAUDE.md into the system prompt card.

import { describe, it, expect } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/spike-a");
const SENTINEL = "SPIKE_A_SENTINEL_7f3c9a";

describe("Spike A — settingSources project loads CLAUDE.md", () => {
  it("CLAUDE.md content is visible to the model", async () => {
    const q = query({
      prompt:
        "There is a CLAUDE.md file at " +
        FIXTURE +
        "/CLAUDE.md that contains a sentinel token on its first line. " +
        "Respond with that first line verbatim and nothing else.",
      options: {
        model: "claude-haiku-4-5",
        cwd: FIXTURE,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 2,
        thinking: { type: "disabled" },
      },
    });

    let result = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") {
        result = msg.result;
      }
    }
    expect(result).toContain(SENTINEL);
  }, 120_000);
});
