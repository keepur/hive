/**
 * Autonomy flags — per-agent capability gates.
 *
 * Only capabilities with real external side effects, resource costs,
 * or information access implications are gated. Infrastructure
 * (reflection, compaction, backgroundTasks, etc.) is always on.
 *
 * Resolution: hardcoded default → instance ceiling → per-agent (restrict only).
 * - Hardcoded defaults are fallback values when instance config is absent.
 * - Instance ceiling (hive.yaml) sets the maximum for the installation.
 * - Per-agent can only restrict (AND with ceiling), never escalate.
 */

export interface AutonomyFlags {
  /** Outbound email/SMS via resend/quo servers */
  externalComms: boolean;
  /** Claude Code CLI sessions via code-task server */
  codeTask: boolean;
  /** Source code visibility via code-search server */
  codeAccess: boolean;
}

export const AUTONOMY_DEFAULTS: Readonly<AutonomyFlags> = {
  externalComms: true,
  codeTask: false,
  codeAccess: false,
};

/**
 * Resolve autonomy flags: hardcoded → instance ceiling → per-agent.
 *
 * Instance config overrides hardcoded defaults (can enable default-false flags).
 * Per-agent can only restrict below the instance ceiling (AND logic), never escalate.
 */
export function resolveAutonomy(
  instanceCeiling: Partial<AutonomyFlags> = {},
  agentOverrides?: Partial<AutonomyFlags>,
): AutonomyFlags {
  const result = {} as AutonomyFlags;
  for (const key of Object.keys(AUTONOMY_DEFAULTS) as (keyof AutonomyFlags)[]) {
    const ceiling = instanceCeiling[key] ?? AUTONOMY_DEFAULTS[key];
    // Agent can only restrict below ceiling (AND), never escalate
    result[key] = ceiling && (agentOverrides?.[key] ?? true);
  }
  return result;
}
