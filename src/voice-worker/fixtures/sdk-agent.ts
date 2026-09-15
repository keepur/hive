import { defineAgent, type JobContext } from "@livekit/agents";
import { withJobLifecycle } from "../job-lifecycle.js";

type FixtureMode = "normal" | "throw-before-session" | "exit-before-entry" | "suppress-completion";

const mode = (process.env.HIVE_SDK_FIXTURE_MODE ?? "normal") as FixtureMode;

function send(caseName: string): void {
  if (process.connected && process.send) process.send({ case: caseName, value: undefined });
}

function cleanupRelease(): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown) => {
      if (typeof message === "object" && message !== null && "case" in message && message.case === "release-cleanup") {
        process.off("message", listener);
        resolve();
      }
    };
    process.on("message", listener);
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    if (mode === "exit-before-entry") process.exit(23);

    await withJobLifecycle(
      ctx,
      {
        entered: () => send("hive-entry"),
        completed: () => {
          if (mode !== "suppress-completion") send("hive-completion");
        },
      },
      async ({ delegateCleanup }) => {
        if (mode === "throw-before-session") throw new Error("fixture work failed before session setup");

        const cleanupFinished = delegateCleanup();
        void cleanupRelease().then(() => {
          send("cleanup-finished");
          cleanupFinished();
        });
        // Exercise the public JobContext shutdown hook without joining a room.
        ctx.shutdown("fixture entry ready");
      },
    );
  },
});
