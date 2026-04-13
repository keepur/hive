import type { Db } from "mongodb";
import type { createLogger } from "../logging/logger.js";
import type { AgentDefinition } from "../types/agent-definition.js";

export const migration001BackfillHomeBase = {
  id: "001-backfill-home-base",
  async run(db: Db, log: ReturnType<typeof createLogger>): Promise<void> {
    const agentDefs = db.collection<AgentDefinition>("agent_definitions");
    const cursor = agentDefs.find({ homeBase: { $exists: false } });
    let updated = 0;
    let skipped = 0;
    for await (const doc of cursor) {
      const homeBase =
        doc.channels?.find((ch) => ch.startsWith("agent-")) ?? doc.channels?.[0];
      if (!homeBase) {
        log.warn("Cannot backfill homeBase — no channels", { agentId: doc._id });
        skipped++;
        continue;
      }
      await agentDefs.updateOne({ _id: doc._id }, { $set: { homeBase } });
      updated++;
    }
    log.info("Backfill complete", { migration: "001-backfill-home-base", updated, skipped });
  },
};
