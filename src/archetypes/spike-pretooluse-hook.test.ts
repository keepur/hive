// Spike B permanent regression test.
//
// Validates two load-bearing assumptions of the archetype enforcement model:
//  1. PreToolUse hooks fire under permissionMode: "bypassPermissions" +
//     allowDangerouslySkipPermissions: true, and a `deny` decision is
//     respected (the Edit does not happen).
//  2. Empirical behavior when a hook throws.
//
// NOTE: SDK is fail-open on hook exceptions — Layer 2 hooks MUST wrap their
// bodies in try/catch and return explicit deny on errors. Empirically
// verified 2026-04-09 against @anthropic-ai/claude-agent-sdk: a hook that
// throws allows the tool call to proceed normally (file gets mutated). The
// second test below asserts this CURRENT behavior so that it passes today;
// when the SDK starts fail-closing on hook throws, this test will break and
// alert us to revisit the Layer 2 try/catch mandate. The denial path in
// test 1 is the load-bearing guarantee — test 2 is observational.

import { describe, it, expect, beforeEach } from "vitest";
import { query, type HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/spike-b");
const TARGET = resolve(FIXTURE, "DENIED_target.txt");
const INITIAL = "initial content — must not change";

// Skip when running inside a Claude Code session — the SDK refuses to nest
// (`CLAUDECODE` is set by the parent harness). Run this test standalone with:
//   env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT npx vitest run src/archetypes/spike-pretooluse-hook.test.ts
const SKIP_NESTED = !!process.env.CLAUDECODE;

beforeEach(() => {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(TARGET, INITIAL, "utf-8");
});

describe.skipIf(SKIP_NESTED)("Spike B — PreToolUse hook fires under bypassPermissions", () => {
  it("denies Edit, file unchanged, agent sees error", async () => {
    let fired = 0;
    const denyHook: HookCallbackMatcher = {
      matcher: "Edit",
      hooks: [
        async (input) => {
          fired++;
          const path = (input as { tool_input?: { file_path?: string } })?.tool_input?.file_path ?? "";
          if (path.includes("DENIED_")) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "spike B denial — test sentinel",
              },
            };
          }
          return { continue: true };
        },
      ],
    };

    const q = query({
      prompt: `Use the Edit tool to replace the content of ${TARGET} with the single word "MUTATED". If Edit is denied or blocked, explain clearly that it was denied.`,
      options: {
        model: "claude-haiku-4-5",
        cwd: FIXTURE,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 4,
        thinking: { type: "disabled" },
        hooks: { PreToolUse: [denyHook] },
      },
    });

    let lastText = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") lastText = msg.result;
    }

    expect(fired).toBeGreaterThan(0);
    expect(readFileSync(TARGET, "utf-8")).toBe(INITIAL);
    expect(lastText.toLowerCase()).toMatch(/denied|blocked|not allowed|cannot|unable/);
  }, 180_000);

  it("observes SDK fail-open behavior on hook exception", async () => {
    const throwHook: HookCallbackMatcher = {
      matcher: "Edit",
      hooks: [
        async () => {
          throw new Error("intentional hook throw");
        },
      ],
    };

    const q = query({
      prompt: `Use the Edit tool to replace the content of ${TARGET} with the single word "MUTATED".`,
      options: {
        model: "claude-haiku-4-5",
        cwd: FIXTURE,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        thinking: { type: "disabled" },
        hooks: { PreToolUse: [throwHook] },
      },
    });

    for await (const _ of q) {
      /* drain */
    }
    // Empirically: SDK is fail-open on hook throws. The Edit proceeds and
    // the file gets mutated. Layer 2 archetype hooks MUST therefore wrap
    // their bodies in try/catch and explicitly return a deny decision on
    // any internal exception — there is no SDK-level safety net.
    //
    // This assertion pins the observed behavior. If the SDK is ever changed
    // to fail-closed, this test will break and we should:
    //   (a) celebrate — the extra safety net is now in place, and
    //   (b) flip the assertion back to `toBe(INITIAL)` and re-examine
    //       whether the Layer 2 try/catch requirement can be relaxed.
    expect(readFileSync(TARGET, "utf-8")).toBe("MUTATED");
  }, 180_000);
});
