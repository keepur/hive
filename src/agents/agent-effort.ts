/**
 * KPR-430: the static per-agent effort scale.
 *
 * By construction identical to the Claude Agent SDK's `EffortLevel` — the
 * runner pins that equality at compile time (agent-runner.ts), so an SDK
 * bump that adds or removes a level fails `npm run typecheck` instead of
 * silently narrowing or over-delivering. Distinct from `ReasoningEffort`
 * (provider-adapters/types.ts), the Lane B `:effort`-suffix scale, which
 * has `minimal`/`none` and no `max`.
 *
 * Dependency-free on purpose: agent-definition.ts, agent-config.ts,
 * agent-runner.ts, agent-manager.ts, turn-telemetry.ts and the admin tool
 * all import from here, and turn-telemetry.ts must not import from
 * agent-manager.ts (which already imports from turn-telemetry.ts).
 */
export const AGENT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type AgentEffort = (typeof AGENT_EFFORT_LEVELS)[number];

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (AGENT_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * KPR-430 D6: provenance of a delivered per-turn effort — telemetry only.
 *   static — the agent definition's `effort` field
 *   suffix — a Lane A model-string `:effort` suffix (KPR-346)
 *   router — the KPR-338 per-turn classifier
 *   pin    — the KPR-389 round-1 reaction pin ("low")
 * Written iff `effort` is written (agent-manager.ts telemetry stamp).
 */
export type EffortSource = "static" | "suffix" | "router" | "pin";
