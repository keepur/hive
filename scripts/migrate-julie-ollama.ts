#!/usr/bin/env npx tsx
/**
 * One-time migration: grant Julie (HR Business Partner) local-model inference.
 *
 * Approved by Tony 2026-09-16 as part of the ollama-coreServers restoration.
 *
 * Operations (idempotent, safe to re-run):
 *   1. Add "ollama" to Julie's `coreServers` if absent.
 *   2. Append the Personnel Data privacy boundary to Julie's `soul` if absent
 *      (detected by the GUARDRAIL_MARKER heading).
 *
 * Usage:
 *   npx tsx scripts/migrate-julie-ollama.ts --instance catalyst            # dry-run
 *   npx tsx scripts/migrate-julie-ollama.ts --instance catalyst --apply    # commit
 *   npx tsx scripts/migrate-julie-ollama.ts --instance catalyst --rollback --apply
 *
 * Env: MONGODB_URI (default mongodb://localhost:27017)
 *
 * *** RUN ORDER MATTERS — read this before applying. ***
 * Do NOT apply this until an engine build containing the in-process `ollama`
 * server (src/ollama/ollama-mcp-server.ts) is actually deployed. A core server
 * named in config but absent from the running engine resolves to nothing and
 * the agent silently lacks the tools — that is the exact failure that cost the
 * other seven agents their Ollama access for weeks. Config after code, always.
 */

import { MongoClient } from "mongodb";

const AGENT_NAME = "Julie";
const SERVER = "ollama";

/** Idempotency marker — if Julie's soul contains this, the guardrail is in. */
const GUARDRAIL_MARKER = "## Personnel Data — Privacy Boundary";

/**
 * Mirrors the shape of Ross's legal-privacy guardrail: two named paths, an
 * explicit trigger list, and a closing clause forbidding the quiet easy path.
 * Deliberately a PRIVACY boundary, not a cost escape hatch — routing HR work
 * to a weaker model by guess is silent quality degradation where it does the
 * most damage.
 */
const GUARDRAIL = `
${GUARDRAIL_MARKER}

**Local model (privacy-preserving) — use for anything about a named person.**
Use this for: performance reviews, compensation figures, disciplinary records, health or
accommodation matters, hiring decisions about identified candidates, exit conversations,
anything involving a real employee's name attached to an evaluation.

**Frontier model (capability) — use only for general, non-personal material.**
Policy drafting, process design, market-rate research, template writing.

**The rule:** If the question names a real person and attaches a judgment to them, it runs
locally. Never route identifiable personnel material to a cloud model because the answer would
be better. If local capability is genuinely insufficient for a personnel question, say so and
ask Mike — do not silently upgrade.
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const instance = arg("--instance");
  if (!instance) {
    console.error("Usage: npx tsx scripts/migrate-julie-ollama.ts --instance <id> [--apply] [--rollback]");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const dbName = `hive_${instance}`;

  const client = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
  await client.connect();
  try {
    const col = client.db(dbName).collection("agent_definitions");
    // NB: agent_definitions has NO `agent_id` field. The key is `name`, title
    // case. Querying {agent_id:"julie"} returns null and looks like "not wired".
    const julie = await col.findOne({ name: AGENT_NAME });
    if (!julie) {
      console.error(`${AGENT_NAME} not found in ${dbName}.agent_definitions — wrong instance?`);
      process.exit(1);
    }

    const core: string[] = Array.isArray(julie.coreServers) ? julie.coreServers : [];
    const soul: string = typeof julie.soul === "string" ? julie.soul : "";
    const hasServer = core.includes(SERVER);
    const hasGuardrail = soul.includes(GUARDRAIL_MARKER);

    console.log(`Target: ${dbName}.agent_definitions / ${AGENT_NAME}`);
    console.log(`  coreServers now : ${JSON.stringify(core)}`);
    console.log(`  has "${SERVER}"      : ${hasServer}`);
    console.log(`  has guardrail   : ${hasGuardrail}`);
    console.log(`  soul length     : ${soul.length}`);

    const set: Record<string, unknown> = {};

    if (rollback) {
      if (hasServer) set.coreServers = core.filter((s) => s !== SERVER);
      if (hasGuardrail) set.soul = soul.replace(GUARDRAIL, "").trimEnd();
      if (Object.keys(set).length === 0) {
        console.log("\nNothing to roll back — already clean.");
        return;
      }
      console.log(`\nROLLBACK plan: remove "${SERVER}" from coreServers and strip the guardrail.`);
    } else {
      if (!hasServer) set.coreServers = [...core, SERVER];
      if (!hasGuardrail) set.soul = `${soul.trimEnd()}\n${GUARDRAIL}`;
      if (Object.keys(set).length === 0) {
        console.log("\nNo change needed — migration already applied.");
        return;
      }
      console.log(`\nPlan:`);
      if (set.coreServers) console.log(`  coreServers -> ${JSON.stringify(set.coreServers)}`);
      if (set.soul) console.log(`  soul        -> append ${GUARDRAIL.length} chars (privacy boundary)`);
    }

    if (!apply) {
      console.log("\nDRY RUN — no write performed. Re-run with --apply to commit.");
      return;
    }

    set.updatedAt = new Date();
    set.updatedBy = "jim/migrate-julie-ollama";
    const res = await col.updateOne({ name: AGENT_NAME }, { $set: set });
    console.log(`\nAPPLIED — matched ${res.matchedCount}, modified ${res.modifiedCount}.`);
    console.log("Restart/redeploy required for the agent to pick up the new core server.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
