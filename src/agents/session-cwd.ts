/**
 * KPR-435: simplified from KPR-348's per-agent-vs-override cwd resolver —
 * the override mechanism was removed, so this now just resolves the
 * per-agent scratch dir, lazily created (KPR-51). Kept as a named export
 * (rather than inlined at the two call sites) so AgentRunner's Claude-lane
 * and Lane-B cwd resolution stay provably identical.
 */
import { mkdirSync } from "node:fs";
import { hiveHome, agentScratchDir } from "../paths.js";

export function resolveSessionCwd(agentId: string): string {
  const effectiveCwd = agentScratchDir(agentId, hiveHome);
  mkdirSync(effectiveCwd, { recursive: true });
  return effectiveCwd;
}
