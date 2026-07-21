/**
 * KPR-348 (spec §D6): real archetype PreToolUse evaluation for the Lane B
 * guardrail gate — a PORT of buildHooks' semantics (agent-runner.ts), not a
 * modification of it. Same matcher production, same fail-closed posture:
 *  - preToolUseHooks() throw at production → deny-all gate (buildHooks'
 *    fallback reason shape, verbatim);
 *  - evaluation throw at call time → deny (plus the bridge wrapper's
 *    throw-is-deny rule — double containment);
 *  - first permissionDecision:"deny" wins; {continue:true}/allow/empty →
 *    keep going; no denial ⇒ allow.
 *
 * DOCUMENTED NARROWING (spec §D6): hooks consumed via this gate must depend
 * only on tool_name/tool_input (+ synthesized event fields) — true of the
 * only registered archetype (software-engineer) and pinned by T2. A future
 * archetype needing full CLI session fields extends this adapter
 * deliberately; it does not break silently.
 */
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { AgentConfig } from "../../types/agent-config.js";
import type { ArchetypeDefinition } from "../../archetypes/registry.js";
import type { WorkItemContext } from "../agent-runner.js";
import type { GuardrailGate } from "./types.js";

const log = createLogger("archetype-gate");

export function buildArchetypeGuardrailGate(
  config: AgentConfig,
  archetypeDef: ArchetypeDefinition,
  workItemContext?: WorkItemContext,
): GuardrailGate {
  let matchers: HookCallbackMatcher[];
  try {
    // Produced once at assembly — identical inputs to buildHooks (agent-runner.ts:1469-1473).
    matchers = archetypeDef.preToolUseHooks({
      agentConfig: config,
      archetypeConfig: config.archetypeConfig!,
      workItemContext,
    });
  } catch (err) {
    // Fail-closed parity with buildHooks' deny-all fallback (agent-runner.ts:1477-1495).
    log.error("Archetype preToolUseHooks threw — installing deny-all guardrail gate", {
      agent: config.id,
      archetype: config.archetype,
      error: String(err),
    });
    const reason = `Archetype hook initialization failed (${String(err)}). All tool calls blocked until the archetype is fixed.`;
    return async () => ({ behavior: "deny", reason });
  }

  // Archetype produced no PreToolUse matchers (e.g. software-engineer with
  // zero workspaces) → allow everything — identical to buildHooks installing
  // no PreToolUse hook.
  if (matchers.length === 0) {
    return async () => ({ behavior: "allow" });
  }

  const neverAborted = new AbortController();

  return async (call) => {
    try {
      // GuardrailToolCall → PreToolUse hook-input shape, best-effort session fields.
      const hookInput = {
        hook_event_name: "PreToolUse",
        tool_name: call.toolName,
        tool_input: (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, unknown>,
        session_id: "",
        transcript_path: "",
        cwd: "",
        permission_mode: "bypassPermissions",
      };
      for (const matcher of matchers) {
        // SDK matcher semantics: tool-name pattern when present; absent = all tools.
        if (matcher.matcher && !matchesToolName(matcher.matcher, call.toolName)) continue;
        for (const hook of matcher.hooks) {
          const out = await hook(hookInput as never, undefined, { signal: neverAborted.signal } as never);
          const hso = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)
            ?.hookSpecificOutput;
          if (hso?.permissionDecision === "deny") {
            return { behavior: "deny", reason: hso.permissionDecisionReason ?? "Denied by archetype tool policy." };
          }
          // allow decisions, {continue:true}, empty outputs → keep evaluating.
        }
      }
      return { behavior: "allow" };
    } catch (err) {
      // Any evaluation throw ⇒ deny (spec §D6 point 3).
      return { behavior: "deny", reason: `Archetype gate evaluation failed: ${String(err)}` };
    }
  };
}

function matchesToolName(pattern: string, toolName: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(toolName);
  } catch {
    // Unparseable matcher: treat as matching (evaluate the hook) — the
    // fail-closed direction for a policy hook.
    return true;
  }
}
