import { defineAgent, cli, WorkerOptions, type JobContext } from "@livekit/agents";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logging/logger.js";
import { resolveCell } from "./cells.js";
import { parseDispatchMetadata } from "./dispatch-meta.js";
import { runCallSession } from "./session.js";
import { VoiceWorkerHeartbeat } from "./telemetry.js";
import { livekitServerAuth, loadWorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker");

export type { DispatchMetadata } from "./dispatch-meta.js";
export { parseDispatchMetadata } from "./dispatch-meta.js";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const wc = loadWorkerConfig();
    const meta = parseDispatchMetadata(ctx.job.metadata);
    const cell = resolveCell(meta, wc);
    const mongo = new MongoClient(wc.mongoUri);
    await mongo.connect();
    const heartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });
    try {
      await runCallSession(ctx, wc, meta, cell, heartbeat);
    } finally {
      // entry() returns while the LiveKit job is still running; close on
      // shutdown so noteCall* writes during the call still have a client.
      ctx.addShutdownCallback(async () => {
        await mongo.close().catch(() => {});
      });
    }
  },
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void (async () => {
    const wc = loadWorkerConfig();
    // Forked job procs fall back to env when WorkerOptions aren't forwarded.
    // This process is the voice-worker, not a cloud-model agent — env is allowed.
    process.env.LIVEKIT_URL = wc.livekitUrl;
    process.env.LIVEKIT_API_KEY = wc.livekitApiKey;
    process.env.LIVEKIT_API_SECRET = wc.livekitApiSecret;
    const mongo = new MongoClient(wc.mongoUri);
    await mongo.connect();
    const workerHeartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });
    await workerHeartbeat.writeOnce();
    workerHeartbeat.start();
    cli.runApp(
      new WorkerOptions({
        agent: fileURLToPath(import.meta.url),
        agentName: "hive-voice",
        ...livekitServerAuth(wc),
      }),
    );
  })().catch((err) => {
    log.error("voice worker boot failed", { error: String(err) });
    process.exit(1);
  });
}
