import { resolve } from "node:path";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { ArchetypeHookContext } from "../registry.js";
import type { SoftwareEngineerConfig } from "./config.js";
import { findWorkspace } from "./paths.js";

/**
 * Tools that mutate files and must be blocked inside workspaces.
 * Bash is intentionally omitted — not reliably parseable for mutation intent.
 * The system prompt card teaches the discipline; hooks enforce the hard line.
 */
const BLOCKED_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Extract the target file path from a tool's input.
 * Edit, Write, MultiEdit use `file_path`. NotebookEdit uses `notebook_path`.
 */
function extractPath(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  if (toolName === "NotebookEdit") {
    return (toolInput.notebook_path ?? toolInput.file_path) as string | undefined;
  }
  return toolInput.file_path as string | undefined;
}

export function preToolUseHooks(ctx: ArchetypeHookContext<SoftwareEngineerConfig>): HookCallbackMatcher[] {
  const cfg = ctx.archetypeConfig;

  // No workspaces → nothing to block
  if (cfg.workspaces.length === 0) return [];

  return [
    {
      hooks: [
        async (input) => {
          // Entire body wrapped in try/catch — fail-closed on any exception.
          // SDK is fail-open on hook throws, so we must never let an error escape.
          try {
            const hi = input as { tool_name?: string; tool_input?: Record<string, unknown> };
            const toolName = hi.tool_name ?? "";

            if (!BLOCKED_TOOLS.has(toolName)) {
              return { continue: true };
            }

            const rawPath = extractPath(toolName, hi.tool_input ?? {});
            if (typeof rawPath !== "string" || rawPath.length === 0) {
              // No path to check — let the SDK handle the missing-argument error
              return { continue: true };
            }

            const absPath = resolve(cfg.workshop, rawPath);
            const ws = findWorkspace(absPath, cfg);
            if (!ws) {
              // Inside workshop but outside any workspace — allowed
              return { continue: true };
            }

            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  `${toolName} blocked: \`${absPath}\` is inside workspace \`${ws.name}\`. ` +
                  `Code changes inside workspaces flow through \`code_task\`, not direct edits — ` +
                  `this preserves the spec \u2192 plan \u2192 PR \u2192 CI discipline. ` +
                  `If you're drafting a prototype, work inside the workshop outside any workspace. ` +
                  `If you're ready to implement against a ticket, use \`code_task\` with the ticket ID.`,
              },
            };
          } catch (err) {
            // Fail-closed: deny everything if our logic throws
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  `Software-engineer hook internal error: ${String(err)}. ` +
                  `All file mutations blocked until the archetype is fixed.`,
              },
            };
          }
        },
      ],
    },
  ];
}
