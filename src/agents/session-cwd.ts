/**
 * KPR-348 (spec §D5-cwd): shared session-cwd resolution — extracted from
 * AgentRunner.send() so the Claude lane and the Lane B builtin executor
 * cannot drift. Archetype-provided cwd wins with a fail-loud stat check;
 * otherwise the per-agent scratch dir, lazily created (KPR-51).
 */
import { mkdirSync, statSync } from "node:fs";
import { hiveHome, agentScratchDir } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("session-cwd");

export function resolveSessionCwd(opts: { archetypeCwd: unknown; agentId: string }): string {
  const source: "archetype" | "default" = typeof opts.archetypeCwd === "string" ? "archetype" : "default";
  const effectiveCwd = source === "archetype" ? (opts.archetypeCwd as string) : agentScratchDir(opts.agentId, hiveHome);
  if (source === "default") {
    // Lazy create — fail loud on mkdir errors (permissions, read-only fs).
    mkdirSync(effectiveCwd, { recursive: true });
  } else {
    // Archetype path must already exist: operator-configured; a missing dir
    // is a misconfig surfaced at session start, not silently recreated.
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(effectiveCwd);
    } catch (err) {
      const msg = `Archetype cwd unavailable at session start — refusing to run: ${effectiveCwd} (${String(err)})`;
      log.error(msg, { agent: opts.agentId });
      throw new Error(msg);
    }
    if (!st.isDirectory()) {
      const msg = `Archetype cwd is not a directory: ${effectiveCwd}`;
      log.error(msg, { agent: opts.agentId });
      throw new Error(msg);
    }
  }
  return effectiveCwd;
}
