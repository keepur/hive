import { defineAgent, cli, WorkerOptions, type JobContext } from "@livekit/agents";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logging/logger.js";
import { resolveCell } from "./cells.js";
import { parseDispatchMetadata } from "./dispatch-meta.js";
import { runCallSession } from "./session.js";
import { VoiceWorkerHeartbeat } from "./telemetry.js";
import { loadWorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker");

/** Bound in the CLI boot path only — stays undefined when this module is imported by tests. */
let workerHeartbeat: VoiceWorkerHeartbeat | undefined;

export type { DispatchMetadata } from "./dispatch-meta.js";
export { parseDispatchMetadata } from "./dispatch-meta.js";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const wc = loadWorkerConfig();
    const meta = parseDispatchMetadata(ctx.job.metadata);
    const cell = resolveCell(meta, wc);
    await runCallSession(ctx, wc, meta, cell, workerHeartbeat);
  },
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void (async () => {
    const wc = loadWorkerConfig();
    const mongo = new MongoClient(wc.mongoUri);
    await mongo.connect();
    workerHeartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });
    await workerHeartbeat.writeOnce();
    workerHeartbeat.start();
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: "hive-voice" }));
  })().catch((err) => {
    log.error("voice worker boot failed", { error: String(err) });
    process.exit(1);
  });
}
