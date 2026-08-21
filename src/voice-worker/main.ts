import { defineAgent, cli, WorkerOptions, type JobContext } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logging/logger.js";
import { resolveCell } from "./cells.js";
import { parseDispatchMetadata } from "./dispatch-meta.js";
import { runCallSession } from "./session.js";
import { loadWorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker");

export type { DispatchMetadata } from "./dispatch-meta.js";
export { parseDispatchMetadata } from "./dispatch-meta.js";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const wc = loadWorkerConfig();
    const meta = parseDispatchMetadata(ctx.job.metadata);
    const cell = resolveCell(meta, wc);
    await runCallSession(ctx, wc, meta, cell);
  },
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: "hive-voice" }));
}
