#!/usr/bin/env npx tsx
/**
 * Core-server drift check — fails if any agent's `coreServers` names a server
 * the engine cannot resolve.
 *
 * WHY THIS EXISTS
 * ---------------
 * A name in `coreServers` that the engine doesn't know is dropped with ZERO
 * log output. There is no error, no warning, no missing-tool message — the
 * agent simply runs without the capability. The existing "Delegate server not
 * found, skipping" warning cannot catch it: by definition that fires only for
 * DELEGATE servers.
 *
 * That silence is not hypothetical. Seven agents (Bill, Diana, Lily, Nora,
 * Ross, Stefan, Warren) were configured for `ollama` and had none of it for
 * weeks, because a routine deploy overwrote the untracked
 * `.hive/pkg/mcp/ollama.min.js` bundle and nothing said a word. Nobody noticed
 * until someone went looking.
 *
 * There are two guards against a repeat, and they catch it at different times:
 *   1. RUNTIME — `AgentRunner.buildToolTransportInventory()` logs a
 *      `log.error` naming any unresolved core server, once per runner. Catches
 *      drift for real agents in production, but only once an agent actually runs.
 *   2. THIS SCRIPT — a static diff of every stored agent definition against the
 *      engine's server catalog. Catches drift BEFORE agents run, so it can gate
 *      a deploy.
 *
 * Run it against an instance after any deploy or agent-definition change:
 *   npm run check:core-servers -- --instance catalyst
 *
 * Exit codes: 0 = clean, 1 = drift found (or bad usage).
 *
 * Env: MONGODB_URI (default mongodb://localhost:27017)
 */

import { MongoClient } from "mongodb";
import { SERVER_CATALOG } from "../src/tools/server-catalog.js";
import { IN_PROCESS_PORTED_SERVERS } from "../src/agents/in-process-servers.js";

/**
 * Injected by the engine for every agent regardless of config — see
 * `AgentRunner.autoInjectedServerNames()`. These legitimately need no catalog
 * entry. `workflow` is feature-flagged but always a real server name, so it is
 * never drift.
 */
const AUTO_INJECTED = ["schedule", "team", "team-roster", "skill-author", "workflow"];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const instance = arg("--instance");
  if (!instance) {
    console.error("Usage: npm run check:core-servers -- --instance <id>");
    process.exit(1);
  }

  // The union of every server name the engine can actually resolve.
  const known = new Set<string>([...Object.keys(SERVER_CATALOG), ...IN_PROCESS_PORTED_SERVERS, ...AUTO_INJECTED]);

  const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
  await client.connect();
  try {
    const agents = await client
      .db(`hive_${instance}`)
      .collection("agent_definitions")
      .find({}, { projection: { name: 1, coreServers: 1, disabled: 1 } })
      .toArray();

    if (agents.length === 0) {
      console.error(`error: no agent definitions in hive_${instance} — wrong instance?`);
      process.exit(1);
    }

    // server name -> agents naming it but unable to get it
    const drift = new Map<string, string[]>();
    for (const a of agents) {
      if (a.disabled) continue;
      for (const server of (a.coreServers as string[] | undefined) ?? []) {
        if (known.has(server)) continue;
        if (!drift.has(server)) drift.set(server, []);
        drift.get(server)!.push(String(a.name));
      }
    }

    if (drift.size === 0) {
      console.log(
        `OK: ${agents.length} agent(s) in hive_${instance}; every coreServers name resolves to a real server.`,
      );
      return;
    }

    console.error(`FAIL: ${drift.size} unresolvable core server name(s) in hive_${instance}.`);
    console.error(`These agents are configured for capabilities they do NOT have, and will say nothing about it:\n`);
    for (const [server, named] of [...drift].sort()) {
      console.error(`  "${server}" — ${named.length} agent(s): ${named.sort().join(", ")}`);
    }
    console.error(`\nEither the server was removed/renamed in the engine, the agent definition has a typo,`);
    console.error(`or a bundle vanished on deploy. Fix the definition or restore the server.`);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
